import { buildInk, strokePath, type InkPoint } from './ink';
import { inkSvg } from './overlayView';
import { prepareUpload } from './signatureImage';
import type { Signature, SignatureStore } from './signatures';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The dialog for choosing a signature, drawing a new one, or uploading one. */
export function createSignaturePicker(store: SignatureStore) {
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
  const context = canvas.getContext('2d')!;

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
        return item;
      }),
    );
  }

  function finish(choice: Signature | null) {
    const resolve = resolveChoice;
    resolveChoice = null;
    if (dialog.open) dialog.close();
    resetDrawing();
    resolve?.(choice);
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

  use.addEventListener('click', () => {
    if (upload) {
      finish(store.addImage(upload.png, upload.width, upload.height));
      return;
    }
    const ink = buildInk(strokes);
    if (ink) finish(store.addInk(ink));
  });

  list.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const remove = target.closest<HTMLElement>('[data-remove]');
    if (remove) {
      store.remove(remove.dataset.remove!);
      renderList();
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
      return new Promise((resolve) => (resolveChoice = resolve));
    },
  };
}
