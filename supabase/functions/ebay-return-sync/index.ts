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
  sellerActionDue: string;
  buyerActionDue: string;
  sellerOptionTypes: string[];
  buyerOptionTypes: string[];
  lifecycleStage: string;
  classificationReason: string;
  dueAt: string | null;
  requestedAt: string | null;
  buyerComment: string;
  requestAmount: string;
  onHoldAmount: string;
  detailsUrl: string;
  orderDetailsUrl?: string;
  apiExtractedDetails?: JsonRecord;
  apiDetailsText?: string;
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
  laneCounts?: JsonRecord;
  warnings?: JsonRecord[];
};

type PostOrderIssueLane = "return" | "inquiry";

type IssueLaneConfig = {
  lane: PostOrderIssueLane;
  path: string;
  stateParam: string;
  openState: string;
  sort: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const EBAY_CLIENT_ID = (Deno.env.get("EBAY_CLIENT_ID") ?? Deno.env.get("EBAY_APP_ID") ?? "").trim();
const EBAY_CLIENT_SECRET = (Deno.env.get("EBAY_CLIENT_SECRET") ?? Deno.env.get("EBAY_CERT_ID") ?? "").trim();
const EBAY_REFRESH_TOKEN = (Deno.env.get("EBAY_REFRESH_TOKEN") ?? "").trim();
const EBAY_ENV = (Deno.env.get("EBAY_ENV") ?? "production").trim().toLowerCase();
const EBAY_FINANCES_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.finances";
const EBAY_RETURN_SCOPE = unique([
  ...(Deno.env.get("EBAY_RETURN_SCOPE") ?? Deno.env.get("EBAY_ORDER_SCOPE") ??
    "https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly https://api.ebay.com/oauth/api_scope/sell.fulfillment")
    .split(/\s+/),
  EBAY_FINANCES_SCOPE,
].map(toText).filter(Boolean)).join(" ");

const EBAY_API_BASE = EBAY_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const EBAY_FINANCES_API_BASE = EBAY_ENV === "sandbox" ? "https://apiz.sandbox.ebay.com" : "https://apiz.ebay.com";
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

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function commentText(...values: unknown[]): string {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number") {
      const text = decodeHtmlEntities(toText(value)).replace(/\s+/g, " ").trim();
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
    if (Array.isArray(record.textSpans)) {
      const text = commentText(...record.textSpans.map((span: any) => span?.text || span?.content || span));
      if (text) return text;
    }
    const text = commentText(
      record.content,
      record.text,
      record.textValue,
      record.plainText,
      record.message,
      record.messageText,
      record.comment,
      record.comments,
      record.note,
      record.notes,
      record.value,
      record.localizedText,
      record.sellerComments,
      record.sellerComment,
      record.buyerComments,
      record.buyerComment,
      record.returnComments,
      record.additionalInfo,
    );
    if (text) return text;
  }
  return "";
}

function normalizeMessageText(value: unknown): string {
  return decodeHtmlEntities(toText(value)).replace(/\s+/g, " ").trim().toLowerCase();
}

function looksLikeReferenceOnlyMessage(value: unknown, prepared: PreparedReturn): boolean {
  const text = normalizeMessageText(value);
  if (!text) return true;
  if (text.length < 3) return true;
  const references = [
    prepared.returnId,
    prepared.orderNumber,
    prepared.itemNumber,
    prepared.transactionId,
    prepared.requestAmount,
    prepared.onHoldAmount,
  ].map(normalizeMessageText).filter(Boolean);
  if (references.includes(text)) return true;
  return /^\d{5,}$/.test(text.replace(/[-\s]/g, ""));
}

function findEbayPageModuleContainers(root: unknown, depth = 0, seen = new Set<unknown>()): any[] {
  if (!root || typeof root !== "object" || depth > 5 || seen.has(root)) return [];
  seen.add(root);
  const record = root as any;
  const containers: any[] = [];
  if (record.MESSAGE_SUMMARY || record.HISTORY) containers.push(record);
  for (const candidate of [
    record.modules,
    record.inputModules?.response?.modules,
    record.response?.modules,
    record.model?.modules,
    record.data?.modules,
    record.s?.modules,
  ]) {
    if (candidate && typeof candidate === "object" && (candidate.MESSAGE_SUMMARY || candidate.HISTORY)) {
      containers.push(candidate);
    }
  }
  if (Array.isArray(root)) {
    for (const item of root) containers.push(...findEbayPageModuleContainers(item, depth + 1, seen));
  } else {
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") containers.push(...findEbayPageModuleContainers(value, depth + 1, seen));
    }
  }
  return [...new Set(containers)];
}

function pageModelHistoryMessages(prepared: PreparedReturn): Array<{
  key: string;
  body: string;
  direction: "inbound" | "outbound" | "internal";
  status: string;
  sentAt: string;
  metadata: JsonRecord;
}> {
  const containers = findEbayPageModuleContainers([prepared.detail, prepared.summary, prepared.source, prepared.payload]);
  const messages: Array<{
    key: string;
    body: string;
    direction: "inbound" | "outbound" | "internal";
    status: string;
    sentAt: string;
    metadata: JsonRecord;
  }> = [];

  for (const modules of containers) {
    const historyActivities = Array.isArray(modules?.HISTORY?.historyActivities)
      ? modules.HISTORY.historyActivities
      : [];
    const messageSummaryBody = commentText(
      modules?.MESSAGE_SUMMARY?.comments?.description,
      modules?.MESSAGE_SUMMARY?.comments?.message,
      modules?.MESSAGE_SUMMARY?.comments?.value,
    );
    if (messageSummaryBody && !looksLikeReferenceOnlyMessage(messageSummaryBody, prepared)) {
      const matchingHistory = historyActivities.find((activity: any) => {
        const title = commentText(activity?.historyDetail?.title, activity?.title).toLowerCase();
        const body = commentText(activity?.historyDetail?.descriptions, activity?.descriptions);
        return /sent.*message|message.*sent|you sent/i.test(title) && normalizeMessageText(body) === normalizeMessageText(messageSummaryBody);
      });
      messages.push({
        key: `page-message-summary:${prepared.returnId}:${messageSummaryBody.slice(0, 80)}`,
        body: messageSummaryBody,
        direction: "outbound",
        status: "imported",
        sentAt: getDateValue(matchingHistory?.date) || prepared.requestedAt || new Date().toISOString(),
        metadata: { source: "ebay_return_page_model", kind: "message_summary", modulesKey: "MESSAGE_SUMMARY" },
      });
    }

    historyActivities.forEach((activity: any, index: number) => {
      const title = commentText(activity?.historyDetail?.title, activity?.title);
      const body = commentText(activity?.historyDetail?.descriptions, activity?.descriptions);
      if (!body || looksLikeReferenceOnlyMessage(body, prepared)) return;
      const titleKey = title.toLowerCase();
      const direction = /you sent|seller.*sent|sent.*message|message.*sent/.test(titleKey)
        ? "outbound"
        : /buyer|return started|buyer sent|buyer message/.test(titleKey)
          ? "inbound"
          : "internal";
      messages.push({
        key: `page-history:${prepared.returnId}:${index}:${title}:${body.slice(0, 80)}`,
        body,
        direction,
        status: "imported",
        sentAt: getDateValue(activity?.date) || prepared.requestedAt || new Date().toISOString(),
        metadata: { source: "ebay_return_page_model", kind: "history_activity", title, activity },
      });
    });
  }

  return messages;
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

const EBAY_ORDER_NUMBER_PATTERN = /\b\d{2}-\d{5}-\d{5}\b/;
const EBAY_ITEM_NUMBER_PATTERN = /\b\d{9,15}\b/;

type DeepTextCandidate = {
  key: string;
  path: string;
  text: string;
};

function cleanDeepText(value: unknown): string {
  return decodeHtmlEntities(toText(value)).replace(/\s+/g, " ").trim();
}

function collectDeepText(
  value: unknown,
  key = "",
  path = "",
  depth = 0,
  seen = new Set<object>(),
  output: DeepTextCandidate[] = [],
): DeepTextCandidate[] {
  if (value == null || depth > 8) return output;

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = cleanDeepText(value);
    if (text && text !== "[object Object]") output.push({ key, path, text });
    return output;
  }

  if (value instanceof Date) {
    output.push({ key, path, text: value.toISOString() });
    return output;
  }

  if (typeof value !== "object") return output;
  if (seen.has(value)) return output;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((child, index) => collectDeepText(child, String(index), path, depth + 1, seen, output));
    return output;
  }

  for (const [childKey, child] of Object.entries(value as JsonRecord)) {
    const childPath = path ? `${path}.${childKey}` : childKey;
    collectDeepText(child, childKey, childPath, depth + 1, seen, output);
  }
  return output;
}

function collectDeepTexts(...values: unknown[]): DeepTextCandidate[] {
  const output: DeepTextCandidate[] = [];
  values.forEach((value, index) => collectDeepText(value, "", `source${index}`, 0, new Set<object>(), output));
  return output;
}

function candidatePath(candidate: DeepTextCandidate): string {
  return `${candidate.path} ${candidate.key}`;
}

function findDeepPattern(
  candidates: DeepTextCandidate[],
  valuePattern: RegExp,
  keyPattern?: RegExp,
): string {
  for (const candidate of candidates) {
    if (keyPattern && !keyPattern.test(candidatePath(candidate))) continue;
    const match = candidate.text.match(valuePattern);
    if (match?.[0]) return match[0];
  }
  return "";
}

function findDeepTextValue(
  candidates: DeepTextCandidate[],
  keyPattern: RegExp,
  isValid: (text: string, candidate: DeepTextCandidate) => boolean = (text) => Boolean(text),
): string {
  for (const candidate of candidates) {
    if (!keyPattern.test(candidatePath(candidate))) continue;
    const text = candidate.text;
    if (isValid(text, candidate)) return text;
  }
  return "";
}

function findDeepOrderNumber(...values: unknown[]): string {
  const candidates = collectDeepTexts(...values);
  return findDeepPattern(candidates, EBAY_ORDER_NUMBER_PATTERN, /(order|salesrecord|transaction)/i)
    || findDeepPattern(candidates, EBAY_ORDER_NUMBER_PATTERN);
}

function findDeepItemNumber(...values: unknown[]): string {
  const candidates = collectDeepTexts(...values);
  return findDeepPattern(candidates, EBAY_ITEM_NUMBER_PATTERN, /(item|listing|legacy)/i);
}

function findDeepTransactionId(...values: unknown[]): string {
  const candidates = collectDeepTexts(...values);
  return findDeepPattern(candidates, EBAY_ITEM_NUMBER_PATTERN, /(transaction|txn)/i);
}

function findDeepBuyerUsername(...values: unknown[]): string {
  const candidates = collectDeepTexts(...values);
  return findDeepTextValue(candidates, /(buyer|purchaser|recipient)/i, (text, candidate) => {
    const path = candidatePath(candidate);
    if (/seller/i.test(path) && !/buyer/i.test(path)) return false;
    if (/(comment|message|note|reason|description|text)/i.test(path)) return false;
    if (EBAY_ORDER_NUMBER_PATTERN.test(text) || EBAY_ITEM_NUMBER_PATTERN.test(text)) return false;
    if (/^\d+(?:\.\d+)?$/.test(text) || /\$|usd|reported|reason|received|request/i.test(text)) return false;
    return text.length >= 2 && text.length <= 80;
  });
}

function findDeepItemTitle(...values: unknown[]): string {
  const candidates = collectDeepTexts(...values);
  return findDeepTextValue(candidates, /(item|listing|product).*(title|name)|itemtitle|listingtitle/i, (text) => {
    if (text.length < 5 || text.length > 220) return false;
    if (/^https?:\/\//i.test(text) || EBAY_ORDER_NUMBER_PATTERN.test(text)) return false;
    if (/^(item not received|not as described|missing parts|defective item)$/i.test(text)) return false;
    return !/^\d+$/.test(text);
  });
}

function findDeepReason(...values: unknown[]): string {
  const candidates = collectDeepTexts(...values);
  return findDeepTextValue(candidates, /(reason|issue|problem|case|inquiry|request).*?(type|reason|description)?/i, (text, candidate) => {
    const path = candidatePath(candidate);
    const normalized = text.trim().toLowerCase();
    if (!text || text.length > 400) return false;
    if (/(id|lane|url|href|link)$/i.test(path)) return false;
    if (["return", "inquiry", "request", "case"].includes(normalized)) return false;
    if (EBAY_ORDER_NUMBER_PATTERN.test(text) || /^\d+$/.test(text)) return false;
    return !/^https?:\/\//i.test(text);
  });
}

function findDeepStatus(...values: unknown[]): string {
  const candidates = collectDeepTexts(...values);
  return findDeepTextValue(candidates, /(status|state)$/i, (text) => text.length > 1 && text.length <= 120);
}

function findDeepActionDue(...values: unknown[]): string {
  const candidates = collectDeepTexts(...values);
  return findDeepTextValue(candidates, /(action|activity|seller|buyer).*(due|required|option)|availableoptions/i, (text) => {
    if (text.length > 220 || /^https?:\/\//i.test(text)) return false;
    return !EBAY_ORDER_NUMBER_PATTERN.test(text);
  });
}

function findDeepDateByKey(keyPattern: RegExp, ...values: unknown[]): string | null {
  const candidates = collectDeepTexts(...values);
  for (const candidate of candidates) {
    if (!keyPattern.test(candidatePath(candidate))) continue;
    const iso = firstDate(candidate.text);
    if (iso) return iso;
  }
  return null;
}

function findDeepUrl(...values: unknown[]): string {
  const candidates = collectDeepTexts(...values);
  return findDeepTextValue(candidates, /(detail|action|case|request|return|inquiry|url|href|link)/i, (text, candidate) => {
    if (!/^https?:\/\//i.test(text)) return false;
    const path = candidatePath(candidate);
    if (/(image|picture|thumbnail|photo|avatar|logo)/i.test(path) || /\.(?:png|jpe?g|gif|webp)(?:\?|$)/i.test(text)) return false;
    return true;
  });
}

function findDeepMoneyText(...values: unknown[]): string {
  const found = findDeepMoneyContainer(values);
  if (found) return moneyText(found);
  const candidates = collectDeepTexts(...values);
  const text = findDeepTextValue(candidates, /(amount|refund|total|price|value|cost|hold)/i, (candidateText) => (
    /\$|usd/i.test(candidateText) && /\d/.test(candidateText)
  ));
  if (!text) return "";
  const numeric = Number(text.replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? `USD ${numeric.toFixed(2)}` : text;
}

function findDeepMoneyContainer(values: unknown[], depth = 0, seen = new Set<object>()): any {
  if (depth > 8) return null;
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      const found = findDeepMoneyContainer(value, depth + 1, seen);
      if (found) return found;
      continue;
    }
    const record = value as any;
    if (record.currency && record.value != null) return record;
    const direct = getAmountContainer(record.amount, record.refundAmount, record.totalAmount, record.price, record.value);
    if (direct) return direct;
    for (const [key, child] of Object.entries(record)) {
      if (/(amount|refund|total|price|cost|hold)/i.test(key)) {
        if (child && typeof child === "object") {
          const amount = getAmountContainer(child);
          if (amount) return amount;
        }
        const numeric = Number(child);
        if (Number.isFinite(numeric) && numeric > 1) return { currency: "USD", value: numeric };
      }
      if (child && typeof child === "object") {
        const found = findDeepMoneyContainer([child], depth + 1, seen);
        if (found) return found;
      }
    }
  }
  return null;
}

function ebayOrderDetailsUrl(orderNumber: string): string {
  const cleanNumber = toText(orderNumber);
  return cleanNumber
    ? `https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(cleanNumber)}`
    : "";
}

function pruneEmptyRecord(record: JsonRecord): JsonRecord {
  const output: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && !value.length) continue;
    output[key] = value;
  }
  return output;
}

function buildApiDetailsText(details: JsonRecord): string {
  return [
    details.requestId ? `Request ${details.requestId}` : "",
    details.issueLane ? `Lane ${details.issueLane}` : "",
    details.orderNumber ? `Order ${details.orderNumber}` : "",
    details.buyerUsername ? `Buyer ${details.buyerUsername}` : "",
    details.itemNumber || details.itemTitle ? `Item ${[details.itemNumber, details.itemTitle].filter(Boolean).join(" - ")}` : "",
    details.requestAmount ? `Amount ${details.requestAmount}` : "",
    details.reason ? `Reason ${details.reason}` : "",
    details.status ? `Status ${details.status}` : "",
  ].map((value) => toText(value)).filter(Boolean).join(" | ");
}

const TRACKING_KEY_PATTERN = /(tracking|shipment|package|carrier)/i;
const TRACKING_NUMBER_PATTERN = /\b(?:1Z[A-Z0-9]{16}|[A-Z]{2}\d{9}[A-Z]{2}|\d{18,34})\b/i;
const TRACKING_NUMBER_KEYED_PATTERN = /\b(?:1Z[A-Z0-9]{16}|[A-Z]{2}\d{9}[A-Z]{2}|\d{12,34})\b/i;

function trackingTextFromValue(value: unknown, keyed = false): string {
  const text = toText(value);
  if (!text || text === "[object Object]") return "";
  const match = text.match(keyed ? TRACKING_NUMBER_KEYED_PATTERN : TRACKING_NUMBER_PATTERN);
  return match?.[0] || "";
}

function collectTrackingNumbers(value: unknown, depth = 0, keyed = false, seen = new Set<object>()): string[] {
  if (value === null || value === undefined || depth > 6) return [];
  const direct = trackingTextFromValue(value, keyed);
  if (direct) return [direct];
  if (typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  if (Array.isArray(value)) {
    return unique(value.slice(0, 100).flatMap((entry) => collectTrackingNumbers(entry, depth + 1, keyed, seen)));
  }

  const values: string[] = [];
  for (const [key, entry] of Object.entries(value as JsonRecord)) {
    const childKeyed = keyed || TRACKING_KEY_PATTERN.test(key);
    const childDirect = trackingTextFromValue(entry, childKeyed);
    if (childDirect) values.push(childDirect);
    if (typeof entry === "object" && entry !== null) {
      values.push(...collectTrackingNumbers(entry, depth + 1, childKeyed, seen));
    }
  }
  return unique(values);
}

function firstTrackingText(...values: unknown[]): string {
  for (const value of values) {
    const text = trackingTextFromValue(value, true) || toText(value);
    if (text && text !== "[object Object]") return text;
  }
  return "";
}

function extractTracking(detail: any, summary: any = {}): string {
  const history = Array.isArray(detail?.responseHistory) ? detail.responseHistory : [];
  const direct = firstTrackingText(
    detail?.buyerReturnShipmentInfo?.shipmentTracking?.trackingNumber,
    detail?.buyerReturnShipmentInfo?.trackingNumber,
    detail?.returnShipmentInfo?.shipmentTracking?.trackingNumber,
    detail?.returnShipmentInfo?.trackingNumber,
    detail?.shipmentTracking?.trackingNumber,
    detail?.replacementShipmentInfo?.shipmentTracking?.trackingNumber,
    summary?.buyerReturnShipmentInfo?.shipmentTracking?.trackingNumber,
    summary?.buyerReturnShipmentInfo?.trackingNumber,
    summary?.returnShipmentInfo?.shipmentTracking?.trackingNumber,
    summary?.returnShipmentInfo?.trackingNumber,
    summary?.shipmentTracking?.trackingNumber,
    ...history.map((entry: any) => entry?.attributes?.updatedTrackingNumber),
  );
  if (direct) return direct;
  return firstText(...collectTrackingNumbers(detail), ...collectTrackingNumbers(summary));
}

function buildReturnPayload(prepared: Omit<PreparedReturn, "payload">, uploadedComplaintImages: any[] = []): JsonRecord {
  const ebayComplaintImages = uploadedComplaintImages.length ? uploadedComplaintImages : getComplaintImages(prepared.files);
  const complaintImageUrls = ebayComplaintImages.map((image) => image.url).filter(Boolean);
  const issueLane = firstText(
    prepared.source?.__ogIssueLane,
    prepared.summary?.__ogIssueLane,
    (prepared.apiExtractedDetails as any)?.issueLane,
    "return",
  );
  return {
    source: "ebay_return_api",
    syncedAt: new Date().toISOString(),
    caseType: prepared.orderNumber ? "matched_or_unmatched_by_order" : "unmatched_legacy",
    ebayReturnId: prepared.returnId,
    ebayIssueId: prepared.returnId,
    ebayRequestId: prepared.returnId,
    postOrderIssueLane: issueLane,
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
    sellerActionDue: prepared.sellerActionDue,
    buyerActionDue: prepared.buyerActionDue,
    sellerOptionTypes: prepared.sellerOptionTypes,
    buyerOptionTypes: prepared.buyerOptionTypes,
    returnLifecycleStage: prepared.lifecycleStage,
    returnClassificationReason: prepared.classificationReason,
    returnInitiated: prepared.requestedAt,
    refundText: prepared.requestAmount,
    detailsUrl: prepared.detailsUrl,
    orderDetailsUrl: prepared.orderDetailsUrl,
    apiExtractedDetails: prepared.apiExtractedDetails,
    apiDetailsText: prepared.apiDetailsText,
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
      orderDetailsUrl: prepared.orderDetailsUrl,
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
  const sellerOptionTypes = unique([
    ...(Array.isArray(mergedSummary?.sellerAvailableOptions) ? mergedSummary.sellerAvailableOptions : []),
    ...(Array.isArray(detail?.sellerAvailableOptions) ? detail.sellerAvailableOptions : []),
  ].map((option: any) => firstText(option?.actionType)).filter(Boolean));
  const buyerOptionTypes = unique([
    ...(Array.isArray(mergedSummary?.buyerAvailableOptions) ? mergedSummary.buyerAvailableOptions : []),
    ...(Array.isArray(detail?.buyerAvailableOptions) ? detail.buyerAvailableOptions : []),
  ].map((option: any) => firstText(option?.actionType)).filter(Boolean));
  const sellerActionDue = firstText(sellerDue?.activityDue);
  const buyerActionDue = firstText(buyerDue?.activityDue);
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

  const apiSources = [summary, detailPayload, detailSummary, sourceSummary, mergedSummary, detail, creation, item];
  const orderNumber = firstText(mergedSummary?.orderId, detail?.orderId, creation?.orderId, findDeepOrderNumber(...apiSources));
  const buyerUsername = firstText(mergedSummary?.buyerLoginName, detail?.buyerLoginName, findDeepBuyerUsername(...apiSources));
  const itemNumber = firstText(item?.itemId, item?.legacyItemId, detail?.itemDetail?.itemId, findDeepItemNumber(...apiSources));
  const transactionId = firstText(item?.transactionId, detail?.itemDetail?.transactionId, findDeepTransactionId(...apiSources));
  const itemTitle = firstText(item?.title, item?.itemTitle, detail?.itemDetail?.title, detail?.itemDetail?.itemTitle, findDeepItemTitle(...apiSources));
  const reason = firstText(creation?.reason, detail?.returnReason, detail?.buyerReturnReason, findDeepReason(...apiSources));
  const status = firstText(mergedSummary?.status, detail?.status, findDeepStatus(...apiSources));
  const state = firstText(mergedSummary?.state, detail?.state);
  const actionDue = firstText(sellerActionDue, buyerActionDue, sellerOptionTypes[0], findDeepActionDue(...apiSources));
  const dueAt = firstDate(
    sellerDue?.respondByDate?.value,
    sellerDue?.respondByDate,
    buyerDue?.respondByDate?.value,
    mergedSummary?.timeoutDate?.value,
    findDeepDateByKey(/respond|deadline|due|resolve|timeout/i, ...apiSources),
  );
  const requestedAt = firstDate(
    creation?.creationDate?.value,
    creation?.creationDate,
    mergedSummary?.creationDate?.value,
    findDeepDateByKey(/creation|created|open|opened|filed|filing|requested/i, ...apiSources),
  );
  const buyerComment = commentText(creation?.comments?.content, creation?.comments, detail?.comments?.content, detail?.comments);
  const requestAmount = moneyText(refundContainer) || findDeepMoneyText(...apiSources);
  const onHoldAmount = moneyText(holdContainer);
  const detailsUrl = getActionUrl(mergedSummary) || findDeepUrl(...apiSources);
  const orderDetailsUrl = ebayOrderDetailsUrl(orderNumber);
  const apiExtractedDetails = pruneEmptyRecord({
    source: "ebay_post_order_api",
    issueLane: "return",
    requestId: returnId,
    orderNumber,
    orderDetailsUrl,
    buyerUsername,
    itemNumber,
    transactionId,
    itemTitle,
    quantity: Math.max(1, Math.trunc(toNumber(item?.returnQuantity, 1))),
    reason,
    status,
    state,
    actionDue,
    dueAt,
    requestedAt,
    buyerComment,
    requestAmount,
    onHoldAmount,
    detailsUrl,
  });

  const preparedBase = {
    source: summary,
    summary: mergedSummary,
    detail,
    filesPayload,
    returnId,
    orderNumber,
    buyerUsername,
    itemNumber,
    transactionId,
    itemTitle,
    quantity: Math.max(1, Math.trunc(toNumber(item?.returnQuantity, 1))),
    reason,
    status,
    state,
    actionDue,
    sellerActionDue,
    buyerActionDue,
    sellerOptionTypes,
    buyerOptionTypes,
    dueAt,
    requestedAt,
    buyerComment,
    requestAmount,
    onHoldAmount,
    detailsUrl,
    orderDetailsUrl,
    apiExtractedDetails,
    apiDetailsText: buildApiDetailsText(apiExtractedDetails),
    itemImageUrl: getItemImageUrl(detail, mergedSummary),
    trackingNumber: extractTracking(detail, mergedSummary),
    fileIds,
    files,
  };
  const lifecycleStage = returnLifecycleStage(preparedBase as PreparedReturn);
  const classificationReason = returnClassificationReason(preparedBase as PreparedReturn, lifecycleStage);
  const preparedWithClassification = {
    ...preparedBase,
    lifecycleStage,
    classificationReason,
  };

  return {
    ...preparedWithClassification,
    payload: buildReturnPayload(preparedWithClassification),
  };
}

function firstArray(...values: unknown[]): any[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function postOrderIssueId(summary: any, detailPayload: any = {}): string {
  const detail = detailPayload?.detail || detailPayload || {};
  const sourceSummary = summary?.summary || summary || {};
  return firstText(
    summary?.returnId,
    sourceSummary?.returnId,
    detail?.returnId,
    summary?.inquiryId,
    sourceSummary?.inquiryId,
    detail?.inquiryId,
    summary?.requestId,
    sourceSummary?.requestId,
    detail?.requestId,
    summary?.caseId,
    sourceSummary?.caseId,
    detail?.caseId,
  );
}

function getIssueActionUrl(summary: any, detail: any = {}): string {
  return getActionUrl(summary?.summary || summary)
    || getActionUrl(detail)
    || firstText(summary?.detailsUrl, summary?.detailUrl, detail?.detailsUrl, detail?.detailUrl);
}

function preparePostOrderIssue(
  summary: any,
  detailPayload: any,
  filesPayload: any,
  lane: PostOrderIssueLane,
): PreparedReturn | null {
  if (lane === "return") return prepareReturn(summary, detailPayload, filesPayload);

  const detail = detailPayload?.detail || detailPayload || {};
  const detailSummary = detailPayload?.summary || {};
  const sourceSummary = summary?.summary || summary || {};
  const mergedSummary = { ...detailSummary, ...sourceSummary };
  const creation = mergedSummary?.creationInfo || detail?.creationInfo || {};
  const item = creation?.item || detail?.itemDetail || mergedSummary?.item || detail?.item || {};
  const sellerDue = mergedSummary?.sellerResponseDue || detail?.sellerResponseDue || mergedSummary?.sellerDue || {};
  const buyerDue = mergedSummary?.buyerResponseDue || detail?.buyerResponseDue || {};
  const sellerOptionTypes = unique([
    ...firstArray(mergedSummary?.sellerAvailableOptions, detail?.sellerAvailableOptions),
  ].map((option: any) => firstText(option?.actionType, option?.type, option)).filter(Boolean));
  const buyerOptionTypes = unique([
    ...firstArray(mergedSummary?.buyerAvailableOptions, detail?.buyerAvailableOptions),
  ].map((option: any) => firstText(option?.actionType, option?.type, option)).filter(Boolean));
  const sellerActionDue = firstText(sellerDue?.activityDue, mergedSummary?.sellerActionDue, detail?.sellerActionDue);
  const buyerActionDue = firstText(buyerDue?.activityDue, mergedSummary?.buyerActionDue, detail?.buyerActionDue);
  const refundContainer = getAmountContainer(
    mergedSummary?.amount,
    mergedSummary?.requestAmount,
    mergedSummary?.sellerTotalRefund,
    mergedSummary?.buyerTotalRefund,
    detail?.amount,
    detail?.requestAmount,
    detail?.refundInfo?.estimatedRefundAmount,
    detail?.refundInfo?.actualRefundAmount,
  );
  const holdContainer = getAmountContainer(detail?.holdInfo?.holdAmount, detail?.payoutRecoupInfo?.recoupAmount);
  const files = unique([
    ...getFilesFromPayload(filesPayload),
    ...getFilesFromPayload(detail),
  ]);
  const fileIds = unique(files.map(fileIdFrom).filter(Boolean));
  const issueId = postOrderIssueId(summary, detailPayload);
  if (!issueId) return null;

  const apiSources = [summary, detailPayload, detailSummary, sourceSummary, mergedSummary, detail, creation, item];
  const orderNumber = firstText(
    mergedSummary?.orderId,
    mergedSummary?.orderNumber,
    detail?.orderId,
    detail?.orderNumber,
    creation?.orderId,
    findDeepOrderNumber(...apiSources),
  );
  const buyerUsername = firstText(
    mergedSummary?.buyerLoginName,
    mergedSummary?.buyerUsername,
    mergedSummary?.buyerUserName,
    detail?.buyerLoginName,
    detail?.buyerUsername,
    detail?.buyerUserName,
    detail?.buyer?.username,
    detail?.buyer?.userName,
    findDeepBuyerUsername(...apiSources),
  );
  const itemNumber = firstText(item?.itemId, item?.legacyItemId, item?.listingId, detail?.itemDetail?.itemId, findDeepItemNumber(...apiSources));
  const transactionId = firstText(item?.transactionId, detail?.itemDetail?.transactionId, findDeepTransactionId(...apiSources));
  const itemTitle = firstText(item?.title, item?.itemTitle, detail?.itemDetail?.title, detail?.itemDetail?.itemTitle, findDeepItemTitle(...apiSources));
  const quantity = Math.max(1, Math.trunc(toNumber(item?.quantity, toNumber(item?.returnQuantity, 1))));
  const reason = firstText(
    creation?.reason,
    mergedSummary?.reason,
    mergedSummary?.issueType,
    detail?.reason,
    detail?.inquiryReason,
    detail?.caseReason,
    detail?.buyerInquiryReason,
    findDeepReason(...apiSources),
  );
  const status = firstText(mergedSummary?.status, detail?.status, findDeepStatus(...apiSources));
  const state = firstText(mergedSummary?.state, detail?.state);
  const actionDue = firstText(sellerActionDue, buyerActionDue, sellerOptionTypes[0], findDeepActionDue(...apiSources));
  const dueAt = firstDate(
    sellerDue?.respondByDate?.value,
    sellerDue?.respondByDate,
    buyerDue?.respondByDate?.value,
    mergedSummary?.respondByDate?.value,
    mergedSummary?.respondByDate,
    mergedSummary?.timeoutDate?.value,
    detail?.respondByDate?.value,
    detail?.respondByDate,
    findDeepDateByKey(/respond|deadline|due|resolve|timeout/i, ...apiSources),
  );
  const requestedAt = firstDate(
    creation?.creationDate?.value,
    creation?.creationDate,
    mergedSummary?.creationDate?.value,
    mergedSummary?.creationDate,
    mergedSummary?.openedDate?.value,
    detail?.creationDate?.value,
    detail?.creationDate,
    detail?.openedDate?.value,
    findDeepDateByKey(/creation|created|open|opened|filed|filing|requested/i, ...apiSources),
  );
  const buyerComment = commentText(
    creation?.comments?.content,
    creation?.comments,
    mergedSummary?.buyerComment,
    mergedSummary?.comments,
    detail?.buyerComment,
    detail?.comments?.content,
    detail?.comments,
  );
  const requestAmount = moneyText(refundContainer) || findDeepMoneyText(...apiSources);
  const onHoldAmount = moneyText(holdContainer);
  const detailsUrl = getIssueActionUrl(mergedSummary, detail) || findDeepUrl(...apiSources);
  const orderDetailsUrl = ebayOrderDetailsUrl(orderNumber);
  const apiExtractedDetails = pruneEmptyRecord({
    source: "ebay_post_order_api",
    issueLane: lane,
    requestId: issueId,
    orderNumber,
    orderDetailsUrl,
    buyerUsername,
    itemNumber,
    transactionId,
    itemTitle,
    quantity,
    reason,
    status,
    state,
    actionDue,
    dueAt,
    requestedAt,
    buyerComment,
    requestAmount,
    onHoldAmount,
    detailsUrl,
  });

  const preparedBase = {
    source: {
      ...(sourceSummary || {}),
      __ogIssueLane: lane,
    },
    summary: {
      ...(mergedSummary || {}),
      __ogIssueLane: lane,
    },
    detail,
    filesPayload,
    returnId: issueId,
    orderNumber,
    buyerUsername,
    itemNumber,
    transactionId,
    itemTitle,
    quantity,
    reason,
    status,
    state,
    actionDue,
    sellerActionDue,
    buyerActionDue,
    sellerOptionTypes,
    buyerOptionTypes,
    dueAt,
    requestedAt,
    buyerComment,
    requestAmount,
    onHoldAmount,
    detailsUrl,
    orderDetailsUrl,
    apiExtractedDetails,
    apiDetailsText: buildApiDetailsText(apiExtractedDetails),
    itemImageUrl: getItemImageUrl(detail, mergedSummary),
    trackingNumber: extractTracking(detail, mergedSummary),
    fileIds,
    files,
  };
  const lifecycleStage = returnLifecycleStage(preparedBase as PreparedReturn);
  const classificationReason = returnClassificationReason(preparedBase as PreparedReturn, lifecycleStage);
  const preparedWithClassification = {
    ...preparedBase,
    lifecycleStage,
    classificationReason,
  };

  return {
    ...preparedWithClassification,
    payload: {
      ...buildReturnPayload(preparedWithClassification),
      postOrderIssueLane: lane,
      caseType: "seller_hub_request_dispute",
      ebayIssueId: issueId,
      ebayRequestId: issueId,
    },
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

async function ebayFinanceRequest(token: string, path: string): Promise<any> {
  const res = await fetch(`${EBAY_FINANCES_API_BASE}${path}`, {
    method: "GET",
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

async function ebayOptionalRequest(token: string, path: string): Promise<{ ok: true; payload: any } | { ok: false; error: string }> {
  try {
    return { ok: true, payload: await ebayRequest(token, path) };
  } catch (error) {
    return { ok: false, error: compactError(error) };
  }
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
  return firstText(transaction?.transactionId, transaction?.transaction_id, transaction?.id);
}

function getFinanceTransactionAmount(transaction: any): number {
  return toNumber(
    transaction?.amount
      || transaction?.transactionAmount
      || transaction?.netAmount
      || transaction?.totalAmount,
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
    const payoutId = firstText(transaction?.payoutId, transaction?.payoutReferenceId);
    return {
      transactionId: getFinanceTransactionId(transaction),
      transactionType: toText(transaction?.transactionType),
      transactionStatus: toText(transaction?.transactionStatus),
      bookingEntry: toText(transaction?.bookingEntry),
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

function buildNoFinanceTransactionsPayload(orderNumber: string, lineItemId = ""): JsonRecord {
  return {
    source: "ebay_finances_api",
    syncedAt: new Date().toISOString(),
    orderNumber,
    lineItemId: lineItemId || null,
    status: "unknown",
    statusLabel: "Payout unknown",
    payoutIds: [],
    transactionIds: [],
    lineItemIds: lineItemId ? [lineItemId] : [],
    memo: "eBay returned no finance transactions for this order.",
    transactions: [],
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

async function loadFinanceTransactionsByOrder(token: string, orderNumbers: string[], syncFinance: boolean) {
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
  for (const orderNumber of checkedOrderNumbers) {
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
  const withTransactions = [...byOrder.values()].filter((transactions) => transactions.length > 0).length;
  return {
    byOrder,
    warnings,
    stats: {
      financeSyncEnabled: true,
      financeOrdersChecked: checkedOrderNumbers.length,
      financeOrdersWithTransactions: withTransactions,
      financeOrdersWithoutTransactions: Math.max(0, checkedOrderNumbers.length - withTransactions - warnings.length),
    },
  };
}

async function fetchReturnSummaries(token: string, body: JsonRecord): Promise<ReturnSummaryFetch> {
  const limit = Math.min(Math.max(1, Math.trunc(Number(body.limit || 100))), MAX_RETURN_LIMIT);
  const daysBack = Math.min(Math.max(1, Math.trunc(Number(body.daysBack || DEFAULT_DAYS_BACK))), 730);
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
    summaries: summaries.slice(0, limit).map((summary: any) => ({
      ...summary,
      __ogIssueLane: "return",
    })),
    totalEntries,
    truncated: totalEntries != null && totalEntries > summaries.length,
    from,
    to,
    laneCounts: { returns: totalEntries ?? summaries.length },
    warnings: [],
  };
}

function issueMembersFromPayload(payload: any, lane: PostOrderIssueLane): any[] {
  return firstArray(
    payload?.members,
    payload?.[`${lane}s`],
    payload?.[`${lane}Summaries`],
    payload?.inquiries,
    payload?.inquirySummaries,
    payload?.summaries,
    payload?.issues,
    payload?.cases,
  );
}

async function fetchIssueLaneSummaries(
  token: string,
  body: JsonRecord,
  config: IssueLaneConfig,
): Promise<ReturnSummaryFetch> {
  const limit = Math.min(Math.max(1, Math.trunc(Number(body.limit || 100))), MAX_RETURN_LIMIT);
  const daysBack = Math.min(Math.max(1, Math.trunc(Number(body.daysBack || DEFAULT_DAYS_BACK))), 730);
  const includeClosed = body.includeClosed === true;
  const from = toIsoDate(body.from) || new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const to = toIsoDate(body.to) || new Date().toISOString();
  const summaries: any[] = [];
  const warnings: JsonRecord[] = [];
  let totalEntries: number | null = null;
  let stateFilterSupported = !includeClosed;

  for (let offset = 0; summaries.length < limit; offset += PAGE_LIMIT) {
    const params = new URLSearchParams({
      limit: String(Math.min(PAGE_LIMIT, limit - summaries.length)),
      offset: String(offset),
      creation_date_range_from: from,
      creation_date_range_to: to,
      sort: config.sort,
    });
    if (stateFilterSupported) params.set(config.stateParam, config.openState);

    let pageResult = await ebayOptionalRequest(token, `${config.path}?${params.toString()}`);
    if (!pageResult.ok && stateFilterSupported && offset === 0) {
      warnings.push({
        reason: `${config.lane}_search_state_filter_failed`,
        lane: config.lane,
        error: pageResult.error,
      });
      stateFilterSupported = false;
      params.delete(config.stateParam);
      pageResult = await ebayOptionalRequest(token, `${config.path}?${params.toString()}`);
    }
    if (!pageResult.ok && params.has("sort") && offset === 0) {
      warnings.push({
        reason: `${config.lane}_search_sort_filter_failed`,
        lane: config.lane,
        error: pageResult.error,
      });
      params.delete("sort");
      pageResult = await ebayOptionalRequest(token, `${config.path}?${params.toString()}`);
    }
    if (!pageResult.ok) {
      warnings.push({
        reason: `${config.lane}_search_failed`,
        lane: config.lane,
        error: pageResult.error,
      });
      break;
    }

    const page = issueMembersFromPayload(pageResult.payload, config.lane);
    summaries.push(...page.map((summary: any) => ({
      ...summary,
      __ogIssueLane: config.lane,
    })));
    totalEntries = Number(pageResult.payload?.paginationOutput?.totalEntries || pageResult.payload?.totalEntries || page.length || 0);
    if (!page.length || summaries.length >= totalEntries) break;
  }

  return {
    summaries: summaries.slice(0, limit),
    totalEntries,
    truncated: totalEntries != null && totalEntries > summaries.length,
    from,
    to,
    laneCounts: { [config.lane]: totalEntries ?? summaries.length },
    warnings,
  };
}

async function fetchPostOrderIssueSummaries(token: string, body: JsonRecord): Promise<ReturnSummaryFetch> {
  const warnings: JsonRecord[] = [];
  const laneCounts: JsonRecord = {};
  const returns = await fetchReturnSummaries(token, body);
  warnings.push(...(returns.warnings || []));
  Object.assign(laneCounts, returns.laneCounts || {});

  const inquiry = await fetchIssueLaneSummaries(token, body, {
    lane: "inquiry",
    path: "/post-order/v2/inquiry/search",
    stateParam: "inquiry_state",
    openState: "ALL_OPEN",
    sort: "-FILING_DATE",
  });
  warnings.push(...(inquiry.warnings || []));
  Object.assign(laneCounts, inquiry.laneCounts || {});

  const summaries = [...returns.summaries, ...inquiry.summaries];
  const totalEntries = [returns.totalEntries, inquiry.totalEntries]
    .filter((value) => Number.isFinite(Number(value)))
    .reduce((sum, value) => sum + Number(value), 0);
  const effectiveTotalEntries = totalEntries || summaries.length;

  return {
    summaries,
    totalEntries: effectiveTotalEntries,
    truncated: returns.truncated || inquiry.truncated,
    from: returns.from || inquiry.from,
    to: returns.to || inquiry.to,
    laneCounts,
    warnings,
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
  const linesByOrderId = new Map<string, any[]>();
  const cleanOrderNumbers = unique(orderNumbers.map(toText).filter(Boolean));
  const cleanItemNumbers = unique(itemNumbers.map(toText).filter(Boolean));

  function indexLine(line: any) {
    const order = line.order || line.ebay_orders || ordersById.get(line.order_id) || null;
    if (order) line.order = order;
    const exact = exactLineKey(line.order_id, toText(line.item_number), toText(line.transaction_id));
    const fallback = fallbackLineKey(line.order_id, toText(line.item_number), line.item_title);
    linesExact.set(exact, [...(linesExact.get(exact) || []), line]);
    linesFallback.set(fallback, [...(linesFallback.get(fallback) || []), line]);
    if (line.order_id) linesByOrderId.set(line.order_id, [...(linesByOrderId.get(line.order_id) || []), line]);
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

  return { orders, ordersById, linesExact, linesFallback, linesByItemNumber, linesByOrderId };
}

function findMatches(prepared: PreparedReturn, indexes: any): MatchResult {
  const order = indexes.orders.get(prepared.orderNumber) || null;
  if (order) {
    const orderLines = indexes.linesByOrderId?.get(order.id) || [];
    if (!prepared.itemNumber && !prepared.transactionId) {
      const title = normalizeTitle(prepared.itemTitle);
      const titleMatches = title
        ? orderLines.filter((line: any) => normalizeTitle(line.item_title) === title || normalizeTitle(line.item_title).includes(title) || title.includes(normalizeTitle(line.item_title)))
        : [];
      return {
        order,
        lines: (titleMatches.length ? titleMatches : orderLines).slice(0, 10),
      };
    }
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
      const orderFinance = summarizeFinanceTransactions(transactions, order.order_number)
        || buildNoFinanceTransactionsPayload(order.order_number);
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
        const lineFinance = summarizeFinanceTransactions(transactions, order.order_number, line.transaction_id)
          || (transactions.length ? {
            ...orderFinance,
            lineItemId: line.transaction_id || null,
            lineItemMatch: "order_level_fallback",
            memo: orderFinance.memo || "Using order-level eBay finance status because eBay did not expose a matching line item id.",
          } : buildNoFinanceTransactionsPayload(order.order_number, line.transaction_id));
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

function localStatusFor(prepared: PreparedReturn, matched: boolean): string {
  const state = `${prepared.state} ${prepared.status}`.toUpperCase();
  if (state.includes("CLOSED")) return "closed";
  if (state.includes("CANCEL")) return "cancelled";
  return matched ? "open" : "needs_review";
}

function isFinalReturnStatus(status: unknown): boolean {
  return ["closed", "cancelled"].includes(toText(status).toLowerCase());
}

function needsLocalReturnActionStatus(status: unknown): boolean {
  return ["needs_review", "partially_received"].includes(toText(status).toLowerCase());
}

function shouldPreserveLocalReturnStatus(status: unknown, proposedStatus: unknown): boolean {
  const local = toText(status).toLowerCase();
  if (isFinalReturnStatus(local) || needsLocalReturnActionStatus(local)) return true;
  return local === "received" && !isFinalReturnStatus(proposedStatus);
}

function shouldSkipReturnApiTask(caseRow: any): boolean {
  return ["received", "partially_received", "closed", "cancelled"].includes(toText(caseRow?.status).toLowerCase());
}

function closureDateFor(prepared: PreparedReturn): string {
  return firstDate(
    prepared.detail?.closeDate?.value,
    prepared.detail?.closeDate,
    prepared.detail?.closedDate?.value,
    prepared.detail?.closedDate,
    prepared.detail?.lastModifiedDate?.value,
    prepared.detail?.lastModifiedDate,
    prepared.summary?.lastModifiedDate?.value,
    prepared.summary?.lastModifiedDate,
    prepared.requestedAt,
  ) || new Date().toISOString();
}

function buildEbayClosurePayload(prepared: PreparedReturn, details: JsonRecord = {}): JsonRecord {
  return {
    source: "ebay_return_api",
    detectedAt: new Date().toISOString(),
    closedAt: closureDateFor(prepared),
    returnId: prepared.returnId,
    orderNumber: prepared.orderNumber,
    buyerUsername: prepared.buyerUsername,
    itemNumber: prepared.itemNumber,
    transactionId: prepared.transactionId,
    status: prepared.status,
    state: prepared.state,
    actionDue: prepared.actionDue,
    reason: prepared.reason,
    requestAmount: prepared.requestAmount,
    onHoldAmount: prepared.onHoldAmount,
    trackingNumber: prepared.trackingNumber,
    detailsUrl: prepared.detailsUrl,
    ...details,
  };
}

function buildClosurePayloadFromDetail(returnId: string, payload: any, reason = "not_open_on_ebay"): JsonRecord {
  const detail = payload?.detail || payload || {};
  const summary = payload?.summary || {};
  const status = firstText(summary?.status, detail?.status);
  const state = firstText(summary?.state, detail?.state);
  const closureDate = firstDate(
    detail?.closeDate?.value,
    detail?.closeDate,
    detail?.closedDate?.value,
    detail?.closedDate,
    detail?.lastModifiedDate?.value,
    detail?.lastModifiedDate,
    summary?.lastModifiedDate?.value,
    summary?.lastModifiedDate,
  );
  return {
    source: "ebay_return_api_cleanup",
    reason,
    detectedAt: new Date().toISOString(),
    closedAt: closureDate || new Date().toISOString(),
    returnId,
    status,
    state,
    requestAmount: moneyText(
      summary?.sellerTotalRefund,
      summary?.buyerTotalRefund,
      detail?.refundInfo?.actualRefundAmount,
      detail?.refundInfo?.estimatedRefundAmount,
      detail?.moneyMovementInfo?.[0]?.amount,
    ),
    detail: stripLargeEbayFields(payload),
  };
}

function closureStatusFromPayload(payload: JsonRecord): string {
  const state = `${payload?.status || ""} ${payload?.state || ""}`.toUpperCase();
  if (state.includes("CANCEL")) return "cancelled";
  if (state.includes("CLOSED")) return "closed";
  return "";
}

function closureImpliesPhysicalReturn(payload: JsonRecord): boolean {
  const text = normalizeApiToken([
    payload?.status,
    payload?.state,
    payload?.actionDue,
    payload?.trackingNumber,
    (payload?.detail as JsonRecord | undefined)?.status,
    (payload?.detail as JsonRecord | undefined)?.state,
    compactReturnStatusText(payload?.detail),
  ].map((value) => toText(value)).filter(Boolean).join(" "));
  if (!text || text.includes("CANCEL") || text.includes("NO_RETURN") || text.includes("REFUND_ONLY")) return false;
  return [
    "ITEM_SHIPPED",
    "RETURN_SHIPPED",
    "BUYER_SHIPPED",
    "IN_TRANSIT",
    "ITEM_DELIVERED",
    "DELIVERED",
    "SELLER_MARK_AS_RECEIVED",
    "RECEIVED_BY_SELLER",
  ].some((marker) => text.includes(marker));
}

function isAutoResolvableClosedReturnTask(task: any): boolean {
  const taskType = toText(task?.task_type);
  return ["return_review", "return_intake"].includes(taskType);
}

function preparedIssueLane(prepared: PreparedReturn): string {
  return firstText(prepared.source?.__ogIssueLane, prepared.summary?.__ogIssueLane, prepared.payload?.postOrderIssueLane, "return");
}

function preparedExpectsPhysicalReturn(prepared: PreparedReturn, matched: boolean): boolean {
  if (preparedIssueLane(prepared) !== "return") return false;
  if (!matched) return false;
  if (Math.max(0, Math.trunc(Number(prepared.quantity || 0))) <= 0) return false;
  const text = `${prepared.status || ""} ${prepared.state || ""} ${prepared.actionDue || ""}`.toUpperCase();
  if (text.includes("CANCEL")) return false;
  if (text.includes("NO_RETURN") || text.includes("REFUND_ONLY")) return false;
  return true;
}

const RETURN_DELIVERED_MARKERS = [
  "ITEM_DELIVERED",
  "RETURN_DELIVERED",
  "DELIVERED",
  "RECEIVED_BY_SELLER",
  "SELLER_MARK_AS_RECEIVED",
];

const RETURN_SHIPMENT_STARTED_MARKERS = [
  "BUYER_SHIPPED",
  "RETURN_SHIPPED",
  "ITEM_SHIPPED",
  "SHIPPED",
  "IN_TRANSIT",
  "ON_ITS_WAY",
  "ITEM_ON_THE_WAY",
  "ITEM_DELIVERED",
  "DELIVERED",
  "MARK_AS_RECEIVED",
  "RECEIVED_BY_SELLER",
];

const RETURN_READY_TO_SHIP_MARKERS = [
  "READY_FOR_SHIPPING",
  "ITEM_READY_TO_SHIP",
  "RETURN_READY_TO_SHIP",
  "READY_TO_SHIP",
];

const SELLER_DECISION_DUE_MARKERS = [
  "SELLER_APPROVE_REQUEST",
  "SELLER_DECLINE_REQUEST",
  "SELLER_OFFER_PARTIAL_REFUND",
  "SELLER_OFFER_REPLACEMENT",
  "SELLER_ACCEPT",
  "SELLER_DECIDE",
  "SELLER_RESPOND",
  "SELLER_UPLOAD",
];

const SELLER_INTAKE_DUE_MARKERS = [
  "SELLER_MARK_AS_RECEIVED",
  "SELLER_RECEIVE_ITEM",
  "SELLER_CONFIRM_RECEIPT",
];

function normalizeApiToken(value: unknown): string {
  return toText(value).toUpperCase().replace(/[\s-]+/g, "_");
}

function compactReturnStatusText(value: unknown, depth = 0, seen = new Set<object>()): string {
  if (value === null || value === undefined || depth > 4) return "";
  if (typeof value !== "object") return toText(value);
  if (seen.has(value)) return "";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => compactReturnStatusText(entry, depth + 1, seen)).filter(Boolean).join(" ");
  }

  const parts: string[] = [];
  for (const [key, entry] of Object.entries(value as JsonRecord)) {
    if (!/(trackingNumber|deliveryStatus|shipmentStatus|status|state|activity|action)/i.test(key)) continue;
    parts.push(compactReturnStatusText(entry, depth + 1, seen));
  }
  return parts.filter(Boolean).join(" ");
}

function rawSellerDecisionRequiredByEbay(prepared: PreparedReturn): boolean {
  const sellerDue = normalizeApiToken(prepared.sellerActionDue || prepared.actionDue);
  if (!sellerDue.includes("SELLER_")) return false;
  if (SELLER_INTAKE_DUE_MARKERS.some((marker) => sellerDue.includes(marker))) return false;
  return SELLER_DECISION_DUE_MARKERS.some((marker) => sellerDue.includes(marker));
}

function returnShipmentEvidenceText(prepared: PreparedReturn): string {
  return [
    prepared.trackingNumber,
    prepared.status,
    prepared.state,
    prepared.buyerActionDue,
    compactReturnStatusText(prepared.detail?.buyerReturnShipmentInfo),
    compactReturnStatusText(prepared.detail?.returnShipmentInfo),
    compactReturnStatusText(prepared.detail?.shipmentTracking),
    compactReturnStatusText(prepared.detail?.returnShipmentTracking),
    compactReturnStatusText(prepared.summary?.buyerReturnShipmentInfo),
    compactReturnStatusText(prepared.summary?.returnShipmentInfo),
    compactReturnStatusText(prepared.summary?.shipmentTracking),
    compactReturnStatusText(prepared.summary?.returnShipmentTracking),
  ].filter(Boolean).join(" ").toUpperCase();
}

function returnLifecycleStage(prepared: PreparedReturn): string {
  const stateText = normalizeApiToken(`${prepared.status || ""} ${prepared.state || ""}`);
  if (stateText.includes("CANCEL")) return "cancelled";
  if (stateText.includes("CLOSED")) return "closed";

  const text = normalizeApiToken(returnShipmentEvidenceText(prepared));
  if (RETURN_DELIVERED_MARKERS.some((marker) => text.includes(marker))) return "delivered";
  if (prepared.trackingNumber || RETURN_SHIPMENT_STARTED_MARKERS.some((marker) => text.includes(marker))) return "shipped";
  if (RETURN_READY_TO_SHIP_MARKERS.some((marker) => text.includes(marker))) return "ready_to_ship";
  if (rawSellerDecisionRequiredByEbay(prepared)) return "decision";
  return "requested";
}

function returnClassificationReason(prepared: PreparedReturn, stage = returnLifecycleStage(prepared)): string {
  if (stage === "closed" || stage === "cancelled") return `eBay status/state is ${prepared.status || prepared.state || stage}.`;
  if (stage === "delivered") return "eBay indicates the returned item was delivered or marked received.";
  if (stage === "shipped") return prepared.trackingNumber
    ? `eBay return tracking ${prepared.trackingNumber} is attached.`
    : "eBay status/history indicates the buyer shipped the item back.";
  if (stage === "ready_to_ship") return "eBay indicates the return is approved/ready for buyer shipment.";
  if (stage === "decision") return `${prepared.sellerActionDue || prepared.actionDue || "Seller response"} is due on eBay.`;
  return "eBay return is requested but no shipment/closure signal is confirmed.";
}

function sellerDecisionRequiredByEbay(prepared: PreparedReturn): boolean {
  return returnLifecycleStage(prepared) === "decision";
}

function returnShipmentStarted(prepared: PreparedReturn, matched: boolean): boolean {
  if (!matched || !preparedExpectsPhysicalReturn(prepared, matched)) return false;
  return ["delivered", "shipped"].includes(returnLifecycleStage(prepared));
}

function returnReadyForShipment(prepared: PreparedReturn, matched: boolean): boolean {
  if (!matched || !preparedExpectsPhysicalReturn(prepared, matched)) return false;
  return returnLifecycleStage(prepared) === "ready_to_ship";
}

function returnItemsNeedPhysicalIntake(row: any, items: any[]): boolean {
  if (!row?.order_id || isFinalReturnStatus(row.status)) return false;
  const localStatus = toText(row.status).toLowerCase();
  if (localStatus === "received") return false;
  if (!items.length) return true;
  return items.some((item: any) => {
    const disposition = toText(item.disposition).toLowerCase();
    if (["missing", "refund_only"].includes(disposition)) return false;
    const expected = Math.max(0, Number(item.expected_quantity || 0));
    const received = Math.max(0, Number(item.received_quantity || 0));
    return expected > received;
  });
}

function needsSellerDecision(prepared: PreparedReturn, matched: boolean): boolean {
  if (!matched) return false;
  if (preparedIssueLane(prepared) !== "return") return true;
  return sellerDecisionRequiredByEbay(prepared);
}

function taskTypeFor(prepared: PreparedReturn, matched: boolean): string {
  if (!matched || needsSellerDecision(prepared, matched)) return "return_review";
  return "return_intake";
}

function taskTitleFor(prepared: PreparedReturn, matched: boolean): string {
  if (preparedIssueLane(prepared) !== "return") return matched ? "Review eBay request/dispute" : "Review unmatched eBay request/dispute";
  if (!matched) return "Review unmatched eBay return/refund";
  if (needsSellerDecision(prepared, matched)) return "Decide eBay return request";
  if (returnLifecycleStage(prepared) === "delivered") return "Inspect returned eBay item";
  if (returnShipmentStarted(prepared, matched)) return "Receive returned eBay item";
  if (returnReadyForShipment(prepared, matched)) return "Monitor eBay return shipment";
  return "Complete eBay return intake";
}

function priorityFor(prepared: PreparedReturn, matched: boolean): string {
  const reason = `${prepared.reason} ${prepared.buyerComment}`.toLowerCase();
  if (!matched) return "high";
  if (reason.includes("description") || reason.includes("authentic") || reason.includes("wrong") || reason.includes("damaged")) return "high";
  return "normal";
}

function questionFor(prepared: PreparedReturn, matched: boolean): string {
  if (preparedIssueLane(prepared) !== "return") {
    return matched
      ? "Open the eBay request or dispute, review the linked OG order/lines, and decide whether to respond, refund, challenge, or keep monitoring."
      : "No matching OG order history was found. Review the eBay request/dispute details, buyer, item, value, and order number before deciding the next step.";
  }
  if (!matched) {
    return "No matching OG order history was found. Review the eBay buyer, item, reason, refund value, and return details before deciding the next step.";
  }
  if (needsSellerDecision(prepared, matched)) {
    return "Open the eBay return and decide how to proceed before intake. Approve, decline, refund, message, or dispute on eBay as needed; keep OG open until the next action is clear.";
  }
  if (returnShipmentStarted(prepared, matched)) {
    const trackingNote = prepared.trackingNumber ? ` Return tracking ${prepared.trackingNumber} is attached.` : "";
    if (returnLifecycleStage(prepared) === "delivered") {
      return `eBay shows the return was delivered or is ready for seller receipt.${trackingNote} Inspect the item, attach evidence photos, add condition notes, choose a disposition/location, then refund or dispute on eBay as appropriate.`;
    }
    return `eBay shows the buyer has shipped the item back.${trackingNote} Keep this open until arrival, then mark it received in eBay, inspect it, attach evidence photos, add condition notes, choose a disposition/location, or route it to dispute/admin review.`;
  }
  if (returnReadyForShipment(prepared, matched)) {
    return "eBay shows the return is approved or ready for buyer shipment. Keep OG open, monitor eBay for tracking/arrival, then inspect and assign location when the item comes back.";
  }
  return "When the item arrives, inspect it, attach evidence photos, add condition notes, choose a disposition/location, or route it to dispute/admin review.";
}

function caseLooksLikeReturn(row: any, prepared: PreparedReturn): boolean {
  const payload = row?.raw_payload || {};
  const details = payload?.returnDetails || {};
  const rowReturnId = normalizeLookup(row?.ebay_return_id || payload.ebayReturnId || payload.ebay_return_id || details.ebayReturnId || details.ebay_return_id);
  const rowBuyer = normalizeLookup(row?.buyer_username || payload.buyerUsername || payload.buyer_username);
  const rowOrder = normalizeLookup(row?.order_number || payload.orderNumber || payload.order_number);
  const rowItem = normalizeLookup(payload.itemNumber || payload.item_number || details.itemNumber || details.item_number);
  const rowTransaction = normalizeLookup(payload.transactionId || payload.transaction_id || details.transactionId || details.transaction_id);
  const returnId = normalizeLookup(prepared.returnId);
  const buyer = normalizeLookup(prepared.buyerUsername);
  const orderNumber = normalizeLookup(prepared.orderNumber);
  const itemNumber = normalizeLookup(prepared.itemNumber);
  const transactionId = normalizeLookup(prepared.transactionId);

  if (rowReturnId && returnId && rowReturnId === returnId) return true;
  if (rowOrder && orderNumber && rowOrder === orderNumber && rowTransaction && transactionId && rowTransaction === transactionId) return true;
  if (rowOrder && orderNumber && rowOrder === orderNumber && rowItem && itemNumber && rowItem === itemNumber) return true;
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
      .order("opened_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    const found = (data || []).find((row: any) => caseLooksLikeReturn(row, prepared));
    if (found) return found;
    const active = (data || []).find((row: any) => !["closed", "cancelled"].includes(toText(row.status).toLowerCase()));
    if (active) return active;
  }

  if (prepared.orderNumber) {
    const { data, error } = await supabase
      .from("ebay_return_cases")
      .select("*")
      .eq("order_number", prepared.orderNumber)
      .order("opened_at", { ascending: false })
      .limit(10);
    if (error) throw error;
    const found = (data || []).find((row: any) => caseLooksLikeReturn(row, prepared));
    if (found) return found;
    const active = (data || []).find((row: any) => !["closed", "cancelled"].includes(toText(row.status).toLowerCase()));
    if (active) return active;
  }

  if (prepared.buyerUsername || prepared.itemNumber) {
    let query = supabase
      .from("ebay_return_cases")
      .select("*")
      .order("opened_at", { ascending: false })
      .limit(20);
    if (prepared.buyerUsername) query = query.eq("buyer_username", prepared.buyerUsername);
    const { data, error } = await query;
    if (error) throw error;
    const found = (data || []).find((row: any) => caseLooksLikeReturn(row, prepared));
    if (found) return found;
  }
  return null;
}

async function getBlockingLocalReturnTasks(supabase: any, caseRow: any): Promise<any[]> {
  if (!caseRow?.id) return [];
  const { data, error } = await supabase
    .from("ebay_return_tasks")
    .select("id,task_type,status,title,question,assigned_to_email,assigned_to_user_id")
    .eq("return_case_id", caseRow.id)
    .not("status", "in", "(resolved,cancelled)")
    .limit(50);
  if (error) throw error;
  return data || [];
}

async function getLocalClosureBlock(supabase: any, caseRow: any): Promise<{ blocked: boolean; tasks: any[]; reason: string }> {
  if (!caseRow) return { blocked: false, tasks: [], reason: "" };
  const tasks = await getBlockingLocalReturnTasks(supabase, caseRow);
  if (needsLocalReturnActionStatus(caseRow.status)) {
    return { blocked: true, tasks, reason: `Local case status is ${caseRow.status}` };
  }
  if (tasks.length) {
    return { blocked: true, tasks, reason: `${tasks.length} unresolved local return task${tasks.length === 1 ? "" : "s"}` };
  }
  return { blocked: false, tasks, reason: "" };
}

async function upsertCase(supabase: any, prepared: PreparedReturn, match: MatchResult): Promise<{
  caseRow: any;
  created: boolean;
  closureBlocked: boolean;
  closureBlockReason: string;
  blockingTaskCount: number;
}> {
  const matched = Boolean(match.order && match.lines.length);
  const existing = await findExistingCase(supabase, prepared, match.order?.id || null);
  const proposedStatus = localStatusFor(prepared, matched);
  const ebayClosure = isFinalReturnStatus(proposedStatus)
    ? buildEbayClosurePayload(prepared)
    : null;
  const physicalReturnExpected = Boolean(ebayClosure && preparedExpectsPhysicalReturn(prepared, matched));
  const physicalIntakeRequired = physicalReturnExpected
    && !["received", "closed", "cancelled"].includes(toText(existing?.status).toLowerCase());
  const closureBlock = existing && ebayClosure
    ? await getLocalClosureBlock(supabase, existing)
    : { blocked: false, tasks: [], reason: "" };
  const closureBlocked = closureBlock.blocked || physicalIntakeRequired;
  const closureBlockReason = closureBlock.blocked
    ? closureBlock.reason
    : physicalIntakeRequired
    ? "Returned item still needs OG intake, condition notes, and location assignment."
    : "";
  const status = closureBlocked
    ? existing?.status || "open"
    : existing && shouldPreserveLocalReturnStatus(existing.status, proposedStatus)
    ? existing.status
    : proposedStatus;
  const closedAt = isFinalReturnStatus(status)
    ? existing?.closed_at || ebayClosure?.closedAt || new Date().toISOString()
    : existing?.closed_at || null;
  const closurePayload = ebayClosure
    ? {
      ...ebayClosure,
      physicalReturnExpected,
      physicalReturnIntakeRequired: physicalIntakeRequired,
      localClosureBlocked: closureBlocked,
      localClosureBlockReason: closureBlockReason,
      blockingTaskCount: closureBlock.tasks.length,
    }
    : null;
  const row = {
    order_id: match.order?.id || null,
    order_number: match.order?.order_number || prepared.orderNumber || null,
    case_type: matched ? "matched_order" : "unmatched_legacy",
    ebay_return_id: prepared.returnId || null,
    buyer_username: prepared.buyerUsername || match.order?.buyer_username || null,
    return_reason: prepared.reason || null,
    return_tracking_number: prepared.trackingNumber || null,
    status,
    closed_at: closedAt,
    opened_at: prepared.requestedAt || new Date().toISOString(),
    notes: existing?.notes || "Synced from eBay Return API.",
    raw_payload: {
      ...(existing?.raw_payload || {}),
      ...prepared.payload,
      caseType: matched ? "matched_order" : "unmatched_legacy",
      unmatchedReason: matched ? null : "No matching fulfilled OG order line was found.",
      ...(closurePayload ? {
        ebayClosure: closurePayload,
        ebayClosedOnEbay: true,
      } : {}),
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
    return {
      caseRow: data,
      created: false,
      closureBlocked,
      closureBlockReason,
      blockingTaskCount: closureBlock.tasks.length,
    };
  }

  const { data, error } = await supabase
    .from("ebay_return_cases")
    .insert(row)
    .select("*")
    .single();
  if (error) throw error;
  return {
    caseRow: data,
    created: true,
    closureBlocked: physicalIntakeRequired,
    closureBlockReason,
    blockingTaskCount: 0,
  };
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

async function resolveSupersededReturnTasks(
  supabase: any,
  caseId: string,
  keepTaskId: string,
  existingTasks: any[],
  metadata: JsonRecord,
): Promise<number> {
  const now = new Date().toISOString();
  const duplicateIds = (existingTasks || [])
    .filter((task: any) => {
      const status = toText(task.status).toLowerCase();
      const type = toText(task.task_type);
      return task.id
        && task.id !== keepTaskId
        && ["return_intake", "return_review"].includes(type)
        && !["resolved", "cancelled"].includes(status);
    })
    .map((task: any) => task.id);
  if (!duplicateIds.length) return 0;

  const { data: resolvedTasks, error } = await supabase
    .from("ebay_return_tasks")
    .update({
      status: "resolved",
      resolved_at: now,
      resolved_by_email: "ebay-return-sync",
      resolution_notes: "Resolved automatically because a newer eBay return API task superseded this duplicate.",
      updated_at: now,
    })
    .in("id", duplicateIds)
    .select("id,return_case_id,status");
  if (error) throw error;

  const events = (resolvedTasks || []).map((task: any) => ({
    task_id: task.id,
    return_case_id: caseId,
    action: "resolved",
    old_status: null,
    new_status: "resolved",
    notes: "Resolved automatically because a newer eBay return API task superseded this duplicate.",
    signed_by_email: "ebay-return-sync",
    payload: {
      supersededByReturnTaskId: keepTaskId,
      latestReturnClassification: {
        ebayReturnId: metadata.ebayReturnId,
        orderNumber: metadata.orderNumber,
        returnStatus: metadata.returnStatus,
        returnState: metadata.returnState,
        returnAction: metadata.returnAction,
        sellerActionDue: metadata.sellerActionDue,
        buyerActionDue: metadata.buyerActionDue,
        returnLifecycleStage: metadata.returnLifecycleStage,
        returnClassificationReason: metadata.returnClassificationReason,
      },
    },
  }));
  if (events.length) {
    const { error: eventError } = await supabase
      .from("ebay_return_task_events")
      .insert(events);
    if (eventError) throw eventError;
  }
  return (resolvedTasks || []).length;
}

async function upsertTask(supabase: any, prepared: PreparedReturn, caseRow: any, match: MatchResult): Promise<{ task: any | null; created: boolean; updated: boolean }> {
  const matched = Boolean(match.order && match.lines.length);
  const taskType = taskTypeFor(prepared, matched);
  const { data: existingTasks, error: taskError } = await supabase
    .from("ebay_return_tasks")
    .select("*")
    .eq("return_case_id", caseRow.id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (taskError) throw taskError;
  const activeReturnTask = (existingTasks || []).find((task: any) => {
    const status = toText(task.status).toLowerCase();
    return ["return_intake", "return_review"].includes(toText(task.task_type))
      && !["resolved", "cancelled"].includes(status);
  });
  const sameTypeTask = (existingTasks || []).find((task: any) => task.task_type === taskType) || null;
  const existing = activeReturnTask || sameTypeTask || null;
  const metadata = {
    ...(existing?.metadata || {}),
    ...prepared.payload,
    caseType: matched ? "matched_order" : "unmatched_legacy",
    sellerDecisionRequired: needsSellerDecision(prepared, matched),
    returnShipmentStarted: returnShipmentStarted(prepared, matched),
    physicalReturnExpected: preparedExpectsPhysicalReturn(prepared, matched),
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
    title: taskTitleFor(prepared, matched),
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
    await resolveSupersededReturnTasks(supabase, caseRow.id, data.id, existingTasks || [], metadata);
    return { task: data, created: false, updated: true };
  }

  const { data, error } = await supabase
    .from("ebay_return_tasks")
    .insert(row)
    .select("*")
    .single();
  if (error) throw error;
  await resolveSupersededReturnTasks(supabase, caseRow.id, data.id, existingTasks || [], metadata);

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
    const attributes = entry?.attributes || {};
    const body = commentText(
      attributes?.comments?.content,
      attributes?.comments,
      attributes?.comment?.content,
      attributes?.comment,
      attributes?.message?.content,
      attributes?.message,
      attributes?.sellerComments?.content,
      attributes?.sellerComments,
      attributes?.sellerComment?.content,
      attributes?.sellerComment,
      attributes?.buyerComments?.content,
      attributes?.buyerComments,
      attributes?.buyerComment?.content,
      attributes?.buyerComment,
      attributes?.note,
      attributes?.notes,
      entry?.comments?.content,
      entry?.comment,
      entry?.comments,
      entry?.message,
      entry?.note,
      entry?.notes?.content,
      entry?.notes,
    );
    if (!body || looksLikeReferenceOnlyMessage(body, prepared)) continue;
    const author = [
      entry?.author,
      entry?.actor,
      entry?.role,
      entry?.authorRole,
      entry?.activityActor,
      entry?.activity,
    ].map(toText).join(" ").toLowerCase();
    messages.push({
      key: `response-history:${prepared.returnId}:${entry?.activity || ""}:${getDateValue(entry?.creationDate) || ""}:${body.slice(0, 80)}`,
      body,
      direction: author.includes("seller") ? "outbound" : author.includes("buyer") ? "inbound" : "internal",
      status: "imported",
      sentAt: getDateValue(entry?.creationDate) || new Date().toISOString(),
      metadata: { source: "ebay_return_api", kind: "response_history", entry },
    });
  }
  messages.push(...pageModelHistoryMessages(prepared));
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
    .select("id,metadata,direction,message_body")
    .eq("ebay_return_id", prepared.returnId)
    .eq("channel", "ebay_return_api");
  if (existingError) throw existingError;
  const existingKeys = new Set((existing || []).map((row: any) => toText(row?.metadata?.ebayResponseHistoryKey)).filter(Boolean));
  const bodyKey = (row: any) => [
    toText(row.direction),
    normalizeMessageText(row.message_body),
  ].join("|");
  const existingBodyKeys = new Set((existing || []).map(bodyKey).filter((key) => key !== "|"));
  const freshRows = rows.filter((row) => {
    const key = toText(row.metadata?.ebayResponseHistoryKey);
    if (key && existingKeys.has(key)) return false;
    const normalizedBodyKey = bodyKey(row);
    if (normalizedBodyKey !== "|" && existingBodyKeys.has(normalizedBodyKey)) return false;
    existingBodyKeys.add(normalizedBodyKey);
    return true;
  });
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
  token: string,
  openReturnIds: Set<string>,
  dryRun: boolean,
  cleanupLimit = 50,
): Promise<{ casesClosed: number; tasksResolved: number; casesHeldOpen: number; casesRemaining: number; results: any[] }> {
  const { data: cases, error: caseError } = await supabase
    .from("ebay_return_cases")
    .select("id,order_id,ebay_return_id,order_number,buyer_username,status,closed_at,raw_payload,updated_at")
    .not("ebay_return_id", "is", null)
    .order("updated_at", { ascending: true })
    .limit(1000);
  if (caseError) throw caseError;

  const staleCandidates = (cases || []).filter((row: any) => {
    const returnId = toText(row.ebay_return_id || row.raw_payload?.ebayReturnId);
    return returnId
      && !openReturnIds.has(returnId)
      && (!isFinalReturnStatus(row.status) || !row.raw_payload?.ebayClosure);
  });
  const normalizedLimit = Math.min(Math.max(1, Math.trunc(Number(cleanupLimit || 50))), 200);
  const staleCases = staleCandidates.slice(0, normalizedLimit);
  const casesRemaining = Math.max(0, staleCandidates.length - staleCases.length);
  if (!staleCases.length) return { casesClosed: 0, tasksResolved: 0, casesHeldOpen: 0, casesRemaining, results: [] };

  const staleCaseIds = staleCases.map((row: any) => row.id).filter(Boolean);
  const { data: tasks, error: taskError } = await supabase
    .from("ebay_return_tasks")
    .select("id,return_case_id,status,task_type,title")
    .in("return_case_id", staleCaseIds)
    .not("status", "in", "(resolved,cancelled)");
  if (taskError) throw taskError;

  const { data: items, error: itemError } = await supabase
    .from("ebay_return_items")
    .select("return_case_id,expected_quantity,received_quantity,disposition")
    .in("return_case_id", staleCaseIds);
  if (itemError) throw itemError;

  const staleTasks = tasks || [];
  const tasksByCase = new Map<string, any[]>();
  staleTasks.forEach((task: any) => {
    const caseId = toText(task.return_case_id);
    tasksByCase.set(caseId, [...(tasksByCase.get(caseId) || []), task]);
  });
  const itemsByCase = new Map<string, any[]>();
  (items || []).forEach((item: any) => {
    const caseId = toText(item.return_case_id);
    itemsByCase.set(caseId, [...(itemsByCase.get(caseId) || []), item]);
  });

  async function closurePayloadFor(row: any): Promise<JsonRecord> {
    if (row.raw_payload?.ebayClosedOnEbay && row.raw_payload?.ebayClosure) {
      return row.raw_payload.ebayClosure;
    }
    const returnId = toText(row.ebay_return_id || row.raw_payload?.ebayReturnId);
    const detailResult = returnId
      ? await ebayOptionalRequest(token, `/post-order/v2/return/${encodeURIComponent(returnId)}?fieldgroups=FULL`)
      : { ok: false as const, error: "Missing eBay return id" };
    if (detailResult.ok) return buildClosurePayloadFromDetail(returnId, detailResult.payload);
    return {
      source: "ebay_return_api_cleanup",
      reason: "not_open_on_ebay",
      detectedAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      returnId,
      detailFetchError: detailResult.error,
    };
  }

  const closureRows = [];
  for (const row of staleCases) {
    const activeTasks = tasksByCase.get(toText(row.id)) || [];
    const blockingTasks = activeTasks.filter((task) => !isAutoResolvableClosedReturnTask(task));
    const returnItems = itemsByCase.get(toText(row.id)) || [];
    const closurePayload = await closurePayloadFor(row);
    const missingClosureDetails = Boolean(closurePayload.detailFetchError);
    const physicalIntakeRequired = closureImpliesPhysicalReturn(closurePayload)
      && returnItemsNeedPhysicalIntake(row, returnItems);
    const localActionRequired = !isFinalReturnStatus(row.status)
      && (needsLocalReturnActionStatus(row.status) || blockingTasks.length > 0 || missingClosureDetails || physicalIntakeRequired);
    closureRows.push({ row, activeTasks, blockingTasks, returnItems, localActionRequired, physicalIntakeRequired, closurePayload });
  }

  const casesToClose = closureRows.filter((entry) => !isFinalReturnStatus(entry.row.status) && !entry.localActionRequired);
  const casesHeldOpen = closureRows.filter((entry) => !isFinalReturnStatus(entry.row.status) && entry.localActionRequired);
  function closureBlockReasonFor(entry: any): string {
    if (!entry.localActionRequired) return "";
    if (entry.closurePayload.detailFetchError) {
      return `Could not fetch eBay closure details: ${entry.closurePayload.detailFetchError}`;
    }
    if (entry.physicalIntakeRequired) {
      return "Returned item still needs OG intake, condition notes, and location assignment.";
    }
    if (needsLocalReturnActionStatus(entry.row.status)) return `Local case status is ${entry.row.status}`;
    if (entry.blockingTasks.length) {
      return `${entry.blockingTasks.length} unresolved local follow-up task${entry.blockingTasks.length === 1 ? "" : "s"}`;
    }
    return "Local return case still needs review";
  }
  const cleanupResults = closureRows.map((entry) => ({
    returnId: entry.row.ebay_return_id || entry.row.raw_payload?.ebayReturnId || "",
    orderNumber: entry.row.order_number || "",
    buyerUsername: entry.row.buyer_username || "",
    status: isFinalReturnStatus(entry.row.status)
      ? "already_closed"
      : entry.localActionRequired
        ? "local_action_required"
        : dryRun ? "would_close" : "closed",
    caseId: entry.row.id,
    previousStatus: entry.row.status,
    staleTaskCount: entry.activeTasks.length,
    blockingTaskCount: entry.blockingTasks.length,
    autoResolvableTaskCount: entry.activeTasks.filter(isAutoResolvableClosedReturnTask).length,
    closureBlockReason: closureBlockReasonFor(entry),
    closureDetailsStored: !dryRun,
  }));

  if (dryRun) {
    return {
      casesClosed: casesToClose.length,
      tasksResolved: 0,
      casesHeldOpen: casesHeldOpen.length,
      casesRemaining,
      results: cleanupResults,
    };
  }

  const now = new Date().toISOString();
  let resolvedTaskCount = 0;
  for (const entry of closureRows) {
    const closurePayload = {
      ...entry.closurePayload,
      localClosureBlocked: entry.localActionRequired,
      localClosureBlockReason: closureBlockReasonFor(entry),
      blockingTaskCount: entry.blockingTasks.length,
      physicalReturnExpected: entry.physicalIntakeRequired,
      physicalReturnIntakeRequired: entry.physicalIntakeRequired,
    };
    const isClosingLocally = casesToClose.some((candidate) => candidate.row.id === entry.row.id);
    const nextStatus = isClosingLocally
      ? closureStatusFromPayload(closurePayload) || "closed"
      : entry.row.status;
    const { error: closeError } = await supabase
      .from("ebay_return_cases")
      .update({
        status: nextStatus,
        closed_at: isFinalReturnStatus(nextStatus) ? entry.row.closed_at || closurePayload.closedAt || now : entry.row.closed_at || null,
        raw_payload: {
          ...(entry.row.raw_payload || {}),
          ebayClosure: closurePayload,
          ebayClosedOnEbay: true,
        },
        updated_at: now,
      })
      .eq("id", entry.row.id);
    if (closeError) throw closeError;

    if (isClosingLocally) {
      const autoResolvableTaskIds = entry.activeTasks
        .filter(isAutoResolvableClosedReturnTask)
        .map((task: any) => task.id)
        .filter(Boolean);
      if (autoResolvableTaskIds.length) {
        const { data: resolvedTasks, error: resolveTaskError } = await supabase
          .from("ebay_return_tasks")
          .update({
            status: "resolved",
            resolved_at: now,
            resolved_by_email: "ebay-return-sync",
            resolution_notes: "Resolved automatically because eBay closed this return.",
            updated_at: now,
          })
          .in("id", autoResolvableTaskIds)
          .select("id");
        if (resolveTaskError) throw resolveTaskError;
        resolvedTaskCount += (resolvedTasks || []).length;
      }

      const { error: eventError } = await supabase
        .from("ebay_return_events")
        .insert({
          return_case_id: entry.row.id,
          action: nextStatus === "cancelled" ? "cancelled" : "closed",
          order_id: entry.row.order_id || null,
          notes: "Closed automatically from eBay return status.",
          signed_by_email: "ebay-return-sync",
          payload: {
            source: "ebay_return_api_cleanup",
            previous_status: entry.row.status,
            status: nextStatus,
            closed_at: closurePayload.closedAt || now,
            ebay_return_id: entry.row.ebay_return_id || entry.row.raw_payload?.ebayReturnId || "",
            ebay_closure: closurePayload,
          },
        });
      if (eventError) throw eventError;
    }
  }

  return {
    casesClosed: casesToClose.length,
    tasksResolved: resolvedTaskCount,
    casesHeldOpen: casesHeldOpen.length,
    casesRemaining,
    results: cleanupResults,
  };
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
    const cleanupOnly = body.cleanupOnly === true;
    const cleanupLimit = Math.min(Math.max(1, Math.trunc(Number(body.cleanupLimit || (cleanupOnly ? 50 : 15)))), 200);
    const staleRunCutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await supabase
      .from("ebay_return_sync_runs")
      .update({
        status: "failed",
        errors: 1,
        warnings: [{ reason: "marked_failed_after_stale_running_state", detectedAt: new Date().toISOString() }],
        finished_at: new Date().toISOString(),
      })
      .eq("status", "running")
      .is("finished_at", null)
      .lt("started_at", staleRunCutoff);
    const { data: run, error: runError } = await supabase
      .from("ebay_return_sync_runs")
      .insert({ dry_run: dryRun, status: "running" })
      .select("id")
      .single();
    if (runError) throw runError;
    runId = run.id;

    const token = await getEbayAccessToken();
    const fetchResult = await fetchPostOrderIssueSummaries(token, body);
    const summaries = fetchResult.summaries;
    const openReturnIdsFromSearch = new Set(
      summaries.map((summary: any) => postOrderIssueId(summary)).filter(Boolean),
    );
    const preparedReturns: PreparedReturn[] = [];
    const warnings: any[] = [...(fetchResult.warnings || [])];

    for (const summary of summaries) {
      const lane = (summary?.__ogIssueLane || "return") as PostOrderIssueLane;
      const returnId = postOrderIssueId(summary);
      if (!returnId) {
        warnings.push({ reason: "missing_post_order_issue_id", lane, summary });
        continue;
      }
      if (cleanupOnly) continue;
      const detailResult = await ebayOptionalRequest(token, `/post-order/v2/${lane}/${encodeURIComponent(returnId)}?fieldgroups=FULL`);
      const filesResult = lane === "return"
        ? await ebayOptionalRequest(token, `/post-order/v2/return/${encodeURIComponent(returnId)}/files`)
        : { ok: false as const, error: "No files endpoint used for non-return post-order issue lane." };
      if (!detailResult.ok) warnings.push({ returnId, lane, request: "detail", error: detailResult.error });
      if (lane === "return" && !filesResult.ok) warnings.push({ returnId, lane, request: "files", error: filesResult.error });
      const prepared = preparePostOrderIssue(summary, detailResult.ok ? detailResult.payload : {}, filesResult.ok ? filesResult.payload : {}, lane);
      if (prepared) preparedReturns.push(prepared);
    }

    const indexes = await loadOrdersAndLines(
      supabase,
      preparedReturns.map((entry) => entry.orderNumber),
      preparedReturns.map((entry) => entry.itemNumber),
    );
    const matchedReturns = preparedReturns.map((prepared) => ({
      prepared,
      match: findMatches(prepared, indexes),
    }));
    const syncFinance = body.syncFinance === true || (!dryRun && body.syncFinance !== false);
    const financeOrderNumbers = unique(matchedReturns.flatMap(({ prepared, match }) => [
      prepared.orderNumber,
      match.order?.order_number,
    ]).map(toText).filter(Boolean));
    const {
      byOrder: financeByOrderNumber,
      warnings: financeWarnings,
      stats: financeStats,
    } = await loadFinanceTransactionsByOrder(token, financeOrderNumbers, syncFinance);
    warnings.push(...financeWarnings);
    if (!dryRun) {
      await updateLocalOrderFinancePayloads(supabase, financeByOrderNumber);
    }

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
    let staleCasesHeldOpen = 0;
    let staleCasesRemaining = 0;

    for (const { prepared, match } of matchedReturns) {
      try {
        const isMatched = Boolean(match.order && match.lines.length);
        if (isMatched) matched += 1;
        else unmatched += 1;
        filesSeen += prepared.files.length;

        if (dryRun) {
          const existingCase = await findExistingCase(supabase, prepared, match.order?.id || null);
          const taskSkipped = existingCase ? shouldSkipReturnApiTask(existingCase) : false;
          results.push({
            returnId: prepared.returnId,
            issueLane: prepared.source?.__ogIssueLane || prepared.summary?.__ogIssueLane || "return",
            orderNumber: prepared.orderNumber,
            orderDetailsUrl: prepared.orderDetailsUrl,
            buyerUsername: prepared.buyerUsername,
            itemNumber: prepared.itemNumber,
            itemTitle: prepared.itemTitle,
            apiDetailsText: prepared.apiDetailsText,
            reason: prepared.reason,
            status: prepared.status || prepared.state,
            actionDue: prepared.actionDue,
            dueAt: prepared.dueAt,
            requestAmount: prepared.requestAmount,
            buyerComment: prepared.buyerComment,
            fileCount: prepared.files.length,
            matched: isMatched,
            matchedLineCount: match.lines.length,
            existingCaseId: existingCase?.id || null,
            existingCaseStatus: existingCase?.status || null,
            taskSkipped,
            wouldCreateTask: !taskSkipped && !["closed", "cancelled"].includes(localStatusFor(prepared, isMatched)),
          });
          continue;
        }

        const uploadedComplaintImages = await uploadEbayReturnFiles(supabase, prepared);
        prepared.payload = buildReturnPayload(prepared, uploadedComplaintImages);
        const {
          caseRow,
          created: caseCreated,
          closureBlocked,
          closureBlockReason,
          blockingTaskCount,
        } = await upsertCase(supabase, prepared, match);
        await upsertReturnItems(supabase, prepared, caseRow, match);
        const skipTaskRefresh = shouldSkipReturnApiTask(caseRow);
        const taskResult = skipTaskRefresh
          ? { task: null, created: false, updated: false }
          : await upsertTask(supabase, prepared, caseRow, match);
        const importedMessageCount = await importMessages(supabase, prepared, caseRow, match);
        if (taskResult.created) tasksCreated += 1;
        if (taskResult.updated) tasksUpdated += 1;
        messagesImported += importedMessageCount;

        results.push({
          returnId: prepared.returnId,
          issueLane: prepared.source?.__ogIssueLane || prepared.summary?.__ogIssueLane || "return",
          orderNumber: caseRow.order_number || prepared.orderNumber,
          orderDetailsUrl: prepared.orderDetailsUrl,
          buyerUsername: caseRow.buyer_username || prepared.buyerUsername,
          itemNumber: prepared.itemNumber,
          itemTitle: prepared.itemTitle,
          apiDetailsText: prepared.apiDetailsText,
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
          closureBlocked,
          closureBlockReason,
          blockingTaskCount,
          taskSkipped: skipTaskRefresh,
          taskCreated: taskResult.created,
          taskUpdated: taskResult.updated,
          messagesImported: importedMessageCount,
        });
      } catch (error) {
        errors += 1;
        results.push({
          returnId: prepared.returnId,
          issueLane: prepared.source?.__ogIssueLane || prepared.summary?.__ogIssueLane || "return",
          orderNumber: prepared.orderNumber,
          orderDetailsUrl: prepared.orderDetailsUrl,
          buyerUsername: prepared.buyerUsername,
          itemNumber: prepared.itemNumber,
          itemTitle: prepared.itemTitle,
          apiDetailsText: prepared.apiDetailsText,
          status: "error",
          matched: false,
          error: compactError(error),
        });
      }
    }

    if (cleanupClosed) {
      const incompleteIssueLane = warnings.find((entry: any) => /_search_failed$/.test(toText(entry?.reason)));
      if (fetchResult.truncated || incompleteIssueLane) {
        warnings.push({
          reason: incompleteIssueLane ? "cleanup_skipped_incomplete_post_order_issue_search" : "cleanup_skipped_truncated_open_return_search",
          totalEntries: fetchResult.totalEntries,
          fetched: openReturnIdsFromSearch.size,
          incompleteLane: incompleteIssueLane?.lane || null,
          incompleteReason: incompleteIssueLane?.reason || null,
        });
      } else {
        try {
          const cleanup = await cleanupClosedReturnCases(
            supabase,
            token,
            openReturnIdsFromSearch,
            dryRun,
            cleanupLimit,
          );
          staleCasesClosed = cleanup.casesClosed;
          staleTasksResolved = cleanup.tasksResolved;
          staleCasesHeldOpen = cleanup.casesHeldOpen;
          staleCasesRemaining = cleanup.casesRemaining;
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

    const taskSkippedCount = results.filter((entry: any) => entry?.taskSkipped).length;
    const syncTotalsWarning = {
      reason: "ebay_return_search_totals",
      source: "ebay-return-api",
      ebayTotalLabel: "API issues",
      ebayTotalEntries: fetchResult.totalEntries ?? preparedReturns.length,
      ebayFetchedEntries: summaries.length,
      ebayPreparedEntries: preparedReturns.length,
      ebayTruncated: fetchResult.truncated,
      requestedFrom: fetchResult.from,
      requestedTo: fetchResult.to,
      laneCounts: fetchResult.laneCounts || {},
      taskSkippedCount,
    };
    const completedWarnings = [syncTotalsWarning, ...warnings];

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
      warnings: completedWarnings,
      finished_at: new Date().toISOString(),
    };
    await supabase.from("ebay_return_sync_runs").update(completed).eq("id", runId);

    return jsonResponse(200, {
      ok: errors === 0,
      runId,
      dryRun,
      total: preparedReturns.length,
      ebayTotalEntries: fetchResult.totalEntries ?? preparedReturns.length,
      fetchedCount: summaries.length,
      preparedCount: preparedReturns.length,
      ebayTruncated: fetchResult.truncated,
      laneCounts: fetchResult.laneCounts || {},
      requestedFrom: fetchResult.from,
      requestedTo: fetchResult.to,
      matched,
      unmatched,
      tasksCreated,
      tasksUpdated,
      messagesImported,
      filesSeen,
      cleanupClosed,
      cleanupOnly,
      cleanupLimit,
      staleCasesClosed,
      staleTasksResolved,
      staleCasesHeldOpen,
      staleCasesRemaining,
      errors,
      financeStats,
      financeWarnings,
      taskSkippedCount,
      warnings: completedWarnings,
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
