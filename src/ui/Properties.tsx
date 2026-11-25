import { Ban, Box, Image as ImageIcon, PenLine, Shapes, Type } from 'lucide-react';
import { EASES, ease, kfIndexAt, kfStart, type El, type Tween } from '../core/model.ts';
import { unionRect } from '../core/geom.ts';
import { parentBounds } from '../render.ts';
import { S, curLayer, editSel, mutate, shownSel } from '../store.ts';
import { run } from '../commands.ts';
import { enterSymbol, isSymbol } from '../tools.ts';
import { FontFields, NumField, Swatch, alphaOf, edit, withAlpha } from './controls.tsx';

const KIND = { shape: ['Shape', Shapes], symbol: ['Symbol', Box], bitmap: ['Bitmap', ImageIcon], text: ['Text', Type] } as const;
/** Edit every selected element (auto-keys tweened frames). */
const each = (key: string, fn: (el: El) => void) => edit(key, () => editSel().forEach(({ el }) => fn(el)));

function ColorRow(p: { label: string; value: string | null; set(v: string | null): void }) {
  return (
    <div className="line">
      <span className="lbl">{p.label}</span>
      <Swatch title={p.label} value={p.value} onChange={v => p.set(v)} />
      <NumField label="%" title={`${p.label} opacity`} digits={0} min={0} max={100} value={alphaOf(p.value) * 100}
        onChange={v => p.value && p.set(withAlpha(p.value, v / 100))} />
      <button className="icon-btn" title={`No ${p.label.toLowerCase()}`} aria-label={`No ${p.label.toLowerCase()}`} onClick={() => p.set(null)}><Ban size={13} /></button>
    </div>
  );
}

function ElementProps() {
  const sel = shownSel(), first = sel[0].el;
  const b = unionRect(sel.map(s => parentBounds(S.doc, s.el, s.age)).filter(r => r !== null)) ?? { x: first.tf.x, y: first.tf.y, w: 0, h: 0 };
  const same = sel.every(s => s.el.kind === first.kind);
  const [kname, KIcon] = same ? KIND[first.kind] : ['Mixed', Shapes] as const;
  const resize = (axis: 'w' | 'h', v: number) => {
    const old = axis === 'w' ? b.w : b.h;
    if (old > 0 && v > 0) each('size' + axis, el => { const k = axis === 'w' ? 'sx' : 'sy'; el.tf[k] *= v / old; });
  };
  return (
    <>
      <div className="sec">
        <h3><span className="kind"><KIcon size={12} />{kname}{sel.length > 1 ? ` ×${sel.length}` : ''}</span></h3>
        <div className="grid2">
          <NumField label="X" title="X" value={b.x} onChange={v => each('x', el => { el.tf.x += v - b.x; })} />
          <NumField label="Y" title="Y" value={b.y} onChange={v => each('y', el => { el.tf.y += v - b.y; })} />
          {sel.length === 1 && <NumField label="W" title="Width" min={0.1} value={b.w} onChange={v => resize('w', v)} />}
          {sel.length === 1 && <NumField label="H" title="Height" min={0.1} value={b.h} onChange={v => resize('h', v)} />}
          <NumField label="R°" title="Rotation" value={first.tf.r} onChange={v => each('r', el => { el.tf.r = v; })} />
          <NumField label="α%" title="Opacity" digits={0} min={0} max={100} value={first.alpha * 100} onChange={v => each('alpha', el => { el.alpha = v / 100; })} />
        </div>
      </div>
      {same && first.kind === 'shape' && (
        <div className="sec">
          <h3>Fill &amp; stroke</h3>
          <ColorRow label="Fill" value={first.fill} set={v => each('fill', el => { if (el.kind === 'shape') el.fill = v; })} />
          <ColorRow label="Stroke" value={first.stroke} set={v => each('stroke', el => { if (el.kind === 'shape') el.stroke = v; })} />
          <NumField label="SW" title="Stroke width" min={0} max={400} value={first.sw} onChange={v => each('sw', el => { if (el.kind === 'shape') el.sw = v; })} />
        </div>
      )}
      {same && isSymbol(first) && (
        <div className="sec">
          <h3>Symbol · {S.doc.symbols[first.symbolId]?.name}</h3>
          <div className="line">
            <span className="lbl">Looping</span>
            <select className="select" value={first.loop} aria-label="Looping"
              onChange={e => each('loop', el => { if (el.kind === 'symbol') el.loop = e.target.value as typeof first.loop; })}>
              <option value="loop">Loop</option><option value="once">Play once</option><option value="single">Single frame</option>
            </select>
          </div>
          <NumField label="First" title="First frame" digits={0} min={1} value={first.first + 1}
            onChange={v => each('first', el => { if (el.kind === 'symbol') el.first = Math.round(v) - 1; })} />
          {sel.length === 1 && <button className="btn" onClick={() => enterSymbol(first)}><PenLine size={14} />Edit symbol</button>}
        </div>
      )}
      {same && first.kind === 'text' && (
        <div className="sec">
          <h3>Text</h3>
          <div className="line" style={{ flexWrap: 'wrap' }}>
            <FontFields v={first} set={p => each('font' + Object.keys(p)[0], el => { if (el.kind === 'text') Object.assign(el, p); })} />
          </div>
          <ColorRow label="Fill" value={first.fill} set={v => each('tfill', el => { if (el.kind === 'text' && v) el.fill = v; })} />
        </div>
      )}
      {same && first.kind === 'bitmap' && (
        <div className="sec"><h3>Bitmap</h3><span className="muted">{S.doc.assets[first.assetId]?.name ?? 'Missing image'}</span></div>
      )}
    </>
  );
}

function DocProps() {
  const e = S.ui.edit.at(-1), sym = e && S.doc.symbols[e.symbolId];
  return (
    <div className="sec">
      <h3>{sym ? 'Symbol' : 'Document'}</h3>
      {sym && (
        <div className="line">
          <span className="lbl">Name</span>
          <input className="input" key={sym.id} defaultValue={sym.name} aria-label="Symbol name"
            onBlur={ev => { const v = ev.target.value.trim(); if (v && v !== sym.name) mutate(d => { d.symbols[sym.id].name = v; }); }}
            onKeyDown={ev => { if (ev.key === 'Enter') ev.currentTarget.blur(); }} />
        </div>
      )}
      <div className="grid2">
        <NumField label="W" title="Stage width" digits={0} min={1} max={8192} value={S.doc.w} onChange={v => edit('docw', d => { d.w = Math.round(v); })} />
        <NumField label="H" title="Stage height" digits={0} min={1} max={8192} value={S.doc.h} onChange={v => edit('doch', d => { d.h = Math.round(v); })} />
        <NumField label="FPS" title="Frames per second" digits={0} min={1} max={120} value={S.doc.fps} onChange={v => edit('fps', d => { d.fps = Math.round(v); })} />
      </div>
      <div className="line">
        <span className="lbl">Stage</span>
        <Swatch title="Stage colour" value={S.doc.bg} onChange={v => edit('bg', d => { d.bg = v; })} />
      </div>
    </div>
  );
}

/** Ease curve preview; with 'custom' the two bezier handles are draggable. */
function EaseEditor({ tw }: { tw: Tween }) {
  const X = (t: number) => 10 + t * 140, Y = (v: number) => 82 - v * 64;
  const pts = Array.from({ length: 49 }, (_, i) => `${X(i / 48)},${Y(ease(tw, i / 48))}`).join(' ');
  const custom = tw.ease === 'custom', [x1, y1, x2, y2] = tw.bez;
  const drag = (h: 0 | 1) => (e: React.PointerEvent<SVGCircleElement>) => {
    const svg = e.currentTarget.ownerSVGElement!, el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, ((m.clientX - r.left) / r.width * 160 - 10) / 140));
      const v = Math.min(1.6, Math.max(-0.6, (82 - (m.clientY - r.top) / r.height * 100) / 64));
      edit('bez', () => { tw.bez[h * 2] = t; tw.bez[h * 2 + 1] = v; });
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  return (
    <svg className="ease-svg" viewBox="0 0 160 100" role="img" aria-label="Ease curve">
      <rect x={X(0)} y={Y(1)} width={140} height={64} fill="none" stroke="rgb(255 255 255 / 0.08)" />
      {custom && <>
        <line x1={X(0)} y1={Y(0)} x2={X(x1)} y2={Y(y1)} stroke="#a99cff" strokeWidth={1} />
        <line x1={X(1)} y1={Y(1)} x2={X(x2)} y2={Y(y2)} stroke="#a99cff" strokeWidth={1} />
      </>}
      <polyline points={pts} fill="none" stroke="#8b7cf6" strokeWidth={2} strokeLinejoin="round" />
      {custom && <>
        <circle cx={X(x1)} cy={Y(y1)} r={5} fill="#fafafa" onPointerDown={drag(0)} />
        <circle cx={X(x2)} cy={Y(y2)} r={5} fill="#fafafa" onPointerDown={drag(1)} />
      </>}
    </svg>
  );
}

function FrameProps() {
  const l = curLayer(), i = l ? kfIndexAt(l, S.ui.frame) : -1;
  if (!l || i < 0) return null;
  const kf = l.kfs[i], start = kfStart(l, i), tw = kf.tween;
  return (
    <div className="sec">
      <h3>Frames {start + 1}–{start + kf.dur} · {l.name}</h3>
      {tw && l.kfs[i + 1] ? (
        <>
          <div className="line">
            <span className="lbl">Ease</span>
            <select className="select" value={tw.ease} aria-label="Ease" onChange={e => edit('ease', () => { tw.ease = e.target.value; })}>
              {Object.keys(EASES).map(k => <option key={k} value={k}>{k}</option>)}
              <option value="custom">custom (bezier)</option>
            </select>
          </div>
          <EaseEditor tw={tw} />
          <NumField label="Spin" title="Extra full turns (negative = counter-clockwise)" digits={0} value={tw.spin} onChange={v => edit('spin', () => { tw.spin = Math.round(v); })} />
          <button className="btn ghost" onClick={() => run('removeTween')}>Remove tween</button>
        </>
      ) : l.kfs[i + 1] ? (
        <button className="btn" onClick={() => run('createTween')}>Create tween</button>
      ) : <span className="muted">Add a later keyframe (F6) to tween into.</span>}
    </div>
  );
}

export function Properties() {
  const has = shownSel().length > 0;
  return (
    <section className="panel props glass" aria-label="Properties">
      <div className="panel-h"><h2>Properties</h2></div>
      <div className="panel-b">
        {has ? <ElementProps /> : <DocProps />}
        <FrameProps />
      </div>
    </section>
  );
}
