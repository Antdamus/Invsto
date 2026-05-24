import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

type PreparedReturn = {
  source: any;
  summary: any;
  detail: any;
  filesPayload: any;
  returnId: string;
  orderNumber: string;
  buyerUsername: string;
  itemNumber: string;
  transactionId: string;
  itemTitle: string;
  quantity: number;
  reason: string;
  status: string;
  state: string;
  actionDue: string;
  dueAt: string | null;
  requestedAt: string | null;
  buyerComment: string;
  requestAmount: string;
  onHoldAmount: string;
  detailsUrl: string;
  itemImageUrl: string;
  trackingNumber: string;
  fileIds: string[];
  files: any[];
  payload: JsonRecord;
};

type MatchResult = {
  order: any | null;
  lines: any[];
};

type ReturnSummaryFetch = {
  summaries: any[];
  totalEntries: number | null;
  truncated: boolean;
  from: string;
  to: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const EBAY_CLIENT_ID = (Deno.env.get("EBAY_CLIENT_ID") ?? Deno.env.get("EBAY_APP_ID") ?? "").trim();
const EBAY_CLIENT_SECRET = (Deno.env.get("EBAY_CLIENT_SECRET") ?? Deno.env.get("EBAY_CERT_ID") ?? "").trim();
const EBAY_REFRESH_TOKEN = (Deno.env.get("EBAY_REFRESH_TOKEN") ?? "").trim();
const EBAY_ENV = (Deno.env.get("EBAY_ENV") ?? "production").trim().toLowerCase();
const EBAY_RETURN_SCOPE = (Deno.env.get("EBAY_RETURN_SCOPE") ?? Deno.env.get("EBAY_ORDER_SCOPE") ??
  "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.fulfillment").trim();

const EBAY_API_BASE = EBAY_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const DEFAULT_DAYS_BACK = 90;
const MAX_RETURN_LIMIT = 500;
const PAGE_LIMIT = 200;
const EBAY_RETURN_EVIDENCE_BUCKET = "ebay-return-evidence";

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

function toText(value: unknown): string {
  return String(value ?? "").trim();
}

function toIsoDate(value: unknown): string | null {
  const text = toText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value: unknown, fallback = 0): number {
  const raw = typeof value === "object" && value !== null && "value" in value
    ? (value as JsonRecord).value
    : value;
  const numeric = Number(raw ?? fallback);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))] as T[];
}

function compactError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as JsonRecord;
    const parts = [record.message, record.details, record.hint, record.code ? `code: ${record.code}` : ""]
      .map((value) => toText(value))
      .filter(Boolean);
    if (parts.length) return parts.join(" | ");
    try {
      return JSON.stringify(record);
    } catch {
      return "Unknown object error";
    }
  }
  return toText(error) || "Unknown error";
}

function moneyText(...values: unknown[]): string {
  for (const value of values) {
    const amount = typeof value === "object" && value !== null ? value as JsonRecord : null;
    const raw = amount && "value" in amount ? amount.value : value;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) continue;
    const currency = toText(amount?.currency || "USD");
    return `${currency} ${numeric.toFixed(2)}`;
  }
  return "";
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = toText(value);
    if (text) return text;
  }
  return "";
}

function commentText(...values: unknown[]): string {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number") {
      const text = toText(value);
      if (text) return text;
      continue;
    }
    if (Array.isArray(value)) {
      const text = commentText(...value);
      if (text) return text;
      continue;
    }
    if (typeof value !== "object") continue;
    const record = value as any;
    const text = commentText(
      record.content,
      record.text,
      record.message,
      record.comment,
      record.value,
      record.localizedText,
    );
    if (text) return text;
  }
  return "";
}

function firstDate(...values: unknown[]): string | null {
  for (const value of values) {
    const iso = toIsoDate(value);
    if (iso) return iso;
  }
  return null;
}

function getDateValue(value: any): string | null {
  return firstDate(value?.value, value?.formattedValue, value);
}

function normalizeTitle(value: unknown): string {
  return toText(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeLookup(value: unknown): string {
  return toText(value).replace(/\s+/g, "").toLowerCase();
}

function fileIdFrom(file: any): string {
  return firstText(file?.fileId, file?.id, file?.file_id, file?.returnFileId);
}

function fileDirectUrlFrom(file: any): string {
  return firstText(file?.secureUrl, file?.url, file?.fileUrl);
}

function fileBase64From(file: any): string {
  const data = firstText(file?.resizedFileData, file?.fileData);
  if (!data) return "";
  return data.startsWith("data:") ? data.split(",", 2)[1] || "" : data;
}

function fileContentType(file: any): string {
  const format = firstText(file?.fileFormat, file?.format).toLowerCase();
  return format.includes("png")
    ? "image/png"
    : format.includes("gif")
      ? "image/gif"
      : "image/jpeg";
}

function fileExtension(file: any): string {
  const contentType = fileContentType(file);
  if (contentType === "image/png") return "png";
  if (contentType === "image/gif") return "gif";
  return "jpg";
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function fileCreatedAt(file: any): string | null {
  return firstDate(file?.creationDate?.value, file?.creationDate, file?.createdAt);
}

function sanitizeEbayFile(file: any): JsonRecord {
  return {
    fileId: fileIdFrom(file),
    fileName: firstText(file?.fileName, file?.name),
    filePurpose: firstText(file?.filePurpose, file?.purpose),
    fileFormat: firstText(file?.fileFormat, file?.format),
    submitter: firstText(file?.submitter),
    createdAt: fileCreatedAt(file),
    url: fileDirectUrlFrom(file),
    hasFileData: Boolean(fileBase64From(file)),
  };
}

function sanitizeEbayFilesPayload(payload: any): JsonRecord {
  return {
    files: getFilesFromPayload(payload).map(sanitizeEbayFile),
  };
}

function stripLargeEbayFields(value: any): any {
  if (Array.isArray(value)) return value.map(stripLargeEbayFields);
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && value.length > 2000) {
      return `[omitted ${value.length} characters]`;
    }
    return value;
  }
  const output: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (["fileData", "resizedFileData"].includes(key)) {
      output[key] = "[omitted file data]";
    } else {
      output[key] = stripLargeEbayFields(child);
    }
  }
  return output;
}

function getComplaintImages(files: any[]): any[] {
  return files
    .map((file) => {
      const url = fileDirectUrlFrom(file);
      if (!url) return null;
      return {
        source: "ebay_return_api",
        fileId: fileIdFrom(file),
        url,
        filePurpose: firstText(file?.filePurpose, file?.purpose),
        fileFormat: firstText(file?.fileFormat, file?.format),
        submitter: firstText(file?.submitter),
        createdAt: fileCreatedAt(file),
      };
    })
    .filter(Boolean);
}

function safePathPart(value: unknown): string {
  return toText(value)
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
}

async function uploadEbayReturnFiles(supabase: any, prepared: PreparedReturn): Promise<any[]> {
  const records: any[] = [];
  for (let index = 0; index < prepared.files.length; index += 1) {
    const file = prepared.files[index];
    const directUrl = fileDirectUrlFrom(file);
    const base64 = fileBase64From(file);
    const fileId = fileIdFrom(file) || `file-${index + 1}`;
    const record = {
      source: "ebay_return_api",
      fileId,
      filePurpose: firstText(file?.filePurpose, file?.purpose),
      fileFormat: firstText(file?.fileFormat, file?.format),
      submitter: firstText(file?.submitter),
      createdAt: fileCreatedAt(file),
      url: directUrl,
    };
    if (!base64) {
      records.push(record);
      continue;
    }

    const path = [
      "ebay-api",
      safePathPart(prepared.returnId),
      `${safePathPart(fileId)}-${index + 1}.${fileExtension(file)}`,
    ].join("/");
    const { error } = await supabase.storage
      .from(EBAY_RETURN_EVIDENCE_BUCKET)
      .upload(path, base64ToBytes(base64), {
        contentType: fileContentType(file),
        upsert: true,
      });
    if (error) throw error;
    records.push({
      ...record,
      url: "",
      bucket: EBAY_RETURN_EVIDENCE_BUCKET,
      path,
      storage_bucket: EBAY_RETURN_EVIDENCE_BUCKET,
      storage_path: path,
    });
  }
  return records.filter((record) => record.url || record.path);
}

function getFilesFromPayload(payload: any): any[] {
  const candidates = [
    payload?.files,
    payload?.returnFiles,
    payload?.members,
    payload?.detail?.files,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function getAmountContainer(...values: unknown[]): any {
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const record = value as any;
    if (record.value != null) return record;
    if (record.actualRefundAmount) return record.actualRefundAmount;
    if (record.estimatedRefundAmount) return record.estimatedRefundAmount;
    if (record.totalAmount) return record.totalAmount;
  }
  return null;
}

function getActionUrl(summary: any): string {
  const options = [
    ...(Array.isArray(summary?.sellerAvailableOptions) ? summary.sellerAvailableOptions : []),
    ...(Array.isArray(summary?.buyerAvailableOptions) ? summary.buyerAvailableOptions : []),
  ];
  return firstText(...options.map((option: any) => option?.actionURL));
}

function getItemImageUrl(detail: any, summary: any): string {
  const images = [
    detail?.itemDetail?.imageUrl,
    detail?.itemDetail?.image?.imageUrl,
    detail?.itemDetail?.pictureURL,
    summary?.creationInfo?.item?.imageUrl,
  ];
  return firstText(...images);
}

function extractTracking(detail: any): string {
  const history = Array.isArray(detail?.responseHistory) ? detail.responseHistory : [];
  return firstText(
    detail?.buyerReturnShipmentInfo?.shipmentTracking?.trackingNumber,
    detail?.buyerReturnShipmentInfo?.trackingNumber,
    detail?.replacementShipmentInfo?.shipmentTracking?.trackingNumber,
    ...history.map((entry: any) => entry?.attributes?.updatedTrackingNumber),
  );
}

function buildReturnPayload(prepared: Omit<PreparedReturn, "payload">, uploadedComplaintImages: any[] = []): JsonRecord {
  const ebayComplaintImages = uploadedComplaintImages.length ? uploadedComplaintImages : getComplaintImages(prepared.files);
  const complaintImageUrls = ebayComplaintImages.map((image) => image.url).filter(Boolean);
  return {
    source: "ebay_return_api",
    syncedAt: new Date().toISOString(),
    caseType: prepared.orderNumber ? "matched_or_unmatched_by_order" : "unmatched_legacy",
    ebayReturnId: prepared.returnId,
    orderNumber: prepared.orderNumber,
    buyerUsername: prepared.buyerUsername,
    itemNumber: prepared.itemNumber,
    itemTitle: prepared.itemTitle,
    transactionId: prepared.transactionId,
    returnQuantity: prepared.quantity,
    returnReason: prepared.reason,
    returnStatus: prepared.status,
    returnState: prepared.state,
    returnAction: prepared.actionDue,
    returnInitiated: prepared.requestedAt,
    refundText: prepared.requestAmount,
    detailsUrl: prepared.detailsUrl,
    returnTrackingNumber: prepared.trackingNumber,
    returnFileIds: prepared.fileIds,
    returnFileCount: prepared.files.length,
    complaintImageUrls,
    ebayComplaintImages,
    returnDetails: {
      buyerComment: prepared.buyerComment,
      requestAmount: prepared.requestAmount,
      onHoldAmount: prepared.onHoldAmount,
      detailsUrl: prepared.detailsUrl,
      itemImageUrl: prepared.itemImageUrl,
      datePurchased: prepared.requestedAt,
      returnFileIds: prepared.fileIds,
      fileCount: prepared.files.length,
      complaintImageUrls,
      ebayComplaintImages,
      returnStatus: prepared.status,
      returnState: prepared.state,
      returnAction: prepared.actionDue,
      responseDueAt: prepared.dueAt,
      trackingNumber: prepared.trackingNumber,
    },
    ebaySummary: stripLargeEbayFields(prepared.summary),
    ebayDetail: stripLargeEbayFields(prepared.detail),
    ebayFiles: sanitizeEbayFilesPayload(prepared.filesPayload),
  };
}

function prepareReturn(summary: any, detailPayload: any, filesPayload: any): PreparedReturn | null {
  const detail = detailPayload?.detail || detailPayload || {};
  const detailSummary = detailPayload?.summary || {};
  const sourceSummary = summary?.summary || summary || {};
  const mergedSummary = { ...detailSummary, ...sourceSummary };
  const creation = mergedSummary?.creationInfo || detail?.creationInfo || {};
  const item = creation?.item || detail?.itemDetail || {};
  const sellerDue = mergedSummary?.sellerResponseDue || detail?.sellerResponseDue || {};
  const buyerDue = mergedSummary?.buyerResponseDue || detail?.buyerResponseDue || {};
  const refundContainer = getAmountContainer(
    mergedSummary?.sellerTotalRefund,
    mergedSummary?.buyerTotalRefund,
    detail?.refundInfo?.estimatedRefundAmount,
    detail?.refundInfo?.actualRefundAmount,
    detail?.moneyMovementInfo?.[0]?.amount,
  );
  const holdContainer = getAmountContainer(detail?.holdInfo?.holdAmount, detail?.payoutRecoupInfo?.recoupAmount);
  const files = unique([
    ...getFilesFromPayload(filesPayload),
    ...getFilesFromPayload(detail),
  ]);
  const fileIds = unique(files.map(fileIdFrom).filter(Boolean));
  const returnId = firstText(summary?.returnId, mergedSummary?.returnId, detail?.returnId, detailPayload?.returnId);
  if (!returnId) return null;

  const preparedBase = {
    source: summary,
    summary: mergedSummary,
    detail,
    filesPayload,
    returnId,
    orderNumber: firstText(mergedSummary?.orderId, detail?.orderId, creation?.orderId),
    buyerUsername: firstText(mergedSummary?.buyerLoginName, detail?.buyerLoginName),
    itemNumber: firstText(item?.itemId, item?.legacyItemId, detail?.itemDetail?.itemId),
    transactionId: firstText(item?.transactionId, detail?.itemDetail?.transactionId),
    itemTitle: firstText(item?.title, item?.itemTitle, detail?.itemDetail?.title, detail?.itemDetail?.itemTitle),
    quantity: Math.max(1, Math.trunc(toNumber(item?.returnQuantity, 1))),
    reason: firstText(creation?.reason, detail?.returnReason, detail?.buyerReturnReason),
    status: firstText(mergedSummary?.status, detail?.status),
    state: firstText(mergedSummary?.state, detail?.state),
    actionDue: firstText(sellerDue?.activityDue, buyerDue?.activityDue, mergedSummary?.sellerAvailableOptions?.[0]?.actionType),
    dueAt: firstDate(sellerDue?.respondByDate?.value, sellerDue?.respondByDate, buyerDue?.respondByDate?.value, mergedSummary?.timeoutDate?.value),
    requestedAt: firstDate(creation?.creationDate?.value, creation?.creationDate, mergedSummary?.creationDate?.value),
    buyerComment: commentText(creation?.comments?.content, creation?.comments, detail?.comments?.content, detail?.comments),
    requestAmount: moneyText(refundContainer),
    onHoldAmount: moneyText(holdContainer),
    detailsUrl: getActionUrl(mergedSummary),
    itemImageUrl: getItemImageUrl(detail, mergedSummary),
    trackingNumber: extractTracking(detail),
    fileIds,
    files,
  };

  return {
    ...preparedBase,
    payload: buildReturnPayload(preparedBase),
  };
}

async function getEbayAccessToken(): Promise<string> {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REFRESH_TOKEN) {
    throw new Error("Missing eBay OAuth secrets. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REFRESH_TOKEN.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: EBAY_REFRESH_TOKEN,
    scope: EBAY_RETURN_SCOPE,
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
      "Authorization": `IAF ${token}`,
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
    throw new Error(`eBay GET ${path} failed (${res.status}): ${text.slice(0, 1000)}`);
  }
  return payload;
}

async function ebayOptionalRequest(token: string, path: string): Promise<{ ok: true; payload: any } | { ok: false; error: string }> {
  try {
    return { ok: true, payload: await ebayRequest(token, path) };
  } catch (error) {
    return { ok: false, error: compactError(error) };
  }
}

async function fetchReturnSummaries(token: string, body: JsonRecord): Promise<ReturnSummaryFetch> {
  const limit = Math.min(Math.max(1, Math.trunc(Number(body.limit || 100))), MAX_RETURN_LIMIT);
  const daysBack = Math.min(Math.max(1, Math.trunc(Number(body.daysBack || DEFAULT_DAYS_BACK))), 540);
  const includeClosed = body.includeClosed === true;
  const from = toIsoDate(body.from) || new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const to = toIsoDate(body.to) || new Date().toISOString();
  const summaries: any[] = [];
  let totalEntries: number | null = null;

  for (let offset = 0; summaries.length < limit; offset += PAGE_LIMIT) {
    const params = new URLSearchParams({
      limit: String(Math.min(PAGE_LIMIT, limit - summaries.length)),
      offset: String(offset),
      creation_date_range_from: from,
      creation_date_range_to: to,
      sort: "-FILING_DATE",
    });
    if (!includeClosed) params.set("return_state", "ALL_OPEN");

    const payload = await ebayRequest(token, `/post-order/v2/return/search?${params.toString()}`);
    const page = Array.isArray(payload?.members) ? payload.members : [];
    summaries.push(...page);
    totalEntries = Number(payload?.paginationOutput?.totalEntries || 0);
    if (!page.length || summaries.length >= totalEntries) break;
  }

  return {
    summaries: summaries.slice(0, limit),
    totalEntries,
    truncated: totalEntries != null && totalEntries > summaries.length,
    from,
    to,
  };
}

function exactLineKey(orderId: string, itemNumber: string, transactionId: string): string {
  return `${orderId}:${itemNumber}:${transactionId}`;
}

function fallbackLineKey(orderId: string, itemNumber: string, title: string): string {
  return `${orderId}:${itemNumber}:${normalizeTitle(title)}`;
}

async function loadOrdersAndLines(supabase: any, orderNumbers: string[], itemNumbers: string[]) {
  const orders = new Map<string, any>();
  const ordersById = new Map<string, any>();
  const linesExact = new Map<string, any[]>();
  const linesFallback = new Map<string, any[]>();
  const linesByItemNumber = new Map<string, any[]>();
  const cleanOrderNumbers = unique(orderNumbers.map(toText).filter(Boolean));
  const cleanItemNumbers = unique(itemNumbers.map(toText).filter(Boolean));

  function indexLine(line: any) {
    const order = line.order || line.ebay_orders || ordersById.get(line.order_id) || null;
    if (order) line.order = order;
    const exact = exactLineKey(line.order_id, toText(line.item_number), toText(line.transaction_id));
    const fallback = fallbackLineKey(line.order_id, toText(line.item_number), line.item_title);
    linesExact.set(exact, [...(linesExact.get(exact) || []), line]);
    linesFallback.set(fallback, [...(linesFallback.get(fallback) || []), line]);
    const itemKey = normalizeLookup(line.item_number);
    if (itemKey) linesByItemNumber.set(itemKey, unique([...(linesByItemNumber.get(itemKey) || []), line]));
  }

  for (let index = 0; index < cleanOrderNumbers.length; index += 100) {
    const chunk = cleanOrderNumbers.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_orders")
      .select("id,order_number,buyer_username,status")
      .in("order_number", chunk);
    if (error) throw error;
    (data || []).forEach((order: any) => {
      orders.set(order.order_number, order);
      ordersById.set(order.id, order);
    });
  }

  const orderIds = [...orders.values()].map((order: any) => order.id).filter(Boolean);
  for (let index = 0; index < orderIds.length; index += 100) {
    const chunk = orderIds.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_order_lines")
      .select("id,order_id,item_number,transaction_id,item_title,quantity,line_status,internal_item_id")
      .in("order_id", chunk);
    if (error) throw error;
    (data || []).forEach(indexLine);
  }

  for (let index = 0; index < cleanItemNumbers.length; index += 100) {
    const chunk = cleanItemNumbers.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_order_lines")
      .select("id,order_id,item_number,transaction_id,item_title,quantity,line_status,internal_item_id,ebay_orders(id,order_number,buyer_username,status)")
      .in("item_number", chunk)
      .limit(1000);
    if (error) throw error;
    (data || []).forEach((line: any) => {
      if (line.ebay_orders) {
        line.order = line.ebay_orders;
        ordersById.set(line.order.id, line.order);
        orders.set(line.order.order_number, line.order);
      }
      indexLine(line);
    });
  }

  return { orders, ordersById, linesExact, linesFallback, linesByItemNumber };
}

function findMatches(prepared: PreparedReturn, indexes: any): MatchResult {
  const order = indexes.orders.get(prepared.orderNumber) || null;
  if (order) {
    const exact = indexes.linesExact.get(exactLineKey(order.id, prepared.itemNumber, prepared.transactionId)) || [];
    const fallback = indexes.linesFallback.get(fallbackLineKey(order.id, prepared.itemNumber, prepared.itemTitle)) || [];
    const sameOrderByItem = (indexes.linesByItemNumber.get(normalizeLookup(prepared.itemNumber)) || [])
      .filter((line: any) => line.order_id === order.id);
    const lines = unique([...exact, ...fallback, ...sameOrderByItem]).slice(0, prepared.quantity || 1);
    return { order, lines };
  }

  const candidates = indexes.linesByItemNumber.get(normalizeLookup(prepared.itemNumber)) || [];
  const buyer = normalizeLookup(prepared.buyerUsername);
  const buyerMatches = buyer
    ? candidates.filter((line: any) => normalizeLookup(line.order?.buyer_username) === buyer)
    : [];
  const selected = buyerMatches.length ? buyerMatches : candidates.length === 1 ? candidates : [];
  const fallbackOrder = selected[0]?.order || indexes.ordersById?.get(selected[0]?.order_id) || null;
  return {
    order: fallbackOrder,
    lines: selected.slice(0, prepared.quantity || 1),
  };
}

function localStatusFor(prepared: PreparedReturn, matched: boolean): string {
  const state = `${prepared.state} ${prepared.status}`.toUpperCase();
  if (state.includes("CLOSED")) return "closed";
  if (state.includes("CANCEL")) return "cancelled";
  return matched ? "open" : "needs_review";
}

function taskTypeFor(matched: boolean): string {
  return matched ? "return_intake" : "return_review";
}

function priorityFor(prepared: PreparedReturn, matched: boolean): string {
  const reason = `${prepared.reason} ${prepared.buyerComment}`.toLowerCase();
  if (!matched) return "high";
  if (reason.includes("description") || reason.includes("authentic") || reason.includes("wrong") || reason.includes("damaged")) return "high";
  return "normal";
}

function questionFor(prepared: PreparedReturn, matched: boolean): string {
  if (!matched) {
    return "No matching OG order history was found. Review the eBay buyer, item, reason, refund value, and return details before deciding the next step.";
  }
  return "Inspect the returned item, attach evidence photos, choose the disposition, and save the return.";
}

function caseLooksLikeReturn(row: any, prepared: PreparedReturn): boolean {
  const payload = row?.raw_payload || {};
  const details = payload?.returnDetails || {};
  const rowBuyer = normalizeLookup(row?.buyer_username || payload.buyerUsername || payload.buyer_username);
  const rowOrder = normalizeLookup(row?.order_number || payload.orderNumber || payload.order_number);
  const rowItem = normalizeLookup(payload.itemNumber || payload.item_number || details.itemNumber || details.item_number);
  const buyer = normalizeLookup(prepared.buyerUsername);
  const orderNumber = normalizeLookup(prepared.orderNumber);
  const itemNumber = normalizeLookup(prepared.itemNumber);

  if (rowOrder && orderNumber && rowOrder === orderNumber) return true;
  if (rowItem && itemNumber && rowItem === itemNumber && (!buyer || !rowBuyer || rowBuyer === buyer)) return true;
  return false;
}

async function findExistingCase(supabase: any, prepared: PreparedReturn, orderId: string | null): Promise<any | null> {
  if (prepared.returnId) {
    const { data, error } = await supabase
      .from("ebay_return_cases")
      .select("*")
      .eq("ebay_return_id", prepared.returnId)
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }
  if (orderId) {
    const { data, error } = await supabase
      .from("ebay_return_cases")
      .select("*")
      .eq("order_id", orderId)
      .not("status", "in", "(closed,cancelled)")
      .order("opened_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  if (prepared.orderNumber) {
    const { data, error } = await supabase
      .from("ebay_return_cases")
      .select("*")
      .eq("order_number", prepared.orderNumber)
      .not("status", "in", "(closed,cancelled)")
      .order("opened_at", { ascending: false })
      .limit(5);
    if (error) throw error;
    const found = (data || []).find((row: any) => caseLooksLikeReturn(row, prepared)) || data?.[0];
    if (found) return found;
  }

  if (prepared.buyerUsername || prepared.itemNumber) {
    let query = supabase
      .from("ebay_return_cases")
      .select("*")
      .not("status", "in", "(closed,cancelled)")
      .order("opened_at", { ascending: false })
      .limit(10);
    if (prepared.buyerUsername) query = query.eq("buyer_username", prepared.buyerUsername);
    const { data, error } = await query;
    if (error) throw error;
    const found = (data || []).find((row: any) => caseLooksLikeReturn(row, prepared));
    if (found) return found;
  }
  return null;
}

async function upsertCase(supabase: any, prepared: PreparedReturn, match: MatchResult): Promise<{ caseRow: any; created: boolean }> {
  const matched = Boolean(match.order && match.lines.length);
  const existing = await findExistingCase(supabase, prepared, match.order?.id || null);
  const status = localStatusFor(prepared, matched);
  const row = {
    order_id: match.order?.id || null,
    order_number: match.order?.order_number || prepared.orderNumber || null,
    case_type: matched ? "matched_order" : "unmatched_legacy",
    ebay_return_id: prepared.returnId || null,
    buyer_username: prepared.buyerUsername || match.order?.buyer_username || null,
    return_reason: prepared.reason || null,
    return_tracking_number: prepared.trackingNumber || null,
    status,
    opened_at: prepared.requestedAt || new Date().toISOString(),
    notes: existing?.notes || "Synced from eBay Return API.",
    raw_payload: {
      ...(existing?.raw_payload || {}),
      ...prepared.payload,
      caseType: matched ? "matched_order" : "unmatched_legacy",
      unmatchedReason: matched ? null : "No matching fulfilled OG order line was found.",
    },
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await supabase
      .from("ebay_return_cases")
      .update(row)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return { caseRow: data, created: false };
  }

  const { data, error } = await supabase
    .from("ebay_return_cases")
    .insert(row)
    .select("*")
    .single();
  if (error) throw error;
  return { caseRow: data, created: true };
}

async function upsertReturnItems(supabase: any, prepared: PreparedReturn, caseRow: any, match: MatchResult): Promise<number> {
  if (!match.order || !match.lines.length) return 0;
  const rows = match.lines.map((line: any) => ({
    return_case_id: caseRow.id,
    order_id: match.order.id,
    order_line_id: line.id,
    internal_item_id: line.internal_item_id || null,
    item_title: line.item_title || prepared.itemTitle || "Returned item",
    item_number: line.item_number || prepared.itemNumber || null,
    expected_quantity: Math.max(1, Math.trunc(Number(prepared.quantity || line.quantity || 1))),
    metadata: {
      source: "ebay_return_api",
      ebayReturnId: prepared.returnId,
      transactionId: prepared.transactionId,
      syncedAt: new Date().toISOString(),
    },
  }));
  const { data, error } = await supabase
    .from("ebay_return_items")
    .upsert(rows, { onConflict: "return_case_id,order_line_id", ignoreDuplicates: false })
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

async function upsertTask(supabase: any, prepared: PreparedReturn, caseRow: any, match: MatchResult): Promise<{ task: any | null; created: boolean; updated: boolean }> {
  const matched = Boolean(match.order && match.lines.length);
  const taskType = taskTypeFor(matched);
  const { data: existingTasks, error: taskError } = await supabase
    .from("ebay_return_tasks")
    .select("*")
    .eq("return_case_id", caseRow.id)
    .eq("task_type", taskType)
    .order("created_at", { ascending: false })
    .limit(1);
  if (taskError) throw taskError;
  const existing = existingTasks?.[0] || null;
  const metadata = {
    ...(existing?.metadata || {}),
    ...prepared.payload,
    caseType: matched ? "matched_order" : "unmatched_legacy",
  };
  const active = !existing || !["resolved", "cancelled"].includes(String(existing.status || ""));

  if (existing && !active) {
    const { data, error } = await supabase
      .from("ebay_return_tasks")
      .update({
        metadata: { ...metadata, duplicateReturnApiSyncIgnoredAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return { task: data, created: false, updated: true };
  }

  const row = {
    return_case_id: caseRow.id,
    order_id: match.order?.id || null,
    order_line_ids: match.lines.map((line: any) => line.id),
    task_type: taskType,
    title: matched ? "Complete eBay return intake" : "Review unmatched eBay return/refund",
    question: questionFor(prepared, matched),
    status: existing?.status || "open",
    priority: existing?.priority && ["high", "urgent"].includes(existing.priority) ? existing.priority : priorityFor(prepared, matched),
    due_at: prepared.dueAt,
    metadata,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await supabase
      .from("ebay_return_tasks")
      .update(row)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw error;
    return { task: data, created: false, updated: true };
  }

  const { data, error } = await supabase
    .from("ebay_return_tasks")
    .insert(row)
    .select("*")
    .single();
  if (error) throw error;

  await supabase
    .from("ebay_return_task_events")
    .insert({
      task_id: data.id,
      return_case_id: caseRow.id,
      action: "created",
      new_status: data.status,
      notes: matched ? "Return intake task opened from eBay Return API." : "Unmatched return review task opened from eBay Return API.",
      payload: metadata,
    });

  return { task: data, created: true, updated: false };
}

function responseHistoryMessages(prepared: PreparedReturn, caseRow: any, match: MatchResult): any[] {
  const history = Array.isArray(prepared.detail?.responseHistory) ? prepared.detail.responseHistory : [];
  const messages = [];
  if (prepared.buyerComment) {
    messages.push({
      key: `creation-comment:${prepared.returnId}:${prepared.requestedAt || ""}`,
      body: prepared.buyerComment,
      direction: "inbound",
      status: "imported",
      sentAt: prepared.requestedAt || new Date().toISOString(),
      metadata: { source: "ebay_return_api", kind: "buyer_creation_comment" },
    });
  }
  for (const entry of history) {
    const body = commentText(
      entry?.attributes?.comments?.content,
      entry?.attributes?.comment?.content,
      entry?.comments?.content,
      entry?.comment,
      entry?.comments,
    );
    if (!body) continue;
    const author = toText(entry?.author).toLowerCase();
    messages.push({
      key: `response-history:${prepared.returnId}:${entry?.activity || ""}:${getDateValue(entry?.creationDate) || ""}:${body.slice(0, 80)}`,
      body,
      direction: author.includes("seller") ? "outbound" : author.includes("buyer") ? "inbound" : "internal",
      status: "imported",
      sentAt: getDateValue(entry?.creationDate) || new Date().toISOString(),
      metadata: { source: "ebay_return_api", kind: "response_history", entry },
    });
  }
  return messages.map((message) => ({
    return_case_id: caseRow.id,
    order_id: match.order?.id || caseRow.order_id || null,
    order_number: caseRow.order_number || prepared.orderNumber || null,
    ebay_return_id: prepared.returnId,
    buyer_username: caseRow.buyer_username || prepared.buyerUsername || null,
    direction: message.direction,
    channel: "ebay_return_api",
    message_status: message.status,
    message_body: message.body,
    item_title: prepared.itemTitle || null,
    return_reason: prepared.reason || null,
    request_amount: prepared.requestAmount || null,
    page_url: prepared.detailsUrl || null,
    sent_at: message.sentAt,
    metadata: {
      ...message.metadata,
      ebayResponseHistoryKey: message.key,
      syncedAt: new Date().toISOString(),
    },
  }));
}

async function importMessages(supabase: any, prepared: PreparedReturn, caseRow: any, match: MatchResult): Promise<number> {
  const rows = responseHistoryMessages(prepared, caseRow, match);
  if (!rows.length) return 0;
  const { data: existing, error: existingError } = await supabase
    .from("ebay_return_messages")
    .select("id,metadata")
    .eq("ebay_return_id", prepared.returnId)
    .eq("channel", "ebay_return_api");
  if (existingError) throw existingError;
  const existingKeys = new Set((existing || []).map((row: any) => toText(row?.metadata?.ebayResponseHistoryKey)).filter(Boolean));
  const freshRows = rows.filter((row) => !existingKeys.has(toText(row.metadata?.ebayResponseHistoryKey)));
  if (!freshRows.length) return 0;
  const { data, error } = await supabase
    .from("ebay_return_messages")
    .insert(freshRows)
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

async function cleanupClosedReturnCases(
  supabase: any,
  openReturnIds: Set<string>,
  dryRun: boolean,
): Promise<{ casesClosed: number; tasksResolved: number; results: any[] }> {
  const { data: cases, error: caseError } = await supabase
    .from("ebay_return_cases")
    .select("id,ebay_return_id,order_number,buyer_username,status,raw_payload")
    .not("ebay_return_id", "is", null)
    .limit(1000);
  if (caseError) throw caseError;

  const staleCases = (cases || []).filter((row: any) => {
    const returnId = toText(row.ebay_return_id || row.raw_payload?.ebayReturnId);
    return returnId && !openReturnIds.has(returnId);
  });
  if (!staleCases.length) return { casesClosed: 0, tasksResolved: 0, results: [] };

  const staleCaseIds = staleCases.map((row: any) => row.id).filter(Boolean);
  const casesToClose = staleCases.filter((row: any) => !["closed", "cancelled"].includes(toText(row.status)));
  const caseIdsToClose = casesToClose.map((row: any) => row.id).filter(Boolean);
  const { data: tasks, error: taskError } = await supabase
    .from("ebay_return_tasks")
    .select("id,return_case_id,status")
    .in("return_case_id", staleCaseIds)
    .not("status", "in", "(resolved,cancelled)");
  if (taskError) throw taskError;

  const staleTasks = tasks || [];
  const cleanupResults = staleCases.map((row: any) => ({
    returnId: row.ebay_return_id || row.raw_payload?.ebayReturnId || "",
    orderNumber: row.order_number || "",
    buyerUsername: row.buyer_username || "",
    status: ["closed", "cancelled"].includes(toText(row.status))
      ? "already_closed"
      : dryRun ? "would_close" : "closed",
    caseId: row.id,
    previousStatus: row.status,
    staleTaskCount: staleTasks.filter((task: any) => task.return_case_id === row.id).length,
  }));

  if (dryRun) {
    return { casesClosed: casesToClose.length, tasksResolved: staleTasks.length, results: cleanupResults };
  }

  const now = new Date().toISOString();
  if (caseIdsToClose.length) {
    const { error: closeError } = await supabase
      .from("ebay_return_cases")
      .update({
        status: "closed",
        closed_at: now,
        updated_at: now,
      })
      .in("id", caseIdsToClose);
    if (closeError) throw closeError;
  }

  const staleTaskIds = staleTasks.map((task: any) => task.id).filter(Boolean);
  if (staleTaskIds.length) {
    const { error: resolveError } = await supabase
      .from("ebay_return_tasks")
      .update({
        status: "resolved",
        resolved_at: now,
        resolved_by_email: "ebay-return-sync",
        resolution_notes: "Resolved by eBay return cleaner because this return is no longer open on eBay.",
        updated_at: now,
      })
      .in("id", staleTaskIds);
    if (resolveError) throw resolveError;

    const { error: eventError } = await supabase
      .from("ebay_return_task_events")
      .insert(staleTasks.map((task: any) => ({
        task_id: task.id,
        return_case_id: task.return_case_id,
        action: "resolved",
        old_status: task.status,
        new_status: "resolved",
        notes: "Auto-resolved by eBay return cleaner: return no longer appears in eBay open returns.",
        signed_by_email: "ebay-return-sync",
        payload: {
          source: "ebay_return_api_cleanup",
          cleanedAt: now,
        },
      })));
    if (eventError) throw eventError;
  }

  return { casesClosed: casesToClose.length, tasksResolved: staleTasks.length, results: cleanupResults };
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
    const cleanupClosed = body.cleanupClosed === true;
    const { data: run, error: runError } = await supabase
      .from("ebay_return_sync_runs")
      .insert({ dry_run: dryRun, status: "running" })
      .select("id")
      .single();
    if (runError) throw runError;
    runId = run.id;

    const token = await getEbayAccessToken();
    const fetchResult = await fetchReturnSummaries(token, body);
    const summaries = fetchResult.summaries;
    const preparedReturns: PreparedReturn[] = [];
    const warnings: any[] = [];

    for (const summary of summaries) {
      const returnId = firstText(summary?.returnId, summary?.summary?.returnId);
      if (!returnId) {
        warnings.push({ reason: "missing_return_id", summary });
        continue;
      }
      const detailResult = await ebayOptionalRequest(token, `/post-order/v2/return/${encodeURIComponent(returnId)}?fieldgroups=FULL`);
      const filesResult = await ebayOptionalRequest(token, `/post-order/v2/return/${encodeURIComponent(returnId)}/files`);
      if (!detailResult.ok) warnings.push({ returnId, request: "detail", error: detailResult.error });
      if (!filesResult.ok) warnings.push({ returnId, request: "files", error: filesResult.error });
      const prepared = prepareReturn(summary, detailResult.ok ? detailResult.payload : {}, filesResult.ok ? filesResult.payload : {});
      if (prepared) preparedReturns.push(prepared);
    }

    const indexes = await loadOrdersAndLines(
      supabase,
      preparedReturns.map((entry) => entry.orderNumber),
      preparedReturns.map((entry) => entry.itemNumber),
    );
    const results = [];
    let matched = 0;
    let unmatched = 0;
    let tasksCreated = 0;
    let tasksUpdated = 0;
    let messagesImported = 0;
    let filesSeen = 0;
    let errors = 0;
    let staleCasesClosed = 0;
    let staleTasksResolved = 0;

    for (const prepared of preparedReturns) {
      try {
        const match = findMatches(prepared, indexes);
        const isMatched = Boolean(match.order && match.lines.length);
        if (isMatched) matched += 1;
        else unmatched += 1;
        filesSeen += prepared.files.length;

        if (dryRun) {
          results.push({
            returnId: prepared.returnId,
            orderNumber: prepared.orderNumber,
            buyerUsername: prepared.buyerUsername,
            itemNumber: prepared.itemNumber,
            itemTitle: prepared.itemTitle,
            reason: prepared.reason,
            status: prepared.status || prepared.state,
            actionDue: prepared.actionDue,
            dueAt: prepared.dueAt,
            requestAmount: prepared.requestAmount,
            buyerComment: prepared.buyerComment,
            fileCount: prepared.files.length,
            matched: isMatched,
            matchedLineCount: match.lines.length,
            wouldCreateTask: true,
          });
          continue;
        }

        const uploadedComplaintImages = await uploadEbayReturnFiles(supabase, prepared);
        prepared.payload = buildReturnPayload(prepared, uploadedComplaintImages);
        const { caseRow, created: caseCreated } = await upsertCase(supabase, prepared, match);
        await upsertReturnItems(supabase, prepared, caseRow, match);
        const taskResult = await upsertTask(supabase, prepared, caseRow, match);
        const importedMessageCount = await importMessages(supabase, prepared, caseRow, match);
        if (taskResult.created) tasksCreated += 1;
        if (taskResult.updated) tasksUpdated += 1;
        messagesImported += importedMessageCount;

        results.push({
          returnId: prepared.returnId,
          orderNumber: caseRow.order_number || prepared.orderNumber,
          buyerUsername: caseRow.buyer_username || prepared.buyerUsername,
          itemNumber: prepared.itemNumber,
          itemTitle: prepared.itemTitle,
          reason: prepared.reason,
          status: caseRow.status,
          actionDue: prepared.actionDue,
          dueAt: prepared.dueAt,
          requestAmount: prepared.requestAmount,
          buyerComment: prepared.buyerComment,
          fileCount: prepared.files.length,
          matched: isMatched,
          matchedLineCount: match.lines.length,
          caseId: caseRow.id,
          taskId: taskResult.task?.id || null,
          caseCreated,
          taskCreated: taskResult.created,
          taskUpdated: taskResult.updated,
          messagesImported: importedMessageCount,
        });
      } catch (error) {
        errors += 1;
        results.push({
          returnId: prepared.returnId,
          orderNumber: prepared.orderNumber,
          buyerUsername: prepared.buyerUsername,
          itemNumber: prepared.itemNumber,
          status: "error",
          matched: false,
          error: compactError(error),
        });
      }
    }

    if (cleanupClosed) {
      if (fetchResult.truncated) {
        warnings.push({
          reason: "cleanup_skipped_truncated_open_return_search",
          totalEntries: fetchResult.totalEntries,
          fetched: preparedReturns.length,
        });
      } else {
        try {
          const cleanup = await cleanupClosedReturnCases(
            supabase,
            new Set(preparedReturns.map((entry) => entry.returnId).filter(Boolean)),
            dryRun,
          );
          staleCasesClosed = cleanup.casesClosed;
          staleTasksResolved = cleanup.tasksResolved;
          results.push(...cleanup.results.map((entry) => ({
            ...entry,
            cleanup: true,
          })));
        } catch (error) {
          errors += 1;
          results.push({
            status: "error",
            cleanup: true,
            error: compactError(error),
          });
        }
      }
    }

    const completed = {
      status: errors ? "failed" : "completed",
      returns_seen: preparedReturns.length,
      cases_matched: matched,
      cases_unmatched: unmatched,
      tasks_created: tasksCreated,
      tasks_updated: tasksUpdated,
      messages_imported: messagesImported,
      files_seen: filesSeen,
      errors,
      warnings,
      finished_at: new Date().toISOString(),
    };
    await supabase.from("ebay_return_sync_runs").update(completed).eq("id", runId);

    return jsonResponse(200, {
      ok: errors === 0,
      runId,
      dryRun,
      total: preparedReturns.length,
      matched,
      unmatched,
      tasksCreated,
      tasksUpdated,
      messagesImported,
      filesSeen,
      cleanupClosed,
      staleCasesClosed,
      staleTasksResolved,
      errors,
      warnings,
      results,
    });
  } catch (error) {
    const message = compactError(error);
    if (runId) {
      await supabase
        .from("ebay_return_sync_runs")
        .update({
          status: "failed",
          errors: 1,
          warnings: [{ error: message }],
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    return jsonResponse(500, { ok: false, runId, error: message });
  }
});
