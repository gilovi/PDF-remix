import type { PageRef } from './model';
import type { Overlay } from './overlay';
import type { Signature } from './signatures';
import { fromStored, toStored, type StoredSignature } from './signatureVault';
import type { Cipher, Sealed } from './vault';

/** Work not yet downloaded, kept encrypted so it can be reopened after closing the tab. */
export interface Draft {
  id: string;
  name: string;
  sources: { id: string; name: string; bytes: Uint8Array }[];
  pages: PageRef[];
  signatures: Signature[];
}

/** Only the id, time and size are unencrypted, so the page can say work exists before unlocking. */
export interface DraftRecord {
  id: string;
  updatedAt: number;
  bytes: number;
  meta: Sealed;
}

export interface DraftFileRecord {
  draftId: string;
  fileId: string;
  file: Sealed;
}

export interface DraftStorage {
  records(): Promise<DraftRecord[]>;
  put(record: DraftRecord): Promise<void>;
  /** Removes a draft and its files. */
  remove(id: string): Promise<void>;
  file(draftId: string, fileId: string): Promise<DraftFileRecord | null>;
  fileIds(draftId: string): Promise<string[]>;
  putFile(record: DraftFileRecord): Promise<void>;
  removeFile(draftId: string, fileId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface DraftLimits {
  maxDrafts: number;
  maxTotalBytes: number;
  maxDraftBytes: number;
}

export interface DraftSummary {
  id: string;
  name: string;
  pageCount: number;
  updatedAt: number;
  bytes: number;
  /** False if the current key can't open it. It can still be deleted. */
  readable: boolean;
}

interface DraftMeta {
  name: string;
  sources: { id: string; name: string }[];
  pages: PageRef[];
  signatures: StoredSignature[];
}

const MB = 1024 * 1024;
const DEFAULT_LIMITS: DraftLimits = { maxDrafts: 5, maxTotalBytes: 500 * MB, maxDraftBytes: 200 * MB };

const metaContext = (id: string) => `draft/${id}/meta`;
const fileContext = (id: string, fileId: string) => `draft/${id}/file/${fileId}`;
const encodeMeta = (meta: DraftMeta) => new TextEncoder().encode(JSON.stringify(meta));
const decodeMeta = (bytes: Uint8Array): DraftMeta => JSON.parse(new TextDecoder().decode(bytes)) as DraftMeta;

/** Which drafts to drop, oldest first, to stay within the limits. The current one always stays. */
export function draftsToEvict(records: readonly { id: string; updatedAt: number; bytes: number }[], currentId: string, limits: DraftLimits): string[] {
  const others = records.filter((r) => r.id !== currentId).sort((a, b) => a.updatedAt - b.updatedAt);
  let count = records.length;
  let total = records.reduce((sum, r) => sum + r.bytes, 0);
  const evicted: string[] = [];
  for (const record of others) {
    if (count <= limits.maxDrafts && total <= limits.maxTotalBytes) break;
    evicted.push(record.id);
    count--;
    total -= record.bytes;
  }
  return evicted;
}

/** Only the signatures placed on pages are worth keeping with a draft. */
export function referencedSignatures(pages: readonly PageRef[], all: readonly Signature[]): Signature[] {
  const used = new Set(pages.flatMap((p) => p.overlays ?? []).flatMap((o) => (o.kind === 'image' || o.kind === 'vector' ? [o.assetId] : [])));
  return all.filter((s) => used.has(s.id));
}

/** Points restored pages at their restored files and signatures, with fresh ids so nothing clashes with new items. */
export function restorePages(
  pages: readonly PageRef[],
  sourceIds: ReadonlyMap<string, string>,
  assetIds: ReadonlyMap<string, string>,
  newId: (prefix: string) => string,
): PageRef[] {
  return pages.flatMap((page) => {
    const sourceId = sourceIds.get(page.sourceId);
    if (!sourceId) return [];
    const restored: PageRef = { ...page, id: newId('p'), sourceId };
    if (page.overlays) {
      restored.overlays = page.overlays.flatMap((o): Overlay[] => {
        if (o.kind !== 'image' && o.kind !== 'vector') return [{ ...o, id: newId('ovr') }];
        const assetId = assetIds.get(o.assetId);
        return assetId ? [{ ...o, assetId, id: newId('ovr') }] : [];
      });
    }
    return [restored];
  });
}

export class DraftStore {
  constructor(
    private storage: DraftStorage,
    private limits: DraftLimits = DEFAULT_LIMITS,
  ) {}

  /**
   * Saves a draft. Files are written once and only the page list changes after that,
   * so editing a large document doesn't rewrite it.
   */
  async save(draft: Draft, cipher: Cipher, now = Date.now()): Promise<'saved' | 'too-large'> {
    const bytes = draft.sources.reduce((sum, s) => sum + s.bytes.length, 0);
    if (bytes > this.limits.maxDraftBytes) return 'too-large';

    const stored = new Set(await this.storage.fileIds(draft.id));
    for (const source of draft.sources) {
      if (stored.has(source.id)) continue;
      await this.storage.putFile({ draftId: draft.id, fileId: source.id, file: await cipher.seal(source.bytes, fileContext(draft.id, source.id)) });
    }
    const meta: DraftMeta = {
      name: draft.name,
      sources: draft.sources.map(({ id, name }) => ({ id, name })),
      pages: draft.pages,
      signatures: draft.signatures.map(toStored),
    };
    await this.storage.put({ id: draft.id, updatedAt: now, bytes, meta: await cipher.seal(encodeMeta(meta), metaContext(draft.id)) });

    const current = new Set(draft.sources.map((s) => s.id));
    for (const fileId of stored) if (!current.has(fileId)) await this.storage.removeFile(draft.id, fileId);
    for (const id of draftsToEvict(await this.storage.records(), draft.id, this.limits)) await this.storage.remove(id);
    return 'saved';
  }

  async count(): Promise<number> {
    return (await this.storage.records()).length;
  }

  /** Newest first. */
  async summaries(cipher: Cipher): Promise<DraftSummary[]> {
    const records = (await this.storage.records()).sort((a, b) => b.updatedAt - a.updatedAt);
    return Promise.all(
      records.map(async ({ id, updatedAt, bytes, meta }): Promise<DraftSummary> => {
        try {
          const { name, pages } = decodeMeta(await cipher.open(meta, metaContext(id)));
          return { id, name, pageCount: pages.length, updatedAt, bytes, readable: true };
        } catch {
          return { id, name: '', pageCount: 0, updatedAt, bytes, readable: false };
        }
      }),
    );
  }

  async load(id: string, cipher: Cipher): Promise<Draft> {
    const record = (await this.storage.records()).find((r) => r.id === id);
    if (!record) throw new Error('That unsaved work is no longer here.');
    const meta = decodeMeta(await cipher.open(record.meta, metaContext(id)));
    const sources = await Promise.all(
      meta.sources.map(async ({ id: fileId, name }) => {
        const file = await this.storage.file(id, fileId);
        if (!file) throw new Error(`A file of this work is missing: ${name}`);
        return { id: fileId, name, bytes: await cipher.open(file.file, fileContext(id, fileId)) };
      }),
    );
    return { id, name: meta.name, sources, pages: meta.pages, signatures: meta.signatures.map(fromStored) };
  }

  remove(id: string): Promise<void> {
    return this.storage.remove(id);
  }

  clear(): Promise<void> {
    return this.storage.clear();
  }

  /** Re-encrypts for a new key. A draft that can't be read is left as it is, to be listed as unreadable. */
  async rekey(before: Cipher, after: Cipher): Promise<void> {
    for (const record of await this.storage.records()) {
      try {
        const files = await Promise.all(
          (await this.storage.fileIds(record.id)).map(async (fileId) => {
            const stored = await this.storage.file(record.id, fileId);
            const context = fileContext(record.id, fileId);
            return { draftId: record.id, fileId, file: await after.seal(await before.open(stored!.file, context), context) };
          }),
        );
        const meta = await after.seal(await before.open(record.meta, metaContext(record.id)), metaContext(record.id));
        for (const file of files) await this.storage.putFile(file);
        await this.storage.put({ ...record, meta });
      } catch {
        /* Unreadable with the old key too, so there's nothing to carry over. */
      }
    }
  }
}
