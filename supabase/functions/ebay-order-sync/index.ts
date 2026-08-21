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
const EBAY_FINANCES_API_BASE = EBAY_ENV === "sandbox" ? "https://apiz.sandbox.ebay.com" : "https://apiz.ebay.com";
const EBAY_ON_HOLD_TRANSACTION_LIST_URL = "https://www.ebay.com/mes/transactionlist?sh=true";
const DEFAULT_DAYS_BACK = 14;
const MAX_ORDER_LIMIT = 1000;
const PAGE_LIMIT = 50;
const DEFAULT_RESPONSE_BUDGET_MS = 45_000;
const MIN_RESPONSE_BUDGET_MS = 15_000;
const MAX_RESPONSE_BUDGET_MS = 110_000;
const RESPONSE_BUDGET_SAFETY_MS = 4_000;
const EBAY_LOOKUP_CONCURRENCY = 5;
const EBAY_FETCH_TIMEOUT_MS = 10_000;

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

function getResponseDeadline(body: JsonRecord): number {
  const requested = Math.trunc(Number(body.responseBudgetMs || DEFAULT_RESPONSE_BUDGET_MS));
  const budget = Math.min(Math.max(requested, MIN_RESPONSE_BUDGET_MS), MAX_RESPONSE_BUDGET_MS);
  return Date.now() + budget - RESPONSE_BUDGET_SAFETY_MS;
}

function hasTimeBudget(deadlineMs = 0): boolean {
  return !deadlineMs || Date.now() < deadlineMs;
}

function budgetWarning(stage: string, skipped: number): JsonRecord | null {
  if (skipped <= 0) return null;
  return {
    reason: "ebay_sync_time_budget_exhausted",
    stage,
    skipped,
    message: `${stage} stopped early so the eBay sync could return before the HTTP connection closed.`,
  };
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  deadlineMs: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<number> {
  let cursor = 0;
  let attempted = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (hasTimeBudget(deadlineMs)) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      attempted += 1;
      await worker(items[index], index);
    }
  }));
  return attempted;
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
    signal: AbortSignal.timeout(EBAY_FETCH_TIMEOUT_MS),
    headers: {
      "Authorization": `Basic ${btoa(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 400 && /invalid_grant|refresh token|authorization refresh token/i.test(text)) {
      throw new Error(
        "eBay OAuth refresh token is invalid or revoked. Reconnect eBay and replace the EBAY_REFRESH_TOKEN Supabase secret. " +
          "This commonly happens after an eBay password or seller login change.",
      );
    }
    throw new Error(`eBay OAuth refresh failed (${res.status}): ${text.slice(0, 800)}`);
  }

  const payload = JSON.parse(text);
  if (!payload.access_token) throw new Error("eBay OAuth response did not include an access_token.");
  return payload.access_token;
}

async function ebayRequest(token: string, path: string): Promise<any> {
  const res = await fetch(`${EBAY_API_BASE}${path}`, {
    method: "GET",
    signal: AbortSignal.timeout(EBAY_FETCH_TIMEOUT_MS),
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

async function ebayFinanceRequest(token: string, path: string): Promise<any> {
  const res = await fetch(`${EBAY_FINANCES_API_BASE}${path}`, {
    method: "GET",
    signal: AbortSignal.timeout(EBAY_FETCH_TIMEOUT_MS),
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
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
    throw new Error(`eBay Finances GET ${path} failed (${res.status}): ${text.slice(0, 1000)}`);
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

function isNormalCancelStatus(status: string): boolean {
  return !status || ["NONE_REQUESTED", "NOT_REQUESTED", "NO_CANCEL", "NOT_CANCELLED"].includes(status);
}

function getCancelRequests(order: any): any[] {
  return Array.isArray(order?.cancelStatus?.cancelRequests) ? order.cancelStatus.cancelRequests : [];
}

function hasCancellationSignal(order: any): boolean {
  return !isNormalCancelStatus(getOrderCancelStatus(order)) || getCancelRequests(order).length > 0;
}

function buildApiCancellationCase(order: any): JsonRecord | null {
  if (!hasCancellationSignal(order)) return null;
  const requests = getCancelRequests(order);
  const latest = requests[0] || {};
  const cancelStatus = getOrderCancelStatus(order);
  const orderNumber = extractOrderNumber(order);
  return {
    source: "ebay_fulfillment_api",
    orderNumber,
    cancelStatus,
    cancellationStatus: cancelStatus,
    cancelReason: toText(latest?.cancelReason || order?.cancelStatus?.cancelReason),
    cancellationReason: toText(latest?.cancelReason || order?.cancelStatus?.cancelReason),
    cancelInitiator: toText(latest?.cancelInitiator || order?.cancelStatus?.cancelInitiator),
    requestedAt: toIsoDate(latest?.cancelRequestDate || latest?.requestedDate || latest?.creationDate || order?.cancelStatus?.cancelRequestDate),
    completedAt: toIsoDate(latest?.cancelCompletedDate || order?.cancelStatus?.cancelledDate || order?.cancelStatus?.cancelCompletedDate),
    importedAt: new Date().toISOString(),
    cancelRequests: requests,
  };
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
    item?.itemId,
    item?.transactionId,
  ]).map(toText).filter(Boolean));
}

function pruneEmptyFinanceRecord(record: JsonRecord): JsonRecord {
  const output: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && !value.length) continue;
    output[key] = value;
  }
  return output;
}

function financeAmountText(value: unknown): string {
  const amount = toMoney(value);
  if (!amount) return "";
  const currency = typeof value === "object" && value !== null && "currency" in value
    ? toText((value as JsonRecord).currency || "USD")
    : "USD";
  return currency === "USD" ? `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${currency} ${amount.toFixed(2)}`;
}

function getFinanceOrderId(transaction: any): string {
  return getNestedText(transaction?.orderId, transaction?.order_id, transaction?.order?.orderId, transaction?.order?.orderNumber);
}

function getFinanceBuyerUsername(transaction: any): string {
  return getNestedText(
    transaction?.buyer?.username,
    transaction?.buyer?.userName,
    transaction?.buyer?.userId,
    transaction?.buyerUsername,
  );
}

function getFinanceReferenceText(transaction: any): string {
  const references = Array.isArray(transaction?.references) ? transaction.references : [];
  return [
    transaction?.transactionMemo,
    transaction?.transactionId,
    transaction?.transactionType,
    transaction?.transactionStatus,
    transaction?.payoutId,
    transaction?.payoutReferenceId,
    ...references.flatMap((reference: any) => [reference?.referenceId, reference?.referenceType, reference?.id, reference?.type]),
  ].map(toText).filter(Boolean).join(" ");
}

function extractReferenceIdsFromText(text: string, pattern: RegExp): string[] {
  return unique([...String(text || "").matchAll(pattern)].map((match) => toText(match[1])).filter(Boolean));
}

function getFinanceReferenceIds(transaction: any): JsonRecord {
  const text = getFinanceReferenceText(transaction);
  return pruneEmptyFinanceRecord({
    requestIds: extractReferenceIdsFromText(text, /\b(?:request|case|claim)\s*(?:id|#)?\s*[:#-]?\s*([0-9]{6,})\b/gi),
    returnIds: extractReferenceIdsFromText(text, /\breturn\s*(?:id|#)?\s*[:#-]?\s*([0-9]{6,})\b/gi),
    disputeIds: extractReferenceIdsFromText(text, /\b(?:dispute|chargeback)\s*(?:id|#)?\s*[:#-]?\s*([A-Z0-9-]{6,})\b/gi),
  });
}

function ebayRequestDetailsUrl(requestId: string): string {
  const cleanId = toText(requestId);
  return cleanId ? `https://www.ebay.com/res/ItemNotReceived/ViewRequest?id=${encodeURIComponent(cleanId)}` : "";
}

function compactFinanceLineItems(transaction: any): JsonRecord[] {
  const items = Array.isArray(transaction?.orderLineItems) ? transaction.orderLineItems : [];
  return items.map((item: any) => pruneEmptyFinanceRecord({
    lineItemId: getNestedText(item?.lineItemId, item?.transactionId),
    itemId: getNestedText(item?.itemId, item?.legacyItemId),
    feeBasisAmount: financeAmountText(item?.feeBasisAmount),
  })).filter((item: JsonRecord) => Object.keys(item).length);
}

function getFinanceHoldSignal(transaction: any): JsonRecord | null {
  const status = normalizeFinanceTransactionStatus(transaction?.transactionStatus);
  const memo = toText(transaction?.transactionMemo);
  const holdText = getFinanceReferenceText(transaction).toLowerCase();
  if (status !== "on_hold" && !/\b(on hold|funds held|held for|hold)\b/i.test(holdText)) return null;
  const references = getFinanceReferenceIds(transaction);
  const requestIds = Array.isArray(references.requestIds) ? references.requestIds.map(toText).filter(Boolean) : [];
  const returnIds = Array.isArray(references.returnIds) ? references.returnIds.map(toText).filter(Boolean) : [];
  const disputeIds = Array.isArray(references.disputeIds) ? references.disputeIds.map(toText).filter(Boolean) : [];
  const requestDetailsUrls = requestIds.map(ebayRequestDetailsUrl).filter(Boolean);
  const amount = getFinanceTransactionAmount(transaction);
  return pruneEmptyFinanceRecord({
    source: "ebay_finances_api",
    status: "on_hold",
    statusLabel: "On hold",
    orderNumber: getFinanceOrderId(transaction),
    buyerUsername: getFinanceBuyerUsername(transaction),
    requestIds,
    returnIds,
    disputeIds,
    requestDetailsUrl: requestDetailsUrls[0] || "",
    requestDetailsUrls,
    transactionListUrl: EBAY_ON_HOLD_TRANSACTION_LIST_URL,
    amount,
    amountText: financeAmountText(transaction?.amount || amount),
    transactionId: getFinanceTransactionId(transaction),
    transactionType: toText(transaction?.transactionType),
    transactionStatus: toText(transaction?.transactionStatus),
    transactionDate: toIsoDate(transaction?.transactionDate || transaction?.createdDate),
    memo,
    lineItemIds: getFinanceLineItemIds(transaction),
    lineItems: compactFinanceLineItems(transaction),
  });
}

function mergeFinanceTransactionsByOrder(byOrder: Map<string, any[]>, transactions: any[]) {
  for (const transaction of transactions || []) {
    const orderNumber = getFinanceOrderId(transaction);
    if (!orderNumber) continue;
    const existing = byOrder.get(orderNumber) || [];
    const transactionId = getFinanceTransactionId(transaction);
    if (transactionId && existing.some((entry) => getFinanceTransactionId(entry) === transactionId)) continue;
    byOrder.set(orderNumber, [...existing, transaction]);
  }
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
    const holdSignal = getFinanceHoldSignal(transaction);
    return {
      transactionId: getFinanceTransactionId(transaction),
      transactionType: toText(transaction?.transactionType),
      transactionStatus: toText(transaction?.transactionStatus),
      bookingEntry: toText(transaction?.bookingEntry),
      status,
      orderNumber: getFinanceOrderId(transaction),
      buyerUsername: getFinanceBuyerUsername(transaction),
      payoutId,
      transactionDate: toIsoDate(transaction?.transactionDate || transaction?.bookingEntry || transaction?.createdDate),
      memo: toText(transaction?.transactionMemo),
      amount: getFinanceTransactionAmount(transaction),
      lineItemIds: getFinanceLineItemIds(transaction),
      lineItems: compactFinanceLineItems(transaction),
      ...(holdSignal ? { holdSignal } : {}),
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
  const holdSignals = compactTransactions
    .map((transaction: any) => transaction.holdSignal)
    .filter((signal: any) => signal && typeof signal === "object");
  const holdAmount = holdSignals.reduce((total: number, signal: any) => total + toMoney(signal.amount), 0);
  const requestIds = unique(holdSignals.flatMap((signal: any) => Array.isArray(signal.requestIds) ? signal.requestIds : []).map(toText).filter(Boolean));
  const returnIds = unique(holdSignals.flatMap((signal: any) => Array.isArray(signal.returnIds) ? signal.returnIds : []).map(toText).filter(Boolean));
  const requestDetailsUrls = unique(holdSignals.flatMap((signal: any) => Array.isArray(signal.requestDetailsUrls) ? signal.requestDetailsUrls : [signal.requestDetailsUrl]).map(toText).filter(Boolean));

  return {
    source: "ebay_finances_api",
    syncedAt: new Date().toISOString(),
    orderNumber,
    lineItemId: lineItemId || null,
    status: holdSignals.length ? "on_hold" : winningStatus,
    statusLabel: holdSignals.length ? "On hold" : getFinanceStatusLabel(winningStatus),
    payoutIds,
    transactionIds,
    lineItemIds,
    holdAmount: holdAmount || null,
    holdAmountText: holdAmount ? financeAmountText(holdAmount) : "",
    requestIds,
    returnIds,
    requestDetailsUrl: requestDetailsUrls[0] || "",
    requestDetailsUrls,
    transactionListUrl: EBAY_ON_HOLD_TRANSACTION_LIST_URL,
    holdSignals: holdSignals.slice(0, 10),
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
    const payload = await ebayFinanceRequest(token, `/sell/finances/v1/transaction?${params.toString()}`);
    const page = Array.isArray(payload?.transactions) ? payload.transactions : [];
    transactions.push(...page);
    if (!payload?.next || page.length < limit) break;
    offset += limit;
  }
  return transactions;
}

async function fetchFundsOnHoldTransactions(token: string, maxTransactions = 1000, deadlineMs = 0): Promise<any[]> {
  const transactions: any[] = [];
  let offset = 0;
  const limit = Math.min(1000, Math.max(1, maxTransactions));
  while (transactions.length < maxTransactions && hasTimeBudget(deadlineMs)) {
    const params = new URLSearchParams({
      filter: "transactionStatus:{FUNDS_ON_HOLD}",
      limit: String(Math.min(limit, maxTransactions - transactions.length)),
      offset: String(offset),
    });
    const payload = await ebayFinanceRequest(token, `/sell/finances/v1/transaction?${params.toString()}`);
    const page = Array.isArray(payload?.transactions) ? payload.transactions : [];
    transactions.push(...page);
    if (!payload?.next || page.length < limit) break;
    offset += limit;
  }
  return transactions;
}

async function loadFinanceTransactionsByOrder(token: string, orderNumbers: string[], syncFinance: boolean, deadlineMs = 0) {
  const byOrder = new Map<string, any[]>();
  const warnings: JsonRecord[] = [];
  const checkedOrderNumbers = syncFinance ? unique(orderNumbers.map(toText).filter(Boolean)) : [];
  if (!syncFinance) {
    return {
      byOrder,
      warnings,
      stats: {
        financeSyncEnabled: false,
        financeOrdersChecked: 0,
        financeOrdersWithTransactions: 0,
        financeOrdersWithoutTransactions: 0,
      },
    };
  }
  const attempted = await mapWithConcurrency(checkedOrderNumbers, EBAY_LOOKUP_CONCURRENCY, deadlineMs, async (orderNumber) => {
    try {
      byOrder.set(orderNumber, await fetchFinanceTransactionsForOrder(token, orderNumber));
    } catch (error) {
      warnings.push({
        orderNumber,
        reason: "ebay_finance_lookup_failed",
        message: compactError(error),
      });
    }
  });
  const skippedByBudget = checkedOrderNumbers.length - attempted;
  const timeoutWarning = budgetWarning("finance transaction lookup", skippedByBudget);
  if (timeoutWarning) warnings.push(timeoutWarning);
  let onHoldTransactions: any[] = [];
  if (hasTimeBudget(deadlineMs)) {
    try {
      onHoldTransactions = await fetchFundsOnHoldTransactions(token, 1000, deadlineMs);
      mergeFinanceTransactionsByOrder(byOrder, onHoldTransactions);
    } catch (error) {
      warnings.push({
        reason: "ebay_finance_on_hold_lookup_failed",
        message: compactError(error),
      });
    }
  } else {
    const warning = budgetWarning("on-hold finance lookup", 1);
    if (warning) warnings.push(warning);
  }
  const withTransactions = [...byOrder.values()].filter((transactions) => transactions.length > 0).length;
  const onHoldOrderNumbers = unique(onHoldTransactions.map(getFinanceOrderId).filter(Boolean));
  return {
    byOrder,
    warnings,
    stats: {
      financeSyncEnabled: true,
      financeOrdersChecked: attempted,
      financeOrdersWithTransactions: withTransactions,
      financeOrdersWithoutTransactions: Math.max(0, attempted - withTransactions - warnings.filter((entry) => entry.reason === "ebay_finance_lookup_failed").length),
      financeOrdersSkippedDueToBudget: skippedByBudget,
      financeOnHoldTransactions: onHoldTransactions.length,
      financeOnHoldOrders: onHoldOrderNumbers.length,
      financeOrdersDiscoveredFromHold: onHoldOrderNumbers.filter((orderNumber) => !checkedOrderNumbers.includes(orderNumber)).length,
    },
  };
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
  const apiCancellationCase = buildApiCancellationCase(order);

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
        orderFulfillmentStatus: getOrderFulfillmentStatus(order),
        orderCancelStatus: getOrderCancelStatus(order),
        ...(apiCancellationCase ? { api_cancellation_case: apiCancellationCase } : {}),
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
        orderFulfillmentStatus: getOrderFulfillmentStatus(order),
        orderCancelStatus: getOrderCancelStatus(order),
        ...(apiCancellationCase ? { api_cancellation_case: apiCancellationCase } : {}),
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

async function hydrateCancellationOrderDetails(
  token: string,
  orders: any[],
  detailLimit: number,
  deadlineMs = 0,
): Promise<{ orders: any[]; checked: number; warnings: JsonRecord[] }> {
  const warnings: JsonRecord[] = [];
  const candidates = orders
    .filter(hasCancellationSignal)
    .slice(0, Math.max(0, detailLimit));
  if (!candidates.length) return { orders, checked: 0, warnings };

  const byOrderNumber = new Map<string, any>();
  const attempted = await mapWithConcurrency(candidates, EBAY_LOOKUP_CONCURRENCY, deadlineMs, async (order) => {
    const orderNumber = extractOrderNumber(order);
    if (!orderNumber || byOrderNumber.has(orderNumber)) return;
    try {
      byOrderNumber.set(orderNumber, await ebayRequest(token, `/sell/fulfillment/v1/order/${encodeURIComponent(orderNumber)}`));
    } catch (error) {
      warnings.push({
        orderNumber,
        reason: "ebay_cancellation_detail_lookup_failed",
        message: compactError(error),
      });
    }
  });
  const timeoutWarning = budgetWarning("cancellation detail lookup", candidates.length - attempted);
  if (timeoutWarning) warnings.push(timeoutWarning);

  if (!byOrderNumber.size) return { orders, checked: attempted, warnings };
  return {
    orders: orders.map((order) => byOrderNumber.get(extractOrderNumber(order)) || order),
    checked: attempted,
    warnings,
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

async function updateLocalOrderFinancePayloads(
  supabase: any,
  financeByOrderNumber: Map<string, any[]>,
) {
  const orderNumbers = [...financeByOrderNumber.keys()].filter(Boolean);
  if (!orderNumbers.length) return;

  const now = new Date().toISOString();
  for (let index = 0; index < orderNumbers.length; index += 100) {
    const chunk = orderNumbers.slice(index, index + 100);
    const { data: orders, error } = await supabase
      .from("ebay_orders")
      .select("id,order_number,raw_payload")
      .in("order_number", chunk);
    if (error) throw error;

    const orderIds = (orders || []).map((order: any) => order.id).filter(Boolean);
    const { data: lines, error: lineError } = orderIds.length
      ? await supabase
        .from("ebay_order_lines")
        .select("id,order_id,transaction_id,raw_payload")
        .in("order_id", orderIds)
      : { data: [], error: null };
    if (lineError) throw lineError;

    const linesByOrderId = new Map<string, any[]>();
    (lines || []).forEach((line: any) => {
      if (!linesByOrderId.has(line.order_id)) linesByOrderId.set(line.order_id, []);
      linesByOrderId.get(line.order_id)?.push(line);
    });

    for (const order of orders || []) {
      const transactions = financeByOrderNumber.get(order.order_number) || [];
      if (!transactions.length) continue;
      const orderFinance = summarizeFinanceTransactions(transactions, order.order_number);
      if (!orderFinance) continue;
      const orderRawPayload = order.raw_payload && typeof order.raw_payload === "object" ? order.raw_payload : {};
      const { error: orderUpdateError } = await supabase
        .from("ebay_orders")
        .update({
          raw_payload: {
            ...orderRawPayload,
            ebayFinance: orderFinance,
            last_ebay_finance_sync_at: now,
          },
          updated_at: now,
        })
        .eq("id", order.id);
      if (orderUpdateError) throw orderUpdateError;

      for (const line of linesByOrderId.get(order.id) || []) {
        const lineFinance = summarizeFinanceTransactions(transactions, order.order_number, line.transaction_id);
        if (!lineFinance) continue;
        const lineRawPayload = line.raw_payload && typeof line.raw_payload === "object" ? line.raw_payload : {};
        const { error: lineUpdateError } = await supabase
          .from("ebay_order_lines")
          .update({
            raw_payload: {
              ...lineRawPayload,
              ebayFinance: lineFinance,
            },
          })
          .eq("id", line.id);
        if (lineUpdateError) throw lineUpdateError;
      }
    }
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
  deadlineMs = 0,
): Promise<{ mismatches: LocalOrderMismatch[]; warnings: JsonRecord[]; attempted: number }> {
  const toVerify = localOrders
    .filter((order) => !seenOrderNumbers.has(order.orderNumber))
    .slice(0, Math.max(0, limit));
  const mismatches: LocalOrderMismatch[] = [];
  const warnings: JsonRecord[] = [];

  const attempted = await mapWithConcurrency(toVerify, EBAY_LOOKUP_CONCURRENCY, deadlineMs, async (local) => {
    try {
      const ebayOrder = await ebayRequest(token, `/sell/fulfillment/v1/order/${encodeURIComponent(local.orderNumber)}`);
      if (isAwaitingShipmentOrder(ebayOrder)) return;
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
  });
  const timeoutWarning = budgetWarning("local pending mismatch lookup", toVerify.length - attempted);
  if (timeoutWarning) warnings.push(timeoutWarning);

  return { mismatches, warnings, attempted };
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
    const responseDeadlineMs = getResponseDeadline(body);
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
    let rawOrders = await fetchOrders(token, body);
    const orderIdsRequested = Array.isArray(body.orderIds)
      ? unique(body.orderIds.map(toText).filter(Boolean)).slice(0, MAX_ORDER_LIMIT)
      : [];
    const requestedOrderLimit = orderIdsRequested.length
      ? orderIdsRequested.length
      : Math.min(Math.max(Math.trunc(Number(body.limit || 50)), 1), MAX_ORDER_LIMIT);
    const syncCancellations = body.syncCancellations !== false;
    const cancellationDetailLimit = syncCancellations
      ? Math.min(Math.max(Math.trunc(Number(body.cancellationDetailLimit || Math.min(requestedOrderLimit, 50))), 0), MAX_ORDER_LIMIT)
      : 0;
    const cancellationDetailHydration = await hydrateCancellationOrderDetails(token, rawOrders, cancellationDetailLimit, responseDeadlineMs);
    rawOrders = cancellationDetailHydration.orders;
    const fetchedCompleteOrderWindow = orderIdsRequested.length > 0 || rawOrders.length < requestedOrderLimit;
    const checkLocalMismatches = body.checkLocalMismatches !== false;
    const localMismatchLimit = Math.min(Math.max(Math.trunc(Number(body.localMismatchLimit || Math.min(requestedOrderLimit, 120))), 0), MAX_ORDER_LIMIT);
    const rawOrderNumbers = new Set(rawOrders.map(extractOrderNumber).filter(Boolean));
    const notAwaitingOrderNumbers = unique(rawOrders.filter((order) => !isAwaitingShipmentOrder(order)).map(extractOrderNumber).filter(Boolean));
    const awaitingOrders = rawOrders.filter(isAwaitingShipmentOrder);
    const cancellationOrders = syncCancellations ? rawOrders.filter(hasCancellationSignal) : [];
    const candidateOrders = [...new Map([
      ...awaitingOrders,
      ...cancellationOrders,
    ].map((order) => [extractOrderNumber(order), order])).values()].filter((order) => extractOrderNumber(order));
    const skippedUnpaid = rawOrders.filter((order) => !isPaidOrder(order)).length;
    const skippedNotAwaitingShipment = rawOrders.filter((order) =>
      isPaidOrder(order) && !isAwaitingShipmentOrder(order) && !hasCancellationSignal(order)
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
    const missingLocalMismatchResult = checkLocalMismatches && fetchedCompleteOrderWindow
      ? await verifyLocalOpenOrderMismatches(token, localOpenOrders, rawOrderNumbers, localMismatchLimit, responseDeadlineMs)
      : { mismatches: [], warnings: [], attempted: 0 };
    const missingLocalMismatches = missingLocalMismatchResult.mismatches;
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
      ...missingLocalMismatchResult.warnings,
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
    const financeOrderNumbers = unique([
      ...candidateOrders.map(extractOrderNumber),
      ...localPendingMismatches.map((entry) => entry.orderNumber),
    ].map(toText).filter(Boolean));
    const {
      byOrder: financeByOrderNumber,
      warnings: financeWarnings,
      stats: financeStats,
    } = await loadFinanceTransactionsByOrder(
      token,
      financeOrderNumbers,
      syncFinance,
      responseDeadlineMs,
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
        cancellationRequested: hasCancellationSignal(entry.source),
        cancellation: buildApiCancellationCase(entry.source),
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
            ...cancellationDetailHydration.warnings,
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
        ebayAwaitingOrderCount: awaitingOrders.length,
        ebayCancellationOrderCount: cancellationOrders.length,
        ebayCancellationDetailsChecked: cancellationDetailHydration.checked,
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
        financeStats,
        warnings: [...cancellationDetailHydration.warnings, ...financeWarnings],
        preview,
      });
    }

    await updateLocalOrderFinancePayloads(supabase, financeByOrderNumber);

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
    const cancellationOrderNumbers = new Set(cancellationOrders.map(extractOrderNumber).filter(Boolean));
    const cancellationOrderIds = new Set([...orderIdByNumber.entries()]
      .filter(([orderNumber]) => cancellationOrderNumbers.has(orderNumber))
      .map(([, orderId]) => orderId));

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
    const reservableUpsertedLines = upsertedLines.filter((line) => !cancellationOrderIds.has(line.order_id));
    if (shouldReserve && reservableUpsertedLines.length) {
      const lineIds = reservableUpsertedLines.map((line) => line.id).filter(Boolean);
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

      reservationResults = reservableUpsertedLines.map((line) => {
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
      ...cancellationDetailHydration.warnings,
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
      ebayAwaitingOrderCount: awaitingOrders.length,
      ebayCancellationOrderCount: cancellationOrders.length,
      ebayCancellationDetailsChecked: cancellationDetailHydration.checked,
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
      financeStats,
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
