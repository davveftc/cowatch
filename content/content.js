/**
 * CoWatch – content script (premium)
 * Injected into all major streaming platforms (including iframes).
 *
 * Supported: Netflix, YouTube, Disney+, Hulu, Amazon Prime Video,
 * HBO Max/Max, Crunchyroll, Peacock, Paramount+, Apple TV+, Tubi,
 * Pluto TV, Twitch, DopeBox, Plex, Vudu, Vimeo.
 *
 * Features: video sync, host-only controls, emoji reactions & picker,
 * drift correction, buffering detection, invite link, per-user colors,
 * kick/ban, password rooms, chat timestamps, typing indicators,
 * notification sounds, and WebRTC voice/video overlay.
 */
(() => {
  if (window.__cowatch_loaded) return;
  window.__cowatch_loaded = true;
  const IS_TOP = window === window.top;

  // ═══════════════════════════════════════════
  //  CONFIG & STATE
  // ═══════════════════════════════════════════

  const SEEK_THRESHOLD = 1.5;
  const DRIFT_INTERVAL = 5000; // ms
  const TYPING_TIMEOUT = 2000;

  const EMOJIS = [
    "\u{1F602}","\u{2764}\u{FE0F}","\u{1F525}","\u{1F44F}","\u{1F60D}",
    "\u{1F389}","\u{1F631}","\u{1F480}","\u{1F923}","\u{1F62D}",
    "\u{1F440}","\u{1F4AF}","\u{1F64C}","\u{1F60E}","\u{1F92F}",
    "\u{1F44D}","\u{1F622}","\u{1F97A}","\u{1F621}","\u{1F922}",
  ];

  const USER_COLORS = [
    "#f87171","#fb923c","#fbbf24","#a3e635","#34d399",
    "#22d3ee","#60a5fa","#a78bfa","#f472b6","#e879f9",
  ];

  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const state = {
    ws: null,
    video: null,
    roomId: null,
    username: "Guest",
    serverUrl: "ws://localhost:3000",
    members: [],
    connected: false,
    isHost: false,
    hostOnly: false,
    isSyncing: false,
    syncTimeout: null,
    panelOpen: false,
    driftTimer: null,
    typingTimer: null,
    typingUsers: new Set(),
    wasPlayingBeforeBuffer: false,
    someoneBuffering: false,
    // WebRTC
    localStream: null,
    peers: new Map(), // id -> { pc, username, audioEnabled, videoEnabled }
    myMediaAudio: false,
    myMediaVideo: false,
  };

  // ═══════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════

  function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  function getUserColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return USER_COLORS[Math.abs(h) % USER_COLORS.length];
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const h = d.getHours(), m = d.getMinutes();
    return `${h % 12 || 12}:${m < 10 ? "0" : ""}${m} ${h >= 12 ? "PM" : "AM"}`;
  }

  // ═══════════════════════════════════════════
  //  NOTIFICATION SOUNDS (Web Audio API)
  // ═══════════════════════════════════════════

  let _audioCtx;
  function audioCtx() { if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return _audioCtx; }

  function playSound(type) {
    try {
      const ctx = audioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);

      switch (type) {
        case "join":
          osc.type = "sine"; osc.frequency.value = 880;
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
          osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.25);
          break;
        case "leave":
          osc.type = "sine"; osc.frequency.value = 440;
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
          osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3);
          break;
        case "message":
          osc.type = "triangle"; osc.frequency.value = 660;
          gain.gain.setValueAtTime(0.05, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
          osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.15);
          break;
        case "kick":
          osc.type = "sawtooth"; osc.frequency.value = 200;
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
          osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.4);
          break;
      }
    } catch { /* audio not available */ }
  }

  // ═══════════════════════════════════════════
  //  PLATFORM DETECTION
  // ═══════════════════════════════════════════

  const PLATFORM = (() => {
    const h = location.hostname;
    if (h.includes("netflix.com"))       return "netflix";
    if (h.includes("youtube.com"))       return "youtube";
    if (h.includes("disneyplus.com"))    return "disney";
    if (h.includes("hulu.com"))          return "hulu";
    if (h.includes("primevideo.com") || (h.includes("amazon.com") && location.pathname.includes("/video"))) return "prime";
    if (h.includes("max.com") || h.includes("hbomax.com")) return "max";
    if (h.includes("crunchyroll.com"))   return "crunchyroll";
    if (h.includes("peacocktv.com"))     return "peacock";
    if (h.includes("paramountplus.com")) return "paramount";
    if (h.includes("tv.apple.com"))      return "appletv";
    if (h.includes("tubitv.com") || h.includes("tubi.tv")) return "tubi";
    if (h.includes("pluto.tv"))          return "pluto";
    if (h.includes("twitch.tv"))         return "twitch";
    if (h.includes("plex.tv"))           return "plex";
    if (h.includes("vudu.com"))          return "vudu";
    if (h.includes("vimeo.com"))         return "vimeo";
    if (h.includes("dopebox.to"))        return "dopebox";
    return "unknown";
  })();

  // ═══════════════════════════════════════════
  //  VIDEO DETECTION (multi-platform)
  // ═══════════════════════════════════════════

  // Walk into shadow DOM trees to find <video> elements
  function queryShadow(root, sel) {
    const results = [];
    for (const el of root.querySelectorAll(sel)) results.push(el);
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) {
        for (const inner of queryShadow(el.shadowRoot, sel)) results.push(inner);
      }
    }
    return results;
  }

  // Pick the largest (most likely main-content) video from a list
  function pickLargest(videos) {
    if (videos.length === 0) return null;
    if (videos.length === 1) return videos[0];
    let best = videos[0], bestArea = 0;
    for (const v of videos) {
      const a = (v.videoWidth || v.clientWidth || 0) * (v.videoHeight || v.clientHeight || 0);
      if (a > bestArea) { bestArea = a; best = v; }
    }
    return best;
  }

  function findVideo() {
    // 1. Direct DOM (covers most platforms)
    let videos = queryShadow(document, "video");
    let v = pickLargest(videos);
    if (v) return v;

    // 2. Same-origin iframes (DopeBox, Tubi, Pluto, etc.)
    try {
      for (const f of document.querySelectorAll("iframe")) {
        const d = f.contentDocument || f.contentWindow?.document;
        if (d) {
          videos = queryShadow(d, "video");
          v = pickLargest(videos);
          if (v) return v;
        }
      }
    } catch { /* cross-origin iframe — handled by all_frames */ }

    return null;
  }

  function waitForVideo(cb) {
    let found = false;
    let n = 0;

    const tryFind = () => {
      if (found) return;
      const v = findVideo();
      if (v) { found = true; cb(v); return; }
      if (++n < 120) setTimeout(tryFind, 1000); // 2 min patience for slow SPAs
    };
    tryFind();

    // Mutation observer for dynamic DOM (React/SPA streaming apps)
    const obs = new MutationObserver(() => {
      if (found) return;
      const v = findVideo();
      if (v) { found = true; obs.disconnect(); cb(v); }
    });
    obs.observe(document.body || document.documentElement, { childList: true, subtree: true });

    // SPA navigation detection — re-scan on URL changes (YouTube, Netflix)
    let lastUrl = location.href;
    const navCheck = setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href; found = false; n = 0;
        tryFind();
      }
    }, 1500);

    // Clean up after 5 minutes
    setTimeout(() => { obs.disconnect(); clearInterval(navCheck); }, 300000);
  }

  // ═══════════════════════════════════════════
  //  WEBSOCKET
  // ═══════════════════════════════════════════

  function connect() {
    if (state.ws && state.ws.readyState <= 1) return;
    try { state.ws = new WebSocket(state.serverUrl); } catch (e) { updateStatus(false); return; }
    state.ws.onopen = () => { updateStatus(true); state.connected = true; };
    state.ws.onclose = () => {
      updateStatus(false); state.connected = false;
      if (state.roomId) setTimeout(() => { connect(); const w = setInterval(() => { if (state.ws?.readyState === 1) { clearInterval(w); send({ type: "join-room", roomId: state.roomId, username: state.username }); } }, 200); }, 3000);
    };
    state.ws.onerror = () => updateStatus(false);
    state.ws.onmessage = (e) => handleMessage(e.data);
  }

  function send(obj) { if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(obj)); }

  // ═══════════════════════════════════════════
  //  MESSAGE HANDLER
  // ═══════════════════════════════════════════

  function handleMessage(raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "room-created":
        state.roomId = msg.roomId; state.members = msg.members || [];
        state.isHost = !!msg.isHost; state.hostOnly = !!msg.hostOnly;
        showRoomView(); toast(`Room ${msg.roomId} created!`); notifyBg(); startDrift();
        break;
      case "room-joined":
        state.roomId = msg.roomId; state.members = msg.members || [];
        state.isHost = !!msg.isHost; state.hostOnly = !!msg.hostOnly;
        showRoomView(); toast(`Joined room ${msg.roomId}`); notifyBg(); startDrift();
        break;
      case "user-joined":
        state.members = msg.members || state.members; renderMembers();
        addSystemMsg(`${msg.username} joined the party`); playSound("join"); notifyBg();
        break;
      case "user-left":
        state.members = msg.members || state.members; renderMembers();
        addSystemMsg(`${msg.username} left the party`); playSound("leave");
        cleanupPeer(msg.username); notifyBg();
        break;
      case "user-kicked":
        state.members = msg.members || state.members; renderMembers();
        addSystemMsg(`${msg.username} was kicked`); playSound("kick"); notifyBg();
        break;
      case "kicked":
        state.roomId = null; state.members = []; state.isHost = false;
        showLobbyView(); toast(msg.reason || "You were kicked."); playSound("kick");
        stopDrift(); stopMedia(); notifyBg();
        break;
      case "sync":
        applySync(msg); break;
      case "sync-request":
        sendCurrentState(); break;
      case "chat":
        addChatMsg(msg.username, msg.text, msg.timestamp); playSound("message"); break;
      case "reaction":
        showFloatingReaction(msg.emoji, msg.username); break;
      case "typing":
        handleRemoteTyping(msg.username, msg.isTyping); break;
      case "host-only-changed":
        state.hostOnly = !!msg.enabled;
        addSystemMsg(`Host-only mode ${msg.enabled ? "enabled" : "disabled"}`);
        updateHostOnlyUI(); break;
      case "buffering":
        if (msg.isBuffering) {
          addSystemMsg(`${msg.username} is buffering...`);
          if (!state.someoneBuffering && state.video && !state.video.paused) {
            state.wasPlayingBeforeBuffer = true; state.isSyncing = true;
            state.video.pause(); setTimeout(() => { state.isSyncing = false; }, 600);
          }
          state.someoneBuffering = true;
        }
        break;
      case "buffering-clear":
        state.someoneBuffering = false;
        if (state.wasPlayingBeforeBuffer && state.video) {
          state.wasPlayingBeforeBuffer = false; state.isSyncing = true;
          state.video.play().catch(() => {}); setTimeout(() => { state.isSyncing = false; }, 600);
        }
        addSystemMsg("Everyone ready — resuming!");
        break;
      case "webrtc-signal":
        handleWebRTCSignal(msg); break;
      case "media-state":
        handleRemoteMediaState(msg); break;
      case "error":
        toast(msg.message || "Something went wrong"); break;
    }
  }

  // ═══════════════════════════════════════════
  //  SYNC LOGIC
  // ═══════════════════════════════════════════

  function attachVideoListeners(video) {
    state.video = video;

    // Playback events
    for (const evt of ["play", "pause", "seeked", "ratechange"]) {
      video.addEventListener(evt, () => {
        if (state.isSyncing || !state.roomId) return;
        if (state.hostOnly && !state.isHost) return; // non-host in host-only
        send({ type: "sync", action: evt, currentTime: video.currentTime, paused: video.paused, playbackRate: video.playbackRate, timestamp: Date.now() });
      });
    }

    // Buffering detection
    video.addEventListener("waiting", () => {
      if (state.roomId) send({ type: "buffering", isBuffering: true });
    });
    video.addEventListener("playing", () => {
      if (state.roomId) send({ type: "buffering", isBuffering: false });
    });
  }

  function applySync(msg) {
    const v = state.video; if (!v) return;
    state.isSyncing = true; clearTimeout(state.syncTimeout);
    if (msg.action === "seeked" || Math.abs(v.currentTime - msg.currentTime) > SEEK_THRESHOLD) v.currentTime = msg.currentTime;
    if (msg.action === "play" && v.paused) v.play().catch(() => {});
    if (msg.action === "pause" && !v.paused) v.pause();
    if (msg.playbackRate && v.playbackRate !== msg.playbackRate) v.playbackRate = msg.playbackRate;
    state.syncTimeout = setTimeout(() => { state.isSyncing = false; }, 600);
  }

  function sendCurrentState() {
    const v = state.video; if (!v) return;
    send({ type: "sync", action: v.paused ? "pause" : "play", currentTime: v.currentTime, paused: v.paused, playbackRate: v.playbackRate, timestamp: Date.now() });
  }

  // Drift correction — host sends state every 5s
  function startDrift() {
    stopDrift();
    state.driftTimer = setInterval(() => {
      if (state.isHost && state.roomId && state.video) sendCurrentState();
    }, DRIFT_INTERVAL);
  }
  function stopDrift() { clearInterval(state.driftTimer); state.driftTimer = null; }

  // ═══════════════════════════════════════════
  //  WEBRTC VOICE / VIDEO
  // ═══════════════════════════════════════════

  async function startMedia(audio, video) {
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia({ audio, video });
      state.myMediaAudio = audio; state.myMediaVideo = video;
      send({ type: "media-state", audio, video });
      renderVideoOverlay();
      // Create offers to all existing media-enabled members
      for (const m of state.members) {
        if (m.id !== getMyId() && (m.mediaAudio || m.mediaVideo)) createPeerOffer(m.id);
      }
    } catch (e) { toast("Camera/mic access denied"); }
  }

  function stopMedia() {
    if (state.localStream) { state.localStream.getTracks().forEach((t) => t.stop()); state.localStream = null; }
    state.myMediaAudio = false; state.myMediaVideo = false;
    for (const [id, peer] of state.peers) { peer.pc.close(); }
    state.peers.clear();
    send({ type: "media-state", audio: false, video: false });
    const overlay = document.getElementById("cw-video-overlay");
    if (overlay) overlay.remove();
  }

  function createPeerOffer(targetId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    if (state.localStream) state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: "webrtc-signal", targetId, signal: { type: "ice-candidate", data: e.candidate } }); };
    pc.ontrack = (e) => { updateRemoteVideo(targetId, e.streams[0]); };
    pc.createOffer().then((offer) => { pc.setLocalDescription(offer); send({ type: "webrtc-signal", targetId, signal: { type: "offer", data: offer } }); });
    state.peers.set(targetId, { pc, username: getMemberName(targetId) });
  }

  function handleWebRTCSignal(msg) {
    const { fromId, signal } = msg;
    if (signal.type === "offer") {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      if (state.localStream) state.localStream.getTracks().forEach((t) => pc.addTrack(t, state.localStream));
      pc.onicecandidate = (e) => { if (e.candidate) send({ type: "webrtc-signal", targetId: fromId, signal: { type: "ice-candidate", data: e.candidate } }); };
      pc.ontrack = (e) => { updateRemoteVideo(fromId, e.streams[0]); };
      pc.setRemoteDescription(new RTCSessionDescription(signal.data))
        .then(() => pc.createAnswer())
        .then((answer) => { pc.setLocalDescription(answer); send({ type: "webrtc-signal", targetId: fromId, signal: { type: "answer", data: answer } }); });
      state.peers.set(fromId, { pc, username: msg.fromUsername });
    } else if (signal.type === "answer") {
      const peer = state.peers.get(fromId);
      if (peer) peer.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
    } else if (signal.type === "ice-candidate") {
      const peer = state.peers.get(fromId);
      if (peer) peer.pc.addIceCandidate(new RTCIceCandidate(signal.data)).catch(() => {});
    }
  }

  function handleRemoteMediaState(msg) {
    // When someone enables media, initiate a connection if we also have media
    if ((msg.audio || msg.video) && state.localStream && msg.userId !== getMyId() && !state.peers.has(msg.userId)) {
      createPeerOffer(msg.userId);
    }
    if (!msg.audio && !msg.video) cleanupPeerById(msg.userId);
  }

  function cleanupPeer(username) {
    for (const [id, peer] of state.peers) { if (peer.username === username) { peer.pc.close(); state.peers.delete(id); } }
    renderVideoOverlay();
  }
  function cleanupPeerById(id) {
    const peer = state.peers.get(id); if (peer) { peer.pc.close(); state.peers.delete(id); } renderVideoOverlay();
  }

  function updateRemoteVideo(peerId, stream) {
    const peer = state.peers.get(peerId);
    if (peer) peer.stream = stream;
    renderVideoOverlay();
  }

  function renderVideoOverlay() {
    let overlay = document.getElementById("cw-video-overlay");
    if (!state.localStream && state.peers.size === 0) { if (overlay) overlay.remove(); return; }

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "cw-video-overlay";
      // Draggable
      let dragging = false, ox, oy;
      overlay.addEventListener("mousedown", (e) => {
        if (e.target.tagName === "BUTTON") return;
        dragging = true; ox = e.clientX - overlay.offsetLeft; oy = e.clientY - overlay.offsetTop;
      });
      document.addEventListener("mousemove", (e) => { if (!dragging) return; overlay.style.left = (e.clientX - ox) + "px"; overlay.style.top = (e.clientY - oy) + "px"; overlay.style.bottom = "auto"; overlay.style.right = "auto"; });
      document.addEventListener("mouseup", () => { dragging = false; });
      document.body.appendChild(overlay);
    }

    let html = '<div class="cw-video-grid">';

    // Local video
    if (state.localStream) {
      html += `<div class="cw-video-cell">
        <video id="cw-local-video" autoplay muted playsinline></video>
        <span class="cw-video-label">You</span>
      </div>`;
    }

    // Remote videos
    for (const [id, peer] of state.peers) {
      if (peer.stream) {
        html += `<div class="cw-video-cell">
          <video id="cw-remote-${id}" autoplay playsinline></video>
          <span class="cw-video-label">${escapeHtml(peer.username || "Peer")}</span>
        </div>`;
      }
    }

    html += "</div>";
    html += `<div class="cw-video-controls">
      <button class="cw-vc-btn" id="cw-toggle-mic" title="Toggle mic">${state.myMediaAudio ? "\u{1F3A4}" : "\u{1F507}"}</button>
      <button class="cw-vc-btn" id="cw-toggle-cam" title="Toggle camera">${state.myMediaVideo ? "\u{1F4F7}" : "\u{1F6AB}"}</button>
      <button class="cw-vc-btn cw-vc-end" id="cw-end-call" title="End call">\u{1F4F5}</button>
    </div>`;

    overlay.innerHTML = html;

    // Attach streams
    if (state.localStream) {
      const lv = document.getElementById("cw-local-video");
      if (lv) { lv.srcObject = state.localStream; lv.style.transform = "scaleX(-1)"; }
    }
    for (const [id, peer] of state.peers) {
      if (peer.stream) { const rv = document.getElementById(`cw-remote-${id}`); if (rv) rv.srcObject = peer.stream; }
    }

    // Controls
    document.getElementById("cw-toggle-mic")?.addEventListener("click", () => {
      if (!state.localStream) return;
      state.myMediaAudio = !state.myMediaAudio;
      state.localStream.getAudioTracks().forEach((t) => { t.enabled = state.myMediaAudio; });
      send({ type: "media-state", audio: state.myMediaAudio, video: state.myMediaVideo });
      renderVideoOverlay();
    });
    document.getElementById("cw-toggle-cam")?.addEventListener("click", () => {
      if (!state.localStream) return;
      state.myMediaVideo = !state.myMediaVideo;
      state.localStream.getVideoTracks().forEach((t) => { t.enabled = state.myMediaVideo; });
      send({ type: "media-state", audio: state.myMediaAudio, video: state.myMediaVideo });
      renderVideoOverlay();
    });
    document.getElementById("cw-end-call")?.addEventListener("click", stopMedia);
  }

  function getMyId() {
    const me = state.members.find((m) => m.username === state.username && (state.isHost ? m.isHost : !m.isHost));
    return me?.id || "";
  }
  function getMemberName(id) { const m = state.members.find((x) => x.id === id); return m?.username || "Peer"; }

  // ═══════════════════════════════════════════
  //  BACKGROUND NOTIFY
  // ═══════════════════════════════════════════

  function notifyBg() {
    try { chrome.runtime.sendMessage({ action: "room-state", inRoom: !!state.roomId, roomId: state.roomId, memberCount: state.members.length }); } catch {}
  }

  // ═══════════════════════════════════════════
  //  IFRAME HANDLER
  // ═══════════════════════════════════════════

  if (!IS_TOP) {
    waitForVideo((video) => {
      attachVideoListeners(video);
      chrome.runtime.onMessage.addListener((msg) => { if (msg.action === "cw-apply-sync") applySync(msg.data); });
    });
    return;
  }

  // ═══════════════════════════════════════════
  //  BUILD UI (top frame only)
  // ═══════════════════════════════════════════

  function buildUI() {
    // FAB
    const fab = document.createElement("button");
    fab.id = "cowatch-fab"; fab.title = "CoWatch"; fab.textContent = "CW";
    fab.addEventListener("click", togglePanel);
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement("div");
    panel.id = "cowatch-panel";
    panel.innerHTML = `
      <div class="cw-header">
        <h1>CoWatch</h1>
        <button class="cw-close" id="cw-close">&times;</button>
      </div>

      <!-- Status -->
      <div class="cw-section">
        <div class="cw-status">
          <div class="cw-status-dot" id="cw-status-dot"></div>
          <span id="cw-status-text">Disconnected</span>
        </div>
        <div class="cw-server-row cw-mt">
          <input class="cw-input" id="cw-server-input" placeholder="ws://localhost:3000" />
          <button class="cw-btn cw-btn-secondary" id="cw-connect-btn">Connect</button>
        </div>
      </div>

      <!-- Lobby -->
      <div class="cw-section" id="cw-lobby">
        <div class="cw-section-title">Username</div>
        <input class="cw-input" id="cw-username" placeholder="Your name" maxlength="20" />

        <div class="cw-section-title cw-mt">Create a Room</div>
        <input class="cw-input" id="cw-room-password" placeholder="Password (optional)" type="password" />
        <button class="cw-btn cw-btn-primary cw-mt" id="cw-create-btn" style="width:100%">Create Room</button>

        <div class="cw-section-title cw-mt">Join a Room</div>
        <div class="cw-join-row">
          <input class="cw-input" id="cw-join-code" placeholder="CODE" maxlength="6" />
          <input class="cw-input" id="cw-join-password" placeholder="Password" type="password" style="flex:.7" />
          <button class="cw-btn cw-btn-secondary" id="cw-join-btn">Join</button>
        </div>
      </div>

      <!-- Room -->
      <div class="cw-section cw-hidden" id="cw-room">
        <div class="cw-room-code">
          <span id="cw-room-id">------</span>
          <button id="cw-copy-code">Copy</button>
          <button id="cw-invite-link" title="Copy invite message">Invite</button>
        </div>

        <div class="cw-room-controls">
          <label class="cw-toggle" id="cw-hostonly-toggle">
            <input type="checkbox" id="cw-hostonly-cb" />
            <span class="cw-toggle-label">Host-only controls</span>
          </label>
          <button class="cw-btn cw-btn-secondary cw-btn-sm" id="cw-media-btn">Voice/Video</button>
        </div>

        <div class="cw-section-title">Members (<span id="cw-member-count">0</span>)</div>
        <div class="cw-members" id="cw-members"></div>
        <button class="cw-btn cw-btn-danger cw-mt" id="cw-leave-btn" style="width:100%">Leave Room</button>
      </div>

      <!-- Chat -->
      <div class="cw-chat cw-hidden" id="cw-chat">
        <div class="cw-chat-messages" id="cw-messages"></div>
        <div class="cw-typing-indicator cw-hidden" id="cw-typing"></div>
        <div class="cw-chat-input">
          <button class="cw-emoji-trigger" id="cw-emoji-btn" title="Emoji">\u{1F600}</button>
          <input class="cw-input" id="cw-chat-text" placeholder="Send a message..." maxlength="500" />
          <button class="cw-btn cw-btn-primary" id="cw-send-btn">Send</button>
        </div>
        <div class="cw-emoji-picker cw-hidden" id="cw-emoji-picker"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // Floating reactions container
    const reactContainer = document.createElement("div");
    reactContainer.id = "cw-reactions";
    document.body.appendChild(reactContainer);

    // Toast
    const toastEl = document.createElement("div");
    toastEl.className = "cw-toast"; toastEl.id = "cw-toast";
    document.body.appendChild(toastEl);

    // Build emoji picker grid
    const picker = document.getElementById("cw-emoji-picker");
    EMOJIS.forEach((e) => {
      const btn = document.createElement("button");
      btn.className = "cw-emoji-item"; btn.textContent = e;
      btn.addEventListener("click", () => {
        send({ type: "reaction", emoji: e });
        picker.classList.add("cw-hidden");
      });
      picker.appendChild(btn);
    });

    // Wire events
    document.getElementById("cw-close").addEventListener("click", togglePanel);
    document.getElementById("cw-connect-btn").addEventListener("click", onConnect);
    document.getElementById("cw-create-btn").addEventListener("click", onCreate);
    document.getElementById("cw-join-btn").addEventListener("click", onJoin);
    document.getElementById("cw-leave-btn").addEventListener("click", onLeave);
    document.getElementById("cw-copy-code").addEventListener("click", onCopyCode);
    document.getElementById("cw-invite-link").addEventListener("click", onInvite);
    document.getElementById("cw-send-btn").addEventListener("click", onSendChat);
    document.getElementById("cw-emoji-btn").addEventListener("click", () => {
      document.getElementById("cw-emoji-picker").classList.toggle("cw-hidden");
    });
    document.getElementById("cw-media-btn").addEventListener("click", () => {
      if (state.localStream) stopMedia(); else startMedia(true, true);
    });
    document.getElementById("cw-hostonly-cb").addEventListener("change", (e) => {
      send({ type: "toggle-host-only", enabled: e.target.checked });
    });

    const chatInput = document.getElementById("cw-chat-text");
    chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") onSendChat(); });
    chatInput.addEventListener("input", onLocalTyping);

    document.getElementById("cw-join-code").addEventListener("input", (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });

    // Close emoji picker when clicking outside
    document.addEventListener("click", (e) => {
      const picker = document.getElementById("cw-emoji-picker");
      if (!picker?.classList.contains("cw-hidden") && !e.target.closest("#cw-emoji-picker") && !e.target.closest("#cw-emoji-btn")) {
        picker.classList.add("cw-hidden");
      }
    });

    loadSettings();
  }

  // ═══════════════════════════════════════════
  //  PANEL
  // ═══════════════════════════════════════════

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    document.getElementById("cowatch-panel").classList.toggle("open", state.panelOpen);
    document.getElementById("cowatch-fab").classList.toggle("active", state.panelOpen);
  }

  // ═══════════════════════════════════════════
  //  EVENT HANDLERS
  // ═══════════════════════════════════════════

  function onConnect() {
    const url = document.getElementById("cw-server-input").value.trim();
    if (!url) return;
    state.serverUrl = url; saveSettings();
    if (state.ws) { state.ws.onclose = null; state.ws.close(); }
    connect();
  }

  function onCreate() {
    if (!state.connected) return toast("Connect to a server first");
    state.username = document.getElementById("cw-username").value.trim() || "Guest";
    const pw = document.getElementById("cw-room-password").value;
    saveSettings();
    send({ type: "create-room", username: state.username, password: pw || undefined });
  }

  function onJoin() {
    if (!state.connected) return toast("Connect to a server first");
    const code = document.getElementById("cw-join-code").value.trim();
    if (!code) return toast("Enter a room code");
    state.username = document.getElementById("cw-username").value.trim() || "Guest";
    const pw = document.getElementById("cw-join-password").value;
    saveSettings();
    send({ type: "join-room", roomId: code, username: state.username, password: pw || undefined });
  }

  function onLeave() {
    send({ type: "leave-room" });
    state.roomId = null; state.members = []; state.isHost = false;
    showLobbyView(); toast("Left the room"); stopDrift(); stopMedia(); notifyBg();
  }

  function onCopyCode() { if (state.roomId) navigator.clipboard.writeText(state.roomId).then(() => toast("Code copied!")); }

  function onInvite() {
    const text = `Join my CoWatch party!\nRoom code: ${state.roomId}\nPage: ${window.location.href}`;
    navigator.clipboard.writeText(text).then(() => toast("Invite copied!"));
  }

  function onSendChat() {
    const input = document.getElementById("cw-chat-text");
    const text = input.value.trim();
    if (!text || !state.roomId) return;
    send({ type: "chat", text });
    send({ type: "typing", isTyping: false });
    input.value = "";
  }

  function onLocalTyping() {
    if (!state.roomId) return;
    send({ type: "typing", isTyping: true });
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => send({ type: "typing", isTyping: false }), TYPING_TIMEOUT);
  }

  // ═══════════════════════════════════════════
  //  UI RENDERERS
  // ═══════════════════════════════════════════

  function showRoomView() {
    document.getElementById("cw-lobby").classList.add("cw-hidden");
    document.getElementById("cw-room").classList.remove("cw-hidden");
    document.getElementById("cw-chat").classList.remove("cw-hidden");
    document.getElementById("cw-room-id").textContent = state.roomId;
    updateHostOnlyUI();
    renderMembers();
  }

  function showLobbyView() {
    document.getElementById("cw-lobby").classList.remove("cw-hidden");
    document.getElementById("cw-room").classList.add("cw-hidden");
    document.getElementById("cw-chat").classList.add("cw-hidden");
    document.getElementById("cw-messages").innerHTML = "";
  }

  function updateHostOnlyUI() {
    const cb = document.getElementById("cw-hostonly-cb");
    const toggle = document.getElementById("cw-hostonly-toggle");
    if (cb) cb.checked = state.hostOnly;
    // Only host can toggle
    if (toggle) toggle.style.opacity = state.isHost ? "1" : "0.5";
    if (cb) cb.disabled = !state.isHost;
  }

  function renderMembers() {
    const container = document.getElementById("cw-members");
    document.getElementById("cw-member-count").textContent = state.members.length;
    container.innerHTML = state.members.map((m) => {
      const color = getUserColor(m.username);
      const kickBtn = state.isHost && !m.isHost
        ? `<button class="cw-kick-btn" data-id="${m.id}" title="Kick">&times;</button>` : "";
      return `<div class="cw-member">
        <div class="cw-member-avatar" style="background:${color}">${(m.username || "?")[0].toUpperCase()}</div>
        <div class="cw-member-name">${escapeHtml(m.username)}</div>
        ${m.isHost ? '<span class="cw-member-badge">HOST</span>' : ""}
        ${m.mediaAudio || m.mediaVideo ? '<span class="cw-member-badge cw-media-badge">\u{1F3A4}</span>' : ""}
        ${kickBtn}
      </div>`;
    }).join("");
    // Wire kick buttons
    container.querySelectorAll(".cw-kick-btn").forEach((btn) => {
      btn.addEventListener("click", () => send({ type: "kick", targetId: btn.dataset.id }));
    });
  }

  function addChatMsg(username, text, timestamp) {
    const container = document.getElementById("cw-messages"); if (!container) return;
    const div = document.createElement("div");
    div.className = "cw-chat-msg";
    const color = getUserColor(username);
    const time = timestamp ? `<span class="cw-chat-time">${fmtTime(timestamp)}</span>` : "";
    div.innerHTML = `${time}<span class="cw-chat-user" style="color:${color}">${escapeHtml(username)}</span><span class="cw-chat-text">${escapeHtml(text)}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function addSystemMsg(text) {
    const container = document.getElementById("cw-messages"); if (!container) return;
    const div = document.createElement("div");
    div.className = "cw-chat-msg cw-system"; div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // Typing indicator
  function handleRemoteTyping(username, isTyping) {
    if (isTyping) state.typingUsers.add(username); else state.typingUsers.delete(username);
    const el = document.getElementById("cw-typing");
    if (!el) return;
    if (state.typingUsers.size === 0) { el.classList.add("cw-hidden"); return; }
    el.classList.remove("cw-hidden");
    const names = Array.from(state.typingUsers);
    if (names.length === 1) el.textContent = `${names[0]} is typing...`;
    else if (names.length === 2) el.textContent = `${names[0]} and ${names[1]} are typing...`;
    else el.textContent = `${names[0]} and ${names.length - 1} others are typing...`;
  }

  // Floating emoji reactions
  function showFloatingReaction(emoji) {
    const container = document.getElementById("cw-reactions"); if (!container) return;
    const el = document.createElement("div");
    el.className = "cw-float-reaction";
    el.textContent = emoji;
    el.style.left = (20 + Math.random() * 60) + "%";
    container.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
  }

  function updateStatus(on) {
    const dot = document.getElementById("cw-status-dot");
    const txt = document.getElementById("cw-status-text");
    if (dot) dot.classList.toggle("connected", on);
    if (txt) txt.textContent = on ? "Connected" : "Disconnected";
  }

  let _tt;
  function toast(msg) {
    const el = document.getElementById("cw-toast"); if (!el) return;
    el.textContent = msg; el.classList.add("show");
    clearTimeout(_tt); _tt = setTimeout(() => el.classList.remove("show"), 2500);
  }

  // ═══════════════════════════════════════════
  //  SETTINGS
  // ═══════════════════════════════════════════

  function saveSettings() {
    try { chrome.storage.local.set({ cowatchServer: state.serverUrl, cowatchUsername: state.username }); } catch {}
  }
  function loadSettings() {
    try {
      chrome.storage.local.get(["cowatchServer", "cowatchUsername"], (d) => {
        if (d.cowatchServer) { state.serverUrl = d.cowatchServer; document.getElementById("cw-server-input").value = d.cowatchServer; }
        else document.getElementById("cw-server-input").value = state.serverUrl;
        if (d.cowatchUsername) { state.username = d.cowatchUsername; document.getElementById("cw-username").value = d.cowatchUsername; }
      });
    } catch { document.getElementById("cw-server-input").value = state.serverUrl; }
  }

  // ═══════════════════════════════════════════
  //  INIT
  // ═══════════════════════════════════════════

  const PLATFORM_NAMES = {
    netflix: "Netflix", youtube: "YouTube", disney: "Disney+", hulu: "Hulu",
    prime: "Prime Video", max: "Max", crunchyroll: "Crunchyroll", peacock: "Peacock",
    paramount: "Paramount+", appletv: "Apple TV+", tubi: "Tubi", pluto: "Pluto TV",
    twitch: "Twitch", plex: "Plex", vudu: "Vudu", vimeo: "Vimeo", dopebox: "DopeBox",
    unknown: "this site",
  };

  function init() {
    buildUI();
    const pname = PLATFORM_NAMES[PLATFORM] || PLATFORM;
    waitForVideo((v) => {
      // Detach from old video if re-detected (SPA navigation)
      if (state.video && state.video !== v) state.video = null;
      attachVideoListeners(v);
      toast(`Video detected on ${pname} \u2013 ready to party!`);
    });
  }

  if (document.body) init(); else document.addEventListener("DOMContentLoaded", init);
})();
