// App state: one mutable document + UI state, a revision counter for React, and snapshot undo.
import { useSyncExternalStore } from 'react';
import { frameEls, insertKeyframe, kfIndexAt, kfStart, newDoc, tlLen, type Doc, type El, type Keyframe, type Layer, type Timeline } from './core/model.ts';

export type ToolId = 'select' | 'sub' | 'transform' | 'pen' | 'pencil' | 'brush' | 'line' | 'rect' | 'oval' | 'bucket' | 'dropper' | 'eraser' | 'hand' | 'zoom';
export type MenuItem = { label: string; cmd?: string; key?: string; sep?: boolean; disabled?: boolean };

/** Electron preload bridge (absent when the renderer runs in a plain browser). */
export type Api = {
  openProject(): Promise<{ path: string; text: string } | null>;
  saveProject(path: string | null, text: string): Promise<string | null>;
  openImages(): Promise<{ name: string; dataUrl: string }[]>;
  pickExportPath(kind: 'gif' | 'png' | 'mp4' | 'webm'): Promise<string | null>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  videoStart(o: { path: string; w: number; h: number; fps: number; format: 'mp4' | 'webm'; alpha: boolean }): Promise<number>;
  videoFrame(id: number, rgba: Uint8Array): Promise<void>;
  videoEnd(id: number): Promise<void>;
  videoAbort(id: number): Promise<void>;
  setDirty(d: boolean): void;
  toggleDevTools(): void;
};
export const api = (window as unknown as { api?: Api }).api;

const doc0 = newDoc();
export const S = {
  doc: doc0,
  ui: {
    tool: 'select' as ToolId,
    sel: [] as string[],
    layerId: doc0.tl.layers[0].id,
    frame: 0,
    playing: false, loop: true, onion: false, onionN: 3,
    zoom: 1, panX: 0, panY: 0, viewW: 800, viewH: 600,
    fill: '#8b7cf6ff' as string | null, stroke: '#18181bff' as string | null, sw: 2, brush: 14,
    // tool options (shown in the options bar)
    thinning: 0.6, smoothing: 0.5, pressure: true, radius: 0, eraser: 8, snap: true, rotSnap: 15,
    /** Symbol-edit stack; each entry remembers the parent playhead to restore on exit. */
    edit: [] as { symbolId: string; parentFrame: number; parentLayer: string }[],
    filePath: null as string | null, dirty: false,
    toast: '', exportOpen: false,
    ctxMenu: null as null | { x: number; y: number; items: MenuItem[] },
  },
  rev: 0, docRev: 0,
};

const subs = new Set<() => void>();
const emit = () => { S.rev++; subs.forEach(f => f()); };
export const useApp = () => useSyncExternalStore(cb => { subs.add(cb); return () => subs.delete(cb); }, () => S.rev);

export function setUI(p: Partial<typeof S.ui>) { Object.assign(S.ui, p); emit(); }
export const redraw = emit;
let toastTimer = 0;
export function toast(msg: string) { clearTimeout(toastTimer); setUI({ toast: msg }); toastTimer = window.setTimeout(() => setUI({ toast: '' }), 2600); }

// ---------- undo ----------
// Assets (big image dataURLs) are copied shallowly: asset objects are immutable, replaced rather than edited.
const undoStack: Doc[] = [], redoStack: Doc[] = [];
const snap = (): Doc => { const { assets, ...rest } = S.doc; return { ...structuredClone(rest), assets: { ...assets } }; };
const restore = (s: Doc) => { S.doc = s; afterDocChange(); };

/**
 * Change the document. Pass undoable=false for the 2nd+ step of one drag so the whole gesture is
 * a single undo entry (one stroke = one Ctrl+Z).
 */
export function mutate(fn: (d: Doc) => void, undoable = true) {
  if (undoable) { undoStack.push(snap()); if (undoStack.length > 300) undoStack.shift(); redoStack.length = 0; }
  fn(S.doc);
  afterDocChange();
}
export function undo() { const s = undoStack.pop(); if (!s) return; redoStack.push(snap()); restore(s); }
export function redo() { const s = redoStack.pop(); if (!s) return; undoStack.push(snap()); restore(s); }

function afterDocChange() {
  S.docRev++;
  if (!S.ui.dirty) { S.ui.dirty = true; api?.setDirty(true); }
  // keep UI references valid after undo / deletes
  S.ui.edit = S.ui.edit.filter(e => S.doc.symbols[e.symbolId]);
  const tl = curTl();
  if (!tl.layers.some(l => l.id === S.ui.layerId)) S.ui.layerId = tl.layers[0]?.id ?? '';
  const shown = new Set(tl.layers.flatMap(l => frameEls(l, S.ui.frame).els.map(e => e.id)));
  S.ui.sel = S.ui.sel.filter(id => shown.has(id));
  emit();
}

export function loadDoc(doc: Doc, path: string | null) {
  S.doc = doc; undoStack.length = redoStack.length = 0;
  Object.assign(S.ui, { sel: [], frame: 0, edit: [], filePath: path, layerId: doc.tl.layers[0]?.id ?? '', playing: false });
  S.docRev++; S.ui.dirty = false; api?.setDirty(false);
  emit();
}
export function markSaved(path: string) { S.ui.filePath = path; S.ui.dirty = false; api?.setDirty(false); emit(); }

// ---------- context helpers ----------
export const curTl = (): Timeline => { const e = S.ui.edit.at(-1); return e ? S.doc.symbols[e.symbolId].tl : S.doc.tl; };
export const curLayer = (): Layer | undefined => curTl().layers.find(l => l.id === S.ui.layerId);
export const curLen = () => tlLen(curTl());

/** Selected elements as currently displayed (tweens interpolated) — for overlays and hit info. */
export function shownSel(): { layer: Layer; el: El; age: number }[] {
  const out: { layer: Layer; el: El; age: number }[] = [];
  for (const layer of curTl().layers) {
    const { els, start } = frameEls(layer, S.ui.frame);
    for (const el of els) if (S.ui.sel.includes(el.id)) out.push({ layer, el, age: S.ui.frame - start });
  }
  return out;
}

/**
 * Keyframe to write into on `layer` at the playhead. Past the end it adds a blank keyframe;
 * inside a tween span it auto-creates a keyframe holding the interpolated pose (auto-key).
 */
export function kfForEdit(layer: Layer, f = S.ui.frame): Keyframe {
  const i = kfIndexAt(layer, f);
  if (i < 0) return insertKeyframe(layer, f, true);
  const kf = layer.kfs[i];
  if (kfStart(layer, i) !== f && kf.tween && layer.kfs[i + 1]) return insertKeyframe(layer, f, false);
  return kf;
}
/** Inside mutate(): the real (editable) selected elements, auto-keying tweened layers. */
export function editSel(): { layer: Layer; kf: Keyframe; el: El }[] {
  const out: { layer: Layer; kf: Keyframe; el: El }[] = [];
  for (const layer of curTl().layers) {
    if (layer.locked) continue;
    if (!frameEls(layer, S.ui.frame).els.some(e => S.ui.sel.includes(e.id))) continue;
    const kf = kfForEdit(layer);
    for (const el of kf.els) if (S.ui.sel.includes(el.id)) out.push({ layer, kf, el });
  }
  return out;
}
/** Layer to draw on, or null (with a toast) if it is hidden/locked. */
export function drawLayer(): Layer | null {
  const l = curLayer();
  if (!l) { toast('Add a layer first'); return null; }
  if (l.locked || !l.visible) { toast(`"${l.name}" is ${l.locked ? 'locked' : 'hidden'}`); return null; }
  return l;
}

// ---------- playback ----------
let raf = 0;
export function togglePlay() {
  if (S.ui.playing) { cancelAnimationFrame(raf); setUI({ playing: false }); return; }
  const len = curLen();
  const startFrame = S.ui.frame >= len - 1 ? 0 : S.ui.frame;
  const t0 = performance.now();
  setUI({ playing: true, sel: [] });
  const tick = (now: number) => {
    let f = startFrame + Math.floor(((now - t0) / 1000) * S.doc.fps);
    const n = curLen();
    if (f >= n) { if (S.ui.loop) f %= n; else { setUI({ frame: n - 1, playing: false }); return; } }
    if (f !== S.ui.frame) setUI({ frame: f });
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
export function stopPlay() { if (S.ui.playing) togglePlay(); }
