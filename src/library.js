// The clip library: files on disk organised as <Library>/<Game>/<clip>, plus a small JSON db for metadata.
const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const media = require('./media');
const { cleanName } = require('./game');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.webm', '.flv', '.ts', '.m4v', '.avi']);
const EXPORTS = 'Exports';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => {
      active--;
      next();
    });
  };
  return (fn) => new Promise((res, rej) => (q.push({ fn, res, rej }), next()));
}

function stampFromName(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}
function fmtStamp(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length);
  for (let i = 2; ; i++) {
    const c = `${base} (${i})${ext}`;
    if (!fs.existsSync(c)) return c;
  }
}
async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dest);
    await fsp.unlink(src);
  }
}

function cleanTags(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const n = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

class Library extends EventEmitter {
  constructor({ cacheDir, settings }) {
    super();
    this.cacheDir = cacheDir;
    this.settings = settings; // function returning current settings
    this.db = { clips: {}, exeMap: {} };
    this.clips = new Map(); // id -> clip
    this.probeQ = limiter(3);
    this.thumbQ = limiter(2);
    this.inflight = new Map();
    this.seenIngest = new Set();
    this.watcher = null;
  }

  get root() {
    return this.settings().libraryDir;
  }
  get dbFile() {
    return path.join(this.root, '.clipdeck', 'db.json');
  }

  // ---------- db ----------
  loadDb() {
    try {
      this.db = JSON.parse(fs.readFileSync(this.dbFile, 'utf8'));
    } catch {
      this.db = {};
    }
    this.db.clips = this.db.clips || {};
    this.db.exeMap = this.db.exeMap || {};
    this.db.categories = Array.isArray(this.db.categories) ? this.db.categories : [];
    this.db.imported = this.db.imported && typeof this.db.imported === 'object' ? this.db.imported : {};
  }
  /** Write the db right now (used before anything re-reads it from disk). */
  flushDb() {
    clearTimeout(this._saveT);
    fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
    const tmp = this.dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 1));
    fs.renameSync(tmp, this.dbFile);
  }
  saveDb() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
        const tmp = this.dbFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.db, null, 1));
        fs.renameSync(tmp, this.dbFile);
      } catch (e) {
        console.error('db save failed', e);
      }
    }, 300);
  }
  meta(id) {
    return (this.db.clips[id] = this.db.clips[id] || {});
  }
  rekey(oldId, newId) {
    if (oldId === newId) return;
    if (this.db.clips[oldId]) this.db.clips[newId] = this.db.clips[oldId];
    delete this.db.clips[oldId];
    this.clips.delete(oldId);
  }

  // ---------- scanning ----------
  idFor(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }
  absFor(id) {
    return path.join(this.root, ...id.split('/'));
  }
  cacheKey(st) {
    return crypto.createHash('sha1').update(`${st.size}:${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 16);
  }

  async walk(dir, out = []) {
    let ents = [];
    try {
      ents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, out);
      else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
    return out;
  }

  async buildClip(abs) {
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      return null;
    }
    const id = this.idFor(abs);
    const m = this.meta(id);
    const parts = id.split('/');
    const isExport = parts[0] === EXPORTS;
    const folder = isExport ? (parts.length > 2 ? parts[1] : '') : parts.length > 1 ? parts[0] : '';
    const key = this.cacheKey(st);
    const base = path.basename(abs, path.extname(abs));
    const clip = {
      id,
      path: abs,
      file: path.basename(abs),
      title: base,
      game: folder || m.game || (isExport ? 'Exports' : 'Unsorted'),
      isExport,
      size: st.size,
      created: m.created || stampFromName(base) || st.birthtimeMs || st.mtimeMs,
      favorite: !!m.favorite,
      trim: m.trim || null,
      markers: Array.isArray(m.markers) ? m.markers : [],
      tags: Array.isArray(m.tags) ? m.tags : [],
      key,
      probe: m.probe && m.probeKey === key ? m.probe : null,
    };
    this.clips.set(id, clip);
    if (!clip.probe) this.queueProbe(clip);
    return clip;
  }

  queueProbe(clip) {
    this.probeQ(async () => {
      try {
        const p = await media.probe(clip.path);
        const m = this.meta(clip.id);
        m.probe = p;
        m.probeKey = clip.key;
        clip.probe = p;
        this.saveDb();
        this.emit('clip-updated', clip);
      } catch (e) {
        clip.probe = { error: String(e.message || e), duration: 0, audioTracks: [] };
        this.emit('clip-updated', clip);
      }
    });
  }

  async scan() {
    fs.mkdirSync(this.root, { recursive: true });
    if (this._saveT && this._dbRoot === this.root) this.flushDb();
    this.loadDb();
    this._dbRoot = this.root;
    this.clips.clear();
    const files = await this.walk(this.root);
    await Promise.all(files.map((f) => this.buildClip(f)));
    // forget db entries for files that no longer exist
    for (const id of Object.keys(this.db.clips)) if (!this.clips.has(id)) delete this.db.clips[id];
    this.saveDb();
    this.watchRoot();
    this.warmThumbs();
    return this.list();
  }

  /** Make missing thumbnails in the background so the library and sidebar fill in on their own. */
  warmThumbs() {
    for (const c of this.list()) {
      if (fs.existsSync(this.thumbPath(c))) continue;
      this.thumb(c.id).then(() => this.emit('clip-updated', c)).catch(() => {});
    }
  }
  list() {
    return [...this.clips.values()];
  }

  watchRoot() {
    if (this.watcher) this.watcher.close();
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (evt, f) => {
        if (!f || f.startsWith('.clipdeck')) return;
        clearTimeout(this._rescanT);
        this._rescanT = setTimeout(() => this.rescanQuiet(), 1200);
      });
      this.watcher.on('error', () => {});
    } catch {}
  }
  async rescanQuiet() {
    const files = await this.walk(this.root);
    const set = new Set(files.map((f) => this.idFor(f)));
    let changed = false;
    for (const id of [...this.clips.keys()]) if (!set.has(id)) (this.clips.delete(id), (changed = true));
    for (const f of files) {
      const id = this.idFor(f);
      const old = this.clips.get(id);
      if (!old) (await this.buildClip(f), (changed = true), this.warmThumbs());
      else {
        try {
          const st = await fsp.stat(f);
          if (this.cacheKey(st) !== old.key) (await this.buildClip(f), (changed = true));
        } catch {}
      }
    }
    if (changed) this.emit('changed');
  }

  // ---------- cache ----------
  thumbPath(clip) {
    return path.join(this.cacheDir, 'thumbs', clip.key + '.jpg');
  }
  async thumb(id) {
    const clip = this.clips.get(id);
    if (!clip) return null;
    const out = this.thumbPath(clip);
    if (fs.existsSync(out)) return out;
    return this.once('thumb:' + out, () =>
      this.thumbQ(async () => {
        if (!clip.probe) clip.probe = await media.probe(clip.path).catch(() => ({ duration: 0 }));
        await media.thumbnail(clip.path, out, clip.probe.duration);
        return out;
      })
    );
  }
  once(key, fn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async ensureProbe(clip) {
    if (!clip.probe || clip.probe.error) {
      clip.probe = await media.probe(clip.path);
      const m = this.meta(clip.id);
      m.probe = clip.probe;
      m.probeKey = clip.key;
      this.saveDb();
    }
    return clip.probe;
  }

  /** Returns per-track audio files when the clip has 2+ tracks (otherwise the video's own audio is used). */
  async prepareAudio(id) {
    const clip = this.clips.get(id);
    if (!clip) throw new Error('Clip not found');
    const p = await this.ensureProbe(clip);
    if (!p.audioTracks || p.audioTracks.length < 2) return null;
    const dir = path.join(this.cacheDir, 'audio', clip.key);
    const files = p.audioTracks.map((t) => path.join(dir, `a${t.index}.m4a`));
    if (!files.every((f) => fs.existsSync(f))) {
      await this.once('audio:' + dir, () => media.extractAudio(clip.path, dir, p.audioTracks));
    }
    return p.audioTracks.map((t, i) => ({ ...t, file: files[i] }));
  }

  /** Waveform peaks for every audio track (cached). */
  async waves(id) {
    const clip = this.clips.get(id);
    if (!clip) throw new Error('Clip not found');
    const p = await this.ensureProbe(clip);
    const file = path.join(this.cacheDir, 'waves', clip.key + '.v2.json');
    const buckets = Math.max(1600, Math.min(60000, Math.round((p.duration || 0) * 100)));
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    return this.once('waves:' + file, async () => {
      const out = [];
      for (const t of p.audioTracks || []) out.push({ index: t.index, peaks: await media.waveform(clip.path, t.index, buckets).catch(() => []) });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(out));
      return out;
    });
  }

  async prepareProxy(id, mode) {
    const clip = this.clips.get(id);
    if (!clip) throw new Error('Clip not found');
    const out = path.join(this.cacheDir, 'proxy', `${clip.key}.${mode}.mp4`);
    if (!fs.existsSync(out)) await this.once('proxy:' + out, () => media.makeProxy(clip.path, out, mode));
    return out;
  }

  clearCacheFor(clip) {
    if (!clip) return;
    for (const p of [this.thumbPath(clip), path.join(this.cacheDir, 'audio', clip.key)]) fs.rmSync(p, { recursive: true, force: true });
    for (const m of ['remux', 'transcode']) fs.rmSync(path.join(this.cacheDir, 'proxy', `${clip.key}.${m}.mp4`), { force: true });
  }

  // ---------- edits ----------
  update(id, patch) {
    const clip = this.clips.get(id);
    if (!clip) throw new Error('Clip not found');
    const m = this.meta(id);
    if ('favorite' in patch) m.favorite = clip.favorite = !!patch.favorite;
    if ('trim' in patch) m.trim = clip.trim = patch.trim;
    if ('tags' in patch) {
      m.tags = clip.tags = cleanTags(patch.tags);
      for (const t of m.tags) if (!this.db.categories.includes(t)) this.db.categories.push(t);
    }
    if ('markers' in patch) {
      const list = (Array.isArray(patch.markers) ? patch.markers : []).map(Number).filter((x) => isFinite(x) && x >= 0);
      m.markers = clip.markers = [...new Set(list)].sort((a, b) => a - b);
    }
    this.saveDb();
    return clip;
  }

  async relocate(clip, destAbs) {
    if (path.resolve(destAbs).toLowerCase() === path.resolve(clip.path).toLowerCase()) return clip;
    destAbs = uniquePath(destAbs);
    const oldDir = path.dirname(clip.path);
    await moveFile(clip.path, destAbs);
    try {
      if (path.resolve(oldDir) !== path.resolve(this.root) && this.contains(oldDir) && !fs.readdirSync(oldDir).length) fs.rmdirSync(oldDir);
    } catch {}
    const newId = this.idFor(destAbs);
    const keepCreated = clip.created;
    this.rekey(clip.id, newId);
    this.meta(newId).created = keepCreated;
    const c = await this.buildClip(destAbs);
    this.saveDb();
    return c;
  }

  async rename(id, title) {
    const clip = this.clips.get(id);
    if (!clip) throw new Error('Clip not found');
    const t = cleanName(title);
    if (!t) throw new Error('Invalid name');
    const ext = path.extname(clip.path);
    return this.relocate(clip, path.join(path.dirname(clip.path), t + ext));
  }

  async moveToGame(id, game) {
    const clip = this.clips.get(id);
    if (!clip) throw new Error('Clip not found');
    const g = cleanName(game) || 'Unsorted';
    if (clip.isExport) {
      const dest = path.join(this.root, EXPORTS, g === 'Exports' ? '' : g, clip.file);
      return this.relocate(clip, dest);
    }
    if (g === EXPORTS) throw new Error('"Exports" is reserved');
    return this.relocate(clip, path.join(this.root, g, clip.file));
  }

  async renameGame(oldName, newName) {
    const n = cleanName(newName);
    if (!n || n === EXPORTS) throw new Error('Invalid game name');
    const moved = [];
    for (const clip of this.list().filter((c) => !c.isExport && c.game === oldName)) moved.push(await this.moveToGame(clip.id, n));
    for (const [exe, name] of Object.entries(this.db.exeMap)) if (name === oldName) this.db.exeMap[exe] = n;
    const oldDir = path.join(this.root, oldName);
    try {
      if (fs.existsSync(oldDir) && !fs.readdirSync(oldDir).length) fs.rmdirSync(oldDir);
    } catch {}
    this.saveDb();
    return moved;
  }

  async remove(ids, trashItem) {
    for (const id of ids) {
      const clip = this.clips.get(id);
      if (!clip) continue;
      await trashItem(clip.path);
      this.clearCacheFor(clip);
      delete this.db.clips[id];
      this.clips.delete(id);
    }
    this.saveDb();
  }

  setExeName(exe, name) {
    const n = cleanName(name);
    if (!exe) return;
    if (n) this.db.exeMap[exe] = n;
    else delete this.db.exeMap[exe];
    this.saveDb();
  }

  // ---------- ingest from OBS ----------
  async waitStable(file, timeoutMs = 5 * 60 * 1000) {
    const t0 = Date.now();
    let last = -1;
    while (Date.now() - t0 < timeoutMs) {
      try {
        const st = await fsp.stat(file);
        if (st.size > 0 && st.size === last) {
          const fh = await fsp.open(file, 'r+'); // fails while OBS still holds it for writing
          await fh.close();
          return true;
        }
        last = st.size;
      } catch (e) {
        if (e.code === 'ENOENT') return false;
      }
      await sleep(700);
    }
    return false;
  }

  /** Move/copy a freshly saved OBS replay into the library under its game folder. */
  async ingest(src, gameName) {
    const key = path.resolve(src).toLowerCase();
    if (this.seenIngest.has(key)) return null;
    this.seenIngest.add(key);
    setTimeout(() => this.seenIngest.delete(key), 10 * 60 * 1000);
    if (!(await this.waitStable(src))) return null;
    const s = this.settings();
    const ext = path.extname(src);
    const when = stampFromName(path.basename(src)) || Date.now();
    const game = cleanName(gameName) || 'Unsorted';
    if (this.contains(src)) {
      // The OBS folder is (inside) the library: leave the file exactly where it is, just tag the game.
      const id = this.idFor(src);
      const m = this.meta(id);
      m.created = when;
      if (!id.includes('/')) m.game = game;
      const clip = await this.buildClip(src);
      this.saveDb();
      this.emit('clip-added', clip);
      return clip;
    }
    const destDir = s.organizeByGame ? path.join(this.root, game) : this.root;
    const dest = uniquePath(path.join(destDir, `${game} ${fmtStamp(when)}${ext}`));
    await fsp.mkdir(destDir, { recursive: true });
    if (s.ingestMode === 'copy') await fsp.copyFile(src, dest);
    else await moveFile(src, dest);
    const id = this.idFor(dest);
    const m = this.meta(id);
    m.created = when;
    if (!s.organizeByGame) m.game = game;
    const clip = await this.buildClip(dest);
    this.saveDb();
    this.emit('clip-added', clip);
    return clip;
  }

  // ---------- categories: labels kept in the db, a clip can have any number ----------
  categories() {
    const used = new Set();
    for (const c of this.clips.values()) for (const t of c.tags || []) used.add(t);
    const list = [...this.db.categories];
    for (const t of used) if (!list.includes(t)) list.push(t);
    return list;
  }
  addCategory(name) {
    const [n] = cleanTags([name]);
    if (!n) throw new Error('Invalid category name');
    if (!this.db.categories.includes(n)) this.db.categories.push(n);
    this.saveDb();
    return n;
  }
  renameCategory(oldName, newName) {
    const [n] = cleanTags([newName]);
    if (!n) throw new Error('Invalid category name');
    this.db.categories = [...new Set(this.db.categories.map((c) => (c === oldName ? n : c)))];
    for (const [id, m] of Object.entries(this.db.clips)) {
      if (!Array.isArray(m.tags) || !m.tags.includes(oldName)) continue;
      m.tags = cleanTags(m.tags.map((t) => (t === oldName ? n : t)));
      const c = this.clips.get(id);
      if (c) c.tags = m.tags;
    }
    this.saveDb();
    return n;
  }
  deleteCategory(name) {
    this.db.categories = this.db.categories.filter((c) => c !== name);
    for (const [id, m] of Object.entries(this.db.clips)) {
      if (!Array.isArray(m.tags) || !m.tags.includes(name)) continue;
      m.tags = m.tags.filter((t) => t !== name);
      const c = this.clips.get(id);
      if (c) c.tags = m.tags;
    }
    this.saveDb();
  }

  contains(p) {
    const rel = path.relative(path.resolve(this.root), path.resolve(p));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  exportPath(clip, name) {
    const base = cleanName(name) || `${clip.title} (export)`;
    return uniquePath(path.join(this.root, EXPORTS, base + '.mp4'));
  }
}

module.exports = { Library, VIDEO_EXT, EXPORTS };
