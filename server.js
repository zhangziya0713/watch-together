require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null; // 不设置的话管理后台无法登录,逼着部署时必须自己配置
const SESSION_SECRET = process.env.SESSION_SECRET || 'please-change-this-secret-in-env';

// ============ Cloudflare R2(视频/海报/账号数据都存这里,重启不丢失) ============
const useR2 = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME &&
  process.env.R2_PUBLIC_URL
);

let r2Client = null;
if (useR2) {
  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  console.log('云存储已启用(Cloudflare R2):', process.env.R2_BUCKET_NAME);
} else {
  console.log('未检测到 R2 配置,账号数据/视频片库将退回本地磁盘存储(重启会丢失,仅供测试)');
}

const dataRoot = path.join(__dirname, 'local-data');
if (!fs.existsSync(dataRoot)) fs.mkdirSync(dataRoot);
const uploadsRoot = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot);
app.use('/uploads', express.static(uploadsRoot));

async function r2PutBuffer(key, buffer, contentType) {
  await r2Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME, Key: key, Body: buffer, ContentType: contentType,
  }));
  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
}

async function r2GetJSON(key, fallback) {
  if (!useR2) {
    const file = path.join(dataRoot, key.replace(/\//g, '_'));
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  }
  try {
    const res = await r2Client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    const str = await res.Body.transformToString();
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

async function r2PutJSON(key, obj) {
  if (!useR2) {
    const file = path.join(dataRoot, key.replace(/\//g, '_'));
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return;
  }
  await r2Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME, Key: key, Body: JSON.stringify(obj, null, 2), ContentType: 'application/json',
  }));
}

// ============ 账号 / 片库 数据读写(小规模场景,直接读写整份 JSON) ============
const ACCOUNTS_KEY = '_data/accounts.json';
const LIBRARY_KEY = '_data/library.json';

async function getAccounts() { return r2GetJSON(ACCOUNTS_KEY, {}); }
async function saveAccounts(accounts) { return r2PutJSON(ACCOUNTS_KEY, accounts); }
async function getLibrary() { return r2GetJSON(LIBRARY_KEY, []); }
async function saveLibrary(lib) { return r2PutJSON(LIBRARY_KEY, lib); }

function isAccountValid(account) {
  if (!account) return false;
  if (!account.enabled) return false;
  if (account.expiresAt && new Date(account.expiresAt) < new Date()) return false;
  return true;
}

// ============ 中间件 ============
app.use(express.json());
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 14 }, // 14天免登录
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

function requireUserAuth(req, res, next) {
  if (req.session && (req.session.username || req.session.isAdmin)) return next();
  return res.redirect('/login.html');
}
function requireAdminAuth(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/login.html?admin=1');
}
function requireUserAuthAPI(req, res, next) {
  if (req.session && (req.session.username || req.session.isAdmin)) return next();
  return res.status(401).json({ error: '请先登录' });
}
function requireAdminAuthAPI(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(403).json({ error: '需要管理员权限' });
}

// ============ 登录 / 登出 ============
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请输入账号和密码' });

  if (ADMIN_PASSWORD && username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true, redirect: '/admin.html' });
  }

  const accounts = await getAccounts();
  const account = accounts[username];
  if (!account) return res.status(401).json({ error: '账号不存在' });
  if (!isAccountValid(account)) return res.status(403).json({ error: '账号已被停用或已过期,请联系管理员' });

  const ok = await bcrypt.compare(password, account.passwordHash);
  if (!ok) return res.status(401).json({ error: '密码错误' });

  req.session.username = username;
  res.json({ ok: true, redirect: '/' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.isAdmin) return res.json({ username: ADMIN_USERNAME, isAdmin: true });
  if (req.session && req.session.username) return res.json({ username: req.session.username, isAdmin: false });
  res.status(401).json({ error: '未登录' });
});

// ============ 页面路由(受保护的页面放 views/,公开页面放 public/) ============
app.get('/', requireUserAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'index.html')));
app.get('/admin.html', requireAdminAuth, (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));

// ============ 片库 API(登录用户可读,管理员可写) ============
app.get('/api/library', requireUserAuthAPI, async (req, res) => {
  const lib = await getLibrary();
  res.json(lib);
});

const libraryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } });

app.post('/api/admin/library', requireAdminAuthAPI, libraryUpload.fields([{ name: 'poster', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  try {
    const { title, videoUrl: videoUrlInput, posterUrl: posterUrlInput } = req.body;
    if (!title) return res.status(400).json({ error: '请填写标题' });
    const posterFile = req.files?.poster?.[0];
    const videoFile = req.files?.video?.[0];

    if (!videoFile && !videoUrlInput) {
      return res.status(400).json({ error: '请上传视频文件,或者提供一个视频直链' });
    }

    const id = crypto.randomUUID();
    let videoUrl, posterUrl = null;

    if (videoFile) {
      if (useR2) {
        videoUrl = await r2PutBuffer(`library/${id}-${videoFile.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`, videoFile.buffer, videoFile.mimetype);
      } else {
        const dir = path.join(uploadsRoot, 'library');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const vName = `${id}-${videoFile.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
        fs.writeFileSync(path.join(dir, vName), videoFile.buffer);
        videoUrl = `/uploads/library/${encodeURIComponent(vName)}`;
      }
    } else {
      videoUrl = videoUrlInput; // 直接使用管理员粘贴的直链,不经过我们的服务器中转
    }

    if (posterFile) {
      if (useR2) {
        posterUrl = await r2PutBuffer(`library/${id}-poster-${posterFile.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`, posterFile.buffer, posterFile.mimetype);
      } else {
        const dir = path.join(uploadsRoot, 'library');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const pName = `${id}-poster-${posterFile.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
        fs.writeFileSync(path.join(dir, pName), posterFile.buffer);
        posterUrl = `/uploads/library/${encodeURIComponent(pName)}`;
      }
    } else if (posterUrlInput) {
      posterUrl = posterUrlInput;
    }

    const lib = await getLibrary();
    lib.unshift({ id, title, videoUrl, posterUrl, createdAt: Date.now() });
    await saveLibrary(lib);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '添加失败: ' + err.message });
  }
});

app.delete('/api/admin/library/:id', requireAdminAuthAPI, async (req, res) => {
  const lib = await getLibrary();
  const next = lib.filter((v) => v.id !== req.params.id);
  await saveLibrary(next);
  res.json({ ok: true });
});

// ============ 账号管理 API(仅管理员) ============
app.get('/api/admin/accounts', requireAdminAuthAPI, async (req, res) => {
  const accounts = await getAccounts();
  const list = Object.entries(accounts).map(([username, info]) => ({
    username, expiresAt: info.expiresAt, enabled: info.enabled, createdAt: info.createdAt,
  }));
  res.json(list);
});

app.post('/api/admin/accounts', requireAdminAuthAPI, async (req, res) => {
  const { username, password, expiresAt } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '请填写账号和密码' });
  const accounts = await getAccounts();
  if (accounts[username]) return res.status(409).json({ error: '这个账号名已经存在' });
  const passwordHash = await bcrypt.hash(password, 10);
  accounts[username] = { passwordHash, expiresAt: expiresAt || null, enabled: true, createdAt: Date.now() };
  await saveAccounts(accounts);
  res.json({ ok: true });
});

app.patch('/api/admin/accounts/:username', requireAdminAuthAPI, async (req, res) => {
  const accounts = await getAccounts();
  const account = accounts[req.params.username];
  if (!account) return res.status(404).json({ error: '账号不存在' });
  const { enabled, expiresAt, password } = req.body || {};
  if (typeof enabled === 'boolean') account.enabled = enabled;
  if (expiresAt !== undefined) account.expiresAt = expiresAt || null;
  if (password) account.passwordHash = await bcrypt.hash(password, 10);
  await saveAccounts(accounts);
  res.json({ ok: true });
});

app.delete('/api/admin/accounts/:username', requireAdminAuthAPI, async (req, res) => {
  const accounts = await getAccounts();
  delete accounts[req.params.username];
  await saveAccounts(accounts);
  res.json({ ok: true });
});

// ============ 房间视频上传(临时观影用,和上面的"片库"是两回事) ============
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

app.post('/upload/:roomId', requireUserAuthAPI, upload.single('video'), async (req, res) => {
  const { roomId } = req.params;
  const { socketId } = req.body;
  const room = rooms.get(roomId);
  if (!room || room.hostId !== socketId) return res.status(403).json({ error: '只有房主可以上传视频' });
  if (!req.file) return res.status(400).json({ error: '没有收到视频文件' });

  const safeName = Date.now() + '-' + req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  try {
    if (useR2) {
      const url = await r2PutBuffer(`rooms/${roomId.replace(/[^a-zA-Z0-9_-]/g, '')}-${safeName}`, req.file.buffer, req.file.mimetype);
      return res.json({ url });
    }
    const roomDir = path.join(uploadsRoot, roomId.replace(/[^a-zA-Z0-9_-]/g, ''));
    if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });
    fs.writeFileSync(path.join(roomDir, safeName), req.file.buffer);
    res.json({ url: `/uploads/${encodeURIComponent(roomId.replace(/[^a-zA-Z0-9_-]/g, ''))}/${encodeURIComponent(safeName)}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '上传失败: ' + err.message });
  }
});

// ============ 房间状态(内存即可,房间是临时性的) ============
const rooms = new Map();

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.users.entries()).map(([id, info]) => ({ id, name: info.name }));
}
function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('room-users', { users: getRoomUsers(roomId), hostId: room.hostId });
}

// ============ Socket.io(接入登录校验,共享 express-session) ============
io.use((socket, next) => { sessionMiddleware(socket.request, {}, next); });
io.use((socket, next) => {
  const session = socket.request.session;
  if (session && (session.username || session.isAdmin)) return next();
  next(new Error('未登录'));
});

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    currentRoom = roomId;
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, { users: new Map(), hostId: socket.id, currentVideo: null });
    }
    const room = rooms.get(roomId);
    room.users.set(socket.id, { name });

    socket.emit('existing-users', getRoomUsers(roomId).filter((u) => u.id !== socket.id));
    socket.to(roomId).emit('user-joined', { id: socket.id, name });

    if (room.currentVideo) {
      socket.emit('video-action', { type: 'load', ...room.currentVideo });
    }
    broadcastRoomState(roomId);
  });

  socket.on('video-action', (payload) => {
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    if (payload.type === 'load') {
      room.currentVideo = { sourceType: payload.sourceType, src: payload.src };
    }
    socket.to(currentRoom).emit('video-action', payload);
  });

  socket.on('chat-message', ({ text, name }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('chat-message', { text, name, id: socket.id, ts: Date.now() });
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    const leavingName = room.users.get(socket.id)?.name;
    room.users.delete(socket.id);

    if (room.users.size === 0) { rooms.delete(currentRoom); return; }

    let hostChanged = false;
    if (room.hostId === socket.id) {
      room.hostId = room.users.keys().next().value;
      hostChanged = true;
    }
    io.to(currentRoom).emit('user-left', { id: socket.id, name: leavingName });
    broadcastRoomState(currentRoom);
    if (hostChanged) io.to(currentRoom).emit('host-changed', { hostId: room.hostId });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  if (!ADMIN_PASSWORD) {
    console.warn('警告: 没有设置 ADMIN_PASSWORD 环境变量,管理后台将无法登录!');
  }
  console.log(`服务已启动: http://localhost:${PORT}`);
});
