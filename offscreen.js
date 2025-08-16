// offscreen.js
const audio = document.getElementById('player');
let progressInterval = null; // Добавил переменную для интервала

function startProgressUpdates() {
    if (progressInterval) {
        clearInterval(progressInterval);
    }
    progressInterval = setInterval(() => {
        chrome.runtime.sendMessage({
            action: 'update_progress',
            currentTime: audio.currentTime,
            duration: audio.duration
        });
    }, 200); // Обновляем каждые 200мс
}

function stopProgressUpdates() {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
}

audio.addEventListener('ended', ()=>{
    stopProgressUpdates();
    chrome.runtime.sendMessage({ action:'track_ended' });
});

audio.addEventListener('pause', () => {
    stopProgressUpdates();
});

audio.addEventListener('play', () => {
    startProgressUpdates();
});

chrome.runtime.onMessage.addListener(msg=>{
    if(msg.target!=='offscreen') return;

    if(msg.action==='play'){
        if(audio.src !== msg.url){
            audio.pause();
            audio.src = msg.url;
        }
        audio.play().catch(()=>{});
    }
    else if(msg.action==='pause'){
        audio.pause();
    }
    else if(msg.action==='resume'){
        audio.play().catch(()=>{});
    }
    else if(msg.action==='seek'){
        audio.currentTime = msg.value;
    }
    else if(msg.action==='set_volume'){
        audio.volume = msg.value;
    }
    // Новый обработчик для запроса информации об аудио
    else if (msg.action === 'get_audio_info') {
        chrome.runtime.sendMessage({
            action: 'update_progress', // Переиспользуем update_progress
            currentTime: audio.currentTime,
            duration: audio.duration
        });
    }
});