'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');
const GameRoom = require('./src/GameRoom');

const nanoidRoom = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);
const nanoidPlayer = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

/** @type {Map<string, GameRoom>} */
const rooms = new Map();
// socket.id -> { roomId, playerId }
const socketMeta = new Map();

function broadcastRoom(room) {
  for (const p of room.players) {
    if (p.socketId) {
      io.to(p.socketId).emit('state', room.stateFor(p.id));
    }
  }
}

function errAck(cb, e) {
  if (typeof cb === 'function') cb({ ok: false, error: e.message || String(e) });
}
function okAck(cb, data) {
  if (typeof cb === 'function') cb({ ok: true, ...data });
}

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    try {
      const roomId = nanoidRoom();
      const room = new GameRoom(roomId);
      rooms.set(roomId, room);
      const playerId = nanoidPlayer();
      const player = room.addPlayer(playerId, (name || 'プレイヤー').slice(0, 20));
      player.socketId = socket.id;
      socketMeta.set(socket.id, { roomId, playerId });
      socket.join(roomId);
      okAck(cb, { roomId, playerId });
      broadcastRoom(room);
    } catch (e) {
      errAck(cb, e);
    }
  });

  socket.on('joinRoom', ({ roomId, name, playerId }, cb) => {
    try {
      roomId = (roomId || '').toUpperCase().trim();
      const room = rooms.get(roomId);
      if (!room) throw new Error('ルームが見つかりません');

      // reconnect path
      if (playerId) {
        const existing = room.getPlayer(playerId);
        if (existing) {
          existing.connected = true;
          existing.socketId = socket.id;
          socketMeta.set(socket.id, { roomId, playerId });
          socket.join(roomId);
          okAck(cb, { roomId, playerId });
          broadcastRoom(room);
          return;
        }
      }

      const newId = nanoidPlayer();
      const player = room.addPlayer(newId, (name || 'プレイヤー').slice(0, 20));
      player.socketId = socket.id;
      socketMeta.set(socket.id, { roomId, playerId: newId });
      socket.join(roomId);
      okAck(cb, { roomId, playerId: newId });
      broadcastRoom(room);
    } catch (e) {
      errAck(cb, e);
    }
  });

  function withRoom(fn) {
    return (payload, cb) => {
      try {
        const meta = socketMeta.get(socket.id);
        if (!meta) throw new Error('セッションが見つかりません。再接続してください');
        const room = rooms.get(meta.roomId);
        if (!room) throw new Error('ルームが見つかりません');
        fn(room, meta.playerId, payload || {}, cb);
        broadcastRoom(room);
        okAck(cb, {});
      } catch (e) {
        errAck(cb, e);
      }
    };
  }

  socket.on('startGame', withRoom((room, playerId) => {
    if (room.hostId !== playerId) throw new Error('ホストのみ開始できます');
    room.startGame();
  }));

  socket.on('updateSettings', withRoom((room, playerId, patch) => {
    room.updateSettings(playerId, patch);
  }));

  socket.on('playAgain', withRoom((room, playerId) => {
    // 「次のゲームへ」：ロビーに戻すだけでなく、同じメンバーでそのまま次のゲームを開始する
    room.resetToLobby(playerId);
    room.startGame();
  }));

  socket.on('draftPick', withRoom((room, playerId, { cardId }) => {
    room.handleDraftPick(playerId, cardId);
  }));

  socket.on('submitPlacement', withRoom((room, playerId, { placements }) => {
    room.handleSubmitPlacement(playerId, placements);
    if (room.phase === 'trial') {
      runTrial(room);
    }
  }));

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = rooms.get(meta.roomId);
    if (room) {
      room.removePlayer(meta.playerId);
      broadcastRoom(room);
    }
    socketMeta.delete(socket.id);
  });
});

function runTrial(room) {
  const emitStep = (playerId, detail) => {
    try {
      io.to(room.id).emit('trialStep', { playerId, ...detail });
    } catch (e) {
      console.error(`[room ${room.id}] emitStep failed:`, e);
    }
  };

  room.startTrialPhase(emitStep).then(() => {
    broadcastRoom(room);
    io.to(room.id).emit('gameOver', { winners: room.winners, results: room.trialResults });
  }).catch((e) => {
    // 試運転フェイズ中に何が起きてもサーバー全体を巻き込んでクラッシュさせない。
    // ここで拾わないと、Node の仕様上プロセス全体が落ちて全ルームのゲームが止まる。
    console.error(`[room ${room.id}] 試運転フェイズでエラーが発生しました:`, e);
    // レールは埋まりきっているため配置フェイズには戻せない。安全にロビーへリセットする。
    room.resetToLobby(room.hostId);
    room.addLog('⚠ 試運転フェイズでエラーが発生したため、ロビーに戻りました。もう一度ゲームを開始してください。');
    try {
      broadcastRoom(room);
    } catch (e2) {
      console.error(`[room ${room.id}] broadcast after trial error also failed:`, e2);
    }
  });
}

// 個々のリクエスト処理中に想定外の例外が出てもサーバー自体は落とさない（1ルームの不具合で全体を巻き込まない）
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (server kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server kept alive):', err);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`FIRST DROP server running: http://localhost:${PORT}`);
});
