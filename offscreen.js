// offscreen.js – единственное место, где реально играет звук
const audio = document.getElementById('player');
let pendingStart = 0;   // позиция, с которой надо начать после загрузки метаданных

const send = msg => chrome.runtime.sendMessage(msg).catch(() => {});
const finite = x => (Number.isFinite(x) ? x : 0);

function progress() {
  send({ action: 'update_progress', currentTime: finite(audio.currentTime), duration: finite(audio.duration) });
}

// timeupdate приходит ~4 раза в секунду и только пока играет звук
audio.addEventListener('timeupdate', progress);
audio.addEventListener('durationchange', progress);
audio.addEventListener('loadedmetadata', () => {
  if (pendingStart > 0) audio.currentTime = pendingStart;
  pendingStart = 0;
});
audio.addEventListener('playing', () => send({ action: 'audio_state', playing: true }));
audio.addEventListener('pause', () => {
  if (audio.ended) return;   // при окончании трека pause приходит перед ended
  send({ action: 'audio_state', playing: false, currentTime: finite(audio.currentTime) });
});
audio.addEventListener('ended', () => send({ action: 'track_ended' }));
audio.addEventListener('error', () => {
  send({ action: 'audio_error', code: audio.error && audio.error.code, currentTime: finite(audio.currentTime) });
});

function tryPlay() {
  audio.play().catch(e => {
    if (e.name === 'AbortError') return;   // src сменили на лету — это нормально
    send({ action: 'audio_error', code: 0, currentTime: finite(audio.currentTime) });
  });
}

/* ---- Media Session: медиаклавиши и системный виджет Chrome ---- */
function setMeta(meta) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = meta ? new MediaMetadata({
      title: meta.title || '', artist: meta.artist || '',
      artwork: meta.cover ? [{ src: meta.cover, sizes: '300x300' }] : []
    }) : null;
  } catch { /* не критично */ }
}
if ('mediaSession' in navigator) {
  const on = (a, h) => { try { navigator.mediaSession.setActionHandler(a, h); } catch {} };
  on('play', tryPlay);
  on('pause', () => audio.pause());
  on('nexttrack', () => send({ action: 'next_track' }));
  on('previoustrack', () => send({ action: 'prev_track' }));
  on('seekto', d => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
}

/* ---- команды от background ---- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  switch (msg.action) {
    case 'play':
      if (typeof msg.volume === 'number') audio.volume = Math.min(1, Math.max(0, msg.volume));
      pendingStart = msg.startAt || 0;
      audio.src = msg.url;        // пауза перед сменой src не нужна — она давала ложное событие pause
      setMeta(msg.meta);
      tryPlay();
      break;
    case 'pause':  audio.pause(); break;
    case 'resume': tryPlay(); break;
    case 'seek':   if (Number.isFinite(msg.value)) audio.currentTime = msg.value; break;
    case 'set_volume': audio.volume = Math.min(1, Math.max(0, msg.value)); break;
    case 'get_audio_info':
      sendResponse({
        hasSrc: !!audio.getAttribute('src'),
        paused: audio.paused, ended: audio.ended,
        currentTime: finite(audio.currentTime), duration: finite(audio.duration)
      });
      break;
  }
});
