import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildPdf } from './pdf';
import type { PageRef } from './model';

/** A PDF whose page i has width `base + i`, so we can identify pages in the output. */
async function makePdf(base: number, count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([base + i, 500]);
  return doc.save();
}

const ref = (sourceId: string, pageIndex: number, n: number): PageRef => ({
  id: `${sourceId}-${pageIndex}-${n}`,
  sourceId,
  pageIndex,
});

async function widths(bytes: Uint8Array): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((pg) => Math.round(pg.getWidth()));
}

describe('buildPdf', () => {
  it('outputs the requested pages in order, across sources, with duplicates', async () => {
    const sources = new Map([
      ['A', await makePdf(100, 4)],
      ['B', await makePdf(200, 3)],
    ]);
    const out = await buildPdf(sources, [
      ref('A', 3, 0),
      ref('B', 1, 1),
      ref('A', 0, 2),
      ref('B', 2, 3),
      ref('A', 3, 4),
    ]);
    expect(await widths(out)).toEqual([103, 201, 100, 202, 103]);
  });

  it('can drop pages (subset of a single source)', async () => {
    const sources = new Map([['A', await makePdf(100, 5)]]);
    const out = await buildPdf(sources, [ref('A', 4, 0), ref('A', 1, 1)]);
    expect(await widths(out)).toEqual([104, 101]);
  });

  it('does not modify the source bytes', async () => {
    const a = await makePdf(100, 2);
    const copy = a.slice();
    await buildPdf(new Map([['A', a]]), [ref('A', 1, 0)]);
    expect(a).toEqual(copy);
  });

  it('throws on an empty page list', async () => {
    await expect(buildPdf(new Map(), [])).rejects.toThrow(/no pages/i);
  });

  it('throws on an unknown source', async () => {
    await expect(buildPdf(new Map(), [ref('X', 0, 0)])).rejects.toThrow(/source/i);
  });
});
