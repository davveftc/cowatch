// CoWatch – background service worker
// Manages badge state and relays messages between popup and content scripts.

chrome.runtime.onInstalled.addListener(() => {
  // Set defaults
  chrome.storage.local.get(["cowatchServer"], (data) => {
    if (!data.cowatchServer) {
      chrome.storage.local.set({ cowatchServer: "ws://localhost:3000" });
    }
  });
});

// Listen for room state changes from content script
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === "room-state") {
    // Update badge
    if (msg.inRoom) {
      chrome.action.setBadgeText({ text: "ON", tabId: sender.tab?.id });
      chrome.action.setBadgeBackgroundColor({ color: "#7c3aed", tabId: sender.tab?.id });
    } else {
      chrome.action.setBadgeText({ text: "", tabId: sender.tab?.id });
    }
    // Persist for popup
    chrome.storage.local.set({ cowatchRoomState: msg });
  }
});
