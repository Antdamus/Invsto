(function () {
  "use strict";

  const REPORT_EVENT_TYPE = "OG_EBAY_AWAITING_REPORT_CAPTURED";
  const READY_EVENT_TYPE = "OG_EBAY_AWAITING_REPORT_PROBE_READY";

  function postReady() {
    window.postMessage({
      type: READY_EVENT_TYPE,
      capturedAt: new Date().toISOString(),
    }, "*");
  }

  if (window.__ogEbayAwaitingReportCaptureProbeInstalled) {
    postReady();
    return;
  }
  window.__ogEbayAwaitingReportCaptureProbeInstalled = true;

  function isLikelyReportUrl(url = "") {
    return /ordersreport|orders-report|order-report|download|report|sh-orders|csv/i.test(String(url || ""));
  }

  function isLikelyReportBlob(blob, url = "") {
    const type = String(blob?.type || "").toLowerCase();
    return /csv|text|spreadsheet|excel|octet-stream/.test(type) || isLikelyReportUrl(url);
  }

  function isLikelyEbayOrdersReportText(text) {
    return /(^|,|\n)\s*"?Order Number"?\s*(,|\n)/i.test(text)
      && /(^|,|\n)\s*"?Item Title"?\s*(,|\n)/i.test(text);
  }

  function filenameFromUrl(url = "") {
    const clean = String(url || "").split(/[?#]/)[0];
    const raw = clean.split("/").pop() || "eBay-OrdersReport.csv";
    try {
      return decodeURIComponent(raw);
    } catch (_) {
      return raw;
    }
  }

  function postReport(source, url, blob, filename = "") {
    if (!blob || !isLikelyReportBlob(blob, url)) return;
    blob.slice(0, 12000).text().then((sample) => {
      if (!isLikelyEbayOrdersReportText(sample)) return;
      const reader = new FileReader();
      reader.onload = () => {
        window.postMessage({
          type: REPORT_EVENT_TYPE,
          payload: {
            source,
            url: url || "",
            filename: filename || filenameFromUrl(url),
            mimeType: blob.type || "text/csv",
            size: blob.size || 0,
            base64: String(reader.result || "").split(",")[1] || "",
            capturedAt: new Date().toISOString(),
          },
        }, "*");
      };
      reader.readAsDataURL(blob);
    }).catch(() => {});
  }

  function cloneResponseIfReport(response, requestUrl, source) {
    try {
      const url = response?.url || requestUrl || "";
      const contentType = response?.headers?.get?.("content-type") || "";
      if (!isLikelyReportUrl(url) && !/csv|text|spreadsheet|excel|octet-stream/i.test(contentType)) return;
      response.clone().blob().then((blob) => postReport(source, url, blob)).catch(() => {});
    } catch (_) {}
  }

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
    cloneResponseIfReport(response, requestUrl, "fetch");
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ogEbayAwaitingReportUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const url = this.responseURL || this.__ogEbayAwaitingReportUrl || "";
        const contentType = this.getResponseHeader("content-type") || "";
        if (!isLikelyReportUrl(url) && !/csv|text|spreadsheet|excel|octet-stream/i.test(contentType)) return;
        if (this.response instanceof Blob) {
          postReport("xhr", url, this.response);
        } else if (this.response instanceof ArrayBuffer) {
          postReport("xhr", url, new Blob([this.response], { type: contentType || "text/csv" }));
        } else if (typeof this.responseText === "string" && this.responseText.trim()) {
          postReport("xhr", url, new Blob([this.responseText], { type: contentType || "text/csv" }));
        }
      } catch (_) {}
    });
    return originalSend.apply(this, args);
  };

  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (value) {
    const objectUrl = originalCreateObjectURL.call(URL, value);
    try {
      if (value instanceof Blob) postReport("object-url", objectUrl, value);
    } catch (_) {}
    return objectUrl;
  };

  document.addEventListener("click", (event) => {
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor) return;
    const href = anchor.href || "";
    if (!isLikelyReportUrl(href)) return;
    window.postMessage({
      type: REPORT_EVENT_TYPE,
      payload: {
        source: "anchor",
        url: href,
        filename: anchor.download || filenameFromUrl(href),
        mimeType: "",
        size: 0,
        base64: "",
        capturedAt: new Date().toISOString(),
      },
    }, "*");
  }, true);

  postReady();
})();
