import { useLayoutEffect, useRef, useState } from 'react';
import { ImagePlus, Plus, Trash2 } from 'lucide-react';
import type { Doc, Timeline } from '../core/model.ts';
import { drawTimeline, timelineBounds } from '../render.ts';
import { S, mutate, toast } from '../store.ts';
import { run, symbolInstance } from '../commands.ts';
import { enterSymbol } from '../tools.ts';

const T = 40;

function SymbolThumb({ tl }: { tl: Timeline }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current!, dpr = devicePixelRatio, ctx = c.getContext('2d')!;
    c.width = c.height = T * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, T, T);
    const b = timelineBounds(S.doc, tl, 0);
    if (!b || b.w <= 0 || b.h <= 0) return;
    const k = Math.min((T - 6) / b.w, (T - 6) / b.h, 4);
    ctx.translate(T / 2 - (b.x + b.w / 2) * k, T / 2 - (b.y + b.h / 2) * k);
    ctx.scale(k, k);
    drawTimeline(ctx, S.doc, tl, 0);
  }, [S.docRev, tl]);
  return <canvas ref={ref} className="thumb" />;
}

/** Is a symbol / asset placed anywhere (main timeline or inside any symbol)? */
function inUse(doc: Doc, kind: 'symbol' | 'asset', id: string) {
  const tls = [doc.tl, ...Object.values(doc.symbols).filter(s => s.id !== id).map(s => s.tl)];
  return tls.some(tl => tl.layers.some(l => l.kfs.some(k => k.els.some(e =>
    kind === 'symbol' ? e.kind === 'symbol' && e.symbolId === id : e.kind === 'bitmap' && e.assetId === id))));
}

type Item = { kind: 'symbol' | 'asset'; id: string; name: string };

export function Library() {
  const [renaming, setRenaming] = useState<string | null>(null);
  const items: Item[] = [
    ...Object.values(S.doc.symbols).map(s => ({ kind: 'symbol' as const, id: s.id, name: s.name })),
    ...Object.values(S.doc.assets).map(a => ({ kind: 'asset' as const, id: a.id, name: a.name })),
  ];

  const rename = (it: Item, v: string) => {
    setRenaming(null);
    v = v.trim();
    if (!v || v === it.name) return;
    // assets are immutable (shared with undo snapshots): replace, never edit in place
    mutate(d => { if (it.kind === 'symbol') d.symbols[it.id].name = v; else d.assets[it.id] = { ...d.assets[it.id], name: v }; });
  };
  const remove = (it: Item) => {
    if (inUse(S.doc, it.kind, it.id) || S.ui.edit.some(e => e.symbolId === it.id)) return toast(`"${it.name}" is in use`);
    mutate(d => { if (it.kind === 'symbol') delete d.symbols[it.id]; else delete d.assets[it.id]; });
  };

  return (
    <section className="panel lib glass" aria-label="Library">
      <div className="panel-h">
        <h2>Library</h2>
        <button className="icon-btn" title="New symbol" aria-label="New symbol" onClick={() => run('newSymbol')}><Plus size={14} /></button>
        <button className="icon-btn" title="Import image (Ctrl+R)" aria-label="Import image" onClick={() => run('import')}><ImagePlus size={14} /></button>
      </div>
      <div className="panel-b lib-list">
        {!items.length && <div className="empty">No symbols yet.<br />Select artwork and press F8, or import an image.</div>}
        {items.map(it => {
          const a = it.kind === 'asset' ? S.doc.assets[it.id] : null;
          return (
            <div
              key={it.id} className="lib-item" draggable={renaming !== it.id} tabIndex={0}
              title={it.kind === 'symbol' ? 'Drag onto the stage · double-click to edit' : 'Drag onto the stage'}
              onDragStart={e => { e.dataTransfer.setData('application/x-anobe', JSON.stringify({ kind: it.kind, id: it.id })); e.dataTransfer.effectAllowed = 'copy'; }}
              onDoubleClick={() => it.kind === 'symbol' && enterSymbol(symbolInstance(it.id))}
            >
              {a ? <img className="thumb" src={a.src} alt="" style={{ objectFit: 'contain' }} /> : <SymbolThumb tl={S.doc.symbols[it.id].tl} />}
              <div className="meta">
                {renaming === it.id ? (
                  <input className="input" autoFocus defaultValue={it.name} aria-label="Name"
                    onBlur={e => rename(it, e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(null); }} />
                ) : <span className="name" onDoubleClick={e => { e.stopPropagation(); setRenaming(it.id); }}>{it.name}</span>}
                <span className="sub">{a ? `Bitmap · ${a.w}×${a.h}` : 'Symbol'}</span>
              </div>
              <button className="icon-btn" title="Delete" aria-label={`Delete ${it.name}`} onClick={() => remove(it)}><Trash2 size={13} /></button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
