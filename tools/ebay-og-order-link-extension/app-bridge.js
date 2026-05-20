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

  function postToOgApp(payload, type = "OG_EBAY_LABEL_TRANSFER") {
    const message = {
      type,
      payload,
    };
    const maxAttempts = type === "OG_EBAY_AWAITING_REPORT_TRANSFER" ? 60 : 10;
    window.postMessage(message, window.location.origin);
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      window.postMessage(message, window.location.origin);
      if (attempts >= maxAttempts) window.clearInterval(timer);
    }, 1000);
  }

  function relayOgStatusToExtension(payload, type = "OG_EBAY_LABEL_TRANSFER_STATUS") {
    chrome.runtime.sendMessage({
      type,
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

  function requestPendingPriorities(payload) {
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
      const timer = window.setTimeout(() => finish(null), 1500);
      const onMessage = (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        if (event.data?.type !== "OG_EBAY_PENDING_PRIORITIES_RESPONSE") return;
        if (event.data?.requestId !== requestId) return;
        finish(event.data.payload || null);
      };
      window.addEventListener("message", onMessage);
      window.postMessage({
        type: "OG_EBAY_PENDING_PRIORITIES_REQUEST",
        requestId,
        payload,
      }, window.location.origin);
    });
  }

  async function deliverPendingTransferFromUrl() {
    const transferId = new URLSearchParams(window.location.search).get("labelTransferId");
    const reportTransferId = new URLSearchParams(window.location.search).get("reportTransferId");
    if (transferId) {
      const response = await chrome.runtime.sendMessage({
        type: "OG_EBAY_GET_PENDING_LABEL",
        transferId,
      }).catch(() => null);
      if (response?.payload) postToOgApp(response.payload);
    }
    if (reportTransferId) {
      const response = await chrome.runtime.sendMessage({
        type: "OG_EBAY_GET_PENDING_REPORT",
        transferId: reportTransferId,
      }).catch(() => null);
      if (response?.payload) postToOgApp(response.payload, "OG_EBAY_AWAITING_REPORT_TRANSFER");
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "OG_EBAY_LABEL_TRANSFER") {
      postToOgApp(message.payload);
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "OG_EBAY_AWAITING_REPORT_TRANSFER") {
      postToOgApp(message.payload, "OG_EBAY_AWAITING_REPORT_TRANSFER");
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type === "OG_EBAY_GET_LABEL_RECEIVER_STATE") {
      requestReceiverState(message.payload)
        .then((state) => sendResponse({ ok: true, ...(state || {}) }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message?.type === "OG_EBAY_GET_PENDING_PRIORITIES") {
      requestPendingPriorities(message.payload)
        .then((state) => sendResponse(state ? { ok: true, ...state } : { ok: false, error: "OG Pending Orders did not answer with due-order priorities." }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    return false;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type === "OG_EBAY_LABEL_TRANSFER_STATUS") {
      relayOgStatusToExtension(event.data.payload || {});
      return;
    }
    if (event.data?.type === "OG_EBAY_AWAITING_REPORT_TRANSFER_STATUS") {
      relayOgStatusToExtension(event.data.payload || {}, "OG_EBAY_AWAITING_REPORT_TRANSFER_STATUS");
      return;
    }
    if (event.data?.type === "OG_EBAY_PENDING_QUEUE_CHANGED") {
      relayOgStatusToExtension(event.data.payload || {}, "OG_EBAY_PENDING_QUEUE_CHANGED");
    }
  });

  getConfiguredAppUrl().then((appUrl) => {
    if (!sameOgAppOrigin(appUrl)) return;
    deliverPendingTransferFromUrl();
  });
})();
