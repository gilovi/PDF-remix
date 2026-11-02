import { describe, expect, it } from 'vitest';
import { pageToView, type PageFrame } from './coords';
import { keepOnPage, moveOverlay, newOverlay, newSignature, nextSize, overlaySize, resizeFromCorner, stepOverlaySize, stepPitch, viewDeltaToLocal } from './overlayGeometry';
import type { Overlay } from './overlay';
import { BASELINE, LINE_HEIGHT } from './textlayout';

const base = { id: 'a', x: 100, y: 200, angle: 0 as const };
const mark: Overlay = { ...base, kind: 'mark', w: 20, h: 40 };
const image: Overlay = { ...base, kind: 'image', assetId: 's', w: 100, h: 50 };
const text: Overlay = { ...base, kind: 'text', text: 'hi', size: 10 };
const comb: Overlay = { ...base, kind: 'comb', digits: '1234', size: 10, pitch: 20 };

describe('overlaySize', () => {
  it('uses the stored size of an X or image', () => {
    expect(overlaySize(mark)).toEqual({ w: 20, h: 40 });
  });

  it('sizes spaced numbers from their slots and line height', () => {
    expect(overlaySize(comb)).toEqual({ w: 80, h: 10 * LINE_HEIGHT });
  });

  it('keeps at least one slot, so an empty box stays grabbable', () => {
    expect(overlaySize({ ...comb, digits: '' }).w).toBe(20);
  });
});

describe('viewDeltaToLocal', () => {
  it.each([
    [0, 10, 0, 10, 0],
    [90, 10, 0, 0, -10],
    [180, 10, 0, -10, 0],
    [270, 10, 0, 0, 10],
    [90, 0, 10, 10, 0],
  ])('at %i° display turn, view (%i, %i) is local (%i, %i)', (turn, dx, dy, u, v) => {
    const got = viewDeltaToLocal(dx, dy, turn);
    expect(got.u).toBeCloseTo(u);
    expect(got.v).toBeCloseTo(v);
  });
});

describe('moveOverlay', () => {
  const box = { x: 0, y: 0, width: 400, height: 600 };

  it.each([0, 90, 180, 270] as const)('moves with the pointer on a page displayed at %i°', (rotation) => {
    const frame: PageFrame = { box, rotation };
    const item: Overlay = { ...mark, angle: rotation };
    const before = pageToView(frame, 2, item);
    const local = viewDeltaToLocal(30, -10, 0);
    const after = pageToView(frame, 2, moveOverlay(item, local.u / 2, local.v / 2));
    expect(after.x - before.x).toBeCloseTo(30);
    expect(after.y - before.y).toBeCloseTo(-10);
  });

  it('follows the pointer when the page was turned after the item was placed', () => {
    const frame: PageFrame = { box, rotation: 90 };
    const before = pageToView(frame, 1, mark);
    const local = viewDeltaToLocal(30, -10, 90 - mark.angle);
    const after = pageToView(frame, 1, moveOverlay(mark, local.u, local.v));
    expect(after.x - before.x).toBeCloseTo(30);
    expect(after.y - before.y).toBeCloseTo(-10);
  });
});

describe('resizeFromCorner', () => {
  it('grows from the bottom-right corner, keeping the top-left fixed', () => {
    expect(resizeFromCorner(mark, overlaySize(mark), 20, 40)).toMatchObject({ x: 100, y: 200, w: 40, h: 80 });
  });

  it('keeps the top-left fixed on a rotated item', () => {
    const item: Overlay = { ...mark, angle: 90 };
    expect(resizeFromCorner(item, overlaySize(item), 20, 40)).toMatchObject({ x: 100, y: 200, w: 40, h: 80 });
  });

  it('keeps every kind’s proportions, following the larger change', () => {
    expect(resizeFromCorner(mark, overlaySize(mark), 20, 0)).toMatchObject({ w: 40, h: 80 });
    expect(resizeFromCorner(image, overlaySize(image), 0, 50)).toMatchObject({ w: 200, h: 100 });
    expect(resizeFromCorner(text, { w: 40, h: 12 }, 40, 0)).toMatchObject({ size: 20 });
    expect(resizeFromCorner(comb, overlaySize(comb), 80, 0)).toMatchObject({ size: 20, pitch: 40 });
  });

  it('stops at the minimum size', () => {
    expect(resizeFromCorner(image, overlaySize(image), -99, -49)).toMatchObject({ x: 100, y: 200, w: 8, h: 4 });
  });

  it('changes nothing when the pointer has not moved', () => {
    expect(resizeFromCorner(text, { w: 40, h: 12 }, 0, 0)).toMatchObject({ x: 100, y: 200, size: 10 });
  });
});

describe('nextSize', () => {
  it('moves to the neighbouring step, from on or between steps', () => {
    expect(nextSize(12, 1)).toBe(14);
    expect(nextSize(12, -1)).toBe(11);
    expect(nextSize(13.3, 1)).toBe(14);
    expect(nextSize(13.3, -1)).toBe(12);
  });

  it('stays put at the ends', () => {
    expect(nextSize(4, -1)).toBe(4);
    expect(nextSize(800, 1)).toBe(800);
  });
});

describe('stepOverlaySize', () => {
  const left: Overlay = { ...text, size: 10 };

  it('changes text by one step and keeps its baseline and left edge', () => {
    const next = stepOverlaySize(left, { w: 40, h: 12 }, 1, false) as Extract<Overlay, { kind: 'text' }>;
    expect(next.size).toBe(11);
    expect(next.x).toBe(100);
    expect(next.y - 11 * BASELINE).toBeCloseTo(200 - 10 * BASELINE);
  });

  it('keeps the right edge of right-to-left text', () => {
    const next = stepOverlaySize(left, { w: 40, h: 12 }, 1, true);
    expect(next.x + 40 * 1.1).toBeCloseTo(100 + 40);
  });

  it('scales the digits’ width along with their size', () => {
    expect(stepOverlaySize(comb, overlaySize(comb), 1, false)).toMatchObject({ size: 11, pitch: 22 });
  });

  it('keeps an X centred and in proportion', () => {
    const square: Overlay = { ...mark, w: 20, h: 20 };
    const next = stepOverlaySize(square, overlaySize(square), 1, false) as Extract<Overlay, { kind: 'mark' }>;
    expect(next.w).toBe(22);
    expect(next.h).toBe(22);
    expect(next.x).toBeCloseTo(99);
    expect(next.y).toBeCloseTo(201);
  });

  it('keeps an image centred and in proportion', () => {
    const next = stepOverlaySize(image, overlaySize(image), -1, false) as Extract<Overlay, { kind: 'image' }>;
    expect(next.h).toBe(48);
    expect(next.w).toBe(96);
  });

  it('returns the same item at the end of the range', () => {
    const tiny: Overlay = { ...text, size: 4 };
    expect(stepOverlaySize(tiny, { w: 10, h: 5 }, -1, false)).toBe(tiny);
  });
});

describe('stepPitch', () => {
  const numbers = comb as Extract<Overlay, { kind: 'comb' }>;

  it('widens and narrows the digits’ slots by a point, leaving their size alone', () => {
    expect(stepPitch(numbers, 1)).toMatchObject({ pitch: 21, size: 10 });
    expect(stepPitch(numbers, -1)).toMatchObject({ pitch: 19, size: 10 });
  });

  it('never makes the slots narrower than half the digit size', () => {
    expect(stepPitch({ ...numbers, pitch: 5 }, -1).pitch).toBe(5);
  });
});

describe('keepOnPage', () => {
  const box = { x: 0, y: 0, width: 400, height: 600 };

  it('leaves an item alone while its centre is on the page', () => {
    expect(keepOnPage(mark, overlaySize(mark), box)).toBe(mark);
  });

  it('pulls an item back so its centre stays on the page', () => {
    const lost: Overlay = { ...mark, x: 1000, y: -500 };
    expect(keepOnPage(lost, overlaySize(lost), box)).toMatchObject({ x: 390, y: 20 });
  });
});

describe('newSignature', () => {
  it('centres a signature on the click, fitted to the default box and in proportion', () => {
    const created = newSignature('vector', 'n', 'sig', { x: 200, y: 300 }, 0, 4);
    expect(created).toMatchObject({ kind: 'vector', assetId: 'sig', w: 150, h: 37.5 });
    expect(created.x).toBeCloseTo(125);
    expect(created.y).toBeCloseTo(318.75);
  });

  it('limits a tall signature by its height', () => {
    expect(newSignature('image', 'n', 'sig', { x: 0, y: 0 }, 0, 0.5)).toMatchObject({ kind: 'image', h: 50, w: 25 });
  });

  it('uses a remembered width when given one', () => {
    expect(newSignature('vector', 'n', 'sig', { x: 0, y: 0 }, 0, 4, 80)).toMatchObject({ w: 80, h: 20 });
  });

  it('turns with the page', () => {
    expect(newSignature('vector', 'n', 'sig', { x: 0, y: 0 }, 90, 4).angle).toBe(90);
  });
});

describe('newOverlay', () => {
  const at = { x: 100, y: 200 };

  it('centres an X on the click', () => {
    expect(newOverlay('mark', 'n', at, 0, { size: 12, pitch: 18, mark: 20 })).toMatchObject({ x: 90, y: 210, w: 20, h: 20 });
  });

  it('starts text and numbers at the click, centred on their first line', () => {
    const size = 10;
    const half = (size * LINE_HEIGHT) / 2;
    const created = newOverlay('text', 'n', at, 0, { size, pitch: 18, mark: 20 });
    expect(created).toMatchObject({ kind: 'text', text: '', size, x: 100 });
    expect(created.y).toBeCloseTo(200 + half);
    expect(newOverlay('comb', 'n', at, 0, { size, pitch: 18, mark: 20 })).toMatchObject({ kind: 'comb', digits: '', pitch: 18 });
  });

  it('centres correctly on a turned page', () => {
    const created = newOverlay('mark', 'n', at, 90, { size: 12, pitch: 18, mark: 20 });
    expect(created.angle).toBe(90);
    // At 90°, local u runs up the page and v runs right.
    expect(created.x).toBeCloseTo(90);
    expect(created.y).toBeCloseTo(190);
  });
});
