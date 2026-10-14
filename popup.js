'use strict';
/* ------------------------------------------------------------------
   Yandex Music popup — Personal + Recommended playlists
   Шапка и кнопки управляют тем, что играет (очередь живёт в background).
   Список показывает открытый плейлист; клик по треку делает его очередью.
   ------------------------------------------------------------------ */

const TOKEN_KEY = 'yandex-music-token';

/************************ DOM REFERENCES ***************************/
const $auth = document.getElementById('auth');
const $authBtn = document.getElementById('auth-btn');
const $playlistSel = document.getElementById('playlist-selection');
const $playlistButtons = document.getElementById('playlist-buttons');
const $backBtn = document.getElementById('back-btn');
const $player = document.getElementById('player-section');
const $trackList = document.getElementById('track-list');
const $prev = document.getElementById('prev');
const $play = document.getElementById('play');
const $next = document.getElementById('next');
const $playIcon = document.getElementById('play-icon');
const $volume = document.getElementById('volume');
const $cover = document.getElementById('cover');
const $title = document.getElementById('track-title');
const $artist = document.getElementById('track-artist');
const $error = document.getElementById('error');
const $progress = document.getElementById('progress');
const $currentTime = document.getElementById('current-time');
const $duration = document.getElementById('duration');

/***************************** STATE ********************************/
let token = null;
let view = { playlistId: null, tracks: [] };   // какой плейлист открыт в списке
let pb = {                                      // состояние плеера из background
  playlistId: null, index: 0, queue: [], isPlaying: false,
  loading: false, currentTime: 0, duration: 0, volume: 1
};
let seeking = false;
let renderedView = null;
let lastActive = -1;
let errTimer = null;

/***************************** HELPERS ******************************/
const send = msg => chrome.runtime.sendMessage(msg).catch(() => {});
const fmt = s => {
  s = Number.isFinite(s) && s > 0 ? s : 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
function showError(m, sticky = false) {
  $error.textContent = m;
  $error.classList.remove('hidden');
  clearTimeout(errTimer);
  if (!sticky) errTimer = setTimeout(clearError, 6000);
}
function clearError() { $error.classList.add('hidden'); }
function show(section) {
  [$auth, $playlistSel, $player].forEach(el => el.classList.toggle('hidden', el !== section));
}
function coverUrl(c, size = '200x200') {
  const raw = (c && (c.uri || (c.itemsUri && c.itemsUri[0]))) || '';
  return raw ? 'https://' + raw.replace('%%', size) : '';
}
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/***************************** BOOTSTRAP ****************************/
chrome.runtime.onMessage.addListener(msg => {
  if (msg.target) return;   // адресовано offscreen
  switch (msg.action) {
    case 'token_updated': token = msg.token; init(); break;
    case 'auth_required': logout(); break;
    case 'player_error': showError(msg.message); break;
    case 'update_progress':
      pb.currentTime = msg.currentTime;
      if (msg.duration) pb.duration = msg.duration;
      renderProgress();
      break;
    case 'playback_state_updated':
      applyState(msg);
      renderPlayer();   // экран при этом не переключаем
      break;
  }
});

chrome.storage.local.get(TOKEN_KEY).then(r => {
  if (r[TOKEN_KEY]) { token = r[TOKEN_KEY]; init(); } else auth();
});

function auth() {
  show($auth);
  $authBtn.onclick = () => send({ action: 'open_oauth' });
}
function logout() {
  token = null;
  chrome.storage.local.remove(TOKEN_KEY);
  auth();
}

/******************************* INIT *******************************/
async function init() {
  clearError();
  $backBtn.onclick = () => show($playlistSel);
  bindControls();

  // Если что-то уже в очереди (музыка играет или стоит на паузе) — сразу показываем плеер
  let s = null;
  try { s = await chrome.runtime.sendMessage({ action: 'get_current_playback_state' }); } catch {}
  if (s) applyState(s);
  if (pb.queue.length) {
    view = { playlistId: pb.playlistId, tracks: pb.queue };
    show($player); renderPlayer();
  } else {
    show($playlistSel);
  }
  loadPlaylistButtons();   // не ждём — Back должен открываться мгновенно
}

function applyState(s) {
  pb = {
    playlistId: s.playlistId, index: s.index, queue: s.queue || [],
    isPlaying: !!s.isPlaying, loading: !!s.loading,
    currentTime: s.currentTime || 0, duration: s.duration || 0,
    volume: typeof s.volume === 'number' ? s.volume : 1
  };
}

/**************************** CONTROLS ******************************/
function bindControls() {
  $play.onclick = () => {
    if (pb.queue.length) send({ action: 'toggle_play' });
    else if (view.tracks.length) playFromView(0);   // первый запуск: с начала открытого плейлиста
  };
  $prev.onclick = () => pb.queue.length && send({ action: 'prev_track' });
  $next.onclick = () => pb.queue.length && send({ action: 'next_track' });
  $volume.oninput = e => send({ action: 'set_volume', value: e.target.value / 100 });
  // Пока тянем ползунок — не перезаписываем его прогрессом; seek отправляем при отпускании
  $progress.oninput = e => { seeking = true; $currentTime.textContent = fmt(e.target.value / 100 * pb.duration); };
  $progress.onchange = e => {
    if (pb.duration > 0) send({ action: 'seek', value: e.target.value / 100 * pb.duration });
    seeking = false;
  };
}

function playFromView(i) {
  send({ action: 'play_queue', playlistId: view.playlistId, tracks: view.tracks, index: i });
}

/*********************** FETCH PLAYLIST LISTS ***********************/
async function json(url) {
  const r = await fetch(url, { headers: { Authorization: 'OAuth ' + token } });
  if (!r.ok) throw new ApiError(r.status, `${r.status} – ${url}`);
  return r.json();
}
async function fetchPersonalPlaylists() {
  const lb = await json('https://api.music.yandex.net/landing-blocks/personal-playlists');
  const blocks = lb.items || lb.result?.blocks || lb.blocks || [];
  return blocks.filter(b => b.type === 'personal_playlist_item' && b.data?.playlist?.uid)
    .map(b => ({ title: b.data.playlist.title, id: `${b.data.playlist.uid}:${b.data.playlist.kind}`, cover: coverUrl(b.data.playlist.cover) }));
}
async function fetchRecommendedPlaylists() {
  const j = await json('https://api.music.yandex.net/landing/block/recommended-playlists');
  return (j.items || []).filter(i => i.type === 'liked_playlist_item' && i.data?.playlist).map(i => {
    const p = i.data.playlist;
    return { title: p.title, id: `${p.uid}:${p.kind}`, cover: coverUrl(p.cover) };
  });
}

async function loadPlaylistButtons() {
  // allSettled: если один из источников отвалился, второй всё равно покажем
  const res = await Promise.allSettled([fetchPersonalPlaylists(), fetchRecommendedPlaylists()]);
  if (res.some(r => r.status === 'rejected' && r.reason?.status === 401)) return logout();
  const byId = new Map();
  res.forEach(r => r.status === 'fulfilled' && r.value.forEach(p => byId.set(p.id, p)));
  renderButtons([...byId.values()]);
  if (!byId.size) {
    const bad = res.find(r => r.status === 'rejected');
    showError(bad ? (bad.reason.message || String(bad.reason)) : 'Плейлисты не найдены', true);
  }
}

function renderButtons(arr) {
  $playlistButtons.replaceChildren();   // при повторном init() кнопки не дублируются
  arr.forEach(pl => {
    const btn = document.createElement('button');
    if (pl.cover) btn.style.backgroundImage = `url("${pl.cover}")`;
    btn.onclick = () => openPlaylist(pl.id);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = pl.title;
    btn.appendChild(label);
    $playlistButtons.appendChild(btn);
  });
}

/************************ OPEN PLAYLIST (NO AUTOPLAY) ***************/
async function openPlaylist(playlistId) {
  // Этот плейлист уже в очереди — просто возвращаемся к плееру
  if (pb.queue.length && pb.playlistId === playlistId) {
    view = { playlistId, tracks: pb.queue };
    show($player); renderPlayer();
    return;
  }
  try {
    const pl = await fetchPlaylist(playlistId);
    const tracks = (pl.tracks || []).map(w => {
      const t = w.track || w;
      const raw = t.coverUri || t.cover?.uri || t.albums?.[0]?.coverUri || '';
      const cover = raw ? 'https://' + (raw.includes('%%') ? raw.replace('%%', '300x300') : raw.replace(/\/?$/, '/200x200')) : '';
      return {
        id: t.id, title: t.title, cover,
        artists: (t.artists || []).map(a => a.name).join(', '),
        duration: t.durationMs ? t.durationMs / 1000 : 0
      };
    });
    if (!tracks.length) throw new Error('Плейлист пуст');
    view = { playlistId, tracks };
    clearError();
    show($player); renderPlayer();
  } catch (e) {
    if (e.status === 401) return logout();
    showError(e.message || String(e));
  }
}
function fetchPlaylist(playlistId) {
  const [uid, kind] = playlistId.split(':');
  return json(`https://api.music.yandex.net/users/${uid}/playlists/${kind}?rich-tracks=true`).then(d => d.result);
}

/***************************** RENDER *******************************/
function renderPlayer() {
  if ($player.classList.contains('hidden')) return;

  // Шапка: играющий трек; если очередь пуста — первый трек открытого плейлиста
  const tr = pb.queue[pb.index] || view.tracks[0];
  $title.textContent = tr ? tr.title : 'Нет трека';
  $artist.textContent = tr ? tr.artists : '';
  if (tr && tr.cover) { if ($cover.getAttribute('src') !== tr.cover) $cover.src = tr.cover; }
  else $cover.removeAttribute('src');

  $playIcon.src = pb.isPlaying ? 'icons/pause.svg' : 'icons/play.svg';
  if (document.activeElement !== $volume) $volume.value = Math.round(pb.volume * 100);

  // Список: пересобираем только при смене плейлиста, иначе лишь подсветка
  if (renderedView !== view) {
    renderedView = view; lastActive = -1;
    $trackList.replaceChildren(...view.tracks.map((t, i) => {
      const li = document.createElement('li');
      li.textContent = `${t.title} — ${t.artists}`;
      li.title = li.textContent;
      li.onclick = () => playFromView(i);
      return li;
    }));
  }
  const active = pb.queue.length && pb.playlistId === view.playlistId ? pb.index : -1;
  [...$trackList.children].forEach((li, i) => li.classList.toggle('active', i === active));
  if (active !== lastActive) {
    lastActive = active;
    $trackList.children[active]?.scrollIntoView({ block: 'nearest' });
  }
  renderProgress();
}

function renderProgress() {
  if (seeking) return;
  const d = pb.duration;
  $progress.value = d > 0 ? Math.min(100, pb.currentTime / d * 100) : 0;
  $currentTime.textContent = fmt(pb.currentTime);
  $duration.textContent = fmt(d);
}
