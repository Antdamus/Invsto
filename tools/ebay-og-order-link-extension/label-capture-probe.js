(function () {
  "use strict";

  const LABEL_EVENT_TYPE = "OG_EBAY_LABEL_CAPTURED";
  const READY_EVENT_TYPE = "OG_EBAY_LABEL_PROBE_READY";

  function postReady() {
    window.postMessage({
      type: READY_EVENT_TYPE,
      capturedAt: new Date().toISOString(),
    }, "*");
  }

  if (window.__ogEbayLabelCaptureProbeInstalled) {
    postReady();
    return;
  }
  window.__ogEbayLabelCaptureProbeInstalled = true;

  function isLikelyPdfResponse(response, url = "") {
    const type = response?.headers?.get?.("content-type") || "";
    return /pdf/i.test(type) || /label|download|shipping/i.test(String(url || response?.url || ""));
  }

  function postPdf(source, url, blob) {
    if (!blob) return;
    const looksLikePdf = /pdf/i.test(blob.type || "") || /\.pdf(?:$|[?#])/i.test(String(url || ""));
    if (!looksLikePdf) return;

    const reader = new FileReader();
    reader.onload = () => {
      window.postMessage({
        type: LABEL_EVENT_TYPE,
        payload: {
          source,
          url: url || "",
          mimeType: blob.type || "application/pdf",
          size: blob.size || 0,
          base64: String(reader.result || "").split(",")[1] || "",
          capturedAt: new Date().toISOString(),
        },
      }, "*");
    };
    reader.readAsDataURL(blob);
  }

  const originalFetch = window.fetch;
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (isLikelyPdfResponse(response, requestUrl)) {
        response.clone().blob().then((blob) => postPdf("fetch", response.url || requestUrl, blob)).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ogEbayLabelUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const contentType = this.getResponseHeader("content-type") || "";
        if (!/pdf/i.test(contentType) && !/label|download|shipping/i.test(String(this.__ogEbayLabelUrl || ""))) return;
        if (this.response instanceof Blob) {
          postPdf("xhr", this.responseURL || this.__ogEbayLabelUrl, this.response);
        } else if (this.response instanceof ArrayBuffer) {
          postPdf("xhr", this.responseURL || this.__ogEbayLabelUrl, new Blob([this.response], { type: contentType || "application/pdf" }));
        }
      } catch (_) {}
    });
    return originalSend.apply(this, args);
  };

  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (value) {
    const objectUrl = originalCreateObjectURL.call(URL, value);
    try {
      if (value instanceof Blob) postPdf("object-url", objectUrl, value);
    } catch (_) {}
    return objectUrl;
  };

  document.addEventListener("click", (event) => {
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor) return;
    const href = anchor.href || "";
    if (/\.pdf(?:$|[?#])|label|download|shipping/i.test(href)) {
      window.postMessage({
        type: LABEL_EVENT_TYPE,
        payload: {
          source: "anchor",
          url: href,
          mimeType: "",
          size: 0,
          base64: "",
          capturedAt: new Date().toISOString(),
        },
      }, "*");
    }
  }, true);

  postReady();
})();
