// OBS integration: obs-websocket (replay saved events, save button) + folder watcher fallback + config detection.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { OBSWebSocket, EventSubscription } = require('obs-websocket-js');

function readIni(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  let sec = '';
  for (let line of fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.trim();
    const m = /^\[(.+)\]$/.exec(line);
    if (m) {
      sec = m[1];
      out[sec] = out[sec] || {};
    } else if (sec && line.includes('=')) {
      const i = line.indexOf('=');
      out[sec][line.slice(0, i)] = line.slice(i + 1);
    }
  }
  return out;
}

const fixPath = (p) => (p ? path.normalize(p.replace(/\\\\/g, '\\')) : '');

/** Reads OBS's own config to find where replays are saved and how to reach obs-websocket. */
function detectObsConfig() {
  const base = path.join(process.env.APPDATA || '', 'obs-studio');
  const res = { found: fs.existsSync(base), watchDir: '', prefix: 'Replay', wsEnabled: false, wsPort: 4455, wsPassword: '', hotkey: '', multiTrack: null };
  if (!res.found) return res;
  let profileDir = 'Untitled';
  for (const f of ['user.ini', 'global.ini']) {
    const g = readIni(path.join(base, f));
    if (g.Basic && g.Basic.ProfileDir) {
      profileDir = g.Basic.ProfileDir;
      break;
    }
  }
  const prof = readIni(path.join(base, 'basic', 'profiles', profileDir, 'basic.ini'));
  const adv = (prof.Output && prof.Output.Mode) === 'Advanced';
  const simple = prof.SimpleOutput || {};
  const advOut = prof.AdvOut || {};
  res.watchDir = fixPath(adv ? advOut.RecFilePath || simple.FilePath : simple.FilePath);
  res.prefix = (adv ? advOut.RecRBPrefix : simple.RecRBPrefix) || simple.RecRBPrefix || 'Replay';
  if (adv) {
    const mask = parseInt(advOut.RecTracks || '1', 10);
    res.multiTrack = { mask, count: [0, 1, 2, 3, 4, 5].filter((b) => mask & (1 << b)).length };
  }
  try {
    const hk = JSON.parse((prof.Hotkeys && prof.Hotkeys.ReplayBuffer) || '{}')['ReplayBuffer.Save'];
    if (hk && hk[0]) {
      const k = hk[0];
      res.hotkey = [k.control && 'Ctrl', k.alt && 'Alt', k.shift && 'Shift', (k.key || '').replace('OBS_KEY_', '')].filter(Boolean).join('+');
    }
  } catch {}
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(base, 'plugin_config', 'obs-websocket', 'config.json'), 'utf8'));
    res.wsEnabled = !!ws.server_enabled;
    res.wsPort = ws.server_port || 4455;
    res.wsPassword = ws.auth_required ? ws.server_password || '' : '';
  } catch {}
  return res;
}

class ObsLink extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'disabled', replayActive: false, error: '' };
    this.ws = null;
    this.timer = null;
    this.cfg = null;
  }
  _set(patch) {
    Object.assign(this.state, patch);
    this.emit('status', { ...this.state });
  }
  start(cfg) {
    this.stop();
    this.cfg = cfg;
    if (!cfg.obsEnabled) return this._set({ status: 'disabled', replayActive: false, error: '' });
    this._connect();
  }
  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      ws.disconnect().catch(() => {});
    }
  }
  _retry() {
    clearTimeout(this.timer);
    if (this.cfg && this.cfg.obsEnabled) this.timer = setTimeout(() => this._connect(), 5000);
  }
  async _connect() {
    const ws = new OBSWebSocket();
    this.ws = ws;
    this._set({ status: 'connecting' });
    ws.on('ConnectionClosed', (e) => {
      if (this.ws !== ws) return;
      this._set({ status: 'offline', replayActive: false, error: e && e.code === 4009 ? 'Wrong OBS WebSocket password' : '' });
      this._retry();
    });
    ws.on('ReplayBufferSaved', (e) => this.emit('replay-saved', e.savedReplayPath));
    ws.on('ReplayBufferStateChanged', (e) => this._set({ replayActive: !!e.outputActive }));
    try {
      const { host, port, password } = { host: this.cfg.obsHost || '127.0.0.1', port: this.cfg.obsPort || 4455, password: this.cfg.obsPassword };
      await ws.connect(`ws://${host}:${port}`, password || undefined, { eventSubscriptions: EventSubscription.Outputs });
      if (this.ws !== ws) return;
      let active = false;
      try {
        active = (await ws.call('GetReplayBufferStatus')).outputActive;
      } catch {}
      this._set({ status: 'connected', replayActive: active, error: '' });
    } catch (e) {
      if (this.ws !== ws) return;
      const msg = String((e && e.message) || e);
      const auth = /auth/i.test(msg) || (e && e.code === 4009);
      this._set({ status: 'offline', error: auth ? 'Wrong OBS WebSocket password' : '' });
      this._retry();
    }
  }
  async saveReplay() {
    if (!this.ws || this.state.status !== 'connected') throw new Error('Not connected to OBS');
    if (!this.state.replayActive) {
      await this.ws.call('StartReplayBuffer');
      throw new Error('Replay buffer was off, so I started it. Try again in a few seconds.');
    }
    await this.ws.call('SaveReplayBuffer');
  }
  async toggleReplay() {
    if (!this.ws || this.state.status !== 'connected') throw new Error('Not connected to OBS');
    await this.ws.call(this.state.replayActive ? 'StopReplayBuffer' : 'StartReplayBuffer');
  }
}

/** Watches the OBS output folder for new replay files (works even without obs-websocket). */
class FolderWatcher extends EventEmitter {
  constructor(exts) {
    super();
    this.exts = exts;
    this.w = null;
  }
  start(dir, prefix) {
    this.stop();
    if (!dir || !fs.existsSync(dir)) return false;
    this.dir = dir;
    this.prefix = (prefix || '').toLowerCase();
    // Files that already exist are never "new", even if Windows reports them later.
    // (Windows fires watch events when a file is merely read, e.g. for thumbnails.)
    this.known = new Set(this.list().map((p) => p.toLowerCase()));
    try {
      this.w = fs.watch(dir, { persistent: true }, (evt, fname) => {
        if (!fname || evt !== 'rename') return; // 'rename' = created/deleted; ignore access/attribute changes
        if (!this.matches(fname)) return;
        const full = path.join(dir, fname);
        const key = full.toLowerCase();
        if (this.known.has(key)) return;
        fs.stat(full, (err, st) => {
          if (err || !st.isFile()) return;
          // A replay OBS just wrote was created moments ago.
          if (Date.now() - Math.max(st.birthtimeMs, st.mtimeMs) > 2 * 60 * 1000) return;
          this.known.add(key);
          this.emit('file', full);
        });
      });
      this.w.on('error', () => {});
      return true;
    } catch {
      return false;
    }
  }
  matches(fname) {
    const ext = path.extname(fname).toLowerCase();
    return this.exts.has(ext) && (!this.prefix || fname.toLowerCase().startsWith(this.prefix));
  }
  list() {
    if (!this.dir || !fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isFile() && this.matches(d.name))
      .map((d) => path.join(this.dir, d.name));
  }
  pending() {
    if (!this.dir || !fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((d) => d.isFile() && this.matches(d.name))
      .map((d) => path.join(this.dir, d.name));
  }
  stop() {
    if (this.w) this.w.close();
    this.w = null;
  }
}

module.exports = { ObsLink, FolderWatcher, detectObsConfig };
