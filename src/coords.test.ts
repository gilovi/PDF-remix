import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { displaySize, localToPage, pageToView, viewToPage, visibleBox, type PageFrame } from './coords';

const box = { x: 30, y: 50, width: 400, height: 600 };
const ROTATIONS = [0, 90, 180, 270] as const;
const frame = (rotation: number): PageFrame => ({ box, rotation });

describe('pageToView / viewToPage', () => {
  it.each(ROTATIONS)('agrees with pdf.js’s own viewport at rotation %i', async (rotation) => {
    const zoom = 1.5;
    const doc = await PDFDocument.create();
    doc.addPage([1000, 1000]).setCropBox(box.x, box.y, box.width, box.height);
    const pdf = await pdfjs.getDocument({ data: await doc.save(), verbosity: 0 }).promise;
    const viewport = (await pdf.getPage(1)).getViewport({ scale: zoom, rotation });
    for (const p of [{ x: 0, y: 0 }, { x: 400, y: 600 }, { x: 120, y: 37 }]) {
      const [vx, vy] = viewport.convertToViewportPoint(p.x + box.x, p.y + box.y);
      const got = pageToView(frame(rotation), zoom, p);
      expect(got.x).toBeCloseTo(vx);
      expect(got.y).toBeCloseTo(vy);
    }
  });

  it.each(ROTATIONS)('round-trips at rotation %i', (rotation) => {
    const p = { x: 123.5, y: 77.25 };
    const back = viewToPage(frame(rotation), 2.5, pageToView(frame(rotation), 2.5, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('accepts a rotation outside 0–359', () => {
    expect(pageToView(frame(450), 1, { x: 5, y: 7 })).toEqual(pageToView(frame(90), 1, { x: 5, y: 7 }));
  });

  it('swaps the displayed size on sideways pages', () => {
    expect(displaySize(frame(0), 2)).toEqual({ width: 800, height: 1200 });
    expect(displaySize(frame(90), 2)).toEqual({ width: 1200, height: 800 });
    expect(displaySize(frame(270), 1)).toEqual({ width: 600, height: 400 });
  });
});

describe('localToPage', () => {
  it.each(ROTATIONS)('makes an item placed at rotation %i read upright on screen', (angle) => {
    const f = frame(angle);
    const item = { x: 100, y: 200, angle };
    const origin = pageToView(f, 1, localToPage(item, 0, 0));
    const right = pageToView(f, 1, localToPage(item, 10, 0));
    const down = pageToView(f, 1, localToPage(item, 0, 10));
    expect(origin.x).toBeCloseTo(pageToView(f, 1, item).x);
    expect(origin.y).toBeCloseTo(pageToView(f, 1, item).y);
    expect(right.x - origin.x).toBeCloseTo(10);
    expect(right.y - origin.y).toBeCloseTo(0);
    expect(down.x - origin.x).toBeCloseTo(0);
    expect(down.y - origin.y).toBeCloseTo(10);
  });
});

describe('visibleBox', () => {
  it('is the part of the crop box inside the media box, as pdf.js shows it', () => {
    expect(visibleBox({ x: -10, y: 20, width: 100, height: 100 }, { x: 0, y: 0, width: 50, height: 500 })).toEqual({
      x: 0,
      y: 20,
      width: 50,
      height: 100,
    });
  });

  it('falls back to the media box when the two do not overlap', () => {
    const media = { x: 0, y: 0, width: 50, height: 50 };
    expect(visibleBox({ x: 100, y: 100, width: 10, height: 10 }, media)).toEqual(media);
  });
});
