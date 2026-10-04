import './style.css';
import {
  History,
  insertPages,
  movePages,
  removePages,
  shiftPages,
  type PageRef,
} from './model';
import { buildPdf, checkEditable } from './pdf';
import { downloadBlob } from './download';
import { boxSelect, boxesIntersect, clickSelect, normalizeBox, selectModeAfter, type ClickMods } from './selection';
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
/** "Select" mode: plain clicks add/remove pages instead of replacing the selection. */
let docSelectMode = false;
let srcSelectMode = false;
/** Selection sizes at the last render, to spot the moment a selection grows past one page. */
let lastDocCount = 0;
let lastSrcCount = 0;
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
  docSelect: $<HTMLButtonElement>('btn-doc-select'),
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
  srcSelect: $<HTMLButtonElement>('btn-src-select'),
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
  docSelectMode = selectModeAfter(docSelectMode, lastDocCount, n);
  lastDocCount = n;
  setSelectToggle(el.docSelect, docSelectMode);
  const them = n === 1 ? 'it' : 'them';
  el.docHint.textContent = touch
    ? n
      ? `${n} selected. Long-press a selected page to drag ${them}, use ◀ ▶, or tap the trash button to remove ${them}.`
      : docSelectMode
        ? 'Tap pages to add them to the selection, or tap again to remove them.'
        : 'Tap a page to select it. To pick several, tap Select, or long-press and drag a box around them.'
    : n
      ? `${n} selected. Drag ${them} to move, or click the trash button to remove ${them}.`
      : docSelectMode
        ? 'Click pages to add them to the selection, or click again to remove them.'
        : 'Click a page to select it. To pick several, Ctrl/Shift-click, drag a box, or use Select. Double-click to enlarge.';
  for (const card of el.docGrid.querySelectorAll<HTMLElement>('.card')) {
    const selected = docSel.has(card.dataset.id!);
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-selected', String(selected));
  }
}

function setSelectToggle(button: HTMLButtonElement, on: boolean) {
  button.classList.toggle('active', on);
  button.setAttribute('aria-pressed', String(on));
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
  const used = new Set(pages().filter((p) => p.sourceId === src?.id).map((p) => p.pageIndex));
  const cards: HTMLElement[] = [];
  if (src) {
    for (let i = 0; i < src.numPages; i++) {
      const card = h(
        'div',
        {
          className: 'card',
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
      card.setAttribute('role', 'option');
      card.setAttribute('aria-label', `${src.name} page ${i + 1}`);
      card.dataset.index = String(i);
      cards.push(card);
    }
  }
  releaseThumbs(el.srcGrid);
  el.srcGrid.replaceChildren(...cards);

  el.filesCount.textContent = `(${sources.size})`;
  renderSrcSelection();
}

/** Updates the Files panel's selection in place (badges, buttons, note). */
function renderSrcSelection() {
  const src = activeSourceId ? sources.get(activeSourceId) : undefined;
  const picked = src ? (picks.get(src.id) ?? []) : [];
  for (const card of el.srcGrid.querySelectorAll<HTMLElement>('.card')) {
    const order = picked.indexOf(Number(card.dataset.index));
    card.classList.toggle('selected', order >= 0);
    card.setAttribute('aria-selected', String(order >= 0));
    let badge = card.querySelector('.badge');
    if (order < 0) badge?.remove();
    else {
      badge ??= card.appendChild(h('span', { className: 'badge' }));
      badge.textContent = String(order + 1);
    }
  }
  srcSelectMode = selectModeAfter(srcSelectMode, lastSrcCount, picked.length);
  lastSrcCount = picked.length;
  setSelectToggle(el.srcSelect, srcSelectMode);
  const touch = touchQuery.matches;
  const one = picked.length === 1;
  const them = one ? 'it' : 'them';
  el.srcNote.textContent = picked.length
    ? `${picked.length} selected (${picked.map((i) => i + 1).join(', ')}). ` +
      (touch
        ? `Tap “Add to end”, or long-press a selected page and drag ${them} into your document.`
        : `Drag ${them} to the place you want in your document.${one ? '' : ' They’ll go in this order.'}`)
    : srcSelectMode
      ? `${touch ? 'Tap' : 'Click'} pages in the order you want them added.`
      : touch
        ? 'Tap a page to select it. To pick several (in order), tap Select, or long-press and drag a box.'
        : 'Click a page to select it. To pick several (in order), Ctrl-click, drag a box, or use Select. Then drag them into your document.';
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

/** Ctrl/Cmd-click or Select mode toggles; Shift-click adds a range; a plain click selects one page. */
const clickMods = (e: MouseEvent | KeyboardEvent, selectMode: boolean): ClickMods => ({
  toggle: e.ctrlKey || e.metaKey || selectMode,
  range: e.shiftKey,
});

function selectInDoc(id: string, mods: ClickMods) {
  const next = clickSelect({ selected: [...docSel], anchor: docAnchor }, pages().map((p) => p.id), id, mods);
  docSel = new Set(next.selected);
  docAnchor = next.anchor;
  renderDocSelection();
}

function selectInSrc(index: number, mods: ClickMods) {
  const src = activeSourceId ? sources.get(activeSourceId) : undefined;
  if (!src) return;
  const all = Array.from({ length: src.numPages }, (_, i) => i);
  const next = clickSelect({ selected: picks.get(src.id) ?? [], anchor: srcAnchor }, all, index, mods);
  picks.set(src.id, next.selected);
  srcAnchor = next.anchor;
  renderSrcSelection();
}

el.docGrid.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const card = t.closest<HTMLElement>('.card');
  if (!card) {
    // A click on empty space clears the selection (except in Select mode).
    if (!docSelectMode && docSel.size > 0) {
      docSel.clear();
      docAnchor = null;
      renderDocSelection();
    }
    return;
  }
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
  selectInDoc(id, clickMods(e, docSelectMode));
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
    selectInDoc(card.dataset.id!, clickMods(e, docSelectMode));
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
el.docSelect.addEventListener('click', () => {
  docSelectMode = !docSelectMode;
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
  if (!card) {
    if (!srcSelectMode && activeSourceId && picks.get(activeSourceId)?.length) {
      picks.set(activeSourceId, []);
      srcAnchor = null;
      renderSrcSelection();
    }
    return;
  }
  selectInSrc(Number(card.dataset.index), clickMods(e, srcSelectMode));
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
    selectInSrc(Number(card.dataset.index), clickMods(e, srcSelectMode));
  }
});

el.srcAll.addEventListener('click', () => {
  const src = activeSourceId ? sources.get(activeSourceId) : undefined;
  if (!src) return;
  picks.set(src.id, Array.from({ length: src.numPages }, (_, i) => i));
  renderSrcSelection();
});
el.srcClear.addEventListener('click', () => {
  if (activeSourceId) picks.set(activeSourceId, []);
  srcAnchor = null;
  renderSrcSelection();
});
el.srcSelect.addEventListener('click', () => {
  srcSelectMode = !srcSelectMode;
  renderSrcSelection();
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
  cancelMouseHold(); // moving right away means "move these pages", not "draw a box"
  if (marquee) {
    e.preventDefault();
    return;
  }
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
// Phone and tablet browsers mostly don't support HTML5 drag-and-drop. On touch
// screens, long-pressing a selected page picks the selection up so a finger
// drag moves it. Long-pressing anywhere else starts a selection box.

const LONG_PRESS_MS = 400;
const MOVE_TOLERANCE = 10;
const main = document.querySelector('main')!;
let press: { grid: HTMLElement; card: HTMLElement | null; x: number; y: number; timer: number } | null = null;
let ghost: HTMLElement | null = null;
let finger = { x: 0, y: 0 };
let scrollFrame = 0;
let suppressClick = false;

/** Swallows the click the browser may fire at the end of a drag or box. */
function suppressNextClick() {
  suppressClick = true;
  setTimeout(() => (suppressClick = false), 400);
}

function cancelPress() {
  if (press) clearTimeout(press.timer);
  press = null;
}

function overDocGrid(x: number, y: number) {
  const r = el.docGrid.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function onLongPress() {
  if (!press) return;
  const { grid, card, x, y } = press;
  if (card && selectedKeys(grid).includes(cardKey(grid, card))) {
    startTouchDrag();
    return;
  }
  press = null;
  navigator.vibrate?.(10);
  startMarquee(grid, x, y, grid === el.docGrid ? docSelectMode : srcSelectMode);
}

function startTouchDrag() {
  if (!press?.card) return;
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

/** While dragging pages or a box, scrolls whichever container the pointer is near the edge of. */
function autoScroll() {
  if (!ghost && !marquee) return;
  const { x, y } = finger;
  for (const box of [marquee?.grid ?? el.docGrid, main]) {
    const r = box.getBoundingClientRect();
    if (x < r.left || x > r.right) continue;
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const edge = 70;
    const speed = y < top + edge ? -(top + edge - y) / 4 : y > bottom - edge ? (y - (bottom - edge)) / 4 : 0;
    if (speed) box.scrollTop += Math.max(-20, Math.min(20, speed));
  }
  if (ghost) moveTouchDrag(x, y);
  else updateMarquee(x, y);
  scrollFrame = requestAnimationFrame(autoScroll);
}

function finishTouchDrag(drop: boolean) {
  cancelAnimationFrame(scrollFrame);
  ghost?.remove();
  ghost = null;
  suppressNextClick();
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
      if (e.touches.length !== 1 || t.closest('button')) return;
      const { clientX: x, clientY: y } = e.touches[0];
      press = { grid, card: t.closest<HTMLElement>('.card'), x, y, timer: window.setTimeout(onLongPress, LONG_PRESS_MS) };
    },
    { passive: true },
  );
  grid.addEventListener(
    'touchmove',
    (e) => {
      const { clientX: x, clientY: y } = e.touches[0];
      if (press && Math.hypot(x - press.x, y - press.y) > MOVE_TOLERANCE) cancelPress(); // it's a scroll
      if (ghost) {
        e.preventDefault(); // don't scroll the page while dragging
        moveTouchDrag(x, y);
      } else if (marquee) {
        e.preventDefault();
        updateMarquee(x, y);
      }
    },
    { passive: false },
  );
  grid.addEventListener('touchend', (e) => {
    cancelPress();
    if (ghost) {
      e.preventDefault();
      finishTouchDrag(true);
    } else if (marquee) {
      e.preventDefault();
      endMarquee();
    }
  });
  grid.addEventListener('touchcancel', () => {
    cancelPress();
    if (ghost) finishTouchDrag(false);
    endMarquee();
  });
  // Long-pressing an image would otherwise open the browser's context menu.
  grid.addEventListener('contextmenu', (e) => {
    if (touchQuery.matches) e.preventDefault();
  });
}

document.addEventListener(
  'click',
  (e) => {
    // Only the one stray click on a page grid; buttons stay responsive.
    const t = e.target as Node;
    if (!suppressClick || !(el.docGrid.contains(t) || el.srcGrid.contains(t))) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

// ---------- box selection ----------
// Mouse: press on empty space and drag, or hold still on a page for a moment
// and then drag (a quick drag on a page moves it instead). Touch: see above.
// Ctrl/Cmd/Shift, or Select mode, add the box to the current selection.

interface Marquee {
  grid: HTMLElement;
  box: HTMLElement;
  /** Start point in the grid's content coordinates (so scrolling keeps it anchored). */
  sx: number;
  sy: number;
  base: string[];
  additive: boolean;
  active: boolean;
}
let marquee: Marquee | null = null;
let mouseHold: { grid: HTMLElement; x: number; y: number; additive: boolean; pointerId: number; timer: number } | null =
  null;

const cardKey = (grid: HTMLElement, card: HTMLElement) => (grid === el.docGrid ? card.dataset.id! : card.dataset.index!);

function selectedKeys(grid: HTMLElement): string[] {
  return grid === el.docGrid ? [...docSel] : (picks.get(activeSourceId ?? '') ?? []).map(String);
}

function setSelectedKeys(grid: HTMLElement, keys: string[]) {
  if (grid === el.docGrid) {
    docSel = new Set(keys);
    renderDocSelection();
  } else if (activeSourceId) {
    picks.set(activeSourceId, keys.map(Number));
    renderSrcSelection();
  }
}

function contentPoint(grid: HTMLElement, x: number, y: number) {
  const r = grid.getBoundingClientRect();
  return { x: x - r.left + grid.scrollLeft, y: y - r.top + grid.scrollTop };
}

function startMarquee(grid: HTMLElement, x: number, y: number, additive: boolean) {
  const p = contentPoint(grid, x, y);
  const box = h('div', { className: 'marquee', hidden: true });
  grid.append(box);
  marquee = { grid, box, sx: p.x, sy: p.y, base: selectedKeys(grid), additive, active: false };
  for (const c of grid.querySelectorAll<HTMLElement>('.card')) c.draggable = false;
  document.body.classList.add('marquee-on');
  finger = { x, y };
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(autoScroll);
}

function updateMarquee(x: number, y: number) {
  finger = { x, y };
  const m = marquee;
  if (!m) return;
  const p = contentPoint(m.grid, x, y);
  const b = normalizeBox(m.sx, m.sy, p.x, p.y);
  // Ignore jitter: a box only starts once the pointer has really moved.
  if (!m.active && b.right - b.left < 6 && b.bottom - b.top < 6) return;
  m.active = true;
  m.box.hidden = false;
  m.box.style.left = `${b.left}px`;
  m.box.style.top = `${b.top}px`;
  m.box.style.width = `${b.right - b.left}px`;
  m.box.style.height = `${b.bottom - b.top}px`;
  const hits = [...m.grid.querySelectorAll<HTMLElement>('.card')]
    .filter((c) =>
      boxesIntersect(b, {
        left: c.offsetLeft,
        top: c.offsetTop,
        right: c.offsetLeft + c.offsetWidth,
        bottom: c.offsetTop + c.offsetHeight,
      }),
    )
    .map((c) => cardKey(m.grid, c));
  setSelectedKeys(m.grid, boxSelect(m.base, hits, m.additive));
}

function endMarquee() {
  const m = marquee;
  if (!m) return;
  marquee = null;
  m.box.remove();
  cancelAnimationFrame(scrollFrame);
  document.body.classList.remove('marquee-on');
  for (const c of m.grid.querySelectorAll<HTMLElement>('.card')) c.draggable = !touchQuery.matches;
  if (m.active) suppressNextClick();
}

function cancelMouseHold() {
  if (mouseHold) clearTimeout(mouseHold.timer);
  mouseHold = null;
}

for (const grid of [el.docGrid, el.srcGrid]) {
  grid.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('button')) return;
    // Leave the scrollbar alone.
    if (e.clientX - grid.getBoundingClientRect().left > grid.clientWidth) return;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey || (grid === el.docGrid ? docSelectMode : srcSelectMode);
    if (!t.closest('.card')) {
      e.preventDefault(); // no text selection while drawing the box
      grid.setPointerCapture(e.pointerId);
      startMarquee(grid, e.clientX, e.clientY, additive);
      return;
    }
    cancelMouseHold();
    const hold = { grid, x: e.clientX, y: e.clientY, additive, pointerId: e.pointerId, timer: 0 };
    hold.timer = window.setTimeout(() => {
      if (mouseHold !== hold) return;
      mouseHold = null;
      startMarquee(grid, hold.x, hold.y, hold.additive);
      try {
        grid.setPointerCapture(hold.pointerId);
      } catch {
        // The button was released in the meantime; the box simply ends on pointerup.
      }
    }, LONG_PRESS_MS);
    mouseHold = hold;
  });
}

window.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  if (mouseHold && Math.hypot(e.clientX - mouseHold.x, e.clientY - mouseHold.y) > 4) cancelMouseHold();
  if (marquee) updateMarquee(e.clientX, e.clientY);
});
for (const type of ['pointerup', 'pointercancel'] as const) {
  window.addEventListener(type, (e) => {
    if (e.pointerType === 'touch') return;
    cancelMouseHold();
    endMarquee();
  });
}

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
  } else if (mod && key === 'a' && t.closest('#src-grid')) {
    e.preventDefault();
    el.srcAll.click();
  } else if (mod && key === 'a' && sources.size > 0) {
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
