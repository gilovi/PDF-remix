import type { PageRef } from './model';

/** Quarter turns, matching the page's total display rotation when the item was placed. */
export type Angle = 0 | 90 | 180 | 270;

/**
 * An item drawn on top of a page. `x` and `y` are the item's top-left corner as
 * read upright, in PDF points relative to the page's crop box (y upwards), in
 * unrotated page space, so neither zoom nor later page rotation changes them.
 */
export type Overlay = { id: string; x: number; y: number; angle: Angle } & (
  | { kind: 'text'; text: string; size: number }
  | { kind: 'comb'; digits: string; size: number; pitch: number }
  | { kind: 'mark'; w: number; h: number }
  | { kind: 'image'; assetId: string; w: number; h: number }
);

const MIN_SIZE = 4;

const replacePage = (pages: PageRef[], pageId: string, overlays: (current: Overlay[]) => Overlay[] | null): PageRef[] => {
  const at = pages.findIndex((p) => p.id === pageId);
  if (at < 0) return pages;
  const next = overlays(pages[at].overlays ?? []);
  if (!next) return pages;
  return pages.map((p, i) => (i === at ? { ...p, overlays: next } : p));
};

export function addOverlay(pages: PageRef[], pageId: string, overlay: Overlay): PageRef[] {
  return replacePage(pages, pageId, (list) => [...list, overlay]);
}

/** Replaces one item with `change(item)`. Returns the input array if the page or item doesn't exist. */
export function updateOverlay(pages: PageRef[], pageId: string, overlayId: string, change: (o: Overlay) => Overlay): PageRef[] {
  return replacePage(pages, pageId, (list) =>
    list.some((o) => o.id === overlayId) ? list.map((o) => (o.id === overlayId ? change(o) : o)) : null,
  );
}

export function removeOverlay(pages: PageRef[], pageId: string, overlayId: string): PageRef[] {
  return replacePage(pages, pageId, (list) => (list.some((o) => o.id === overlayId) ? list.filter((o) => o.id !== overlayId) : null));
}

/**
 * Scales an item, keeping its proportions: text changes font size, spaced numbers
 * scale size and pitch together, and an X or image scales both sides. Nothing
 * shrinks below a legible minimum.
 */
export function resizeOverlay(o: Overlay, scale: number): Overlay {
  switch (o.kind) {
    case 'text':
      return { ...o, size: Math.max(o.size * scale, MIN_SIZE) };
    case 'comb': {
      const factor = Math.max(scale, MIN_SIZE / o.size);
      return { ...o, size: o.size * factor, pitch: o.pitch * factor };
    }
    case 'mark':
    case 'image': {
      const factor = Math.max(scale, MIN_SIZE / Math.min(o.w, o.h));
      return { ...o, w: o.w * factor, h: o.h * factor };
    }
  }
}

/** Spaced numbers hold ASCII digits only. */
export const cleanDigits = (s: string) => s.replace(/[^0-9]/g, '');
