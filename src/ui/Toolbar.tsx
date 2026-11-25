import { useState } from 'react';
import {
  ArrowLeftRight, Ban, Brush, Circle, Eraser, Hand, MousePointer2, PaintBucket, PenTool, Pencil, Pipette, Scaling, Slash, Spline, Square, Type, ZoomIn,
} from 'lucide-react';
import { S, setUI, type ToolId } from '../store.ts';
import { setTool } from '../tools.ts';
import { Swatch } from './controls.tsx';

export const TOOL_LIST: [ToolId, string, string, typeof Brush][] = [
  ['select', 'Selection', 'V', MousePointer2], ['sub', 'Subselection', 'A', Spline], ['transform', 'Free Transform', 'Q', Scaling],
  ['pen', 'Pen', 'P', PenTool], ['pencil', 'Pencil', 'Y', Pencil], ['brush', 'Brush', 'B', Brush],
  ['line', 'Line', 'N', Slash], ['rect', 'Rectangle', 'R', Square], ['oval', 'Oval', 'O', Circle], ['text', 'Text', 'T', Type],
  ['bucket', 'Paint Bucket (Shift: stroke)', 'K', PaintBucket], ['dropper', 'Eyedropper', 'I', Pipette], ['eraser', 'Eraser', 'E', Eraser],
  ['hand', 'Hand (hold Space)', 'H', Hand], ['zoom', 'Zoom (Alt: out)', 'Z', ZoomIn],
];
const BREAKS = new Set(['transform', 'text', 'eraser']);

export function Toolbar() {
  const [active, setActive] = useState<'fill' | 'stroke'>('fill');
  const { tool, fill, stroke } = S.ui;
  return (
    <nav className="toolbar glass" aria-label="Tools">
      {TOOL_LIST.map(([id, name, key, Icon]) => (
        <span key={id} style={{ display: 'contents' }}>
          <button className="tool" aria-pressed={tool === id} title={`${name} (${key})`} aria-label={name} onClick={() => setTool(id)}>
            <Icon size={18} strokeWidth={1.75} />
          </button>
          {BREAKS.has(id) && <hr />}
        </span>
      ))}
      <hr />
      <div className="fillstroke">
        <Swatch className="stroke-sw" title="Stroke colour" value={stroke} onFocus={() => setActive('stroke')} onChange={v => setUI({ stroke: v })} />
        <Swatch className="fill-sw" title="Fill colour" value={fill} onFocus={() => setActive('fill')} onChange={v => setUI({ fill: v })} />
      </div>
      <div className="tiny-row">
        <button className="icon-btn" title="Swap fill and stroke" aria-label="Swap fill and stroke" onClick={() => setUI({ fill: stroke, stroke: fill })}>
          <ArrowLeftRight size={13} />
        </button>
        <button className="icon-btn" title={`No ${active}`} aria-label={`No ${active}`} onClick={() => setUI({ [active]: null })}>
          <Ban size={13} />
        </button>
      </div>
    </nav>
  );
}
