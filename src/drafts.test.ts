import { describe, expect, it } from 'vitest';
import { DraftStore, draftsToEvict, referencedSignatures, restorePages, type Draft, type DraftFileRecord, type DraftRecord, type DraftStorage } from './drafts';
import type { PageRef } from './model';
import type { Signature } from './signatures';
import { cipherFor, createVault, type Unlocked } from './vault';

const FAST = { iterations: 1000 };

async function newCipher() {
  const { unlocked } = await createVault('correct horse battery', new Uint8Array(1), FAST);
  return cipherFor(unlocked as Unlocked);
}

function memoryStorage(): DraftStorage & { recordsMap: Map<string, DraftRecord>; filesMap: Map<string, DraftFileRecord>; fileWrites: number } {
  return {
    recordsMap: new Map(),
    filesMap: new Map(),
    fileWrites: 0,
    async records() {
      return [...this.recordsMap.values()].map((r) => structuredClone(r));
    },
    async put(record) {
      this.recordsMap.set(record.id, structuredClone(record));
    },
    async remove(id) {
      this.recordsMap.delete(id);
      for (const key of this.filesMap.keys()) if (key.startsWith(`${id}/`)) this.filesMap.delete(key);
    },
    async file(draftId, fileId) {
      return this.filesMap.get(`${draftId}/${fileId}`) ?? null;
    },
    async fileIds(draftId) {
      return [...this.filesMap.values()].filter((f) => f.draftId === draftId).map((f) => f.fileId);
    },
    async putFile(record) {
      this.fileWrites++;
      this.filesMap.set(`${record.draftId}/${record.fileId}`, structuredClone(record));
    },
    async removeFile(draftId, fileId) {
      this.filesMap.delete(`${draftId}/${fileId}`);
    },
    async clear() {
      this.recordsMap.clear();
      this.filesMap.clear();
    },
  };
}

const ink = { paths: ['M0 0L10 0L10 5Z'], width: 10, height: 5 };
const pdf = new Uint8Array([37, 80, 68, 70, 1, 2, 3, 4]);

function draft(over: Partial<Draft> = {}): Draft {
  return {
    id: 'd1',
    name: 'tax-form-secret.pdf',
    sources: [{ id: 's1', name: 'tax-form-secret.pdf', bytes: pdf }],
    pages: [{ id: 'p1', sourceId: 's1', pageIndex: 0, rotation: 90, overlays: [{ id: 'o1', kind: 'text', text: 'שלום', x: 1, y: 2, size: 12, angle: 0 }] }],
    signatures: [],
    ...over,
  };
}

describe('DraftStore', () => {
  it('brings back the files, pages, items and signatures', async () => {
    const cipher = await newCipher();
    const store = new DraftStore(memoryStorage());
    const signature: Signature = { id: 'sig1', kind: 'ink', ink };
    await store.save(draft({ signatures: [signature] }), cipher);
    const back = await store.load('d1', cipher);
    expect(back.sources[0].bytes).toEqual(pdf);
    expect(back.sources[0].name).toBe('tax-form-secret.pdf');
    expect(back.pages).toEqual(draft().pages);
    expect(back.signatures).toEqual([signature]);
  });

  it('brings back an image signature too', async () => {
    const cipher = await newCipher();
    const store = new DraftStore(memoryStorage());
    const signature: Signature = { id: 'sig1', kind: 'image', png: new Uint8Array([9, 8, 7]), width: 4, height: 2 };
    await store.save(draft({ signatures: [signature] }), cipher);
    expect((await store.load('d1', cipher)).signatures).toEqual([signature]);
  });

  it('stores nothing readable: no file name, text or file contents', async () => {
    const cipher = await newCipher();
    const storage = memoryStorage();
    await new DraftStore(storage).save(draft(), cipher);
    const dump = JSON.stringify([...storage.recordsMap.values()].map((r) => ({ ...r, meta: new TextDecoder('latin1').decode(r.meta.ciphertext) })));
    expect(dump).not.toContain('tax-form-secret');
    expect(dump).not.toContain('sourceId');
    const file = [...storage.filesMap.values()][0];
    expect(new TextDecoder('latin1').decode(file.file.ciphertext)).not.toContain('%PDF');
  });

  it('writes a source file once, however many times the draft is saved', async () => {
    const cipher = await newCipher();
    const storage = memoryStorage();
    const store = new DraftStore(storage);
    await store.save(draft(), cipher);
    await store.save(draft({ pages: [] }), cipher);
    await store.save(draft(), cipher);
    expect(storage.fileWrites).toBe(1);
  });

  it('drops the stored copy of a file that left the document', async () => {
    const cipher = await newCipher();
    const storage = memoryStorage();
    const store = new DraftStore(storage);
    const second = { id: 's2', name: 'b.pdf', bytes: pdf };
    await store.save(draft({ sources: [...draft().sources, second] }), cipher);
    expect(await storage.fileIds('d1')).toHaveLength(2);
    await store.save(draft(), cipher);
    expect(await storage.fileIds('d1')).toEqual(['s1']);
  });

  it('lists drafts newest first, with their details', async () => {
    const cipher = await newCipher();
    const store = new DraftStore(memoryStorage());
    await store.save(draft({ id: 'old', name: 'old.pdf' }), cipher, 100);
    await store.save(draft({ id: 'new', name: 'new.pdf' }), cipher, 200);
    expect(await store.summaries(cipher)).toMatchObject([
      { id: 'new', name: 'new.pdf', pageCount: 1, updatedAt: 200, readable: true },
      { id: 'old', name: 'old.pdf', pageCount: 1, updatedAt: 100, readable: true },
    ]);
  });

  it('counts drafts without needing the key', async () => {
    const store = new DraftStore(memoryStorage());
    expect(await store.count()).toBe(0);
    await store.save(draft(), await newCipher());
    expect(await store.count()).toBe(1);
  });

  it('marks a draft it can’t decrypt as unreadable, and refuses to load it', async () => {
    const store = new DraftStore(memoryStorage());
    await store.save(draft(), await newCipher());
    const other = await newCipher();
    expect(await store.summaries(other)).toMatchObject([{ id: 'd1', readable: false }]);
    await expect(store.load('d1', other)).rejects.toThrow();
  });

  it('won’t accept a file moved from another draft', async () => {
    const cipher = await newCipher();
    const storage = memoryStorage();
    const store = new DraftStore(storage);
    await store.save(draft({ id: 'a' }), cipher);
    await store.save(draft({ id: 'b' }), cipher);
    storage.filesMap.set('b/s1', { ...storage.filesMap.get('a/s1')!, draftId: 'b' });
    await expect(store.load('b', cipher)).rejects.toThrow();
  });

  it('doesn’t keep a document over the size limit', async () => {
    const cipher = await newCipher();
    const storage = memoryStorage();
    const store = new DraftStore(storage, { maxDrafts: 5, maxTotalBytes: 1000, maxDraftBytes: 4 });
    expect(await store.save(draft(), cipher)).toBe('too-large');
    expect(await store.count()).toBe(0);
    expect(storage.filesMap.size).toBe(0);
  });

  it('drops the oldest drafts past the count limit, and never the one being saved', async () => {
    const cipher = await newCipher();
    const store = new DraftStore(memoryStorage(), { maxDrafts: 2, maxTotalBytes: 1e9, maxDraftBytes: 1e9 });
    await store.save(draft({ id: 'a' }), cipher, 100);
    await store.save(draft({ id: 'b' }), cipher, 200);
    expect(await store.save(draft({ id: 'c' }), cipher, 150)).toBe('saved');
    expect((await store.summaries(cipher)).map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('removes one draft with its files, or all of them', async () => {
    const cipher = await newCipher();
    const storage = memoryStorage();
    const store = new DraftStore(storage);
    await store.save(draft({ id: 'a' }), cipher);
    await store.save(draft({ id: 'b' }), cipher);
    await store.remove('a');
    expect(await store.count()).toBe(1);
    expect(await storage.fileIds('a')).toEqual([]);
    await store.clear();
    expect(await store.count()).toBe(0);
  });

  it('re-encrypts everything for a new key', async () => {
    const before = await newCipher();
    const after = await newCipher();
    const store = new DraftStore(memoryStorage());
    await store.save(draft(), before);
    await store.rekey(before, after);
    expect((await store.load('d1', after)).sources[0].bytes).toEqual(pdf);
    await expect(store.load('d1', before)).rejects.toThrow();
  });

  it('keeps going past a draft that can’t be re-encrypted', async () => {
    const before = await newCipher();
    const after = await newCipher();
    const store = new DraftStore(memoryStorage());
    await store.save(draft({ id: 'lost' }), await newCipher());
    await store.save(draft({ id: 'fine' }), before);
    await store.rekey(before, after);
    expect((await store.load('fine', after)).name).toBe('tax-form-secret.pdf');
  });
});

describe('draftsToEvict', () => {
  const record = (id: string, updatedAt: number, bytes: number) => ({ id, updatedAt, bytes });
  const limits = { maxDrafts: 3, maxTotalBytes: 100, maxDraftBytes: 100 };

  it('removes nothing within the limits', () => {
    expect(draftsToEvict([record('a', 1, 10), record('b', 2, 10)], 'b', limits)).toEqual([]);
  });

  it('removes the oldest past the count', () => {
    const all = [record('a', 1, 1), record('b', 2, 1), record('c', 3, 1), record('d', 4, 1)];
    expect(draftsToEvict(all, 'd', limits)).toEqual(['a']);
  });

  it('removes the oldest until the total fits', () => {
    expect(draftsToEvict([record('a', 1, 60), record('b', 2, 30), record('c', 3, 50)], 'c', limits)).toEqual(['a']);
    expect(draftsToEvict([record('a', 1, 60), record('b', 2, 50), record('c', 3, 90)], 'c', limits)).toEqual(['a', 'b']);
  });

  it('never removes the current one, even if it’s the oldest', () => {
    expect(draftsToEvict([record('a', 1, 90), record('b', 2, 90)], 'a', limits)).toEqual(['b']);
  });
});

describe('referencedSignatures', () => {
  it('keeps only the signatures placed on pages', () => {
    const used: Signature = { id: 'sig1', kind: 'ink', ink };
    const unused: Signature = { id: 'sig2', kind: 'ink', ink };
    const pages: PageRef[] = [{ id: 'p', sourceId: 's', pageIndex: 0, overlays: [{ id: 'o', kind: 'vector', assetId: 'sig1', x: 0, y: 0, angle: 0, w: 1, h: 1 }] }];
    expect(referencedSignatures(pages, [used, unused])).toEqual([used]);
  });
});

describe('restorePages', () => {
  it('gives pages and items fresh ids, and points them at the restored files and signatures', () => {
    const pages: PageRef[] = [
      { id: 'p1', sourceId: 's1', pageIndex: 2, rotation: 90, overlays: [{ id: 'ov1', kind: 'vector', assetId: 'old', x: 5, y: 6, angle: 90, w: 1, h: 1 }, { id: 'ov2', kind: 'mark', x: 1, y: 1, angle: 0, w: 2, h: 2 }] },
      { id: 'p2', sourceId: 's2', pageIndex: 0 },
    ];
    let n = 100;
    const back = restorePages(pages, new Map([['s1', 'a'], ['s2', 'b']]), new Map([['old', 'new']]), (prefix) => `${prefix}${++n}`);
    expect(back[0]).toMatchObject({ sourceId: 'a', pageIndex: 2, rotation: 90 });
    expect(back[1].sourceId).toBe('b');
    expect(back[0].overlays![0]).toMatchObject({ assetId: 'new', x: 5, y: 6, angle: 90 });
    const ids = [back[0].id, back[1].id, ...back[0].overlays!.map((o) => o.id)];
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain('p1');
    expect(ids).not.toContain('ov1');
  });

  it('drops a page whose file didn’t come back', () => {
    const pages: PageRef[] = [{ id: 'p1', sourceId: 'gone', pageIndex: 0 }];
    expect(restorePages(pages, new Map(), new Map(), (p) => p)).toEqual([]);
  });

  it('drops an item whose signature didn’t come back', () => {
    const pages: PageRef[] = [{ id: 'p1', sourceId: 's', pageIndex: 0, overlays: [{ id: 'o', kind: 'image', assetId: 'gone', x: 0, y: 0, angle: 0, w: 1, h: 1 }] }];
    expect(restorePages(pages, new Map([['s', 's']]), new Map(), (p) => p)[0].overlays).toEqual([]);
  });
});
