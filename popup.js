'use strict';
/* ------------------------------------------------------------------
   Yandex Music popup — Personal + Recommended playlists
   (landing/block/recommended-playlists) • NO autoplay on open
   ------------------------------------------------------------------ */

/**************************** CONSTANTS *****************************/
const TOKEN_KEY       = 'yandex-music-token';
const PLAYLIST_ID_KEY = 'current-playlist-id';
const IDX_PREFIX      = 'PLIDX-';          // per playlist index key

/************************ DOM REFERENCES ***************************/
const $auth  = document.getElementById('auth');
const $authBtn = document.getElementById('auth-btn');
const $playlistSel = document.getElementById('playlist-selection');
const $playlistButtons = document.getElementById('playlist-buttons');
const $backBtn = document.getElementById('back-btn');
const $player  = document.getElementById('player-section');
const $trackList = document.getElementById('track-list');
const $prev = document.getElementById('prev');
const $play = document.getElementById('play');
const $next = document.getElementById('next');
const $playIcon = document.getElementById('play-icon');
const $volume = document.getElementById('volume');
const $cover  = document.getElementById('cover');
const $title  = document.getElementById('track-title');
const $artist = document.getElementById('track-artist');
const $error  = document.getElementById('error');
const $progress = document.getElementById('progress');
const $currentTime = document.getElementById('current-time');
const $duration    = document.getElementById('duration');

/***************************** STATE ********************************/
let state = {
  token:null, tracks:[], index:0, playing:false, duration:0, playlistId:null
};

/***************************** HELPERS ******************************/
const err = m=>{ $error.textContent=m; $error.classList.remove('hidden'); $player.classList.add('hidden'); };
const ok  = ()=>{ $error.classList.add('hidden'); };
const fmt = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const showPlayer = ()=>{ $player.classList.remove('hidden'); $playlistSel.classList.add('hidden'); $auth.classList.add('hidden'); };
const showPlaylistSel = ()=>{ $player.classList.add('hidden'); $playlistSel.classList.remove('hidden'); $auth.classList.add('hidden'); state.tracks=[]; };
const showAuth = ()=>{ $player.classList.add('hidden'); $playlistSel.classList.add('hidden'); $auth.classList.remove('hidden'); };

/***************************** BOOTSTRAP ****************************/
chrome.storage.local.get(TOKEN_KEY, r=>{
  r[TOKEN_KEY] ? (state.token=r[TOKEN_KEY], init()) : auth();
});

function auth(){
  showAuth();
  $authBtn.onclick = ()=> chrome.runtime.sendMessage({action:'open_oauth'});
  chrome.runtime.onMessage.addListener(msg=>{
    if(msg.action==='token_updated'){ state.token=msg.token; init(); }
  });
}

/******************************* INIT *******************************/
function init(){
  ok();
  $backBtn.onclick = showPlaylistSel;
  bindCtrl();

  // Запрашиваем текущее состояние воспроизведения из background.js при открытии попапа
  chrome.runtime.sendMessage({ action: 'get_current_playback_state' });

  // Загружаем плейлисты для кнопок
  Promise.all([
    fetchPersonalPlaylists(state.token),
    fetchRecommendedPlaylists(state.token)
  ]).then(([personal,recommended])=>{
      renderButtons(personal);
      renderButtons(recommended);
  }).catch(e=>err(e.message||e));
}

/**************************** CONTROLS ******************************/
function bindCtrl(){
  $play.onclick = toggle;
  $prev.onclick = ()=> chrome.runtime.sendMessage({action:'prev_track'}); // Отправляем команду в background
  $next.onclick = ()=> chrome.runtime.sendMessage({action:'next_track'}); // Отправляем команду в background
  $volume.oninput = e=> chrome.runtime.sendMessage({action:'set_volume', value: parseFloat(e.target.value)/100});
  $progress.oninput = e=> chrome.runtime.sendMessage({action:'seek', value:(e.target.value/100)*state.duration});

  chrome.runtime.onMessage.addListener(msg=>{
    if(msg.action==='update_progress'){
      $progress.value = (msg.currentTime/msg.duration)*100;
      $currentTime.textContent = fmt(msg.currentTime);
      $duration.textContent    = fmt(msg.duration);
      state.duration = msg.duration;
    }
    // Обработчик для получения полного состояния воспроизведения из background.js
    if(msg.action === 'playback_state_updated'){
      state.index = msg.currentIndex;
      state.playing = msg.isPlaying;
      state.trackList = msg.trackList; // Сохраняем список треков, если он пришел
      state.playlistId = msg.playlistId; // Сохраняем ID плейлиста
      state.tracks = msg.fullTrackInfo; // Получаем полную информацию о треках

      $playIcon.src = state.playing ? 'icons/pause.svg' : 'icons/play.svg';

      if(state.playlistId && state.tracks && state.tracks.length > 0) {
        showPlayer();
        list(); // Обновляем список треков в UI
        update(); // Обновляем информацию о текущем треке
        // Устанавливаем прогресс и время, если они доступны
        if (msg.currentTime !== undefined && msg.duration !== undefined) {
          $progress.value = (msg.currentTime / msg.duration) * 100;
          $currentTime.textContent = fmt(msg.currentTime);
          $duration.textContent = fmt(msg.duration);
          state.duration = msg.duration;
        }
      } else if (state.token) { // Если нет воспроизведения, но есть токен, показываем выбор плейлиста
          showPlaylistSel();
      } else { // Если нет токена, показываем авторизацию
          showAuth();
      }
    }
  });
}

/*********************** FETCH PLAYLIST LISTS ***********************/
async function fetchPersonalPlaylists(token){
  const lb = await json('https://api.music.yandex.net/landing-blocks/personal-playlists', token);
  const blocks = lb.items || lb.result?.blocks || lb.blocks || [];
  return blocks.filter(b=>b.type==='personal_playlist_item' && b.data?.playlist?.uid)
               .map(b=>({
                 title : b.data.playlist.title,
                 id    : `${b.data.playlist.uid}:${b.data.playlist.kind}`,
                 cover : b.data.playlist.cover.uri.replace('%%','200x200')
               }));
}
async function fetchRecommendedPlaylists(token){
  const j = await json('https://api.music.yandex.net/landing/block/recommended-playlists', token);
  const items = j.items || [];
  return items.filter(i=>i.type==='liked_playlist_item').map(i=>{
     const p=i.data.playlist;
     return { title:p.title, id:`${p.uid}:${p.kind}`, cover:p.cover.uri.replace('%%','200x200') };
  });
}

/************************ RENDER BUTTONS ****************************/
function renderButtons(arr){
  arr.forEach(pl=>{
    const btn=document.createElement('button');
    btn.style.backgroundImage=`url(https://${pl.cover})`;
    btn.onclick = ()=> loadPlaylistAndPlay(pl.id);
    const label=document.createElement('span');
    label.className='label';
    label.textContent=pl.title;
    btn.appendChild(label);
    $playlistButtons.appendChild(btn);
  });
}

/**************** LOAD & DISPLAY PLAYLIST (NO AUTOPLAY) *************/
async function loadPlaylistAndPlay(playlistId, isResuming=false){
  try{
    const pl = await fetchPlaylist(state.token, playlistId);
    const tracks = (pl.tracks||[]).map(w=>{
      const t=w.track||w;
      const raw=t.cover?.uri||t.albums?.[0]?.coverUri||'';
      const cover = raw ? 'https://'+(raw.includes('%%')?raw.replace('%%','300x300'):raw.replace(/\/?$/,'/200x200')) : '';
      return { id:t.id, title:t.title, artists:(t.artists||[]).map(a=>a.name).join(', '), cover };
    });
    if(!tracks.length) throw new Error('Плейлист пуст');

    state.tracks = tracks;
    state.playlistId = playlistId;

    const trackIds = tracks.map(t=>t.id);
    // Отправляем полную информацию о треках и ID плейлиста в background.js
    chrome.runtime.sendMessage({action:'set_playlist_info', playlistId: playlistId, trackIds: trackIds, fullTrackInfo: tracks });

    chrome.storage.local.set({[PLAYLIST_ID_KEY]:playlistId});

    const idxKey = IDX_PREFIX+playlistId;
    chrome.storage.local.get(idxKey, res=>{
      state.index = isResuming && typeof res[idxKey]==='number' && res[idxKey]<tracks.length
                    ? res[idxKey] : 0;
      state.playing=false; $playIcon.src='icons/play.svg';
      showPlayer(); list(); update();
    });
  }catch(e){ err(e.message||e); }
}

/***************************** UI ***********************************/
function list(){
  $trackList.innerHTML='';
  state.tracks.forEach((tr,i)=>{
    const li=document.createElement('li');
    li.textContent = `${tr.title} — ${tr.artists}`;
    li.onclick = ()=> play(i); // Теперь play(i) будет отправлять сообщение в background
    if(i===state.index) li.classList.add('active');
    $trackList.appendChild(li);
  });
}
function update(){
  const tr = state.tracks[state.index];
  if (tr) { // Добавляем проверку, чтобы избежать ошибок, если трека нет
    $cover.src = tr.cover;
    $title.textContent = tr.title;
    $artist.textContent = tr.artists;
  } else {
    // Очищаем информацию, если трек не найден
    $cover.src = '';
    $title.textContent = 'Нет трека';
    $artist.textContent = '';
  }
  document.querySelectorAll('#track-list li').forEach(li=>li.classList.remove('active'));
  const act = document.querySelectorAll('#track-list li')[state.index];
  if(act) act.classList.add('active');
}

/************************ PLAYER CONTROL ****************************/
function play(i){
  state.index = i;
  const tr = state.tracks[i];
  if (!tr) {
    console.error("Не удалось найти трек по индексу:", i);
    return;
  }
  // Отправляем сообщение background.js для воспроизведения
  chrome.runtime.sendMessage({
    action: 'play_track_by_index',
    index: i,
    playlistId: state.playlistId,
    trackId: tr.id // Передаем ID трека для удобства
  });
  state.playing = true;
  $playIcon.src = 'icons/pause.svg';
  update(); // Обновляем UI сразу
}

// Изменена логика toggle для отправки команд в background.js
function toggle(){
  if(state.playing){
    chrome.runtime.sendMessage({action:'pause'});
  }else if(state.tracks.length){
    // Если трек не играет, но есть треки в плейлисте, пытаемся его воспроизвести
    // Возможно, нужно возобновить текущий или начать с 0, если ничего не играло
    chrome.runtime.sendMessage({action:'resume_or_play_current'});
  }
  // Состояние state.playing будет обновлено через message 'playback_state_updated' от background.js
}


/********************** NETWORK HELPERS *****************************/
function json(url,token,opts={}){
  opts.headers = {...(opts.headers||{}), Authorization:'OAuth '+token};
  return fetch(url,opts).then(r=>{ if(!r.ok) throw new Error(`${r.status} – ${url}`); return r.json(); });
}
function fetchPlaylist(token,playlistId){
  const [uid,kind] = playlistId.split(':');
  const url = `https://api.music.yandex.net/users/${uid}/playlists/${kind}?rich-tracks=true`;
  return fetch(url,{headers:{Authorization:'OAuth '+token}})
           .then(r=> r.ok ? r.json().then(d=>d.result)
                          : Promise.reject(new Error('playlist fetch error')));
}
function fetchTrackUrl(token,id){
  return json(`https://api.music.yandex.net/tracks/${id}/download-info`, token)
    .then(info=>{
      const best=info.result.find(i=>i.codec==='mp3' && i.bitrateInKbps===192) || info.result[0];
      return best.directUrl || resolveDownloadInfo(best.downloadInfoUrl);
    });
}
function resolveDownloadInfo(u){
  return fetch(u).then(r=>r.text()).then(xml=>{
    const g=t=>(xml.match(new RegExp(`<${t}>([^<]+)</${t}>`))||[])[1];
    const host=g('host'), path=g('path'), ts=g('ts'), s=g('s');
    if(!host||!path||!ts||!s) throw new Error('download-info XML incomplete');
    return `https://${host}/get-mp3/${s}/${ts}${path}`;
  });
}