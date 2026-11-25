import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { MENUS, newFile, run } from '../commands.ts';
import { NumField } from './controls.tsx';
import { Cancelled, exportAnim, type ExportKind } from '../exporter.ts';
import { S, api, setUI, toast, useApp, type MenuItem } from '../store.ts';
import { Library } from './Library.tsx';
import { Properties } from './Properties.tsx';
import { Stage } from './Stage.tsx';
import { Timeline } from './Timeline.tsx';
import { ToolOptions } from './ToolOptions.tsx';
import { Toolbar } from './Toolbar.tsx';

/** Logo diamond turning around a still play triangle (index.html has a copy for the boot splash). */
function Spinner({ size }: { size: number }) {
  const g = useId().replace(/\W/g, ''), url = `url(#${g})`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs><linearGradient id={g} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c4baff" /><stop offset="1" stopColor="#8b7cf6" /></linearGradient></defs>
      <path className="spin" d="M50 16 L84 50 L50 84 L16 50 Z" fill={url} stroke={url} strokeWidth="6" strokeLinejoin="round" />
      <path d="M44 38 L62 50 L44 62 Z" fill="#0c0c12" stroke="#0c0c12" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}

/** Close on any pointerdown outside `ref`. */
function useOutside(ref: React.RefObject<HTMLElement | null>, on: boolean, close: () => void) {
  useEffect(() => {
    if (!on) return;
    const f = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    window.addEventListener('pointerdown', f, true);
    return () => window.removeEventListener('pointerdown', f, true);
  }, [on]);
}

function Items({ items, done }: { items: MenuItem[]; done(): void }) {
  return items.map((m, i) => m.sep ? <div key={i} className="menu-sep" role="separator" /> : (
    <button key={i} className="menu-item" role="menuitem" disabled={m.disabled} onClick={() => { done(); if (m.cmd) run(m.cmd); }}>
      <span>{m.label}</span>{m.key && <span className="kbd">{m.key}</span>}
    </button>
  ));
}

function Menubar() {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, !!open, () => setOpen(null));
  const name = S.ui.filePath?.split(/[\\/]/).pop() ?? 'Untitled';
  return (
    <header className="menubar" ref={ref}>
      <span className="logo"><img src="./logo.svg" alt="" width={18} height={18} />Anobe</span>
      {Object.entries(MENUS).map(([title, items]) => (
        <div key={title} style={{ position: 'relative' }}>
          <button className="menu-btn" aria-haspopup="menu" aria-expanded={open === title}
            onClick={() => setOpen(open === title ? null : title)} onPointerEnter={() => open && setOpen(title)}>{title}</button>
          {open === title && <div className="menu-pop glass" role="menu"><Items items={items} done={() => setOpen(null)} /></div>}
        </div>
      ))}
      <span className="title"><b>{name}</b>{S.ui.dirty ? ' •' : ''}</span>
    </header>
  );
}

function ContextMenu() {
  const m = S.ui.ctxMenu, ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const close = () => setUI({ ctxMenu: null });
  useOutside(ref, !!m, close);
  useLayoutEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(m.x, innerWidth - r.width - 6), y: Math.min(m.y, innerHeight - r.height - 6) });
  }, [m]);
  if (!m) return null;
  return (
    <div ref={ref} className="ctx glass" role="menu" style={{ position: 'fixed', left: pos.x, top: pos.y }} onContextMenu={e => e.preventDefault()}>
      <Items items={m.items} done={close} />
    </div>
  );
}

/** Dialog shell: Escape or a click on the backdrop calls `close`. */
function Modal({ title, close, children }: { title: string; close(): void; children: React.ReactNode }) {
  const id = useId();
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  return (
    <div className="modal-back" onPointerDown={e => e.target === e.currentTarget && close()}>
      <div className="modal glass" role="dialog" aria-modal="true" aria-labelledby={id}>
        <h2 id={id}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

const PRESETS: [string, number, number][] = [
  ['HD 1280×720', 1280, 720], ['Full HD 1920×1080', 1920, 1080], ['4K 3840×2160', 3840, 2160],
  ['Square 1080×1080', 1080, 1080], ['Portrait 1080×1920', 1080, 1920],
];

function NewDialog() {
  const [w, setW] = useState(S.doc.w), [h, setH] = useState(S.doc.h), [fps, setFps] = useState(S.doc.fps);
  const close = () => setUI({ newOpen: false });
  const preset = PRESETS.find(p => p[1] === w && p[2] === h);
  return (
    <Modal title="New animation" close={close}>
      <div className="line">
        <span className="lbl">Size</span>
        <select className="select" aria-label="Size preset" value={preset?.[0] ?? ''} onChange={e => {
          const p = PRESETS.find(p => p[0] === e.target.value);
          if (p) { setW(p[1]); setH(p[2]); }
        }}>
          {!preset && <option value="">Custom</option>}
          {PRESETS.map(([n]) => <option key={n}>{n}</option>)}
        </select>
      </div>
      <div className="line">
        <NumField label="W" title="Width (px)" digits={0} min={1} max={8192} value={w} onChange={v => setW(Math.round(v))} />
        <NumField label="H" title="Height (px)" digits={0} min={1} max={8192} value={h} onChange={v => setH(Math.round(v))} />
        <NumField label="FPS" title="Frames per second" digits={0} min={1} max={120} value={fps} onChange={v => setFps(Math.round(v))} />
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={close}>Cancel</button>
        <button className="btn primary" autoFocus onClick={() => newFile(w, h, fps)}>Create</button>
      </div>
    </Modal>
  );
}

const KINDS: [ExportKind, string][] = [['gif', 'GIF'], ['png', 'PNG seq'], ['mp4', 'MP4'], ['webm', 'WebM']];

function ExportDialog() {
  const [kind, setKind] = useState<ExportKind>('gif');
  const [scale, setScale] = useState(1);
  const [transparent, setTransparent] = useState(false);
  const [prog, setProg] = useState<number | null>(null);
  const cancel = useRef(false);
  const close = () => { if (prog === null) setUI({ exportOpen: false }); else cancel.current = true; };
  const go = async () => {
    cancel.current = false; setProg(0);
    try {
      const path = await exportAnim(S.doc, { kind, scale, transparent: transparent && kind !== 'mp4' }, setProg, () => cancel.current);
      if (path) { toast(`Exported ${path}`); setUI({ exportOpen: false }); }
    } catch (e) {
      toast(e instanceof Cancelled ? 'Export cancelled' : `Export failed: ${(e as Error).message}`);
    } finally { setProg(null); }
  };
  return (
    <Modal title="Export animation" close={close}>
        <div className="seg" role="group" aria-label="Format">
          {KINDS.map(([k, l]) => {
            const desktopOnly = !api && (k === 'mp4' || k === 'webm');
            return <button key={k} aria-pressed={kind === k} disabled={prog !== null || desktopOnly} title={desktopOnly ? 'Needs the desktop app' : undefined} onClick={() => setKind(k)}>{l}</button>;
          })}
        </div>
        <div className="line">
          <span className="lbl">Scale</span>
          <select className="select" value={scale} disabled={prog !== null} aria-label="Scale" onChange={e => setScale(Number(e.target.value))}>
            {[0.25, 0.5, 1, 2].map(s => <option key={s} value={s}>{s * 100}% · {Math.round(S.doc.w * s)}×{Math.round(S.doc.h * s)}</option>)}
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={transparent && kind !== 'mp4'} disabled={kind === 'mp4' || prog !== null} onChange={e => setTransparent(e.target.checked)} />
          Transparent background{kind === 'mp4' ? ' (not in MP4)' : ''}
        </label>
        {prog !== null && <div className="line">
          <Spinner size={22} />
          <div className="progress" style={{ flex: 1 }} role="progressbar" aria-valuenow={Math.round(prog * 100)}><div style={{ width: `${prog * 100}%` }} /></div>
        </div>}
        <div className="actions">
          <button className="btn ghost" onClick={close}>{prog === null ? 'Close' : 'Cancel'}</button>
          <button className="btn primary" disabled={prog !== null} onClick={go}>{prog === null ? 'Export' : `${Math.round(prog * 100)}%`}</button>
        </div>
    </Modal>
  );
}

export function App() {
  useApp();
  return (
    <div className="app">
      <Menubar />
      <Toolbar />
      <ToolOptions />
      <Stage />
      <Timeline />
      <aside className="side">
        <Properties />
        <Library />
      </aside>
      <ContextMenu />
      {S.ui.exportOpen && <ExportDialog />}
      {S.ui.newOpen && <NewDialog />}
      {(S.ui.busy || S.ui.toast) && <div className="toast" role="status">{S.ui.busy && <Spinner size={16} />}{S.ui.busy || S.ui.toast}</div>}
    </div>
  );
}
