(function () {
  "use strict";

  const ORDER_LINK_SELECTOR = 'a[data-testid^="unique-order-id-link-"]';
  const ORDER_NUMBER_PATTERN = /\b\d{2}-\d{5}-\d{5}\b/;
  const TRACKING_NUMBER_PATTERN = /\b\d{20,30}\b/g;
  const FORMATTED_TRACKING_NUMBER_PATTERN = /\b\d{2,4}(?:[\s-]+\d{2,4}){4,8}\b/g;
  const STORAGE_KEY = "ogPendingOrdersUrl";
  const BUTTON_CLASS = "og-ebay-open-order";
  const FLOATING_ID = "og-ebay-open-all-orders";
  const SINGLE_ORDER_ID = "og-ebay-open-single-order";
  const SEND_LABEL_ID = "og-ebay-send-label";
  const SEND_BULK_LABELS_ID = "og-ebay-send-bulk-labels";
  const SEND_AWAITING_REPORT_ID = "og-ebay-send-awaiting-report";
  const SEND_RETURN_PANEL_ID = "og-ebay-return-panel";
  const SEND_RETURN_BUTTON_CLASS = "og-ebay-send-return";
  const PRIORITIZE_DUE_ORDERS_ID = "og-ebay-prioritize-due-orders";
  const BULK_ACTIONS_SHORTCUT_ID = "og-ebay-bulk-actions-shortcut";
  const CLEAR_SELECTED_SHORTCUT_ID = "og-ebay-clear-selected-shortcut";
  const URGENT_COVERAGE_WARNING_ID = "og-ebay-urgent-coverage-warning";
  const BOX_REMINDER_ID = "og-ebay-box-reminder";
  const LABEL_EVENT_TYPE = "OG_EBAY_LABEL_CAPTURED";
  const LABEL_PROBE_READY_EVENT_TYPE = "OG_EBAY_LABEL_PROBE_READY";
  const REPORT_EVENT_TYPE = "OG_EBAY_AWAITING_REPORT_CAPTURED";
  const REPORT_PROBE_READY_EVENT_TYPE = "OG_EBAY_AWAITING_REPORT_PROBE_READY";
  const LABEL_STATUS_TIMEOUT_MS = 30000;
  const LABEL_PROBE_READY_TIMEOUT_MS = 5000;
  const REPORT_STATUS_TIMEOUT_MS = 120000;
  const REPORT_PROBE_READY_TIMEOUT_MS = 5000;
  let currentBoxReminderKey = "";
  let dismissedBoxReminderKey = "";
  let shownBoxReminderKey = "";
  let ogPendingPriorityCache = null;
  let ogPriorityAutoAttemptKey = "";
  let ogPriorityReapplyTimer = null;
  let ogPriorityLastRowSignature = "";
  const ogLocallyClosedAwaitingOrders = new Set();
  let ogBuyerSelectionHandlersAttached = false;
  let ogBuyerSelectionInProgress = false;
  let ogBuyerSelectionRefreshTimer = null;
  let ogPartialSelectionWarningTimer = null;
  let ogReturnEntriesCache = null;
  let ogReturnEntriesSignature = "";

  function normalizeOrderNumber(value) {
    const match = String(value || "").match(ORDER_NUMBER_PATTERN);
    return match ? match[0] : "";
  }

  function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
  }

  function normalizeTrackingNumber(value) {
    const digits = String(value || "").replace(/\D/g, "");
    return /^\d{20,30}$/.test(digits) ? digits : "";
  }

  function getTrackingNumbersFromText(text) {
    const body = String(text || "");
    return unique([
      ...(body.match(TRACKING_NUMBER_PATTERN) || []),
      ...(body.match(FORMATTED_TRACKING_NUMBER_PATTERN) || []),
    ].map(normalizeTrackingNumber));
  }

  function getOrderLinks() {
    const awaitingRows = typeof getEbayAwaitingShipmentRows === "function" ? getEbayAwaitingShipmentRows() : [];
    if (awaitingRows.length) {
      return awaitingRows
        .map((row) => {
          const orderNumber = getRowOrderNumber(row);
          const link = [...row.querySelectorAll("a[href], [role='link']")]
            .find((anchor) => normalizeOrderNumber(anchor.textContent || anchor.getAttribute?.("href") || anchor.getAttribute?.("aria-label")) === orderNumber)
            || row.querySelector('a[href*="/mesh/ord/details"], a[href*="orderid="], a[href*="orderId="]')
            || row.querySelector("a[href], [role='link']");
          return { link, orderNumber };
        })
        .filter((entry) => entry.link && entry.orderNumber);
    }

    const links = [
      ...document.querySelectorAll(ORDER_LINK_SELECTOR),
      ...document.querySelectorAll("a[href], [role='link']"),
    ];
    const seen = new Set();
    return links
      .map((link) => ({
        link,
        orderNumber: normalizeOrderNumber([
          link.textContent,
          link.getAttribute?.("aria-label"),
          link.getAttribute?.("href"),
          link.dataset?.testid,
        ].filter(Boolean).join(" ")),
      }))
      .filter((entry) => {
        if (!entry.orderNumber || seen.has(entry.link)) return false;
        seen.add(entry.link);
        return true;
      });
  }

  function uniqueOrderNumbers() {
    return [...new Set(getOrderLinks().map((entry) => entry.orderNumber))];
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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

  function getSingleLabelTrackingNumbers() {
    const numbers = [];
    const candidateRows = [...document.querySelectorAll(".eui-label-value-line, div, dl, section, li")];

    for (const row of candidateRows) {
      const text = row.innerText || row.textContent || "";
      if (/Tracking number/i.test(text)) {
        numbers.push(...getTrackingNumbersFromText(text));
      }
    }

    document.querySelectorAll('a[href*="backToLabelsHistory?query="], a[href*="showOrderDetails="]').forEach((link) => {
      try {
        const url = new URL(link.getAttribute("href") || link.href, window.location.origin);
        numbers.push(url.searchParams.get("query"));
        numbers.push(url.searchParams.get("showOrderDetails"));
      } catch (_) {}
    });

    if (!numbers.length) {
      numbers.push(...getTrackingNumbersFromText(document.body?.innerText || ""));
    }

    return unique(numbers);
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

  function getBulkLabelDownloadLink() {
    return document.querySelector('[data-testid="download-labels-button"]')
      || document.querySelector('[download][href*="/ship/single/api/label-service/label/"][href*="/download"]')
      || document.querySelector('.labels-confirmation-page a[href*="/ship/single/api/label-service/label/"][href*="/download"]')
      || document.querySelector('a[href*="/ship/single/api/label-service/label/"][href*="/download"]')
      || document.querySelector('.labels-confirmation-page a[href*="/download"]');
  }

  function isBulkLabelConfirmationPage() {
    return Boolean(
      document.querySelector("#bulk-labels-app")
      && document.querySelector(".labels-confirmation-page")
      && (document.querySelector('[data-testid="label-generation-success-notice"]') || /label.+successfully generated/i.test(document.body?.innerText || ""))
      && getBulkLabelDownloadLink()
    );
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

  function isDownloadReportText(value) {
    const text = cleanText(value);
    return /^(?:download\s+(?:orders?\s+)?report|download\s+csv|orders?\s+report)$/i.test(text)
      || /\bdownload\b/i.test(text) && /\b(report|csv|orders?)\b/i.test(text);
  }

  function getDownloadReportButton() {
    const scoped = [
      ...document.querySelectorAll(".downloadReport button, .downloadReport a, [id*='downloadReport' i] button, [id*='downloadReport' i] a, [data-testid*='download' i] button, [data-testid*='download' i] a"),
    ].find((control) => {
      const text = cleanText(control.textContent || control.getAttribute("aria-label"));
      return isElementVisible(control) && isDownloadReportText(text);
    });
    if (scoped) return scoped;

    return [...document.querySelectorAll("button, a")]
      .find((control) => {
        const text = cleanText(control.textContent || control.getAttribute("aria-label"));
        return isElementVisible(control) && isDownloadReportText(text);
      }) || null;
  }

  function isAwaitingShipmentOrdersPage() {
    const sample = getPageTextSample();
    const url = new URL(window.location.href);
    const pathLooksRight = /\/sh\/ord\/?$/i.test(url.pathname);
    const filterLooksRight = /AWAITING_SHIPMENT|awaiting[_\s-]*shipment/i.test(`${url.search} ${url.hash} ${sample}`);
    const pageLooksRight = /awaiting shipment|ready to ship|manage orders/i.test(sample);
    return pathLooksRight
      && filterLooksRight
      && pageLooksRight
      && Boolean(getDownloadReportButton());
  }

  function isEbayReturnsPage() {
    const url = new URL(window.location.href);
    const sample = getPageTextSample();
    return /\/sh\/ord\/?$/i.test(url.pathname)
      && /returns?|currentpage_SHOrderReturn|returnid/i.test(`${url.search} ${url.hash} ${sample}`)
      && /table of returns|return requested|return shipped|return delivered|waiting for buyer to ship|return id/i.test(sample);
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

  function normalizeReturnReasonText(value) {
    return cleanText(String(value || "").replace(/^reason:\s*/i, ""));
  }

  function decodeReturnText(value) {
    const text = String(value || "");
    if (!/[&<>]/.test(text)) return cleanText(text);
    const textarea = document.createElement("textarea");
    textarea.innerHTML = text;
    return cleanText(textarea.value || text);
  }

  function textSpansToText(value) {
    if (!value) return "";
    if (typeof value === "string") return cleanText(value);
    if (Array.isArray(value)) return cleanText(value.map(textSpansToText).join(" "));
    if (typeof value === "object") {
      if (Array.isArray(value.textSpans)) return textSpansToText(value.textSpans);
      if (Object.prototype.hasOwnProperty.call(value, "text")) return cleanText(value.text);
    }
    return "";
  }

  function getActionUrl(value) {
    if (!value || typeof value !== "object") return "";
    if (typeof value.URL === "string") return value.URL;
    if (value.action && typeof value.action === "object") return getActionUrl(value.action);
    return "";
  }

  function getReturnDetailsUrl(member = {}) {
    const direct = getActionUrl(member.returnDetails)
      || getActionUrl(member.lineActions?.model?.defaultAction)
      || getActionUrl(member.lineActions?.model?.actionValues?.[0]);
    if (direct) return direct;
    const returnId = cleanText(member.returnId || "");
    return returnId ? `https://www.ebay.com/rtn/Return/ReturnsDetail?returnId=${encodeURIComponent(returnId)}` : "";
  }

  function getReturnTransactionId(member = {}) {
    const urls = [
      getActionUrl(member.buyerDetails?.buyerid),
      ...(Array.isArray(member.lineActions?.model?.actionValues)
        ? member.lineActions.model.actionValues.map(getActionUrl)
        : []),
    ];
    for (const url of urls) {
      try {
        const parsed = new URL(url, window.location.origin);
        const transId = parsed.searchParams.get("transId");
        if (transId) return transId;
      } catch (_) {}
    }
    return "";
  }

  function normalizeReturnMember(member = {}) {
    const listing = member.lineItems?.[0]?.listing || {};
    const returnId = cleanText(member.returnId || textSpansToText(member.returnDetails));
    const itemNumber = cleanText(listing.listingId || "");
    if (!returnId || !itemNumber) return null;
    const detailsUrl = getReturnDetailsUrl(member);
    const returnReason = normalizeReturnReasonText(textSpansToText(member.returnReason));
    return {
      source: "ebay-returns-page",
      returnId,
      itemNumber,
      transactionId: getReturnTransactionId(member),
      itemTitle: textSpansToText(listing.title) || cleanText(listing.image?.title || ""),
      quantity: Number(listing.quantity?.value || textSpansToText(listing.quantity).match(/\d+/)?.[0] || 1),
      buyerUsername: textSpansToText(member.buyerDetails?.buyerid),
      returnStatus: textSpansToText(member.returnStatus),
      returnAction: textSpansToText(member.returnAction),
      returnReason,
      returnInitiated: textSpansToText(member.returnInitiated).replace(/^requested:\s*/i, ""),
      refundText: textSpansToText(member.refundDetails),
      detailsUrl,
      itemUrl: getActionUrl(listing.title),
      imageUrl: listing.image?.URL || "",
      pageUrl: window.location.href,
      pageTitle: document.title || "",
      capturedAt: new Date().toISOString(),
      rawReturn: {
        returnId,
        buyerDetails: member.buyerDetails || null,
        returnStatus: member.returnStatus || null,
        returnAction: member.returnAction || null,
        returnReason: member.returnReason || null,
        returnInitiated: member.returnInitiated || null,
        refundDetails: member.refundDetails || null,
        lineItems: member.lineItems || null,
        lineActions: member.lineActions || null,
      },
    };
  }

  function collectReturnMembersFromJson(value, results = [], seen = new WeakSet(), limit = { count: 0 }) {
    if (!value || typeof value !== "object" || seen.has(value) || limit.count > 25000) return results;
    seen.add(value);
    limit.count += 1;

    const normalized = value.returnId && Array.isArray(value.lineItems) ? normalizeReturnMember(value) : null;
    if (normalized) results.push(normalized);

    if (Array.isArray(value)) {
      value.forEach((entry) => collectReturnMembersFromJson(entry, results, seen, limit));
      return results;
    }

    Object.values(value).forEach((entry) => collectReturnMembersFromJson(entry, results, seen, limit));
    return results;
  }

  function readLastRegexMatch(text, regex) {
    let found = "";
    for (const match of text.matchAll(regex)) {
      if (match?.[1]) found = decodeReturnText(match[1]);
    }
    return found;
  }

  function readFirstRegexMatch(text, regex) {
    const match = text.match(regex);
    return decodeReturnText(match?.[1] || "");
  }

  function extractReturnMembersFromText(rawText = "") {
    const text = rawText.replace(/&quot;/g, '"').replace(/&#34;/g, '"');
    const results = [];
    for (const match of text.matchAll(/"returnId"\s*:\s*"([^"]+)"/g)) {
      const returnId = decodeReturnText(match[1]);
      const before = text.slice(Math.max(0, match.index - 7000), match.index);
      const after = text.slice(match.index, match.index + 12000);
      const itemNumber = readLastRegexMatch(before, /"listingId"\s*:\s*"([^"]+)"/g);
      if (!returnId || !itemNumber) continue;
      const buyerUsername = readFirstRegexMatch(after, /"buyerid"\s*:\s*\{"textSpans"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"/);
      const returnDetailsUrl = readFirstRegexMatch(after, /"URL"\s*:\s*"(https:\/\/www\.ebay\.com\/rtn\/Return\/ReturnsDetail\?returnId=[^"]+)"/);
      const reportBuyerUrl = readFirstRegexMatch(after, /"URL"\s*:\s*"(http:\/\/spd\.ebay\.com\/RBASellerHub[^"]+)"/);
      let transactionId = "";
      try {
        transactionId = new URL(reportBuyerUrl).searchParams.get("transId") || "";
      } catch (_) {}
      results.push({
        source: "ebay-returns-page",
        returnId,
        itemNumber,
        transactionId,
        itemTitle: readLastRegexMatch(before, /"title"\s*:\s*\{"textSpans"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"/g),
        quantity: Number(readLastRegexMatch(before, /"quantity"\s*:\s*\{(?:"textSpans".*?)?"value"\s*:\s*(\d+)/gs) || 1),
        buyerUsername,
        returnStatus: readFirstRegexMatch(after, /"returnStatus"\s*:\s*\{"textSpans"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"/),
        returnAction: readFirstRegexMatch(after, /"returnAction"\s*:\s*\{"textSpans"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"/),
        returnReason: normalizeReturnReasonText(readFirstRegexMatch(after, /"returnReason"\s*:\s*\{"textSpans"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"/)),
        returnInitiated: readFirstRegexMatch(after, /"returnInitiated"\s*:\s*\{"textSpans"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"/).replace(/^requested:\s*/i, ""),
        refundText: readFirstRegexMatch(after, /"refundDetails"\s*:\s*\{"textSpans"\s*:\s*\[\{"text"\s*:\s*"([^"]+)"/),
        detailsUrl: returnDetailsUrl || `https://www.ebay.com/rtn/Return/ReturnsDetail?returnId=${encodeURIComponent(returnId)}`,
        itemUrl: readLastRegexMatch(before, /"URL"\s*:\s*"(https:\/\/www\.ebay\.com\/itm\/[^"]+)"/g),
        imageUrl: readLastRegexMatch(before, /"image"\s*:\s*\{.*?"URL"\s*:\s*"([^"]+)"/gs),
        pageUrl: window.location.href,
        pageTitle: document.title || "",
        capturedAt: new Date().toISOString(),
        rawReturn: {
          returnId,
          itemNumber,
          transactionId,
          buyerUsername,
        },
      });
    }
    return results;
  }

  function getEbayReturnJsonTextCandidates() {
    const scripts = [...document.scripts]
      .map((script) => script.textContent || "")
      .filter((text) => text.includes('"returnId"') || text.includes("Return ID:"));
    return [...scripts, document.documentElement?.innerHTML || ""].filter(Boolean);
  }

  function getEbayReturnEntries() {
    if (!isEbayReturnsPage()) return [];
    const signature = `${window.location.href}|${document.scripts.length}|${document.body?.innerText?.length || 0}`;
    if (ogReturnEntriesCache && ogReturnEntriesSignature === signature) return ogReturnEntriesCache;
    const entries = [];
    getEbayReturnJsonTextCandidates().forEach((text) => {
      const beforeCount = entries.length;
      try {
        const parsed = JSON.parse(text);
        entries.push(...collectReturnMembersFromJson(parsed));
        if (entries.length === beforeCount) entries.push(...extractReturnMembersFromText(text));
      } catch (_) {
        entries.push(...extractReturnMembersFromText(text));
      }
    });
    const byReturnId = new Map();
    entries.forEach((entry) => {
      if (!entry?.returnId || !entry?.itemNumber) return;
      const existing = byReturnId.get(entry.returnId);
      byReturnId.set(entry.returnId, {
        ...(existing || {}),
        ...entry,
        rawReturn: entry.rawReturn || existing?.rawReturn || null,
      });
    });
    ogReturnEntriesSignature = signature;
    ogReturnEntriesCache = [...byReturnId.values()].sort((a, b) => String(a.returnId).localeCompare(String(b.returnId), undefined, { numeric: true }));
    return ogReturnEntriesCache;
  }

  function findReturnAnchor(returnInfo = {}) {
    const returnId = String(returnInfo.returnId || "");
    if (!returnId) return null;
    return [...document.querySelectorAll("a[href]")]
      .find((anchor) => {
        const href = anchor.getAttribute("href") || anchor.href || "";
        return href.includes(`returnId=${returnId}`) || cleanText(anchor.textContent) === returnId;
      }) || null;
  }

  function getRawEbayAwaitingShipmentRows() {
    return [...document.querySelectorAll('tr.order-info[id^="orderid_"][id$="__order-info"], tr.order-info.order-border')]
      .filter((row) => row.querySelector('input[data-testid="order-checkbox"], input[data-ordernumber], input[data-buyer-id]'));
  }

  function isOgLocallyClosedAwaitingRow(row) {
    const orderNumber = getRowOrderNumber(row);
    return row?.dataset?.ogClosedInOg === "true"
      || Boolean(orderNumber && ogLocallyClosedAwaitingOrders.has(orderNumber));
  }

  function getEbayAwaitingShipmentRows(options = {}) {
    return getRawEbayAwaitingShipmentRows()
      .filter((row) => options.includeOgClosed || !isOgLocallyClosedAwaitingRow(row));
  }

  function getRowCheckbox(row) {
    return row?.querySelector?.('input[data-testid="order-checkbox"]')
      || row?.querySelector?.("input[data-ordernumber]")
      || row?.querySelector?.('input[name^="grid-table-bulk-checkbox_order"]')
      || null;
  }

  function getRowOrderNumber(row) {
    const checkbox = getRowCheckbox(row);
    const fromCheckbox = checkbox?.dataset?.ordernumber
      || checkbox?.getAttribute?.("data-ordernumber")
      || checkbox?.value
      || "";
    const fromId = row?.id?.match(ORDER_NUMBER_PATTERN)?.[0] || "";
    const detailsLink = row?.querySelector?.('a[href*="orderid="], a[href*="orderId="], a[href*="/mesh/ord/details"]');
    const fromHref = detailsLink?.href?.match(ORDER_NUMBER_PATTERN)?.[0] || "";
    const fromText = row?.textContent?.match(ORDER_NUMBER_PATTERN)?.[0] || "";
    return cleanText(fromCheckbox || fromId || fromHref || fromText);
  }

  function getRowBuyerUsername(row) {
    const checkbox = getRowCheckbox(row);
    const fromCheckbox = checkbox?.dataset?.buyerId
      || checkbox?.getAttribute?.("data-buyer-id")
      || "";
    if (fromCheckbox) return cleanText(fromCheckbox);

    const spans = [...(row?.querySelectorAll?.(".buyer-modal-trigger-wrapper button span") || [])]
      .map((span) => cleanText(span.textContent));
    if (spans[1]) return spans[1];

    const feedbackLink = row?.querySelector?.('a[href*="/fdbk/feedback_profile/"][href*="q="]');
    if (feedbackLink) {
      try {
        const url = new URL(feedbackLink.getAttribute("href"), window.location.origin);
        const query = url.searchParams.get("q");
        if (query) return cleanText(query);
      } catch (_) {}
    }

    return "";
  }

  function getRowBuyerDisplayName(row) {
    const spans = [...(row?.querySelectorAll?.(".buyer-modal-trigger-wrapper button span") || [])]
      .map((span) => cleanText(span.textContent));
    return spans[0] || "";
  }

  function getRowItemTitle(row) {
    return cleanText(
      row?.querySelector?.(".item-title")?.textContent
      || row?.querySelector?.('a[href*="/itm/"]')?.textContent
      || ""
    );
  }

  function getRowShipStatusText(row) {
    const status = row?.querySelector?.(".order-status");
    return cleanText(status?.innerText || status?.textContent || "");
  }

  function parseShipByDate(statusText) {
    const match = cleanText(statusText).match(/\bShip by ([A-Z][a-z]+)\s+(\d{1,2})\b/);
    if (!match) return null;
    const months = {
      Jan: 0, January: 0,
      Feb: 1, February: 1,
      Mar: 2, March: 2,
      Apr: 3, April: 3,
      May: 4,
      Jun: 5, June: 5,
      Jul: 6, July: 6,
      Aug: 7, August: 7,
      Sep: 8, Sept: 8, September: 8,
      Oct: 9, October: 9,
      Nov: 10, November: 10,
      Dec: 11, December: 11,
    };
    const month = months[match[1]];
    if (month == null) return null;
    const now = new Date();
    return new Date(now.getFullYear(), month, Number(match[2]));
  }

  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function getRowShipStatus(row) {
    const text = getRowShipStatusText(row);
    if (/shipping overdue/i.test(text)) {
      return { rank: 0, label: "Overdue", raw: text };
    }
    const shipBy = parseShipByDate(text);
    if (shipBy) {
      const today = startOfLocalDay(new Date());
      const shipDay = startOfLocalDay(shipBy);
      if (shipDay.getTime() < today.getTime()) return { rank: 0, label: "Overdue", raw: text };
      if (shipDay.getTime() === today.getTime()) return { rank: 1, label: "Due today", raw: text };
      return { rank: 2, label: text, raw: text };
    }
    return { rank: 99, label: text || "No ship status", raw: text };
  }

  function getAssociatedNoteRow(row) {
    const orderNumber = getRowOrderNumber(row);
    if (!orderNumber) return null;
    try {
      return document.querySelector(`tr.my-note-row[ordernumber="${CSS.escape(orderNumber)}"]`);
    } catch (_) {
      return [...document.querySelectorAll("tr.my-note-row[ordernumber]")]
        .find((noteRow) => noteRow.getAttribute("ordernumber") === orderNumber) || null;
    }
  }

  function setRelatedAwaitingRowsClosed(row, closed = true) {
    const orderNumber = getRowOrderNumber(row);
    const rows = [row, getAssociatedNoteRow(row)].filter(Boolean);
    rows.forEach((entry) => {
      entry.classList.toggle("og-ebay-closed-in-og", closed);
      entry.dataset.ogClosedInOg = closed ? "true" : "";
      if (!closed) entry.removeAttribute("data-og-closed-in-og");
    });
    if (closed && orderNumber) ogLocallyClosedAwaitingOrders.add(orderNumber);
    if (!closed && orderNumber) ogLocallyClosedAwaitingOrders.delete(orderNumber);
  }

  function syncLocallyClosedAwaitingRows() {
    if (!ogLocallyClosedAwaitingOrders.size) return;
    getRawEbayAwaitingShipmentRows().forEach((row) => {
      const orderNumber = getRowOrderNumber(row);
      if (orderNumber && ogLocallyClosedAwaitingOrders.has(orderNumber)) {
        setRelatedAwaitingRowsClosed(row, true);
      }
    });
  }

  function shouldHideRowsForPendingQueueChange(payload = {}) {
    const action = String(payload.action || "").toLowerCase();
    return [
      "no_inventory_completion",
      "inventory_fulfillment",
      "live_lot_fulfillment",
      "admin_cancelled",
      "admin_fulfilled_no_inventory",
      "admin_archived",
      "admin_closeout",
    ].includes(action);
  }

  function getPendingOrderNumbersFromPriorityPayload(payload = {}) {
    const pending = new Set();
    (Array.isArray(payload.priorities) ? payload.priorities : []).forEach((entry) => {
      (Array.isArray(entry.orderNumbers) ? entry.orderNumbers : [])
        .map(normalizeOrderNumber)
        .filter(Boolean)
        .forEach((orderNumber) => pending.add(orderNumber));
    });
    return pending;
  }

  function hideClosedAwaitingRowsFromOg(payload = {}, priorityPayload = null) {
    if (!shouldHideRowsForPendingQueueChange(payload)) {
      return { hiddenRows: 0, orderNumbers: [], stillPendingOrderNumbers: [] };
    }

    const orderNumbers = unique([
      payload.orderNumber,
      ...(Array.isArray(payload.orderNumbers) ? payload.orderNumbers : []),
    ].map(normalizeOrderNumber));
    if (!orderNumbers.length) return { hiddenRows: 0, orderNumbers: [], stillPendingOrderNumbers: [] };

    const pendingOrderNumbers = priorityPayload ? getPendingOrderNumbersFromPriorityPayload(priorityPayload) : null;
    const stillPendingOrderNumbers = pendingOrderNumbers
      ? orderNumbers.filter((orderNumber) => pendingOrderNumbers.has(orderNumber))
      : [];
    const closed = new Set(pendingOrderNumbers
      ? orderNumbers.filter((orderNumber) => !pendingOrderNumbers.has(orderNumber))
      : orderNumbers);
    let hiddenRows = 0;
    getEbayAwaitingShipmentRows({ includeOgClosed: true }).forEach((row) => {
      const orderNumber = getRowOrderNumber(row);
      if (!closed.has(orderNumber) || isOgLocallyClosedAwaitingRow(row)) return;
      const checkbox = getRowCheckbox(row);
      if (checkbox?.checked) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
      setRelatedAwaitingRowsClosed(row, true);
      hiddenRows += 1;
    });

    if (hiddenRows) {
      ogPriorityLastRowSignature = "";
      renderUrgentCoverageWarning(null);
      updateBulkActionsShortcut();
      refreshBuyerGroupSelectButtons();
    }

    return { hiddenRows, orderNumbers, stillPendingOrderNumbers };
  }

  function normalizeBuyerKey(value) {
    return String(value || "").trim().toLowerCase();
  }

  function getVisibleOrderRowSignature() {
    return getOrderLinks().map((entry) => entry.orderNumber).join("|");
  }

  function buildPriorityMaps(payload = {}) {
    const entries = Array.isArray(payload.priorities) ? payload.priorities : [];
    const byOrder = new Map();
    const byBuyer = new Map();
    entries.forEach((entry, index) => {
      const normalized = {
        ...entry,
        originalPriorityIndex: index,
        priorityRank: Number.isFinite(Number(entry.priorityRank)) ? Number(entry.priorityRank) : 4,
        buyerKey: normalizeBuyerKey(entry.buyerKey || entry.buyerUsername),
      };
      if (normalized.buyerKey) byBuyer.set(normalized.buyerKey, normalized);
      (Array.isArray(entry.orderNumbers) ? entry.orderNumbers : []).forEach((orderNumber) => {
        const normalizedOrder = normalizeOrderNumber(orderNumber);
        if (normalizedOrder) byOrder.set(normalizedOrder, normalized);
      });
    });
    return { byOrder, byBuyer, entries };
  }

  function getPriorityPendingLines(...priorities) {
    return Math.max(
      0,
      ...priorities.map((priority) => Number(priority?.pendingLines || 0)).filter((count) => Number.isFinite(count))
    );
  }

  function ensureRowBadge(row, className, text, title = "") {
    const cell = row?.querySelector?.("td.checkbox-cell") || row?.firstElementChild;
    if (!cell) return null;
    let badge = cell.querySelector(`.${className}`);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = className;
      cell.insertBefore(badge, cell.firstChild);
    }
    badge.textContent = text;
    if (title) badge.title = title;
    return badge;
  }

  function getBuyerGroupRows(buyerKey) {
    const normalizedBuyerKey = normalizeBuyerKey(buyerKey);
    if (!normalizedBuyerKey) return [];
    return getEbayAwaitingShipmentRows()
      .filter((row) => normalizeBuyerKey(getRowBuyerUsername(row) || row.dataset.ogBuyerGroup) === normalizedBuyerKey);
  }

  function getBuyerGroupCheckboxes(buyerKey) {
    return getBuyerGroupRows(buyerKey)
      .map(getRowCheckbox)
      .filter((checkbox) => checkbox && !checkbox.disabled);
  }

  function isPartialBuyerGroupRow(row) {
    return row?.dataset?.ogPartialBuyerGroup === "true"
      || row?.classList?.contains("is-og-partial-buyer");
  }

  function isBuyerGroupFullySelected(buyerKey) {
    const checkboxes = getBuyerGroupCheckboxes(buyerKey);
    return Boolean(checkboxes.length && checkboxes.every((checkbox) => checkbox.checked));
  }

  function getSelectedAwaitingOrderCheckboxes() {
    return getEbayAwaitingShipmentRows()
      .map(getRowCheckbox)
      .filter((checkbox) => checkbox && checkbox.checked && !checkbox.disabled);
  }

  function getSelectedPartialBuyerCheckboxes() {
    return getSelectedAwaitingOrderCheckboxes()
      .filter((checkbox) => isPartialBuyerGroupRow(checkbox.closest("tr")));
  }

  function clearSelectedPartialBuyerRows({ notify = false } = {}) {
    const checkboxes = getSelectedPartialBuyerCheckboxes();
    if (!checkboxes.length) return 0;
    checkboxes.forEach((checkbox) => {
      setCheckboxChecked(checkbox, false);
    });
    refreshBuyerGroupSelectButtons();
    updateBulkActionsShortcut();
    if (notify) {
      window.alert("OG safety check: one or more selected buyers are only partly visible on this eBay page. The extension cleared those boxes so a partial shipping label is not created by mistake.");
    }
    return checkboxes.length;
  }

  function refreshBuyerGroupSelectButtons(buyerKey = "") {
    const selector = buyerKey
      ? `.og-ebay-select-buyer-group[data-og-buyer-key="${CSS.escape(normalizeBuyerKey(buyerKey))}"]`
      : ".og-ebay-select-buyer-group";
    const buttonsByKey = new Map();
    document.querySelectorAll(selector).forEach((button) => {
      const key = normalizeBuyerKey(button.dataset.ogBuyerKey || "");
      if (!key) return;
      if (!buttonsByKey.has(key)) buttonsByKey.set(key, []);
      buttonsByKey.get(key).push(button);
    });

    buttonsByKey.forEach((buttons, key) => {
      const checkboxes = getBuyerGroupCheckboxes(key);
      const count = checkboxes.length;
      const selected = Boolean(count && checkboxes.every((checkbox) => checkbox.checked));
      buttons.forEach((button) => {
        const partial = button.dataset.ogPartialBuyerGroup === "true";
        const totalOgLines = Number(button.dataset.ogTotalOgLines || 0);
        button.textContent = selected ? `Unselect ${count}` : `Select visible ${count}`;
        button.setAttribute("aria-pressed", selected ? "true" : "false");
        if (partial && !selected) {
          button.textContent = "Do not select";
          button.disabled = true;
          button.title = `OG has ${totalOgLines || "more"} pending line(s) for this buyer, but only ${count} are visible here. Wait until all lines are visible before generating the label.`;
        } else {
          button.disabled = false;
          button.title = selected
            ? "Unselect all visible eBay rows for this buyer"
            : "Select all visible eBay rows for this buyer";
        }
      });
    });
  }

  function getSelectedOrdersCount() {
    const text = document.querySelector("#gridSummary-wrapper-id .shord-selected-count")?.textContent || "";
    const match = text.match(/\((\d+)\s+orders?\s+selected\)/i);
    if (match) return Number(match[1]) || 0;
    return getSelectedAwaitingOrderCheckboxes().length;
  }

  function getSelectedOrdersText() {
    const summary = cleanText(document.querySelector("#gridSummary-wrapper-id .summary-content")?.textContent || "");
    const selected = cleanText(document.querySelector("#gridSummary-wrapper-id .shord-selected-count")?.textContent || "");
    return cleanText(`${summary} ${selected}`);
  }

  function getSelectedOrdersSummaryBlock() {
    return document.querySelector("#gridSummary-wrapper-id .summary.clearfix");
  }

  function getBulkActionsToolbar() {
    return document.querySelector("#gridSummary-wrapper-id .summary-actions .bulk-actions");
  }

  function getBulkShippingDropdownButton() {
    return document.querySelector("#gridSummary-wrapper-id .bulk-shipping .fake-menu-button__button");
  }

  function getBulkShippingMenuItemByText(label) {
    const needle = cleanText(label).toLowerCase();
    return [...document.querySelectorAll("#gridSummary-wrapper-id .bulk-shipping .fake-menu-button__item")]
      .find((button) => cleanText(button.textContent).toLowerCase().includes(needle)) || null;
  }

  function isAnyOrderSelected() {
    return getSelectedOrdersCount() > 0
      && Boolean(getBulkActionsToolbar())
      && Boolean(getBulkShippingDropdownButton());
  }

  function setCheckboxChecked(checkbox, checked) {
    if (!checkbox || checkbox.disabled || checkbox.checked === checked) return false;
    checkbox.click();
    if (checkbox.checked !== checked) {
      checkbox.checked = checked;
      checkbox.dispatchEvent(new Event("input", { bubbles: true }));
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }

  function waitForBrowserPaint() {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function waitForBulkActionsReady({ expectedSelectedCount = 0, timeoutMs = 5000 } = {}) {
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
      const selectedCount = getSelectedOrdersCount();
      const checkedCount = getSelectedAwaitingOrderCheckboxes().length;
      const effectiveCount = Math.max(selectedCount, checkedCount);
      if (
        effectiveCount >= Math.max(Number(expectedSelectedCount || 0), 1)
        && Boolean(getBulkActionsToolbar())
        && Boolean(getBulkShippingDropdownButton())
      ) {
        return true;
      }
      await delay(120);
    }
    return isAnyOrderSelected();
  }

  async function focusEbayBulkActionsWhenReady({ expectedSelectedCount = 0, onlyIfSelected = false } = {}) {
    if (onlyIfSelected && !getSelectedAwaitingOrderCheckboxes().length && getSelectedOrdersCount() < 1) return false;
    const ready = await waitForBulkActionsReady({ expectedSelectedCount });
    updateBulkActionsShortcut();
    if (!ready && onlyIfSelected) return false;
    return scrollEbayBulkActionsIntoView();
  }

  async function toggleBuyerGroupSelection(buyerKey) {
    if (ogBuyerSelectionInProgress) return;
    const firstRow = getBuyerGroupRows(buyerKey)[0];
    if (isPartialBuyerGroupRow(firstRow)) {
      window.alert("OG safety check: this buyer is only partly visible on this eBay page. Do not select or buy labels for this buyer until all of their pending lines are visible together.");
      return;
    }
    const checkboxes = getBuyerGroupCheckboxes(buyerKey);
    if (!checkboxes.length) return;
    const shouldSelect = !checkboxes.every((checkbox) => checkbox.checked);
    const buttons = [...document.querySelectorAll(`.og-ebay-select-buyer-group[data-og-buyer-key="${CSS.escape(normalizeBuyerKey(buyerKey))}"]`)];

    ogBuyerSelectionInProgress = true;
    buttons.forEach((button) => {
      button.disabled = true;
      button.textContent = shouldSelect ? `Selecting ${checkboxes.length}...` : `Unselecting ${checkboxes.length}...`;
    });

    try {
      for (let index = 0; index < checkboxes.length; index += 1) {
        setCheckboxChecked(checkboxes[index], shouldSelect);
        if (index % 4 === 3) await waitForBrowserPaint();
      }
      if (shouldSelect) {
        buttons.forEach((button) => {
          button.textContent = "Opening actions...";
        });
        await focusEbayBulkActionsWhenReady({
          expectedSelectedCount: getSelectedAwaitingOrderCheckboxes().length || checkboxes.length,
        });
      }
    } finally {
      ogBuyerSelectionInProgress = false;
      buttons.forEach((button) => {
        button.disabled = false;
      });
      refreshBuyerGroupSelectButtons(buyerKey);
      updateBulkActionsShortcut();
      window.setTimeout(() => {
        refreshBuyerGroupSelectButtons(buyerKey);
        updateBulkActionsShortcut();
      }, 250);
    }
  }

  async function clearSelectedAwaitingOrders() {
    if (ogBuyerSelectionInProgress) return;
    const checkboxes = getSelectedAwaitingOrderCheckboxes();
    if (!checkboxes.length) return;

    const clearButton = document.getElementById(CLEAR_SELECTED_SHORTCUT_ID);
    ogBuyerSelectionInProgress = true;
    if (clearButton) {
      clearButton.disabled = true;
      clearButton.textContent = `Clearing ${checkboxes.length}...`;
    }

    try {
      for (let index = 0; index < checkboxes.length; index += 1) {
        setCheckboxChecked(checkboxes[index], false);
        if (index % 4 === 3) await waitForBrowserPaint();
      }
    } finally {
      ogBuyerSelectionInProgress = false;
      if (clearButton) clearButton.disabled = false;
      window.setTimeout(() => {
        refreshBuyerGroupSelectButtons();
        updateBulkActionsShortcut();
      }, 180);
    }
  }

  function fillBadgeWithBuyerSelectButton(badge, label, buyerKey, rowCount, title = "", options = {}) {
    if (!badge) return;
    const normalizedBuyerKey = normalizeBuyerKey(buyerKey);
    badge.textContent = "";
    if (title) badge.title = title;

    const labelText = document.createElement("span");
    labelText.textContent = label;
    badge.appendChild(labelText);

    if (!normalizedBuyerKey) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "og-ebay-select-buyer-group";
    button.dataset.ogBuyerKey = normalizedBuyerKey;
    button.dataset.ogBuyerCount = String(rowCount || "");
    button.dataset.ogPartialBuyerGroup = options.partial ? "true" : "false";
    button.dataset.ogTotalOgLines = String(options.totalOgLines || "");
    badge.appendChild(button);
    refreshBuyerGroupSelectButtons(normalizedBuyerKey);
  }

  function clearOldOgBadges(row) {
    row?.querySelectorAll?.(".og-ebay-priority-badge, .og-ebay-buyer-badge").forEach((element) => element.remove());
    row?.removeAttribute?.("data-og-partial-buyer-group");
    row?.removeAttribute?.("data-og-total-og-lines");
  }

  function collectVisibleEbayRows() {
    return getEbayAwaitingShipmentRows().map((row, originalIndex) => {
      const orderNumber = getRowOrderNumber(row);
      const buyerUsername = getRowBuyerUsername(row);
      return {
        row,
        noteRow: getAssociatedNoteRow(row),
        originalIndex,
        orderNumber,
        buyerUsername,
        buyerKey: normalizeBuyerKey(buyerUsername),
        buyerDisplayName: getRowBuyerDisplayName(row),
        itemTitle: getRowItemTitle(row),
        shipStatus: getRowShipStatus(row),
      };
    });
  }

  function getOgPriorityRank(...priorities) {
    const ranks = priorities
      .map((priority) => Number(priority?.priorityRank))
      .filter((rank) => Number.isFinite(rank));
    return ranks.length ? Math.min(...ranks) : 99;
  }

  function groupRowsByBuyer(rowInfos, priorityMaps) {
    const groups = new Map();
    rowInfos.forEach((info) => {
      const ogByOrder = priorityMaps.byOrder.get(info.orderNumber);
      const ogByBuyer = priorityMaps.byBuyer.get(info.buyerKey);
      const buyerKey = normalizeBuyerKey(
        info.buyerUsername
        || ogByOrder?.buyerUsername
        || ogByOrder?.buyerKey
        || ogByBuyer?.buyerUsername
        || ogByBuyer?.buyerKey
        || info.orderNumber
      );
      if (!buyerKey) return;

      if (!groups.has(buyerKey)) {
        groups.set(buyerKey, {
          buyerKey,
          buyerUsername: info.buyerUsername || ogByOrder?.buyerUsername || ogByBuyer?.buyerUsername || buyerKey,
          buyerDisplayName: info.buyerDisplayName || "",
        rows: [],
        orderNumbers: new Set(),
        originalIndex: info.originalIndex,
        pendingLines: 0,
        priorityRank: 99,
        prioritySource: "none",
      });
      }

      const group = groups.get(buyerKey);
      group.rows.push(info);
      if (info.orderNumber) group.orderNumbers.add(info.orderNumber);
      group.originalIndex = Math.min(group.originalIndex, info.originalIndex);
      if (!group.buyerDisplayName && info.buyerDisplayName) group.buyerDisplayName = info.buyerDisplayName;
      if (!group.buyerUsername && info.buyerUsername) group.buyerUsername = info.buyerUsername;

      group.pendingLines = Math.max(group.pendingLines, getPriorityPendingLines(ogByOrder, ogByBuyer));
      const ogRank = getOgPriorityRank(ogByOrder, ogByBuyer);
      const fallbackRank = Number.isFinite(Number(info.shipStatus?.rank)) ? Number(info.shipStatus.rank) : 99;
      const effectiveRank = Math.min(ogRank, fallbackRank);
      if (effectiveRank < group.priorityRank) {
        group.priorityRank = effectiveRank;
        group.prioritySource = ogRank <= fallbackRank ? "og" : "ebay-visible";
      }
    });
    return [...groups.values()];
  }

  function sortBuyerGroups(groups) {
    return [...groups].sort((a, b) => {
      const rankA = Number.isFinite(Number(a.priorityRank)) ? Number(a.priorityRank) : 99;
      const rankB = Number.isFinite(Number(b.priorityRank)) ? Number(b.priorityRank) : 99;
      if (rankA !== rankB) return rankA - rankB;
      return a.originalIndex - b.originalIndex;
    });
  }

  function normalizePriorityLines(entry = {}) {
    const lines = Array.isArray(entry.lines) ? entry.lines : [];
    if (lines.length) {
      return lines.map((line, index) => ({
        orderNumber: normalizeOrderNumber(line.orderNumber),
        itemNumber: cleanText(line.itemNumber || line.item_number || ""),
        transactionId: cleanText(line.transactionId || line.transaction_id || ""),
        itemTitle: cleanText(line.itemTitle || line.item_title || ""),
        remainingQuantity: Number(line.remainingQuantity || line.remaining_quantity || 0) || 0,
        shipByDate: line.shipByDate || line.ship_by_date || entry.nextShipBy || "",
        priorityLabel: cleanText(line.priorityLabel || entry.priorityLabel || ""),
        index,
      }));
    }
    return (Array.isArray(entry.orderNumbers) ? entry.orderNumbers : [])
      .map(normalizeOrderNumber)
      .filter(Boolean)
      .map((orderNumber, index) => ({
        orderNumber,
        itemNumber: "",
        transactionId: "",
        itemTitle: "",
        remainingQuantity: 0,
        shipByDate: entry.nextShipBy || "",
        priorityLabel: cleanText(entry.priorityLabel || ""),
        index,
      }));
  }

  function getHiddenPriorityLines(entry = {}, group = null) {
    const lines = normalizePriorityLines(entry);
    if (!group?.rows?.length) return lines;

    const visibleCountsByOrder = new Map();
    group.rows.forEach((info) => {
      const orderNumber = normalizeOrderNumber(info.orderNumber);
      if (!orderNumber) return;
      visibleCountsByOrder.set(orderNumber, (visibleCountsByOrder.get(orderNumber) || 0) + 1);
    });

    const hidden = [];
    lines.forEach((line) => {
      const orderNumber = normalizeOrderNumber(line.orderNumber);
      const visibleCount = orderNumber ? Number(visibleCountsByOrder.get(orderNumber) || 0) : 0;
      if (visibleCount > 0) {
        visibleCountsByOrder.set(orderNumber, visibleCount - 1);
        return;
      }
      hidden.push(line);
    });
    return hidden;
  }

  function getPriorityEntryLineCount(entry = {}) {
    const lines = normalizePriorityLines(entry);
    return lines.length || Number(entry.pendingLines || 0) || 0;
  }

  function decorateBuyerGroup(row, groupInfo) {
    clearOldOgBadges(row);
    row.classList.add("og-ebay-buyer-group-row");
    row.classList.toggle("og-ebay-buyer-group-first", Boolean(groupInfo.isFirst));
    row.dataset.ogBuyerGroup = groupInfo.buyerUsername || groupInfo.buyerKey || "";
    row.dataset.ogPriorityRank = String(groupInfo.priorityRank ?? 99);
    const totalOgLines = Math.max(Number(groupInfo.pendingLines || 0), groupInfo.rowCount);
    const hasHiddenLines = totalOgLines > groupInfo.rowCount;
    row.dataset.ogPartialBuyerGroup = hasHiddenLines ? "true" : "false";
    row.dataset.ogTotalOgLines = String(totalOgLines || "");
    row.classList.toggle("is-og-overdue", groupInfo.priorityRank === 0);
    row.classList.toggle("is-og-today", groupInfo.priorityRank === 1);
    row.classList.toggle("is-og-partial-buyer", hasHiddenLines);

    if (groupInfo.isFirst) {
      const baseStatusLabel = groupInfo.priorityRank === 0
        ? "OVERDUE"
        : groupInfo.priorityRank === 1
          ? "DUE TODAY"
          : "BUYER";
      const statusLabel = hasHiddenLines ? "DO NOT SHIP - PARTIAL BUYER" : baseStatusLabel;
      const lineText = hasHiddenLines
        ? `${groupInfo.rowCount} visible of ${totalOgLines} OG lines`
        : `${groupInfo.rowCount} ${groupInfo.rowCount === 1 ? "line" : "lines"}`;
      const partialTitle = `Do not generate a label for this buyer yet. OG has ${totalOgLines} pending line(s), but only ${groupInfo.rowCount} are visible on this eBay page.`;
      const badge = ensureRowBadge(
        row,
        "og-ebay-priority-badge",
        `${statusLabel} - Buyer: ${groupInfo.buyerUsername || groupInfo.buyerKey} - ${lineText}`,
        hasHiddenLines ? partialTitle : `This buyer has ${groupInfo.rowCount} visible eBay row${groupInfo.rowCount === 1 ? "" : "s"}.`
      );
      fillBadgeWithBuyerSelectButton(
        badge,
        `${statusLabel} - Buyer: ${groupInfo.buyerUsername || groupInfo.buyerKey} - ${lineText}`,
        groupInfo.buyerKey || groupInfo.buyerUsername,
        groupInfo.rowCount,
        hasHiddenLines ? partialTitle : `This buyer has ${groupInfo.rowCount} visible eBay row${groupInfo.rowCount === 1 ? "" : "s"}.`,
        { partial: hasHiddenLines, totalOgLines }
      );
    } else if (groupInfo.rowCount > 1) {
      const totalOgLines = Math.max(Number(groupInfo.pendingLines || 0), groupInfo.rowCount);
      const hasHiddenLines = totalOgLines > groupInfo.rowCount;
      const sameBuyerLabel = hasHiddenLines
        ? `PARTIAL BUYER - visible line ${groupInfo.groupIndex + 1} of ${groupInfo.rowCount} (${totalOgLines} OG lines)`
        : `Same buyer - line ${groupInfo.groupIndex + 1} of ${groupInfo.rowCount}`;
      const sameBuyerTitle = hasHiddenLines
        ? `Do not generate a label yet. This buyer has ${totalOgLines} pending OG line(s), but only ${groupInfo.rowCount} are visible here.`
        : `This row belongs with ${groupInfo.buyerUsername || groupInfo.buyerKey}.`;
      const badge = ensureRowBadge(
        row,
        "og-ebay-buyer-badge",
        sameBuyerLabel,
        sameBuyerTitle
      );
      fillBadgeWithBuyerSelectButton(
        badge,
        sameBuyerLabel,
        groupInfo.buyerKey || groupInfo.buyerUsername,
        groupInfo.rowCount,
        sameBuyerTitle,
        { partial: hasHiddenLines, totalOgLines }
      );
    }
  }

  function applyGroupedOrder(sortedGroups) {
    const groupsByParent = new Map();
    sortedGroups.forEach((group) => {
      const parent = group.rows[0]?.row?.parentElement;
      if (!parent) return;
      if (!groupsByParent.has(parent)) groupsByParent.set(parent, []);
      groupsByParent.get(parent).push(group);
    });

    let moved = 0;
    groupsByParent.forEach((groups, tbody) => {
      let stripe = 0;
      groups.forEach((group) => {
        const stripeClass = stripe % 2 === 0 ? "og-ebay-buyer-group-a" : "og-ebay-buyer-group-b";
        stripe += 1;
        group.rows.forEach((info, index) => {
          const { row } = info;
          row.classList.remove("og-ebay-buyer-group-a", "og-ebay-buyer-group-b", "og-ebay-priority-row", "is-og-pending", "is-og-tomorrow", "is-og-partial-buyer");
          row.classList.add(stripeClass);
      decorateBuyerGroup(row, {
        buyerKey: group.buyerKey,
        buyerUsername: group.buyerUsername,
        priorityRank: group.priorityRank,
        pendingLines: group.pendingLines,
        rowCount: group.rows.length,
        groupIndex: index,
            isFirst: index === 0,
          });
          tbody.appendChild(row);
          moved += 1;
          if (info.noteRow && info.noteRow.parentElement === tbody) {
            tbody.appendChild(info.noteRow);
          }
        });
      });
    });
    return moved;
  }

  function summarizeUrgentCoverage(payload, groups) {
    const groupByBuyer = new Map(groups.map((group) => [normalizeBuyerKey(group.buyerKey || group.buyerUsername), group]));
    const priorityByBuyer = new Map((Array.isArray(payload?.priorities) ? payload.priorities : [])
      .map((entry) => [normalizeBuyerKey(entry.buyerKey || entry.buyerUsername), entry])
      .filter(([buyerKey]) => Boolean(buyerKey)));
    const urgentPriorities = (Array.isArray(payload?.priorities) ? payload.priorities : [])
      .filter((entry) => Number(entry?.priorityRank) <= 1);
    const hiddenDetailsByBuyer = new Map();

    let missingBuyerCount = 0;
    let partialBuyerCount = 0;
    let hiddenLineCount = 0;
    let visibleUrgentLineCount = 0;
    let visiblePartialBuyerCount = 0;
    let visiblePartialHiddenLineCount = 0;

    const addHiddenDetail = (entry = {}, group = null, hiddenCount = 0, reason = "") => {
      const buyerKey = normalizeBuyerKey(entry.buyerKey || entry.buyerUsername || group?.buyerKey || group?.buyerUsername);
      if (!buyerKey || hiddenDetailsByBuyer.has(buyerKey)) return;
      const hiddenLines = getHiddenPriorityLines(entry, group);
      hiddenDetailsByBuyer.set(buyerKey, {
        buyerKey,
        buyerUsername: entry.buyerUsername || group?.buyerUsername || buyerKey,
        priorityLabel: entry.priorityLabel || "",
        priorityRank: Number(entry.priorityRank ?? group?.priorityRank ?? 99),
        hiddenLineCount: Math.max(Number(hiddenCount || 0), hiddenLines.length || 0),
        pendingLines: Math.max(getPriorityEntryLineCount(entry), Number(entry.pendingLines || 0), Number(group?.pendingLines || 0)),
        visibleLines: Number(group?.rows?.length || 0),
        orderNumbers: unique([
          ...(Array.isArray(entry.orderNumbers) ? entry.orderNumbers : []),
          ...[...(group?.orderNumbers || [])],
        ].map(normalizeOrderNumber)),
        reason,
        hiddenLines,
      });
    };

    groups.forEach((group) => {
      const visibleLines = group?.rows?.length || 0;
      const pendingLines = Math.max(Number(group?.pendingLines || 0), visibleLines);
      if (visibleLines && pendingLines > visibleLines) {
        visiblePartialBuyerCount += 1;
        visiblePartialHiddenLineCount += pendingLines - visibleLines;
        const buyerKey = normalizeBuyerKey(group.buyerKey || group.buyerUsername);
        addHiddenDetail(priorityByBuyer.get(buyerKey) || {
          buyerKey,
          buyerUsername: group.buyerUsername || buyerKey,
          pendingLines,
          orderNumbers: [...(group.orderNumbers || [])],
          priorityRank: group.priorityRank,
        }, group, pendingLines - visibleLines, "visible-partial");
      }
    });

    urgentPriorities.forEach((entry) => {
      const buyerKey = normalizeBuyerKey(entry.buyerKey || entry.buyerUsername);
      const group = groupByBuyer.get(buyerKey);
      const visibleLines = group?.rows?.length || 0;
      const pendingLines = Math.max(Number(entry.pendingLines || 0), visibleLines);
      visibleUrgentLineCount += Math.min(visibleLines, pendingLines);

      if (!visibleLines) {
        missingBuyerCount += 1;
        hiddenLineCount += pendingLines;
        addHiddenDetail(entry, null, pendingLines, "missing");
      } else if (pendingLines > visibleLines) {
        partialBuyerCount += 1;
        hiddenLineCount += pendingLines - visibleLines;
        addHiddenDetail(entry, group, pendingLines - visibleLines, "urgent-partial");
      }
    });

    return {
      hiddenLineCount,
      missingBuyerCount,
      partialBuyerCount,
      urgentBuyerCount: urgentPriorities.length,
      urgentLineCount: Number(payload?.urgentLineCount || 0) || urgentPriorities.reduce((sum, entry) => sum + Number(entry.pendingLines || 0), 0),
      visibleUrgentLineCount,
      visiblePartialBuyerCount,
      visiblePartialHiddenLineCount,
      hiddenDetails: [...hiddenDetailsByBuyer.values()]
        .sort((a, b) =>
          a.priorityRank - b.priorityRank
          || b.hiddenLineCount - a.hiddenLineCount
          || String(a.buyerUsername || "").localeCompare(String(b.buyerUsername || ""), undefined, { sensitivity: "base" })
        ),
    };
  }

  function getHiddenLineSummary(line = {}) {
    const parts = [];
    if (line.itemNumber) parts.push(`#${line.itemNumber}`);
    else if (line.transactionId) parts.push(`Transaction ${line.transactionId}`);
    else if (line.orderNumber) parts.push(`Order ${line.orderNumber}`);
    if (line.itemTitle) parts.push(line.itemTitle);
    if (line.remainingQuantity) parts.push(`Qty ${line.remainingQuantity}`);
    return parts.join(" - ") || "Pending OG line";
  }

  function buildHiddenCoverageDetails(details = []) {
    const wrapper = document.createElement("div");
    wrapper.className = "og-ebay-hidden-coverage-details";

    if (!details.length) {
      const empty = document.createElement("p");
      empty.className = "og-ebay-hidden-empty";
      empty.textContent = "Open or refresh OG Pending Orders to load buyer/item details for the hidden lines.";
      wrapper.appendChild(empty);
      return wrapper;
    }

    const shownDetails = details.slice(0, 12);
    shownDetails.forEach((detail) => {
      const article = document.createElement("article");
      const title = document.createElement("strong");
      const count = Number(detail.hiddenLineCount || detail.hiddenLines?.length || 0);
      const visible = Number(detail.visibleLines || 0);
      const pending = Number(detail.pendingLines || 0);
      title.textContent = `${detail.buyerUsername || detail.buyerKey || "Unknown buyer"} - ${count || "Some"} hidden line${count === 1 ? "" : "s"}`;
      article.appendChild(title);

      const meta = document.createElement("span");
      meta.textContent = [
        detail.priorityLabel || "",
        pending ? `${pending} OG pending` : "",
        visible ? `${visible} visible here` : "not visible here",
      ].filter(Boolean).join(" - ");
      article.appendChild(meta);

      const list = document.createElement("ul");
      (detail.hiddenLines || []).slice(0, 6).forEach((line) => {
        const item = document.createElement("li");
        item.textContent = getHiddenLineSummary(line);
        list.appendChild(item);
      });
      const unlisted = Math.max(0, count - (detail.hiddenLines || []).slice(0, 6).length);
      if (unlisted > 0) {
        const more = document.createElement("li");
        more.textContent = `${unlisted} more hidden line${unlisted === 1 ? "" : "s"} for this buyer`;
        list.appendChild(more);
      }
      article.appendChild(list);
      wrapper.appendChild(article);
    });

    if (details.length > shownDetails.length) {
      const more = document.createElement("p");
      more.className = "og-ebay-hidden-empty";
      more.textContent = `${details.length - shownDetails.length} more buyer${details.length - shownDetails.length === 1 ? "" : "s"} hidden. Open OG Pending Orders for the full queue.`;
      wrapper.appendChild(more);
    }

    return wrapper;
  }

  function renderUrgentCoverageWarning(coverage) {
    let warning = document.getElementById(URGENT_COVERAGE_WARNING_ID);
    const hiddenUrgentLines = Number(coverage?.hiddenLineCount || 0);
    const partialHiddenLines = Number(coverage?.visiblePartialHiddenLineCount || 0);
    if (!isAwaitingShipmentOrdersPage() || !coverage || (hiddenUrgentLines <= 0 && partialHiddenLines <= 0)) {
      warning?.remove();
      return;
    }

    if (!warning) {
      warning = document.createElement("div");
      warning.id = URGENT_COVERAGE_WARNING_ID;
      document.body.appendChild(warning);
    }

    const hiddenLines = hiddenUrgentLines;
    const missingBuyers = Number(coverage.missingBuyerCount || 0);
    const partialBuyers = Number(coverage.partialBuyerCount || 0);
    const visiblePartialBuyers = Number(coverage.visiblePartialBuyerCount || 0);
    const visiblePartialHiddenLines = Number(coverage.visiblePartialHiddenLineCount || 0);
    const pieces = [];
    if (hiddenLines) {
      pieces.push(`${hiddenLines.toLocaleString()} urgent OG line${hiddenLines === 1 ? "" : "s"} not visible on this eBay page`);
    }
    if (missingBuyers) pieces.push(`${missingBuyers.toLocaleString()} buyer${missingBuyers === 1 ? "" : "s"} not shown`);
    if (partialBuyers) pieces.push(`${partialBuyers.toLocaleString()} buyer${partialBuyers === 1 ? "" : "s"} only partly shown`);
    if (visiblePartialBuyers) {
        pieces.push(`${visiblePartialBuyers.toLocaleString()} visible buyer group${visiblePartialBuyers === 1 ? "" : "s"} incomplete (${visiblePartialHiddenLines.toLocaleString()} hidden line${visiblePartialHiddenLines === 1 ? "" : "s"})`);
    }
    const wasExpanded = warning.dataset.ogExpanded === "true";
    warning.textContent = "";

    const summary = document.createElement("div");
    summary.className = "og-ebay-coverage-summary";
    summary.textContent = `Safety check: ${pieces.join(" - ")}. Do not ship partial buyer groups until all lines are visible together.`;
    warning.appendChild(summary);

    const actions = document.createElement("div");
    actions.className = "og-ebay-coverage-actions";
    const detailsButton = document.createElement("button");
    detailsButton.type = "button";
    detailsButton.className = "og-ebay-coverage-details-toggle";
    detailsButton.textContent = wasExpanded ? "Hide hidden lines" : "Show hidden lines";
    actions.appendChild(detailsButton);
    warning.appendChild(actions);

    const details = buildHiddenCoverageDetails(coverage.hiddenDetails || []);
    details.hidden = !wasExpanded;
    warning.appendChild(details);

    detailsButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const expanded = warning.dataset.ogExpanded !== "true";
      warning.dataset.ogExpanded = expanded ? "true" : "false";
      details.hidden = !expanded;
      detailsButton.textContent = expanded ? "Hide hidden lines" : "Show hidden lines";
    });
  }

  function clearOgPriorityBadges(root = document) {
    root.querySelectorAll(".og-ebay-priority-badge, .og-ebay-buyer-badge").forEach((badge) => badge.remove());
    root.querySelectorAll(".og-ebay-priority-row").forEach((row) => {
      row.classList.remove("og-ebay-priority-row", "is-og-overdue", "is-og-today", "is-og-tomorrow", "is-og-pending");
      row.removeAttribute("data-og-priority-rank");
    });
    root.querySelectorAll(".og-ebay-buyer-group-row").forEach((row) => {
      row.classList.remove("og-ebay-buyer-group-row", "og-ebay-buyer-group-a", "og-ebay-buyer-group-b", "og-ebay-buyer-group-first", "is-og-overdue", "is-og-today", "is-og-partial-buyer");
      row.removeAttribute("data-og-buyer-group");
      row.removeAttribute("data-og-priority-rank");
      row.removeAttribute("data-og-partial-buyer-group");
      row.removeAttribute("data-og-total-og-lines");
    });
  }

  function applyOgPendingPriorities(payload = ogPendingPriorityCache) {
    if (!payload || !isAwaitingShipmentOrdersPage()) return { ok: false, matched: 0, moved: 0 };
    clearOgPriorityBadges();
    const priorityMaps = buildPriorityMaps(payload);
    const rowInfos = collectVisibleEbayRows();
    const groups = sortBuyerGroups(groupRowsByBuyer(rowInfos, priorityMaps));
    const moved = applyGroupedOrder(groups);
    const withPriority = groups.filter((group) => group.prioritySource === "og" && group.priorityRank <= 1);
    const withEbayUrgency = groups.filter((group) => group.prioritySource === "ebay-visible" && group.priorityRank <= 1);
    const coverage = summarizeUrgentCoverage(payload, groups);
    renderUrgentCoverageWarning(coverage);
    window.setTimeout(() => {
      clearSelectedPartialBuyerRows();
    }, 0);

    ogPriorityLastRowSignature = getVisibleOrderRowSignature();

    return {
      ok: true,
      matched: withPriority.reduce((sum, group) => sum + group.rows.length, 0),
      ebayMatched: withEbayUrgency.reduce((sum, group) => sum + group.rows.length, 0),
      moved,
      visibleRows: rowInfos.length,
      buyerGroups: groups.length,
      hiddenUrgentLines: coverage.hiddenLineCount,
      hiddenPartialLines: coverage.visiblePartialHiddenLineCount,
      missingUrgentBuyers: coverage.missingBuyerCount,
      partialUrgentBuyers: coverage.partialBuyerCount,
      visiblePartialBuyers: coverage.visiblePartialBuyerCount,
      urgentBuyers: payload.urgentBuyerCount || 0,
      overdueBuyers: payload.overdueBuyerCount || 0,
      dueTodayBuyers: payload.dueTodayBuyerCount || 0,
    };
  }

  async function requestOgPendingPriorities() {
    const response = await chrome.runtime.sendMessage({
      type: "OG_EBAY_GET_PENDING_PRIORITIES",
      payload: {
        pageUrl: window.location.href,
        visibleOrderNumbers: uniqueOrderNumbers(),
        requestedAt: new Date().toISOString(),
      },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not get OG due-order priorities.");
    ogPendingPriorityCache = response;
    return response;
  }

  async function getOrganizerPriorityPayload(messagePayload = {}) {
    const prefetched = messagePayload?.priorityPayload;
    if (prefetched?.ok && Array.isArray(prefetched.priorities)) {
      ogPendingPriorityCache = prefetched;
      return prefetched;
    }
    if (prefetched?.error) {
      console.warn("[OG eBay Priority] Prefetch failed, requesting live priorities:", prefetched.error);
    }
    return requestOgPendingPriorities();
  }

  function updatePriorityButtonStatus(text, tone = "") {
    const button = document.getElementById(PRIORITIZE_DUE_ORDERS_ID);
    if (!button) return;
    button.textContent = text;
    button.dataset.statusTone = tone;
  }

  function updatePriorityButtonStatusFromResult(result = {}, payload = {}) {
    const urgentBuyers = Number(payload.urgentBuyerCount || 0);
    if (Number(result.hiddenUrgentLines || 0) > 0) {
      updatePriorityButtonStatus(`${Number(result.hiddenUrgentLines).toLocaleString()} urgent OG line${Number(result.hiddenUrgentLines) === 1 ? "" : "s"} not visible`, "error");
    } else if (Number(result.hiddenPartialLines || 0) > 0) {
      updatePriorityButtonStatus(`${Number(result.visiblePartialBuyers || 0).toLocaleString()} partial buyer group${Number(result.visiblePartialBuyers || 0) === 1 ? "" : "s"}`, "error");
    } else if (result.matched > 0) {
      updatePriorityButtonStatus(`OG sorted ${result.matched} visible row${result.matched === 1 ? "" : "s"}`, "success");
    } else if (result.ebayMatched > 0) {
      updatePriorityButtonStatus(`eBay sorted ${result.ebayMatched} urgent row${result.ebayMatched === 1 ? "" : "s"}`, "success");
    } else if (urgentBuyers > 0) {
      updatePriorityButtonStatus(`${urgentBuyers} urgent OG buyer${urgentBuyers === 1 ? "" : "s"} not matched here`, "success");
    } else {
      updatePriorityButtonStatus("No overdue/today OG buyers", "success");
    }
  }

  async function prioritizeEbayRowsFromOg({ silent = false } = {}) {
    try {
      if (!silent) updatePriorityButtonStatus("Loading OG priorities...");
      const payload = await requestOgPendingPriorities();
      const result = applyOgPendingPriorities(payload);
      updatePriorityButtonStatusFromResult(result, payload);
      return result;
    } catch (error) {
      if (!silent) {
        console.warn("[OG eBay Priority]", error);
        updatePriorityButtonStatus("Open OG Pending Orders to sort", "error");
      }
      return { ok: false, error: error.message || String(error) };
    }
  }

  function maybeAutoPrioritizeEbayRows() {
    if (!isAwaitingShipmentOrdersPage()) return;
    const key = `${window.location.pathname}${window.location.search}`;
    if (ogPriorityAutoAttemptKey === key) return;
    ogPriorityAutoAttemptKey = key;
    window.setTimeout(() => {
      prioritizeEbayRowsFromOg({ silent: true });
    }, 1500);
  }

  function schedulePriorityReapply({ force = false } = {}) {
    if (!ogPendingPriorityCache || ogPriorityReapplyTimer) return;
    const signature = getVisibleOrderRowSignature();
    if (!force && (!signature || signature === ogPriorityLastRowSignature)) return;
    ogPriorityReapplyTimer = window.setTimeout(() => {
      ogPriorityReapplyTimer = null;
      applyOgPendingPriorities(ogPendingPriorityCache);
      refreshBuyerGroupSelectButtons();
    }, 450);
  }

  function attachBuyerGroupSelectionHandlers() {
    if (ogBuyerSelectionHandlersAttached) return;
    ogBuyerSelectionHandlersAttached = true;

    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.(".og-ebay-select-buyer-group");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      toggleBuyerGroupSelection(button.dataset.ogBuyerKey || "");
    }, true);

    document.addEventListener("change", (event) => {
      if (!event.target?.matches?.('input[data-testid="order-checkbox"], input[data-ordernumber], input[data-buyer-id]')) return;
      const row = event.target.closest("tr");
      if (event.target.checked && isPartialBuyerGroupRow(row) && !ogBuyerSelectionInProgress) {
        window.clearTimeout(ogPartialSelectionWarningTimer);
        ogPartialSelectionWarningTimer = window.setTimeout(() => {
          clearSelectedPartialBuyerRows({ notify: true });
        }, 0);
        return;
      }
      if (ogBuyerSelectionInProgress) {
        window.clearTimeout(ogBuyerSelectionRefreshTimer);
        ogBuyerSelectionRefreshTimer = window.setTimeout(() => {
          refreshBuyerGroupSelectButtons();
          updateBulkActionsShortcut();
        }, 180);
        return;
      }
      updateBulkActionsShortcut();
      refreshBuyerGroupSelectButtons(getRowBuyerUsername(event.target.closest("tr")));
    }, true);
  }

  function getEbayBulkActionsTarget() {
    return getBulkActionsToolbar()
      || getSelectedOrdersSummaryBlock()
      || document.querySelector("#gridSummary-wrapper-id")
      || document.querySelector("#mainGridContainer");
  }

  function scrollEbayBulkActionsIntoView() {
    const target = getEbayBulkActionsTarget();
    if (!target) {
      const scroller = document.scrollingElement || document.documentElement || document.body;
      scroller?.scrollTo?.({ top: 0, behavior: "smooth" });
      window.scrollTo?.({ top: 0, behavior: "smooth" });
      return false;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    target.classList.add("og-ebay-actions-highlight");
    window.setTimeout(() => target.classList.remove("og-ebay-actions-highlight"), 1800);
    return true;
  }

  function updateBulkActionsShortcut() {
    let button = document.getElementById(BULK_ACTIONS_SHORTCUT_ID);
    let clearButton = document.getElementById(CLEAR_SELECTED_SHORTCUT_ID);
    const selectedCount = getSelectedOrdersCount();

    if (!isAwaitingShipmentOrdersPage() || selectedCount < 1 || !isAnyOrderSelected()) {
      button?.remove();
      clearButton?.remove();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = BULK_ACTIONS_SHORTCUT_ID;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        scrollEbayBulkActionsIntoView();
      });
      document.body.appendChild(button);
    }

    if (!clearButton) {
      clearButton = document.createElement("button");
      clearButton.type = "button";
      clearButton.id = CLEAR_SELECTED_SHORTCUT_ID;
      clearButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearSelectedAwaitingOrders();
      });
      document.body.appendChild(clearButton);
    }

    button.textContent = `Go to selected actions (${selectedCount})`;
    button.title = getSelectedOrdersText() || "Go to eBay selected-order actions";
    clearButton.textContent = `Clear selected (${selectedCount})`;
    clearButton.title = "Unselect all selected visible eBay rows";
  }

  function parseCountFromText(value) {
    const text = cleanText(value);
    if (!text) return 0;
    const patterns = [
      /\b(\d+)\s+(?:item|items|unit|units)\b/i,
      /\b(?:qty|quantity)\s*:?\s*(\d+)\b/i,
      /\b(?:item|items|unit|units|selected)\s*:?\s*(\d+)\b/i,
      /\b(\d+)\s+(?:selected|ready to ship)\b/i,
      /\b(\d+)\s+(?:order|orders)\s+(?:selected|ready|to ship|in this shipment)\b/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const count = Number(match?.[1] || 0);
      if (Number.isFinite(count) && count > 0) return count;
    }
    return 0;
  }

  function findPackageDimensionInputs() {
    const inputs = [...document.querySelectorAll("input")];
    const findByHints = (hints) => inputs.find((input) => {
      const haystack = [
        input.getAttribute("aria-label"),
        input.getAttribute("name"),
        input.getAttribute("id"),
        input.getAttribute("placeholder"),
      ].map((entry) => String(entry || "").toLowerCase()).join(" ");
      return hints.some((hint) => haystack.includes(hint));
    });

    return {
      length: document.querySelector('input[aria-label="Package length in inches"]') || findByHints(["package length", "length"]),
      width: document.querySelector('input[aria-label="Package width in inches"]') || findByHints(["package width", "width"]),
      height: document.querySelector('input[aria-label="Package height in inches"]') || findByHints(["package height", "height"]),
    };
  }

  function setInputValue(input, value) {
    if (!input) return;
    input.focus();
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }

  function setPackageDimensionsToFour() {
    const dimensions = findPackageDimensionInputs();
    setInputValue(dimensions.length, 4);
    setInputValue(dimensions.width, 4);
    setInputValue(dimensions.height, 4);
  }

  function hasPackageDimensionInputs() {
    const dimensions = findPackageDimensionInputs();
    return Boolean(dimensions.length && dimensions.width && dimensions.height);
  }

  function detectShippingItemCount() {
    const counts = [];
    if (!isAwaitingShipmentOrdersPage()) {
      const orderNumbers = uniqueOrderNumbers();
      if (orderNumbers.length) counts.push(orderNumbers.length);
    }

    const orderSection = document.querySelector('section[aria-label="Order information"]');
    counts.push(parseCountFromText(orderSection?.querySelector("button.fake-link")?.textContent));
    counts.push(parseCountFromText(orderSection?.innerText || orderSection?.textContent));

    const targetedSelectors = [
      '[data-testid="order-page"]',
      '[data-testid*="item" i]',
      '[data-testid*="line" i]',
      '[data-testid*="shipment" i]',
      '[data-testid*="package" i]',
      '[aria-label*="item" i]',
      '[aria-label*="shipment" i]',
    ];
    targetedSelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        counts.push(parseCountFromText(element.innerText || element.textContent));
      });
    });

    return Math.max(0, ...counts.filter((count) => Number.isFinite(count)));
  }

  function isShippingLabelWorkflowPage() {
    if (isAwaitingShipmentOrdersPage()) return false;
    return Boolean(
      isSingleLabelPage()
      || hasPackageDimensionInputs()
      || getShippingActions()
      || /\/ship\/(?:single|bulk|label|labels)\b/i.test(window.location.pathname)
    );
  }

  function getLabelMetadata() {
    const downloadButton = getDownloadLabelButton();
    const printButton = getPrintLabelButton();
    const metadataText = getElementMetadataText(downloadButton || printButton || getShippingActions());
    const fromPage = getSingleLabelOrderNumber() || normalizeOrderNumber(window.location.href) || normalizeOrderNumber(metadataText);
    const orderId = normalizeOrderNumber(parseMetadataValue(metadataText, ["order_id", "orderId", "order_number", "orderNumber"]) || fromPage);
    const shipmentId = parseMetadataValue(metadataText, ["shipment_id", "shipmentId", "shipmentid"]);
    const labelId = parseMetadataValue(metadataText, ["label_id", "labelId", "labelid"]);
    const trackingNumbers = getSingleLabelTrackingNumbers();
    return {
      source: "ebay-single-label-page",
      orderId: normalizeOrderNumber(parseMetadataValue(metadataText, ["order_id", "orderId", "order_number", "orderNumber"]) || fromPage),
      orderNumber: orderId,
      shipmentId,
      labelId,
      carrier: parseMetadataValue(metadataText, ["carrier_code", "carrierCode", "carrier"]),
      service: parseMetadataValue(metadataText, ["service_code", "serviceCode", "service"]),
      packageType: parseMetadataValue(metadataText, ["package_code", "packageCode", "package"]),
      labelCost: parseMetadataValue(metadataText, ["label_cost", "labelCost"]),
      trackingNumber: trackingNumbers[0] || "",
      trackingNumbers,
      shippingBarcodeNumber: trackingNumbers[0] || "",
      shippingBarcodeNumbers: trackingNumbers,
      lookupKeys: unique([
        orderId,
        shipmentId,
        labelId,
        ...trackingNumbers,
      ]),
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

  function uniqueTextMatches(text, pattern) {
    const regex = pattern.global
      ? pattern
      : new RegExp(pattern.source, `${pattern.flags || ""}g`);
    return [...new Set([...String(text || "").matchAll(regex)].map((match) => match[0]))];
  }

  function getBulkConfirmationOrderIds() {
    const fromItemDetails = [...document.querySelectorAll('ul[data-testid="item-details-no-sku"] li')]
      .map((li) => li.textContent || "")
      .map((text) => text.match(ORDER_NUMBER_PATTERN)?.[0])
      .filter(Boolean);
    const fallbackFromPageText = uniqueTextMatches(document.body?.innerText || "", ORDER_NUMBER_PATTERN);
    return [...new Set([...fromItemDetails, ...fallbackFromPageText])];
  }

  function normalizeBulkContextOrderIds(context) {
    const raw = [
      ...(Array.isArray(context?.orderIds) ? context.orderIds : []),
      ...(Array.isArray(context?.orderNumbers) ? context.orderNumbers : []),
      ...(Array.isArray(context?.orders) ? context.orders.map((entry) => entry?.orderId || entry?.orderNumber || entry) : []),
    ];
    return [...new Set(raw.map(normalizeOrderNumber).filter(Boolean))];
  }

  function getOptionalCachedBulkContext() {
    const keys = [
      "ogEbayBulkLabelContext",
      "og-ebay-bulk-label-context",
      "og.ebay.bulkLabelContext",
      "ogBulkLabelContext",
    ];

    for (const storage of [window.sessionStorage, window.localStorage]) {
      if (!storage) continue;
      for (const key of keys) {
        try {
          const raw = storage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") return parsed;
        } catch (_) {}
      }
    }

    return null;
  }

  function getBulkConfirmationTrackingNumbers() {
    const bodyText = document.body?.innerText || "";
    const explicitMatches = [...bodyText.matchAll(/Tracking No\.?:\s*((?:\d[\s-]*){20,30})/gi)]
      .map((match) => normalizeTrackingNumber(match[1]));
    return unique(explicitMatches.length ? explicitMatches : getTrackingNumbersFromText(bodyText));
  }

  function getBulkConfirmationLabelRows() {
    const candidateRows = [
      ...document.querySelectorAll(".grid__group, .success-summary-cards, section.card, .labels-confirmation-page article, .labels-confirmation-page section, .labels-confirmation-page li"),
    ];
    const rows = [];

    for (const row of candidateRows) {
      const text = row.innerText || row.textContent || "";
      const trackingNumbers = getTrackingNumbersFromText(text);
      const orderIds = unique(
        [...row.querySelectorAll('ul[data-testid="item-details-no-sku"] li')]
          .map((li) => (li.textContent || "").match(ORDER_NUMBER_PATTERN)?.[0])
          .filter(Boolean)
      );
      const shipmentIds = unique(
        [...row.querySelectorAll('a[href*="shipmentId="]')]
          .map((link) => {
            try {
              return new URL(link.getAttribute("href") || link.href, window.location.origin).searchParams.get("shipmentId") || "";
            } catch (_) {
              return "";
            }
          })
      );

      if (trackingNumbers.length || orderIds.length || shipmentIds.length) {
        rows.push({
          orderIds,
          orderNumbers: orderIds,
          trackingNumber: trackingNumbers[0] || "",
          trackingNumbers,
          shippingBarcodeNumber: trackingNumbers[0] || "",
          shippingBarcodeNumbers: trackingNumbers,
          shipmentIds,
          rowText: text.slice(0, 2000),
        });
      }
    }

    return rows.filter((row, index, array) => {
      const key = [row.orderIds.join(","), row.trackingNumbers.join(","), row.shipmentIds.join(",")].join("|");
      return key.replace(/\|/g, "")
        && array.findIndex((entry) => [entry.orderIds.join(","), entry.trackingNumbers.join(","), entry.shipmentIds.join(",")].join("|") === key) === index;
    });
  }

  function getBulkLabelConfirmationSnapshot() {
    const downloadLink = getBulkLabelDownloadLink();
    const rawHref = downloadLink?.getAttribute("href") || "";
    const absoluteLabelUrl = rawHref ? new URL(rawHref, window.location.origin).toString() : "";
    const labelIdMatch = absoluteLabelUrl.match(/\/label\/([^/]+)\/download/i);
    const labelId = labelIdMatch?.[1] || "";
    const shipmentIds = [...document.querySelectorAll('a[href*="shipmentId="]')]
      .map((link) => {
        try {
          return new URL(link.getAttribute("href") || link.href, window.location.origin).searchParams.get("shipmentId") || "";
        } catch (_) {
          return "";
        }
      })
      .filter(Boolean);
    const pageText = document.body?.innerText || "";
    const cachedBulkContext = getOptionalCachedBulkContext();
    const extractedOrderIds = getBulkConfirmationOrderIds();
    const cachedOrderIds = normalizeBulkContextOrderIds(cachedBulkContext);
    const orderIds = extractedOrderIds.length ? extractedOrderIds : cachedOrderIds;
    const labelRows = getBulkConfirmationLabelRows();
    const rowTrackingNumbers = unique(labelRows.flatMap((row) => row.trackingNumbers || []));
    const trackingNumbers = unique(rowTrackingNumbers.length ? rowTrackingNumbers : getBulkConfirmationTrackingNumbers())
      .filter((entry) => !orderIds.includes(entry));
    const labelCountText = cleanText(document.querySelector('[data-testid="label-generation-success-notice"]')?.innerText || "");
    const labelCount = Number(labelCountText.match(/\b(\d+)\s+label/i)?.[1] || 0) || "";
    const billingSummaryText = cleanText(document.querySelector(".billing-summary")?.innerText || "");
    const billingCost = billingSummaryText.match(/\$\s?\d[\d,]*(?:\.\d{2})?/)?.[0] || "";

    return {
      source: "ebay-bulk-label-confirmation",
      capturedAt: new Date().toISOString(),
      pageUrl: window.location.href,
      pageTitle: document.title || "",
      labelUrl: absoluteLabelUrl,
      labelId,
      shipmentId: shipmentIds[0] || "",
      shipmentIds: [...new Set(shipmentIds)],
      orderId: orderIds.length === 1 ? orderIds[0] : "",
      orderIds,
      orderNumbers: orderIds,
      trackingNumber: trackingNumbers[0] || "",
      trackingNumbers,
      shippingBarcodeNumber: trackingNumbers[0] || "",
      shippingBarcodeNumbers: trackingNumbers,
      labelRows,
      lookupKeys: unique([
        ...orderIds,
        ...shipmentIds,
        labelId,
        ...trackingNumbers,
      ]),
      cachedBulkContext: cachedBulkContext || null,
      labelCount,
      labelCountText,
      billingSummaryText,
      billingCost,
    };
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

  function setBulkLabelButtonStatus(message, tone = "info") {
    const button = document.getElementById(SEND_BULK_LABELS_ID);
    if (!button) return;
    button.dataset.statusTone = tone;
    button.textContent = message || "Send Bulk Labels to OG";
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
      && /(^|,|\n)\s*"?Item Title"?\s*(,|\n)/i.test(text);
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
        setLabelButtonStatus(captured.result.canceled ? "Returned to queue" : captured.result.opened ? "Opened OG to attach" : "Attached to OG", "success");
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
      setLabelButtonStatus(response.canceled ? "Returned to queue" : response.opened ? "Opened OG to attach" : "Attached to OG", "success");
      window.setTimeout(() => setLabelButtonStatus("Send Label to OG"), 3500);
    } catch (error) {
      console.error("[OG eBay Label] Capture failed:", error);
      cancelDownloadCapture(downloadCaptureId);
      setLabelButtonStatus("Capture failed", "error");
      window.alert(`${getErrorMessage(error)}\n\nThe extension now also watches Chrome/Edge downloads. If a PDF still downloads normally but does not attach, send me the console lines that start with [OG eBay Label].`);
      window.setTimeout(() => setLabelButtonStatus("Send Label to OG"), 5000);
    }
  }

  function setReturnButtonStatus(button, text, tone = "") {
    if (!button) return;
    button.textContent = text;
    button.dataset.statusTone = tone;
    button.disabled = /opening|sending|matching/i.test(text);
  }

  async function sendReturnToOg(returnInfo, button = null) {
    try {
      assertExtensionContextActive();
    } catch (error) {
      setReturnButtonStatus(button, "Refresh page", "error");
      window.alert(error.message);
      return;
    }

    const payload = {
      return: {
        ...returnInfo,
        capturedAt: new Date().toISOString(),
        pageUrl: window.location.href,
        pageTitle: document.title || returnInfo.pageTitle || "",
      },
      metadata: {
        source: "ebay-returns-page",
        returnId: returnInfo.returnId || "",
        buyerUsername: returnInfo.buyerUsername || "",
        itemNumber: returnInfo.itemNumber || "",
        transactionId: returnInfo.transactionId || "",
        pageUrl: window.location.href,
        capturedAt: new Date().toISOString(),
      },
    };

    try {
      setReturnButtonStatus(button, "Opening OG...");
      const response = await chrome.runtime.sendMessage({
        type: "OG_EBAY_SEND_RETURN",
        payload,
      });
      if (!response?.ok) throw new Error(response?.error || "Could not open the OG return workflow.");
      setReturnButtonStatus(button, response.opened ? "Opened in OG" : "Sent to OG", "success");
      window.setTimeout(() => setReturnButtonStatus(button, "Open Return in OG"), 3500);
    } catch (error) {
      console.error("[OG eBay Return] Transfer failed:", error);
      setReturnButtonStatus(button, "Send failed", "error");
      window.alert(error?.message || "Could not send this eBay return to OG.");
      window.setTimeout(() => setReturnButtonStatus(button, "Open Return in OG"), 5000);
    }
  }

  async function sendBulkLabelToOg() {
    try {
      assertExtensionContextActive();
    } catch (error) {
      setBulkLabelButtonStatus("Refresh eBay page", "error");
      window.alert(error.message);
      return;
    }

    try {
      setBulkLabelButtonStatus("Finding bulk label...");
      const metadata = getBulkLabelConfirmationSnapshot();
      labelLog("bulk metadata", metadata);
      if (!metadata.labelUrl) throw new Error("Could not find the bulk label download URL.");

      setBulkLabelButtonStatus("Sending to OG...");
      const label = await fetchLabelUrlFromContentScript(metadata.labelUrl);
      if (!label.base64) throw new Error("The bulk label URL did not return a readable PDF.");

      const response = await chrome.runtime.sendMessage({
        type: "OG_EBAY_SEND_LABEL",
        payload: {
          metadata,
          label,
        },
      });
      if (!response?.ok) throw new Error(response?.error || "Could not hand the bulk label to OG.");

      setBulkLabelButtonStatus(response.canceled ? "Returned to queue" : response.opened ? "Opened OG to attach" : "Sent to OG", "success");
      window.setTimeout(() => setBulkLabelButtonStatus("Send Bulk Labels to OG"), 3500);
    } catch (error) {
      console.error("[OG eBay Label] Failed to send bulk label to OG:", error);
      setBulkLabelButtonStatus("Send failed", "error");
      window.alert(error?.message || "Failed to send bulk label to OG.");
      window.setTimeout(() => setBulkLabelButtonStatus("Send Bulk Labels to OG"), 5000);
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
      #${SEND_AWAITING_REPORT_ID},
      #${PRIORITIZE_DUE_ORDERS_ID},
      #${BULK_ACTIONS_SHORTCUT_ID},
      #${CLEAR_SELECTED_SHORTCUT_ID} {
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

      #${PRIORITIZE_DUE_ORDERS_ID} {
        bottom: 126px;
        border-color: #7f56d9;
        background: #f4efff;
        color: #4a1d96;
        max-width: min(340px, calc(100vw - 36px));
        white-space: normal;
      }

      #${PRIORITIZE_DUE_ORDERS_ID}:hover {
        background: #ebe1ff;
      }

      #${BULK_ACTIONS_SHORTCUT_ID} {
        bottom: 180px;
        border-color: #0b72e7;
        background: #edf5ff;
        color: #0759b8;
        max-width: min(330px, calc(100vw - 36px));
        white-space: normal;
      }

      #${BULK_ACTIONS_SHORTCUT_ID}:hover {
        background: #dcebff;
      }

      #${CLEAR_SELECTED_SHORTCUT_ID} {
        bottom: 234px;
        border-color: #9f1f14;
        background: #fff0ed;
        color: #9f1f14;
        max-width: min(330px, calc(100vw - 36px));
        white-space: normal;
      }

      #${CLEAR_SELECTED_SHORTCUT_ID}:hover {
        background: #ffe1dc;
      }

      #${CLEAR_SELECTED_SHORTCUT_ID}:disabled {
        cursor: wait;
        opacity: .72;
      }

      #${URGENT_COVERAGE_WARNING_ID} {
        position: fixed;
        right: 18px;
        bottom: 288px;
        z-index: 2147483647;
        max-width: min(520px, calc(100vw - 36px));
        max-height: min(68vh, 720px);
        overflow: auto;
        border: 2px solid #b42318;
        border-radius: 18px;
        background: #fff0ed;
        color: #7a130c;
        box-shadow: 0 14px 34px rgba(0, 0, 0, .24);
        font: 900 13px/1.35 Arial, sans-serif;
        padding: 12px 14px;
      }

      .og-ebay-coverage-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 8px;
      }

      .og-ebay-coverage-details-toggle {
        appearance: none;
        border: 1px solid #b42318;
        border-radius: 999px;
        background: #fff;
        color: #7a130c;
        cursor: pointer;
        font: 900 12px/1 Arial, sans-serif;
        padding: 7px 10px;
      }

      .og-ebay-coverage-details-toggle:hover {
        background: #ffe1dc;
      }

      .og-ebay-hidden-coverage-details {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }

      .og-ebay-hidden-coverage-details[hidden] {
        display: none !important;
      }

      .og-ebay-hidden-coverage-details article {
        display: grid;
        gap: 4px;
        padding: 9px 10px;
        border: 1px solid rgba(180, 35, 24, .28);
        border-radius: 12px;
        background: rgba(255, 255, 255, .76);
      }

      .og-ebay-hidden-coverage-details strong,
      .og-ebay-hidden-coverage-details span,
      .og-ebay-hidden-coverage-details li,
      .og-ebay-hidden-empty {
        overflow-wrap: anywhere;
      }

      .og-ebay-hidden-coverage-details span {
        color: #9f1f14;
        font: 800 12px/1.3 Arial, sans-serif;
      }

      .og-ebay-hidden-coverage-details ul {
        display: grid;
        gap: 3px;
        margin: 2px 0 0;
        padding-left: 18px;
      }

      .og-ebay-hidden-coverage-details li {
        color: #57100b;
        font: 800 12px/1.35 Arial, sans-serif;
      }

      .og-ebay-hidden-empty {
        margin: 0;
        color: #9f1f14;
        font: 800 12px/1.35 Arial, sans-serif;
      }

      .og-ebay-actions-highlight {
        outline: 4px solid rgba(11, 114, 231, .45) !important;
        outline-offset: 6px !important;
        border-radius: 18px !important;
      }

      #${PRIORITIZE_DUE_ORDERS_ID}[data-status-tone="error"] {
        border-color: #b42318;
        background: #fff0ed;
        color: #9f1f14;
      }

      #${PRIORITIZE_DUE_ORDERS_ID}[data-status-tone="success"] {
        border-color: #116b36;
        background: #d8f8e2;
        color: #0a5b2b;
      }

      .og-ebay-buyer-group-row {
        position: relative;
        transition: background-color 160ms ease, box-shadow 160ms ease;
      }

      .og-ebay-closed-in-og {
        display: none !important;
      }

      .og-ebay-buyer-group-a {
        background: rgba(255, 248, 230, .88) !important;
      }

      .og-ebay-buyer-group-a > td,
      .og-ebay-buyer-group-a > th {
        background: rgba(255, 248, 230, .88) !important;
      }

      .og-ebay-buyer-group-b {
        background: rgba(238, 247, 255, .88) !important;
      }

      .og-ebay-buyer-group-b > td,
      .og-ebay-buyer-group-b > th {
        background: rgba(238, 247, 255, .88) !important;
      }

      .og-ebay-buyer-group-first {
        border-top: 3px solid #111827 !important;
      }

      .og-ebay-buyer-group-first > td,
      .og-ebay-buyer-group-first > th {
        border-top: 3px solid #111827 !important;
      }

      .og-ebay-buyer-group-row td:first-child {
        border-left: 6px solid #9b6418 !important;
      }

      .og-ebay-buyer-group-row.is-og-overdue {
        background: rgba(255, 238, 238, .94) !important;
      }

      .og-ebay-buyer-group-row.is-og-overdue > td,
      .og-ebay-buyer-group-row.is-og-overdue > th {
        background: rgba(255, 238, 238, .94) !important;
      }

      .og-ebay-buyer-group-row.is-og-overdue td:first-child {
        border-left-color: #c1121f !important;
      }

      .og-ebay-buyer-group-row.is-og-today td:first-child {
        border-left-color: #d97706 !important;
      }

      .og-ebay-buyer-group-row.is-og-partial-buyer {
        background: rgba(255, 241, 242, .98) !important;
        box-shadow: inset 0 0 0 3px rgba(190, 18, 60, .2) !important;
      }

      .og-ebay-buyer-group-row.is-og-partial-buyer > td,
      .og-ebay-buyer-group-row.is-og-partial-buyer > th {
        background: rgba(255, 241, 242, .98) !important;
      }

      .og-ebay-buyer-group-row.is-og-partial-buyer td:first-child {
        border-left-color: #be123c !important;
      }

      .og-ebay-priority-badge,
      .og-ebay-buyer-badge {
        display: inline-flex;
        align-items: center;
        margin: 2px 6px 4px 0;
        padding: 4px 8px;
        border-radius: 999px;
        font: 800 11px/1.2 Arial, sans-serif;
        letter-spacing: .02em;
        white-space: nowrap;
      }

      .og-ebay-priority-badge {
        background: #111827;
        color: #fff;
      }

      .is-og-overdue .og-ebay-priority-badge {
        background: #c1121f;
      }

      .is-og-today .og-ebay-priority-badge {
        background: #d97706;
      }

      .is-og-partial-buyer .og-ebay-priority-badge,
      .is-og-partial-buyer .og-ebay-buyer-badge {
        border: 2px solid #be123c;
        background: #be123c;
        color: #fff;
        box-shadow: 0 2px 8px rgba(190, 18, 60, .2);
      }

      .og-ebay-buyer-badge {
        border: 1px solid #fed7aa;
        background: #fff7ed;
        color: #7c2d12;
      }

      .og-ebay-select-buyer-group {
        appearance: none;
        border: 1px solid currentColor;
        border-radius: 999px;
        background: rgba(255, 255, 255, .92);
        color: inherit;
        cursor: pointer;
        font: 900 11px/1 Arial, sans-serif;
        margin-left: 8px;
        padding: 4px 7px;
      }

      .og-ebay-select-buyer-group:hover {
        background: #fff;
        box-shadow: 0 1px 4px rgba(17, 24, 39, .22);
      }

      .og-ebay-select-buyer-group:disabled {
        cursor: not-allowed;
        opacity: .72;
      }

      .og-ebay-select-buyer-group[aria-pressed="true"] {
        background: #111827;
        border-color: #111827;
        color: #fff;
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

      #${SEND_BULK_LABELS_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 42px;
        margin-top: 10px;
        border: 1px solid #116b36;
        border-radius: 999px;
        background: #e8fff0;
        color: #0a5b2b;
        cursor: pointer;
        font: 800 14px Arial, sans-serif;
        padding: 10px 14px;
        text-align: center;
      }

      #${SEND_BULK_LABELS_ID}:hover {
        background: #d4f8df;
      }

      .${SEND_RETURN_BUTTON_CLASS} {
        margin-left: 8px;
        border: 1px solid #116b36;
        border-radius: 999px;
        background: #e8fff0;
        color: #0a5b2b;
        cursor: pointer;
        font: 800 12px Arial, sans-serif;
        padding: 7px 10px;
      }

      .${SEND_RETURN_BUTTON_CLASS}:hover {
        background: #d4f8df;
      }

      #${SEND_RETURN_PANEL_ID} {
        position: fixed;
        right: 16px;
        bottom: 154px;
        z-index: 2147483646;
        width: min(360px, calc(100vw - 32px));
        border: 1px solid rgba(17, 107, 54, .32);
        border-radius: 16px;
        background: #f6fff9;
        box-shadow: 0 18px 45px rgba(0, 0, 0, .22);
        color: #0f2a1b;
        font-family: Arial, sans-serif;
        padding: 12px;
      }

      #${SEND_RETURN_PANEL_ID} strong {
        display: block;
        margin-bottom: 8px;
        font: 900 14px Arial, sans-serif;
      }

      #${SEND_RETURN_PANEL_ID} article {
        display: grid;
        gap: 5px;
        border-top: 1px solid rgba(17, 107, 54, .18);
        padding: 9px 0;
      }

      #${SEND_RETURN_PANEL_ID} article:first-of-type {
        border-top: 0;
        padding-top: 0;
      }

      #${SEND_RETURN_PANEL_ID} span {
        color: #254c33;
        font: 700 12px/1.35 Arial, sans-serif;
      }

      #${SEND_LABEL_ID}[data-status-tone="error"],
      #${SEND_BULK_LABELS_ID}[data-status-tone="error"],
      #${SEND_AWAITING_REPORT_ID}[data-status-tone="error"],
      .${SEND_RETURN_BUTTON_CLASS}[data-status-tone="error"] {
        border-color: #b42318;
        background: #fff0ed;
        color: #9f1f14;
      }

      #${SEND_LABEL_ID}[data-status-tone="success"],
      #${SEND_BULK_LABELS_ID}[data-status-tone="success"],
      #${SEND_AWAITING_REPORT_ID}[data-status-tone="success"],
      .${SEND_RETURN_BUTTON_CLASS}[data-status-tone="success"] {
        border-color: #116b36;
        background: #d8f8e2;
        color: #0a5b2b;
      }

      #${BOX_REMINDER_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        padding: 18px;
        background: rgba(0, 0, 0, .46);
        font-family: Arial, sans-serif;
      }

      #${BOX_REMINDER_ID} .og-ebay-box-card {
        width: min(430px, calc(100vw - 36px));
        border: 1px solid rgba(155, 100, 24, .42);
        border-radius: 18px;
        background: #fffaf0;
        color: #17120b;
        box-shadow: 0 24px 70px rgba(0, 0, 0, .34);
        padding: 22px;
      }

      #${BOX_REMINDER_ID} h2 {
        margin: 0 0 8px;
        font: 900 20px Arial, sans-serif;
      }

      #${BOX_REMINDER_ID} p {
        margin: 0 0 16px;
        color: #513d20;
        font: 500 14px/1.45 Arial, sans-serif;
      }

      #${BOX_REMINDER_ID} .og-ebay-box-callout {
        margin-bottom: 16px;
        border: 1px solid rgba(155, 100, 24, .28);
        border-radius: 14px;
        background: #fff;
        padding: 12px;
        font: 900 18px Arial, sans-serif;
        text-align: center;
      }

      #${BOX_REMINDER_ID} .og-ebay-box-actions {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
        flex-wrap: wrap;
      }

      #${BOX_REMINDER_ID} button {
        border: 1px solid rgba(23, 18, 11, .18);
        border-radius: 999px;
        cursor: pointer;
        font: 900 13px Arial, sans-serif;
        padding: 10px 14px;
      }

      #${BOX_REMINDER_ID} .og-ebay-box-primary {
        border-color: #116b36;
        background: #e8fff0;
        color: #0a5b2b;
      }

      #${BOX_REMINDER_ID} .og-ebay-box-secondary {
        background: #fff;
        color: #513d20;
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

    if (isAwaitingShipmentOrdersPage() || !orderNumbers.length) {
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

  function injectBulkLabelSendButton() {
    const downloadLink = getBulkLabelDownloadLink();
    let button = document.getElementById(SEND_BULK_LABELS_ID);

    if (!isBulkLabelConfirmationPage() || !downloadLink) {
      button?.remove();
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = SEND_BULK_LABELS_ID;
      button.textContent = "Send Bulk Labels to OG";
      button.title = "Send this eBay bulk label PDF to the current OG Pending Orders session";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        sendBulkLabelToOg();
      });
    }

    const container = downloadLink.parentElement || document.querySelector(".labels-confirmation-page") || document.body;
    if (!container.contains(button)) {
      downloadLink.insertAdjacentElement("afterend", button);
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

  function createReturnSendButton(returnInfo) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = SEND_RETURN_BUTTON_CLASS;
    button.dataset.ogReturnId = returnInfo.returnId;
    button.textContent = "Open Return in OG";
    button.title = `Open eBay return ${returnInfo.returnId} in OG Order History`;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendReturnToOg(returnInfo, button);
    });
    return button;
  }

  function injectReturnPageButtons() {
    const returns = getEbayReturnEntries();
    let panel = document.getElementById(SEND_RETURN_PANEL_ID);
    document.querySelectorAll(`.${SEND_RETURN_BUTTON_CLASS}[data-og-return-row-button="true"]`).forEach((button) => {
      const returnId = button.dataset.ogReturnId || "";
      if (!returns.some((entry) => entry.returnId === returnId)) button.remove();
    });

    if (!returns.length) {
      panel?.remove();
      return;
    }

    returns.forEach((returnInfo) => {
      const anchor = findReturnAnchor(returnInfo);
      const parent = anchor?.parentElement;
      if (!parent || parent.querySelector(`.${SEND_RETURN_BUTTON_CLASS}[data-og-return-id="${returnInfo.returnId}"]`)) return;
      const button = createReturnSendButton(returnInfo);
      button.dataset.ogReturnRowButton = "true";
      anchor.insertAdjacentElement("afterend", button);
    });

    if (!panel) {
      panel = document.createElement("aside");
      panel.id = SEND_RETURN_PANEL_ID;
      document.body.appendChild(panel);
    }

    panel.innerHTML = `
      <strong>OG Returns (${returns.length})</strong>
      ${returns.slice(0, 6).map((entry) => `
        <article data-og-return-panel-row="${entry.returnId}">
          <span>${escapeHtml(entry.buyerUsername || "Unknown buyer")} - ${escapeHtml(entry.itemNumber || "No item #")}</span>
          <span>${escapeHtml(entry.itemTitle || entry.returnStatus || "eBay return")}</span>
        </article>
      `).join("")}
      ${returns.length > 6 ? `<span>${returns.length - 6} more return${returns.length - 6 === 1 ? "" : "s"} on this page.</span>` : ""}
    `;

    returns.slice(0, 6).forEach((returnInfo) => {
      const row = panel.querySelector(`[data-og-return-panel-row="${returnInfo.returnId}"]`);
      if (!row || row.querySelector(`.${SEND_RETURN_BUTTON_CLASS}`)) return;
      row.appendChild(createReturnSendButton(returnInfo));
    });
  }

  function injectPrioritizeDueOrdersButton() {
    let button = document.getElementById(PRIORITIZE_DUE_ORDERS_ID);

    if (!isAwaitingShipmentOrdersPage()) {
      button?.remove();
      clearOgPriorityBadges();
      renderUrgentCoverageWarning(null);
      return;
    }

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.id = PRIORITIZE_DUE_ORDERS_ID;
      button.textContent = "Prioritize OG Due Orders";
      button.title = "Move visible eBay rows for OG overdue or due-today buyers to the top of this eBay page";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        prioritizeEbayRowsFromOg();
      });
      document.body.appendChild(button);
    }

    maybeAutoPrioritizeEbayRows();
    schedulePriorityReapply();
  }

  function dismissBoxReminder() {
    dismissedBoxReminderKey = currentBoxReminderKey;
    document.getElementById(BOX_REMINDER_ID)?.remove();
  }

  function showBoxReminder(itemCount) {
    if (document.getElementById(BOX_REMINDER_ID)) return;

    const overlay = document.createElement("div");
    overlay.id = BOX_REMINDER_ID;
    overlay.innerHTML = `
      <div class="og-ebay-box-card" role="dialog" aria-modal="true" aria-labelledby="og-ebay-box-title">
        <h2 id="og-ebay-box-title">Check the shipping box size</h2>
        <p>
          OG detected ${itemCount.toLocaleString()} item${itemCount === 1 ? "" : "s"} on this eBay label workflow.
          Before buying the label, please change the package dimensions so eBay does not keep the default small box.
        </p>
        <div class="og-ebay-box-callout">Example: 4 x 4 x 4 in</div>
        <div class="og-ebay-box-actions">
          ${hasPackageDimensionInputs() ? `<button type="button" class="og-ebay-box-primary" data-og-ebay-set-box>Set 4 x 4 x 4</button>` : ""}
          <button type="button" class="og-ebay-box-secondary" data-og-ebay-close-box>Got it</button>
        </div>
      </div>
    `;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target.closest("[data-og-ebay-close-box]")) {
        dismissBoxReminder();
        return;
      }
      if (event.target.closest("[data-og-ebay-set-box]")) {
        setPackageDimensionsToFour();
        dismissBoxReminder();
      }
    });
    document.body.appendChild(overlay);
  }

  function maybeShowBoxReminder() {
    if (!isShippingLabelWorkflowPage()) {
      dismissBoxReminder();
      return;
    }

    if (!hasPackageDimensionInputs()) {
      dismissBoxReminder();
      return;
    }

    const itemCount = detectShippingItemCount();
    if (itemCount < 3) return;

    const reminderKey = `og-ebay-box-reminder:${window.location.pathname}:${window.location.search}:${itemCount}`;
    currentBoxReminderKey = reminderKey;
    if (dismissedBoxReminderKey === reminderKey || shownBoxReminderKey === reminderKey) return;
    shownBoxReminderKey = reminderKey;
    showBoxReminder(itemCount);
  }

  function injectOgControls() {
    ensureStyles();
    attachBuyerGroupSelectionHandlers();
    syncLocallyClosedAwaitingRows();
    injectRowButtons();
    injectFloatingButton();
    injectSingleOrderButton();
    injectSendLabelButton();
    injectBulkLabelSendButton();
    injectAwaitingReportButton();
    injectReturnPageButtons();
    injectPrioritizeDueOrdersButton();
    updateBulkActionsShortcut();
    maybeShowBoxReminder();
  }

  let scheduled = false;
  function scheduleInject() {
    if (ogBuyerSelectionInProgress) return;
    if (scheduled) return;
    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      injectOgControls();
    }, 250);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "OG_EBAY_REORGANIZE_AWAITING_QUEUE") return false;

    (async () => {
      if (!isAwaitingShipmentOrdersPage()) {
        sendResponse({ ok: false, error: "This is not the eBay awaiting-shipment orders page." });
        return;
      }

      injectOgControls();
      updatePriorityButtonStatus(message.payload?.priorityPayload?.ok ? "Sorting with OG priorities..." : "Refreshing OG priorities...");
      await new Promise((resolve) => window.setTimeout(resolve, message.payload?.fastRefresh ? 40 : 160));
      const priorityPayload = await getOrganizerPriorityPayload(message.payload || {});
      const hidden = hideClosedAwaitingRowsFromOg(message.payload || {}, priorityPayload);
      const result = applyOgPendingPriorities(priorityPayload);
      updatePriorityButtonStatusFromResult(result, priorityPayload);
      if (hidden.hiddenRows && result?.ok) {
        updatePriorityButtonStatus(
          `Hid ${hidden.hiddenRows} completed order${hidden.hiddenRows === 1 ? "" : "s"}; sorted ${Number(result.visibleRows || 0).toLocaleString()} visible row${Number(result.visibleRows || 0) === 1 ? "" : "s"}`,
          "success"
        );
      } else if (hidden.stillPendingOrderNumbers?.length && result?.ok) {
        updatePriorityButtonStatus(
          `Order still has OG pending work; sorted ${Number(result.visibleRows || 0).toLocaleString()} visible row${Number(result.visibleRows || 0) === 1 ? "" : "s"}`,
          "success"
        );
      }
      updateBulkActionsShortcut();
      await focusEbayBulkActionsWhenReady({ onlyIfSelected: true });
      sendResponse({ ok: Boolean(result?.ok), result, hidden });
    })().catch((error) => {
      console.warn("[OG eBay Priority] Refresh after queue change failed:", error);
      updatePriorityButtonStatus("Refresh needs OG Pending Orders", "error");
      sendResponse({ ok: false, error: error.message || String(error) });
    });

    return true;
  });

  injectOgControls();
  new MutationObserver(scheduleInject).observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
