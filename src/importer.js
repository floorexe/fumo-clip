// Import clips from other recorders (SteelSeries Moments, Overwolf/Outplayed, NVIDIA, Xbox Game Bar,
// Medal, AMD ReLive, Discord, or any folder) into the Fumo Clip library.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { cleanName } = require('./game');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi', '.flv', '.ts']);
// Folder names that describe the recorder, not the game.
const GENERIC_DIRS = /^(insights capture|clips?|captures?|replays?|highlights?|recordings?|videos?|exported clips|shared clips|thumbs?|thumbnails|medal|outplayed|overwolf|nvidia|radeon relive|steelseries moments|discord clips|instant replay|manual recordings|desktop)$/i;
const SKIP_DIRS = /^(thumbs|thumbnails|\.gallery|cache.*|temp)$/i;

// ---------------- known sources ----------------
function knownSources(videosDir) {
  const v = (...p) => path.join(videosDir, ...p);
  const home = process.env.USERPROFILE || path.dirname(videosDir);
  return [
    { id: 'moments', name: 'SteelSeries Moments', dirs: [v('SteelSeries Moments')], note: 'Keeps game names, trims and custom titles from Moments' },
    { id: 'overwolf', name: 'Overwolf / Outplayed', dirs: [v('Overwolf')] },
    { id: 'medal', name: 'Medal', dirs: [v('Medal'), path.join(home, 'Medal')] },
    { id: 'nvidia', name: 'NVIDIA', dirs: [v('NVIDIA')] },
    { id: 'amd', name: 'AMD ReLive', dirs: [v('Radeon ReLive')] },
    { id: 'xbox', name: 'Xbox Game Bar', dirs: [v('Captures')] },
    { id: 'discord', name: 'Discord Clips', dirs: [v('Discord Clips')] },
  ];
}

const inside = (p, dir) => {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

async function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let ents;
  try {
    ents = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.test(e.name)) await walk(full, out, depth + 1);
    } else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full); // skips Moments' leftover ".mp4.meta123" fragments
  }
  return out;
}

async function folderStats(dir) {
  const files = await walk(dir);
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += (await fsp.stat(f)).size;
    } catch {}
  }
  return { count: files.length, bytes };
}

/** Sources that exist on this PC and contain videos. Also lists other video folders under Videos. */
async function detectSources({ videosDir, exclude = [] }) {
  const excluded = (d) => exclude.some((x) => x && (inside(d, x) || inside(x, d)));
  const out = [];
  const used = new Set();
  for (const s of knownSources(videosDir)) {
    const dir = s.dirs.find((d) => fs.existsSync(d) && !excluded(d));
    if (!dir) continue;
    const st = await folderStats(dir);
    s.dirs.forEach((d) => used.add(path.resolve(d).toLowerCase()));
    if (st.count) out.push({ id: s.id, name: s.name, dir, note: s.note || '', ...st });
  }
  // any other folder directly under Videos that holds videos (NVIDIA saves per game, e.g. Videos\Valorant)
  let ents = [];
  try {
    ents = await fsp.readdir(videosDir, { withFileTypes: true });
  } catch {}
  for (const e of ents) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(videosDir, e.name);
    if (used.has(path.resolve(dir).toLowerCase()) || excluded(dir) || /^(fumo clip|clipdeck|resolve project backups|cacheclip)$/i.test(e.name)) continue;
    const st = await folderStats(dir);
    if (st.count) out.push({ id: 'folder:' + dir, name: e.name, dir, note: '', ...st });
  }
  return out;
}

// ---------------- names & dates ----------------
const pad = (n) => String(n).padStart(2, '0');
const fmtStamp = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};
const DATE_PATTERNS = [
  // 2026-11-25 23-04-55 / 2026-11-25__23-04-55 / 2025-12-20T18_31_19 / 2025.01.16 - 20.44.38
  { re: /(\d{4})[-_.](\d{2})[-_.](\d{2})(?:[ _T]+|\s*-\s*|__)(\d{2})[-_.:](\d{2})[-_.:](\d{2})/, ymd: [1, 2, 3], hms: [4, 5, 6] },
  // 01-19-2025 22-17-19 (Overwolf)
  { re: /(\d{2})[-_.](\d{2})[-_.](\d{4})[ _]+(\d{2})[-_.:](\d{2})[-_.:](\d{2})/, ymd: [3, 1, 2], hms: [4, 5, 6] },
  // 20250706_224927
  { re: /(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})/, ymd: [1, 2, 3], hms: [4, 5, 6] },
];
function parseDate(name) {
  for (const p of DATE_PATTERNS) {
    const m = p.re.exec(name);
    if (!m) continue;
    const [y, mo, d] = p.ymd.map((i) => +m[i]);
    const [h, mi, s] = p.hms.map((i) => +m[i]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23) continue;
    return { time: new Date(y, mo - 1, d, h, mi, s).getTime(), match: m[0] };
  }
  return null;
}
const UUID = /[-_ ]?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Text left in a filename once dates, ids and separators are removed ("VALORANT 01-19-2025 22-17-19-295" -> "VALORANT"). */
function leftoverTitle(base, dateMatch) {
  let t = base;
  if (dateMatch) t = t.replace(dateMatch, ' ');
  t = t
    .replace(UUID, ' ')
    .replace(/__/g, ' ')
    .replace(/[_]+/g, ' ')
    .replace(/(^|\s)[-.]\d{1,3}(?=\s|$)/g, ' ') // "-295" milliseconds leftovers
    .replace(/\s[-–.]+\s|\s[-–.]+$|^[-–.]+\s/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[-.]+$/, '')
    .trim();
  return t;
}

/** Work out game + nice title + date for one file. root = the source folder it came from. */
function describe(file, root, sourceName, stat) {
  const base = path.basename(file, path.extname(file));
  const date = parseDate(base);
  const created = date ? date.time : Math.min(stat.mtimeMs, stat.birthtimeMs || stat.mtimeMs);
  // game from folders between the source root and the file (deepest meaningful one), else the root itself
  const rel = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
  let game = '';
  for (let i = rel.length - 1; i >= 0; i--) if (!GENERIC_DIRS.test(rel[i])) {
    game = rel[i];
    break;
  }
  if (!game && !GENERIC_DIRS.test(path.basename(root))) game = path.basename(root);
  let left = leftoverTitle(base, date && date.match);
  // SteelSeries style "Arma-Reforger__2026-..." -> "Arma Reforger": the filename names the game, whatever the folder is called
  if (/__\d{4}-\d{2}-\d{2}__/.test(base)) {
    left = base.split('__')[0].replace(/-/g, ' ');
    if (left && !rel.some((r) => !GENERIC_DIRS.test(r))) game = left;
  }
  if (!game) game = left && date && !/^(screen|clip|replay|recording|moments?)\b/i.test(left) ? left : sourceName;
  // keep a real title, otherwise "<Game> <date>"
  const generic = !left || left.toLowerCase() === game.toLowerCase() || /^(screen|clip|replay|recording|moments?)(\s?\d+)?$/i.test(left) || /^[\d\s-]+$/.test(left);
  const title = generic || date ? `${game} ${fmtStamp(created)}` : left;
  return { game: cleanName(game) || 'Unsorted', title: cleanName(title) || cleanName(base) || 'Clip', created };
}

// ---------------- SteelSeries Moments database ----------------
/** Apply a SQLite write-ahead log to a database image so recent changes are visible. */
function applyWal(dbBuf, walBuf) {
  if (!walBuf || walBuf.length < 32) return dbBuf;
  const magic = walBuf.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) return dbBuf;
  const pageSize = walBuf.readUInt32BE(8) || 65536;
  const salt1 = walBuf.readUInt32BE(16);
  const salt2 = walBuf.readUInt32BE(20);
  const frames = [];
  let lastCommit = -1;
  for (let off = 32; off + 24 + pageSize <= walBuf.length; off += 24 + pageSize) {
    if (walBuf.readUInt32BE(off + 8) !== salt1 || walBuf.readUInt32BE(off + 12) !== salt2) break;
    frames.push({ pgno: walBuf.readUInt32BE(off), commit: walBuf.readUInt32BE(off + 4), off: off + 24 });
    if (frames[frames.length - 1].commit) lastCommit = frames.length - 1;
  }
  if (lastCommit < 0) return dbBuf;
  let size = frames[lastCommit].commit * pageSize;
  let out = Buffer.alloc(Math.max(size, dbBuf.length));
  dbBuf.copy(out);
  for (let i = 0; i <= lastCommit; i++) {
    const f = frames[i];
    walBuf.copy(out, (f.pgno - 1) * pageSize, f.off, f.off + pageSize);
  }
  out = out.subarray(0, size);
  out[18] = 1; // switch the header back from WAL to the classic journal so a plain reader opens it
  out[19] = 1;
  return out;
}

let sqlPromise = null;
function loadSql() {
  if (!sqlPromise) {
    const initSqlJs = require('sql.js/dist/sql-wasm.js');
    const wasm = require.resolve('sql.js/dist/sql-wasm.wasm').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    const wasmBinary = fs.readFileSync(fs.existsSync(wasm) ? wasm : require.resolve('sql.js/dist/sql-wasm.wasm'));
    sqlPromise = initSqlJs({ wasmBinary });
  }
  return sqlPromise;
}

/** Map of lowercased clip path -> Moments info (game name, title, trim, favourite, tags). Read-only. */
async function readMomentsDb() {
  const dir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'SteelSeries', 'GG', 'apps', 'moments', 'db');
  const dbFile = path.join(dir, 'database.db');
  const map = new Map();
  if (!fs.existsSync(dbFile)) return map;
  try {
    const db0 = fs.readFileSync(dbFile);
    let wal = null;
    try {
      wal = fs.readFileSync(dbFile + '-wal');
    } catch {}
    const SQL = await loadSql();
    const db = new SQL.Database(applyWal(db0, wal));
    const res = db.exec(
      `SELECT path, name, last_game_name, clip_start_point, clip_end_point, full_length, is_manually_trimmed, recording_timestamp, tags
       FROM moments_clips WHERE is_deleted = 0`
    );
    db.close();
    if (!res.length) return map;
    const cols = res[0].columns;
    for (const row of res[0].values) {
      const r = Object.fromEntries(cols.map((c, i) => [c, row[i]]));
      let game = r.last_game_name || '';
      if (!game || /desktopModeGameName/i.test(game)) game = 'Desktop';
      const custom = r.name && !/^Moments( Desktop)? clip from /i.test(r.name) ? r.name : '';
      const len = +r.full_length || 0;
      const s = +r.clip_start_point || 0;
      const e = +r.clip_end_point || len;
      const trimmed = len > 0 && (s > 0.05 || e < len - 0.05) && e - s > 0.1;
      let tags = [];
      let favorite = false;
      try {
        for (const t of JSON.parse(r.tags || '[]')) {
          if (t && t.label) tags.push(String(t.label));
          else if (t && t.type === 2) favorite = true; // Moments' star tag has no label
        }
      } catch {}
      map.set(String(r.path).toLowerCase(), {
        game,
        title: custom,
        trim: trimmed ? { in: +s.toFixed(3), out: +e.toFixed(3) } : null,
        created: r.recording_timestamp ? Date.parse(r.recording_timestamp) : null,
        favorite,
        tags,
      });
    }
  } catch (e) {
    console.error('Could not read the SteelSeries Moments database', e);
  }
  return map;
}

// ---------------- scan + import ----------------
/**
 * Build the list of clips to import from the chosen sources.
 * sources: [{ id, name, dir }]; library: { root, knownKeys:Set("size|name"), imported:Set(srcPath) }
 */
async function scan(sources, library) {
  const items = [];
  const needMoments = sources.some((s) => s.id === 'moments');
  const moments = needMoments ? await readMomentsDb() : new Map();
  for (const src of sources) {
    for (const file of await walk(src.dir)) {
      if (inside(file, library.root)) continue; // already in the library
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      if (st.size < 50 * 1024) continue;
      const d = describe(file, src.dir, src.name, st);
      const m = moments.get(file.toLowerCase());
      const item = {
        src: file,
        source: src.name,
        size: st.size,
        mtime: st.mtimeMs,
        game: m ? cleanName(m.game) || d.game : d.game,
        title: m && m.title ? cleanName(m.title) : null,
        created: (m && m.created) || d.created,
        trim: m ? m.trim : null,
        favorite: m ? m.favorite : false,
        tags: m ? m.tags : [],
      };
      if (!item.title) item.title = m ? cleanName(`${item.game} ${fmtStamp(item.created)}`) : d.title;
      item.duplicate = library.imported.has(file.toLowerCase()) || library.knownKeys.has(`${st.size}|${path.basename(file).toLowerCase()}`) || library.knownSizes.has(`${st.size}|${Math.round(item.created / 1000)}`);
      items.push(item);
    }
  }
  return items;
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

/**
 * Copy or move the items into the library. onItem(done, total, bytesDone, bytesTotal, item) after each file.
 * Returns [{ item, dest }] for files that made it, plus failures.
 */
async function run(items, { root, mode, organize, isCancelled, onItem, beforeWrite }) {
  const results = [];
  const failed = [];
  const bytesTotal = items.reduce((n, it) => n + it.size, 0);
  let bytesDone = 0;
  for (let i = 0; i < items.length; i++) {
    if (isCancelled()) break;
    const it = items[i];
    const dir = organize ? path.join(root, it.game) : root;
    try {
      await fsp.mkdir(dir, { recursive: true });
      const dest = uniquePath(path.join(dir, it.title + path.extname(it.src).toLowerCase()));
      if (beforeWrite) beforeWrite(dest);
      if (mode === 'move') {
        try {
          await fsp.rename(it.src, dest);
        } catch (e) {
          if (e.code !== 'EXDEV') throw e;
          await fsp.copyFile(it.src, dest);
          await fsp.unlink(it.src);
        }
      } else {
        await fsp.copyFile(it.src, dest, fs.constants.COPYFILE_EXCL);
      }
      // keep the original date on the file
      try {
        const t = new Date(it.mtime);
        await fsp.utimes(dest, t, t);
      } catch {}
      results.push({ item: it, dest });
    } catch (e) {
      failed.push({ item: it, error: String((e && e.message) || e) });
    }
    bytesDone += it.size;
    onItem(i + 1, items.length, bytesDone, bytesTotal, it);
  }
  return { results, failed };
}

module.exports = { detectSources, scan, run, describe, parseDate, applyWal, readMomentsDb, fmtStamp };
