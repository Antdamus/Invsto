const CONTEXT_VERSION = "ebay-conversation-context-v5";
const MAX_LINKS = 80;
const MAX_MESSAGES = 100;
const MAX_RETURNS = 20;
const MAX_BUYER_VALUE_LINES = 10;

export type EbayConversationContextClient = any;

type WarningSeverity = "info" | "warning" | "error";
type LinkStatus = "confirmed" | "suggested";
type LinkType =
  | "listing_reference"
  | "buyer_username"
  | "ebay_order"
  | "ebay_order_line"
  | "ebay_return_case"
  | "inventory_listing";

type LinkCandidate = {
  conversation_id: string;
  seller_account_id: string;
  link_type: LinkType;
  link_key: string;
  ebay_order_id?: string | null;
  ebay_order_line_id?: string | null;
  ebay_return_case_id?: string | null;
  reference_id?: string | null;
  reference_type?: string | null;
  buyer_username?: string | null;
  matched_value: string;
  match_method: string;
  confidence: number;
  status: LinkStatus;
  metadata: Record<string, unknown>;
};

type LinkCounters = {
  scanned: number;
  candidates: number;
  links_created: number;
  links_updated: number;
  links_unchanged: number;
  warnings: Array<Record<string, unknown>>;
};

export class EbayConversationContextError extends Error {
  code: string;
  status: number;
  phase: string;

  constructor(code: string, options: { status?: number; phase?: string; message?: string } = {}) {
    super(options.message || code);
    this.name = "EbayConversationContextError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "conversation_context";
  }
}

function text(value: unknown, maxLength = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function shortText(value: unknown, maxLength: number) {
  return text(value, maxLength) || null;
}

function lowerTrim(value: unknown) {
  return text(value).toLowerCase();
}

function buyerKey(value: unknown) {
  return lowerTrim(value) || null;
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function integerOrNull(value: unknown) {
  const numeric = numberOrNull(value);
  return numeric === null ? null : Math.trunc(numeric);
}

function unique(values: Array<string | null | undefined>, maxItems = 100) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))].slice(0, maxItems);
}

function uniqueIds(values: unknown[], maxItems = 100) {
  return unique(values.map((value) => String(value || "")), maxItems);
}

function warning(code: string, message: string, severity: WarningSeverity = "warning") {
  return { code, message, severity };
}

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
    if (entry === null || entry === undefined || entry === "") return false;
    if (Array.isArray(entry) && entry.length === 0) return false;
    if (typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry as Record<string, unknown>).length === 0) return false;
    return true;
  }));
}

function compactContextValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return shortText(value, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return depth >= 3 ? [] : value.slice(0, 20).map((item) => compactContextValue(item, depth + 1));
  if (typeof value !== "object" || depth >= 3) return null;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
    if (/(raw|payload|token|secret|credential|body_html|body_text|attachment|blob|content)/i.test(key)) continue;
    output[key] = compactContextValue(item, depth + 1);
  }
  return output;
}

function rawMetadataSearchText(value: unknown, depth = 0): string[] {
  if (value === null || value === undefined || depth > 4) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const result = text(value, 700);
    return result ? [result] : [];
  }
  if (Array.isArray(value)) return value.slice(0, 40).flatMap((item) => rawMetadataSearchText(item, depth + 1));
  if (typeof value !== "object") return [];

  const rows: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (/(raw|payload|token|secret|credential|authorization|access_token|refresh_token|html|body_html|body_text|attachment|blob|image|media|thumbnail|photo|picture|content)/i.test(key)) continue;
    const keyMayContainLink = /(order|purchase|transaction|txn|item|listing|offer|reference|return|case|request|dispute|buyer|username|member|title|subject|url|href|action|link|id)/i.test(key);
    if (keyMayContainLink) {
      const keyText = text(key, 160);
      if (keyText) rows.push(keyText);
      rows.push(...rawMetadataSearchText(item, depth + 1));
    } else if (depth <= 1 && typeof item === "object") {
      rows.push(...rawMetadataSearchText(item, depth + 1));
    }
  }
  return rows.filter(Boolean);
}

function daysBetween(left?: string | null, right?: string | null) {
  if (!left || !right) return null;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return null;
  return Math.abs((leftTime - rightTime) / 86400000);
}

function conversationTime(conversation: Record<string, any>) {
  return conversation.last_message_created_at ||
    conversation.latest_message_created_at ||
    conversation.first_message_created_at ||
    conversation.updated_at ||
    conversation.created_at ||
    null;
}

function buildSearchText(conversation: Record<string, any>, messages: Array<Record<string, any>>) {
  return [
    conversation.ebay_conversation_id,
    conversation.conversation_title,
    conversation.other_party_username,
    conversation.reference_id,
    conversation.reference_type,
    conversation.latest_message_preview,
    ...messages.flatMap((message) => [
      message.ebay_message_id,
      message.sender_username,
      message.recipient_username,
      message.subject,
      message.message_body,
      message.message_body_preview,
      ...rawMetadataSearchText(message.raw_message_metadata),
    ]),
    ...rawMetadataSearchText(conversation.raw_summary),
    ...rawMetadataSearchText(conversation.raw_detail_metadata),
  ].filter(Boolean).join("\n").slice(0, 60000);
}

function extractConversationIdentifiers(conversation: Record<string, any>, messages: Array<Record<string, any>>) {
  const source = buildSearchText(conversation, messages);
  const labels = unique(source.match(/#\d+\b/g) || []);
  const labelValues = unique([
    ...labels.map((label) => label.replace(/^#/, "")),
    ...Array.from(source.matchAll(/\b(?:custom\s+label|sku|label)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,40})\b/gi), (match) => match[1]),
  ]);
  const listingIds = unique([
    conversation.reference_id,
    ...Array.from(source.matchAll(/\b(?:listing\s+id|listing|offer\s+id|offer|item\s+id|item)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{5,40})\b/gi), (match) => match[1]),
  ]).filter((value) => /\d/.test(value));
  const buyerUsernames = unique([
    conversation.other_party_username,
    ...messages.flatMap((message) =>
      [message.direction === "inbound" ? message.sender_username : null, message.direction === "outbound" ? message.recipient_username : null]
    ),
  ]).map(lowerTrim).filter(Boolean);

  return {
    orderNumbers: unique(source.match(/\b\d{2}-\d{5}-\d{5}\b/g) || []),
    itemNumbers: unique(source.match(/\b\d{12}\b/g) || []),
    transactionIds: unique(source.match(/\b\d{14}\b/g) || []),
    labels,
    labelValues,
    listingIds,
    returnIds: unique([
      ...Array.from(source.matchAll(/\b(?:return\s+(?:case\s+)?id|ebay\s+return\s+id|return)\s*[:#-]?\s*([A-Z0-9-]{6,40})\b/gi), (match) => match[1]),
    ]).filter((value) => /\d/.test(value)),
    buyerUsernames,
  };
}

function identifierSummary(identifiers: ReturnType<typeof extractConversationIdentifiers>) {
  return {
    order_numbers: identifiers.orderNumbers.length,
    item_numbers: identifiers.itemNumbers.length,
    transaction_ids: identifiers.transactionIds.length,
    listing_labels: identifiers.labels.length,
    listing_ids: identifiers.listingIds.length,
    return_ids: identifiers.returnIds.length,
    buyer_usernames: identifiers.buyerUsernames.length,
  };
}

function linkMetadata(identifiers: ReturnType<typeof extractConversationIdentifiers>, matchedBy: string, extra: Record<string, unknown> = {}) {
  return compactObject({
    context_version: CONTEXT_VERSION,
    matched_by: matchedBy,
    extracted_identifiers: identifierSummary(identifiers),
    ...extra,
  });
}

function orderLineSelect() {
  return "id, order_id, item_number, transaction_id, item_title, custom_label, quantity, sold_for, total_price, line_status, internal_item_id, sale_id, order:ebay_orders(id, order_number, buyer_username, buyer_name, buyer_email, status, sale_date, paid_on_date, ship_by_date, shipped_on_date, total_price, net_payout, tracking_number, shipping_service, ebay_shipment_id, label_status, label_metadata)";
}

async function queryByChunks<T>(values: string[], load: (chunk: string[]) => Promise<T[]>) {
  const rows: T[] = [];
  for (let index = 0; index < values.length; index += 50) {
    rows.push(...await load(values.slice(index, index + 50)));
  }
  return rows;
}

async function loadConversation(supabase: EbayConversationContextClient, conversationId: string) {
  const { data, error } = await supabase
    .from("ebay_conversations")
    .select("*")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new EbayConversationContextError("conversation_lookup_failed", { phase: "conversation_lookup", message: error.message });
  if (!data?.id) throw new EbayConversationContextError("conversation_not_found", { status: 404, phase: "conversation_lookup" });
  return data as Record<string, any>;
}

async function loadConversationByEbayId(
  supabase: EbayConversationContextClient,
  ebayConversationId: string,
  conversationType?: string | null,
) {
  let query = supabase
    .from("ebay_conversations")
    .select("*")
    .eq("ebay_conversation_id", ebayConversationId)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (conversationType) query = query.eq("conversation_type", conversationType);
  const { data, error } = await query;
  if (error) throw new EbayConversationContextError("conversation_lookup_failed", { phase: "conversation_lookup", message: error.message });
  const row = (data || [])[0];
  if (!row?.id) throw new EbayConversationContextError("conversation_not_found", { status: 404, phase: "conversation_lookup" });
  return row as Record<string, any>;
}

async function loadMessages(supabase: EbayConversationContextClient, conversationId: string) {
  const { data, error } = await supabase
    .from("ebay_conversation_messages")
    .select("id, ebay_message_id, sender_username, recipient_username, direction, direction_confidence, subject, message_body, message_body_preview, read_status, is_read, message_status, created_at_ebay, has_media, media_count, message_media, raw_message_metadata")
    .eq("conversation_id", conversationId)
    .order("created_at_ebay", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(MAX_MESSAGES);
  if (error) throw new EbayConversationContextError("message_lookup_failed", { phase: "message_lookup", message: error.message });
  return (data || []) as Array<Record<string, any>>;
}

async function upsertConversationLink(supabase: EbayConversationContextClient, candidate: LinkCandidate) {
  const { data: existingRows, error: lookupError } = await supabase
    .from("ebay_conversation_links")
    .select("id, confidence, status, metadata")
    .eq("conversation_id", candidate.conversation_id)
    .eq("link_type", candidate.link_type)
    .eq("link_key", candidate.link_key)
    .limit(1);
  if (lookupError) throw new EbayConversationContextError("conversation_link_lookup_failed", { phase: "link_lookup", message: lookupError.message });

  const existing = (existingRows || [])[0];
  if (existing?.id) {
    const existingConfidence = Number(existing.confidence || 0);
    const shouldUpdate = candidate.confidence > existingConfidence ||
      (existing.status === "suggested" && candidate.status === "confirmed") ||
      JSON.stringify(existing.metadata || {}) !== JSON.stringify(candidate.metadata || {});
    if (!shouldUpdate) return { created: 0, updated: 0, unchanged: 1 };

    const { error } = await supabase
      .from("ebay_conversation_links")
      .update({
        ebay_order_id: candidate.ebay_order_id || null,
        ebay_order_line_id: candidate.ebay_order_line_id || null,
        ebay_return_case_id: candidate.ebay_return_case_id || null,
        reference_id: candidate.reference_id || null,
        reference_type: candidate.reference_type || null,
        buyer_username: candidate.buyer_username || null,
        matched_value: candidate.matched_value,
        match_method: candidate.match_method,
        confidence: candidate.confidence,
        status: candidate.status,
        metadata: candidate.metadata,
      })
      .eq("id", existing.id);
    if (error) throw new EbayConversationContextError("conversation_link_update_failed", { phase: "link_update", message: error.message });
    return { created: 0, updated: 1, unchanged: 0 };
  }

  const { error } = await supabase.from("ebay_conversation_links").insert(candidate);
  if (error) throw new EbayConversationContextError("conversation_link_insert_failed", { phase: "link_insert", message: error.message });
  return { created: 1, updated: 0, unchanged: 0 };
}

function pushDirectConversationCandidates(
  candidates: LinkCandidate[],
  conversation: Record<string, any>,
  identifiers: ReturnType<typeof extractConversationIdentifiers>,
) {
  if (conversation.reference_id) {
    candidates.push({
      conversation_id: conversation.id,
      seller_account_id: conversation.seller_account_id,
      link_type: "listing_reference",
      link_key: `reference:${conversation.reference_type || "UNKNOWN"}:${conversation.reference_id}`,
      reference_id: conversation.reference_id,
      reference_type: conversation.reference_type,
      matched_value: String(conversation.reference_id),
      match_method: "direct_api_field",
      confidence: 0.9,
      status: "confirmed",
      metadata: linkMetadata(identifiers, "direct_api_field", { source: "ebay_conversations.reference_id" }),
    });
  }
  if (conversation.other_party_username) {
    candidates.push({
      conversation_id: conversation.id,
      seller_account_id: conversation.seller_account_id,
      link_type: "buyer_username",
      link_key: `username:${lowerTrim(conversation.other_party_username)}`,
      buyer_username: conversation.other_party_username,
      matched_value: String(conversation.other_party_username),
      match_method: "direct_api_field",
      confidence: 0.92,
      status: "confirmed",
      metadata: linkMetadata(identifiers, "direct_api_field", { source: "ebay_conversations.other_party_username" }),
    });
  }
}

function pushParticipantBuyerCandidates(
  candidates: LinkCandidate[],
  conversation: Record<string, any>,
  identifiers: ReturnType<typeof extractConversationIdentifiers>,
) {
  const existingBuyerKeys = new Set(
    candidates
      .filter((candidate) => candidate.link_type === "buyer_username")
      .map((candidate) => buyerKey(candidate.buyer_username || candidate.matched_value))
      .filter(Boolean) as string[],
  );
  const participantBuyers = unique(identifiers.buyerUsernames, 10)
    .map((value) => text(value, 120))
    .filter((value) => {
      const key = buyerKey(value);
      return key && key !== "ebay" && !existingBuyerKeys.has(key);
    });
  const isMemberConversation = String(conversation.conversation_type || "") === "FROM_MEMBERS";

  for (const username of participantBuyers) {
    const key = buyerKey(username);
    if (!key) continue;
    existingBuyerKeys.add(key);
    candidates.push({
      conversation_id: conversation.id,
      seller_account_id: conversation.seller_account_id,
      link_type: "buyer_username",
      link_key: `username:${key}`,
      buyer_username: username,
      matched_value: username,
      match_method: "message_participant",
      confidence: isMemberConversation ? 0.88 : 0.62,
      status: isMemberConversation ? "confirmed" : "suggested",
      metadata: linkMetadata(identifiers, "message_participant", {
        source: "ebay_conversation_messages.sender_or_recipient",
        exact_order_linked: false,
        provider_detail_refresh_recommended: !conversation.reference_id,
      }),
    });
  }
}

function lineCandidateFrom(
  conversation: Record<string, any>,
  identifiers: ReturnType<typeof extractConversationIdentifiers>,
  line: Record<string, any>,
  options: { matchedValue: string; method: string; confidence: number; status: LinkStatus; extra?: Record<string, unknown> },
): LinkCandidate {
  return {
    conversation_id: conversation.id,
    seller_account_id: conversation.seller_account_id,
    link_type: "ebay_order_line",
    link_key: `order_line:${line.id}`,
    ebay_order_id: line.order_id || null,
    ebay_order_line_id: line.id,
    reference_id: line.item_number || null,
    reference_type: "LISTING",
    buyer_username: line.order?.buyer_username || null,
    matched_value: options.matchedValue,
    match_method: options.method,
    confidence: options.confidence,
    status: options.status,
    metadata: linkMetadata(identifiers, options.method, compactObject({
      order_number: line.order?.order_number,
      buyer_username: line.order?.buyer_username,
      item_number: line.item_number,
      transaction_id: line.transaction_id,
      custom_label: line.custom_label,
      ...options.extra,
    })),
  };
}

function orderCandidateFrom(
  conversation: Record<string, any>,
  identifiers: ReturnType<typeof extractConversationIdentifiers>,
  order: Record<string, any>,
  options: { matchedValue: string; method: string; confidence: number; status: LinkStatus; extra?: Record<string, unknown> },
): LinkCandidate {
  return {
    conversation_id: conversation.id,
    seller_account_id: conversation.seller_account_id,
    link_type: "ebay_order",
    link_key: `order:${order.id}`,
    ebay_order_id: order.id,
    buyer_username: order.buyer_username || null,
    matched_value: options.matchedValue,
    match_method: options.method,
    confidence: options.confidence,
    status: options.status,
    metadata: linkMetadata(identifiers, options.method, compactObject({
      order_number: order.order_number,
      buyer_username: order.buyer_username,
      ...options.extra,
    })),
  };
}

function returnCandidateFrom(
  conversation: Record<string, any>,
  identifiers: ReturnType<typeof extractConversationIdentifiers>,
  returnCase: Record<string, any>,
  options: { matchedValue: string; method: string; confidence: number; status: LinkStatus; extra?: Record<string, unknown> },
): LinkCandidate {
  return {
    conversation_id: conversation.id,
    seller_account_id: conversation.seller_account_id,
    link_type: "ebay_return_case",
    link_key: `return_case:${returnCase.id}`,
    ebay_order_id: returnCase.order_id || null,
    ebay_return_case_id: returnCase.id,
    buyer_username: returnCase.buyer_username || null,
    matched_value: options.matchedValue,
    match_method: options.method,
    confidence: options.confidence,
    status: options.status,
    metadata: linkMetadata(identifiers, options.method, compactObject({
      ebay_return_id: returnCase.ebay_return_id,
      order_number: returnCase.order_number,
      buyer_username: returnCase.buyer_username,
      return_status: returnCase.status,
      ...options.extra,
    })),
  };
}

const TITLE_STOP_WORDS = new Set([
  "about",
  "and",
  "ebay",
  "for",
  "from",
  "item",
  "listing",
  "message",
  "order",
  "question",
  "sale",
  "sold",
  "that",
  "the",
  "this",
  "with",
]);

function normalizeTitleForMatch(value: unknown) {
  return text(value, 400)
    .toLowerCase()
    .replace(/\bsold\s*[-:]\s*/g, " ")
    .replace(/#[0-9]+\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleTokens(value: unknown) {
  return unique(normalizeTitleForMatch(value).split(" "), 80)
    .filter((token) => token.length >= 3 && !TITLE_STOP_WORDS.has(token));
}

function titleMatchScore(left: unknown, right: unknown) {
  const leftText = normalizeTitleForMatch(left);
  const rightText = normalizeTitleForMatch(right);
  if (!leftText || !rightText) return 0;
  if ((leftText.length >= 12 && rightText.includes(leftText)) || (rightText.length >= 12 && leftText.includes(rightText))) {
    return 0.96;
  }

  const leftTokens = titleTokens(leftText);
  const rightTokens = titleTokens(rightText);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const rightSet = new Set(rightTokens);
  const common = leftTokens.filter((token) => rightSet.has(token)).length;
  const overlap = common / Math.min(leftTokens.length, rightTokens.length);
  const union = new Set([...leftTokens, ...rightTokens]).size || 1;
  const jaccard = common / union;
  return (overlap * 0.82) + (jaccard * 0.18);
}

function conversationTitleCandidates(conversation: Record<string, any>, messages: Array<Record<string, any>>) {
  return unique([
    conversation.conversation_title,
    ...messages.map((message) => message.subject),
  ], 12).filter((value) => titleTokens(value).length >= 2);
}

function bestLineByBuyerAndTime(lines: Array<Record<string, any>>, buyerUsernames: string[], targetTime: string | null) {
  const buyerKeys = new Set(buyerUsernames.map(lowerTrim).filter(Boolean));
  const buyerMatched = buyerKeys.size
    ? lines.filter((line) => buyerKeys.has(lowerTrim(line.order?.buyer_username)))
    : lines;
  const pool = buyerMatched.length ? buyerMatched : lines;
  const scored = pool
    .map((line) => ({
      line,
      days: daysBetween(targetTime, line.order?.sale_date || line.order?.paid_on_date),
    }))
    .sort((a, b) => (a.days ?? 999999) - (b.days ?? 999999));
  const best = scored[0] || null;
  const second = scored[1] || null;
  if (!best) return null;
  return {
    line: best.line,
    buyerMatched: buyerMatched.includes(best.line),
    days: best.days,
    uniqueByTime: best.days !== null && (!second || second.days === null || second.days - best.days >= 2),
    candidateCount: lines.length,
  };
}

async function pushBuyerTitleOrderLineCandidates(
  supabase: EbayConversationContextClient,
  candidates: LinkCandidate[],
  conversation: Record<string, any>,
  messages: Array<Record<string, any>>,
  identifiers: ReturnType<typeof extractConversationIdentifiers>,
  targetTime: string | null,
  warnings: Array<Record<string, unknown>>,
) {
  const buyerUsernames = unique(identifiers.buyerUsernames, 10);
  const titleCandidates = conversationTitleCandidates(conversation, messages);
  if (!buyerUsernames.length || !titleCandidates.length) return;

  const { data: orders, error: ordersError } = await supabase
    .from("ebay_orders")
    .select("id, order_number, buyer_username, buyer_name, buyer_email, status, sale_date, paid_on_date")
    .in("buyer_username", buyerUsernames)
    .order("sale_date", { ascending: false, nullsFirst: false })
    .limit(80);
  if (ordersError) throw new EbayConversationContextError("order_lookup_failed", { phase: "buyer_title_order_lookup", message: ordersError.message });
  const orderIds = uniqueIds((orders || []).map((order: Record<string, any>) => order.id), 80);
  if (!orderIds.length) return;

  const lines = await queryByChunks<Record<string, any>>(orderIds, async (chunk) => {
    const { data, error } = await supabase
      .from("ebay_order_lines")
      .select(orderLineSelect())
      .in("order_id", chunk)
      .limit(120);
    if (error) throw new EbayConversationContextError("order_line_lookup_failed", { phase: "buyer_title_line_lookup", message: error.message });
    return data || [];
  });

  const scored = lines
    .flatMap((line) => titleCandidates.map((candidateTitle) => ({
      line,
      candidateTitle,
      titleScore: titleMatchScore(candidateTitle, line.item_title),
      days: daysBetween(targetTime, line.order?.sale_date || line.order?.paid_on_date),
    })))
    .filter((entry) => entry.titleScore >= 0.72)
    .sort((a, b) => {
      const scoreDelta = b.titleScore - a.titleScore;
      if (Math.abs(scoreDelta) > 0.001) return scoreDelta;
      return (a.days ?? 999999) - (b.days ?? 999999);
    });

  const best = scored[0] || null;
  if (!best) {
    warnings.push(warning("buyer_title_order_line_not_found", "Buyer was found, but no stored order line title matched the eBay conversation title.", "info"));
    return;
  }
  const second = scored.find((entry) => String(entry.line.id) !== String(best.line.id)) || null;
  const closeSecond = second && second.titleScore >= best.titleScore - 0.08 && Math.abs((second.days ?? 999999) - (best.days ?? 999999)) <= 2;
  const status: LinkStatus = best.titleScore >= 0.86 && !closeSecond ? "confirmed" : "suggested";
  candidates.push(lineCandidateFrom(conversation, identifiers, best.line, {
    matchedValue: text(best.candidateTitle, 180),
    method: "buyer_title_time_order_line",
    confidence: status === "confirmed" ? 0.88 : 0.74,
    status,
    extra: {
      buyer_matched: true,
      title_score: Number(best.titleScore.toFixed(3)),
      proximity_days: best.days,
      candidate_count: scored.length,
    },
  }));
}

async function pushBuyerRecentOrderCandidates(
  supabase: EbayConversationContextClient,
  candidates: LinkCandidate[],
  conversation: Record<string, any>,
  identifiers: ReturnType<typeof extractConversationIdentifiers>,
  targetTime: string | null,
  warnings: Array<Record<string, unknown>>,
) {
  const buyerUsernames = unique(identifiers.buyerUsernames, 10);
  if (!buyerUsernames.length || !targetTime) return;

  const { data: orders, error } = await supabase
    .from("ebay_orders")
    .select("id, order_number, buyer_username, buyer_name, buyer_email, status, sale_date, paid_on_date")
    .in("buyer_username", buyerUsernames)
    .order("sale_date", { ascending: false, nullsFirst: false })
    .limit(40);
  if (error) throw new EbayConversationContextError("order_lookup_failed", { phase: "buyer_recent_order_lookup", message: error.message });

  const scored = (orders || [])
    .map((order: Record<string, any>) => ({
      order,
      days: daysBetween(targetTime, order.sale_date || order.paid_on_date),
    }))
    .filter((entry: { days: number | null }) => entry.days !== null && entry.days <= 14)
    .sort((a: { days: number | null }, b: { days: number | null }) => (a.days ?? 999999) - (b.days ?? 999999));
  const best = scored[0] || null;
  if (!best) return;

  const second = scored[1] || null;
  const uniqueByTime = !second || second.days === null || (second.days ?? 999999) - (best.days ?? 999999) >= 2;
  const veryClose = (best.days ?? 999999) <= 2;
  if (!uniqueByTime && !veryClose) {
    warnings.push(warning("ambiguous_buyer_recent_orders", "Buyer has multiple recent orders near this conversation time, so no automatic buyer-only order link was created.", "info"));
    return;
  }

  const status: LinkStatus = veryClose && uniqueByTime ? "confirmed" : "suggested";
  candidates.push(orderCandidateFrom(conversation, identifiers, best.order, {
    matchedValue: String(best.order.order_number || best.order.id),
    method: "buyer_recent_unique_order",
    confidence: status === "confirmed" ? 0.82 : 0.68,
    status,
    extra: {
      buyer_matched: true,
      proximity_days: best.days,
      candidate_count: scored.length,
      title_not_required: true,
    },
  }));
}

async function buildLinkCandidates(
  supabase: EbayConversationContextClient,
  conversation: Record<string, any>,
  messages: Array<Record<string, any>>,
  warnings: Array<Record<string, unknown>>,
) {
  const identifiers = extractConversationIdentifiers(conversation, messages);
  const candidates: LinkCandidate[] = [];
  const targetTime = conversationTime(conversation);
  pushDirectConversationCandidates(candidates, conversation, identifiers);
  pushParticipantBuyerCandidates(candidates, conversation, identifiers);

  if (identifiers.orderNumbers.length) {
    const orders = await queryByChunks<Record<string, any>>(identifiers.orderNumbers, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_orders")
        .select("id, order_number, buyer_username, buyer_name, buyer_email, status, sale_date, paid_on_date")
        .in("order_number", chunk);
      if (error) throw new EbayConversationContextError("order_lookup_failed", { phase: "order_lookup", message: error.message });
      return data || [];
    });
    for (const order of orders) {
      candidates.push(orderCandidateFrom(conversation, identifiers, order, {
        matchedValue: order.order_number,
        method: "order_number_exact",
        confidence: 1.0,
        status: "confirmed",
      }));
    }
    const matchedOrderNumbers = new Set(orders.map((order) => String(order.order_number || "")));
    const missingOrderNumbers = identifiers.orderNumbers.filter((orderNumber) => !matchedOrderNumbers.has(orderNumber));
    if (missingOrderNumbers.length) {
      warnings.push(warning(
        "conversation_order_not_found_locally",
        `eBay referenced order ${missingOrderNumbers.slice(0, 5).join(", ")}, but no matching local ebay_orders row was found. Sync order history or pending orders for that order number.`,
        "warning",
      ));
    }
  }

  if (identifiers.itemNumbers.length && identifiers.transactionIds.length) {
    const lines = await queryByChunks<Record<string, any>>(identifiers.itemNumbers, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_order_lines")
        .select(orderLineSelect())
        .in("item_number", chunk)
        .in("transaction_id", identifiers.transactionIds);
      if (error) throw new EbayConversationContextError("order_line_lookup_failed", { phase: "item_transaction_lookup", message: error.message });
      return data || [];
    });
    for (const line of lines) {
      candidates.push(lineCandidateFrom(conversation, identifiers, line, {
        matchedValue: `${line.item_number}:${line.transaction_id}`,
        method: "item_transaction_exact",
        confidence: 1.0,
        status: "confirmed",
      }));
    }
  }

  const listingValues = unique([...identifiers.itemNumbers, ...identifiers.listingIds]);
  if (listingValues.length) {
    const lines = await queryByChunks<Record<string, any>>(listingValues, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_order_lines")
        .select(orderLineSelect())
        .in("item_number", chunk);
      if (error) throw new EbayConversationContextError("order_line_lookup_failed", { phase: "listing_line_lookup", message: error.message });
      return data || [];
    });

    const byItem = new Map<string, Array<Record<string, any>>>();
    for (const line of lines) {
      const itemNumber = String(line.item_number || "");
      byItem.set(itemNumber, [...(byItem.get(itemNumber) || []), line]);
    }
    for (const [itemNumber, matchedLines] of byItem) {
      if (candidates.some((candidate) => candidate.link_type === "ebay_order_line" && candidate.ebay_order_line_id && matchedLines.some((line) => line.id === candidate.ebay_order_line_id))) continue;
      if (matchedLines.length === 1) {
        const line = matchedLines[0];
        const buyerMatches = identifiers.buyerUsernames.includes(lowerTrim(line.order?.buyer_username));
        candidates.push(lineCandidateFrom(conversation, identifiers, line, {
          matchedValue: itemNumber,
          method: buyerMatches ? "listing_buyer_unique_order_line" : "listing_unique_order_line",
          confidence: buyerMatches ? 0.9 : 0.76,
          status: buyerMatches ? "confirmed" : "suggested",
          extra: { buyer_matched: buyerMatches },
        }));
      } else if (matchedLines.length > 1) {
        const best = bestLineByBuyerAndTime(matchedLines, identifiers.buyerUsernames, targetTime);
        if (best && best.buyerMatched && (best.uniqueByTime || best.candidateCount <= 3)) {
          candidates.push(lineCandidateFrom(conversation, identifiers, best.line, {
            matchedValue: itemNumber,
            method: "listing_buyer_time_proximity",
            confidence: best.uniqueByTime ? 0.82 : 0.72,
            status: best.uniqueByTime ? "confirmed" : "suggested",
            extra: { buyer_matched: true, proximity_days: best.days, candidate_count: best.candidateCount },
          }));
        } else {
          warnings.push(warning("ambiguous_listing_order_lines", `Listing/item ${itemNumber} matched multiple order lines.`, "warning"));
        }
      }
    }
  }

  if (identifiers.labelValues.length) {
    const labels = unique([...identifiers.labels, ...identifiers.labelValues]);
    const lines = await queryByChunks<Record<string, any>>(labels, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_order_lines")
        .select(orderLineSelect())
        .in("custom_label", chunk);
      if (error) throw new EbayConversationContextError("order_line_lookup_failed", { phase: "custom_label_lookup", message: error.message });
      return data || [];
    });
    const byLabel = new Map<string, Array<Record<string, any>>>();
    for (const line of lines) {
      const key = String(line.custom_label || "");
      byLabel.set(key, [...(byLabel.get(key) || []), line]);
    }
    for (const [label, matchedLines] of byLabel) {
      if (matchedLines.length === 1) {
        candidates.push(lineCandidateFrom(conversation, identifiers, matchedLines[0], {
          matchedValue: label,
          method: "custom_label_exact",
          confidence: 0.78,
          status: "suggested",
        }));
      } else if (matchedLines.length > 1) {
        warnings.push(warning("ambiguous_custom_label_order_lines", `Custom label ${label} matched multiple order lines.`, "warning"));
      }
    }
  }

  const hasOrderCandidate = candidates.some((candidate) => candidate.link_type === "ebay_order" || candidate.link_type === "ebay_order_line");
  if (!hasOrderCandidate) {
    await pushBuyerTitleOrderLineCandidates(supabase, candidates, conversation, messages, identifiers, targetTime, warnings);
  }
  const hasFallbackOrderCandidate = candidates.some((candidate) => candidate.link_type === "ebay_order" || candidate.link_type === "ebay_order_line");
  if (!hasFallbackOrderCandidate) {
    await pushBuyerRecentOrderCandidates(supabase, candidates, conversation, identifiers, targetTime, warnings);
  }

  const orderIds = uniqueIds(candidates.map((candidate) => candidate.ebay_order_id), MAX_LINKS);
  const orderNumbersFromCandidates = unique(candidates.map((candidate) => String(candidate.metadata?.order_number || "")), MAX_LINKS);
  if (orderIds.length || orderNumbersFromCandidates.length || identifiers.returnIds.length) {
    const returnRows = new Map<string, Record<string, any>>();
    if (identifiers.returnIds.length) {
      const rows = await queryByChunks<Record<string, any>>(identifiers.returnIds, async (chunk) => {
        const { data, error } = await supabase
          .from("ebay_return_cases")
          .select("id, ebay_return_id, order_id, order_number, buyer_username, status, return_reason, opened_at, received_at, closed_at, return_tracking_number")
          .in("ebay_return_id", chunk);
        if (error) throw new EbayConversationContextError("return_lookup_failed", { phase: "return_id_lookup", message: error.message });
        return data || [];
      });
      for (const row of rows) returnRows.set(String(row.id), row);
    }
    if (orderIds.length) {
      const { data, error } = await supabase
        .from("ebay_return_cases")
        .select("id, ebay_return_id, order_id, order_number, buyer_username, status, return_reason, opened_at, received_at, closed_at, return_tracking_number")
        .in("order_id", orderIds)
        .limit(MAX_RETURNS);
      if (error) throw new EbayConversationContextError("return_lookup_failed", { phase: "return_order_lookup", message: error.message });
      for (const row of data || []) returnRows.set(String(row.id), row);
    }
    if (orderNumbersFromCandidates.length) {
      const { data, error } = await supabase
        .from("ebay_return_cases")
        .select("id, ebay_return_id, order_id, order_number, buyer_username, status, return_reason, opened_at, received_at, closed_at, return_tracking_number")
        .in("order_number", orderNumbersFromCandidates)
        .limit(MAX_RETURNS);
      if (error) throw new EbayConversationContextError("return_lookup_failed", { phase: "return_order_number_lookup", message: error.message });
      for (const row of data || []) returnRows.set(String(row.id), row);
    }
    for (const returnCase of returnRows.values()) {
      const exactReturn = identifiers.returnIds.includes(String(returnCase.ebay_return_id || ""));
      candidates.push(returnCandidateFrom(conversation, identifiers, returnCase, {
        matchedValue: String(returnCase.ebay_return_id || returnCase.order_number || returnCase.id),
        method: exactReturn ? "return_id_exact" : "matched_order_return_context",
        confidence: exactReturn ? 1.0 : 0.86,
        status: exactReturn ? "confirmed" : "suggested",
      }));
    }
  }

  const inventoryLookupValues = unique([...identifiers.listingIds, ...identifiers.labelValues, ...identifiers.itemNumbers]);
  if (inventoryLookupValues.length) {
    const inventoryLinks = await queryByChunks<Record<string, any>>(inventoryLookupValues, async (chunk) => {
      const [skuResult, listingResult, offerResult] = await Promise.all([
        supabase.from("ebay_inventory_links").select("item_type_id, sku, offer_id, listing_id, status, last_synced_at, updated_at").in("sku", chunk),
        supabase.from("ebay_inventory_links").select("item_type_id, sku, offer_id, listing_id, status, last_synced_at, updated_at").in("listing_id", chunk),
        supabase.from("ebay_inventory_links").select("item_type_id, sku, offer_id, listing_id, status, last_synced_at, updated_at").in("offer_id", chunk),
      ]);
      if (skuResult.error || listingResult.error || offerResult.error) {
        throw new EbayConversationContextError("inventory_lookup_failed", { phase: "inventory_lookup" });
      }
      const byItem = new Map<string, Record<string, any>>();
      for (const link of [...(skuResult.data || []), ...(listingResult.data || []), ...(offerResult.data || [])]) byItem.set(String(link.item_type_id), link);
      return [...byItem.values()];
    });
    for (const link of inventoryLinks) {
      const matchedField = [
        ["sku", link.sku],
        ["listing_id", link.listing_id],
        ["offer_id", link.offer_id],
      ].find(([, value]) => value && inventoryLookupValues.includes(String(value)));
      if (!matchedField) continue;
      candidates.push({
        conversation_id: conversation.id,
        seller_account_id: conversation.seller_account_id,
        link_type: "inventory_listing",
        link_key: `inventory:${link.item_type_id}`,
        reference_id: link.listing_id || link.offer_id || link.sku || null,
        reference_type: String(matchedField[0]),
        matched_value: String(matchedField[1]),
        match_method: matchedField[0] === "sku" ? "inventory_sku_exact" : "inventory_listing_bridge_exact",
        confidence: matchedField[0] === "sku" ? 0.68 : 0.58,
        status: "suggested",
        metadata: linkMetadata(identifiers, matchedField[0] === "sku" ? "inventory_sku_exact" : "inventory_listing_bridge_exact", {
          item_type_id: link.item_type_id,
          sku: link.sku,
          offer_id: link.offer_id,
          listing_id: link.listing_id,
          status: link.status,
          last_synced_at: link.last_synced_at,
          inventory_availability_not_verified: true,
        }),
      });
    }
  }

  const deduped = new Map<string, LinkCandidate>();
  for (const candidate of candidates) {
    const existing = deduped.get(`${candidate.link_type}:${candidate.link_key}`);
    if (!existing || candidate.confidence > existing.confidence || (existing.status === "suggested" && candidate.status === "confirmed")) {
      deduped.set(`${candidate.link_type}:${candidate.link_key}`, candidate);
    }
  }
  return [...deduped.values()];
}

export async function linkEbayConversationContext(
  supabase: EbayConversationContextClient,
  conversationId: string,
) {
  const conversation = await loadConversation(supabase, conversationId);
  const messages = await loadMessages(supabase, conversation.id);
  const counters: LinkCounters = {
    scanned: 1,
    candidates: 0,
    links_created: 0,
    links_updated: 0,
    links_unchanged: 0,
    warnings: [],
  };
  const candidates = await buildLinkCandidates(supabase, conversation, messages, counters.warnings);
  counters.candidates = candidates.length;
  for (const candidate of candidates) {
    const result = await upsertConversationLink(supabase, candidate);
    counters.links_created += result.created;
    counters.links_updated += result.updated;
    counters.links_unchanged += result.unchanged;
  }
  return counters;
}

function compactConversation(conversation: Record<string, any>) {
  return {
    id: conversation.id,
    seller_account_id: conversation.seller_account_id,
    ebay_conversation_id: conversation.ebay_conversation_id,
    conversation_type: conversation.conversation_type,
    conversation_status: shortText(conversation.conversation_status, 120),
    conversation_title: shortText(conversation.conversation_title, 300),
    other_party_username: shortText(conversation.other_party_username, 120),
    reference_id: shortText(conversation.reference_id, 160),
    reference_type: shortText(conversation.reference_type, 80),
    unread_count: integerOrNull(conversation.unread_count) || 0,
    latest_message_created_at: conversation.latest_message_created_at || null,
    first_message_created_at: conversation.first_message_created_at || null,
    last_message_created_at: conversation.last_message_created_at || null,
    message_count: integerOrNull(conversation.message_count),
    last_synced_at: conversation.last_synced_at || null,
    last_detail_synced_at: conversation.last_detail_synced_at || null,
  };
}

function compactMessage(message: Record<string, any>) {
  return {
    id: message.id,
    ebay_message_id: shortText(message.ebay_message_id, 180),
    sender_username: shortText(message.sender_username, 120),
    recipient_username: shortText(message.recipient_username, 120),
    direction: shortText(message.direction, 40),
    direction_confidence: shortText(message.direction_confidence, 40),
    subject: shortText(message.subject, 300),
    message_body: shortText(message.message_body, 5000),
    message_body_preview: shortText(message.message_body_preview, 500),
    is_read: typeof message.is_read === "boolean" ? message.is_read : null,
    read_status: shortText(message.read_status, 80),
    message_status: shortText(message.message_status, 80),
    created_at_ebay: message.created_at_ebay || null,
    has_media: message.has_media === true,
    media_count: integerOrNull(message.media_count) || 0,
    message_media: Array.isArray(message.message_media) ? message.message_media.slice(0, 10).map((item: unknown) => compactContextValue(item)) : [],
  };
}

function compactLink(link: Record<string, any>) {
  return {
    id: link.id,
    link_type: shortText(link.link_type, 80),
    link_key: shortText(link.link_key, 240),
    status: shortText(link.status, 80),
    ebay_order_id: link.ebay_order_id || null,
    ebay_order_line_id: link.ebay_order_line_id || null,
    ebay_return_case_id: link.ebay_return_case_id || null,
    reference_id: shortText(link.reference_id, 180),
    reference_type: shortText(link.reference_type, 80),
    buyer_username: shortText(link.buyer_username, 120),
    matched_value: shortText(link.matched_value, 180),
    match_method: shortText(link.match_method, 120),
    confidence: numberOrNull(link.confidence),
    metadata: compactContextValue(link.metadata || {}),
    created_at: link.created_at || null,
    updated_at: link.updated_at || null,
  };
}

function compactSafeLabelMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    [
      "trackingNumber",
      "shippingBarcodeNumber",
      "labelId",
      "carrier",
      "carrierCode",
      "shippingCarrier",
      "shipmentStatus",
      "deliveryStatus",
    ]
      .map((key) => [key, shortText(source[key], 180) || null])
      .filter(([, item]) => Boolean(item)),
  ) as Record<string, string>;
}

function compactOrder(order: Record<string, any>) {
  const safeLabelMetadata = compactSafeLabelMetadata(order.label_metadata);
  return {
    id: order.id,
    order_number: shortText(order.order_number, 120),
    buyer_username: shortText(order.buyer_username, 120),
    buyer_name: shortText(order.buyer_name, 160),
    buyer_email: shortText(order.buyer_email, 180),
    status: shortText(order.status, 80),
    sale_date: order.sale_date || null,
    paid_on_date: order.paid_on_date || null,
    ship_by_date: order.ship_by_date || null,
    shipped_on_date: order.shipped_on_date || null,
    total_price: numberOrNull(order.total_price),
    net_payout: numberOrNull(order.net_payout),
    tracking_number: shortText(order.tracking_number, 180),
    shipping_service: shortText(order.shipping_service, 180),
    ebay_shipment_id: shortText(order.ebay_shipment_id, 180),
    label_status: shortText(order.label_status, 80),
    carrier: shortText(order.carrier || safeLabelMetadata.carrier || safeLabelMetadata.shippingCarrier || safeLabelMetadata.carrierCode, 120),
    shipment_status: shortText(order.shipment_status || safeLabelMetadata.shipmentStatus || safeLabelMetadata.deliveryStatus, 120),
    safe_label_metadata: safeLabelMetadata,
  };
}

function compactOrderLine(line: Record<string, any>, order: Record<string, any> | null) {
  return {
    id: line.id,
    order_id: line.order_id || null,
    order_number: shortText(order?.order_number, 120),
    item_number: shortText(line.item_number, 120),
    transaction_id: shortText(line.transaction_id, 120),
    custom_label: shortText(line.custom_label, 180),
    item_title: shortText(line.item_title, 300),
    quantity: integerOrNull(line.quantity),
    sold_for: numberOrNull(line.sold_for),
    total_price: numberOrNull(line.total_price),
    line_status: shortText(line.line_status, 80),
    internal_item_id: line.internal_item_id || null,
    sale_id: line.sale_id || null,
  };
}

function compactOrderGroup(
  event: Record<string, any>,
  lineById: Map<string, Record<string, any>>,
  orderById: Map<string, Record<string, any>>,
) {
  const orderLineIds = uniqueIds(Array.isArray(event.order_line_ids) ? event.order_line_ids : [], MAX_LINKS * 20);
  const groupLines = orderLineIds
    .map((lineId) => lineById.get(String(lineId)))
    .filter(Boolean) as Array<Record<string, any>>;
  const orderIds = uniqueIds([
    ...(Array.isArray(event.order_ids) ? event.order_ids : []),
    ...groupLines.map((line) => line.order_id),
  ], MAX_LINKS * 20);
  const orderNumbers = unique(
    orderIds.map((orderId) => orderById.get(String(orderId))?.order_number),
    MAX_LINKS * 20,
  );
  const totalPrice = groupLines.reduce((sum, line) => {
    const value = Number(line.total_price ?? line.sold_for ?? 0);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  return {
    id: event.id,
    action: shortText(event.action, 120),
    created_at: event.created_at || null,
    order_ids: orderIds,
    order_line_ids: orderLineIds,
    order_numbers: orderNumbers,
    line_count: groupLines.length,
    total_price: numberOrNull(totalPrice),
  };
}

function mergeRowsById(...groups: Array<Array<Record<string, any>>>) {
  const rowsById = new Map<string, Record<string, any>>();
  for (const group of groups) {
    for (const row of group || []) {
      const id = String(row?.id || "");
      if (!id) continue;
      rowsById.set(id, { ...(rowsById.get(id) || {}), ...row });
    }
  }
  return [...rowsById.values()];
}

function compactReturnItem(item: Record<string, any>) {
  return {
    id: item.id,
    return_case_id: item.return_case_id || null,
    order_id: item.order_id || null,
    order_line_id: item.order_line_id || null,
    internal_item_id: item.internal_item_id || null,
    item_title: shortText(item.item_title, 240),
    item_number: shortText(item.item_number, 120),
    expected_quantity: integerOrNull(item.expected_quantity),
    received_quantity: integerOrNull(item.received_quantity),
    condition_received: shortText(item.condition_received, 80),
    disposition: shortText(item.disposition, 80),
    processed_at: item.processed_at || null,
  };
}

function compactReturnCase(returnCase: Record<string, any>, items: Array<Record<string, any>>) {
  return {
    id: returnCase.id,
    ebay_return_id: shortText(returnCase.ebay_return_id, 160),
    order_id: returnCase.order_id || null,
    order_number: shortText(returnCase.order_number, 120),
    buyer_username: shortText(returnCase.buyer_username, 120),
    status: shortText(returnCase.status, 80),
    return_reason: shortText(returnCase.return_reason, 240),
    opened_at: returnCase.opened_at || null,
    received_at: returnCase.received_at || null,
    closed_at: returnCase.closed_at || null,
    return_tracking_number: shortText(returnCase.return_tracking_number, 180),
    items: items.map(compactReturnItem),
  };
}

function compactInventoryLink(link: Record<string, any>) {
  return {
    item_type_id: link.item_type_id || null,
    sku: shortText(link.sku, 180),
    offer_id: shortText(link.offer_id, 180),
    listing_id: shortText(link.listing_id, 180),
    status: shortText(link.status, 80),
    last_synced_at: link.last_synced_at || null,
    updated_at: link.updated_at || null,
  };
}

function chooseBuyer(values: {
  conversation: Record<string, any>;
  links: Array<Record<string, any>>;
  orders: Array<Record<string, any>>;
  lineOrders: Array<Record<string, any>>;
  returns: Array<Record<string, any>>;
  warnings: Array<Record<string, unknown>>;
}) {
  const candidates: Array<{ username: string; key: string; matched_from: string; reliability: number; name: string | null; email: string | null }> = [];
  const addCandidate = (username: unknown, matchedFrom: string, reliability: number, name?: unknown, email?: unknown) => {
    const usernameText = shortText(username, 120);
    const key = buyerKey(usernameText);
    if (!usernameText || !key) return;
    candidates.push({
      username: usernameText,
      key,
      matched_from: matchedFrom,
      reliability,
      name: shortText(name, 160),
      email: shortText(email, 180),
    });
  };

  addCandidate(values.conversation.other_party_username, "conversation", 5);
  for (const order of values.orders) addCandidate(order.buyer_username, "order", 4, order.buyer_name, order.buyer_email);
  for (const order of values.lineOrders) addCandidate(order.buyer_username, "order_line", 3, order.buyer_name, order.buyer_email);
  for (const returnCase of values.returns) addCandidate(returnCase.buyer_username, "return_case", 2);
  for (const link of values.links) {
    const confidence = Number(link.confidence || 0);
    const matchMethod = text(link.match_method, 120);
    const reliability = link.link_type === "buyer_username" && (matchMethod === "message_participant" || confidence >= 0.8)
      ? 3
      : 1;
    addCandidate(
      link.buyer_username || (link.link_type === "buyer_username" ? link.matched_value : null),
      matchMethod === "message_participant" ? "message_participant" : "conversation_link",
      reliability,
    );
  }

  if (!candidates.length) return { username: null, name: null, email: null, matched_from: null, confidence: "none" };
  const maxReliability = Math.max(...candidates.map((candidate) => candidate.reliability));
  const strongest = candidates.filter((candidate) => candidate.reliability === maxReliability);
  const strongestKeys = unique(strongest.map((candidate) => candidate.key), 10);
  if (strongestKeys.length > 1) {
    values.warnings.push(warning("ambiguous_buyer_match", "Multiple equally strong buyer usernames were found.", "warning"));
    return { username: null, name: null, email: null, matched_from: null, confidence: "none" };
  }
  const allKeys = unique(candidates.map((candidate) => candidate.key), 10);
  if (allKeys.length > 1) values.warnings.push(warning("buyer_context_disagreement", "Lower-confidence buyer hints disagree with the strongest buyer context.", "warning"));
  const selected = strongest.find((candidate) => candidate.name || candidate.email) || strongest[0];
  return {
    username: selected.username,
    name: selected.name,
    email: selected.email,
    matched_from: selected.matched_from,
    confidence: selected.reliability >= 2 ? "confirmed" : "weak",
  };
}

function summarizeLinkConfidence(links: Array<Record<string, any>>) {
  const active = links.filter((link) => ["confirmed", "suggested"].includes(String(link.status || "")));
  const maxConfidence = active.reduce((max, link) => Math.max(max, Number(link.confidence || 0)), 0);
  const confirmed = active.filter((link) => link.status === "confirmed").length;
  const suggested = active.filter((link) => link.status === "suggested").length;
  return {
    level: confirmed && maxConfidence >= 0.9 ? "strong" : confirmed ? "medium" : suggested ? "weak" : "none",
    max_confidence: maxConfidence || null,
    confirmed_links: confirmed,
    suggested_links: suggested,
    total_active_links: active.length,
  };
}

function contextResolution(values: {
  conversation: Record<string, any>;
  buyer: Record<string, unknown>;
  links: Array<Record<string, any>>;
  orders: Array<Record<string, any>>;
  lines: Array<Record<string, any>>;
  returns: Array<Record<string, any>>;
}) {
  const hasBuyer = Boolean(text(values.buyer?.username));
  const hasOrder = values.orders.length > 0 || values.lines.length > 0;
  const hasReturn = values.returns.length > 0;
  const hasReference = Boolean(text(values.conversation.reference_id));
  const linkTypes = new Set(values.links.map((link) => text(link.link_type)).filter(Boolean));
  const providerDetailRefreshRecommended = Boolean(values.conversation.ebay_conversation_id) &&
    !hasReference &&
    !hasOrder &&
    !hasReturn;

  return {
    buyer_found: hasBuyer,
    buyer_context_status: hasBuyer
      ? hasOrder ? "order_linked" : "buyer_found_no_exact_order"
      : "buyer_not_found",
    order_context_status: hasOrder ? "order_linked" : "no_exact_order_link",
    provider_detail_refresh_status: providerDetailRefreshRecommended ? "recommended" : "not_needed",
    provider_detail_refresh_recommended: providerDetailRefreshRecommended,
    deterministic_reference_found: hasReference,
    active_link_types: [...linkTypes],
  };
}

function compactBuyerHistorySummary(values: {
  insights: Record<string, any> | null;
  buyerHistorySync: Record<string, any> | null;
  accountHistoryRun: Record<string, any> | null;
}) {
  const summary = values.insights?.summary && typeof values.insights.summary === "object" ? values.insights.summary as Record<string, any> : {};
  const buyerSync = values.buyerHistorySync;
  const accountRun = values.accountHistoryRun;
  const lastSuccessAt = buyerSync?.last_success_at || accountRun?.finished_at || null;
  return {
    source: "stored_ebay_context",
    prior_order_count: integerOrNull(summary.orderCount),
    pending_order_count: integerOrNull(summary.pendingOrderCount),
    gross_value: numberOrNull(summary.grossSalesBeforeReturns ?? summary.grossSales),
    retained_value: numberOrNull(summary.grossSales ?? summary.netPayout),
    average_order_value: numberOrNull(summary.avgOrderValue),
    return_count: integerOrNull(summary.returnCount),
    open_return_count: integerOrNull(summary.openReturnCount),
    cancellation_count: integerOrNull(summary.cancelledOrderCount),
    first_prior_purchase_at: summary.firstPurchaseAt || null,
    last_prior_purchase_at: summary.lastPurchaseAt || null,
    coverage: {
      covered_by_account_archive: accountRun ? accountRun.status === "completed" : null,
      days_back: integerOrNull(buyerSync?.days_back ?? accountRun?.days_back),
      scanned_orders: integerOrNull(buyerSync?.scanned_orders ?? accountRun?.scanned_orders),
      matched_orders: integerOrNull(buyerSync?.matched_orders ?? accountRun?.matched_orders),
      last_success_at: lastSuccessAt,
      status: buyerSync?.status || accountRun?.status || null,
    },
  };
}

function compactBuyerValueLineBreakdown(data: Record<string, any> | null) {
  const rows = Array.isArray(data?.lineBreakdown) ? data.lineBreakdown : [];
  return rows.slice(0, MAX_BUYER_VALUE_LINES).map((row: Record<string, any>) => ({
    line_id: row.lineId || null,
    order_id: row.orderId || null,
    order_number: shortText(row.orderNumber, 120),
    purchase_at: row.purchaseAt || null,
    item_state: shortText(row.itemState, 80),
    title: shortText(row.title, 240),
    item_number: shortText(row.itemNumber, 120),
    transaction_id: shortText(row.transactionId, 120),
    custom_label: shortText(row.customLabel, 180),
    gross_value: numberOrNull(row.lineTotal ?? row.orderTotal),
    order_total: numberOrNull(row.orderTotal),
    returned_value: numberOrNull(row.lineReturnedAmount ?? row.orderReturnedAmount),
    retained_value: numberOrNull(row.lineRetainedAmount ?? row.orderRetainedAmount),
    return_count: integerOrNull(row.returnCount),
    open_return_count: integerOrNull(row.openReturnCount),
  }));
}

export async function resolveEbayConversation(
  supabase: EbayConversationContextClient,
  options: { conversationId?: string | null; ebayConversationId?: string | null; conversationType?: string | null },
) {
  if (options.conversationId) return await loadConversation(supabase, options.conversationId);
  if (options.ebayConversationId) return await loadConversationByEbayId(supabase, options.ebayConversationId, options.conversationType);
  throw new EbayConversationContextError("conversation_id_required", { status: 400, phase: "input" });
}

export async function buildEbayConversationContext(
  supabase: EbayConversationContextClient,
  conversationId: string,
  rpcSupabase: EbayConversationContextClient = supabase,
) {
  const warnings: Array<Record<string, unknown>> = [];
  const conversation = await loadConversation(supabase, conversationId);
  const messages = await loadMessages(supabase, conversation.id);
  const { data: linksData, error: linksError } = await supabase
    .from("ebay_conversation_links")
    .select("id, link_type, link_key, ebay_order_id, ebay_order_line_id, ebay_return_case_id, reference_id, reference_type, buyer_username, matched_value, match_method, confidence, status, metadata, created_at, updated_at")
    .eq("conversation_id", conversation.id)
    .in("status", ["confirmed", "suggested"])
    .order("confidence", { ascending: false, nullsFirst: false })
    .limit(MAX_LINKS);
  if (linksError) throw new EbayConversationContextError("link_lookup_failed", { phase: "link_lookup", message: linksError.message });
  const links = (linksData || []) as Array<Record<string, any>>;
  if (!links.length) warnings.push(warning("no_conversation_links", "No active eBay conversation links exist yet.", "info"));

  const directOrderIds = uniqueIds(links.map((link) => link.ebay_order_id), MAX_LINKS);
  const orderLineIds = uniqueIds(links.map((link) => link.ebay_order_line_id), MAX_LINKS);
  const returnCaseIds = uniqueIds(links.map((link) => link.ebay_return_case_id), MAX_RETURNS);
  const inventoryItemTypeIds = uniqueIds(links.map((link) => link.metadata?.item_type_id), MAX_LINKS);
  const inventoryReferenceIds = unique(links.map((link) => link.link_type === "inventory_listing" || link.link_type === "listing_reference" ? link.reference_id : null), MAX_LINKS);

  const linkedLinesResult = orderLineIds.length
    ? await supabase
      .from("ebay_order_lines")
      .select("id, order_id, item_number, transaction_id, custom_label, item_title, quantity, sold_for, total_price, line_status, internal_item_id, sale_id")
      .in("id", orderLineIds)
      .limit(MAX_LINKS)
    : { data: [], error: null };
  if (linkedLinesResult.error) warnings.push(warning("order_line_context_partial", "Linked order lines could not be loaded.", "warning"));
  const linkedLines = (linkedLinesResult.data || []) as Array<Record<string, any>>;
  const linkedLineIds = uniqueIds(linkedLines.map((line) => line.id), MAX_LINKS);
  const groupEventsResult = linkedLineIds.length
    ? await supabase
      .from("ebay_order_admin_events")
      .select("id, action, order_ids, order_line_ids, created_at, payload")
      .overlaps("order_line_ids", linkedLineIds)
      .limit(MAX_LINKS)
    : { data: [], error: null };
  if (groupEventsResult.error) warnings.push(warning("order_history_group_context_partial", "Related order-history groups could not be loaded.", "warning"));
  const groupLineIds = uniqueIds(
    (groupEventsResult.data || []).flatMap((event: Record<string, any>) => Array.isArray(event.order_line_ids) ? event.order_line_ids : []),
    MAX_LINKS * 20,
  );
  const groupLinesResult = groupLineIds.length
    ? await supabase
      .from("ebay_order_lines")
      .select("id, order_id, item_number, transaction_id, custom_label, item_title, quantity, sold_for, total_price, line_status, internal_item_id, sale_id")
      .in("id", groupLineIds)
      .limit(MAX_LINKS * 20)
    : { data: [], error: null };
  if (groupLinesResult.error) warnings.push(warning("order_history_group_line_context_partial", "Lines from related order-history groups could not be loaded.", "warning"));
  const groupLines = (groupLinesResult.data || []) as Array<Record<string, any>>;
  const contextSeedLines = mergeRowsById(linkedLines, groupLines);
  const lineOrderIds = uniqueIds(contextSeedLines.map((line) => line.order_id), MAX_LINKS);
  const allOrderIds = uniqueIds([...directOrderIds, ...lineOrderIds], MAX_LINKS);

  const ordersResult = allOrderIds.length
    ? await supabase
      .from("ebay_orders")
      .select("id, order_number, buyer_username, buyer_name, buyer_email, status, sale_date, paid_on_date, ship_by_date, shipped_on_date, total_price, net_payout, tracking_number, shipping_service, ebay_shipment_id, label_status, label_metadata")
      .in("id", allOrderIds)
      .limit(MAX_LINKS)
    : { data: [], error: null };
  if (ordersResult.error) warnings.push(warning("order_context_partial", "Linked orders could not be loaded.", "warning"));
  const orders = (ordersResult.data || []) as Array<Record<string, any>>;
  const orderById = new Map<string, Record<string, any>>();
  for (const order of orders) orderById.set(String(order.id), order);

  const orderLinesResult = allOrderIds.length
    ? await supabase
      .from("ebay_order_lines")
      .select("id, order_id, item_number, transaction_id, custom_label, item_title, quantity, sold_for, total_price, line_status, internal_item_id, sale_id")
      .in("order_id", allOrderIds)
      .limit(MAX_LINKS * 20)
    : { data: [], error: null };
  if (orderLinesResult.error) warnings.push(warning("order_sibling_line_context_partial", "All lines for matched orders could not be loaded.", "warning"));
  const orderLines = (orderLinesResult.data || []) as Array<Record<string, any>>;
  const lines = mergeRowsById(contextSeedLines, orderLines);
  const lineById = new Map<string, Record<string, any>>();
  for (const line of lines) lineById.set(String(line.id), line);
  const matchedOrderGroups = ((groupEventsResult.data || []) as Array<Record<string, any>>)
    .map((event) => compactOrderGroup(event, lineById, orderById))
    .filter((group) => group.order_line_ids.length > 0);

  const orderNumbers = unique(orders.map((order) => order.order_number), MAX_LINKS);
  const returnRows = new Map<string, Record<string, any>>();
  const returnLookups = await Promise.all([
    returnCaseIds.length
      ? supabase
        .from("ebay_return_cases")
        .select("id, ebay_return_id, order_id, order_number, buyer_username, status, return_reason, opened_at, received_at, closed_at, return_tracking_number")
        .in("id", returnCaseIds)
        .limit(MAX_RETURNS)
      : Promise.resolve({ data: [], error: null }),
    allOrderIds.length
      ? supabase
        .from("ebay_return_cases")
        .select("id, ebay_return_id, order_id, order_number, buyer_username, status, return_reason, opened_at, received_at, closed_at, return_tracking_number")
        .in("order_id", allOrderIds)
        .limit(MAX_RETURNS)
      : Promise.resolve({ data: [], error: null }),
    orderNumbers.length
      ? supabase
        .from("ebay_return_cases")
        .select("id, ebay_return_id, order_id, order_number, buyer_username, status, return_reason, opened_at, received_at, closed_at, return_tracking_number")
        .in("order_number", orderNumbers)
        .limit(MAX_RETURNS)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const result of returnLookups) {
    if (result.error) warnings.push(warning("return_context_partial", "Some return context could not be loaded.", "warning"));
    for (const row of result.data || []) returnRows.set(String(row.id), row);
  }
  const returns = [...returnRows.values()].sort((a, b) => String(b.opened_at || "").localeCompare(String(a.opened_at || ""))).slice(0, MAX_RETURNS);
  const returnIds = uniqueIds(returns.map((row) => row.id), MAX_RETURNS);
  const returnItemsResult = returnIds.length
    ? await supabase
      .from("ebay_return_items")
      .select("id, return_case_id, order_id, order_line_id, internal_item_id, item_title, item_number, expected_quantity, received_quantity, condition_received, disposition, processed_at")
      .in("return_case_id", returnIds)
      .limit(80)
    : { data: [], error: null };
  if (returnItemsResult.error) warnings.push(warning("return_item_context_partial", "Return item context could not be loaded.", "warning"));
  const returnItemsByCase = new Map<string, Array<Record<string, any>>>();
  for (const item of returnItemsResult.data || []) {
    const key = String(item.return_case_id || "");
    returnItemsByCase.set(key, [...(returnItemsByCase.get(key) || []), item]);
  }

  const inventoryLinks = new Map<string, Record<string, any>>();
  if (inventoryItemTypeIds.length || inventoryReferenceIds.length) {
    const inventoryResults = await Promise.all([
      inventoryItemTypeIds.length
        ? supabase.from("ebay_inventory_links").select("item_type_id, sku, offer_id, listing_id, status, last_synced_at, updated_at").in("item_type_id", inventoryItemTypeIds)
        : Promise.resolve({ data: [], error: null }),
      inventoryReferenceIds.length
        ? supabase.from("ebay_inventory_links").select("item_type_id, sku, offer_id, listing_id, status, last_synced_at, updated_at").in("listing_id", inventoryReferenceIds)
        : Promise.resolve({ data: [], error: null }),
      inventoryReferenceIds.length
        ? supabase.from("ebay_inventory_links").select("item_type_id, sku, offer_id, listing_id, status, last_synced_at, updated_at").in("offer_id", inventoryReferenceIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    for (const result of inventoryResults) {
      if (result.error) warnings.push(warning("inventory_context_partial", "Inventory listing context could not be loaded.", "warning"));
      for (const row of result.data || []) inventoryLinks.set(String(row.item_type_id), row);
    }
  }

  const lineOrders = lines.map((line) => orderById.get(String(line.order_id))).filter(Boolean) as Array<Record<string, any>>;
  const buyer = chooseBuyer({ conversation, links, orders, lineOrders, returns, warnings });
  const resolution = contextResolution({ conversation, buyer, links, orders, lines, returns });
  if (resolution.provider_detail_refresh_recommended) {
    warnings.push(warning(
      "provider_detail_refresh_recommended",
      "Buyer was derived from message participants, but no exact order/listing reference is stored yet. Run a targeted provider detail refresh.",
      "info",
    ));
  }
  let buyerHistorySummary = null;
  let buyerValueLineBreakdown: Array<Record<string, unknown>> = [];
  if (buyer.username && buyer.confidence === "confirmed") {
    const key = buyerKey(buyer.username);
    const [insightsResult, valueLineResult, buyerSyncResult, accountRunResult] = await Promise.all([
      rpcSupabase.rpc("get_ebay_buyer_insights", { _buyer_username: buyer.username, _days_back: null }),
      rpcSupabase.rpc("get_ebay_buyer_value_line_breakdown", { _buyer_username: buyer.username, _days_back: null }),
      key
        ? supabase
          .from("ebay_buyer_history_syncs")
          .select("buyer_key, buyer_username, status, days_back, scanned_orders, matched_orders, last_started_at, last_success_at, last_error, updated_at")
          .eq("buyer_key", key)
          .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from("ebay_account_history_sync_runs")
        .select("id, status, days_back, scanned_orders, matched_orders, started_at, finished_at, error")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (insightsResult.error) warnings.push(warning("buyer_history_rpc_failed", "Stored buyer insights RPC failed; returning partial context.", "warning"));
    if (valueLineResult.error) warnings.push(warning("buyer_value_line_rpc_failed", "Stored buyer value line RPC failed; returning partial context.", "warning"));
    if (buyerSyncResult.error || accountRunResult.error) warnings.push(warning("buyer_history_coverage_partial", "Buyer history sync coverage metadata could not be loaded.", "warning"));
    buyerHistorySummary = compactBuyerHistorySummary({
      insights: insightsResult.error ? null : insightsResult.data as Record<string, any> | null,
      buyerHistorySync: buyerSyncResult.error ? null : buyerSyncResult.data as Record<string, any> | null,
      accountHistoryRun: accountRunResult.error ? null : accountRunResult.data as Record<string, any> | null,
    });
    buyerValueLineBreakdown = valueLineResult.error ? [] : compactBuyerValueLineBreakdown(valueLineResult.data as Record<string, any> | null);
  } else if (buyer.username) {
    warnings.push(warning("buyer_history_skipped", "Buyer history was skipped because the buyer match is weak.", "info"));
  }

  return {
    context_version: CONTEXT_VERSION,
    conversation: compactConversation(conversation),
    messages: messages.map(compactMessage),
    links: links.map(compactLink),
    buyer,
    matched_orders: orders.map(compactOrder),
    matched_order_lines: lines.map((line) => compactOrderLine(line, orderById.get(String(line.order_id)) || null)),
    matched_order_groups: matchedOrderGroups,
    matched_returns: returns.map((returnCase) => compactReturnCase(returnCase, returnItemsByCase.get(String(returnCase.id)) || [])),
    context_resolution: resolution,
    buyer_history_summary: buyerHistorySummary,
    buyer_value_line_breakdown: buyerValueLineBreakdown,
    inventory_listing_context: [...inventoryLinks.values()].map(compactInventoryLink),
    warnings,
    link_confidence: summarizeLinkConfidence(links),
    safety: {
      ebay_mutations_performed: false,
      sends_enabled: false,
      messages_sent: 0,
    },
  };
}
