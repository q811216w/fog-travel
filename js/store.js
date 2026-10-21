// 資料儲存：全部存在使用者手機的瀏覽器（IndexedDB），不會上傳。
const DB_NAME = 'fog-travel';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((r) => { out = r; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function get(key, fallback) {
  try {
    const v = await tx('kv', 'readonly', (s) => reqP(s.get(key)));
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

export async function set(key, value) {
  try {
    await tx('kv', 'readwrite', (s) => { s.put(value, key); });
    return true;
  } catch (e) {
    console.warn('save failed', key, e);
    return false;
  }
}

export async function putPhoto(id, blob) {
  await tx('photos', 'readwrite', (s) => { s.put(blob, id); });
}

export async function getPhoto(id) {
  try {
    return await tx('photos', 'readonly', (s) => reqP(s.get(id)));
  } catch (e) {
    return null;
  }
}

export async function deletePhoto(id) {
  try { await tx('photos', 'readwrite', (s) => { s.delete(id); }); } catch (e) { /* ignore */ }
}

export async function allPhotos() {
  try {
    return await tx('photos', 'readonly', async (s) => {
      const keys = await reqP(s.getAllKeys());
      const vals = await reqP(s.getAll());
      return keys.map((k, i) => [k, vals[i]]);
    });
  } catch (e) {
    return [];
  }
}

export async function clearAll() {
  await tx('kv', 'readwrite', (s) => { s.clear(); });
  await tx('photos', 'readwrite', (s) => { s.clear(); });
}
