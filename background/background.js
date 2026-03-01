// CoWatch – background service worker
// Manages badge state with user count display.

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["cowatchServer"], (data) => {
    if (!data.cowatchServer) chrome.storage.local.set({ cowatchServer: "ws://localhost:3000" });
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === "room-state") {
    const tabId = sender.tab?.id;
    if (msg.inRoom) {
      // Show member count on badge
      const count = msg.memberCount || 0;
      chrome.action.setBadgeText({ text: String(count), tabId });
      chrome.action.setBadgeBackgroundColor({ color: "#7c3aed", tabId });
    } else {
      chrome.action.setBadgeText({ text: "", tabId });
    }
    chrome.storage.local.set({ cowatchRoomState: msg });
  }
});
