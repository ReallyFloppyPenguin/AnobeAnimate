// Every user command (menus + keyboard) lives here, keyed by id.
import { clearKeyframe, cloneEls, ident, insertFrame, insertKeyframe, kfIndexAt, kfStart, layerLen, newLayer, newTween, removeFrame, uid, type Doc, type El, type Layer, type SymbolEl } from './core/model.ts';
import { unionRect, type Rect } from './core/geom.ts';
import { parentBounds } from './render.ts';
import {
  S, api, curLayer, curLen, curTl, drawLayer, editSel, kfForEdit, loadDoc, markSaved, mutate, redo, setUI, shownSel,
  stopPlay, toast, togglePlay, undo, type MenuItem, type ToolId,
} from './store.ts';
import { deleteSubNode, exitSymbol, penFinish, penPending, setTool, zoomAt } from './tools.ts';
import { newDoc } from './core/model.ts';

// ---------- file ----------
const confirmDiscard = () => !S.ui.dirty || confirm('Discard unsaved changes?');
function isDoc(d: unknown): d is Doc {
  const x = d as Doc;
  return !!x && x.v === 1 && typeof x.w === 'number' && Array.isArray(x.tl?.layers) && typeof x.symbols === 'object' && typeof x.assets === 'object';
}
async function openFile() {
  if (!api) return toast('Opening files needs the desktop app');
  if (!confirmDiscard()) return;
  const r = await api.openProject();
  if (!r) return;
  try {
    const d = JSON.parse(r.text);
    if (!isDoc(d)) throw new Error('not an AnobeAnimate project');
    loadDoc(d, r.path); fitView();
  } catch (e) { toast(`Could not open: ${(e as Error).message}`); }
}
async function save(as: boolean) {
  if (!api) return toast('Saving needs the desktop app');
  const path = await api.saveProject(as ? null : S.ui.filePath, JSON.stringify(S.doc));
  if (path) { markSaved(path); toast('Saved'); }
}

// ---------- images ----------
const loadSize = (src: string) => new Promise<{ w: number; h: number }>((res, rej) => {
  const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => rej(new Error('bad image')); i.src = src;
});
/** Add an image to the library and place it on the stage (centred on `at`, default stage centre). */
export async function addImage(name: string, src: string, at?: { x: number; y: number }) {
  const layer = drawLayer();
  if (!layer) return;
  const { w, h } = await loadSize(src);
  const id = uid(), el: El = { id: uid(), kind: 'bitmap', assetId: id, alpha: 1, tf: { ...ident(), px: w / 2, py: h / 2 } };
  const c = at ?? stageCentre();
  el.tf.x = c.x; el.tf.y = c.y;
  mutate(d => { d.assets[id] = { id, name, src, w, h }; kfForEdit(layer).els.push(el); }); // one undo step
  selectPlaced(el);
}
async function importImages() {
  if (!api) return toast('Importing needs the desktop app — or drop an image on the stage');
  for (const f of await api.openImages()) await addImage(f.name, f.dataUrl);
}
/** Put a new element on the current layer at `at` (edit space). */
export function placeEl(el: El, at?: { x: number; y: number }) {
  const layer = drawLayer();
  if (!layer) return;
  const c = at ?? stageCentre();
  el.tf.x = c.x; el.tf.y = c.y;
  mutate(() => kfForEdit(layer).els.push(el));
  selectPlaced(el);
}
const stageCentre = () => (S.ui.edit.length ? { x: 0, y: 0 } : { x: S.doc.w / 2, y: S.doc.h / 2 });
const selectPlaced = (el: El) => setUI({ sel: [el.id], tool: S.ui.tool === 'transform' ? 'transform' : 'select' });
export const symbolInstance = (symbolId: string): SymbolEl => ({ id: uid(), kind: 'symbol', symbolId, loop: 'loop', first: 0, alpha: 1, tf: ident() });

// ---------- edit ----------
let clip: El[] = [];
function copy() { clip = structuredClone(shownSel().map(s => s.el)); if (clip.length) toast(`Copied ${clip.length}`); }
function del() {
  if (deleteSubNode()) return;
  if (!S.ui.sel.length) return;
  mutate(() => { for (const { kf, el } of editSel()) kf.els = kf.els.filter(e => e !== el); });
  setUI({ sel: [] });
}
function paste(inPlace: boolean) {
  const layer = drawLayer();
  if (!layer || !clip.length) return;
  const els = cloneEls(clip);
  if (!inPlace) for (const e of els) { e.tf.x += 12; e.tf.y += 12; }
  mutate(() => kfForEdit(layer).els.push(...els));
  clip = structuredClone(els); // repeated pastes cascade
  setUI({ sel: els.map(e => e.id) });
}
function duplicate() { const keep = clip; copy(); paste(false); clip = keep; }
function selectAll() {
  const ids: string[] = [];
  for (const l of curTl().layers) if (l.visible && !l.locked) {
    const i = kfIndexAt(l, S.ui.frame);
    if (i >= 0) ids.push(...l.kfs[i].els.map(e => e.id));
  }
  setUI({ sel: ids });
}
function nudge(dx: number, dy: number) {
  if (!S.ui.sel.length) return;
  mutate(() => { for (const { el } of editSel()) { el.tf.x += dx; el.tf.y += dy; } });
}
function arrange(where: 'front' | 'forward' | 'backward' | 'back') {
  mutate(() => {
    const kfs = new Set(editSel().map(s => s.kf));
    for (const kf of kfs) {
      const pick = (e: El) => S.ui.sel.includes(e.id);
      const sel = kf.els.filter(pick), rest = kf.els.filter(e => !pick(e));
      if (where === 'front') kf.els = [...rest, ...sel];
      else if (where === 'back') kf.els = [...sel, ...rest];
      else {
        const els = kf.els, up = where === 'forward';
        for (let i = up ? els.length - 2 : 1; up ? i >= 0 : i < els.length; i += up ? -1 : 1) {
          const j = up ? i + 1 : i - 1;
          if (pick(els[i]) && !pick(els[j])) [els[i], els[j]] = [els[j], els[i]];
        }
      }
    }
  });
}
function flip(axis: 'sx' | 'sy') { mutate(() => { for (const { el } of editSel()) el.tf[axis] *= -1; }); }

// ---------- timeline ----------
/** Edit the current layer; if `fn` returns a frame number the playhead moves there. */
function layerOp(fn: (l: NonNullable<ReturnType<typeof curLayer>>) => number | void) {
  const l = curLayer();
  if (!l) return;
  if (l.locked) return toast(`"${l.name}" is locked`);
  stopPlay();
  mutate(() => { const to = fn(l); if (to !== undefined) S.ui.frame = to; });
}
/** F5 as in Animate: insert a frame after the playhead and step onto it (past the end: extend to the playhead). */
function addFrame(l: Layer) {
  const f = S.ui.frame, inside = f < layerLen(l);
  insertFrame(l, f);
  return inside ? f + 1 : f;
}
/** F6/F7 as in Animate: on an existing keyframe the new one goes on the next frame and the playhead follows. */
const addKey = (blank: boolean) => layerOp(l => {
  const f = S.ui.frame, i = kfIndexAt(l, f), to = i >= 0 && kfStart(l, i) === f ? f + 1 : f;
  insertKeyframe(l, to, blank);
  return to;
});
function createTween() {
  const l = curLayer(), i = l ? kfIndexAt(l, S.ui.frame) : -1;
  if (!l || i < 0) return toast('No keyframe span at the playhead');
  if (!l.kfs[i + 1]) return toast('A tween needs an end keyframe: move the playhead later and press F6');
  if (l.kfs[i].tween) return;
  mutate(() => { l.kfs[i].tween = newTween(); });
}
function removeTween() {
  const l = curLayer(), i = l ? kfIndexAt(l, S.ui.frame) : -1;
  if (l && i >= 0 && l.kfs[i].tween) mutate(() => { delete l.kfs[i].tween; });
}
function addLayer() {
  const tl = curTl(), at = Math.max(0, tl.layers.findIndex(l => l.id === S.ui.layerId));
  const l = newLayer(`Layer ${tl.layers.length + 1}`);
  mutate(() => tl.layers.splice(at, 0, l));
  setUI({ layerId: l.id });
}
export function deleteLayer(id = S.ui.layerId) {
  const tl = curTl();
  if (tl.layers.length <= 1) return toast('A timeline needs at least one layer');
  mutate(() => { tl.layers = tl.layers.filter(l => l.id !== id); });
}
export function setFrame(f: number) { stopPlay(); setUI({ frame: Math.max(0, f), sel: [] }); }

// ---------- symbols ----------
function convertToSymbol() {
  const r = unionRect(shownSel().map(s => parentBounds(S.doc, s.el, s.age)).filter((x): x is Rect => !!x));
  if (!r) return toast('Select something to convert');
  const c = { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
  const id = uid(), inst = symbolInstance(id);
  mutate(d => {
    const tl = curTl(), es = editSel();
    if (!es.length) return;
    es.sort((a, b) => tl.layers.indexOf(b.layer) - tl.layers.indexOf(a.layer)); // bottom layer first keeps stacking
    const layer = newLayer('Layer 1');
    for (const { kf, el } of es) {
      kf.els = kf.els.filter(e => e !== el);
      el.tf.x -= c.x; el.tf.y -= c.y;
      layer.kfs[0].els.push(el);
    }
    d.symbols[id] = { id, name: `Symbol ${Object.keys(d.symbols).length + 1}`, tl: { layers: [layer] } };
    inst.tf.x = c.x; inst.tf.y = c.y;
    kfForEdit(es.at(-1)!.layer).els.push(inst);
  });
  setUI({ sel: [inst.id] });
}
export function newSymbol() {
  const id = uid(), layer = newLayer('Layer 1');
  mutate(d => { d.symbols[id] = { id, name: `Symbol ${Object.keys(d.symbols).length + 1}`, tl: { layers: [layer] } }; });
  S.ui.edit.push({ symbolId: id, parentFrame: S.ui.frame, parentLayer: S.ui.layerId });
  setUI({ frame: 0, sel: [], layerId: layer.id });
}

// ---------- view ----------
export function fitView() {
  const { viewW: vw, viewH: vh } = S.ui, z = Math.min((vw - 64) / S.doc.w, (vh - 64) / S.doc.h, 4);
  setUI({ zoom: z, panX: (vw - S.doc.w * z) / 2, panY: (vh - S.doc.h * z) / 2 });
}
function zoom100() { const { viewW: vw, viewH: vh } = S.ui; setUI({ zoom: 1, panX: (vw - S.doc.w) / 2, panY: (vh - S.doc.h) / 2 }); }

// ---------- registry ----------
export const COMMANDS: Record<string, () => void> = {
  new: () => { if (confirmDiscard()) { loadDoc(newDoc(), null); fitView(); } },
  open: openFile, save: () => save(false), saveAs: () => save(true),
  import: importImages, export: () => { stopPlay(); setUI({ exportOpen: true }); },
  undo, redo, cut: () => { copy(); del(); }, copy, paste: () => paste(false), pasteInPlace: () => paste(true),
  duplicate, delete: del, selectAll, deselect: () => setUI({ sel: [] }),
  front: () => arrange('front'), forward: () => arrange('forward'), backward: () => arrange('backward'), back: () => arrange('back'),
  flipH: () => flip('sx'), flipV: () => flip('sy'),
  convertSymbol: convertToSymbol, newSymbol, exitSymbol: () => exitSymbol(), exitAll: () => exitSymbol(true),
  play: togglePlay, loop: () => setUI({ loop: !S.ui.loop }), onion: () => setUI({ onion: !S.ui.onion }),
  prevFrame: () => setFrame(S.ui.frame - 1), nextFrame: () => setFrame(S.ui.frame + 1),
  firstFrame: () => setFrame(0), lastFrame: () => setFrame(curLen() - 1),
  insertFrame: () => layerOp(addFrame),
  removeFrame: () => layerOp(l => removeFrame(l, S.ui.frame)),
  keyframe: () => addKey(false),
  blankKeyframe: () => addKey(true),
  clearKeyframe: () => layerOp(l => clearKeyframe(l, S.ui.frame)),
  createTween, removeTween, addLayer, deleteLayer: () => deleteLayer(),
  zoomIn: () => zoomAt(S.ui.viewW / 2, S.ui.viewH / 2, 1.25), zoomOut: () => zoomAt(S.ui.viewW / 2, S.ui.viewH / 2, 0.8),
  fit: fitView, zoom100, devtools: () => api?.toggleDevTools(),
};

const TOOL_KEYS: Record<string, ToolId> = { V: 'select', A: 'sub', Q: 'transform', P: 'pen', Y: 'pencil', B: 'brush', N: 'line', R: 'rect', O: 'oval', K: 'bucket', I: 'dropper', E: 'eraser', H: 'hand', Z: 'zoom' };
const KEYS: Record<string, string> = {
  'Ctrl+N': 'new', 'Ctrl+O': 'open', 'Ctrl+S': 'save', 'Ctrl+Shift+S': 'saveAs', 'Ctrl+R': 'import', 'Ctrl+Shift+E': 'export',
  'Ctrl+Z': 'undo', 'Ctrl+Shift+Z': 'redo', 'Ctrl+Y': 'redo', 'Ctrl+X': 'cut', 'Ctrl+C': 'copy', 'Ctrl+V': 'paste', 'Ctrl+Shift+V': 'pasteInPlace',
  'Ctrl+D': 'duplicate', 'Delete': 'delete', 'Backspace': 'delete', 'Ctrl+A': 'selectAll', 'Ctrl+Shift+A': 'deselect',
  'Ctrl+Shift+ArrowUp': 'front', 'Ctrl+ArrowUp': 'forward', 'Ctrl+ArrowDown': 'backward', 'Ctrl+Shift+ArrowDown': 'back',
  'F8': 'convertSymbol', 'Ctrl+F8': 'newSymbol', 'Ctrl+E': 'exitSymbol',
  'Enter': 'play', ',': 'prevFrame', '.': 'nextFrame', 'Home': 'firstFrame', 'End': 'lastFrame',
  'F5': 'insertFrame', 'Shift+F5': 'removeFrame', 'F6': 'keyframe', 'F7': 'blankKeyframe', 'Shift+F6': 'clearKeyframe',
  'Ctrl+=': 'zoomIn', 'Ctrl++': 'zoomIn', 'Ctrl+Shift++': 'zoomIn', 'Ctrl+-': 'zoomOut', 'Ctrl+0': 'fit', 'Ctrl+1': 'zoom100', 'F12': 'devtools', 'Ctrl+Shift+I': 'devtools',
};
export const keyOf = (cmd: string) => Object.keys(KEYS).find(k => KEYS[k] === cmd);
export const run = (cmd: string) => COMMANDS[cmd]?.();

// ---------- menus ----------
const it = (label: string, cmd: string): MenuItem => ({ label, cmd, key: keyOf(cmd) });
const SEP: MenuItem = { label: '', sep: true };
export const MENUS: Record<string, MenuItem[]> = {
  File: [it('New', 'new'), it('Open…', 'open'), SEP, it('Save', 'save'), it('Save As…', 'saveAs'), SEP, it('Import Image…', 'import'), it('Export…', 'export')],
  Edit: [it('Undo', 'undo'), it('Redo', 'redo'), SEP, it('Cut', 'cut'), it('Copy', 'copy'), it('Paste', 'paste'), it('Paste in Place', 'pasteInPlace'), it('Duplicate', 'duplicate'), it('Delete', 'delete'), SEP, it('Select All', 'selectAll'), it('Deselect All', 'deselect')],
  Modify: [it('Convert to Symbol', 'convertSymbol'), SEP, it('Bring to Front', 'front'), it('Bring Forward', 'forward'), it('Send Backward', 'backward'), it('Send to Back', 'back'), SEP, it('Flip Horizontal', 'flipH'), it('Flip Vertical', 'flipV')],
  Insert: [it('New Symbol', 'newSymbol'), it('New Layer', 'addLayer'), SEP, it('Frame', 'insertFrame'), it('Remove Frame', 'removeFrame'), it('Keyframe', 'keyframe'), it('Blank Keyframe', 'blankKeyframe'), it('Clear Keyframe', 'clearKeyframe'), SEP, it('Create Tween', 'createTween'), it('Remove Tween', 'removeTween')],
  Control: [it('Play / Stop', 'play'), it('Loop Playback', 'loop'), SEP, it('Previous Frame', 'prevFrame'), it('Next Frame', 'nextFrame'), it('First Frame', 'firstFrame'), it('Last Frame', 'lastFrame'), SEP, it('Onion Skin', 'onion')],
  View: [it('Zoom In', 'zoomIn'), it('Zoom Out', 'zoomOut'), it('Fit Stage', 'fit'), it('Actual Size', 'zoom100'), SEP, it('Exit Symbol', 'exitSymbol'), SEP, it('Developer Tools', 'devtools')],
};

// ---------- keyboard ----------
let spaceFrom: ToolId | null = null;
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
export function installKeys() {
  window.addEventListener('keydown', e => {
    if (typing(e.target) || S.ui.exportOpen) return;
    const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    if (k === ' ') { e.preventDefault(); if (!spaceFrom && !e.repeat) { spaceFrom = S.ui.tool; setUI({ tool: 'hand' }); } return; }
    if (k === 'Escape') { if (penPending()) penFinish(false); else if (S.ui.ctxMenu) setUI({ ctxMenu: null }); else setUI({ sel: [] }); return; }
    if (k === 'Enter' && penPending()) { penFinish(false); return; }
    const mods = (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '');
    if (!mods && TOOL_KEYS[k] && !e.repeat) { setTool(TOOL_KEYS[k]); return; }
    if (k.startsWith('Arrow') && (!mods || mods === 'Shift+')) {
      e.preventDefault();
      const s = mods ? 10 : 1, d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[k]!;
      nudge(d[0], d[1]);
      return;
    }
    const cmd = KEYS[mods + k];
    if (cmd) { e.preventDefault(); run(cmd); }
  });
  window.addEventListener('keyup', e => { if (e.key === ' ' && spaceFrom) { setUI({ tool: spaceFrom }); spaceFrom = null; } });
}
