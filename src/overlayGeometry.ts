import { localToPage, type Box, type Point } from './coords';
import { resizeOverlay, type Angle, type Overlay } from './overlay';
import { BASELINE, LINE_HEIGHT } from './textlayout';

const SIZE_STEPS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64, 72, 96, 128, 160, 200, 250, 320, 400, 500, 640, 800];
const SIGNATURE_BOX = { w: 150, h: 50 };

export interface Size {
  w: number;
  h: number;
}

export interface NewItemSizes {
  size: number;
  pitch: number;
  mark: number;
}

/** An item's box in its own reading frame. Text width depends on the font, so the editor measures text instead. */
export function overlaySize(o: Overlay): Size {
  switch (o.kind) {
    case 'text':
      return { w: 0, h: o.size * LINE_HEIGHT * o.text.split('\n').length };
    case 'comb':
      return { w: o.pitch * Math.max(1, o.digits.length), h: o.size * LINE_HEIGHT };
    default:
      return { w: o.w, h: o.h };
  }
}

/** Converts a pointer movement on screen to an item's reading frame, for an item shown turned clockwise by `turn`. */
export function viewDeltaToLocal(dx: number, dy: number, turn: number): { u: number; v: number } {
  switch (((turn % 360) + 360) % 360) {
    case 90:
      return { u: dy, v: -dx };
    case 180:
      return { u: -dx, v: -dy };
    case 270:
      return { u: -dy, v: dx };
    default:
      return { u: dx, v: dy };
  }
}

/** Moves an item along its own reading frame. */
export function moveOverlay<T extends Overlay>(o: T, du: number, dv: number): T {
  return { ...o, ...localToPage(o, du, dv) };
}

/**
 * Resizes an item by dragging its bottom-right corner `du`, `dv` in its reading
 * frame, keeping the top-left fixed. Every kind keeps its proportions, following
 * whichever direction changed more.
 */
export function resizeFromCorner(o: Overlay, box: Size, du: number, dv: number): Overlay {
  const sx = (box.w + du) / box.w;
  const sy = (box.h + dv) / box.h;
  return resizeOverlay(o, Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy);
}

/** The next size up or down, from on or between the steps. Stays put at the ends. */
export function nextSize(current: number, direction: 1 | -1): number {
  const found = direction > 0 ? SIZE_STEPS.find((s) => s > current) : SIZE_STEPS.findLast((s) => s < current);
  return found ?? current;
}

const tidy = (n: number) => Math.round(n * 100) / 100;

/**
 * Changes an item's size by one step. Text and numbers keep their baseline, so
 * they stay on a form's line, and their reading start (the right edge when `rtl`).
 * An X or image stays centred.
 */
export function stepOverlaySize(o: Overlay, box: Size, direction: 1 | -1, rtl: boolean): Overlay {
  const base = o.kind === 'text' || o.kind === 'comb' ? o.size : Math.min(o.w, o.h);
  const target = nextSize(base, direction);
  if (target === base) return o;
  const growth = target / base - 1;
  if (o.kind === 'text' || o.kind === 'comb') {
    const at = localToPage(o, rtl ? -box.w * growth : 0, -(target - base) * BASELINE);
    return o.kind === 'comb' ? { ...o, ...at, size: target, pitch: tidy(o.pitch * (1 + growth)) } : { ...o, ...at, size: target };
  }
  const at = localToPage(o, (-box.w * growth) / 2, (-box.h * growth) / 2);
  return { ...o, ...at, w: tidy(o.w * (1 + growth)), h: tidy(o.h * (1 + growth)) };
}

/** Widens or narrows the slots of spaced numbers by a point, leaving the digits' size alone. */
export function stepPitch<T extends Extract<Overlay, { kind: 'comb' }>>(o: T, direction: 1 | -1): T {
  const pitch = tidy(o.pitch + direction);
  return pitch < o.size / 2 ? o : { ...o, pitch };
}

/** Pulls an item back so its centre stays on the page and it can't be lost. `box` gives the page's size. */
export function keepOnPage(o: Overlay, size: Size, box: Box): Overlay {
  const centre = localToPage(o, size.w / 2, size.h / 2);
  const x = Math.min(box.width, Math.max(0, centre.x));
  const y = Math.min(box.height, Math.max(0, centre.y));
  if (x === centre.x && y === centre.y) return o;
  return { ...o, x: o.x + x - centre.x, y: o.y + y - centre.y };
}

/** Creates a signature centred on a click: fitted to a default box, or at a remembered width. */
export function newSignature(kind: 'image' | 'vector', id: string, assetId: string, at: Point, angle: Angle, aspect: number, width?: number): Overlay {
  const w = width ?? Math.min(SIGNATURE_BOX.w, SIGNATURE_BOX.h * aspect);
  const h = w / aspect;
  const { x, y } = localToPage({ ...at, angle }, -w / 2, -h / 2);
  return { id, kind, assetId, x, y, angle, w, h };
}

/** Creates an item at a click: the X centred on it, text and numbers starting at it, centred on their first line. */
export function newOverlay(kind: 'text' | 'comb' | 'mark', id: string, at: Point, angle: Angle, sizes: NewItemSizes): Overlay {
  const anchor = { ...at, angle };
  if (kind === 'mark') {
    const { x, y } = localToPage(anchor, -sizes.mark / 2, -sizes.mark / 2);
    return { id, kind, x, y, angle, w: sizes.mark, h: sizes.mark };
  }
  const { x, y } = localToPage(anchor, 0, (-sizes.size * LINE_HEIGHT) / 2);
  return kind === 'text'
    ? { id, kind, x, y, angle, text: '', size: sizes.size }
    : { id, kind, x, y, angle, digits: '', size: sizes.size, pitch: sizes.pitch };
}
