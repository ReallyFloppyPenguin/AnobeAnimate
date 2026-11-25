import { useLayoutEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Layers, Lock, LockOpen, Pause, Play, Plus, Repeat, SkipBack, SkipForward, StepBack, StepForward, Trash2 } from 'lucide-react';
import { kfIndexAt, kfStart, moveKeyframe, type Layer } from '../core/model.ts';
import { S, curLen, curTl, mutate, setUI, stopPlay, type MenuItem } from '../store.ts';
import { deleteLayer, keyOf, run, setFrame } from '../commands.ts';

const CW = 14, RH = 28, RULER = 24;
const item = (label: string, cmd: string): MenuItem => ({ label, cmd, key: keyOf(cmd) });
const SEP: MenuItem = { label: '', sep: true };
const FRAME_MENU = [
  item('Insert Frame', 'insertFrame'), item('Remove Frame', 'removeFrame'), SEP,
  item('Insert Keyframe', 'keyframe'), item('Insert Blank Keyframe', 'blankKeyframe'), item('Clear Keyframe', 'clearKeyframe'), SEP,
  item('Create Tween', 'createTween'), item('Remove Tween', 'removeTween'),
];

function paint(c: HTMLCanvasElement, sl: number, st: number) {
  const dpr = devicePixelRatio, W = c.clientWidth, H = c.clientHeight;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const layers = curTl().layers, f0 = Math.floor(sl / CW), f1 = Math.ceil((sl + W) / CW), cur = S.ui.frame;
  const x = (f: number) => f * CW - sl;

  // rows
  layers.forEach((l, i) => {
    const y = RULER + i * RH - st;
    if (y > H || y + RH < RULER) return;
    if (l.id === S.ui.layerId) { ctx.fillStyle = 'rgb(139 124 246 / 0.10)'; ctx.fillRect(0, y, W, RH); }
    for (let f = f0; f <= f1; f++) {
      if ((f + 1) % 5 === 0) { ctx.fillStyle = 'rgb(255 255 255 / 0.025)'; ctx.fillRect(x(f), y, CW, RH); }
      ctx.fillStyle = 'rgb(255 255 255 / 0.05)'; ctx.fillRect(x(f) + CW - 1, y, 1, RH);
    }
    let s = 0;
    l.kfs.forEach((kf, k) => {
      const x0 = x(s), w = kf.dur * CW, tween = kf.tween && l.kfs[k + 1];
      if (x0 < W && x0 + w > 0) {
        ctx.fillStyle = tween ? 'rgb(139 124 246 / 0.30)' : kf.els.length ? 'rgb(255 255 255 / 0.09)' : 'rgb(255 255 255 / 0.035)';
        ctx.fillRect(x0 + 1, y + 3, w - 2, RH - 6);
        ctx.strokeStyle = 'rgb(255 255 255 / 0.14)'; ctx.lineWidth = 1; ctx.strokeRect(x0 + 1.5, y + 3.5, w - 3, RH - 7);
        if (tween && w > CW * 2) {
          ctx.strokeStyle = '#a99cff'; ctx.beginPath(); ctx.moveTo(x0 + CW, y + RH / 2); ctx.lineTo(x0 + w - 6, y + RH / 2);
          ctx.lineTo(x0 + w - 10, y + RH / 2 - 3); ctx.moveTo(x0 + w - 6, y + RH / 2); ctx.lineTo(x0 + w - 10, y + RH / 2 + 3); ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(x0 + CW / 2, y + RH / 2, 3.5, 0, Math.PI * 2);
        if (kf.els.length) { ctx.fillStyle = '#fafafa'; ctx.fill(); } else { ctx.strokeStyle = '#d4d4d8'; ctx.lineWidth = 1.25; ctx.stroke(); }
      }
      s += kf.dur;
    });
    ctx.fillStyle = 'rgb(255 255 255 / 0.05)'; ctx.fillRect(0, y + RH - 1, W, 1);
  });

  // ruler
  ctx.fillStyle = 'rgb(16 16 19 / 0.96)'; ctx.fillRect(0, 0, W, RULER);
  ctx.fillStyle = 'rgb(255 255 255 / 0.10)'; ctx.fillRect(0, RULER - 1, W, 1);
  ctx.font = '11px "Cascadia Mono", Consolas, monospace'; ctx.textBaseline = 'middle';
  for (let f = f0; f <= f1; f++) {
    const big = (f + 1) % 5 === 0 || f === 0;
    ctx.fillStyle = big ? 'rgb(255 255 255 / 0.28)' : 'rgb(255 255 255 / 0.12)';
    ctx.fillRect(x(f) + CW - 1, big ? RULER - 9 : RULER - 5, 1, big ? 8 : 4);
    if (big) { ctx.fillStyle = '#a1a1aa'; ctx.fillText(String(f + 1), x(f) + 2, 9); }
  }
  // end of timeline marker
  const len = curLen();
  ctx.fillStyle = 'rgb(255 255 255 / 0.18)'; ctx.fillRect(x(len), RULER, 1, H);

  // playhead
  const px = x(cur);
  ctx.fillStyle = 'rgb(139 124 246 / 0.22)'; ctx.fillRect(px, RULER, CW, H);
  ctx.fillStyle = '#8b7cf6'; ctx.fillRect(px + CW / 2 - 0.5, RULER, 1, H);
  ctx.beginPath(); ctx.roundRect(px - 4, 3, CW + 8, RULER - 6, 4); ctx.fill();
  ctx.fillStyle = '#0b0918'; ctx.font = '600 10.5px "Cascadia Mono", Consolas, monospace'; ctx.textAlign = 'center';
  ctx.fillText(String(cur + 1), px + CW / 2, RULER / 2); ctx.textAlign = 'start';
}

export function Timeline() {
  const frames = useRef<HTMLDivElement>(null), cv = useRef<HTMLCanvasElement>(null), rows = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const tl = curTl(), len = curLen();
  const contentW = (Math.max(len, S.ui.frame + 1) + 120) * CW, contentH = RULER + tl.layers.length * RH;

  useLayoutEffect(() => {
    const f = frames.current!, c = cv.current!;
    c.style.width = `${f.clientWidth}px`; c.style.height = `${f.clientHeight}px`; c.style.marginBottom = `${-f.clientHeight}px`;
    paint(c, f.scrollLeft, f.scrollTop);
    // keep the playhead in view while playing / stepping
    const px = S.ui.frame * CW;
    if (px < f.scrollLeft || px + CW > f.scrollLeft + f.clientWidth) f.scrollLeft = Math.max(0, px - f.clientWidth / 3);
  });

  const onScroll = () => {
    const f = frames.current!;
    if (rows.current) rows.current.scrollTop = f.scrollTop;
    paint(cv.current!, f.scrollLeft, f.scrollTop);
  };

  const at = (e: { clientX: number; clientY: number }) => {
    const f = frames.current!, r = f.getBoundingClientRect();
    const x = e.clientX - r.left + f.scrollLeft, y = e.clientY - r.top;
    return { frame: Math.max(0, Math.floor(x / CW)), row: y < RULER ? -1 : Math.floor((y - RULER + f.scrollTop) / RH) };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget, { frame, row } = at(e);
    el.setPointerCapture(e.pointerId);
    const layer: Layer | undefined = tl.layers[row];
    let move: (m: PointerEvent) => void;
    if (row >= 0 && !layer) return;
    if (layer) setUI({ layerId: layer.id });
    const i = layer ? kfIndexAt(layer, frame) : -1;
    if (layer && !layer.locked && i > 0 && kfStart(layer, i) === frame) {
      // drag a keyframe left/right: one gesture = one undo step
      let cur = frame, first = true;
      setFrame(frame);
      move = m => {
        const d = at(m).frame - cur;
        if (!d) return;
        let applied = 0;
        mutate(() => { applied = moveKeyframe(layer, i, d); }, first);
        first = false; cur += applied; setUI({ frame: cur });
      };
    } else {
      setFrame(frame);
      move = m => { const f = at(m).frame; if (f !== S.ui.frame) setUI({ frame: f }); };
    }
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };

  const ctxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const { frame, row } = at(e), layer = tl.layers[row];
    if (!layer) return;
    setUI({ layerId: layer.id }); setFrame(frame);
    setUI({ ctxMenu: { x: e.clientX, y: e.clientY, items: FRAME_MENU } });
  };

  const toggle = (l: Layer, k: 'visible' | 'locked') => mutate(() => { l[k] = !l[k]; });
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    mutate(() => { const [l] = tl.layers.splice(from, 1); tl.layers.splice(to > from ? to - 1 : to, 0, l); });
  };
  const sec = (S.ui.frame / S.doc.fps).toFixed(2);

  return (
    <section className="timeline glass" aria-label="Timeline">
      <div className="tl-body">
        <div className="tl-layers">
          <div className="head">
            <button className="icon-btn" title="New layer" aria-label="New layer" onClick={() => run('addLayer')}><Plus size={14} /></button>
            <button className="icon-btn" title="Delete layer" aria-label="Delete layer" onClick={() => deleteLayer()}><Trash2 size={13} /></button>
            <span className="muted" style={{ flex: 1, fontSize: 11, paddingLeft: 6 }}>Layers</span>
          </div>
          <div className="rows" ref={rows}>
            {tl.layers.map((l, i) => (
              <div
                key={l.id} className={`layer-row ${l.id === S.ui.layerId ? 'active' : ''} ${dragOver === i ? 'drag-over' : ''}`}
                draggable={renaming !== l.id}
                onDragStart={e => { e.dataTransfer.setData('application/x-anobe-layer', String(i)); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={e => { if (e.dataTransfer.types.includes('application/x-anobe-layer')) { e.preventDefault(); setDragOver(i); } }}
                onDragLeave={() => setDragOver(null)}
                onDrop={e => { setDragOver(null); const from = Number(e.dataTransfer.getData('application/x-anobe-layer')); if (Number.isFinite(from)) reorder(from, i); }}
                onClick={() => setUI({ layerId: l.id })}
                onDoubleClick={() => setRenaming(l.id)}
              >
                <span className="chip" style={{ background: l.color }} />
                {renaming === l.id ? (
                  <input
                    className="input" autoFocus defaultValue={l.name} aria-label="Layer name"
                    onBlur={e => { const v = e.target.value.trim(); if (v && v !== l.name) mutate(() => { l.name = v; }); setRenaming(null); }}
                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); }}
                  />
                ) : <span className="nm">{l.name}</span>}
                <button className="icon-btn" title={l.visible ? 'Hide layer' : 'Show layer'} aria-label="Toggle visibility" onClick={e => { e.stopPropagation(); toggle(l, 'visible'); }}>
                  {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                </button>
                <button className="icon-btn" title={l.locked ? 'Unlock layer' : 'Lock layer'} aria-label="Toggle lock" aria-pressed={l.locked} onClick={e => { e.stopPropagation(); toggle(l, 'locked'); }}>
                  {l.locked ? <Lock size={13} /> : <LockOpen size={13} />}
                </button>
              </div>
            ))}
            <div style={{ height: 40 }} />
          </div>
        </div>
        <div className="tl-frames" ref={frames} onScroll={onScroll} onWheel={e => { if (e.shiftKey && frames.current) frames.current.scrollLeft += e.deltaY; }}>
          <canvas ref={cv} onPointerDown={down} onContextMenu={ctxMenu} aria-label="Frames" />
          <div style={{ width: contentW, height: contentH + 40 }} />
        </div>
      </div>
      <div className="transport">
        <button className="icon-btn" title="First frame (Home)" aria-label="First frame" onClick={() => run('firstFrame')}><SkipBack size={15} /></button>
        <button className="icon-btn" title="Previous frame (,)" aria-label="Previous frame" onClick={() => run('prevFrame')}><StepBack size={15} /></button>
        <button className="icon-btn" title="Play / Stop (Enter)" aria-label={S.ui.playing ? 'Stop' : 'Play'} aria-pressed={S.ui.playing} onClick={() => run('play')}>
          {S.ui.playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button className="icon-btn" title="Next frame (.)" aria-label="Next frame" onClick={() => run('nextFrame')}><StepForward size={15} /></button>
        <button className="icon-btn" title="Last frame (End)" aria-label="Last frame" onClick={() => run('lastFrame')}><SkipForward size={15} /></button>
        <span className="sep" />
        <button className="icon-btn" title="Loop playback" aria-label="Loop playback" aria-pressed={S.ui.loop} onClick={() => run('loop')}><Repeat size={14} /></button>
        <button className="icon-btn" title="Onion skin" aria-label="Onion skin" aria-pressed={S.ui.onion} onClick={() => run('onion')}><Layers size={14} /></button>
        <span className="sep" />
        <span className="stat">Frame <b>{S.ui.frame + 1}</b> / {len}</span>
        <span className="stat"><b>{sec}</b>s</span>
        <span className="grow" />
        <span className="stat">FPS</span>
        <input
          className="input fps" type="number" min={1} max={120} value={S.doc.fps} aria-label="Frames per second"
          onChange={e => { const v = Math.round(Number(e.target.value)); if (v >= 1 && v <= 120) { stopPlay(); mutate(d => { d.fps = v; }); } }}
        />
      </div>
    </section>
  );
}
