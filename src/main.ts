import './style.css';
import {
  History,
  insertPages,
  movePages,
  rangeSelect,
  removePages,
  shiftPages,
  type PageRef,
} from './model';
import { buildPdf, checkEditable } from './pdf';
import { downloadBlob } from './download';
import { openPdf, renderPage, ThumbnailCache, type PDFDocumentProxy } from './render';

// ---------- state ----------

interface Source {
  id: string;
  name: string;
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
  numPages: number;
  hue: number;
}

const sources = new Map<string, Source>();
const history = new History<PageRef[]>([]);
let docSel = new Set<string>();
let docAnchor: string | null = null;
let activeSourceId: string | null = null;
/** Picked page indices per source, in click order (= insertion order). */
const picks = new Map<string, number[]>();
let srcAnchor: number | null = null;
let filesCollapsed = false;
/** Phones and tablets, where drag-and-drop between panels usually doesn't work. */
const touchQuery = window.matchMedia('(hover: none) and (pointer: coarse)');

let idCounter = 0;
const newId = (prefix: string) => `${prefix}${++idCounter}`;
const HUES = [212, 152, 28, 280, 340, 190, 95, 250];

const pages = () => history.current;
const commit = (next: PageRef[]) => {
  history.push(next);
  render();
};

const thumbs = new ThumbnailCache(3);
const THUMB_W = 150;

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  fileInput: $<HTMLInputElement>('file-input'),
  add: $<HTMLButtonElement>('btn-add'),
  undo: $<HTMLButtonElement>('btn-undo'),
  redo: $<HTMLButtonElement>('btn-redo'),
  reset: $<HTMLButtonElement>('btn-reset'),
  preview: $<HTMLButtonElement>('btn-preview'),
  download: $<HTMLButtonElement>('btn-download'),
  empty: $('empty'),
  dropzone: $<HTMLButtonElement>('dropzone'),
  workspace: $('workspace'),
  docCount: $('doc-count'),
  docGrid: $('doc-grid'),
  docEmpty: $('doc-empty'),
  docHint: $('doc-hint'),
  docAll: $<HTMLButtonElement>('btn-doc-all'),
  docClear: $<HTMLButtonElement>('btn-doc-clear'),
  del: $<HTMLButtonElement>('btn-delete'),
  earlier: $<HTMLButtonElement>('btn-earlier'),
  later: $<HTMLButtonElement>('btn-later'),
  delCount: $('doc-delcount'),
  filesToggle: $<HTMLButtonElement>('btn-files-toggle'),
  filesCount: $('files-count'),
  srcTabs: $('src-tabs'),
  srcGrid: $('src-grid'),
  srcNote: $('src-note'),
  srcAll: $<HTMLButtonElement>('btn-src-all'),
  srcClear: $<HTMLButtonElement>('btn-src-clear'),
  srcAddEnd: $<HTMLButtonElement>('btn-src-add-end'),
  bottombar: $('bottombar'),
  outSummary: $('out-summary'),
  confirm: $<HTMLDialogElement>('confirm'),
  confirmMsg: $('confirm-msg'),
  confirmSub: $('confirm-sub'),
  confirmOk: $<HTMLButtonElement>('confirm-ok'),
  confirmCancel: $<HTMLButtonElement>('confirm-cancel'),
  lightbox: $<HTMLDialogElement>('lightbox'),
  lbTitle: $('lb-title'),
  lbImg: $<HTMLImageElement>('lb-img'),
  lbPrev: $<HTMLButtonElement>('lb-prev'),
  lbNext: $<HTMLButtonElement>('lb-next'),
  previewDlg: $<HTMLDialogElement>('preview'),
  pvTitle: $('pv-title'),
  pvPages: $('pv-pages'),
  pvOpen: $<HTMLAnchorElement>('pv-open'),
  pvDownload: $<HTMLButtonElement>('pv-download'),
  toast: $('toast'),
};

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let toastTimer = 0;
function toast(message: string, kind: 'info' | 'error' = 'info') {
  el.toast.textContent = message;
  el.toast.className = `toast ${kind}`;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), kind === 'error' ? 6000 : 3000);
}

/** A styled replacement for window.confirm(). Resolves true only if the user clicks OK. */
function ask(message: string, detail: string, okLabel: string): Promise<boolean> {
  el.confirmMsg.textContent = message;
  el.confirmSub.textContent = detail;
  el.confirmOk.textContent = okLabel;
  answerConfirm(false); // settle any earlier, unanswered question
  el.confirm.showModal();
  el.confirmCancel.focus();
  return new Promise((resolve) => (pendingConfirm = resolve));
}
let pendingConfirm: ((ok: boolean) => void) | null = null;
// Settle synchronously from the buttons rather than waiting for the dialog's
// async 'close' event.
function answerConfirm(ok: boolean) {
  const resolve = pendingConfirm;
  pendingConfirm = null;
  if (el.confirm.open) el.confirm.close();
  resolve?.(ok);
}
el.confirmOk.addEventListener('click', () => answerConfirm(true));
el.confirmCancel.addEventListener('click', () => answerConfirm(false));
el.confirm.addEventListener('cancel', () => answerConfirm(false)); // Escape key
el.confirm.addEventListener('close', () => answerConfirm(false));
el.confirm.addEventListener('click', (e) => {
  if (e.target === el.confirm) answerConfirm(false); // backdrop click
});

// ---------- thumbnails (lazy) ----------

const loaders = new WeakMap<Element, () => void>();
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      loaders.get(e.target)?.();
      observer.unobserve(e.target);
    }
  },
  { rootMargin: '300px' },
);

/** Stops lazy-loading thumbnails of cards that are about to be discarded. */
function releaseThumbs(grid: HTMLElement) {
  for (const box of grid.querySelectorAll('.thumb.loading')) observer.unobserve(box);
}

function thumbnail(sourceId: string, pageIndex: number): HTMLElement {
  const img = h('img', { alt: '', decoding: 'async', draggable: false });
  const box = h('div', { className: 'thumb loading' }, img);
  const load = () => {
    const src = sources.get(sourceId);
    if (!src) return;
    thumbs
      .get(`${sourceId}:${pageIndex}:t`, () => renderPage(src.pdf, pageIndex, THUMB_W))
      .then((url) => {
        img.src = url;
        box.classList.remove('loading');
      })
      .catch(() => box.classList.replace('loading', 'failed'));
  };
  if (thumbs.peek(`${sourceId}:${pageIndex}:t`)) load();
  else {
    loaders.set(box, load);
    observer.observe(box);
  }
  return box;
}

// ---------- rendering ----------

function render() {
  const hasSources = sources.size > 0;
  const n = pages().length;
  el.empty.hidden = hasSources;
  el.workspace.hidden = !hasSources;
  el.bottombar.hidden = !hasSources;
  el.undo.disabled = !history.canUndo;
  el.redo.disabled = !history.canRedo;
  el.reset.disabled = !hasSources;
  el.preview.disabled = el.download.disabled = n === 0;
  el.outSummary.textContent = n ? `${n} page${n === 1 ? '' : 's'} ready` : 'No pages yet';
  el.add.textContent = hasSources ? 'Add PDF…' : 'Open PDF…';
  el.workspace.classList.toggle('files-collapsed', filesCollapsed);
  el.filesToggle.setAttribute('aria-expanded', String(!filesCollapsed));
  el.filesToggle.title = filesCollapsed ? 'Show files' : 'Hide files';

  // Drop selections that no longer exist (e.g. after undo).
  const present = new Set(pages().map((p) => p.id));
  docSel = new Set([...docSel].filter((id) => present.has(id)));

  renderDoc();
  renderSources();
}

function shortName(name: string) {
  const base = name.replace(/\.pdf$/i, '');
  return base.length > 18 ? `${base.slice(0, 16)}…` : base;
}

/** Updates selection state in place (no re-render), so large documents stay snappy. */
function renderDocSelection() {
  const n = docSel.size;
  el.docClear.hidden = el.del.hidden = n === 0;
  el.docAll.hidden = n > 0 && n === pages().length;
  el.delCount.textContent = `Delete ${n}`;
  el.del.ariaLabel = `Remove ${n} selected page${n === 1 ? '' : 's'}`;
  const touch = touchQuery.matches;
  el.earlier.hidden = el.later.hidden = !touch || n === 0;
  el.earlier.disabled = shiftPages(pages(), docSel, -1) === pages();
  el.later.disabled = shiftPages(pages(), docSel, 1) === pages();
  el.docHint.textContent = touch
    ? n
      ? `${n} selected. Use ◀ ▶ or long-press and drag to move ${n === 1 ? 'it' : 'them'}, or tap the trash button to remove ${n === 1 ? 'it' : 'them'}.`
      : 'Tap pages to select them. Long-press a page and drag to reorder.'
    : n
      ? `${n} selected. Drag them to move them together, or click the trash button to remove them.`
      : 'Click pages to select them. Drag to reorder. Double-click to enlarge.';
  for (const card of el.docGrid.querySelectorAll<HTMLElement>('.card')) {
    const selected = docSel.has(card.dataset.id!);
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-selected', String(selected));
  }
}

function renderDoc() {
  const list = pages();
  el.docCount.textContent = `· ${list.length} page${list.length === 1 ? '' : 's'}`;
  el.docEmpty.hidden = list.length > 0;

  const multi = sources.size > 1;
  const cards = list.map((p, i) => {
    const src = sources.get(p.sourceId)!;
    const selected = docSel.has(p.id);
    const remove = h('button', {
      className: 'card-btn remove',
      type: 'button',
      title: 'Remove page',
      ariaLabel: `Remove page ${i + 1}`,
      textContent: '✕',
    });
    remove.dataset.action = 'remove';
    const zoom = h('button', {
      className: 'card-btn zoom',
      type: 'button',
      title: 'Enlarge',
      ariaLabel: `Enlarge page ${i + 1}`,
      textContent: '⤢',
    });
    zoom.dataset.action = 'zoom';
    const card = h(
      'div',
      { className: `card${selected ? ' selected' : ''}`, draggable: !touchQuery.matches, tabIndex: 0 },
      thumbnail(p.sourceId, p.pageIndex),
      h(
        'div',
        { className: 'label' },
        h('b', { textContent: String(i + 1) }),
        h('span', {
          className: 'origin',
          textContent: multi ? `${shortName(src.name)} p.${p.pageIndex + 1}` : `p.${p.pageIndex + 1}`,
          title: `${src.name}, page ${p.pageIndex + 1}`,
        }),
      ),
      remove,
      zoom,
    );
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', String(selected));
    card.setAttribute('aria-label', `Page ${i + 1}: ${src.name} page ${p.pageIndex + 1}`);
    card.dataset.id = p.id;
    card.dataset.index = String(i);
    if (multi) card.style.setProperty('--src-hue', String(src.hue));
    card.classList.toggle('tinted', multi);
    return card;
  });
  releaseThumbs(el.docGrid);
  el.docGrid.replaceChildren(...cards);
  renderDocSelection();
}

function renderSources() {
  if (activeSourceId && !sources.has(activeSourceId)) activeSourceId = null;
  if (!activeSourceId) activeSourceId = [...sources.keys()].at(-1) ?? null;

  el.srcTabs.replaceChildren(
    ...[...sources.values()].map((s) => {
      const tab = h(
        'div',
        { className: `tab${s.id === activeSourceId ? ' active' : ''}` },
        h('button', {
          type: 'button',
          className: 'tab-name',
          textContent: `${shortName(s.name)} (${s.numPages})`,
          title: s.name,
        }),
        h('button', {
          type: 'button',
          className: 'tab-close',
          textContent: '✕',
          title: `Close ${s.name}`,
          ariaLabel: `Close ${s.name}`,
        }),
      );
      tab.style.setProperty('--src-hue', String(s.hue));
      tab.dataset.source = s.id;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(s.id === activeSourceId));
      return tab;
    }),
  );

  const src = activeSourceId ? sources.get(activeSourceId) : undefined;
  const picked = src ? (picks.get(src.id) ?? []) : [];
  const used = new Set(pages().filter((p) => p.sourceId === src?.id).map((p) => p.pageIndex));
  const cards: HTMLElement[] = [];
  if (src) {
    for (let i = 0; i < src.numPages; i++) {
      const order = picked.indexOf(i);
      const card = h(
        'div',
        {
          className: `card${order >= 0 ? ' selected' : ''}`,
          draggable: !touchQuery.matches,
          tabIndex: 0,
          title: used.has(i) ? 'Already in your document' : '',
        },
        thumbnail(src.id, i),
        h(
          'div',
          { className: 'label' },
          h('span', { textContent: `p.${i + 1}` }),
          used.has(i) ? h('span', { className: 'used', textContent: '● in doc' }) : '',
        ),
      );
      if (order >= 0) card.append(h('span', { className: 'badge', textContent: String(order + 1) }));
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', String(order >= 0));
      card.setAttribute('aria-label', `${src.name} page ${i + 1}`);
      card.dataset.index = String(i);
      cards.push(card);
    }
  }
  releaseThumbs(el.srcGrid);
  el.srcGrid.replaceChildren(...cards);

  el.filesCount.textContent = `(${sources.size})`;
  const touch = touchQuery.matches;
  const one = picked.length === 1;
  el.srcNote.textContent = picked.length
    ? `${picked.length} selected (${picked.map((i) => i + 1).join(', ')}). ` +
      (touch
        ? `Tap “Add to end” to add ${one ? 'it after the last page.' : 'them after the last page, in this order.'}`
        : `Drag ${one ? 'it' : 'them'} to the place you want in your document.${one ? '' : ' They’ll go in this order.'}`)
    : touch
      ? 'Tap pages in the order you want, then tap “Add to end” or long-press and drag them into your document.'
      : 'Select pages in the order you want, then drag them into your document.';
  el.srcClear.hidden = picked.length === 0;
  el.srcAddEnd.hidden = !touch || picked.length === 0;
  el.srcAddEnd.textContent = picked.length > 1 ? `Add ${picked.length} to end` : 'Add to end';
  el.srcAll.hidden = !!src && picked.length === src.numPages;
}

// ---------- files ----------

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

async function addFiles(files: Iterable<File>) {
  for (const file of files) {
    if (!isPdf(file)) {
      toast(`“${file.name}” isn’t a PDF.`, 'error');
      continue;
    }
    let pdf: PDFDocumentProxy;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      await checkEditable(bytes);
      pdf = await openPdf(bytes);
    } catch (err) {
      toast(`${file.name}: ${err instanceof Error ? err.message : err}`, 'error');
      continue;
    }
    const id = newId('s');
    const first = sources.size === 0;
    sources.set(id, { id, name: file.name, bytes, pdf, numPages: pdf.numPages, hue: HUES[sources.size % HUES.length] });
    activeSourceId = id;
    if (first) {
      history.reset(Array.from({ length: pdf.numPages }, (_, i) => ({ id: newId('p'), sourceId: id, pageIndex: i })));
    } else {
      filesCollapsed = false;
      toast(`Added “${file.name}”. Select its pages in the Files panel and drag them into your document.`);
    }
    render();
  }
}

async function closeSource(id: string) {
  const src = sources.get(id);
  if (!src) return;
  const usedCount = pages().filter((p) => p.sourceId === id).length;
  if (usedCount > 0) {
    const ok = await ask(
      `Close “${src.name}”?`,
      `Its ${usedCount} page${usedCount === 1 ? '' : 's'} will be removed from your document. This can’t be undone.`,
      'Close file',
    );
    if (!ok || !sources.has(id)) return;
  }
  sources.delete(id);
  picks.delete(id);
  thumbs.drop(`${id}:`);
  void src.pdf.loadingTask.destroy();
  if (sources.size === 0) {
    history.reset([]);
  } else {
    // Undo history may reference the closed file, so start a fresh history.
    history.reset(pages().filter((p) => p.sourceId !== id));
  }
  render();
}

async function startOver() {
  const ok = await ask('Close all files and start over?', 'Your current document will be discarded.', 'Start over');
  if (!ok) return;
  for (const id of [...sources.keys()]) {
    const src = sources.get(id)!;
    void src.pdf.loadingTask.destroy();
    thumbs.drop(`${id}:`);
  }
  sources.clear();
  picks.clear();
  docSel.clear();
  history.reset([]);
  render();
}

// ---------- document actions ----------

async function deleteSelected() {
  const n = docSel.size;
  if (n === 0) return;
  if (n > 1) {
    const ok = await ask(
      `Remove ${n} pages from your document?`,
      'You can bring them back with Undo (Ctrl+Z).',
      `Remove ${n} pages`,
    );
    if (!ok) return;
  }
  const next = removePages(pages(), docSel);
  docSel.clear();
  commit(next);
  toast(`Removed ${n} page${n === 1 ? '' : 's'}. Press Ctrl+Z to undo.`);
}

function insertPicked(gap: number, sourceId: string, indices: number[]) {
  if (indices.length === 0) return;
  const added = indices.map((pageIndex) => ({ id: newId('p'), sourceId, pageIndex }));
  picks.set(sourceId, []);
  srcAnchor = null;
  docSel = new Set(added.map((p) => p.id));
  commit(insertPages(pages(), added, gap));
  const where = gap === 0 ? 'at the beginning' : `after page ${gap}`;
  const one = added.length === 1;
  toast(
    `Inserted ${added.length} page${one ? '' : 's'} ${where}.` +
      (touchQuery.matches ? '' : ` ${one ? 'It’s' : 'They’re'} selected, so you can move ${one ? 'it' : 'them'}.`),
  );
  el.docGrid.querySelector(`[data-id="${added[0].id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function undo() {
  history.undo();
  render();
}
function redo() {
  history.redo();
  render();
}

// ---------- output ----------

function outputName() {
  const first = [...sources.values()][0];
  return `${first ? first.name.replace(/\.pdf$/i, '') : 'document'}-remix.pdf`;
}

async function makeOutput(): Promise<Blob | null> {
  const bytesBySource = new Map([...sources].map(([id, s]) => [id, s.bytes]));
  try {
    const bytes = await buildPdf(bytesBySource, pages());
    return new Blob([bytes as BlobPart], { type: 'application/pdf' });
  } catch (err) {
    toast(`Couldn’t build the PDF: ${err instanceof Error ? err.message : err}`, 'error');
    return null;
  }
}

const saveBlob = (blob: Blob) => downloadBlob(blob, outputName());

async function withBusy(button: HTMLButtonElement, label: string, fn: () => Promise<void>) {
  const text = button.querySelector('.lbl')!;
  const old = text.textContent;
  button.disabled = true;
  text.textContent = label;
  try {
    await fn();
  } finally {
    text.textContent = old;
    button.disabled = pages().length === 0;
  }
}

let previewBlob: Blob | null = null;
let previewUrl: string | null = null;
let previewPdf: PDFDocumentProxy | null = null;
const previewRenders = new ThumbnailCache(2);

/** Renders the actual output PDF (not the workspace) so the preview is exactly what you'll download. */
async function openPreview() {
  await withBusy(el.preview, 'Building…', async () => {
    const blob = await makeOutput();
    if (!blob) return;
    previewBlob = blob;
    previewUrl = URL.createObjectURL(blob);
    el.pvOpen.href = previewUrl;
    el.pvTitle.textContent = `Preview: ${outputName()} (${pages().length} pages)`;
    try {
      previewPdf = await openPdf(new Uint8Array(await blob.arrayBuffer()));
    } catch (err) {
      toast(`Couldn’t preview the PDF: ${err instanceof Error ? err.message : err}`, 'error');
      return;
    }
    const pdf = previewPdf;
    const width = Math.min(820, Math.max(240, window.innerWidth - 120));
    const pvObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          pvObserver.unobserve(e.target);
          const i = Number((e.target as HTMLElement).dataset.index);
          const img = e.target.querySelector('img')!;
          previewRenders
            .get(`pv:${i}`, () => renderPage(pdf, i, width))
            .then((url) => {
              img.src = url;
              e.target.classList.remove('loading');
            })
            .catch(() => e.target.classList.replace('loading', 'failed'));
        }
      },
      { root: el.pvPages, rootMargin: '600px' },
    );
    el.pvPages.replaceChildren(
      ...Array.from({ length: pdf.numPages }, (_, i) => {
        const sheet = h(
          'figure',
          { className: 'pv-page loading' },
          h('img', { alt: `Page ${i + 1}` }),
          h('figcaption', { textContent: `${i + 1} / ${pdf.numPages}` }),
        );
        sheet.dataset.index = String(i);
        sheet.style.width = `${width}px`;
        return sheet;
      }),
    );
    el.previewDlg.showModal();
    el.pvPages.scrollTop = 0;
    for (const sheet of el.pvPages.children) pvObserver.observe(sheet);
    el.previewDlg.addEventListener('close', () => pvObserver.disconnect(), { once: true });
  });
}

el.previewDlg.addEventListener('close', () => {
  el.pvPages.replaceChildren();
  previewRenders.drop('pv:');
  void previewPdf?.loadingTask.destroy();
  previewPdf = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  previewBlob = null;
});

// ---------- lightbox ----------

let lb: { items: { sourceId: string; pageIndex: number; title: string }[]; index: number } | null = null;

function openLightbox(items: NonNullable<typeof lb>['items'], index: number) {
  lb = { items, index };
  showLightboxPage();
  if (!el.lightbox.open) el.lightbox.showModal();
}

function showLightboxPage() {
  if (!lb) return;
  const item = lb.items[lb.index];
  const src = sources.get(item.sourceId);
  if (!src) return;
  el.lbTitle.textContent = item.title;
  el.lbPrev.disabled = lb.index === 0;
  el.lbNext.disabled = lb.index === lb.items.length - 1;
  el.lbImg.removeAttribute('src');
  const width = Math.min(1000, Math.max(320, window.innerWidth - 160));
  const want = lb.index;
  thumbs
    .get(`${item.sourceId}:${item.pageIndex}:L${width}`, () => renderPage(src.pdf, item.pageIndex, width))
    .then((url) => {
      if (lb?.index === want) el.lbImg.src = url;
    })
    .catch(() => toast('Couldn’t render this page.', 'error'));
}

function stepLightbox(delta: number) {
  if (!lb) return;
  const next = lb.index + delta;
  if (next < 0 || next >= lb.items.length) return;
  lb.index = next;
  showLightboxPage();
}

function docLightboxItems() {
  const multi = sources.size > 1;
  return pages().map((p, i) => ({
    sourceId: p.sourceId,
    pageIndex: p.pageIndex,
    title: `Page ${i + 1} of ${pages().length}${multi ? ` (${sources.get(p.sourceId)!.name} p.${p.pageIndex + 1})` : ''}`,
  }));
}

el.lbPrev.addEventListener('click', () => stepLightbox(-1));
el.lbNext.addEventListener('click', () => stepLightbox(1));
el.lightbox.addEventListener('close', () => (lb = null));
for (const dlg of [el.lightbox, el.previewDlg]) {
  dlg.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    // Close on the ✕ button or a click on the backdrop.
    if (t.closest('[data-close]') || t === dlg) dlg.close();
  });
}

// ---------- events: document grid ----------

el.docGrid.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const card = t.closest<HTMLElement>('.card');
  if (!card) return;
  const id = card.dataset.id!;
  const action = t.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action === 'remove') {
    commit(removePages(pages(), new Set([id])));
    return;
  }
  if (action === 'zoom') {
    openLightbox(docLightboxItems(), Number(card.dataset.index));
    return;
  }
  if (e.shiftKey && docAnchor) {
    docSel = new Set([...docSel, ...rangeSelect(pages(), docAnchor, id)]);
  } else {
    if (docSel.has(id)) docSel.delete(id);
    else docSel.add(id);
    docAnchor = id;
  }
  renderDocSelection();
});

el.docGrid.addEventListener('dblclick', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
  if (!card || (e.target as HTMLElement).closest('[data-action]')) return;
  openLightbox(docLightboxItems(), Number(card.dataset.index));
});

el.docGrid.addEventListener('keydown', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
  if (!card) return;
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    card.click();
  }
});

el.del.addEventListener('click', () => void deleteSelected());
function shiftSelected(delta: -1 | 1) {
  const next = shiftPages(pages(), docSel, delta);
  if (next === pages()) return;
  commit(next);
  const first = el.docGrid.querySelector('.card.selected');
  first?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
el.earlier.addEventListener('click', () => shiftSelected(-1));
el.later.addEventListener('click', () => shiftSelected(1));
el.docClear.addEventListener('click', () => {
  docSel.clear();
  renderDocSelection();
});
el.docAll.addEventListener('click', () => {
  docSel = new Set(pages().map((p) => p.id));
  renderDocSelection();
});

// ---------- events: source panel ----------

el.srcTabs.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const tab = t.closest<HTMLElement>('.tab');
  if (!tab) return;
  const id = tab.dataset.source!;
  if (t.closest('.tab-close')) void closeSource(id);
  else {
    activeSourceId = id;
    srcAnchor = null;
    render();
  }
});

el.srcGrid.addEventListener('click', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
  if (!card || !activeSourceId) return;
  const i = Number(card.dataset.index);
  const list = picks.get(activeSourceId) ?? [];
  if (e.shiftKey && srcAnchor !== null) {
    const [lo, hi] = srcAnchor < i ? [srcAnchor, i] : [i, srcAnchor];
    const step = srcAnchor < i ? 1 : -1;
    // Add the range in the direction it was selected, skipping ones already picked.
    for (let k = srcAnchor; step > 0 ? k <= hi : k >= lo; k += step) if (!list.includes(k)) list.push(k);
  } else {
    const at = list.indexOf(i);
    if (at >= 0) list.splice(at, 1);
    else list.push(i);
    srcAnchor = i;
  }
  picks.set(activeSourceId, list);
  const hadFocus = card.contains(document.activeElement);
  renderSources();
  // The grid was rebuilt; keep keyboard focus on the same page.
  if (hadFocus) el.srcGrid.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
});

el.srcGrid.addEventListener('dblclick', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
  const src = activeSourceId ? sources.get(activeSourceId) : undefined;
  if (!card || !src) return;
  const items = Array.from({ length: src.numPages }, (_, i) => ({
    sourceId: src.id,
    pageIndex: i,
    title: `${src.name}: page ${i + 1} of ${src.numPages}`,
  }));
  openLightbox(items, Number(card.dataset.index));
});

el.srcGrid.addEventListener('keydown', (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
  if (card && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    card.click();
  }
});

el.srcAll.addEventListener('click', () => {
  const src = activeSourceId ? sources.get(activeSourceId) : undefined;
  if (!src) return;
  picks.set(src.id, Array.from({ length: src.numPages }, (_, i) => i));
  renderSources();
});
el.srcClear.addEventListener('click', () => {
  if (activeSourceId) picks.set(activeSourceId, []);
  srcAnchor = null;
  renderSources();
});
el.srcAddEnd.addEventListener('click', () => {
  if (activeSourceId) insertPicked(pages().length, activeSourceId, picks.get(activeSourceId) ?? []);
});
touchQuery.addEventListener('change', render);
el.filesToggle.addEventListener('click', () => {
  filesCollapsed = !filesCollapsed;
  render();
});

// ---------- drag and drop ----------

type Drag = { kind: 'doc'; ids: Set<string> } | { kind: 'src'; sourceId: string; indices: number[] };
let drag: Drag | null = null;

/** What a drag starting on `card` carries: the whole selection if the card is part of it. */
function dragFromCard(card: HTMLElement): Drag | null {
  if (el.docGrid.contains(card)) {
    const id = card.dataset.id!;
    return { kind: 'doc', ids: docSel.has(id) ? new Set(docSel) : new Set([id]) };
  }
  if (!activeSourceId) return null;
  const i = Number(card.dataset.index);
  const list = picks.get(activeSourceId) ?? [];
  return { kind: 'src', sourceId: activeSourceId, indices: list.includes(i) ? [...list] : [i] };
}

const dragCount = (d: Drag) => (d.kind === 'doc' ? d.ids.size : d.indices.length);

function beginDrag(d: Drag) {
  drag = d;
  if (d.kind !== 'doc') return;
  requestAnimationFrame(() => {
    for (const c of el.docGrid.querySelectorAll<HTMLElement>('.card')) {
      if (d.ids.has(c.dataset.id!)) c.classList.add('dragging');
    }
  });
}

function endDrag() {
  drag = null;
  clearDropMarker();
  for (const c of document.querySelectorAll('.dragging')) c.classList.remove('dragging');
}

function dropAt(gap: number) {
  const d = drag;
  endDrag();
  if (!d) return;
  if (d.kind === 'doc') {
    const next = movePages(pages(), d.ids, gap);
    if (next.some((p, i) => p !== pages()[i])) commit(next);
  } else {
    insertPicked(gap, d.sourceId, d.indices);
  }
}

function onDragStart(e: DragEvent) {
  const card = (e.target as HTMLElement).closest<HTMLElement>('.card');
  const d = card && dragFromCard(card);
  if (!card || !d || !e.dataTransfer) return;
  beginDrag(d);
  e.dataTransfer.effectAllowed = d.kind === 'doc' ? 'move' : 'copy';
  e.dataTransfer.setData('text/plain', `${dragCount(d)} page(s)`);
  if (dragCount(d) > 1) setDragBadge(e.dataTransfer, card, dragCount(d));
}
el.docGrid.addEventListener('dragstart', onDragStart);
el.srcGrid.addEventListener('dragstart', onDragStart);

function setDragBadge(dt: DataTransfer, card: HTMLElement, count: number) {
  const ghost = card.cloneNode(true) as HTMLElement;
  ghost.classList.add('drag-ghost');
  ghost.append(h('span', { className: 'ghost-count', textContent: `${count} pages` }));
  document.body.append(ghost);
  dt.setDragImage(ghost, 40, 40);
  setTimeout(() => ghost.remove());
}

function clearDropMarker() {
  for (const c of el.docGrid.querySelectorAll('.drop-before, .drop-after')) {
    c.classList.remove('drop-before', 'drop-after');
  }
}

function showDropMarker(gap: number) {
  clearDropMarker();
  const cards = el.docGrid.querySelectorAll('.card');
  if (gap < cards.length) cards[gap].classList.add('drop-before');
  else cards[cards.length - 1]?.classList.add('drop-after');
}

/** The gap (0..n) in the document grid nearest to a pointer position. */
function gapAt(x: number, y: number): number {
  const cards = [...el.docGrid.querySelectorAll<HTMLElement>('.card')];
  if (cards.length === 0) return 0;
  let best = 0;
  let bestDist = Infinity;
  cards.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dist = dy * 4 + dx; // prefer the card on the same row
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  });
  const r = cards[best].getBoundingClientRect();
  return x < r.left + r.width / 2 ? best : best + 1;
}

el.docGrid.addEventListener('dragover', (e) => {
  if (!drag) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = drag.kind === 'doc' ? 'move' : 'copy';
  showDropMarker(gapAt(e.clientX, e.clientY));
});

el.docGrid.addEventListener('dragleave', (e) => {
  if (!el.docGrid.contains(e.relatedTarget as Node)) clearDropMarker();
});

el.docGrid.addEventListener('drop', (e) => {
  if (!drag) return;
  e.preventDefault();
  dropAt(gapAt(e.clientX, e.clientY));
});

document.addEventListener('dragend', endDrag);

// ---------- touch: long-press, then drag ----------
// Phone and tablet browsers mostly don't support HTML5 drag-and-drop, so on
// touch screens a long press picks pages up and a finger drag moves them.

const LONG_PRESS_MS = 400;
const MOVE_TOLERANCE = 10;
const main = document.querySelector('main')!;
let press: { card: HTMLElement; x: number; y: number; timer: number } | null = null;
let ghost: HTMLElement | null = null;
let finger = { x: 0, y: 0 };
let scrollFrame = 0;
let suppressClick = false;

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function overDocGrid(x: number, y: number) {
  const r = el.docGrid.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function startTouchDrag() {
  if (!press) return;
  const { card, x, y } = press;
  press = null;
  const d = dragFromCard(card);
  if (!d) return;
  beginDrag(d);
  navigator.vibrate?.(15);
  ghost = card.cloneNode(true) as HTMLElement;
  ghost.classList.add('touch-ghost');
  for (const b of ghost.querySelectorAll('.card-btn')) b.remove();
  ghost.style.width = `${card.offsetWidth}px`;
  if (dragCount(d) > 1) ghost.append(h('span', { className: 'ghost-count', textContent: `${dragCount(d)} pages` }));
  document.body.append(ghost);
  moveTouchDrag(x, y);
  scrollFrame = requestAnimationFrame(autoScroll);
}

function moveTouchDrag(x: number, y: number) {
  finger = { x, y };
  if (!ghost) return;
  // Keep the page just above the finger so the drop marker stays visible.
  ghost.style.left = `${x - ghost.offsetWidth / 2}px`;
  ghost.style.top = `${y - ghost.offsetHeight + 10}px`;
  if (overDocGrid(x, y)) showDropMarker(gapAt(x, y));
  else clearDropMarker();
}

/** Scrolls whichever container the finger is near the edge of. */
function autoScroll() {
  if (!ghost) return;
  const { x, y } = finger;
  for (const box of [el.docGrid, main]) {
    const r = box.getBoundingClientRect();
    if (x < r.left || x > r.right) continue;
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const edge = 70;
    const speed = y < top + edge ? -(top + edge - y) / 4 : y > bottom - edge ? (y - (bottom - edge)) / 4 : 0;
    if (speed) box.scrollTop += Math.max(-20, Math.min(20, speed));
  }
  moveTouchDrag(x, y);
  scrollFrame = requestAnimationFrame(autoScroll);
}

function finishTouchDrag(drop: boolean) {
  cancelAnimationFrame(scrollFrame);
  ghost?.remove();
  ghost = null;
  // The browser may still fire a click for this touch; ignore it.
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 400);
  const { x, y } = finger;
  if (drop && overDocGrid(x, y)) dropAt(gapAt(x, y));
  else endDrag();
}

for (const grid of [el.docGrid, el.srcGrid]) {
  grid.addEventListener(
    'touchstart',
    (e) => {
      cancelPress();
      const t = e.target as HTMLElement;
      const card = t.closest<HTMLElement>('.card');
      if (e.touches.length !== 1 || !card || t.closest('button')) return;
      const { clientX: x, clientY: y } = e.touches[0];
      press = { card, x, y, timer: window.setTimeout(startTouchDrag, LONG_PRESS_MS) };
    },
    { passive: true },
  );
  grid.addEventListener(
    'touchmove',
    (e) => {
      const { clientX: x, clientY: y } = e.touches[0];
      if (press && Math.hypot(x - press.x, y - press.y) > MOVE_TOLERANCE) cancelPress(); // it's a scroll
      if (!ghost) return;
      e.preventDefault(); // don't scroll the page while dragging
      moveTouchDrag(x, y);
    },
    { passive: false },
  );
  grid.addEventListener('touchend', (e) => {
    cancelPress();
    if (!ghost) return;
    e.preventDefault();
    finishTouchDrag(true);
  });
  grid.addEventListener('touchcancel', () => {
    cancelPress();
    if (ghost) finishTouchDrag(false);
  });
  // Long-pressing an image would otherwise open the browser's context menu.
  grid.addEventListener('contextmenu', (e) => {
    if (touchQuery.matches) e.preventDefault();
  });
}

document.addEventListener(
  'click',
  (e) => {
    if (!suppressClick) return;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

// Dropping files from the OS anywhere on the page. While dragging, the Files
// panel opens and gets a dotted frame (on the start screen, the drop zone does).
let fileDragDepth = 0;
let collapsedBeforeFileDrag = false;
const hasFiles = (e: DragEvent) => !drag && !!e.dataTransfer?.types.includes('Files');

function startFileDrag() {
  document.body.classList.add('file-dragging');
  collapsedBeforeFileDrag = filesCollapsed;
  if (filesCollapsed) {
    filesCollapsed = false;
    render();
  }
}
function endFileDrag(dropped: boolean) {
  fileDragDepth = 0;
  document.body.classList.remove('file-dragging');
  // Nothing was dropped: put the panel back the way it was.
  if (!dropped && collapsedBeforeFileDrag) {
    filesCollapsed = true;
    render();
  }
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  if (fileDragDepth++ === 0) startFileDrag();
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--fileDragDepth <= 0) endFileDrag(false);
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  endFileDrag(true);
  void addFiles(e.dataTransfer!.files);
});

// ---------- toolbar & keyboard ----------

const chooseFiles = () => el.fileInput.click();
el.add.addEventListener('click', chooseFiles);
el.dropzone.addEventListener('click', chooseFiles);
el.fileInput.addEventListener('change', () => {
  const files = [...(el.fileInput.files ?? [])];
  el.fileInput.value = '';
  void addFiles(files);
});
el.undo.addEventListener('click', undo);
el.redo.addEventListener('click', redo);
el.reset.addEventListener('click', () => void startOver());
el.preview.addEventListener('click', () => void openPreview());
el.download.addEventListener('click', () =>
  withBusy(el.download, 'Building…', async () => {
    const blob = await makeOutput();
    if (blob) saveBlob(blob);
  }),
);
el.pvDownload.addEventListener('click', () => {
  if (previewBlob) saveBlob(previewBlob);
});

document.addEventListener('keydown', (e) => {
  if (el.lightbox.open) {
    if (e.key === 'ArrowLeft') stepLightbox(-1);
    if (e.key === 'ArrowRight') stepLightbox(1);
    return;
  }
  if (el.previewDlg.open || el.confirm.open) return;
  const t = e.target instanceof Element ? e.target : document.body;
  if (t.matches('input, select, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
  } else if (mod && key === 'a' && sources.size > 0 && !t.closest('#src-grid')) {
    e.preventDefault();
    docSel = new Set(pages().map((p) => p.id));
    renderDocSelection();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && docSel.size > 0) {
    e.preventDefault();
    void deleteSelected();
  } else if (e.key === 'Escape' && docSel.size > 0) {
    docSel.clear();
    renderDocSelection();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (sources.size > 0) e.preventDefault();
});

render();
