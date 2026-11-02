import { describe, expect, it } from 'vitest';
import { rotatePages, removePages, History, type PageRef } from './model';
import { addOverlay, cleanDigits, removeOverlay, resizeOverlay, updateOverlay, type Overlay } from './overlay';

const base = { x: 10, y: 100, angle: 0 as const };
const text: Overlay = { ...base, id: 't', kind: 'text', text: 'שלום', size: 12 };
const comb: Overlay = { ...base, id: 'c', kind: 'comb', digits: '123', size: 12, pitch: 20 };
const mark: Overlay = { ...base, id: 'm', kind: 'mark', w: 10, h: 10 };
const image: Overlay = { ...base, id: 'i', kind: 'image', assetId: 'a', w: 100, h: 50 };

const page = (id: string, overlays?: Overlay[]): PageRef => ({ id, sourceId: 'A', pageIndex: 0, overlays });

describe('overlay list operations', () => {
  it('adds an item to one page and leaves the other page objects alone', () => {
    const pages = [page('p1'), page('p2')];
    const next = addOverlay(pages, 'p2', mark);
    expect(next[1].overlays).toEqual([mark]);
    expect(next[0]).toBe(pages[0]);
    expect(pages[1].overlays).toBeUndefined();
  });

  it('updates one item without mutating the previous state', () => {
    const pages = [page('p1', [mark, text])];
    const next = updateOverlay(pages, 'p1', 'm', (o) => ({ ...o, x: 50 }));
    expect(next[0].overlays![0].x).toBe(50);
    expect(next[0].overlays![1]).toBe(text);
    expect(pages[0].overlays![0].x).toBe(10);
  });

  it('removes one item', () => {
    const next = removeOverlay([page('p1', [mark, text])], 'p1', 'm');
    expect(next[0].overlays).toEqual([text]);
  });

  it('returns the input array when the page or item does not exist', () => {
    const pages = [page('p1', [mark])];
    expect(addOverlay(pages, 'nope', text)).toBe(pages);
    expect(removeOverlay(pages, 'p1', 'nope')).toBe(pages);
    expect(updateOverlay(pages, 'p1', 'nope', (o) => o)).toBe(pages);
  });

  it('undo restores an item, and restores the items of a removed page', () => {
    const history = new History<PageRef[]>([page('p1', [mark])]);
    history.push(removeOverlay(history.current, 'p1', 'm'));
    expect(history.undo()[0].overlays).toEqual([mark]);
    history.push(removePages(history.current, new Set(['p1'])));
    expect(history.undo()[0].overlays).toEqual([mark]);
  });

  it('keeps items when a page is rotated', () => {
    const next = rotatePages([page('p1', [mark])], new Set(['p1']), 90);
    expect(next[0].rotation).toBe(90);
    expect(next[0].overlays).toEqual([mark]);
  });
});

describe('resizeOverlay', () => {
  it('scales text by font size', () => {
    expect(resizeOverlay(text, 2)).toMatchObject({ kind: 'text', size: 24, x: 10, y: 100 });
  });

  it('scales spaced numbers’ size and pitch together', () => {
    expect(resizeOverlay(comb, 1.5)).toMatchObject({ size: 18, pitch: 30 });
  });

  it('scales the X freely', () => {
    expect(resizeOverlay(mark, 2, 3)).toMatchObject({ w: 20, h: 30 });
  });

  it('keeps an image’s aspect ratio, using the horizontal factor', () => {
    expect(resizeOverlay(image, 2, 5)).toMatchObject({ w: 200, h: 100 });
  });

  it('enforces minimum sizes, and keeps proportions while doing so', () => {
    expect(resizeOverlay(text, 0.01)).toMatchObject({ size: 4 });
    const tiny = resizeOverlay(comb, 0.01) as Extract<Overlay, { kind: 'comb' }>;
    expect(tiny.size).toBe(4);
    expect(tiny.pitch).toBeCloseTo((20 * 4) / 12);
    expect(resizeOverlay(mark, 0.01, 0.01)).toMatchObject({ w: 4, h: 4 });
    expect(resizeOverlay(image, 0.01)).toMatchObject({ w: 8, h: 4 });
  });
});

describe('cleanDigits', () => {
  it('keeps only ASCII digits', () => {
    expect(cleanDigits(' 12-3a٤ 4')).toBe('1234');
  });
});
