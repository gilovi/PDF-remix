import { buildInk, strokePath, type InkPoint } from './ink';
import { inkSvg } from './overlayView';
import { prepareUpload } from './signatureImage';
import type { Signature, SignatureStore } from './signatures';
import { SignatureVault, canUseVault, type NewSavedSignature, type SavedSignature } from './signatureVault';
import { browserVaultStorage } from './vaultStorage';
import { MIN_PASSPHRASE_LENGTH } from './vault';

type Ask = (message: string, detail: string, okLabel: string) => Promise<boolean>;
type FormMode = 'create' | 'unlock' | 'change';

const FORM_TEXT: Record<FormMode, { title: string; submit: string }> = {
  create: {
    title: `Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters. Your signatures are encrypted with it on this device. It can’t be recovered: if you forget it, you’ll need to delete them and sign again.`,
    submit: 'Save',
  },
  unlock: { title: 'Enter your passphrase to use your saved signatures.', submit: 'Unlock' },
  change: { title: `Choose a new passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters. It can’t be recovered.`, submit: 'Change passphrase' },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The dialog for choosing a signature, drawing a new one, or uploading one. */
export function createSignaturePicker(store: SignatureStore, ask: Ask) {
  const dialog = $<HTMLDialogElement>('sig-dialog');
  const savedWrap = $('sig-saved');
  const list = $('sig-list');
  const canvas = $<HTMLCanvasElement>('sig-canvas');
  const preview = $<HTMLImageElement>('sig-preview');
  const status = $('sig-status');
  const undo = $<HTMLButtonElement>('sig-undo');
  const clear = $<HTMLButtonElement>('sig-clear');
  const uploadBtn = $<HTMLButtonElement>('sig-upload');
  const fileInput = $<HTMLInputElement>('sig-file');
  const whiteRow = $('sig-white-row');
  const white = $<HTMLInputElement>('sig-white');
  const use = $<HTMLButtonElement>('sig-use');
  const main = $('sig-main');
  const saveRow = $('sig-save-row');
  const save = $<HTMLInputElement>('sig-save');
  const vaultBar = $('vault-bar');
  const vaultStatus = $('vault-status');
  const unlockBtn = $<HTMLButtonElement>('vault-unlock');
  const lockBtn = $<HTMLButtonElement>('vault-lock');
  const changeBtn = $<HTMLButtonElement>('vault-change');
  const deleteBtn = $<HTMLButtonElement>('vault-delete');
  const form = $<HTMLFormElement>('vault-form');
  const formTitle = $('vault-form-title');
  const pass = $<HTMLInputElement>('vault-pass');
  const pass2 = $<HTMLInputElement>('vault-pass2');
  const pass2Row = $('vault-pass2-row');
  const formError = $('vault-error');
  const submit = $<HTMLButtonElement>('vault-submit');
  const context = canvas.getContext('2d')!;

  const vault = canUseVault(location.hostname) ? new SignatureVault(browserVaultStorage) : null;
  /** Which of this session's signatures are saved: signature id to its id in the vault. */
  const savedIds = new Map<string, string>();
  let formDone: ((ok: boolean) => void) | null = null;
  let formMode: FormMode = 'unlock';

  /** Raw points exist only while drawing: they're discarded once the outline is built. */
  let strokes: InkPoint[][] = [];
  let current: { pointerId: number; points: InkPoint[] } | null = null;
  let upload: { file: File; png: Uint8Array; width: number; height: number; url: string } | null = null;
  let resolveChoice: ((choice: Signature | null) => void) | null = null;

  function resetDrawing() {
    strokes = [];
    current = null;
    if (upload) URL.revokeObjectURL(upload.url);
    upload = null;
    preview.removeAttribute('src');
    status.textContent = 'Sign in the box with your mouse, finger or pen.';
    status.classList.remove('warning');
  }

  function renderState() {
    const hasInk = strokes.length > 0;
    canvas.hidden = upload !== null;
    preview.hidden = upload === null;
    whiteRow.hidden = upload === null;
    undo.hidden = upload !== null;
    undo.disabled = !hasInk;
    clear.disabled = !hasInk && !upload;
    use.disabled = !hasInk && !upload;
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

  async function renderVault() {
    saveRow.hidden = !vault;
    if (!vault) return;
    const state = await vault.state();
    if (state === 'none') forgetSession();
    vaultBar.hidden = state === 'none';
    vaultStatus.textContent = state === 'locked' ? 'You have signatures saved on this device.' : 'Your saved signatures are unlocked.';
    unlockBtn.hidden = state !== 'locked';
    lockBtn.hidden = changeBtn.hidden = deleteBtn.hidden = state !== 'unlocked';
    renderList();
  }

  function openForm(mode: FormMode): Promise<boolean> {
    formMode = mode;
    formTitle.textContent = FORM_TEXT[mode].title;
    submit.textContent = FORM_TEXT[mode].submit;
    pass2Row.hidden = mode === 'unlock';
    pass.autocomplete = mode === 'unlock' ? 'current-password' : 'new-password';
    pass.value = pass2.value = '';
    formError.textContent = '';
    form.hidden = false;
    main.hidden = vaultBar.hidden = true;
    pass.focus();
    return new Promise((resolve) => (formDone = resolve));
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
  $('vault-cancel').addEventListener('click', () => {
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
        await vault.changePassphrase(pass.value);
      } else {
        (await vault.unlock(pass.value)).forEach(addToSession);
      }
      closeForm(true);
      await renderVault();
    } catch (err) {
      formError.textContent = err instanceof Error ? err.message : 'That didn’t work.';
    } finally {
      submit.disabled = false;
    }
  }

  /** Makes sure the vault is open, asking for or creating a passphrase if needed. */
  async function ensureUnlocked(): Promise<boolean> {
    const state = await vault!.state();
    if (state === 'unlocked') return true;
    return openForm(state === 'none' ? 'create' : 'unlock');
  }

  unlockBtn.addEventListener('click', () => void openForm('unlock'));
  changeBtn.addEventListener('click', () => void openForm('change'));
  lockBtn.addEventListener('click', () => {
    vault?.lock();
    forgetSession();
    void renderVault();
  });
  deleteBtn.addEventListener('click', () => void deleteAll());

  async function deleteAll() {
    const ok = await ask('Delete all saved signatures?', 'They’ll be permanently removed from this device. This can’t be undone.', 'Delete');
    if (!ok || !vault) return;
    await vault.destroy();
    forgetSession();
    await renderVault();
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

  async function useCurrent() {
    let signature: NewSavedSignature | null = null;
    if (upload) signature = { kind: 'image', png: upload.png, width: upload.width, height: upload.height };
    else {
      const ink = buildInk(strokes);
      if (ink) signature = { kind: 'ink', ink };
    }
    if (!signature) return;

    if (vault && save.checked) {
      if (!(await ensureUnlocked())) return;
      use.disabled = true;
      try {
        finish(addToSession(await vault.add(signature)));
      } catch (err) {
        status.textContent = err instanceof Error ? err.message : 'That couldn’t be saved.';
        status.classList.add('warning');
        renderState();
      }
      return;
    }
    finish(signature.kind === 'ink' ? store.addInk(signature.ink) : store.addImage(signature.png, signature.width, signature.height));
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
  });
  canvas.addEventListener('pointermove', (e) => {
    if (current?.pointerId === e.pointerId) addPoints(e);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (current?.pointerId !== e.pointerId) return;
    strokes.push(current.points);
    current = null;
    redraw();
    renderState();
  });
  canvas.addEventListener('pointercancel', (e) => {
    if (current?.pointerId !== e.pointerId) return;
    current = null;
    redraw();
  });

  undo.addEventListener('click', () => {
    strokes.pop();
    redraw();
    renderState();
  });
  clear.addEventListener('click', () => {
    resetDrawing();
    renderState();
    sizeCanvas();
  });

  // ---------- uploading ----------

  async function readUpload(file: File) {
    try {
      const prepared = await prepareUpload(file, white.checked);
      if (upload) URL.revokeObjectURL(upload.url);
      const url = URL.createObjectURL(new Blob([prepared.png as BlobPart], { type: 'image/png' }));
      upload = { file, ...prepared, url };
      strokes = [];
      preview.src = url;
      status.textContent = 'Check how it looks. The checkerboard shows what’s transparent.';
      status.classList.remove('warning');
    } catch (err) {
      status.textContent = err instanceof Error && err.message === 'This image looks empty.' ? err.message : 'That file couldn’t be read as an image.';
      status.classList.add('warning');
    }
    renderState();
  }

  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void readUpload(file);
  });
  white.addEventListener('change', () => {
    if (upload) void readUpload(upload.file);
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
  dialog.addEventListener('close', () => finish(null));

  return {
    choose(): Promise<Signature | null> {
      resetDrawing();
      renderList();
      renderState();
      dialog.showModal();
      sizeCanvas();
      void renderVault();
      return new Promise((resolve) => (resolveChoice = resolve));
    },
  };
}
