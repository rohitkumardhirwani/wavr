/* ═══════════════════════════════════════════════════
   WAVR — Offline Music Player — app.js
   No database, no backend. Pure localStorage + Web Audio API.
═══════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────
const STATE = {
  songs:           {},          // id -> { id, name, artist, duration, dataUrl, cover }
  playlists:       {},          // id -> { id, name, songIds:[] }
  liked:           new Set(),   // set of song ids
  currentQueue:    [],          // ordered list of song ids for playback
  currentIndex:    -1,
  currentPlaylistId: null,
  shuffle:         false,
  loop:            'none',      // 'none' | 'one' | 'all'
  volume:          1,
  sleepTimerId:    null,
  sleepEnd:        null,
  sleepInterval:   null,
};

let audio = new Audio();
audio.preload = 'metadata';

// ─────────────────────────────────────────────────
//  LOCALSTORAGE PERSISTENCE
// ─────────────────────────────────────────────────
const LS = {
  save() {
    const serializable = {
      songs:     STATE.songs,
      playlists: STATE.playlists,
      liked:     [...STATE.liked],
      volume:    STATE.volume,
      shuffle:   STATE.shuffle,
      loop:      STATE.loop,
    };
    try { localStorage.setItem('wavr_state', JSON.stringify(serializable)); } catch(e) { console.warn('Storage quota exceeded'); }
  },
  load() {
    try {
      const raw = localStorage.getItem('wavr_state');
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.songs)     Object.assign(STATE.songs, data.songs);
      if (data.playlists) Object.assign(STATE.playlists, data.playlists);
      if (data.liked)     STATE.liked = new Set(data.liked);
      if (data.volume !== undefined) STATE.volume = data.volume;
      if (data.shuffle !== undefined) STATE.shuffle = data.shuffle;
      if (data.loop)      STATE.loop = data.loop;
    } catch(e) { console.warn('Load error', e); }
  }
};

// ─────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  LS.load();
  setGreeting();
  checkSharedPlaylist();
  renderAll();
  setupAudio();
  setupDrop();
  setupFileInput();
  setVolumeUI(STATE.volume);
  updateShuffleUI();
  updateLoopUI();

  // load QR lib
  const qrScript = document.createElement('script');
  qrScript.src = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js';
  document.head.appendChild(qrScript);
});

function setGreeting() {
  const h = new Date().getHours();
  const el = document.getElementById('greeting-time');
  if (!el) return;
  el.textContent = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
}

// ─────────────────────────────────────────────────
//  FILE UPLOAD
// ─────────────────────────────────────────────────
function setupFileInput() {
  document.getElementById('file-input').addEventListener('change', e => {
    processFiles([...e.target.files]);
    e.target.value = '';
  });
}

async function processFiles(files) {
  const audioFiles = files.filter(f => f.type.startsWith('audio/'));
  if (!audioFiles.length) { showToast('No audio files found'); return; }

  showToast(`Uploading ${audioFiles.length} song${audioFiles.length > 1 ? 's' : ''}…`);

  // Ensure "New Songs" playlist exists
  let newSongsPl = Object.values(STATE.playlists).find(p => p.name === 'New Songs');
  if (!newSongsPl) {
    newSongsPl = createPlaylistObj('New Songs');
  }

  let added = 0;
  for (const file of audioFiles) {
    const id = 'song_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const dataUrl = await readFileAsDataURL(file);
    const duration = await getAudioDuration(dataUrl);
    const { name, artist } = parseFilename(file.name);

    STATE.songs[id] = { id, name, artist, duration, dataUrl, cover: null };
    if (!newSongsPl.songIds.includes(id)) newSongsPl.songIds.push(id);
    added++;
  }

  LS.save();
  renderAll();
  showToast(`✓ Added ${added} song${added > 1 ? 's' : ''} to "New Songs"`);
}

function readFileAsDataURL(file) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
}

function getAudioDuration(dataUrl) {
  return new Promise(res => {
    const a = new Audio();
    a.src = dataUrl;
    a.onloadedmetadata = () => res(a.duration || 0);
    a.onerror = () => res(0);
  });
}

function parseFilename(filename) {
  const base = filename.replace(/\.[^/.]+$/, '');
  const parts = base.split(/[-–—]/).map(s => s.trim());
  if (parts.length >= 2) {
    return { artist: parts[0], name: parts.slice(1).join(' - ') };
  }
  return { name: base, artist: 'Unknown Artist' };
}

// ─────────────────────────────────────────────────
//  DRAG & DROP
// ─────────────────────────────────────────────────
function setupDrop() {
  const overlay = document.getElementById('drop-overlay');
  let dragCount = 0;
  document.addEventListener('dragenter', e => {
    e.preventDefault(); dragCount++;
    overlay.classList.add('active');
  });
  document.addEventListener('dragleave', () => {
    dragCount--;
    if (dragCount <= 0) { dragCount = 0; overlay.classList.remove('active'); }
  });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault(); dragCount = 0;
    overlay.classList.remove('active');
    processFiles([...e.dataTransfer.files]);
  });
}

// ─────────────────────────────────────────────────
//  PLAYLIST MANAGEMENT
// ─────────────────────────────────────────────────
function createPlaylistObj(name) {
  const id = 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const pl = { id, name, songIds: [] };
  STATE.playlists[id] = pl;
  LS.save();
  return pl;
}

function createNewPlaylist() {
  const name = prompt('Playlist name:', 'My Playlist');
  if (!name) return;
  createPlaylistObj(name.trim() || 'Untitled');
  renderAll();
  showToast(`✓ Created "${name}"`);
}

function deleteCurrentPlaylist() {
  const id = STATE.currentPlaylistId;
  if (!id || !STATE.playlists[id]) return;
  const name = STATE.playlists[id].name;
  if (!confirm(`Delete "${name}"?`)) return;
  delete STATE.playlists[id];
  STATE.currentPlaylistId = null;
  LS.save();
  renderAll();
  switchView('home');
  showToast(`Deleted "${name}"`);
}

function renameCurrentPlaylist(el) {
  const id = STATE.currentPlaylistId;
  if (!id || !STATE.playlists[id]) return;
  const newName = el.textContent.trim();
  if (!newName) { el.textContent = STATE.playlists[id].name; return; }
  STATE.playlists[id].name = newName;
  LS.save();
  renderSidebar();
  renderPlaylistGrid();
  showToast(`Renamed to "${newName}"`);
}

// ─────────────────────────────────────────────────
//  PLAYBACK
// ─────────────────────────────────────────────────
function setupAudio() {
  audio.volume = STATE.volume;
  audio.addEventListener('ended', onAudioEnded);
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('loadedmetadata', updateProgress);
  audio.addEventListener('play', () => {
    document.getElementById('play-pause-btn').textContent = '⏸';
  });
  audio.addEventListener('pause', () => {
    document.getElementById('play-pause-btn').textContent = '▶';
  });
}

function playSongById(songId, queue, index) {
  const song = STATE.songs[songId];
  if (!song) return;
  STATE.currentQueue = queue || [songId];
  STATE.currentIndex = index !== undefined ? index : 0;
  loadSong(song);
}

function loadSong(song) {
  audio.src = song.dataUrl;
  audio.volume = STATE.volume;
  audio.play().catch(e => console.warn('Play failed', e));
  updatePlayerUI(song);
  updateQueueUI();
  renderSongLists(); // highlight playing row
}

function updatePlayerUI(song) {
  document.getElementById('player-title').textContent = song.name;
  document.getElementById('player-artist').textContent = song.artist;
  document.getElementById('player-art').innerHTML = song.cover
    ? `<img src="${song.cover}" alt="cover"/>`
    : '♪';
  // like btn
  const likeBtn = document.getElementById('like-btn');
  likeBtn.textContent = STATE.liked.has(song.id) ? '♥' : '♡';
  likeBtn.classList.toggle('liked', STATE.liked.has(song.id));
}

function togglePlayPause() {
  if (STATE.currentQueue.length === 0) return;
  if (audio.paused) audio.play();
  else audio.pause();
}

function nextSong() {
  if (!STATE.currentQueue.length) return;
  if (STATE.loop === 'one') { audio.currentTime = 0; audio.play(); return; }

  let nextIdx;
  if (STATE.shuffle) {
    nextIdx = Math.floor(Math.random() * STATE.currentQueue.length);
  } else {
    nextIdx = STATE.currentIndex + 1;
    if (nextIdx >= STATE.currentQueue.length) {
      if (STATE.loop === 'all') nextIdx = 0;
      else { audio.pause(); return; }
    }
  }
  STATE.currentIndex = nextIdx;
  loadSong(STATE.songs[STATE.currentQueue[nextIdx]]);
}

function prevSong() {
  if (!STATE.currentQueue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  let prevIdx = STATE.currentIndex - 1;
  if (prevIdx < 0) prevIdx = STATE.loop === 'all' ? STATE.currentQueue.length - 1 : 0;
  STATE.currentIndex = prevIdx;
  loadSong(STATE.songs[STATE.currentQueue[prevIdx]]);
}

function onAudioEnded() {
  if (STATE.loop === 'one') { audio.currentTime = 0; audio.play(); return; }
  nextSong();
}

function seekTo(e) {
  const bar = document.getElementById('progress-bar');
  const rect = bar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audio.currentTime = ratio * audio.duration;
}

function updateProgress() {
  if (!audio.duration) return;
  const ratio = audio.currentTime / audio.duration;
  document.getElementById('progress-fill').style.width = (ratio * 100) + '%';
  document.getElementById('progress-thumb').style.left  = (ratio * 100) + '%';
  document.getElementById('time-current').textContent = formatTime(audio.currentTime);
  document.getElementById('time-total').textContent   = formatTime(audio.duration);
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function setVolume(v) {
  STATE.volume = parseFloat(v);
  audio.volume = STATE.volume;
  LS.save();
}
function setVolumeUI(v) {
  document.getElementById('volume-slider').value = v;
  audio.volume = v;
}

// Shuffle
function toggleShuffle() {
  STATE.shuffle = !STATE.shuffle;
  LS.save();
  updateShuffleUI();
  showToast(STATE.shuffle ? 'Shuffle on' : 'Shuffle off');
}
function updateShuffleUI() {
  document.getElementById('shuffle-btn-ctrl').classList.toggle('active', STATE.shuffle);
}

// Loop
function toggleLoop() {
  const modes = ['none', 'one', 'all'];
  const idx = modes.indexOf(STATE.loop);
  STATE.loop = modes[(idx + 1) % modes.length];
  LS.save();
  updateLoopUI();
  const labels = { none: 'Loop off', one: 'Loop song', all: 'Loop all' };
  showToast(labels[STATE.loop]);
}
function updateLoopUI() {
  const btn = document.getElementById('loop-btn-ctrl');
  btn.classList.toggle('active', STATE.loop !== 'none');
  btn.textContent = STATE.loop === 'one' ? '↺¹' : '↺';
}

// Like
function toggleLikeCurrent() {
  const songId = STATE.currentQueue[STATE.currentIndex];
  if (!songId) return;
  if (STATE.liked.has(songId)) {
    STATE.liked.delete(songId);
    document.getElementById('like-btn').textContent = '♡';
    document.getElementById('like-btn').classList.remove('liked');
    showToast('Removed from Liked Songs');
  } else {
    STATE.liked.add(songId);
    document.getElementById('like-btn').textContent = '♥';
    document.getElementById('like-btn').classList.add('liked');
    showToast('Added to Liked Songs ♥');
  }
  LS.save();
  renderSongLists();
}

function toggleLikeSong(songId) {
  if (STATE.liked.has(songId)) {
    STATE.liked.delete(songId);
    showToast('Removed from Liked Songs');
  } else {
    STATE.liked.add(songId);
    showToast('Added to Liked Songs ♥');
  }
  // sync player like btn
  const curId = STATE.currentQueue[STATE.currentIndex];
  if (curId === songId) {
    const likeBtn = document.getElementById('like-btn');
    likeBtn.textContent = STATE.liked.has(songId) ? '♥' : '♡';
    likeBtn.classList.toggle('liked', STATE.liked.has(songId));
  }
  LS.save();
  renderSongLists();
}

// ─────────────────────────────────────────────────
//  PLAYLIST PLAY
// ─────────────────────────────────────────────────
function playPlaylist(plId) {
  const ids = plId === 'liked'
    ? [...STATE.liked].filter(id => STATE.songs[id])
    : (STATE.playlists[plId]?.songIds || []).filter(id => STATE.songs[id]);
  if (!ids.length) { showToast('No songs to play'); return; }
  STATE.currentPlaylistId = plId;
  const idx = 0;
  playSongById(ids[idx], ids, idx);
}

function shufflePlaylist(plId) {
  const ids = plId === 'liked'
    ? [...STATE.liked].filter(id => STATE.songs[id])
    : (STATE.playlists[plId]?.songIds || []).filter(id => STATE.songs[id]);
  if (!ids.length) { showToast('No songs to play'); return; }
  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  STATE.currentPlaylistId = plId;
  playSongById(shuffled[0], shuffled, 0);
}

function playCurrentPlaylist() {
  if (STATE.currentPlaylistId) playPlaylist(STATE.currentPlaylistId);
}
function shuffleCurrentPlaylist() {
  if (STATE.currentPlaylistId) shufflePlaylist(STATE.currentPlaylistId);
}

// ─────────────────────────────────────────────────
//  VIEWS
// ─────────────────────────────────────────────────
let activeView = 'home';

function switchView(view, plId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.playlist-nav-item').forEach(b => b.classList.remove('active'));

  const viewEl = document.getElementById('view-' + view);
  if (viewEl) viewEl.classList.add('active');
  activeView = view;

  const navBtn = document.querySelector(`.nav-btn[data-view="${view}"]`);
  if (navBtn) navBtn.classList.add('active');

  // Show/hide search bar
  document.getElementById('search-bar-wrap').style.display = view === 'search' ? 'flex' : 'none';

  if (view === 'playlist' && plId) {
    STATE.currentPlaylistId = plId;
    renderPlaylistView(plId);
    document.querySelectorAll('.playlist-nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.plid === plId);
    });
  }
  if (view === 'liked') {
    renderLikedView();
  }
  if (view === 'search') {
    document.getElementById('search-input').focus();
    doSearch('');
  }
}

// ─────────────────────────────────────────────────
//  RENDER ALL
// ─────────────────────────────────────────────────
function renderAll() {
  renderSidebar();
  renderHome();
  if (activeView === 'playlist' && STATE.currentPlaylistId)
    renderPlaylistView(STATE.currentPlaylistId);
  if (activeView === 'liked') renderLikedView();
}

function renderSidebar() {
  const list = document.getElementById('playlist-nav-list');
  list.innerHTML = '';
  Object.values(STATE.playlists).forEach(pl => {
    const div = document.createElement('div');
    div.className = 'playlist-nav-item';
    div.dataset.plid = pl.id;
    if (activeView === 'playlist' && STATE.currentPlaylistId === pl.id) div.classList.add('active');
    div.innerHTML = `<span class="playlist-nav-dot"></span><span>${escHtml(pl.name)}</span>`;
    div.onclick = () => switchView('playlist', pl.id);
    list.appendChild(div);
  });
}

function renderHome() {
  renderQuickPicks();
  renderPlaylistGrid();
  renderRecentSongs();
}

function renderQuickPicks() {
  const container = document.getElementById('quick-picks-grid');
  const allSongs = Object.values(STATE.songs);
  if (!allSongs.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">♫</div><div class="empty-title">No songs yet</div><div class="empty-sub">Upload audio files to get started</div></div>`;
    return;
  }
  const picks = [...allSongs].slice(-8).reverse();
  container.innerHTML = picks.map(s => `
    <div class="quick-card" onclick="playSongById('${s.id}', ${JSON.stringify([s.id])}, 0)">
      <div class="quick-card-art">${s.cover ? `<img src="${s.cover}" alt="cover"/>` : '♪'}</div>
      <div class="quick-card-info">
        <div class="quick-card-name">${escHtml(s.name)}</div>
        <div class="quick-card-meta">${escHtml(s.artist)}</div>
      </div>
    </div>
  `).join('');
}

function renderPlaylistGrid() {
  const container = document.getElementById('playlists-grid');
  const pls = Object.values(STATE.playlists);
  if (!pls.length) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">⊞</div><div class="empty-title">No playlists</div><div class="empty-sub">Create one or upload songs</div></div>`;
    return;
  }
  container.innerHTML = pls.map(pl => {
    const count = pl.songIds.filter(id => STATE.songs[id]).length;
    const previewSongs = pl.songIds.slice(0, 4).map(id => STATE.songs[id]).filter(Boolean);
    const coverHtml = previewSongs.length >= 2
      ? `<div class="pl-card-cover-inner">${previewSongs.slice(0,4).map(s => `<span>${s.cover ? `<img src="${s.cover}" style="width:100%;height:100%;object-fit:cover"/>` : '♪'}</span>`).join('')}</div>`
      : '♪';
    return `
      <div class="pl-card" onclick="switchView('playlist','${pl.id}')">
        <div class="pl-card-cover">${coverHtml}</div>
        <div class="pl-card-name">${escHtml(pl.name)}</div>
        <div class="pl-card-meta">${count} song${count !== 1 ? 's' : ''}</div>
        <button class="pl-card-play" onclick="event.stopPropagation(); playPlaylist('${pl.id}')">▶</button>
      </div>`;
  }).join('');
}

function renderRecentSongs() {
  const container = document.getElementById('recent-songs-list');
  const songs = Object.values(STATE.songs).slice(-20).reverse();
  renderSongListInto(container, songs, songs.map(s => s.id), null, true);
}

function renderSongLists() {
  // re-render the currently visible song list
  if (activeView === 'home')     renderRecentSongs();
  if (activeView === 'liked')    renderLikedView();
  if (activeView === 'playlist' && STATE.currentPlaylistId)
    renderPlaylistView(STATE.currentPlaylistId);
  if (activeView === 'search')   doSearch(document.getElementById('search-input').value);
  updateQueueUI();
}

function renderPlaylistView(plId) {
  const pl = STATE.playlists[plId];
  if (!pl) return;
  const validIds = pl.songIds.filter(id => STATE.songs[id]);
  const songs = validIds.map(id => STATE.songs[id]);
  document.getElementById('pl-view-name').textContent = pl.name;
  document.getElementById('pl-view-count').textContent = `${songs.length} song${songs.length !== 1 ? 's' : ''}`;
  document.getElementById('pl-view-cover').innerHTML = songs.length
    ? (songs.length >= 2
      ? `<div class="pl-card-cover-inner">${songs.slice(0,4).map(s=>`<span>${s.cover?`<img src="${s.cover}" style="width:100%;height:100%;object-fit:cover"/>`:'♪'}</span>`).join('')}</div>`
      : '♪')
    : '♪';
  const container = document.getElementById('pl-view-songs');
  renderSongListInto(container, songs, validIds, plId, false);
}

function renderLikedView() {
  const ids = [...STATE.liked].filter(id => STATE.songs[id]);
  const songs = ids.map(id => STATE.songs[id]);
  document.getElementById('liked-count').textContent = `${songs.length} song${songs.length !== 1 ? 's' : ''}`;
  const container = document.getElementById('liked-songs-list');
  renderSongListInto(container, songs, ids, 'liked', false);
}

function renderSongListInto(container, songs, queueIds, plId, showNum) {
  if (!songs.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">♫</div><div class="empty-title">No songs here</div><div class="empty-sub">Upload or add songs to this playlist</div></div>`;
    return;
  }
  const curSongId = STATE.currentQueue[STATE.currentIndex];
  container.innerHTML = songs.map((song, i) => {
    const isPlaying = song.id === curSongId && audio && !audio.paused;
    const isLiked = STATE.liked.has(song.id);
    const num = showNum
      ? (isPlaying ? `<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>` : (i + 1))
      : (isPlaying ? `<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>` : (i + 1));
    return `
      <div class="song-row${song.id === curSongId ? ' playing' : ''}" ondblclick="playSongById('${song.id}',${JSON.stringify(queueIds)},${i})">
        <div class="song-num">${num}</div>
        <div class="song-art-thumb">${song.cover ? `<img src="${song.cover}" alt="cover"/>` : '♪'}</div>
        <div class="song-info">
          <div class="song-title-row">${escHtml(song.name)}</div>
          <div class="song-artist-row">${escHtml(song.artist)}</div>
        </div>
        <div class="song-duration">${formatTime(song.duration)}</div>
        <button class="song-like-btn${isLiked ? ' liked' : ''}" onclick="event.stopPropagation(); toggleLikeSong('${song.id}')">${isLiked ? '♥' : '♡'}</button>
        <button class="song-menu-btn" onclick="event.stopPropagation(); openSongMenu('${song.id}','${plId || ''}')">⋮</button>
      </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────
//  SONG CONTEXT MENU
// ─────────────────────────────────────────────────
function openSongMenu(songId, plId) {
  const plOptions = Object.values(STATE.playlists)
    .filter(p => p.id !== plId)
    .map(p => `<button onclick="addSongToPlaylist('${songId}','${p.id}')">Add to "${escHtml(p.name)}"</button>`)
    .join('');

  const removeOpt = plId && plId !== 'liked' && STATE.playlists[plId]
    ? `<button onclick="removeSongFromPlaylist('${songId}','${plId}')">Remove from playlist</button>` : '';

  const menu = document.createElement('div');
  menu.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    background:var(--bg-surface);border:1px solid var(--border);border-radius:14px;
    padding:12px;z-index:600;min-width:220px;display:flex;flex-direction:column;gap:4px;
    animation:modalIn 0.2s ease;
  `;
  menu.innerHTML = `
    <div style="font-family:var(--font-display);font-size:15px;font-weight:700;padding:4px 10px 10px;border-bottom:1px solid var(--border);margin-bottom:4px">Song Options</div>
    <button onclick="playSongById('${songId}',[('${songId}')],0)">▶ Play now</button>
    ${plOptions}
    ${removeOpt}
    <button onclick="deleteSong('${songId}','${plId}')">✕ Delete song</button>
  `;
  menu.querySelectorAll('button').forEach(b => {
    b.style.cssText = 'text-align:left;padding:10px 14px;border:none;background:transparent;color:var(--text-primary);font-family:var(--font-body);font-size:13px;cursor:pointer;border-radius:8px;width:100%;transition:background 0.15s;';
    b.onmouseover = () => b.style.background = 'var(--bg-hover)';
    b.onmouseout  = () => b.style.background = 'transparent';
  });
  const backdrop = document.createElement('div');
  backdrop.style.cssText = 'position:fixed;inset:0;z-index:599;';
  backdrop.onclick = () => { menu.remove(); backdrop.remove(); };
  document.body.appendChild(backdrop);
  document.body.appendChild(menu);
}

function addSongToPlaylist(songId, plId) {
  closeAllMenus();
  if (!STATE.playlists[plId]) return;
  if (STATE.playlists[plId].songIds.includes(songId)) { showToast('Already in playlist'); return; }
  STATE.playlists[plId].songIds.push(songId);
  LS.save();
  showToast(`Added to "${STATE.playlists[plId].name}"`);
}

function removeSongFromPlaylist(songId, plId) {
  closeAllMenus();
  if (!STATE.playlists[plId]) return;
  STATE.playlists[plId].songIds = STATE.playlists[plId].songIds.filter(id => id !== songId);
  LS.save();
  renderAll();
  showToast('Removed from playlist');
}

function deleteSong(songId, plId) {
  closeAllMenus();
  if (!confirm('Delete this song permanently?')) return;
  // Remove from all playlists
  Object.values(STATE.playlists).forEach(pl => {
    pl.songIds = pl.songIds.filter(id => id !== songId);
  });
  STATE.liked.delete(songId);
  delete STATE.songs[songId];
  // Stop if playing
  if (STATE.currentQueue[STATE.currentIndex] === songId) {
    audio.pause();
    audio.src = '';
    STATE.currentQueue = [];
    STATE.currentIndex = -1;
    document.getElementById('player-title').textContent = 'No song playing';
    document.getElementById('player-artist').textContent = '—';
  }
  LS.save();
  renderAll();
  showToast('Song deleted');
}

function closeAllMenus() {
  document.querySelectorAll('[style*="translate(-50%,-50%)"]').forEach(m => m.remove());
  // remove backdrops
  const bds = document.querySelectorAll('div[style*="position:fixed;inset:0;z-index:599"]');
  bds.forEach(b => b.remove());
}

// ─────────────────────────────────────────────────
//  SEARCH
// ─────────────────────────────────────────────────
function doSearch(query) {
  const q = query.toLowerCase().trim();
  const container = document.getElementById('search-results');
  if (!q) {
    const all = Object.values(STATE.songs);
    renderSongListInto(container, all, all.map(s=>s.id), null, true);
    return;
  }
  const results = Object.values(STATE.songs).filter(s =>
    s.name.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)
  );
  renderSongListInto(container, results, results.map(s=>s.id), null, true);
}

// ─────────────────────────────────────────────────
//  QUEUE PANEL
// ─────────────────────────────────────────────────
function toggleQueue() {
  document.getElementById('queue-panel').classList.toggle('open');
  document.getElementById('queue-btn').classList.toggle('active', document.getElementById('queue-panel').classList.contains('open'));
  updateQueueUI();
}

function updateQueueUI() {
  const list = document.getElementById('queue-list');
  if (!STATE.currentQueue.length) {
    list.innerHTML = '<div class="empty-state" style="padding:30px 20px"><div class="empty-icon" style="font-size:32px">≡</div><div class="empty-title" style="font-size:14px">Queue is empty</div></div>';
    return;
  }
  list.innerHTML = STATE.currentQueue.map((id, i) => {
    const song = STATE.songs[id];
    if (!song) return '';
    const isPlaying = i === STATE.currentIndex;
    return `
      <div class="queue-item${isPlaying ? ' playing' : ''}" onclick="STATE.currentIndex=${i}; loadSong(STATE.songs['${id}'])">
        <div class="queue-item-art">${isPlaying ? '<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>' : '♪'}</div>
        <div class="queue-item-info">
          <div class="queue-item-title">${escHtml(song.name)}</div>
          <div class="queue-item-artist">${escHtml(song.artist)}</div>
        </div>
      </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────
//  SLEEP TIMER
// ─────────────────────────────────────────────────
function openSleepTimer() {
  document.getElementById('sleep-modal').classList.add('open');
  updateSleepStatus();
}

function closeSleepTimer(e) {
  if (e.target === document.getElementById('sleep-modal') || e === true) {
    document.getElementById('sleep-modal').classList.remove('open');
  }
}

function setSleepTimer(minutes) {
  clearSleepTimerInternal();
  STATE.sleepEnd = Date.now() + minutes * 60 * 1000;
  STATE.sleepTimerId = setTimeout(() => {
    audio.pause();
    showToast('Sleep timer: Music stopped 😴');
    STATE.sleepEnd = null;
  }, minutes * 60 * 1000);
  STATE.sleepInterval = setInterval(updateSleepStatus, 1000);
  showToast(`Sleep timer set for ${minutes} min`);
  document.querySelectorAll('.timer-options button').forEach(b => {
    b.classList.toggle('selected', b.textContent === minutes + ' min');
  });
  updateSleepStatus();
}

function setSleepTimerCustom() {
  const v = parseInt(document.getElementById('custom-timer-input').value);
  if (!v || v < 1) { showToast('Enter a valid number'); return; }
  setSleepTimer(v);
}

function cancelSleepTimer() {
  clearSleepTimerInternal();
  STATE.sleepEnd = null;
  updateSleepStatus();
  showToast('Sleep timer cancelled');
}

function clearSleepTimerInternal() {
  if (STATE.sleepTimerId) { clearTimeout(STATE.sleepTimerId); STATE.sleepTimerId = null; }
  if (STATE.sleepInterval) { clearInterval(STATE.sleepInterval); STATE.sleepInterval = null; }
  document.querySelectorAll('.timer-options button').forEach(b => b.classList.remove('selected'));
}

function updateSleepStatus() {
  const el = document.getElementById('sleep-timer-status');
  if (!STATE.sleepEnd) { el.textContent = ''; return; }
  const remaining = Math.max(0, STATE.sleepEnd - Date.now());
  const m = Math.floor(remaining / 60000);
  const s = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
  el.textContent = `⏱ Stops in ${m}:${s}`;
}

// ─────────────────────────────────────────────────
//  SHARE / QR
// ─────────────────────────────────────────────────
function openShareModal() {
  const plId = STATE.currentPlaylistId;
  const pl = plId && STATE.playlists[plId] ? STATE.playlists[plId] : null;

  // Build share data: playlist name + song names (no audio data — too large)
  const shareData = {
    version: 1,
    playlist: pl ? { name: pl.name, songs: pl.songIds.map(id => STATE.songs[id]).filter(Boolean).map(s => ({ name: s.name, artist: s.artist })) } : null,
  };

  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(shareData))));
  const url = `${location.origin}${location.pathname}?wavr=${encoded}`;

  document.getElementById('share-link-input').value = url;

  // QR code
  const wrap = document.getElementById('qr-code-wrap');
  wrap.innerHTML = '';
  if (window.QRCode) {
    new QRCode(wrap, { text: url, width: 180, height: 180, colorDark: '#b8ff57', colorLight: '#111116' });
  } else {
    wrap.innerHTML = `<div style="width:180px;height:180px;background:var(--bg-card);border-radius:12px;display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:12px;text-align:center;padding:12px">QR library loading…<br>Copy the link below</div>`;
    // retry after lib loads
    setTimeout(() => {
      if (window.QRCode) {
        wrap.innerHTML = '';
        new QRCode(wrap, { text: url, width: 180, height: 180, colorDark: '#b8ff57', colorLight: '#111116' });
      }
    }, 1200);
  }

  document.getElementById('share-modal').classList.add('open');
}

function closeShareModal(e) {
  if (e.target === document.getElementById('share-modal')) {
    document.getElementById('share-modal').classList.remove('open');
  }
}

function copyShareLink() {
  const val = document.getElementById('share-link-input').value;
  navigator.clipboard.writeText(val).then(() => showToast('Link copied!')).catch(() => {
    document.getElementById('share-link-input').select();
    document.execCommand('copy');
    showToast('Link copied!');
  });
}

// On page load, check for shared playlist in URL
function checkSharedPlaylist() {
  const params = new URLSearchParams(location.search);
  const wavr = params.get('wavr');
  if (!wavr) return;
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(wavr))));
    if (data.playlist) {
      const { name, songs } = data.playlist;
      // Create playlist with song stubs (no audio data — user must upload)
      const existing = Object.values(STATE.playlists).find(p => p.name === name);
      if (!existing) {
        const pl = createPlaylistObj(name + ' (Shared)');
        // Add stub metadata display
        showToast(`📥 Shared playlist "${name}" imported! Upload the same songs to hear them.`);
      } else {
        showToast(`Playlist "${name}" already exists`);
      }
    }
    // Clean URL
    history.replaceState(null, '', location.pathname);
  } catch(e) { console.warn('Invalid share link', e); }
}

// ─────────────────────────────────────────────────
//  BACKGROUND / SERVICE WORKER hint
// ─────────────────────────────────────────────────
// The Web Audio API continues playing when the tab is in background.
// No extra code needed — browser handles this natively for <audio> elements.
// For true background on mobile, we set mediaSession API metadata:
audio.addEventListener('play', updateMediaSession);

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const song = STATE.songs[STATE.currentQueue[STATE.currentIndex]];
  if (!song) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title:  song.name,
    artist: song.artist,
    album:  'WAVR',
  });
  navigator.mediaSession.setActionHandler('play',          () => audio.play());
  navigator.mediaSession.setActionHandler('pause',         () => audio.pause());
  navigator.mediaSession.setActionHandler('nexttrack',     () => nextSong());
  navigator.mediaSession.setActionHandler('previoustrack', () => prevSong());
}

// ─────────────────────────────────────────────────
//  TOAST
// ─────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ─────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
