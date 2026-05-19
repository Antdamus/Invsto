(function () {
  "use strict";

  const ORDER_LINK_SELECTOR = 'a[data-testid^="unique-order-id-link-"]';
  const ORDER_NUMBER_PATTERN = /\b\d{2}-\d{5}-\d{5}\b/;
  const STORAGE_KEY = "ogPendingOrdersUrl";
  const BUTTON_CLASS = "og-ebay-open-order";
  const FLOATING_ID = "og-ebay-open-all-orders";
  const SINGLE_ORDER_ID = "og-ebay-open-single-order";
  const SEND_LABEL_ID = "og-ebay-send-label";
  const SEND_AWAITING_REPORT_ID = "og-ebay-send-awaiting-report";
  const LABEL_EVENT_TYPE = "OG_EBAY_LABEL_CAPTURED";
  const LABEL_PROBE_READY_EVENT_TYPE = "OG_EBAY_LABEL_PROBE_READY";
  const REPORT_EVENT_TYPE = "OG_EBAY_AWAITING_REPORT_CAPTURED";
  const REPORT_PROBE_READY_EVENT_TYPE = "OG_EBAY_AWAITING_REPORT_PROBE_READY";
  const LABEL_STATUS_TIMEOUT_MS = 30000;
  const LABEL_PROBE_READY_TIMEOUT_MS = 5000;
  const REPORT_STATUS_TIMEOUT_MS = 120000;
  const REPORT_PROBE_READY_TIMEOUT_MS = 5000;

  function normalizeOrderNumber(value) {
    const match = String(value || "").match(ORDER_NUMBER_PATTERN);
    return match ? match[0] : "";
  }

  function getOrderLinks() {
    return [...document.querySelectorAll(ORDER_LINK_SELECTOR)]
      .map((link) => ({
        link,
        orderNumber: normalizeOrderNumber(link.textContent || link.getAttribute("href") || link.dataset.testid),
      }))
      .filter((entry) => entry.orderNumber);
  }

  function uniqueOrderNumbers() {
    return [...new Set(getOrderLinks().map((entry) => entry.orderNumber))];
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function getText(selector, root = document) {
    return cleanText(root.querySelector(selector)?.textContent || root.querySelector(selector)?.innerText || "");
  }

  function getTextLines(selector, root = document) {
    const element = root.querySelector(selector);
    return String(element?.innerText || element?.textContent || "")
      .split(/\n+/)
      .map(cleanText)
      .filter(Boolean);
  }

  function getValueByHeading(label) {
    const expected = String(label || "").trim().toLowerCase();
    const headings = [...document.querySelectorAll('[data-testid="order-page"] h3')];
    const heading = headings.find((entry) => cleanText(entry.textContent).toLowerCase() === expected);
    const container = heading?.parentElement;
    if (!container) return "";

    const clone = container.cloneNode(true);
    clone.querySelector("h3")?.remove();
    clone.querySelectorAll("button, svg, .infotip, .infotip__overlay").forEach((element) => element.remove());
    return cleanText(clone.textContent || clone.innerText || "");
  }

  function encodeBase64UrlJson(value) {
    try {
      const json = JSON.stringify(value);
      const bytes = new TextEncoder().encode(json);
      let binary = "";
      bytes.forEach((byte) => {
        binary += String.fromCharCode(byte);
      });
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    } catch (error) {
      console.warn("Could not encode eBay order snapshot:", error);
      return "";
    }
  }

  function getSingleLabelOrderNumber() {
    const fromPath = normalizeOrderNumber(window.location.pathname);
    if (fromPath) return fromPath;

    const packingSlip = document.querySelector('[data-testid="packingslip-new-tab-link"]');
    const fromPackingSlip = normalizeOrderNumber(packingSlip?.getAttribute("href"));
    if (fromPackingSlip) return fromPackingSlip;

    const surveyLink = document.querySelector('a[href*="ctx_order_id="]');
    const fromSurvey = normalizeOrderNumber(surveyLink?.getAttribute("href"));
    if (fromSurvey) return fromSurvey;

    return "";
  }

  function isSingleLabelPage() {
    return Boolean(
      getSingleLabelOrderNumber()
      && document.querySelector('[data-testid="order-page"]')
      && document.querySelector('[data-testid="ship-to-address"]')
    );
  }

  function getSelectedServiceSnapshot() {
    const row = document.querySelector('input[name="service"]:checked')?.closest('[data-testid="service"]');
    if (!row) return {};
    return {
      name: getText('[data-testid="service-title"]', row),
      price: getText('[data-testid="service-price"]', row),
      estimatedDelivery: getText('[data-testid="service-estimated-delivery-date"]', row),
      includedCoverage: getText('[data-testid="included-compensation-amount"]', row),
      qrCode: getText('[data-testid="service-qr-code-availability"]', row),
    };
  }

  function getPackageSnapshot() {
    return {
      weightPounds: document.querySelector('input[aria-label="Package weight in pounds"]')?.value || "",
      weightOunces: document.querySelector('input[aria-label="Package weight in ounces"]')?.value || "",
      lengthInches: document.querySelector('input[aria-label="Package length in inches"]')?.value || "",
      widthInches: document.querySelector('input[aria-label="Package width in inches"]')?.value || "",
      heightInches: document.querySelector('input[aria-label="Package height in inches"]')?.value || "",
    };
  }

  function tryParseJsonish(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function findValueInObject(value, keys) {
    if (!value || typeof value !== "object") return "";
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findValueInObject(item, keys);
        if (found) return found;
      }
      return "";
    }

    for (const [key, entry] of Object.entries(value)) {
      if (keys.includes(String(key).toLowerCase())) return String(entry ?? "");
      const found = findValueInObject(entry, keys);
      if (found) return found;
    }
    return "";
  }

  function parseMetadataValue(source, keys) {
    const text = String(source || "");
    const lowerKeys = keys.map((key) => key.toLowerCase());
    const parsed = tryParseJsonish(text);
    const fromJson = findValueInObject(parsed, lowerKeys);
    if (fromJson) return fromJson;

    for (const key of lowerKeys) {
      const patterns = [
        new RegExp(`["']?${key}["']?\\s*[:=]\\s*["']([^"']+)["']`, "i"),
        new RegExp(`${key}=([^&\\s,}]+)`, "i"),
      ];
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]) return cleanText(match[1]);
      }
    }
    return "";
  }

  function getElementMetadataText(element) {
    if (!element) return "";
    const chunks = [];
    for (const attribute of element.attributes || []) {
      chunks.push(attribute.name, attribute.value);
    }
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
      for (const attribute of parent.attributes || []) {
        if (/data|click|tracking|spm/i.test(attribute.name)) chunks.push(attribute.name, attribute.value);
      }
    }
    chunks.push(document.body?.innerText || "");
    return chunks.join("\n");
  }

  function getShippingActions() {
    return document.querySelector('[data-testid="shipping-actions"]');
  }

  function getDownloadLabelButton() {
    const actions = getShippingActions();
    return actions?.querySelector('button[aria-label="Download label"]')
      || document.querySelector('[data-testid="shipping-actions"] button[aria-label*="Download" i]');
  }

  function getPrintLabelButton() {
    const actions = getShippingActions();
    return actions?.querySelector('button[aria-label="Print label"]')
      || document.querySelector('[data-testid="shipping-actions"] button[aria-label*="Print" i]');
  }

  function isElementVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== "hidden"
      && style.display !== "none"
      && !element.closest("[hidden], [aria-hidden='true']");
  }

  function getPageTextSample() {
    return [
      document.title,
      document.body?.innerText || "",
      ...[...document.scripts].slice(0, 20).map((script) => script.textContent || ""),
    ].join("\n");
  }

  function getAwaitingOrdersSummaryText() {
    const text = document.body?.innerText || "";
    const match = text.match(/Results:\s*\d+\s*-\s*\d+\s*of\s*\d+/i)
      || text.match(/Results:\s*\d+\s*of\s*\d+/i);
    return cleanText(match?.[0] || "");
  }

  function getDownloadReportButton() {
    const scoped = [
      ...document.querySelectorAll(".downloadReport button, .downloadReport a, [id*='downloadReport' i] button, [id*='downloadReport' i] a, [data-testid*='download' i] button, [data-testid*='download' i] a"),
    ].find((control) => {
      const text = cleanText(control.textContent || control.getAttribute("aria-label"));
      return isElementVisible(control) && /^Download report$/i.test(text);
    });
    if (scoped) return scoped;

    return [...document.querySelectorAll("button, a")]
      .find((control) => {
        const text = cleanText(control.textContent || control.getAttribute("aria-label"));
        return isElementVisible(control) && /^Download report$/i.test(text);
      }) || null;
  }

  function isAwaitingShipmentOrdersPage() {
    const sample = getPageTextSample();
    return /Manage orders awaiting shipment/i.test(sample)
      && /Results:/i.test(sample)
      && Boolean(getDownloadReportButton())
      && (/orders-download-report/i.test(sample) || /Download report/i.test(sample));
  }

  function getAwaitingReportMetadata() {
    return {
      source: "ebay-awaiting-shipment-report",
      pageUrl: window.location.href,
      pageTitle: document.title || "",
      visibleSummaryText: getAwaitingOrdersSummaryText(),
      capturedAt: new Date().toISOString(),
    };
  }

  function getLabelMetadata() {
    const downloadButton = getDownloadLabelButton();
    const printButton = getPrintLabelButton();
    const metadataText = getElementMetadataText(downloadButton || printButton || getShippingActions());
    const fromPage = getSingleLabelOrderNumber() || normalizeOrderNumber(window.location.href) || normalizeOrderNumber(metadataText);
    return {
      orderId: normalizeOrderNumber(parseMetadataValue(metadataText, ["order_id", "orderId", "order_number", "orderNumber"]) || fromPage),
      shipmentId: parseMetadataValue(metadataText, ["shipment_id", "shipmentId", "shipmentid"]),
      carrier: parseMetadataValue(metadataText, ["carrier_code", "carrierCode", "carrier"]),
      service: parseMetadataValue(metadataText, ["service_code", "serviceCode", "service"]),
      packageType: parseMetadataValue(metadataText, ["package_code", "packageCode", "package"]),
      labelCost: parseMetadataValue(metadataText, ["label_cost", "labelCost"]),
      pageUrl: window.location.href,
      capturedAt: new Date().toISOString(),
    };
  }

  function labelLog(...args) {
    console.log("[OG eBay Label]", ...args);
  }

  function getErrorMessage(error) {
    if (error instanceof AggregateError) {
      const messages = error.errors
        .map((entry) => entry?.message || String(entry || ""))
        .filter(Boolean);
      return messages.join(" / ") || "No PDF was captured from the eBay download action.";
    }
    return error?.message || String(error || "Could not capture the eBay label.");
  }

  function getReportErrorMessage(error) {
    if (error instanceof AggregateError) {
      const messages = error.errors
        .map((entry) => entry?.message || String(entry || ""))
        .filter(Boolean);
      return messages.join(" / ") || "No report file was captured from the eBay Download report action.";
    }
    return error?.message || String(error || "Could not capture the eBay orders report.");
  }

  function setLabelButtonStatus(message, tone = "info") {
    const button = document.getElementById(SEND_LABEL_ID);
    if (!button) return;
    button.dataset.statusTone = tone;
    button.textContent = message || "Send Label to OG";
  }

  function setAwaitingReportButtonStatus(message, tone = "info") {
    const button = document.getElementById(SEND_AWAITING_REPORT_ID);
    if (!button) return;
    button.dataset.statusTone = tone;
    button.textContent = message || "Send Awaiting Orders Report to OG";
  }

  function assertExtensionContextActive() {
    try {
      if (!chrome?.runtime?.id) throw new Error("Extension context invalidated.");
    } catch (_) {
      throw new Error("The OG eBay extension was reloaded while this eBay tab was already open. Refresh this eBay label page, then click Send Label to OG again.");
    }
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

  function injectLabelCaptureProbe() {
    return new Promise((resolve, reject) => {
      const existing = document.getElementById("og-ebay-label-capture-probe");
      if (existing) existing.remove();

      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("The eBay label capture probe did not finish loading."));
      }, LABEL_PROBE_READY_TIMEOUT_MS);

      function finish() {
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve();
      }

      function onMessage(event) {
        if (event.source !== window || event.data?.type !== LABEL_PROBE_READY_EVENT_TYPE) return;
        finish();
      }

      window.addEventListener("message", onMessage);

      const script = document.createElement("script");
      script.id = "og-ebay-label-capture-probe";
      try {
        assertExtensionContextActive();
        script.src = chrome.runtime.getURL("label-capture-probe.js");
      } catch (error) {
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        reject(error);
        return;
      }
      script.async = false;
      script.onload = () => {
        window.setTimeout(() => script.remove(), 0);
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        reject(new Error("The extension-hosted eBay label capture probe was blocked or could not load."));
      };
      (document.documentElement || document.head).appendChild(script);
    });
  }

  function injectReportCaptureProbe() {
    return new Promise((resolve, reject) => {
      const existing = document.getElementById("og-ebay-report-capture-probe");
      if (existing) existing.remove();

      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("The eBay report capture probe did not finish loading."));
      }, REPORT_PROBE_READY_TIMEOUT_MS);

      function finish() {
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve();
      }

      function onMessage(event) {
        if (event.source !== window || event.data?.type !== REPORT_PROBE_READY_EVENT_TYPE) return;
        finish();
      }

      window.addEventListener("message", onMessage);

      const script = document.createElement("script");
      script.id = "og-ebay-report-capture-probe";
      try {
        assertExtensionContextActive();
        script.src = chrome.runtime.getURL("report-capture-probe.js");
      } catch (error) {
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        reject(error);
        return;
      }
      script.async = false;
      script.onload = () => {
        window.setTimeout(() => script.remove(), 0);
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        reject(new Error("The extension-hosted eBay report capture probe was blocked or could not load."));
      };
      (document.documentElement || document.head).appendChild(script);
    });
  }

  function waitForCapturedLabel() {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("No PDF was captured from the eBay download action."));
      }, LABEL_STATUS_TIMEOUT_MS);

      function onMessage(event) {
        if (event.source !== window || event.data?.type !== LABEL_EVENT_TYPE) return;
        const payload = event.data.payload || {};
        if (!payload.base64 && !payload.url) return;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(payload);
      }

      window.addEventListener("message", onMessage);
    });
  }

  function waitForCapturedReport() {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("No eBay orders report file was captured from the Download report action."));
      }, REPORT_STATUS_TIMEOUT_MS);

      function onMessage(event) {
        if (event.source !== window || event.data?.type !== REPORT_EVENT_TYPE) return;
        const payload = event.data.payload || {};
        if (!payload.base64 && !payload.url) return;
        if (payload.base64 && !isLikelyEbayOrdersReportBase64(payload.base64)) return;
        if (!payload.base64 && !/ebay-ordersreport|ordersreport|orders-report/i.test(`${payload.filename || ""} ${payload.url || ""}`)) return;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(payload);
      }

      window.addEventListener("message", onMessage);
    });
  }

  function isLikelyEbayOrdersReportText(text) {
    return /(^|,|\n)\s*"?Order Number"?\s*(,|\n)/i.test(text)
      && /(^|,|\n)\s*"?Item Title"?\s*(,|\n)/i.test(text)
      && /(^|,|\n)\s*"?Sales Record Number"?\s*(,|\n)/i.test(text);
  }

  function isLikelyEbayOrdersReportBase64(base64) {
    try {
      const binary = atob(String(base64 || ""));
      const sampleLength = Math.min(binary.length, 12000);
      const bytes = new Uint8Array(sampleLength);
      for (let index = 0; index < sampleLength; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return isLikelyEbayOrdersReportText(new TextDecoder("utf-8").decode(bytes));
    } catch (_) {
      return false;
    }
  }

  async function fetchLabelUrlFromContentScript(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`Label URL returned HTTP ${response.status}.`);
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    return {
      source: "content-fetch",
      url: response.url || url,
      mimeType: blob.type || "application/pdf",
      size: blob.size || buffer.byteLength,
      base64: arrayBufferToBase64(buffer),
      capturedAt: new Date().toISOString(),
    };
  }

  async function beginDownloadCapture(metadata) {
    assertExtensionContextActive();
    const response = await chrome.runtime.sendMessage({
      type: "OG_EBAY_BEGIN_DOWNLOAD_CAPTURE",
      payload: {
        metadata,
        pageUrl: window.location.href,
      },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not prepare the browser download fallback.");
    return response.captureId;
  }

  async function beginReportDownloadCapture(metadata) {
    assertExtensionContextActive();
    const response = await chrome.runtime.sendMessage({
      type: "OG_EBAY_BEGIN_DOWNLOAD_CAPTURE",
      payload: {
        kind: "awaiting-orders-report",
        metadata,
        pageUrl: window.location.href,
      },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not prepare the browser report download fallback.");
    return response.captureId;
  }

  function waitForBackgroundDownloadCapture(captureId) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        chrome.runtime.onMessage.removeListener(onMessage);
        reject(new Error("No browser download was captured from the eBay action."));
      }, LABEL_STATUS_TIMEOUT_MS + 10000);

      function onMessage(message) {
        if (message?.type !== "OG_EBAY_DOWNLOAD_CAPTURE_RESULT" || message.captureId !== captureId) return false;
        if (!message.result?.ok) {
          labelLog("download fallback did not attach label", message.result);
          return false;
        }
        window.clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(onMessage);
        resolve(message.result);
        return false;
      }

      try {
        assertExtensionContextActive();
      } catch (error) {
        window.clearTimeout(timer);
        reject(error);
        return;
      }
      chrome.runtime.onMessage.addListener(onMessage);
    });
  }

  function waitForBackgroundReportCapture(captureId) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        chrome.runtime.onMessage.removeListener(onMessage);
        reject(new Error("No browser download was captured from eBay's report action."));
      }, REPORT_STATUS_TIMEOUT_MS + 15000);

      function onMessage(message) {
        if (message?.type !== "OG_EBAY_AWAITING_REPORT_CAPTURE_RESULT" || message.captureId !== captureId) return false;
        if (!message.result?.ok) {
          labelLog("report download fallback did not import", message.result);
          return false;
        }
        window.clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(onMessage);
        resolve(message.result);
        return false;
      }

      try {
        assertExtensionContextActive();
      } catch (error) {
        window.clearTimeout(timer);
        reject(error);
        return;
      }
      chrome.runtime.onMessage.addListener(onMessage);
    });
  }

  function cancelDownloadCapture(captureId) {
    if (!captureId) return;
    try {
      assertExtensionContextActive();
    } catch (_) {
      return;
    }
    chrome.runtime.sendMessage({
      type: "OG_EBAY_CANCEL_DOWNLOAD_CAPTURE",
      captureId,
    }).catch(() => null);
  }

  async function sendLabelToOg() {
    const downloadButton = getDownloadLabelButton();
    const metadata = getLabelMetadata();
    labelLog("metadata", metadata);

    if (!metadata.orderId) {
      setLabelButtonStatus("Order not found", "error");
      window.alert("Could not find an eBay order number on this label page.");
      return;
    }
    if (!downloadButton) {
      setLabelButtonStatus("Download missing", "error");
      window.alert("Could not find eBay's Download label button.");
      return;
    }

    try {
      assertExtensionContextActive();
    } catch (error) {
      setLabelButtonStatus("Refresh eBay page", "error");
      window.alert(error.message);
      return;
    }

    setLabelButtonStatus("Finding label...");
    let downloadCaptureId = "";
    try {
      await injectLabelCaptureProbe();
      downloadCaptureId = await beginDownloadCapture(metadata);
    } catch (error) {
      if (/extension context|reloaded/i.test(error?.message || "")) {
        setLabelButtonStatus("Refresh eBay page", "error");
        window.alert(error.message);
        return;
      }
      console.warn("[OG eBay Label] Capture setup warning:", error);
    }
    const pageCapturePromise = waitForCapturedLabel().then((label) => ({ kind: "page", label }));
    const downloadCapturePromise = downloadCaptureId
      ? waitForBackgroundDownloadCapture(downloadCaptureId).then((result) => ({ kind: "download", result }))
      : Promise.reject(new Error("Browser download fallback was not available."));

    setLabelButtonStatus("Downloading label...");
    downloadButton.click();

    try {
      const captured = await Promise.any([pageCapturePromise, downloadCapturePromise]);
      if (captured.kind === "download") {
        setLabelButtonStatus(captured.result.opened ? "Opened OG to attach" : "Attached to OG", "success");
        window.setTimeout(() => setLabelButtonStatus("Send Label to OG"), 3500);
        return;
      }

      cancelDownloadCapture(downloadCaptureId);
      let label = captured.label;
      if (!label.base64 && label.url && !label.url.startsWith("blob:")) {
        label = await fetchLabelUrlFromContentScript(label.url);
      }
      if (!label.base64) throw new Error("Captured a label URL, but not a readable PDF blob.");

      setLabelButtonStatus("Uploading to OG...");
      assertExtensionContextActive();
      const response = await chrome.runtime.sendMessage({
        type: "OG_EBAY_SEND_LABEL",
        payload: {
          metadata,
          label,
        },
      });
      if (!response?.ok) throw new Error(response?.error || "Could not hand the label to OG.");
      setLabelButtonStatus(response.opened ? "Opened OG to attach" : "Attached to OG", "success");
      window.setTimeout(() => setLabelButtonStatus("Send Label to OG"), 3500);
    } catch (error) {
      console.error("[OG eBay Label] Capture failed:", error);
      cancelDownloadCapture(downloadCaptureId);
      setLabelButtonStatus("Capture failed", "error");
      window.alert(`${getErrorMessage(error)}\n\nThe extension now also watches Chrome/Edge downloads. If a PDF still downloads normally but does not attach, send me the console lines that start with [OG eBay Label].`);
      window.setTimeout(() => setLabelButtonStatus("Send Label to OG"), 5000);
    }
  }

  async function fetchReportUrlFromContentScript(url) {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`Report URL returned HTTP ${response.status}.`);
    const blob = await response.blob();
    const buffer = await blob.arrayBuffer();
    const sample = new TextDecoder("utf-8").decode(buffer.slice(0, Math.min(buffer.byteLength, 12000)));
    if (!isLikelyEbayOrdersReportText(sample)) {
      throw new Error("The captured report URL did not return the eBay Orders Report CSV.");
    }
    const filename = String(response.url || url).split(/[\\/]/).pop()?.split(/[?#]/)[0] || "eBay-OrdersReport.csv";
    return {
      source: "content-fetch",
      url: response.url || url,
      filename,
      mimeType: blob.type || "text/csv",
      size: blob.size || buffer.byteLength,
      base64: arrayBufferToBase64(buffer),
      capturedAt: new Date().toISOString(),
    };
  }

  async function sendAwaitingOrdersReportToOg() {
    const reportButton = getDownloadReportButton();
    if (!isAwaitingShipmentOrdersPage() || !reportButton) {
      setAwaitingReportButtonStatus("Report button missing", "error");
      window.alert("Could not find eBay's visible Download report button on the awaiting-shipment orders page.");
      return;
    }

    const appUrl = await getConfiguredAppUrl();
    if (!appUrl) {
      setAwaitingReportButtonStatus("Set OG URL", "error");
      window.alert("OG Pending Orders URL was not set. Click the extension icon to set it.");
      return;
    }

    const metadata = getAwaitingReportMetadata();
    let downloadCaptureId = "";
    try {
      assertExtensionContextActive();
      setAwaitingReportButtonStatus("Creating report...");
      await injectReportCaptureProbe();
      downloadCaptureId = await beginReportDownloadCapture(metadata);
    } catch (error) {
      if (/extension context|reloaded/i.test(error?.message || "")) {
        setAwaitingReportButtonStatus("Refresh eBay page", "error");
        window.alert(error.message);
        return;
      }
      console.warn("[OG eBay Report] Capture setup warning:", error);
    }

    const pageCapturePromise = waitForCapturedReport().then((report) => ({ kind: "page", report }));
    const downloadCapturePromise = downloadCaptureId
      ? waitForBackgroundReportCapture(downloadCaptureId).then((result) => ({ kind: "download", result }))
      : Promise.reject(new Error("Browser download fallback was not available."));

    setAwaitingReportButtonStatus("Waiting for download...");
    reportButton.click();

    try {
      const captured = await Promise.any([pageCapturePromise, downloadCapturePromise]);
      if (captured.kind === "download") {
        setAwaitingReportButtonStatus(captured.result.opened ? "Opened OG" : "Done", "success");
        window.setTimeout(() => setAwaitingReportButtonStatus("Send Awaiting Orders Report to OG"), 4500);
        return;
      }

      cancelDownloadCapture(downloadCaptureId);
      let report = captured.report;
      if (!report.base64 && report.url && !report.url.startsWith("blob:")) {
        report = await fetchReportUrlFromContentScript(report.url);
      }
      if (!report.base64) throw new Error("Captured a report URL, but not a readable report file.");

      setAwaitingReportButtonStatus("Uploading to OG...");
      assertExtensionContextActive();
      const response = await chrome.runtime.sendMessage({
        type: "OG_EBAY_SEND_AWAITING_REPORT",
        payload: {
          metadata,
          report,
        },
      });
      if (!response?.ok) throw new Error(response?.error || "Could not hand the eBay report to OG.");
      setAwaitingReportButtonStatus(response.opened ? "Opened OG" : "Done", "success");
      window.setTimeout(() => setAwaitingReportButtonStatus("Send Awaiting Orders Report to OG"), 4500);
    } catch (error) {
      console.error("[OG eBay Report] Capture failed:", error);
      cancelDownloadCapture(downloadCaptureId);
      setAwaitingReportButtonStatus("Import failed", "error");
      window.alert(`${getReportErrorMessage(error)}\n\nThe extension tried both page-level capture and Chrome/Edge download capture. If the report downloaded normally but did not import, send me the console lines that start with [OG eBay Report].`);
      window.setTimeout(() => setAwaitingReportButtonStatus("Send Awaiting Orders Report to OG"), 6000);
    }
  }

  function getSingleLabelOrderSnapshot(orderNumber) {
    const orderSection = document.querySelector('section[aria-label="Order information"]');
    const moneyMatches = String(orderSection?.innerText || "").match(/\$\d[\d,]*(?:\.\d{2})?/g) || [];
    const shipToAddressLines = getTextLines("#shipToAddress");
    const shipFromAddressLines = getTextLines('[data-testid="ship-from-address"] [data-testid="address-info"]');
    const totalCost = document.querySelector('[data-testid="total-cost"] span:last-child')?.textContent;

    return {
      source: "ebay-single-label-page",
      capturedAt: new Date().toISOString(),
      orderNumber,
      buyerUsername: cleanText(document.querySelector('a[href*="/usr/"]')?.textContent),
      itemCount: cleanText(orderSection?.querySelector("button.fake-link")?.textContent),
      itemSubtotal: moneyMatches[0] || "",
      orderValue: getValueByHeading("Order value"),
      shippingPaid: getValueByHeading("Shipping paid"),
      selectedShipping: getValueByHeading("Selected"),
      expectedDelivery: getValueByHeading("Expected"),
      shipToAddressLines,
      shipToName: shipToAddressLines[0] || "",
      shipToCityStateZip: shipToAddressLines[shipToAddressLines.length - 1] || "",
      shipFromAddressLines,
      packingSlipUrl: document.querySelector('[data-testid="packingslip-new-tab-link"]')?.href || "",
      productImageUrl: document.querySelector('[data-testid="product-image-wrapper"] img')?.src || "",
      authenticGuarantee: Boolean(document.querySelector('[data-testid="auth-guaranteed-badge"]')),
      selectedService: getSelectedServiceSnapshot(),
      package: getPackageSnapshot(),
      labelTotalCost: cleanText(totalCost),
    };
  }

  function normalizeAppUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    try {
      const url = new URL(text);
      return url.toString();
    } catch (_) {
      return "";
    }
  }

  async function getConfiguredAppUrl() {
    const stored = await chrome.storage.sync.get(STORAGE_KEY);
    const saved = normalizeAppUrl(stored[STORAGE_KEY]);
    if (saved) return saved;

    const entered = window.prompt(
      "Paste your OG Pending Orders page URL. Example: https://your-site.com/pending-orders.html"
    );
    const normalized = normalizeAppUrl(entered);
    if (normalized) {
      await chrome.storage.sync.set({ [STORAGE_KEY]: normalized });
    }
    return normalized;
  }

  function buildOgUrl(appUrl, orderNumbers, orderSnapshot = null) {
    const url = new URL(appUrl);
    const unique = [...new Set(orderNumbers.map(normalizeOrderNumber).filter(Boolean))];
    url.searchParams.set("source", "ebay");
    if (unique.length === 1) {
      url.searchParams.set("orderId", unique[0]);
      url.searchParams.delete("orderIds");
    } else {
      url.searchParams.set("orderIds", unique.join(","));
      url.searchParams.delete("orderId");
    }
    if (orderSnapshot) {
      const encoded = encodeBase64UrlJson(orderSnapshot);
      if (encoded) {
        url.searchParams.set("ebayOrderPage", "single");
        url.searchParams.set("ebayOrderSnapshot", encoded);
      }
    } else {
      url.searchParams.delete("ebayOrderPage");
      url.searchParams.delete("ebayOrderSnapshot");
    }
    return url.toString();
  }

  async function openInOg(orderNumbers, orderSnapshot = null) {
    const clean = [...new Set(orderNumbers.map(normalizeOrderNumber).filter(Boolean))];
    if (!clean.length) return;

    const appUrl = await getConfiguredAppUrl();
    if (!appUrl) {
      window.alert("OG Pending Orders URL was not set. Click the extension icon to set it.");
      return;
    }
    window.open(buildOgUrl(appUrl, clean, orderSnapshot), "_blank", "noopener,noreferrer");
  }

  function ensureStyles() {
    if (document.getElementById("og-ebay-order-link-styles")) return;
    const style = document.createElement("style");
    style.id = "og-ebay-order-link-styles";
    style.textContent = `
      .${BUTTON_CLASS} {
        margin-left: 8px;
        border: 1px solid #0b72e7;
        border-radius: 999px;
        background: #edf5ff;
        color: #0759b8;
        cursor: pointer;
        font: 700 12px Arial, sans-serif;
        line-height: 1;
        padding: 5px 8px;
      }

      .${BUTTON_CLASS}:hover {
        background: #dcebff;
      }

      #${FLOATING_ID},
      #${SINGLE_ORDER_ID},
      #${SEND_AWAITING_REPORT_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        border: 1px solid #9b6418;
        border-radius: 999px;
        background: #e7bd73;
        color: #17120b;
        box-shadow: 0 12px 28px rgba(0, 0, 0, .22);
        cursor: pointer;
        font: 800 14px Arial, sans-serif;
        padding: 12px 16px;
      }

      #${SINGLE_ORDER_ID} {
        top: 112px;
        bottom: auto;
        border-color: #0b72e7;
        background: #edf5ff;
        color: #0759b8;
      }

      #${SINGLE_ORDER_ID}:hover {
        background: #dcebff;
      }

      #${SEND_AWAITING_REPORT_ID} {
        bottom: 72px;
        border-color: #116b36;
        background: #e8fff0;
        color: #0a5b2b;
        max-width: min(360px, calc(100vw - 36px));
        white-space: normal;
      }

      #${SEND_AWAITING_REPORT_ID}:hover {
        background: #d4f8df;
      }

      #${SEND_LABEL_ID} {
        margin-left: 8px;
        border: 1px solid #116b36;
        border-radius: 999px;
        background: #e8fff0;
        color: #0a5b2b;
        cursor: pointer;
        font: 800 13px Arial, sans-serif;
        padding: 9px 12px;
      }

      #${SEND_LABEL_ID}:hover {
        background: #d4f8df;
      }

      #${SEND_LABEL_ID}[data-status-tone="error"],
      #${SEND_AWAITING_REPORT_ID}[data-status-tone="error"] {
        border-color: #b42318;
        background: #fff0ed;
        color: #9f1f14;
      }

      #${SEND_LABEL_ID}[data-status-tone="success"],
      #${SEND_AWAITING_REPORT_ID}[data-status-tone="success"] {
        border-color: #116b36;
        background: #d8f8e2;
        color: #0a5b2b;
      }
    `;
    document.head.appendChild(style);
  }

  function injectRowButtons() {
    getOrderLinks().forEach(({ link, orderNumber }) => {
      const parent = link.parentElement;
      if (!parent || parent.querySelector(`.${BUTTON_CLASS}[data-og-order="${orderNumber}"]`)) return;

      const button = document.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      button.dataset.ogOrder = orderNumber;
      button.textContent = "Open in OG";
      button.title = `Open ${orderNumber} in OG Pending Orders`;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openInOg([orderNumber]);
      });

      link.insertAdjacentElement("afterend", button);
    });
  }

  function injectFloatingButton() {
    const orderNumbers = uniqueOrderNumbers();
    let button = document.getElementById(FLOATING_ID);

    if (!orderNumbers.length) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = FLOATING_ID;
      button.addEventListener("click", () => openInOg(uniqueOrderNumbers()));
      document.body.appendChild(button);
    }

    button.textContent = `Open ${orderNumbers.length} in OG`;
    button.title = "Open all visible eBay label orders in OG Pending Orders";
  }

  function injectSingleOrderButton() {
    const orderNumber = getSingleLabelOrderNumber();
    let button = document.getElementById(SINGLE_ORDER_ID);

    if (!isSingleLabelPage()) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = SINGLE_ORDER_ID;
      button.addEventListener("click", () => {
        const currentOrderNumber = getSingleLabelOrderNumber();
        const snapshot = getSingleLabelOrderSnapshot(currentOrderNumber);
        openInOg([currentOrderNumber], snapshot);
      });
      document.body.appendChild(button);
    }

    button.textContent = "Open order in OG";
    button.title = `Extract ${orderNumber} from this eBay label page and open it in OG Pending Orders`;
  }

  function injectSendLabelButton() {
    const actions = getShippingActions();
    const downloadButton = getDownloadLabelButton();
    let button = document.getElementById(SEND_LABEL_ID);

    if (!actions || !downloadButton) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = SEND_LABEL_ID;
      button.textContent = "Send Label to OG";
      button.title = "Capture the eBay label PDF and route it to the matching OG pending or completed order";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        sendLabelToOg();
      });
    }

    if (!actions.contains(button)) {
      downloadButton.insertAdjacentElement("afterend", button);
    }
  }

  function injectAwaitingReportButton() {
    let button = document.getElementById(SEND_AWAITING_REPORT_ID);

    if (!isAwaitingShipmentOrdersPage()) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = SEND_AWAITING_REPORT_ID;
      button.textContent = "Send Awaiting Orders Report to OG";
      button.title = "Trigger eBay's full awaiting-shipment orders report and import it into OG Pending Orders";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        sendAwaitingOrdersReportToOg();
      });
      document.body.appendChild(button);
    }
  }

  function injectOgControls() {
    ensureStyles();
    injectRowButtons();
    injectFloatingButton();
    injectSingleOrderButton();
    injectSendLabelButton();
    injectAwaitingReportButton();
  }

  let scheduled = false;
  function scheduleInject() {
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      injectOgControls();
    }, 250);
  }

  injectOgControls();
  new MutationObserver(scheduleInject).observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
