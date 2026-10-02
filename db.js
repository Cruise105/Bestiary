// Tiny IndexedDB wrapper. Everything lives on this device.
const DB_NAME = 'bestiary';
const DB_VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('monsters')) db.createObjectStore('monsters', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const db = {
  all: () => tx('monsters', 'readonly', s => reqP(s.getAll())),
  get: id => tx('monsters', 'readonly', s => reqP(s.get(id))),
  put: m => tx('monsters', 'readwrite', s => { s.put(m); }),
  putMany: list => tx('monsters', 'readwrite', s => { list.forEach(m => s.put(m)); }),
  del: id => tx('monsters', 'readwrite', s => { s.delete(id); }),
  getMeta: key => tx('meta', 'readonly', s => reqP(s.get(key))),
  setMeta: (key, val) => tx('meta', 'readwrite', s => { s.put(val, key); }),
};
