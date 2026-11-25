// Context options bar above the stage: settings for the active tool.
import type { ReactNode } from 'react';
import { S, setUI } from '../store.ts';
import { NumField } from './controls.tsx';
import { TOOL_LIST } from './Toolbar.tsx';

type UI = typeof S.ui;
const pct = (k: 'thinning' | 'smoothing', label: string, title: string, disabled = false) => (
  <span className={disabled ? 'off' : ''}>
    <NumField label={label} title={title} digits={0} min={0} max={100} value={S.ui[k] * 100} onChange={v => setUI({ [k]: v / 100 })} />
  </span>
);
const num = (k: 'sw' | 'brush' | 'radius' | 'eraser', label: string, title: string, min: number, max: number) =>
  <NumField label={label} title={title} digits={k === 'sw' ? 1 : 0} min={min} max={max} value={S.ui[k]} onChange={v => setUI({ [k]: v })} />;
const check = (k: 'pressure' | 'snap', label: string) => (
  <label className="check"><input type="checkbox" checked={S.ui[k]} onChange={e => setUI({ [k]: e.target.checked })} />{label}</label>
);

// Remembered colours so the Fill / Stroke checkboxes can turn a colour back on.
const last: Pick<UI, 'fill' | 'stroke'> = { fill: S.ui.fill ?? '#8b7cf6ff', stroke: S.ui.stroke ?? '#18181bff' };
const paint = (k: 'fill' | 'stroke', label: string) => (
  <label className="check">
    <input type="checkbox" checked={S.ui[k] !== null} onChange={e => {
      if (!e.target.checked) last[k] = S.ui[k];
      setUI({ [k]: e.target.checked ? last[k] : null });
    }} />{label}
  </label>
);
const hint = (t: string) => <span className="hint">{t}</span>;
const width = () => num('sw', 'Width', 'Stroke width', 0, 400);

const OPTIONS: Partial<Record<UI['tool'], () => ReactNode>> = {
  select: () => <>{check('snap', 'Snap to stage')}{hint('Shift: lock axis · double-click symbol to edit')}</>,
  transform: () => <>
    {check('snap', 'Snap to stage')}
    <label className="check">Shift-rotate step
      <select className="select" value={S.ui.rotSnap} aria-label="Rotate snap step" onChange={e => setUI({ rotSnap: Number(e.target.value) })}>
        {[1, 5, 15, 30, 45, 90].map(d => <option key={d} value={d}>{d}°</option>)}
      </select>
    </label>
    {hint('Alt: scale from pivot')}
  </>,
  sub: () => hint('Drag nodes and handles · Alt-click node: corner ⇄ smooth · Alt-drag handle: break'),
  pen: () => <>{width()}{paint('fill', 'Fill when closed')}{paint('stroke', 'Stroke')}{hint('Click: corner · drag: curve · click first node to close · Enter: finish')}</>,
  pencil: () => <>{width()}{pct('smoothing', 'Smooth', 'Smoothing %')}</>,
  brush: () => <>
    {num('brush', 'Size', 'Brush size', 1, 400)}
    {pct('thinning', 'Thin', 'Thinning % (width change with pressure/speed)', !S.ui.pressure)}
    {pct('smoothing', 'Smoothing', 'Smoothing % (steadies the stroke, like Animate)')}
    {check('pressure', 'Pressure')}
  </>,
  line: () => <>{width()}{hint('Shift: 45° steps')}</>,
  rect: () => <>{width()}{num('radius', 'Corner', 'Corner radius', 0, 2000)}{paint('fill', 'Fill')}{paint('stroke', 'Stroke')}{hint('Shift: square · Alt: from centre')}</>,
  oval: () => <>{width()}{paint('fill', 'Fill')}{paint('stroke', 'Stroke')}{hint('Shift: circle · Alt: from centre')}</>,
  bucket: () => hint('Click: fill colour · Shift-click: stroke colour'),
  dropper: () => hint('Click a shape to pick its fill, stroke and width'),
  eraser: () => <>{num('eraser', 'Size', 'Eraser radius (screen px)', 1, 200)}{hint('Erases whole shapes the circle touches')}</>,
  hand: () => hint('Drag to pan · hold Space with any tool'),
  zoom: () => hint('Click: zoom in · Alt-click: zoom out · Ctrl+wheel anywhere'),
};

export function ToolOptions() {
  const t = TOOL_LIST.find(x => x[0] === S.ui.tool)!, [, name, , Icon] = t;
  return (
    <div className="tool-opts glass" role="toolbar" aria-label={`${name} options`}>
      <span className="name"><Icon size={14} />{name}</span>
      {OPTIONS[S.ui.tool]?.()}
    </div>
  );
}
