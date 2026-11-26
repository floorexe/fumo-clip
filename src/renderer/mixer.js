// Live multi-track audio mixer. The video plays silently; every OBS audio track plays from its own
// extracted file, routed through Web Audio (gain + level meter) and kept in sync with the video.
class AudioMixer {
  constructor(video) {
    this.video = video;
    this.ctx = null;
    this.tracks = [];
    this.multi = false;
    this.masterVolume = 1;
    this.masterMuted = false;
    this._syncTimer = null;
    const v = video;
    const each = (fn) => this.multi && this.tracks.forEach((t) => t.el && fn(t.el));
    v.addEventListener('play', () => {
      this.resume();
      each((a) => {
        a.currentTime = v.currentTime;
        a.playbackRate = v.playbackRate;
        a.play().catch(() => {});
      });
    });
    v.addEventListener('playing', () => each((a) => ((a.currentTime = v.currentTime), a.play().catch(() => {}))));
    v.addEventListener('pause', () => each((a) => a.pause()));
    v.addEventListener('waiting', () => each((a) => a.pause()));
    v.addEventListener('seeking', () => each((a) => (a.currentTime = v.currentTime)));
    v.addEventListener('ratechange', () => each((a) => (a.playbackRate = v.playbackRate)));
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  ensureCtx() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ latencyHint: 'playback' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    // The video element's own audio (used when a clip only has one track).
    this.vSrc = this.ctx.createMediaElementSource(this.video);
    this.vGain = this.ctx.createGain();
    this.vAn = this.makeAnalyser();
    this.vSrc.connect(this.vGain).connect(this.vAn).connect(this.master);
  }

  makeAnalyser() {
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.3;
    return an;
  }

  /** tracks: null (single-track clip) or [{ index, url, title, channels }] */
  load(tracks, saved = {}) {
    this.unload();
    this.ensureCtx();
    this.multi = !!(tracks && tracks.length > 1);
    if (this.multi) {
      this.vGain.gain.value = 0;
      this.tracks = tracks.map((t) => {
        const el = new Audio();
        el.preload = 'auto';
        el.crossOrigin = 'anonymous';
        el.src = t.url;
        const src = this.ctx.createMediaElementSource(el);
        const gain = this.ctx.createGain();
        const an = this.makeAnalyser();
        src.connect(gain).connect(an).connect(this.master);
        const s = saved[t.index] || {};
        return { index: t.index, title: t.title, channels: t.channels, el, src, gain, an, volume: s.volume ?? 1, muted: !!s.muted, solo: false, buf: null };
      });
      this._syncTimer = setInterval(() => this.sync(), 200);
    } else {
      const s = saved[0] || {};
      this.tracks = [{ index: 0, title: '', el: null, gain: this.vGain, an: this.vAn, volume: s.volume ?? 1, muted: !!s.muted, solo: false }];
    }
    this.apply();
  }

  unload() {
    clearInterval(this._syncTimer);
    if (this.multi) {
      for (const t of this.tracks) {
        t.el.pause();
        t.src.disconnect();
        t.gain.disconnect();
        t.an.disconnect();
        t.el.removeAttribute('src');
        t.el.load();
      }
    }
    this.tracks = [];
    this.multi = false;
  }

  sync() {
    const v = this.video;
    if (v.paused || v.seeking) return;
    for (const t of this.tracks) {
      const a = t.el;
      if (!a || a.readyState < 2) continue;
      const drift = a.currentTime - v.currentTime;
      if (Math.abs(drift) > 0.07) a.currentTime = v.currentTime;
      if (a.paused) a.play().catch(() => {});
    }
  }

  effectiveGain(t) {
    const anySolo = this.tracks.some((x) => x.solo);
    if (anySolo) return t.solo ? t.volume : 0;
    return t.muted ? 0 : t.volume;
  }

  apply() {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const t of this.tracks) t.gain.gain.setTargetAtTime(this.effectiveGain(t), now, 0.015);
    if (this.master) this.master.gain.setTargetAtTime(this.masterMuted ? 0 : this.masterVolume, now, 0.015);
  }

  set(index, patch) {
    const t = this.tracks.find((x) => x.index === index);
    if (!t) return;
    Object.assign(t, patch);
    this.apply();
  }

  /** RMS level per track in 0..1 (log-scaled for display). */
  levels() {
    return this.tracks.map((t) => {
      if (!t.buf) t.buf = new Float32Array(t.an.fftSize);
      t.an.getFloatTimeDomainData(t.buf);
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < t.buf.length; i++) {
        const s = t.buf[i];
        sum += s * s;
        if (Math.abs(s) > peak) peak = Math.abs(s);
      }
      const rms = Math.sqrt(sum / t.buf.length);
      const db = 20 * Math.log10(rms + 1e-8);
      return { level: Math.max(0, Math.min(1, (db + 60) / 60)), clip: peak >= 0.99 };
    });
  }

  /** Mix settings for export: only tracks you can currently hear. */
  exportTracks() {
    return this.tracks.map((t) => ({ index: t.index, volume: this.effectiveGain(t), enabled: this.effectiveGain(t) > 0 }));
  }
}
