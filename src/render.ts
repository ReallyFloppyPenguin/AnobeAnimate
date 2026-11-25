// Canvas rendering, hit testing and bounds. Shared by the stage, library thumbnails and export.
import { LINE_H, fontCss, frameEls, instFrame, tlLen, type Doc, type El, type Timeline, type Transform } from './core/model.ts';
import { pathBounds, tracePath, unionRect, type Rect } from './core/geom.ts';

/** Element not drawn on stage (the text being edited, shown by its textarea instead). */
export const hidden = { id: '' };

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export const tfMatrix = (t: Transform) => new DOMMatrix().translate(t.x, t.y).rotate(t.r).scale(t.sx, t.sy).translate(-t.px, -t.py);

export function toPath2D(el: { path: Parameters<typeof tracePath>[1] }) { const p = new Path2D(); tracePath(p, el.path); return p; }

// ---------- bitmaps ----------
const images = new Map<string, HTMLImageElement>();
let onImageLoad = () => {};
export const setImageLoadHandler = (fn: () => void) => { onImageLoad = fn; };
export function image(doc: Doc, assetId: string) {
  let img = images.get(assetId);
  const a = doc.assets[assetId];
  if (!img && a) { img = new Image(); img.onload = () => onImageLoad(); img.src = a.src; images.set(assetId, img); }
  return img?.complete && img.naturalWidth ? img : null;
}
/** Make sure every bitmap is decoded (export must not drop frames' images). */
export async function preloadImages(doc: Doc) {
  await Promise.all(Object.keys(doc.assets).map(id => { image(doc, id); return images.get(id)!.decode().catch(() => {}); }));
}

// ---------- drawing ----------
const MAX_DEPTH = 24; // guards against a symbol that (indirectly) contains itself

export function drawTimeline(ctx: Ctx, doc: Doc, tl: Timeline, frame: number, depth = 0) {
  if (depth > MAX_DEPTH) return;
  for (let i = tl.layers.length - 1; i >= 0; i--) {
    const l = tl.layers[i];
    if (!l.visible) continue;
    const { els, start } = frameEls(l, frame);
    for (const el of els) drawEl(ctx, doc, el, frame - start, depth);
  }
}

export function drawEl(ctx: Ctx, doc: Doc, el: El, age: number, depth = 0) {
  if (el.alpha <= 0 || el.id === hidden.id) return;
  ctx.save();
  const m = tfMatrix(el.tf);
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.globalAlpha *= el.alpha;
  if (el.kind === 'shape') {
    const p = toPath2D(el);
    if (el.fill && el.path.closed) { ctx.fillStyle = el.fill; ctx.fill(p); }
    if (el.stroke && el.sw > 0) { ctx.strokeStyle = el.stroke; ctx.lineWidth = el.sw; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(p); }
  } else if (el.kind === 'symbol') {
    const sym = doc.symbols[el.symbolId];
    if (sym) drawTimeline(ctx, doc, sym.tl, instFrame(el, age, tlLen(sym.tl)), depth + 1);
  } else if (el.kind === 'text') {
    ctx.font = fontCss(el); ctx.fillStyle = el.fill; ctx.textBaseline = 'middle';
    el.text.split('\n').forEach((l, i) => ctx.fillText(l, 0, (i + 0.5) * el.size * LINE_H));
  } else {
    const a = doc.assets[el.assetId], img = image(doc, el.assetId);
    if (a && img) ctx.drawImage(img, 0, 0, a.w, a.h);
  }
  ctx.restore();
}

/** Render the scene's frame to a fresh canvas at `scale` (export + thumbnails). */
export function renderFrame(doc: Doc, frame: number, scale: number, transparent: boolean) {
  const c = new OffscreenCanvas(Math.max(1, Math.round(doc.w * scale)), Math.max(1, Math.round(doc.h * scale)));
  const ctx = c.getContext('2d')!;
  if (!transparent) { ctx.fillStyle = doc.bg; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.scale(scale, scale);
  drawTimeline(ctx, doc, doc.tl, frame);
  return { canvas: c, ctx };
}

// ---------- bounds (in the element's parent space, axis-aligned) ----------
/** Bounds in the element's own local coordinates (before its transform). */
export function localBounds(doc: Doc, el: El, age: number, depth = 0): Rect | null {
  if (el.kind === 'shape') {
    const b = pathBounds(el.path), pad = el.stroke ? el.sw / 2 : 0;
    return { x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad };
  }
  if (el.kind === 'bitmap') { const a = doc.assets[el.assetId]; return a ? { x: 0, y: 0, w: a.w, h: a.h } : null; }
  if (el.kind === 'text') {
    hitCtx.font = fontCss(el);
    const ls = el.text.split('\n');
    return { x: 0, y: 0, w: Math.max(...ls.map(l => hitCtx.measureText(l).width)), h: ls.length * el.size * LINE_H };
  }
  const sym = doc.symbols[el.symbolId];
  if (!sym || depth > MAX_DEPTH) return null;
  return timelineBounds(doc, sym.tl, instFrame(el, age, tlLen(sym.tl)), depth + 1);
}
export function timelineBounds(doc: Doc, tl: Timeline, frame: number, depth = 0): Rect | null {
  const rs: Rect[] = [];
  for (const l of tl.layers) {
    const { els, start } = frameEls(l, frame);
    for (const el of els) { const r = parentBounds(doc, el, frame - start, depth); if (r) rs.push(r); }
  }
  return unionRect(rs);
}
export function corners(r: Rect, m: DOMMatrix) {
  return [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map(([x, y]) => m.transformPoint({ x, y }));
}
export function parentBounds(doc: Doc, el: El, age: number, depth = 0): Rect | null {
  const r = localBounds(doc, el, age, depth);
  if (!r) return null;
  const cs = corners(r, tfMatrix(el.tf));
  const xs = cs.map(p => p.x), ys = cs.map(p => p.y);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// ---------- hit testing ----------
const hitCtx = new OffscreenCanvas(1, 1).getContext('2d')!;
/** Is point p (parent space of `el`, transformed by `parent`) on the element? `tol` = stroke slop in parent units. */
export function hitEl(doc: Doc, el: El, age: number, p: { x: number; y: number }, tol: number, parent = new DOMMatrix(), depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  const m = parent.multiply(tfMatrix(el.tf));
  if (el.kind === 'shape') {
    const path = toPath2D(el);
    hitCtx.setTransform(m);
    if (el.fill && el.path.closed && hitCtx.isPointInPath(path, p.x, p.y)) return true;
    const scale = Math.hypot(m.a, m.b) || 1;
    hitCtx.lineWidth = (el.stroke ? el.sw : 0) + (2 * tol) / scale;
    return hitCtx.isPointInStroke(path, p.x, p.y);
  }
  if (el.kind === 'bitmap' || el.kind === 'text') {
    const r = localBounds(doc, el, age), q = m.inverse().transformPoint(p);
    return !!r && q.x >= r.x && q.y >= r.y && q.x <= r.x + r.w && q.y <= r.y + r.h;
  }
  const sym = doc.symbols[el.symbolId];
  if (!sym) return false;
  const f = instFrame(el, age, tlLen(sym.tl));
  return sym.tl.layers.some(l => { if (!l.visible) return false; const fe = frameEls(l, f); return fe.els.some(c => hitEl(doc, c, f - fe.start, p, tol, m, depth + 1)); });
}
