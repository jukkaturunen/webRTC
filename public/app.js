const roomListEl = document.getElementById("roomList");
const createRoomForm = document.getElementById("createRoomForm");
const sessionView = document.getElementById("sessionView");
const joinDialog = document.getElementById("joinDialog");
const joinForm = document.getElementById("joinForm");
const joinRoomName = document.getElementById("joinRoomName");
const cancelJoin = document.getElementById("cancelJoin");
const connectionStatus = document.getElementById("connectionStatus");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const audioBin = document.createElement("div");
audioBin.style.display = "none";
document.body.appendChild(audioBin);

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

let ws = null;
let wsState = "connecting";
let reconnectAttempts = 0;
let reconnectTimer = null;
const maxReconnectAttempts = 6;

let rooms = [];
let currentRoomId = null;
let currentRoomName = "";
let screenName = "";
let clientId = null;
let pendingJoinRoomId = null;
let localStream = null;
let preferredDeviceId = null;
let isSwitchingDevice = false;
let testToneEnabled = false;
let testToneContext = null;
let testToneOscillator = null;
let testToneGain = null;
let testToneDestination = null;
let testToneTrack = null;
let meterContext = null;
let meterAnimation = null;
const meters = new Map();
const meterBars = new Map();
let audioInputs = [];
let deviceRefreshInFlight = false;
const peers = new Map();

function setConnectionState(state) {
  wsState = state;
  connectionStatus.classList.remove("connected", "reconnecting", "disconnected");
  if (state === "connected") {
    connectionStatus.classList.add("connected");
    statusText.textContent = "Connected";
    statusDot.style.background = "var(--success)";
  } else if (state === "reconnecting") {
    connectionStatus.classList.add("reconnecting");
    statusText.textContent = "Reconnecting…";
    statusDot.style.background = "var(--warning)";
  } else if (state === "disconnected") {
    connectionStatus.classList.add("disconnected");
    statusText.textContent = "Disconnected";
    statusDot.style.background = "var(--danger)";
  } else {
    statusText.textContent = "Connecting…";
    statusDot.style.background = "var(--muted)";
  }
}

function wsUrl() {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}`;
}

function connectWebSocket() {
  if (ws) {
    ws.close();
  }
  setConnectionState("connecting");
  ws = new WebSocket(wsUrl());

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    setConnectionState("connected");
    if (pendingJoinRoomId && screenName) {
      sendMessage({
        type: "join-room",
        roomId: pendingJoinRoomId,
        name: screenName,
      });
    }
  });

  ws.addEventListener("close", () => {
    cleanupPeerConnections();
    if (reconnectAttempts < maxReconnectAttempts) {
      reconnectAttempts += 1;
      setConnectionState("reconnecting");
      const delay = Math.min(1000 * reconnectAttempts, 5000);
      reconnectTimer = setTimeout(connectWebSocket, delay);
    } else {
      setConnectionState("disconnected");
    }
  });

  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (err) {
      return;
    }

    if (message.type === "joined") {
      currentRoomId = message.roomId;
      pendingJoinRoomId = message.roomId;
      clientId = message.clientId;
      message.peers.forEach((peer) => {
        createPeerConnection(peer.id, peer.name);
        createOffer(peer.id);
      });
      updateSessionView();
      return;
    }

    if (message.type === "peer-joined") {
      createPeerConnection(message.id, message.name);
      updateSessionView();
      return;
    }

    if (message.type === "peer-left") {
      removePeer(message.id);
      updateSessionView();
      return;
    }

    if (message.type === "room-deleted") {
      if (currentRoomId === message.roomId) {
        leaveRoom(true);
      }
      return;
    }

    if (message.type === "signal") {
      handleSignal(message.from, message.data);
      return;
    }

    if (message.type === "error") {
      alert(message.message || "An error occurred.");
    }

    if (message.type === "kicked") {
      leaveRoom(true);
      alert("You were disconnected because the same name joined another room.");
    }
  });
}

function sendMessage(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

async function fetchRooms() {
  const res = await fetch("/api/rooms");
  const data = await res.json();
  rooms = data.rooms || [];
  renderRoomList();
}

function renderRoomList() {
  roomListEl.innerHTML = "";
  if (!rooms.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No rooms yet.";
    roomListEl.appendChild(empty);
    return;
  }

  rooms.forEach((room) => {
    const card = document.createElement("div");
    card.className = "room";

    const title = document.createElement("h3");
    title.textContent = room.name;

    const meta = document.createElement("p");
    meta.className = "muted";
    meta.textContent = `${room.count} participant${room.count === 1 ? "" : "s"}`;

    const actions = document.createElement("div");
    actions.className = "room-actions";

    const joinBtn = document.createElement("button");
    joinBtn.textContent = "Join";
    joinBtn.addEventListener("click", () => openJoinDialog(room));

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "danger";
    deleteBtn.addEventListener("click", () => deleteRoom(room.id));

    actions.append(joinBtn, deleteBtn);
    card.append(title, meta, actions);
    roomListEl.appendChild(card);
  });
}

function openJoinDialog(room) {
  if (currentRoomId && currentRoomId === room.id) {
    return;
  }
  pendingJoinRoomId = room.id;
  currentRoomName = room.name;
  joinRoomName.textContent = `Room: ${room.name}`;
  joinForm.reset();
  joinDialog.showModal();
}

function closeJoinDialog() {
  joinDialog.close();
}

async function deleteRoom(roomId) {
  if (!confirm("Delete this room?")) return;
  await fetch(`/api/rooms/${roomId}`, { method: "DELETE" });
  await fetchRooms();
}

async function createRoom(name) {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return;
  await fetchRooms();
}

function buildAudioConstraints() {
  const base = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 48000,
    sampleSize: 16,
  };
  if (preferredDeviceId) {
    return { ...base, deviceId: { exact: preferredDeviceId } };
  }
  return base;
}

async function pickPreferredAudioDevice() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  audioInputs = devices.filter((d) => d.kind === "audioinput");
  if (!audioInputs.length) return;
  const bluetooth = audioInputs.find((d) =>
    /bluetooth|airpods|headset|bt/i.test(d.label || "")
  );
  if (bluetooth) {
    preferredDeviceId = bluetooth.deviceId;
  } else if (!preferredDeviceId) {
    preferredDeviceId = audioInputs[0].deviceId;
  }
}

async function startLocalStream({ force = false } = {}) {
  if (localStream && !force) return localStream;
  if (isSwitchingDevice) return localStream;
  isSwitchingDevice = true;
  try {
    await pickPreferredAudioDevice();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(),
      });
    } catch (err) {
      // Fallback if exact device constraints fail.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    localStream = stream;
    const settings = localStream.getAudioTracks?.()[0]?.getSettings?.();
    if (!preferredDeviceId && settings?.deviceId) {
      preferredDeviceId = settings.deviceId;
    }
    ensureMeterContext();
    if (meterContext && meterContext.state === "suspended") {
      meterContext.resume();
    }
    updateOutgoingTracks();
    ensureLocalMeter();
    return localStream;
  } finally {
    isSwitchingDevice = false;
  }
}

async function ensureLocalStream() {
  return startLocalStream({ force: false });
}

function getOutgoingTracks() {
  if (testToneEnabled && testToneTrack) {
    return [testToneTrack];
  }
  if (!localStream) return [];
  return localStream.getAudioTracks();
}

function ensureMeterContext() {
  if (!meterContext) {
    meterContext = new AudioContext();
  }
  return meterContext;
}

function startMeterLoop() {
  if (meterAnimation) return;
  const tick = () => {
    meters.forEach((meter, id) => {
      const bar = meterBars.get(id);
      if (!bar) return;
      meter.analyser.getFloatTimeDomainData(meter.data);
      let sum = 0;
      for (let i = 0; i < meter.data.length; i += 1) {
        const sample = meter.data[i];
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / meter.data.length);
      const level = Math.min(rms * 3, 1);
      bar.style.width = `${Math.round(level * 100)}%`;
    });
    meterAnimation = requestAnimationFrame(tick);
  };
  meterAnimation = requestAnimationFrame(tick);
}

function createMeter(id, stream, trackId) {
  if (!stream) return;
  const ctx = ensureMeterContext();
  if (ctx.state === "suspended") {
    ctx.resume();
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  meters.set(id, { analyser, data, source, trackId });
  startMeterLoop();
}

function removeMeter(id) {
  const meter = meters.get(id);
  if (meter) {
    try {
      meter.source.disconnect();
    } catch (err) {
      // ignore
    }
  }
  meters.delete(id);
  meterBars.delete(id);
}

function syncMeterBarsFromDOM() {
  meterBars.clear();
  document.querySelectorAll(".meter-bar[data-meter-id]").forEach((el) => {
    meterBars.set(el.dataset.meterId, el);
  });
}

function renderMicSelector(container) {
  const wrapper = document.createElement("div");
  const label = document.createElement("label");
  label.textContent = "Microphone";
  label.className = "muted";
  const select = document.createElement("select");
  select.id = "micSelect";

  if (!audioInputs.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Loading microphones…";
    select.appendChild(opt);
    if (!deviceRefreshInFlight) {
      deviceRefreshInFlight = true;
      pickPreferredAudioDevice()
        .catch(() => {})
        .finally(() => {
          deviceRefreshInFlight = false;
          updateSessionView();
        });
    }
  } else {
    audioInputs.forEach((device) => {
      const opt = document.createElement("option");
      opt.value = device.deviceId;
      opt.textContent = device.label || "Microphone";
      select.appendChild(opt);
    });
    select.value = preferredDeviceId || audioInputs[0].deviceId;
  }

  select.addEventListener("change", async (event) => {
    const value = event.target.value;
    if (!value) return;
    preferredDeviceId = value;
    await startLocalStream({ force: true });
  });

  wrapper.append(label, select);
  container.appendChild(wrapper);
}

function ensureLocalMeter() {
  const track = getOutgoingTracks()[0];
  if (!track) return;
  const existing = meters.get("local");
  if (existing && existing.trackId === track.id) return;
  if (existing) removeMeter("local");
  const stream = new MediaStream([track]);
  createMeter("local", stream, track.id);
}

function ensurePeerMeter(peerId, stream) {
  const track = stream?.getAudioTracks?.()[0];
  if (!track) return;
  const existing = meters.get(peerId);
  if (existing && existing.trackId === track.id) return;
  if (existing) removeMeter(peerId);
  createMeter(peerId, stream, track.id);
}

function ensureTestToneTrack() {
  if (testToneTrack) return testToneTrack;
  testToneContext = new AudioContext();
  testToneDestination = testToneContext.createMediaStreamDestination();
  testToneOscillator = testToneContext.createOscillator();
  testToneGain = testToneContext.createGain();
  testToneOscillator.type = "sine";
  testToneOscillator.frequency.value = 440;
  testToneGain.gain.value = 0.2;
  testToneOscillator.connect(testToneGain).connect(testToneDestination);
  testToneOscillator.start();
  testToneTrack = testToneDestination.stream.getAudioTracks()[0];
  testToneTrack.enabled = true;
  return testToneTrack;
}

function stopTestTone() {
  if (testToneOscillator) testToneOscillator.stop();
  if (testToneContext) testToneContext.close();
  testToneContext = null;
  testToneOscillator = null;
  testToneGain = null;
  testToneDestination = null;
  testToneTrack = null;
}

function updateOutgoingTracks() {
  const tracks = getOutgoingTracks();
  const track = tracks[0] || null;
  peers.forEach((peer) => {
    const sender = peer.pc
      .getSenders()
      .find((s) => s.track && s.track.kind === "audio");
    if (sender) {
      sender.replaceTrack(track);
    } else if (track) {
      peer.pc.addTrack(track, new MediaStream([track]));
    }
  });
  ensureLocalMeter();
}

function toggleTestTone() {
  testToneEnabled = !testToneEnabled;
  if (testToneEnabled) {
    ensureTestToneTrack();
    if (testToneContext && testToneContext.state === "suspended") {
      testToneContext.resume();
    }
  } else {
    stopTestTone();
    startLocalStream({ force: true });
  }
  updateOutgoingTracks();
  updateSessionView();
}

function createPeerConnection(peerId, peerName) {
  if (peers.has(peerId)) return;
  const pc = new RTCPeerConnection(rtcConfig);
  const peer = {
    id: peerId,
    name: peerName || "Guest",
    pc,
    audio: null,
    stream: null,
  };
  peers.set(peerId, peer);

  const outgoingTracks = getOutgoingTracks();
  outgoingTracks.forEach((track) =>
    pc.addTrack(track, new MediaStream([track]))
  );

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendMessage({
        type: "signal",
        to: peerId,
        data: { type: "ice", candidate: event.candidate },
      });
    }
  });

  pc.addEventListener("track", (event) => {
    if (!peer.audio) {
      peer.audio = document.createElement("audio");
      peer.audio.autoplay = true;
      peer.audio.playsInline = true;
      audioBin.appendChild(peer.audio);
    }
    peer.stream = event.streams[0];
    peer.audio.srcObject = peer.stream;
    ensurePeerMeter(peer.id, peer.stream);
  });

  pc.addEventListener("connectionstatechange", () => {
    updateSessionView();
  });
}

async function createOffer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  sendMessage({
    type: "signal",
    to: peerId,
    data: { type: "offer", sdp: offer },
  });
}

async function handleSignal(from, data) {
  if (!peers.has(from)) {
    createPeerConnection(from, "Guest");
  }
  const peer = peers.get(from);
  const pc = peer.pc;

  if (data.type === "offer") {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendMessage({
      type: "signal",
      to: from,
      data: { type: "answer", sdp: answer },
    });
  }

  if (data.type === "answer") {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  }

  if (data.type === "ice" && data.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      // Ignore ICE errors during reconnect.
    }
  }
}

function updateSessionView() {
  sessionView.innerHTML = "";
  if (!currentRoomId) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Not in a room.";
    sessionView.appendChild(empty);
    return;
  }

  const header = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = currentRoomName || "Room";
  const sub = document.createElement("p");
  sub.className = "muted";
  sub.textContent = `You are ${screenName || "Guest"}.`;

  const leaveBtn = document.createElement("button");
  leaveBtn.textContent = "Leave Room";
  leaveBtn.className = "secondary";
  leaveBtn.addEventListener("click", () => leaveRoom(false));

  const toneBtn = document.createElement("button");
  toneBtn.textContent = testToneEnabled ? "Stop Test Tone" : "Play Test Tone";
  toneBtn.className = "secondary";
  toneBtn.addEventListener("click", toggleTestTone);

  header.append(title, sub, leaveBtn, toneBtn);
  sessionView.appendChild(header);

  renderMicSelector(sessionView);

  const participantsTitle = document.createElement("h4");
  participantsTitle.textContent = "Participants";
  sessionView.appendChild(participantsTitle);

  const list = document.createElement("div");
  list.className = "participants";

  const you = document.createElement("div");
  you.className = "participant";
  const youStatus = testToneEnabled ? "Test tone" : "Mic on";
  const youName = document.createElement("span");
  youName.textContent = `${screenName || "Guest"} (you)`;
  const youMeter = document.createElement("div");
  youMeter.className = "meter";
  const youBar = document.createElement("div");
  youBar.className = "meter-bar";
  youBar.dataset.meterId = "local";
  youMeter.appendChild(youBar);
  const youMeta = document.createElement("em");
  youMeta.className = "muted";
  youMeta.textContent = youStatus;
  you.append(youName, youMeter, youMeta);
  list.appendChild(you);

  peers.forEach((peer) => {
    const item = document.createElement("div");
    item.className = "participant";
    const status = peer.pc.connectionState || "new";
    const name = document.createElement("span");
    name.textContent = peer.name;
    const meter = document.createElement("div");
    meter.className = "meter";
    const bar = document.createElement("div");
    bar.className = "meter-bar";
    bar.dataset.meterId = peer.id;
    meter.appendChild(bar);
    const meta = document.createElement("em");
    meta.className = "muted";
    meta.textContent = status;
    item.append(name, meter, meta);
    list.appendChild(item);
  });

  sessionView.appendChild(list);
  syncMeterBarsFromDOM();
  ensureLocalMeter();
  peers.forEach((peer) => {
    if (peer.stream) {
      ensurePeerMeter(peer.id, peer.stream);
    }
  });
}

function removePeer(peerId) {
  const peer = peers.get(peerId);
  if (!peer) return;
  peer.pc.close();
  if (peer.audio) {
    peer.audio.srcObject = null;
    peer.audio.remove();
  }
  removeMeter(peerId);
  peers.delete(peerId);
}

function cleanupPeerConnections() {
  peers.forEach((peer) => {
    peer.pc.close();
    if (peer.audio) {
      peer.audio.srcObject = null;
      peer.audio.remove();
    }
    removeMeter(peer.id);
  });
  peers.clear();
  updateSessionView();
}

async function joinRoom(roomId) {
  if (!roomId) return;
  pendingJoinRoomId = roomId;
  try {
    await ensureLocalStream();
  } catch (err) {
    alert("Microphone access is required to join a room.");
    return;
  }
  if (currentRoomId && currentRoomId !== roomId) {
    sendMessage({ type: "leave-room" });
    currentRoomId = null;
    currentRoomName = "";
  }
  cleanupPeerConnections();
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendMessage({ type: "join-room", roomId, name: screenName });
  }
}

function leaveRoom(silent) {
  if (!currentRoomId) return;
  sendMessage({ type: "leave-room" });
  currentRoomId = null;
  currentRoomName = "";
  pendingJoinRoomId = null;
  if (testToneEnabled) {
    testToneEnabled = false;
    stopTestTone();
  }
  removeMeter("local");
  cleanupPeerConnections();
  updateSessionView();
  if (!silent) {
    fetchRooms();
  }
}

createRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(createRoomForm);
  const name = data.get("roomName");
  if (!name) return;
  await createRoom(String(name));
  createRoomForm.reset();
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", async () => {
    if (testToneEnabled) return;
    await pickPreferredAudioDevice();
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioInputs = devices.filter((device) => device.kind === "audioinput");
    const currentTrack = localStream?.getAudioTracks?.()[0];
    if (currentTrack) {
      const settings = currentTrack.getSettings?.();
      const currentId = settings?.deviceId;
      const stillExists = audioInputs.some((d) => d.deviceId === currentId);
      if (!stillExists) {
        preferredDeviceId = audioInputs[0]?.deviceId || null;
        await startLocalStream({ force: true });
      }
    } else if (currentRoomId) {
      await startLocalStream({ force: true });
    }
    updateSessionView();
  });
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(joinForm);
  const name = String(data.get("screenName") || "Guest").trim();
  if (!name) return;
  screenName = name;
  const roomId = pendingJoinRoomId;
  closeJoinDialog();
  if (currentRoomId && currentRoomId !== roomId) {
    leaveRoom(true);
  }
  await joinRoom(roomId);
  updateSessionView();
});

cancelJoin.addEventListener("click", () => {
  closeJoinDialog();
  pendingJoinRoomId = null;
});

fetchRooms();
connectWebSocket();
setInterval(fetchRooms, 5000);
