// ORIS web — saved places and routes, kept on this device (IndexedDB) instead of the PC app's places folder.
// Two stores: places (file name → the whole place file) and meta (file name → what the Saved list shows).
const DB = "oris", VER = 1;
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const s of ["places", "meta"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(...stores.map(s => t.objectStore(s)))).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error("storage aborted (the device may be out of space)"));
  });
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** What the Studio needs to reopen a saved place or route (stops, area, effects, words, picture — no map data). */
export function metaOf(name, p, size) {
  const route = p.oris_route === 1;
  if (!route && p.oris_place !== 1) throw new Error("not an ORIS place or route file");
  const parts = route ? p.stops : [p], first = parts[0];
  return {
    file: name, kind: route ? "route" : "place", name: p.name || name.replace(/\.json$/, ""),
    created: p.created || "", mtime: Date.now(), size, center: p.center,
    stops: parts.map(s => ({ lat: s.center[0], lng: s.center[1], name: route ? s.name || "" : "" })),
    tr: first.terrain.half_m / 1000, cr: first.city.half_m, res: first.terrain.elev.n,
    sat: parts.some(s => s.city && "imagery" in s.city),
    options: p.options || {}, text: p.text || {}, subject: (p.subject || {}).image || null,
  };
}

export async function save(name, place) {
  const size = JSON.stringify(place).length;
  const m = metaOf(name, place, size);
  await tx(["places", "meta"], "readwrite", (P, M) => { P.put(place, name); M.put(m, name); });
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* best effort */ }
  return m;
}
export const load = name => tx(["places"], "readonly", P => req(P.get(name)));
export async function list() {
  const all = await tx(["meta"], "readonly", M => req(M.getAll()));
  return (all || []).sort((a, b) => b.mtime - a.mtime);
}
/** Effects, words and picture of a saved place, without touching its map data. */
export async function updateOptions(name, { options, text, subject }) {
  const p = await load(name);
  if (!p) throw new Error("that saved place is gone");
  p.options = options;
  p.text = text;
  if (subject) p.subject = { image: subject }; else delete p.subject;
  return save(name, p);
}
/** Off the Saved list and off this device. */
export async function remove(name) {
  await tx(["places", "meta"], "readwrite", (P, M) => { P.delete(name); M.delete(name); });
}
export async function usage() {
  try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) { return null; }
}
