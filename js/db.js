// Tiny IndexedDB wrapper. Everything stays on the phone (inside Bluefy).
const DB_NAME = 'hwtablet';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('This browser has no storage (IndexedDB) available.')); return; }
    const timer = setTimeout(() => reject(new Error('Phone storage did not respond. Close other tabs of this app and reload.')), 8000);
    const req = indexedDB.open(DB_NAME, 1);
    req.onblocked = () => reject(new Error('Phone storage is busy in another tab. Close other tabs of this app and reload.'));
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('assignments', { keyPath: 'id' });
      db.createObjectStore('blobs');   // key -> Blob | ArrayBuffer
      db.createObjectStore('kv');      // key -> any
    };
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
    req.onerror = () => { clearTimeout(timer); reject(req.error); };
  });
  dbp.catch(() => { dbp = null; });   // allow a retry later
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const wrap = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const db = {
  async allAssignments() {
    return tx('assignments', 'readonly', s => wrap(s.getAll()));
  },
  async getAssignment(id) { return tx('assignments', 'readonly', s => wrap(s.get(id))); },
  async putAssignment(a) { return tx('assignments', 'readwrite', s => wrap(s.put(a))); },
  async deleteAssignment(id) { return tx('assignments', 'readwrite', s => wrap(s.delete(id))); },

  async getBlob(key) { return tx('blobs', 'readonly', s => wrap(s.get(key))); },
  async putBlob(key, value) { return tx('blobs', 'readwrite', s => wrap(s.put(value, key))); },
  async deleteBlob(key) { return tx('blobs', 'readwrite', s => wrap(s.delete(key))); },
  async deleteBlobsWithPrefix(prefix) {
    return tx('blobs', 'readwrite', s => wrap(s.delete(IDBKeyRange.bound(prefix, prefix + '￿'))));
  },

  async get(key, fallback = null) {
    const v = await tx('kv', 'readonly', s => wrap(s.get(key)));
    return v === undefined ? fallback : v;
  },
  async set(key, value) { return tx('kv', 'readwrite', s => wrap(s.put(value, key))); },
};

export function newId(prefix = '') {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return prefix + Array.from(a, b => (b % 36).toString(36)).join('');
}
