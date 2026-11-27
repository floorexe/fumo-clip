/* global api, icon, hydrateIcons, AudioMixer */
'use strict';

// ============================================================ utils
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => {
  let t;
  return (...a) => (clearTimeout(t), (t = setTimeout(() => fn(...a), ms)));
};
function fmtDur(s, tenths = false) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = tenths ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
function fmtSize(b) {
  if (b > 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b > 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}
const fmtTimeOfDay = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function toast(text, kind = '', actions = []) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `<span>${esc(text)}</span>`;
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = a.label;
    b.onclick = () => (a.run(), el.remove());
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), actions.length ? 9000 : 4500);
}
async function call(ch, ...a) {
  try {
    return await api.invoke(ch, ...a);
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast(msg, 'error');
    throw e;
  }
}

// ============================================================ state
const S = {
  clips: [],
  settings: {},
  view: 'all', // all | favorites | exports | game:<name>
  search: '',
  sort: 'newest',
  selected: new Set(),
  lastClicked: null,
  current: null,
  obs: { status: 'disabled' },
  trim: null,
  visible: [],
  cats: [],
  lastGame: null,
};
const byId = (id) => S.clips.find((c) => c.id === id);
function upsert(c) {
  const i = S.clips.findIndex((x) => x.id === c.id);
  if (i >= 0) S.clips[i] = c;
  else S.clips.push(c);
}

// ============================================================ boot
async function boot() {
  hydrateIcons();
  S.settings = await call('settings:get');
  applyTheme(S.settings.theme || 'midnight', S.settings.customTheme || undefined);
  applyBackground(S.settings.bgImage);
  S.cats = await call('categories:list');
  S.clips = await call('library:current');
  S.obs = await call('obs:status');
  document.documentElement.style.setProperty('--card', (localStorage.cardSize || 280) + 'px');
  $('#card-size').value = localStorage.cardSize || 280;
  renderObs();
  renderAll();
  wireLibrary();
  wirePlayer();

  api.on('obs:status', (s) => ((S.obs = s), renderObs()));
  api.on('clip:added', (c) => {
    upsert(c);
    renderAll();
    toast(`Clip saved: ${c.game}`, 'good', [{ label: 'Watch', run: () => openClip(c.id) }]);
  });
  api.on('clip:updated', (c) => {
    if (!byId(c.id)) return;
    upsert(c);
    updateCard(c);
    if (S.current && S.current.id === c.id) {
      S.current = { ...S.current, ...c };
      renderDetails();
    }
  });
  api.on('library:changed', async () => {
    S.clips = await api.invoke('library:current');
    if (S.current && !byId(S.current.id)) closePlayer();
    renderAll();
  });
  api.on('toast', (t) => toast(t.text, t.kind));
  api.on('update:status', (u) => {
    S.update = u;
    renderUpdateStatus();
    renderUpdateBanner();
  });
  api.invoke('update:status').then((u) => ((S.update = u), renderUpdateBanner())).catch(() => {});
  api.on('export:progress', (p) => P.shareProgress && P.shareProgress(p));
}

// ============================================================ sidebar
function renderObs() {
  const pill = $('#obs-pill');
  const s = S.obs;
  pill.className = 'obs-pill';
  let txt;
  if (s.status === 'connected') {
    pill.classList.add(s.replayActive ? 'replay' : 'connected');
    txt = s.replayActive ? 'Replay buffer on' : 'OBS connected · buffer off';
  } else if (s.status === 'connecting') txt = 'Connecting to OBS…';
  else if (s.status === 'disabled') txt = S.settings.watchEnabled ? 'Watching folder' : 'OBS link off';
  else {
    pill.classList.add('error');
    txt = s.error || (S.settings.watchEnabled ? 'OBS offline · watching folder' : 'OBS offline');
  }
  pill.querySelector('.txt').textContent = txt;
  pill.title = s.status === 'connected' ? (s.replayActive ? 'Click to stop the replay buffer' : 'Click to start the replay buffer') : 'Open settings';
  $('#btn-save-replay').disabled = !(s.status === 'connected');
  $('#btn-save-replay').title = s.status === 'connected' ? 'Save the OBS replay buffer now' : 'Connect to OBS WebSocket (Settings) to save from here. Your OBS hotkey always works.';
}

function games() {
  const m = new Map();
  for (const c of S.clips) {
    if (c.isExport) continue;
    const g = m.get(c.game) || { name: c.game, count: 0, latest: null };
    g.count++;
    if (!g.latest || c.created > g.latest.created) g.latest = c;
    m.set(c.game, g);
  }
  return [...m.values()].sort((a, b) => b.latest.created - a.latest.created);
}

function renderSidebar() {
  $('#count-all').textContent = S.clips.filter((c) => !c.isExport).length;
  $('#count-fav').textContent = S.clips.filter((c) => c.favorite).length;
  $('#count-exp').textContent = S.clips.filter((c) => c.isExport).length;
  const list = games();
  $('#games').innerHTML = list
    .map(
      (g) => `<button class="nav-item ${S.view === 'game:' + g.name ? 'active' : ''} ${gameSelected(g.name) ? 'sel' : ''}" data-view="game:${esc(g.name)}" title="Ctrl-click / Shift-click to select all clips in this game">
        ${g.latest.thumb ? `<img class="game-thumb" src="${esc(g.latest.thumb)}">` : `<span class="game-thumb"></span>`}
        <span>${esc(g.name)}</span><em>${g.count}</em></button>`
    )
    .join('');
  $$('#nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
  $('#game-list').innerHTML = list.map((g) => `<option value="${esc(g.name)}">`).join('');
  const counts = {};
  for (const c of S.clips) for (const t of c.tags || []) counts[t] = (counts[t] || 0) + 1;
  const cats = [...new Set([...(S.cats || []), ...Object.keys(counts)])];
  $('#cats').innerHTML = cats.length
    ? cats
        .map(
          (t) => `<button class="nav-item ${S.view === 'cat:' + t ? 'active' : ''}" data-view="cat:${esc(t)}" title="Right-click to rename or delete">
        <span class="cat-dot">${icon('tag')}</span><span>${esc(t)}</span><em>${counts[t] || 0}</em></button>`
        )
        .join('')
    : '<div class="nav-empty">Labels for clips. A clip can be in many categories and stays in its folder, so nothing is copied.</div>';
}

// ---- selecting whole games (Ctrl/Shift-click in the sidebar)
const gameClipIds = (name) => S.clips.filter((c) => !c.isExport && c.game === name).map((c) => c.id);
function gameSelected(name) {
  const ids = gameClipIds(name);
  return ids.length > 0 && ids.every((id) => S.selected.has(id));
}
function toggleGameSelect(name, range) {
  const names = games().map((g) => g.name);
  let targets = [name];
  if (range && S.lastGame && names.includes(S.lastGame)) {
    const [a, b] = [names.indexOf(S.lastGame), names.indexOf(name)].sort((x, y) => x - y);
    targets = names.slice(a, b + 1);
  }
  const on = range ? true : !gameSelected(name);
  for (const g of targets) for (const id of gameClipIds(g)) on ? S.selected.add(id) : S.selected.delete(id);
  S.lastGame = name;
  if (S.current) closePlayer();
  renderSelection();
}
function selectedGames() {
  return games().map((g) => g.name).filter(gameSelected);
}

// ============================================================ grid
function filtered() {
  let list = S.clips;
  if (S.view === 'all') list = list.filter((c) => !c.isExport);
  else if (S.view === 'favorites') list = list.filter((c) => c.favorite);
  else if (S.view === 'exports') list = list.filter((c) => c.isExport);
  else if (S.view.startsWith('game:')) list = list.filter((c) => !c.isExport && c.game === S.view.slice(5));
  else if (S.view.startsWith('cat:')) list = list.filter((c) => (c.tags || []).includes(S.view.slice(4)));
  const q = S.search.trim().toLowerCase();
  if (q) list = list.filter((c) => (c.title + ' ' + c.game + ' ' + (c.tags || []).join(' ')).toLowerCase().includes(q));
  const sorters = {
    newest: (a, b) => b.created - a.created,
    oldest: (a, b) => a.created - b.created,
    longest: (a, b) => b.duration - a.duration,
    shortest: (a, b) => a.duration - b.duration,
    largest: (a, b) => b.size - a.size,
    name: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }),
  };
  return [...list].sort(sorters[S.sort]);
}

function viewTitle() {
  if (S.view === 'all') return 'All clips';
  if (S.view === 'favorites') return 'Favorites';
  if (S.view === 'exports') return 'Exports';
  if (S.view.startsWith('cat:')) return S.view.slice(4);
  return S.view.slice(5);
}

function cardHtml(c) {
  const nTracks = (c.tracks || []).length;
  return `<div class="card ${S.selected.has(c.id) ? 'selected' : ''}" data-id="${esc(c.id)}" draggable="true">
    <div class="thumb">
      ${c.thumb ? `<img src="${esc(c.thumb)}" loading="lazy" draggable="false">` : ''}
      <button class="fav-btn ${c.favorite ? 'on' : ''}" data-act="fav" title="Favorite">${icon('star')}</button>
      ${nTracks > 1 ? `<span class="badge tracks" title="${nTracks} audio tracks">${icon('layers')}${nTracks}</span>` : ''}
      ${(c.markers || []).length ? `<span class="badge marks" title="${c.markers.length} marker(s)">${icon('flag')}${c.markers.length}</span>` : ''}
      <span class="badge dur">${c.probed ? fmtDur(c.duration) : '…'}</span>
    </div>
    <div class="info">
      <div class="title" title="${esc(c.title)}">${esc(c.title)}</div>
      ${(c.tags || []).length ? `<div class="card-tags" title="${esc(c.tags.join(', '))}">${icon('tag')}${esc(c.tags.join(', '))}</div>` : ''}
      <div class="sub"><span>${esc(c.game)}</span><span>·</span><span>${fmtTimeOfDay(c.created)}</span><span>·</span><span>${fmtSize(c.size)}</span></div>
    </div>
  </div>`;
}

const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      const id = e.target.dataset.id;
      const c = byId(id);
      if (!c || c.thumb) continue;
      api
        .invoke('library:thumb', id)
        .then((url) => {
          if (!url) return;
          c.thumb = url;
          updateCard(c);
          renderSidebarDebounced();
        })
        .catch(() => {});
    }
  },
  { root: $('#grid-wrap'), rootMargin: '400px' }
);
const renderSidebarDebounced = debounce(renderSidebar, 300);

function renderGrid() {
  const list = filtered();
  S.visible = list;
  $('#view-title').textContent = viewTitle();
  const grid = $('#grid');
  const empty = $('#empty');
  if (!list.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    const hk = (S.settings.obsDetected && S.settings.obsDetected.hotkey) || 'your OBS replay hotkey';
    empty.innerHTML = S.search
      ? `<div><h2>No matches</h2>Nothing matches “${esc(S.search)}”.</div>`
      : S.view === 'favorites'
        ? `<div><h2>No favorites yet</h2>Hit the star on a clip to keep it here.</div>`
        : S.view === 'exports'
          ? `<div><h2>No exports yet</h2>Open a clip, trim it, and press Export.</div>`
          : `<div><h2>No clips yet</h2>Start the replay buffer in OBS and press <kbd>${esc(hk)}</kbd> in-game.<br>Clips show up here automatically, sorted by game.</div>`;
    return;
  }
  empty.classList.add('hidden');
  const groups = [];
  const timeSort = S.sort === 'newest' || S.sort === 'oldest';
  for (const c of list) {
    const label = timeSort ? dayLabel(c.created) : '';
    let g = groups[groups.length - 1];
    if (!g || g.label !== label) groups.push((g = { label, items: [] }));
    g.items.push(c);
  }
  grid.innerHTML = groups
    .map((g) => `${g.label ? `<div class="group-head">${esc(g.label)} <small>${g.items.length} clip${g.items.length > 1 ? 's' : ''}</small></div>` : ''}<div class="group">${g.items.map(cardHtml).join('')}</div>`)
    .join('');
  $$('.card', grid).forEach((el) => {
    if (!byId(el.dataset.id).thumb) thumbObserver.observe(el);
  });
}

function updateCard(c) {
  const el = $(`.card[data-id="${CSS.escape(c.id)}"]`);
  if (!el || el.matches(':hover')) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = cardHtml(c);
  el.replaceWith(tmp.firstElementChild);
}

function renderAll() {
  renderSidebar();
  renderGrid();
  renderSelection();
}

function renderSelection() {
  const n = S.selected.size;
  $('#selection-bar').classList.toggle('hidden', !n);
  const sg = selectedGames();
  $('#sel-count').textContent = `${n} clip${n === 1 ? '' : 's'} selected${sg.length ? ` · ${sg.length} game${sg.length === 1 ? '' : 's'}` : ''}`;
  $$('.card').forEach((el) => el.classList.toggle('selected', S.selected.has(el.dataset.id)));
  $$('#games .nav-item').forEach((el) => el.classList.toggle('sel', gameSelected(el.dataset.view.slice(5))));
}

// hover preview
let hoverT = null;
function startPreview(card) {
  clearTimeout(hoverT);
  hoverT = setTimeout(() => {
    const c = byId(card.dataset.id);
    if (!c || !card.matches(':hover') || $('video', card)) return;
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.src = c.url + '#t=' + Math.min(2, c.duration * 0.1 || 0);
    v.onerror = () => v.remove();
    v.play().catch(() => {});
    $('.thumb', card).appendChild(v);
  }, 450);
}
function stopPreview(card) {
  clearTimeout(hoverT);
  const v = $('video', card);
  if (v) (v.pause(), v.removeAttribute('src'), v.load(), v.remove());
}

function wireLibrary() {
  $('#nav').addEventListener('click', (e) => navClick(e));
  $('#games').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (b && (e.ctrlKey || e.metaKey || e.shiftKey)) return toggleGameSelect(b.dataset.view.slice(5), e.shiftKey);
    navClick(e);
  });
  $('#cats').addEventListener('click', (e) => navClick(e));
  $('#cats').addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.nav-item');
    if (!b) return;
    e.preventDefault();
    const name = b.dataset.view.slice(4);
    showCtx(e, [
      { label: 'Rename category…', icon: 'edit', run: () => renameCategory(name) },
      { label: 'Select its clips', icon: 'check', run: () => (S.clips.filter((c) => (c.tags || []).includes(name)).forEach((c) => S.selected.add(c.id)), renderSelection()) },
      '-',
      { label: 'Delete category', icon: 'trash', danger: true, run: () => deleteCategory(name) },
    ]);
  });
  $('#btn-new-cat').onclick = async () => {
    const n = await promptModal({ title: 'New category', placeholder: 'e.g. Funny, Clutches, With friends', ok: 'Create', note: 'Categories are labels. A clip can be in as many as you like, and it stays in its folder.' });
    if (!n) return;
    await call('categories:add', n);
    S.cats = await call('categories:list');
    renderSidebar();
  };
  $('#games').addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.nav-item');
    if (!b) return;
    e.preventDefault();
    const name = b.dataset.view.slice(5);
    const sel = selectedGames();
    if (sel.length > 1 && sel.includes(name)) {
      const ids = [...S.selected];
      return showCtx(e, [
        { label: `Move ${ids.length} clips into one game…`, icon: 'folder', run: () => moveClipsTo(ids) },
        { label: 'Add to category…', icon: 'tag', run: () => openTagModal(ids) },
        { label: 'Favorite all', icon: 'star', run: () => favClips(ids) },
        '-',
        { label: `Delete ${ids.length} clips`, icon: 'trash', danger: true, run: () => deleteClips(ids) },
      ]);
    }
    showCtx(e, [
      { label: 'Select all its clips', icon: 'check', run: () => toggleGameSelect(name, false) },
      { label: 'Rename game…', icon: 'edit', run: () => renameGame(name) },
      { label: 'Open folder', icon: 'folder', run: () => { const c = S.clips.find((x) => x.game === name && !x.isExport); if (c) api.invoke('shell:show', c.path); } },
    ]);
  });
  $('#search').addEventListener('input', debounce((e) => ((S.search = e.target.value), renderGrid()), 120));
  $('#sort').addEventListener('change', (e) => ((S.sort = e.target.value), renderGrid()));
  $('#card-size').addEventListener('input', (e) => {
    document.documentElement.style.setProperty('--card', e.target.value + 'px');
    localStorage.cardSize = e.target.value;
  });
  $('#btn-folder').onclick = () => api.invoke('shell:openLibrary');
  $('#btn-import').onclick = openImport;
  $('#btn-save-replay').onclick = async () => {
    await call('obs:save');
    toast('Saving replay…');
  };
  $('#btn-settings').onclick = openSettings;
  $('#obs-pill').onclick = async () => {
    if (S.obs.status === 'connected') await call('obs:toggleReplay');
    else openSettings('obs');
  };

  const grid = $('#grid');
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest('[data-act=fav]')) {
      e.stopPropagation();
      return toggleFav(id);
    }
    if (e.ctrlKey || e.metaKey) {
      S.selected.has(id) ? S.selected.delete(id) : S.selected.add(id);
      S.lastClicked = id;
      return renderSelection();
    }
    if (e.shiftKey && S.lastClicked) {
      const ids = S.visible.map((c) => c.id);
      const [a, b] = [ids.indexOf(S.lastClicked), ids.indexOf(id)].sort((x, y) => x - y);
      if (a >= 0) ids.slice(a, b + 1).forEach((x) => S.selected.add(x));
      return renderSelection();
    }
    if (S.selected.size) {
      S.selected.clear();
      renderSelection();
    }
    openClip(id);
  });
  grid.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    clipMenu(e, card.dataset.id);
  });
  grid.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.card');
    if (card && !card.contains(e.relatedTarget)) startPreview(card);
  });
  grid.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.card');
    if (card && !card.contains(e.relatedTarget)) stopPreview(card);
  });
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    api.startDrag(card.dataset.id); // drag the real file into Discord, Explorer, etc.
  });

  $('#selection-bar').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sel]');
    if (!b) return;
    const ids = [...S.selected];
    if (b.dataset.sel === 'combine') {
      if (ids.length < 2) return toast('Select at least 2 clips to combine (Ctrl+click or Shift+click).');
      return openCombine(ids);
    }
    if (b.dataset.sel === 'tags') return openTagModal(ids);
    if (b.dataset.sel === 'compress') return openProcess(ids, 'compress');
    if (b.dataset.sel === 'cut') return openProcess(ids, 'cut');
    if (b.dataset.sel === 'clear') S.selected.clear();
    if (b.dataset.sel === 'fav') return favClips(ids);
    if (b.dataset.sel === 'move') return moveClipsTo(ids);
    if (b.dataset.sel === 'delete') {
      if (!(await deleteClips(ids))) return;
    }
    renderAll();
  });

  document.addEventListener('click', () => hideCtx());
  window.addEventListener('blur', () => hideCtx());
}

function navClick(e) {
  const b = e.target.closest('.nav-item');
  if (!b) return;
  S.view = b.dataset.view;
  S.selected.clear();
  if (S.current) closePlayer();
  renderAll();
  $('#grid-wrap').scrollTop = 0;
}

// ============================================================ clip actions
async function toggleFav(id) {
  const c = byId(id);
  const n = await call('clip:update', id, { favorite: !c.favorite });
  upsert(n);
  if (S.current && S.current.id === id) S.current = { ...S.current, ...n };
  updateCard(n);
  renderSidebar();
  if (S.view === 'favorites') renderGrid();
  renderPlayerFav();
}

async function renameClip(id) {
  const c = byId(id);
  const t = await promptModal({ title: 'Rename clip', value: c.title, ok: 'Rename' });
  if (!t || t === c.title) return;
  const n = await call('clip:rename', id, t);
  replaceId(id, n);
}

async function moveClip(id) {
  const c = byId(id);
  const g = await promptModal({ title: 'Move to game', value: c.game, placeholder: 'Game name', datalist: games().map((x) => x.name), ok: 'Move' });
  if (!g || g === c.game) return;
  const n = await call('clip:move', id, g);
  replaceId(id, n);
}

function replaceId(oldId, n) {
  S.clips = S.clips.filter((c) => c.id !== oldId);
  upsert(n);
  if (S.current && S.current.id === oldId) {
    S.current = { ...S.current, ...n };
    renderDetails();
  }
  renderAll();
}

async function renameGame(name) {
  const n = await promptModal({ title: `Rename “${name}”`, value: name, ok: 'Rename', note: 'Moves the folder, and future clips from this game use the new name.' });
  if (!n || n === name) return;
  await call('game:rename', name, n);
  S.clips = await api.invoke('library:current');
  if (S.view === 'game:' + name) S.view = 'game:' + n;
  renderAll();
}

async function deleteClips(ids) {
  const ok = await confirmModal(
    ids.length === 1 ? 'Delete clip?' : `Delete ${ids.length} clips?`,
    ids.length === 1 ? `“${byId(ids[0]).title}” goes to the Recycle Bin.` : 'They go to the Recycle Bin.',
    'Delete'
  );
  if (!ok) return false;
  await call('clip:delete', ids);
  S.clips = S.clips.filter((c) => !ids.includes(c.id));
  ids.forEach((id) => S.selected.delete(id));
  renderAll();
  return true;
}

async function copyFile(c) {
  await call('shell:copyFile', c.path);
  toast('File copied. Paste it into Discord or anywhere else.', 'good');
}

function clipMenu(e, id) {
  const c = byId(id);
  const ids = S.selected.has(id) && S.selected.size > 1 ? [...S.selected] : [id];
  if (ids.length > 1) {
    return showCtx(e, [
      { label: `Combine ${ids.length} clips…`, icon: 'layers', run: () => openCombine(ids) },
      { label: 'Categories…', icon: 'tag', run: () => openTagModal(ids) },
      { label: 'Compress…', icon: 'compress', run: () => openProcess(ids, 'compress') },
      { label: 'Cut to trims…', icon: 'scissors', run: () => openProcess(ids, 'cut') },
      { label: 'Move to game…', icon: 'folder', run: () => moveClipsTo(ids) },
      { label: 'Favorite', icon: 'star', run: () => favClips(ids) },
      '-',
      { label: `Delete ${ids.length} clips`, icon: 'trash', danger: true, run: () => deleteClips(ids) },
    ]);
  }
  showCtx(e, [
    { label: 'Open', icon: 'play2', run: () => openClip(id) },
    { label: c.favorite ? 'Unfavorite' : 'Favorite', icon: 'star', run: () => toggleFav(id) },
    { label: 'Rename…', icon: 'edit', run: () => renameClip(id) },
    { label: 'Move to game…', icon: 'gamepad', run: () => moveClip(id) },
    { label: 'Categories…', icon: 'tag', run: () => openTagModal([id]) },
    { label: 'Compress…', icon: 'compress', run: () => openProcess([id], 'compress') },
    ...(c.trim ? [{ label: 'Cut file to trim…', icon: 'scissors', run: () => openProcess([id], 'cut') }] : []),
    '-',
    { label: 'Copy file', icon: 'copy', run: () => copyFile(c) },
    { label: 'Show in folder', icon: 'folder', run: () => api.invoke('shell:show', c.path) },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: () => deleteClips([id]) },
  ]);
}

// ============================================================ context menu & modals
function showCtx(e, items) {
  const m = $('#ctx');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') {
      m.appendChild(document.createElement('hr'));
      continue;
    }
    const b = document.createElement('button');
    if (it.danger) b.className = 'danger';
    b.innerHTML = icon(it.icon) + esc(it.label);
    b.onclick = (ev) => (ev.stopPropagation(), hideCtx(), it.run());
    m.appendChild(b);
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
  e.stopPropagation();
}
function hideCtx() {
  $('#ctx').classList.add('hidden');
}

function modal(html, { wide = false, onClose = null, cls = '' } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''} ${cls}">${html}</div>`;
  (document.fullscreenElement || $('#modal-root')).appendChild(back); // in fullscreen, popups must live inside the fullscreen layer
  hydrateIcons(back);
  const close = () => {
    if (!back.isConnected) return;
    back.remove();
    if (onClose) onClose();
  };
  back.addEventListener('mousedown', (e) => e.target === back && (back.dataset.down = '1'));
  back.addEventListener('mouseup', (e) => e.target === back && back.dataset.down && !back.dataset.busy && close());
  return { el: back, close };
}
function promptModal({ title, value = '', placeholder = '', ok = 'OK', datalist = null, note = '' }) {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><div class="body">${note ? `<p>${esc(note)}</p>` : ''}
      <input id="pm-in" style="width:100%" value="${esc(value)}" placeholder="${esc(placeholder)}" ${datalist ? 'list="pm-list"' : ''} spellcheck="false">
      ${datalist ? `<datalist id="pm-list">${datalist.map((d) => `<option value="${esc(d)}">`).join('')}</datalist>` : ''}</div>
      <div class="foot"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`);
    const input = $('#pm-in', m.el);
    const done = (v) => (m.close(), resolve(v));
    $('[data-x]', m.el).onclick = () => done(null);
    $('[data-ok]', m.el).onclick = () => done(input.value.trim());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim());
      if (e.key === 'Escape') done(null);
      e.stopPropagation();
    });
    setTimeout(() => (input.focus(), input.select()), 0);
  });
}
function confirmModal(title, text, ok = 'OK') {
  return new Promise((resolve) => {
    const m = modal(`<h2>${esc(title)}</h2><div class="body"><p>${esc(text)}</p></div>
      <div class="foot"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${esc(ok)}</button></div>`);
    const done = (v) => (m.close(), document.removeEventListener('keydown', key, true), resolve(v));
    const key = (e) => {
      if (e.key === 'Escape') (e.stopPropagation(), done(false));
      if (e.key === 'Enter') (e.stopPropagation(), done(true));
    };
    document.addEventListener('keydown', key, true);
    $('[data-x]', m.el).onclick = () => done(false);
    $('[data-ok]', m.el).onclick = () => done(true);
    setTimeout(() => $('[data-ok]', m.el).focus(), 0);
  });
}

// ============================================================ settings
const SETTINGS_TABS = [
  ['look', 'Appearance', 'palette'],
  ['library', 'Library', 'grid'],
  ['obs', 'OBS', 'record'],
  ['audio', 'Audio tracks', 'headphones'],
  ['games', 'Games', 'gamepad'],
  ['app', 'App', 'gear'],
  ['updates', 'Updates', 'refresh'],
  ['storage', 'Storage', 'folder'],
];
async function openSettings(tab) {
  const s = await call('settings:get');
  const det = s.obsDetected || {};
  const exeMap = await call('games:exeMap');
  const pending = await api.invoke('import:pending').catch(() => 0);
  const names = s.trackNames || [];
  const norm = (p) => (p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const sameFolder = !!s.watchDir && (norm(s.watchDir) === norm(s.libraryDir) || norm(s.watchDir).startsWith(norm(s.libraryDir) + '\\'));
  const trackWarn = det.multiTrack && det.multiTrack.count <= 1;
  const obsNeedsAttention = trackWarn || (det.found && !det.wsEnabled);
  const m = modal(
    `<h2>Settings</h2><div class="set-layout">
    <nav class="set-nav">${SETTINGS_TABS.map(([id, label, ic]) => `<button data-tab="${id}">${icon(ic)}<span>${label}</span>${id === 'obs' && obsNeedsAttention ? '<i class="set-dot" title="Needs attention"></i>' : ''}</button>`).join('')}</nav>
    <div class="body set-pane">
    <div class="set-section" data-tab="look"><h3>Appearance</h3>${themePickerHtml(s.theme || 'midnight')}</div>
    <div class="set-section" data-tab="library"><h3>Library</h3>
      <div class="set-row"><label>Library folder</label><input id="s-lib" value="${esc(s.libraryDir)}" readonly><button class="btn" id="s-lib-pick">Browse</button></div>
      ${sameFolder ? `<div class="set-note">Your OBS clip folder is the library, so every video in it shows up and new replays <b>stay exactly where OBS saves them</b>. Fumo Clip only remembers which game each one is from. The two options below only apply if the library is a different folder.</div>` : ''}
      <div class="set-row"><label>New replays</label><select id="s-mode"><option value="move">Move into the library</option><option value="copy">Copy into the library (leave original)</option></select></div>
      <div class="set-row"><label></label><label class="toggle"><input type="checkbox" id="s-org" ${s.organizeByGame ? 'checked' : ''}><span>Sort clips into a folder per game</span></label></div>
    </div>
    <div class="set-section" data-tab="obs"><h3>OBS</h3>
      <div class="set-row"><label></label><label class="toggle"><input type="checkbox" id="s-obs" ${s.obsEnabled ? 'checked' : ''}><span>Connect to OBS WebSocket (live status + Save button)</span></label></div>
      <div class="set-row"><label>Host / port</label><input id="s-host" value="${esc(s.obsHost)}"><input id="s-port" type="number" style="max-width:90px" value="${esc(s.obsPort)}"></div>
      <div class="set-row"><label>Password</label><input id="s-pass" type="password" value="${esc(s.obsPassword)}"><button class="btn" id="s-detect">Read from OBS</button></div>
      ${det.found && !det.wsEnabled ? `<div class="set-note warn">OBS WebSocket is turned off. In OBS go to <b>Tools → WebSocket Server Settings</b> and tick <b>Enable WebSocket server</b>. Without it, Fumo Clip still picks up clips by watching the folder below.</div>` : ''}
      <div class="set-row"><label></label><label class="toggle"><input type="checkbox" id="s-watch" ${s.watchEnabled ? 'checked' : ''}><span>Watch the OBS replay folder</span></label></div>
      <div class="set-row"><label>OBS replay folder</label><input id="s-wdir" value="${esc(s.watchDir)}"><button class="btn" id="s-wdir-pick">Browse</button></div>
      <div class="set-row"><label>File name starts with</label><input id="s-prefix" value="${esc(s.filePrefix)}" placeholder="(any file)"></div>
      <div class="set-note">Only files starting with this are imported, so normal OBS recordings stay where they are. OBS's default replay prefix is <code>Replay</code>.${det.hotkey ? ` Your OBS "Save Replay" hotkey is <code>${esc(det.hotkey)}</code>.` : ''}</div>
      ${pending ? `<div class="set-row"><label></label><button class="btn" id="s-import">Import ${pending} replay${pending > 1 ? 's' : ''} already in that folder</button></div>` : ''}
      ${trackWarn ? `<div class="set-note warn">OBS only records <b>1 audio track</b> right now. For separate tracks (game / Discord / mic…): OBS <b>Settings → Output</b> → Output Mode <b>Advanced</b> → <b>Recording</b> tab → tick Audio Tracks 1–6. Then in <b>Edit → Advanced Audio Properties</b>, choose which tracks each source goes to. The replay buffer uses the recording settings.</div>` : ''}
    </div>
    <div class="set-section" data-tab="audio"><h3>Audio track names</h3>
      <div class="set-note">These names apply to every clip. You can also rename a track right in the player.</div>
      ${[0, 1, 2, 3, 4, 5].map((i) => `<div class="set-row"><label>Track ${i + 1}</label><input data-track="${i}" value="${esc(names[i] || '')}" placeholder="${['Everything', 'Game', 'Discord', 'Mic', 'Music', 'Other'][i]}"></div>`).join('')}
    </div>
    <div class="set-section" data-tab="games"><h3>Game names</h3>
      <div class="set-note">Fumo Clip names each clip after the app in the foreground when you saved it. Fix names here (program → game). To also move old clips, right-click a game in the sidebar.</div>
      <div class="exe-list">${Object.keys(exeMap).length ? Object.entries(exeMap).sort().map(([exe, n]) => `<div class="set-row"><label title="${esc(exe)}">${esc(exe)}</label><input data-exe="${esc(exe)}" value="${esc(n)}"></div>`).join('') : '<div class="set-note">No games detected yet.</div>'}</div>
    </div>
    <div class="set-section" data-tab="app"><h3>App</h3>
      <div class="set-row"><label></label><label class="toggle"><input type="checkbox" id="s-notify" ${s.notify ? 'checked' : ''}><span>Show a notification when a clip is saved</span></label></div>
      <div class="set-row"><label></label><label class="toggle"><input type="checkbox" id="s-tray" ${s.closeToTray ? 'checked' : ''}><span>Closing the window keeps Fumo Clip running in the tray (needed to catch clips)</span></label></div>
      <div class="set-row"><label></label><label class="toggle"><input type="checkbox" id="s-login" ${s.launchAtLogin ? 'checked' : ''}><span>Start with Windows (installed version only)</span></label></div>
    </div>
    <div class="set-section" data-tab="updates"><h3>Updates</h3>
      <div class="set-row"><label></label><label class="toggle"><input type="checkbox" id="s-autoupd" ${s.autoUpdate !== false ? 'checked' : ''}><span>Update automatically (downloads in the background, installs on restart)</span></label></div>
      <div class="set-row"><label>Version</label><span id="upd-status" class="set-note" style="margin:0;flex:1"></span><button class="btn" id="s-upd-check">Check now</button><button class="btn primary hidden" id="s-upd-install">Restart &amp; update</button></div>
    </div>
    <div class="set-section" data-tab="storage"><h3>Storage</h3>
      <div id="s-paths"></div>
      <div class="set-row"><label></label><button class="btn" id="s-cache">Clear thumbnail & audio cache</button></div>
    </div>
  </div></div>
  <div class="foot"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div>`,
    { wide: true, cls: 'settings' }
  );
  const el = m.el;
  // ---- one section at a time
  const showTab = (id) => {
    if (!SETTINGS_TABS.some((t) => t[0] === id)) id = 'look';
    $$('.set-nav button', el).forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    $$('.set-section', el).forEach((sec) => sec.classList.toggle('on', sec.dataset.tab === id));
    $('.set-pane', el).scrollTop = 0;
    try {
      localStorage.settingsTab = id;
    } catch {}
  };
  $('.set-nav', el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  showTab(tab || localStorage.settingsTab || 'look');
  $('#s-mode', el).value = s.ingestMode;
  el.addEventListener('click', (e) => {
    const sw = e.target.closest('.theme-sw');
    if (!sw) return;
    const id = sw.dataset.theme;
    if (id === 'custom' && !S.settings.customTheme) S.settings.customTheme = themeHexColors(S.settings.theme || 'midnight');
    applyTheme(id, id === 'custom' ? S.settings.customTheme : undefined);
    $$('.theme-sw', el).forEach((x) => x.classList.toggle('on', x === sw));
    $('#custom-editor', el).classList.toggle('hidden', id !== 'custom');
    if (id === 'custom') fillCustomInputs(el);
    S.settings.theme = id;
    api.invoke('settings:set', { theme: id, customTheme: S.settings.customTheme });
  });
  wireThemeEditor(el);
  $('#s-lib-pick', el).onclick = async () => {
    const p = await call('dialog:folder', $('#s-lib', el).value);
    if (p) $('#s-lib', el).value = p;
  };
  $('#s-wdir-pick', el).onclick = async () => {
    const p = await call('dialog:folder', $('#s-wdir', el).value);
    if (p) $('#s-wdir', el).value = p;
  };
  $('#s-detect', el).onclick = async () => {
    const d = await call('obs:detect');
    if (!d.found) return toast("Couldn't find an OBS config on this PC", 'error');
    $('#s-port', el).value = d.wsPort;
    $('#s-pass', el).value = d.wsPassword;
    if (d.watchDir) $('#s-wdir', el).value = d.watchDir;
    if (d.prefix) $('#s-prefix', el).value = d.prefix;
    toast(d.wsEnabled ? 'Got the settings from OBS' : 'Got the settings, but the OBS WebSocket server is turned off', d.wsEnabled ? 'good' : '');
  };
  $('#s-upd-check', el).onclick = async () => {
    $('#upd-status', el).textContent = 'Checking…';
    S.update = await call('update:check');
    renderUpdateStatus();
  };
  $('#s-upd-install', el).onclick = () => api.invoke('update:install');
  api.invoke('update:status').then((u) => ((S.update = u), renderUpdateStatus()));
  api.invoke('app:paths').then((p) => {
    const box = $('#s-paths', el);
    if (!box) return;
    const row = (label, dir, note) =>
      dir ? `<div class="set-row"><label>${label}</label><code class="path" title="${esc(dir)}">${esc(dir)}</code><button class="btn ghost sm" data-open="${esc(dir)}">Open</button></div>${note ? `<div class="set-note" style="margin-left:158px">${note}</div>` : ''}` : '';
    box.innerHTML =
      row('App installed in', p.install) +
      (p.installed ? '' : '<div class="set-row"><label>App installed in</label><span class="set-note" style="margin:0">Running from source</span></div>') +
      row('Settings & cache', p.data) +
      row('Your clips', p.library, 'Never touched by installing, updating or uninstalling.') +
      `<div class="set-row"><label></label><button class="btn danger" id="s-uninstall" ${p.canUninstall ? '' : 'disabled title="Only in the installed app"'}>${icon('trash')}Uninstall Fumo Clip…</button></div>`;
    $$('[data-open]', box).forEach((b) => (b.onclick = () => api.invoke('shell:openPath', b.dataset.open)));
    const un = $('#s-uninstall', box);
    if (un)
      un.onclick = async () => {
        const ok = await confirmModal(
          'Uninstall Fumo Clip?',
          `This removes the Fumo Clip app only. Your videos in ${p.library} are NOT deleted, and their favourites, trims, markers and categories stay with them.`,
          'Uninstall'
        );
        if (ok) await call('app:uninstall');
      };
  });
  $('#s-cache', el).onclick = async () => {
    await call('cache:clear');
    S.clips.forEach((c) => (c.thumb = null));
    renderAll();
    toast('Cache cleared');
  };
  const imp = $('#s-import', el);
  if (imp)
    imp.onclick = async () => {
      imp.disabled = true;
      imp.textContent = 'Importing…';
      const n = await call('import:run');
      toast(`Imported ${n} clip(s) into “Unsorted”`, 'good');
      imp.remove();
    };
  $('[data-x]', el).onclick = m.close;
  $('[data-ok]', el).onclick = async () => {
    const trackNames = $$('[data-track]', el).map((i) => i.value.trim());
    const patch = {
      libraryDir: $('#s-lib', el).value,
      ingestMode: $('#s-mode', el).value,
      organizeByGame: $('#s-org', el).checked,
      obsEnabled: $('#s-obs', el).checked,
      obsHost: $('#s-host', el).value.trim() || '127.0.0.1',
      obsPort: parseInt($('#s-port', el).value, 10) || 4455,
      obsPassword: $('#s-pass', el).value,
      watchEnabled: $('#s-watch', el).checked,
      watchDir: $('#s-wdir', el).value.trim(),
      filePrefix: $('#s-prefix', el).value.trim(),
      notify: $('#s-notify', el).checked,
      closeToTray: $('#s-tray', el).checked,
      launchAtLogin: $('#s-login', el).checked,
      autoUpdate: $('#s-autoupd', el).checked,
      trackNames,
    };
    for (const inp of $$('[data-exe]', el)) if (inp.value.trim() !== exeMap[inp.dataset.exe]) await call('games:setExe', inp.dataset.exe, inp.value.trim());
    await call('settings:set', patch);
    S.settings = await call('settings:get');
    m.close();
    renderObs();
    if (S.current) renderTracks();
    toast('Settings saved', 'good');
  };
}

// ============================================================ player
const video = $('#video');
const mixer = new AudioMixer(video);
const TRACK_COLORS = ['#3ddc97', '#4fa8ff', '#ffb648', '#ff6ad5', '#b18cff', '#ffe066'];
const P = { fps: 60, raf: 0, dragging: null, saveMixer: null, saveTrim: null, loadToken: 0, waves: null, shareReq: 0 };

async function openClip(id) {
  const c = byId(id);
  if (!c) return;
  const token = ++P.loadToken;
  S.current = { ...c };
  S.trim = c.trim ? { ...c.trim } : null;
  resetZoom();
  P.waves = null;
  $('#library-view').classList.add('hidden');
  $('#player-view').classList.remove('hidden');
  $$('.card video').forEach((v) => v.remove());
  video.pause();
  video.removeAttribute('src');
  video.load();
  mixer.unload();
  renderDetails();
  renderTracks();
  renderTimeline();
  stageMsg(c.tracks && c.tracks.length > 1 ? 'Getting audio tracks ready…' : 'Loading…');

  // waveforms load in the background
  api
    .invoke('clip:waves', id)
    .then((w) => {
      if (token !== P.loadToken) return;
      P.waves = w;
      drawWaves();
    })
    .catch(() => {});

  let prep;
  try {
    prep = await call('clip:prepare', id);
  } catch {
    return stageMsg("Couldn't open this clip");
  }
  if (token !== P.loadToken) return;
  S.current = { ...S.current, ...prep.clip };
  P.fps = prep.clip.fps || 60;
  mixer.load(prep.tracks, S.settings.mixer || {});
  mixer.masterVolume = +(localStorage.masterVol ?? 1);
  mixer.apply();
  $('#c-vol').value = mixer.masterVolume * 100;
  renderMute();
  renderDetails();
  renderTracks();
  await setVideoSrc(prep.clip.url, token);
}

async function setVideoSrc(url, token, attempt = 0) {
  video.src = url;
  video.playbackRate = +$('#c-speed').value;
  const ok = await new Promise((res) => {
    const done = (v) => (video.removeEventListener('loadedmetadata', y), video.removeEventListener('error', n), res(v));
    const y = () => done(true);
    const n = () => done(false);
    video.addEventListener('loadedmetadata', y);
    video.addEventListener('error', n);
  });
  if (token !== P.loadToken) return;
  if (!ok || (video.videoWidth === 0 && S.current.width > 0)) {
    // Chromium can't play this file as-is (e.g. some MKV/HEVC). Make a playable copy.
    const modes = ['remux', 'transcode'];
    if (attempt >= modes.length) return stageMsg("This video format can't be played");
    stageMsg(attempt === 0 ? 'Converting for playback…' : 'Re-encoding for playback (this can take a bit)…');
    try {
      const proxy = await api.invoke('clip:proxy', S.current.id, modes[attempt]);
      if (token !== P.loadToken) return;
      return setVideoSrc(proxy, token, attempt + 1);
    } catch {
      return setVideoSrc(url, token, attempt + 1);
    }
  }
  stageMsg('');
  renderTimeline();
  video.currentTime = S.trim && S.trim.in < video.duration ? S.trim.in : 0;
  video.play().catch(() => {});
  startRaf();
}

function stageMsg(t) {
  const el = $('#stage-msg');
  el.textContent = t;
  el.classList.toggle('hidden', !t);
}

function closePlayer() {
  P.loadToken++;
  video.pause();
  video.removeAttribute('src');
  video.load();
  mixer.unload();
  cancelAnimationFrame(P.raf);
  S.current = null;
  if (document.fullscreenElement) document.exitFullscreen();
  $('#player-view').classList.add('hidden');
  $('#library-view').classList.remove('hidden');
  renderAll();
}

function step(dir) {
  if (!S.current) return;
  const list = S.visible.length ? S.visible : filtered();
  const i = list.findIndex((c) => c.id === S.current.id);
  const n = list[i + dir];
  if (n) openClip(n.id);
}

function renderPlayerFav() {
  if (!S.current) return;
  const c = byId(S.current.id) || S.current;
  $('#p-fav').classList.toggle('on', !!c.favorite);
}

function renderDetails() {
  const c = S.current;
  if (!c) return;
  $('#p-title').textContent = c.title;
  $('#i-title').value = c.title;
  $('#i-game').value = c.game;
  renderTagBox();
  updateClipLane();
  renderPlayerFav();
  const rows = [
    ['Saved', new Date(c.created).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })],
    ['Length', fmtDur(c.duration, true)],
    ['Video', c.width ? `${c.width}×${c.height} · ${Math.round(c.fps)} fps · ${(c.vcodec || '').toUpperCase()}` : '…'],
    ['Audio', `${(c.tracks || []).length} track${(c.tracks || []).length === 1 ? '' : 's'}`],
    ['Size', c.compressed && c.compressed.before > c.size ? `${fmtSize(c.size)} (compressed from ${fmtSize(c.compressed.before)})` : fmtSize(c.size)],
    ['File', c.file],
  ];
  $('#i-meta').innerHTML = rows.map(([k, v]) => `<span>${k}</span><span title="${esc(v)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v)}</span>`).join('');
}

// ---- audio track lanes (label + controls on the left, waveform on the right)
function trackLabel(t) {
  const names = S.settings.trackNames || [];
  return names[t.index] || t.title || (mixer.multi ? `Track ${t.index + 1}` : 'Audio');
}
const trackColor = (i) => TRACK_COLORS[i % TRACK_COLORS.length];

function renderTracks() {
  const c = S.current;
  if (!c) return;
  const n = (c.tracks || []).length;
  // before the mixer is ready, show lanes from the probe info so the layout doesn't jump
  const tracks = mixer.tracks.length && n ? mixer.tracks : (c.tracks || []).map((t) => ({ ...t, volume: 1, muted: false, solo: false }));
  let labels = `<div class="ruler-spacer"></div><div class="lab clip">${icon('play2')}&nbsp;Clip</div>`;
  let rows = `<div class="lane clip"><div class="clip-name"></div></div>`;
  for (const t of tracks) {
    const col = trackColor(t.index);
    labels += `<div class="lab" data-i="${t.index}" style="--tc:${col}">
      <div class="lab-top">
        <input class="track-name" value="${esc(trackLabel(t))}" title="Rename this track (applies to every clip)" spellcheck="false">
        <button class="chip m ${t.muted ? 'on' : ''}" title="Mute (${t.index + 1})">M</button>
        ${n > 1 ? `<button class="chip s ${t.solo ? 'on' : ''}" title="Solo: only hear this track">S</button>` : ''}
      </div>
      <div class="lab-bottom">
        <input type="range" min="0" max="200" value="${Math.round(t.volume * 100)}" title="Volume (double-click resets to 100%)">
        <span class="track-vol">${Math.round(t.volume * 100)}%</span>
      </div>
      <div class="meter"><div></div></div>
    </div>`;
    rows += `<div class="lane" data-i="${t.index}"><canvas></canvas></div>`;
  }
  if (n === 0) labels += `<div class="mix-empty">This clip has no audio.</div>`;
  if (n === 1) labels += `<div class="mix-empty">One audio track. To split game / Discord / mic, turn on more tracks in OBS (see Settings).</div>`;
  $('#tl-labels').innerHTML = labels;
  $('#tl-rows').innerHTML = rows;
  updateClipLane();
  markSilent();
  drawWaves();
  renderRuler();
}

function markSilent() {
  for (const t of mixer.tracks) {
    const silent = mixer.effectiveGain(t) === 0;
    const lab = $(`#tl-labels .lab[data-i="${t.index}"]`);
    const lane = $(`#tl-rows .lane[data-i="${t.index}"]`);
    if (lab) lab.classList.toggle('silent', silent);
    if (lane) lane.classList.toggle('muted', silent);
  }
}

function drawWaves() {
  const dpr = window.devicePixelRatio || 1;
  const sc = $('#tl-lanes');
  const viewW = sc.clientWidth;
  const innerW = $('#tl-inner').clientWidth || viewW;
  const left = sc.scrollLeft;
  for (const lane of $$('#tl-rows .lane[data-i]')) {
    const i = +lane.dataset.i;
    const cv = $('canvas', lane);
    cv.style.left = left + 'px';
    cv.style.width = viewW + 'px';
    const w = Math.max(1, Math.round(viewW * dpr));
    const h = Math.max(1, Math.round(lane.clientHeight * dpr));
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    const wv = P.waves && P.waves.find((x) => x.index === i);
    g.fillStyle = trackColor(i);
    if (!wv || !wv.peaks.length) {
      g.globalAlpha = 0.25;
      g.fillRect(0, h / 2 - dpr / 2, w, dpr);
      g.globalAlpha = 1;
      continue;
    }
    const pk = wv.peaks;
    const mid = h / 2;
    const bar = Math.max(1, Math.floor(dpr * 2));
    for (let x = 0; x < w; x += bar) {
      const a = Math.floor(((left + x / dpr) / innerW) * pk.length);
      const b = Math.max(a + 1, Math.floor(((left + (x + bar) / dpr) / innerW) * pk.length));
      let v = 0;
      for (let k = a; k < b && k < pk.length; k++) if (pk[k] > v) v = pk[k];
      const bh = Math.max(dpr, v * (h - 6 * dpr));
      g.fillRect(x, mid - bh / 2, bar - (bar > 1 ? 1 : 0), bh);
    }
  }
}

function renderRuler() {
  const el = $('#tl-ruler');
  const d = video.duration || (S.current && S.current.duration) || 0;
  const w = el.clientWidth;
  if (!d || !w) return (el.innerHTML = '');
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const stepS = steps.find((s) => (s / d) * w >= 70) || 600;
  let html = '';
  for (let i = 0; i * stepS <= d + 0.001; i++) {
    const t = i * stepS;
    const x = (t / d) * w;
    if (t > 0 && x > w - 24) break;
    html += `<span class="${t === 0 ? 'first' : ''}" style="left:${(t / d) * 100}%">${fmtDur(t, stepS < 1)}</span>`;
  }
  el.innerHTML = html;
}

function persistMixer() {
  const m = { ...(S.settings.mixer || {}) };
  for (const t of mixer.tracks) m[t.index] = { volume: t.volume, muted: t.muted };
  S.settings.mixer = m;
  P.saveMixer = P.saveMixer || debounce(() => api.invoke('settings:set', { mixer: S.settings.mixer }), 500);
  P.saveMixer();
}

// ---- timeline (ruler, trim, playhead)
function dur() {
  return video.duration || (S.current && S.current.duration) || 0;
}
function pct(t) {
  const d = dur() || 1;
  return (Math.max(0, Math.min(d, t)) / d) * 100;
}
function renderTimeline() {
  const lanes = $('#tl-lanes');
  const tr = S.trim;
  lanes.classList.toggle('has-trim', !!tr);
  if (tr) {
    $('.tl-dim.left', lanes).style.width = pct(tr.in) + '%';
    $('.tl-dim.right', lanes).style.width = 100 - pct(tr.out) + '%';
    $('.tl-handle.in', lanes).style.left = pct(tr.in) + '%';
    $('.tl-handle.out', lanes).style.left = pct(tr.out) + '%';
  }
  updateClipLane();
  renderMarkers();
  renderRuler();
  $('#c-cut').disabled = !tr;
}
function startRaf() {
  cancelAnimationFrame(P.raf);
  const tick = () => {
    if (!S.current) return;
    const t = video.currentTime;
    $('.tl-playhead').style.left = pct(t) + '%';
    if (P.zoom > 1 && !video.paused && !P.dragging) followPlayhead(t);
    $('#c-time').textContent = `${fmtDur(t, true)} / ${fmtDur(dur(), true)}`;
    // keep playback inside the trimmed part
    if (S.trim && !video.paused && !P.dragging && t >= S.trim.out - 0.01) {
      if ($('#c-loop').checked) video.currentTime = S.trim.in;
      else {
        video.pause();
        video.currentTime = S.trim.out;
      }
    }
    const lv = mixer.tracks.length ? mixer.levels() : [];
    const meters = $$('#tl-labels .meter div');
    lv.forEach((l, i) => meters[i] && (meters[i].style.width = l.level * 100 + '%'));
    P.raf = requestAnimationFrame(tick);
  };
  P.raf = requestAnimationFrame(tick);
}

function setTrim(inT, outT) {
  const d = dur();
  inT = Math.max(0, Math.min(inT, d));
  outT = Math.max(0, Math.min(outT, d));
  if (outT - inT < 0.1) return;
  S.trim = { in: +inT.toFixed(3), out: +outT.toFixed(3) };
  renderTimeline();
  saveTrim();
}
function clearTrim() {
  S.trim = null;
  renderTimeline();
  saveTrim();
}
function saveTrim() {
  P.saveTrim = P.saveTrim || debounce((i, t) => api.invoke('clip:update', i, { trim: t }).then((c) => upsert(c)).catch(() => {}), 400);
  P.saveTrim(S.current.id, S.trim);
}

// ---- clip lane label (title + trim info)
function updateClipLane() {
  const el = $('#tl-rows .clip-name');
  if (!el || !S.current) return;
  const tr = S.trim;
  el.innerHTML = esc(S.current.title) + (tr ? ` <span class="muted">· trimmed ${fmtDur(tr.in, true)} – ${fmtDur(tr.out, true)} (${fmtDur(tr.out - tr.in, true)})</span>` : ` <span class="muted">· Shift-drag or press I / O to trim</span>`);
}

// ---- timeline zoom
function maxZoom() {
  return Math.max(1, Math.min(400, dur() / 2)); // zoomed all the way in = about 2 seconds on screen
}
function resetZoom() {
  P.zoom = 1;
  $('#tl-inner').style.width = '100%';
  $('#tl-lanes').scrollLeft = 0;
  $('#z-range').value = 0;
}
function setZoom(z, anchorClientX) {
  const sc = $('#tl-lanes');
  const inner = $('#tl-inner');
  const mz = maxZoom();
  z = Math.max(1, Math.min(mz, z));
  const rect = sc.getBoundingClientRect();
  let ax;
  if (anchorClientX != null) ax = anchorClientX - rect.left;
  else {
    // keep the playhead in place if it's on screen, else the middle
    const px = (pct(video.currentTime) / 100) * inner.clientWidth - sc.scrollLeft;
    ax = px >= 0 && px <= sc.clientWidth ? px : sc.clientWidth / 2;
  }
  const frac = (sc.scrollLeft + ax) / (inner.clientWidth || 1);
  P.zoom = z;
  inner.style.width = z * 100 + '%';
  sc.scrollLeft = frac * inner.clientWidth - ax;
  $('#z-range').value = mz > 1 ? Math.round((Math.log(z) / Math.log(mz)) * 1000) : 0;
  drawWaves();
  renderRuler();
}
function followPlayhead(t) {
  const sc = $('#tl-lanes');
  const x = (pct(t) / 100) * $('#tl-inner').clientWidth;
  if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 24) {
    sc.scrollLeft = x - sc.clientWidth * 0.1;
    drawWaves();
  }
}

// ---- markers
function markers() {
  return (S.current && S.current.markers) || [];
}
function renderMarkers() {
  const box = $('#tl-markers');
  if (!box) return;
  box.innerHTML = markers()
    .map((t) => `<div class="tl-marker" style="left:${pct(t)}%" data-t="${t}"><b title="Marker at ${fmtDur(t, true)}: click to jump, right-click to remove"></b></div>`)
    .join('');
}
function saveMarkers(list) {
  const id = S.current.id;
  S.current.markers = list;
  renderMarkers();
  api.invoke('clip:update', id, { markers: list }).then((c) => (upsert(c), updateCard(c))).catch(() => {});
}
function addMarker() {
  if (!S.current || !dur()) return;
  const t = +video.currentTime.toFixed(3);
  const list = markers().filter((x) => Math.abs(x - t) > 0.05);
  list.push(t);
  saveMarkers(list.sort((a, b) => a - b));
  toast(`Marker added at ${fmtDur(t, true)}`);
}
function removeMarker(t) {
  saveMarkers(markers().filter((x) => Math.abs(x - t) > 0.0005));
}
function jumpMarker(dir) {
  const t = video.currentTime;
  const list = markers();
  const target = dir > 0 ? list.find((x) => x > t + 0.05) : [...list].reverse().find((x) => x < t - 0.05);
  if (target != null) seek(target);
}

// ---- copy a frame
function grabFrame() {
  if (!video.videoWidth) return null;
  const cv = document.createElement('canvas');
  cv.width = video.videoWidth;
  cv.height = video.videoHeight;
  cv.getContext('2d').drawImage(video, 0, 0);
  return cv.toDataURL('image/png');
}
async function copyFrame() {
  const url = grabFrame();
  if (!url) return;
  const at = video.currentTime;
  const clip = S.current;
  await call('frame:copy', url);
  toast(`Frame at ${fmtDur(at, true)} copied. Paste it anywhere.`, 'good', [
    {
      label: 'Save as file',
      run: async () => {
        const p = await call('frame:save', url, clip.id, at);
        toast('Saved to the Screenshots folder', 'good', [{ label: 'Show', run: () => api.invoke('shell:show', p) }]);
      },
    },
  ]);
}

function seek(t) {
  video.currentTime = Math.max(0, Math.min(dur(), t));
}
function frameStep(dir) {
  video.pause();
  seek(video.currentTime + dir / (P.fps || 60));
}
function togglePlay() {
  if (!video.src) return;
  if (video.paused) {
    if (S.trim && (video.currentTime < S.trim.in || video.currentTime >= S.trim.out - 0.05)) video.currentTime = S.trim.in;
    video.play().catch(() => {});
  } else video.pause();
}

// ---- share (temporary render you drag into Discord)
const SHARE_DEFAULTS = { sizeMB: 10, height: 'auto', fps: 0, quality: 'high', audioMode: 'mix', audioKbps: 128, codec: 'h264', encoder: 'auto' };
const SIZE_PRESETS = [0, 10, 50, 100];
const ENCODER_NAMES = { nvenc: 'NVIDIA GPU', amf: 'AMD GPU', qsv: 'Intel GPU' };

async function openShare() {
  const c = S.current;
  if (!c) return;
  video.pause();
  const start = S.trim ? S.trim.in : 0;
  const end = S.trim ? S.trim.out : c.duration;
  const len = end - start;
  const nTracks = (c.tracks || []).length;
  const tracks = nTracks ? mixer.exportTracks() : [];
  const opts = { ...SHARE_DEFAULTS, ...(S.settings.shareOpts || {}) };
  if (S.settings.shareOpts === undefined && S.settings.shareSizeMB !== undefined) opts.sizeMB = S.settings.shareSizeMB;
  let current = null;
  let rendering = false;
  const ftOpen = localStorage.shareFineTune === '1';
  const sel = (id, options) => `<select id="${id}">${options.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('')}</select>`;

  const m = modal(
    `<h2>Share clip</h2><div class="body">
      <div class="share-label">Choose a file size</div>
      <div class="share-sizes">${SIZE_PRESETS.map((mb) => `<button data-mb="${mb}">${mb ? mb + ' MB' : 'Original'}</button>`).join('')}<button data-mb="custom">Custom</button></div>

      <button class="ft-toggle ${ftOpen ? 'open' : ''}" id="ft-toggle">${icon('chev')}Fine-tune</button>
      <div class="ft ${ftOpen ? '' : 'hidden'}" id="ft">
        <div class="ft-grid">
          <div class="field"><label>Max file size</label>
            <div class="ft-size"><input id="ft-size" type="number" min="1" max="10000" step="1" placeholder="No limit"><span>MB</span></div></div>
          <div class="field"><label>Resolution</label>${sel('ft-height', [['auto', 'Auto'], ['0', 'Original'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']])}</div>
          <div class="field"><label>Frame rate</label>${sel('ft-fps', [['0', 'Original'], ['60', '60 fps'], ['30', '30 fps']])}</div>
          <div class="field"><label>Quality <span class="muted" id="ft-q-note"></span></label>${sel('ft-quality', [['best', 'Best (big file)'], ['high', 'High'], ['balanced', 'Balanced'], ['small', 'Smaller file']])}</div>
          <div class="field"><label>Audio</label>${sel('ft-audio', [['mix', 'Mixed (as I hear it)'], ['separate', 'Separate tracks'], ['none', 'No audio']])}</div>
          <div class="field"><label>Audio quality</label>${sel('ft-akbps', [['96', '96 kbps'], ['128', '128 kbps'], ['160', '160 kbps'], ['192', '192 kbps'], ['256', '256 kbps'], ['320', '320 kbps']])}</div>
          <div class="field"><label>Video codec</label>${sel('ft-codec', [['h264', 'H.264 (works everywhere)'], ['hevc', 'H.265 (smaller)']])}</div>
          <div class="field"><label>Encoder</label>${sel('ft-encoder', [['auto', 'GPU (fast)'], ['cpu', 'CPU (slower)']])}</div>
        </div>
        <div class="ft-foot"><span id="ft-est" class="hint"></span><button class="btn ghost sm" id="ft-reset">Reset</button></div>
        <div id="ft-warn" class="hint warn"></div>
      </div>

      <div class="share-title">Drag &amp; Drop</div>
      <div class="share-sub">Drag this clip into any Discord chat (or any folder) to upload it</div>
      <div class="share-zone busy" id="sz" draggable="true">
        <div class="pv" style="${c.thumb ? `background-image:url('${esc(c.thumb)}')` : ''}"><span class="badge">${fmtDur(len, true)}</span></div>
        <div class="cover"><span id="sz-msg">Rendering…</span><div class="progress"><div id="sz-bar"></div></div></div>
      </div>
      <div class="share-info"><span id="sh-info">&nbsp;</span><span>Temporary file. Nothing is added to your clips folder.</span></div>
    </div>
    <div class="foot"><button class="btn ghost" id="sh-copy" disabled>${icon('copy')}Copy file</button><button class="btn ghost" id="sh-save" disabled>${icon('folder')}Save a copy</button><button class="btn primary" data-x>Done</button></div>`,
    { wide: true, onClose: () => rendering && api.invoke('share:cancel') }
  );
  const el = m.el;
  const zone = $('#sz', el);
  const f = (id) => $('#' + id, el);

  // ---- form <-> opts
  const fill = () => {
    f('ft-size').value = opts.sizeMB > 0 ? opts.sizeMB : '';
    f('ft-height').value = String(opts.height);
    f('ft-fps').value = String(opts.fps);
    f('ft-quality').value = opts.quality;
    f('ft-audio').value = opts.audioMode;
    f('ft-akbps').value = String(opts.audioKbps);
    f('ft-codec').value = opts.codec;
    f('ft-encoder').value = opts.encoder;
    if (!nTracks) (f('ft-audio').value = 'none'), (f('ft-audio').disabled = true), (f('ft-akbps').disabled = true);
  };
  const read = () => {
    const size = parseFloat(f('ft-size').value);
    opts.sizeMB = size > 0 ? Math.round(size * 10) / 10 : 0;
    opts.height = f('ft-height').value === 'auto' ? 'auto' : +f('ft-height').value;
    opts.fps = +f('ft-fps').value;
    opts.quality = f('ft-quality').value;
    opts.audioMode = nTracks ? f('ft-audio').value : 'none';
    opts.audioKbps = +f('ft-akbps').value;
    opts.codec = f('ft-codec').value;
    opts.encoder = f('ft-encoder').value;
  };
  const syncPresets = () => {
    const isPreset = SIZE_PRESETS.includes(opts.sizeMB);
    $$('.share-sizes button', el).forEach((b) => b.classList.toggle('on', b.dataset.mb === 'custom' ? !isPreset : isPreset && +b.dataset.mb === opts.sizeMB));
    f('ft-quality').disabled = opts.sizeMB > 0;
    f('ft-q-note').textContent = opts.sizeMB > 0 ? '(set by the size limit)' : '';
    f('ft-akbps').disabled = !nTracks || opts.audioMode === 'none';
  };

  const updateEstimate = async () => {
    const plan = await api.invoke('share:plan', {
      duration: len,
      sizeMB: opts.sizeMB,
      height: opts.height,
      fps: opts.fps,
      srcHeight: c.height,
      srcFps: c.fps,
      audioMode: opts.audioMode,
      audioKbps: opts.audioKbps,
      nAudioTracks: opts.audioMode === 'mix' ? (tracks.some((t) => t.enabled) ? 1 : 0) : nTracks,
    });
    const h = plan.height || c.height;
    const w = c.height ? Math.round((c.width * h) / c.height / 2) * 2 : 0;
    const enc = opts.encoder === 'cpu' ? 'cpu' : await api.invoke('share:encoder', opts.codec);
    const encName = Object.entries(ENCODER_NAMES).find(([k]) => enc.includes(k));
    const parts = [w ? `${w}×${h}` : '', `${Math.round(plan.fps || c.fps || 0)} fps`, plan.kbps ? `~${plan.kbps.toLocaleString()} kbps video` : 'quality-based bitrate', `${opts.codec === 'hevc' ? 'H.265' : 'H.264'} on ${encName ? encName[1] : 'CPU'}`];
    f('ft-est').textContent = 'Output: ' + parts.filter(Boolean).join(' · ');
    const warns = [];
    if (plan.kbps && plan.kbps < 800) warns.push('Very low bitrate for this length. Trim the clip or allow a bigger size for a sharper video.');
    if (opts.codec === 'hevc') warns.push('Discord may not show a preview for H.265 videos. They still download fine.');
    if (opts.audioMode === 'separate' && nTracks > 1) warns.push('Discord and most players only play the first audio track. Use "Mixed" for sharing.');
    f('ft-warn').textContent = warns.join(' ');
  };

  // ---- rendering
  let lastSig = '';
  const render = async () => {
    const sig = JSON.stringify(opts);
    syncPresets();
    if (sig === lastSig && (rendering || current)) return; // nothing actually changed
    lastSig = sig;
    const req = ++P.shareReq;
    updateEstimate().catch(() => {});
    S.settings.shareOpts = { ...opts };
    api.invoke('settings:set', { shareOpts: S.settings.shareOpts }).catch(() => {});
    current = null;
    rendering = true;
    zone.classList.add('busy');
    const pv = $('.pv video', el);
    if (pv) pv.remove();
    $('.cover', zone).classList.remove('hidden');
    f('sz-msg').textContent = 'Rendering…';
    f('sz-bar').style.width = '0';
    f('sh-copy').disabled = f('sh-save').disabled = true;
    f('sh-info').textContent = ' ';
    let res;
    try {
      res = await api.invoke('share:render', c.id, { start, end, tracks, ...opts, requestId: req });
    } catch (e) {
      if (req !== P.shareReq) return;
      rendering = false;
      f('sz-msg').textContent = "Couldn't render: " + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      return;
    }
    if (req !== P.shareReq || !res || res.cancelled) return;
    rendering = false;
    current = res;
    zone.classList.remove('busy');
    $('.cover', zone).classList.add('hidden');
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.autoplay = true;
    v.src = res.url;
    $('.pv', zone).appendChild(v);
    f('sh-copy').disabled = f('sh-save').disabled = false;
    const over = opts.sizeMB > 0 && res.size > opts.sizeMB * 1024 * 1024;
    f('sh-info').textContent = `${fmtSize(res.size)}${over ? ' (a bit over, try a smaller size)' : ''} · ${res.name}`;
  };
  const renderSoon = debounce(render, 600);

  P.shareProgress = (p) => {
    if (p.key !== P.shareReq) return;
    const bar = f('sz-bar');
    if (bar) bar.style.width = (p.progress * 100).toFixed(1) + '%';
  };

  // ---- events
  $('.share-sizes', el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-mb]');
    if (!b) return;
    if (b.dataset.mb === 'custom') {
      if (!f('ft').classList.contains('hidden')) return f('ft-size').focus();
      f('ft-toggle').click();
      return setTimeout(() => f('ft-size').focus(), 0);
    }
    opts.sizeMB = +b.dataset.mb;
    fill();
    render();
  });
  f('ft-toggle').onclick = () => {
    const open = f('ft').classList.toggle('hidden') === false;
    f('ft-toggle').classList.toggle('open', open);
    localStorage.shareFineTune = open ? '1' : '0';
  };
  for (const id of ['ft-height', 'ft-fps', 'ft-quality', 'ft-audio', 'ft-akbps', 'ft-codec', 'ft-encoder']) {
    f(id).addEventListener('change', () => (read(), render()));
  }
  f('ft-size').addEventListener('input', () => {
    read();
    syncPresets();
    renderSoon();
  });
  f('ft-size').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (e.preventDefault(), read(), render());
    e.stopPropagation();
  });
  f('ft-reset').onclick = () => {
    Object.assign(opts, SHARE_DEFAULTS);
    fill();
    render();
  };
  zone.addEventListener('dragstart', (e) => {
    e.preventDefault();
    if (current) api.dragShare(current.file, c.id);
  });
  f('sh-copy').onclick = async () => {
    if (!current) return;
    await call('shell:copyFile', current.file);
    toast('Copied. Paste it into Discord with Ctrl+V.', 'good');
  };
  f('sh-save').onclick = async () => {
    if (!current) return;
    const out = await call('share:save', current.file, c.id);
    upsert(out);
    renderSidebar();
    toast('Saved a copy to Exports', 'good', [{ label: 'Show', run: () => api.invoke('shell:show', out.path) }]);
  };
  $('[data-x]', el).onclick = m.close;

  fill();
  render();
}

function wirePlayer() {
  $('#btn-back').onclick = closePlayer;
  $('#p-prev').onclick = () => step(-1);
  $('#p-next').onclick = () => step(1);
  $('#p-fav').onclick = () => S.current && toggleFav(S.current.id);
  $('#btn-share').onclick = openShare;
  $('#i-show').onclick = () => api.invoke('shell:show', S.current.path);
  $('#i-copy').onclick = () => copyFile(S.current);
  $('#i-delete').onclick = async () => {
    const id = S.current.id;
    const list = S.visible;
    const i = list.findIndex((c) => c.id === id);
    const next = list[i + 1] || list[i - 1];
    video.pause();
    if (await deleteClips([id])) next && byId(next.id) ? openClip(next.id) : closePlayer();
  };
  const commitTitle = async () => {
    const v = $('#i-title').value.trim();
    if (!S.current || !v || v === S.current.title) return ($('#i-title').value = S.current.title);
    const old = S.current.id;
    const n = await call('clip:rename', old, v).catch(() => null);
    if (n) replaceId(old, n);
  };
  const commitGame = async () => {
    const v = $('#i-game').value.trim();
    if (!S.current || !v || v === S.current.game) return ($('#i-game').value = S.current.game);
    const old = S.current.id;
    const n = await call('clip:move', old, v).catch(() => null);
    if (n) replaceId(old, n);
  };
  for (const [sel, fn] of [['#i-title', commitTitle], ['#i-game', commitGame]]) {
    $(sel).addEventListener('change', fn);
    $(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') e.target.blur();
      if (e.key === 'Escape') ((e.target.value = sel === '#i-title' ? S.current.title : S.current.game), e.target.blur());
      e.stopPropagation();
    });
  }

  // transport
  const playIcon = () => ($('#c-play').innerHTML = icon(video.paused ? 'play' : 'pause'));
  video.addEventListener('play', playIcon);
  video.addEventListener('pause', playIcon);
  video.addEventListener('click', togglePlay);
  video.addEventListener('dblclick', toggleFull);
  $('#c-play').onclick = togglePlay;
  $('#c-start').onclick = () => seek(S.trim ? S.trim.in : 0);
  $('#c-end').onclick = () => seek(S.trim ? S.trim.out : dur());
  $('#c-frame-b').onclick = () => frameStep(-1);
  $('#c-frame-f').onclick = () => frameStep(1);
  $('#c-speed').onchange = (e) => (video.playbackRate = +e.target.value);
  $('#c-in').onclick = () => setTrim(video.currentTime, S.trim ? S.trim.out : dur());
  $('#c-out').onclick = () => setTrim(S.trim ? S.trim.in : 0, video.currentTime);
  $('#c-clear-trim').onclick = clearTrim;
  $('#c-cut').onclick = () => S.current && openProcess([S.current.id], 'cut');
  $('#i-compress').onclick = () => S.current && openProcess([S.current.id], 'compress');
  $('#c-full').onclick = toggleFull;
  $('#c-vol').oninput = (e) => {
    mixer.masterVolume = e.target.value / 100;
    mixer.masterMuted = false;
    mixer.apply();
    localStorage.masterVol = mixer.masterVolume;
    renderMute();
  };
  $('#c-mute').onclick = () => {
    mixer.masterMuted = !mixer.masterMuted;
    mixer.apply();
    renderMute();
  };

  // timeline: click/drag to seek, drag the purple handles to trim, Shift-drag to draw a trim
  const lanes = $('#tl-lanes');
  const inner = $('#tl-inner');
  const timeAt = (x) => {
    const r = inner.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width)) * dur();
  };
  lanes.addEventListener('pointerdown', (e) => {
    if (!dur() || e.button !== 0) return;
    if (e.offsetY > lanes.clientHeight && e.target === lanes) return; // horizontal scrollbar
    const mk = e.target.closest('.tl-marker');
    if (mk) return seek(+mk.dataset.t);
    lanes.setPointerCapture(e.pointerId);
    const h = e.target.closest('.tl-handle');
    const t = timeAt(e.clientX);
    if (h) P.dragging = { kind: h.classList.contains('in') ? 'in' : 'out', wasPlaying: !video.paused };
    else if (e.shiftKey) P.dragging = { kind: 'make', from: t, wasPlaying: !video.paused };
    else P.dragging = { kind: 'seek', wasPlaying: !video.paused };
    video.pause();
    if (!h && !e.shiftKey) seek(t);
  });
  lanes.addEventListener('pointermove', (e) => {
    const t = timeAt(e.clientX);
    const hov = $('.tl-hover', lanes);
    hov.style.left = e.clientX - inner.getBoundingClientRect().left + 'px';
    hov.textContent = fmtDur(t, true);
    const d = P.dragging;
    if (!d) return;
    if (d.kind === 'seek') seek(t);
    else if (d.kind === 'in') (setTrim(Math.min(t, S.trim.out - 0.1), S.trim.out), seek(S.trim.in));
    else if (d.kind === 'out') (setTrim(S.trim.in, Math.max(t, S.trim.in + 0.1)), seek(S.trim.out));
    else if (d.kind === 'make' && Math.abs(t - d.from) > 0.1) setTrim(Math.min(t, d.from), Math.max(t, d.from));
  });
  const endDrag = () => {
    const d = P.dragging;
    P.dragging = null;
    if (!d) return;
    if (d.kind !== 'seek' && S.trim) seek(S.trim.in);
    if (d.wasPlaying) togglePlay();
  };
  lanes.addEventListener('pointerup', endDrag);
  lanes.addEventListener('pointercancel', endDrag);
  new ResizeObserver(() => S.current && (drawWaves(), renderRuler())).observe(lanes);
  lanes.addEventListener('contextmenu', (e) => {
    const mk = e.target.closest('.tl-marker');
    if (!mk) return;
    e.preventDefault();
    removeMarker(+mk.dataset.t);
  });
  // Ctrl + scroll zooms around the mouse; plain scroll pans when zoomed in
  lanes.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        setZoom(P.zoom * (e.deltaY < 0 ? 1.3 : 1 / 1.3), e.clientX);
      } else if (P.zoom > 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        lanes.scrollLeft += e.deltaY;
      }
    },
    { passive: false }
  );
  let wavesQueued = false;
  lanes.addEventListener('scroll', () => {
    if (wavesQueued) return;
    wavesQueued = true;
    requestAnimationFrame(() => ((wavesQueued = false), drawWaves()));
  });
  $('#z-range').addEventListener('input', (e) => setZoom(Math.pow(maxZoom(), e.target.value / 1000)));
  $('#z-in').onclick = () => setZoom(P.zoom * 1.6);
  $('#z-out').onclick = () => setZoom(P.zoom / 1.6);
  $('#z-fit').onclick = () => setZoom(1);
  $('#c-marker').onclick = addMarker;
  $('#c-frame').onclick = copyFrame;

  // track controls
  const box = $('#tl-labels');
  box.addEventListener('input', (e) => {
    const row = e.target.closest('.lab[data-i]');
    if (!row || e.target.type !== 'range') return;
    const v = e.target.value / 100;
    mixer.set(+row.dataset.i, { volume: v });
    $('.track-vol', row).textContent = Math.round(v * 100) + '%';
    markSilent();
    persistMixer();
  });
  box.addEventListener('dblclick', (e) => {
    if (e.target.type !== 'range') return;
    e.target.value = 100;
    e.target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  box.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const i = +chip.closest('.lab').dataset.i;
    const t = mixer.tracks.find((x) => x.index === i);
    if (!t) return;
    if (chip.classList.contains('m')) mixer.set(i, { muted: !t.muted });
    else mixer.set(i, { solo: !t.solo });
    chip.classList.toggle('on');
    markSilent();
    persistMixer();
  });
  box.addEventListener('change', (e) => {
    if (!e.target.classList.contains('track-name')) return;
    const i = +e.target.closest('.lab').dataset.i;
    const names = [...(S.settings.trackNames || [])];
    while (names.length <= i) names.push('');
    names[i] = e.target.value.trim();
    S.settings.trackNames = names;
    api.invoke('settings:set', { trackNames: names });
  });
  box.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('track-name')) {
      if (e.key === 'Enter') e.target.blur();
      e.stopPropagation();
    }
  });

  document.addEventListener('keydown', onKey);
}

function renderMute() {
  $('#c-mute').innerHTML = icon(mixer.masterMuted || mixer.masterVolume === 0 ? 'volOff' : 'vol');
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#player-view').requestFullscreen();
}

// ============================================================ fullscreen: keep popups visible
document.addEventListener('fullscreenchange', () => {
  const fsEl = document.fullscreenElement;
  const modalHost = fsEl || $('#modal-root');
  $$('.modal-back').forEach((m) => modalHost.appendChild(m));
  const host = fsEl || document.body;
  host.appendChild($('#toasts'));
  host.appendChild($('#ctx'));
});

function onKey(e) {
  if (document.querySelector('.modal-back')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (!S.current) {
    if (e.key === 'Delete' && S.selected.size) deleteClips([...S.selected]);
    if (e.key === 'Escape' && S.selected.size) (S.selected.clear(), renderSelection());
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') (e.preventDefault(), $('#search').focus());
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') (e.preventDefault(), S.visible.forEach((c) => S.selected.add(c.id)), renderSelection());
    return;
  }
  const k = e.key;
  switch (k.toLowerCase()) {
    case ' ':
    case 'k':
      togglePlay();
      break;
    case 'arrowleft':
      if (e.ctrlKey) jumpMarker(-1);
      else seek(video.currentTime - (e.shiftKey ? 1 : 5));
      break;
    case 'arrowright':
      if (e.ctrlKey) jumpMarker(1);
      else seek(video.currentTime + (e.shiftKey ? 1 : 5));
      break;
    case 'b':
      addMarker();
      break;
    case 'c':
      if (e.ctrlKey) return;
      copyFrame();
      break;
    case '=':
    case '+':
      setZoom(P.zoom * 1.6);
      break;
    case '-':
      setZoom(P.zoom / 1.6);
      break;
    case '0':
      setZoom(1);
      break;
    case 'j':
      seek(video.currentTime - 10);
      break;
    case 'l':
      seek(video.currentTime + 10);
      break;
    case ',':
      frameStep(-1);
      break;
    case '.':
      frameStep(1);
      break;
    case 'i':
      $('#c-in').click();
      break;
    case 'o':
      $('#c-out').click();
      break;
    case 'f':
      toggleFull();
      break;
    case 'm':
      $('#c-mute').click();
      break;
    case 's':
      toggleFav(S.current.id);
      break;
    case 'arrowup':
      step(-1);
      break;
    case 'arrowdown':
      step(1);
      break;
    case 'delete':
      $('#i-delete').click();
      break;
    case 'escape':
      if (!document.fullscreenElement) closePlayer();
      break;
    case 'home':
      $('#c-start').click();
      break;
    case 'end':
      $('#c-end').click();
      break;
    default:
      if (/^[1-6]$/.test(k)) {
        // number keys toggle mute on that track
        const t = mixer.tracks.find((x) => x.index === +k - 1);
        if (t) {
          mixer.set(t.index, { muted: !t.muted });
          renderTracks();
          persistMixer();
        }
        break;
      }
      return;
  }
  e.preventDefault();
}

// ============================================================ themes (settings picker)
function themeSwatchHtml(id, t, current) {
  const v = { ...THEME_BASE, ...t.vars };
  return `<button class="theme-sw ${id === current ? 'on' : ''}" data-theme="${id}" title="${esc(t.note || t.name)}">
    <div class="tp" style="background:${v.bg}">
      <i class="sb" style="background:${v.bg2}"></i>
      <i class="mn" style="background-image:radial-gradient(${v.p1} 2px, transparent 2.7px), radial-gradient(${v.p2} 1.5px, transparent 2.2px);background-size:16px 16px, 11px 11px;background-position:0 0, 5px 7px">
        <i class="ln" style="background:${v.muted}"></i><i class="dot" style="background:${v.accent}"></i><i class="dot2" style="background:${v.accent3}"></i>
      </i>
    </div>
    <div class="tn" style="background:${v.bg3};color:${v.text}">${esc(t.name)}<small style="color:${v.muted}">${esc(t.note || (t.light ? 'Light' : 'Dark'))}</small></div>
  </button>`;
}

function themePickerHtml(current) {
  const groups = {};
  for (const [id, t] of Object.entries(THEMES)) (groups[t.group] = groups[t.group] || []).push([id, t]);
  const custom = { ...customThemeDef(S.settings.customTheme), note: 'Your own colours' };
  const bg = S.settings.bgImage || {};
  return (
    Object.entries(groups)
      .map(([g, list]) => `<div class="theme-group">${esc(g)}</div><div class="theme-grid">${list.map(([id, t]) => themeSwatchHtml(id, t, current)).join('')}</div>`)
      .join('') +
    `<div class="theme-group">Custom</div>
    <div class="theme-grid" id="custom-sw-wrap">${themeSwatchHtml('custom', custom, current)}</div>
    <div class="custom-editor ${current === 'custom' ? '' : 'hidden'}" id="custom-editor">
      <div class="color-grid">${CUSTOM_KEYS.map(([k, label]) => `<label class="color-row"><input type="color" data-ck="${k}">${esc(label)}</label>`).join('')}</div>
      <div class="editor-foot">
        <span class="hint">Start from</span>
        <select id="ce-from">${Object.entries(THEMES).map(([id, t]) => `<option value="${id}">${esc(t.name)}</option>`).join('')}</select>
        <button class="btn ghost sm" id="ce-copy">Copy its colours</button>
      </div>
    </div>
    <div class="theme-group">Background image <span class="muted">(works with any theme)</span></div>
    <div class="bg-editor">
      <div class="bg-row">
        <div class="bg-preview" id="bg-preview"></div>
        <div class="bg-sliders">
          <span>Darken</span><input type="range" min="0" max="90" data-bg="dim" value="${bg.dim ?? 45}"><span id="bgv-dim">${bg.dim ?? 45}%</span>
          <span>Blur</span><input type="range" min="0" max="24" data-bg="blur" value="${bg.blur ?? 0}"><span id="bgv-blur">${bg.blur ?? 0}px</span>
          <span>See-through</span><input type="range" min="0" max="80" data-bg="glass" value="${bg.glass ?? 25}"><span id="bgv-glass">${bg.glass ?? 25}%</span>
        </div>
      </div>
      <div class="editor-foot">
        <button class="btn sm" id="bg-pick">${icon('folder')}Choose image…</button>
        <button class="btn ghost sm" id="bg-remove">Remove</button>
        <span class="hint">PNG, JPG, WEBP or GIF. A copy is kept, so you can move or delete the original.</span>
      </div>
    </div>`
  );
}

function fillCustomInputs(el) {
  const c = S.settings.customTheme || themeHexColors(S.settings.theme || 'midnight');
  $$('[data-ck]', el).forEach((inp) => (inp.value = c[inp.dataset.ck]));
}
function refreshCustomSwatch(el) {
  const wrap = $('#custom-sw-wrap', el);
  if (!wrap) return;
  wrap.innerHTML = themeSwatchHtml('custom', { ...customThemeDef(S.settings.customTheme), note: 'Your own colours' }, S.settings.theme);
}
function refreshBgUi(el) {
  const bg = S.settings.bgImage;
  const pv = $('#bg-preview', el);
  pv.style.backgroundImage = bg && bg.file ? `url("clipdeck://app/media?p=${encodeURIComponent(bg.file)}")` : '';
  $('#bg-remove', el).disabled = !(bg && bg.file);
  $$('[data-bg]', el).forEach((r) => (r.disabled = !(bg && bg.file)));
}

function wireThemeEditor(el) {
  const saveCustom = debounce(() => api.invoke('settings:set', { theme: 'custom', customTheme: S.settings.customTheme }), 400);
  const saveBg = debounce(() => api.invoke('settings:set', { bgImage: S.settings.bgImage }), 300);
  fillCustomInputs(el);
  $('#ce-from', el).value = THEMES[S.settings.theme] ? S.settings.theme : 'midnight';
  const useCustom = () => {
    S.settings.theme = 'custom';
    applyTheme('custom', S.settings.customTheme);
    refreshCustomSwatch(el);
    $$('.theme-sw', el).forEach((x) => x.classList.toggle('on', x.dataset.theme === 'custom'));
    saveCustom();
  };
  el.addEventListener('input', (e) => {
    const k = e.target.dataset.ck;
    if (k) {
      S.settings.customTheme = { ...(S.settings.customTheme || themeHexColors(S.settings.theme || 'midnight')), [k]: e.target.value };
      return useCustom();
    }
    const bk = e.target.dataset.bg;
    if (bk && S.settings.bgImage) {
      S.settings.bgImage = { ...S.settings.bgImage, [bk]: +e.target.value };
      $('#bgv-' + bk, el).textContent = e.target.value + (bk === 'blur' ? 'px' : '%');
      applyBackground(S.settings.bgImage);
      saveBg();
    }
  });
  $('#ce-copy', el).onclick = () => {
    S.settings.customTheme = themeHexColors($('#ce-from', el).value);
    fillCustomInputs(el);
    useCustom();
  };
  $('#bg-pick', el).onclick = async () => {
    const file = await call('dialog:image');
    if (!file) return;
    S.settings.bgImage = { dim: 45, blur: 0, glass: 25, ...(S.settings.bgImage || {}), file };
    applyBackground(S.settings.bgImage);
    refreshBgUi(el);
    saveBg();
  };
  $('#bg-remove', el).onclick = () => {
    S.settings.bgImage = null;
    applyBackground(null);
    refreshBgUi(el);
    saveBg();
  };
  refreshBgUi(el);
}

// ============================================================ combine clips
function mixTracksFor(c) {
  const saved = S.settings.mixer || {};
  return (c.tracks || []).map((t) => {
    const m = saved[t.index] || {};
    const vol = m.muted ? 0 : m.volume ?? 1;
    return { index: t.index, volume: vol, enabled: vol > 0 };
  });
}
const segment = (c) => (c.trim ? { start: c.trim.in, end: c.trim.out } : { start: 0, end: c.duration });

async function openCombine(ids) {
  let items = ids.map(byId).filter(Boolean).sort((a, b) => a.created - b.created);
  const co = { sizeMB: 0, height: 'auto', ...(S.settings.combineOpts || {}) };
  let current = null;
  let rendering = false;
  const sizeBtns = [0, 10, 50, 100].map((mb) => `<button data-mb="${mb}">${mb ? mb + ' MB' : 'Original'}</button>`).join('') + `<button data-mb="custom">Custom</button>`;
  const m = modal(
    `<h2>Combine clips</h2><div class="body">
      <p>Clips are joined from top to bottom. Each one uses its trim if it has one, and the audio is mixed with your current track volumes.</p>
      <div class="cmb-list" id="cmb-list"></div>
      <div class="cmb-total"><span id="cmb-total"></span><span id="cmb-res"></span></div>
      <div class="share-label">File size</div>
      <div class="share-sizes" id="cmb-sizes">${sizeBtns}</div>
      <div class="ft" style="padding:10px 12px"><div class="ft-grid" style="grid-template-columns: repeat(2, 1fr)">
        <div class="field"><label>Max file size</label><div class="ft-size"><input id="cmb-size" type="number" min="1" placeholder="No limit"><span>MB</span></div></div>
        <div class="field"><label>Resolution</label><select id="cmb-height"><option value="auto">Auto</option><option value="0">Same as first clip</option><option value="1440">1440p</option><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option></select></div>
      </div></div>
      <div id="cmb-out" class="hidden">
        <div class="share-title">Drag &amp; Drop</div>
        <div class="share-sub">Drag the combined video into any Discord chat (or any folder)</div>
        <div class="share-zone busy" id="sz" draggable="true">
          <div class="pv"><span class="badge" id="cmb-badge"></span></div>
          <div class="cover"><span id="sz-msg">Combining…</span><div class="progress"><div id="sz-bar"></div></div></div>
        </div>
        <div class="share-info"><span id="sh-info">&nbsp;</span><span>Temporary file. Nothing is added to your clips folder.</span></div>
      </div>
    </div>
    <div class="foot"><button class="btn ghost" id="sh-copy" disabled>${icon('copy')}Copy file</button><button class="btn ghost" id="sh-save" disabled>${icon('folder')}Save a copy</button><button class="btn primary" id="cmb-go">${icon('layers')}Combine</button><button class="btn ghost" data-x>Close</button></div>`,
    { wide: true, onClose: () => rendering && api.invoke('share:cancel') }
  );
  const el = m.el;
  const f = (id) => $('#' + id, el);
  const total = () => items.reduce((n, c) => n + (segment(c).end - segment(c).start), 0);

  const renderList = () => {
    f('cmb-list').innerHTML = items
      .map((c, i) => {
        const sg = segment(c);
        return `<div class="cmb-row" data-i="${i}">
          <span class="cmb-n">${i + 1}</span>
          ${c.thumb ? `<img src="${esc(c.thumb)}">` : '<span class="noimg"></span>'}
          <div class="cmb-t"><div title="${esc(c.title)}">${esc(c.title)}</div><small>${esc(c.game)} · ${fmtDur(sg.end - sg.start, true)}${c.trim ? ' (trimmed)' : ''}</small></div>
          <button class="icon-btn" data-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
          <button class="icon-btn" data-act="down" title="Move down" ${i === items.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
          <button class="icon-btn" data-act="remove" title="Leave this clip out">${icon('x')}</button>
        </div>`;
      })
      .join('');
    f('cmb-total').textContent = `${items.length} clips · ${fmtDur(total(), true)} total`;
    const c0 = items[0];
    f('cmb-res').textContent = c0 && c0.width ? `Uses the first clip's shape (${c0.width}×${c0.height}); others are letterboxed if they differ` : '';
    f('cmb-go').disabled = items.length < 2;
  };
  const syncSizes = () => {
    const preset = [0, 10, 50, 100].includes(co.sizeMB);
    $$('#cmb-sizes button', el).forEach((b) => b.classList.toggle('on', b.dataset.mb === 'custom' ? !preset : preset && +b.dataset.mb === co.sizeMB));
    f('cmb-size').value = co.sizeMB > 0 ? co.sizeMB : '';
    f('cmb-height').value = String(co.height);
  };
  const invalidate = () => {
    if (rendering) api.invoke('share:cancel');
    rendering = false;
    current = null;
    f('cmb-out').classList.add('hidden');
    f('sh-copy').disabled = f('sh-save').disabled = true;
  };

  const go = async () => {
    if (items.length < 2) return;
    const req = ++P.shareReq;
    S.settings.combineOpts = { ...co };
    api.invoke('settings:set', { combineOpts: S.settings.combineOpts }).catch(() => {});
    rendering = true;
    current = null;
    f('cmb-out').classList.remove('hidden');
    const zone = f('sz');
    zone.classList.add('busy');
    const old = $('.pv video', zone);
    if (old) old.remove();
    $('.pv', zone).style.backgroundImage = items[0].thumb ? `url('${items[0].thumb}')` : '';
    f('cmb-badge').textContent = fmtDur(total(), true);
    $('.cover', zone).classList.remove('hidden');
    f('sz-msg').textContent = 'Combining…';
    f('sz-bar').style.width = '0';
    f('sh-info').textContent = ' ';
    f('cmb-go').disabled = true;
    zone.scrollIntoView({ block: 'nearest' });
    let res;
    try {
      res = await api.invoke(
        'combine:render',
        items.map((c) => ({ id: c.id, ...segment(c), tracks: mixTracksFor(c) })),
        { ...co, requestId: req }
      );
    } catch (e) {
      if (req !== P.shareReq) return;
      rendering = false;
      f('cmb-go').disabled = false;
      f('sz-msg').textContent = "Couldn't combine: " + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      return;
    }
    if (req !== P.shareReq || !res || res.cancelled) return;
    rendering = false;
    current = res;
    f('cmb-go').disabled = false;
    zone.classList.remove('busy');
    $('.cover', zone).classList.add('hidden');
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.autoplay = true;
    v.src = res.url;
    $('.pv', zone).appendChild(v);
    f('sh-copy').disabled = f('sh-save').disabled = false;
    f('sh-info').textContent = `${fmtSize(res.size)} · ${res.name}`;
  };

  P.shareProgress = (p) => {
    if (p.key !== P.shareReq) return;
    const bar = f('sz-bar');
    if (bar) bar.style.width = (p.progress * 100).toFixed(1) + '%';
  };
  f('cmb-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const i = +b.closest('.cmb-row').dataset.i;
    if (b.dataset.act === 'up' && i > 0) [items[i - 1], items[i]] = [items[i], items[i - 1]];
    if (b.dataset.act === 'down' && i < items.length - 1) [items[i + 1], items[i]] = [items[i], items[i + 1]];
    if (b.dataset.act === 'remove') items.splice(i, 1);
    invalidate();
    renderList();
  });
  f('cmb-sizes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mb]');
    if (!b) return;
    if (b.dataset.mb === 'custom') return f('cmb-size').focus();
    co.sizeMB = +b.dataset.mb;
    syncSizes();
    invalidate();
  });
  f('cmb-size').addEventListener('input', () => {
    const v = parseFloat(f('cmb-size').value);
    co.sizeMB = v > 0 ? Math.round(v * 10) / 10 : 0;
    syncSizes();
    invalidate();
  });
  f('cmb-size').addEventListener('keydown', (e) => e.stopPropagation());
  f('cmb-height').addEventListener('change', () => {
    co.height = f('cmb-height').value === 'auto' ? 'auto' : +f('cmb-height').value;
    invalidate();
  });
  f('cmb-go').onclick = go;
  f('sz').addEventListener('dragstart', (e) => {
    e.preventDefault();
    if (current) api.dragShare(current.file, items[0].id);
  });
  f('sh-copy').onclick = async () => {
    if (!current) return;
    await call('shell:copyFile', current.file);
    toast('Copied. Paste it into Discord with Ctrl+V.', 'good');
  };
  f('sh-save').onclick = async () => {
    if (!current) return;
    const out = await call('share:save', current.file, items[0].id);
    upsert(out);
    renderSidebar();
    toast('Saved a copy to Exports', 'good', [{ label: 'Show', run: () => api.invoke('shell:show', out.path) }]);
  };
  $('[data-x]', el).onclick = m.close;
  renderList();
  syncSizes();
}

// ============================================================ categories (labels) + bulk actions
async function refreshCats() {
  S.cats = await call('categories:list');
}

async function favClips(ids) {
  const on = !ids.every((id) => byId(id) && byId(id).favorite);
  for (const id of ids) upsert(await call('clip:update', id, { favorite: on }));
  renderAll();
}

async function moveClipsTo(ids) {
  const g = await promptModal({
    title: `Move ${ids.length} clip${ids.length === 1 ? '' : 's'} to game`,
    placeholder: 'Game name (pick one or type a new one)',
    datalist: games().map((x) => x.name),
    ok: 'Move',
    note: 'Moves the files into that game\'s folder. A folder left empty is removed.',
  });
  if (!g) return;
  let n = 0;
  for (const id of ids) if (await call('clip:move', id, g).catch(() => null)) n++;
  S.selected.clear();
  S.clips = await api.invoke('library:current');
  renderAll();
  toast(`Moved ${n} clip${n === 1 ? '' : 's'} to ${g}`, 'good');
}

async function renameCategory(name) {
  const n = await promptModal({ title: `Rename “${name}”`, value: name, ok: 'Rename' });
  if (!n || n === name) return;
  S.clips = await call('categories:rename', name, n);
  await refreshCats();
  if (S.view === 'cat:' + name) S.view = 'cat:' + n;
  renderAll();
}

async function deleteCategory(name) {
  const count = S.clips.filter((c) => (c.tags || []).includes(name)).length;
  const ok = await confirmModal(`Delete “${name}”?`, `This only removes the label from ${count} clip${count === 1 ? '' : 's'}. The videos stay where they are.`, 'Delete category');
  if (!ok) return;
  S.clips = await call('categories:delete', name);
  await refreshCats();
  if (S.view === 'cat:' + name) S.view = 'all';
  renderAll();
}

/** Add or remove categories on one or more clips. */
function openTagModal(ids) {
  const clips = ids.map(byId).filter(Boolean);
  if (!clips.length) return;
  const all = [...new Set([...(S.cats || []), ...clips.flatMap((c) => c.tags || [])])];
  // state per category: 1 = all have it, 0 = none, 0.5 = some
  const start = Object.fromEntries(all.map((t) => [t, clips.filter((c) => (c.tags || []).includes(t)).length / clips.length]));
  const state = { ...start };
  const m = modal(
    `<h2>Categories${clips.length > 1 ? ` · ${clips.length} clips` : ''}</h2><div class="body">
      <p>Categories are labels: a clip can be in several, and the file stays in its folder.</p>
      <div class="tag-opts" id="tag-opts"></div>
      <div class="tag-new"><input id="tag-new" placeholder="New category…" spellcheck="false"><button class="btn" id="tag-add">${icon('plus')}Add</button></div>
    </div>
    <div class="foot"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Apply</button></div>`
  );
  const el = m.el;
  const draw = () => {
    const keys = Object.keys(state);
    $('#tag-opts', el).innerHTML = keys.length
      ? keys
          .map(
            (t) => `<label class="tag-opt"><input type="checkbox" data-t="${esc(t)}" ${state[t] === 1 ? 'checked' : ''}><span>${esc(t)}</span>${
              state[t] > 0 && state[t] < 1 ? `<small>some selected clips</small>` : ''
            }</label>`
          )
          .join('')
      : '<div class="nav-empty">No categories yet. Type one below.</div>';
    $$('[data-t]', el).forEach((cb) => (cb.indeterminate = state[cb.dataset.t] > 0 && state[cb.dataset.t] < 1));
  };
  $('#tag-opts', el).addEventListener('change', (e) => {
    const t = e.target.dataset.t;
    if (t != null) state[t] = e.target.checked ? 1 : 0;
  });
  const addNew = () => {
    const v = $('#tag-new', el).value.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!v) return;
    state[v] = 1;
    $('#tag-new', el).value = '';
    draw();
  };
  $('#tag-add', el).onclick = addNew;
  $('#tag-new', el).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (e.preventDefault(), addNew());
    e.stopPropagation();
  });
  $('[data-x]', el).onclick = m.close;
  $('[data-ok]', el).onclick = async () => {
    const add = Object.keys(state).filter((t) => state[t] === 1 && start[t] !== 1);
    const remove = Object.keys(state).filter((t) => state[t] === 0 && (start[t] || 0) > 0);
    m.close();
    if (!add.length && !remove.length) return;
    const updated = await call('clips:tag', clips.map((c) => c.id), add, remove);
    updated.forEach(upsert);
    if (S.current) {
      const cur = updated.find((c) => c.id === S.current.id);
      if (cur) S.current = { ...S.current, tags: cur.tags };
    }
    await refreshCats();
    renderAll();
    renderTagBox();
    toast(`Updated categories on ${updated.length} clip${updated.length === 1 ? '' : 's'}`, 'good');
  };
  draw();
  setTimeout(() => $('#tag-new', el).focus(), 0);
}

// ---- category chips in the player's details panel
function renderTagBox() {
  const box = $('#i-tags');
  if (!box || !S.current) return;
  const c = byId(S.current.id) || S.current;
  const tags = c.tags || [];
  box.innerHTML =
    tags.map((t) => `<span class="tag-chip">${esc(t)}<button data-rm="${esc(t)}" title="Remove">${icon('x')}</button></span>`).join('') +
    `<input id="i-tag-in" list="cat-list" placeholder="${tags.length ? 'Add…' : 'Add a category…'}" spellcheck="false"><datalist id="cat-list">${(S.cats || [])
      .filter((x) => !tags.includes(x))
      .map((x) => `<option value="${esc(x)}">`)
      .join('')}</datalist>`;
  const inp = $('#i-tag-in', box);
  const add = async () => {
    const v = inp.value.replace(/\s+/g, ' ').trim();
    if (!v) return;
    const [n] = await call('clips:tag', [c.id], [v], []);
    upsert(n);
    S.current = { ...S.current, tags: n.tags };
    await refreshCats();
    renderSidebar();
    renderTagBox();
    $('#i-tag-in').focus();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (e.preventDefault(), add());
    if (e.key === 'Escape') inp.blur();
    e.stopPropagation();
  });
  inp.addEventListener('change', () => {
    // picking from the dropdown list adds it straight away
    if ((S.cats || []).includes(inp.value.trim())) add();
  });
  box.onclick = async (e) => {
    const rm = e.target.closest('[data-rm]');
    if (!rm) return;
    const [n] = await call('clips:tag', [c.id], [], [rm.dataset.rm]);
    upsert(n);
    S.current = { ...S.current, tags: n.tags };
    renderSidebar();
    renderTagBox();
  };
}

// ============================================================ updates
function renderUpdateStatus() {
  const el = $('#upd-status');
  if (!el) return;
  const u = S.update || {};
  const cur = u.current ? 'v' + u.current : '';
  const msg = {
    dev: 'Running from source: updates only work in the installed app',
    idle: 'Not checked yet',
    checking: 'Checking for updates…',
    latest: "You're up to date",
    downloading: `Downloading v${u.version || ''}… ${u.percent || 0}%`,
    ready: `v${u.version} downloaded and ready to install`,
    error: "Couldn't check for updates" + (u.error ? ': ' + u.error : ''),
  }[u.state] || '';
  el.textContent = [cur, msg].filter(Boolean).join(' · ');
  const btn = $('#s-upd-install');
  if (btn) btn.classList.toggle('hidden', u.state !== 'ready');
}

// ============================================================ import from other recorders
const gb = (b) => (b >= 1e9 ? (b / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB');

async function openImport() {
  const m = modal(`<h2>Import clips</h2><div class="body" id="imp-body"><p>Looking for clips on this PC…</p></div><div class="foot" id="imp-foot"><button class="btn ghost" data-x>Cancel</button></div>`, { wide: true });
  const el = m.el;
  const body = $('#imp-body', el);
  const foot = $('#imp-foot', el);
  let sources = [];
  try {
    sources = await call('import:sources');
  } catch {
    sources = [];
  }
  const picked = new Set(sources.filter((s) => s.id === 'moments').map((s) => s.id));
  if (!picked.size && sources[0]) picked.add(sources[0].id);

  // ---- step 1: choose sources
  const step1 = () => {
    body.innerHTML = `
      <p>Pick where to import from. Fumo Clip works out each clip's game and date, and from SteelSeries Moments it also keeps your trims and titles.</p>
      <div class="imp-list">${
        sources.length
          ? sources
              .map(
                (s) => `<label class="imp-src"><input type="checkbox" data-src="${esc(s.id)}" ${picked.has(s.id) ? 'checked' : ''}>
              <div><b>${esc(s.name)}</b><small>${esc(s.dir)}</small>${s.note ? `<small class="imp-note">${esc(s.note)}</small>` : ''}</div>
              <span>${s.count == null ? 'folder' : `${s.count} clip${s.count === 1 ? '' : 's'} · ${gb(s.bytes)}`}</span></label>`
              )
              .join('')
          : '<div class="nav-empty">No other clip folders found in your Videos folder. Pick a folder below.</div>'
      }</div>
      <button class="btn" id="imp-add">${icon('folder')}Add another folder…</button>`;
    foot.innerHTML = `<button class="btn ghost" data-x>Cancel</button><button class="btn primary" id="imp-next">Next</button>`;
    $('[data-x]', foot).onclick = m.close;
    $$('[data-src]', body).forEach((cb) => (cb.onchange = () => (cb.checked ? picked.add(cb.dataset.src) : picked.delete(cb.dataset.src), sync())));
    $('#imp-add', body).onclick = async () => {
      const s = await call('import:pickFolder').catch(() => null);
      if (!s) return;
      if (!sources.some((x) => x.id === s.id)) sources.push(s);
      picked.add(s.id);
      step1();
    };
    const sync = () => ($('#imp-next', foot).disabled = !picked.size);
    $('#imp-next', foot).onclick = () => step2();
    sync();
  };

  // ---- step 2: summary + move/copy
  const step2 = async () => {
    const chosen = sources.filter((s) => picked.has(s.id)).map(({ id, name, dir }) => ({ id, name, dir }));
    body.innerHTML = '<p>Scanning clips…</p>';
    foot.innerHTML = `<button class="btn ghost" data-x>Cancel</button>`;
    $('[data-x]', foot).onclick = m.close;
    let r;
    try {
      r = await call('import:scan', chosen);
    } catch {
      return step1();
    }
    const copyFits = r.free == null || r.free > r.bytes + 2 * 1073741824;
    const moveFits = r.free == null || !r.crossDrive || r.free > r.crossBytes + 2 * 1073741824;
    let mode = moveFits ? 'move' : 'copy';
    const extras = [r.trims ? `${r.trims} trims` : '', r.titles ? `${r.titles} custom titles` : ''].filter(Boolean).join(' and ');
    body.innerHTML = `
      <div class="imp-sum">
        <div class="imp-big">${r.fresh}<small>clip${r.fresh === 1 ? '' : 's'} to import · ${gb(r.bytes)}</small></div>
        <div class="imp-facts">
          ${r.duplicates ? `<div>${r.duplicates} already in your library, skipped</div>` : ''}
          ${extras ? `<div>Brings over ${extras} from Moments</div>` : ''}
          <div>Goes into <code>${esc(r.library)}</code>${r.organize ? ', in a folder per game' : ''}</div>
        </div>
      </div>
      <div class="imp-games">${r.games
        .slice(0, 14)
        .map((g) => `<span>${esc(g.game)} <em>${g.n}</em></span>`)
        .join('')}${r.games.length > 14 ? `<span class="muted">+${r.games.length - 14} more</span>` : ''}</div>
      <div class="imp-modes">
        <label class="imp-mode ${moveFits ? '' : 'disabled'}"><input type="radio" name="imp-mode" value="move" ${mode === 'move' ? 'checked' : ''} ${moveFits ? '' : 'disabled'}>
          <div><b>Move</b> <span class="tag-ok">recommended</span><small>${r.crossDrive ? 'Some clips are on another drive, so those get copied and then removed.' : 'Instant and uses no extra space (same drive).'} The clips leave their old folder, so the other app won't show them any more.</small></div></label>
        <label class="imp-mode ${copyFits ? '' : 'disabled'}"><input type="radio" name="imp-mode" value="copy" ${mode === 'copy' ? 'checked' : ''} ${copyFits ? '' : 'disabled'}>
          <div><b>Copy</b><small>${copyFits ? `Keeps the originals too. Needs ${gb(r.bytes)} of free space${r.free != null ? ` (you have ${gb(r.free)})` : ''}.` : `Not enough space: needs ${gb(r.bytes)}, only ${gb(r.free)} free.`}</small></div></label>
      </div>`;
    foot.innerHTML = `<button class="btn ghost" id="imp-back">Back</button><button class="btn primary" id="imp-go" ${r.fresh && (moveFits || copyFits) ? '' : 'disabled'}>Import ${r.fresh} clip${r.fresh === 1 ? '' : 's'}</button>`;
    $$('[name=imp-mode]', body).forEach((rd) => (rd.onchange = () => (mode = rd.value)));
    $('#imp-back', foot).onclick = step1;
    $('#imp-go', foot).onclick = () => step3(mode, r.fresh);
  };

  // ---- step 3: progress
  const step3 = async (mode, n) => {
    body.innerHTML = `
      <div class="imp-run">
        <div class="imp-big" id="imp-count">0<small>of ${n} clips ${mode === 'move' ? 'moved' : 'copied'}</small></div>
        <div class="progress"><div id="imp-bar"></div></div>
        <div class="hint" id="imp-cur">&nbsp;</div>
      </div>`;
    foot.innerHTML = `<button class="btn ghost" id="imp-stop">Stop</button>`;
    $('#imp-stop', foot).onclick = () => (api.invoke('import:cancel'), ($('#imp-stop', foot).disabled = true), ($('#imp-cur', body).textContent = 'Stopping after the current clip…'));
    m.el.dataset.busy = '1';
    const offP = api.on('import:progress', (p) => {
      $('#imp-count', body).firstChild.textContent = p.done;
      $('#imp-bar', body).style.width = ((p.bytesDone / Math.max(1, p.bytesTotal)) * 100).toFixed(1) + '%';
      $('#imp-cur', body).textContent = `${p.game} · ${p.current}`;
    });
    const offD = api.on('import:done', async (d) => {
      offP();
      offD();
      delete m.el.dataset.busy;
      S.clips = await api.invoke('library:current');
      await refreshCats();
      renderAll();
      body.innerHTML = `<div class="imp-run"><div class="imp-big">${d.imported}<small>clip${d.imported === 1 ? '' : 's'} imported${d.cancelled ? ' (stopped early)' : ''}</small></div>
        ${d.failed ? `<div class="set-note warn">${d.failed} could not be imported:<br>${d.errors.map(esc).join('<br>')}</div>` : ''}
        <p>Thumbnails and audio info fill in over the next minute or so.</p></div>`;
      foot.innerHTML = `<button class="btn primary" data-x>Done</button>`;
      $('[data-x]', foot).onclick = m.close;
      toast(`Imported ${d.imported} clip${d.imported === 1 ? '' : 's'}`, 'good');
    });
    await call('import:start', { mode });
  };

  step1();
}

// ============================================================ compress / cut to trim (saves disk space)
const canPlayHevc = (() => {
  try {
    return !!document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"');
  } catch {
    return false;
  }
})();

/** op: 'compress' | 'cut' */
async function openProcess(ids, op) {
  let clips = ids.map(byId).filter(Boolean);
  // a clip being cut uses its trim, so make sure the latest trim from the player is saved
  if (op === 'cut' && S.current && S.trim && ids.includes(S.current.id)) {
    const n = await call('clip:update', S.current.id, { trim: S.trim });
    upsert(n);
    clips = ids.map(byId).filter(Boolean);
  }
  if (op === 'cut') clips = clips.filter((c) => c.trim);
  if (!clips.length) return toast(op === 'cut' ? 'None of those clips has a trim yet. Set one with I / O first.' : 'Nothing to compress');
  const total = clips.reduce((n, c) => n + c.size, 0);
  const already = clips.filter((c) => c.compressed).length;
  const kept = op === 'cut' ? clips.reduce((n, c) => n + (c.trim.out - c.trim.in), 0) : 0;
  const full = op === 'cut' ? clips.reduce((n, c) => n + (c.duration || 0), 0) : 0;
  const one = clips.length === 1;
  const title =
    op === 'cut'
      ? one
        ? `Cut “${clips[0].title}” to its trim`
        : `Cut ${clips.length} clips to their trims`
      : one
        ? `Compress “${clips[0].title}”`
        : `Compress ${clips.length} clips`;

  const m = modal(
    `<h2>${esc(title)}</h2><div class="body" id="pr-body">
      ${
        op === 'cut'
          ? `<p>This <b>permanently</b> removes the parts outside the trim from the file${one ? '' : 's'}, keeping ${fmtDur(kept)} of ${fmtDur(full)}. Normal trimming (which keeps the whole clip) stays the default; this is only for saving space. Every audio track is kept.</p>`
          : `<p>Re-encodes the video to take less space. Every audio track is kept exactly as it is, and so are trims, markers and categories.${already ? ` ${already} of these ${already === 1 ? 'is' : 'are'} already compressed.` : ''}</p>`
      }
      <div class="ft"><div class="ft-grid" style="grid-template-columns: repeat(2, 1fr)">
        ${
          op === 'cut'
            ? `<div class="field"><label>Cut</label><select id="pr-fast"><option value="0">Exact (re-encodes, high quality)</option><option value="1">Fast (no re-encode, starts at the nearest keyframe)</option></select></div>`
            : `<div class="field"><label>Size vs quality</label><select id="pr-quality"><option value="high">Light (barely visible, smaller)</option><option value="balanced" selected>Balanced (much smaller)</option><option value="small">Smallest (softer picture)</option></select></div>
               <div class="field"><label>Video codec</label><select id="pr-codec"><option value="hevc" ${canPlayHevc ? 'selected' : ''}>H.265 (about half the size)</option><option value="h264" ${canPlayHevc ? '' : 'selected'}>H.264 (plays everywhere)</option></select></div>
               <div class="field"><label>Resolution</label><select id="pr-height"><option value="0">Keep</option><option value="1080">1080p</option><option value="720">720p</option></select></div>`
        }
        <div class="field"><label>The original file${one ? '' : 's'}</label><select id="pr-orig"><option value="trash">Send to the Recycle Bin (safe)</option><option value="delete">Delete permanently (frees space now)</option></select></div>
      </div></div>
      <div class="hint" id="pr-hint">${one ? '' : `${clips.length} clips · `}${fmtSize(total)} now. ${op === 'compress' ? 'Clips that would not get smaller are left alone.' : ''}</div>
    </div>
    <div class="foot" id="pr-foot"><button class="btn ghost" data-x>Cancel</button><button class="btn primary" id="pr-go">${icon(op === 'cut' ? 'scissors' : 'compress')}${op === 'cut' ? 'Cut' : 'Compress'}</button></div>`,
    { wide: true }
  );
  const el = m.el;
  const body = $('#pr-body', el);
  const foot = $('#pr-foot', el);
  $('[data-x]', foot).onclick = m.close;
  if (op === 'compress' && !canPlayHevc) $('#pr-codec option[value=hevc]', el).textContent = "H.265 (smaller, but this PC can't play it)";
  $('#pr-orig', el).onchange = (e) => ($('#pr-hint', el).textContent = e.target.value === 'delete' ? 'The originals will be gone for good once each new file checks out.' : 'You can restore originals from the Recycle Bin. Empty it to actually free the space.');

  $('#pr-go', foot).onclick = async () => {
    const opts =
      op === 'cut'
        ? { fast: $('#pr-fast', el).value === '1', originals: $('#pr-orig', el).value }
        : { quality: $('#pr-quality', el).value, codec: $('#pr-codec', el).value, height: +$('#pr-height', el).value, originals: $('#pr-orig', el).value };
    if (opts.originals === 'delete') {
      const ok = await confirmModal('Delete the originals permanently?', `Once each new file is checked, its original is deleted for good (not sent to the Recycle Bin). ${clips.length} clip${one ? '' : 's'}.`, 'Yes, delete originals');
      if (!ok) return;
    }
    // let go of any file we're about to replace
    if (S.current && clips.some((c) => c.id === S.current.id)) closePlayer();
    $$('.card video').forEach((v) => (v.pause(), v.removeAttribute('src'), v.load(), v.remove()));
    body.innerHTML = `<div class="imp-run">
      <div class="imp-big" id="pr-count">0<small>of ${clips.length} done</small></div>
      <div class="hint" id="pr-cur">&nbsp;</div>
      <div class="progress"><div id="pr-bar"></div></div>
      <div class="hint">Overall</div>
      <div class="progress"><div id="pr-all"></div></div>
      <div class="hint" id="pr-saved"></div></div>`;
    foot.innerHTML = `<button class="btn ghost" id="pr-stop">Stop</button>`;
    el.dataset.busy = '1';
    $('#pr-stop', foot).onclick = () => (api.invoke('process:cancel'), ($('#pr-stop', foot).disabled = true), ($('#pr-cur', body).textContent = 'Stopping… (the clip in progress is left untouched)'));
    const offP = api.on('process:progress', (p) => {
      $('#pr-count', body).firstChild.textContent = p.index;
      $('#pr-cur', body).textContent = p.title;
      $('#pr-bar', body).style.width = (p.progress * 100).toFixed(1) + '%';
      $('#pr-all', body).style.width = (((p.index + p.progress) / p.total) * 100).toFixed(1) + '%';
      if (p.saved > 0) $('#pr-saved', body).textContent = `Saved ${fmtSize(p.saved)} so far`;
    });
    const offD = api.on('process:done', async (d) => {
      offP();
      offD();
      delete el.dataset.busy;
      S.clips = await api.invoke('library:current');
      renderAll();
      const saved = d.before - d.after;
      const pct = d.before ? Math.round((saved / d.before) * 100) : 0;
      const lines = [...d.notes, ...d.skipped, ...d.failed];
      body.innerHTML = `<div class="imp-run">
        <div class="imp-big">${fmtSize(Math.max(0, saved))}<small>saved on ${d.done} clip${d.done === 1 ? '' : 's'}${d.done ? ` (${pct}% smaller)` : ''}${d.cancelled ? ' · stopped early' : ''}</small></div>
        ${lines.length ? `<div class="set-note ${d.failed.length ? 'warn' : ''}">${lines.slice(0, 8).map(esc).join('<br>')}${lines.length > 8 ? `<br>…and ${lines.length - 8} more` : ''}</div>` : ''}
        ${d.done && opts.originals !== 'delete' ? '<p>The originals are in the Recycle Bin. Empty it to actually free the space.</p>' : ''}
      </div>`;
      foot.innerHTML = `<button class="btn primary" data-x>Done</button>`;
      $('[data-x]', foot).onclick = m.close;
      toast(`${op === 'cut' ? 'Cut' : 'Compressed'} ${d.done} clip${d.done === 1 ? '' : 's'}, saved ${fmtSize(Math.max(0, saved))}`, 'good');
    });
    await call('process:start', { ids: clips.map((c) => c.id), op, opts });
  };
}

// ============================================================ update banner (under the top bar)
function renderUpdateBanner() {
  const u = S.update || {};
  const show = (u.state === 'downloading' || u.state === 'ready') && S.updateHidden !== u.state + u.version;
  for (const bar of $$('.upd-bar')) {
    bar.classList.toggle('hidden', !show);
    bar.classList.toggle('ready', u.state === 'ready');
    if (!show) continue;
    bar.innerHTML =
      u.state === 'ready'
        ? `${icon('refresh')}<span><b>Fumo Clip v${esc(u.version)} is ready.</b> Restart to update. It only takes a few seconds and your clips stay put.</span>
           <button class="btn primary sm" data-upd="install">Restart now</button><button class="btn ghost sm" data-upd="later">Later</button>`
        : `${icon('import')}<span>Downloading Fumo Clip v${esc(u.version || '')}… ${u.percent || 0}%</span>
           <div class="upd-prog"><div style="width:${u.percent || 0}%"></div></div><button class="icon-btn" data-upd="later" title="Hide">${icon('x')}</button>`;
  }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-upd]');
  if (!b) return;
  if (b.dataset.upd === 'install') api.invoke('update:install');
  else {
    // "Later": hide until something changes (a finished download shows the banner again)
    const u = S.update || {};
    S.updateHidden = u.state + u.version;
    renderUpdateBanner();
    if (u.state === 'ready') toast('The update installs next time Fumo Clip restarts');
  }
});

boot();
