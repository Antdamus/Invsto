(function () {
  "use strict";

  const STORAGE_KEY = "ogPendingOrdersUrl";
  const input = document.getElementById("app-url");
  const status = document.getElementById("status");

  function setStatus(message) {
    status.textContent = message || "";
  }

  function normalizeUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      return new URL(text).toString();
    } catch (_) {
      return "";
    }
  }

  async function load() {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    input.value = stored[STORAGE_KEY] || "";
  }

  async function save() {
    const url = normalizeUrl(input.value);
    if (!url) {
      setStatus("Enter a valid full URL.");
      input.focus();
      return;
    }
    await chrome.storage.sync.set({ [STORAGE_KEY]: url });
    setStatus("Saved.");
  }

  document.getElementById("save").addEventListener("click", save);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save();
  });
  load();
})();
