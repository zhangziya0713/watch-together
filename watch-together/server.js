const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ 房间状态 ============
// roomId -> { users: Map(socketId -> {name}), hostId: socketId, currentVideo: {sourceType, src} | null }
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

// ============ 视频上传 ============
// 优先存到 Cloudflare R2(永久保留,不受服务器重启影响)。
// 如果没配置 R2 的环境变量,自动退回本地磁盘存储(仅供本地测试,服务器重启会丢失文件)。
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
  console.log('视频上传将存到 Cloudflare R2:', process.env.R2_BUCKET_NAME);
} else {
  console.log('未检测到 R2 配置,视频上传将退回本地磁盘存储(重启会丢失,仅供测试)');
}

const uploadsRoot = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot);
app.use('/uploads', express.static(uploadsRoot));

// 用内存暂存上传的文件,再决定转存到 R2 还是本地磁盘
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

app.post('/upload/:roomId', upload.single('video'), async (req, res) => {
  const { roomId } = req.params;
  const { socketId } = req.body;
  const room = rooms.get(roomId);
  if (!room || room.hostId !== socketId) {
    return res.status(403).json({ error: '只有房主可以上传视频' });
  }
  if (!req.file) {
    return res.status(400).json({ error: '没有收到视频文件' });
  }

  const safeName = Date.now() + '-' + req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');

  if (useR2) {
    try {
      await r2Client.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: safeName,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }));
      const publicBase = process.env.R2_PUBLIC_URL.replace(/\/$/, '');
      return res.json({ url: `${publicBase}/${safeName}` });
    } catch (err) {
      console.error('R2 上传失败:', err);
      return res.status(500).json({ error: '上传到云存储失败: ' + err.message });
    }
  }

  // 本地磁盘兜底(没配置 R2 时)
  try {
    const roomDir = path.join(uploadsRoot, roomId.replace(/[^a-zA-Z0-9_-]/g, ''));
    if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });
    fs.writeFileSync(path.join(roomDir, safeName), req.file.buffer);
    const url = `/uploads/${encodeURIComponent(roomId.replace(/[^a-zA-Z0-9_-]/g, ''))}/${encodeURIComponent(safeName)}`;
    res.json({ url });
  } catch (err) {
    console.error('本地保存失败:', err);
    res.status(500).json({ error: '保存文件失败: ' + err.message });
  }
});

// ============ Socket.io ============
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

    // 新人加入时,如果房间已经在播放,把当前视频状态同步给ta
    if (room.currentVideo) {
      socket.emit('video-action', { type: 'load', ...room.currentVideo });
    }

    broadcastRoomState(roomId);
  });

  // 只有房主的操作才会被转发和记录
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

    if (room.users.size === 0) {
      rooms.delete(currentRoom);
      return;
    }

    let hostChanged = false;
    if (room.hostId === socket.id) {
      room.hostId = room.users.keys().next().value; // 房主离开,自动把下一位提升为房主
      hostChanged = true;
    }

    io.to(currentRoom).emit('user-left', { id: socket.id, name: leavingName });
    broadcastRoomState(currentRoom);
    if (hostChanged) {
      io.to(currentRoom).emit('host-changed', { hostId: room.hostId });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
});
