// Small shared inputs: numeric field with label scrubbing, colour swatch, undo-coalescing edits.
import { useState, type ReactNode } from 'react';
import { mutate } from '../store.ts';
import { FONTS, type Doc, type TextStyle } from '../core/model.ts';

/** Property edits: repeats of the same key within 800 ms merge into one undo step (scrubs, typing, colour drags). */
let lastKey = '', lastT = 0;
export function edit(key: string, fn: (d: Doc) => void) {
  const now = performance.now(), first = key !== lastKey || now - lastT > 800;
  lastKey = key; lastT = now;
  mutate(fn, first);
}

const fmt = (v: number, digits: number) => String(Math.round(v * 10 ** digits) / 10 ** digits);

export function NumField(p: {
  label: ReactNode; value: number; onChange(v: number): void; step?: number; min?: number; max?: number; digits?: number; title?: string;
}) {
  const { step = 1, digits = 1 } = p;
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, v));
  const commit = () => {
    const v = parseFloat(text ?? '');
    if (Number.isFinite(v)) p.onChange(clamp(v));
    setText(null);
  };
  const scrub = (e: React.PointerEvent<HTMLLabelElement>) => {
    const el = e.currentTarget, x0 = e.clientX, v0 = p.value;
    el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => p.onChange(clamp(v0 + Math.round((m.clientX - x0) / 2) * step * (m.shiftKey ? 10 : 1)));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  return (
    <div className="field" title={p.title}>
      <label onPointerDown={scrub}>{p.label}</label>
      <input
        className="input" inputMode="decimal" aria-label={p.title}
        value={text ?? fmt(p.value, digits)}
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { commit(); e.currentTarget.blur(); }
          if (e.key === 'Escape') { setText(null); e.currentTarget.blur(); }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            p.onChange(clamp(p.value + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1))); setText(null);
          }
        }}
      />
    </div>
  );
}

/** Colour swatch over a native picker. Colours are #rrggbbaa; picking keeps the existing alpha. */
export function Swatch(p: { value: string | null; onChange(v: string): void; title: string; className?: string; onFocus?(): void }) {
  return (
    <div className={`swatch ${p.value ? '' : 'none'} ${p.className ?? ''}`} title={p.title} style={{ '--c': p.value ?? 'transparent' } as React.CSSProperties}>
      <span style={p.value ? { background: p.value } : undefined} />
      <input
        type="color" aria-label={p.title} value={(p.value ?? '#000000ff').slice(0, 7)}
        onFocus={p.onFocus} onClick={p.onFocus}
        onChange={e => p.onChange(e.target.value + ((p.value?.slice(7, 9)) || 'ff'))}
      />
    </div>
  );
}

export const alphaOf = (c: string | null) => (c ? parseInt(c.slice(7, 9) || 'ff', 16) / 255 : 1);
export const withAlpha = (c: string, a: number) => c.slice(0, 7) + Math.round(Math.min(1, Math.max(0, a)) * 255).toString(16).padStart(2, '0');

/** Font, size, bold, italic: the text tool's options and a selected text element's properties. */
export function FontFields({ v, set }: { v: TextStyle; set(p: Partial<TextStyle>): void }) {
  return <>
    <select className="select" aria-label="Font" value={v.font} onChange={e => set({ font: e.target.value })}>
      {Object.keys(FONTS).map(f => <option key={f}>{f}</option>)}
    </select>
    <NumField label="Size" title="Font size (px)" digits={0} min={1} max={2000} value={v.size} onChange={size => set({ size })} />
    <label className="check"><input type="checkbox" checked={v.bold} onChange={e => set({ bold: e.target.checked })} />Bold</label>
    <label className="check"><input type="checkbox" checked={v.italic} onChange={e => set({ italic: e.target.checked })} />Italic</label>
  </>;
}
