(function () {
  const MODAL_ID = "ebay-buyer-insights-modal";

  let activeBuyer = "";
  let activeRequestId = 0;
  let activeSyncMeta = null;
  let deepSyncBusy = false;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function waitForSupabaseReady() {
    return new Promise((resolve) => {
      if (window.supabase) return resolve(window.supabase);
      document.addEventListener("supabase-ready", () => resolve(window.supabase), { once: true });
    });
  }

  function formatMoney(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "$0.00";
    return number.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

  function formatDate(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatDateTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatRate(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "0%";
    return `${Math.round(number * 100)}%`;
  }

  function formatCount(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number.toLocaleString() : "0";
  }

  function getSyncMetaValue(meta, camelName, snakeName = "") {
    if (!meta || typeof meta !== "object") return null;
    return meta[camelName] ?? meta[snakeName || camelName] ?? null;
  }

  function getDeepSyncButtonLabel() {
    return getSyncMetaValue(activeSyncMeta, "lastSuccessAt", "last_success_at")
      ? "Refresh 2-year scan"
      : "Scan 2 years";
  }

  function ensureModal() {
    let modal = document.getElementById(MODAL_ID);
    if (modal) return modal;

    modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.className = "buyer-insights-modal hidden";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "buyer-insights-title");
    modal.innerHTML = `
      <div class="buyer-insights-card">
        <button type="button" class="buyer-insights-close" aria-label="Close buyer insights">x</button>
        <div class="buyer-insights-header">
          <div>
            <span class="eyebrow">Buyer Insight</span>
            <h2 id="buyer-insights-title">Buyer history</h2>
            <p id="buyer-insights-subtitle">Loading synced eBay order history...</p>
          </div>
          <div class="buyer-insights-actions">
            <a id="buyer-insights-history-link" class="buyer-insights-history-link" href="ebay-order-history.html">Open history</a>
            <button id="buyer-insights-deep-sync" class="buyer-insights-deep-sync" type="button">
              Scan 2 years
            </button>
          </div>
        </div>
        <div id="buyer-insights-sync-status" class="buyer-insights-sync-status hidden"></div>
        <div id="buyer-insights-body" class="buyer-insights-body">
          <div class="buyer-insights-empty">Loading...</div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.closest(".buyer-insights-close")) {
        closeModal();
        return;
      }
      if (event.target.closest("#buyer-insights-deep-sync")) {
        event.preventDefault();
        runDeepBuyerSync();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modal.classList.contains("hidden")) {
        closeModal();
      }
    });

    return modal;
  }

  function closeModal() {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    modal.classList.add("hidden");
    activeBuyer = "";
  }

  function getBuyerHistorySyncUrl() {
    const projectRef = String(window.SUPABASE_URL || "")
      .match(/^https:\/\/([^.]+)\.supabase\.co/i)?.[1] || "byhytmarmigalvawkedi";
    return `https://${projectRef}.functions.supabase.co/ebay-buyer-history-sync`;
  }

  function setDeepSyncBusy(busy) {
    deepSyncBusy = busy;
    const button = document.getElementById("buyer-insights-deep-sync");
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? "Scanning eBay..." : getDeepSyncButtonLabel();
  }

  function setDeepSyncStatus(message, tone = "") {
    const status = document.getElementById("buyer-insights-sync-status");
    if (!status) return;
    status.className = `buyer-insights-sync-status${tone ? ` ${tone}` : ""}`;
    status.textContent = message || "";
    status.classList.toggle("hidden", !message);
  }

  function summarizeDeepSyncResult(result) {
    if (!result?.ok) return result?.error || "Could not scan eBay buyer history.";
    const skippedOpen = Number(result.skippedNewOpenOrders || 0);
    const skippedText = skippedOpen
      ? ` ${skippedOpen.toLocaleString()} new open order(s) were left for the pending-order sync.`
      : "";
    return `Scanned ${Number(result.scannedOrders || 0).toLocaleString()} eBay order(s), matched ${Number(result.matchedOrders || 0).toLocaleString()} for this buyer, and saved ${Number(result.ordersUpserted || 0).toLocaleString()} order(s) / ${Number(result.linesUpserted || 0).toLocaleString()} line(s).${skippedText}`;
  }

  function setLoading(buyerUsername) {
    const modal = ensureModal();
    activeSyncMeta = null;
    modal.classList.remove("hidden");
    modal.querySelector("#buyer-insights-title").textContent = buyerUsername || "Buyer history";
    modal.querySelector("#buyer-insights-subtitle").textContent = "Pulling synced eBay orders, returns, and item mix...";
    modal.querySelector("#buyer-insights-history-link").href = `ebay-order-history.html?buyer=${encodeURIComponent(buyerUsername || "")}`;
    setDeepSyncBusy(false);
    setDeepSyncStatus("");
    modal.querySelector("#buyer-insights-body").innerHTML = `
      <div class="buyer-insights-empty">Loading buyer history...</div>
    `;
  }

  function setError(message) {
    const modal = ensureModal();
    modal.querySelector("#buyer-insights-subtitle").textContent = "Could not load this buyer.";
    modal.querySelector("#buyer-insights-body").innerHTML = `
      <div class="buyer-insights-error">${escapeHtml(message || "Unknown error")}</div>
    `;
  }

  function metric(label, value, hint = "") {
    return `
      <div class="buyer-insights-metric">
        <small>${escapeHtml(label)}</small>
        <strong>${escapeHtml(value)}</strong>
        ${hint ? `<span>${escapeHtml(hint)}</span>` : ""}
      </div>
    `;
  }

  function renderKindRows(rows) {
    if (!rows?.length) return `<div class="buyer-insights-empty is-compact">No item mix captured yet.</div>`;
    return rows.map((row) => `
      <div class="buyer-kind-row">
        <strong>${escapeHtml(row.label || "Other")}</strong>
        <span>${escapeHtml(`${row.unitCount || 0} units`)}</span>
        <b>${escapeHtml(formatMoney(row.grossSales))}</b>
      </div>
    `).join("");
  }

  function renderTopItems(rows) {
    if (!rows?.length) return `<div class="buyer-insights-empty is-compact">No item detail captured yet.</div>`;
    return rows.map((row) => `
      <div class="buyer-insights-list-row">
        <div>
          <strong>${escapeHtml(row.title || "Untitled item")}</strong>
          <span>${escapeHtml(row.itemNumber || "No item number")} - ${escapeHtml(`${row.unitCount || 0} units`)}</span>
        </div>
        <b>${escapeHtml(formatMoney(row.grossSales))}</b>
      </div>
    `).join("");
  }

  function renderRecentOrders(rows) {
    if (!rows?.length) return `<div class="buyer-insights-empty is-compact">No synced orders for this buyer.</div>`;
    return rows.map((row) => {
      const titles = Array.isArray(row.itemTitles) ? row.itemTitles.filter(Boolean).slice(0, 3) : [];
      return `
        <div class="buyer-insights-list-row">
          <div>
            <strong>${escapeHtml(row.orderNumber || "No order number")}</strong>
            <span>${escapeHtml(formatDate(row.purchaseAt))} - ${escapeHtml(row.status || "unknown")} - ${escapeHtml(`${row.lineCount || 0} lines / ${row.unitCount || 0} units`)}</span>
            ${titles.length ? `<em>${titles.map(escapeHtml).join(" / ")}</em>` : ""}
          </div>
          <b>${escapeHtml(formatMoney(row.totalPrice))}</b>
        </div>
      `;
    }).join("");
  }

  function renderRecentReturns(rows) {
    if (!rows?.length) return `<div class="buyer-insights-empty is-compact">No synced returns for this buyer.</div>`;
    return rows.map((row) => `
      <div class="buyer-insights-list-row">
        <div>
          <strong>${escapeHtml(row.returnId || row.orderNumber || "Return")}</strong>
          <span>${escapeHtml(row.status || "unknown")} - ${escapeHtml(row.reason || "No reason")} - ${escapeHtml(formatDate(row.openedAt))}</span>
          ${row.buyerComment ? `<em>${escapeHtml(row.buyerComment)}</em>` : ""}
        </div>
        <b>${escapeHtml(row.requestAmount || "")}</b>
      </div>
    `).join("");
  }

  function renderScanIndicator(meta) {
    const status = String(getSyncMetaValue(meta, "status") || "").toLowerCase();
    const lastSuccessAt = getSyncMetaValue(meta, "lastSuccessAt", "last_success_at");
    const lastStartedAt = getSyncMetaValue(meta, "lastStartedAt", "last_started_at");
    const lastError = getSyncMetaValue(meta, "lastError", "last_error");
    const scanned = getSyncMetaValue(meta, "scannedOrders", "scanned_orders");
    const matched = getSyncMetaValue(meta, "matchedOrders", "matched_orders");
    const daysBack = getSyncMetaValue(meta, "daysBack", "days_back") || 730;

    if (status === "running") {
      return `
        <div class="buyer-insights-scan-indicator is-running">
          <strong>2-year API scan is running</strong>
          <span>Started ${escapeHtml(formatDateTime(lastStartedAt))}. Refresh this buyer in a moment to see the updated history.</span>
        </div>
      `;
    }

    if (status === "failed") {
      return `
        <div class="buyer-insights-scan-indicator is-failed">
          <strong>Last 2-year API scan failed</strong>
          <span>${escapeHtml(lastError || "Run the scan again when eBay is responding.")}</span>
        </div>
      `;
    }

    if (lastSuccessAt) {
      return `
        <div class="buyer-insights-scan-indicator is-complete">
          <strong>${escapeHtml(`${daysBack}-day API scan collected`)}</strong>
          <span>${escapeHtml(formatDateTime(lastSuccessAt))} · ${escapeHtml(formatCount(scanned))} eBay orders scanned · ${escapeHtml(formatCount(matched))} matched this buyer.</span>
        </div>
      `;
    }

    return `
      <div class="buyer-insights-scan-indicator is-empty">
        <strong>No deep API scan yet</strong>
        <span>This view is using already-synced OG history. Use Scan 2 years only when you want a fuller buyer profile.</span>
      </div>
    `;
  }

  function renderInsights(data) {
    const modal = ensureModal();
    const summary = data?.summary || {};
    const buyerUsername = data?.buyerUsername || activeBuyer || "Buyer";
    const buyerName = data?.buyerName && data.buyerName !== buyerUsername ? data.buyerName : "";
    activeSyncMeta = data?.buyerHistorySync || null;
    modal.querySelector("#buyer-insights-title").textContent = buyerUsername;
    modal.querySelector("#buyer-insights-subtitle").textContent = buyerName
      ? `${buyerName} - synced eBay buyer history`
      : "Synced eBay buyer history";
    modal.querySelector("#buyer-insights-history-link").href = `ebay-order-history.html?buyer=${encodeURIComponent(buyerUsername)}`;
    setDeepSyncBusy(deepSyncBusy);

    modal.querySelector("#buyer-insights-body").innerHTML = `
      ${renderScanIndicator(activeSyncMeta)}

      <div class="buyer-insights-metrics">
        ${metric("Gross bought", formatMoney(summary.grossSales), `${summary.orderCount || 0} orders`)}
        ${metric("Estimated payout", formatMoney(summary.netPayout), `${summary.unitCount || 0} units`)}
        ${metric("Average order", formatMoney(summary.avgOrderValue), `${summary.lineCount || 0} lines`)}
        ${metric("Returns", `${summary.returnCount || 0}`, `${summary.openReturnCount || 0} open / ${formatRate(summary.returnRate)}`)}
        ${metric("First purchase", formatDate(summary.firstPurchaseAt))}
        ${metric("Last purchase", formatDate(summary.lastPurchaseAt))}
      </div>

      <div class="buyer-insights-grid">
        <section class="buyer-insights-panel">
          <h3>What They Buy</h3>
          ${renderKindRows(data?.itemKinds || [])}
        </section>
        <section class="buyer-insights-panel">
          <h3>Top Items</h3>
          ${renderTopItems(data?.topItems || [])}
        </section>
        <section class="buyer-insights-panel is-wide">
          <h3>Recent Orders</h3>
          ${renderRecentOrders(data?.recentOrders || [])}
        </section>
        <section class="buyer-insights-panel is-wide">
          <h3>Recent Returns</h3>
          ${renderRecentReturns(data?.recentReturns || [])}
        </section>
      </div>

      <p class="buyer-insights-note">
        This uses synced OG eBay order and return history. Refresh eBay orders or returns first when you need the newest activity.
      </p>
    `;
  }

  async function openBuyerInsights(buyerUsername, options = {}) {
    const buyer = String(buyerUsername || "").trim();
    if (!buyer || /^no buyer/i.test(buyer)) return;

    activeBuyer = buyer;
    const requestId = ++activeRequestId;
    setLoading(buyer);

    try {
      await waitForSupabaseReady();
      const buyerKey = buyer.toLowerCase();
      const [insightsResult, syncResult] = await Promise.all([
        window.supabase.rpc("get_ebay_buyer_insights", {
          _buyer_username: buyer,
          _days_back: options.daysBack ?? null,
        }),
        window.supabase
          .from("ebay_buyer_history_syncs")
          .select("buyer_key,buyer_username,status,days_back,max_scanned_orders,scanned_orders,matched_orders,orders_upserted,lines_upserted,skipped_new_open_orders,windows_scanned,last_started_at,last_success_at,last_error,updated_at")
          .eq("buyer_key", buyerKey)
          .maybeSingle(),
      ]);
      if (requestId !== activeRequestId) return;
      if (insightsResult.error) throw insightsResult.error;
      if (syncResult.error && syncResult.error.code !== "PGRST116") {
        console.warn("Could not load eBay buyer scan metadata:", syncResult.error);
      }
      renderInsights({
        ...(insightsResult.data || {}),
        buyerHistorySync: syncResult.error ? null : syncResult.data,
      });
    } catch (error) {
      if (requestId !== activeRequestId) return;
      console.warn("Failed to load eBay buyer insights:", error);
      setError(error?.message || "Failed to load buyer insights.");
    }
  }

  async function runDeepBuyerSync() {
    const buyer = String(activeBuyer || "").trim();
    if (!buyer || deepSyncBusy) return;

    setDeepSyncBusy(true);
    setDeepSyncStatus("Scanning eBay order history for this buyer only. This can take a little bit...", "info");

    try {
      const response = await fetch(getBuyerHistorySyncUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          buyerUsername: buyer,
          daysBack: 730,
          maxScannedOrders: 2500,
          dryRun: false,
        }),
      });
      const text = await response.text();
      let result;
      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        result = { ok: false, error: text || `HTTP ${response.status}` };
      }
      if (!response.ok && !result.error) result.error = `HTTP ${response.status}`;
      if (!result?.ok) throw new Error(result?.error || "Could not scan eBay buyer history.");

      await openBuyerInsights(buyer, { daysBack: null });
      setDeepSyncStatus(summarizeDeepSyncResult(result), "success");
    } catch (error) {
      console.warn("Failed to deep-scan eBay buyer history:", error);
      setDeepSyncStatus(error?.message || "Could not scan eBay buyer history.", "error");
    } finally {
      setDeepSyncBusy(false);
    }
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-buyer-insights]");
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    openBuyerInsights(trigger.dataset.buyerInsights, {
      source: trigger.dataset.buyerContext || "",
    });
  });

  window.openEbayBuyerInsights = openBuyerInsights;
})();
