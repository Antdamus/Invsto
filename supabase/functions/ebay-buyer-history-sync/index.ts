import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const EBAY_CLIENT_ID = (Deno.env.get("EBAY_CLIENT_ID") ?? Deno.env.get("EBAY_APP_ID") ?? "").trim();
const EBAY_CLIENT_SECRET = (Deno.env.get("EBAY_CLIENT_SECRET") ?? Deno.env.get("EBAY_CERT_ID") ?? "").trim();
const EBAY_REFRESH_TOKEN = (Deno.env.get("EBAY_REFRESH_TOKEN") ?? "").trim();
const EBAY_ENV = (Deno.env.get("EBAY_ENV") ?? "production").trim().toLowerCase();
const EBAY_ORDER_SCOPE = (Deno.env.get("EBAY_ORDER_SCOPE") ??
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly").trim();

const EBAY_API_BASE = EBAY_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
// eBay says "2 years" but rejects requests right on the exact boundary.
// Keep a small buffer so chunked archive scans stay inside the accepted range.
const MAX_DAYS_BACK = 720;
const DEFAULT_DAYS_BACK = 720;
const PAGE_LIMIT = 50;
const DEFAULT_MAX_SCANNED_ORDERS = 2500;
const DEFAULT_ACCOUNT_MAX_SCANNED_ORDERS = 20000;
const DEFAULT_WINDOW_DAYS = 30;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [
      record.message,
      record.details,
      record.hint,
      record.code ? `code: ${record.code}` : "",
    ].map((value) => String(value || "").trim()).filter(Boolean);
    if (parts.length) return parts.join(" | ");
    try {
      return JSON.stringify(record);
    } catch {
      return "Unknown object error";
    }
  }
  return String(error || "Unknown error");
}

function toText(value: unknown): string {
  return String(value || "").trim();
}

function normalizeBuyerKey(value: unknown): string {
  return toText(value).toLowerCase();
}

function toMoney(value: unknown): number {
  const raw = typeof value === "object" && value !== null && "value" in value
    ? (value as JsonRecord).value
    : value;
  const numeric = Number(raw || 0);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0;
}

function toIsoDate(value: unknown): string | null {
  const text = toText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeSku(value: unknown): string {
  return toText(value).replace(/\s+/g, "-").slice(0, 50);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function getNestedText(...values: unknown[]): string {
  for (const value of values) {
    const text = toText(value);
    if (text) return text;
  }
  return "";
}

function extractOrderNumber(order: any): string {
  return getNestedText(order?.orderId, order?.legacyOrderId, order?.salesRecordReference);
}

function extractBuyerUsername(order: any): string {
  return getNestedText(order?.buyer?.username, order?.buyer?.userId);
}

function getOrderPaymentStatus(order: any): string {
  return toText(order?.orderPaymentStatus || order?.paymentSummary?.payments?.[0]?.paymentStatus).toUpperCase();
}

function getOrderFulfillmentStatus(order: any): string {
  return toText(order?.orderFulfillmentStatus || order?.orderFulfillmentState).toUpperCase();
}

function getOrderCancelStatus(order: any): string {
  return toText(order?.cancelStatus?.cancelState || order?.cancelStatus?.cancelStatus).toUpperCase();
}

function isCancelled(order: any): boolean {
  const status = getOrderCancelStatus(order);
  return Boolean(status && !["NONE_REQUESTED", "NOT_REQUESTED", "CANCEL_REJECTED"].includes(status));
}

function isPaidOrClosedSale(order: any): boolean {
  const paymentStatus = getOrderPaymentStatus(order);
  const fulfillmentStatus = getOrderFulfillmentStatus(order);
  return ["PAID", "FULLY_REFUNDED", "PARTIALLY_REFUNDED"].includes(paymentStatus)
    || ["FULFILLED", "IN_PROGRESS"].includes(fulfillmentStatus)
    || isCancelled(order);
}

function inferOrderStatus(order: any): "pending" | "partially_fulfilled" | "fulfilled" | "cancelled" | "archived" {
  if (isCancelled(order)) return "cancelled";
  const fulfillmentStatus = getOrderFulfillmentStatus(order);
  const paymentStatus = getOrderPaymentStatus(order);
  if (fulfillmentStatus === "FULFILLED") return "fulfilled";
  if (fulfillmentStatus === "IN_PROGRESS") return "partially_fulfilled";
  if (paymentStatus === "PAID" && fulfillmentStatus === "NOT_STARTED") return "pending";
  return "archived";
}

function inferLineStatus(order: any): "pending" | "partially_fulfilled" | "fulfilled" | "cancelled" | "skipped" {
  const orderStatus = inferOrderStatus(order);
  if (orderStatus === "cancelled") return "cancelled";
  if (orderStatus === "fulfilled") return "fulfilled";
  if (orderStatus === "partially_fulfilled") return "partially_fulfilled";
  if (orderStatus === "pending") return "pending";
  return "skipped";
}

function extractShipTo(order: any): any {
  const instruction = Array.isArray(order?.fulfillmentStartInstructions)
    ? order.fulfillmentStartInstructions[0]
    : null;
  return instruction?.shippingStep?.shipTo || {};
}

function extractShipByDate(order: any): string | null {
  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const dates = lineItems
    .map((line: any) => toIsoDate(line?.lineItemFulfillmentInstructions?.shipByDate || line?.shipByDate))
    .filter(Boolean)
    .sort();
  return dates[0] || null;
}

function extractShippedDate(order: any): string | null {
  const fulfillments = Array.isArray(order?.fulfillmentHrefs) ? order.fulfillmentHrefs : [];
  if (fulfillments.length) return toIsoDate(order?.lastModifiedDate);
  return toIsoDate(order?.lastModifiedDate || order?.creationDate);
}

function extractLineSku(line: any): string {
  return normalizeSku(getNestedText(
    line?.sku,
    line?.legacyVariationSku,
    line?.lineItemFulfillmentInstructions?.sku,
    line?.inventoryReferenceId,
    line?.properties?.sku,
  ));
}

function normalizeLineTitle(value: unknown): string {
  return toText(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function lineExactKey(orderId: string, itemNumber: unknown, transactionId: unknown): string {
  return `${orderId}:${toText(itemNumber)}:${toText(transactionId)}`;
}

function lineFallbackKey(orderId: string, itemNumber: unknown, title: unknown, quantity: unknown): string {
  return `${orderId}:${toText(itemNumber)}:${normalizeLineTitle(title)}:${Math.max(1, Math.trunc(Number(quantity || 1)))}`;
}

async function getEbayAccessToken(): Promise<string> {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REFRESH_TOKEN) {
    throw new Error("Missing eBay OAuth secrets. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REFRESH_TOKEN.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: EBAY_REFRESH_TOKEN,
    scope: EBAY_ORDER_SCOPE,
  });

  const res = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`eBay OAuth refresh failed (${res.status}): ${text.slice(0, 800)}`);
  const payload = JSON.parse(text);
  if (!payload.access_token) throw new Error("eBay OAuth response did not include an access_token.");
  return payload.access_token;
}

async function ebayRequest(token: string, path: string): Promise<any> {
  const res = await fetch(`${EBAY_API_BASE}${path}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
    },
  });

  const text = await res.text();
  let payload: any = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!res.ok) throw new Error(`eBay GET ${path} failed (${res.status}): ${text.slice(0, 1000)}`);
  return payload;
}

function toDateOrNull(value: unknown): Date | null {
  const iso = toIsoDate(value);
  return iso ? new Date(iso) : null;
}

async function fetchHistoryOrders(
  token: string,
  buyerUsername: string,
  fromDate: Date,
  toDate: Date,
  maxScannedOrders: number,
  windowDays = DEFAULT_WINDOW_DAYS,
) {
  const buyerKey = normalizeBuyerKey(buyerUsername);
  const since = fromDate;
  const orders: any[] = [];
  let scannedOrders = 0;
  let windowsScanned = 0;

  for (let windowEnd = toDate; windowEnd > since && scannedOrders < maxScannedOrders;) {
    const windowStart = new Date(Math.max(
      since.getTime(),
      windowEnd.getTime() - windowDays * 24 * 60 * 60 * 1000,
    ));
    windowsScanned += 1;

    for (let offset = 0; scannedOrders < maxScannedOrders; offset += PAGE_LIMIT) {
      const pageLimit = Math.min(PAGE_LIMIT, maxScannedOrders - scannedOrders);
      const params = new URLSearchParams({
        limit: String(pageLimit),
        offset: String(offset),
        filter: `creationdate:[${windowStart.toISOString()}..${windowEnd.toISOString()}]`,
      });
      const payload = await ebayRequest(token, `/sell/fulfillment/v1/order?${params.toString()}`);
      const pageOrders = Array.isArray(payload.orders) ? payload.orders : [];
      scannedOrders += pageOrders.length;
      orders.push(...pageOrders.filter((order: any) => {
        if (!isPaidOrClosedSale(order)) return false;
        if (!buyerKey) return true;
        return normalizeBuyerKey(extractBuyerUsername(order)) === buyerKey;
      }));
      if (!payload.next || pageOrders.length < pageLimit) break;
    }

    windowEnd = new Date(windowStart.getTime() - 1);
  }

  return {
    orders: [...new Map(orders.map((order) => [extractOrderNumber(order), order])).values()],
    scannedOrders,
    windowsScanned,
  };
}

async function loadItemMapBySku(supabase: any, skus: string[]): Promise<Map<string, any>> {
  const bySku = new Map<string, any>();
  const wanted = unique(skus.map(normalizeSku).filter(Boolean));
  for (let index = 0; index < wanted.length; index += 100) {
    const chunk = wanted.slice(index, index + 100);
    const { data, error } = await supabase
      .from("item_types")
      .select("id,title,barcode,deleted_at")
      .in("barcode", chunk)
      .is("deleted_at", null);
    if (error) throw error;
    (data || []).forEach((item: any) => {
      const sku = normalizeSku(item.barcode);
      if (sku) bySku.set(sku, item);
    });
  }
  return bySku;
}

async function loadExistingOrders(supabase: any, orderNumbers: string[]): Promise<Map<string, any>> {
  const existing = new Map<string, any>();
  for (let index = 0; index < orderNumbers.length; index += 100) {
    const chunk = orderNumbers.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_orders")
      .select("id,order_number,status,raw_payload")
      .in("order_number", chunk);
    if (error) throw error;
    (data || []).forEach((order: any) => existing.set(order.order_number, order));
  }
  return existing;
}

async function loadExistingLines(supabase: any, orderIds: string[]) {
  const exact = new Map<string, any>();
  const fallback = new Map<string, any>();
  for (let index = 0; index < orderIds.length; index += 100) {
    const chunk = orderIds.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_order_lines")
      .select("id,order_id,item_number,transaction_id,item_title,quantity,line_status,fulfilled_at,internal_item_id")
      .in("order_id", chunk)
      .order("created_at", { ascending: true });
    if (error) throw error;
    (data || []).forEach((line: any) => {
      const exactKey = lineExactKey(line.order_id, line.item_number, line.transaction_id);
      const fallbackKey = lineFallbackKey(line.order_id, line.item_number, line.item_title, line.quantity);
      if (!exact.has(exactKey)) exact.set(exactKey, line);
      if (!fallback.has(fallbackKey)) fallback.set(fallbackKey, line);
    });
  }
  return { exact, fallback };
}

async function recordBuyerSyncStatus(supabase: any, buyerUsername: string, values: JsonRecord) {
  const buyerKey = normalizeBuyerKey(buyerUsername);
  if (!buyerKey) return;

  const row = {
    buyer_key: buyerKey,
    buyer_username: buyerUsername,
    ...values,
  };

  const { error } = await supabase
    .from("ebay_buyer_history_syncs")
    .upsert(row, {
      onConflict: "buyer_key",
      ignoreDuplicates: false,
    });
  if (error) throw error;
}

async function createAccountSyncRun(supabase: any, values: JsonRecord): Promise<string | null> {
  const { data, error } = await supabase
    .from("ebay_account_history_sync_runs")
    .insert(values)
    .select("id")
    .maybeSingle();
  if (error) {
    console.warn("Could not create account history sync run:", error);
    return null;
  }
  return data?.id || null;
}

async function updateAccountSyncRun(supabase: any, runId: string | null, values: JsonRecord) {
  if (!runId) return;
  const { error } = await supabase
    .from("ebay_account_history_sync_runs")
    .update(values)
    .eq("id", runId);
  if (error) console.warn("Could not update account history sync run:", error);
}

function findExistingLine(existingLines: any, orderId: string, line: any): any | null {
  return existingLines.exact.get(lineExactKey(orderId, line.item_number, line.transaction_id))
    || existingLines.fallback.get(lineFallbackKey(orderId, line.item_number, line.item_title, line.quantity))
    || null;
}

function prepareOrder(order: any, itemBySku: Map<string, any>, existingOrder: any | null, sourceName = "ebay_buyer_history_sync") {
  const orderNumber = extractOrderNumber(order);
  const shipTo = extractShipTo(order);
  const payment = Array.isArray(order?.paymentSummary?.payments) ? order.paymentSummary.payments[0] : null;
  const buyer = order?.buyer || {};
  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const inferredStatus = inferOrderStatus(order);
  const keepLocalClosed = ["fulfilled", "cancelled", "archived"].includes(String(existingOrder?.status || "").toLowerCase());
  const orderStatus = keepLocalClosed ? existingOrder.status : inferredStatus;
  const shippedOnDate = inferredStatus === "fulfilled" ? extractShippedDate(order) : null;

  const lines = lineItems.map((line: any, index: number) => {
    const sku = extractLineSku(line);
    const matchedItem = sku ? itemBySku.get(sku) : null;
    const quantity = Math.max(1, Math.trunc(Number(line?.quantity || 1)));
    const transactionId = getNestedText(line?.lineItemId, line?.transactionId, `${orderNumber}:${index + 1}`);
    const itemNumber = getNestedText(line?.legacyItemId, line?.itemId, line?.listingMarketplaceId, transactionId);
    const lineTotal = toMoney(line?.total || line?.lineItemCost);
    const lineStatus = inferLineStatus(order);
    const fulfilledQuantity = ["fulfilled", "cancelled", "skipped"].includes(lineStatus) ? quantity : 0;
    const closedAt = toIsoDate(order?.lastModifiedDate || order?.cancelStatus?.cancelCloseDate || order?.creationDate);
    const fulfilledAt = ["fulfilled", "cancelled", "skipped"].includes(lineStatus)
      ? shippedOnDate || closedAt
      : null;

    return {
      item_number: itemNumber,
      transaction_id: transactionId,
      item_title: getNestedText(line?.title, matchedItem?.title, "eBay item"),
      custom_label: sku || null,
      quantity,
      sold_for: quantity > 0 ? Number((lineTotal / quantity || toMoney(line?.lineItemCost)).toFixed(2)) : lineTotal,
      shipping_and_handling: toMoney(line?.deliveryCost),
      total_price: lineTotal,
      net_payout: null,
      line_status: lineStatus,
      fulfilled_quantity: fulfilledQuantity,
      fulfilled_at: fulfilledAt,
      internal_item_id: matchedItem?.id || null,
      raw_payload: {
        source: sourceName,
        orderPaymentStatus: getOrderPaymentStatus(order),
        orderFulfillmentStatus: getOrderFulfillmentStatus(order),
        orderCancelStatus: getOrderCancelStatus(order),
        line,
      },
    };
  }).filter((line: any) => line.transaction_id && line.item_number);

  return {
    order: {
      order_number: orderNumber,
      sales_record_number: getNestedText(order?.salesRecordReference, order?.legacyOrderId),
      buyer_username: getNestedText(buyer?.username, buyer?.userId),
      buyer_name: getNestedText(shipTo?.fullName, buyer?.buyerRegistrationAddress?.fullName),
      buyer_email: getNestedText(shipTo?.email, buyer?.email),
      item_location: getNestedText(shipTo?.contactAddress?.city, shipTo?.primaryPhone?.phoneNumber),
      item_zip_code: getNestedText(shipTo?.contactAddress?.postalCode),
      item_country: getNestedText(shipTo?.contactAddress?.countryCode),
      payment_method: getNestedText(payment?.paymentMethod, payment?.paymentStatus),
      sale_date: toIsoDate(order?.creationDate),
      paid_on_date: toIsoDate(payment?.paymentDate || order?.creationDate),
      ship_by_date: extractShipByDate(order),
      shipped_on_date: shippedOnDate,
      tracking_number: "",
      shipping_service: "",
      shipping_and_handling: toMoney(order?.pricingSummary?.deliveryCost),
      seller_collected_tax: toMoney(order?.pricingSummary?.tax),
      ebay_collected_tax: 0,
      ebay_collected_charges: 0,
      total_price: toMoney(order?.pricingSummary?.total),
      net_payout: null,
      status: orderStatus,
      imported_by: null,
      raw_payload: {
        ...(existingOrder?.raw_payload && typeof existingOrder.raw_payload === "object" ? existingOrder.raw_payload : {}),
        source: sourceName,
        buyer_history_synced_at: new Date().toISOString(),
        account_history_synced_at: sourceName === "ebay_account_history_sync" ? new Date().toISOString() : undefined,
        orderPaymentStatus: getOrderPaymentStatus(order),
        orderFulfillmentStatus: getOrderFulfillmentStatus(order),
        orderCancelStatus: getOrderCancelStatus(order),
        order,
      },
    },
    lines,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  let supabase: any = null;
  let statusBuyerUsername = "";
  let statusDryRun = true;
  let statusDaysBack = DEFAULT_DAYS_BACK;
  let statusMaxScannedOrders = DEFAULT_MAX_SCANNED_ORDERS;
  let accountRunId: string | null = null;

  try {
    const body = await req.json().catch(() => ({}));
    const scanAllBuyers = body.scanAllBuyers === true || toText(body.mode).toLowerCase() === "account";
    const buyerUsername = toText(body.buyerUsername);
    if (!scanAllBuyers && !buyerUsername) {
      return jsonResponse(400, { ok: false, error: "buyerUsername is required unless scanAllBuyers is true" });
    }

    const dryRun = body.dryRun === true;
    const daysBack = Math.min(Math.max(Math.trunc(Number(body.daysBack || DEFAULT_DAYS_BACK)), 1), MAX_DAYS_BACK);
    const now = new Date();
    const requestedTo = toDateOrNull(body.to) || now;
    const requestedFrom = toDateOrNull(body.from) || new Date(requestedTo.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const oldestAllowed = new Date(now.getTime() - MAX_DAYS_BACK * 24 * 60 * 60 * 1000);
    const fromDate = requestedFrom < oldestAllowed ? oldestAllowed : requestedFrom;
    const toDate = requestedTo > now ? now : requestedTo;
    if (fromDate >= toDate) {
      return jsonResponse(400, { ok: false, error: "The eBay history sync date range is invalid." });
    }
    const rangeDays = Math.max(1, Math.ceil((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000)));
    const windowDays = Math.min(Math.max(Math.trunc(Number(body.windowDays || DEFAULT_WINDOW_DAYS)), 1), 90);
    const chunkKey = toText(body.chunkKey);
    const defaultMaxScannedOrders = scanAllBuyers ? DEFAULT_ACCOUNT_MAX_SCANNED_ORDERS : DEFAULT_MAX_SCANNED_ORDERS;
    const maxScannedOrders = Math.min(
      Math.max(Math.trunc(Number(body.maxScannedOrders || defaultMaxScannedOrders)), 50),
      scanAllBuyers ? 50000 : 10000,
    );

    statusBuyerUsername = buyerUsername;
    statusDryRun = dryRun;
    statusDaysBack = rangeDays;
    statusMaxScannedOrders = maxScannedOrders;

    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    if (scanAllBuyers && !dryRun) {
      accountRunId = await createAccountSyncRun(supabase, {
        status: "running",
        dry_run: dryRun,
        days_back: rangeDays,
        max_scanned_orders: maxScannedOrders,
        started_at: new Date().toISOString(),
        raw_payload: {
          source: "ebay_account_history_sync",
          requestedFrom: fromDate.toISOString(),
          requestedTo: toDate.toISOString(),
          requestedDaysBack: daysBack,
          chunkKey,
        },
      });
    } else if (!dryRun) {
      await recordBuyerSyncStatus(supabase, buyerUsername, {
        status: "running",
        days_back: rangeDays,
        max_scanned_orders: maxScannedOrders,
        scanned_orders: 0,
        matched_orders: 0,
        orders_upserted: 0,
        lines_upserted: 0,
        skipped_new_open_orders: 0,
        windows_scanned: 0,
        last_started_at: new Date().toISOString(),
        last_error: null,
        raw_payload: {
          source: "ebay_buyer_history_sync",
          dryRun,
        },
      });
    }

    const token = await getEbayAccessToken();
    const { orders, scannedOrders, windowsScanned } = await fetchHistoryOrders(
      token,
      scanAllBuyers ? "" : buyerUsername,
      fromDate,
      toDate,
      maxScannedOrders,
      windowDays,
    );
    const matchedOrders = orders.length;
    const orderNumbers = unique(orders.map(extractOrderNumber).filter(Boolean));
    const existingOrders = await loadExistingOrders(supabase, orderNumbers);
    const skus = unique(orders.flatMap((order) =>
      (Array.isArray(order?.lineItems) ? order.lineItems : []).map(extractLineSku).filter(Boolean)
    ));
    const itemBySku = await loadItemMapBySku(supabase, skus);
    let skippedNewOpenOrders = 0;
    const skippedNewOpenOrdersByBuyer = new Map<string, number>();
    const sourceName = scanAllBuyers ? "ebay_account_history_sync" : "ebay_buyer_history_sync";
    const prepared = orders.flatMap((order) => {
      const orderNumber = extractOrderNumber(order);
      const existingOrder = existingOrders.get(orderNumber) || null;
      const status = inferOrderStatus(order);
      if (!existingOrder && ["pending", "partially_fulfilled"].includes(status)) {
        skippedNewOpenOrders += 1;
        const buyerKey = normalizeBuyerKey(extractBuyerUsername(order)) || "unknown";
        skippedNewOpenOrdersByBuyer.set(buyerKey, (skippedNewOpenOrdersByBuyer.get(buyerKey) || 0) + 1);
        return [];
      }
      return [prepareOrder(order, itemBySku, existingOrder, sourceName)];
    });
    const buyerKeysSeen = unique(orders.map(extractBuyerUsername).map(normalizeBuyerKey).filter(Boolean));
    const buyersSeen = buyerKeysSeen.length;

    if (dryRun) {
      return jsonResponse(200, {
        ok: true,
        dryRun: true,
        mode: scanAllBuyers ? "account" : "buyer",
        buyerUsername,
        daysBack: rangeDays,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        scannedOrders,
        windowsScanned,
        buyersSeen,
        buyerKeys: scanAllBuyers ? buyerKeysSeen : undefined,
        matchedOrders,
        existingOrders: prepared.filter((entry) => existingOrders.has(entry.order.order_number)).length,
        newOrders: prepared.filter((entry) => !existingOrders.has(entry.order.order_number)).length,
        skippedNewOpenOrders,
        lineCount: prepared.reduce((sum, entry) => sum + entry.lines.length, 0),
      });
    }

    let upsertedOrders: any[] = [];
    if (prepared.length) {
      const { data, error } = await supabase
        .from("ebay_orders")
        .upsert(prepared.map((entry) => entry.order), {
          onConflict: "order_number",
          ignoreDuplicates: false,
        })
        .select("id,order_number,status");
      if (error) throw error;
      upsertedOrders = data || [];
    }

    const orderIdByNumber = new Map(upsertedOrders.map((order) => [order.order_number, order.id]));
    const existingLines = await loadExistingLines(supabase, upsertedOrders.map((order) => order.id));
    const lineRows = prepared.flatMap((entry) => {
      const orderId = orderIdByNumber.get(entry.order.order_number);
      if (!orderId) return [];
      return entry.lines.map((line) => {
        const existing = findExistingLine(existingLines, orderId, line);
        const existingClosed = ["fulfilled", "cancelled", "skipped"].includes(String(existing?.line_status || "").toLowerCase());
        return {
          ...line,
          order_id: orderId,
          item_number: existing?.item_number || line.item_number,
          transaction_id: existing?.transaction_id || line.transaction_id,
          internal_item_id: line.internal_item_id || existing?.internal_item_id || null,
          line_status: existingClosed ? existing.line_status : line.line_status,
          fulfilled_quantity: existingClosed ? existing.quantity : line.fulfilled_quantity,
          fulfilled_at: existingClosed ? existing.fulfilled_at || line.fulfilled_at : line.fulfilled_at,
        };
      });
    });

    let upsertedLines: any[] = [];
    if (lineRows.length) {
      const { data, error } = await supabase
        .from("ebay_order_lines")
        .upsert(lineRows, {
          onConflict: "order_id,item_number,transaction_id",
          ignoreDuplicates: false,
        })
        .select("id,line_status");
      if (error) throw error;
      upsertedLines = data || [];
    }

    const fulfilledLines = upsertedLines.filter((line) => String(line.line_status).toLowerCase() === "fulfilled").length;
    const cancelledLines = upsertedLines.filter((line) => String(line.line_status).toLowerCase() === "cancelled").length;
    const upsertedOrderNumbers = new Set(upsertedOrders.map((order) => order.order_number));

    if (scanAllBuyers) {
      const preparedByBuyer = new Map<string, any[]>();
      prepared.forEach((entry) => {
        const buyerKey = normalizeBuyerKey(entry.order.buyer_username) || "unknown";
        if (!preparedByBuyer.has(buyerKey)) preparedByBuyer.set(buyerKey, []);
        preparedByBuyer.get(buyerKey)?.push(entry);
      });
      for (const [buyerKey, entries] of preparedByBuyer.entries()) {
        const displayBuyer = entries[0]?.order?.buyer_username || buyerKey;
        await recordBuyerSyncStatus(supabase, displayBuyer, {
          status: "completed",
          days_back: rangeDays,
          max_scanned_orders: maxScannedOrders,
          scanned_orders: scannedOrders,
          matched_orders: entries.length,
          orders_upserted: entries.filter((entry) => upsertedOrderNumbers.has(entry.order.order_number)).length,
          lines_upserted: entries.reduce((sum, entry) => sum + entry.lines.length, 0),
          skipped_new_open_orders: skippedNewOpenOrdersByBuyer.get(buyerKey) || 0,
          windows_scanned: windowsScanned,
          last_success_at: new Date().toISOString(),
          last_error: null,
          raw_payload: {
            source: "ebay_account_history_sync",
            accountWide: true,
            requestedFrom: fromDate.toISOString(),
            requestedTo: toDate.toISOString(),
            chunkKey,
            fulfilledLines: entries.reduce((sum, entry) => sum + entry.lines.filter((line: any) => String(line.line_status).toLowerCase() === "fulfilled").length, 0),
            cancelledLines: entries.reduce((sum, entry) => sum + entry.lines.filter((line: any) => String(line.line_status).toLowerCase() === "cancelled").length, 0),
          },
        });
      }
      await updateAccountSyncRun(supabase, accountRunId, {
        status: "completed",
        scanned_orders: scannedOrders,
        matched_orders: matchedOrders,
        orders_upserted: upsertedOrders.length,
        lines_upserted: upsertedLines.length,
        buyers_seen: buyersSeen,
        skipped_new_open_orders: skippedNewOpenOrders,
        windows_scanned: windowsScanned,
        finished_at: new Date().toISOString(),
        raw_payload: {
          source: "ebay_account_history_sync",
          requestedFrom: fromDate.toISOString(),
          requestedTo: toDate.toISOString(),
          chunkKey,
          fulfilledLines,
          cancelledLines,
        },
      });
    } else {
      await recordBuyerSyncStatus(supabase, buyerUsername, {
        status: "completed",
        days_back: rangeDays,
        max_scanned_orders: maxScannedOrders,
        scanned_orders: scannedOrders,
        matched_orders: matchedOrders,
        orders_upserted: upsertedOrders.length,
        lines_upserted: upsertedLines.length,
        skipped_new_open_orders: skippedNewOpenOrders,
        windows_scanned: windowsScanned,
        last_success_at: new Date().toISOString(),
        last_error: null,
        raw_payload: {
          source: "ebay_buyer_history_sync",
          fulfilledLines,
          cancelledLines,
        },
      });
    }

    return jsonResponse(200, {
      ok: true,
      dryRun: false,
      mode: scanAllBuyers ? "account" : "buyer",
      buyerUsername,
      daysBack: rangeDays,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      scannedOrders,
      windowsScanned,
      buyersSeen,
      buyerKeys: scanAllBuyers ? buyerKeysSeen : undefined,
      matchedOrders,
      ordersUpserted: upsertedOrders.length,
      linesUpserted: upsertedLines.length,
      skippedNewOpenOrders,
      fulfilledLines,
      cancelledLines,
    });
  } catch (error) {
    if (supabase && accountRunId) {
      await updateAccountSyncRun(supabase, accountRunId, {
        status: "failed",
        error: compactError(error),
        finished_at: new Date().toISOString(),
      });
    }
    if (supabase && statusBuyerUsername && !statusDryRun) {
      try {
        await recordBuyerSyncStatus(supabase, statusBuyerUsername, {
          status: "failed",
          days_back: statusDaysBack,
          max_scanned_orders: statusMaxScannedOrders,
          last_error: compactError(error),
          raw_payload: {
            source: "ebay_buyer_history_sync",
            failedAt: new Date().toISOString(),
          },
        });
      } catch (statusError) {
        console.warn("Failed to record buyer history sync failure:", statusError);
      }
    }
    return jsonResponse(500, {
      ok: false,
      error: compactError(error),
    });
  }
});
