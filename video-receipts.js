// Shared receipt navigation for pending orders, order history, and returns.
(() => {
  const resolvedLinks = new Map();
  let activeDialog = null;

  function normalizeUrl(value, receipt = {}) {
    let url;
    try { url = new URL(String(value || "").trim().replace(/&amp;/g, "&")); }
    catch (_) { return ""; }
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !/(^|\.)ebay\.com$/i.test(url.hostname)
      || !/^\/ebaylive\/events\/[^/]+(?:\/stream)?\/?$/i.test(url.pathname)) return "";
    const item = String(receipt.itemNumber || receipt.item_number || "").trim();
    if (!item) return "";
    if (url.searchParams.get("selectedItemId") !== item) {
      const items = (url.searchParams.get("itemIds") || "").split(",").map(id => id.trim());
      if (!items.includes(item)) return "";
      url.searchParams.set("selectedItemId", item);
    }
    url.searchParams.set("playback", "true");
    return url.toString();
  }

  function metadataUrls(metadata = {}) {
    if (!metadata || typeof metadata !== "object") return [];
    return [metadata, metadata.returnDetails || {}].flatMap(value => [
      value.videoReceiptUrl, value.videoReceiptURL,
      ...(Array.isArray(value.videoReceiptUrls) ? value.videoReceiptUrls : []),
    ]).filter(Boolean);
  }

  function cacheKey(receipt) {
    return JSON.stringify([receipt.orderId || receipt.orderNumber, receipt.itemNumber, receipt.transactionId]);
  }

  function orderUrl(receipt) {
    if (!receipt.orderNumber) return "";
    const url = new URL("https://www.ebay.com/mesh/ord/details");
    url.searchParams.set("orderid", receipt.orderNumber);
    return url.toString();
  }

  function navigate(url, event) {
    // Preserve the browser's normal link navigation (and modifier clicks) on phones.
    const trigger = event?.currentTarget;
    if (trigger?.tagName === "A" && !event.defaultPrevented) {
      trigger.href = url;
      trigger.target = "_blank";
      trigger.rel = "noopener noreferrer";
      return;
    }
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    document.body.append(link);
    link.click();
    link.remove();
  }

  function requestExtension(receipt, signal) {
    const requestId = crypto.randomUUID();
    return new Promise(resolve => {
      let finished = false;
      const finish = result => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onMessage = event => {
        if (event.source !== window || event.origin !== window.location.origin
          || event.data?.type !== "OG_EBAY_VIDEO_RECEIPT_OPEN_RESPONSE"
          || event.data.requestId !== requestId) return;
        finish(event.data.payload);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish({ok: false,
        error: "The desktop extension did not respond. You can still use Open eBay order above."}), 20000);
      window.addEventListener("message", onMessage);
      signal.addEventListener("abort", onAbort, {once: true});
      window.postMessage({type: "OG_EBAY_VIDEO_RECEIPT_OPEN_REQUEST", requestId, payload: {
        orderNumber: receipt.orderNumber,
        orderDetailsUrl: orderUrl(receipt),
        itemNumber: receipt.itemNumber,
        transactionId: receipt.transactionId,
        itemTitle: receipt.itemTitle,
        itemUrl: receipt.itemNumber ? `https://www.ebay.com/itm/${encodeURIComponent(receipt.itemNumber)}` : "",
      }}, window.location.origin);
    });
  }

  function open(event, receipt = {}) {
    event?.stopPropagation?.();
    const direct = normalizeUrl(receipt.url, receipt) || resolvedLinks.get(cacheKey(receipt));
    if (direct) {
      navigate(direct, event);
      return {ok: true, direct: true};
    }
    event?.preventDefault?.();
    activeDialog?.close();
    const trigger = event?.currentTarget || document.activeElement;
    const controller = new AbortController();
    const lookupController = new AbortController();
    const dialog = document.createElement("dialog");
    dialog.className = "video-receipt-dialog";
    dialog.setAttribute("aria-labelledby", "video-receipt-heading");
    dialog.innerHTML = `
      <button type="button" class="video-receipt-close" aria-label="Close video receipt">&#215;</button>
      <h2 id="video-receipt-heading">Video receipt</h2>
      <p class="video-receipt-context"></p>
      <p class="video-receipt-lookup" role="status">Checking for a saved receipt link…</p>
      <a class="video-receipt-direct" target="_blank" rel="noopener noreferrer" hidden>Open video receipt</a>
      <a class="video-receipt-order" target="_blank" rel="noopener noreferrer">Open eBay order</a>
      <p class="video-receipt-help">On eBay, sign in to the seller account, then tap the item's image with the Live icon to open its video receipt. No extension is needed for this route.</p>
      <details class="video-receipt-desktop">
        <summary>Using the desktop extension?</summary>
        <p>If the OG eBay extension is installed on this browser, it can find and open the receipt.</p>
        <button type="button" class="video-receipt-find">Find with desktop extension</button>
        <p class="video-receipt-extension-status" role="status"></p>
      </details>`;
    const find = selector => dialog.querySelector(selector);
    const lookupStatus = find(".video-receipt-lookup");
    const directLink = find(".video-receipt-direct");
    const orderLink = find(".video-receipt-order");
    const extensionButton = find(".video-receipt-find");
    find(".video-receipt-context").textContent = [receipt.orderNumber ? `Order ${receipt.orderNumber}` : "", receipt.itemTitle].filter(Boolean).join(" · ");
    const ebayOrderUrl = orderUrl(receipt);
    if (ebayOrderUrl) orderLink.href = ebayOrderUrl;
    else {
      orderLink.hidden = true;
      find(".video-receipt-help").textContent = "This item has no eBay order number. Find its order in eBay Seller Hub to view the video receipt.";
      find(".video-receipt-desktop").hidden = true;
    }
    const showReceipt = url => {
      if (controller.signal.aborted) return;
      resolvedLinks.set(cacheKey(receipt), url);
      directLink.href = url;
      directLink.hidden = false;
      lookupStatus.textContent = "A saved receipt link is available for this item.";
    };
    const onKey = e => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    const close = () => {
      controller.abort();
      lookupController.abort();
      document.removeEventListener("keydown", onKey, true);
      dialog.close();
      dialog.remove();
      if (activeDialog?.element === dialog) activeDialog = null;
      if (trigger?.isConnected) trigger.focus();
    };
    activeDialog = {element: dialog, close};
    find(".video-receipt-close").addEventListener("click", close);
    dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
    document.addEventListener("keydown", onKey, true);
    document.body.append(dialog);
    dialog.showModal();

    // The queue deliberately omits large metadata. Read only this order on demand;
    // the eBay fallback stays usable even if this lookup is slow or unavailable.
    (async () => {
      const timer = setTimeout(() => lookupController.abort(), 8000);
      try {
        if (!receipt.orderId || !window.supabase?.from) {
          lookupStatus.textContent = "No saved receipt link is available here. Open the order on eBay to view it.";
          return;
        }
        const {data, error} = await window.supabase.from("ebay_orders")
          .select("label_metadata").eq("id", receipt.orderId)
          .abortSignal(lookupController.signal).maybeSingle();
        if (controller.signal.aborted) return;
        if (error) throw error;
        const url = metadataUrls(data?.label_metadata).map(value => normalizeUrl(value, receipt)).find(Boolean);
        if (url) showReceipt(url);
        else if (directLink.hidden) lookupStatus.textContent = "No saved receipt link yet. Open the order on eBay to view it.";
      } catch (_) {
        if (!controller.signal.aborted && directLink.hidden) lookupStatus.textContent = "Couldn't check saved links. You can still open the order on eBay below.";
      } finally { clearTimeout(timer); }
    })();

    extensionButton.addEventListener("click", async () => {
      if (extensionButton.disabled) return;
      extensionButton.disabled = true;
      const status = find(".video-receipt-extension-status");
      status.textContent = "Looking for the receipt with the desktop extension… You can also open the eBay order above.";
      try {
        const result = await requestExtension(receipt, controller.signal);
        if (controller.signal.aborted) return;
        const url = result?.ok && normalizeUrl(result.openedUrl, receipt);
        if (url) {
          showReceipt(url);
          lookupStatus.textContent = "Receipt found for this item.";
          status.textContent = "The extension opened the receipt. You can reopen it using the link above.";
        } else {
          status.textContent = result?.error || "The extension couldn't find a matching receipt. Open the eBay order above to check it.";
        }
      } catch (_) {
        if (!controller.signal.aborted) status.textContent = "Couldn't reach the extension. Open the eBay order above to view the receipt.";
      } finally { extensionButton.disabled = false; }
    });
    return {ok: true, dialog: true};
  }

  window.OGVideoReceipts = {open, normalizeUrl};
})();
