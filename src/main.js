const { app, BrowserWindow, ipcMain, protocol, shell, dialog, Tray, Menu, Notification, nativeImage, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { execFile } = require('child_process');
const { Library, VIDEO_EXT } = require('./library');
const { ObsLink, FolderWatcher, detectObsConfig } = require('./obs');
const { foregroundInfo, resolveGame } = require('./game');
const media = require('./media');
const importer = require('./importer');
const { autoUpdater } = require('electron-updater');

protocol.registerSchemesAsPrivileged([
  { scheme: 'clipdeck', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// Optional override (portable installs / testing): CLIPDECK_USERDATA=<folder>
if (process.env.CLIPDECK_USERDATA) app.setPath('userData', process.env.CLIPDECK_USERDATA);
if (!app.requestSingleInstanceLock()) app.quit();

const USER = app.getPath('userData');
const SETTINGS_FILE = path.join(USER, 'settings.json');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const RENDERER = path.join(__dirname, 'renderer');
const BG_DIR = () => path.join(app.getPath('userData'), 'backgrounds');

let settings;
let win = null;
let tray = null;
let quitting = false;

// ---------------- settings ----------------
function defaultSettings() {
  const obs = detectObsConfig();
  return {
    // Use OBS's own clip folder as the library, so every video already in it shows up as-is.
    libraryDir: obs.watchDir && fs.existsSync(obs.watchDir) ? obs.watchDir : path.join(app.getPath('videos'), 'Fumo Clip'),
    watchEnabled: true,
    watchDir: obs.watchDir || '',
    filePrefix: obs.prefix || 'Replay',
    ingestMode: 'move',
    organizeByGame: true,
    obsEnabled: true,
    obsHost: '127.0.0.1',
    obsPort: obs.wsPort || 4455,
    obsPassword: obs.wsPassword || '',
    notify: true,
    autoUpdate: true,
    theme: 'midnight',
    customTheme: null, // { bg, bg2, bg3, line, text, muted, accent, accent2, accent3 }
    bgImage: null, // { file, dim, blur, glass }
    closeToTray: true,
    launchAtLogin: false,
    trackNames: [],
    mixer: {}, // track index -> { volume, muted }
    shareOpts: { sizeMB: 10, height: 'auto', fps: 0, quality: 'high', audioMode: 'mix', audioKbps: 128, codec: 'h264', encoder: 'auto' },
  };
}
/** The app used to be called ClipDeck (settings in %APPDATA%/clipdeck). Bring them over once. */
function migrateOldSettings() {
  if (fs.existsSync(SETTINGS_FILE) || process.env.CLIPDECK_USERDATA) return;
  const oldDir = path.join(app.getPath('appData'), 'clipdeck');
  const oldFile = path.join(oldDir, 'settings.json');
  if (!fs.existsSync(oldFile)) return;
  try {
    const s = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    const oldBg = path.join(oldDir, 'backgrounds');
    if (s.bgImage && s.bgImage.file && s.bgImage.file.startsWith(oldBg) && fs.existsSync(s.bgImage.file)) {
      const dest = path.join(BG_DIR(), path.basename(s.bgImage.file));
      fs.mkdirSync(BG_DIR(), { recursive: true });
      fs.copyFileSync(s.bgImage.file, dest);
      s.bgImage.file = dest;
    }
    fs.mkdirSync(USER, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error('settings migration failed', e);
  }
}

function loadSettings() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {}
  settings = { ...defaultSettings(), ...s };
}
function saveSettings() {
  fs.mkdirSync(USER, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

const lib = new Library({ cacheDir: path.join(USER, 'clipdeck-cache'), settings: () => settings });
const obs = new ObsLink();
const watcher = new FolderWatcher(VIDEO_EXT);

function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

// ---------------- clip serialisation ----------------
const mediaUrl = (p) => `clipdeck://app/media?p=${encodeURIComponent(p)}`;
function pub(c) {
  if (!c) return null;
  const p = c.probe || {};
  return {
    id: c.id,
    path: c.path,
    file: c.file,
    title: c.title,
    game: c.game,
    isExport: c.isExport,
    size: c.size,
    created: c.created,
    favorite: c.favorite,
    trim: c.trim,
    markers: c.markers || [],
    tags: c.tags || [],
    compressed: (lib.db.clips[c.id] || {}).compressed || null,
    duration: p.duration || 0,
    width: p.width || 0,
    height: p.height || 0,
    fps: p.fps || 0,
    vcodec: p.vcodec || null,
    tracks: p.audioTracks || [],
    probed: !!c.probe,
    error: p.error || null,
    url: mediaUrl(c.path),
    thumb: fs.existsSync(lib.thumbPath(c)) ? mediaUrl(lib.thumbPath(c)) : null,
  };
}

// ---------------- ingest ----------------
const importingPaths = new Set();
async function handleNewReplay(file, source) {
  if (importingPaths.has(path.resolve(file).toLowerCase())) return;
  // Detect the game right away, while it's still the foreground window.
  const info = await foregroundInfo();
  const g = resolveGame(info, lib.db.exeMap);
  if (g.exe && !lib.db.exeMap[g.exe]) lib.setExeName(g.exe, g.name);
  try {
    const clip = await lib.ingest(file, g.name);
    if (!clip) return;
    send('clip:added', pub(clip));
    lib.thumb(clip.id).then(() => send('clip:updated', pub(lib.clips.get(clip.id)))).catch(() => {});
    if (settings.notify && Notification.isSupported()) {
      new Notification({ title: 'Clip saved', body: `${clip.game} — ${clip.title}`, icon: ICON, silent: true }).show();
    }
  } catch (e) {
    console.error('ingest failed', source, e);
    send('toast', { kind: 'error', text: `Couldn't import clip: ${e.message}` });
  }
}
obs.on('replay-saved', (p) => p && handleNewReplay(p, 'websocket'));
obs.on('status', (s) => send('obs:status', s));
watcher.on('file', (p) => handleNewReplay(p, 'watcher'));
lib.on('clip-updated', (c) => send('clip:updated', pub(c)));
lib.on('changed', () => send('library:changed'));

function applyRuntime() {
  obs.start(settings);
  if (settings.watchEnabled) watcher.start(settings.watchDir, settings.filePrefix);
  else watcher.stop();
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin, args: ['--hidden'] });
}

// ---------------- protocol (serves UI + local media with Range support) ----------------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.m4a': 'audio/mp4', '.flv': 'video/x-flv', '.ts': 'video/mp2t', '.avi': 'video/x-msvideo',
};
function inside(p, dir) {
  if (!dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function serveFile(file, range) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return new Response('not found', { status: 404 });
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : st.size - parseInt(m[2], 10);
    let end = m[1] && m[2] ? parseInt(m[2], 10) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(st.size), 'Accept-Ranges': 'bytes' },
  });
}
function registerProtocol() {
  protocol.handle('clipdeck', (req) => {
    const u = new URL(req.url);
    if (u.host !== 'app') return new Response('bad host', { status: 400 });
    if (u.pathname === '/media') {
      const p = u.searchParams.get('p') || '';
      if (!(inside(p, settings.libraryDir) || inside(p, lib.cacheDir) || inside(p, SHARE_DIR) || inside(p, BG_DIR()))) return new Response('forbidden', { status: 403 });
      return serveFile(p, req.headers.get('range'));
    }
    const fp = path.join(RENDERER, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
    if (!inside(fp, RENDERER)) return new Response('forbidden', { status: 403 });
    return serveFile(fp);
  });
}

// ---------------- window / tray ----------------
const TITLEBAR_H = 59;
function createWindow(show = true) {
  win = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0e0f13',
    title: 'Fumo Clip',
    icon: ICON,
    autoHideMenuBar: true,
    // no grey Windows title bar: the app's own top bar is the title bar, with the
    // minimise / maximise / close buttons drawn on top in the theme's colours
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0f13', symbolColor: '#e8eaf0', height: TITLEBAR_H },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('clipdeck://app/index.html');
  win.once('ready-to-show', () => show && win.show());
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Fumo Clip');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Fumo Clip', click: showWindow },
      { label: 'Save replay now', click: () => obs.saveReplay().catch((e) => send('toast', { kind: 'error', text: e.message })) },
      { label: 'Open library folder', click: () => shell.openPath(settings.libraryDir) },
      { type: 'separator' },
      { label: 'Quit', click: () => ((quitting = true), app.quit()) },
    ])
  );
  tray.on('click', showWindow);
}

// ---------------- IPC ----------------
const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => fn(...a));
function getClip(id) {
  const c = lib.clips.get(id);
  if (!c) throw new Error('Clip not found (it may have been moved or deleted)');
  return c;
}

handle('settings:get', () => ({ ...settings, obsDetected: detectObsConfig(), defaultLibrary: path.join(app.getPath('videos'), 'Fumo Clip') }));
handle('settings:set', async (patch) => {
  const oldLib = settings.libraryDir;
  delete patch.obsDetected;
  delete patch.defaultLibrary;
  settings = { ...settings, ...patch };
  saveSettings();
  const runtimeKeys = ['obsEnabled', 'obsHost', 'obsPort', 'obsPassword', 'watchEnabled', 'watchDir', 'filePrefix', 'launchAtLogin'];
  if (runtimeKeys.some((k) => k in patch)) applyRuntime();
  if (settings.libraryDir !== oldLib) {
    await lib.scan();
    send('library:changed');
  }
  return settings;
});
handle('library:list', async () => (await lib.scan()).map(pub));
handle('library:current', () => lib.list().map(pub));
handle('library:thumb', async (id) => {
  const out = await lib.thumb(id);
  return out ? mediaUrl(out) : null;
});
handle('clip:get', (id) => pub(getClip(id)));
handle('clip:update', (id, patch) => pub(lib.update(id, patch)));
handle('clip:rename', async (id, title) => pub(await lib.rename(id, title)));
handle('clip:move', async (id, game) => pub(await lib.moveToGame(id, game)));
handle('clip:delete', async (ids) => {
  await lib.remove(ids, (p) => shell.trashItem(p));
  return true;
});
handle('game:rename', async (oldName, newName) => (await lib.renameGame(oldName, newName)).map(pub));
handle('games:exeMap', () => lib.db.exeMap);
handle('games:setExe', (exe, name) => (lib.setExeName(exe, name), lib.db.exeMap));
handle('clip:prepare', async (id) => {
  const tracks = await lib.prepareAudio(id);
  return { clip: pub(getClip(id)), tracks: tracks && tracks.map((t) => ({ ...t, url: mediaUrl(t.file) })) };
});
handle('clip:proxy', async (id, mode) => mediaUrl(await lib.prepareProxy(id, mode)));

// ---------------- share (temporary renders for drag & drop) ----------------
// Share renders live in a temp folder and are wiped on start/quit; nothing is added to your clips
// folder unless you press "Save a copy".
const SHARE_DIR = path.join(app.getPath('temp'), 'clipdeck-share');
const cleanShareDir = () => fs.rmSync(SHARE_DIR, { recursive: true, force: true });
let shareRun = null; // { key, ac, promise, requestId } for the render in progress
let shareSeq = 0;
const shareCache = new Map(); // render key -> file

// Export options the share window can send (anything else is ignored).
const SHARE_KEYS = ['sizeMB', 'height', 'fps', 'quality', 'audioMode', 'audioKbps', 'codec', 'encoder'];
function shareOptions(o) {
  const out = {};
  for (const k of SHARE_KEYS) if (o[k] !== undefined) out[k] = o[k];
  out.sizeMB = Math.max(0, Math.min(10000, +out.sizeMB || 0));
  return out;
}
/**
 * Runs one temporary render. Same key as the running one: wait for it. A different key: cancel the
 * old one. A finished key: reuse the file. Returns the output path, or null if it was cancelled.
 */
/** Delete a temp folder; if Windows still has a file in it open (ffmpeg just stopped), try again shortly. */
function removeLater(dir, tries = 10) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    if (tries > 0) setTimeout(() => removeLater(dir, tries - 1), 500);
  }
}

async function runShareJob(key, fileName, requestId, work) {
  const cached = shareCache.get(key);
  if (cached && fs.existsSync(cached)) {
    if (shareRun && shareRun.key !== key) shareRun.ac.abort();
    return cached;
  }
  if (shareRun && shareRun.key === key) {
    shareRun.requestId = requestId;
    return shareRun.promise;
  }
  if (shareRun) shareRun.ac.abort();
  const ac = new AbortController();
  const job = { key, ac, requestId };
  shareRun = job;
  const output = path.join(SHARE_DIR, key + '-' + ++shareSeq, fileName);
  job.promise = (async () => {
    try {
      await work(output, ac.signal, (f) => !ac.signal.aborted && send('export:progress', { key: job.requestId, progress: f }));
      shareCache.set(key, output);
      return output;
    } catch (e) {
      removeLater(path.dirname(output));
      if (ac.signal.aborted) return null;
      throw e;
    } finally {
      if (shareRun === job) shareRun = null;
    }
  })();
  return job.promise;
}

handle('combine:render', async (list, opts) => {
  if (!Array.isArray(list) || list.length < 2) throw new Error('Pick at least 2 clips');
  const items = [];
  for (const it of list) {
    const clip = getClip(it.id);
    const p = await lib.ensureProbe(clip);
    const start = Math.max(0, +it.start || 0);
    const end = Math.min(p.duration || 0, +it.end || p.duration || 0);
    if (!(end > start)) throw new Error(`"${clip.title}" has nothing to use`);
    items.push({ clip, input: clip.path, start, end, width: p.width, height: p.height, fps: p.fps, tracks: (it.tracks || []).filter((t) => t.enabled) });
  }
  const o = { sizeMB: Math.max(0, +opts.sizeMB || 0), height: opts.height === 'auto' ? 'auto' : +opts.height || 0 };
  const key = require('crypto')
    .createHash('sha1')
    .update(JSON.stringify(['combine', items.map((x) => [x.clip.key, x.start, x.end, x.tracks]), o]))
    .digest('hex')
    .slice(0, 12);
  const label = o.sizeMB ? ' (' + o.sizeMB + 'MB)' : '';
  const name = require('./game').cleanName('Combined ' + items.length + ' clips' + label) + '.mp4';
  const out = await runShareJob(key, name, opts.requestId, (output, signal, progress) =>
    media.combineClips({ items: items.map(({ clip, ...x }) => x), output, ...o, signal }, progress)
  );
  return out ? shareResult(out, items[0].clip) : { cancelled: true };
});

// ---------------- frames ----------------
handle('frame:copy', (dataUrl) => {
  const img = nativeImage.createFromDataURL(String(dataUrl));
  if (img.isEmpty()) throw new Error('Could not read the frame');
  clipboard.writeImage(img);
  return true;
});
handle('frame:save', (dataUrl, id, at) => {
  const clip = getClip(id);
  const img = nativeImage.createFromDataURL(String(dataUrl));
  if (img.isEmpty()) throw new Error('Could not read the frame');
  const t = Math.max(0, +at || 0);
  const stamp = Math.floor(t / 60) + 'm' + (t % 60).toFixed(1).padStart(4, '0') + 's';
  const dir = path.join(settings.libraryDir, 'Screenshots');
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, require('./game').cleanName(clip.title + ' ' + stamp) + '.png');
  for (let i = 2; fs.existsSync(file); i++) file = file.replace(/( \(\d+\))?\.png$/, ' (' + i + ').png');
  fs.writeFileSync(file, img.toPNG());
  return file;
});

handle('share:render', async (id, opts) => {
  const clip = getClip(id);
  const p = await lib.ensureProbe(clip);
  const tracks = (opts.tracks || []).filter((t) => t.enabled);
  const o = shareOptions(opts);
  const key = require('crypto').createHash('sha1').update(JSON.stringify([clip.key, opts.start, opts.end, tracks, o])).digest('hex').slice(0, 12);
  const label = o.sizeMB ? ' (' + o.sizeMB + 'MB)' : '';
  const name = require('./game').cleanName(clip.title + label) + '.mp4';
  const out = await runShareJob(key, name, opts.requestId, (output, signal, progress) =>
    media.exportClip(
      {
        ...o,
        input: clip.path,
        output,
        start: opts.start,
        end: opts.end,
        duration: p.duration,
        srcHeight: p.height,
        srcFps: p.fps,
        nAudioTracks: (p.audioTracks || []).length,
        tracks,
        signal,
      },
      progress
    )
  );
  return out ? shareResult(out, clip) : { cancelled: true };
});
handle('share:plan', (o) => media.planExport(o));
handle('share:encoder', async (codec) => media.detectEncoder(codec));
function shareResult(file, clip) {
  return { file, name: path.basename(file), size: fs.statSync(file).size, url: mediaUrl(file), clipId: clip.id };
}
handle('share:cancel', () => shareRun && shareRun.ac.abort());
handle('share:save', async (file, id) => {
  if (!inside(file, SHARE_DIR)) throw new Error('Not a share file');
  const clip = getClip(id);
  const dest = lib.exportPath(clip, path.basename(file, '.mp4'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  const out = await lib.buildClip(dest);
  if (out && !clip.isExport) {
    lib.meta(out.id).game = clip.game; // remember which game the export came from
    out.game = clip.game;
    lib.saveDb();
  }
  lib.thumb(out.id).then(() => send('clip:updated', pub(lib.clips.get(out.id)))).catch(() => {});
  return pub(out);
});
handle('clip:waves', (id) => lib.waves(id));

function copyFileToClipboard(file) {
  // Puts the file itself on the clipboard (paste straight into Discord / Explorer).
  return new Promise((resolve, reject) => {
    const cmd = `Set-Clipboard -LiteralPath '${file.replace(/'/g, "''")}'`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}
handle('shell:copyFile', (p) => copyFileToClipboard(p));
handle('shell:show', (p) => shell.showItemInFolder(p));
handle('shell:openLibrary', () => shell.openPath(settings.libraryDir));
handle('shell:openExternal', (url) => /^https:\/\//.test(url) && shell.openExternal(url));
handle('dialog:folder', async (current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: current || undefined });
  return r.canceled ? null : r.filePaths[0];
});
// ---------------- categories ----------------
handle('categories:list', () => lib.categories());
handle('categories:add', (name) => lib.addCategory(name));
handle('categories:rename', (oldName, newName) => (lib.renameCategory(oldName, newName), lib.list().map(pub)));
handle('categories:delete', (name) => (lib.deleteCategory(name), lib.list().map(pub)));
// Add and/or remove categories on many clips at once.
handle('clips:tag', (ids, add = [], remove = []) =>
  ids.map((id) => {
    const c = getClip(id);
    const tags = (c.tags || []).filter((t) => !remove.includes(t));
    for (const t of add) if (!tags.includes(t)) tags.push(t);
    return pub(lib.update(id, { tags }));
  })
);

// ---------------- custom background image ----------------
handle('dialog:image', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = r.filePaths[0];
  const dir = BG_DIR();
  fs.mkdirSync(dir, { recursive: true });
  // keep our own copy so the background survives the original being moved
  const dest = path.join(dir, 'bg-' + Date.now() + path.extname(src).toLowerCase());
  fs.copyFileSync(src, dest);
  for (const f of fs.readdirSync(dir)) if (path.join(dir, f) !== dest && f.startsWith('bg-')) fs.rmSync(path.join(dir, f), { force: true });
  return dest;
});

// ---------------- window chrome / app info ----------------
const HEX = /^#[0-9a-f]{6}$/i;
handle('window:titlebar', (o) => {
  if (!win || win.isDestroyed() || !o || !HEX.test(o.color) || !HEX.test(o.symbolColor)) return false;
  try {
    win.setTitleBarOverlay({ color: o.color, symbolColor: o.symbolColor, height: TITLEBAR_H });
  } catch {}
  return true;
});
const uninstallerPath = () => path.join(path.dirname(app.getPath('exe')), 'Uninstall Fumo Clip.exe');
handle('app:paths', () => ({
  installed: app.isPackaged,
  install: app.isPackaged ? path.dirname(app.getPath('exe')) : null,
  data: USER,
  library: settings.libraryDir,
  canUninstall: app.isPackaged && fs.existsSync(uninstallerPath()),
}));
handle('shell:openPath', (p) => {
  const allowed = [app.isPackaged ? path.dirname(app.getPath('exe')) : null, USER, settings.libraryDir].filter(Boolean);
  if (!allowed.some((a) => path.resolve(a) === path.resolve(p))) return false;
  return shell.openPath(p);
});
// Runs the normal Windows uninstaller. It removes the app only, never your clips.
handle('app:uninstall', () => {
  const exe = uninstallerPath();
  if (!app.isPackaged || !fs.existsSync(exe)) throw new Error('The uninstaller only exists in the installed app');
  require('child_process').spawn(exe, ['/currentuser', '--fumo-confirmed'], { detached: true, stdio: 'ignore' }).unref();
  quitting = true;
  setTimeout(() => app.quit(), 300);
  return true;
});

// ---------------- compress / cut to trim (rewrites clip files to save space) ----------------
const COMPRESS_CQ = { high: 22, balanced: 26, small: 30 };
let procJob = null;
handle('process:cancel', () => {
  if (procJob) {
    procJob.cancelled = true;
    if (procJob.ac) procJob.ac.abort();
  }
  return true;
});
handle('process:start', async (req) => {
  if (procJob && procJob.running) throw new Error('Already working on some clips');
  const op = req.op === 'cut' ? 'cut' : 'compress';
  const opts = req.opts || {};
  const list = (req.ids || []).map((id) => lib.clips.get(id)).filter(Boolean);
  const job = { cancelled: false, running: true, ac: null };
  procJob = job;
  const removeOriginal = opts.originals === 'delete' ? (p) => fs.promises.unlink(p) : (p) => shell.trashItem(p);
  (async () => {
    const sum = { op, done: 0, skipped: [], failed: [], notes: [], before: 0, after: 0, cancelled: false };
    for (let i = 0; i < list.length && !job.cancelled; i++) {
      const clip = list[i];
      const tmp = path.join(path.dirname(clip.path), '.' + path.basename(clip.path, path.extname(clip.path)) + '.fumo-tmp.mp4');
      const report = (f) => send('process:progress', { index: i, total: list.length, title: clip.title, progress: f, saved: sum.before - sum.after });
      report(0);
      try {
        const p = await lib.ensureProbe(clip);
        let start = null;
        let end = null;
        if (op === 'cut') {
          if (!clip.trim) {
            sum.skipped.push(`${clip.title}: has no trim`);
            continue;
          }
          start = clip.trim.in;
          end = Math.min(clip.trim.out, p.duration || clip.trim.out);
        }
        job.ac = new AbortController();
        await media.reencodeClip(
          {
            input: clip.path,
            output: tmp,
            start,
            end,
            duration: p.duration,
            codec: opts.codec === 'hevc' ? 'hevc' : 'h264',
            cq: op === 'cut' ? 19 : COMPRESS_CQ[opts.quality] || COMPRESS_CQ.balanced,
            height: op === 'compress' ? +opts.height || 0 : 0,
            copyVideo: op === 'cut' && !!opts.fast,
            signal: job.ac.signal,
          },
          report
        );
        // make sure the new file is complete before the original is touched
        const q = await media.probe(tmp);
        const want = op === 'cut' ? end - start : p.duration;
        const slack = (op === 'cut' && opts.fast ? 4 : 1) + want * 0.02;
        if (!(q.duration > 0) || Math.abs(q.duration - want) > slack) throw new Error(`the new file is ${q.duration.toFixed(1)}s instead of ${want.toFixed(1)}s, so the original was kept`);
        if ((q.audioTracks || []).length !== (p.audioTracks || []).length) throw new Error('the new file lost audio tracks, so the original was kept');
        const before = clip.size;
        const after = fs.statSync(tmp).size;
        if (op === 'compress' && after > before * 0.95) {
          fs.rmSync(tmp, { force: true });
          sum.skipped.push(`${clip.title}: already small, left as it was`);
          continue;
        }
        let patch;
        if (op === 'cut') {
          const marks = (clip.markers || []).filter((t) => t >= start && t <= end).map((t) => +(t - start).toFixed(3));
          patch = { trim: null, markers: marks };
        } else {
          patch = { compressed: { codec: opts.codec === 'hevc' ? 'hevc' : 'h264', quality: opts.quality || 'balanced', before, after, at: Date.now() } };
        }
        const r = await lib.replaceFile(clip.id, tmp, { removeOriginal, patch });
        if (r.note) sum.notes.push(`${clip.title}: ${r.note}`);
        sum.done++;
        sum.before += before;
        sum.after += after;
        send('clip:updated', pub(r.clip));
      } catch (e) {
        removeLater(tmp); // the stopped ffmpeg may still hold it for a moment
        if (job.cancelled) break;
        sum.failed.push(`${clip.title}: ${String((e && e.message) || e).split('\n').pop()}`);
      }
    }
    sum.cancelled = job.cancelled;
    job.running = false;
    lib.flushDb();
    send('process:done', sum);
    send('library:changed');
  })();
  return { started: list.length };
});

// ---------------- import from other recorders ----------------
let importJob = null; // { sources, items, cancelled, running }
function driveRoot(p) {
  return path.parse(path.resolve(p)).root.toLowerCase();
}
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
handle('import:sources', async () => importer.detectSources({ videosDir: app.getPath('videos'), exclude: [settings.libraryDir, settings.watchDir] }));
handle('import:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const dir = r.filePaths[0];
  if (lib.contains(path.join(dir, 'x')) || path.resolve(dir).toLowerCase() === path.resolve(settings.libraryDir).toLowerCase()) {
    throw new Error('That folder is already your Fumo Clip library');
  }
  return { id: 'folder:' + dir, name: path.basename(dir) || dir, dir, note: '', count: null, bytes: null };
});
handle('import:scan', async (sources) => {
  if (importJob && importJob.running) throw new Error('An import is already running');
  const clips = lib.list();
  const knownKeys = new Set(clips.map((c) => `${c.size}|${path.basename(c.path).toLowerCase()}`));
  const knownSizes = new Set(clips.map((c) => `${c.size}|${Math.round(c.created / 1000)}`));
  const imported = new Set(Object.keys(lib.db.imported || {}));
  const items = await importer.scan(sources, { root: settings.libraryDir, knownKeys, knownSizes, imported });
  importJob = { sources, items, cancelled: false, running: false };
  const fresh = items.filter((i) => !i.duplicate);
  const games = {};
  for (const i of fresh) games[i.game] = (games[i.game] || 0) + 1;
  const bytes = fresh.reduce((n, i) => n + i.size, 0);
  const crossDrive = fresh.some((i) => driveRoot(i.src) !== driveRoot(settings.libraryDir));
  return {
    total: items.length,
    fresh: fresh.length,
    duplicates: items.length - fresh.length,
    bytes,
    crossBytes: fresh.filter((i) => driveRoot(i.src) !== driveRoot(settings.libraryDir)).reduce((n, i) => n + i.size, 0),
    crossDrive,
    free: freeBytes(settings.libraryDir),
    trims: fresh.filter((i) => i.trim).length,
    titles: fresh.filter((i) => i.title && !i.title.startsWith(i.game + ' ')).length,
    games: Object.entries(games).sort((a, b) => b[1] - a[1]).map(([game, n]) => ({ game, n })),
    organize: settings.organizeByGame,
    library: settings.libraryDir,
  };
});
handle('import:cancel', () => {
  if (importJob) importJob.cancelled = true;
  return true;
});
handle('import:start', async (opts) => {
  if (!importJob || !importJob.items) throw new Error('Scan first');
  if (importJob.running) throw new Error('An import is already running');
  const job = importJob;
  job.running = true;
  const mode = opts && opts.mode === 'copy' ? 'copy' : 'move';
  const items = job.items.filter((i) => !i.duplicate);
  let lastSend = 0;
  (async () => {
    let out = { results: [], failed: [] };
    try {
      out = await importer.run(items, {
        root: settings.libraryDir,
        mode,
        organize: settings.organizeByGame,
        isCancelled: () => job.cancelled,
        beforeWrite: (dest) => importingPaths.add(path.resolve(dest).toLowerCase()),
        onItem: (done, total, bytesDone, bytesTotal, it) => {
          const now = Date.now();
          if (now - lastSend > 120 || done === total) {
            lastSend = now;
            send('import:progress', { done, total, bytesDone, bytesTotal, current: it.title, game: it.game });
          }
        },
      });
      // bring over what Moments knew: date, trim, favourite, tags
      lib.db.imported = lib.db.imported || {};
      for (const { item, dest } of out.results) {
        const id = lib.idFor(dest);
        const m = lib.meta(id);
        m.created = item.created;
        if (!settings.organizeByGame) m.game = item.game;
        if (item.trim) m.trim = item.trim;
        if (item.favorite) m.favorite = true;
        if (item.tags && item.tags.length) {
          m.tags = [...new Set([...(m.tags || []), ...item.tags])];
          for (const t of item.tags) if (!lib.db.categories.includes(t)) lib.db.categories.push(t);
        }
        lib.db.imported[item.src.toLowerCase()] = id;
      }
      lib.flushDb();
      await lib.rescanQuiet();
    } catch (e) {
      out.failed.push({ item: null, error: String((e && e.message) || e) });
    } finally {
      job.running = false;
      setTimeout(() => importingPaths.clear(), 5000);
    }
    send('import:done', {
      imported: out.results.length,
      failed: out.failed.length,
      errors: out.failed.slice(0, 5).map((f) => (f.item ? f.item.title + ': ' : '') + f.error),
      cancelled: job.cancelled,
      mode,
    });
    send('library:changed');
  })();
  return { started: items.length };
});

handle('obs:status', () => obs.state);
handle('obs:save', () => obs.saveReplay());
handle('obs:toggleReplay', () => obs.toggleReplay());
handle('obs:detect', () => detectObsConfig());
// Nothing to import when the OBS folder is already inside the library.
const importable = () => (settings.watchDir && lib.contains(path.join(settings.watchDir, 'x')) ? [] : watcher.pending());
handle('import:pending', () => importable().length);
handle('import:run', async () => {
  const files = importable();
  let n = 0;
  for (const f of files) {
    const c = await lib.ingest(f, 'Unsorted').catch(() => null);
    if (c) n++;
  }
  send('library:changed');
  return n;
});
handle('cache:clear', () => {
  fs.rmSync(lib.cacheDir, { recursive: true, force: true });
  return true;
});

function dragIcon(c) {
  let icon = c ? nativeImage.createFromPath(lib.thumbPath(c)) : nativeImage.createEmpty();
  if (icon.isEmpty()) icon = nativeImage.createFromPath(ICON);
  return icon.resize({ width: 160 });
}
ipcMain.on('drag:start', (e, id) => {
  const c = lib.clips.get(id);
  if (c) e.sender.startDrag({ file: c.path, icon: dragIcon(c) });
});
// Drag a temporary share render out of the app (e.g. into a Discord chat).
ipcMain.on('drag:share', (e, file, id) => {
  if (inside(file, SHARE_DIR) && fs.existsSync(file)) e.sender.startDrag({ file, icon: dragIcon(lib.clips.get(id)) });
});

// ---------------- lifecycle ----------------
app.on('second-instance', showWindow);
app.on('before-quit', () => (quitting = true));
app.on('will-quit', () => {
  if (shareRun) shareRun.ac.abort(); // stop a running ffmpeg render so it doesn't keep going in the background
  try {
    cleanShareDir();
  } catch {}
});
app.on('window-all-closed', () => {
  if (!settings.closeToTray) app.quit();
});

app.whenReady().then(async () => {
  app.setAppUserModelId('dev.clipdeck.app');
  migrateOldSettings();
  loadSettings();
  if (!fs.existsSync(SETTINGS_FILE)) saveSettings();
  try {
    cleanShareDir();
  } catch {}
  registerProtocol();
  await lib.scan().catch((e) => console.error('scan failed', e));
  applyRuntime();
  createTray();
  createWindow(!process.argv.includes('--hidden'));
  setupUpdater();
});

// ---------------- auto-update (GitHub Releases) ----------------
let updateState = { state: app.isPackaged ? 'idle' : 'dev', version: null, percent: 0, error: '' };
let updateTimer = null;
function setUpdate(patch) {
  updateState = { ...updateState, ...patch };
  send('update:status', updateState);
}
function setupUpdater() {
  if (!app.isPackaged) return; // updates only make sense for the installed app
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ state: 'checking', error: '' }));
  autoUpdater.on('update-available', (i) => setUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => setUpdate({ state: 'latest' }));
  autoUpdater.on('download-progress', (p) => setUpdate({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => {
    setUpdate({ state: 'ready', version: i.version, percent: 100 });
    if (Notification.isSupported()) {
      new Notification({ title: 'Fumo Clip update ready', body: `Version ${i.version} installs when you restart Fumo Clip.`, icon: ICON, silent: true }).show();
    }
  });
  autoUpdater.on('error', (e) => setUpdate({ state: 'error', error: String((e && e.message) || e).split('\n')[0] }));
  const check = () => settings.autoUpdate !== false && autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15 * 1000);
  updateTimer = setInterval(check, 4 * 60 * 60 * 1000);
}
handle('update:status', () => ({ ...updateState, current: app.getVersion() }));
handle('update:check', async () => {
  if (!app.isPackaged) return { ...updateState, current: app.getVersion() };
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    setUpdate({ state: 'error', error: String((e && e.message) || e).split('\n')[0] });
  }
  return { ...updateState, current: app.getVersion() };
});
handle('update:install', () => {
  if (updateState.state !== 'ready') return false;
  quitting = true; // let the window close instead of hiding to the tray
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
});
