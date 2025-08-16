// background.js – OAuth + offscreen player
const OAUTH_APP_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const TOKEN_KEY    = 'yandex-music-token';
const OAUTH_URL    = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${OAUTH_APP_ID}`;
const TOKEN_RE     = /https:\/\/music\.yandex\.(?:ru|com|by|kz|ua)\/#access_token=([^&]*)/;

let oauthTabId = null;
let offscreenReady = false;
let offscreenCreating = false;

// Состояние воспроизведения, которое background.js будет хранить
let currentPlaybackState = {
  currentTrackIndex: 0,
  isPlaying: false,
  currentTrackListIds: [], // Только ID треков
  currentFullTrackListInfo: [], // Полная информация о треках
  currentPlaylistId: null,
  currentTime: 0, // Добавлено для синхронизации прогресса
  duration: 0     // Добавлено для синхронизации прогресса
};

/* OAuth flow */
function openOauthTab(){ chrome.tabs.create({url:OAUTH_URL}, t=> oauthTabId=t.id); }
chrome.tabs.onUpdated.addListener((id,_c,tab)=>{
  if(id!==oauthTabId||!tab.url) return;
  const m=tab.url.match(TOKEN_RE);
  if(m&&m[1]){
    chrome.storage.local.set({[TOKEN_KEY]:m[1]});
    chrome.tabs.remove(oauthTabId); oauthTabId=null;
    chrome.runtime.sendMessage({action:'token_updated', token:m[1]});
  }
});

/* one-shot offscreen factory */
async function ensureOffscreen(){
  if(offscreenReady || offscreenCreating) return;
  offscreenCreating = true;
  if(chrome.offscreen){
    const exists = await chrome.offscreen.hasDocument?.();
    if(!exists){
      await chrome.offscreen.createDocument({
        url:'offscreen.html',
        reasons:[chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification:'Yandex Music background playback'
      });
    }
  }
  offscreenReady = true;
  offscreenCreating = false;
}

// Функция для обновления состояния и отправки в попап
async function updateAndNotifyPopup(changes = {}) {
  Object.assign(currentPlaybackState, changes);
  chrome.storage.local.set({
    currentIndex: currentPlaybackState.currentTrackIndex,
    isPlaying: currentPlaybackState.isPlaying,
    trackIds: currentPlaybackState.currentTrackListIds,
    playlistId: currentPlaybackState.currentPlaylistId
    // currentTime и duration не сохраняются постоянно, а запрашиваются при необходимости
  });

  // Отправляем полное состояние в popup
  chrome.runtime.sendMessage({
    action: 'playback_state_updated',
    currentIndex: currentPlaybackState.currentTrackIndex,
    isPlaying: currentPlaybackState.isPlaying,
    trackList: currentPlaybackState.currentTrackListIds,
    fullTrackInfo: currentPlaybackState.currentFullTrackListInfo, // Отправляем полную инфу
    playlistId: currentPlaybackState.currentPlaylistId,
    currentTime: currentPlaybackState.currentTime, // Передаем текущее время
    duration: currentPlaybackState.duration       // Передаем длительность
  });
}

async function playTrack(index, playlistId) {
    if (!currentPlaybackState.currentTrackListIds.length || !currentPlaybackState.currentFullTrackListInfo.length || !playlistId || !currentPlaybackState.currentPlaylistId) {
        console.warn("Нет активного плейлиста или треков для воспроизведения. Попытка загрузить из хранилища...");
        const stored = await chrome.storage.local.get(['trackIds', TOKEN_KEY, 'playlistId']);
        if (stored.trackIds && stored.trackIds.length && stored.playlistId) {
            currentPlaybackState.currentTrackListIds = stored.trackIds;
            currentPlaybackState.currentPlaylistId = stored.playlistId;
            // Здесь нужен способ восстановить fullTrackInfo, если popup закрыт
            // Возможно, fetchPlaylist снова, или сохранять fullTrackInfo в storage
            // Для простоты пока используем то, что есть, а полный список получит popup при открытии
            console.warn("Восстановлен плейлист из хранилища, но полная информация о треках может отсутствовать до открытия попапа.");
        } else {
            console.error("Невозможно воспроизвести трек: нет плейлиста в текущем состоянии или хранилище.");
            return;
        }
    }

    const token = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY];
    if (!token) {
        console.error("Токен Яндекс Музыки не найден. Невозможно воспроизвести трек.");
        return;
    }

    const trackIdToPlay = currentPlaybackState.currentTrackListIds[index];
    if (!trackIdToPlay) {
        console.error("Не удалось найти трек по индексу", index);
        return;
    }

    try {
        const url = await fetchTrackUrl(token, trackIdToPlay);
        await ensureOffscreen();
        chrome.runtime.sendMessage({ action: 'play', url, target: 'offscreen' });
        updateAndNotifyPopup({
            currentTrackIndex: index,
            isPlaying: true,
            playlistId: playlistId || currentPlaybackState.currentPlaylistId // Убедимся, что ID плейлиста установлен
        });
        console.log(`Playing track index: ${index}, ID: ${trackIdToPlay}`);
    } catch (e) {
        console.error("Error playing track:", e);
        updateAndNotifyPopup({ isPlaying: false }); // Останавливаем воспроизведение в UI
    }
}

async function nextTrack() {
    if (!currentPlaybackState.currentTrackListIds.length) return;
    const newIndex = (currentPlaybackState.currentTrackIndex + 1) % currentPlaybackState.currentTrackListIds.length;
    await playTrack(newIndex, currentPlaybackState.currentPlaylistId);
}

async function prevTrack() {
    if (!currentPlaybackState.currentTrackListIds.length) return;
    const newIndex = (currentPlaybackState.currentTrackIndex - 1 + currentPlaybackState.currentTrackListIds.length) % currentPlaybackState.currentTrackListIds.length;
    await playTrack(newIndex, currentPlaybackState.currentPlaylistId);
}


// router
chrome.runtime.onMessage.addListener(async (msg) => {
    if (msg.action === 'open_oauth') {
        openOauthTab();
        return;
    }
    
    // Получение информации о плейлисте и треках от popup.js
    if (msg.action === 'set_playlist_info') {
        currentPlaybackState.currentTrackListIds = msg.trackIds;
        currentPlaybackState.currentFullTrackListInfo = msg.fullTrackInfo; // Сохраняем полную инфу
        currentPlaybackState.currentPlaylistId = msg.playlistId;
        console.log('Playlist info set in background:', currentPlaybackState.currentPlaylistId, currentPlaybackState.currentTrackListIds.length);
        return;
    }

    // Воспроизведение трека по индексу из popup.js
    if (msg.action === 'play_track_by_index') {
        await playTrack(msg.index, msg.playlistId);
        return;
    }

    if (msg.action === 'track_ended') {
        await nextTrack(); // Переходим к следующему треку при окончании текущего
        return;
    }

    if (msg.action === 'prev_track') {
        await prevTrack();
        return;
    }

    if (msg.action === 'next_track') {
        await nextTrack();
        return;
    }

    if (msg.action === 'pause') {
        await ensureOffscreen();
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'pause' });
        updateAndNotifyPopup({ isPlaying: false });
        return;
    }

    if (msg.action === 'resume_or_play_current') {
        if (currentPlaybackState.isPlaying) { // Уже играет, ничего не делаем
            return;
        }
        if (currentPlaybackState.currentTrackListIds.length > 0) {
            // Если есть трек и он не играет, возобновляем или начинаем с текущего
            // Проверяем, играет ли offscreen что-то, прежде чем отправлять resume
            await ensureOffscreen();
            chrome.runtime.sendMessage({ target: 'offscreen', action: 'resume' });
            updateAndNotifyPopup({ isPlaying: true });
        } else {
             // Если нет треков, возможно, нужно загрузить последний плейлист
             // (Этот сценарий уже должен быть обработан при инициализации попапа,
             // когда он запрашивает get_current_playback_state)
            console.warn("Попытка воспроизвести без загруженного плейлиста.");
        }
        return;
    }

    if (msg.action === 'set_volume') {
        await ensureOffscreen();
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'set_volume', value: msg.value });
        return;
    }

    if (msg.action === 'seek') {
        await ensureOffscreen();
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'seek', value: msg.value });
        return;
    }

    // Получение информации о прогрессе от offscreen.js и пересылка в popup.js
    if (msg.action === 'update_progress') {
        currentPlaybackState.currentTime = msg.currentTime;
        currentPlaybackState.duration = msg.duration;
        chrome.runtime.sendMessage(msg); // Пересылаем в popup
        return;
    }

    // Обработчик для запроса текущего состояния воспроизведения от popup.js
    if (msg.action === 'get_current_playback_state') {
        console.log("Popup requested current playback state.");
        // Сначала пытаемся получить текущее время и длительность из offscreen.js
        if (offscreenReady) {
            chrome.runtime.sendMessage({ action: 'get_audio_info', target: 'offscreen' });
        }
        // Затем отправляем текущее состояние (которое уже должно быть обновлено)
        // ВАЖНО: `playback_state_updated` должен быть отправлен после того, как `update_progress`
        // принесет последние данные о времени/длительности, если это возможно.
        // Для простоты, пока отправляем то, что есть сразу.
        // Более сложное решение - промис, который ждет ответа от offscreen.js
        // Но `update_progress` обрабатывается асинхронно, так что popup получит его позже.
        updateAndNotifyPopup(); // Отправляем текущее состояние
        return;
    }
});

// Инициализация состояния из хранилища при запуске service worker
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['currentIndex', 'isPlaying', 'trackIds', 'playlistId'], (r) => {
        currentPlaybackState.currentTrackIndex = r.currentIndex || 0;
        currentPlaybackState.isPlaying = r.isPlaying || false;
        currentPlaybackState.currentTrackListIds = r.trackIds || [];
        currentPlaybackState.currentPlaylistId = r.playlistId || null;
        console.log("Background state initialized from storage:", currentPlaybackState);
        // Если музыка играла до закрытия расширения/браузера, возобновляем воспроизведение
        if (currentPlaybackState.isPlaying && currentPlaybackState.currentTrackListIds.length > 0 && currentPlaybackState.currentPlaylistId) {
            playTrack(currentPlaybackState.currentTrackIndex, currentPlaybackState.currentPlaylistId);
        }
    });
});

// Функции для работы с API (без изменений)
function json(url, token, opts) {
  opts = opts || {};
  var headers = opts.headers || {};
  headers.Authorization = 'OAuth ' + token;
  opts.headers = headers;
  return fetch(url, opts).then(function (res) {
    if (!res.ok) {
      throw new Error(res.status + ' – ' + res.statusText + ' @ ' + url);
    }
    return res.json();
  });
}
function fetchPlaylistOfTheDay(token) {
  return json('https://api.music.yandex.net/landing-blocks/personal-playlists', token)
    .then(function (lb) {
      if (lb && lb.name === 'Unavailable For Legal Reasons') {
        throw new Error('Yandex API вернул "Unavailable For Legal Reasons"');
      }
      function isPlaylistOfDay(obj) {
        return obj && obj.type === 'personal_playlist_item' && obj.data && obj.data.playlist &&
          (obj.data.playlist.idForFrom === 'playlist_of_the_day' || obj.data.playlist.title === 'Плейлист дня' || obj.data.playlistType === 'playlistOfTheDay');
      }
      function extractId(pl) { return { playlistId: pl.uid + ':' + pl.kind }; }
      var blocks = [];
      if (Array.isArray(lb.items)) {
        blocks = lb.items;
      } else {
        blocks = (lb.result && lb.result.blocks) || lb.blocks || [];
      }
      for (var i = 0; i < blocks.length; i++) {
        var e = blocks[i];
        if (e.type !== 'personal_playlist_item' && e.entities) {
          for (var j = 0; j < e.entities.length; j++) {
            var ent = e.entities[j];
            if (isPlaylistOfDay(ent)) {
              return extractId(ent.data.playlist);
            }
          }
        } else if (isPlaylistOfDay(e)) {
          return extractId(e.data.playlist);
        }
      }
      throw new Error('Не найден «Плейлист дня» в landing blocks');
    });
}
function fetchPlaylist(token, playlistId) {
  var parts = playlistId.split(':');
  if (parts.length !== 2) {
    return Promise.reject(new Error('Некорректный playlistId'));
  }
  var uid = parts[0];
  var kind = parts[1];
  var url = 'https://api.music.yandex.net/users/' + uid + '/playlists/' + kind + '?rich-tracks=true';
  return fetch(url, { headers: { Authorization: 'OAuth ' + token } }).then(function (res) {
    if (res.ok) {
      return res.json().then(function (d) { return d.result; });
    }
    var body = new URLSearchParams({ playlistIds: playlistId });
    return fetch('https://api.music.yandex.net/playlists/list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'OAuth ' + token
      },
      body: body
    }).then(function (res2) {
      if (!res2.ok) {
        throw new Error(res2.status + ' – ' + res2.statusText);
      }
      return res2.json().then(function (d2) { return d2.result[0]; });
    });
  });
}
function fetchTrackUrl(token, trackId) {
  return json('https://api.music.yandex.net/tracks/' + trackId + '/download-info', token)
    .then(function (info) {
      if (!(info.result && info.result.length)) {
        throw new Error('download-info пуст');
      }
      var best = info.result.find(function (i) { return i.codec === 'mp3' && i.bitrateInKbps === 192; }) || info.result[0];
      if (best.directUrl) {
        return best.directUrl;
      }
      if (best.downloadInfoUrl) {
        return resolveDownloadInfo(best.downloadInfoUrl);
      }
      throw new Error('Не удалось извлечь ссылку трека');
    });
}
function resolveDownloadInfo(infoUrl) {
  return fetch(infoUrl).then(function (res) {
    if (!res.ok) {
      throw new Error('downloadInfoUrl ' + res.status);
    }
    return res.text();
  }).then(function (xml) {
    var host = (xml.match(/<host>([^<]+)<\/host>/) || [])[1];
    var path = (xml.match(/<path>([^<]+)<\/path>/) || [])[1];
    var ts   = (xml.match(/<ts>([^<]+)<\/ts>/) || [])[1];
    var s    = (xml.match(/<s>([^<]+)<\/s>/) || [])[1];
    if (!host || !path || !ts || !s) {
      throw new Error('XML download info неполный');
    }
    return 'https://' + host + '/get-mp3/' + s + '/' + ts + path;
  });
}
