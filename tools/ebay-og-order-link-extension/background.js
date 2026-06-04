(function () {
  "use strict";

  const APP_URL_KEY = "ogPendingOrdersUrl";
  const PENDING_LABEL_PREFIX = "ogPendingLabel:";
  const PENDING_REPORT_PREFIX = "ogPendingReport:";
  const PENDING_RETURN_PREFIX = "ogPendingReturn:";
  const PENDING_RETURN_MESSAGE_PREFIX = "ogPendingReturnMessage:";
  const PENDING_VIDEO_RECEIPT_PHOTO_PREFIX = "ogPendingVideoReceiptPhoto:";
  const PENDING_CANCEL_PROOF_PREFIX = "ogPendingCancelProof:";
  const DOWNLOAD_CAPTURE_TIMEOUT_MS = 45000;
  const REPORT_DOWNLOAD_CAPTURE_TIMEOUT_MS = 180000;
  const APP_ACK_TIMEOUT_MS = 300000;
  const RECEIVER_STATE_TIMEOUT_MS = 900;
  const DEFAULT_AWAITING_SHIPMENT_URL = "https://www.ebay.com/sh/ord/?filter=status:AWAITING_SHIPMENT";
  const downloadCaptures = new Map();
  const appTransferAcks = new Map();
  const appReportAcks = new Map();
  const appReturnAcks = new Map();
  const appReturnMessageAcks = new Map();
  const appVideoReceiptPhotoAcks = new Map();
  const appCancelProofAcks = new Map();
  let pendingPriorityCache = null;
  let pendingPriorityCacheAt = 0;
  const PENDING_PRIORITY_CACHE_TTL_MS = 15000;

  function normalizeUrl(value) {
    try {
      return new URL(String(value || "").trim());
    } catch (_) {
      return null;
    }
  }

  function normalizeEbayNavigationUrl(value, baseUrl = "https://www.ebay.com/") {
    const raw = String(value || "").trim().replace(/&amp;/g, "&").replace(/\\u0026/gi, "&");
    if (!raw) return "";
    try {
      return new URL(raw.replace(/\\\//g, "/"), baseUrl).toString().replace(/&amp;/g, "&");
    } catch (_) {
      return raw.replace(/\\\//g, "/").replace(/&amp;/g, "&");
    }
  }

  function getPayloadItemNumber(payload = {}) {
    return String(payload.itemNumber || payload.selectedItemId || "").trim();
  }

  function normalizeVideoReceiptUrlForPayload(value, payload = {}, baseUrl = "https://www.ebay.com/") {
    const normalized = normalizeEbayNavigationUrl(value, baseUrl);
    const parsed = normalizeUrl(normalized);
    if (!parsed || !/(^|\.)ebay\.com$/i.test(parsed.hostname) || !/\/ebaylive\/events\//i.test(parsed.pathname)) {
      return "";
    }

    const itemNumber = getPayloadItemNumber(payload);
    if (!itemNumber) return parsed.toString();

    const selectedItemId = String(parsed.searchParams.get("selectedItemId") || "").trim();
    const itemIds = String(parsed.searchParams.get("itemIds") || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (selectedItemId === itemNumber) return parsed.toString();
    if (itemIds.includes(itemNumber)) {
      parsed.searchParams.set("selectedItemId", itemNumber);
      if (!parsed.searchParams.get("playback")) parsed.searchParams.set("playback", "true");
      return parsed.toString();
    }
    return "";
  }

  function findVideoReceiptUrlInText(text, baseUrl = "https://www.ebay.com/") {
    const candidates = findVideoReceiptCandidatesInText(text, baseUrl);
    return candidates[0]?.url || "";
  }

  function findVideoReceiptCandidatesInText(text, baseUrl = "https://www.ebay.com/") {
    const body = String(text || "");
    const patterns = [
      /https?:\/\/(?:www\.)?ebay\.com\/ebaylive\/events\/[^"'<>\s\\]+/gi,
      /https?:\\\/\\\/(?:www\.)?ebay\.com\\\/ebaylive\\\/events\\\/[^"'<>\s]+/gi,
    ];
    const seen = new Set();
    const candidates = [];
    for (const pattern of patterns) {
      for (const match of body.matchAll(pattern)) {
        const url = normalizeEbayNavigationUrl(match?.[0] || "", baseUrl);
        if (!url || !/\/ebaylive\/events\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        let selectedItemId = "";
        let itemIds = [];
        try {
          const parsed = new URL(url);
          selectedItemId = String(parsed.searchParams.get("selectedItemId") || "").trim();
          itemIds = String(parsed.searchParams.get("itemIds") || "")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);
        } catch (_) {}
        candidates.push({ url, index: match.index || 0, selectedItemId, itemIds });
      }
    }
    return candidates;
  }

  function normalizeComparableText(value = "") {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function findBestVideoReceiptUrlInText(text, payload = {}, baseUrl = "https://www.ebay.com/") {
    const body = String(text || "");
    const candidates = findVideoReceiptCandidatesInText(body, baseUrl);
    if (!candidates.length) return "";
    const itemNumber = getPayloadItemNumber(payload);
    if (itemNumber) {
      const exactMatches = candidates
        .map((candidate) => normalizeVideoReceiptUrlForPayload(candidate.url, payload, baseUrl))
        .filter(Boolean);
      if (exactMatches.length) return exactMatches[0];
      return "";
    }
    if (candidates.length === 1 && (!itemNumber || candidates[0].selectedItemId === itemNumber || !candidates[0].selectedItemId)) {
      return candidates[0].url;
    }

    const identifiers = [
      itemNumber,
      payload.transactionId,
      normalizeComparableText(payload.itemTitle).split(" ").filter((part) => part.length >= 4).slice(0, 5).join(" "),
    ].filter(Boolean).map(String);
    if (!identifiers.length) return "";

    const lowerBody = body.toLowerCase();
    const identifierPositions = identifiers.flatMap((identifier) => {
      const needle = String(identifier || "").toLowerCase();
      if (!needle) return [];
      const positions = [];
      let index = lowerBody.indexOf(needle);
      while (index >= 0 && positions.length < 20) {
        positions.push(index);
        index = lowerBody.indexOf(needle, index + needle.length);
      }
      return positions;
    });
    if (!identifierPositions.length) return "";

    const ranked = candidates.map((candidate) => {
      const distance = Math.min(...identifierPositions.map((position) => Math.abs(candidate.index - position)));
      return { ...candidate, distance };
    }).sort((a, b) => a.distance - b.distance);
    return ranked[0]?.distance <= 12000 ? ranked[0].url : "";
  }

  function resolveVideoReceiptUrlInText(text, payload = {}, baseUrl = "https://www.ebay.com/") {
    const candidates = findVideoReceiptCandidatesInText(text, baseUrl);
    if (!candidates.length) return "";
    const itemNumber = getPayloadItemNumber(payload);
    if (itemNumber) {
      return findBestVideoReceiptUrlInText(text, payload, baseUrl);
    }
    if (candidates.length === 1) {
      return candidates[0].url;
    }
    return findBestVideoReceiptUrlInText(text, payload, baseUrl);
  }

  function buildEbayOrderDetailsUrl(orderNumber = "") {
    const cleanNumber = String(orderNumber || "").trim();
    if (!cleanNumber) return "";
    const url = new URL("https://www.ebay.com/mesh/ord/details");
    url.searchParams.set("orderid", cleanNumber);
    return url.toString();
  }

  function buildTransferId(label = {}) {
    const orderId = String(label.metadata?.orderId || "order").replace(/[^a-z0-9-]/gi, "-");
    const shipmentId = String(label.metadata?.shipmentId || crypto.randomUUID()).replace(/[^a-z0-9-]/gi, "-");
    return `${orderId}:${shipmentId}:${Date.now()}`;
  }

  function buildReportTransferId(report = {}) {
    const file = String(report.report?.filename || report.metadata?.filename || "awaiting-orders-report")
      .replace(/[^a-z0-9._-]/gi, "-")
      .slice(0, 70);
    return `report:${file || "awaiting-orders-report"}:${Date.now()}`;
  }

  function buildReturnTransferId(returnTransfer = {}) {
    if (Array.isArray(returnTransfer.returns) && returnTransfer.returns.length) {
      const first = returnTransfer.returns[0] || {};
      const firstId = String(first.returnId || first.itemNumber || "return").replace(/[^a-z0-9._-]/gi, "-").slice(0, 50);
      return `return-batch:${returnTransfer.returns.length}:${firstId || "return"}:${Date.now()}`;
    }
    const data = returnTransfer.return || returnTransfer.metadata || {};
    const returnId = String(data.returnId || "return").replace(/[^a-z0-9._-]/gi, "-").slice(0, 60);
    const itemNumber = String(data.itemNumber || "item").replace(/[^a-z0-9._-]/gi, "-").slice(0, 60);
    return `return:${returnId || "return"}:${itemNumber || "item"}:${Date.now()}`;
  }

  function buildReturnMessageTransferId(messageTransfer = {}) {
    const data = messageTransfer.message || messageTransfer.metadata || {};
    const returnId = String(data.returnId || "return").replace(/[^a-z0-9._-]/gi, "-").slice(0, 60);
    const orderNumber = String(data.orderNumber || data.orderId || "order").replace(/[^a-z0-9._-]/gi, "-").slice(0, 60);
    return `return-message:${returnId || "return"}:${orderNumber || "order"}:${Date.now()}`;
  }

  function buildVideoReceiptPhotoTransferId(photoTransfer = {}) {
    const data = photoTransfer.metadata || {};
    const itemNumber = String(data.itemNumber || data.selectedItemId || "item").replace(/[^a-z0-9._-]/gi, "-").slice(0, 60);
    const eventId = String(data.eventId || "video").replace(/[^a-z0-9._-]/gi, "-").slice(0, 60);
    return `video-receipt-photo:${itemNumber || "item"}:${eventId || "video"}:${Date.now()}`;
  }

  function buildCancelProofTransferId(proofTransfer = {}) {
    const data = proofTransfer.metadata || {};
    const orderNumber = String(data.orderNumber || data.orderId || data.omsOrderId || "order").replace(/[^a-z0-9._-]/gi, "-").slice(0, 60);
    const cancelId = String(data.cancelId || "cancel").replace(/[^a-z0-9._-]/gi, "-").slice(0, 60);
    return `cancel-proof:${orderNumber || "order"}:${cancelId || "cancel"}:${Date.now()}`;
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

  async function storePendingReport(transferId, report) {
    await chrome.storage.local.set({
      [`${PENDING_REPORT_PREFIX}${transferId}`]: {
        ...report,
        transferId,
        relayedAt: new Date().toISOString(),
      },
    });
  }

  async function storePendingReturn(transferId, returnTransfer) {
    await chrome.storage.local.set({
      [`${PENDING_RETURN_PREFIX}${transferId}`]: {
        ...returnTransfer,
        transferId,
        relayedAt: new Date().toISOString(),
      },
    });
  }

  async function storePendingReturnMessage(transferId, messageTransfer) {
    await chrome.storage.local.set({
      [`${PENDING_RETURN_MESSAGE_PREFIX}${transferId}`]: {
        ...messageTransfer,
        transferId,
        relayedAt: new Date().toISOString(),
      },
    });
  }

  async function storePendingVideoReceiptPhoto(transferId, photoTransfer) {
    await chrome.storage.local.set({
      [`${PENDING_VIDEO_RECEIPT_PHOTO_PREFIX}${transferId}`]: {
        ...photoTransfer,
        transferId,
        relayedAt: new Date().toISOString(),
      },
    });
  }

  async function storePendingCancelProof(transferId, proofTransfer) {
    await chrome.storage.local.set({
      [`${PENDING_CANCEL_PROOF_PREFIX}${transferId}`]: {
        ...proofTransfer,
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

  async function getPendingReport(transferId) {
    const key = `${PENDING_REPORT_PREFIX}${transferId}`;
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  async function getPendingReturn(transferId) {
    const key = `${PENDING_RETURN_PREFIX}${transferId}`;
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  async function getPendingReturnMessage(transferId) {
    const key = `${PENDING_RETURN_MESSAGE_PREFIX}${transferId}`;
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  async function getPendingVideoReceiptPhoto(transferId) {
    const key = `${PENDING_VIDEO_RECEIPT_PHOTO_PREFIX}${transferId}`;
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  async function getPendingCancelProof(transferId) {
    const key = `${PENDING_CANCEL_PROOF_PREFIX}${transferId}`;
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  }

  async function removePendingLabel(transferId) {
    await chrome.storage.local.remove(`${PENDING_LABEL_PREFIX}${transferId}`);
  }

  async function removePendingReport(transferId) {
    await chrome.storage.local.remove(`${PENDING_REPORT_PREFIX}${transferId}`);
  }

  async function removePendingReturn(transferId) {
    await chrome.storage.local.remove(`${PENDING_RETURN_PREFIX}${transferId}`);
  }

  async function removePendingReturnMessage(transferId) {
    await chrome.storage.local.remove(`${PENDING_RETURN_MESSAGE_PREFIX}${transferId}`);
  }

  async function removePendingVideoReceiptPhoto(transferId) {
    await chrome.storage.local.remove(`${PENDING_VIDEO_RECEIPT_PHOTO_PREFIX}${transferId}`);
  }

  async function removePendingCancelProof(transferId) {
    await chrome.storage.local.remove(`${PENDING_CANCEL_PROOF_PREFIX}${transferId}`);
  }

  function waitForAppTransferAck(transferId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        appTransferAcks.delete(transferId);
        resolve({
          ok: false,
          transferId,
          error: "OG received the label handoff, but did not confirm upload within 5 minutes. Open the matching OG label modal/session and try again.",
        });
      }, APP_ACK_TIMEOUT_MS);

      appTransferAcks.set(transferId, {
        resolve: (status) => {
          clearTimeout(timer);
          appTransferAcks.delete(transferId);
          resolve(status);
        },
      });
    });
  }

  function waitForAppReportAck(transferId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        appReportAcks.delete(transferId);
        resolve({
          ok: false,
          transferId,
          error: "OG received the eBay report handoff, but did not confirm import within 5 minutes. Open Pending Orders and try again.",
        });
      }, APP_ACK_TIMEOUT_MS);

      appReportAcks.set(transferId, {
        resolve: (status) => {
          clearTimeout(timer);
          appReportAcks.delete(transferId);
          resolve(status);
        },
      });
    });
  }

  function waitForAppReturnAck(transferId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        appReturnAcks.delete(transferId);
        resolve({
          ok: false,
          transferId,
          error: "OG Returns opened, but did not confirm the return workflow within 5 minutes.",
        });
      }, APP_ACK_TIMEOUT_MS);

      appReturnAcks.set(transferId, {
        resolve: (status) => {
          clearTimeout(timer);
          appReturnAcks.delete(transferId);
          resolve(status);
        },
      });
    });
  }

  function waitForAppReturnMessageAck(transferId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        appReturnMessageAcks.delete(transferId);
        resolve({
          ok: false,
          transferId,
          error: "OG Returns opened, but did not confirm the eBay buyer-message log within 5 minutes.",
        });
      }, APP_ACK_TIMEOUT_MS);

      appReturnMessageAcks.set(transferId, {
        resolve: (status) => {
          clearTimeout(timer);
          appReturnMessageAcks.delete(transferId);
          resolve(status);
        },
      });
    });
  }

  function waitForAppVideoReceiptPhotoAck(transferId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        appVideoReceiptPhotoAcks.delete(transferId);
        resolve({
          ok: false,
          transferId,
          error: "OG Pending Orders opened, but did not confirm the video receipt photo within 5 minutes.",
        });
      }, APP_ACK_TIMEOUT_MS);

      appVideoReceiptPhotoAcks.set(transferId, {
        resolve: (status) => {
          clearTimeout(timer);
          appVideoReceiptPhotoAcks.delete(transferId);
          resolve(status);
        },
      });
    });
  }

  function waitForAppCancelProofAck(transferId) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        appCancelProofAcks.delete(transferId);
        resolve({
          ok: false,
          transferId,
          error: "OG Pending Orders opened, but did not confirm the cancellation proof within 5 minutes.",
        });
      }, APP_ACK_TIMEOUT_MS);

      appCancelProofAcks.set(transferId, {
        resolve: (status) => {
          clearTimeout(timer);
          appCancelProofAcks.delete(transferId);
          resolve(status);
        },
      });
    });
  }

  async function handleAppTransferStatus(status = {}, sender = null) {
    const transferId = status.transferId || "";
    if (!transferId) return;
    if (status.phase === "started" && status.tabId) {
      focusTab(status.tabId);
      return;
    }
    if (status.ok) await removePendingLabel(transferId);
    const waiter = appTransferAcks.get(transferId);
    if (waiter) {
      waiter.resolve(status);
      return;
    }
    if (status.returnToAwaiting) {
      await refreshAwaitingShipmentQueue({
        reason: status.reason || "og-label-exit",
        orderNumber: status.orderNumber || "",
        orderNumbers: status.orderNumbers || [],
        transferId,
        fastRefresh: true,
      }, sender).catch(() => null);
    }
  }

  async function handleAppReportStatus(status = {}) {
    const transferId = status.transferId || "";
    if (!transferId) return;
    if (status.phase === "started" && status.tabId) {
      focusTab(status.tabId);
      return;
    }
    if (status.ok) await removePendingReport(transferId);
    const waiter = appReportAcks.get(transferId);
    if (waiter) waiter.resolve(status);
  }

  async function handleAppReturnStatus(status = {}) {
    const transferId = status.transferId || "";
    if (!transferId) return;
    if (status.phase === "started") return;
    if (status.ok) await removePendingReturn(transferId);
    const waiter = appReturnAcks.get(transferId);
    if (waiter) waiter.resolve(status);
  }

  async function handleAppReturnMessageStatus(status = {}) {
    const transferId = status.transferId || "";
    if (!transferId) return;
    if (status.phase === "started") return;
    if (status.ok) await removePendingReturnMessage(transferId);
    const waiter = appReturnMessageAcks.get(transferId);
    if (waiter) waiter.resolve(status);
  }

  async function handleAppVideoReceiptPhotoStatus(status = {}) {
    const transferId = status.transferId || "";
    if (!transferId) return;
    if (status.phase === "started") return;
    if (status.ok) await removePendingVideoReceiptPhoto(transferId);
    if (status.ok && status.tabId) await focusTab(status.tabId);
    const waiter = appVideoReceiptPhotoAcks.get(transferId);
    if (waiter) waiter.resolve(status);
  }

  async function handleAppCancelProofStatus(status = {}) {
    const transferId = status.transferId || "";
    if (!transferId) return;
    if (status.phase === "started") return;
    if (status.ok) await removePendingCancelProof(transferId);
    if (status.ok && status.tabId) await focusTab(status.tabId);
    const waiter = appCancelProofAcks.get(transferId);
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
    return /\/(?:pending-orders|ebay-order-history|ebay-returns)\.html$/i.test(tabUrl.pathname);
  }

  async function findAppTabs(appUrl) {
    const tabs = await chrome.tabs.query({});
    const exact = tabs.filter((tab) => isExactAppTab(tab, appUrl));
    const sameOrigin = tabs.filter((tab) => isSameOriginOgTab(tab, appUrl) && !exact.some((entry) => entry.id === tab.id));
    return [...exact, ...sameOrigin];
  }

  function isEbayTab(tab) {
    const tabUrl = normalizeUrl(tab?.url);
    return Boolean(tabUrl && /(^|\.)ebay\.com$/i.test(tabUrl.hostname));
  }

  function isAwaitingShipmentTab(tab) {
    const tabUrl = normalizeUrl(tab?.url);
    if (!tabUrl || !/(^|\.)ebay\.com$/i.test(tabUrl.hostname)) return false;
    const path = tabUrl.pathname.replace(/\/+$/, "");
    if (path !== "/sh/ord") return false;
    const sample = `${tabUrl.search} ${tabUrl.hash} ${tab?.title || ""}`;
    return /AWAITING_SHIPMENT|awaiting shipment/i.test(sample);
  }

  function waitForTabComplete(tabId, timeoutMs = 25000, options = {}) {
    const allowAlreadyComplete = options.allowAlreadyComplete !== false;
    return new Promise((resolve) => {
      let settled = false;
      const finish = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        resolve(tab);
      };
      const timer = setTimeout(finish, timeoutMs);
      const onUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") finish();
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      if (allowAlreadyComplete) {
        chrome.tabs.get(tabId).then((tab) => {
          if (tab?.status === "complete") finish();
        }).catch(() => null);
      }
    });
  }

  async function sendMessageToTabWithRetry(tabId, message, options = {}) {
    const attempts = Math.max(1, Number(options.attempts || 12));
    const initialDelayMs = Number(options.initialDelayMs ?? 500);
    const retryDelayMs = Number(options.retryDelayMs ?? 500);
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const delay = attempt ? retryDelayMs : initialDelayMs;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        if (response) return response;
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(lastError?.message || "The eBay detail page did not answer the extension capture request.");
  }

  async function captureReturnDetailPage(payload = {}) {
    const detailsUrl = normalizeUrl(payload.detailsUrl);
    if (!detailsUrl || !/(^|\.)ebay\.com$/i.test(detailsUrl.hostname)) {
      throw new Error("The return detail URL is not an eBay page.");
    }

    const tab = await chrome.tabs.create({
      url: detailsUrl.toString(),
      active: false,
    });

    try {
      const response = await sendMessageToTabWithRetry(tab.id, {
        type: "OG_EBAY_CAPTURE_RETURN_DETAIL_PAGE",
        payload,
      }, {
        attempts: 30,
        initialDelayMs: 250,
        retryDelayMs: 450,
      });
      if (!response?.ok) throw new Error(response?.error || "The eBay detail page did not return complaint photos.");
      return response;
    } finally {
      if (tab?.id) chrome.tabs.remove(tab.id).catch(() => null);
    }
  }

  async function openVideoReceiptFromOrder(payload = {}) {
    const directUrl = normalizeVideoReceiptUrlForPayload(payload.videoReceiptUrl, payload);
    if (directUrl) {
      const tab = await chrome.tabs.create({ url: directUrl, active: true });
      return { ok: true, openedUrl: directUrl, tabId: tab.id || null, direct: true };
    }

    const itemUrl = normalizeUrl(payload.itemUrl || (payload.itemNumber ? `https://www.ebay.com/itm/${encodeURIComponent(payload.itemNumber)}` : ""));
    if (itemUrl && /(^|\.)ebay\.com$/i.test(itemUrl.hostname) && /\/itm\//i.test(itemUrl.pathname)) {
      const itemResponse = await fetch(itemUrl.toString(), { credentials: "include" }).catch(() => null);
      if (itemResponse?.ok) {
        const itemHtml = await itemResponse.text();
        const itemReceiptUrl = resolveVideoReceiptUrlInText(itemHtml, payload, itemUrl.toString());
        if (itemReceiptUrl) {
          const tab = await chrome.tabs.create({ url: itemReceiptUrl, active: true });
          return { ok: true, openedUrl: itemReceiptUrl, tabId: tab.id || null, direct: false, source: "item" };
        }
      }
    }

    const detailsUrl = normalizeUrl(payload.orderDetailsUrl || buildEbayOrderDetailsUrl(payload.orderNumber));
    if (!detailsUrl || !/(^|\.)ebay\.com$/i.test(detailsUrl.hostname) || !/\/mesh\/ord\/details/i.test(detailsUrl.pathname)) {
      throw new Error("The eBay order details URL is missing or invalid.");
    }

    const response = await fetch(detailsUrl.toString(), { credentials: "include" });
    if (!response.ok) {
      throw new Error(`eBay order details returned HTTP ${response.status}. Make sure you are signed in to eBay.`);
    }
    const html = await response.text();
    const receiptUrl = resolveVideoReceiptUrlInText(html, payload, detailsUrl.toString());
    if (!receiptUrl) {
      throw new Error("I could not match a video receipt URL to this item on the eBay order details page.");
    }
    const tab = await chrome.tabs.create({ url: receiptUrl, active: true });
    return { ok: true, openedUrl: receiptUrl, tabId: tab.id || null, direct: false };
  }

  async function askAwaitingTabToOrganize(tabId, payload = {}, options = {}) {
    const message = {
      type: "OG_EBAY_REORGANIZE_AWAITING_QUEUE",
      payload: {
        source: "og-pending-queue-changed",
        requestedAt: new Date().toISOString(),
        ...payload,
      },
    };
    const attempts = Math.max(1, Number(options.attempts || 6));
    const initialDelayMs = Number(options.initialDelayMs ?? 1200);
    const retryDelayMs = Number(options.retryDelayMs ?? 800);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const delay = attempt ? retryDelayMs : initialDelayMs;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const response = await chrome.tabs.sendMessage(tabId, message).catch(() => null);
      if (response?.ok) return response;
    }
    return { ok: false, error: "The eBay organizer content script did not answer yet." };
  }

  async function refreshAwaitingShipmentQueue(payload = {}, sender = null) {
    const priorityPromise = getPendingOrderPriorities({
      ...payload,
      useCache: false,
      requestedFor: "awaiting-queue-refresh",
    }).catch((error) => ({ ok: false, error: error.message || String(error) }));
    const tabs = await chrome.tabs.query({});
    const awaitingTabs = tabs.filter(isAwaitingShipmentTab);
    let targetTab = awaitingTabs.find((tab) => tab.active) || awaitingTabs[0] || null;
    let opened = false;
    let reloaded = false;
    let organized = false;
    let organizeResult = null;
    const forceReload = payload?.forceReload === true;

    if (targetTab?.id) {
      await focusTab(targetTab.id);
      if (!forceReload) {
        const priorityPayload = await priorityPromise;
        organizeResult = await askAwaitingTabToOrganize(targetTab.id, {
          ...payload,
          priorityPayload,
          fastRefresh: true,
        }, {
          attempts: 2,
          initialDelayMs: 0,
          retryDelayMs: 250,
        });
        organized = Boolean(organizeResult?.ok);
      }
      if (!organized) {
        await chrome.tabs.reload(targetTab.id);
        reloaded = true;
      }
    } else if (sender?.tab?.id && isEbayTab(sender.tab)) {
      targetTab = await chrome.tabs.update(sender.tab.id, {
        url: DEFAULT_AWAITING_SHIPMENT_URL,
        active: true,
      });
      opened = true;
    } else {
      targetTab = await chrome.tabs.create({
        url: DEFAULT_AWAITING_SHIPMENT_URL,
        active: true,
      });
      opened = true;
    }

    if (targetTab?.id) await focusTab(targetTab.id);
    const completedTab = targetTab?.id
      ? await waitForTabComplete(targetTab.id, 25000, { allowAlreadyComplete: !reloaded })
      : null;
    if (completedTab?.id && !organized) {
      const priorityPayload = await priorityPromise;
      organizeResult = await askAwaitingTabToOrganize(completedTab.id, {
        ...payload,
        priorityPayload,
      }, {
        initialDelayMs: opened ? 250 : 650,
        retryDelayMs: 350,
        attempts: opened ? 10 : 6,
      });
      organized = Boolean(organizeResult?.ok);
    }

    return {
      ok: Boolean(targetTab?.id),
      tabId: targetTab?.id || null,
      opened,
      reloaded,
      organized,
      fastRefresh: organized && !reloaded && !opened,
      organizeResult,
    };
  }

  function shouldRefreshQueueAfterLabelAck(response = {}) {
    return Boolean(response?.ok && (response.routedTo === "history" || response.extraLabel));
  }

  async function refreshQueueAfterHistoryLabelAck(response = {}, sender = null) {
    if (!shouldRefreshQueueAfterLabelAck(response)) return response;
    const awaitingRefresh = await refreshAwaitingShipmentQueue({
      reason: response.extraLabel ? "history-extra-label-attached" : "history-label-attached",
      orderNumber: response.orderNumber || "",
      orderNumbers: response.orderNumbers || [],
      transferId: response.transferId || "",
    }, sender).catch((error) => ({ ok: false, error: error.message || String(error) }));
    return { ...response, awaitingRefresh };
  }

  function buildAppPageUrl(appUrl, payload, pageName = "") {
    const url = new URL(appUrl.toString());
    if (pageName) {
      url.pathname = url.pathname.replace(/[^/]*$/, pageName);
    }
    url.searchParams.set("source", "ebay");
    if (payload.metadata?.orderId) url.searchParams.set("orderId", payload.metadata.orderId);
    const orderIds = Array.isArray(payload.metadata?.orderIds)
      ? payload.metadata.orderIds
      : Array.isArray(payload.metadata?.orderNumbers)
        ? payload.metadata.orderNumbers
        : [];
    if (orderIds.length) url.searchParams.set("orderIds", [...new Set(orderIds)].join(","));
    url.searchParams.set("labelTransferId", payload.transferId);
    return url;
  }

  function buildReportPageUrl(appUrl, payload, pageName = "") {
    const url = new URL(appUrl.toString());
    if (pageName) {
      url.pathname = url.pathname.replace(/[^/]*$/, pageName);
    }
    url.searchParams.set("source", "ebay");
    url.searchParams.set("reportTransferId", payload.transferId);
    return url;
  }

  function buildReturnPageUrl(appUrl, payload, pageName = "ebay-returns.html") {
    const url = new URL(appUrl.toString());
    if (pageName) {
      url.pathname = url.pathname.replace(/[^/]*$/, pageName);
    }
    url.searchParams.set("source", "ebay");
    url.searchParams.set("returnTransferId", payload.transferId);
    if (payload.return?.returnId) url.searchParams.set("ebayReturnId", payload.return.returnId);
    if (payload.return?.itemNumber) url.searchParams.set("itemNumber", payload.return.itemNumber);
    if (Array.isArray(payload.returns) && payload.returns.length) {
      url.searchParams.set("returnBatch", "1");
      url.searchParams.set("returnCount", String(payload.returns.length));
    }
    return url;
  }

  function buildReturnMessagePageUrl(appUrl, payload, pageName = "ebay-returns.html") {
    const url = new URL(appUrl.toString());
    if (pageName) {
      url.pathname = url.pathname.replace(/[^/]*$/, pageName);
    }
    url.searchParams.set("source", "ebay");
    url.searchParams.set("returnMessageTransferId", payload.transferId);
    if (payload.message?.returnId) url.searchParams.set("ebayReturnId", payload.message.returnId);
    if (payload.message?.orderNumber) url.searchParams.set("orderId", payload.message.orderNumber);
    return url;
  }

  function buildVideoReceiptPhotoPageUrl(appUrl, payload, pageName = "pending-orders.html") {
    const url = new URL(appUrl.toString());
    if (pageName) {
      url.pathname = url.pathname.replace(/[^/]*$/, pageName);
    }
    url.searchParams.set("source", "ebay");
    url.searchParams.set("videoReceiptPhotoTransferId", payload.transferId);
    if (payload.metadata?.itemNumber) url.searchParams.set("itemNumber", payload.metadata.itemNumber);
    if (payload.metadata?.orderNumber) url.searchParams.set("orderId", payload.metadata.orderNumber);
    return url;
  }

  function buildCancelProofPageUrl(appUrl, payload, pageName = "pending-orders.html") {
    const url = new URL(appUrl.toString());
    if (pageName) {
      url.pathname = url.pathname.replace(/[^/]*$/, pageName);
    }
    url.searchParams.set("source", "ebay");
    url.searchParams.set("cancelProofTransferId", payload.transferId);
    if (payload.metadata?.orderNumber) url.searchParams.set("orderId", payload.metadata.orderNumber);
    if (payload.metadata?.cancelId) url.searchParams.set("cancelId", payload.metadata.cancelId);
    return url;
  }

  function buildBuyerFocusPageUrl(appUrl, payload = {}, pageName = "pending-orders.html") {
    const url = new URL(appUrl.toString());
    if (pageName) {
      url.pathname = url.pathname.replace(/[^/]*$/, pageName);
    }
    const buyerUsername = String(payload.buyerUsername || payload.username || "").trim();
    url.searchParams.set("source", "ebay");
    if (buyerUsername) {
      url.searchParams.set("buyerUsername", buyerUsername);
      url.searchParams.set("buyer", buyerUsername);
    }
    if (payload.itemNumber) url.searchParams.set("itemNumber", payload.itemNumber);
    return url;
  }

  function isPendingOrdersState(state = {}) {
    return state.pageType === "pending-orders";
  }

  function getStateOrderNumber(state = {}) {
    return String(state.selectedOrderNumber || "").trim();
  }

  function stateHasActiveReceiver(state = {}) {
    return Boolean(getStateOrderNumber(state))
      || Boolean(state.labelModalOpen && Array.isArray(state.awaitingOrderNumbers) && state.awaitingOrderNumbers.length);
  }

  function stateMatchesOrder(state = {}, orderId = "") {
    if (!orderId) return false;
    const selectedOrder = getStateOrderNumber(state);
    if (selectedOrder) return selectedOrder === orderId;
    if (Array.isArray(state.awaitingOrderNumbers)) return state.awaitingOrderNumbers.includes(orderId);
    return false;
  }

  function isBulkLabelTransfer(label = {}) {
    return label.metadata?.source === "ebay-bulk-label-confirmation";
  }

  function queryReceiverState(tab, payload) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), RECEIVER_STATE_TIMEOUT_MS);
      chrome.tabs.sendMessage(tab.id, {
        type: "OG_EBAY_GET_LABEL_RECEIVER_STATE",
        payload,
      }).then((state) => {
        clearTimeout(timer);
        resolve(state?.ok ? { ...state, tab } : null);
      }).catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  async function getReceiverStates(tabs, payload) {
    const states = await Promise.all(tabs.map((tab) => queryReceiverState(tab, payload)));
    return states.filter(Boolean);
  }

  async function deliverLabelToTab(tab, payload) {
    const appAckPromise = waitForAppTransferAck(payload.transferId);
    await chrome.tabs.sendMessage(tab.id, { type: "OG_EBAY_LABEL_TRANSFER", payload });
    await focusTab(tab.id);
    return appAckPromise;
  }

  async function focusBuyerInPendingOrders(payload = {}) {
    const appUrl = await getAppUrl();
    if (!appUrl) throw new Error("Set the OG Pending Orders URL in the extension options first.");
    const buyerUsername = String(payload.buyerUsername || payload.username || "").trim();
    if (!buyerUsername) throw new Error("No eBay winner username was found yet.");

    const tabs = await findAppTabs(appUrl);
    const pendingTab = tabs.find((tab) => {
      const tabUrl = normalizeUrl(tab?.url);
      return tabUrl?.origin === appUrl.origin && /\/pending-orders\.html$/i.test(tabUrl.pathname);
    });

    if (pendingTab?.id) {
      const response = await sendMessageToTabWithRetry(pendingTab.id, {
        type: "OG_EBAY_FOCUS_BUYER",
        payload: {
          ...payload,
          buyerUsername,
          requestedAt: new Date().toISOString(),
        },
      }, {
        attempts: 6,
        initialDelayMs: 0,
        retryDelayMs: 350,
      }).catch((error) => ({ ok: false, error: error.message || String(error) }));
      await focusTab(pendingTab.id);
      return {
        ok: response?.ok !== false,
        buyerUsername,
        opened: false,
        delivered: Boolean(response?.ok),
        response,
        tabId: pendingTab.id,
      };
    }

    const url = buildBuyerFocusPageUrl(appUrl, payload);
    const tab = await openTransferUrl(url);
    return {
      ok: Boolean(tab?.id),
      buyerUsername,
      opened: Boolean(tab?.id),
      delivered: false,
      tabId: tab?.id || null,
    };
  }

  async function openTransferUrl(url, existingTab = null) {
    const tab = existingTab?.id
      ? await chrome.tabs.update(existingTab.id, { url: url.toString(), active: true })
      : await chrome.tabs.create({ url: url.toString(), active: true });
    if (tab?.id) await focusTab(tab.id);
    return tab;
  }

  async function openTransferPageAndWait(appUrl, payload, pageName, existingTab = null) {
    const appAckPromise = waitForAppTransferAck(payload.transferId);
    const url = buildAppPageUrl(appUrl, payload, pageName);
    await openTransferUrl(url, existingTab);
    return appAckPromise;
  }

  async function finishRoutedTransfer(appUrl, payload, firstAck, openedInfo = {}) {
    if (firstAck?.route === "history") {
      const historyAck = await openTransferPageAndWait(appUrl, payload, "ebay-order-history.html");
      return {
        ...historyAck,
        transferId: payload.transferId,
        delivered: false,
        opened: true,
        routedTo: "history",
      };
    }

    return {
      ...firstAck,
      transferId: payload.transferId,
      ...openedInfo,
    };
  }

  async function relayLabelToApp(label) {
    const appUrl = await getAppUrl();
    if (!appUrl) throw new Error("Set the OG Pending Orders URL in the extension options first.");

    const transferId = buildTransferId(label);
    const payload = { ...label, transferId };
    const orderId = String(label.metadata?.orderId || "").trim();
    const isBulkLabel = isBulkLabelTransfer(label);
    await storePendingLabel(transferId, payload);

    const tabs = await findAppTabs(appUrl);
    const receiverStates = await getReceiverStates(tabs, payload);
    const matchingReceiver = orderId
      ? receiverStates.find((state) => stateHasActiveReceiver(state) && stateMatchesOrder(state, orderId))
      : isBulkLabel
        ? receiverStates.find((state) => stateHasActiveReceiver(state))
        : null;
    if (matchingReceiver?.tab?.id) {
      const ack = await deliverLabelToTab(matchingReceiver.tab, payload);
      return finishRoutedTransfer(appUrl, payload, ack, { delivered: true, opened: false });
    }

    const activeMismatches = orderId
      ? receiverStates.filter((state) => stateHasActiveReceiver(state) && !stateMatchesOrder(state, orderId))
      : [];
    if (activeMismatches.length) {
      const mismatch = activeMismatches[0];
      await focusTab(mismatch.tab.id);
      const selected = getStateOrderNumber(mismatch) || (mismatch.awaitingOrderNumbers || []).join(", ");
      return {
        ok: false,
        transferId,
        delivered: false,
        opened: false,
        blocked: true,
        error: `OG already has an open label/session for ${selected || "another order"}. Close it or open the matching order ${orderId}, then click Send Label to OG again.`,
      };
    }

    const neutralPending = receiverStates.find((state) => isPendingOrdersState(state) && !stateHasActiveReceiver(state));
    if (neutralPending?.tab?.id) {
      const ack = await openTransferPageAndWait(appUrl, payload, "", neutralPending.tab);
      return finishRoutedTransfer(appUrl, payload, ack, {
        delivered: false,
        opened: true,
        reusedTab: true,
      });
    }

    const pendingTab = tabs.find((tab) => {
      const state = receiverStates.find((entry) => entry.tab?.id === tab.id);
      return !state && isExactAppTab(tab, appUrl);
    });
    if (pendingTab?.id) {
      const ack = await openTransferPageAndWait(appUrl, payload, "", pendingTab);
      return finishRoutedTransfer(appUrl, payload, ack, {
        delivered: false,
        opened: true,
        reusedTab: true,
      });
    }

    const ack = await openTransferPageAndWait(appUrl, payload, "");
    return finishRoutedTransfer(appUrl, payload, ack, { delivered: false, opened: true });
  }

  async function deliverReportToTab(tab, payload) {
    const appAckPromise = waitForAppReportAck(payload.transferId);
    await chrome.tabs.sendMessage(tab.id, { type: "OG_EBAY_AWAITING_REPORT_TRANSFER", payload });
    await focusTab(tab.id);
    return appAckPromise;
  }

  async function openReportTransferPageAndWait(appUrl, payload, existingTab = null) {
    const appAckPromise = waitForAppReportAck(payload.transferId);
    const url = buildReportPageUrl(appUrl, payload, "pending-orders.html");
    await openTransferUrl(url, existingTab);
    return appAckPromise;
  }

  async function relayAwaitingReportToApp(reportTransfer) {
    const appUrl = await getAppUrl();
    if (!appUrl) throw new Error("Set the OG Pending Orders URL in the extension options first.");

    const transferId = buildReportTransferId(reportTransfer);
    const payload = { ...reportTransfer, transferId };
    await storePendingReport(transferId, payload);

    const tabs = await findAppTabs(appUrl);
    const pendingTab = tabs.find((tab) => {
      const tabUrl = normalizeUrl(tab?.url);
      return tabUrl?.origin === appUrl.origin && /\/pending-orders\.html$/i.test(tabUrl.pathname);
    });

    if (pendingTab?.id) {
      try {
        const ack = await deliverReportToTab(pendingTab, payload);
        return {
          ...ack,
          transferId,
          delivered: true,
          opened: false,
        };
      } catch (error) {
        const ack = await openReportTransferPageAndWait(appUrl, payload, pendingTab);
        return {
          ...ack,
          transferId,
          delivered: false,
          opened: true,
          reusedTab: true,
          recoveredFromMissingBridge: /receiving end|connection/i.test(error?.message || ""),
        };
      }
    }

    const reusableTab = tabs[0] || null;
    const ack = await openReportTransferPageAndWait(appUrl, payload, reusableTab);
    return {
      ...ack,
      transferId,
      delivered: false,
      opened: true,
      reusedTab: Boolean(reusableTab),
    };
  }

  async function deliverReturnToTab(tab, payload) {
    const appAckPromise = waitForAppReturnAck(payload.transferId);
    await chrome.tabs.sendMessage(tab.id, { type: "OG_EBAY_RETURN_TRANSFER", payload });
    await focusTab(tab.id);
    return appAckPromise;
  }

  async function openReturnTransferPageAndWait(appUrl, payload, existingTab = null) {
    const appAckPromise = waitForAppReturnAck(payload.transferId);
    const url = buildReturnPageUrl(appUrl, payload);
    await openTransferUrl(url, existingTab);
    return appAckPromise;
  }

  async function deliverReturnMessageToTab(tab, payload) {
    const appAckPromise = waitForAppReturnMessageAck(payload.transferId);
    await chrome.tabs.sendMessage(tab.id, { type: "OG_EBAY_RETURN_MESSAGE_LOG", payload });
    return appAckPromise;
  }

  async function openReturnMessagePageAndWait(appUrl, payload, existingTab = null) {
    const appAckPromise = waitForAppReturnMessageAck(payload.transferId);
    const url = buildReturnMessagePageUrl(appUrl, payload);
    await openTransferUrl(url, existingTab);
    return appAckPromise;
  }

  async function relayReturnToApp(returnTransfer) {
    const appUrl = await getAppUrl();
    if (!appUrl) throw new Error("Set the OG Pending Orders URL in the extension options first.");

    const transferId = buildReturnTransferId(returnTransfer);
    const payload = { ...returnTransfer, transferId };
    await storePendingReturn(transferId, payload);

    const tabs = await findAppTabs(appUrl);
    const returnsTab = tabs.find((tab) => {
      const tabUrl = normalizeUrl(tab?.url);
      return tabUrl?.origin === appUrl.origin && /\/ebay-returns\.html$/i.test(tabUrl.pathname);
    });
    const historyTab = tabs.find((tab) => {
      const tabUrl = normalizeUrl(tab?.url);
      return tabUrl?.origin === appUrl.origin && /\/ebay-order-history\.html$/i.test(tabUrl.pathname);
    });
    const returnWorkflowTab = returnsTab || historyTab;

    if (returnWorkflowTab?.id) {
      try {
        const ack = await deliverReturnToTab(returnWorkflowTab, payload);
        return {
          ...ack,
          transferId,
          delivered: true,
          opened: false,
        };
      } catch (error) {
        const ack = await openReturnTransferPageAndWait(appUrl, payload, returnWorkflowTab);
        return {
          ...ack,
          transferId,
          delivered: false,
          opened: true,
          reusedTab: true,
          recoveredFromMissingBridge: /receiving end|connection/i.test(error?.message || ""),
        };
      }
    }

    const reusableTab = tabs[0] || null;
    const ack = await openReturnTransferPageAndWait(appUrl, payload, reusableTab);
    return {
      ...ack,
      transferId,
      delivered: false,
      opened: true,
      reusedTab: Boolean(reusableTab),
    };
  }

  async function relayReturnMessageToApp(messageTransfer) {
    const appUrl = await getAppUrl();
    if (!appUrl) throw new Error("Set the OG Pending Orders URL in the extension options first.");

    const transferId = buildReturnMessageTransferId(messageTransfer);
    const payload = { ...messageTransfer, transferId };
    await storePendingReturnMessage(transferId, payload);

    const tabs = await findAppTabs(appUrl);
    const returnsTab = tabs.find((tab) => {
      const tabUrl = normalizeUrl(tab?.url);
      return tabUrl?.origin === appUrl.origin && /\/ebay-returns\.html$/i.test(tabUrl.pathname);
    });
    const historyTab = tabs.find((tab) => {
      const tabUrl = normalizeUrl(tab?.url);
      return tabUrl?.origin === appUrl.origin && /\/ebay-order-history\.html$/i.test(tabUrl.pathname);
    });
    const returnWorkflowTab = returnsTab || historyTab;

    if (returnWorkflowTab?.id) {
      try {
        const ack = await deliverReturnMessageToTab(returnWorkflowTab, payload);
        return {
          ...ack,
          transferId,
          delivered: true,
          opened: false,
        };
      } catch (error) {
        const ack = await openReturnMessagePageAndWait(appUrl, payload, returnWorkflowTab);
        return {
          ...ack,
          transferId,
          delivered: false,
          opened: true,
          reusedTab: true,
          recoveredFromMissingBridge: /receiving end|connection/i.test(error?.message || ""),
        };
      }
    }

    const reusableTab = tabs[0] || null;
    const ack = await openReturnMessagePageAndWait(appUrl, payload, reusableTab);
    return {
      ...ack,
      transferId,
      delivered: false,
      opened: true,
      reusedTab: Boolean(reusableTab),
    };
  }

  async function deliverVideoReceiptPhotoToTab(tab, payload) {
    const appAckPromise = waitForAppVideoReceiptPhotoAck(payload.transferId);
    await chrome.tabs.sendMessage(tab.id, { type: "OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER", payload });
    return appAckPromise;
  }

  async function openVideoReceiptPhotoPageAndWait(appUrl, payload, existingTab = null) {
    const appAckPromise = waitForAppVideoReceiptPhotoAck(payload.transferId);
    const url = buildVideoReceiptPhotoPageUrl(appUrl, payload);
    await openTransferUrl(url, existingTab);
    return appAckPromise;
  }

  async function relayVideoReceiptPhotoToApp(photoTransfer) {
    const appUrl = await getAppUrl();
    if (!appUrl) throw new Error("Set the OG Pending Orders URL in the extension options first.");

    const transferId = buildVideoReceiptPhotoTransferId(photoTransfer);
    const payload = { ...photoTransfer, transferId };
    await storePendingVideoReceiptPhoto(transferId, payload);

    const tabs = await findAppTabs(appUrl);
    const pendingTab = tabs.find((tab) => {
      const tabUrl = normalizeUrl(tab?.url);
      return tabUrl?.origin === appUrl.origin && /\/pending-orders\.html$/i.test(tabUrl.pathname);
    });

    if (pendingTab?.id) {
      try {
        const ack = await deliverVideoReceiptPhotoToTab(pendingTab, payload);
        if (ack?.ok) await focusTab(pendingTab.id);
        return { ...ack, transferId, delivered: true, opened: false };
      } catch (error) {
        const ack = await openVideoReceiptPhotoPageAndWait(appUrl, payload, pendingTab);
        return {
          ...ack,
          transferId,
          delivered: false,
          opened: true,
          reusedTab: true,
          recoveredFromMissingBridge: /receiving end|connection/i.test(error?.message || ""),
        };
      }
    }

    const reusableTab = tabs[0] || null;
    const ack = await openVideoReceiptPhotoPageAndWait(appUrl, payload, reusableTab);
    return {
      ...ack,
      transferId,
      delivered: false,
      opened: true,
      reusedTab: Boolean(reusableTab),
    };
  }

  async function deliverCancelProofToTab(tab, payload) {
    const appAckPromise = waitForAppCancelProofAck(payload.transferId);
    await chrome.tabs.sendMessage(tab.id, { type: "OG_EBAY_CANCEL_PROOF_TRANSFER", payload });
    return appAckPromise;
  }

  async function openCancelProofPageAndWait(appUrl, payload, existingTab = null) {
    const appAckPromise = waitForAppCancelProofAck(payload.transferId);
    const url = buildCancelProofPageUrl(appUrl, payload);
    await openTransferUrl(url, existingTab);
    return appAckPromise;
  }

  async function relayCancelProofToApp(proofTransfer) {
    const appUrl = await getAppUrl();
    if (!appUrl) throw new Error("Set the OG Pending Orders URL in the extension options first.");

    const transferId = buildCancelProofTransferId(proofTransfer);
    const payload = { ...proofTransfer, transferId };
    await storePendingCancelProof(transferId, payload);

    const tabs = await findAppTabs(appUrl);
    const pendingTab = tabs.find((tab) => {
      const tabUrl = normalizeUrl(tab?.url);
      return tabUrl?.origin === appUrl.origin && /\/pending-orders\.html$/i.test(tabUrl.pathname);
    });

    if (pendingTab?.id) {
      try {
        const ack = await deliverCancelProofToTab(pendingTab, payload);
        if (ack?.ok) await focusTab(pendingTab.id);
        return { ...ack, transferId, delivered: true, opened: false };
      } catch (error) {
        const ack = await openCancelProofPageAndWait(appUrl, payload, pendingTab);
        return {
          ...ack,
          transferId,
          delivered: false,
          opened: true,
          reusedTab: true,
          recoveredFromMissingBridge: /receiving end|connection/i.test(error?.message || ""),
        };
      }
    }

    const reusableTab = tabs[0] || null;
    const ack = await openCancelProofPageAndWait(appUrl, payload, reusableTab);
    return {
      ...ack,
      transferId,
      delivered: false,
      opened: true,
      reusedTab: Boolean(reusableTab),
    };
  }

  async function captureVideoReceiptFrame(payload = {}, sender = null) {
    const tab = sender?.tab;
    if (!tab?.windowId) throw new Error("The video receipt tab was not available for screenshot capture.");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (!dataUrl) throw new Error("Chrome did not return a screenshot for the video receipt.");
    const base64 = String(dataUrl).split(",")[1] || "";
    if (!base64) throw new Error("The screenshot payload was empty.");
    return relayVideoReceiptPhotoToApp({
      metadata: {
        ...(payload.metadata || {}),
        source: "ebay-video-receipt",
        pageUrl: payload.pageUrl || tab.url || "",
        pageTitle: payload.pageTitle || tab.title || "",
        capturedAt: new Date().toISOString(),
      },
      screenshot: {
        source: "chrome-visible-tab",
        mimeType: "image/png",
        base64,
        dataUrl,
        viewport: payload.viewport || null,
        videoRect: payload.videoRect || null,
        capturedAt: new Date().toISOString(),
      },
    });
  }

  async function captureVisibleTabScreenshot(payload = {}, sender = null) {
    const tab = sender?.tab;
    if (!tab?.windowId) throw new Error("The current tab was not available for screenshot capture.");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (!dataUrl) throw new Error("Chrome did not return a screenshot.");
    const base64 = String(dataUrl).split(",")[1] || "";
    if (!base64) throw new Error("The screenshot payload was empty.");
    return {
      dataUrl,
      mimeType: "image/png",
      base64,
      metadata: {
        ...(payload.metadata || {}),
        pageUrl: payload.pageUrl || tab.url || "",
        pageTitle: payload.pageTitle || tab.title || "",
        capturedAt: new Date().toISOString(),
      },
      viewport: payload.viewport || null,
    };
  }

  async function captureCancelConfirmationFrame(payload = {}, sender = null) {
    const tab = sender?.tab;
    if (!tab?.windowId) throw new Error("The eBay cancellation confirmation tab was not available for screenshot capture.");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (!dataUrl) throw new Error("Chrome did not return a screenshot for the cancellation confirmation.");
    const base64 = String(dataUrl).split(",")[1] || "";
    if (!base64) throw new Error("The screenshot payload was empty.");
    return relayCancelProofToApp({
      metadata: {
        ...(payload.metadata || {}),
        source: "ebay-cancel-confirmation",
        pageUrl: payload.pageUrl || tab.url || "",
        pageTitle: payload.pageTitle || tab.title || "",
        capturedAt: new Date().toISOString(),
      },
      screenshot: {
        source: "chrome-visible-tab",
        mimeType: "image/png",
        base64,
        dataUrl,
        viewport: payload.viewport || null,
        capturedAt: new Date().toISOString(),
      },
    });
  }

  async function getPendingOrderPriorities(payload = {}) {
    const cacheAllowed = payload.useCache !== false;
    if (
      cacheAllowed
      && pendingPriorityCache
      && Date.now() - pendingPriorityCacheAt < PENDING_PRIORITY_CACHE_TTL_MS
    ) {
      return {
        ...pendingPriorityCache,
        ok: true,
        cacheHit: true,
      };
    }

    const appUrl = await getAppUrl();
    if (!appUrl) throw new Error("Set the OG Pending Orders URL in the extension options first.");

    const tabs = await findAppTabs(appUrl);
    const pendingTab = tabs.find((tab) => {
      const tabUrl = normalizeUrl(tab?.url);
      return tabUrl?.origin === appUrl.origin && /\/pending-orders\.html$/i.test(tabUrl.pathname);
    });
    if (!pendingTab?.id) {
      throw new Error("Open OG Pending Orders in another tab, then click Prioritize OG Due Orders again.");
    }

    const response = await chrome.tabs.sendMessage(pendingTab.id, {
      type: "OG_EBAY_GET_PENDING_PRIORITIES",
      payload,
    });
    if (!response?.ok) throw new Error(response?.error || "OG Pending Orders did not return due-order priorities.");
    pendingPriorityCache = response;
    pendingPriorityCacheAt = Date.now();
    return response;
  }

  function beginDownloadCapture(payload, sender) {
    const captureId = crypto.randomUUID();
    const capture = {
      captureId,
      tabId: sender?.tab?.id || null,
      kind: payload?.kind || "label",
      metadata: payload?.metadata || {},
      pageUrl: payload?.pageUrl || sender?.tab?.url || "",
      startedAt: Date.now(),
      timeoutMs: payload?.kind === "awaiting-orders-report" ? REPORT_DOWNLOAD_CAPTURE_TIMEOUT_MS : DOWNLOAD_CAPTURE_TIMEOUT_MS,
      matchedDownloadIds: new Set(),
      finished: false,
      timer: null,
    };
    capture.timer = setTimeout(() => {
      downloadCaptures.delete(captureId);
    }, capture.timeoutMs);
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

    if (capture.kind === "awaiting-orders-report") {
      const looksLikeEbayReport = /ebay\.com|blob:https:\/\/www\.ebay\.com/.test(text)
        && /ordersreport|orders-report|order-report|download|report|csv|xlsx|sh-orders/.test(text);
      return looksLikeEbayReport;
    }

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
      .filter((capture) => Date.now() - capture.startedAt <= (capture.timeoutMs || DOWNLOAD_CAPTURE_TIMEOUT_MS))
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

  function filenameFromDownloadItem(item, fallback = "eBay-OrdersReport.csv") {
    const raw = String(item?.filename || item?.url || item?.finalUrl || "").split(/[\\/]/).pop() || fallback;
    try {
      return decodeURIComponent(raw.split(/[?#]/)[0] || fallback);
    } catch (_) {
      return raw.split(/[?#]/)[0] || fallback;
    }
  }

  function isLikelyEbayOrdersReportText(text) {
    return /(^|,|\n)\s*"?Order Number"?\s*(,|\n)/i.test(text)
      && /(^|,|\n)\s*"?Item Title"?\s*(,|\n)/i.test(text);
  }

  async function fetchDownloadItemAsReport(item) {
    const url = item?.finalUrl || item?.url || "";
    if (!url) throw new Error("The browser download did not expose a URL.");
    if (url.startsWith("blob:")) {
      throw new Error("The eBay report used a blob URL. The page probe must capture that before download.");
    }

    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`The eBay report download URL returned HTTP ${response.status}.`);

    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const sample = new TextDecoder("utf-8").decode(buffer.slice(0, Math.min(buffer.byteLength, 12000)));
    if (!isLikelyEbayOrdersReportText(sample)) {
      throw new Error("The browser-exposed report download URL did not return the eBay Orders Report CSV.");
    }
    const filename = filenameFromDownloadItem(item);
    const mimeType = blob.type || item?.mime || "text/csv";
    return {
      source: "browser-download-url",
      url: response.url || url,
      filename,
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
      if (capture.kind === "awaiting-orders-report") {
        const report = await fetchDownloadItemAsReport(item);
        const response = await relayAwaitingReportToApp({
          metadata: capture.metadata,
          report,
        });
        finishDownloadCapture(capture.captureId);
        if (capture.tabId !== null) {
          chrome.tabs.sendMessage(capture.tabId, {
            type: "OG_EBAY_AWAITING_REPORT_CAPTURE_RESULT",
            captureId: capture.captureId,
            result: response,
          }).catch(() => null);
        }
        return;
      }

      const label = await fetchDownloadItemAsLabel(item);
      const response = await relayLabelToApp({
        metadata: capture.metadata,
        label,
      });
      const finalResponse = await refreshQueueAfterHistoryLabelAck(response, { tab: { id: capture.tabId } });
      finishDownloadCapture(capture.captureId);
      if (capture.tabId !== null) {
        chrome.tabs.sendMessage(capture.tabId, {
          type: "OG_EBAY_DOWNLOAD_CAPTURE_RESULT",
          captureId: capture.captureId,
          result: finalResponse,
        }).catch(() => null);
      }
    } catch (error) {
      if (capture.tabId !== null) {
        chrome.tabs.sendMessage(capture.tabId, {
          type: capture.kind === "awaiting-orders-report"
            ? "OG_EBAY_AWAITING_REPORT_CAPTURE_RESULT"
            : "OG_EBAY_DOWNLOAD_CAPTURE_RESULT",
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
        .then((response) => refreshQueueAfterHistoryLabelAck(response, _sender))
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_LABEL_TRANSFER_STATUS") {
      handleAppTransferStatus({
        ...(message.payload || {}),
        tabId: _sender?.tab?.id || message.payload?.tabId || null,
      }, _sender)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_AWAITING_REPORT_TRANSFER_STATUS") {
      handleAppReportStatus({
        ...(message.payload || {}),
        tabId: _sender?.tab?.id || message.payload?.tabId || null,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_RETURN_TRANSFER_STATUS") {
      handleAppReturnStatus({
        ...(message.payload || {}),
        tabId: _sender?.tab?.id || message.payload?.tabId || null,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_RETURN_MESSAGE_LOG_STATUS") {
      handleAppReturnMessageStatus({
        ...(message.payload || {}),
        tabId: _sender?.tab?.id || message.payload?.tabId || null,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER_STATUS") {
      handleAppVideoReceiptPhotoStatus({
        ...(message.payload || {}),
        tabId: _sender?.tab?.id || message.payload?.tabId || null,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_CANCEL_PROOF_TRANSFER_STATUS") {
      handleAppCancelProofStatus({
        ...(message.payload || {}),
        tabId: _sender?.tab?.id || message.payload?.tabId || null,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_SEND_AWAITING_REPORT") {
      relayAwaitingReportToApp(message.payload)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_SEND_RETURN" || message.type === "OG_EBAY_SEND_RETURN_BATCH") {
      relayReturnToApp(message.payload)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_LOG_RETURN_MESSAGE") {
      relayReturnMessageToApp(message.payload)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_CAPTURE_RETURN_DETAIL_PAGE") {
      captureReturnDetailPage(message.payload || {})
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_OPEN_VIDEO_RECEIPT") {
      openVideoReceiptFromOrder(message.payload || {})
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_CAPTURE_VIDEO_RECEIPT_FRAME") {
      captureVideoReceiptFrame(message.payload || {}, _sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_CAPTURE_VISIBLE_TAB_SCREENSHOT") {
      captureVisibleTabScreenshot(message.payload || {}, _sender)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_FOCUS_PENDING_BUYER") {
      focusBuyerInPendingOrders(message.payload || {})
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_CAPTURE_CANCEL_CONFIRMATION") {
      captureCancelConfirmationFrame(message.payload || {}, _sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_PENDING_QUEUE_CHANGED") {
      refreshAwaitingShipmentQueue(message.payload || {}, _sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_GET_PENDING_PRIORITIES") {
      getPendingOrderPriorities(message.payload)
        .then(sendResponse)
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

    if (message.type === "OG_EBAY_GET_PENDING_REPORT") {
      getPendingReport(message.transferId)
        .then((payload) => sendResponse({ ok: true, payload }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_GET_PENDING_RETURN") {
      getPendingReturn(message.transferId)
        .then((payload) => sendResponse({ ok: true, payload }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_GET_PENDING_RETURN_MESSAGE") {
      getPendingReturnMessage(message.transferId)
        .then((payload) => sendResponse({ ok: true, payload }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_GET_PENDING_VIDEO_RECEIPT_PHOTO") {
      getPendingVideoReceiptPhoto(message.transferId)
        .then((payload) => sendResponse({ ok: true, payload }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_GET_PENDING_CANCEL_PROOF") {
      getPendingCancelProof(message.transferId)
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

    if (message.type === "OG_EBAY_CLEAR_PENDING_REPORT") {
      removePendingReport(message.transferId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_CLEAR_PENDING_RETURN") {
      removePendingReturn(message.transferId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_CLEAR_PENDING_RETURN_MESSAGE") {
      removePendingReturnMessage(message.transferId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_CLEAR_PENDING_VIDEO_RECEIPT_PHOTO") {
      removePendingVideoReceiptPhoto(message.transferId)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message.type === "OG_EBAY_CLEAR_PENDING_CANCEL_PROOF") {
      removePendingCancelProof(message.transferId)
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
