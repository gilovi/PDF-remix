import type { VaultStorage } from './signatureVault';
import type { Vault } from './vault';

const DATABASE = 'pdf-remix';
const STORE = 'vault';
const KEY = 'main';

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

function openDatabase(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  return done(request);
}

async function withStore<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE, mode);
    const result = await done(action(transaction.objectStore(STORE)));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    return result;
  } finally {
    db.close();
  }
}

/** Keeps the encrypted vault in this browser's IndexedDB. */
export const browserVaultStorage: VaultStorage = {
  async load() {
    return (await withStore<Vault | undefined>('readonly', (store) => store.get(KEY))) ?? null;
  },
  async save(vault) {
    await withStore('readwrite', (store) => store.put(vault, KEY));
  },
  async clear() {
    await withStore('readwrite', (store) => store.delete(KEY));
  },
};
