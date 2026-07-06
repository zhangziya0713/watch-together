// ============ 基础状态 ============
const socket = io();

let myName = '';
let myId = null;
let currentRoom = null;
let hostId = null;
let isHost = false;

let ytPlayer = null;
let ytReady = false;
let fileVideoEl = null;
let currentVideo = null; // { sourceType: 'youtube'|'file', src }
let applyingRemoteAction = false;
let expectedTime = 0;
let pollTimer = null;
let pendingLoadAfterYTReady = null;

let localStream = null;
let micOn = false;
const peers = new Map(); // socketId -> RTCPeerConnection

const ICE_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

// ============ DOM ============
const joinScreen = document.getElementById('join-screen');
const roomScreen = document.getElementById('room-screen');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const enterBtn = document.getElementById('enter-btn');
const joinHint = document.getElementById('join-hint');

const roomCodeDisplay = document.getElementById('room-code-display');
const copyLinkBtn = document.getElementById('copy-link-btn');
const micToggleBtn = document.getElementById('mic-toggle');

const hostControls = document.getElementById('host-controls');
const ytUrlInput = document.getElementById('yt-url-input');
const ytLoadBtn = document.getElementById('yt-load-btn');
const directUrlInput = document.getElementById('direct-url-input');
const directLoadBtn = document.getElementById('direct-load-btn');
const uploadInput = document.getElementById('upload-input');
const uploadBtn = document.getElementById('upload-btn');
const uploadStatus = document.getElementById('upload-status');

const playerMount = document.getElementById('player-mount');
const playerPlaceholder = document.getElementById('player-placeholder');
const placeholderText = document.getElementById('placeholder-text');

const participantList = document.getElementById('participant-list');
const participantCount = document.getElementById('participant-count');
const chatLog = document.getElementById('chat-log');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');

const audioSinks = document.getElementById('audio-sinks');

const logoutBtn = document.getElementById('logout-btn');
const openLibraryBtn = document.getElementById('open-library-btn');
const libraryModal = document.getElementById('library-modal');
const closeLibraryBtn = document.getElementById('close-library-btn');
const libraryModalGrid = document.getElementById('library-modal-grid');

// ============ 入场逻辑 ============
function randomRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

const hashMatch = location.hash.match(/room=([A-Za-z0-9]+)/);
if (hashMatch) roomInput.value = hashMatch[1];

enterBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) { joinHint.textContent = '请先输入你的名字'; return; }
  const roomId = (roomInput.value.trim() || randomRoomCode()).toUpperCase();
  myName = name;
  currentRoom = roomId;
  socket.emit('join-room', { roomId, name });

  joinScreen.style.display = 'none';
  roomScreen.style.display = 'flex';
  roomCodeDisplay.textContent = roomId;
  history.replaceState(null, '', `#room=${roomId}`);
});

copyLinkBtn.addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}#room=${currentRoom}`;
  try {
    await navigator.clipboard.writeText(link);
    copyLinkBtn.textContent = '已复制!';
    setTimeout(() => (copyLinkBtn.textContent = '复制邀请链接'), 1500);
  } catch (e) {
    prompt('复制这个链接发给朋友:', link);
  }
});

// ============ 房主 / 参与者状态 ============
function updateHostUI() {
  hostControls.style.display = isHost ? 'flex' : 'none';
  if (!currentVideo) {
    placeholderText.textContent = isHost ? '在上面选一个视频源开始播放' : '等待房主选择视频...';
  }
}

socket.on('connect', () => { myId = socket.id; });

socket.on('room-users', ({ users, hostId: newHostId }) => {
  hostId = newHostId;
  isHost = myId === hostId;
  renderParticipants(users.filter((u) => u.id !== myId));
  updateHostUI();
});

socket.on('host-changed', ({ hostId: newHostId }) => {
  hostId = newHostId;
  const wasHost = isHost;
  isHost = myId === hostId;
  updateHostUI();
  if (isHost && !wasHost) {
    addSystemMessage('原房主已离开,你现在是新房主了');
    // 重新挂载播放器以获得可控的控制条
    if (currentVideo) mountPlayer(currentVideo.sourceType, currentVideo.src);
  } else if (!isHost && wasHost) {
    if (currentVideo) mountPlayer(currentVideo.sourceType, currentVideo.src);
  }
});

function renderParticipants(others) {
  participantList.innerHTML = '';
  const all = [{ id: myId, name: myName + '(我)' }, ...others];
  participantCount.textContent = `(${all.length})`;
  all.forEach((u) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'mic-dot' + (u.id === myId && micOn ? ' on' : '');
    dot.dataset.uid = u.id;
    li.appendChild(dot);
    const span = document.createElement('span');
    span.textContent = u.name;
    li.appendChild(span);
    if (u.id === hostId) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = '👑';
      badge.title = '房主';
      li.appendChild(badge);
    }
    participantList.appendChild(li);
  });
}

socket.on('user-joined', ({ name }) => {
  addSystemMessage(`${name} 加入了放映厅`);
});

socket.on('user-left', ({ id, name }) => {
  if (peers.has(id)) {
    peers.get(id).close();
    peers.delete(id);
  }
  const audioEl = document.getElementById(`audio-${id}`);
  if (audioEl) audioEl.remove();
  if (name) addSystemMessage(`${name} 离开了放映厅`);
});

// ============ 聊天 ============
function addChatMessage(name, text, isSystem = false) {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (isSystem ? ' system' : '');
  if (!isSystem) {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = name + '：';
    div.appendChild(who);
    div.appendChild(document.createTextNode(text));
  } else {
    div.textContent = text;
  }
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}
function addSystemMessage(text) { addChatMessage(null, text, true); }

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text, name: myName });
  chatInput.value = '';
}
chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

socket.on('chat-message', ({ name, text, id }) => {
  addChatMessage(id === myId ? myName + '(我)' : name, text);
});

// ============ 视频源加载(仅房主可触发) ============
function extractYouTubeId(input) {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/,
    /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}

function hostLoadVideo(sourceType, src) {
  if (!isHost) return;
  currentVideo = { sourceType, src };
  mountPlayer(sourceType, src);
  socket.emit('video-action', { type: 'load', sourceType, src });
}

ytLoadBtn.addEventListener('click', () => {
  const url = ytUrlInput.value.trim();
  if (!url) return;
  const id = extractYouTubeId(url);
  if (!id) { addSystemMessage('没能识别这个 YouTube 链接,检查一下格式?'); return; }
  hostLoadVideo('youtube', id);
});

directLoadBtn.addEventListener('click', () => {
  const url = directUrlInput.value.trim();
  if (!url) return;
  hostLoadVideo('file', url);
});

uploadBtn.addEventListener('click', () => {
  const file = uploadInput.files[0];
  if (!file) { uploadStatus.textContent = '先选一个视频文件'; return; }
  const form = new FormData();
  form.append('video', file);
  form.append('socketId', myId);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/upload/${encodeURIComponent(currentRoom)}`);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      uploadStatus.textContent = `上传中... ${pct}%`;
    }
  };
  xhr.onload = () => {
    if (xhr.status === 200) {
      const res = JSON.parse(xhr.responseText);
      uploadStatus.textContent = '上传完成,开始播放';
      hostLoadVideo('file', res.url);
    } else {
      uploadStatus.textContent = '上传失败:' + (JSON.parse(xhr.responseText || '{}').error || xhr.status);
    }
  };
  xhr.onerror = () => { uploadStatus.textContent = '上传失败,请检查网络'; };
  uploadStatus.textContent = '开始上传...';
  xhr.send(form);
});

// ============ 播放器挂载(统一处理 YouTube / 文件两种类型) ============
function clearPlayerMount() {
  if (ytPlayer) {
    try { ytPlayer.destroy(); } catch (e) {}
    ytPlayer = null;
  }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  fileVideoEl = null;
  playerMount.innerHTML = '';
}

function mountPlayer(sourceType, src) {
  playerPlaceholder.style.display = 'none';
  clearPlayerMount();

  if (sourceType === 'youtube') {
    const div = document.createElement('div');
    div.id = 'yt-target-' + Date.now();
    playerMount.appendChild(div);
    const build = () => {
      ytPlayer = new YT.Player(div.id, {
        videoId: src,
        playerVars: { playsinline: 1, rel: 0, controls: isHost ? 1 : 0, disablekb: isHost ? 0 : 1 },
        events: {
          onReady: () => startYTPolling(),
          onStateChange: onYTStateChange,
        },
      });
    };
    if (ytReady) build(); else pendingLoadAfterYTReady = build;
  } else if (sourceType === 'file') {
    const video = document.createElement('video');
    video.src = src;
    video.controls = isHost;
    video.autoplay = false;
    video.playsInline = true;
    playerMount.appendChild(video);
    fileVideoEl = video;
    attachFileVideoEvents(video);
  }
}

function onYouTubeIframeAPIReady() {
  ytReady = true;
  if (pendingLoadAfterYTReady) { pendingLoadAfterYTReady(); pendingLoadAfterYTReady = null; }
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function onYTStateChange(e) {
  if (!isHost || applyingRemoteAction || !ytPlayer) return;
  const time = ytPlayer.getCurrentTime();
  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit('video-action', { type: 'play', time });
  } else if (e.data === YT.PlayerState.PAUSED) {
    socket.emit('video-action', { type: 'pause', time });
  }
}

function startYTPolling() {
  if (pollTimer) clearInterval(pollTimer);
  expectedTime = ytPlayer.getCurrentTime();
  pollTimer = setInterval(() => {
    if (!isHost || !ytPlayer || applyingRemoteAction) return;
    const state = ytPlayer.getPlayerState();
    const time = ytPlayer.getCurrentTime();
    if (state === YT.PlayerState.PLAYING) {
      const diff = time - expectedTime;
      if (Math.abs(diff) > 1.5) socket.emit('video-action', { type: 'seek', time });
      expectedTime = time + 1;
    } else {
      expectedTime = time;
    }
  }, 1000);
}

function attachFileVideoEvents(video) {
  video.addEventListener('play', () => {
    if (!isHost || applyingRemoteAction) return;
    socket.emit('video-action', { type: 'play', time: video.currentTime });
  });
  video.addEventListener('pause', () => {
    if (!isHost || applyingRemoteAction) return;
    socket.emit('video-action', { type: 'pause', time: video.currentTime });
  });
  video.addEventListener('seeked', () => {
    if (!isHost || applyingRemoteAction) return;
    socket.emit('video-action', { type: 'seek', time: video.currentTime });
  });
}

// 接收房主广播的播放动作(其他人 + 中途加入的人)
socket.on('video-action', (action) => {
  if (action.type === 'load') {
    currentVideo = { sourceType: action.sourceType, src: action.src };
    playerPlaceholder.style.display = 'none';
    mountPlayer(action.sourceType, action.src);
    return;
  }

  applyingRemoteAction = true;
  if (currentVideo?.sourceType === 'youtube' && ytPlayer) {
    if (action.type === 'play') { ytPlayer.seekTo(action.time, true); ytPlayer.playVideo(); }
    else if (action.type === 'pause') { ytPlayer.seekTo(action.time, true); ytPlayer.pauseVideo(); }
    else if (action.type === 'seek') { ytPlayer.seekTo(action.time, true); }
  } else if (currentVideo?.sourceType === 'file' && fileVideoEl) {
    if (action.type === 'play') { fileVideoEl.currentTime = action.time; fileVideoEl.play(); }
    else if (action.type === 'pause') { fileVideoEl.currentTime = action.time; fileVideoEl.pause(); }
    else if (action.type === 'seek') { fileVideoEl.currentTime = action.time; }
  }
  setTimeout(() => { applyingRemoteAction = false; }, 700);
});

// ============ 语音聊天(WebRTC 网状连接) ============
async function ensureLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return localStream;
}

function createPeerConnection(remoteId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers.set(remoteId, pc);

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: remoteId, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    let audioEl = document.getElementById(`audio-${remoteId}`);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `audio-${remoteId}`;
      audioEl.autoplay = true;
      audioSinks.appendChild(audioEl);
    }
    audioEl.srcObject = e.streams[0];
  };

  return pc;
}

async function callPeer(remoteId) {
  const pc = createPeerConnection(remoteId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: remoteId, data: { sdp: offer } });
}

socket.on('existing-users', async (users) => {
  window.__existingUsers = users;
  if (micOn) {
    for (const u of users) await callPeer(u.id);
  }
});

socket.on('signal', async ({ from, data }) => {
  let pc = peers.get(from);
  if (data.sdp) {
    if (data.sdp.type === 'offer') {
      if (!pc) {
        await ensureLocalStream().catch(() => {});
        pc = createPeerConnection(from);
      }
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: answer } });
    } else if (data.sdp.type === 'answer') {
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    }
  } else if (data.candidate && pc) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
  }
});

// ============ 退出登录 ============
logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
});

// ============ 片库选择(仅房主能加载,但按钮本身在房主控制区里,普通观众看不到) ============
async function openLibrary() {
  libraryModal.style.display = 'flex';
  libraryModalGrid.innerHTML = '<p class="hint" style="color:var(--text-muted)">加载中...</p>';
  try {
    const res = await fetch('/api/library');
    const list = await res.json();
    if (list.length === 0) {
      libraryModalGrid.innerHTML = '<p class="hint" style="color:var(--text-muted)">片库还是空的,去管理后台传几个视频吧</p>';
      return;
    }
    libraryModalGrid.innerHTML = '';
    list.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'library-card';
      card.innerHTML = `
        <div class="poster">${item.posterUrl ? `<img src="${item.posterUrl}" alt="">` : '🎬'}</div>
        <div class="library-card-title">${item.title}</div>
      `;
      card.addEventListener('click', () => {
        hostLoadVideo('file', item.videoUrl);
        libraryModal.style.display = 'none';
      });
      libraryModalGrid.appendChild(card);
    });
  } catch (e) {
    libraryModalGrid.innerHTML = '<p class="hint">加载片库失败</p>';
  }
}
openLibraryBtn.addEventListener('click', openLibrary);
closeLibraryBtn.addEventListener('click', () => { libraryModal.style.display = 'none'; });
libraryModal.addEventListener('click', (e) => { if (e.target === libraryModal) libraryModal.style.display = 'none'; });

micToggleBtn.addEventListener('click', async () => {
  if (!micOn) {
    try {
      await ensureLocalStream();
      micOn = true;
      micToggleBtn.textContent = '🎤 麦克风已开启';
      micToggleBtn.classList.add('active');
      localStream.getTracks().forEach((t) => (t.enabled = true));

      for (const [, pc] of peers.entries()) {
        const senders = pc.getSenders();
        if (!senders.find((s) => s.track)) {
          localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
        }
      }
      const known = window.__existingUsers || [];
      for (const u of known) {
        if (!peers.has(u.id)) await callPeer(u.id);
      }
    } catch (e) {
      addSystemMessage('无法访问麦克风,请检查浏览器权限设置。');
    }
  } else {
    micOn = false;
    micToggleBtn.textContent = '🎤 开启麦克风';
    micToggleBtn.classList.remove('active');
    if (localStream) localStream.getTracks().forEach((t) => (t.enabled = false));
  }
  const myDot = document.querySelector(`.mic-dot[data-uid="${myId}"]`);
  if (myDot) myDot.classList.toggle('on', micOn);
});
