(function () {
  const MODAL_ID = "ebay-buyer-insights-modal";

  let activeBuyer = "";
  let activeRequestId = 0;
  let activeSyncMeta = null;
  let activeBreakdownSection = "";
  let activeInsightsData = null;

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

  function parseMoneyAmount(value, fallback = 0) {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : fallback;
    }
    const text = String(value ?? "").replace(/,/g, "").trim();
    if (!text) return fallback;
    const match = text.match(/-?\d+(?:\.\d+)?/);
    if (!match) return fallback;
    const number = Number(match[0]);
    return Number.isFinite(number) ? number : fallback;
  }

  function formatMoney(value) {
    const number = parseMoneyAmount(value, NaN);
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

  function toFiniteNumber(value, fallback = 0) {
    return parseMoneyAmount(value, fallback);
  }

  function toPositiveInteger(value, fallback = 0) {
    const number = Math.trunc(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function parseJsonArray(value) {
    try {
      const parsed = JSON.parse(String(value || "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function getInsightContextLabel(context = {}) {
    const source = String(context.source || "").trim();
    if (source === "pending-orders") return "Current pending order(s)";
    if (source === "order-history") return "Opened order group";
    return "Current order";
  }

  function getCurrentItemsPanelTitle(context = {}) {
    const source = String(context.source || "").trim();
    if (source === "pending-orders") return "Current Pending Items";
    if (source === "order-history") return "Opened Order Items";
    return "Current Items";
  }

  function getSyncMetaValue(meta, camelName, snakeName = "") {
    if (!meta || typeof meta !== "object") return null;
    return meta[camelName] ?? meta[snakeName || camelName] ?? null;
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
            <span class="buyer-insights-archive-pill">Covered by account archive</span>
          </div>
        </div>
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
      const metricButton = event.target.closest("[data-insight-section]");
      if (metricButton && modal.contains(metricButton)) {
        activeBreakdownSection = metricButton.dataset.insightSection || "";
        if (activeInsightsData) renderInsights(activeInsightsData);
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
    activeBreakdownSection = "";
    activeInsightsData = null;
  }

  function setLoading(buyerUsername) {
    const modal = ensureModal();
    activeSyncMeta = null;
    activeBreakdownSection = "";
    activeInsightsData = null;
    modal.classList.remove("hidden");
    modal.querySelector("#buyer-insights-title").textContent = buyerUsername || "Buyer history";
    modal.querySelector("#buyer-insights-subtitle").textContent = "Pulling synced eBay orders, returns, and item mix...";
    modal.querySelector("#buyer-insights-history-link").href = `ebay-order-history.html?buyer=${encodeURIComponent(buyerUsername || "")}`;
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

  function metric(label, value, hint = "", section = "") {
    const hints = Array.isArray(hint) ? hint.filter(Boolean) : [hint].filter(Boolean);
    const tag = section ? "button" : "div";
    const attrs = section
      ? ` type="button" data-insight-section="${escapeHtml(section)}" aria-pressed="${activeBreakdownSection === section ? "true" : "false"}"`
      : "";
    return `
      <${tag} class="buyer-insights-metric ${section ? "is-clickable" : ""} ${section && activeBreakdownSection === section ? "is-active" : ""}"${attrs}>
        <small>${escapeHtml(label)}</small>
        <strong>${escapeHtml(value)}</strong>
        ${hints.map((line) => `<span>${escapeHtml(line)}</span>`).join("")}
      </${tag}>
    `;
  }

  function getPriorOrderRows(rows, context = {}) {
    const currentOrderNumbers = new Set(Array.isArray(context.currentOrderNumbers) ? context.currentOrderNumbers : []);
    return (rows || []).filter((row) => {
      const orderNumber = String(row.orderNumber || "").trim();
      const status = String(row.status || "").toLowerCase();
      return !currentOrderNumbers.has(orderNumber) && status !== "cancelled" && status !== "archived" && !row.hasReturn;
    });
  }

  function normalizeOrderNumber(value) {
    return String(value || "").trim().toLowerCase();
  }

  function getReturnedOrderRows(rows) {
    return (rows || []).filter((row) => {
      const status = String(row.status || "").toLowerCase();
      return row?.hasReturn && status !== "cancelled" && status !== "archived";
    });
  }

  function getReturnOrderMatch(returnRow, orders) {
    const returnOrderNumber = normalizeOrderNumber(returnRow?.orderNumber);
    if (!returnOrderNumber) return null;
    return (orders || []).find((order) => normalizeOrderNumber(order?.orderNumber) === returnOrderNumber) || null;
  }

  function getMatchingReturnsForOrder(orderRow, returns = []) {
    const orderNumber = normalizeOrderNumber(orderRow?.orderNumber);
    if (!orderNumber) return [];
    return (returns || []).filter((row) => normalizeOrderNumber(row?.orderNumber) === orderNumber);
  }

  function sumOrderTotals(rows) {
    return (rows || []).reduce((total, row) => total + toFiniteNumber(row?.originalTotal ?? row?.totalPrice, 0), 0);
  }

  function sumReturnAmounts(rows) {
    return (rows || []).reduce((total, row) => total + toFiniteNumber(row?.requestAmount ?? row?.returnedAmount, 0), 0);
  }

  function renderContextMetrics(summary = {}, context = {}, priorRows = []) {
    const currentTotal = toFiniteNumber(context.currentOrderTotal, 0);
    const currentOrderCount = toPositiveInteger(context.currentOrderCount, currentTotal > 0 ? 1 : 0);
    const currentLineCount = toPositiveInteger(context.currentLineCount, 0);
    if (!currentTotal && !currentOrderCount && !currentLineCount) return "";

    const grossSales = toFiniteNumber(summary.grossSales, 0);
    const orderCount = toPositiveInteger(summary.orderCount, 0);
    const lineCount = toPositiveInteger(summary.lineCount, 0);
    const visiblePriorGross = priorRows.reduce((total, row) => total + toFiniteNumber(row.totalPrice, 0), 0);
    const visiblePriorLines = priorRows.reduce((total, row) => total + toPositiveInteger(row.lineCount, 0), 0);
    const fallbackPriorGross = Math.max(0, grossSales - currentTotal);
    const priorGross = priorRows.length ? visiblePriorGross : fallbackPriorGross;
    const priorOrders = priorRows.length ? priorRows.length : Math.max(0, orderCount - currentOrderCount);
    const priorLines = priorRows.length ? visiblePriorLines : Math.max(0, lineCount - currentLineCount);
    const currentLabel = getInsightContextLabel(context);

    return `
      <div class="buyer-insights-context-metrics">
        ${metric(currentLabel, formatMoney(currentTotal), `${formatCount(currentOrderCount)} order${currentOrderCount === 1 ? "" : "s"} / ${formatCount(currentLineCount)} line${currentLineCount === 1 ? "" : "s"}`)}
        ${metric("Prior net buyer value", formatMoney(priorGross), `${formatCount(priorOrders)} prior order${priorOrders === 1 ? "" : "s"} / ${formatCount(priorLines)} line${priorLines === 1 ? "" : "s"}`)}
        ${metric("Net archive value", formatMoney(grossSales), `${formatCount(orderCount)} stored order${orderCount === 1 ? "" : "s"} after returns`)}
      </div>
    `;
  }

  function getPurchaseDateRange(rows = [], fallbackFirst = "", fallbackLast = "") {
    const entries = (rows || [])
      .map((row) => ({ row, date: new Date(row?.purchaseAt) }))
      .filter((entry) => !Number.isNaN(entry.date.getTime()));
    if (!entries.length) {
      return { firstPurchaseAt: fallbackFirst, lastPurchaseAt: fallbackLast, firstOrderNumber: "", lastOrderNumber: "" };
    }
    const fallbackFirstDate = fallbackFirst ? new Date(fallbackFirst) : null;
    const sorted = entries.sort((a, b) => a.date.getTime() - b.date.getTime());
    const firstEntry = sorted[0];
    const lastEntry = sorted[sorted.length - 1];
    const firstTime = fallbackFirstDate && !Number.isNaN(fallbackFirstDate.getTime())
      ? Math.min(firstEntry.date.getTime(), fallbackFirstDate.getTime())
      : firstEntry.date.getTime();
    return {
      firstPurchaseAt: new Date(firstTime).toISOString(),
      lastPurchaseAt: lastEntry.date.toISOString(),
      firstOrderNumber: firstEntry.row?.orderNumber || "",
      lastOrderNumber: lastEntry.row?.orderNumber || "",
    };
  }

  function getCurrentArchiveValue(recentOrders = [], context = {}, fallback = 0) {
    const currentOrderNumbers = new Set(Array.isArray(context.currentOrderNumbers) ? context.currentOrderNumbers : []);
    if (!currentOrderNumbers.size) return fallback;
    const archiveTotal = (recentOrders || []).reduce((total, row) => {
      const orderNumber = String(row?.orderNumber || "").trim();
      return currentOrderNumbers.has(orderNumber) ? total + toFiniteNumber(row?.totalPrice, 0) : total;
    }, 0);
    return archiveTotal || fallback;
  }

  function renderBuyerValueMetrics(summary = {}, context = {}, priorRows = [], returnedRows = [], recentOrders = []) {
    const currentTotal = toFiniteNumber(context.currentOrderTotal, 0);
    const currentOrderCount = toPositiveInteger(context.currentOrderCount, currentTotal > 0 ? 1 : 0);
    const currentLineCount = toPositiveInteger(context.currentLineCount, 0);
    const currentItems = Array.isArray(context.currentItems) ? context.currentItems : [];
    const currentOrderNumbers = Array.isArray(context.currentOrderNumbers) ? context.currentOrderNumbers.filter(Boolean) : [];
    const archiveValue = toFiniteNumber(summary.grossSales, 0);
    const currentArchiveValue = getCurrentArchiveValue(recentOrders, context, currentTotal);
    const priorValue = Math.max(0, archiveValue - currentArchiveValue);
    const totalWithCurrent = priorValue + currentTotal;
    const returnedOrderCount = returnedRows.length;
    const returnedLineCount = returnedRows.reduce((total, row) => total + toPositiveInteger(row.lineCount, 0), 0);
    const returnedOriginalValue = sumOrderTotals(returnedRows);
    const returnedRetainedValue = returnedRows.reduce((total, row) => total + toFiniteNumber(row.retainedAmount, 0), 0);
    const returnedAmount = toFiniteNumber(summary.returnAmountTotal, 0);
    const priorOrderCount = Math.max(0, toPositiveInteger(summary.orderCount, 0) - currentOrderCount) + returnedOrderCount;
    const priorLineCount = Math.max(0, toPositiveInteger(summary.lineCount, 0) - currentLineCount) + returnedLineCount;
    const keptPriorValue = Math.max(0, priorValue - returnedRetainedValue);
    const keptPriorOrderCount = Math.max(0, priorOrderCount - returnedOrderCount);
    const avgOrderValue = priorOrderCount ? priorValue / priorOrderCount : toFiniteNumber(summary.avgOrderValue, 0);
    const dateRows = [...(priorRows || []), ...(returnedRows || [])];
    const dates = getPurchaseDateRange(dateRows, summary.firstPurchaseAt, summary.lastPurchaseAt);
    const currentLabel = getInsightContextLabel(context);
    const currentItemLines = currentItems.slice(0, 2).map((row) => {
      const name = row.itemNumber || row.title || row.orderNumber || "Current item";
      return `${name}: ${formatMoney(row.grossSales)}`;
    });
    const currentBreakdown = [
      currentOrderNumbers.length ? `Order ${currentOrderNumbers.slice(0, 2).join(", ")}` : "",
      ...currentItemLines,
      currentItems.length > 2 ? `+ ${currentItems.length - 2} more current item${currentItems.length - 2 === 1 ? "" : "s"}` : "",
    ].filter(Boolean);

    return `
      <div class="buyer-insights-metrics">
        ${metric(currentLabel, formatMoney(currentTotal), [
          `${formatCount(currentOrderCount)} order${currentOrderCount === 1 ? "" : "s"} / ${formatCount(currentLineCount)} line${currentLineCount === 1 ? "" : "s"}`,
          ...currentBreakdown,
        ], "current")}
        ${metric("Prior store value", formatMoney(priorValue), [
          `Kept purchases: ${formatMoney(keptPriorValue)} (${formatCount(keptPriorOrderCount)} order${keptPriorOrderCount === 1 ? "" : "s"})`,
          returnedOrderCount ? `Retained after partial returns: ${formatMoney(returnedRetainedValue)}` : "",
          `${formatCount(priorOrderCount)} prior order${priorOrderCount === 1 ? "" : "s"} / ${formatCount(priorLineCount)} line${priorLineCount === 1 ? "" : "s"}`,
        ], "prior")}
        ${metric("Current + prior value", formatMoney(totalWithCurrent), [
          `${formatMoney(priorValue)} prior retained value`,
          `+ ${formatMoney(currentTotal)} current pending`,
        ], "total")}
        ${metric("Returns", formatMoney(returnedAmount), [
          `${summary.returnCount || 0} return${Number(summary.returnCount || 0) === 1 ? "" : "s"} / ${summary.openReturnCount || 0} open`,
          returnedOriginalValue ? `${formatMoney(returnedAmount)} returned from ${formatMoney(returnedOriginalValue)} original purchase value` : "",
          returnedRetainedValue ? `${formatMoney(returnedRetainedValue)} retained by store` : "",
        ], "returns")}
        ${metric("Cancellations", formatMoney(summary.cancelledOrderTotal ?? summary.cancelledLineTotal), [
          `${summary.cancelledOrderCount || 0} cancelled order${Number(summary.cancelledOrderCount || 0) === 1 ? "" : "s"}`,
          `${summary.cancelledLineCount || 0} cancelled line${Number(summary.cancelledLineCount || 0) === 1 ? "" : "s"}`,
        ], "cancellations")}
        ${metric("Average order", formatMoney(avgOrderValue), [
          `${formatMoney(priorValue)} prior retained value`,
          `/ ${formatCount(priorOrderCount)} prior order${priorOrderCount === 1 ? "" : "s"}`,
        ], "average")}
        ${metric("First prior purchase", formatDate(dates.firstPurchaseAt), dates.firstOrderNumber ? `Order ${dates.firstOrderNumber}` : "", "first")}
        ${metric("Last prior purchase", formatDate(dates.lastPurchaseAt), dates.lastOrderNumber ? `Order ${dates.lastOrderNumber}` : "", "last")}
      </div>
    `;
  }

  function getLineBreakdownRows(data = {}) {
    return Array.isArray(data?.lineBreakdown) ? data.lineBreakdown : [];
  }

  function isCurrentOrderRow(row, context = {}) {
    const currentOrderNumbers = new Set(Array.isArray(context.currentOrderNumbers) ? context.currentOrderNumbers : []);
    return currentOrderNumbers.has(String(row?.orderNumber || "").trim());
  }

  function sortDetailRows(rows = []) {
    return [...rows].sort((a, b) => {
      const aTime = new Date(a.purchaseAt || 0).getTime();
      const bTime = new Date(b.purchaseAt || 0).getTime();
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });
  }

  function getLineLookupKey(row = {}) {
    return [row.orderNumber || "", row.itemNumber || "", row.transactionId || "", row.title || ""].join("|").toLowerCase();
  }

  function makeDetailRow(row = {}, amount = 0, extraDetails = []) {
    const status = [row.itemState || row.status || "", row.orderStatus || "", row.lineStatus || ""]
      .filter(Boolean)
      .join(" / ");
    return {
      orderNumber: row.orderNumber || "",
      purchaseAt: row.purchaseAt || row.shipByDate || "",
      title: row.title || row.itemTitle || (Array.isArray(row.itemTitles) ? row.itemTitles.filter(Boolean).join(" / ") : "") || "Untitled item",
      itemNumber: row.itemNumber || "",
      transactionId: row.transactionId || "",
      customLabel: row.customLabel || "",
      quantity: toPositiveInteger(row.quantity, toPositiveInteger(row.unitCount, 0)),
      status,
      amount: toFiniteNumber(amount, 0),
      details: extraDetails.filter(Boolean),
    };
  }

  function currentRowsFromContext(context = {}, lineRows = []) {
    const currentItems = Array.isArray(context.currentItems) ? context.currentItems : [];
    const currentOrderNumbers = new Set(Array.isArray(context.currentOrderNumbers) ? context.currentOrderNumbers : []);
    if (currentItems.length) {
      return currentItems.map((item) => {
        const match = lineRows.find((row) =>
          String(row.orderNumber || "") === String(item.orderNumber || "")
          && (!item.itemNumber || String(row.itemNumber || "") === String(item.itemNumber || ""))
        ) || {};
        return makeDetailRow({
          ...match,
          orderNumber: item.orderNumber || match.orderNumber || "",
          purchaseAt: match.purchaseAt || item.shipByDate || "",
          title: item.title || match.title || "",
          itemNumber: item.itemNumber || match.itemNumber || "",
          quantity: item.quantity || match.quantity || 0,
          itemState: "pending",
          orderStatus: match.orderStatus || "",
          lineStatus: item.status || match.lineStatus || "",
        }, item.grossSales, [
          item.status ? `Current line status: ${item.status}` : "",
          item.shipByDate ? `Ship by ${formatDate(item.shipByDate)}` : "",
        ]);
      });
    }
    return lineRows
      .filter((row) => currentOrderNumbers.has(String(row.orderNumber || "")))
      .filter((row) => ["pending", "partially_fulfilled"].includes(String(row.lineStatus || "").toLowerCase()))
      .map((row) => makeDetailRow(row, row.lineTotal, [row.shipByDate ? `Ship by ${formatDate(row.shipByDate)}` : ""]));
  }

  function priorRowsFromBreakdown(lineRows = [], context = {}) {
    return lineRows
      .filter((row) => !isCurrentOrderRow(row, context))
      .filter((row) => ["successful", "return"].includes(String(row.itemState || "").toLowerCase()))
      .map((row) => {
        const isReturn = String(row.itemState || "").toLowerCase() === "return";
        const amount = isReturn ? row.lineRetainedAmount : row.lineTotal;
        return makeDetailRow(row, amount, [
          isReturn ? `${formatMoney(row.lineReturnedAmount)} returned from ${formatMoney(row.lineTotal)} line value` : "",
          isReturn ? `${formatMoney(row.lineRetainedAmount)} retained on this line` : "",
        ]);
      });
  }

  function returnRowsFromBreakdown(lineRows = [], context = {}) {
    return lineRows
      .filter((row) => !isCurrentOrderRow(row, context))
      .filter((row) => String(row.itemState || "").toLowerCase() === "return")
      .map((row) => makeDetailRow(row, row.lineReturnedAmount, [
        `${formatMoney(row.lineReturnedAmount)} returned from ${formatMoney(row.lineTotal)} line value`,
        `${formatMoney(row.lineRetainedAmount)} retained on this line`,
        row.returnCount ? `${row.returnCount} return${Number(row.returnCount) === 1 ? "" : "s"} on order` : "",
      ]));
  }

  function cancellationRowsFromBreakdown(lineRows = [], context = {}) {
    return lineRows
      .filter((row) => !isCurrentOrderRow(row, context))
      .filter((row) => String(row.itemState || "").toLowerCase() === "cancelled")
      .map((row) => makeDetailRow(row, row.lineTotal, ["Cancelled value"]));
  }

  function fallbackPriorRows(priorRows = [], returnedRows = []) {
    const prior = (priorRows || []).map((row) => makeDetailRow({
      orderNumber: row.orderNumber,
      purchaseAt: row.purchaseAt,
      title: Array.isArray(row.itemTitles) ? row.itemTitles.join(" / ") : "",
      itemState: row.status || "successful",
      quantity: row.unitCount,
    }, row.totalPrice, [`${row.lineCount || 0} lines / ${row.unitCount || 0} units`]));
    const returned = (returnedRows || []).map((row) => makeDetailRow({
      orderNumber: row.orderNumber,
      purchaseAt: row.purchaseAt,
      title: Array.isArray(row.itemTitles) ? row.itemTitles.join(" / ") : "",
      itemState: "return",
      quantity: row.unitCount,
    }, row.retainedAmount ?? row.totalPrice, [
      `${formatMoney(row.returnedAmount)} returned from ${formatMoney(row.originalTotal ?? row.totalPrice)} original purchase value`,
      `${formatMoney(row.retainedAmount ?? row.totalPrice)} retained by store`,
    ]));
    return [...prior, ...returned];
  }

  function renderDetailRows(rows = []) {
    if (!rows.length) {
      return `<div class="buyer-insights-empty is-compact">No item lines found for this section.</div>`;
    }
    return sortDetailRows(rows).map((row) => `
      <div class="buyer-insights-list-row buyer-insights-breakdown-row">
        <div>
          <strong>${escapeHtml(row.title)}</strong>
          <span>${escapeHtml(formatDate(row.purchaseAt))} - Order ${escapeHtml(row.orderNumber || "No order")} - Qty ${escapeHtml(row.quantity || 0)}</span>
          ${row.itemNumber ? `<span>Item ${escapeHtml(row.itemNumber)}${row.transactionId ? ` - Tx ${escapeHtml(row.transactionId)}` : ""}</span>` : ""}
          ${row.status ? `<em>${escapeHtml(row.status)}</em>` : ""}
          ${row.details.map((detail) => `<span>${escapeHtml(detail)}</span>`).join("")}
        </div>
        <b>${escapeHtml(formatMoney(row.amount))}</b>
      </div>
    `).join("");
  }

  function getBoundaryOrderRows(rows = [], boundary = "first") {
    const datedRows = (rows || [])
      .map((row) => ({ row, time: new Date(row.purchaseAt || 0).getTime() }))
      .filter((entry) => Number.isFinite(entry.time));
    if (!datedRows.length) return [];
    datedRows.sort((a, b) => boundary === "first" ? a.time - b.time : b.time - a.time);
    const target = datedRows[0].row;
    if (!target.orderNumber) return [target];
    return rows.filter((row) => row.orderNumber === target.orderNumber);
  }

  function renderMetricBreakdown(section, data = {}, context = {}, priorRows = [], returnedRows = []) {
    if (!section) return "";
    const lineRows = getLineBreakdownRows(data);
    const currentRows = currentRowsFromContext(context, lineRows);
    const priorDetailRows = lineRows.length
      ? priorRowsFromBreakdown(lineRows, context)
      : fallbackPriorRows(priorRows, returnedRows);
    const returnDetailRows = lineRows.length
      ? returnRowsFromBreakdown(lineRows, context)
      : fallbackPriorRows([], returnedRows);
    const cancellationRows = cancellationRowsFromBreakdown(lineRows, context);
    const totalRows = [...currentRows, ...priorDetailRows];
    const firstOrderRows = getBoundaryOrderRows(priorDetailRows, "first");
    const lastOrderRows = getBoundaryOrderRows(priorDetailRows, "last");
    const config = {
      current: { title: "Current Pending Order Lines", rows: currentRows },
      prior: { title: "Prior Store Value Lines", rows: priorDetailRows },
      total: { title: "Current + Prior Value Lines", rows: totalRows },
      returns: { title: "Returned Value Lines", rows: returnDetailRows },
      cancellations: { title: "Cancelled Lines", rows: cancellationRows },
      average: { title: "Average Order Inputs", rows: priorDetailRows },
      first: { title: "First Prior Purchase Lines", rows: firstOrderRows },
      last: { title: "Last Prior Purchase Lines", rows: lastOrderRows },
    }[section];
    if (!config) return "";
    const total = config.rows.reduce((sum, row) => sum + toFiniteNumber(row.amount, 0), 0);
    return `
      <section class="buyer-insights-breakdown">
        <div class="buyer-insights-breakdown-head">
          <h3>${escapeHtml(config.title)}</h3>
          <span>${escapeHtml(`${formatCount(config.rows.length)} line${config.rows.length === 1 ? "" : "s"} / ${formatMoney(total)}`)}</span>
        </div>
        ${renderDetailRows(config.rows)}
      </section>
    `;
  }

  function renderKindRows(rows, note = "") {
    const noteMarkup = note ? `<p class="buyer-insights-panel-note">${escapeHtml(note)}</p>` : "";
    if (!rows?.length) return `${noteMarkup}<div class="buyer-insights-empty is-compact">No item mix captured yet.</div>`;
    return `${noteMarkup}${rows.map((row) => `
      <div class="buyer-kind-row">
        <strong>${escapeHtml(row.label || "Other")}</strong>
        <span>${escapeHtml(`${row.unitCount || 0} units`)}</span>
        <b>${escapeHtml(formatMoney(row.grossSales))}</b>
      </div>
    `).join("")}`;
  }

  function renderTopItems(rows, context = {}) {
    const currentItems = Array.isArray(context.currentItems) ? context.currentItems.filter(Boolean) : [];
    if (currentItems.length) {
      return currentItems.map((row) => {
        const quantity = toPositiveInteger(row.quantity, toPositiveInteger(row.unitCount, 0));
        const detailParts = [
          row.itemNumber || "No item number",
          row.orderNumber || "",
          quantity ? `${quantity} unit${quantity === 1 ? "" : "s"}` : "",
        ].filter(Boolean);
        return `
          <div class="buyer-insights-list-row">
            <div>
              <strong>${escapeHtml(row.title || "Untitled item")}</strong>
              <span>${escapeHtml(detailParts.join(" - "))}</span>
              ${row.status ? `<em>${escapeHtml(row.status)}</em>` : ""}
            </div>
            <b>${escapeHtml(formatMoney(row.grossSales))}</b>
          </div>
        `;
      }).join("");
    }
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
    const priorRows = rows || [];
    if (!priorRows.length) return `<div class="buyer-insights-empty is-compact">No previous orders found for this buyer.</div>`;
    return priorRows.map((row) => {
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

  function renderReturnedPurchases(rows, returns = []) {
    if (!rows?.length) return `<div class="buyer-insights-empty is-compact">No returned purchases found for this buyer.</div>`;
    return rows.map((row) => {
      const titles = Array.isArray(row.itemTitles) ? row.itemTitles.filter(Boolean).slice(0, 3) : [];
      const matchingReturns = getMatchingReturnsForOrder(row, returns);
      const originalValue = toFiniteNumber(row.originalTotal ?? row.totalPrice, 0);
      const returnedAmount = toFiniteNumber(row.returnedAmount, NaN);
      const totalReturned = Number.isFinite(returnedAmount) ? returnedAmount : sumReturnAmounts(matchingReturns);
      const retainedAmount = toFiniteNumber(row.retainedAmount, Math.max(0, originalValue - totalReturned));
      const returnCount = matchingReturns.length || toPositiveInteger(row.returnCount, 0);
      const returnSummary = matchingReturns.map((ret) => {
        const parts = [ret.returnId || "Return", ret.reason || "", ret.requestAmount || ""].filter(Boolean);
        return parts.join(" - ");
      }).join(" / ");
      return `
        <div class="buyer-insights-list-row is-returned-order">
          <div>
            <strong>${escapeHtml(row.orderNumber || "No order number")}</strong>
            <span>${escapeHtml(formatDate(row.purchaseAt))} - returned purchase - ${escapeHtml(`${row.lineCount || 0} lines / ${row.unitCount || 0} units`)}</span>
            ${originalValue ? `<span>${escapeHtml(`${formatMoney(totalReturned)} returned from original ${formatMoney(originalValue)}`)}</span>` : ""}
            ${originalValue ? `<span>${escapeHtml(`${formatMoney(retainedAmount)} retained by store`)}</span>` : ""}
            ${titles.length ? `<em>${titles.map(escapeHtml).join(" / ")}</em>` : ""}
            ${returnSummary ? `<span>${escapeHtml(returnSummary)}</span>` : ""}
          </div>
          <b>
            ${escapeHtml(formatMoney(retainedAmount || originalValue))}
            ${returnCount ? `<small>${escapeHtml(`${returnCount} return${returnCount === 1 ? "" : "s"}`)}</small>` : ""}
          </b>
        </div>
      `;
    }).join("");
  }

  function renderRecentCancellations(rows) {
    if (!rows?.length) return `<div class="buyer-insights-empty is-compact">No synced cancellations for this buyer.</div>`;
    return rows.map((row) => {
      const titles = Array.isArray(row.itemTitles) ? row.itemTitles.filter(Boolean).slice(0, 3) : [];
      return `
        <div class="buyer-insights-list-row">
          <div>
            <strong>${escapeHtml(row.orderNumber || "No order number")}</strong>
            <span>${escapeHtml(formatDate(row.purchaseAt))} - cancelled - ${escapeHtml(`${row.lineCount || 0} lines / ${row.unitCount || 0} units`)}</span>
            ${titles.length ? `<em>${titles.map(escapeHtml).join(" / ")}</em>` : ""}
          </div>
          <b>${escapeHtml(formatMoney(row.totalPrice))}</b>
        </div>
      `;
    }).join("");
  }

  function renderRecentReturns(rows, orders = []) {
    if (!rows?.length) return `<div class="buyer-insights-empty is-compact">No synced returns for this buyer.</div>`;
    return rows.map((row) => {
      const matchedOrder = getReturnOrderMatch(row, orders);
      const rowTitles = Array.isArray(row.itemTitles) ? row.itemTitles : [];
      const matchedTitles = Array.isArray(matchedOrder?.itemTitles) ? matchedOrder.itemTitles : [];
      const titles = (rowTitles.length ? rowTitles : matchedTitles).filter(Boolean).slice(0, 2);
      const originalOrderValue = toFiniteNumber(row.originalOrderTotal ?? matchedOrder?.totalPrice, 0);
      const returnedAmount = toFiniteNumber(row.returnedAmount ?? row.requestAmount, 0);
      const retainedOrderValue = toFiniteNumber(row.retainedOrderValue, Math.max(0, originalOrderValue - returnedAmount));
      return `
        <div class="buyer-insights-list-row">
          <div>
            <strong>${escapeHtml(row.returnId || row.orderNumber || "Return")}</strong>
            <span>${escapeHtml(row.status || "unknown")} - ${escapeHtml(row.reason || "No reason")} - ${escapeHtml(formatDate(row.openedAt))}</span>
            ${originalOrderValue ? `<span>${escapeHtml(`${formatMoney(returnedAmount)} returned from original ${formatMoney(originalOrderValue)}`)}</span>` : ""}
            ${originalOrderValue ? `<span>${escapeHtml(`${formatMoney(retainedOrderValue)} retained by store`)}</span>` : ""}
            ${titles.length ? `<em>${titles.map(escapeHtml).join(" / ")}</em>` : ""}
            ${row.buyerComment ? `<em>${escapeHtml(row.buyerComment)}</em>` : ""}
          </div>
          <b>
            ${escapeHtml(row.requestAmount || "")}
            ${originalOrderValue ? `<small>${escapeHtml(`${formatMoney(retainedOrderValue)} retained`)}</small>` : ""}
          </b>
        </div>
      `;
    }).join("");
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
          <strong>Account archive is refreshing</strong>
          <span>Started ${escapeHtml(formatDateTime(lastStartedAt))}. Refresh this buyer in a moment to see updated archive coverage.</span>
        </div>
      `;
    }

    if (status === "failed") {
      return `
        <div class="buyer-insights-scan-indicator is-failed">
          <strong>Account archive needs attention</strong>
          <span>${escapeHtml(lastError || "The last account archive refresh did not finish cleanly.")}</span>
        </div>
      `;
    }

    if (lastSuccessAt) {
      return `
        <div class="buyer-insights-scan-indicator is-complete">
          <strong>Covered by account archive</strong>
          <span>${escapeHtml(`${daysBack} days through ${formatDateTime(lastSuccessAt)} - ${formatCount(scanned)} eBay orders scanned - ${formatCount(matched)} matched this buyer.`)}</span>
        </div>
      `;
    }

    return `
      <div class="buyer-insights-scan-indicator is-complete">
        <strong>Covered by account archive</strong>
        <span>Using synced OG and eBay history. Run the account archive from Order History when you need a full refresh.</span>
      </div>
    `;
  }

  function renderInsights(data) {
    const modal = ensureModal();
    activeInsightsData = data || {};
    const summary = data?.summary || {};
    const context = data?.context || {};
    const recentOrders = data?.recentOrders || [];
    const priorRows = getPriorOrderRows(recentOrders, context);
    const returnedRows = Array.isArray(data?.returnedPurchases) && data.returnedPurchases.length
      ? data.returnedPurchases
      : getReturnedOrderRows(recentOrders);
    const buyerUsername = data?.buyerUsername || activeBuyer || "Buyer";
    const buyerName = data?.buyerName && data.buyerName !== buyerUsername ? data.buyerName : "";
    activeSyncMeta = data?.buyerHistorySync || null;
    modal.querySelector("#buyer-insights-title").textContent = buyerUsername;
    modal.querySelector("#buyer-insights-subtitle").textContent = buyerName
      ? `${buyerName} - synced eBay buyer history`
      : "Synced eBay buyer history";
    modal.querySelector("#buyer-insights-history-link").href = `ebay-order-history.html?buyer=${encodeURIComponent(buyerUsername)}`;

    modal.querySelector("#buyer-insights-body").innerHTML = `
      ${renderScanIndicator(activeSyncMeta)}

      ${renderBuyerValueMetrics(summary, context, priorRows, returnedRows, recentOrders)}
      ${renderMetricBreakdown(activeBreakdownSection, data, context, priorRows, returnedRows)}

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
      const [insightsResult, returnValueResult, lineBreakdownResult, syncResult] = await Promise.all([
        window.supabase.rpc("get_ebay_buyer_insights", {
          _buyer_username: buyer,
          _days_back: options.daysBack ?? null,
        }),
        window.supabase.rpc("get_ebay_buyer_return_value_breakdown", {
          _buyer_username: buyer,
          _days_back: options.daysBack ?? null,
        }),
        window.supabase.rpc("get_ebay_buyer_value_line_breakdown", {
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
      if (returnValueResult.error) {
        console.warn("Could not load eBay buyer return value breakdown:", returnValueResult.error);
      }
      if (lineBreakdownResult.error) {
        console.warn("Could not load eBay buyer line breakdown:", lineBreakdownResult.error);
      }
      if (syncResult.error && syncResult.error.code !== "PGRST116") {
        console.warn("Could not load eBay buyer scan metadata:", syncResult.error);
      }
      const insightsData = insightsResult.data || {};
      const returnValueData = returnValueResult.error ? {} : returnValueResult.data || {};
      const lineBreakdownData = lineBreakdownResult.error ? {} : lineBreakdownResult.data || {};
      renderInsights({
        ...insightsData,
        ...returnValueData,
        ...lineBreakdownData,
        recentReturns: Array.isArray(returnValueData.recentReturns)
          ? returnValueData.recentReturns
          : insightsData.recentReturns,
        buyerHistorySync: syncResult.error ? null : syncResult.data,
        context: {
          source: options.source || "",
          currentOrderTotal: options.currentOrderTotal,
          currentOrderCount: options.currentOrderCount,
          currentLineCount: options.currentLineCount,
          currentOrderNumbers: options.currentOrderNumbers || [],
          currentItems: Array.isArray(options.currentItems) ? options.currentItems : [],
        },
      });
    } catch (error) {
      if (requestId !== activeRequestId) return;
      console.warn("Failed to load eBay buyer insights:", error);
      setError(error?.message || "Failed to load buyer insights.");
    }
  }

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-buyer-insights]");
    if (!trigger) return;
    event.preventDefault();
    event.stopPropagation();
    openBuyerInsights(trigger.dataset.buyerInsights, {
      source: trigger.dataset.buyerContext || "",
      currentOrderTotal: trigger.dataset.currentOrderTotal,
      currentOrderCount: trigger.dataset.currentOrderCount,
      currentLineCount: trigger.dataset.currentLineCount,
      currentOrderNumbers: String(trigger.dataset.currentOrderNumbers || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      currentItems: parseJsonArray(trigger.dataset.currentItems),
    });
  });

  window.openEbayBuyerInsights = openBuyerInsights;
})();
