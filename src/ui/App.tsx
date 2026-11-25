import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MENUS, run } from '../commands.ts';
import { Cancelled, exportAnim, type ExportKind } from '../exporter.ts';
import { S, api, setUI, toast, useApp, type MenuItem } from '../store.ts';
import { Library } from './Library.tsx';
import { Properties } from './Properties.tsx';
import { Stage } from './Stage.tsx';
import { Timeline } from './Timeline.tsx';
import { ToolOptions } from './ToolOptions.tsx';
import { Toolbar } from './Toolbar.tsx';

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
      <span className="logo"><i />Anobe</span>
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

const KINDS: [ExportKind, string][] = [['gif', 'GIF'], ['png', 'PNG seq'], ['mp4', 'MP4'], ['webm', 'WebM']];

function ExportDialog() {
  const [kind, setKind] = useState<ExportKind>('gif');
  const [scale, setScale] = useState(1);
  const [transparent, setTransparent] = useState(false);
  const [prog, setProg] = useState<number | null>(null);
  const cancel = useRef(false);
  const close = () => { if (prog === null) setUI({ exportOpen: false }); else cancel.current = true; };
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  const go = async () => {
    if (!api) return toast('Export needs the desktop app (npm start)');
    cancel.current = false; setProg(0);
    try {
      const path = await exportAnim(S.doc, { kind, scale, transparent: transparent && kind !== 'mp4' }, setProg, () => cancel.current);
      if (path) { toast(`Exported ${path}`); setUI({ exportOpen: false }); }
    } catch (e) {
      toast(e instanceof Cancelled ? 'Export cancelled' : `Export failed: ${(e as Error).message}`);
    } finally { setProg(null); }
  };
  return (
    <div className="modal-back" onPointerDown={e => e.target === e.currentTarget && close()}>
      <div className="modal glass" role="dialog" aria-modal="true" aria-labelledby="exp-h">
        <h2 id="exp-h">Export animation</h2>
        <div className="seg" role="group" aria-label="Format">
          {KINDS.map(([k, l]) => <button key={k} aria-pressed={kind === k} disabled={prog !== null} onClick={() => setKind(k)}>{l}</button>)}
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
        {prog !== null && <div className="progress" role="progressbar" aria-valuenow={Math.round(prog * 100)}><div style={{ width: `${prog * 100}%` }} /></div>}
        <div className="actions">
          <button className="btn ghost" onClick={close}>{prog === null ? 'Close' : 'Cancel'}</button>
          <button className="btn primary" disabled={prog !== null} onClick={go}>{prog === null ? 'Export' : `${Math.round(prog * 100)}%`}</button>
        </div>
      </div>
    </div>
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
      {S.ui.toast && <div className="toast" role="status">{S.ui.toast}</div>}
    </div>
  );
}
