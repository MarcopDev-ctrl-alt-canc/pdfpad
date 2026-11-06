const dbp = new Promise((ok, ko) => {
  const r = indexedDB.open('pdfpad', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => ko(r.error);
});

export async function idb(method, ...args) {
  const db = await dbp;
  return new Promise((ok, ko) => {
    const r = db.transaction('kv', method === 'get' ? 'readonly' : 'readwrite').objectStore('kv')[method](...args);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}

export const libList = async () => await idb('get', 'lib') || [];

export async function libAdd(bytes, name) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await idb('put', { bytes, name }, 'doc:' + id);
  await idb('put', [{ id, name, opened: Date.now() }, ...await libList()], 'lib');
  return id;
}

export async function libTouch(id, patch = {}) {
  const list = await libList(), i = list.findIndex(x => x.id === id);
  if (i < 0) return;
  const [e] = list.splice(i, 1);
  await idb('put', [{ ...e, ...patch, opened: Date.now() }, ...list], 'lib');
}

export async function libRemove(id) {
  await idb('delete', 'doc:' + id);
  await idb('delete', 'ink:' + id);
  await idb('put', (await libList()).filter(x => x.id !== id), 'lib');
  if (await idb('get', 'cur') === id) await idb('delete', 'cur');
}

export async function migrate() {
  const d = await idb('get', 'doc');
  if (!d) return;
  const ink = await idb('get', 'ink'), id = await libAdd(d.bytes, d.name);
  if (ink) await idb('put', ink, 'ink:' + id);
  await idb('put', id, 'cur');
  await idb('delete', 'doc');
  await idb('delete', 'ink');
}
