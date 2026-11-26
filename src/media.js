// ffmpeg / ffprobe helpers: probing, thumbnails, audio-track extraction, proxies, export.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function binPath(p) {
  // When packaged, binaries live in app.asar.unpacked
  return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}
const FFMPEG = binPath(require('ffmpeg-static'));
const FFPROBE = binPath(require('ffprobe-static').path);

function run(bin, args, { onStderr, signal } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true, signal });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (err.length > 20000) err = err.slice(-10000);
      if (onStderr) onStderr(s);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split('\n').slice(-3).join('\n') || `exit ${code}`));
    });
  });
}

// Generic default names that muxers write; not useful as track labels.
const JUNK_TITLES = /^(soundhandler|sound handler|audio|core media audio|iso media file produced by .*|)$/i;

async function probe(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = (j.streams || []).filter((s) => s.codec_type === 'audio');
  const fpsStr = (v && (v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate)) || '0/1';
  const [n, d] = fpsStr.split('/').map(Number);
  const tags = (s) => s.tags || {};
  return {
    duration: parseFloat(j.format && j.format.duration) || parseFloat(v && v.duration) || 0,
    width: v ? v.width : 0,
    height: v ? v.height : 0,
    fps: d ? Math.round((n / d) * 100) / 100 : 0,
    vcodec: v ? v.codec_name : null,
    audioTracks: audio.map((s, i) => {
      const t = tags(s).title || tags(s).handler_name || '';
      return {
        index: i,
        codec: s.codec_name,
        channels: s.channels,
        title: JUNK_TITLES.test(t.trim()) ? '' : t.trim(),
      };
    }),
  };
}

async function thumbnail(file, out, duration) {
  const at = Math.min(Math.max((duration || 0) * 0.1, 0), 3);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp.jpg';
  await run(FFMPEG, ['-y', '-v', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', tmp]);
  fs.renameSync(tmp, out);
}

// Split each audio track into its own .m4a so the player can mix them live.
async function extractAudio(file, outDir, tracks) {
  fs.mkdirSync(outDir, { recursive: true });
  const args = ['-y', '-v', 'error', '-i', file];
  const outs = [];
  for (const t of tracks) {
    const out = path.join(outDir, `a${t.index}.m4a`);
    outs.push(out);
    args.push('-map', `0:a:${t.index}`, '-vn');
    if (t.codec === 'aac') args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k');
    args.push(out + '.tmp.m4a');
  }
  await run(FFMPEG, args);
  outs.forEach((o) => fs.renameSync(o + '.tmp.m4a', o));
  return outs;
}

// Make a Chromium-playable copy. mode 'remux' = container swap only, 'transcode' = re-encode to H.264.
async function makeProxy(file, out, mode) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + '.tmp.mp4';
  const args = ['-y', '-v', 'error', '-i', file, '-map', '0:v:0', '-map', '0:a?'];
  if (mode === 'remux') args.push('-c', 'copy');
  else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k');
  args.push('-movflags', '+faststart', tmp);
  await run(FFMPEG, args);
  fs.renameSync(tmp, out);
}

// ---------- encoder detection ----------
const encoderCache = {};
const CANDIDATES = {
  h264: ['h264_nvenc', 'h264_amf', 'h264_qsv'],
  hevc: ['hevc_nvenc', 'hevc_amf', 'hevc_qsv'],
};
const CPU = { h264: 'libx264', hevc: 'libx265' };
/** Fastest working encoder for a codec: GPU (NVIDIA/AMD/Intel) if it works, else the CPU encoder. */
function detectEncoder(codec = 'h264') {
  if (!encoderCache[codec]) {
    encoderCache[codec] = (async () => {
      for (const enc of CANDIDATES[codec] || []) {
        try {
          await run(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=0.2', '-c:v', enc, '-f', 'null', '-']);
          return enc;
        } catch {}
      }
      return CPU[codec] || 'libx264';
    })();
  }
  return encoderCache[codec];
}

// "Constant quality" levels used when there's no file-size limit.
const QUALITY_CQ = { best: 16, high: 19, balanced: 23, small: 28 };

function videoEncodeArgs(enc, kbps, quality) {
  const cq = QUALITY_CQ[quality] || QUALITY_CQ.high;
  const rate = (extra = []) => ['-b:v', kbps + 'k', '-maxrate', kbps + 'k', '-bufsize', kbps * 2 + 'k', ...extra];
  if (enc.endsWith('_nvenc')) {
    const a = ['-c:v', enc, '-preset', 'p5', '-tune', 'hq', '-pix_fmt', 'yuv420p'];
    return kbps ? [...a, '-rc', 'vbr', ...rate()] : [...a, '-rc', 'vbr', '-cq', String(cq), '-b:v', '0'];
  }
  if (enc.endsWith('_amf')) {
    const a = ['-c:v', enc, '-quality', 'quality', '-pix_fmt', 'yuv420p'];
    return kbps ? [...a, '-rc', 'vbr_peak', '-b:v', kbps + 'k', '-maxrate', kbps + 'k'] : [...a, '-rc', 'cqp', '-qp_i', String(cq), '-qp_p', String(cq + 2)];
  }
  if (enc.endsWith('_qsv')) {
    const a = ['-c:v', enc, '-preset', 'medium', '-pix_fmt', 'nv12'];
    return kbps ? [...a, '-b:v', kbps + 'k', '-maxrate', kbps + 'k'] : [...a, '-global_quality', String(cq + 1)];
  }
  if (enc === 'libx265') {
    const a = ['-c:v', 'libx265', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'];
    return kbps ? [...a, ...rate()] : [...a, '-crf', String(cq + 3)];
  }
  const a = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
  return kbps ? [...a, ...rate()] : [...a, '-crf', String(cq - 1)];
}

/**
 * Plan the video settings for an export (also used by the UI to show an estimate).
 * o: { duration (of the export), sizeMB (0 = no limit), height ('auto' | 0 = original | px), fps (0 = original),
 *      srcHeight, srcFps, audioMode, audioKbps, nAudioTracks }
 */
function planExport(o) {
  const len = Math.max(0.1, o.duration || 0.1);
  const nAudio = o.audioMode === 'none' ? 0 : o.audioMode === 'separate' ? o.nAudioTracks || 0 : o.nAudioTracks ? 1 : 0;
  const audioKbps = nAudio * (o.audioKbps || 128);
  let kbps = null;
  if (o.sizeMB > 0) kbps = Math.max(150, Math.floor((o.sizeMB * 8 * 1024 * 0.9) / len - audioKbps));
  let height = 0;
  if (o.height === 'auto' || o.height == null) {
    // only shrink when a size limit makes the bitrate too small for the full resolution
    if (kbps) height = kbps < 1200 ? 480 : kbps < 2500 ? 720 : kbps < 6000 ? 1080 : 0;
  } else height = +o.height || 0;
  if (o.srcHeight && height >= o.srcHeight) height = 0;
  const fps = o.fps && (!o.srcFps || o.fps < o.srcFps - 0.5) ? +o.fps : 0;
  return { kbps, height, fps, audioKbps, nAudio };
}

/**
 * Render a shareable mp4.
 * opts: {
 *   input, output, start, end, duration (of source), srcHeight, srcFps, nAudioTracks,
 *   tracks: [{ index, volume, enabled }]   // for audioMode 'mix'
 *   audioMode: 'mix' | 'separate' | 'none', audioKbps,
 *   sizeMB (0 = no limit), height ('auto' | 0 | px), fps (0 | 30 | 60…), quality ('best'|'high'|'balanced'|'small'),
 *   codec: 'h264' | 'hevc', encoder: 'auto' | 'cpu', signal
 * }
 */
async function exportClip(opts, onProgress) {
  const start = Math.max(0, opts.start || 0);
  const end = opts.end && opts.end > start ? opts.end : opts.duration;
  const len = Math.max(0.1, end - start);
  const audioMode = opts.audioMode || 'mix';
  const active = (opts.tracks || []).filter((t) => t.enabled && t.volume > 0);
  const plan = planExport({
    duration: len,
    sizeMB: opts.sizeMB,
    height: opts.height,
    fps: opts.fps,
    srcHeight: opts.srcHeight,
    srcFps: opts.srcFps,
    audioMode,
    audioKbps: opts.audioKbps,
    nAudioTracks: audioMode === 'mix' ? (active.length ? 1 : 0) : opts.nAudioTracks,
  });

  const filters = [];
  const maps = ['-map', '0:v:0'];
  let audioArgs = ['-an'];
  const ab = (opts.audioKbps || (opts.sizeMB ? 128 : 192)) + 'k';
  if (audioMode === 'mix' && active.length) {
    const parts = active.map((t, i) => '[0:a:' + t.index + ']volume=' + t.volume.toFixed(3) + '[m' + i + ']');
    if (active.length === 1) filters.push(parts[0].replace('[m0]', '[aout]'));
    else {
      filters.push(...parts);
      filters.push(active.map((_, i) => '[m' + i + ']').join('') + 'amix=inputs=' + active.length + ':normalize=0:dropout_transition=0[aout]');
    }
    maps.push('-map', '[aout]');
    audioArgs = ['-c:a', 'aac', '-b:a', ab];
  } else if (audioMode === 'separate' && opts.nAudioTracks > 0) {
    maps.push('-map', '0:a');
    audioArgs = ['-c:a', 'aac', '-b:a', ab];
  }

  const vf = [];
  if (plan.height) vf.push('scale=-2:' + plan.height);
  if (plan.fps) vf.push('fps=' + plan.fps);
  if (vf.length) {
    filters.push('[0:v:0]' + vf.join(',') + '[vout]');
    maps[1] = '[vout]';
  }

  const codec = opts.codec === 'hevc' ? 'hevc' : 'h264';
  const build = (enc) => {
    const args = ['-y', '-hide_banner', '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', opts.input];
    if (filters.length) args.push('-filter_complex', filters.join(';'));
    args.push(...maps, ...videoEncodeArgs(enc, plan.kbps, opts.quality), ...audioArgs, '-movflags', '+faststart', opts.output);
    return args;
  };
  const progress = (s) => {
    const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(s);
    if (m && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / len));
  };

  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  const enc = opts.encoder === 'cpu' ? CPU[codec] : await detectEncoder(codec);
  try {
    await run(FFMPEG, build(enc), { onStderr: progress, signal: opts.signal });
  } catch (e) {
    if (enc === CPU[codec] || (opts.signal && opts.signal.aborted)) throw e;
    await run(FFMPEG, build(CPU[codec]), { onStderr: progress, signal: opts.signal }); // GPU encoder hiccup: fall back to CPU
  }
  return { output: opts.output, plan, encoder: enc };
}

/**
 * Join several clip segments into one mp4.
 * o: { items: [{ input, start, end, width, height, fps, tracks: [{ index, volume, enabled }] }],
 *      output, sizeMB, height ('auto' | 0 | px), quality, audioKbps, signal }
 * Every segment is scaled/letterboxed to the first clip's shape and its audio tracks are mixed.
 */
async function combineClips(o, onProgress) {
  const items = o.items;
  const lens = items.map((it) => Math.max(0.1, it.end - it.start));
  const total = lens.reduce((a, b) => a + b, 0);
  const first = items[0];
  const plan = planExport({
    duration: total,
    sizeMB: o.sizeMB,
    height: o.height,
    fps: 0,
    srcHeight: first.height,
    srcFps: first.fps,
    audioMode: 'mix',
    audioKbps: o.audioKbps || 128,
    nAudioTracks: 1,
  });
  const H = Math.round((plan.height || first.height || 1080) / 2) * 2;
  const W = Math.round(((first.width || 1920) * H) / (first.height || 1080) / 2) * 2;
  const F = Math.min(120, Math.round(first.fps || 60));
  const inputs = [];
  const filters = [];
  items.forEach((it, i) => {
    const len = lens[i].toFixed(3);
    inputs.push('-ss', it.start.toFixed(3), '-to', it.end.toFixed(3), '-i', it.input);
    filters.push(
      '[' + i + ':v:0]scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2,setsar=1,fps=' + F +
        ',format=yuv420p,trim=duration=' + len + ',setpts=PTS-STARTPTS[v' + i + ']'
    );
    const act = (it.tracks || []).filter((t) => t.enabled && t.volume > 0);
    const tail = ',aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:' + len + ',asetpts=PTS-STARTPTS[a' + i + ']';
    if (!act.length) filters.push('anullsrc=r=48000:cl=stereo,atrim=0:' + len + ',asetpts=PTS-STARTPTS[a' + i + ']');
    else {
      act.forEach((t, k) => filters.push('[' + i + ':a:' + t.index + ']volume=' + t.volume.toFixed(3) + '[m' + i + '_' + k + ']'));
      if (act.length === 1) filters.push('[m' + i + '_0]anull' + tail);
      else filters.push(act.map((_, k) => '[m' + i + '_' + k + ']').join('') + 'amix=inputs=' + act.length + ':normalize=0:dropout_transition=0' + tail);
    }
  });
  filters.push(items.map((_, i) => '[v' + i + '][a' + i + ']').join('') + 'concat=n=' + items.length + ':v=1:a=1[vout][aout]');
  const ab = (o.audioKbps || (o.sizeMB ? 128 : 192)) + 'k';
  const build = (enc) => [
    '-y', '-hide_banner', ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    ...videoEncodeArgs(enc, plan.kbps, o.quality || 'high'),
    '-c:a', 'aac', '-b:a', ab, '-movflags', '+faststart', o.output,
  ];
  const progress = (s) => {
    const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(s);
    if (m && onProgress) onProgress(Math.min(1, (+m[1] * 3600 + +m[2] * 60 + +m[3]) / total));
  };
  fs.mkdirSync(path.dirname(o.output), { recursive: true });
  const enc = await detectEncoder('h264');
  try {
    await run(FFMPEG, build(enc), { onStderr: progress, signal: o.signal });
  } catch (e) {
    if (enc === 'libx264' || (o.signal && o.signal.aborted)) throw e;
    await run(FFMPEG, build('libx264'), { onStderr: progress, signal: o.signal });
  }
  return { output: o.output, plan, width: W, height: H };
}

/** Peak waveform for one audio track: array of 0..1 values (sqrt-scaled so quiet audio stays visible). */
function waveform(file, index, buckets = 1600) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:a:' + index, '-ac', '1', '-ar', '3000', '-f', 's16le', 'pipe:1'], { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0 && !chunks.length) return reject(new Error('waveform failed'));
      const buf = Buffer.concat(chunks);
      const n = Math.floor(buf.length / 2);
      const count = Math.max(1, Math.min(buckets, n));
      const per = n / count;
      const out = new Array(count);
      for (let b = 0; b < count; b++) {
        let peak = 0;
        const s0 = Math.floor(b * per);
        const s1 = Math.max(s0 + 1, Math.floor((b + 1) * per));
        for (let i = s0; i < s1 && i < n; i++) {
          const v = Math.abs(buf.readInt16LE(i * 2));
          if (v > peak) peak = v;
        }
        out[b] = Math.round(Math.sqrt(peak / 32768) * 1000) / 1000;
      }
      resolve(out);
    });
  });
}

module.exports = { FFMPEG, FFPROBE, run, probe, thumbnail, extractAudio, makeProxy, exportClip, planExport, combineClips, waveform, detectEncoder };
