/**
 * CoWatch – content script
 * Injected into dopebox.to pages (including iframes).
 * Handles video detection, WebSocket sync, and the watch-party overlay UI.
 */
(() => {
  /* ──────── Guard: only run once per frame ──────── */
  if (window.__cowatch_loaded) return;
  window.__cowatch_loaded = true;

  const IS_TOP = window === window.top;

  /* ──────── State ──────── */
  const state = {
    ws: null,
    video: null,
    roomId: null,
    username: "Guest",
    serverUrl: "ws://localhost:3000",
    members: [],
    connected: false,
    isSyncing: false, // flag to ignore self-triggered events
    syncTimeout: null,
    panelOpen: false,
  };

  /* ──────── Video detection ──────── */

  function findVideo() {
    // Direct video elements
    let video = document.querySelector("video");
    if (video) return video;

    // Try iframes (same-origin only)
    try {
      const iframes = document.querySelectorAll("iframe");
      for (const iframe of iframes) {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (doc) {
          video = doc.querySelector("video");
          if (video) return video;
        }
      }
    } catch {
      /* cross-origin – ignore */
    }
    return null;
  }

  function waitForVideo(callback, maxAttempts = 60) {
    let attempts = 0;
    const check = () => {
      const video = findVideo();
      if (video) {
        callback(video);
        return;
      }
      if (++attempts < maxAttempts) setTimeout(check, 1000);
    };
    check();

    // Also watch for dynamically added videos
    const observer = new MutationObserver(() => {
      const v = findVideo();
      if (v) {
        observer.disconnect();
        callback(v);
      }
    });
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  /* ──────── WebSocket ──────── */

  function connect() {
    if (state.ws && state.ws.readyState <= 1) return; // already open/connecting
    try {
      state.ws = new WebSocket(state.serverUrl);
    } catch (e) {
      console.error("[CoWatch] WS connection failed:", e);
      updateStatus(false);
      return;
    }
    state.ws.onopen = () => {
      updateStatus(true);
      state.connected = true;
    };
    state.ws.onclose = () => {
      updateStatus(false);
      state.connected = false;
      // Auto-reconnect after 3s if we were in a room
      if (state.roomId) {
        setTimeout(() => {
          connect();
          // Re-join after reconnect
          const waitOpen = setInterval(() => {
            if (state.ws?.readyState === 1) {
              clearInterval(waitOpen);
              send({ type: "join-room", roomId: state.roomId, username: state.username });
            }
          }, 200);
        }, 3000);
      }
    };
    state.ws.onerror = () => updateStatus(false);
    state.ws.onmessage = (e) => handleMessage(e.data);
  }

  function send(obj) {
    if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(obj));
  }

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "room-created":
        state.roomId = msg.roomId;
        state.members = msg.members || [];
        showRoomView();
        toast(`Room ${msg.roomId} created!`);
        notifyBackground();
        break;

      case "room-joined":
        state.roomId = msg.roomId;
        state.members = msg.members || [];
        showRoomView();
        toast(`Joined room ${msg.roomId}`);
        notifyBackground();
        break;

      case "user-joined":
        state.members = msg.members || state.members;
        renderMembers();
        addSystemMsg(`${msg.username} joined the party`);
        break;

      case "user-left":
        state.members = msg.members || state.members;
        renderMembers();
        addSystemMsg(`${msg.username} left the party`);
        break;

      case "sync":
        applySync(msg);
        break;

      case "sync-request":
        sendCurrentState();
        break;

      case "chat":
        addChatMsg(msg.username, msg.text);
        break;

      case "error":
        toast(msg.message || "Something went wrong");
        break;
    }
  }

  /* ──────── Sync logic ──────── */

  const SEEK_THRESHOLD = 1.5; // seconds – ignore tiny drifts

  function attachVideoListeners(video) {
    state.video = video;

    const events = ["play", "pause", "seeked", "ratechange"];
    for (const evt of events) {
      video.addEventListener(evt, () => {
        if (state.isSyncing || !state.roomId) return;
        send({
          type: "sync",
          action: evt,
          currentTime: video.currentTime,
          paused: video.paused,
          playbackRate: video.playbackRate,
          timestamp: Date.now(),
        });
      });
    }
  }

  function applySync(msg) {
    const v = state.video;
    if (!v) return;

    state.isSyncing = true;
    clearTimeout(state.syncTimeout);

    if (msg.action === "seeked" || Math.abs(v.currentTime - msg.currentTime) > SEEK_THRESHOLD) {
      v.currentTime = msg.currentTime;
    }
    if (msg.action === "play" && v.paused) v.play().catch(() => {});
    if (msg.action === "pause" && !v.paused) v.pause();
    if (msg.playbackRate && v.playbackRate !== msg.playbackRate) {
      v.playbackRate = msg.playbackRate;
    }

    state.syncTimeout = setTimeout(() => { state.isSyncing = false; }, 600);
  }

  function sendCurrentState() {
    const v = state.video;
    if (!v) return;
    send({
      type: "sync",
      action: v.paused ? "pause" : "play",
      currentTime: v.currentTime,
      paused: v.paused,
      playbackRate: v.playbackRate,
      timestamp: Date.now(),
    });
  }

  /* ──────── Notify background (for badge) ──────── */

  function notifyBackground() {
    try {
      chrome.runtime.sendMessage({
        action: "room-state",
        inRoom: !!state.roomId,
        roomId: state.roomId,
      });
    } catch { /* extension context may be invalid */ }
  }

  /* ──────── UI – only in top frame ──────── */

  if (!IS_TOP) {
    // In sub-frames, just hook the video and relay via runtime messaging
    waitForVideo((video) => {
      attachVideoListeners(video);
      // Listen for sync commands from top frame via runtime messages
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === "cw-apply-sync") applySync(msg.data);
      });
    });
    return; // Don't build UI in iframes
  }

  /* ──────── Build the overlay UI ──────── */

  function buildUI() {
    // Floating action button
    const fab = document.createElement("button");
    fab.id = "cowatch-fab";
    fab.title = "CoWatch – Watch Party";
    fab.innerHTML = "&#9654;&#65039;"; // play icon placeholder
    fab.textContent = "CW";
    fab.addEventListener("click", togglePanel);
    document.body.appendChild(fab);

    // Side panel
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

      <!-- Lobby (no room) -->
      <div class="cw-section" id="cw-lobby">
        <div class="cw-section-title">Username</div>
        <input class="cw-input" id="cw-username" placeholder="Your name" maxlength="20" />
        <div class="cw-btn-group cw-mt">
          <button class="cw-btn cw-btn-primary" id="cw-create-btn">Create Room</button>
        </div>
        <div class="cw-section-title cw-mt">Join a Room</div>
        <div class="cw-join-row">
          <input class="cw-input" id="cw-join-code" placeholder="ROOM CODE" maxlength="6" />
          <button class="cw-btn cw-btn-secondary" id="cw-join-btn">Join</button>
        </div>
      </div>

      <!-- Room view -->
      <div class="cw-section cw-hidden" id="cw-room">
        <div class="cw-section-title">Room Code</div>
        <div class="cw-room-code">
          <span id="cw-room-id">------</span>
          <button id="cw-copy-code">Copy</button>
        </div>
        <div class="cw-section-title">Members</div>
        <div class="cw-members" id="cw-members"></div>
        <button class="cw-btn cw-btn-danger cw-mt" id="cw-leave-btn" style="width:100%;">Leave Room</button>
      </div>

      <!-- Chat -->
      <div class="cw-chat cw-hidden" id="cw-chat">
        <div class="cw-chat-messages" id="cw-messages"></div>
        <div class="cw-chat-input">
          <input class="cw-input" id="cw-chat-text" placeholder="Send a message..." maxlength="500" />
          <button class="cw-btn cw-btn-primary" id="cw-send-btn">Send</button>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // Toast container
    const toastEl = document.createElement("div");
    toastEl.className = "cw-toast";
    toastEl.id = "cw-toast";
    document.body.appendChild(toastEl);

    // Wire up events
    document.getElementById("cw-close").addEventListener("click", togglePanel);
    document.getElementById("cw-connect-btn").addEventListener("click", onConnect);
    document.getElementById("cw-create-btn").addEventListener("click", onCreate);
    document.getElementById("cw-join-btn").addEventListener("click", onJoin);
    document.getElementById("cw-leave-btn").addEventListener("click", onLeave);
    document.getElementById("cw-copy-code").addEventListener("click", onCopyCode);
    document.getElementById("cw-send-btn").addEventListener("click", onSendChat);
    document.getElementById("cw-chat-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter") onSendChat();
    });
    document.getElementById("cw-join-code").addEventListener("input", (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });

    // Load saved settings
    loadSettings();
  }

  /* ──────── Panel toggle ──────── */

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    const panel = document.getElementById("cowatch-panel");
    const fab = document.getElementById("cowatch-fab");
    if (state.panelOpen) {
      panel.classList.add("open");
      fab.classList.add("active");
    } else {
      panel.classList.remove("open");
      fab.classList.remove("active");
    }
  }

  /* ──────── Event handlers ──────── */

  function onConnect() {
    const input = document.getElementById("cw-server-input");
    const url = input.value.trim();
    if (!url) return;
    state.serverUrl = url;
    saveSettings();
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
    }
    connect();
  }

  function onCreate() {
    if (!state.connected) { toast("Connect to a server first"); return; }
    const username = document.getElementById("cw-username").value.trim() || "Guest";
    state.username = username;
    saveSettings();
    send({ type: "create-room", username });
  }

  function onJoin() {
    if (!state.connected) { toast("Connect to a server first"); return; }
    const code = document.getElementById("cw-join-code").value.trim();
    if (!code) { toast("Enter a room code"); return; }
    const username = document.getElementById("cw-username").value.trim() || "Guest";
    state.username = username;
    saveSettings();
    send({ type: "join-room", roomId: code, username });
  }

  function onLeave() {
    send({ type: "leave-room" });
    state.roomId = null;
    state.members = [];
    showLobbyView();
    toast("Left the room");
    notifyBackground();
  }

  function onCopyCode() {
    if (!state.roomId) return;
    navigator.clipboard.writeText(state.roomId).then(() => toast("Code copied!"));
  }

  function onSendChat() {
    const input = document.getElementById("cw-chat-text");
    const text = input.value.trim();
    if (!text || !state.roomId) return;
    send({ type: "chat", text });
    input.value = "";
  }

  /* ──────── UI helpers ──────── */

  function showRoomView() {
    document.getElementById("cw-lobby").classList.add("cw-hidden");
    document.getElementById("cw-room").classList.remove("cw-hidden");
    document.getElementById("cw-chat").classList.remove("cw-hidden");
    document.getElementById("cw-room-id").textContent = state.roomId;
    renderMembers();
  }

  function showLobbyView() {
    document.getElementById("cw-lobby").classList.remove("cw-hidden");
    document.getElementById("cw-room").classList.add("cw-hidden");
    document.getElementById("cw-chat").classList.add("cw-hidden");
    document.getElementById("cw-messages").innerHTML = "";
  }

  function renderMembers() {
    const container = document.getElementById("cw-members");
    container.innerHTML = state.members
      .map(
        (m) => `
        <div class="cw-member">
          <div class="cw-member-avatar">${(m.username || "?")[0].toUpperCase()}</div>
          <div class="cw-member-name">${escapeHtml(m.username)}</div>
          ${m.isHost ? '<span class="cw-member-badge">HOST</span>' : ""}
        </div>`
      )
      .join("");
  }

  function addChatMsg(username, text) {
    const container = document.getElementById("cw-messages");
    if (!container) return;
    const div = document.createElement("div");
    div.className = "cw-chat-msg";
    div.innerHTML = `<span class="cw-chat-user">${escapeHtml(username)}</span><span class="cw-chat-text">${escapeHtml(text)}</span>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function addSystemMsg(text) {
    const container = document.getElementById("cw-messages");
    if (!container) return;
    const div = document.createElement("div");
    div.className = "cw-chat-msg cw-system";
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function updateStatus(connected) {
    const dot = document.getElementById("cw-status-dot");
    const txt = document.getElementById("cw-status-text");
    if (!dot || !txt) return;
    if (connected) {
      dot.classList.add("connected");
      txt.textContent = "Connected";
    } else {
      dot.classList.remove("connected");
      txt.textContent = "Disconnected";
    }
  }

  let toastTimer;
  function toast(message) {
    const el = document.getElementById("cw-toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  /* ──────── Settings persistence ──────── */

  function saveSettings() {
    try {
      chrome.storage.local.set({
        cowatchServer: state.serverUrl,
        cowatchUsername: state.username,
      });
    } catch { /* ignore */ }
  }

  function loadSettings() {
    try {
      chrome.storage.local.get(["cowatchServer", "cowatchUsername"], (data) => {
        if (data.cowatchServer) {
          state.serverUrl = data.cowatchServer;
          document.getElementById("cw-server-input").value = data.cowatchServer;
        } else {
          document.getElementById("cw-server-input").value = state.serverUrl;
        }
        if (data.cowatchUsername) {
          state.username = data.cowatchUsername;
          document.getElementById("cw-username").value = data.cowatchUsername;
        }
      });
    } catch {
      document.getElementById("cw-server-input").value = state.serverUrl;
    }
  }

  /* ──────── Init ──────── */

  function init() {
    buildUI();
    waitForVideo((video) => {
      attachVideoListeners(video);
      toast("Video detected – ready to party!");
    });
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
