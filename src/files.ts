// Project open/save (desktop bridge, browser File System Access, or download fallback) plus
// auto-save: a recovery copy in IndexedDB, and a silent re-save of a project that has a location.
import type { Doc } from './core/model.ts';
import { download } from './exporter.ts';
import { S, api, loadDoc, markSaved, setUI, toast } from './store.ts';

type Picker = { types: { description: string; accept: Record<string, string[]> }[]; suggestedName?: string };
const fsa = window as unknown as {
  showOpenFilePicker?(o: Picker): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?(o: Picker): Promise<FileSystemFileHandle>;
};
const TYPES = [{ description: 'AnobeAnimate project', accept: { 'application/json': ['.anobe'] } }];
const aborted = (e: unknown) => (e as Error)?.name === 'AbortError';

export function isDoc(d: unknown): d is Doc {
  const x = d as Doc;
  return !!x && x.v === 1 && typeof x.w === 'number' && Array.isArray(x.tl?.layers) && typeof x.symbols === 'object' && typeof x.assets === 'object';
}

/** Ask for a project file: { name/path, text, browser handle }. */
async function pick(): Promise<{ path: string; text: string; handle?: FileSystemFileHandle } | null> {
  if (api) return api.openProject();
  if (fsa.showOpenFilePicker) {
    const [handle] = await fsa.showOpenFilePicker({ types: TYPES });
    const f = await handle.getFile();
    return { path: f.name, text: await f.text(), handle };
  }
  return new Promise(res => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept: '.anobe,.json' });
    inp.onchange = async () => { const f = inp.files?.[0]; res(f ? { path: f.name, text: await f.text() } : null); };
    inp.oncancel = () => res(null);
    inp.click();
  });
}

/** Returns true when a project was loaded. */
export async function openFile(): Promise<boolean> {
  try {
    const r = await pick();
    if (!r) return false;
    const d = JSON.parse(r.text);
    if (!isDoc(d)) throw new Error('not an AnobeAnimate project');
    loadDoc(d, r.path, r.handle ?? null);
    return true;
  } catch (e) {
    if (!aborted(e)) toast(`Could not open: ${(e as Error).message}`);
    return false;
  }
}

/** Write the project; returns its path/name, or null if the user cancelled. */
async function write(as: boolean, text: string): Promise<string | null> {
  if (api) return api.saveProject(as ? null : S.ui.filePath, text);
  const name = S.ui.filePath ?? 'Untitled.anobe';
  if (!fsa.showSaveFilePicker) { download(new Blob([text], { type: 'application/json' }), name); return name; }
  if (as || !S.ui.handle) S.ui.handle = await fsa.showSaveFilePicker({ types: TYPES, suggestedName: name });
  const w = await S.ui.handle.createWritable();
  await w.write(text); await w.close();
  return S.ui.handle.name;
}

let saving = false;
export async function save(as = false, auto = false) {
  if (saving) return;
  saving = true;
  const rev = S.docRev; // edits made while writing keep the project dirty
  try {
    const path = await write(as, JSON.stringify(S.doc));
    if (!path) return;
    if (S.docRev === rev) markSaved(path); else setUI({ filePath: path });
    if (!auto) toast('Saved');
  } catch (e) {
    if (!auto && !aborted(e)) toast(`Could not save: ${(e as Error).message}`);
  } finally { saving = false; }
}

// ---------- recovery copy (IndexedDB: localStorage is ~5 MB and images are embedded data URLs) ----------
type Recovery = { doc: Doc; path: string | null; dirty: boolean; handle: FileSystemFileHandle | null };
const db = new Promise<IDBDatabase>((res, rej) => {
  const r = indexedDB.open('anobe', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function kv<T>(fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const s = (await db).transaction('kv', 'readwrite').objectStore('kv');
  return new Promise((res, rej) => { const r = fn(s); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

/** Restore the last session, then keep the recovery copy current and re-save located projects when idle. */
export async function startAutosave(after: () => void) {
  try {
    const r = await kv<Recovery | undefined>(s => s.get('recovery'));
    if (r && isDoc(r.doc) && !S.ui.dirty) {
      loadDoc(r.doc, r.path, r.handle);
      if (r.dirty) { setUI({ dirty: true }); api?.setDirty(true); toast('Recovered unsaved work'); }
      after();
    }
  } catch { /* no recovery copy */ }
  let key = '', changed = 0;
  setInterval(async () => {
    const k = `${S.docRev}|${S.ui.dirty}|${S.ui.filePath}`;
    if (k !== key) {
      key = k; changed = Date.now();
      const rec: Recovery = { doc: S.doc, path: S.ui.filePath, dirty: S.ui.dirty, handle: S.ui.handle };
      kv(s => s.put(rec, 'recovery')).catch(() => {});
    }
    if (!S.ui.dirty || saving || Date.now() - changed < 3000) return;
    const h = S.ui.handle as (FileSystemFileHandle & { queryPermission?(o: { mode: string }): Promise<string> }) | null;
    const ok = api ? !!S.ui.filePath : !!h && (await h.queryPermission?.({ mode: 'readwrite' })) === 'granted';
    if (ok) save(false, true);
  }, 2000);
}
