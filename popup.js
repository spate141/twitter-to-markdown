(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const btnStart = $("#btn-start");
  const btnStop = $("#btn-stop");
  const stopGroup = $("#stop-group");
  const btnCopy = $("#btn-copy");
  const btnDownload = $("#btn-download");
  const statusEl = $("#status");
  const previewSection = $("#preview-section");
  const previewEl = $("#preview");

  let currentMarkdown = "";

  // ── Helpers ──────────────────────────────────────────────

  function setStatus(msg, cls = "") {
    statusEl.textContent = msg;
    statusEl.className = cls;
  }

  function setRunning(running) {
    btnStart.disabled = running;
    stopGroup.style.display = running ? "flex" : "none";
  }

  async function sendToContent(action) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setStatus("No active tab found.", "error");
      return;
    }
    if (!tab.url?.match(/https:\/\/(x\.com|twitter\.com|mobile\.twitter\.com)/)) {
      setStatus("Navigate to a Twitter/X page first.", "error");
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { action });
    } catch (e) {
      // Content script might not be injected yet — inject it
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"],
        });
        await chrome.tabs.sendMessage(tab.id, { action });
      } catch (e2) {
        setStatus("Could not connect to page. Try refreshing.", "error");
      }
    }
  }

  // ── Buttons ─────────────────────────────────────────────

  btnStart.addEventListener("click", () => {
    setRunning(true);
    setStatus("Starting…");
    previewSection.classList.remove("visible");
    sendToContent("scrape_all");
  });

  btnStop.addEventListener("click", () => {
    sendToContent("stop");
    setStatus("Stopping…");
  });

  btnCopy.addEventListener("click", async () => {
    if (!currentMarkdown) return;
    try {
      await navigator.clipboard.writeText(currentMarkdown);
      btnCopy.textContent = "✅ Copied!";
      setTimeout(() => (btnCopy.textContent = "📋 Copy"), 1500);
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = currentMarkdown;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      btnCopy.textContent = "✅ Copied!";
      setTimeout(() => (btnCopy.textContent = "📋 Copy"), 1500);
    }
  });

  btnDownload.addEventListener("click", () => {
    if (!currentMarkdown) return;
    const blob = new Blob([currentMarkdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
    a.download = `twitter-conversation-${timestamp}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Listen for messages from content script ────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "progress") {
      setStatus(msg.message);
    } else if (msg.type === "result") {
      setRunning(false);
      currentMarkdown = msg.markdown;
      previewEl.textContent = msg.markdown;
      previewSection.classList.add("visible");
      setStatus(`Done! ${msg.count} tweets captured.`, "success-msg");
    } else if (msg.type === "spam_detected") {
      setRunning(false);
      currentMarkdown = msg.markdown;
      previewEl.textContent = msg.markdown;
      previewSection.classList.add("visible");
      setStatus(`Done! ${msg.count} tweets captured. (Stopped at spam indicator)`, "success-msg");
    } else if (msg.type === "aborted") {
      setRunning(false);
      setStatus("Stopped by user.");
    } else if (msg.type === "error") {
      setRunning(false);
      setStatus(`Error: ${msg.message}`, "error");
    }
  });
})();
