import type { DraftFileRecord, DraftRecord, DraftStorage } from './drafts';
import type { VaultStorage } from './signatureVault';
import type { Vault } from './vault';

const DATABASE = 'pdf-remix';
const VAULT = 'vault';
const DRAFTS = 'drafts';
const DRAFT_FILES = 'draftFiles';
const KEY = 'main';

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE, 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const name of [VAULT, DRAFTS, DRAFT_FILES]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
  };
  return done(request);
}

/** Runs requests in one transaction, across the named stores, and waits for it to complete. */
async function transact<T>(stores: string[], mode: IDBTransactionMode, action: (tx: IDBTransaction) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(stores, mode);
    const result = await done(action(transaction));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    return result;
  } finally {
    db.close();
  }
}

const fileKey = (draftId: string, fileId: string) => `${draftId}/${fileId}`;
/** Every key of one draft's files, without reading the files themselves. */
const filesOf = (draftId: string) => IDBKeyRange.bound(`${draftId}/`, `${draftId}/${String.fromCharCode(0xffff)}`);

/** Keeps the encrypted vault in this browser's IndexedDB. */
export const browserVaultStorage: VaultStorage = {
  async load() {
    return (await transact<Vault | undefined>([VAULT], 'readonly', (tx) => tx.objectStore(VAULT).get(KEY))) ?? null;
  },
  async save(vault) {
    await transact([VAULT], 'readwrite', (tx) => tx.objectStore(VAULT).put(vault, KEY));
  },
  /** Drafts go too: they're encrypted with the vault's key, and can't be opened without it. */
  async clear() {
    await transact([VAULT, DRAFTS, DRAFT_FILES], 'readwrite', (tx) => {
      tx.objectStore(DRAFTS).clear();
      tx.objectStore(DRAFT_FILES).clear();
      return tx.objectStore(VAULT).delete(KEY);
    });
  },
};

/** Keeps encrypted unsaved work in this browser's IndexedDB, beside the vault. */
export const browserDraftStorage: DraftStorage = {
  records() {
    return transact<DraftRecord[]>([DRAFTS], 'readonly', (tx) => tx.objectStore(DRAFTS).getAll());
  },
  async put(record) {
    await transact([DRAFTS], 'readwrite', (tx) => tx.objectStore(DRAFTS).put(record, record.id));
  },
  async remove(id) {
    await transact([DRAFTS, DRAFT_FILES], 'readwrite', (tx) => {
      tx.objectStore(DRAFT_FILES).delete(filesOf(id));
      return tx.objectStore(DRAFTS).delete(id);
    });
  },
  async file(draftId, fileId) {
    const key = fileKey(draftId, fileId);
    return (await transact<DraftFileRecord | undefined>([DRAFT_FILES], 'readonly', (tx) => tx.objectStore(DRAFT_FILES).get(key))) ?? null;
  },
  async fileIds(draftId) {
    const keys = await transact<IDBValidKey[]>([DRAFT_FILES], 'readonly', (tx) => tx.objectStore(DRAFT_FILES).getAllKeys(filesOf(draftId)));
    return keys.map((key) => String(key).slice(draftId.length + 1));
  },
  async putFile(record) {
    await transact([DRAFT_FILES], 'readwrite', (tx) => tx.objectStore(DRAFT_FILES).put(record, fileKey(record.draftId, record.fileId)));
  },
  async removeFile(draftId, fileId) {
    await transact([DRAFT_FILES], 'readwrite', (tx) => tx.objectStore(DRAFT_FILES).delete(fileKey(draftId, fileId)));
  },
  async clear() {
    await transact([DRAFTS, DRAFT_FILES], 'readwrite', (tx) => {
      tx.objectStore(DRAFT_FILES).clear();
      return tx.objectStore(DRAFTS).clear();
    });
  },
};
