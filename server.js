const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { Game } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROOM_REJOIN_TTL_MS = 5 * 60 * 1000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

function getLocalIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((network) => network && network.family === 'IPv4' && !network.internal)
    .map((network) => network.address);
}

function getServerUrls() {
  const localIps = getLocalIps();
  const urls = localIps.map((ip) => `http://${ip}:${PORT}`);
  return urls.length ? urls : [`http://localhost:${PORT}`];
}

app.get('/server-info', async (req, res) => {
  const urls = getServerUrls();
  const primaryUrl = urls[0];
  const qrCode = await QRCode.toDataURL(primaryUrl, {
    margin: 1,
    scale: 8,
    color: { dark: '#111827', light: '#fffdf5' }
  });

  res.json({ primaryUrl, urls, qrCode });
});

function createRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function createPlayerToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function createRoom(socket) {
  const code = createRoomCode();
  const room = {
    code,
    players: {
      1: { socketId: socket.id, connected: true, token: createPlayerToken() },
      2: null
    },
    game: new Game(),
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    missingSince: Date.now()
  };

  rooms.set(code, room);
  attachSocketToRoom(socket, room, 1);
  return room;
}

function attachSocketToRoom(socket, room, playerNumber) {
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerNumber = playerNumber;
  const existingToken = room.players[playerNumber]?.token;
  room.players[playerNumber] = {
    socketId: socket.id,
    connected: true,
    token: existingToken || createPlayerToken()
  };
  room.lastActiveAt = Date.now();
  updateMissingSince(room);
}

function getJoinSlot(room) {
  if (!room.players[2]) return 2;
  return null;
}

function hasMissingPlayer(room) {
  return [1, 2].some((playerNumber) => !room.players[playerNumber]?.connected);
}

function updateMissingSince(room) {
  if (hasMissingPlayer(room)) {
    room.missingSince = room.missingSince || Date.now();
  } else {
    room.missingSince = null;
  }
}

function isRoomExpired(room) {
  return Boolean(room.missingSince && Date.now() - room.missingSince > ROOM_REJOIN_TTL_MS);
}

function expireRoom(code, reason = 'Room expired. Rejoin time is over.') {
  const room = rooms.get(code);
  if (!room) return;

  for (const playerNumber of [1, 2]) {
    const player = room.players[playerNumber];
    if (player?.connected && player.socketId) {
      const playerSocket = io.sockets.sockets.get(player.socketId);
      playerSocket?.leave(code);
      playerSocket?.emit('roomExpired', reason);
    }
  }

  rooms.delete(code);
}

function emitRoomState(roomCode, message = null) {
  const room = rooms.get(roomCode);
  if (!room) return;

  for (const playerNumber of [1, 2]) {
    const player = room.players[playerNumber];
    if (player?.connected && player.socketId) {
      const state = getSafeGameState(room, playerNumber);
      if (message) state.message = message;
      io.to(player.socketId).emit('state', state);
    }
  }
}

function getSafeGameState(room, playerNumber) {
  const state = room.game.getStateForPlayer(playerNumber);
  return {
    ...state,
    roomCode: room.code,
    playerId: playerNumber,
    playerNumber,
    playerToken: room.players[playerNumber]?.token,
    rejoinExpiresAt: room.missingSince ? room.missingSince + ROOM_REJOIN_TTL_MS : null,
    roomPlayers: {
      1: { connected: Boolean(room.players[1]?.connected) },
      2: { connected: Boolean(room.players[2]?.connected) }
    }
  };
}

function emitLobbyState(socket, message = 'Create game or join with a room code.') {
  socket.emit('lobbyState', { message });
}

function getSocketRoom(socket) {
  const roomCode = socket.data.roomCode;
  const playerNumber = socket.data.playerNumber;
  if (!roomCode || !playerNumber) return null;

  const room = rooms.get(roomCode);
  if (!room) return null;
  if (isRoomExpired(room)) {
    expireRoom(roomCode);
    return null;
  }

  const player = room.players[playerNumber];
  if (!player || player.socketId !== socket.id || !player.connected) return null;

  return { room, roomCode, playerNumber };
}

function emitRoomJoined(socket, room, playerNumber, message) {
  socket.emit('roomJoined', {
    roomCode: room.code,
    playerNumber,
    playerToken: room.players[playerNumber]?.token,
    message
  });
}

function cleanupRooms() {
  for (const [code, room] of rooms.entries()) {
    updateMissingSince(room);
    if (isRoomExpired(room)) {
      expireRoom(code);
    }
  }
}

setInterval(cleanupRooms, 30 * 1000);

io.on('connection', (socket) => {
  emitLobbyState(socket);

  socket.on('createRoom', () => {
    const room = createRoom(socket);
    emitRoomJoined(socket, room, 1, `Room created: ${room.code}. Waiting for Player 2.`);
    emitRoomState(room.code, 'Waiting for Player 2');
  });

  socket.on('joinRoom', ({ roomCode }) => {
    const code = String(roomCode || '').trim();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('lobbyError', 'Invalid room code');
      return;
    }

    if (isRoomExpired(room)) {
      expireRoom(code);
      socket.emit('lobbyError', 'Room expired');
      return;
    }

    const playerNumber = getJoinSlot(room);
    if (!playerNumber) {
      socket.emit('lobbyError', 'Room is full');
      return;
    }

    attachSocketToRoom(socket, room, playerNumber);
    emitRoomJoined(socket, room, playerNumber, `Joined room ${code}`);

    if (room.players[1]?.connected && room.players[2]?.connected && room.game.status === 'waiting') {
      io.to(room.code).emit('roomMessage', 'Player 2 joined');
      room.game.start();
      io.to(room.code).emit('roomMessage', 'Game started');
    }

    emitRoomState(room.code, room.game.status === 'playing' ? 'Game started' : `Waiting for Player ${playerNumber === 1 ? 2 : 1}`);
  });

  socket.on('rejoinRoom', ({ roomCode, playerNumber, playerToken }) => {
    const code = String(roomCode || '').trim();
    const slot = Number(playerNumber);
    const room = rooms.get(code);

    if (!room || ![1, 2].includes(slot)) {
      socket.emit('rejoinFailed', 'Room no longer exists');
      return;
    }

    if (isRoomExpired(room)) {
      expireRoom(code);
      socket.emit('rejoinFailed', 'Room expired');
      return;
    }

    const player = room.players[slot];
    if (!player || player.token !== playerToken) {
      socket.emit('rejoinFailed', 'Rejoin is not valid for this room');
      return;
    }

    attachSocketToRoom(socket, room, slot);
    emitRoomJoined(socket, room, slot, `Reconnected as Player ${slot}`);
    io.to(room.code).emit('roomMessage', `Player ${slot} reconnected.`);
    emitRoomState(room.code, 'Reconnected');
  });

  socket.on('takeCards', ({ handCardId, tableCardIds }) => {
    const context = getSocketRoom(socket);
    if (!context) return;

    const { room, roomCode, playerNumber } = context;
    if (hasMissingPlayer(room)) {
      socket.emit('errorMessage', 'Wait for opponent to reconnect.');
      emitRoomState(roomCode);
      return;
    }

    const result = room.game.takeCards(playerNumber, handCardId, tableCardIds);
    socket.emit('errorMessage', result.ok ? '' : result.message);
    room.lastActiveAt = Date.now();
    emitRoomState(roomCode);
  });

  socket.on('throwCard', ({ handCardId }) => {
    const context = getSocketRoom(socket);
    if (!context) return;

    const { room, roomCode, playerNumber } = context;
    if (hasMissingPlayer(room)) {
      socket.emit('errorMessage', 'Wait for opponent to reconnect.');
      emitRoomState(roomCode);
      return;
    }

    const result = room.game.throwCard(playerNumber, handCardId);
    socket.emit('errorMessage', result.ok ? '' : result.message);
    room.lastActiveAt = Date.now();
    emitRoomState(roomCode);
  });

  socket.on('playAgain', () => {
    const context = getSocketRoom(socket);
    if (!context) return;

    const { room, roomCode } = context;
    if (room.players[1]?.connected && room.players[2]?.connected) {
      room.game.start();
      room.lastActiveAt = Date.now();
      emitRoomState(roomCode, 'Game started');
    } else {
      socket.emit('errorMessage', 'Waiting for both players.');
    }
  });

  socket.on('disconnect', () => {
    const { roomCode, playerNumber } = socket.data;
    const room = rooms.get(roomCode);
    if (!room || !playerNumber || !room.players[playerNumber]) return;

    room.players[playerNumber].connected = false;
    room.players[playerNumber].socketId = null;
    room.lastActiveAt = Date.now();
    updateMissingSince(room);
    socket.to(roomCode).emit('errorMessage', 'Opponent disconnected. Rejoin is available for 5 minutes.');
    emitRoomState(roomCode);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Tablanet server running at http://localhost:${PORT}`);

  const localIps = getLocalIps();
  if (localIps.length) {
    console.log('Open from another device on the same Wi-Fi:');
    localIps.forEach((ip) => console.log(`  http://${ip}:${PORT}`));
  }
});
