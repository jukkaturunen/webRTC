import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
const nameIndex = new Map();

function createRoom(name) {
  const id = crypto.randomUUID();
  const room = {
    id,
    name: name?.trim() || "Untitled Room",
    createdAt: new Date().toISOString(),
    clients: new Set(),
  };
  rooms.set(id, room);
  return room;
}

function listRooms() {
  return Array.from(rooms.values()).map((room) => ({
    id: room.id,
    name: room.name,
    createdAt: room.createdAt,
    count: room.clients.size,
  }));
}

function removeClientFromRoom(client) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (!room) {
    client.roomId = null;
    return;
  }
  room.clients.delete(client);
  const payload = JSON.stringify({ type: "peer-left", id: client.id });
  for (const peer of room.clients) {
    peer.ws.send(payload);
  }
  client.roomId = null;
}

function unregisterClient(client) {
  if (client.name && nameIndex.get(client.name) === client) {
    nameIndex.delete(client.name);
  }
}

function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  const payload = JSON.stringify({ type: "room-deleted", roomId });
  for (const client of room.clients) {
    client.roomId = null;
    unregisterClient(client);
    client.ws.send(payload);
  }
  rooms.delete(roomId);
  return true;
}

app.get("/api/rooms", (req, res) => {
  res.json({ rooms: listRooms() });
});

app.post("/api/rooms", (req, res) => {
  const name = req.body?.name;
  const room = createRoom(name);
  res.status(201).json({ room });
});

app.delete("/api/rooms/:id", (req, res) => {
  const ok = deleteRoom(req.params.id);
  if (!ok) {
    res.status(404).json({ error: "Room not found" });
    return;
  }
  res.json({ ok: true });
});

wss.on("connection", (ws) => {
  const client = {
    id: crypto.randomUUID(),
    ws,
    name: null,
    roomId: null,
  };

  ws.on("message", (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (message.type === "join-room") {
      const room = rooms.get(message.roomId);
      if (!room) {
        ws.send(JSON.stringify({ type: "error", message: "Room not found" }));
        return;
      }

      const requestedName = String(message.name || "Guest").slice(0, 32);
      const existing = nameIndex.get(requestedName);
      if (existing && existing !== client) {
        removeClientFromRoom(existing);
        unregisterClient(existing);
        existing.ws.send(
          JSON.stringify({
            type: "kicked",
            reason: "Name joined another room",
          })
        );
      }

      if (client.roomId && client.roomId !== room.id) {
        removeClientFromRoom(client);
      }

      unregisterClient(client);
      client.name = requestedName;
      client.roomId = room.id;
      nameIndex.set(client.name, client);
      room.clients.add(client);

      const peers = Array.from(room.clients)
        .filter((peer) => peer.id !== client.id)
        .map((peer) => ({ id: peer.id, name: peer.name || "Guest" }));

      ws.send(
        JSON.stringify({
          type: "joined",
          roomId: room.id,
          clientId: client.id,
          peers,
        })
      );

      const joinedPayload = JSON.stringify({
        type: "peer-joined",
        id: client.id,
        name: client.name,
      });
      for (const peer of room.clients) {
        if (peer.id !== client.id) {
          peer.ws.send(joinedPayload);
        }
      }
      return;
    }

    if (message.type === "leave-room") {
      removeClientFromRoom(client);
      unregisterClient(client);
      return;
    }

    if (message.type === "signal") {
      const room = rooms.get(client.roomId);
      if (!room) return;
      const target = Array.from(room.clients).find(
        (peer) => peer.id === message.to
      );
      if (!target) return;
      target.ws.send(
        JSON.stringify({
          type: "signal",
          from: client.id,
          data: message.data,
        })
      );
      return;
    }
  });

  ws.on("close", () => {
    removeClientFromRoom(client);
    unregisterClient(client);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
