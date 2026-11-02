import { describe, expect, it } from 'vitest';
import { SignatureStore } from './signatures';
import type { Ink } from './ink';

const ink: Ink = { paths: ['M0 0L10 0L10 5Z'], width: 10, height: 5 };
const png = new Uint8Array([1, 2, 3]);

describe('SignatureStore', () => {
  it('lists what was added, newest first, with unique ids', () => {
    const store = new SignatureStore();
    const a = store.addInk(ink);
    const b = store.addImage(png, 40, 20);
    expect(a.id).not.toBe(b.id);
    expect(store.list().map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('gives what an export needs', () => {
    const store = new SignatureStore();
    const a = store.addInk(ink);
    const b = store.addImage(png, 40, 20);
    expect(store.inks().get(a.id)).toBe(ink);
    expect(store.pngs().get(b.id)).toBe(png);
  });

  it('hides a removed signature, but items already placed can still export it', () => {
    const store = new SignatureStore();
    const a = store.addInk(ink);
    store.remove(a.id);
    expect(store.list()).toEqual([]);
    expect(store.inks().get(a.id)).toBe(ink);
  });

  it('holds no raw stroke data', () => {
    const store = new SignatureStore();
    const a = store.addInk(ink);
    expect(Object.keys(store.get(a.id)!).sort()).toEqual(['id', 'ink', 'kind']);
  });

  it('reports each signature’s proportions', () => {
    const store = new SignatureStore();
    expect(store.addInk(ink)).toMatchObject({ kind: 'ink' });
    expect(store.addImage(png, 40, 20)).toMatchObject({ kind: 'image', width: 40, height: 20 });
  });
});
