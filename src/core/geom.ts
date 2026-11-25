// Pure bezier/path geometry helpers.
import type { BNode, Path, Pt } from './model.ts';

export const node = (x: number, y: number, ix = 0, iy = 0, ox = 0, oy = 0): BNode => ({ x, y, ix, iy, ox, oy });
export type Rect = { x: number; y: number; w: number; h: number };

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): Path {
  const k = 0.5522847498, kx = rx * k, ky = ry * k;
  return { closed: true, nodes: [
    node(cx, cy - ry, -kx, 0, kx, 0), node(cx + rx, cy, 0, -ky, 0, ky),
    node(cx, cy + ry, kx, 0, -kx, 0), node(cx - rx, cy, 0, ky, 0, -ky),
  ] };
}
/** Rectangle; `r` > 0 rounds the corners with quarter-circle beziers. */
export function rectPath(x: number, y: number, w: number, h: number, r = 0): Path {
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) return { closed: true, nodes: [node(x, y), node(x + w, y), node(x + w, y + h), node(x, y + h)] };
  const k = r * 0.5522847498, R = x + w, B = y + h;
  return { closed: true, nodes: [
    node(x + r, y, -k, 0), node(R - r, y, 0, 0, k, 0), node(R, y + r, 0, -k), node(R, B - r, 0, 0, 0, k),
    node(R - r, B, k, 0), node(x + r, B, 0, 0, -k, 0), node(x, B - r, 0, k), node(x, y + r, 0, 0, 0, -k),
  ] };
}
export const linePath = (a: Pt, b: Pt): Path => ({ closed: false, nodes: [node(a.x, a.y), node(b.x, b.y)] });

/** Ramer–Douglas–Peucker polyline simplification. */
export function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  let idx = 0, max = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs(dy * pts[i].x - dx * pts[i].y + b.x * a.y - b.y * a.x) / len;
    if (d > max) { max = d; idx = i; }
  }
  if (max <= eps) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}

/** Catmull-Rom through points, expressed as bezier handles. */
export function smoothPath(pts: Pt[], closed: boolean, tension = 1): Path {
  const n = pts.length;
  const nodes = pts.map((p, i) => {
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tx = ((next.x - prev.x) / 6) * tension, ty = ((next.y - prev.y) / 6) * tension;
    const end = !closed && (i === 0 || i === n - 1);
    return end ? node(p.x, p.y) : node(p.x, p.y, -tx, -ty, tx, ty);
  });
  return { nodes, closed };
}

export function bezPoint(a: BNode, b: BNode, t: number): Pt {
  const u = 1 - t, x1 = a.x + a.ox, y1 = a.y + a.oy, x2 = b.x + b.ix, y2 = b.y + b.iy;
  return {
    x: u * u * u * a.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * b.y,
  };
}

/** Tight-enough bounds by sampling each segment. */
export function pathBounds(p: Path): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (q: Pt) => { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); };
  const n = p.nodes.length, segs = p.closed ? n : n - 1;
  p.nodes.forEach(add);
  for (let i = 0; i < segs; i++) {
    const a = p.nodes[i], b = p.nodes[(i + 1) % n];
    if (a.ox || a.oy || b.ix || b.iy) for (let k = 1; k < 12; k++) add(bezPoint(a, b, k / 12));
  }
  return n ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** Shift nodes so the bbox centre is the origin; returns the old centre. */
export function recenter(p: Path): Pt {
  const b = pathBounds(p), c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  for (const n of p.nodes) { n.x -= c.x; n.y -= c.y; }
  return c;
}

type PathSink = { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void; closePath(): void };
export function tracePath(ctx: PathSink, p: Path) {
  const ns = p.nodes, n = ns.length;
  if (!n) return;
  ctx.moveTo(ns[0].x, ns[0].y);
  const seg = (a: BNode, b: BNode) => {
    if (a.ox || a.oy || b.ix || b.iy) ctx.bezierCurveTo(a.x + a.ox, a.y + a.oy, b.x + b.ix, b.y + b.iy, b.x, b.y);
    else ctx.lineTo(b.x, b.y);
  };
  for (let i = 1; i < n; i++) seg(ns[i - 1], ns[i]);
  if (p.closed) { seg(ns[n - 1], ns[0]); ctx.closePath(); }
}

export const rectsHit = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
export function unionRect(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y));
  const x1 = Math.max(...rs.map(r => r.x + r.w)), y1 = Math.max(...rs.map(r => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
