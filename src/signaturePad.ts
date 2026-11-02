import { buildInk, strokePath, type InkPoint } from './ink';
import { inkSvg } from './overlayView';
import { PASSKEY_LABEL, createPasskey, passkeyName, passkeyProblem, passkeysSupported, readPrf } from './passkey';
import type { Signature, SignatureStore } from './signatures';
import { SignatureVault, canUseVault, type SavedSignature } from './signatureVault';
import { MIN_PASSPHRASE_LENGTH, type Cipher, type PasskeyInfo } from './vault';
import { browserVaultStorage } from './vaultStorage';

type Ask = (message: string, detail: string, okLabel: string) => Promise<boolean>;
type FormMode = 'create' | 'unlock' | 'change' | 'add';

const FORM_TEXT: Record<FormMode, { title: string; submit: string; cancel: string }> = {
  create: {
    title: `Keep your signatures and unsaved work on this device, encrypted? Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters. It can’t be recovered: if you forget it, you’ll need to delete them and sign again.`,
    submit: 'Save with passphrase',
    cancel: 'Not now',
  },
  unlock: { title: 'Unlock your signatures and unsaved work?', submit: 'Unlock', cancel: 'Not now' },
  change: { title: `Choose a new passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters. It can’t be recovered.`, submit: 'Change passphrase', cancel: 'Cancel' },
  add: { title: `Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters, as a second way in. It can’t be recovered.`, submit: 'Add passphrase', cancel: 'Cancel' },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** How long after a handled press its click still counts as the same press. */
const CLICK_AFTER_PRESS_MS = 600;

/**
 * Runs an action on a press. A finger that moves slightly during a tap gets no click
 * from the browser, so the end of the press counts too, as long as it ended on the
 * button. The click still handles the keyboard, and is ignored if it repeats a press.
 */
function onPress(button: HTMLButtonElement, action: () => void) {
  let handledAt = -Infinity;
  let pressed = false;
  button.addEventListener('pointerdown', () => (pressed = true));
  button.addEventListener('pointercancel', () => (pressed = false));
  button.addEventListener('pointerup', (e) => {
    const started = pressed;
    pressed = false;
    const r = button.getBoundingClientRect();
    if (!started || e.button !== 0 || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    handledAt = e.timeStamp;
    action();
  });
  button.addEventListener('click', (e) => {
    // `detail` is 0 for a click from the keyboard, which never repeats a press.
    if (e.detail === 0 || e.timeStamp - handledAt > CLICK_AFTER_PRESS_MS) action();
  });
}

/** The dialog for choosing a signature or drawing a new one, and for the vault that keeps them. */
export function createSignaturePicker(store: SignatureStore, ask: Ask, hooks: { vaultChanged(): void; rekey(before: Cipher, after: Cipher): Promise<void> }) {
  const dialog = $<HTMLDialogElement>('sig-dialog');
  const savedWrap = $('sig-saved');
  const list = $('sig-list');
  const canvas = $<HTMLCanvasElement>('sig-canvas');
  const status = $('sig-status');
  const undo = $<HTMLButtonElement>('sig-undo');
  const clear = $<HTMLButtonElement>('sig-clear');
  const use = $<HTMLButtonElement>('sig-use');
  const main = $('sig-main');
  const title = $('sig-title');
  const vaultBar = $('vault-bar');
  const vaultStatus = $('vault-status');
  const openBtn = $<HTMLButtonElement>('vault-open');
  const lockBtn = $<HTMLButtonElement>('vault-lock');
  const changeBtn = $<HTMLButtonElement>('vault-change');
  const deleteBtn = $<HTMLButtonElement>('vault-delete');
  const addPasskeyBtn = $<HTMLButtonElement>('vault-add-passkey');
  const barPasskeys = $('vault-passkeys');
  const unlockers = $('vault-unlockers');
  const menu = $<HTMLDetailsElement>('vault-menu');
  const cantBtn = $<HTMLButtonElement>('vault-cant');
  const resetDialog = $<HTMLDialogElement>('vault-reset-dialog');
  const form = $<HTMLFormElement>('vault-form');
  const formTitle = $('vault-form-title');
  const formPasskeys = $('vault-form-passkeys');
  const passkeyNote = $('vault-passkey-note');
  const passFields = $('vault-pass-fields');
  const pass = $<HTMLInputElement>('vault-pass');
  const pass2 = $<HTMLInputElement>('vault-pass2');
  const pass2Row = $('vault-pass2-row');
  const formError = $('vault-error');
  const submit = $<HTMLButtonElement>('vault-submit');
  const cancel = $<HTMLButtonElement>('vault-cancel');
  const resetBtn = $<HTMLButtonElement>('vault-reset');
  const context = canvas.getContext('2d')!;

  const vault = canUseVault(location.hostname) ? new SignatureVault(browserVaultStorage) : null;
  /** Which of this session's signatures are saved: signature id to its id in the vault. */
  const savedIds = new Map<string, string>();
  /** The user said not now, so this session stops offering the vault on its own. */
  let declined = false;
  /** Offering to delete makes sense only once an unlock has actually failed. */
  let unlockFailed = false;
  let formDone: ((ok: boolean) => void) | null = null;
  let formMode: FormMode = 'unlock';
  let barState: 'none' | 'locked' | 'unlocked' = 'none';
  /** Opened only to unlock, for something other than a signature. */
  let unlockOnly = false;

  /** Raw points exist only while drawing: they're discarded once the outline is built. */
  let strokes: InkPoint[][] = [];
  let current: { pointerId: number; points: InkPoint[] } | null = null;
  let resolveChoice: ((choice: Signature | null) => void) | null = null;

  function resetDrawing() {
    strokes = [];
    current = null;
    status.textContent = 'Sign in the box with your mouse, finger or pen.';
    status.classList.remove('warning');
  }

  function renderState() {
    const hasInk = strokes.length > 0;
    undo.disabled = use.disabled = !hasInk;
    // Ink can be cleared as soon as it's on the pad, even mid-stroke.
    clear.disabled = !hasInk && !current;
  }

  function redraw() {
    const scale = canvas.width / canvas.clientWidth;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    context.fillStyle = '#000';
    for (const stroke of current ? [...strokes, current.points] : strokes) {
      const path = strokePath(stroke);
      if (path) context.fill(new Path2D(path));
    }
  }

  function sizeCanvas() {
    const scale = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(canvas.clientWidth * scale);
    canvas.height = Math.round(canvas.clientHeight * scale);
    redraw();
  }

  function renderList() {
    const signatures = store.list();
    savedWrap.hidden = signatures.length === 0;
    list.replaceChildren(
      ...signatures.map((s) => {
        const choose = document.createElement('button');
        choose.type = 'button';
        choose.className = 'sig-thumb';
        choose.title = 'Use this signature';
        choose.ariaLabel = 'Use this signature';
        choose.dataset.choose = s.id;
        if (s.kind === 'ink') choose.append(inkSvg(s.ink));
        else {
          const img = document.createElement('img');
          img.alt = '';
          img.src = store.imageUrl(s.id) ?? '';
          choose.append(img);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'sig-remove';
        remove.textContent = '✕';
        remove.title = 'Remove from this list';
        remove.ariaLabel = 'Remove this signature from the list';
        remove.dataset.remove = s.id;
        const item = document.createElement('div');
        item.className = 'sig-item';
        item.append(choose, remove);
        if (savedIds.has(s.id)) {
          const mark = document.createElement('span');
          mark.className = 'sig-saved-mark';
          mark.textContent = '🔒';
          mark.title = 'Saved on this device';
          item.append(mark);
        }
        return item;
      }),
    );
  }

  function finish(choice: Signature | null) {
    const resolve = resolveChoice;
    resolveChoice = null;
    closeForm(false);
    if (dialog.open) dialog.close();
    resetDrawing();
    resolve?.(choice);
  }

  // ---------- saved signatures ----------

  function addToSession(saved: SavedSignature) {
    const signature = saved.kind === 'ink' ? store.addInk(saved.ink) : store.addImage(saved.png, saved.width, saved.height);
    savedIds.set(signature.id, saved.id);
    return signature;
  }

  function forgetSession() {
    for (const id of savedIds.keys()) store.remove(id);
    savedIds.clear();
  }

  /** Once the vault opens, this session's earlier signatures are saved along with the rest. */
  async function saveUnsaved() {
    for (const s of store.list()) {
      if (savedIds.has(s.id)) continue;
      const saved = await vault!.add(s.kind === 'ink' ? { kind: 'ink', ink: s.ink } : { kind: 'image', png: s.png, width: s.width, height: s.height });
      savedIds.set(s.id, saved.id);
    }
  }

  /** Finishes any route to an open vault: passphrase, passkey, new or existing. */
  async function vaultOpened() {
    unlockFailed = false;
    closeForm(true);
    await saveUnsaved();
    await renderVault();
  }

  async function renderVault() {
    if (!vault) return;
    barState = await vault.state();
    if (barState === 'none') forgetSession();
    const passkeys = await vault.passkeys();
    const hasPassphrase = await vault.hasPassphrase();
    if (!formDone) vaultBar.hidden = false;
    vaultBar.classList.remove('warning');
    vaultStatus.textContent =
      barState === 'unlocked'
        ? 'New signatures are saved on this device, encrypted.'
        : barState === 'locked'
          ? 'Your saved signatures are locked. New ones won’t be saved.'
          : 'Signatures aren’t being saved.';
    openBtn.hidden = barState === 'unlocked' || (barState === 'locked' && !hasPassphrase);
    openBtn.textContent = barState === 'none' ? 'Save on this device' : passkeys.length ? 'Use passphrase' : 'Unlock';
    openBtn.classList.toggle('primary', barState === 'none' || passkeys.length === 0);
    cantBtn.hidden = barState !== 'locked' || !unlockFailed;
    menu.hidden = barState !== 'unlocked';
    changeBtn.textContent = hasPassphrase ? 'Change passphrase' : 'Add passphrase';
    addPasskeyBtn.hidden = !passkeysSupported();
    const onlyWayIn = passkeys.length === 1 && !hasPassphrase;
    unlockers.replaceChildren(...(barState === 'locked' ? passkeys.map(unlockButton) : []));
    barPasskeys.replaceChildren(...(barState === 'unlocked' ? passkeys.map((p, i) => passkeyChip(p, passkeyName(i, passkeys.length), onlyWayIn)) : []));
    renderList();
    hooks.vaultChanged();
  }

  function unlockButton(passkey: PasskeyInfo, index: number, all: PasskeyInfo[]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small primary';
    button.textContent = `Unlock with ${passkeyName(index, all.length).toLowerCase()}`;
    button.addEventListener('click', () => void unlockWithPasskey(passkey));
    return button;
  }

  function passkeyChip(passkey: PasskeyInfo, name: string, onlyWayIn: boolean) {
    const chip = document.createElement('span');
    chip.className = 'vault-chip';
    chip.append(name);
    if (onlyWayIn) {
      chip.title = 'This is the only way to unlock your signatures. Add a passphrase or another passkey to remove it.';
      return chip;
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = `Stop unlocking with ${name.toLowerCase()}`;
    remove.ariaLabel = remove.title;
    remove.addEventListener('click', () => void removePasskey(passkey, name));
    chip.append(remove);
    return chip;
  }

  /** Shows a problem where the user is looking: on the open form, or else on the bar. */
  function showVaultProblem(message: string) {
    if (formDone) {
      formError.textContent = message;
      return;
    }
    vaultStatus.textContent = message;
    vaultBar.classList.add('warning');
  }

  const passkeyMessage = (err: unknown) =>
    passkeyProblem(err) === 'cancelled'
      ? 'The passkey request was cancelled.'
      : err instanceof Error && err.name === 'VaultError'
        ? err.message
        : 'The passkey didn’t work.';

  const UNUSABLE_PASSKEY = 'That passkey can’t unlock signatures, so it wasn’t used. Try saving one somewhere else. You can delete the unused passkey from where it was saved.';

  function markUnlockFailed() {
    unlockFailed = true;
    if (formDone) resetBtn.hidden = false;
    else cantBtn.hidden = false;
  }

  async function unlockWithPasskey(passkey: PasskeyInfo) {
    if (!vault) return;
    try {
      const prf = await readPrf(passkey.credentialId, passkey.prfSalt);
      if (!prf) throw new Error('No usable output');
      (await vault.unlockWithPasskey(passkey.credentialId, prf)).forEach((saved) => addToSession(saved));
      await vaultOpened();
    } catch {
      // Browsers report a deleted passkey just like a cancelled prompt, so this has to cover both.
      showVaultProblem('Couldn’t unlock with that passkey. If you cancelled, try again.');
      markUnlockFailed();
    }
  }

  /** Makes a passkey and reads its output, or returns null after explaining why not. */
  async function newPasskey(existing: PasskeyInfo[]) {
    const credentialId = await createPasskey(existing.map((p) => p.credentialId));
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    const prf = await readPrf(credentialId, prfSalt);
    if (!prf) {
      showVaultProblem(UNUSABLE_PASSKEY);
      return null;
    }
    return { info: { credentialId, prfSalt, label: PASSKEY_LABEL }, prf };
  }

  async function createWithPasskey() {
    if (!vault) return;
    formError.textContent = 'Create the passkey, then confirm it once more.';
    try {
      const made = await newPasskey([]);
      if (!made) return;
      await vault.createWithPasskey(made.info, made.prf);
      void navigator.storage?.persist?.();
      await vaultOpened();
    } catch (err) {
      showVaultProblem(passkeyMessage(err));
    }
  }

  async function addPasskey() {
    if (!vault) return;
    addPasskeyBtn.disabled = true;
    vaultBar.classList.remove('warning');
    vaultStatus.textContent = 'Create the passkey, then confirm it once more.';
    try {
      const made = await newPasskey(await vault.passkeys());
      if (!made) return;
      await vault.addPasskey(made.info, made.prf);
      await renderVault();
    } catch (err) {
      showVaultProblem(passkeyProblem(err) === 'duplicate' ? 'You already have a passkey for your signatures saved there.' : passkeyMessage(err));
    } finally {
      addPasskeyBtn.disabled = false;
    }
  }

  async function removePasskey(passkey: PasskeyInfo, name: string) {
    if (!vault) return;
    const ok = await ask(
      `Stop unlocking with ${name.toLowerCase()}?`,
      'Your signatures stay saved. The passkey itself stays where it’s saved until you delete it there.',
      'Stop using it',
    );
    if (!ok) return;
    try {
      await vault.removePasskey(passkey.credentialId);
      await renderVault();
    } catch (err) {
      showVaultProblem(err instanceof Error ? err.message : 'That passkey couldn’t be removed.');
    }
  }

  function openForm(mode: FormMode, passkeys: PasskeyInfo[], hasPassphrase: boolean): Promise<boolean> {
    formMode = mode;
    const text = FORM_TEXT[mode];
    formTitle.textContent = mode === 'change' && passkeys.length ? `${text.title} Your passkeys will stop working, and you’ll need to add them again.` : text.title;
    submit.textContent = text.submit;
    cancel.textContent = text.cancel;
    const fieldsShown = mode !== 'unlock' || hasPassphrase;
    passFields.hidden = submit.hidden = !fieldsShown;
    pass2Row.hidden = mode === 'unlock';
    pass.autocomplete = mode === 'unlock' ? 'current-password' : 'new-password';
    pass.value = pass2.value = '';
    formError.textContent = '';
    passkeyNote.hidden = mode !== 'create' || !passkeysSupported();
    resetBtn.hidden = mode !== 'unlock' || !unlockFailed;
    if (mode === 'unlock') formPasskeys.replaceChildren(...passkeys.map(unlockButton));
    else if (mode === 'create' && passkeysSupported()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn small primary';
      button.textContent = 'Use only a passkey';
      button.addEventListener('click', () => void createWithPasskey());
      formPasskeys.replaceChildren(button);
    } else formPasskeys.replaceChildren();
    form.hidden = false;
    main.hidden = vaultBar.hidden = true;
    if (fieldsShown) pass.focus();
    return new Promise((resolve) => (formDone = resolve));
  }

  /** Opens the form for what the vault needs now. */
  async function openVaultForm(mode: FormMode) {
    const ok = await openForm(mode, (await vault?.passkeys()) ?? [], (await vault?.hasPassphrase()) ?? false);
    if (!ok && (mode === 'create' || mode === 'unlock')) declined = true;
  }

  function closeForm(ok: boolean) {
    if (!formDone) return;
    const resolve = formDone;
    formDone = null;
    pass.value = pass2.value = '';
    form.hidden = true;
    main.hidden = false;
    resolve(ok);
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submitForm();
  });
  cancel.addEventListener('click', () => {
    closeForm(false);
    void renderVault();
  });

  async function submitForm() {
    if (!vault) return;
    if (formMode !== 'unlock' && pass.value !== pass2.value) {
      formError.textContent = 'The two passphrases don’t match.';
      return;
    }
    submit.disabled = true;
    formError.textContent = '';
    try {
      if (formMode === 'create') {
        await vault.create(pass.value);
        // Ask the browser not to clear this under storage pressure. It may say no.
        void navigator.storage?.persist?.();
      } else if (formMode === 'change') {
        await vault.changePassphrase(pass.value, hooks.rekey);
      } else if (formMode === 'add') {
        await vault.addPassphrase(pass.value);
      } else {
        (await vault.unlock(pass.value)).forEach((saved) => addToSession(saved));
      }
      await vaultOpened();
    } catch (err) {
      formError.textContent = err instanceof Error ? err.message : 'That didn’t work.';
      if (formMode === 'unlock') markUnlockFailed();
    } finally {
      submit.disabled = false;
    }
  }

  openBtn.addEventListener('click', () => void openVaultForm(barState === 'none' ? 'create' : 'unlock'));
  changeBtn.addEventListener('click', () => void (async () => openVaultForm((await vault?.hasPassphrase()) ? 'change' : 'add'))());
  lockBtn.addEventListener('click', () => {
    vault?.lock();
    forgetSession();
    declined = true;
    void renderVault();
  });
  deleteBtn.addEventListener('click', () => void deleteAll());
  resetBtn.addEventListener('click', () => void resetVault());
  cantBtn.addEventListener('click', () => void resetVault());
  addPasskeyBtn.addEventListener('click', () => void addPasskey());

  async function deleteAll() {
    const ok = await ask('Delete all saved signatures and unsaved work?', 'They’ll be permanently removed from this device. This can’t be undone. Any passkeys stay where they’re saved until you delete them there.', 'Delete');
    if (!ok || !vault) return;
    await vault.destroy();
    forgetSession();
    declined = true;
    await renderVault();
  }

  /** Explains being locked out, with its own serious warning, and starts over only if confirmed. */
  function confirmReset(): Promise<boolean> {
    resetDialog.showModal();
    $('vault-reset-cancel').focus();
    return new Promise((resolve) => {
      const answer = (ok: boolean) => {
        resetDialog.removeEventListener('close', onClose);
        resetDialog.close();
        resolve(ok);
      };
      const onClose = () => answer(false);
      resetDialog.addEventListener('close', onClose);
      $('vault-reset-cancel').onclick = () => answer(false);
      $('vault-reset-ok').onclick = () => answer(true);
    });
  }

  async function resetVault() {
    if (!vault || !(await confirmReset())) return;
    const only = unlockOnly;
    closeForm(false);
    await vault.destroy();
    forgetSession();
    unlockFailed = false;
    await renderVault();
    if (!only) await openVaultForm('create');
  }

  async function removeFromList(id: string) {
    const savedId = savedIds.get(id);
    if (savedId && vault) {
      const ok = await ask('Delete this saved signature?', 'It’ll be permanently removed from this device.', 'Delete');
      if (!ok) return;
      await vault.remove(savedId);
      savedIds.delete(id);
    }
    store.remove(id);
    renderList();
  }

  /** While the vault is open every signature is saved. Otherwise it lasts for this session. */
  async function useCurrent() {
    const ink = buildInk(strokes);
    if (!ink) return;
    if (vault && (await vault.state()) === 'unlocked') {
      use.disabled = true;
      try {
        finish(addToSession(await vault.add({ kind: 'ink', ink })));
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'That couldn’t be saved.';
        status.classList.add('warning');
        renderState();
      }
      return;
    }
    finish(store.addInk(ink));
  }

  /** Shows the vault's state, and the first time in a session, offers to open or create it. */
  async function offerVault() {
    await renderVault();
    if (vault && barState !== 'unlocked' && !declined && !formDone) await openVaultForm(barState === 'none' ? 'create' : 'unlock');
  }

  // ---------- drawing ----------

  function addPoints(e: PointerEvent) {
    if (!current) return;
    const rect = canvas.getBoundingClientRect();
    // Browsers merge fast movement into one event; these are the points it merged.
    const events = e.getCoalescedEvents?.() ?? [];
    for (const event of events.length ? events : [e]) {
      current.points.push({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        t: event.timeStamp,
        pressure: event.pressure,
        pointerType: event.pointerType === 'pen' || event.pointerType === 'touch' ? event.pointerType : 'mouse',
      });
    }
    redraw();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || current) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    current = { pointerId: e.pointerId, points: [] };
    addPoints(e);
    renderState();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (current?.pointerId === e.pointerId) addPoints(e);
  });
  const endStroke = (e: PointerEvent) => {
    if (current?.pointerId !== e.pointerId) return;
    strokes.push(current.points);
    current = null;
    redraw();
    renderState();
  };
  canvas.addEventListener('pointerup', endStroke);
  // If the browser never reports the end of a stroke, this still does, so the pad can't stay stuck mid-stroke.
  canvas.addEventListener('lostpointercapture', endStroke);
  canvas.addEventListener('pointercancel', (e) => {
    if (current?.pointerId !== e.pointerId) return;
    current = null;
    redraw();
    renderState();
  });

  onPress(undo, () => {
    strokes.pop();
    redraw();
    renderState();
  });
  onPress(clear, () => {
    resetDrawing();
    renderState();
    sizeCanvas();
  });

  // ---------- choosing ----------

  use.addEventListener('click', () => void useCurrent());

  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const remove = target.closest<HTMLElement>('[data-remove]');
    if (remove) {
      void removeFromList(remove.dataset.remove!);
      return;
    }
    const choose = target.closest<HTMLElement>('[data-choose]');
    if (choose) finish(store.get(choose.dataset.choose!) ?? null);
  });

  dialog.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-close]')) finish(null);
  });
  // This event arrives late, and may belong to a closing before the dialog was reopened.
  dialog.addEventListener('close', () => {
    if (!dialog.open) finish(null);
  });

  return {
    choose(): Promise<Signature | null> {
      resetDrawing();
      renderList();
      renderState();
      menu.open = false;
      title.textContent = 'Signature';
      dialog.showModal();
      sizeCanvas();
      void offerVault();
      return new Promise((resolve) => (resolveChoice = resolve));
    },

    /** The vault's key while it's open, for keeping other data. */
    cipher: () => vault?.cipher() ?? null,
    available: () => vault !== null,

    /** Asks for the vault if it's closed, creating it if there's none. True once it's open. */
    async ensureUnlocked(): Promise<boolean> {
      if (!vault) return false;
      const state = await vault.state();
      if (state === 'unlocked') return true;
      resetDrawing();
      renderList();
      renderState();
      menu.open = false;
      title.textContent = 'Saved on this device';
      unlockOnly = true;
      dialog.showModal();
      await renderVault();
      await openForm(state === 'none' ? 'create' : 'unlock', await vault.passkeys(), await vault.hasPassphrase());
      unlockOnly = false;
      finish(null);
      return vault.cipher() !== null;
    },
  };
}
