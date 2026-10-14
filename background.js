// background.js – OAuth + управление offscreen-плеером
//
// ВАЖНО про MV3: service worker засыпает после ~30 с простоя и теряет всю память,
// а offscreen-документ с аудио Chrome закрывает через ~30 с после паузы.
// Поэтому очередь, индекс, позиция и громкость хранятся в chrome.storage.local,
// а «правда» о том, играет ли звук, берётся у offscreen-документа (если он жив).

const OAUTH_APP_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const TOKEN_KEY    = 'yandex-music-token';
const STATE_KEY    = 'player-state';
const OAUTH_URL    = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${OAUTH_APP_ID}`;
const TOKEN_RE     = /https:\/\/music\.yandex\.(?:ru|com|by|kz|ua)\/#access_token=([^&]*)/;
const OFFSCREEN_URL = 'offscreen.html';
const SIGN_SALT    = 'XGRlBW9FXlekgbPrRHuSiA';
const MAX_FAILS    = 5;   // подряд неудачных треков, после чего останавливаемся

/* ------------------------------ состояние ------------------------------ */
const DEFAULT_STATE = { queue: [], playlistId: null, index: 0, position: 0, volume: 1 };
let st = { ...DEFAULT_STATE };                       // сохраняется в storage
const rt = { isPlaying: false, loading: false, currentTime: 0, duration: 0 }; // только в памяти
let playToken = 0;   // защита от гонок: «устаревшие» загрузки треков игнорируются
let failCount = 0;
let lastPosSave = 0;

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => chrome.storage.local.set({ [STATE_KEY]: st }), 200);
}

const stateReady = loadState().catch(e => console.error('loadState', e));
async function loadState() {
  const r = await chrome.storage.local.get(STATE_KEY);
  if (r[STATE_KEY]) st = { ...DEFAULT_STATE, ...r[STATE_KEY] };
  // offscreen мог пережить перезапуск service worker — синхронизируемся с ним
  const info = await getAudioInfo();
  if (info && info.hasSrc) {
    rt.isPlaying = !info.paused;
    rt.currentTime = info.currentTime;
    rt.duration = info.duration || 0;
  }
}

const run = fn => stateReady.then(fn).catch(e => console.error(e));
const notify = msg => chrome.runtime.sendMessage(msg).catch(() => {}); // popup может быть закрыт

function publicState() {
  return {
    playlistId: st.playlistId, index: st.index, queue: st.queue,
    isPlaying: rt.isPlaying, loading: rt.loading,
    currentTime: rt.currentTime, duration: rt.duration, volume: st.volume
  };
}
const push = () => notify({ action: 'playback_state_updated', ...publicState() });
const reportError = message => notify({ action: 'player_error', message });

/* ------------------------------- OAuth --------------------------------- */
// tabId хранится в storage.session: пока пользователь вводит пароль, worker успевает уснуть
async function openOauthTab() {
  const tab = await chrome.tabs.create({ url: OAUTH_URL });
  await chrome.storage.session.set({ oauthTabId: tab.id });
}
chrome.tabs.onUpdated.addListener(async (id, _c, tab) => {
  if (!tab.url || !tab.url.includes('#access_token=')) return;
  const { oauthTabId } = await chrome.storage.session.get('oauthTabId');
  if (id !== oauthTabId) return;
  const m = tab.url.match(TOKEN_RE);
  if (!m || !m[1]) return;
  await chrome.storage.session.remove('oauthTabId');
  await chrome.storage.local.set({ [TOKEN_KEY]: m[1] });
  chrome.tabs.remove(id);
  notify({ action: 'token_updated', token: m[1] });
});

/* ------------------------------ offscreen ------------------------------ */
async function hasOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    return ctx.length > 0;
  }
  const clients = await self.clients.matchAll();
  return clients.some(c => c.url === url);
}

let creating = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Yandex Music background playback'
    }).finally(() => { creating = null; });
  }
  try { await creating; }
  catch (e) { if (!/single offscreen/i.test(e.message)) throw e; }
}

async function toOffscreen(msg) {
  try { await chrome.runtime.sendMessage({ target: 'offscreen', ...msg }); } catch { /* документа нет */ }
}

// null — если offscreen-документа нет (не создан или закрыт Chrome)
async function getAudioInfo() {
  if (!(await hasOffscreen())) return null;
  try {
    const timeout = new Promise(r => setTimeout(() => r(null), 700));
    return (await Promise.race([chrome.runtime.sendMessage({ target: 'offscreen', action: 'get_audio_info' }), timeout])) || null;
  } catch { return null; }
}

async function getFullState() {
  await stateReady;
  if (!rt.loading) {
    const info = await getAudioInfo();
    if (info && info.hasSrc) {
      rt.isPlaying = !info.paused;
      rt.currentTime = info.currentTime;
      rt.duration = info.duration || rt.duration;
    } else {
      // звука нет (первый запуск / документ закрыт) — показываем сохранённую позицию
      rt.isPlaying = false;
      rt.currentTime = st.position;
      rt.duration = (st.queue[st.index] && st.queue[st.index].duration) || 0;
    }
  }
  return publicState();
}

/* ------------------------------ воспроизведение ------------------------ */
async function playQueue({ playlistId, tracks, index }) {
  if (!Array.isArray(tracks) || !tracks.length) return;
  st.queue = tracks.map(({ id, title, artists, cover, duration }) => ({ id, title, artists, cover, duration }));
  st.playlistId = playlistId || null;
  await playTrack(index || 0);
}

async function playTrack(index, { startAt = 0, dir = 1, auto = false } = {}) {
  const n = st.queue.length;
  if (!n) return;
  if (!auto) failCount = 0;
  index = ((index % n) + n) % n;
  const my = ++playToken;
  const track = st.queue[index];

  st.index = index; st.position = startAt;
  rt.isPlaying = true; rt.loading = true; rt.currentTime = startAt; rt.duration = track.duration || 0;
  persist(); push();

  try {
    const token = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY];
    if (!token) throw new ApiError(401, 'Нет токена');
    const url = await fetchTrackUrl(token, track.id);
    if (my !== playToken) return;
    await ensureOffscreen();
    if (my !== playToken) return;
    await toOffscreen({
      action: 'play', url, startAt, volume: st.volume,
      meta: { title: track.title, artist: track.artists, cover: track.cover }
    });
    // rt.loading сбросится, когда offscreen пришлёт audio_state(playing)
  } catch (e) {
    if (my !== playToken) return;
    console.error('playTrack:', e);
    rt.loading = false;
    if (e.status === 401) {
      rt.isPlaying = false; push();
      await chrome.storage.local.remove(TOKEN_KEY);
      notify({ action: 'auth_required' });
      return;
    }
    failCount++;
    if (n > 1 && failCount < MAX_FAILS) {      // трек недоступен — пробуем следующий
      return playTrack(index + dir, { dir, auto: true });
    }
    rt.isPlaying = false; push();
    reportError('Не удалось воспроизвести трек: ' + e.message);
  }
}

const nextTrack = () => playTrack(st.index + 1, { dir: 1 });
async function prevTrack() {
  if (!st.queue.length) return;
  const info = await getAudioInfo();
  const t = info && info.hasSrc ? info.currentTime : rt.currentTime;
  if (t > 3) return seekTo(0);                  // как в обычных плеерах: сначала в начало трека
  return playTrack(st.index - 1, { dir: -1 });
}

async function togglePlay() {
  if (!st.queue.length) return;
  if (rt.loading) {                              // пауза во время загрузки = отмена
    playToken++; rt.loading = false; rt.isPlaying = false; push();
    return;
  }
  const info = await getAudioInfo();
  if (info && info.hasSrc && !info.ended) {
    if (info.paused) {
      await toOffscreen({ action: 'resume' });
      rt.isPlaying = true;
    } else {
      st.position = info.currentTime; persist();
      await toOffscreen({ action: 'pause' });
      rt.isPlaying = false;
    }
    push();
  } else {
    // Аудио нет: первый запуск либо Chrome закрыл offscreen после долгой паузы.
    // Заново берём ссылку и продолжаем с сохранённой позиции.
    await playTrack(st.index, { startAt: st.position });
  }
}

async function seekTo(sec) {
  if (!Number.isFinite(sec) || sec < 0) return;
  const info = await getAudioInfo();
  rt.currentTime = sec;
  if (info && info.hasSrc) {
    await toOffscreen({ action: 'seek', value: sec });
  } else {
    st.position = sec; persist(); push();        // продолжим с этого места по Play
  }
}

async function setVolume(v) {
  v = Number(v);
  if (!Number.isFinite(v)) return;
  st.volume = Math.min(1, Math.max(0, v)); persist();
  await toOffscreen({ action: 'set_volume', value: st.volume });
}

/* ------------------------------- router -------------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target) return;               // адресовано offscreen
  switch (msg.action) {
    case 'open_oauth':  openOauthTab(); break;
    case 'get_current_playback_state':
      getFullState().then(sendResponse);
      return true;
    case 'play_queue':  run(() => playQueue(msg)); break;
    case 'toggle_play': run(togglePlay); break;
    case 'next_track':  run(nextTrack); break;
    case 'prev_track':  run(prevTrack); break;
    case 'seek':        run(() => seekTo(msg.value)); break;
    case 'set_volume':  run(() => setVolume(msg.value)); break;

    // ---- события от offscreen ----
    case 'update_progress':
      run(() => {
        if (rt.loading) return;
        rt.currentTime = msg.currentTime;
        if (msg.duration) rt.duration = msg.duration;
        if (Date.now() - lastPosSave > 5000) { lastPosSave = Date.now(); st.position = msg.currentTime; persist(); }
      });
      break;
    case 'audio_state':
      run(() => {
        const changed = rt.isPlaying !== msg.playing || rt.loading;
        rt.isPlaying = msg.playing;
        if (msg.playing) { rt.loading = false; failCount = 0; }
        else { st.position = msg.currentTime || 0; persist(); }
        if (changed) push();
      });
      break;
    case 'track_ended': run(nextTrack); break;
    case 'audio_error':
      run(async () => {
        if (msg.code === 1) return;             // MEDIA_ERR_ABORTED — это не ошибка
        failCount++;
        // первая ошибка — вероятно протухла ссылка: берём новую и продолжаем с того же места
        if (failCount <= 1) return playTrack(st.index, { startAt: msg.currentTime || 0, auto: true });
        if (failCount < MAX_FAILS && st.queue.length > 1) return playTrack(st.index + 1, { auto: true });
        rt.isPlaying = false; rt.loading = false; push();
        reportError('Ошибка воспроизведения');
      });
      break;
  }
});

/* ---------------------------- Yandex Music API -------------------------- */
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(url, token) {
  const res = await fetch(url, { headers: { Authorization: 'OAuth ' + token } });
  if (!res.ok) throw new ApiError(res.status, `${res.status} – ${res.statusText}`);
  return res.json();
}

async function fetchTrackUrl(token, trackId) {
  const info = await api(`https://api.music.yandex.net/tracks/${trackId}/download-info`, token);
  const list = info && info.result;
  if (!(list && list.length)) throw new Error('download-info пуст');
  const best = list.find(i => i.codec === 'mp3' && i.bitrateInKbps === 192) || list[0];
  if (best.directUrl) return best.directUrl;
  if (best.downloadInfoUrl) return resolveDownloadInfo(best.downloadInfoUrl, best.codec || 'mp3');
  throw new Error('Не удалось извлечь ссылку трека');
}

async function resolveDownloadInfo(infoUrl, codec) {
  const res = await fetch(infoUrl);
  if (!res.ok) throw new Error('downloadInfoUrl ' + res.status);
  const xml = await res.text();
  const g = t => (xml.match(new RegExp(`<${t}>([^<]+)</${t}>`)) || [])[1];
  const host = g('host'), path = g('path'), ts = g('ts'), s = g('s');
  if (!host || !path || !ts || !s) throw new Error('XML download info неполный');
  // Ссылка подписывается: md5(соль + путь без первого «/» + s)
  const sign = md5(SIGN_SALT + path.slice(1) + s);
  return `https://${host}/get-${codec}/${sign}/${ts}${path}`;
}

/* ------------------------------- MD5 ----------------------------------- */
// В SubtleCrypto MD5 нет, а подпись ссылки без него не посчитать.
function md5(str) {
  const bytes = new TextEncoder().encode(str);
  const len = bytes.length;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(bytes); padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);
  const S = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => dv.getUint32(off + i * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16)      { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D;          g = (3 * i + 5) % 16; }
      else             { F = C ^ (B | ~D);       g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      const sh = S[(i >> 4) * 4 + (i % 4)];
      B = (B + ((F << sh) | (F >>> (32 - sh)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return [...new Uint8Array(out.buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}
