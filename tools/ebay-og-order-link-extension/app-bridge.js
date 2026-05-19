(function () {
  "use strict";

  async function getConfiguredAppUrl() {
    const response = await chrome.runtime.sendMessage({ type: "OG_EBAY_GET_APP_URL" }).catch(() => null);
    return response?.appUrl || "";
  }

  function sameOgAppOrigin(appUrl) {
    try {
      const configured = new URL(appUrl);
      return configured.origin === window.location.origin
        && /\/(?:pending-orders|ebay-order-history)\.html$/i.test(window.location.pathname);
    } catch (_) {
      return false;
    }
  }

  function postToOgApp(payload) {
    const message = {
      type: "OG_EBAY_LABEL_TRANSFER",
      payload,
    };
    window.postMessage(message, window.location.origin);
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      window.postMessage(message, window.location.origin);
      if (attempts >= 10) window.clearInterval(timer);
    }, 1000);
  }

  function relayOgStatusToExtension(payload) {
    chrome.runtime.sendMessage({
      type: "OG_EBAY_LABEL_TRANSFER_STATUS",
      payload,
    }).catch(() => null);
  }

  function requestReceiverState(payload) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      let settled = false;
      const finish = (state) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(state);
      };
      const timer = window.setTimeout(() => finish(null), 700);
      const onMessage = (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.type !== "OG_EBAY_LABEL_RECEIVER_STATE_RESPONSE") return;
        if (event.data?.requestId !== requestId) return;
        finish(event.data.payload || null);
      };
      window.addEventListener("message", onMessage);
      window.postMessage({
        type: "OG_EBAY_LABEL_RECEIVER_STATE_REQUEST",
        requestId,
        payload,
      }, window.location.origin);
    });
  }

  async function deliverPendingTransferFromUrl() {
    const transferId = new URLSearchParams(window.location.search).get("labelTransferId");
    if (!transferId) return;
    const response = await chrome.runtime.sendMessage({
      type: "OG_EBAY_GET_PENDING_LABEL",
      transferId,
    }).catch(() => null);
    if (response?.payload) postToOgApp(response.payload);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "OG_EBAY_LABEL_TRANSFER") {
      postToOgApp(message.payload);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "OG_EBAY_GET_LABEL_RECEIVER_STATE") {
      requestReceiverState(message.payload)
        .then((state) => sendResponse({ ok: true, ...(state || {}) }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    return false;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type !== "OG_EBAY_LABEL_TRANSFER_STATUS") return;
    relayOgStatusToExtension(event.data.payload || {});
  });

  getConfiguredAppUrl().then((appUrl) => {
    if (!sameOgAppOrigin(appUrl)) return;
    deliverPendingTransferFromUrl();
  });
})();
