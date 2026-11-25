// Export the scene timeline to GIF, PNG sequence, MP4 or WebM.
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { tlLen, type Doc } from './core/model.ts';
import { preloadImages, renderFrame } from './render.ts';
import { api } from './store.ts';
import { zip } from './zip.ts';

export type ExportKind = 'gif' | 'png' | 'mp4' | 'webm';
export type ExportOpts = { kind: ExportKind; scale: number; transparent: boolean };
export class Cancelled extends Error {}

const tick = () => new Promise(r => setTimeout(r)); // let the progress bar paint
/** Browser builds have no file system: hand the file to the browser as a download. */
function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Returns the written path (desktop) or downloaded name (browser), or null if the user cancelled the save dialog. */
export async function exportAnim(doc: Doc, o: ExportOpts, progress: (p: number) => void, cancelled: () => boolean): Promise<string | null> {
  if (!api && (o.kind === 'mp4' || o.kind === 'webm')) throw new Error('Video export needs the desktop app');
  const path = api ? await api.pickExportPath(o.kind) : `animation.${o.kind === 'png' ? 'zip' : 'gif'}`;
  if (!path) return null;
  await preloadImages(doc);
  const n = tlLen(doc.tl), alpha = o.transparent && o.kind !== 'mp4';
  const frame = (f: number) => renderFrame(doc, f, o.scale, alpha);
  const step = async (i: number) => { progress((i + 1) / n); await tick(); if (cancelled()) throw new Cancelled(); };

  if (o.kind === 'png') {
    const base = path.replace(/\.(png|zip)$/i, ''), files: [string, Uint8Array][] = [];
    for (let f = 0; f < n; f++) {
      const name = `${base}_${String(f + 1).padStart(4, '0')}.png`;
      const bytes = new Uint8Array(await (await frame(f).canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      if (api) await api.writeFile(name, bytes); else files.push([name, bytes]);
      await step(f);
    }
    if (!api) download(zip(files), path);
    return path;
  }

  if (o.kind === 'gif') {
    const gif = GIFEncoder(), delay = Math.round(1000 / doc.fps);
    for (let f = 0; f < n; f++) {
      const { canvas, ctx } = frame(f), { width: w, height: h } = canvas;
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const format = alpha ? 'rgba4444' : 'rgb565';
      const palette = quantize(rgba, 256, { format, oneBitAlpha: alpha });
      const index = applyPalette(rgba, palette, format);
      const ti = alpha ? palette.findIndex((c: number[]) => c[3] === 0) : -1;
      gif.writeFrame(index, w, h, { palette, delay, transparent: ti >= 0, transparentIndex: Math.max(0, ti) });
      await step(f);
    }
    gif.finish();
    if (api) await api.writeFile(path, gif.bytes()); else download(new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: 'image/gif' }), path);
    return path;
  }

  if (!api) throw new Error('Video export needs the desktop app');
  const first = frame(0).canvas;
  const id = await api.videoStart({ path, w: first.width, h: first.height, fps: doc.fps, format: o.kind, alpha });
  try {
    for (let f = 0; f < n; f++) {
      const { canvas, ctx } = frame(f);
      await api.videoFrame(id, new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer));
      await step(f);
    }
    await api.videoEnd(id);
  } catch (e) { await api.videoAbort(id); throw e; }
  return path;
}
