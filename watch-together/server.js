const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Server } = require('socket.io');

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
const uploadsRoot = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const roomDir = path.join(uploadsRoot, req.params.roomId.replace(/[^a-zA-Z0-9_-]/g, ''));
    if (!fs.existsSync(roomDir)) fs.mkdirSync(roomDir, { recursive: true });
    cb(null, roomDir);
  },
  filename: (req, file, cb) => {
    const safe = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.use('/uploads', express.static(uploadsRoot));

app.post('/upload/:roomId', upload.single('video'), (req, res) => {
  const { roomId } = req.params;
  const { socketId } = req.body;
  const room = rooms.get(roomId);
  if (!room || room.hostId !== socketId) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: '只有房主可以上传视频' });
  }
  const url = `/uploads/${encodeURIComponent(roomId.replace(/[^a-zA-Z0-9_-]/g, ''))}/${encodeURIComponent(req.file.filename)}`;
  res.json({ url });
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
