import { describe, expect, it } from 'vitest';
import {
  History,
  insertPages,
  movePages,
  rangeSelect,
  removePages,
  type PageRef,
} from './model';

const p = (id: string): PageRef => ({ id, sourceId: 's', pageIndex: 0 });
const ids = (pages: PageRef[]) => pages.map((x) => x.id).join('');
const doc = (s: string) => [...s].map(p);

describe('removePages', () => {
  it('removes exactly the given ids and keeps the order of the rest', () => {
    expect(ids(removePages(doc('abcde'), new Set(['b', 'd'])))).toBe('ace');
  });
  it('ignores unknown ids and does not mutate input', () => {
    const input = doc('abc');
    expect(ids(removePages(input, new Set(['z'])))).toBe('abc');
    expect(ids(removePages(input, new Set(['a'])))).toBe('bc');
    expect(ids(input)).toBe('abc');
  });
});

describe('movePages', () => {
  it('moves a single page forward to a gap', () => {
    // gap 4 = between d and e
    expect(ids(movePages(doc('abcde'), new Set(['a']), 4))).toBe('bcdae');
  });
  it('moves a single page backward', () => {
    expect(ids(movePages(doc('abcde'), new Set(['e']), 1))).toBe('aebcd');
  });
  it('moves a non-contiguous group together, keeping current relative order', () => {
    expect(ids(movePages(doc('abcdef'), new Set(['e', 'b']), 0))).toBe('beacdf');
    expect(ids(movePages(doc('abcdef'), new Set(['a', 'c']), 6))).toBe('bdefac');
    expect(ids(movePages(doc('abcdef'), new Set(['a', 'f']), 3))).toBe('bcafde');
  });
  it('is a no-op when dropping a group on its own position', () => {
    expect(ids(movePages(doc('abcde'), new Set(['b', 'c']), 1))).toBe('abcde');
    expect(ids(movePages(doc('abcde'), new Set(['b', 'c']), 2))).toBe('abcde');
    expect(ids(movePages(doc('abcde'), new Set(['b', 'c']), 3))).toBe('abcde');
  });
  it('clamps out-of-range gaps', () => {
    expect(ids(movePages(doc('abc'), new Set(['a']), 99))).toBe('bca');
    expect(ids(movePages(doc('abc'), new Set(['c']), -5))).toBe('cab');
  });
});

describe('insertPages', () => {
  it('inserts a group at an index, in the given order', () => {
    expect(ids(insertPages(doc('abc'), doc('XY'), 1))).toBe('aXYbc');
    expect(ids(insertPages(doc('abc'), doc('YX'), 0))).toBe('YXabc');
    expect(ids(insertPages(doc('abc'), doc('XY'), 3))).toBe('abcXY');
  });
  it('clamps the index to [0, length]', () => {
    expect(ids(insertPages(doc('ab'), doc('X'), 50))).toBe('abX');
    expect(ids(insertPages(doc('ab'), doc('X'), -1))).toBe('Xab');
  });
  it('works on an empty document', () => {
    expect(ids(insertPages([], doc('XY'), 0))).toBe('XY');
  });
});

describe('rangeSelect', () => {
  it('returns the inclusive range in either direction', () => {
    expect([...rangeSelect(doc('abcde'), 'b', 'd')].sort().join('')).toBe('bcd');
    expect([...rangeSelect(doc('abcde'), 'd', 'b')].sort().join('')).toBe('bcd');
  });
  it('falls back to just the target if the anchor is gone', () => {
    expect([...rangeSelect(doc('abc'), 'zz', 'b')].join('')).toBe('b');
  });
});

describe('History', () => {
  it('undoes and redoes', () => {
    const h = new History<number>(1);
    h.push(2);
    h.push(3);
    expect(h.current).toBe(3);
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.canUndo).toBe(false);
    expect(h.undo()).toBe(1);
    expect(h.redo()).toBe(2);
    expect(h.canRedo).toBe(true);
  });
  it('clears the redo stack on push', () => {
    const h = new History<number>(1);
    h.push(2);
    h.undo();
    h.push(5);
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBe(5);
  });
  it('reset forgets everything', () => {
    const h = new History<number>(1);
    h.push(2);
    h.reset(9);
    expect(h.current).toBe(9);
    expect(h.canUndo).toBe(false);
  });
});
