// Stage tools. Points arrive in "edit space" (the coordinate space of the timeline being edited).
import { getStroke } from 'perfect-freehand';
import { frameEls, ident, uid, type BNode, type El, type Layer, type Path, type Pt, type ShapeEl, type SymbolEl, type TextEl, type Transform } from './core/model.ts';
import { ellipsePath, linePath, node, rdp, recenter, rectPath, rectsHit, smoothPath, tracePath, unionRect, type Rect } from './core/geom.ts';
import { corners, hitEl, localBounds, parentBounds, tfMatrix } from './render.ts';
import { S, curTl, drawLayer, editSel, kfForEdit, mutate, redraw, setUI, shownSel, toast, type ToolId } from './store.ts';

export type PEvt = { p: Pt; sx: number; sy: number; shift: boolean; alt: boolean; pressure: number; pen: boolean; dbl: boolean };
type Tool = {
  down?(e: PEvt): void; move?(e: PEvt, pressed: boolean): void; up?(e: PEvt): void;
  overlay?(ctx: CanvasRenderingContext2D): void; cursor?(e: PEvt): string;
};

const ACCENT = '#8b7cf6';
export const baseM = () => (S.ui.edit.length ? new DOMMatrix().translate(S.doc.w / 2, S.doc.h / 2) : new DOMMatrix());
/** edit space -> screen (CSS px inside the stage canvas) */
export const viewM = () => new DOMMatrix([S.ui.zoom, 0, 0, S.ui.zoom, S.ui.panX, S.ui.panY]).multiply(baseM());
const tol = () => 5 / S.ui.zoom;
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const screenDist = (a: Pt, b: Pt) => dist(a, b) * S.ui.zoom;

export function zoomAt(sx: number, sy: number, factor: number) {
  const z = S.ui.zoom, nz = Math.min(32, Math.max(0.05, z * factor));
  setUI({ zoom: nz, panX: sx - (sx - S.ui.panX) * (nz / z), panY: sy - (sy - S.ui.panY) * (nz / z) });
}

type Hit = { layer: Layer; el: El; age: number };
/** Topmost element under p across visible, unlocked layers. */
export function hitTop(p: Pt, filter?: (el: El) => boolean): Hit | null {
  for (const layer of curTl().layers) {
    if (!layer.visible || layer.locked) continue;
    const { els, start } = frameEls(layer, S.ui.frame);
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if ((!filter || filter(el)) && hitEl(S.doc, el, S.ui.frame - start, p, tol())) return { layer, el, age: S.ui.frame - start };
    }
  }
  return null;
}

export function enterSymbol(el: SymbolEl) {
  const sym = S.doc.symbols[el.symbolId];
  if (!sym) return;
  S.ui.edit.push({ symbolId: sym.id, parentFrame: S.ui.frame, parentLayer: S.ui.layerId });
  setUI({ frame: 0, sel: [], layerId: sym.tl.layers[0]?.id ?? '' });
}
export function exitSymbol(all = false) {
  let e;
  while ((e = S.ui.edit.pop())) { S.ui.frame = e.parentFrame; S.ui.layerId = e.parentLayer; if (!all) break; }
  setUI({ sel: [] });
}

function commitShape(path: Path, fill: string | null, stroke: string | null, sw: number) {
  const layer = drawLayer();
  if (!layer || path.nodes.length < 2) return;
  if (!fill && !stroke) { toast('Pick a fill or stroke colour first'); return; }
  const c = recenter(path);
  const el: ShapeEl = { id: uid(), kind: 'shape', tf: ident(c.x, c.y), alpha: 1, path, fill, stroke, sw };
  mutate(() => kfForEdit(layer).els.push(el)); // one stroke = one undo step
}

// ---------- overlay helpers (screen space) ----------
function poly(ctx: CanvasRenderingContext2D, pts: Pt[], color = ACCENT, dash: number[] = []) {
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath();
  ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
}
function box(ctx: CanvasRenderingContext2D, p: Pt, size = 7, fill = '#fff') {
  ctx.fillStyle = fill; ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.25;
  ctx.fillRect(p.x - size / 2, p.y - size / 2, size, size); ctx.strokeRect(p.x - size / 2, p.y - size / 2, size, size);
}
function dot(ctx: CanvasRenderingContext2D, p: Pt, r = 4, fill = '#fff') {
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = ACCENT; ctx.lineWidth = 1.25; ctx.stroke();
}
function previewPath(ctx: CanvasRenderingContext2D, path: Path, fill: string | null, stroke: string | null, sw: number) {
  const vm = viewM();
  ctx.save(); ctx.setTransform(new DOMMatrix([devicePixelRatio, 0, 0, devicePixelRatio, 0, 0]).multiply(vm));
  const p = new Path2D(); tracePath(p, path);
  if (fill && path.closed) { ctx.fillStyle = fill; ctx.fill(p); }
  if (stroke && sw > 0) { ctx.strokeStyle = stroke; ctx.lineWidth = sw; ctx.lineCap = ctx.lineJoin = 'round'; ctx.stroke(p); }
  ctx.restore();
}
/** Oriented selection boxes for every selected element. */
export function drawSelection(ctx: CanvasRenderingContext2D) {
  const vm = viewM();
  for (const { el, age } of shownSel()) {
    const r = localBounds(S.doc, el, age);
    if (r) poly(ctx, corners(r, vm.multiply(tfMatrix(el.tf))));
  }
}
function selRect(): Rect | null {
  return unionRect(shownSel().map(s => parentBounds(S.doc, s.el, s.age)).filter((r): r is Rect => !!r));
}

// ---------- select ----------
const sel = {
  mode: '' as '' | 'move' | 'marquee', start: { x: 0, y: 0 }, cur: { x: 0, y: 0 }, first: true,
  orig: new Map<string, Pt>(), box: null as Rect | null, guides: { x: null as number | null, y: null as number | null },
};
/** Snap a moved box's edges/centre to the stage's edges/centre (edit space). Returns the corrected delta + guide lines. */
function snapMove(b: Rect, dx: number, dy: number, lockX: boolean, lockY: boolean) {
  const o = S.ui.edit.length ? -0.5 : 0, th = 6 / S.ui.zoom;
  const axis = (start: number, size: number, stage: number, d: number) => {
    let best: { d: number; at: number } | null = null;
    for (const t of [o * stage, (o + 0.5) * stage, (o + 1) * stage]) for (const f of [0, 0.5, 1]) {
      const diff = t - (start + f * size + d);
      if (Math.abs(diff) < th && (!best || Math.abs(diff) < Math.abs(best.d - d))) best = { d: d + diff, at: t };
    }
    return best;
  };
  const sx = lockX ? null : axis(b.x, b.w, S.doc.w, dx), sy = lockY ? null : axis(b.y, b.h, S.doc.h, dy);
  return { dx: sx?.d ?? dx, dy: sy?.d ?? dy, guides: { x: sx?.at ?? null, y: sy?.at ?? null } };
}
const selectTool: Tool = {
  down(e) {
    const hit = hitTop(e.p);
    if (e.dbl) {
      if (hit?.el.kind === 'symbol') enterSymbol(hit.el);
      else if (hit?.el.kind === 'text') editText(hit);
      else if (!hit && S.ui.edit.length) exitSymbol();
      return;
    }
    sel.start = sel.cur = e.p; sel.first = true;
    if (hit) {
      let ids = S.ui.sel;
      if (e.shift) ids = ids.includes(hit.el.id) ? ids.filter(i => i !== hit.el.id) : [...ids, hit.el.id];
      else if (!ids.includes(hit.el.id)) ids = [hit.el.id];
      setUI({ sel: ids, layerId: hit.layer.id });
      sel.mode = ids.includes(hit.el.id) ? 'move' : '';
    } else {
      if (!e.shift) setUI({ sel: [] });
      sel.mode = 'marquee';
    }
  },
  move(e, pressed) {
    if (!pressed || !sel.mode) return;
    sel.cur = e.p;
    if (sel.mode === 'marquee') { redraw(); return; }
    let dx = e.p.x - sel.start.x, dy = e.p.y - sel.start.y;
    if (sel.first && screenDist(e.p, sel.start) < 3) return;
    const lockY = e.shift && Math.abs(dx) > Math.abs(dy), lockX = e.shift && !lockY;
    if (lockY) dy = 0; else if (lockX) dx = 0;
    if (sel.first) sel.box = selRect();
    if (S.ui.snap && sel.box) ({ dx, dy, guides: sel.guides } = snapMove(sel.box, dx, dy, lockX, lockY));
    mutate(() => {
      const es = editSel();
      if (sel.first) sel.orig = new Map(es.map(s => [s.el.id, { x: s.el.tf.x, y: s.el.tf.y }]));
      for (const { el } of es) { const o = sel.orig.get(el.id); if (o) { el.tf.x = o.x + dx; el.tf.y = o.y + dy; } }
    }, sel.first);
    sel.first = false;
  },
  up(e) {
    if (sel.mode === 'marquee' && screenDist(sel.start, sel.cur) > 2) {
      const r = { x: Math.min(sel.start.x, sel.cur.x), y: Math.min(sel.start.y, sel.cur.y), w: Math.abs(sel.cur.x - sel.start.x), h: Math.abs(sel.cur.y - sel.start.y) };
      const ids = new Set(e.shift ? S.ui.sel : []);
      for (const layer of curTl().layers) {
        if (!layer.visible || layer.locked) continue;
        const { els, start } = frameEls(layer, S.ui.frame);
        for (const el of els) { const b = parentBounds(S.doc, el, S.ui.frame - start); if (b && rectsHit(b, r)) ids.add(el.id); }
      }
      setUI({ sel: [...ids] });
    }
    sel.mode = ''; sel.guides = { x: null, y: null };
    redraw();
  },
  overlay(ctx) {
    drawSelection(ctx);
    const vm = viewM(), { x: gx, y: gy } = sel.guides;
    if (sel.mode === 'move' && (gx !== null || gy !== null)) {
      ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 1; ctx.beginPath();
      if (gx !== null) { const sx = Math.round(vm.transformPoint({ x: gx, y: 0 }).x) + 0.5; ctx.moveTo(sx, 0); ctx.lineTo(sx, S.ui.viewH); }
      if (gy !== null) { const sy = Math.round(vm.transformPoint({ x: 0, y: gy }).y) + 0.5; ctx.moveTo(0, sy); ctx.lineTo(S.ui.viewW, sy); }
      ctx.stroke();
    }
    if (sel.mode === 'marquee') {
      const vm = viewM(), a = vm.transformPoint(sel.start), b = vm.transformPoint(sel.cur);
      ctx.fillStyle = 'rgb(139 124 246 / 0.12)'; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      poly(ctx, [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }], ACCENT, [4, 3]);
    }
  },
};

// ---------- free transform ----------
type Handle = { u: number; v: number; at: Pt }; // u/v in {0,.5,1} across the box
const HANDLE_UV = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
const ft = {
  mode: '' as '' | 'scale' | 'rotate' | 'pivot' | 'select', first: true, h: null as Handle | null, start: { x: 0, y: 0 },
  orig: [] as { id: string; tf: Transform }[], r: null as Rect | null,
};
/** Box being transformed: single element -> its local bounds + matrix; several -> union box in edit space. */
function ftBox(): { r: Rect; m: DOMMatrix; single: El | null } | null {
  const ss = shownSel();
  if (ss.length === 1) {
    const r = localBounds(S.doc, ss[0].el, ss[0].age);
    return r ? { r, m: tfMatrix(ss[0].el.tf), single: ss[0].el } : null;
  }
  const r = selRect();
  return r ? { r, m: new DOMMatrix(), single: null } : null;
}
const uvPoint = (r: Rect, u: number, v: number) => ({ x: r.x + u * r.w, y: r.y + v * r.h });
function ftZone(e: PEvt): { mode: typeof ft.mode; h?: Handle } {
  const b = ftBox();
  if (!b) return { mode: 'select' };
  const vm = viewM().multiply(b.m), s = { x: e.sx, y: e.sy };
  if (b.single) {
    const pv = vm.transformPoint({ x: b.single.tf.px, y: b.single.tf.py });
    if (dist(pv, s) < 8) return { mode: 'pivot' };
  }
  for (const [u, v] of HANDLE_UV) {
    const at = vm.transformPoint(uvPoint(b.r, u, v));
    if (dist(at, s) < 7) return { mode: 'scale', h: { u, v, at: uvPoint(b.r, u, v) } };
  }
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) if (dist(vm.transformPoint(uvPoint(b.r, u, v)), s) < 22) return { mode: 'rotate' };
  return { mode: 'select' };
}
const transformTool: Tool = {
  down(e) {
    const z = S.ui.sel.length ? ftZone(e) : { mode: 'select' as const };
    ft.mode = z.mode; ft.h = z.h ?? null; ft.first = true; ft.start = e.p;
    if (ft.mode === 'select') { selectTool.down!(e); return; }
    ft.orig = shownSel().map(s => ({ id: s.el.id, tf: { ...s.el.tf } }));
    ft.r = ftBox()?.r ?? null;
  },
  move(e, pressed) {
    if (!pressed) return;
    if (ft.mode === 'select') { selectTool.move!(e, pressed); return; }
    if (!ft.mode || !ft.r) return;
    const r = ft.r, single = ft.orig.length === 1;
    mutate(() => {
      const es = editSel();
      for (const { el } of es) {
        const o = ft.orig.find(x => x.id === el.id)?.tf;
        if (!o) continue;
        if (single) Object.assign(el.tf, singleTransform(o, r, e));
        else Object.assign(el.tf, groupTransform(o, r, e));
      }
    }, ft.first);
    ft.first = false;
  },
  up(e) { if (ft.mode === 'select') selectTool.up!(e); ft.mode = ''; },
  overlay(ctx) {
    selectTool.overlay!(ctx);
    const b = ftBox();
    if (!b) return;
    const vm = viewM().multiply(b.m);
    poly(ctx, corners(b.r, vm));
    for (const [u, v] of HANDLE_UV) box(ctx, vm.transformPoint(uvPoint(b.r, u, v)));
    const pv = b.single ? vm.transformPoint({ x: b.single.tf.px, y: b.single.tf.py }) : vm.transformPoint(uvPoint(b.r, 0.5, 0.5));
    dot(ctx, pv, 4.5);
  },
  cursor(e) {
    if (!S.ui.sel.length) return 'default';
    const z = ftZone(e);
    return z.mode === 'pivot' ? 'move' : z.mode === 'rotate' ? 'grab' : z.mode === 'scale' ? (z.h!.u === 0.5 ? 'ns-resize' : z.h!.v === 0.5 ? 'ew-resize' : 'nwse-resize') : 'default';
  },
};
function singleTransform(o: Transform, r: Rect, e: PEvt): Partial<Transform> {
  const p = e.p;
  if (ft.mode === 'pivot') {
    const lp = tfMatrix(o).inverse().transformPoint(p);
    return { px: lp.x, py: lp.y, x: p.x, y: p.y };
  }
  if (ft.mode === 'rotate') {
    const a0 = Math.atan2(ft.start.y - o.y, ft.start.x - o.x), a1 = Math.atan2(p.y - o.y, p.x - o.x);
    let rr = o.r + ((a1 - a0) * 180) / Math.PI;
    if (e.shift) rr = Math.round(rr / S.ui.rotSnap) * S.ui.rotSnap;
    return { r: rr };
  }
  // scale: work in the element's rotated frame where local L maps to S·(L - pivot)
  const h = ft.h!, q = new DOMMatrix().translate(o.x, o.y).rotate(o.r).inverse().transformPoint(p);
  const H = uvPoint(r, h.u, h.v), A = e.alt ? { x: o.px, y: o.py } : uvPoint(r, 1 - h.u, 1 - h.v);
  const axis = (qv: number, Hv: number, Av: number, pv: number, s0: number, active: boolean) =>
    active && Math.abs(Hv - Av) > 1e-9 ? (qv - s0 * (Av - pv)) / (Hv - Av) : s0;
  let sx = axis(q.x, H.x, A.x, o.px, o.sx, h.u !== 0.5), sy = axis(q.y, H.y, A.y, o.py, o.sy, h.v !== 0.5);
  if (e.shift && h.u !== 0.5 && h.v !== 0.5) {
    const k = Math.abs(sx / o.sx) > Math.abs(sy / o.sy) ? sx / o.sx : sy / o.sy;
    sx = o.sx * k; sy = o.sy * k;
  }
  const dx = o.sx * (A.x - o.px) - sx * (A.x - o.px), dy = o.sy * (A.y - o.py) - sy * (A.y - o.py);
  const d = new DOMMatrix().rotate(o.r).transformPoint({ x: dx, y: dy });
  return { sx, sy, x: o.x + d.x, y: o.y + d.y };
}
function groupTransform(o: Transform, r: Rect, e: PEvt): Partial<Transform> {
  const p = e.p, c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  if (ft.mode === 'rotate') {
    let d = Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(ft.start.y - c.y, ft.start.x - c.x);
    if (e.shift) { const st = (S.ui.rotSnap * Math.PI) / 180; d = Math.round(d / st) * st; }
    const q = new DOMMatrix().translate(c.x, c.y).rotate((d * 180) / Math.PI).translate(-c.x, -c.y).transformPoint({ x: o.x, y: o.y });
    return { x: q.x, y: q.y, r: o.r + (d * 180) / Math.PI };
  }
  if (ft.mode !== 'scale') return {};
  const h = ft.h!, H = uvPoint(r, h.u, h.v), A = e.alt ? c : uvPoint(r, 1 - h.u, 1 - h.v);
  let kx = h.u !== 0.5 && H.x !== A.x ? (p.x - A.x) / (H.x - A.x) : 1;
  let ky = h.v !== 0.5 && H.y !== A.y ? (p.y - A.y) / (H.y - A.y) : 1;
  if (e.shift && h.u !== 0.5 && h.v !== 0.5) kx = ky = Math.abs(kx) > Math.abs(ky) ? kx : ky;
  return { x: A.x + (o.x - A.x) * kx, y: A.y + (o.y - A.y) * ky, sx: o.sx * kx, sy: o.sy * ky };
}

// ---------- subselection (bezier node editing) ----------
export const sub = { node: -1, drag: '' as '' | 'anchor' | 'in' | 'out', first: true };
function subTarget(): ShapeEl | null { const s = shownSel(); return s.length === 1 && s[0].el.kind === 'shape' ? (s[0].el as ShapeEl) : null; }
const subTool: Tool = {
  down(e) {
    const t = subTarget();
    if (t) {
      const m = viewM().multiply(tfMatrix(t.tf)), s = { x: e.sx, y: e.sy };
      for (let i = 0; i < t.path.nodes.length; i++) {
        const n = t.path.nodes[i];
        const near = (dx: number, dy: number) => dist(m.transformPoint({ x: n.x + dx, y: n.y + dy }), s) < 6;
        const kind = near(0, 0) ? 'anchor' : i === sub.node && near(n.ox, n.oy) && (n.ox || n.oy) ? 'out' : i === sub.node && near(n.ix, n.iy) && (n.ix || n.iy) ? 'in' : '';
        if (!kind) continue;
        sub.node = i; sub.drag = kind; sub.first = true;
        if (kind === 'anchor' && e.alt) { toggleSmooth(t.id, i); sub.drag = ''; }
        redraw();
        return;
      }
    }
    const hit = hitTop(e.p, el => el.kind === 'shape');
    sub.node = -1; sub.drag = '';
    setUI(hit ? { sel: [hit.el.id], layerId: hit.layer.id } : { sel: [] });
  },
  move(e, pressed) {
    if (!pressed || !sub.drag) return;
    mutate(() => {
      const el = editSel().find(s => s.el.kind === 'shape')?.el as ShapeEl | undefined;
      const n = el?.path.nodes[sub.node];
      if (!el || !n) return;
      const q = tfMatrix(el.tf).inverse().transformPoint(e.p);
      if (sub.drag === 'anchor') { n.x = q.x; n.y = q.y; return; }
      const [hx, hy] = [q.x - n.x, q.y - n.y];
      const other = sub.drag === 'out' ? ['ix', 'iy'] as const : ['ox', 'oy'] as const;
      const len = Math.hypot(n[other[0]], n[other[1]]), hl = Math.hypot(hx, hy) || 1;
      if (sub.drag === 'out') { n.ox = hx; n.oy = hy; } else { n.ix = hx; n.iy = hy; }
      if (!e.alt && len) { n[other[0]] = (-hx / hl) * len; n[other[1]] = (-hy / hl) * len; } // keep the node smooth
    }, sub.first);
    sub.first = false;
  },
  up() { sub.drag = ''; },
  overlay(ctx) {
    const t = subTarget();
    if (!t) return;
    const m = viewM().multiply(tfMatrix(t.tf));
    const path = new Path2D(); tracePath(path, t.path);
    ctx.save(); ctx.setTransform(new DOMMatrix([devicePixelRatio, 0, 0, devicePixelRatio, 0, 0]).multiply(m));
    ctx.restore();
    // outline drawn in screen space for a crisp 1px line
    const pts = (n: BNode, dx: number, dy: number) => m.transformPoint({ x: n.x + dx, y: n.y + dy });
    ctx.beginPath();
    const ns = t.path.nodes;
    ns.forEach((n, i) => {
      const a = pts(n, 0, 0);
      if (!i) { ctx.moveTo(a.x, a.y); return; }
      const p = ns[i - 1], c1 = pts(p, p.ox, p.oy), c2 = pts(n, n.ix, n.iy);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, a.x, a.y);
    });
    if (t.path.closed && ns.length) { const p = ns.at(-1)!, n = ns[0], c1 = pts(p, p.ox, p.oy), c2 = pts(n, n.ix, n.iy), a = pts(n, 0, 0); ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, a.x, a.y); }
    ctx.strokeStyle = ACCENT; ctx.lineWidth = 1; ctx.stroke();
    ns.forEach((n, i) => {
      const a = pts(n, 0, 0);
      if (i === sub.node) for (const [dx, dy] of [[n.ix, n.iy], [n.ox, n.oy]]) {
        if (!dx && !dy) continue;
        const h = pts(n, dx, dy);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(h.x, h.y); ctx.strokeStyle = ACCENT; ctx.stroke(); dot(ctx, h, 3);
      }
      box(ctx, a, 6, i === sub.node ? ACCENT : '#fff');
    });
  },
};
function toggleSmooth(id: string, i: number) {
  mutate(() => {
    const el = editSel().find(s => s.el.id === id)?.el as ShapeEl | undefined;
    const ns = el?.path.nodes, n = ns?.[i];
    if (!ns || !n) return;
    if (n.ix || n.iy || n.ox || n.oy) { n.ix = n.iy = n.ox = n.oy = 0; return; }
    const N = ns.length, prev = ns[el.path.closed ? (i - 1 + N) % N : Math.max(0, i - 1)], next = ns[el.path.closed ? (i + 1) % N : Math.min(N - 1, i + 1)];
    const tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6;
    n.ix = -tx; n.iy = -ty; n.ox = tx; n.oy = ty;
  });
}
/** Delete the active subselection node. Returns true if it handled the key. */
export function deleteSubNode() {
  const t = subTarget();
  if (S.ui.tool !== 'sub' || !t || sub.node < 0) return false;
  if (t.path.nodes.length <= 2) { toast('A path needs at least 2 points'); return true; }
  mutate(() => { const el = editSel().find(s => s.el.id === t.id)?.el as ShapeEl | undefined; el?.path.nodes.splice(sub.node, 1); });
  sub.node = -1;
  return true;
}

// ---------- pen ----------
const pen = { nodes: [] as BNode[], dragging: false, mouse: null as Pt | null };
export function penFinish(closed = false) {
  if (pen.nodes.length >= 2) commitShape({ nodes: pen.nodes, closed }, closed ? S.ui.fill : null, S.ui.stroke ?? S.ui.fill, S.ui.sw);
  pen.nodes = []; pen.dragging = false; redraw();
}
export const penPending = () => pen.nodes.length > 0;
const penTool: Tool = {
  down(e) {
    if (pen.nodes.length >= 3 && screenDist(e.p, pen.nodes[0]) < 8) { penFinish(true); return; }
    if (e.dbl) { pen.nodes.pop(); penFinish(false); return; } // dblclick added a duplicate point on its 2nd down
    pen.nodes.push(node(e.p.x, e.p.y)); pen.dragging = true; redraw();
  },
  move(e, pressed) {
    pen.mouse = e.p;
    const n = pen.nodes.at(-1);
    if (pressed && pen.dragging && n) { n.ox = e.p.x - n.x; n.oy = e.p.y - n.y; n.ix = -n.ox; n.iy = -n.oy; }
    redraw();
  },
  up() { pen.dragging = false; },
  overlay(ctx) {
    if (!pen.nodes.length) return;
    const nodes = pen.nodes.slice();
    if (pen.mouse && !pen.dragging) nodes.push(node(pen.mouse.x, pen.mouse.y));
    previewPath(ctx, { nodes, closed: false }, null, S.ui.stroke ?? S.ui.fill ?? ACCENT, S.ui.sw);
    const vm = viewM();
    pen.nodes.forEach((n, i) => box(ctx, vm.transformPoint(n), i === 0 && pen.mouse && pen.nodes.length >= 3 && screenDist(pen.mouse, n) < 8 ? 9 : 6));
  },
};

// ---------- pencil + brush ----------
const free = { pts: [] as number[][], active: false };
/** Smoothing, applied once the stroke ends: drop jitter points closer than a few screen px to the
 *  last kept one, then a centred moving average over ±k points (window shrinks at the ends so they stay put). */
const smoothStroke = (pts: number[][]) => {
  const { smoothing, zoom } = S.ui, gap = (1 + smoothing * 4) / zoom, k = Math.round(smoothing * 10), q: number[][] = [];
  for (const p of pts) { const l = q.at(-1); if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) >= gap) q.push(p); }
  return q.map((p, i) => {
    const r = Math.min(k, i, q.length - 1 - i);
    let x = 0, y = 0;
    for (let j = i - r; j <= i + r; j++) { x += q[j][0]; y += q[j][1]; }
    return [x / (2 * r + 1), y / (2 * r + 1), p[2]];
  });
};
const brushOutline = (pts: number[][], last: boolean) => {
  const { brush, thinning, pressure } = S.ui;
  return getStroke(pressure ? pts : pts.map(([x, y]) => [x, y, 0.5]), {
    size: brush, thinning: pressure ? thinning : 0, smoothing: 0.5, streamline: 0.2,
    simulatePressure: pressure && !pts.some(p => p[2] !== 0.5), last,
  });
};
const freeTool = (brush: boolean): Tool => ({
  down(e) { if (!drawLayer()) return; free.active = true; free.pts = [[e.p.x, e.p.y, e.pen ? e.pressure : 0.5]]; },
  move(e, pressed) {
    if (!pressed || !free.active) return;
    free.pts.push([e.p.x, e.p.y, e.pen ? e.pressure : 0.5]); redraw();
  },
  up() {
    if (!free.active) return;
    free.active = false;
    if (brush) {
      const outline = brushOutline(smoothStroke(free.pts), true).map(([x, y]) => ({ x, y }));
      if (outline.length > 2) commitShape(smoothPath(rdp(outline, 0.35 / S.ui.zoom), true, 0.6), S.ui.fill ?? S.ui.stroke, null, 0);
    } else {
      const pts = rdp(free.pts.map(([x, y]) => ({ x, y })), (0.2 + S.ui.smoothing * 4) / S.ui.zoom);
      if (pts.length >= 2 && (pts.length > 2 || dist(pts[0], pts[1]) > 0)) commitShape(smoothPath(pts, false), null, S.ui.stroke ?? S.ui.fill, S.ui.sw);
    }
    free.pts = []; redraw();
  },
  overlay(ctx) {
    if (!free.active || free.pts.length < 2) return;
    if (brush) {
      const o = brushOutline(free.pts, false).map(([x, y]) => ({ x, y }));
      if (o.length > 2) previewPath(ctx, { nodes: o.map(p => node(p.x, p.y)), closed: true }, S.ui.fill ?? S.ui.stroke, null, 0);
    } else previewPath(ctx, { nodes: free.pts.map(([x, y]) => node(x, y)), closed: false }, null, S.ui.stroke ?? S.ui.fill, S.ui.sw);
  },
});

// ---------- line / rect / oval ----------
const drag = { a: null as Pt | null, b: { x: 0, y: 0 }, shift: false, alt: false };
function dragPath(kind: 'line' | 'rect' | 'oval'): Path | null {
  const a = drag.a;
  if (!a) return null;
  let { x: bx, y: by } = drag.b;
  if (kind === 'line') {
    if (drag.shift) { // snap to 45°
      const ang = Math.round(Math.atan2(by - a.y, bx - a.x) / (Math.PI / 4)) * (Math.PI / 4), l = dist(a, drag.b);
      bx = a.x + Math.cos(ang) * l; by = a.y + Math.sin(ang) * l;
    }
    return linePath(a, { x: bx, y: by });
  }
  let w = bx - a.x, h = by - a.y;
  if (drag.shift) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
  let x0 = a.x, y0 = a.y;
  if (drag.alt) { x0 -= w; y0 -= h; w *= 2; h *= 2; }
  const x = Math.min(x0, x0 + w), y = Math.min(y0, y0 + h);
  return kind === 'rect' ? rectPath(x, y, Math.abs(w), Math.abs(h), S.ui.radius) : ellipsePath(x + Math.abs(w) / 2, y + Math.abs(h) / 2, Math.abs(w) / 2, Math.abs(h) / 2);
}
const shapeTool = (kind: 'line' | 'rect' | 'oval'): Tool => {
  const style = () => (kind === 'line' ? [null, S.ui.stroke ?? S.ui.fill] : [S.ui.fill, S.ui.stroke]) as [string | null, string | null];
  return {
    down(e) { if (drawLayer()) { drag.a = e.p; drag.b = e.p; } },
    move(e, pressed) { if (pressed && drag.a) { drag.b = e.p; drag.shift = e.shift; drag.alt = e.alt; redraw(); } },
    up() {
      const p = dragPath(kind), a = drag.a;
      drag.a = null;
      if (p && a && screenDist(a, drag.b) > 2) commitShape(p, ...style(), S.ui.sw);
      redraw();
    },
    overlay(ctx) { const p = dragPath(kind); if (p) previewPath(ctx, p, ...style(), S.ui.sw); },
  };
};

// ---------- bucket / dropper / eraser / hand / zoom ----------
const bucketTool: Tool = {
  down(e) {
    const hit = hitTop(e.p, el => el.kind === 'shape');
    if (!hit) return;
    const s = hit.el as ShapeEl;
    if (!e.shift && !s.path.closed) { toast('Open path — close it to fill (Shift+click sets stroke)'); return; }
    mutate(() => {
      const el = kfForEdit(hit.layer).els.find(x => x.id === s.id) as ShapeEl | undefined;
      if (!el) return;
      if (e.shift) { el.stroke = S.ui.stroke; if (!el.sw) el.sw = S.ui.sw; } else el.fill = S.ui.fill;
    });
  },
};
const dropperTool: Tool = {
  down(e) {
    const hit = hitTop(e.p, el => el.kind === 'shape');
    if (hit) { const s = hit.el as ShapeEl; setUI({ fill: s.fill, stroke: s.stroke, sw: s.sw || S.ui.sw }); }
  },
};
const er = { first: true, at: null as Pt | null };
/** Remove every element the eraser circle touches. */
function eraseAt(p: Pt) {
  const r = S.ui.eraser / S.ui.zoom, hits: { layer: Layer; id: string }[] = [];
  for (const layer of curTl().layers) {
    if (!layer.visible || layer.locked) continue;
    const { els, start } = frameEls(layer, S.ui.frame);
    for (const el of els) if (hitEl(S.doc, el, S.ui.frame - start, p, r)) hits.push({ layer, id: el.id });
  }
  if (!hits.length) return;
  mutate(() => { for (const h of hits) { const kf = kfForEdit(h.layer); kf.els = kf.els.filter(x => x.id !== h.id); } }, er.first);
  er.first = false; // whole drag = one undo step
}
// ponytail: object eraser (removes whole shapes); a vector boolean eraser needs path clipping (e.g. paper.js)
const eraserTool: Tool = {
  down(e) { er.first = true; eraseAt(e.p); },
  move(e, pressed) { er.at = e.p; if (pressed) eraseAt(e.p); redraw(); },
  overlay(ctx) {
    if (!er.at) return;
    const p = viewM().transformPoint(er.at);
    ctx.beginPath(); ctx.arc(p.x, p.y, S.ui.eraser, 0, Math.PI * 2); ctx.strokeStyle = '#fafafa'; ctx.lineWidth = 1.5; ctx.stroke();
  },
  cursor: () => 'none',
};
const hand = { sx: 0, sy: 0, px: 0, py: 0 };
export const handTool: Tool = {
  down(e) { Object.assign(hand, { sx: e.sx, sy: e.sy, px: S.ui.panX, py: S.ui.panY }); },
  move(e, pressed) { if (pressed) setUI({ panX: hand.px + e.sx - hand.sx, panY: hand.py + e.sy - hand.sy }); },
  cursor: () => 'grab',
};
// ---------- text ----------
const editText = (h: Hit) => setUI({ sel: [h.el.id], layerId: h.layer.id, textEdit: { id: h.el.id, x: 0, y: 0 } });
const textTool: Tool = {
  down(e) {
    const hit = hitTop(e.p, el => el.kind === 'text');
    if (hit) editText(hit);
    else if (drawLayer()) setUI({ sel: [], textEdit: { id: null, x: e.p.x, y: e.p.y } });
  },
  cursor: () => 'text',
};
/** Close the text editor, writing `text` back (empty text deletes the element / places nothing). */
export function commitText(text: string) {
  const te = S.ui.textEdit;
  if (!te) return;
  setUI({ textEdit: null });
  const empty = !text.trim();
  if (te.id) {
    const cur = shownSel().find(s => s.el.id === te.id)?.el;
    if (cur?.kind !== 'text' || cur.text === text) return;
    mutate(() => {
      for (const { kf, el } of editSel()) if (el.id === te.id && el.kind === 'text') { if (empty) kf.els = kf.els.filter(x => x !== el); else el.text = text; }
    });
  } else if (!empty) {
    const layer = drawLayer();
    if (!layer) return;
    const el: TextEl = { id: uid(), kind: 'text', tf: ident(te.x, te.y), alpha: 1, text, fill: S.ui.fill ?? '#000000ff', ...S.ui.textStyle };
    mutate(() => kfForEdit(layer).els.push(el));
    setUI({ sel: [el.id] });
  }
}

const zoomTool: Tool = { down(e) { zoomAt(e.sx, e.sy, e.alt ? 0.5 : 2); }, cursor: () => 'zoom-in' };

export const TOOLS: Record<ToolId, Tool> = {
  select: selectTool, transform: transformTool, sub: subTool, pen: penTool, pencil: freeTool(false), brush: freeTool(true),
  line: shapeTool('line'), rect: shapeTool('rect'), oval: shapeTool('oval'),
  bucket: bucketTool, dropper: dropperTool, eraser: eraserTool, hand: handTool, zoom: zoomTool, text: textTool,
};
export const DEFAULT_CURSOR: Partial<Record<ToolId, string>> = {
  pen: 'crosshair', pencil: 'crosshair', brush: 'crosshair', line: 'crosshair', rect: 'crosshair', oval: 'crosshair', bucket: 'cell', dropper: 'copy',
};
export function setTool(t: ToolId) {
  if (S.ui.tool === 'pen' && t !== 'pen') penFinish(false);
  sub.node = -1;
  setUI({ tool: t });
}
export const isSymbol = (el: El): el is SymbolEl => el.kind === 'symbol';
