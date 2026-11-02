import { describe, expect, it, vi } from 'vitest';
import { PDFDocument, concatTransformationMatrix, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import hebrewUrl from '@fontsource/heebo/files/heebo-hebrew-400-normal.woff?inline';
import latinUrl from '@fontsource/heebo/files/heebo-latin-400-normal.woff?inline';
import { buildPdf } from './pdf';
import { combSlots, markStrokes } from './pdfOverlays';
import { BASELINE } from './textlayout';
import type { PageRef } from './model';
import type { Overlay } from './overlay';

const bytesOf = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
const loadFonts = async () => ({ fontkit, hebrew: await bytesOf(hebrewUrl), latin: await bytesOf(latinUrl) });

/** A 1×1 transparent PNG. */
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

async function source(edit?: (doc: PDFDocument) => void) {
  const doc = await PDFDocument.create();
  doc.addPage([600, 800]);
  edit?.(doc);
  return new Map([['A', await doc.save()]]);
}

const text = (t: string, x = 100, y = 700, size = 20, angle: Overlay['angle'] = 0): Overlay => ({
  id: `t${t}`,
  kind: 'text',
  text: t,
  x,
  y,
  size,
  angle,
});
const placed = (overlays: Overlay[], extra: Partial<PageRef> = {}, id = 'p'): PageRef => ({
  id,
  sourceId: 'A',
  pageIndex: 0,
  overlays,
  ...extra,
});

interface Item {
  str: string;
  transform: number[];
}
async function textItems(bytes: Uint8Array, pageNumber = 1): Promise<Item[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(pageNumber);
  const { items } = await page.getTextContent();
  return (items as Item[]).filter((i) => i.str.trim());
}

describe('buildPdf with overlays', () => {
  it('puts text at the item’s position, measured from its top-left corner', async () => {
    const out = await buildPdf(await source(), [placed([text('Hello')])], { loadFonts });
    const [item] = await textItems(out);
    expect(item.str).toBe('Hello');
    expect(item.transform[4]).toBeCloseTo(100, 1);
    expect(item.transform[5]).toBeCloseTo(700 - 20 * BASELINE, 1);
  });

  it('measures positions from the crop box', async () => {
    const sources = await source((doc) => doc.getPage(0).setCropBox(50, 60, 400, 500));
    const out = await buildPdf(sources, [placed([text('Hello', 10, 100)])], { loadFonts });
    const [item] = await textItems(out);
    expect(item.transform[4]).toBeCloseTo(60, 1);
    expect(item.transform[5]).toBeCloseTo(160 - 20 * BASELINE, 1);
  });

  it('is not moved by a transform the page’s own content left in place', async () => {
    const sources = await source((doc) => doc.getPage(0).pushOperators(concatTransformationMatrix(0.5, 0, 0, 0.5, 40, 40)));
    const out = await buildPdf(sources, [placed([text('Hello')])], { loadFonts });
    const [item] = await textItems(out);
    expect(item.transform[0]).toBeCloseTo(20, 1);
    expect(item.transform[4]).toBeCloseTo(100, 1);
    expect(item.transform[5]).toBeCloseTo(700 - 20 * BASELINE, 1);
  });

  it.each([90, 180, 270] as const)('turns an item placed at rotation %i to read upright', async (angle) => {
    const out = await buildPdf(await source(), [placed([text('Hello', 200, 300, 20, angle)], { rotation: angle })], {
      loadFonts,
    });
    const [item] = await textItems(out);
    const rad = (angle * Math.PI) / 180;
    expect(item.transform[0]).toBeCloseTo(20 * Math.cos(rad), 1);
    expect(item.transform[1]).toBeCloseTo(20 * Math.sin(rad), 1);
    expect((await PDFDocument.load(out)).getPage(0).getRotation().angle).toBe(angle);
  });

  it('honours the page’s own rotation in the source without changing it', async () => {
    const sources = await source((doc) => doc.getPage(0).setRotation(degrees(90)));
    const out = await buildPdf(sources, [placed([text('Hello', 200, 300, 20, 90)])], { loadFonts });
    const [item] = await textItems(out);
    expect(item.transform[1]).toBeCloseTo(20, 1);
    expect((await PDFDocument.load(out)).getPage(0).getRotation().angle).toBe(90);
  });

  it('lets two placements of one source page hold different items', async () => {
    const out = await buildPdf(await source(), [placed([text('One')], {}, 'a'), placed([text('Two')], {}, 'b')], { loadFonts });
    expect((await textItems(out, 1)).map((i) => i.str)).toEqual(['One']);
    expect((await textItems(out, 2)).map((i) => i.str)).toEqual(['Two']);
  });

  it('keeps pure Hebrew text extractable in reading order', async () => {
    const out = await buildPdf(await source(), [placed([text('שלום עולם')])], { loadFonts });
    expect((await textItems(out)).map((i) => i.str).join('')).toContain('שלום עולם');
  });

  it.each([
    'שָׁלוֹם',
    'בְּרֵאשִׁית and more',
    'סכום: ₪1,250.50',
    'שלום, Hello (world) 123.',
    'א\nב\n\nHello',
    '\u05B0abc',
    ' \u05B8',
    '123\u05B0',
    '\u05D0\u05B0\u05B0\u05B0',
    'ab\u05B0cd',
    '😀 سلام ж',
    '',
    '   ',
    'a\tb',
  ])('never throws on: %j', async (t) => {
    const out = await buildPdf(await source(), [placed([text(t)])], { loadFonts });
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
  });

  it('draws spaced numbers, an X and images on one page', async () => {
    const overlays: Overlay[] = [
      { id: 'c', kind: 'comb', digits: '123', x: 50, y: 500, angle: 0, size: 14, pitch: 24 },
      { id: 'm', kind: 'mark', x: 50, y: 400, angle: 0, w: 12, h: 12 },
      { id: 'i1', kind: 'image', assetId: 'sig', x: 50, y: 300, angle: 0, w: 100, h: 50 },
      { id: 'i2', kind: 'image', assetId: 'sig', x: 50, y: 200, angle: 90, w: 100, h: 50 },
    ];
    const out = await buildPdf(await source(), [placed(overlays)], { loadFonts, assets: new Map([['sig', PNG]]) });
    const doc = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
    const ops = await (await doc.getPage(1)).getOperatorList();
    const images = ops.argsArray.filter((_, i) => ops.fnArray[i] === pdfjs.OPS.paintImageXObject);
    expect(images).toHaveLength(2);
    expect(images[0][0]).toBe(images[1][0]);
    expect((await textItems(out)).map((i) => i.str).join('').replace(/\s/g, '')).toBe('123');
  });

  it('draws a vector signature as paths, not as an image, without loading fonts', async () => {
    const overlays: Overlay[] = [{ id: 'v', kind: 'vector', assetId: 'sig', x: 50, y: 300, angle: 0, w: 100, h: 50 }];
    const inks = new Map([['sig', { paths: ['M0 0L10 0L10 5Z'], width: 10, height: 5 }]]);
    const spy = vi.fn(loadFonts);
    const out = await buildPdf(await source(), [placed(overlays)], { loadFonts: spy, inks });
    const doc = await pdfjs.getDocument({ data: out.slice(), verbosity: 0 }).promise;
    const ops = await (await doc.getPage(1)).getOperatorList();
    expect(ops.fnArray).toContain(pdfjs.OPS.constructPath);
    expect(ops.fnArray).not.toContain(pdfjs.OPS.paintImageXObject);
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws a readable error for a missing vector signature', async () => {
    const overlays: Overlay[] = [{ id: 'v', kind: 'vector', assetId: 'gone', x: 0, y: 100, angle: 0, w: 10, h: 10 }];
    await expect(buildPdf(await source(), [placed(overlays)], { loadFonts })).rejects.toThrow(/signature/i);
  });

  it('throws a readable error for a missing image', async () => {
    const overlays: Overlay[] = [{ id: 'i', kind: 'image', assetId: 'gone', x: 0, y: 100, angle: 0, w: 10, h: 10 }];
    await expect(buildPdf(await source(), [placed(overlays)], { loadFonts })).rejects.toThrow(/signature|image/i);
  });

  it('loads the fonts only when an output contains text or numbers', async () => {
    const spy = vi.fn(loadFonts);
    const mark: Overlay = { id: 'm', kind: 'mark', x: 50, y: 400, angle: 0, w: 12, h: 12 };
    await buildPdf(await source(), [{ id: 'p', sourceId: 'A', pageIndex: 0 }], { loadFonts: spy });
    await buildPdf(await source(), [placed([])], { loadFonts: spy });
    await buildPdf(await source(), [placed([mark])], { loadFonts: spy });
    expect(spy).not.toHaveBeenCalled();
    await buildPdf(await source(), [placed([text('a')]), placed([text('b')], {}, 'q')], { loadFonts: spy });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('markStrokes', () => {
  it('crosses the item’s box corner to corner', () => {
    const [a, b] = markStrokes({ x: 10, y: 100, angle: 0, w: 20, h: 30 });
    expect(a).toEqual({ start: { x: 10, y: 100 }, end: { x: 30, y: 70 } });
    expect(b).toEqual({ start: { x: 30, y: 100 }, end: { x: 10, y: 70 } });
  });
});

describe('combSlots', () => {
  it('leaves a vacant slot empty, keeping later digits in their own slots', () => {
    expect(combSlots('1 3', 20, () => 10)).toEqual([
      { digit: '1', u: 5 },
      { digit: '3', u: 45 },
    ]);
  });

  it('centres each digit in its slot, left to right', () => {
    expect(combSlots('12', 20, (d) => (d === '1' ? 6 : 10))).toEqual([
      { digit: '1', u: 7 },
      { digit: '2', u: 25 },
    ]);
  });
});
