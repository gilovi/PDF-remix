import { displaySize, pageToView, viewToPage, type PageFrame } from './coords';
import type { PageRef } from './model';
import { addOverlay, cleanDigits, removeOverlay, updateOverlay, type Angle, type Overlay } from './overlay';
import { keepOnPage, moveOverlay, newOverlay, overlaySize, resizeFromCorner, stepOverlaySize, stepPitch, viewDeltaToLocal, type NewItemSizes, type Size } from './overlayGeometry';
import { fillBody, pageFrame, placeItem, renderItem, type AssetUrl } from './overlayView';
import { renderPage, type PDFDocumentProxy } from './render';
import { shortcutFor } from './shortcuts';
import { fontCoverage, isRtlLine, missingChars } from './textlayout';
import { anchoredScroll, clampZoom, fitZoom, pinchZoom, stepZoom } from './zoom';

export interface EditorDeps {
  pages(): PageRef[];
  commit(next: PageRef[]): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  pdfOf(sourceId: string): PDFDocumentProxy | undefined;
  assetUrl?: AssetUrl;
}

type Tool = 'text' | 'comb' | 'mark';

interface Gesture {
  pointerId: number;
  kind: 'move' | 'resize';
  startX: number;
  startY: number;
  original: Overlay;
  size: Size;
  moved: boolean;
  wasSelected: boolean;
}

/** Renders stay within this, near iOS's canvas limit. Beyond it, CSS scales the last render. */
const MAX_PIXELS = 16_000_000;
const STAGE_PADDING = 16;
const DRAG_THRESHOLD = 3;
/** Room needed above an item for its buttons, and beside it before they switch sides. */
const TOOLS_HEIGHT = 44;
const TOOLS_WIDTH = 220;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function createEditor(deps: EditorDeps) {
  const dialog = $<HTMLDialogElement>('editor');
  const stage = $('ed-stage');
  const sheet = $('ed-sheet');
  const img = $<HTMLImageElement>('ed-img');
  const layer = $('ed-items');
  const hint = $('ed-hint');
  const pageLabel = $('ed-page-label');
  const prev = $<HTMLButtonElement>('ed-prev');
  const next = $<HTMLButtonElement>('ed-next');
  const undoBtn = $<HTMLButtonElement>('ed-undo');
  const redoBtn = $<HTMLButtonElement>('ed-redo');
  const zoomLabel = $<HTMLButtonElement>('ed-zoom-fit');
  const pitchRow = $('ed-pitch-row');
  const pitch = $<HTMLInputElement>('ed-pitch');
  const tools = [...dialog.querySelectorAll<HTMLButtonElement>('[data-tool]')];

  let pageId: string | null = null;
  let frame: PageFrame | null = null;
  let renderedRotation = -1;
  let zoom = 1;
  let fit = 1;
  let fitted = true;
  let tool: Tool | null = null;
  let selectedId: string | null = null;
  /** The working copy of an item being edited or dragged; replaces (or, while new, adds to) the page's item. */
  let draft: Overlay | null = null;
  let editing: { id: string; isNew: boolean; input: HTMLTextAreaElement } | null = null;
  let gesture: Gesture | null = null;
  let suppressClick = false;
  /** This press landed outside a box being typed in: it only closes that box. */
  let pressEndedEdit = false;
  let pan: { pointerId: number; startX: number; startY: number; left: number; top: number; moved: boolean } | null = null;
  let imageUrl: string | null = null;
  let renderToken = 0;
  let renderTimer = 0;
  let idCounter = 0;
  const sizes: NewItemSizes = { size: 12, pitch: 18, mark: 12 };

  const currentPage = () => deps.pages().find((p) => p.id === pageId) ?? null;
  const committedItems = () => currentPage()?.overlays ?? [];

  function items(): Overlay[] {
    const list = committedItems();
    if (!draft) return list;
    const { id } = draft;
    return list.some((o) => o.id === id) ? list.map((o) => (o.id === id ? draft! : o)) : [...list, draft];
  }

  const findItem = (id: string | null) => items().find((o) => o.id === id) ?? null;
  const nodeOf = (id: string) => layer.querySelector<HTMLElement>(`.ov[data-id="${id}"]`);
  const turnOf = (o: Overlay) => frame!.rotation - o.angle;

  /** Text width depends on the font, so it comes from the rendered box. */
  function measuredSize(o: Overlay): Size {
    if (o.kind !== 'text') return overlaySize(o);
    const node = nodeOf(o.id);
    return node ? { w: node.offsetWidth / zoom, h: node.offsetHeight / zoom } : overlaySize(o);
  }

  // ---------- drawing ----------

  function renderItems() {
    if (!frame) return;
    const nodes = items().map((o) => {
      const node = renderItem(o, frame!, zoom, deps.assetUrl);
      if (o.id === selectedId && !editing) {
        node.classList.add('selected');
        const grip = document.createElement('span');
        grip.className = 'ov-handle';
        grip.dataset.resize = '';
        node.append(grip, itemTools(o));
      }
      return node;
    });
    layer.replaceChildren(...nodes);
    renderControls();
  }

  /** The buttons on a selected item: size, digit width for spaced numbers, and delete. */
  function itemTools(o: Overlay): HTMLElement {
    const tools = document.createElement('div');
    tools.className = 'ov-tools';
    const at = pageToView(frame!, zoom, o);
    tools.classList.toggle('below', at.y < TOOLS_HEIGHT);
    tools.classList.toggle('end', at.x > displaySize(frame!, zoom).width - TOOLS_WIDTH);

    const stepper = (label: string, what: string, action: 'size' | 'pitch') => {
      const group = document.createElement('span');
      group.className = 'ov-stepper';
      group.setAttribute('role', 'group');
      group.ariaLabel = what;
      group.append(label);
      for (const [text, direction, name] of [['−', '-1', 'Decrease'], ['+', '1', 'Increase']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.title = `${name} ${what.toLowerCase()}`;
        button.ariaLabel = button.title;
        button.dataset[action] = direction;
        group.append(button);
      }
      return group;
    };
    tools.append(stepper('Size', 'Size', 'size'));
    if (o.kind === 'comb') tools.append(stepper('Width', 'Space between digits', 'pitch'));

    const remove = document.createElement('button');
    remove.className = 'ov-delete';
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = 'Delete (Del)';
    remove.ariaLabel = 'Delete this item';
    remove.dataset.delete = '';
    tools.append(remove);
    return tools;
  }

  function renderControls() {
    const selected = findItem(selectedId);
    undoBtn.disabled = !deps.canUndo();
    redoBtn.disabled = !deps.canRedo();
    for (const button of tools) {
      const on = button.dataset.tool === (tool ?? 'hand');
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
    layer.classList.toggle('placing', tool !== null);
    layer.classList.toggle('panning', pan?.moved === true);
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;

    const comb = selected?.kind === 'comb' ? selected : null;
    pitchRow.hidden = !comb;
    if (comb) {
      pitch.min = String(Math.round(comb.size / 2));
      pitch.max = String(Math.round(comb.size * 5));
      pitch.value = String(comb.pitch);
    }

    const list = deps.pages();
    const index = list.findIndex((p) => p.id === pageId);
    pageLabel.textContent = `Page ${index + 1} of ${list.length}`;
    prev.disabled = index <= 0;
    next.disabled = index >= list.length - 1;

    hint.classList.remove('warning');
    const missing = selected?.kind === 'text' ? missingChars(selected.text, fontCoverage) : [];
    const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
    const click = touch ? 'Tap' : 'Click';
    if (missing.length) {
      hint.classList.add('warning');
      hint.textContent = `These characters can’t be saved in the PDF and will show as empty boxes: ${missing.join(' ')}`;
    } else if (editing) {
      hint.textContent = selected?.kind === 'comb'
        ? `Type the digits. ${click} outside the box or press Enter to finish.`
        : `Type here. ${click} outside the box to finish.`;
    } else if (selected) {
      const place = tool ? ` ${click} an empty spot to add another.` : '';
      hint.textContent = selected.kind === 'text' || selected.kind === 'comb'
        ? `Drag to move, or use the buttons to change it. ${click} again to edit.${place}`
        : `Drag to move, or use the buttons to change it.${place}`;
    } else if (tool) {
      hint.textContent = `${click} the page to add one, as many as you need. Esc or the hand stops adding.`;
    } else {
      hint.textContent = `Choose Text, Numbers or X, then ${click.toLowerCase()} the page. ${click} an item to change it.`;
    }
  }

  function applySheetSize() {
    if (!frame) return;
    const { width, height } = displaySize(frame, zoom);
    sheet.style.width = `${width}px`;
    sheet.style.height = `${height}px`;
  }

  /** Renders the page sharply for the current zoom, keeping the old image up until the new one is ready. */
  async function renderImage() {
    const page = currentPage();
    const pdf = page && deps.pdfOf(page.sourceId);
    if (!page || !pdf || !frame) return;
    const token = ++renderToken;
    const url = await renderPage(pdf, page.pageIndex, displaySize(frame, zoom).width, page.rotation ?? 0, MAX_PIXELS);
    if (token !== renderToken || !dialog.open) {
      URL.revokeObjectURL(url);
      return;
    }
    img.src = url;
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = url;
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = window.setTimeout(() => void renderImage().catch(() => {}), 200);
  }

  // ---------- zoom ----------

  function availableWidth() {
    return Math.max(100, stage.clientWidth - 2 * STAGE_PADDING);
  }

  /** Changes zoom, keeping the content at `point` (relative to the stage) where it is. */
  function setZoom(value: number, point = { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }) {
    if (!frame) return;
    finishEdit();
    const target = clampZoom(value, fit);
    const ratio = target / zoom;
    const before = {
      x: { point: point.x, scroll: stage.scrollLeft, offset: sheet.offsetLeft },
      y: { point: point.y, scroll: stage.scrollTop, offset: sheet.offsetTop },
    };
    zoom = target;
    applySheetSize();
    stage.scrollLeft = anchoredScroll(before.x, ratio, sheet.offsetLeft);
    stage.scrollTop = anchoredScroll(before.y, ratio, sheet.offsetTop);
    renderItems();
    scheduleRender();
  }

  /** Works out the fit, again after sizing the page, as a tall page brings a scrollbar that narrows the stage. */
  function applyFit() {
    if (!frame) return;
    const measure = () => fitZoom(displaySize(frame!, 1).width, availableWidth());
    fit = measure();
    zoom = clampZoom(fit, fit);
    applySheetSize();
    fit = measure();
    zoom = clampZoom(fit, fit);
    applySheetSize();
  }

  function fitToWidth() {
    if (!frame) return;
    finishEdit();
    fitted = true;
    applyFit();
    renderItems();
    scheduleRender();
  }

  zoomLabel.addEventListener('click', fitToWidth);
  $('ed-zoom-in').addEventListener('click', () => {
    fitted = false;
    setZoom(stepZoom(zoom, 1, fit));
  });
  $('ed-zoom-out').addEventListener('click', () => {
    fitted = false;
    setZoom(stepZoom(zoom, -1, fit));
  });

  const stagePoint = (clientX: number, clientY: number) => {
    const rect = stage.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  stage.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      fitted = false;
      setZoom(zoom * Math.exp(-e.deltaY * 0.002), stagePoint(e.clientX, e.clientY));
    },
    { passive: false },
  );

  // Two fingers zoom; one finger is left to the browser, which scrolls the stage.
  let pinch: { startZoom: number; startDistance: number } | null = null;
  const fingers = (e: TouchEvent) => {
    const [a, b] = [e.touches[0], e.touches[1]];
    return {
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      middle: stagePoint((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2),
    };
  };
  stage.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      cancelGesture();
      pinch = { startZoom: zoom, startDistance: fingers(e).distance };
    },
    { passive: false },
  );
  stage.addEventListener(
    'touchmove',
    (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const { distance, middle } = fingers(e);
      fitted = false;
      setZoom(pinchZoom(pinch.startZoom, pinch.startDistance, distance, fit), middle);
    },
    { passive: false },
  );
  stage.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinch = null;
  });

  // ---------- pages ----------

  async function showPage(id: string) {
    finishEdit();
    pageId = id;
    selectedId = null;
    await loadFrame();
    stage.scrollTo(0, 0);
    renderItems();
  }

  /** Reads the page's geometry again; undo can bring back a different rotation. */
  async function loadFrame() {
    const page = currentPage();
    const pdf = page && deps.pdfOf(page.sourceId);
    if (!page || !pdf) return;
    const rotation = page.rotation ?? 0;
    frame = await pageFrame(pdf, page.pageIndex, rotation);
    renderedRotation = rotation;
    if (fitted) applyFit();
    else {
      fit = fitZoom(displaySize(frame, 1).width, availableWidth());
      zoom = clampZoom(zoom, fit);
      applySheetSize();
    }
    await renderImage().catch(() => {});
  }

  function stepPage(delta: number) {
    const list = deps.pages();
    const target = list[list.findIndex((p) => p.id === pageId) + delta];
    if (target) void showPage(target.id);
  }
  prev.addEventListener('click', () => stepPage(-1));
  next.addEventListener('click', () => stepPage(1));

  // ---------- changing items ----------

  const commitItem = (o: Overlay) => deps.commit(updateOverlay(deps.pages(), pageId!, o.id, () => o));

  function rememberSizes(o: Overlay) {
    if (o.kind === 'text' || o.kind === 'comb') sizes.size = o.size;
    if (o.kind === 'comb') sizes.pitch = o.pitch;
    if (o.kind === 'mark') sizes.mark = Math.max(o.w, o.h);
  }

  function deleteSelected() {
    if (selectedId) deps.commit(removeOverlay(deps.pages(), pageId!, selectedId));
    selectedId = null;
    renderItems();
  }

  function startEdit(id: string, isNew: boolean) {
    const o = findItem(id);
    if (!o || (o.kind !== 'text' && o.kind !== 'comb')) return;
    selectedId = id;
    draft = o;
    const input = document.createElement('textarea');
    input.className = 'ov-input';
    input.ariaLabel = o.kind === 'comb' ? 'Digits' : 'Text';
    input.spellcheck = false;
    input.value = o.kind === 'comb' ? o.digits : o.text;
    input.rows = 1;
    input.wrap = 'off';
    if (o.kind === 'comb') input.inputMode = 'numeric';
    input.addEventListener('input', onEditInput);
    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', (e) => {
      const done = e.key === 'Enter' && (draft?.kind === 'comb' || e.ctrlKey || e.metaKey);
      if (done) {
        e.preventDefault();
        finishEdit();
      }
    });
    editing = { id, isNew, input };
    renderItems();
    const node = nodeOf(id)!;
    node.classList.add('editing');
    node.append(input);
    applyEditorFont(input, o);
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function applyEditorFont(input: HTMLTextAreaElement, o: Overlay) {
    if (o.kind === 'text' || o.kind === 'comb') input.style.fontSize = `${o.size * zoom}px`;
  }

  /** Redraws the item in place, since rebuilding it would take focus from the input. */
  function onEditInput() {
    if (!editing || !draft || !frame) return;
    const node = nodeOf(draft.id)!;
    const body = node.querySelector<HTMLElement>('.ov-body')!;
    if (draft.kind === 'comb') {
      const digits = cleanDigits(editing.input.value);
      if (digits !== editing.input.value) editing.input.value = digits;
      draft = { ...draft, digits };
      fillBody(body, draft, zoom);
    } else if (draft.kind === 'text') {
      const before = node.offsetWidth;
      draft = { ...draft, text: editing.input.value };
      fillBody(body, draft, zoom);
      // Hebrew grows to the left: keep the right edge where it is, as the caret is there.
      const firstLine = draft.text.split('\n')[0];
      if (isRtlLine(firstLine)) draft = moveOverlay(draft, -(node.offsetWidth - before) / zoom, 0);
      placeItem(node, draft, frame, zoom);
    }
    renderControls();
  }

  function finishEdit() {
    if (!editing) return;
    const { id, isNew, input } = editing;
    const o = draft!;
    editing = null;
    draft = null;
    input.removeEventListener('blur', finishEdit);
    const empty = o.kind === 'comb' ? o.digits === '' : o.kind === 'text' && o.text.trim() === '';
    if (isNew) {
      if (empty) selectedId = null;
      else deps.commit(addOverlay(deps.pages(), pageId!, o));
    } else if (empty) {
      deps.commit(removeOverlay(deps.pages(), pageId!, id));
      selectedId = null;
    } else if (o !== committedItems().find((c) => c.id === id)) {
      commitItem(o);
    }
    rememberSizes(o);
    renderItems();
  }

  // ---------- pointer: placing, selecting, dragging ----------

  function place(e: MouseEvent) {
    if (!tool || !frame) return;
    const rect = sheet.getBoundingClientRect();
    const at = viewToPage(frame, zoom, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    const angle = (((frame.rotation % 360) + 360) % 360) as Angle;
    const created = newOverlay(tool, `ov${++idCounter}`, at, angle, sizes);
    selectedId = created.id;
    if (created.kind === 'mark') {
      deps.commit(addOverlay(deps.pages(), pageId!, created));
      renderItems();
    } else {
      draft = created;
      renderItems();
      startEdit(created.id, true);
    }
  }

  layer.addEventListener('pointerdown', (e) => {
    // Browsers skip the click when its target was rebuilt mid-press, so this can't wait for a click to clear it.
    suppressClick = false;
    pressEndedEdit = editing !== null;
    const target = e.target as HTMLElement;
    if (e.button !== 0 || target.closest('.ov-tools, .ov-input')) return;
    const node = target.closest<HTMLElement>('.ov');
    if (!node) {
      // The hand drags the page with a mouse; fingers already scroll it natively.
      if (!tool && e.pointerType === 'mouse') {
        pan = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false };
        layer.setPointerCapture(e.pointerId);
      }
      return;
    }
    finishEdit();
    const o = findItem(node.dataset.id!);
    if (!o) return;
    e.preventDefault();
    const wasSelected = selectedId === o.id;
    selectedId = o.id;
    gesture = {
      pointerId: e.pointerId,
      kind: 'resize' in target.dataset ? 'resize' : 'move',
      startX: e.clientX,
      startY: e.clientY,
      original: o,
      size: measuredSize(o),
      moved: false,
      wasSelected,
    };
    layer.setPointerCapture(e.pointerId);
    renderItems();
  });

  layer.addEventListener('pointermove', (e) => {
    if (pan && e.pointerId === pan.pointerId) {
      const dx = e.clientX - pan.startX;
      const dy = e.clientY - pan.startY;
      if (!pan.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      pan.moved = true;
      stage.scrollLeft = pan.left - dx;
      stage.scrollTop = pan.top - dy;
      layer.classList.add('panning');
      return;
    }
    if (!gesture || e.pointerId !== gesture.pointerId || !frame) return;
    const dx = e.clientX - gesture.startX;
    const dy = e.clientY - gesture.startY;
    if (!gesture.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    gesture.moved = true;
    const { u, v } = viewDeltaToLocal(dx, dy, turnOf(gesture.original));
    const changed =
      gesture.kind === 'move'
        ? moveOverlay(gesture.original, u / zoom, v / zoom)
        : resizeFromCorner(gesture.original, gesture.size, u / zoom, v / zoom);
    draft = keepOnPage(changed, gesture.size, frame.box);
    renderItems();
  });

  function endGesture(e: PointerEvent) {
    if (pan && e.pointerId === pan.pointerId) {
      suppressClick = pan.moved;
      pan = null;
      layer.classList.remove('panning');
      return;
    }
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const { moved, wasSelected, original } = gesture;
    gesture = null;
    suppressClick = true;
    if (moved && draft) {
      const changed = draft;
      draft = null;
      rememberSizes(changed);
      commitItem(changed);
      renderItems();
    } else if (wasSelected) {
      startEdit(original.id, false);
    }
  }
  layer.addEventListener('pointerup', endGesture);

  function cancelGesture() {
    pan = null;
    if (!gesture) return;
    gesture = null;
    draft = null;
    renderItems();
  }
  layer.addEventListener('pointercancel', cancelGesture);

  layer.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-delete]')) {
      deleteSelected();
      return;
    }
    const button = target.closest<HTMLElement>('[data-size], [data-pitch]');
    if (button) {
      stepSelected(button);
      return;
    }
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (target.closest('.ov')) return;
    finishEdit();
    // A click that closes a box does only that, leaving it selected so its buttons are at hand.
    if (pressEndedEdit) {
      pressEndedEdit = false;
      renderControls();
      return;
    }
    if (tool) {
      place(e);
      return;
    }
    selectedId = null;
    renderItems();
  });

  function stepSelected(button: HTMLElement) {
    const o = findItem(selectedId);
    if (!o) return;
    const direction = Number(button.dataset.size ?? button.dataset.pitch) as 1 | -1;
    let changed = o;
    if (button.dataset.pitch && o.kind === 'comb') changed = stepPitch(o, direction);
    else if (button.dataset.size) {
      const rtl = o.kind === 'text' && isRtlLine(o.text.split(/\r\n|\r|\n/)[0]);
      changed = stepOverlaySize(o, measuredSize(o), direction, rtl);
    }
    if (changed === o) return;
    rememberSizes(changed);
    commitItem(changed);
    renderItems();
  }

  // Clicks in the empty area around the page also clear the selection.
  stage.addEventListener('click', (e) => {
    if (e.target !== stage || !selectedId) return;
    selectedId = null;
    renderItems();
  });

  for (const button of tools) {
    button.addEventListener('click', () => {
      finishEdit();
      const chosen = button.dataset.tool as Tool | 'hand';
      tool = chosen === 'hand' || tool === chosen ? null : chosen;
      selectedId = null;
      renderItems();
    });
  }

  pitch.addEventListener('input', () => {
    const o = findItem(selectedId);
    if (o?.kind !== 'comb') return;
    draft = { ...o, pitch: Number(pitch.value) };
    renderItems();
  });
  pitch.addEventListener('change', () => {
    if (draft?.kind !== 'comb') return;
    const changed = draft;
    draft = null;
    rememberSizes(changed);
    commitItem(changed);
    renderItems();
  });

  // ---------- history & keyboard ----------

  async function afterHistory() {
    selectedId = null;
    const list = deps.pages();
    if (list.length === 0) {
      dialog.close();
      return;
    }
    if (!currentPage()) pageId = list[0].id;
    if ((currentPage()?.rotation ?? 0) !== renderedRotation || !frame) await loadFrame();
    renderItems();
  }
  const undo = () => {
    finishEdit();
    deps.undo();
    void afterHistory();
  };
  const redo = () => {
    finishEdit();
    deps.redo();
    void afterHistory();
  };
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);

  // On the document, since focus falls back to the body when a finished text box is removed.
  document.addEventListener('keydown', (e) => {
    if (!dialog.open) return;
    const t = e.target as HTMLElement;
    if (t.matches('textarea, input:not([type=range])')) return;
    const shortcut = shortcutFor(e);
    if (shortcut === 'undo') {
      e.preventDefault();
      undo();
    } else if (shortcut === 'redo') {
      e.preventDefault();
      redo();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.preventDefault();
      deleteSelected();
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      stepPage(-1);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      stepPage(1);
    }
  });

  // Escape returns to the hand with nothing selected. Only one press can be intercepted
  // reliably (browsers close a dialog on a repeat), so it does all of that at once.
  dialog.addEventListener('cancel', (e) => {
    if (!editing && !tool && !selectedId) return;
    e.preventDefault();
    finishEdit();
    tool = null;
    selectedId = null;
    renderItems();
  });

  $('ed-done').addEventListener('click', () => dialog.close());

  // Width only: a phone's keyboard changes the height, and refitting would end the typing that opened it.
  let observedWidth = 0;
  const resizes = new ResizeObserver(() => {
    if (stage.clientWidth === observedWidth) return;
    observedWidth = stage.clientWidth;
    if (dialog.open && fitted && frame) fitToWidth();
  });

  dialog.addEventListener('close', () => {
    finishEdit();
    resizes.disconnect();
    clearTimeout(renderTimer);
    renderToken++;
    img.removeAttribute('src');
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    imageUrl = null;
    layer.replaceChildren();
    pageId = null;
    frame = null;
    tool = null;
    selectedId = null;
    gesture = null;
    pan = null;
  });

  return {
    async open(id: string) {
      fitted = true;
      dialog.showModal();
      // Text is measured for layout, so its font must be ready first.
      await Promise.all([document.fonts.load('16px Heebo', 'a'), document.fonts.load('16px Heebo', String.fromCharCode(0x5d0))]).catch(() => {});
      await showPage(id);
      observedWidth = stage.clientWidth;
      resizes.observe(stage);
    },
  };
}
