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

  async function postPdf(source, url, blob) {
    if (!blob) return;
    const looksLikePdf = /pdf/i.test(blob.type || "") || /\.pdf(?:$|[?#])/i.test(String(url || ""));
    if (!looksLikePdf) return;
    // PDF viewers may fetch byte ranges. Never let the first fragment win the capture race.
    const head=await blob.slice(0,1024).text(),tail=await blob.slice(Math.max(0,blob.size-4096)).text();
    if(!head.includes('%PDF-')||!tail.includes('%%EOF'))return;

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

  const fullPdfRequests = new Set();
  const originalFetch = window.fetch;
  async function captureResponse(response,url,method='GET') {
    if(response.status===206) {
      if(method.toUpperCase()!=='GET'||fullPdfRequests.has(url))return;
      fullPdfRequests.add(url);
      // A fresh GET without the viewer's Range header requests the full saved label.
      response=await originalFetch(url,{credentials:'include',cache:'no-store'});
      if(response.status!==200)return;
    }
    if(response.ok)await postPdf('fetch',response.url||url,await response.clone().blob());
  }
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    try {
      const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (isLikelyPdfResponse(response, requestUrl)) {
        void captureResponse(response,response.url||requestUrl,args[1]?.method||args[0]?.method||'GET').catch(()=>{});
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
        if(this.status===206){void captureResponse({status:206},this.responseURL||this.__ogEbayLabelUrl).catch(()=>{});return;}
        if (this.response instanceof Blob) {
          void postPdf("xhr", this.responseURL || this.__ogEbayLabelUrl, this.response).catch(()=>{});
        } else if (this.response instanceof ArrayBuffer) {
          void postPdf("xhr", this.responseURL || this.__ogEbayLabelUrl, new Blob([this.response], { type: contentType || "application/pdf" })).catch(()=>{});
        }
      } catch (_) {}
    });
    return originalSend.apply(this, args);
  };

  const originalCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (value) {
    const objectUrl = originalCreateObjectURL.call(URL, value);
    try {
      if (value instanceof Blob) void postPdf("object-url", objectUrl, value).catch(()=>{});
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
