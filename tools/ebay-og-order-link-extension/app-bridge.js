(function () {
  "use strict";

  async function getConfiguredAppUrl() {
    const response = await chrome.runtime.sendMessage({ type: "OG_EBAY_GET_APP_URL" }).catch(() => null);
    return response?.appUrl || "";
  }

  function sameAppPage(appUrl) {
    try {
      const configured = new URL(appUrl);
      return configured.origin === window.location.origin && configured.pathname === window.location.pathname;
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
    if (message?.type !== "OG_EBAY_LABEL_TRANSFER") return false;
    postToOgApp(message.payload);
    sendResponse({ ok: true });
    return true;
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.type !== "OG_EBAY_LABEL_TRANSFER_STATUS") return;
    relayOgStatusToExtension(event.data.payload || {});
  });

  getConfiguredAppUrl().then((appUrl) => {
    if (!sameAppPage(appUrl)) return;
    deliverPendingTransferFromUrl();
  });
})();
