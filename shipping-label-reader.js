/* Read label text and barcodes locally. Uploaded PDFs never go to an OCR service. */
(function () {
  "use strict";
  const base = new URL(".", document.currentScript.src);
  const scripts = new Map();
  function script(path, ready) {
    if (ready()) return Promise.resolve();
    if (!scripts.has(path)) scripts.set(path, new Promise((resolve, reject) => {
      const element = document.createElement("script");
      const timeout = setTimeout(() => {element.remove(); scripts.delete(path); reject(Error("PDF reading tools took too long to load. Try again."));}, 20000);
      element.src = new URL(path, base).href;
      element.onload = () => {clearTimeout(timeout); resolve();};
      element.onerror = () => {clearTimeout(timeout); scripts.delete(path); reject(Error("Could not load PDF reading tools. Refresh and try again."));};
      document.head.append(element);
    }));
    return scripts.get(path);
  }
  function clean(value) {
    return String(value || "").trim().replace(/^\][A-Za-z0-9]{2}/, "").replace(/[\s\u001d]+/g, "").toUpperCase();
  }
  function trackingFromBarcode(value) {
    const code = clean(value);
    const routed = /^420(?:\d{5}|\d{9})(9\d{19,21})$/.exec(code);
    if (routed) return routed[1];
    return /^(?:1Z[A-Z0-9]{16}|[A-Z]{2}\d{9}[A-Z]{2}|\d{12}|\d{15}|\d{20,30})$/.test(code) ? code : "";
  }
  function trackingFromText(value) {
    const text = String(value || "").toUpperCase();
    const found = [
      ...(text.match(/\b1Z(?:[ -]?[A-Z0-9]){16}\b/g) || []),
      ...(text.match(/\b[A-Z]{2}\s?\d{9}\s?[A-Z]{2}\b/g) || []),
      ...(text.match(/\b9(?:[ -]?\d){19,21}\b/g) || []),
      ...[...text.matchAll(/(?:TRACKING(?:\s+(?:NUMBER|NO\.?))?|TRK(?:#|\s*#)?)[\s:#-]{0,12}((?:\d[ -]?){12,30})(?!\d)/g)].map(m => m[1]),
    ];
    return [...new Set(found.map(trackingFromBarcode).filter(Boolean))];
  }
  async function read(file, {onProgress = () => {}, signal} = {}) {
    if (!file?.size || file.size > 10 * 1024 * 1024) throw Error("Choose a PDF smaller than 10 MB.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const decoder = new TextDecoder("latin1");
    if (!decoder.decode(bytes.subarray(0, 1024)).includes("%PDF-") ||
        !decoder.decode(bytes.subarray(Math.max(0, bytes.length - 4096))).includes("%%EOF")) {
      throw Error("This file is not a complete PDF. Download the original shipping-label document and try again.");
    }
    await script("pdf.min.js", () => Boolean(window.pdfjsLib?.getDocument));
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.js", base).href;
    let barcodeReader = null;
    try {
      await script("vendor/zxing-wasm-reader-3.1.4.js", () => Boolean(window.ZXingWASM));
      await window.ZXingWASM.prepareZXingModule({overrides: {
        locateFile: () => new URL("vendor/zxing-reader-3.1.4.wasm", base).href,
      }, fireImmediately: true});
      barcodeReader = window.ZXingWASM;
    } catch (_) { /* Text reading and manual entry remain available. */ }
    const task = window.pdfjsLib.getDocument({data: bytes, isEvalSupported: false});
    // Password-protected PDFs need an unencrypted copy, not an indefinitely pending prompt.
    let rejectPassword;
    const passwordFailure = new Promise((_, reject) => {rejectPassword = reject;});
    task.onPassword = () => {rejectPassword(Error("This PDF is password protected. Upload an unencrypted copy of the label."));};
    let pdf;
    try {
      pdf = await Promise.race([task.promise, passwordFailure]);
      if (!pdf.numPages || pdf.numPages > 100) throw Error("Choose a PDF with 1–100 pages.");
      const tracking = new Set(), barcodes = new Set();
      const pageResults = [];
      let previewUrl = "", allThermal = true;
      for (let number = 1; number <= pdf.numPages; number++) {
        if (signal?.aborted) throw new DOMException("Reading cancelled", "AbortError");
        onProgress(`Reading page ${number} of ${pdf.numPages}…`);
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        const text = content.items.map(item => item.str || "").join(" ");
        const pageTracking = new Set(trackingFromText(text));
        const pageCodes = new Set();
        const original = page.getViewport({scale: 1});
        const sides = [original.width, original.height].sort((a,b) => a-b);
        allThermal &&= Math.abs(sides[0] - 288) <= 8 && Math.abs(sides[1] - 432) <= 8;
        const canvas = document.createElement("canvas");
        try {
          const viewport = page.getViewport({scale: Math.min(3, 1900 / Math.max(original.width, original.height))});
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d", {willReadFrequently: true});
          await page.render({canvasContext: context, viewport}).promise;
          if (!previewUrl) {
            const thumb = document.createElement("canvas");
            thumb.width = 350; thumb.height = Math.round(canvas.height * 350 / canvas.width);
            thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height);
            previewUrl = thumb.toDataURL("image/jpeg", .8);
          }
          if (barcodeReader) {
            const decoded = await barcodeReader.readBarcodes(context.getImageData(0, 0, canvas.width, canvas.height), {
              formats: ["Code128", "Code39", "ITF", "QRCode", "DataMatrix", "PDF417", "Aztec"],
              tryHarder: true, tryRotate: true, tryInvert: true, maxNumberOfSymbols: 12, textMode: "Plain",
            }).catch(() => []); // Manual entry remains available if barcode decoding fails.
            for (const result of decoded.filter(r => r.isValid && !r.error)) {
              const raw = clean(result.text);
              if (/^[A-Z0-9]{10,80}$/.test(raw)) pageCodes.add(raw);
              const candidate = trackingFromBarcode(raw);
              if (candidate) pageTracking.add(candidate);
            }
          }
        } finally {canvas.width = canvas.height = 0; page.cleanup();}
        pageTracking.forEach(code => tracking.add(code));
        pageCodes.forEach(code => barcodes.add(code));
        pageResults.push({page: number, trackingNumbers: [...pageTracking], barcodeValues: [...pageCodes]});
      }
      return {trackingNumbers: [...tracking], barcodeValues: [...barcodes], pageCount: pdf.numPages,
        pages: pageResults, previewUrl, allThermal};
    } catch (error) {
      if (/password|passwordexception|worker was destroyed/i.test(error?.message || "")) {
        throw Error("This PDF is password protected. Upload an unencrypted copy of the label.");
      }
      throw error;
    } finally {await task.destroy();}
  }
  window.shippingLabelReader = {read, clean, trackingFromText, trackingFromBarcode};
})();
