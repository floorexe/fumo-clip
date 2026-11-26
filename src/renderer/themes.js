// Colour themes. Each theme is just a set of CSS variables; Touhou themes also get a faint
// "danmaku" bullet-dot background (p1 / p2 colours).
const THEME_BASE = {
  danger: '#ff5a6a',
  good: '#3ddc97',
  warn: '#ffb648',
  'on-accent': '#ffffff',
  playhead: '#ffffff',
  p1: 'transparent',
  p2: 'transparent',
};

const THEMES = {
  // ---------- Fumo Clip ----------
  midnight: { group: 'Fumo Clip', name: 'Midnight', vars: { bg: '#0e0f13', bg2: '#15171d', bg3: '#1c1f27', bg4: '#252935', line: '#2a2e3a', text: '#e8eaf0', muted: '#8b90a0', accent: '#8b6cff', accent2: '#6d4dff', accent3: '#4fc3ff' } },
  oled: { group: 'Fumo Clip', name: 'OLED Black', vars: { bg: '#000000', bg2: '#0a0a0a', bg3: '#141414', bg4: '#1f1f1f', line: '#262626', text: '#f2f2f2', muted: '#8a8a8a', accent: '#5aa9ff', accent2: '#2f86ff', accent3: '#9be7ff' } },
  light: { group: 'Fumo Clip', name: 'Daylight', light: true, vars: { bg: '#f3f4f8', bg2: '#ffffff', bg3: '#eceef4', bg4: '#dfe2ea', line: '#d5d9e3', text: '#1b1e27', muted: '#697083', accent: '#6d4dff', accent2: '#5a3bea', accent3: '#2fa9e8', playhead: '#1b1e27', good: '#12a86b', warn: '#c77f00', danger: '#e5354a' } },
  frost: { group: 'Fumo Clip', name: 'Frost', vars: { bg: '#1b2029', bg2: '#222833', bg3: '#2a313e', bg4: '#343c4b', line: '#3a4252', text: '#e5e9f0', muted: '#96a0b3', accent: '#88c0d0', accent2: '#5e9fb8', accent3: '#b48ead' } },
  ember: { group: 'Fumo Clip', name: 'Ember', vars: { bg: '#120f0d', bg2: '#1a1512', bg3: '#231c17', bg4: '#2e251e', line: '#372c23', text: '#f1e9e2', muted: '#a8988a', accent: '#ff7a2f', accent2: '#e85d10', accent3: '#ffc145' } },
  sakura: { group: 'Fumo Clip', name: 'Sakura', vars: { bg: '#161015', bg2: '#1e161d', bg3: '#271d26', bg4: '#332631', line: '#3b2c39', text: '#f5e8f1', muted: '#ad97a8', accent: '#ff8fc8', accent2: '#e8609f', accent3: '#ffd1e6' } },
  forest: { group: 'Fumo Clip', name: 'Forest', vars: { bg: '#0d1210', bg2: '#131a16', bg3: '#1a231e', bg4: '#222e27', line: '#2a372f', text: '#e4efe8', muted: '#8fa597', accent: '#4fd18b', accent2: '#2fb06d', accent3: '#c8e66b' } },

  // ---------- Touhou (colour palettes inspired by the characters) ----------
  reimu: { group: 'Touhou', name: 'Reimu', note: 'Shrine red & white', light: true, vars: { bg: '#f7f2ec', bg2: '#fffdfa', bg3: '#f1e8df', bg4: '#e6d8cb', line: '#e0d0c2', text: '#2a1a17', muted: '#7d675e', accent: '#d7263d', accent2: '#b81d31', accent3: '#e9a21f', playhead: '#2a1a17', good: '#1f9d63', warn: '#c27a00', danger: '#c81e33', p1: 'rgba(215,38,61,.08)', p2: 'rgba(233,162,31,.10)' } },
  marisa: { group: 'Touhou', name: 'Marisa', note: 'Black & gold, stardust', vars: { bg: '#0f0d0a', bg2: '#17140f', bg3: '#201b14', bg4: '#2b241a', line: '#342b1f', text: '#f5eedc', muted: '#a99c80', accent: '#f5c542', accent2: '#e0ad25', accent3: '#ffffff', 'on-accent': '#1a1406', p1: 'rgba(245,197,66,.11)', p2: 'rgba(255,255,255,.05)' } },
  sakuya: { group: 'Touhou', name: 'Sakuya', note: 'Silver knives, stopped time', vars: { bg: '#12151b', bg2: '#191d25', bg3: '#212630', bg4: '#2b313d', line: '#333a47', text: '#eef1f6', muted: '#9aa3b5', accent: '#9fb4d6', accent2: '#6f8bbd', accent3: '#c9d3e6', p1: 'rgba(201,211,230,.07)', p2: 'rgba(111,139,189,.09)' } },
  remilia: { group: 'Touhou', name: 'Remilia', note: 'Scarlet mansion', vars: { bg: '#14070b', bg2: '#1d0b10', bg3: '#281017', bg4: '#35161f', line: '#401b25', text: '#f7e6ea', muted: '#b08a94', accent: '#e0303f', accent2: '#b81f2d', accent3: '#b9a7ff', p1: 'rgba(224,48,63,.11)', p2: 'rgba(185,167,255,.05)' } },
  flandre: { group: 'Touhou', name: 'Flandre', note: 'Crimson with crystal wings', vars: { bg: '#120b10', bg2: '#1a1017', bg3: '#23151f', bg4: '#2e1c28', line: '#382231', text: '#fbe9ef', muted: '#b39aa8', accent: '#ff3d5a', accent2: '#e0213f', accent3: '#ffd84d', p1: 'rgba(255,61,90,.10)', p2: 'rgba(92,214,255,.08)' } },
  cirno: { group: 'Touhou', name: 'Cirno', note: 'Ice fairy ⑨', vars: { bg: '#0a1424', bg2: '#0f1b2f', bg3: '#15243b', bg4: '#1d2f4a', line: '#243857', text: '#e6f4ff', muted: '#8fb0cc', accent: '#5cd0ff', accent2: '#2aa8e6', accent3: '#bdf0ff', 'on-accent': '#04263a', p1: 'rgba(189,240,255,.10)', p2: 'rgba(92,208,255,.07)' } },
  youmu: { group: 'Touhou', name: 'Youmu', note: 'Half-phantom gardener', vars: { bg: '#0f1312', bg2: '#151b19', bg3: '#1c2421', bg4: '#252f2b', line: '#2d3833', text: '#eaf1ee', muted: '#98aaa2', accent: '#7fd6a6', accent2: '#4fb784', accent3: '#dfe6e9', 'on-accent': '#0b2418', p1: 'rgba(223,230,233,.07)', p2: 'rgba(127,214,166,.07)' } },
  yuyuko: { group: 'Touhou', name: 'Yuyuko', note: 'Ghostly cherry blossoms', vars: { bg: '#151019', bg2: '#1d1622', bg3: '#261d2d', bg4: '#312639', line: '#3a2d43', text: '#fbeef6', muted: '#b29fb8', accent: '#ff9ccf', accent2: '#e86fae', accent3: '#8fd3ff', 'on-accent': '#2b0c1c', p1: 'rgba(255,156,207,.10)', p2: 'rgba(143,211,255,.06)' } },
  patchouli: { group: 'Touhou', name: 'Patchouli', note: 'Library of moonlight', vars: { bg: '#120f1a', bg2: '#191524', bg3: '#211c30', bg4: '#2b243d', line: '#332b48', text: '#efe9fb', muted: '#a79cc0', accent: '#b48cff', accent2: '#9466f0', accent3: '#ff9ad5', p1: 'rgba(180,140,255,.09)', p2: 'rgba(255,154,213,.05)' } },
  koishi: { group: 'Touhou', name: 'Koishi', note: 'Closed third eye', vars: { bg: '#0f1410', bg2: '#151c17', bg3: '#1c251f', bg4: '#253129', line: '#2c3a31', text: '#eef6ef', muted: '#9db1a2', accent: '#8be08a', accent2: '#5fc35f', accent3: '#ffd86b', 'on-accent': '#0d260d', p1: 'rgba(139,224,138,.08)', p2: 'rgba(190,120,255,.07)' } },
  sanae: { group: 'Touhou', name: 'Sanae', note: 'Wind priestess', vars: { bg: '#0e1517', bg2: '#141d20', bg3: '#1a262a', bg4: '#223236', line: '#29393e', text: '#eaf6f5', muted: '#93aeae', accent: '#49d6a8', accent2: '#23b688', accent3: '#5ea8ff', p1: 'rgba(73,214,168,.08)', p2: 'rgba(94,168,255,.08)' } },
};

// ---------- custom theme: you pick the main colours, the rest is worked out ----------
const CUSTOM_KEYS = [
  ['bg', 'Background'],
  ['bg2', 'Sidebar & panels'],
  ['bg3', 'Cards & inputs'],
  ['line', 'Borders'],
  ['text', 'Text'],
  ['muted', 'Faded text'],
  ['accent', 'Accent'],
  ['accent2', 'Buttons'],
  ['accent3', 'Highlight'],
];
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function customThemeDef(c) {
  const base = THEMES.midnight.vars;
  const v = {};
  for (const [k] of CUSTOM_KEYS) v[k] = (c && c[k]) || base[k];
  v.bg4 = `color-mix(in srgb, ${v.bg3} 82%, ${v.text})`;
  v['on-accent'] = luminance(v.accent2) > 0.45 ? '#111111' : '#ffffff';
  v.playhead = v.text;
  const light = luminance(v.bg) > 0.45;
  if (light) Object.assign(v, { good: '#12a86b', warn: '#c77f00', danger: '#e5354a' });
  return { group: 'Custom', name: 'Custom', light, vars: v };
}
function readCustom() {
  try {
    return JSON.parse(localStorage.customTheme || 'null');
  } catch {
    return null;
  }
}
/** Hex colours of a theme (for starting a custom theme from it). */
function themeHexColors(id) {
  const t = id === 'custom' ? customThemeDef(readCustom()) : THEMES[id] || THEMES.midnight;
  const out = {};
  for (const [k] of CUSTOM_KEYS) out[k] = /^#[0-9a-f]{6}$/i.test(t.vars[k]) ? t.vars[k] : THEMES.midnight.vars[k];
  return out;
}

// ---------- background image (works with any theme) ----------
function applyBackground(bg) {
  const layer = document.getElementById('bg-layer');
  const root = document.documentElement;
  const on = !!(bg && bg.file);
  root.classList.toggle('has-bg', on);
  try {
    localStorage.bgImage = JSON.stringify(on ? bg : null);
  } catch {}
  if (!layer) return;
  if (!on) {
    layer.style.backgroundImage = '';
    return;
  }
  layer.style.backgroundImage = `url("clipdeck://app/media?p=${encodeURIComponent(bg.file)}")`;
  layer.style.filter = bg.blur ? `blur(${bg.blur}px)` : '';
  layer.style.setProperty('--bg-dim', String((bg.dim ?? 45) / 100));
  root.style.setProperty('--glass', String((bg.glass ?? 25) / 100));
}

function applyTheme(id, custom) {
  if (id === 'custom') {
    if (custom) {
      try {
        localStorage.customTheme = JSON.stringify(custom);
      } catch {}
    }
  }
  const t = id === 'custom' ? customThemeDef(custom || readCustom()) : THEMES[id] || THEMES.midnight;
  const root = document.documentElement;
  const vars = { ...THEME_BASE, ...t.vars };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty('--' + k, v);
  root.style.colorScheme = t.light ? 'light' : 'dark';
  root.dataset.theme = id === 'custom' || THEMES[id] ? id : 'midnight';
  root.classList.toggle('patterned', vars.p1 !== 'transparent');
  try {
    localStorage.theme = root.dataset.theme;
  } catch {}
}

// Apply the last-used theme immediately (before the app finishes loading) to avoid a flash.
try {
  applyTheme(localStorage.theme || 'midnight');
} catch {}
document.addEventListener('DOMContentLoaded', () => {
  try {
    applyBackground(JSON.parse(localStorage.bgImage || 'null'));
  } catch {}
});
