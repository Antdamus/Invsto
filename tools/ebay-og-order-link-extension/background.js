(function () {
  "use strict";

  const APP_URL_KEY = "ogPendingOrdersUrl";
  const PENDING_LABEL_PREFIX = "ogPendingLabel:";
  const DOWNLOAD_CAPTURE_TIMEOUT_MS = 45000;
  const APP_ACK_TIMEOUT_MS = 60000;
  const downloadCaptures = new Map();
  const appTransferAcks = new Map();

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

  function waitForAppTransferAck(transferId) {
    return new Promise((resolve) => {
      let lastError = null;
      const timer = setTimeout(() => {
        appTransferAcks.delete(transferId);
        resolve({
          ok: false,
          transferId,
          error: lastError || "OG received the label handoff, but did not confirm upload within 60 seconds. Open the matching OG label modal/session and try again.",
        });
      }, APP_ACK_TIMEOUT_MS);

      appTransferAcks.set(transferId, {
        resolve: (status) => {
          if (!status?.ok) {
            lastError = status?.error || status?.message || lastError;
            return;
          }
          clearTimeout(timer);
          appTransferAcks.delete(transferId);
          resolve(status);
        },
      });
    });
  }

  async function handleAppTransferStatus(status = {}) {
    const transferId = status.transferId || "";
    if (!transferId) return;
    if (status.phase === "started" && status.tabId) {
      focusTab(status.tabId);
      return;
    }
    if (status.ok) await removePendingLabel(transferId);
    const waiter = appTransferAcks.get(transferId);
    if (waiter) waiter.resolve(status);
  }

  async function focusTab(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      await chrome.tabs.update(tabId, { active: true });
    } catch (_) {}
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function isExactAppTab(tab, appUrl) {
    const tabUrl = normalizeUrl(tab?.url);
    if (!tabUrl || !appUrl) return false;
    return tabUrl.origin === appUrl.origin && tabUrl.pathname === appUrl.pathname;
  }

  function isSameOriginOgTab(tab, appUrl) {
    const tabUrl = normalizeUrl(tab?.url);
    if (!tabUrl || !appUrl || tabUrl.origin !== appUrl.origin) return false;
    return /\/(?:pending-orders|ebay-order-history)\.html$/i.test(tabUrl.pathname);
  }

  async function findAppTabs(appUrl) {
    const tabs = await chrome.tabs.query({});
    const exact = tabs.filter((tab) => isExactAppTab(tab, appUrl));
    const sameOrigin = tabs.filter((tab) => isSameOriginOgTab(tab, appUrl) && !exact.some((entry) => entry.id === tab.id));
    return [...exact, ...sameOrigin];
  }

  async function relayLabelToApp(label) {
    const appUrl = await getAppUrl();
    if (!appUrl) throw new Error("Set the OG Pending Orders URL in the extension options first.");

    const transferId = buildTransferId(label);
    const payload = { ...label, transferId };
    await storePendingLabel(transferId, payload);
    const appAckPromise = waitForAppTransferAck(transferId);
    const url = new URL(appUrl.toString());
    url.searchParams.set("source", "ebay");
    if (label.metadata?.orderId) url.searchParams.set("orderId", label.metadata.orderId);
    url.searchParams.set("labelTransferId", transferId);

    const tabs = await findAppTabs(appUrl);
    if (tabs.length) {
      const deliveries = await Promise.all(tabs.map((tab) =>
        chrome.tabs.sendMessage(tab.id, { type: "OG_EBAY_LABEL_TRANSFER", payload }).catch(() => null)
      ));
      if (deliveries.some((delivery) => delivery?.ok)) {
        const ack = await appAckPromise;
        return { ...ack, transferId, delivered: true, opened: false };
      }

      await chrome.tabs.create({ url: url.toString(), active: true });
      const ack = await appAckPromise;
      return {
        ...ack,
        transferId,
        delivered: false,
        opened: true,
        note: "The open OG tab did not have the label bridge yet, so a transfer tab was opened.",
      };
    }

    await chrome.tabs.create({ url: url.toString(), active: true });
    const ack = await appAckPromise;
    return { ...ack, transferId, delivered: false, opened: true };
  }

  function beginDownloadCapture(payload, sender) {
    const captureId = crypto.randomUUID();
    const capture = {
      captureId,
      tabId: sender?.tab?.id || null,
      metadata: payload?.metadata || {},
      pageUrl: payload?.pageUrl || sender?.tab?.url || "",
      startedAt: Date.now(),
      matchedDownloadIds: new Set(),
      finished: false,
      timer: null,
    };
    capture.timer = setTimeout(() => {
      downloadCaptures.delete(captureId);
    }, DOWNLOAD_CAPTURE_TIMEOUT_MS);
    downloadCaptures.set(captureId, capture);
    return captureId;
  }

  function finishDownloadCapture(captureId) {
    const capture = downloadCaptures.get(captureId);
    if (!capture) return null;
    capture.finished = true;
    clearTimeout(capture.timer);
    downloadCaptures.delete(captureId);
    return capture;
  }

  function isLikelyDownloadForCapture(item, capture) {
    if (!capture || capture.finished) return false;
    const text = [
      item?.url,
      item?.finalUrl,
      item?.referrer,
      item?.filename,
      item?.mime,
      capture.pageUrl,
    ].filter(Boolean).join(" ").toLowerCase();

    const orderId = String(capture.metadata?.orderId || "").toLowerCase();
    const shipmentId = String(capture.metadata?.shipmentId || "").toLowerCase();
    const mentionsCapture = (orderId && text.includes(orderId))
      || (shipmentId && text.includes(shipmentId));
    const looksLikeEbay = /ebay\.com|ebaystatic\.com|blob:https:\/\/www\.ebay\.com/.test(text);
    const looksLikeLabel = /pdf|label|shipping|download|shipment/.test(text);

    return looksLikeEbay && (looksLikeLabel || mentionsCapture);
  }

  function getMatchingCapture(item) {
    const captures = [...downloadCaptures.values()]
      .filter((capture) => Date.now() - capture.startedAt <= DOWNLOAD_CAPTURE_TIMEOUT_MS)
      .filter((capture) => isLikelyDownloadForCapture(item, capture))
      .sort((a, b) => b.startedAt - a.startedAt);
    return captures[0] || null;
  }

  async function getDownloadItem(downloadId) {
    const items = await chrome.downloads.search({ id: downloadId });
    return items?.[0] || null;
  }

  async function fetchDownloadItemAsLabel(item) {
    const url = item?.finalUrl || item?.url || "";
    if (!url) throw new Error("The browser download did not expose a URL.");
    if (url.startsWith("blob:")) {
      throw new Error("The browser download used a blob URL. The page probe must capture that before download.");
    }

    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`The eBay label download URL returned HTTP ${response.status}.`);

    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const mimeType = blob.type || item?.mime || "application/pdf";
    if (!/pdf/i.test(mimeType) && !/\.pdf(?:$|[?#])/i.test(url)) {
      throw new Error(`The captured download was not a PDF (${mimeType || "unknown type"}).`);
    }

    return {
      source: "browser-download-url",
      url: response.url || url,
      mimeType,
      size: blob.size || buffer.byteLength || item?.fileSize || 0,
      base64: arrayBufferToBase64(buffer),
      capturedAt: new Date().toISOString(),
    };
  }

  async function handleDownloadCapture(capture, downloadId) {
    if (!capture || capture.finished || capture.matchedDownloadIds.has(downloadId)) return;
    capture.matchedDownloadIds.add(downloadId);

    try {
      await new Promise((resolve) => setTimeout(resolve, 750));
      const item = await getDownloadItem(downloadId);
      const label = await fetchDownloadItemAsLabel(item);
      const response = await relayLabelToApp({
        metadata: capture.metadata,
        label,
      });
      finishDownloadCapture(capture.captureId);
      if (capture.tabId !== null) {
        chrome.tabs.sendMessage(capture.tabId, {
          type: "OG_EBAY_DOWNLOAD_CAPTURE_RESULT",
          captureId: capture.captureId,
          result: response,
        }).catch(() => null);
      }
    } catch (error) {
      if (capture.tabId !== null) {
        chrome.tabs.sendMessage(capture.tabId, {
          type: "OG_EBAY_DOWNLOAD_CAPTURE_RESULT",
          captureId: capture.captureId,
          result: {
            ok: false,
            error: error.message || String(error),
          },
        }).catch(() => null);
      }
    }
  }

  if (chrome.downloads?.onCreated) {
    chrome.downloads.onCreated.addListener((item) => {
      const capture = getMatchingCapture(item);
      if (!capture) return;
      handleDownloadCapture(capture, item.id);
    });
  }

  if (chrome.downloads?.onChanged) {
    chrome.downloads.onChanged.addListener((delta) => {
      if (!delta?.id) return;
      getDownloadItem(delta.id).then((item) => {
        const capture = getMatchingCapture(item);
        if (!capture) return;
        handleDownloadCapture(capture, delta.id);
      }).catch(() => null);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;

    if (message.type === "OG_EBAY_SEND_LABEL") {
      relayLabelToApp(message.payload)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_LABEL_TRANSFER_STATUS") {
      handleAppTransferStatus({
        ...(message.payload || {}),
        tabId: _sender?.tab?.id || message.payload?.tabId || null,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_BEGIN_DOWNLOAD_CAPTURE") {
      try {
        const captureId = beginDownloadCapture(message.payload, _sender);
        sendResponse({ ok: true, captureId });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || String(error) });
      }
      return false;
    }

    if (message.type === "OG_EBAY_CANCEL_DOWNLOAD_CAPTURE") {
      finishDownloadCapture(message.captureId);
      sendResponse({ ok: true });
      return false;
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
