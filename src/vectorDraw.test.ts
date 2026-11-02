import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { localToPage, visibleBox, type Point } from './coords';
import { buildInk, type InkPoint } from './ink';
import { drawInk } from './vectorDraw';
import type { Angle } from './overlay';

const ANGLES: Angle[] = [0, 90, 180, 270];

/** A frame and a small flag, so a flip, a swap or a wrong origin shows up. */
const ink = { paths: ['M0 0L100 0L100 40L0 40Z', 'M10 10L30 10L10 25Z'], width: 100, height: 40 };

const vertices = [
  [
    [0, 0],
    [100, 0],
    [100, 40],
    [0, 40],
  ],
  [
    [10, 10],
    [30, 10],
    [10, 25],
  ],
];

type Matrix = number[];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Every vertex that pdf.js sees being drawn, in page space (CTM applied), grouped per path. */
async function drawnPaths(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const list = await (await doc.getPage(1)).getOperatorList();
  const { OPS } = pdfjs;
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const fills: string[] = [];
  const paths: Point[][] = [];
  list.fnArray.forEach((fn: number, i: number) => {
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop()!;
    else if (fn === OPS.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === OPS.setFillRGBColor) fills.push(...(args as string[]));
    else if (fn === OPS.constructPath) {
      // pdf.js packs a path as a run of codes: 0 move, 1 line (1 point each), 2 curve (3 points), 4 close.
      const data = (args as [number, ArrayLike<number>[]])[1][0];
      const points: Point[] = [];
      for (let k = 0; k < data.length; ) {
        const op = data[k++];
        const take = op === 0 || op === 1 ? 1 : op === 2 ? 3 : 0;
        for (let n = 0; n < take; n++, k += 2) {
          points.push({ x: ctm[0] * data[k] + ctm[2] * data[k + 1] + ctm[4], y: ctm[1] * data[k] + ctm[3] * data[k + 1] + ctm[5] });
        }
      }
      paths.push(points);
    }
  });
  return { paths, fills };
}

async function pageWith(crop?: [number, number, number, number]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  if (crop) page.setCropBox(...crop);
  return { doc, page };
}

describe('drawInk', () => {
  for (const angle of ANGLES) {
    it(`puts every vertex where localToPage says, at angle ${angle}, scaled, with a crop box offset`, async () => {
      const { doc, page } = await pageWith([30, 40, 540, 720]);
      const item = { x: 120, y: 500, angle, w: 250, h: 100 }; // scale 2.5
      drawInk(page, ink, item);
      const { paths } = await drawnPaths(await doc.save());

      const box = visibleBox(page.getCropBox(), page.getMediaBox());
      expect(box.x).toBe(30);
      expect(paths).toHaveLength(2);
      vertices.forEach((path, i) => {
        expect(paths[i]).toHaveLength(path.length);
        path.forEach(([a, b], k) => {
          const want = localToPage(item, a * 2.5, b * 2.5);
          expect(paths[i][k].x).toBeCloseTo(want.x + box.x, 3);
          expect(paths[i][k].y).toBeCloseTo(want.y + box.y, 3);
        });
      });
    });
  }

  it('reads upright at angle 0: top-left at the item origin, going right and down', async () => {
    const { doc, page } = await pageWith([30, 40, 540, 720]);
    drawInk(page, ink, { x: 100, y: 500, angle: 0, w: 200, h: 80 });
    const [frame] = (await drawnPaths(await doc.save())).paths;
    expect(frame[0].x).toBeCloseTo(130, 3);
    expect(frame[0].y).toBeCloseTo(540, 3);
    expect(frame[1].x).toBeCloseTo(330, 3);
    expect(frame[1].y).toBeCloseTo(540, 3);
    expect(frame[2].y).toBeCloseTo(460, 3); // down is lower on the page
  });

  it('at angle 90 reading runs up the page and down in the item is to the right', async () => {
    const { doc, page } = await pageWith();
    drawInk(page, ink, { x: 100, y: 500, angle: 90, w: 200, h: 80 });
    const [frame] = (await drawnPaths(await doc.save())).paths;
    expect(frame[0].x).toBeCloseTo(100, 3);
    expect(frame[0].y).toBeCloseTo(500, 3);
    expect(frame[1].x).toBeCloseTo(100, 3);
    expect(frame[1].y).toBeCloseTo(700, 3);
    expect(frame[2].x).toBeCloseTo(180, 3);
  });

  it('fills solid black', async () => {
    const { doc, page } = await pageWith();
    drawInk(page, ink, { x: 100, y: 500, angle: 0, w: 100, h: 40 });
    const { fills } = await drawnPaths(await doc.save());
    expect(new Set(fills)).toEqual(new Set(['#000000']));
  });

  it('stays accurate when the media box does not start at the origin', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    page.setMediaBox(20, 30, 600, 800);
    page.setCropBox(20, 30, 600, 800);
    drawInk(page, ink, { x: 10, y: 20, angle: 0, w: 100, h: 40 });
    const [frame] = (await drawnPaths(await doc.save())).paths;
    expect(frame[0].x).toBeCloseTo(30, 3);
    expect(frame[0].y).toBeCloseTo(50, 3);
  });

  it('draws nothing for an empty ink', async () => {
    const { doc, page } = await pageWith();
    drawInk(page, { paths: [], width: 0, height: 0 }, { x: 0, y: 0, angle: 0, w: 10, h: 10 });
    expect((await drawnPaths(await doc.save())).paths).toHaveLength(0);
  });
});

describe('a real signature', () => {
  const signature = () => {
    const strokes: InkPoint[][] = [0, 1, 2, 3].map((s) =>
      Array.from({ length: 140 }, (_, i) => ({
        x: 20 + i * 2.2 + s * 9,
        y: 60 + Math.sin(i / 7 + s) * 22 + s * 6 - i * 0.1,
        t: i * 7,
        pressure: 0.5,
        pointerType: 'mouse' as const,
      })),
    );
    return buildInk(strokes)!;
  };

  it('adds only a few kilobytes to the PDF', async () => {
    const { doc: bare } = await pageWith();
    const base = (await bare.save({ useObjectStreams: false })).length;
    const { doc, page } = await pageWith();
    drawInk(page, signature(), { x: 100, y: 500, angle: 0, w: 200, h: 80 });
    const added = (await doc.save({ useObjectStreams: false })).length - base;
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(12_000);
  });

  it('stays inside its box at every angle', async () => {
    const sig = signature();
    for (const angle of ANGLES) {
      const { doc, page } = await pageWith();
      const w = 200;
      const h = (w * sig.height) / sig.width;
      const item = { x: 300, y: 400, angle, w, h };
      drawInk(page, sig, item);
      const { paths } = await drawnPaths(await doc.save());
      const corners = [localToPage(item, 0, 0), localToPage(item, w, 0), localToPage(item, w, h), localToPage(item, 0, h)];
      const lo = { x: Math.min(...corners.map((c) => c.x)) - 0.01, y: Math.min(...corners.map((c) => c.y)) - 0.01 };
      const hi = { x: Math.max(...corners.map((c) => c.x)) + 0.01, y: Math.max(...corners.map((c) => c.y)) + 0.01 };
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths.flat()) {
        expect(p.x).toBeGreaterThanOrEqual(lo.x);
        expect(p.x).toBeLessThanOrEqual(hi.x);
        expect(p.y).toBeGreaterThanOrEqual(lo.y);
        expect(p.y).toBeLessThanOrEqual(hi.y);
      }
    }
  });
});
