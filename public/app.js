const app = document.querySelector("#app");
const tokenKey = "roomix_token";
const userKey = "roomix_user";

let state = {
  token: localStorage.getItem(tokenKey),
  user: JSON.parse(localStorage.getItem(userKey) || "null"),
  rooms: [],
  currentRoom: null,
  socket: null,
  localStream: null,
  peers: new Map(),
  participants: [],
  cameraOn: true,
  micOn: true
};

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

function html(strings, ...values) {
  return strings.reduce((result, string, index) => result + string + (values[index] ?? ""), "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setAuth(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem(tokenKey, token);
  localStorage.setItem(userKey, JSON.stringify(user));
}

function logout() {
  closeRoom();
  state.token = null;
  state.user = null;
  localStorage.removeItem(tokenKey);
  localStorage.removeItem(userKey);
  renderAuth();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Ошибка запроса");
  }

  return data;
}

function notice(message, type = "info") {
  const existing = document.querySelector("#toast");
  existing?.remove();

  const toast = document.createElement("div");
  toast.id = "toast";
  toast.className = "toast toast-top toast-end z-50";
  toast.innerHTML = `<div class="alert alert-${type}"><span>${escapeHtml(message)}</span></div>`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

function renderAuth(mode = "login") {
  const isLogin = mode === "login";

  app.innerHTML = html`
    <section class="flex min-h-screen items-center justify-center bg-base-200 p-4">
      <div class="w-full max-w-md rounded-lg bg-base-100 p-6 shadow">
        <div class="mb-6">
          <h1 class="text-3xl font-bold">Roomix</h1>
          <p class="mt-2 text-sm text-base-content/70">Видеоконференции с комнатами, чатом и авторизацией.</p>
        </div>
        <form id="authForm" class="space-y-4">
          <input name="name" class="${isLogin ? "hidden" : ""} input input-bordered w-full" placeholder="Имя" autocomplete="name" />
          <input name="email" class="input input-bordered w-full" placeholder="Email" type="email" autocomplete="email" required />
          <input name="password" class="input input-bordered w-full" placeholder="Пароль" type="password" autocomplete="${isLogin ? "current-password" : "new-password"}" required />
          <button class="btn btn-primary w-full" type="submit">${isLogin ? "Войти" : "Создать аккаунт"}</button>
        </form>
        <button id="switchAuth" class="btn btn-ghost mt-3 w-full" type="button">
          ${isLogin ? "Нужен аккаунт" : "Уже есть аккаунт"}
        </button>
      </div>
    </section>
  `;

  document.querySelector("#switchAuth").addEventListener("click", () => renderAuth(isLogin ? "register" : "login"));
  document.querySelector("#authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());

    try {
      const data = await api(`/api/auth/${isLogin ? "login" : "register"}`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
      setAuth(data.token, data.user);
      await loadRooms();
      renderLobby();
    } catch (error) {
      notice(error.message, "error");
    }
  });
}

async function loadRooms() {
  const data = await api("/api/rooms");
  state.rooms = data.rooms;
}

function renderLobby() {
  app.innerHTML = html`
    <section class="min-h-screen bg-base-200">
      <header class="border-b border-base-300 bg-base-100">
        <div class="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div>
            <h1 class="text-2xl font-bold">Roomix</h1>
            <p class="text-sm text-base-content/70">${escapeHtml(state.user.name)}</p>
          </div>
          <button id="logout" class="btn btn-ghost btn-sm">Выйти</button>
        </div>
      </header>

      <div class="mx-auto grid max-w-6xl gap-6 px-4 py-6 lg:grid-cols-[360px_1fr]">
        <aside class="space-y-4">
          <form id="createRoom" class="rounded-lg bg-base-100 p-4 shadow-sm">
            <h2 class="mb-3 text-lg font-semibold">Новая комната</h2>
            <input name="title" class="input input-bordered mb-3 w-full" placeholder="Название" required />
            <textarea name="description" class="textarea textarea-bordered mb-3 w-full" placeholder="Описание"></textarea>
            <button class="btn btn-primary w-full" type="submit">Создать и открыть</button>
          </form>

          <form id="joinRoom" class="rounded-lg bg-base-100 p-4 shadow-sm">
            <h2 class="mb-3 text-lg font-semibold">Войти по коду</h2>
            <input name="accessCode" class="input input-bordered mb-3 w-full uppercase" placeholder="Код комнаты" required />
            <button class="btn btn-secondary w-full" type="submit">Присоединиться</button>
          </form>
        </aside>

        <section class="min-w-0">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-xl font-semibold">Активные комнаты</h2>
            <button id="refreshRooms" class="btn btn-outline btn-sm">Обновить</button>
          </div>
          <div id="rooms" class="grid gap-3 md:grid-cols-2"></div>
        </section>
      </div>
    </section>
  `;

  document.querySelector("#logout").addEventListener("click", logout);
  document.querySelector("#refreshRooms").addEventListener("click", async () => {
    await loadRooms();
    drawRooms();
  });
  document.querySelector("#createRoom").addEventListener("submit", createRoom);
  document.querySelector("#joinRoom").addEventListener("submit", joinRoomByCode);
  drawRooms();
}

function drawRooms() {
  const rooms = document.querySelector("#rooms");

  if (!state.rooms.length) {
    rooms.innerHTML = `<div class="rounded-lg bg-base-100 p-6 text-base-content/70 shadow-sm">Комнат пока нет.</div>`;
    return;
  }

  rooms.innerHTML = state.rooms
    .map(
      (room) => html`
        <article class="rounded-lg bg-base-100 p-4 shadow-sm">
          <div class="mb-3 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="truncate font-semibold">${escapeHtml(room.title)}</h3>
              <p class="mt-1 line-clamp-2 text-sm text-base-content/70">${escapeHtml(room.description || "Без описания")}</p>
            </div>
            <span class="badge badge-outline">${escapeHtml(room.accessCode)}</span>
          </div>
          <div class="mb-4 text-xs text-base-content/60">Создал: ${escapeHtml(room.owner.name)}</div>
          <button class="btn btn-primary btn-sm w-full" data-room="${room.id}">Открыть</button>
        </article>
      `
    )
    .join("");

  rooms.querySelectorAll("[data-room]").forEach((button) => {
    button.addEventListener("click", () => openRoom(button.dataset.room));
  });
}

async function createRoom(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());

  try {
    const data = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    await openRoom(data.room.id);
  } catch (error) {
    notice(error.message, "error");
  }
}

async function joinRoomByCode(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());

  try {
    const data = await api("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    await openRoom(data.room.id);
  } catch (error) {
    notice(error.message, "error");
  }
}

async function openRoom(roomId) {
  try {
    const data = await api(`/api/rooms/${roomId}`);
    state.currentRoom = data.room;
    renderRoom();
    await startMedia();
    connectSocket();
    drawMessages(data.room.messages);
  } catch (error) {
    notice(error.message, "error");
  }
}

function renderRoom() {
  const room = state.currentRoom;
  app.innerHTML = html`
    <section class="grid min-h-screen bg-base-200 lg:grid-cols-[1fr_360px]">
      <div class="flex min-w-0 flex-col">
        <header class="border-b border-base-300 bg-base-100 px-4 py-3">
          <div class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
            <div class="min-w-0">
              <h1 class="truncate text-xl font-bold">${escapeHtml(room.title)}</h1>
              <p class="text-sm text-base-content/70">Код: <span class="font-mono">${escapeHtml(room.accessCode)}</span></p>
            </div>
            <div class="flex gap-2">
              <button id="toggleMic" class="btn btn-outline btn-sm">Микрофон</button>
              <button id="toggleCamera" class="btn btn-outline btn-sm">Камера</button>
              <button id="leaveRoom" class="btn btn-error btn-sm">Выйти</button>
            </div>
          </div>
        </header>

        <div id="videos" class="grid flex-1 auto-rows-fr gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3"></div>
      </div>

      <aside class="flex min-h-[420px] flex-col border-l border-base-300 bg-base-100">
        <div class="border-b border-base-300 p-4">
          <h2 class="font-semibold">Участники</h2>
          <div id="participants" class="mt-2 flex flex-wrap gap-2"></div>
        </div>
        <div id="messages" class="flex-1 space-y-3 overflow-y-auto p-4"></div>
        <form id="chatForm" class="flex gap-2 border-t border-base-300 p-3">
          <input name="text" class="input input-bordered input-sm min-w-0 flex-1" placeholder="Сообщение" autocomplete="off" />
          <button class="btn btn-primary btn-sm" type="submit">Отправить</button>
        </form>
      </aside>
    </section>
  `;

  document.querySelector("#leaveRoom").addEventListener("click", leaveRoom);
  document.querySelector("#toggleMic").addEventListener("click", toggleMic);
  document.querySelector("#toggleCamera").addEventListener("click", toggleCamera);
  document.querySelector("#chatForm").addEventListener("submit", sendMessage);
  drawLocalVideo();
}

async function startMedia() {
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    state.localStream = new MediaStream();
    notice("Камера или микрофон недоступны. Можно пользоваться чатом.", "warning");
  }

  drawLocalVideo();
}

function drawLocalVideo() {
  const videos = document.querySelector("#videos");
  if (!videos) return;

  let tile = document.querySelector("#localTile");
  if (!tile) {
    tile = document.createElement("div");
    tile.id = "localTile";
    tile.className = "video-tile";
    tile.innerHTML = `<video id="localVideo" autoplay playsinline muted></video><span class="video-name">Вы</span>`;
    videos.prepend(tile);
  }

  document.querySelector("#localVideo").srcObject = state.localStream;
}

function connectSocket() {
  closeSocketOnly();
  state.socket = io({ auth: { token: state.token } });

  state.socket.on("connect", () => {
    state.socket.emit("room:join", { roomId: state.currentRoom.id }, async (response) => {
      if (!response?.ok) {
        notice(response?.error || "Не удалось войти в комнату", "error");
        return;
      }

      for (const peer of response.peers) {
        await createPeer(peer.socketId, true, peer);
      }
    });
  });

  state.socket.on("room:participants", ({ participants }) => {
    state.participants = participants;
    drawParticipants();
  });

  state.socket.on("peer:joined", ({ peer }) => {
    state.participants = [...state.participants.filter((item) => item.socketId !== peer.socketId), peer];
    drawParticipants();
  });

  state.socket.on("peer:left", ({ socketId }) => {
    removePeer(socketId);
  });

  state.socket.on("signal:offer", async ({ from, peer, description }) => {
    const connection = await createPeer(from, false, peer);
    await connection.setRemoteDescription(description);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    state.socket.emit("signal:answer", { to: from, description: answer });
  });

  state.socket.on("signal:answer", async ({ from, description }) => {
    const connection = state.peers.get(from)?.connection;
    if (connection) {
      await connection.setRemoteDescription(description);
    }
  });

  state.socket.on("signal:ice", async ({ from, candidate }) => {
    const connection = state.peers.get(from)?.connection;
    if (connection && candidate) {
      await connection.addIceCandidate(candidate);
    }
  });

  state.socket.on("chat:message", ({ message }) => appendMessage(message));
}

async function createPeer(socketId, initiator, peer) {
  if (state.peers.has(socketId)) {
    return state.peers.get(socketId).connection;
  }

  const connection = new RTCPeerConnection(rtcConfig);
  const stream = new MediaStream();
  state.peers.set(socketId, { connection, stream, peer });

  state.localStream?.getTracks().forEach((track) => {
    connection.addTrack(track, state.localStream);
  });

  connection.onicecandidate = (event) => {
    if (event.candidate) {
      state.socket.emit("signal:ice", { to: socketId, candidate: event.candidate });
    }
  };

  connection.ontrack = (event) => {
    event.streams[0].getTracks().forEach((track) => stream.addTrack(track));
    drawRemoteVideo(socketId, stream, peer);
  };

  connection.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(connection.connectionState)) {
      removePeer(socketId);
    }
  };

  drawRemoteVideo(socketId, stream, peer);

  if (initiator) {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    state.socket.emit("signal:offer", { to: socketId, description: offer });
  }

  return connection;
}

function drawRemoteVideo(socketId, stream, peer) {
  const videos = document.querySelector("#videos");
  if (!videos) return;

  let tile = document.querySelector(`[data-peer-tile="${socketId}"]`);
  if (!tile) {
    tile = document.createElement("div");
    tile.dataset.peerTile = socketId;
    tile.className = "video-tile";
    tile.innerHTML = `<video autoplay playsinline></video><span class="video-name">${escapeHtml(peer?.name || "Участник")}</span>`;
    videos.appendChild(tile);
  }

  tile.querySelector("video").srcObject = stream;
}

function removePeer(socketId) {
  const peer = state.peers.get(socketId);
  peer?.connection.close();
  state.peers.delete(socketId);
  document.querySelector(`[data-peer-tile="${socketId}"]`)?.remove();
}

function drawParticipants() {
  const list = document.querySelector("#participants");
  if (!list) return;

  list.innerHTML = state.participants
    .map((participant) => `<span class="badge badge-neutral">${escapeHtml(participant.name)}</span>`)
    .join("");
}

function drawMessages(messages) {
  document.querySelector("#messages").innerHTML = "";
  messages.forEach(appendMessage);
}

function appendMessage(message) {
  const messages = document.querySelector("#messages");
  if (!messages) return;

  const own = message.user.id === state.user.id;
  const row = document.createElement("div");
  row.className = `chat ${own ? "chat-end" : "chat-start"}`;
  row.innerHTML = html`
    <div class="chat-header text-xs">${escapeHtml(message.user.name)}</div>
    <div class="chat-bubble ${own ? "chat-bubble-primary" : ""}">${escapeHtml(message.text)}</div>
  `;
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
}

function sendMessage(event) {
  event.preventDefault();
  const input = event.currentTarget.elements.text;
  const text = input.value.trim();

  if (!text) return;

  state.socket.emit("chat:message", { roomId: state.currentRoom.id, text }, (response) => {
    if (!response?.ok) {
      notice(response?.error || "Не удалось отправить сообщение", "error");
    }
  });
  input.value = "";
}

function toggleMic() {
  state.micOn = !state.micOn;
  state.localStream?.getAudioTracks().forEach((track) => {
    track.enabled = state.micOn;
  });
  document.querySelector("#toggleMic").classList.toggle("btn-active", state.micOn);
}

function toggleCamera() {
  state.cameraOn = !state.cameraOn;
  state.localStream?.getVideoTracks().forEach((track) => {
    track.enabled = state.cameraOn;
  });
  document.querySelector("#toggleCamera").classList.toggle("btn-active", state.cameraOn);
}

function closeSocketOnly() {
  state.socket?.disconnect();
  state.socket = null;
  state.peers.forEach(({ connection }) => connection.close());
  state.peers.clear();
}

function closeRoom() {
  closeSocketOnly();
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.localStream = null;
  state.currentRoom = null;
  state.participants = [];
}

async function leaveRoom() {
  closeRoom();
  await loadRooms();
  renderLobby();
}

async function bootstrap() {
  if (!state.token) {
    renderAuth();
    return;
  }

  try {
    const data = await api("/api/me");
    state.user = data.user;
    localStorage.setItem(userKey, JSON.stringify(data.user));
    await loadRooms();
    renderLobby();
  } catch {
    logout();
  }
}

bootstrap();
