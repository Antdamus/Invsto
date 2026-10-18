(function () {
  "use strict";

  const STORAGE_KEY = "ogPendingOrdersUrl";
  const input = document.getElementById("app-url");
  const status = document.getElementById("status");
  document.getElementById("installed-version").textContent = chrome.runtime.getManifest().version;

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
  document.getElementById('online-print').addEventListener('click', async () => {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    try {
      const url = new URL('print-stations.html', stored[STORAGE_KEY]);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Save an HTTPS OG Pending Orders URL first.');
      url.searchParams.set('onlinePrint', '1');
      await chrome.tabs.create({url: url.href});
    } catch (error) { setStatus(error.message || 'Save your OG Pending Orders URL first.'); }
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") save();
  });
  document.getElementById('tiktok-orders').addEventListener('click', async () => {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    try {
      const url = new URL('pending-tiktok-orders.html', stored[STORAGE_KEY]);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Save an HTTPS OG Pending Orders URL first.');
      await chrome.tabs.create({url: url.href});
    } catch (error) { setStatus(error.message || 'Save your OG Pending Orders URL first.'); }
  });
  load();
})();
