// Saves the books in the browser's IndexedDB (survives closing the app; stays on this device).
export function idbStorage(dbName = "sooqwoow-books") {
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(dbName, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const run = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const tx = db.transaction("kv", mode); const rq = fn(tx.objectStore("kv")); tx.oncomplete = () => { db.close(); res(rq?.result ?? null); }; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); };
  return { load: () => run("readonly", (s) => s.get("state")), save: (json) => run("readwrite", (s) => s.put(json, "state")) };
}
