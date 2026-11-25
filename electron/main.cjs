// Electron main process: window, file dialogs, file IO and ffmpeg video encoding.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

let win = null;
let dirty = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 960, minHeight: 600,
    backgroundColor: '#09090b', title: 'AnobeAnimate', show: false, icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e4e4e7', height: 36 },
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  const dev = process.env.ANOBE_DEV_URL;
  if (dev) win.loadURL(dev); else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // The app never navigates or opens popups.
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', e => {
    if (!dirty) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Discard changes', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'You have unsaved changes.', detail: 'Close AnobeAnimate and discard them?',
    });
    if (r === 1) e.preventDefault();
  });
}

// ---------- files ----------
const PROJECT = [{ name: 'AnobeAnimate project', extensions: ['anobe', 'json'] }];
const EXPORT_FILTERS = {
  gif: [{ name: 'Animated GIF', extensions: ['gif'] }],
  png: [{ name: 'PNG sequence (name_0001.png …)', extensions: ['png'] }],
  mp4: [{ name: 'MP4 video (H.264)', extensions: ['mp4'] }],
  webm: [{ name: 'WebM video (VP9)', extensions: ['webm'] }],
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

ipcMain.handle('openProject', async () => {
  const r = await dialog.showOpenDialog(win, { filters: PROJECT, properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], text: await fs.readFile(r.filePaths[0], 'utf8') };
});
ipcMain.handle('saveProject', async (_e, p, text) => {
  if (!p) {
    const r = await dialog.showSaveDialog(win, { filters: PROJECT, defaultPath: 'Untitled.anobe' });
    if (r.canceled || !r.filePath) return null;
    p = r.filePath;
  }
  const tmp = `${p}.tmp`; // write then rename so a crash never leaves a half-written project
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, p);
  return p;
});
ipcMain.handle('openImages', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Images', extensions: Object.keys(MIME) }], properties: ['openFile', 'multiSelections'] });
  if (r.canceled) return [];
  return Promise.all(r.filePaths.map(async f => {
    const ext = path.extname(f).slice(1).toLowerCase();
    return { name: path.basename(f), dataUrl: `data:${MIME[ext] ?? 'application/octet-stream'};base64,${(await fs.readFile(f)).toString('base64')}` };
  }));
});
// Only paths the user picked in a save dialog may be written to.
const writable = new Set();
ipcMain.handle('pickExportPath', async (_e, kind) => {
  const r = await dialog.showSaveDialog(win, { filters: EXPORT_FILTERS[kind], defaultPath: `animation.${kind}` });
  if (r.canceled || !r.filePath) return null;
  writable.add(r.filePath);
  return r.filePath;
});
function checkWritable(p) {
  // PNG sequences write name_0001.png etc. next to the picked name.
  const ok = writable.has(p) || [...writable].some(w => w.toLowerCase().endsWith('.png') && p.startsWith(w.slice(0, -4) + '_') && /_\d{4}\.png$/i.test(p));
  if (!ok) throw new Error('Path was not chosen by the user');
}
ipcMain.handle('writeFile', async (_e, p, data) => { checkWritable(p); await fs.writeFile(p, Buffer.from(data)); });

// ---------- video (raw RGBA frames piped into ffmpeg) ----------
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const jobs = new Map();
let jobSeq = 0;
ipcMain.handle('videoStart', (_e, o) => {
  checkWritable(o.path);
  const even = 'pad=ceil(iw/2)*2:ceil(ih/2)*2';
  const codec = o.format === 'mp4'
    ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-vf', even, '-movflags', '+faststart']
    : ['-c:v', 'libvpx-vp9', '-pix_fmt', o.alpha ? 'yuva420p' : 'yuv420p', '-b:v', '0', '-crf', '30', '-row-mt', '1', '-vf', `${even}:color=black@0`];
  const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.w}x${o.h}`, '-r', String(o.fps), '-i', '-', ...codec, o.path];
  const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  const job = { proc, log: '', done: null };
  proc.stderr.on('data', d => { job.log = (job.log + d).slice(-4000); });
  job.done = new Promise((res, rej) => {
    proc.on('error', rej);
    proc.on('close', code => (code === 0 ? res() : rej(new Error(`ffmpeg exited with ${code}: ${job.log.trim().split('\n').slice(-3).join(' ')}`))));
  });
  job.done.catch(() => {}); // surfaced by videoFrame/videoEnd
  proc.stdin.on('error', () => {}); // EPIPE when ffmpeg dies early; the close handler reports why
  const id = ++jobSeq;
  jobs.set(id, job);
  return id;
});
ipcMain.handle('videoFrame', async (_e, id, rgba) => {
  const job = jobs.get(id);
  if (!job) throw new Error('No such video job');
  if (job.proc.exitCode !== null) await job.done;
  if (!job.proc.stdin.write(Buffer.from(rgba))) await new Promise(r => job.proc.stdin.once('drain', r));
});
ipcMain.handle('videoEnd', async (_e, id) => {
  const job = jobs.get(id);
  if (!job) return;
  job.proc.stdin.end();
  try { await job.done; } finally { jobs.delete(id); }
});
ipcMain.handle('videoAbort', (_e, id) => {
  const job = jobs.get(id);
  if (!job) return;
  job.proc.kill();
  jobs.delete(id);
});

ipcMain.on('setDirty', (_e, d) => { dirty = !!d; });
ipcMain.on('toggleDevTools', () => win?.webContents.toggleDevTools());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
