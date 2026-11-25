import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Clapperboard, Box, Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { drawTimeline, hidden, tfMatrix } from '../render.ts';
import { LINE_H, fontCss, ident, uid } from '../core/model.ts';
import { S, busy, curTl, setUI, shownSel, stopPlay, type MenuItem } from '../store.ts';
import { DEFAULT_CURSOR, TOOLS, baseM, commitText, exitSymbol, handTool, hitTop, viewM, zoomAt, type PEvt } from '../tools.ts';
import { addImage, fitView, keyOf, placeEl, run, symbolInstance } from '../commands.ts';

const item = (label: string, cmd: string): MenuItem => ({ label, cmd, key: keyOf(cmd) });
const SEP: MenuItem = { label: '', sep: true };
let fitted = false;
let onionCanvas: OffscreenCanvas | null = null;

function paint(c: HTMLCanvasElement) {
  const dpr = devicePixelRatio, { viewW: W, viewH: H, zoom: z, panX, panY } = S.ui;
  const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  const root = new DOMMatrix([dpr * z, 0, 0, dpr * z, dpr * panX, dpr * panY]), edit = root.multiply(baseM());
  const { w, h } = S.doc, tl = curTl(), f = S.ui.frame;

  // stage
  ctx.setTransform(root);
  ctx.shadowColor = 'rgb(0 0 0 / 0.55)'; ctx.shadowBlur = 30 * dpr; ctx.shadowOffsetY = 6 * dpr;
  ctx.fillStyle = S.doc.bg; ctx.fillRect(0, 0, w, h);
  ctx.shadowColor = 'transparent';

  // onion skin: neighbouring frames tinted (past = violet, future = teal), fading with distance
  if (S.ui.onion && !S.ui.playing) {
    onionCanvas ??= new OffscreenCanvas(1, 1);
    if (onionCanvas.width !== pw || onionCanvas.height !== ph) { onionCanvas.width = pw; onionCanvas.height = ph; }
    const o = onionCanvas.getContext('2d')!;
    for (let k = S.ui.onionN; k >= 1; k--) for (const dir of [-1, 1]) {
      const g = f + dir * k;
      if (g < 0) continue;
      o.globalCompositeOperation = 'source-over'; o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, pw, ph);
      o.setTransform(edit); drawTimeline(o, S.doc, tl, g);
      o.globalCompositeOperation = 'source-in'; o.setTransform(1, 0, 0, 1, 0, 0);
      o.fillStyle = dir < 0 ? '#8b7cf6' : '#2dd4bf'; o.fillRect(0, 0, pw, ph);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 0.45 * (1 - (k - 1) / S.ui.onionN); ctx.drawImage(onionCanvas, 0, 0); ctx.globalAlpha = 1;
    }
  }

  ctx.setTransform(edit);
  drawTimeline(ctx, S.doc, tl, f);

  // dim the pasteboard (content outside the stage stays visible but muted)
  ctx.setTransform(root);
  const inv = root.inverse(), a = inv.transformPoint({ x: 0, y: 0 }), b = inv.transformPoint({ x: pw, y: ph });
  ctx.beginPath(); ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.rect(0, 0, w, h);
  ctx.fillStyle = 'rgb(12 12 15 / 0.62)'; ctx.fill('evenodd');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = 'rgb(255 255 255 / 0.08)'; ctx.lineWidth = 1;
  const s0 = root.transformPoint({ x: 0, y: 0 }), s1 = root.transformPoint({ x: w, y: h });
  ctx.strokeRect(Math.round(s0.x) + 0.5, Math.round(s0.y) + 0.5, Math.round(s1.x - s0.x), Math.round(s1.y - s0.y));

  // symbol registration point
  if (S.ui.edit.length) {
    const o = edit.transformPoint({ x: 0, y: 0 });
    ctx.strokeStyle = '#8b7cf6'; ctx.lineWidth = 1.25 * dpr;
    ctx.beginPath(); ctx.moveTo(o.x - 8 * dpr, o.y); ctx.lineTo(o.x + 8 * dpr, o.y); ctx.moveTo(o.x, o.y - 8 * dpr); ctx.lineTo(o.x, o.y + 8 * dpr); ctx.stroke();
  }

  if (!S.ui.playing) { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); TOOLS[S.ui.tool].overlay?.(ctx); }
}

/** Textarea laid over the stage for typing; the element itself is hidden while it is open. */
function TextEditor() {
  const te = S.ui.textEdit!, cur = te.id ? shownSel().find(s => s.el.id === te.id)?.el : undefined;
  const el = cur?.kind === 'text' ? cur : { ...S.ui.textStyle, fill: S.ui.fill ?? '#000000ff', text: '', tf: ident(te.x, te.y) };
  const [v, setV] = useState(el.text);
  useLayoutEffect(() => { hidden.id = te.id ?? ''; return () => { hidden.id = ''; }; }, []);
  const m = viewM().multiply(tfMatrix(el.tf)), at = m.transformPoint({ x: 0, y: 0 }), lines = v.split('\n');
  return (
    <textarea className="text-edit" autoFocus spellCheck={false} wrap="off" aria-label="Text" value={v}
      rows={lines.length} cols={Math.max(2, ...lines.map(l => l.length + 1))}
      style={{ left: at.x, top: at.y, font: fontCss(el, el.size * Math.hypot(m.a, m.b)), lineHeight: LINE_H, color: el.fill, transform: `rotate(${Math.atan2(m.b, m.a)}rad)` }}
      onChange={e => setV(e.target.value)} onBlur={() => commitText(v)} onKeyDown={e => { if (e.key === 'Escape') e.currentTarget.blur(); }} />
  );
}

export function Stage() {
  const wrap = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null);
  const [drop, setDrop] = useState(false);
  const g = useRef({ pressed: false, tool: null as (typeof TOOLS)[keyof typeof TOOLS] | null, lastT: 0, lastX: 0, lastY: 0 });

  useLayoutEffect(() => { if (cv.current) paint(cv.current); });

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(([e]) => {
      setUI({ viewW: e.contentRect.width, viewH: e.contentRect.height });
      if (!fitted && e.contentRect.width > 0) { fitted = true; fitView(); }
    });
    ro.observe(el);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      else if (e.shiftKey) setUI({ panX: S.ui.panX - e.deltaY });
      else setUI({ panX: S.ui.panX - e.deltaX, panY: S.ui.panY - e.deltaY });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    const dpr = matchMedia(`(resolution: ${devicePixelRatio}dppx)`), redraw = () => cv.current && paint(cv.current);
    dpr.addEventListener('change', redraw);
    return () => { ro.disconnect(); el.removeEventListener('wheel', wheel); dpr.removeEventListener('change', redraw); };
  }, []);

  const evt = (e: PointerEvent, dbl = false): PEvt => {
    const r = cv.current!.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const p = viewM().inverse().transformPoint({ x: sx, y: sy });
    return { p: { x: p.x, y: p.y }, sx, sy, shift: e.shiftKey, alt: e.altKey, pressure: e.pressure || 0.5, pen: e.pointerType === 'pen', dbl };
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    stopPlay();
    e.preventDefault(); // no compat mousedown, so focus stays where the tool puts it (text editor)
    const editing = !!S.ui.textEdit;
    (document.activeElement as HTMLElement | null)?.blur?.();
    if (editing) return; // this click only closes the text editor
    e.currentTarget.setPointerCapture(e.pointerId);
    const s = g.current, now = performance.now();
    const dbl = e.button === 0 && now - s.lastT < 350 && Math.hypot(e.clientX - s.lastX, e.clientY - s.lastY) < 5;
    Object.assign(s, { lastT: dbl ? 0 : now, lastX: e.clientX, lastY: e.clientY, pressed: true });
    s.tool = e.button === 1 ? handTool : TOOLS[S.ui.tool];
    s.tool.down?.(evt(e.nativeEvent, dbl));
  };
  const move = (e: React.PointerEvent) => {
    const s = g.current, tool = s.tool ?? TOOLS[S.ui.tool], n = e.nativeEvent;
    const evs = s.pressed && (S.ui.tool === 'pencil' || S.ui.tool === 'brush') ? n.getCoalescedEvents?.() ?? [n] : [n];
    for (const x of evs.length ? evs : [n]) tool.move?.(evt(x), s.pressed);
    if (!s.pressed) cv.current!.style.cursor = tool.cursor?.(evt(n)) ?? DEFAULT_CURSOR[S.ui.tool] ?? 'default';
  };
  const up = (e: React.PointerEvent) => {
    const s = g.current;
    if (!s.pressed) return;
    s.pressed = false;
    s.tool?.up?.(evt(e.nativeEvent));
    s.tool = null;
  };

  const ctxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const hit = hitTop(evt(e.nativeEvent as PointerEvent).p);
    if (hit && !S.ui.sel.includes(hit.el.id)) setUI({ sel: [hit.el.id], layerId: hit.layer.id });
    if (!hit) setUI({ sel: [] });
    const items = hit
      ? [item('Cut', 'cut'), item('Copy', 'copy'), item('Paste', 'paste'), item('Duplicate', 'duplicate'), item('Delete', 'delete'), SEP,
        item('Convert to Symbol…', 'convertSymbol'), SEP, item('Bring to Front', 'front'), item('Send to Back', 'back'), SEP, item('Flip Horizontal', 'flipH'), item('Flip Vertical', 'flipV')]
      : [item('Paste', 'paste'), item('Paste in Place', 'pasteInPlace'), item('Select All', 'selectAll'), SEP, item('Import Image…', 'import'), item('Fit Stage', 'fit')];
    setUI({ ctxMenu: { x: e.clientX, y: e.clientY, items } });
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDrop(false);
    const p = evt(e.nativeEvent as unknown as PointerEvent).p, at = { x: Math.round(p.x), y: Math.round(p.y) };
    const lib = e.dataTransfer.getData('application/x-anobe');
    if (lib) {
      const { kind, id } = JSON.parse(lib) as { kind: 'symbol' | 'asset'; id: string };
      if (kind === 'symbol') placeEl(symbolInstance(id), at);
      else { const a = S.doc.assets[id]; if (a) placeEl({ id: uid(), kind: 'bitmap', assetId: id, alpha: 1, tf: { ...ident(), px: a.w / 2, py: a.h / 2 } }, at); }
      return;
    }
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length) await busy('Importing…', async () => {
      for (const f of files) {
        const url = await new Promise<string>(res => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(f); });
        await addImage(f.name, url, at);
      }
    });
  };

  const crumbs = [{ name: 'Scene 1', icon: Clapperboard }, ...S.ui.edit.map(e => ({ name: S.doc.symbols[e.symbolId]?.name ?? '?', icon: Box }))];
  return (
    <main
      ref={wrap} className={`stage-wrap ${drop ? 'drop' : ''}`}
      onDragOver={e => { if ([...e.dataTransfer.types].some(t => t === 'Files' || t === 'application/x-anobe')) { e.preventDefault(); setDrop(true); } }}
      onDragLeave={() => setDrop(false)} onDrop={onDrop}
    >
      <canvas
        ref={cv} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={ctxMenu}
        onPointerLeave={() => { if (!g.current.pressed) cv.current!.style.cursor = ''; }}
        aria-label="Stage"
      />
      {S.ui.textEdit && <TextEditor key={S.ui.textEdit.id ?? `${S.ui.textEdit.x},${S.ui.textEdit.y}`} />}
      <div className="hud crumbs glass">
        {crumbs.map((c, i) => (
          <span key={i} style={{ display: 'contents' }}>
            {i > 0 && <ChevronRight size={13} className="muted" />}
            <button className="crumb" aria-current={i === crumbs.length - 1} onClick={() => { for (let k = S.ui.edit.length; k > i; k--) exitSymbol(); }}>
              <c.icon size={14} /> {c.name}
            </button>
          </span>
        ))}
      </div>
      <div className="hud zoom glass">
        <button className="icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => run('zoomOut')}><ZoomOut size={15} /></button>
        <button className="icon-btn zv" style={{ width: 'auto', padding: '0 4px' }} title="Actual size (Ctrl+1)" onClick={() => run('zoom100')}>{Math.round(S.ui.zoom * 100)}%</button>
        <button className="icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => run('zoomIn')}><ZoomIn size={15} /></button>
        <button className="icon-btn" title="Fit stage (Ctrl+0)" aria-label="Fit stage" onClick={() => run('fit')}><Maximize size={14} /></button>
      </div>
    </main>
  );
}
