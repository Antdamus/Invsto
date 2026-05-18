(function () {
  "use strict";

  const APP_URL_KEY = "ogPendingOrdersUrl";
  const PENDING_LABEL_PREFIX = "ogPendingLabel:";

  function normalizeUrl(value) {
    try {
      return new URL(String(value || "").trim());
    } catch (_) {
      return null;
    }
  }

  function buildTransferId(label = {}) {
    const orderId = String(label.metadata?.orderId || "order").replace(/[^a-z0-9-]/gi, "-");
    const shipmentId = String(label.metadata?.shipmentId || crypto.randomUUID()).replace(/[^a-z0-9-]/gi, "-");
    return `${orderId}:${shipmentId}:${Date.now()}`;
  }

  async function getAppUrl() {
    const stored = await chrome.storage.sync.get(APP_URL_KEY);
    return normalizeUrl(stored[APP_URL_KEY]);
  }

  async function storePendingLabel(transferId, label) {
    await chrome.storage.local.set({
      [`${PENDING_LABEL_PREFIX}${transferId}`]: {
        ...label,
        transferId,
        relayedAt: new Date().toISOString(),
      },
    });
  }

  async function getPendingLabel(transferId) {
    const key = `${PENDING_LABEL_PREFIX}${transferId}`;
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  async function removePendingLabel(transferId) {
    await chrome.storage.local.remove(`${PENDING_LABEL_PREFIX}${transferId}`);
  }

  function isAppTab(tab, appUrl) {
    const tabUrl = normalizeUrl(tab?.url);
    if (!tabUrl || !appUrl) return false;
    return tabUrl.origin === appUrl.origin && tabUrl.pathname === appUrl.pathname;
  }

  async function findAppTabs(appUrl) {
    const tabs = await chrome.tabs.query({});
    return tabs.filter((tab) => isAppTab(tab, appUrl));
  }

  async function relayLabelToApp(label) {
    const appUrl = await getAppUrl();
    if (!appUrl) throw new Error("Set the OG Pending Orders URL in the extension options first.");

    const transferId = buildTransferId(label);
    const payload = { ...label, transferId };
    await storePendingLabel(transferId, payload);

    const tabs = await findAppTabs(appUrl);
    if (tabs.length) {
      await Promise.all(tabs.map((tab) =>
        chrome.tabs.sendMessage(tab.id, { type: "OG_EBAY_LABEL_TRANSFER", payload }).catch(() => null)
      ));
      return { ok: true, transferId, delivered: true, opened: false };
    }

    const url = new URL(appUrl.toString());
    url.searchParams.set("source", "ebay");
    if (label.metadata?.orderId) url.searchParams.set("orderId", label.metadata.orderId);
    url.searchParams.set("labelTransferId", transferId);
    await chrome.tabs.create({ url: url.toString(), active: true });
    return { ok: true, transferId, delivered: false, opened: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;

    if (message.type === "OG_EBAY_SEND_LABEL") {
      relayLabelToApp(message.payload)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_GET_PENDING_LABEL") {
      getPendingLabel(message.transferId)
        .then((payload) => sendResponse({ ok: true, payload }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_CLEAR_PENDING_LABEL") {
      removePendingLabel(message.transferId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_GET_APP_URL") {
      getAppUrl()
        .then((url) => sendResponse({ ok: true, appUrl: url?.toString() || "" }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    return false;
  });
})();
