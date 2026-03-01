const http = require("http");
const crypto = require("crypto");

// ────────── tiny WebSocket server (zero deps) ──────────

function createWSServer(httpServer) {
  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const clients = new Set();
  const listeners = { connection: [] };

  httpServer.on("upgrade", (req, socket, head) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const ws = wrapSocket(socket);
    clients.add(ws);
    ws._socket.on("close", () => { clients.delete(ws); ws._handlers.close.forEach((fn) => fn()); });
    listeners.connection.forEach((fn) => fn(ws, req));
  });

  function wrapSocket(socket) {
    const ws = {
      _socket: socket,
      _handlers: { message: [], close: [] },
      readyState: 1,
      on(evt, fn) { (ws._handlers[evt] = ws._handlers[evt] || []).push(fn); },
      send(data) {
        if (socket.destroyed) return;
        socket.write(buildFrame(Buffer.from(data)));
      },
    };
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const r = parseFrame(buf);
        if (!r) break;
        buf = r.rest;
        if (r.opcode === 0x8) { ws.readyState = 3; socket.end(); return; }
        if (r.opcode === 0x9) { socket.write(buildFrame(r.payload, 0xa)); continue; }
        if (r.opcode === 0xa) continue;
        if (r.opcode === 0x1 || r.opcode === 0x2)
          ws._handlers.message.forEach((fn) => fn(r.payload.toString("utf8")));
      }
    });
    socket.on("error", () => { ws.readyState = 3; });
    return ws;
  }

  function buildFrame(payload, opcode = 0x1) {
    const len = payload.length;
    let h;
    if (len < 126) { h = Buffer.alloc(2); h[0] = 0x80 | opcode; h[1] = len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([h, payload]);
  }

  function parseFrame(buf) {
    if (buf.length < 2) return null;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let payloadLen = buf[1] & 0x7f, offset = 2;
    if (payloadLen === 126) { if (buf.length < 4) return null; payloadLen = buf.readUInt16BE(2); offset = 4; }
    else if (payloadLen === 127) { if (buf.length < 10) return null; payloadLen = Number(buf.readBigUInt64BE(2)); offset = 10; }
    if (masked) {
      if (buf.length < offset + 4 + payloadLen) return null;
      const mask = buf.slice(offset, offset + 4); offset += 4;
      const payload = buf.slice(offset, offset + payloadLen);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      return { opcode, payload, rest: buf.slice(offset + payloadLen) };
    }
    if (buf.length < offset + payloadLen) return null;
    return { opcode, payload: buf.slice(offset, offset + payloadLen), rest: buf.slice(offset + payloadLen) };
  }

  return { on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }, clients };
}

// ────────── Room management ──────────

const rooms = new Map();

function rid() {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = ""; for (let i = 0; i < 6; i++) s += c[(Math.random() * c.length) | 0];
  return s;
}

function memberList(room) {
  return Array.from(room.members.values()).map((m) => ({
    id: m.id, username: m.username, isHost: m.ws === room.host,
    mediaAudio: m.mediaAudio || false, mediaVideo: m.mediaVideo || false,
  }));
}

function broadcast(room, msg, exclude) {
  const d = JSON.stringify(msg);
  for (const [, m] of room.members) {
    if (m.ws !== exclude && m.ws.readyState === 1) m.ws.send(d);
  }
}

function sendTo(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function removeFromRoom(ws) {
  if (!ws._roomId) return;
  const room = rooms.get(ws._roomId);
  if (!room) return;

  const wasBuf = room.members.get(ws._id)?.isBuffering;
  room.members.delete(ws._id);
  ws._roomId = null;

  if (room.members.size === 0) { rooms.delete(room.id); return; }

  // Transfer host
  if (room.host === ws) {
    const next = room.members.values().next().value;
    room.host = next.ws;
  }

  // Buffering bookkeeping
  if (wasBuf) {
    room.bufferingCount = Math.max(0, room.bufferingCount - 1);
    if (room.bufferingCount === 0) broadcast(room, { type: "buffering-clear" });
  }

  broadcast(room, { type: "user-left", username: ws._username, members: memberList(room) });
}

// ────────── Handlers ──────────

function handleCreate(ws, msg) {
  removeFromRoom(ws);
  const id = rid();
  const room = {
    id, host: ws, password: msg.password || null, hostOnly: false,
    members: new Map(), banned: new Set(), bufferingCount: 0, createdAt: Date.now(),
  };
  ws._username = msg.username || "Guest";
  ws._roomId = id;
  room.members.set(ws._id, { ws, id: ws._id, username: ws._username, isBuffering: false, mediaAudio: false, mediaVideo: false });
  rooms.set(id, room);
  sendTo(ws, { type: "room-created", roomId: id, members: memberList(room), isHost: true, hostOnly: false });
  console.log(`[room:${id}] created by ${ws._username}${room.password ? " (password)" : ""}`);
}

function handleJoin(ws, msg) {
  const room = rooms.get((msg.roomId || "").toUpperCase());
  if (!room) return sendTo(ws, { type: "error", message: "Room not found." });
  if (room.banned.has((msg.username || "").toLowerCase()))
    return sendTo(ws, { type: "error", message: "You have been kicked from this room." });
  if (room.password && msg.password !== room.password)
    return sendTo(ws, { type: "error", message: room.password ? "Wrong password." : "This room requires a password." });

  removeFromRoom(ws);
  ws._username = msg.username || "Guest";
  ws._roomId = room.id;
  room.members.set(ws._id, { ws, id: ws._id, username: ws._username, isBuffering: false, mediaAudio: false, mediaVideo: false });

  sendTo(ws, { type: "room-joined", roomId: room.id, members: memberList(room), isHost: room.host === ws, hostOnly: room.hostOnly });
  broadcast(room, { type: "user-joined", username: ws._username, members: memberList(room) }, ws);
  sendTo(room.host, { type: "sync-request", for: ws._id });
  console.log(`[room:${room.id}] ${ws._username} joined`);
}

function handleSync(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  if (room.hostOnly && room.host !== ws) return; // host-only mode
  broadcast(room, { ...msg, from: ws._username }, ws);
}

function handleChat(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  const payload = { type: "chat", username: ws._username, text: (msg.text || "").slice(0, 500), timestamp: Date.now() };
  broadcast(room, payload);
  sendTo(ws, payload);
}

function handleReaction(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  broadcast(room, { type: "reaction", username: ws._username, emoji: (msg.emoji || "").slice(0, 4) });
  sendTo(ws, { type: "reaction", username: ws._username, emoji: (msg.emoji || "").slice(0, 4) });
}

function handleTyping(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  broadcast(room, { type: "typing", username: ws._username, isTyping: !!msg.isTyping }, ws);
}

function handleKick(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room || room.host !== ws) return; // only host
  const target = room.members.get(msg.targetId);
  if (!target || target.ws === ws) return; // can't kick self

  room.banned.add(target.username.toLowerCase());
  sendTo(target.ws, { type: "kicked", reason: "You were kicked by the host." });
  removeFromRoom(target.ws);
  broadcast(room, { type: "user-kicked", username: target.username, members: memberList(room) });
  console.log(`[room:${room.id}] ${target.username} kicked by host`);
}

function handleHostOnly(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room || room.host !== ws) return;
  room.hostOnly = !!msg.enabled;
  broadcast(room, { type: "host-only-changed", enabled: room.hostOnly });
  sendTo(ws, { type: "host-only-changed", enabled: room.hostOnly });
}

function handleBuffering(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  const member = room.members.get(ws._id);
  if (!member) return;

  const wasBuf = member.isBuffering;
  member.isBuffering = !!msg.isBuffering;

  if (!wasBuf && member.isBuffering) {
    room.bufferingCount++;
    broadcast(room, { type: "buffering", username: ws._username, isBuffering: true });
  } else if (wasBuf && !member.isBuffering) {
    room.bufferingCount = Math.max(0, room.bufferingCount - 1);
    broadcast(room, { type: "buffering", username: ws._username, isBuffering: false });
    if (room.bufferingCount === 0) broadcast(room, { type: "buffering-clear" });
  }
}

function handleWebRTC(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  const target = room.members.get(msg.targetId);
  if (!target) return;
  sendTo(target.ws, { type: "webrtc-signal", fromId: ws._id, fromUsername: ws._username, signal: msg.signal });
}

function handleMediaState(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  const member = room.members.get(ws._id);
  if (!member) return;
  member.mediaAudio = !!msg.audio;
  member.mediaVideo = !!msg.video;
  broadcast(room, { type: "media-state", userId: ws._id, username: ws._username, audio: member.mediaAudio, video: member.mediaVideo });
  sendTo(ws, { type: "media-state", userId: ws._id, username: ws._username, audio: member.mediaAudio, video: member.mediaVideo });
}

// ────────── Boot ──────────

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ name: "CoWatch Sync Server", status: "ok", rooms: rooms.size, uptime: process.uptime() | 0 }));
  }
  res.writeHead(404); res.end("Not found");
});

const wss = createWSServer(server);
let nextId = 1;

wss.on("connection", (ws) => {
  ws._id = String(nextId++);
  ws._roomId = null;
  ws._username = "Guest";

  ws.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case "create-room":     handleCreate(ws, msg); break;
      case "join-room":       handleJoin(ws, msg); break;
      case "leave-room":      removeFromRoom(ws); break;
      case "sync":            handleSync(ws, msg); break;
      case "chat":            handleChat(ws, msg); break;
      case "reaction":        handleReaction(ws, msg); break;
      case "typing":          handleTyping(ws, msg); break;
      case "kick":            handleKick(ws, msg); break;
      case "toggle-host-only":handleHostOnly(ws, msg); break;
      case "buffering":       handleBuffering(ws, msg); break;
      case "webrtc-signal":   handleWebRTC(ws, msg); break;
      case "media-state":     handleMediaState(ws, msg); break;
    }
  });

  ws.on("close", () => removeFromRoom(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`CoWatch sync server listening on http://localhost:${PORT}`));
