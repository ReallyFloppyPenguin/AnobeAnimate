// Document model + pure timeline operations. No DOM here so the self-test can run under plain Node.

export type Pt = { x: number; y: number };
/** Bezier anchor. ix/iy and ox/oy are handle offsets relative to the anchor (0,0 = sharp corner). */
export type BNode = { x: number; y: number; ix: number; iy: number; ox: number; oy: number };
export type Path = { nodes: BNode[]; closed: boolean };

/** Local -> parent: translate(x,y) · rotate(r deg) · scale(sx,sy) · translate(-px,-py). (x,y) is where the pivot sits. */
export type Transform = { x: number; y: number; r: number; sx: number; sy: number; px: number; py: number };

type Base = { id: string; tf: Transform; alpha: number };
export type ShapeEl = Base & { kind: 'shape'; path: Path; fill: string | null; stroke: string | null; sw: number };
export type LoopMode = 'loop' | 'once' | 'single';
export type SymbolEl = Base & { kind: 'symbol'; symbolId: string; loop: LoopMode; first: number };
export type BitmapEl = Base & { kind: 'bitmap'; assetId: string };
export type TextEl = Base & { kind: 'text'; text: string; font: string; size: number; fill: string; bold: boolean; italic: boolean };
export type El = ShapeEl | SymbolEl | BitmapEl | TextEl;

/** Built-in fonts: menu name -> CSS font-family. */
export const FONTS: Record<string, string> = {
  Sans: 'sans-serif', Serif: 'serif', Mono: 'monospace', Arial: 'Arial, sans-serif', Georgia: 'Georgia, serif',
  Times: '"Times New Roman", serif', Courier: '"Courier New", monospace', Impact: 'Impact, sans-serif',
  'Comic Sans': '"Comic Sans MS", cursive', Verdana: 'Verdana, sans-serif',
};
export type TextStyle = Pick<TextEl, 'font' | 'size' | 'bold' | 'italic'>;
export const fontCss = (t: TextStyle, size = t.size) => `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${size}px ${FONTS[t.font] ?? 'sans-serif'}`;
/** Text line height as a multiple of the font size (canvas and the editing textarea agree on it). */
export const LINE_H = 1.2;

export type Tween = { ease: string; bez: [number, number, number, number]; spin: number };
export type Keyframe = { id: string; dur: number; els: El[]; tween?: Tween };
export type Layer = { id: string; name: string; visible: boolean; locked: boolean; color: string; kfs: Keyframe[] };
export type Timeline = { layers: Layer[] }; // layers[0] is the TOP layer
export type SymbolDef = { id: string; name: string; tl: Timeline };
export type Asset = { id: string; name: string; src: string; w: number; h: number };
export type Doc = {
  v: 1; w: number; h: number; fps: number; bg: string;
  tl: Timeline; symbols: Record<string, SymbolDef>; assets: Record<string, Asset>;
};

export const uid = () => Math.random().toString(36).slice(2, 10);
export const ident = (x = 0, y = 0): Transform => ({ x, y, r: 0, sx: 1, sy: 1, px: 0, py: 0 });
const LAYER_COLORS = ['#8b7cf6', '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#fb7185', '#a3e635', '#22d3ee'];
let layerSeq = 0;
export const newLayer = (name: string): Layer => ({
  id: uid(), name, visible: true, locked: false, color: LAYER_COLORS[layerSeq++ % LAYER_COLORS.length],
  kfs: [{ id: uid(), dur: 1, els: [] }],
});
export const newDoc = (): Doc => ({
  v: 1, w: 1280, h: 720, fps: 24, bg: '#ffffffff',
  tl: { layers: [newLayer('Layer 1')] }, symbols: {}, assets: {},
});
export const newTween = (): Tween => ({ ease: 'linear', bez: [0.42, 0, 0.58, 1], spin: 0 });

/** Deep copy of elements with fresh ids (paste / duplicate). Plain-JSON data, so structuredClone is safe. */
export const cloneEls = (els: El[]): El[] => els.map(e => ({ ...structuredClone(e), id: uid() }));

// ---------- timeline queries ----------
export const layerLen = (l: Layer) => l.kfs.reduce((s, k) => s + k.dur, 0);
export const tlLen = (tl: Timeline) => Math.max(1, ...tl.layers.map(layerLen));
export function kfStart(l: Layer, i: number) { let s = 0; for (let j = 0; j < i; j++) s += l.kfs[j].dur; return s; }
/** Index of the keyframe span containing frame f, or -1 past the end of the layer. */
export function kfIndexAt(l: Layer, f: number) {
  let s = 0;
  for (let i = 0; i < l.kfs.length; i++) { s += l.kfs[i].dur; if (f < s) return i; }
  return -1;
}

// ---------- easing ----------
const pow = Math.pow, PI = Math.PI;
const outBounce = (t: number) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
export const EASES: Record<string, (t: number) => number> = {
  'linear': t => t,
  'in-sine': t => 1 - Math.cos((t * PI) / 2),
  'out-sine': t => Math.sin((t * PI) / 2),
  'in-out-sine': t => -(Math.cos(PI * t) - 1) / 2,
  'in-quad': t => t * t,
  'out-quad': t => 1 - (1 - t) * (1 - t),
  'in-out-quad': t => (t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2),
  'in-cubic': t => t * t * t,
  'out-cubic': t => 1 - pow(1 - t, 3),
  'in-out-cubic': t => (t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2),
  'in-expo': t => (t === 0 ? 0 : pow(2, 10 * t - 10)),
  'out-expo': t => (t === 1 ? 1 : 1 - pow(2, -10 * t)),
  'in-back': t => 2.70158 * t * t * t - 1.70158 * t * t,
  'out-back': t => 1 + 2.70158 * pow(t - 1, 3) + 1.70158 * pow(t - 1, 2),
  'out-elastic': t => (t === 0 || t === 1 ? t : pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * PI) / 3)) + 1),
  'out-bounce': outBounce,
  'in-bounce': t => 1 - outBounce(1 - t),
};

/** CSS-style cubic-bezier(x1,y1,x2,y2): solve x(u)=t by Newton, fall back to bisection. */
export function cubicBezier(t: number, [x1, y1, x2, y2]: [number, number, number, number]) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (u: number) => ((ax * u + bx) * u + cx) * u;
  let u = t;
  for (let i = 0; i < 8; i++) {
    const err = X(u) - t, d = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(err) < 1e-6) break;
    if (Math.abs(d) < 1e-6) { u = NaN; break; }
    u -= err / d;
  }
  if (!(u >= 0 && u <= 1)) { // bisection fallback
    let lo = 0, hi = 1; u = t;
    for (let i = 0; i < 30; i++) { if (X(u) < t) lo = u; else hi = u; u = (lo + hi) / 2; }
  }
  return ((ay * u + by) * u + cy) * u;
}
export const ease = (tw: Tween, t: number) => (tw.ease === 'custom' ? cubicBezier(t, tw.bez) : (EASES[tw.ease] ?? EASES.linear)(t));

// ---------- colors (#rrggbbaa) ----------
export function parseColor(c: string): [number, number, number, number] {
  const h = c.replace('#', '');
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length >= 8 ? n(6) : 255];
}
const hx = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
export const fmtColor = (c: number[]) => '#' + c.map(hx).join('');
export function lerpColor(a: string | null, b: string | null, t: number): string | null {
  if (a === null && b === null) return null;
  const ca = parseColor(a ?? (b as string).slice(0, 7) + '00');
  const cb = parseColor(b ?? (a as string).slice(0, 7) + '00');
  return fmtColor(ca.map((v, i) => v + (cb[i] - v) * t));
}

// ---------- path morphing ----------
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const segCount = (p: Path) => (p.closed ? p.nodes.length : p.nodes.length - 1);

/** Split segment i (node i -> i+1) at t=0.5 with de Casteljau; curve shape is unchanged. */
export function splitSeg(p: Path, i: number) {
  const a = p.nodes[i], j = (i + 1) % p.nodes.length, b = p.nodes[j];
  const p0 = [a.x, a.y], p1 = [a.x + a.ox, a.y + a.oy], p2 = [b.x + b.ix, b.y + b.iy], p3 = [b.x, b.y];
  const m = (u: number[], v: number[]) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2];
  const q0 = m(p0, p1), q1 = m(p1, p2), q2 = m(p2, p3), r0 = m(q0, q1), r1 = m(q1, q2), s = m(r0, r1);
  a.ox = q0[0] - a.x; a.oy = q0[1] - a.y;
  b.ix = q2[0] - b.x; b.iy = q2[1] - b.y;
  p.nodes.splice(i + 1, 0, { x: s[0], y: s[1], ix: r0[0] - s[0], iy: r0[1] - s[1], ox: r1[0] - s[0], oy: r1[1] - s[1] });
}
function segLen(p: Path, i: number) {
  const a = p.nodes[i], b = p.nodes[(i + 1) % p.nodes.length];
  return Math.hypot(a.ox, a.oy) + Math.hypot(b.x + b.ix - a.x - a.ox, b.y + b.iy - a.y - a.oy) + Math.hypot(b.ix, b.iy);
}
/** Subdivide the longest segment until the path has n nodes. */
function growTo(p: Path, n: number) {
  while (p.nodes.length < n && segCount(p) > 0) {
    let best = 0, bl = -1;
    for (let i = 0; i < segCount(p); i++) { const l = segLen(p, i); if (l > bl) { bl = l; best = i; } }
    splitSeg(p, best);
  }
}
const area = (p: Path) => p.nodes.reduce((s, a, i) => { const b = p.nodes[(i + 1) % p.nodes.length]; return s + a.x * b.y - b.x * a.y; }, 0);
export function reversePath(p: Path): Path {
  return { closed: p.closed, nodes: p.nodes.slice().reverse().map(n => ({ x: n.x, y: n.y, ix: n.ox, iy: n.oy, ox: n.ix, oy: n.iy })) };
}
/** Copies of a and b with equal node counts, matching winding and best start-node alignment (closed paths). */
export function matchPaths(a: Path, b: Path): [Path, Path] {
  const A = structuredClone(a), B = structuredClone(b);
  if (!A.nodes.length || !B.nodes.length) return [A, B];
  growTo(A, B.nodes.length); growTo(B, A.nodes.length);
  if (A.closed && B.closed && A.nodes.length === B.nodes.length) {
    let BB = Math.sign(area(A)) !== Math.sign(area(B)) ? reversePath(B) : B;
    const n = BB.nodes.length;
    // ponytail: O(n²) start alignment, fine for the few hundred nodes a brush stroke produces
    let best = 0, bd = Infinity;
    for (let k = 0; k < n; k++) {
      let d = 0;
      for (let i = 0; i < n; i++) { const p = A.nodes[i], q = BB.nodes[(i + k) % n]; d += (p.x - q.x) ** 2 + (p.y - q.y) ** 2; }
      if (d < bd) { bd = d; best = k; }
    }
    BB = { closed: true, nodes: BB.nodes.map((_, i) => BB.nodes[(i + best) % n]) };
    return [A, BB];
  }
  return [A, B];
}
export function lerpPath(a: Path, b: Path, t: number): Path {
  if (a.nodes.length !== b.nodes.length) return t < 1 ? a : b;
  return { closed: a.closed, nodes: a.nodes.map((n, i) => { const m = b.nodes[i]; return {
    x: lerp(n.x, m.x, t), y: lerp(n.y, m.y, t), ix: lerp(n.ix, m.ix, t), iy: lerp(n.iy, m.iy, t), ox: lerp(n.ox, m.ox, t), oy: lerp(n.oy, m.oy, t),
  }; }) };
}

// ---------- tween interpolation ----------
export function lerpTf(a: Transform, b: Transform, t: number, spin: number): Transform {
  return {
    x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), r: a.r + (b.r - a.r + spin * 360) * t,
    sx: lerp(a.sx, b.sx, t), sy: lerp(a.sy, b.sy, t), px: lerp(a.px, b.px, t), py: lerp(a.py, b.py, t),
  };
}
const sameTarget = (a: El, b: El) =>
  a.kind === b.kind && (a.kind !== 'symbol' || a.symbolId === (b as SymbolEl).symbolId) && (a.kind !== 'bitmap' || a.assetId === (b as BitmapEl).assetId);

/** Pair start/end elements: by id first (keyframe copies keep ids), then leftovers in stacking order by kind. */
export function pairEls(a: El[], b: El[]): (El | undefined)[] {
  const byId = new Map(b.map(e => [e.id, e]));
  const used = new Set<El>();
  const out: (El | undefined)[] = a.map(e => { const m = byId.get(e.id); if (m && sameTarget(e, m)) { used.add(m); return m; } return undefined; });
  const rest = b.filter(e => !used.has(e));
  a.forEach((e, i) => {
    if (out[i]) return;
    const k = rest.findIndex(r => sameTarget(e, r));
    if (k >= 0) out[i] = rest.splice(k, 1)[0];
  });
  return out;
}
export function lerpEl(a: El, b: El, t: number, spin: number): El {
  const base = { ...a, tf: lerpTf(a.tf, b.tf, t, spin), alpha: lerp(a.alpha, b.alpha, t) };
  if (a.kind === 'shape' && b.kind === 'shape') {
    const [pa, pb] = matchPaths(a.path, b.path);
    return { ...(base as ShapeEl), path: lerpPath(pa, pb, t), fill: lerpColor(a.fill, b.fill, t), stroke: lerpColor(a.stroke, b.stroke, t), sw: lerp(a.sw, b.sw, t) };
  }
  if (a.kind === 'text' && b.kind === 'text') return { ...(base as TextEl), fill: lerpColor(a.fill, b.fill, t) ?? a.fill, size: lerp(a.size, b.size, t) };
  return base as El;
}

/** Elements shown on a layer at frame f (tweens interpolated) plus the start frame of their keyframe span. */
export function frameEls(l: Layer, f: number): { els: El[]; start: number } {
  const i = kfIndexAt(l, f);
  if (i < 0) return { els: [], start: f };
  const kf = l.kfs[i], start = kfStart(l, i), next = l.kfs[i + 1];
  if (!kf.tween || !next || f === start) return { els: kf.els, start };
  const t = ease(kf.tween, (f - start) / kf.dur);
  const partners = pairEls(kf.els, next.els);
  return { els: kf.els.map((e, k) => (partners[k] ? lerpEl(e, partners[k]!, t, kf.tween!.spin) : e)), start };
}

/** Frame of a symbol's own timeline that an instance shows, `age` frames into its keyframe span. */
export function instFrame(el: SymbolEl, age: number, len: number) {
  if (el.loop === 'single') return Math.min(el.first, len - 1);
  if (el.loop === 'once') return Math.min(el.first + age, len - 1);
  return (el.first + age) % len;
}

// ---------- timeline edits (mutate the layer in place) ----------
/** F5: insert a frame at f (extends the span there, or stretches the layer out to f). */
export function insertFrame(l: Layer, f: number) {
  const len = layerLen(l);
  if (f < len) l.kfs[kfIndexAt(l, f)].dur++;
  else if (l.kfs.length) l.kfs[l.kfs.length - 1].dur += f - len + 1;
  else l.kfs.push({ id: uid(), dur: f + 1, els: [] });
}
/** Shift+F5 */
export function removeFrame(l: Layer, f: number) {
  const i = kfIndexAt(l, f);
  if (i < 0) return;
  if (--l.kfs[i].dur === 0) {
    l.kfs.splice(i, 1);
    if (i > 0 && i === l.kfs.length) delete l.kfs[i - 1].tween; // nothing left to tween to
  }
}
/** F6 (copy interpolated content) / F7 (blank). Returns the keyframe now starting at f. */
export function insertKeyframe(l: Layer, f: number, blank: boolean): Keyframe {
  const len = layerLen(l);
  if (f >= len) {
    const prev = l.kfs[l.kfs.length - 1];
    const els = blank || !prev ? [] : structuredClone(frameEls(l, len - 1).els);
    if (prev) prev.dur += f - len; else if (f > 0) l.kfs.push({ id: uid(), dur: f, els: [] });
    const kf: Keyframe = { id: uid(), dur: 1, els };
    l.kfs.push(kf);
    return kf;
  }
  const i = kfIndexAt(l, f), kf = l.kfs[i], s = kfStart(l, i);
  if (s === f) return kf;
  const els = blank ? [] : structuredClone(frameEls(l, f).els);
  const nk: Keyframe = { id: uid(), dur: kf.dur - (f - s), els };
  if (kf.tween && !blank && l.kfs[i + 1]) nk.tween = structuredClone(kf.tween);
  if (blank) delete kf.tween;
  kf.dur = f - s;
  l.kfs.splice(i + 1, 0, nk);
  return nk;
}
/** Shift+F6: merge the keyframe at f into the previous span. */
export function clearKeyframe(l: Layer, f: number) {
  const i = kfIndexAt(l, f);
  if (i < 0 || kfStart(l, i) !== f) return;
  if (i === 0) { l.kfs[0].els = []; delete l.kfs[0].tween; return; }
  l.kfs[i - 1].dur += l.kfs[i].dur;
  l.kfs.splice(i, 1);
  if (i === l.kfs.length) delete l.kfs[i - 1].tween;
}
/** Drag keyframe i by delta frames, trading duration with the previous span. Returns applied delta. */
export function moveKeyframe(l: Layer, i: number, delta: number) {
  if (i <= 0) return 0;
  const prev = l.kfs[i - 1], kf = l.kfs[i];
  const d = Math.max(1 - prev.dur, Math.min(delta, kf.dur - 1));
  prev.dur += d; kf.dur -= d;
  return d;
}
