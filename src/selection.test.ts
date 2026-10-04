import { describe, expect, it } from 'vitest';
import { boxSelect, boxesIntersect, clickSelect, normalizeBox, type SelState } from './selection';

const all = ['a', 'b', 'c', 'd', 'e'];
const st = (selected: string[], anchor: string | null = null): SelState<string> => ({ selected, anchor });
const plain = { toggle: false, range: false };
const toggle = { toggle: true, range: false };
const range = { toggle: false, range: true };

describe('clickSelect', () => {
  it('a plain click selects only that page, dropping the previous selection', () => {
    expect(clickSelect(st(['a', 'c'], 'c'), all, 'd', plain)).toEqual(st(['d'], 'd'));
  });
  it('a plain click on a page already in a larger selection narrows to that page', () => {
    expect(clickSelect(st(['a', 'c'], 'a'), all, 'c', plain)).toEqual(st(['c'], 'c'));
  });
  it('a plain click on the only selected page deselects it', () => {
    expect(clickSelect(st(['c'], 'c'), all, 'c', plain)).toEqual(st([], null));
  });
  it('toggle (Ctrl-click / select mode) adds and removes, keeping click order', () => {
    let s = clickSelect(st([]), all, 'd', toggle);
    s = clickSelect(s, all, 'a', toggle);
    expect(s).toEqual(st(['d', 'a'], 'a'));
    expect(clickSelect(s, all, 'd', toggle)).toEqual(st(['a'], 'd'));
  });
  it('range (Shift-click) adds the pages between the anchor and the click, in that direction', () => {
    expect(clickSelect(st(['b'], 'b'), all, 'd', range)).toEqual(st(['b', 'c', 'd'], 'b'));
    expect(clickSelect(st(['d'], 'd'), all, 'b', range)).toEqual(st(['d', 'c', 'b'], 'd'));
  });
  it('range keeps an existing selection and does not duplicate', () => {
    expect(clickSelect(st(['e', 'b'], 'b'), all, 'c', range)).toEqual(st(['e', 'b', 'c'], 'b'));
  });
  it('range without a usable anchor behaves like a plain click', () => {
    expect(clickSelect(st(['a'], null), all, 'c', range)).toEqual(st(['c'], 'c'));
    expect(clickSelect(st(['a'], 'zz'), all, 'c', range)).toEqual(st(['c'], 'c'));
  });
});

describe('boxSelect', () => {
  it('replaces the selection with what the box covers', () => {
    expect(boxSelect(['a'], ['c', 'd'], false)).toEqual(['c', 'd']);
  });
  it('adds to the selection when additive, keeping existing order first', () => {
    expect(boxSelect(['e', 'c'], ['b', 'c', 'd'], true)).toEqual(['e', 'c', 'b', 'd']);
  });
});

describe('box geometry', () => {
  it('normalizes a box dragged in any direction', () => {
    expect(normalizeBox(50, 80, 10, 20)).toEqual({ left: 10, top: 20, right: 50, bottom: 80 });
  });
  it('detects overlap, including partial overlap', () => {
    const box = { left: 0, top: 0, right: 100, bottom: 100 };
    expect(boxesIntersect(box, { left: 90, top: 90, right: 150, bottom: 150 })).toBe(true);
    expect(boxesIntersect(box, { left: 20, top: 20, right: 30, bottom: 30 })).toBe(true);
    expect(boxesIntersect(box, { left: 101, top: 0, right: 150, bottom: 50 })).toBe(false);
    expect(boxesIntersect(box, { left: 0, top: 120, right: 50, bottom: 150 })).toBe(false);
  });
});
