// A tiny Blob mailbox in IndexedDB. The Chrome service worker cannot make blob: URLs or decode
// audio, so it hands Blobs to the offscreen document through this store (same extension origin).
const DB = 'vdl-blobs';
const STORE = 'b';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
  } finally { db.close(); }
}

export const putBlob = (key, blob) => run('readwrite', (s) => s.put(blob, key));
export const getBlob = (key) => run('readonly', (s) => s.get(key));
export const delBlob = (key) => run('readwrite', (s) => s.delete(key));
export const clearBlobs = () => run('readwrite', (s) => s.clear());
