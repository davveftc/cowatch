// CoWatch popup – settings & status display

document.addEventListener("DOMContentLoaded", () => {
  const serverInput = document.getElementById("popup-server");
  const saveBtn = document.getElementById("popup-save");
  const statusDot = document.getElementById("popup-dot");
  const statusText = document.getElementById("popup-status-text");
  const roomInfo = document.getElementById("popup-room-info");
  const roomCode = document.getElementById("popup-room-code");

  // Load saved settings
  chrome.storage.local.get(["cowatchServer", "cowatchRoomState"], (data) => {
    serverInput.value = data.cowatchServer || "ws://localhost:3000";
    if (data.cowatchRoomState?.inRoom) {
      statusDot.classList.add("in-room");
      statusText.textContent = "In a watch party";
      roomInfo.style.display = "flex";
      roomCode.textContent = data.cowatchRoomState.roomId || "------";
    }
  });

  // Save server URL
  saveBtn.addEventListener("click", () => {
    const url = serverInput.value.trim();
    if (!url) return;
    chrome.storage.local.set({ cowatchServer: url }, () => {
      saveBtn.textContent = "Saved!";
      setTimeout(() => { saveBtn.textContent = "Save"; }, 1200);
    });
  });
});
