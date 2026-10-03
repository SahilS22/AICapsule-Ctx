import type { CapsuleFile } from '../core/capsule/schema';

/**
 * IndexedDB persistence (§19). Capsules are stored as whole documents keyed by id —
 * a capsule is the natural unit of load/save — while settings live in
 * chrome.storage.local. No giant localStorage blobs.
 */

const DB_NAME = 'context-capsule';
const DB_VERSION = 1;
const STORE = 'capsules';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updated_at', 'updated_at');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open database'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Database operation failed'));
        t.oncomplete = () => db.close();
        t.onerror = () => db.close();
      })
  );
}

export function saveCapsule(capsule: CapsuleFile): Promise<IDBValidKey> {
  return tx('readwrite', (s) => s.put(capsule));
}

export function getCapsule(id: string): Promise<CapsuleFile | undefined> {
  return tx('readonly', (s) => s.get(id) as IDBRequest<CapsuleFile | undefined>);
}

export function deleteCapsule(id: string): Promise<undefined> {
  return tx('readwrite', (s) => s.delete(id) as unknown as IDBRequest<undefined>);
}

export function listCapsules(): Promise<CapsuleFile[]> {
  return tx('readonly', (s) => s.getAll() as IDBRequest<CapsuleFile[]>);
}

export async function clearCapsules(): Promise<void> {
  await tx('readwrite', (s) => s.clear() as unknown as IDBRequest<undefined>);
}
