const PROCESSOR_VERSION = "v1";

export type DeterministicMatcherClient = any;

type EmailMessage = {
  id: string;
  subject: string | null;
  body_preview: string | null;
  from_email: string | null;
  from_name: string | null;
  sender_email: string | null;
  sender_name: string | null;
  received_at: string | null;
  sync_status: string;
};

type EmailBody = {
  body_text: string | null;
  body_html: string | null;
  normalized_text: string | null;
  normalized_text_sha256: string | null;
  normalization_version: string | null;
};

type EmailRecipient = {
  recipient_type: string;
  display_name: string | null;
  email: string | null;
  email_normalized: string | null;
};

export type DeterministicIdentifiers = {
  orderNumbers: string[];
  itemNumbers: string[];
  transactionIds: string[];
  labels: string[];
  labelValues: string[];
  listingIds: string[];
  returnIds: string[];
  trackingNumbers: string[];
  titlePhrases: string[];
  buyerUsernames: string[];
  buyerEmails: string[];
};

type LinkCandidate = {
  message_id: string;
  link_type: "ebay_order" | "ebay_order_line" | "inventory_item" | "sale" | "customer_identity";
  ebay_order_id?: string | null;
  ebay_order_line_id?: string | null;
  item_id?: string | null;
  sale_id?: string | null;
  matched_value: string;
  match_method: string;
  confidence: number;
  status: "suggested" | "confirmed";
  metadata: Record<string, unknown>;
};

export class DeterministicMatcherError extends Error {
  code: string;
  status: number;
  phase: string;
  messageId?: string;

  constructor(
    code: string,
    options: { status?: number; phase?: string; messageId?: string } = {},
  ) {
    super(code);
    this.name = "DeterministicMatcherError";
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "matching";
    this.messageId = options.messageId;
  }
}

function lowerTrim(value?: string | null) {
  return String(value || "").trim().toLowerCase();
}

function unique(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function uniqueLower(values: Array<string | null | undefined>) {
  return unique(values.map((value) => lowerTrim(value))).filter(Boolean);
}

export function deterministicIdentifiersSummary(identifiers: DeterministicIdentifiers) {
  return {
    order_numbers: identifiers.orderNumbers.length,
    item_numbers: identifiers.itemNumbers.length,
    transaction_ids: identifiers.transactionIds.length,
    listing_labels: identifiers.labels.length,
    listing_ids: identifiers.listingIds.length,
    return_ids: identifiers.returnIds.length,
    tracking_numbers: identifiers.trackingNumbers.length,
    title_phrases: identifiers.titlePhrases.length,
    buyer_usernames: identifiers.buyerUsernames.length,
    buyer_emails: identifiers.buyerEmails.length,
  };
}

async function loadMessageContext(supabase: DeterministicMatcherClient, messageId: string) {
  const { data: message, error: messageError } = await supabase
    .from("email_messages")
    .select("id, subject, body_preview, from_email, from_name, sender_email, sender_name, received_at, sync_status")
    .eq("id", messageId)
    .maybeSingle();

  if (messageError) throw new DeterministicMatcherError("matching_failed", { phase: "message_lookup", messageId });
  if (!message) throw new DeterministicMatcherError("message_not_found", { status: 404, phase: "message_lookup", messageId });

  const { data: body, error: bodyError } = await supabase
    .from("email_message_bodies")
    .select("body_text, body_html, normalized_text, normalized_text_sha256, normalization_version")
    .eq("message_id", messageId)
    .maybeSingle();

  if (bodyError) throw new DeterministicMatcherError("normalization_failed", { phase: "body_lookup", messageId });

  const { data: recipients, error: recipientsError } = await supabase
    .from("email_message_recipients")
    .select("recipient_type, display_name, email, email_normalized")
    .eq("message_id", messageId);

  if (recipientsError) throw new DeterministicMatcherError("matching_failed", { phase: "recipient_lookup", messageId });

  return {
    message: message as EmailMessage,
    body: body as EmailBody | null,
    recipients: (recipients || []) as EmailRecipient[],
  };
}

function buildSearchText(context: { message: EmailMessage; body: EmailBody | null; recipients: EmailRecipient[] }) {
  const recipientText = context.recipients
    .map((recipient) => [recipient.display_name, recipient.email, recipient.email_normalized].filter(Boolean).join(" "))
    .join(" ");

  return [
    context.message.subject,
    context.message.body_preview,
    context.body?.normalized_text,
    context.message.from_email,
    context.message.from_name,
    context.message.sender_email,
    context.message.sender_name,
    recipientText,
  ].filter(Boolean).join("\n");
}

function extractIdentifiers(context: { message: EmailMessage; body: EmailBody | null; recipients: EmailRecipient[] }) {
  const text = buildSearchText(context);
  const subject = String(context.message.subject || "");
  const participantEmails = [
    context.message.from_email,
    context.message.sender_email,
    ...context.recipients.map((recipient) => recipient.email_normalized || recipient.email),
  ];

  const buyerUsernameFromSubject = subject.match(/^(.+?)\s+sent a message\b/i)?.[1]?.trim();
  const fromNameCandidates = [context.message.from_name, context.message.sender_name]
    .map((value) => String(value || "").trim())
    .filter((value) => value && !value.includes("@") && value.length <= 80);

  const labels = unique(text.match(/#\d+\b/g) || []);
  const customLabelValues = [
    ...Array.from(text.matchAll(/\b(?:custom\s+label|sku|label)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{2,40})\b/gi), (match) => match[1]),
  ];
  const labelValues = unique([...labels.map((label) => label.replace(/^#/, "")), ...customLabelValues]);
  const listingIds = unique([
    ...Array.from(text.matchAll(/\b(?:listing\s+id|listing|offer\s+id|offer)\s*[:#-]?\s*([A-Z0-9][A-Z0-9_-]{5,40})\b/gi), (match) => match[1]),
  ]).filter((value) => /\d/.test(value));
  const trackingNumbers = unique([
    ...Array.from(text.matchAll(/\b(?:tracking\s+number|tracking|shipment\s+tracking|shipping\s+barcode|label\s+id)\s*[:#-]?\s*([A-Z0-9][A-Z0-9 -]{7,34})\b/gi), (match) =>
      String(match[1] || "").replace(/\s+/g, "").trim()
    ),
  ]).filter((value) => /[A-Z]/i.test(value) && /\d/.test(value) && value.length >= 8 && value.length <= 34);
  const titlePhrases = unique([
    ...Array.from(text.matchAll(/\b(?:item|listing|title)\s*(?:title|name)?\s*[:#-]\s*["“]?([^"\n\r.]{8,120})/gi), (match) => match[1]),
    ...Array.from(subject.matchAll(/\b(?:re|about|question\s+about)\s*[:#-]\s*["“]?([^"\n\r]{8,120})/gi), (match) => match[1]),
  ])
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => isSafeTitlePhrase(value))
    .slice(0, 10);
  return {
    orderNumbers: unique(text.match(/\b\d{2}-\d{5}-\d{5}\b/g) || []),
    itemNumbers: unique(text.match(/\b\d{12}\b/g) || []),
    transactionIds: unique(text.match(/\b\d{14}\b/g) || []),
    labels,
    labelValues,
    listingIds,
    returnIds: unique([
      ...Array.from(text.matchAll(/\b(?:return\s+(?:case\s+)?id|ebay\s+return\s+id|return)\s*[:#-]?\s*([A-Z0-9-]{6,40})\b/gi), (match) => match[1]),
    ]).filter((value) => /\d/.test(value)),
    trackingNumbers,
    titlePhrases,
    buyerUsernames: uniqueLower([buyerUsernameFromSubject, ...fromNameCandidates]),
    buyerEmails: uniqueLower([
      ...participantEmails,
      ...(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []),
    ]),
  } satisfies DeterministicIdentifiers;
}

const GENERIC_TITLE_WORDS = new Set(["watch", "ring", "bracelet", "chain", "pendant"]);

function isSafeTitlePhrase(value: string) {
  const cleaned = lowerTrim(value).replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  if (words.length === 1 && GENERIC_TITLE_WORDS.has(words[0])) return false;
  if (words.every((word) => GENERIC_TITLE_WORDS.has(word))) return false;
  return cleaned.length >= 8;
}

function isMaskedBuyerEmail(value: string) {
  const email = lowerTrim(value);
  return !email ||
    email.includes("members.ebay") ||
    email.includes("member.ebay") ||
    email.includes("reply.ebay") ||
    email.includes("ebay.com") ||
    email.includes("no-reply") ||
    email.includes("noreply");
}

async function queryByChunks<T>(
  values: string[],
  load: (chunk: string[]) => Promise<T[]>,
) {
  const rows: T[] = [];
  for (let index = 0; index < values.length; index += 50) {
    rows.push(...await load(values.slice(index, index + 50)));
  }
  return rows;
}

function orderLineSelect() {
  return "id, order_id, item_number, transaction_id, item_title, custom_label, internal_item_id, sale_id, order:ebay_orders(id, order_number, buyer_username, buyer_email, sale_date, paid_on_date)";
}

async function upsertLink(supabase: DeterministicMatcherClient, candidate: LinkCandidate) {
  let lookup = supabase
    .from("email_message_links")
    .select("id, confidence, status, match_method, metadata")
    .eq("message_id", candidate.message_id)
    .eq("link_type", candidate.link_type)
    .in("status", ["suggested", "confirmed"]);

  lookup = candidate.ebay_order_id ? lookup.eq("ebay_order_id", candidate.ebay_order_id) : lookup.is("ebay_order_id", null);
  lookup = candidate.ebay_order_line_id ? lookup.eq("ebay_order_line_id", candidate.ebay_order_line_id) : lookup.is("ebay_order_line_id", null);
  lookup = candidate.item_id ? lookup.eq("item_id", candidate.item_id) : lookup.is("item_id", null);
  lookup = candidate.sale_id ? lookup.eq("sale_id", candidate.sale_id) : lookup.is("sale_id", null);

  const { data: existingRows, error: lookupError } = await lookup.limit(5);

  if (lookupError) {
    throw new DeterministicMatcherError("link_insert_failed", { phase: "link_lookup", messageId: candidate.message_id });
  }

  const rows = Array.isArray(existingRows) ? existingRows : [];
  const existing = rows.find((row) => row.status === candidate.status) ||
    rows.find((row) => row.status === "suggested") ||
    rows[0] ||
    null;
  if (existing?.id) {
    const existingConfidence = Number(existing.confidence || 0);
    const metadataChanged = JSON.stringify(existing.metadata || {}) !== JSON.stringify(candidate.metadata || {});
    const shouldImprove = Number(candidate.confidence) > existingConfidence ||
      (existing.status === "suggested" && candidate.status === "confirmed") ||
      (Number(candidate.confidence) >= existingConfidence && metadataChanged);
    if (!shouldImprove) return { created: 0, updated: 0 };

    const { error } = await supabase
      .from("email_message_links")
      .update({
        confidence: candidate.confidence,
        status: candidate.status,
        match_method: candidate.match_method,
        matched_value: candidate.matched_value,
        metadata: candidate.metadata,
      })
      .eq("id", existing.id);

    if (error) throw new DeterministicMatcherError("link_insert_failed", { phase: "link_update", messageId: candidate.message_id });
    return { created: 0, updated: 1 };
  }

  const { error } = await supabase.from("email_message_links").insert(candidate);
  if (error) throw new DeterministicMatcherError("link_insert_failed", { phase: "link_insert", messageId: candidate.message_id });
  return { created: 1, updated: 0 };
}

function compactObject(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => {
    if (entry === null || entry === undefined) return false;
    if (Array.isArray(entry) && entry.length === 0) return false;
    if (typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry as Record<string, unknown>).length === 0) return false;
    return true;
  }));
}

function daysSince(iso?: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

async function loadSyncFreshness(supabase: DeterministicMatcherClient, identifiers: DeterministicIdentifiers) {
  const buyerSyncs: Array<Record<string, unknown>> = [];
  for (const username of identifiers.buyerUsernames.slice(0, 10)) {
    const { data, error } = await supabase
      .from("ebay_buyer_history_syncs")
      .select("buyer_username, status, last_success_at, last_started_at, updated_at, days_back, scanned_orders, matched_orders")
      .ilike("buyer_username", username)
      .limit(1);
    if (error) throw new DeterministicMatcherError("matching_failed", { phase: "buyer_history_freshness_lookup" });
    for (const row of data || []) {
      const ageDays = daysSince(row.last_success_at || row.updated_at);
      buyerSyncs.push(compactObject({
        buyer_username: row.buyer_username,
        status: row.status,
        last_success_at: row.last_success_at,
        age_days: ageDays,
        days_back: row.days_back,
        scanned_orders: row.scanned_orders,
        matched_orders: row.matched_orders,
        stale: ageDays === null || ageDays > 14 || row.status !== "completed",
      }));
    }
  }

  const { data: accountRuns, error: accountError } = await supabase
    .from("ebay_account_history_sync_runs")
    .select("id, status, started_at, finished_at, updated_at, days_back, scanned_orders, matched_orders, buyers_seen")
    .order("created_at", { ascending: false })
    .limit(1);
  if (accountError) throw new DeterministicMatcherError("matching_failed", { phase: "account_history_freshness_lookup" });

  const accountRun = accountRuns?.[0] || null;
  const accountAgeDays = daysSince(accountRun?.finished_at || accountRun?.updated_at);
  const buyerUsernamesWithSync = new Set(buyerSyncs.map((row) => lowerTrim(String(row.buyer_username || ""))));
  const missingBuyerHistory = identifiers.buyerUsernames
    .filter((username) => !buyerUsernamesWithSync.has(lowerTrim(username)))
    .slice(0, 10);
  const stale = Boolean(
    missingBuyerHistory.length ||
      buyerSyncs.some((row) => row.stale === true) ||
      !accountRun ||
      accountAgeDays === null ||
      accountAgeDays > 14 ||
      accountRun.status !== "completed",
  );

  return compactObject({
    buyer_history: buyerSyncs,
    missing_buyer_history: missingBuyerHistory,
    account_history: accountRun
      ? compactObject({
        status: accountRun.status,
        finished_at: accountRun.finished_at,
        age_days: accountAgeDays,
        days_back: accountRun.days_back,
        scanned_orders: accountRun.scanned_orders,
        matched_orders: accountRun.matched_orders,
        buyers_seen: accountRun.buyers_seen,
        stale: accountAgeDays === null || accountAgeDays > 14 || accountRun.status !== "completed",
      })
      : { missing: true },
    stale,
  });
}

function linkMetadata(identifiers: DeterministicIdentifiers, matchedBy: string, extra: Record<string, unknown> = {}) {
  return {
    processor_version: PROCESSOR_VERSION,
    matched_by: matchedBy,
    extracted_identifiers: deterministicIdentifiersSummary(identifiers),
    matched_fields: extra.matched_fields || [matchedBy],
    data_sources_checked: extra.data_sources_checked || [],
    ...extra,
  };
}

function returnCaseItemNumbers(row: Record<string, any>) {
  const payload = row.raw_payload || {};
  const details = payload.returnDetails || {};
  return unique([
    payload.itemNumber,
    payload.item_number,
    details.itemNumber,
    details.item_number,
    ...(Array.isArray(payload.items) ? payload.items.map((item: Record<string, any>) => item?.itemNumber || item?.item_number) : []),
  ]);
}

function returnCaseMatchesClues(row: Record<string, any>, identifiers: DeterministicIdentifiers) {
  const rowOrder = String(row.order_number || "");
  const rowBuyer = lowerTrim(row.buyer_username || row.raw_payload?.buyerUsername || row.raw_payload?.buyer_username);
  const rowItems = new Set(returnCaseItemNumbers(row));
  const orderMatched = Boolean(rowOrder && identifiers.orderNumbers.includes(rowOrder));
  const buyerMatched = Boolean(rowBuyer && identifiers.buyerUsernames.includes(rowBuyer));
  const itemMatched = identifiers.itemNumbers.some((itemNumber) => rowItems.has(itemNumber));
  return { orderMatched, buyerMatched, itemMatched };
}

export async function deterministicMatchEmail(supabase: DeterministicMatcherClient, messageId: string) {
  const context = await loadMessageContext(supabase, messageId);
  const identifiers = extractIdentifiers(context);
  const counters = { links_created: 0, links_updated: 0 };
  const candidates: LinkCandidate[] = [];
  const ambiguity: Record<string, unknown> = {};
  const dataSourcesChecked = new Set<string>([
    "ebay_orders",
    "ebay_order_lines",
    "ebay_buyer_history_syncs",
    "ebay_account_history_sync_runs",
  ]);
  const syncFreshness = await loadSyncFreshness(supabase, identifiers);
  const buildMetadata = (matchedBy: string, extra: Record<string, unknown> = {}) => linkMetadata(identifiers, matchedBy, compactObject({
    data_sources_checked: unique([...dataSourcesChecked, ...(Array.isArray(extra.data_sources_checked) ? extra.data_sources_checked as string[] : [])]),
    sync_freshness: syncFreshness,
    stale_context_warning: (syncFreshness as Record<string, unknown>).stale === true,
    ...extra,
  }));

  if (identifiers.orderNumbers.length) {
    const orders = await queryByChunks(identifiers.orderNumbers, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_orders")
        .select("id, order_number")
        .in("order_number", chunk);
      if (error) throw new DeterministicMatcherError("matching_failed", { phase: "order_lookup", messageId });
      return data || [];
    });

    for (const order of orders as Array<{ id: string; order_number: string }>) {
      candidates.push({
        message_id: messageId,
        link_type: "ebay_order",
        ebay_order_id: order.id,
        matched_value: order.order_number,
        match_method: "order_number_exact",
        confidence: 1.0,
        status: "confirmed",
        metadata: buildMetadata("order_number_exact"),
      });
    }
  }

  if (identifiers.returnIds.length) {
    dataSourcesChecked.add("ebay_return_cases");
    const returnCases = await queryByChunks(identifiers.returnIds, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_return_cases")
        .select("id, order_id, order_number, ebay_return_id, buyer_username, status")
        .in("ebay_return_id", chunk);
      if (error) throw new DeterministicMatcherError("matching_failed", { phase: "return_id_lookup", messageId });
      return data || [];
    });

    for (const returnCase of returnCases as Array<Record<string, any>>) {
      if (!returnCase.order_id) {
        ambiguity[`return_id:${returnCase.ebay_return_id || returnCase.id}`] = "return_case_has_no_order_link";
        continue;
      }
      candidates.push({
        message_id: messageId,
        link_type: "ebay_order",
        ebay_order_id: String(returnCase.order_id),
        matched_value: String(returnCase.ebay_return_id || returnCase.id),
        match_method: "return_id_exact",
        confidence: 1.0,
        status: "confirmed",
        metadata: buildMetadata("return_id_exact", {
          return_case_id: returnCase.id,
          return_status: returnCase.status,
        }),
      });
    }
  }

  if (
    !identifiers.returnIds.length &&
    (identifiers.orderNumbers.length || identifiers.buyerUsernames.length) &&
    (identifiers.itemNumbers.length || identifiers.titlePhrases.length)
  ) {
    dataSourcesChecked.add("ebay_return_cases");
    const returnRows = new Map<string, Record<string, any>>();

    if (identifiers.orderNumbers.length) {
      const byOrder = await queryByChunks(identifiers.orderNumbers, async (chunk) => {
        const { data, error } = await supabase
          .from("ebay_return_cases")
          .select("id, order_id, order_number, ebay_return_id, buyer_username, status, opened_at, raw_payload")
          .in("order_number", chunk)
          .not("status", "in", "(closed,cancelled)")
          .order("opened_at", { ascending: false })
          .limit(20);
        if (error) throw new DeterministicMatcherError("matching_failed", { phase: "return_order_context_lookup", messageId });
        return data || [];
      });
      for (const row of byOrder as Array<Record<string, any>>) returnRows.set(String(row.id), row);
    }

    for (const username of identifiers.buyerUsernames.slice(0, 10)) {
      const { data, error } = await supabase
        .from("ebay_return_cases")
        .select("id, order_id, order_number, ebay_return_id, buyer_username, status, opened_at, raw_payload")
        .eq("buyer_username", username)
        .not("status", "in", "(closed,cancelled)")
        .order("opened_at", { ascending: false })
        .limit(20);
      if (error) throw new DeterministicMatcherError("matching_failed", { phase: "return_buyer_context_lookup", messageId });
      for (const row of data || []) returnRows.set(String(row.id), row);
    }

    const correlatedReturns = [...returnRows.values()].filter((row) => {
      const clues = returnCaseMatchesClues(row, identifiers);
      return clues.orderMatched && (clues.buyerMatched || clues.itemMatched);
    });

    if (correlatedReturns.length === 1) {
      const returnCase = correlatedReturns[0];
      if (returnCase.order_id) {
        const clues = returnCaseMatchesClues(returnCase, identifiers);
        const exactOrderLinked = Boolean(clues.orderMatched && returnCase.order_id && (clues.buyerMatched || clues.itemMatched));
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order",
          ebay_order_id: String(returnCase.order_id),
          matched_value: String(returnCase.ebay_return_id || returnCase.order_number || returnCase.id),
          match_method: exactOrderLinked ? "return_context_order_buyer_item" : "return_context_inferred",
          confidence: exactOrderLinked ? 0.92 : 0.62,
          status: exactOrderLinked ? "confirmed" : "suggested",
          metadata: buildMetadata(exactOrderLinked ? "return_context_order_buyer_item" : "return_context_inferred", {
            matched_fields: [
              ...(clues.orderMatched ? ["order_number"] : []),
              ...(clues.buyerMatched ? ["buyer_username"] : []),
              ...(clues.itemMatched ? ["item_number"] : []),
            ],
            return_case_id: returnCase.id,
            return_status: returnCase.status,
            return_context_only: true,
            return_reason_buyer_stated_only: true,
            refund_approval_not_verified: true,
          }),
        });
      } else {
        ambiguity[`return_context:${returnCase.id}`] = "return_case_has_no_order_link";
      }
    } else if (correlatedReturns.length > 1) {
      ambiguity.return_context_inferred = correlatedReturns.length;
    }
  }

  if (identifiers.trackingNumbers.length) {
    dataSourcesChecked.add("ebay_order_label_events");
    for (const trackingNumber of identifiers.trackingNumbers.slice(0, 20)) {
      const orderRows = new Map<string, Record<string, any>>();
      const lookups = await Promise.all([
        supabase
          .from("ebay_orders")
          .select("id, order_number, tracking_number, label_metadata")
          .eq("tracking_number", trackingNumber)
          .limit(5),
        supabase
          .from("ebay_orders")
          .select("id, order_number, tracking_number, label_metadata")
          .contains("label_metadata", { trackingNumber })
          .limit(5),
        supabase
          .from("ebay_orders")
          .select("id, order_number, tracking_number, label_metadata")
          .contains("label_metadata", { shippingBarcodeNumber: trackingNumber })
          .limit(5),
        supabase
          .from("ebay_orders")
          .select("id, order_number, tracking_number, label_metadata")
          .contains("label_metadata", { labelId: trackingNumber })
          .limit(5),
      ]);

      for (const result of lookups) {
        if (result.error) throw new DeterministicMatcherError("matching_failed", { phase: "tracking_lookup", messageId });
        for (const order of result.data || []) orderRows.set(String(order.id), order);
      }

      const labelEventLookups = await Promise.all([
        supabase
          .from("ebay_order_label_events")
          .select("id, order_ids, order_numbers, shipment_id, label_metadata, created_at")
          .contains("label_metadata", { trackingNumber })
          .limit(10),
        supabase
          .from("ebay_order_label_events")
          .select("id, order_ids, order_numbers, shipment_id, label_metadata, created_at")
          .contains("label_metadata", { shippingBarcodeNumber: trackingNumber })
          .limit(10),
        supabase
          .from("ebay_order_label_events")
          .select("id, order_ids, order_numbers, shipment_id, label_metadata, created_at")
          .contains("label_metadata", { labelId: trackingNumber })
          .limit(10),
        supabase
          .from("ebay_order_label_events")
          .select("id, order_ids, order_numbers, shipment_id, label_metadata, created_at")
          .eq("shipment_id", trackingNumber)
          .limit(10),
      ]);

      const labelEvents = new Map<string, Record<string, any>>();
      for (const result of labelEventLookups) {
        if (result.error) throw new DeterministicMatcherError("matching_failed", { phase: "label_event_tracking_lookup", messageId });
        for (const event of result.data || []) labelEvents.set(String(event.id), event);
      }

      const eventOrderNumbers = new Set<string>();
      for (const event of labelEvents.values()) {
        for (const orderId of event.order_ids || []) {
          if (orderId) orderRows.set(String(orderId), { id: String(orderId), label_event_id: event.id });
        }
        for (const orderNumber of event.order_numbers || []) {
          if (orderNumber) eventOrderNumbers.add(String(orderNumber));
        }
      }

      if (eventOrderNumbers.size) {
        const eventOrders = await queryByChunks([...eventOrderNumbers], async (chunk) => {
          const { data, error } = await supabase
            .from("ebay_orders")
            .select("id, order_number")
            .in("order_number", chunk);
          if (error) throw new DeterministicMatcherError("matching_failed", { phase: "label_event_order_lookup", messageId });
          return data || [];
        });
        for (const order of eventOrders as Array<Record<string, any>>) orderRows.set(String(order.id), order);
      }

      const orders = [...orderRows.values()];
      if (orders.length === 1) {
        const order = orders[0];
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order",
          ebay_order_id: String(order.id),
          matched_value: trackingNumber,
          match_method: "tracking_or_label_exact",
          confidence: 0.9,
          status: "confirmed",
          metadata: buildMetadata("tracking_or_label_exact", {
            unique_order: true,
            matched_fields: ["tracking_number"],
            label_event_count: labelEvents.size,
            safe_label_metadata_keys: ["trackingNumber", "shippingBarcodeNumber", "labelId"],
          }),
        });
      } else if (orders.length > 1) {
        ambiguity[`tracking:${trackingNumber}`] = orders.length;
      }
    }
  }

  if (identifiers.itemNumbers.length && identifiers.transactionIds.length) {
    const lines = await queryByChunks(identifiers.itemNumbers, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_order_lines")
        .select(orderLineSelect())
        .in("item_number", chunk)
        .in("transaction_id", identifiers.transactionIds);
      if (error) throw new DeterministicMatcherError("matching_failed", { phase: "item_transaction_lookup", messageId });
      return data || [];
    });

    for (const line of lines as Array<Record<string, any>>) {
      if (!identifiers.itemNumbers.includes(String(line.item_number || ""))) continue;
      if (!identifiers.transactionIds.includes(String(line.transaction_id || ""))) continue;
      candidates.push({
        message_id: messageId,
        link_type: "ebay_order_line",
        ebay_order_line_id: String(line.id),
        ebay_order_id: String(line.order_id || ""),
        item_id: line.internal_item_id || null,
        sale_id: line.sale_id || null,
        matched_value: `${line.item_number}:${line.transaction_id}`,
        match_method: "item_transaction_exact",
        confidence: 1.0,
        status: "confirmed",
        metadata: buildMetadata("item_transaction_exact"),
      });
    }
  }

  if (identifiers.itemNumbers.length) {
    const lines = await queryByChunks(identifiers.itemNumbers, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_order_lines")
        .select(orderLineSelect())
        .in("item_number", chunk);
      if (error) throw new DeterministicMatcherError("matching_failed", { phase: "item_number_lookup", messageId });
      return data || [];
    });

    const byItem = new Map<string, Array<Record<string, any>>>();
    for (const line of lines as Array<Record<string, any>>) {
      const itemNumber = String(line.item_number || "");
      byItem.set(itemNumber, [...(byItem.get(itemNumber) || []), line]);
    }

    for (const [itemNumber, matchedLines] of byItem) {
      const alreadyHasStrong = candidates.some((candidate) =>
        candidate.link_type === "ebay_order_line" &&
        candidate.match_method === "item_transaction_exact" &&
        candidate.matched_value.startsWith(`${itemNumber}:`)
      );
      if (alreadyHasStrong) continue;

      if (matchedLines.length === 1) {
        const line = matchedLines[0];
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order_line",
          ebay_order_line_id: String(line.id),
          ebay_order_id: String(line.order_id || ""),
          item_id: line.internal_item_id || null,
          sale_id: line.sale_id || null,
          matched_value: itemNumber,
          match_method: "item_number_exact",
          confidence: 0.8,
          status: "suggested",
          metadata: buildMetadata("item_number_exact"),
        });
      } else if (matchedLines.length > 1) {
        ambiguity[`item_number:${itemNumber}`] = matchedLines.length;
      }
    }
  }

  if (identifiers.buyerUsernames.length) {
    const orders: Array<Record<string, unknown>> = [];
    for (const username of identifiers.buyerUsernames.slice(0, 10)) {
      const { data, error } = await supabase
        .from("ebay_orders")
        .select("id, order_number, buyer_username, sale_date, paid_on_date")
        .ilike("buyer_username", username);
      if (error) throw new DeterministicMatcherError("matching_failed", { phase: "buyer_username_lookup", messageId });
      orders.push(...(data || []));
    }

    const orderNumberHints = new Set(identifiers.orderNumbers);
    const itemHints = new Set(identifiers.itemNumbers);
    const hasStrongContext = orderNumberHints.size > 0 ||
      itemHints.size > 0 ||
      identifiers.labelValues.length > 0 ||
      identifiers.listingIds.length > 0 ||
      identifiers.trackingNumbers.length > 0 ||
      identifiers.returnIds.length > 0;
    if (hasStrongContext) {
      for (const order of orders as Array<{ id: string; order_number: string; buyer_username: string }>) {
        const alreadyLinked = candidates.some((candidate) => candidate.ebay_order_id === order.id);
        if (alreadyLinked) continue;
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order",
          ebay_order_id: order.id,
          matched_value: order.buyer_username,
          match_method: "buyer_username_plus_strong_clue",
          confidence: 0.65,
          status: "suggested",
          metadata: buildMetadata("buyer_username_plus_strong_clue", { guarded_by_context: true }),
        });
      }
    } else if (orders.length === 1) {
      const order = orders[0] as { id: string; buyer_username: string };
      candidates.push({
        message_id: messageId,
        link_type: "ebay_order",
        ebay_order_id: order.id,
        matched_value: order.buyer_username,
        match_method: "buyer_username_alone_unique",
        confidence: 0.45,
        status: "suggested",
        metadata: buildMetadata("buyer_username_alone_unique", { buyer_username_only: true }),
      });
    } else if (orders.length) {
      ambiguity.buyer_username_context_required = true;
    }
  }

  if (identifiers.buyerEmails.length) {
    const usableEmails = identifiers.buyerEmails.filter((email) => !isMaskedBuyerEmail(email));
    const hasStrongContext = identifiers.orderNumbers.length > 0 ||
      identifiers.itemNumbers.length > 0 ||
      identifiers.labelValues.length > 0 ||
      identifiers.listingIds.length > 0 ||
      identifiers.trackingNumbers.length > 0 ||
      identifiers.returnIds.length > 0;
    if (usableEmails.length && hasStrongContext) {
      const orders = await queryByChunks(usableEmails.slice(0, 10), async (chunk) => {
        const { data, error } = await supabase
          .from("ebay_orders")
          .select("id, order_number, buyer_email, buyer_username")
          .in("buyer_email", chunk);
        if (error) throw new DeterministicMatcherError("matching_failed", { phase: "buyer_email_lookup", messageId });
        return data || [];
      });

      for (const order of orders as Array<Record<string, any>>) {
        const alreadyLinked = candidates.some((candidate) => candidate.ebay_order_id === order.id);
        if (alreadyLinked) continue;
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order",
          ebay_order_id: String(order.id),
          matched_value: String(order.buyer_email || ""),
          match_method: "buyer_email_plus_strong_clue",
          confidence: 0.65,
          status: "suggested",
          metadata: buildMetadata("buyer_email_plus_strong_clue", { masked_email_excluded: true }),
        });
      }
    } else if (identifiers.buyerEmails.some(isMaskedBuyerEmail)) {
      ambiguity.buyer_email_masked_or_unreliable = true;
    }
  }

  const inventoryLookupValues = unique([
    ...identifiers.labels,
    ...identifiers.labelValues,
    ...identifiers.listingIds,
    ...identifiers.itemNumbers,
  ]);
  if (inventoryLookupValues.length) {
    dataSourcesChecked.add("ebay_inventory_links");
    const inventoryLinks = await queryByChunks(inventoryLookupValues, async (chunk) => {
      const [skuResult, listingResult, offerResult] = await Promise.all([
        supabase
          .from("ebay_inventory_links")
          .select("item_type_id, sku, offer_id, listing_id, status, last_synced_at, updated_at")
          .in("sku", chunk),
        supabase
          .from("ebay_inventory_links")
          .select("item_type_id, sku, offer_id, listing_id, status, last_synced_at, updated_at")
          .in("listing_id", chunk),
        supabase
          .from("ebay_inventory_links")
          .select("item_type_id, sku, offer_id, listing_id, status, last_synced_at, updated_at")
          .in("offer_id", chunk),
      ]);
      if (skuResult.error || listingResult.error || offerResult.error) {
        throw new DeterministicMatcherError("matching_failed", { phase: "ebay_inventory_link_lookup", messageId });
      }
      const byItem = new Map<string, Record<string, any>>();
      for (const link of [...(skuResult.data || []), ...(listingResult.data || []), ...(offerResult.data || [])] as Array<Record<string, any>>) {
        byItem.set(String(link.item_type_id), link);
      }
      return [...byItem.values()];
    });

    const byMatchedValue = new Map<string, Array<Record<string, any>>>();
    for (const link of inventoryLinks as Array<Record<string, any>>) {
      const matches = [
        { field: "sku", value: link.sku, confidence: 0.52 },
        { field: "listing_id", value: link.listing_id, confidence: 0.42 },
        { field: "offer_id", value: link.offer_id, confidence: 0.42 },
      ].filter((entry) => entry.value && inventoryLookupValues.includes(String(entry.value)));
      for (const match of matches) {
        const key = `${match.field}:${match.value}`;
        byMatchedValue.set(key, [
          ...(byMatchedValue.get(key) || []),
          { ...link, matched_field: match.field, matched_value: match.value, confidence: match.confidence },
        ]);
      }
    }

    for (const [key, links] of byMatchedValue) {
      if (links.length === 1) {
        const link = links[0];
        candidates.push({
          message_id: messageId,
          link_type: "inventory_item",
          item_id: String(link.item_type_id),
          matched_value: String(link.matched_value || ""),
          match_method: link.matched_field === "sku" ? "ebay_inventory_sku_exact" : "ebay_inventory_listing_bridge_exact",
          confidence: Number(link.confidence || 0.42),
          status: "suggested",
          metadata: buildMetadata(link.matched_field === "sku" ? "ebay_inventory_sku_exact" : "ebay_inventory_listing_bridge_exact", {
            matched_fields: [String(link.matched_field)],
            inventory_context_only: true,
            inventory_availability_not_verified: true,
            listing_id_alone_not_order_verified: link.matched_field !== "sku",
            inventory_link: compactObject({
              last_synced_at: link.last_synced_at,
              updated_at: link.updated_at,
            }),
          }),
        });
      } else if (links.length > 1) {
        ambiguity[`ebay_inventory_link:${key}`] = links.length;
      }
    }
  }

  if (identifiers.labelValues.length) {
    const labelCandidates = unique([...identifiers.labels, ...identifiers.labelValues]);
    const lineMatches = await queryByChunks(labelCandidates, async (chunk) => {
      const { data, error } = await supabase
        .from("ebay_order_lines")
        .select(orderLineSelect())
        .in("custom_label", chunk);
      if (error) throw new DeterministicMatcherError("matching_failed", { phase: "custom_label_lookup", messageId });
      return data || [];
    });

    const byLabel = new Map<string, Array<Record<string, any>>>();
    for (const line of lineMatches as Array<Record<string, any>>) {
      const key = String(line.custom_label || "");
      byLabel.set(key, [...(byLabel.get(key) || []), line]);
    }

    for (const [label, lines] of byLabel) {
      if (lines.length === 1) {
        const line = lines[0];
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order_line",
          ebay_order_line_id: String(line.id),
          ebay_order_id: String(line.order_id || ""),
          item_id: line.internal_item_id || null,
          sale_id: line.sale_id || null,
          matched_value: label,
          match_method: "internal_label_custom_label_exact",
          confidence: 0.78,
          status: "suggested",
          metadata: buildMetadata("internal_label_custom_label_exact"),
        });
      } else if (lines.length > 1) {
        ambiguity[`custom_label:${label}`] = lines.length;
      }
    }

    const itemMatches = await queryByChunks(labelCandidates, async (chunk) => {
      const { data: barcodeData, error: barcodeError } = await supabase
        .from("item_types")
        .select("id, barcode, qr_code, title")
        .in("barcode", chunk);
      if (barcodeError) throw new DeterministicMatcherError("matching_failed", { phase: "inventory_label_lookup", messageId });

      const { data: qrData, error: qrError } = await supabase
        .from("item_types")
        .select("id, barcode, qr_code, title")
        .in("qr_code", chunk);
      if (qrError) throw new DeterministicMatcherError("matching_failed", { phase: "inventory_label_lookup", messageId });

      const byId = new Map<string, Record<string, any>>();
      for (const item of [...(barcodeData || []), ...(qrData || [])] as Array<Record<string, any>>) {
        byId.set(String(item.id), item);
      }
      return [...byId.values()];
    });

    const byItemValue = new Map<string, Array<Record<string, any>>>();
    for (const item of itemMatches as Array<Record<string, any>>) {
      for (const value of [item.barcode, item.qr_code].filter(Boolean)) {
        byItemValue.set(String(value), [...(byItemValue.get(String(value)) || []), item]);
      }
    }

    for (const [label, items] of byItemValue) {
      if (items.length === 1) {
        const item = items[0];
        candidates.push({
          message_id: messageId,
          link_type: "inventory_item",
          item_id: String(item.id),
          matched_value: label,
          match_method: "internal_label_inventory_exact",
          confidence: 0.5,
          status: "suggested",
          metadata: buildMetadata("internal_label_inventory_exact"),
        });
      } else if (items.length > 1) {
        ambiguity[`inventory_label:${label}`] = items.length;
      }
    }

    for (const label of labelCandidates.slice(0, 10)) {
      const [lineTitleResult, itemTitleResult] = await Promise.all([
        supabase
          .from("ebay_order_lines")
          .select(orderLineSelect())
          .ilike("item_title", `%${label}%`)
          .limit(3),
        supabase
          .from("item_types")
          .select("id, title")
          .ilike("title", `%${label}%`)
          .limit(3),
      ]);

      if (lineTitleResult.error) {
        throw new DeterministicMatcherError("matching_failed", { phase: "line_title_label_lookup", messageId });
      }
      if (itemTitleResult.error) {
        throw new DeterministicMatcherError("matching_failed", { phase: "inventory_title_label_lookup", messageId });
      }

      const lineTitleMatches = lineTitleResult.data || [];
      if (lineTitleMatches.length === 1) {
        const line = lineTitleMatches[0] as Record<string, any>;
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order_line",
          ebay_order_line_id: String(line.id),
          ebay_order_id: String(line.order_id || ""),
          item_id: line.internal_item_id || null,
          sale_id: line.sale_id || null,
          matched_value: label,
          match_method: "internal_label_item_title_contains",
          confidence: 0.55,
          status: "suggested",
          metadata: buildMetadata("internal_label_item_title_contains"),
        });
      } else if (lineTitleMatches.length > 1) {
        ambiguity[`item_title_contains:${label}`] = lineTitleMatches.length;
      }

      const itemTitleMatches = itemTitleResult.data || [];
      if (itemTitleMatches.length === 1) {
        const item = itemTitleMatches[0] as Record<string, any>;
        candidates.push({
          message_id: messageId,
          link_type: "inventory_item",
          item_id: String(item.id),
          matched_value: label,
          match_method: "internal_label_inventory_title_contains",
          confidence: 0.5,
          status: "suggested",
          metadata: buildMetadata("internal_label_inventory_title_contains"),
        });
      } else if (itemTitleMatches.length > 1) {
        ambiguity[`inventory_title_contains:${label}`] = itemTitleMatches.length;
      }
    }
  }

  if (identifiers.titlePhrases.length) {
    for (const phrase of identifiers.titlePhrases.slice(0, 10)) {
      const lineTitleResult = await supabase
        .from("ebay_order_lines")
        .select(orderLineSelect())
        .ilike("item_title", `%${phrase}%`)
        .limit(3);
      if (lineTitleResult.error) {
        throw new DeterministicMatcherError("matching_failed", { phase: "line_title_phrase_lookup", messageId });
      }

      const lineTitleMatches = lineTitleResult.data || [];
      if (lineTitleMatches.length === 1) {
        const line = lineTitleMatches[0] as Record<string, any>;
        candidates.push({
          message_id: messageId,
          link_type: "ebay_order_line",
          ebay_order_line_id: String(line.id),
          ebay_order_id: String(line.order_id || ""),
          item_id: line.internal_item_id || null,
          sale_id: line.sale_id || null,
          matched_value: phrase,
          match_method: "item_title_unique_contains",
          confidence: 0.5,
          status: "suggested",
          metadata: buildMetadata("item_title_unique_contains", { title_only: true }),
        });
      } else if (lineTitleMatches.length > 1) {
        ambiguity[`item_title_phrase:${phrase}`] = lineTitleMatches.length;
      }
    }
  }

  const deduped = new Map<string, LinkCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.link_type,
      candidate.ebay_order_id || "",
      candidate.ebay_order_line_id || "",
      candidate.item_id || "",
      candidate.sale_id || "",
      candidate.status,
    ].join(":");
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, candidate);
      continue;
    }
    if (candidate.confidence > existing.confidence) {
      candidate.metadata = {
        ...candidate.metadata,
        supplemental_matches: [
          ...((candidate.metadata.supplemental_matches as unknown[]) || []),
          compactObject({
            match_method: existing.match_method,
            matched_value: existing.matched_value,
            confidence: existing.confidence,
            return_case_id: existing.metadata.return_case_id,
          }),
        ],
      };
      deduped.set(key, candidate);
      continue;
    }
    existing.metadata = {
      ...existing.metadata,
      supplemental_matches: [
        ...((existing.metadata.supplemental_matches as unknown[]) || []),
        compactObject({
          match_method: candidate.match_method,
          matched_value: candidate.matched_value,
          confidence: candidate.confidence,
          return_case_id: candidate.metadata.return_case_id,
        }),
      ],
    };
  }

  for (const candidate of deduped.values()) {
    const result = await upsertLink(supabase, candidate);
    counters.links_created += result.created;
    counters.links_updated += result.updated;
  }

  return {
    skipped: deduped.size === 0,
    identifiers,
    links_created: counters.links_created,
    links_updated: counters.links_updated,
    metadata: {
      processor_version: PROCESSOR_VERSION,
      identifiers_found: deterministicIdentifiersSummary(identifiers),
      links_created: counters.links_created,
      links_updated: counters.links_updated,
      data_sources_checked: [...dataSourcesChecked],
      sync_freshness: syncFreshness,
      stale_context_warning: (syncFreshness as Record<string, unknown>).stale === true,
      ambiguity,
    },
  };
}
