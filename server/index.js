const http = require("http");
const crypto = require("crypto");

// ---------- tiny WebSocket server (no deps for dev, or use `ws` in prod) ----------

function createWSServer(httpServer) {
  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const clients = new Set();
  const listeners = { connection: [] };

  httpServer.on("upgrade", (req, socket, head) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = crypto
      .createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const ws = wrapSocket(socket);
    clients.add(ws);
    ws._socket.on("close", () => {
      clients.delete(ws);
      ws._handlers.close.forEach((fn) => fn());
    });
    listeners.connection.forEach((fn) => fn(ws, req));
  });

  function wrapSocket(socket) {
    const ws = {
      _socket: socket,
      _handlers: { message: [], close: [] },
      readyState: 1, // OPEN
      on(evt, fn) {
        (ws._handlers[evt] = ws._handlers[evt] || []).push(fn);
      },
      send(data) {
        if (socket.destroyed) return;
        const buf = Buffer.from(data);
        const frame = buildFrame(buf);
        socket.write(frame);
      },
    };
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const result = parseFrame(buf);
        if (!result) break;
        buf = result.rest;
        if (result.opcode === 0x8) {
          ws.readyState = 3;
          socket.end();
          return;
        }
        if (result.opcode === 0x9) {
          // ping -> pong
          const pong = buildFrame(result.payload, 0xa);
          socket.write(pong);
          continue;
        }
        if (result.opcode === 0xa) continue; // pong
        if (result.opcode === 0x1 || result.opcode === 0x2) {
          ws._handlers.message.forEach((fn) =>
            fn(result.payload.toString("utf8"))
          );
        }
      }
    });
    socket.on("error", () => {
      ws.readyState = 3;
    });
    return ws;
  }

  function buildFrame(payload, opcode = 0x1) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  function parseFrame(buf) {
    if (buf.length < 2) return null;
    const firstByte = buf[0];
    const opcode = firstByte & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let payloadLen = buf[1] & 0x7f;
    let offset = 2;
    if (payloadLen === 126) {
      if (buf.length < 4) return null;
      payloadLen = buf.readUInt16BE(2);
      offset = 4;
    } else if (payloadLen === 127) {
      if (buf.length < 10) return null;
      payloadLen = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    if (masked) {
      if (buf.length < offset + 4 + payloadLen) return null;
      const mask = buf.slice(offset, offset + 4);
      offset += 4;
      const payload = buf.slice(offset, offset + payloadLen);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      return { opcode, payload, rest: buf.slice(offset + payloadLen) };
    }
    if (buf.length < offset + payloadLen) return null;
    return {
      opcode,
      payload: buf.slice(offset, offset + payloadLen),
      rest: buf.slice(offset + payloadLen),
    };
  }

  return {
    on(evt, fn) {
      (listeners[evt] = listeners[evt] || []).push(fn);
    },
    clients,
  };
}

// ---------- Room management ----------

const rooms = new Map();

function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[(Math.random() * chars.length) | 0];
  return id;
}

function broadcast(room, message, excludeWs) {
  const data = JSON.stringify(message);
  for (const [, member] of room.members) {
    if (member.ws !== excludeWs && member.ws.readyState === 1) {
      member.ws.send(data);
    }
  }
}

function getMemberList(room) {
  return Array.from(room.members.values()).map((m) => ({
    id: m.id,
    username: m.username,
    isHost: m.ws === room.host,
  }));
}

function removeFromRoom(ws) {
  if (!ws._roomId) return;
  const room = rooms.get(ws._roomId);
  if (!room) return;

  room.members.delete(ws._id);
  ws._roomId = null;

  if (room.members.size === 0) {
    rooms.delete(room.id);
    console.log(`[room:${room.id}] deleted (empty)`);
    return;
  }

  if (room.host === ws) {
    const next = room.members.values().next().value;
    room.host = next.ws;
    console.log(`[room:${room.id}] host transferred to ${next.username}`);
  }

  broadcast(room, {
    type: "user-left",
    username: ws._username,
    members: getMemberList(room),
  });
}

// ---------- Message handlers ----------

function handleCreate(ws, msg) {
  removeFromRoom(ws);
  const roomId = generateRoomId();
  const room = {
    id: roomId,
    host: ws,
    members: new Map(),
    createdAt: Date.now(),
  };
  room.members.set(ws._id, { ws, id: ws._id, username: msg.username });
  rooms.set(roomId, room);
  ws._roomId = roomId;
  ws._username = msg.username;

  ws.send(
    JSON.stringify({
      type: "room-created",
      roomId,
      members: getMemberList(room),
    })
  );
  console.log(`[room:${roomId}] created by ${msg.username}`);
}

function handleJoin(ws, msg) {
  const room = rooms.get(msg.roomId?.toUpperCase());
  if (!room) {
    ws.send(
      JSON.stringify({ type: "error", message: "Room not found. Check the code and try again." })
    );
    return;
  }

  removeFromRoom(ws);
  room.members.set(ws._id, { ws, id: ws._id, username: msg.username });
  ws._roomId = room.id;
  ws._username = msg.username;

  ws.send(
    JSON.stringify({
      type: "room-joined",
      roomId: room.id,
      members: getMemberList(room),
    })
  );

  broadcast(
    room,
    {
      type: "user-joined",
      username: msg.username,
      members: getMemberList(room),
    },
    ws
  );

  // Ask host to send current state so new member can sync
  room.host.send(JSON.stringify({ type: "sync-request", for: ws._id }));
  console.log(`[room:${room.id}] ${msg.username} joined`);
}

function handleSync(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  broadcast(room, { ...msg, from: ws._username }, ws);
}

function handleChat(ws, msg) {
  const room = rooms.get(ws._roomId);
  if (!room) return;
  broadcast(room, {
    type: "chat",
    username: ws._username,
    text: (msg.text || "").slice(0, 500),
    timestamp: Date.now(),
  });
  // Also echo back to sender
  ws.send(
    JSON.stringify({
      type: "chat",
      username: ws._username,
      text: (msg.text || "").slice(0, 500),
      timestamp: Date.now(),
    })
  );
}

function handleLeave(ws) {
  removeFromRoom(ws);
}

// ---------- Boot ----------

const server = http.createServer((req, res) => {
  // Health check / info endpoint
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(
      JSON.stringify({
        name: "CoWatch Sync Server",
        status: "ok",
        rooms: rooms.size,
        uptime: process.uptime() | 0,
      })
    );
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const wss = createWSServer(server);
let nextId = 1;

wss.on("connection", (ws) => {
  ws._id = String(nextId++);
  ws._roomId = null;
  ws._username = "Guest";

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "create-room":
        handleCreate(ws, msg);
        break;
      case "join-room":
        handleJoin(ws, msg);
        break;
      case "sync":
        handleSync(ws, msg);
        break;
      case "chat":
        handleChat(ws, msg);
        break;
      case "leave-room":
        handleLeave(ws);
        break;
    }
  });

  ws.on("close", () => removeFromRoom(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`CoWatch sync server listening on http://localhost:${PORT}`);
});
