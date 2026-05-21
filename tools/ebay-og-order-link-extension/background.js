(function () {
  "use strict";

  const APP_URL_KEY = "ogPendingOrdersUrl";
  const PENDING_LABEL_PREFIX = "ogPendingLabel:";
  const PENDING_REPORT_PREFIX = "ogPendingReport:";
  const DOWNLOAD_CAPTURE_TIMEOUT_MS = 45000;
  const REPORT_DOWNLOAD_CAPTURE_TIMEOUT_MS = 180000;
  const APP_ACK_TIMEOUT_MS = 300000;
  const RECEIVER_STATE_TIMEOUT_MS = 900;
  const DEFAULT_AWAITING_SHIPMENT_URL = "https://www.ebay.com/sh/ord/?filter=status:AWAITING_SHIPMENT";
  const downloadCaptures = new Map();
  const appTransferAcks = new Map();
  const appReportAcks = new Map();

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

  function buildReportTransferId(report = {}) {
    const file = String(report.report?.filename || report.metadata?.filename || "awaiting-orders-report")
      .replace(/[^a-z0-9._-]/gi, "-")
      .slice(0, 70);
    return `report:${file || "awaiting-orders-report"}:${Date.now()}`;
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

  async function removePendingLabel(transferId) {
    await chrome.storage.local.remove(`${PENDING_LABEL_PREFIX}${transferId}`);
  }

  async function removePendingReport(transferId) {
    await chrome.storage.local.remove(`${PENDING_REPORT_PREFIX}${transferId}`);
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
        organizeResult = await askAwaitingTabToOrganize(targetTab.id, {
          ...payload,
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
      organizeResult = await askAwaitingTabToOrganize(completedTab.id, payload);
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

  async function getPendingOrderPriorities(payload = {}) {
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
      })
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

    if (message.type === "OG_EBAY_SEND_AWAITING_REPORT") {
      relayAwaitingReportToApp(message.payload)
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

    if (message.type === "OG_EBAY_GET_APP_URL") {
      getAppUrl()
        .then((url) => sendResponse({ ok: true, appUrl: url?.toString() || "" }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    return false;
  });
})();
