import { describe, expect, it } from 'vitest';
import { clearWhite, fitWithin, inkBounds } from './signatureImage';

/** Builds RGBA data from rows of 'k' (black), 'w' (white), 'g' (light grey) and '.' (transparent). */
function pixels(rows: string[]) {
  const colours: Record<string, number[]> = { k: [0, 0, 0, 255], w: [255, 255, 255, 255], g: [235, 235, 235, 255], '.': [0, 0, 0, 0] };
  return { data: Uint8ClampedArray.from(rows.flatMap((row) => [...row].flatMap((c) => colours[c]))), width: rows[0].length, height: rows.length };
}

describe('clearWhite', () => {
  it('makes white and near-white transparent, and leaves ink alone', () => {
    const { data } = pixels(['wgk']);
    clearWhite(data, 230);
    expect([data[3], data[7], data[11]]).toEqual([0, 0, 255]);
  });

  it('keeps pixels just below the threshold', () => {
    const { data } = pixels(['g']);
    clearWhite(data, 240);
    expect(data[3]).toBe(255);
  });
});

describe('inkBounds', () => {
  it('finds the box around everything visible', () => {
    const { data, width, height } = pixels(['....', '..k.', '.kk.', '....']);
    expect(inkBounds(data, width, height)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });

  it('returns null for an empty image', () => {
    const { data, width, height } = pixels(['..', '..']);
    expect(inkBounds(data, width, height)).toBeNull();
  });
});

describe('fitWithin', () => {
  it('leaves a size alone when it fits', () => {
    expect(fitWithin(100, 50, 1600)).toEqual({ width: 100, height: 50 });
  });

  it('scales the longest side down to the limit, keeping proportions', () => {
    expect(fitWithin(3200, 800, 1600)).toEqual({ width: 1600, height: 400 });
    expect(fitWithin(800, 3200, 1600)).toEqual({ width: 400, height: 1600 });
  });

  it('never rounds a side down to nothing', () => {
    expect(fitWithin(10000, 1, 100)).toEqual({ width: 100, height: 1 });
  });
});
