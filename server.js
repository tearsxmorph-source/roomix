import "dotenv/config";
import bcrypt from "bcrypt";
import express from "express";
import http from "http";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { Server } from "socket.io";
import { randomBytes } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const prisma = new PrismaClient();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "development-secret-change-me";
const activeUsers = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, {
    expiresIn: "7d"
  });
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt
  };
}

function roomCode() {
  return randomBytes(4).toString("hex").toUpperCase();
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Требуется авторизация" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });

    if (!user) {
      return res.status(401).json({ error: "Пользователь не найден" });
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Недействительный токен" });
  }
}

app.post("/api/auth/register", async (req, res) => {
  const { email, name, password } = req.body;

  if (!email || !name || !password || password.length < 6) {
    return res.status(400).json({ error: "Укажите имя, email и пароль от 6 символов" });
  }

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) {
    return res.status(409).json({ error: "Пользователь с таким email уже существует" });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      email: String(email).toLowerCase().trim(),
      name: String(name).trim(),
      passwordHash
    }
  });

  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Укажите email и пароль" });
  }

  const user = await prisma.user.findUnique({
    where: { email: String(email).toLowerCase().trim() }
  });

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: "Неверный email или пароль" });
  }

  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get("/api/rooms", authMiddleware, async (req, res) => {
  const rooms = await prisma.room.findMany({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
    include: {
      owner: { select: { id: true, name: true } },
      _count: { select: { messages: true } }
    }
  });

  res.json({ rooms });
});

app.post("/api/rooms", authMiddleware, async (req, res) => {
  const { title, description } = req.body;

  if (!title || String(title).trim().length < 3) {
    return res.status(400).json({ error: "Название комнаты должно быть не короче 3 символов" });
  }

  const room = await prisma.room.create({
    data: {
      title: String(title).trim(),
      description: description ? String(description).trim() : null,
      accessCode: roomCode(),
      ownerId: req.user.id
    },
    include: {
      owner: { select: { id: true, name: true } },
      _count: { select: { messages: true } }
    }
  });

  res.status(201).json({ room });
});

app.get("/api/rooms/:id", authMiddleware, async (req, res) => {
  const room = await prisma.room.findFirst({
    where: { id: req.params.id, isActive: true },
    include: {
      owner: { select: { id: true, name: true } },
      messages: {
        take: 50,
        orderBy: { createdAt: "asc" },
        include: { user: { select: { id: true, name: true } } }
      }
    }
  });

  if (!room) {
    return res.status(404).json({ error: "Комната не найдена" });
  }

  res.json({ room });
});

app.post("/api/rooms/join", authMiddleware, async (req, res) => {
  const { accessCode } = req.body;
  const room = await prisma.room.findFirst({
    where: { accessCode: String(accessCode || "").trim().toUpperCase(), isActive: true },
    include: {
      owner: { select: { id: true, name: true } },
      _count: { select: { messages: true } }
    }
  });

  if (!room) {
    return res.status(404).json({ error: "Комната с таким кодом не найдена" });
  }

  res.json({ room });
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });

    if (!user) {
      return next(new Error("Пользователь не найден"));
    }

    socket.user = publicUser(user);
    next();
  } catch {
    next(new Error("Недействительный токен"));
  }
});

io.on("connection", (socket) => {
  socket.on("room:join", async ({ roomId }, ack) => {
    const room = await prisma.room.findFirst({ where: { id: roomId, isActive: true } });

    if (!room) {
      return ack?.({ ok: false, error: "Комната не найдена" });
    }

    socket.join(roomId);
    socket.roomId = roomId;
    activeUsers.set(socket.id, { ...socket.user, socketId: socket.id, roomId });

    await prisma.participant.create({
      data: { userId: socket.user.id, roomId }
    });

    const peers = [...activeUsers.values()].filter((peer) => peer.roomId === roomId);
    socket.to(roomId).emit("peer:joined", { peer: activeUsers.get(socket.id) });
    io.to(roomId).emit("room:participants", { participants: peers });
    ack?.({ ok: true, peers: peers.filter((peer) => peer.socketId !== socket.id) });
  });

  socket.on("signal:offer", ({ to, description }) => {
    io.to(to).emit("signal:offer", {
      from: socket.id,
      peer: activeUsers.get(socket.id),
      description
    });
  });

  socket.on("signal:answer", ({ to, description }) => {
    io.to(to).emit("signal:answer", { from: socket.id, description });
  });

  socket.on("signal:ice", ({ to, candidate }) => {
    io.to(to).emit("signal:ice", { from: socket.id, candidate });
  });

  socket.on("chat:message", async ({ roomId, text }, ack) => {
    const cleanText = String(text || "").trim();

    if (!cleanText) {
      return ack?.({ ok: false, error: "Сообщение пустое" });
    }

    const message = await prisma.message.create({
      data: {
        text: cleanText.slice(0, 1000),
        roomId,
        userId: socket.user.id
      },
      include: { user: { select: { id: true, name: true } } }
    });

    io.to(roomId).emit("chat:message", { message });
    ack?.({ ok: true });
  });

  socket.on("disconnect", async () => {
    const participant = activeUsers.get(socket.id);

    if (!participant) {
      return;
    }

    activeUsers.delete(socket.id);

    await prisma.participant.updateMany({
      where: { userId: participant.id, roomId: participant.roomId, leftAt: null },
      data: { leftAt: new Date() }
    });

    const participants = [...activeUsers.values()].filter((peer) => peer.roomId === participant.roomId);
    socket.to(participant.roomId).emit("peer:left", { socketId: socket.id });
    io.to(participant.roomId).emit("room:participants", { participants });
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log(`Roomix is running at http://localhost:${PORT}`);
});
