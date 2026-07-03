import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

type PreparedOrder = {
  source: any;
  order: JsonRecord & { order_number: string };
  lines: Array<JsonRecord & { transaction_id: string; item_number: string; custom_label: string | null }>;
};

type ExistingLineIndex = {
  exact: Map<string, any>;
  fallback: Map<string, any>;
};

type LocalOpenOrderSummary = {
  id: string;
  orderNumber: string;
  buyerUsername: string;
  shipByDate: string | null;
  status: string;
  lineCount: number;
};

type LocalOrderMismatch = LocalOpenOrderSummary & {
  reason: string;
  message: string;
  ebayPaymentStatus: string;
  ebayFulfillmentStatus: string;
  ebayCancelStatus: string;
  fetchError?: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const EBAY_CLIENT_ID = (Deno.env.get("EBAY_CLIENT_ID") ?? Deno.env.get("EBAY_APP_ID") ?? "").trim();
const EBAY_CLIENT_SECRET = (Deno.env.get("EBAY_CLIENT_SECRET") ?? Deno.env.get("EBAY_CERT_ID") ?? "").trim();
const EBAY_REFRESH_TOKEN = (Deno.env.get("EBAY_REFRESH_TOKEN") ?? "").trim();
const EBAY_ENV = (Deno.env.get("EBAY_ENV") ?? "production").trim().toLowerCase();
const EBAY_FINANCES_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.finances";
const EBAY_ORDER_SCOPE = unique([
  ...String(Deno.env.get("EBAY_ORDER_SCOPE") ??
    "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.inventory").split(/\s+/),
  EBAY_FINANCES_SCOPE,
].map(toText).filter(Boolean)).join(" ");

const EBAY_API_BASE = EBAY_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const DEFAULT_DAYS_BACK = 14;
const MAX_ORDER_LIMIT = 1000;
const PAGE_LIMIT = 50;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CLOSED_LOCAL_ORDER_STATUSES = new Set(["fulfilled", "cancelled", "archived"]);
const CLOSED_LOCAL_LINE_STATUSES = new Set(["fulfilled", "cancelled", "skipped"]);

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

function toMoney(value: unknown): number {
  const raw = typeof value === "object" && value !== null && "value" in value
    ? (value as JsonRecord).value
    : value;
  const numeric = Number(raw || 0);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0;
}

function toIsoDate(value: unknown): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toText(value: unknown): string {
  return String(value || "").trim();
}

function normalizeSku(value: unknown): string {
  return toText(value).replace(/\s+/g, "-").slice(0, 50);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
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
  if (!res.ok) {
    throw new Error(`eBay OAuth refresh failed (${res.status}): ${text.slice(0, 800)}`);
  }

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
  if (!res.ok) {
    throw new Error(`eBay GET ${path} failed (${res.status}): ${text.slice(0, 1000)}`);
  }
  return payload;
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

function getOrderPaymentStatus(order: any): string {
  return toText(order?.orderPaymentStatus || order?.paymentSummary?.payments?.[0]?.paymentStatus).toUpperCase();
}

function getOrderFulfillmentStatus(order: any): string {
  return toText(order?.orderFulfillmentStatus || order?.orderFulfillmentState).toUpperCase();
}

function getOrderCancelStatus(order: any): string {
  return toText(order?.cancelStatus?.cancelState || order?.cancelStatus?.cancelStatus).toUpperCase();
}

function normalizeFinanceTransactionStatus(value: unknown): string {
  const status = toText(value).toUpperCase();
  if (status.includes("HOLD")) return "on_hold";
  if (status.includes("PROCESS")) return "processing";
  if (status.includes("AVAILABLE")) return "available";
  if (status.includes("PAYOUT") || status.includes("PAID")) return "paid_out";
  return status ? "unknown" : "";
}

function getFinanceStatusLabel(status: string): string {
  if (status === "on_hold") return "On hold";
  if (status === "paid_out") return "Paid out";
  if (status === "available") return "Available";
  if (status === "processing") return "Processing";
  return status ? "Payout unknown" : "";
}

function getFinanceStatusRank(status: string): number {
  if (status === "on_hold") return 50;
  if (status === "processing") return 40;
  if (status === "available") return 30;
  if (status === "paid_out") return 20;
  return 10;
}

function getFinanceTransactionId(transaction: any): string {
  return getNestedText(transaction?.transactionId, transaction?.transaction_id, transaction?.id);
}

function getFinanceTransactionAmount(transaction: any): number {
  return toMoney(
    transaction?.amount
      || transaction?.transactionAmount
      || transaction?.netAmount
      || transaction?.totalAmount
  );
}

function getFinanceLineItemIds(transaction: any): string[] {
  const items = Array.isArray(transaction?.orderLineItems) ? transaction.orderLineItems : [];
  return unique(items.flatMap((item: any) => [
    item?.lineItemId,
    item?.legacyItemId,
    item?.transactionId,
  ]).map(toText).filter(Boolean));
}

function summarizeFinanceTransactions(transactions: any[], orderNumber: string, lineItemId = ""): JsonRecord | null {
  const relevant = transactions.filter((transaction) => {
    if (!lineItemId) return true;
    const lineIds = getFinanceLineItemIds(transaction);
    return !lineIds.length || lineIds.includes(lineItemId);
  });
  if (!relevant.length) return null;

  const compactTransactions = relevant.map((transaction) => {
    const status = normalizeFinanceTransactionStatus(transaction?.transactionStatus);
    const payoutId = getNestedText(transaction?.payoutId, transaction?.payoutReferenceId);
    return {
      transactionId: getFinanceTransactionId(transaction),
      transactionType: toText(transaction?.transactionType),
      transactionStatus: toText(transaction?.transactionStatus),
      status,
      payoutId,
      transactionDate: toIsoDate(transaction?.transactionDate || transaction?.bookingEntry || transaction?.createdDate),
      memo: toText(transaction?.transactionMemo),
      amount: getFinanceTransactionAmount(transaction),
      lineItemIds: getFinanceLineItemIds(transaction),
    };
  });

  const winningStatus = compactTransactions
    .map((transaction) => String(transaction.status || ""))
    .filter(Boolean)
    .sort((left, right) => getFinanceStatusRank(right) - getFinanceStatusRank(left))[0] || "unknown";
  const payoutIds = unique(compactTransactions.map((transaction: any) => toText(transaction.payoutId)).filter(Boolean));
  const transactionIds = unique(compactTransactions.map((transaction: any) => toText(transaction.transactionId)).filter(Boolean));
  const lineItemIds = unique(compactTransactions.flatMap((transaction: any) => transaction.lineItemIds || []).map(toText).filter(Boolean));
  const memos = unique(compactTransactions.map((transaction: any) => toText(transaction.memo)).filter(Boolean));

  return {
    source: "ebay_finances_api",
    syncedAt: new Date().toISOString(),
    orderNumber,
    lineItemId: lineItemId || null,
    status: winningStatus,
    statusLabel: getFinanceStatusLabel(winningStatus),
    payoutIds,
    transactionIds,
    lineItemIds,
    memo: memos[0] || "",
    transactions: compactTransactions.slice(0, 20),
  };
}

async function fetchFinanceTransactionsForOrder(token: string, orderNumber: string): Promise<any[]> {
  const transactions: any[] = [];
  let offset = 0;
  const limit = 100;
  while (transactions.length < 500) {
    const params = new URLSearchParams({
      filter: `orderId:{${orderNumber}}`,
      limit: String(limit),
      offset: String(offset),
    });
    const payload = await ebayRequest(token, `/sell/finances/v1/transaction?${params.toString()}`);
    const page = Array.isArray(payload?.transactions) ? payload.transactions : [];
    transactions.push(...page);
    if (!payload?.next || page.length < limit) break;
    offset += limit;
  }
  return transactions;
}

async function loadFinanceTransactionsByOrder(token: string, orderNumbers: string[], syncFinance: boolean) {
  const byOrder = new Map<string, any[]>();
  const warnings: JsonRecord[] = [];
  if (!syncFinance) return { byOrder, warnings };
  for (const orderNumber of unique(orderNumbers.map(toText).filter(Boolean))) {
    try {
      byOrder.set(orderNumber, await fetchFinanceTransactionsForOrder(token, orderNumber));
    } catch (error) {
      warnings.push({
        orderNumber,
        reason: "ebay_finance_lookup_failed",
        message: compactError(error),
      });
    }
  }
  return { byOrder, warnings };
}

function isPaidOrder(order: any): boolean {
  return getOrderPaymentStatus(order) === "PAID";
}

function isAwaitingShipmentOrder(order: any): boolean {
  const fulfillmentStatus = getOrderFulfillmentStatus(order);
  const cancelStatus = getOrderCancelStatus(order);
  const notCancelled = !cancelStatus || cancelStatus === "NONE_REQUESTED" || cancelStatus === "NOT_REQUESTED";
  return isPaidOrder(order)
    && ["NOT_STARTED", "IN_PROGRESS"].includes(fulfillmentStatus)
    && notCancelled;
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

function extractLineSku(line: any): string {
  return normalizeSku(getNestedText(
    line?.sku,
    line?.legacyVariationSku,
    line?.lineItemFulfillmentInstructions?.sku,
    line?.inventoryReferenceId,
    line?.properties?.sku
  ));
}

function prepareOrder(order: any, itemBySku: Map<string, any>, financeTransactions: any[] = []): PreparedOrder | null {
  const orderNumber = extractOrderNumber(order);
  if (!orderNumber) return null;

  const shipTo = extractShipTo(order);
  const payment = Array.isArray(order?.paymentSummary?.payments) ? order.paymentSummary.payments[0] : null;
  const buyer = order?.buyer || {};
  const lineItems = Array.isArray(order?.lineItems) ? order.lineItems : [];

  const preparedLines = lineItems.map((line: any, index: number) => {
    const sku = extractLineSku(line);
    const matchedItem = sku ? itemBySku.get(sku) : null;
    const quantity = Math.max(1, Math.trunc(Number(line?.quantity || 1)));
    const transactionId = getNestedText(line?.lineItemId, line?.transactionId, `${orderNumber}:${index + 1}`);
    const itemNumber = getNestedText(line?.legacyItemId, line?.itemId, line?.listingMarketplaceId, transactionId);
    const lineTotal = toMoney(line?.total || line?.lineItemCost);
    const ebayFinance = summarizeFinanceTransactions(financeTransactions, orderNumber, transactionId);

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
      line_status: "pending",
      internal_item_id: matchedItem?.id || null,
      raw_payload: {
        source: "ebay_fulfillment_api",
        orderPaymentStatus: getOrderPaymentStatus(order),
        ...(ebayFinance ? { ebayFinance } : {}),
        line,
      },
    };
  }).filter((line: any) => line.transaction_id && line.item_number);

  const orderFinance = summarizeFinanceTransactions(financeTransactions, orderNumber);

  return {
    source: order,
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
      shipped_on_date: null,
      tracking_number: "",
      shipping_service: "",
      shipping_and_handling: toMoney(order?.pricingSummary?.deliveryCost),
      seller_collected_tax: toMoney(order?.pricingSummary?.tax),
      ebay_collected_tax: 0,
      ebay_collected_charges: 0,
      total_price: toMoney(order?.pricingSummary?.total),
      net_payout: null,
      status: "pending",
      imported_by: null,
      raw_payload: {
        source: "ebay_fulfillment_api",
        orderPaymentStatus: getOrderPaymentStatus(order),
        ...(orderFinance ? { ebayFinance: orderFinance } : {}),
        order,
      },
    },
    lines: preparedLines,
  };
}

async function fetchOrders(token: string, body: JsonRecord): Promise<any[]> {
  const orderIds = Array.isArray(body.orderIds)
    ? unique(body.orderIds.map(toText).filter(Boolean)).slice(0, MAX_ORDER_LIMIT)
    : [];

  if (orderIds.length) {
    const orders = [];
    for (const orderId of orderIds) {
      orders.push(await ebayRequest(token, `/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`));
    }
    return orders;
  }

  const limit = Math.min(Math.max(Math.trunc(Number(body.limit || 50)), 1), MAX_ORDER_LIMIT);
  const daysBack = Math.min(Math.max(Math.trunc(Number(body.daysBack || DEFAULT_DAYS_BACK)), 1), 90);
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const orders: any[] = [];

  for (let offset = 0; orders.length < limit; offset += PAGE_LIMIT) {
    const pageLimit = Math.min(PAGE_LIMIT, limit - orders.length);
    const params = new URLSearchParams({
      limit: String(pageLimit),
      offset: String(offset),
      filter: `orderfulfillmentstatus:{NOT_STARTED|IN_PROGRESS},lastmodifieddate:[${since}..]`,
    });
    const payload = await ebayRequest(token, `/sell/fulfillment/v1/order?${params.toString()}`);
    const pageOrders = Array.isArray(payload.orders) ? payload.orders : [];
    orders.push(...pageOrders);
    if (!payload.next || pageOrders.length < pageLimit) break;
  }

  return orders.slice(0, limit);
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

async function updateExistingOrderFinancePayloads(
  supabase: any,
  prepared: PreparedOrder[],
  existingOrders: Map<string, any>,
) {
  const now = new Date().toISOString();
  for (const entry of prepared) {
    const existing = existingOrders.get(entry.order.order_number);
    const finance = entry.order.raw_payload?.ebayFinance;
    if (!existing?.id || !finance) continue;
    const rawPayload = existing.raw_payload && typeof existing.raw_payload === "object" ? existing.raw_payload : {};
    const { error } = await supabase
      .from("ebay_orders")
      .update({
        raw_payload: {
          ...rawPayload,
          ebayFinance: finance,
          last_ebay_finance_sync_at: now,
        },
        updated_at: now,
      })
      .eq("id", existing.id);
    if (error) throw error;
  }
}

async function loadExistingLines(supabase: any, orderIds: string[]): Promise<ExistingLineIndex> {
  const exact = new Map<string, any>();
  const fallback = new Map<string, any>();
  for (let index = 0; index < orderIds.length; index += 100) {
    const chunk = orderIds.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_order_lines")
      .select("id,order_id,item_number,transaction_id,item_title,quantity,line_status,internal_item_id")
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

function findExistingLine(existingLines: ExistingLineIndex, orderId: string, line: any): any | null {
  return existingLines.exact.get(lineExactKey(orderId, line.item_number, line.transaction_id))
    || existingLines.fallback.get(lineFallbackKey(orderId, line.item_number, line.item_title, line.quantity))
    || null;
}

async function loadLocalOpenOrderSummaries(supabase: any): Promise<LocalOpenOrderSummary[]> {
  const { data, error } = await supabase
    .from("ebay_order_lines")
    .select(`
      id,
      line_status,
      order_id,
      ebay_orders!inner(
        id,
        order_number,
        buyer_username,
        ship_by_date,
        status
      )
    `)
    .in("line_status", ["pending", "partially_fulfilled"])
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;

  const byOrder = new Map<string, LocalOpenOrderSummary>();
  (data || []).forEach((line: any) => {
    const order = line.ebay_orders || {};
    const orderNumber = toText(order.order_number);
    if (!orderNumber || CLOSED_LOCAL_ORDER_STATUSES.has(String(order.status || "").toLowerCase())) return;
    const existing = byOrder.get(orderNumber);
    if (existing) {
      existing.lineCount += 1;
      return;
    }
    byOrder.set(orderNumber, {
      id: order.id,
      orderNumber,
      buyerUsername: toText(order.buyer_username),
      shipByDate: order.ship_by_date || null,
      status: toText(order.status),
      lineCount: 1,
    });
  });

  return [...byOrder.values()];
}

async function verifyLocalOpenOrderMismatches(
  token: string,
  localOrders: LocalOpenOrderSummary[],
  seenOrderNumbers: Set<string>,
  limit: number,
): Promise<LocalOrderMismatch[]> {
  const toVerify = localOrders
    .filter((order) => !seenOrderNumbers.has(order.orderNumber))
    .slice(0, Math.max(0, limit));
  const mismatches: LocalOrderMismatch[] = [];

  for (const local of toVerify) {
    try {
      const ebayOrder = await ebayRequest(token, `/sell/fulfillment/v1/order/${encodeURIComponent(local.orderNumber)}`);
      if (isAwaitingShipmentOrder(ebayOrder)) continue;
      const paymentStatus = getOrderPaymentStatus(ebayOrder);
      const fulfillmentStatus = getOrderFulfillmentStatus(ebayOrder);
      const cancelStatus = getOrderCancelStatus(ebayOrder);
      mismatches.push({
        ...local,
        reason: "not_awaiting_shipment",
        message: "Local pending order is not currently reported by eBay as paid awaiting shipment. Verify before packing, cancelling, or completing it.",
        ebayPaymentStatus: paymentStatus,
        ebayFulfillmentStatus: fulfillmentStatus,
        ebayCancelStatus: cancelStatus,
      });
    } catch (error) {
      mismatches.push({
        ...local,
        reason: "order_lookup_failed",
        message: "Local pending order was not returned by the eBay awaiting-shipment sync and the follow-up order lookup failed. Verify this order in eBay before acting on it.",
        ebayPaymentStatus: "",
        ebayFulfillmentStatus: "",
        ebayCancelStatus: "",
        fetchError: compactError(error),
      });
    }
  }

  return mismatches;
}

function buildReturnedNotAwaitingMismatch(
  localByOrderNumber: Map<string, LocalOpenOrderSummary>,
  ebayOrder: any,
): LocalOrderMismatch | null {
  const orderNumber = extractOrderNumber(ebayOrder);
  const local = localByOrderNumber.get(orderNumber);
  if (!local) return null;
  const paymentStatus = getOrderPaymentStatus(ebayOrder);
  const fulfillmentStatus = getOrderFulfillmentStatus(ebayOrder);
  const cancelStatus = getOrderCancelStatus(ebayOrder);
  return {
    ...local,
    reason: "not_awaiting_shipment",
    message: "Local pending order was returned by eBay, but eBay no longer reports it as paid awaiting shipment. Verify before packing, cancelling, or completing it.",
    ebayPaymentStatus: paymentStatus,
    ebayFulfillmentStatus: fulfillmentStatus,
    ebayCancelStatus: cancelStatus,
  };
}

async function updateOrderSyncMismatchFlags(
  supabase: any,
  mismatches: LocalOrderMismatch[],
  clearedOrderNumbers: string[],
  runId: string | null,
) {
  const now = new Date().toISOString();
  const mismatchByOrderNumber = new Map(mismatches.map((entry) => [entry.orderNumber, entry]));
  const orderNumbers = unique([
    ...mismatches.map((entry) => entry.orderNumber),
    ...clearedOrderNumbers,
  ].map(toText).filter(Boolean));
  if (!orderNumbers.length) return;

  const { data, error } = await supabase
    .from("ebay_orders")
    .select("id,order_number,raw_payload")
    .in("order_number", orderNumbers);
  if (error) throw error;

  for (const order of data || []) {
    const mismatch = mismatchByOrderNumber.get(order.order_number);
    const rawPayload = order.raw_payload && typeof order.raw_payload === "object" ? order.raw_payload : {};
    const nextPayload = {
      ...rawPayload,
      last_ebay_order_sync_seen_at: mismatch ? rawPayload.last_ebay_order_sync_seen_at || null : now,
    };
    if (mismatch) {
      nextPayload.pending_order_sync_mismatch = {
        runId,
        detectedAt: now,
        reason: mismatch.reason,
        message: mismatch.message,
        ebayPaymentStatus: mismatch.ebayPaymentStatus,
        ebayFulfillmentStatus: mismatch.ebayFulfillmentStatus,
        ebayCancelStatus: mismatch.ebayCancelStatus,
        fetchError: mismatch.fetchError || null,
      };
    } else {
      delete nextPayload.pending_order_sync_mismatch;
    }

    const { error: updateError } = await supabase
      .from("ebay_orders")
      .update({
        raw_payload: nextPayload,
        updated_at: now,
      })
      .eq("id", order.id);
    if (updateError) throw updateError;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "Method not allowed" });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  let runId: string | null = null;
  let body: JsonRecord = {};

  try {
    body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun !== false;
    const shouldReserve = body.reserve !== false;

    const { data: run, error: runError } = await supabase
      .from("ebay_order_sync_runs")
      .insert({ dry_run: dryRun, status: "running" })
      .select("id")
      .single();
    if (runError) throw runError;
    runId = run.id;

    const token = await getEbayAccessToken();
    const rawOrders = await fetchOrders(token, body);
    const orderIdsRequested = Array.isArray(body.orderIds)
      ? unique(body.orderIds.map(toText).filter(Boolean)).slice(0, MAX_ORDER_LIMIT)
      : [];
    const requestedOrderLimit = orderIdsRequested.length
      ? orderIdsRequested.length
      : Math.min(Math.max(Math.trunc(Number(body.limit || 50)), 1), MAX_ORDER_LIMIT);
    const fetchedCompleteOrderWindow = orderIdsRequested.length > 0 || rawOrders.length < requestedOrderLimit;
    const checkLocalMismatches = body.checkLocalMismatches !== false;
    const localMismatchLimit = Math.min(Math.max(Math.trunc(Number(body.localMismatchLimit || MAX_ORDER_LIMIT)), 0), MAX_ORDER_LIMIT);
    const rawOrderNumbers = new Set(rawOrders.map(extractOrderNumber).filter(Boolean));
    const notAwaitingOrderNumbers = unique(rawOrders.filter((order) => !isAwaitingShipmentOrder(order)).map(extractOrderNumber).filter(Boolean));
    const candidateOrders = rawOrders.filter(isAwaitingShipmentOrder);
    const skippedUnpaid = rawOrders.filter((order) => !isPaidOrder(order)).length;
    const skippedNotAwaitingShipment = rawOrders.filter((order) =>
      isPaidOrder(order) && !isAwaitingShipmentOrder(order)
    ).length;
    const localOpenOrders = checkLocalMismatches ? await loadLocalOpenOrderSummaries(supabase) : [];
    const localByOrderNumber = new Map(localOpenOrders.map((order) => [order.orderNumber, order]));
    const returnedNotAwaitingMismatches = unique(rawOrders
      .filter((order) => !isAwaitingShipmentOrder(order))
      .map((order) => buildReturnedNotAwaitingMismatch(localByOrderNumber, order))
      .filter(Boolean) as LocalOrderMismatch[]);
    const localPendingMismatchCandidates = checkLocalMismatches
      ? localOpenOrders.filter((order) => !rawOrderNumbers.has(order.orderNumber)).length
      : 0;
    const missingLocalMismatches = checkLocalMismatches && fetchedCompleteOrderWindow
      ? await verifyLocalOpenOrderMismatches(token, localOpenOrders, rawOrderNumbers, localMismatchLimit)
      : [];
    const localPendingMismatches = [...new Map([
      ...returnedNotAwaitingMismatches,
      ...missingLocalMismatches,
    ].map((entry) => [entry.orderNumber, entry])).values()];
    const localMismatchWarnings = [
      ...(localPendingMismatches.length
        ? [{
          localPendingMismatches: localPendingMismatches.length,
          reason: "local_pending_not_in_ebay_awaiting_shipments",
          orders: localPendingMismatches,
        }]
        : []),
      ...(checkLocalMismatches && !fetchedCompleteOrderWindow
        ? [{
          localPendingMismatchCheckSkipped: true,
          reason: "ebay_order_fetch_reached_limit",
          message: "The eBay order fetch reached its limit, so local missing-order detection was skipped to avoid false alarms. Increase the sync limit and run again for a full mismatch check.",
          requestedOrderLimit,
        }]
        : []),
    ];

    if (!dryRun) {
      await updateOrderSyncMismatchFlags(supabase, localPendingMismatches, [...rawOrderNumbers], runId);
    }

    const allSkus = unique(candidateOrders.flatMap((order) =>
      (Array.isArray(order?.lineItems) ? order.lineItems : []).map(extractLineSku).filter(Boolean)
    ));
    const itemBySku = await loadItemMapBySku(supabase, allSkus);
    const syncFinance = body.syncFinance !== false;
    const { byOrder: financeByOrderNumber, warnings: financeWarnings } = await loadFinanceTransactionsByOrder(
      token,
      candidateOrders.map(extractOrderNumber).filter(Boolean),
      syncFinance,
    );
    const prepared = candidateOrders
      .map((order) => prepareOrder(order, itemBySku, financeByOrderNumber.get(extractOrderNumber(order)) || []))
      .filter(Boolean) as PreparedOrder[];

    const orderNumbers = prepared.map((entry) => entry.order.order_number);
    const existingOrders = await loadExistingOrders(supabase, orderNumbers);
    const importable = prepared.filter((entry) => !CLOSED_LOCAL_ORDER_STATUSES.has(String(existingOrders.get(entry.order.order_number)?.status || "").toLowerCase()));
    const skippedClosed = prepared.length - importable.length;

    if (dryRun) {
      const preview = importable.map((entry) => ({
        orderNumber: entry.order.order_number,
        buyer: entry.order.buyer_username || entry.order.buyer_name || "",
        paymentStatus: getOrderPaymentStatus(entry.source),
        fulfillmentStatus: getOrderFulfillmentStatus(entry.source),
        cancelStatus: getOrderCancelStatus(entry.source),
        shipByDate: entry.order.ship_by_date || null,
        lineCount: entry.lines.length,
        lines: entry.lines.map((line) => ({
          sku: line.custom_label,
          title: line.item_title,
          quantity: line.quantity,
          matched: Boolean(line.internal_item_id),
        })),
      }));

      await supabase
        .from("ebay_order_sync_runs")
        .update({
          status: "completed",
          orders_seen: rawOrders.length,
          orders_imported: 0,
          lines_imported: 0,
          lines_reserved: 0,
          warnings: [
            ...(skippedClosed ? [{ skippedClosed }] : []),
            ...(skippedUnpaid ? [{ skippedUnpaid, reason: "payment_not_paid" }] : []),
            ...(skippedNotAwaitingShipment ? [{ skippedNotAwaitingShipment, reason: "not_awaiting_shipment" }] : []),
            ...financeWarnings,
            ...localMismatchWarnings,
          ],
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);

      return jsonResponse(200, {
        ok: true,
        runId,
        dryRun: true,
        ordersSeen: rawOrders.length,
        ebayAwaitingOrderCount: candidateOrders.length,
        ordersImportable: importable.length,
        skippedClosed,
        skippedUnpaid,
        skippedNotAwaitingShipment,
        localPendingMismatches,
        localPendingMismatchCandidates,
        localOpenOrderCount: localOpenOrders.length,
        requestedOrderLimit,
        localPendingMismatchChecked: checkLocalMismatches && fetchedCompleteOrderWindow,
        localPendingMismatchCheckSkipped: checkLocalMismatches && !fetchedCompleteOrderWindow,
        warnings: financeWarnings,
        preview,
      });
    }

    const freshOrders = importable.filter((entry) => !existingOrders.has(entry.order.order_number));
    let insertedOrders: any[] = [];
    if (freshOrders.length) {
      const { data, error } = await supabase
        .from("ebay_orders")
        .insert(freshOrders.map((entry) => entry.order))
        .select("id,order_number,status");
      if (error) throw error;
      insertedOrders = data || [];
    }

    const orderIdByNumber = new Map<string, string>([
      ...[...existingOrders.entries()]
        .filter(([, order]) => !CLOSED_LOCAL_ORDER_STATUSES.has(String(order?.status || "").toLowerCase()))
        .map(([orderNumber, order]) => [orderNumber, order.id] as [string, string]),
      ...insertedOrders.map((order) => [order.order_number, order.id] as [string, string]),
    ]);

    await updateExistingOrderFinancePayloads(supabase, importable, existingOrders);

    const orderIds = unique([...orderIdByNumber.values()].filter(Boolean));
    const existingLines = await loadExistingLines(supabase, orderIds);
    const lineRows = importable.flatMap((entry) => {
      const orderId = orderIdByNumber.get(entry.order.order_number);
      if (!orderId) return [];
      return entry.lines
        .map((line) => {
          const existing = findExistingLine(existingLines, orderId, line);
          return {
            ...line,
            order_id: orderId,
            item_number: existing?.item_number || line.item_number,
            transaction_id: existing?.transaction_id || line.transaction_id,
            internal_item_id: line.internal_item_id || existing?.internal_item_id || null,
          };
        })
        .filter((line) => {
          const existing = findExistingLine(existingLines, orderId, line);
          return !existing || !CLOSED_LOCAL_LINE_STATUSES.has(String(existing.line_status || "").toLowerCase());
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
        .select("id,order_id,custom_label,quantity,line_status,internal_item_id");
      if (error) throw error;
      upsertedLines = data || [];
    }

    let reservationResults: any[] = [];
    if (shouldReserve && upsertedLines.length) {
      const lineIds = upsertedLines.map((line) => line.id).filter(Boolean);
      const [lineStateResponse, reservationResponse] = await Promise.all([
        supabase
          .from("ebay_order_lines")
          .select("id,custom_label,quantity,line_status,internal_item_id,stock_location_row_id,location_id")
          .in("id", lineIds),
        supabase
          .from("ebay_order_line_reservations")
          .select("order_line_id,item_id,stock_location_row_id,location_id,quantity,status")
          .in("order_line_id", lineIds)
          .eq("status", "reserved"),
      ]);

      if (lineStateResponse.error) throw lineStateResponse.error;
      if (reservationResponse.error) throw reservationResponse.error;

      const lineStateById = new Map((lineStateResponse.data || []).map((line: any) => [line.id, line]));
      const reservationByLineId = new Map((reservationResponse.data || []).map((reservation: any) => [reservation.order_line_id, reservation]));

      reservationResults = upsertedLines.map((line) => {
        const latestLine = lineStateById.get(line.id) || line;
        const reservation = reservationByLineId.get(line.id);
        if (reservation) {
          return {
            lineId: line.id,
            sku: latestLine.custom_label || "",
            ok: true,
            status: reservation.status || "reserved",
            error: null,
            result: reservation,
          };
        }
        return {
          lineId: line.id,
          sku: latestLine.custom_label || "",
          ok: false,
          status: latestLine.internal_item_id ? "no_available_stock" : "unmatched",
          error: latestLine.internal_item_id
            ? "No available stock row could be reserved for this eBay order line."
            : "No OG item matched this eBay order line SKU/custom label.",
          result: latestLine,
        };
      });
    }

    const reserved = reservationResults.filter((entry) =>
      entry.ok && ["reserved", "already_reserved"].includes(String(entry.status || ""))
    ).length;
    const warnings = [
      ...(skippedClosed ? [{ skippedClosed }] : []),
      ...(skippedUnpaid ? [{ skippedUnpaid, reason: "payment_not_paid" }] : []),
      ...(skippedNotAwaitingShipment ? [{ skippedNotAwaitingShipment, reason: "not_awaiting_shipment" }] : []),
      ...financeWarnings,
      ...localMismatchWarnings,
      ...reservationResults.filter((entry) => !entry.ok).map((entry) => ({
        lineId: entry.lineId,
        sku: entry.sku,
        status: entry.status,
        error: entry.error,
        result: entry.result,
      })),
    ];

    await supabase
      .from("ebay_order_sync_runs")
      .update({
        status: "completed",
        orders_seen: rawOrders.length,
        orders_imported: freshOrders.length,
        lines_imported: upsertedLines.length,
        lines_reserved: reserved,
        warnings,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    return jsonResponse(200, {
      ok: true,
      runId,
      dryRun: false,
      ordersSeen: rawOrders.length,
      ebayAwaitingOrderCount: candidateOrders.length,
      ordersImported: freshOrders.length,
      linesImported: upsertedLines.length,
      linesReserved: reserved,
      skippedClosed,
      skippedUnpaid,
      skippedNotAwaitingShipment,
      localPendingMismatches,
      localPendingMismatchCandidates,
      localOpenOrderCount: localOpenOrders.length,
      requestedOrderLimit,
      localPendingMismatchChecked: checkLocalMismatches && fetchedCompleteOrderWindow,
      localPendingMismatchCheckSkipped: checkLocalMismatches && !fetchedCompleteOrderWindow,
      warnings,
      reservations: reservationResults,
    });
  } catch (error) {
    const message = compactError(error);
    if (runId) {
      await supabase
        .from("ebay_order_sync_runs")
        .update({
          status: "failed",
          error: message,
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    return jsonResponse(500, {
      ok: false,
      runId,
      error: message,
    });
  }
});
