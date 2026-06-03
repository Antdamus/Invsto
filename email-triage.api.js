(function () {
  "use strict";

  const EBAY_CONVERSATION_CONTEXT_FUNCTION = "ebay-conversation-context";
  const EBAY_MESSAGE_SYNC_FUNCTION = "ebay-message-sync";
  const EBAY_CONVERSATION_CLASSIFY_FUNCTION = "ebay-conversation-classify";
  const EBAY_CONVERSATION_DRAFT_FUNCTION = "ebay-conversation-draft";

  const DEFAULT_LIMITS = {
    conversationLimit: 100,
  };

  const TIMEOUTS = {
    operationalDashboard: 30000,
    ebayConversations: 15000,
    ebayConversationMessages: 15000,
    ebayConversationContext: 30000,
    ebayMessageSync: 90000,
    ebayMessageBackfill: 300000,
    ebayConversationClassify: 90000,
    ebayConversationDraft: 60000,
  };

  function waitForSupabaseReady(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (window.supabase?.auth?.getSession) return resolve(window.supabase);

      let done = false;
      const timeout = window.setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error("Supabase not ready. Did initSupabase.js load?"));
      }, timeoutMs);

      document.addEventListener("supabase-ready", () => {
        if (done) return;
        if (!window.supabase?.auth?.getSession) return;
        done = true;
        window.clearTimeout(timeout);
        resolve(window.supabase);
      }, { once: true });
    });
  }

  async function requireAdmin(options = {}) {
    const client = await waitForSupabaseReady();
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) console.error("Email triage session lookup failed:", sessionError);

    const session = sessionData?.session;
    if (!session?.user?.id) {
      window.location.href = "index.html?next=" + encodeURIComponent("email-triage.html");
      return null;
    }

    const { data: employee, error: employeeError } = await client
      .from("employees")
      .select("role, active, display_name")
      .eq("user_id", session.user.id)
      .maybeSingle();

    if (employeeError || !employee || employee.active === false) {
      console.error("Email triage admin guard failed:", employeeError);
      window.location.href = "index.html?next=" + encodeURIComponent("email-triage.html");
      return null;
    }

    const role = String(employee.role || "").toLowerCase();
    if (role !== "admin") {
      window.location.href = "worker-dashboard.html";
      return null;
    }

    if (options.greetingEl) {
      const name = employee.display_name ? `, ${employee.display_name}` : "";
      options.greetingEl.textContent = `eBay Messaging${name}`;
    }

    return { client, session, employee };
  }

  function functionUrl(functionName) {
    const baseUrl = String(window.SUPABASE_URL || "").replace(/\/+$/, "");
    if (!baseUrl) throw new Error("Missing Supabase URL");
    return `${baseUrl}/functions/v1/${functionName}`;
  }

  function normalizeEnvelope(payload, fallbackMode = "") {
    const source = payload && typeof payload === "object" ? payload : {};
    const ok = source.ok !== false;
    const data = source.data && typeof source.data === "object" ? source.data : source;

    return {
      ok,
      mode: source.mode || data.mode || fallbackMode || "",
      request_id: source.request_id || source.requestId || data.request_id || data.requestId || null,
      operation_id: source.operation_id || source.operationId || data.operation_id || data.operationId || null,
      generated_at: source.generated_at || source.generatedAt || data.generated_at || data.generatedAt || new Date().toISOString(),
      data,
      page: source.page && typeof source.page === "object" ? source.page : normalizePage(source),
      counters: source.counters && typeof source.counters === "object" ? source.counters : {},
      safety: normalizeSafety(source.safety || data.safety || source),
      raw: source,
    };
  }

  function normalizePage(source = {}) {
    const pageSource = source.page && typeof source.page === "object" ? source.page : {};
    return {
      page: Number(pageSource.page || source.page_number || 1) || 1,
      pageSize: Number(pageSource.page_size || pageSource.pageSize || source.limit || 0) || null,
      limit: Number(pageSource.limit || source.limit || 0) || null,
      offset: Number(pageSource.offset || 0) || 0,
      cursor: source.cursor || pageSource.cursor || null,
      has_more: Boolean(source.has_more || source.hasMore || pageSource.has_more || pageSource.hasMore),
      has_previous_page: Boolean(pageSource.has_previous_page),
      total_pages: Number(pageSource.total_pages || 1) || 1,
      filtered_rows: Number(pageSource.filtered_rows || 0) || 0,
      visible_rows: Number(pageSource.visible_rows || 0) || 0,
      filters: source.filters || pageSource.filters || {},
      sort: source.sort || pageSource.sort || null,
    };
  }

  function normalizeNumberMap(source = {}) {
    if (!source || typeof source !== "object") return {};
    return Object.entries(source).reduce((map, [key, value]) => {
      map[key] = Number(value || 0);
      return map;
    }, {});
  }

  function normalizeSafety(source = {}) {
    const safety = source && typeof source === "object" ? source : {};
    return {
      blocked: safety.blocked === true,
      warnings: Array.isArray(safety.warnings) ? safety.warnings : [],
      flags: Array.isArray(safety.flags) ? safety.flags : [],
      reason: safety.reason || safety.safety_reason || null,
    };
  }

  function extractOperationId(payload) {
    return normalizeEnvelope(payload).operation_id;
  }

  function toSafeErrorEnvelope(error, fallbackCode = "request_failed") {
    const code = error?.code || error?.message || fallbackCode;
    return {
      ok: false,
      mode: "",
      request_id: null,
      operation_id: null,
      generated_at: new Date().toISOString(),
      data: {},
      page: normalizePage(),
      counters: {},
      safety: normalizeSafety(),
      error: code,
    };
  }

  async function edgeFetch(functionName, session, options = {}) {
    if (!session?.access_token) {
      const error = new Error("unauthorized");
      error.code = "unauthorized";
      throw error;
    }

    const headers = {
      Authorization: `Bearer ${session.access_token}`,
      apikey: window.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    const response = await fetch(functionUrl(functionName), {
      ...options,
      headers,
      credentials: "include",
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const code = payload.error || payload.error_description || payload.detail || `request_failed_${response.status}`;
      const error = new Error(code);
      error.code = code;
      error.detail = payload.message || payload.detail || "";
      error.details = payload.details && typeof payload.details === "object" ? payload.details : {};
      error.providerResponse = error.details.provider_response || payload.provider_response || null;
      error.envelope = toSafeErrorEnvelope(error, code);
      throw error;
    }

    return payload;
  }

  async function edgeFetchWithTimeout(functionName, session, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await edgeFetch(functionName, session, {
        ...options,
        signal: options.signal || controller.signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error("request_timeout");
        timeoutError.code = "request_timeout";
        timeoutError.envelope = toSafeErrorEnvelope(timeoutError, "request_timeout");
        throw timeoutError;
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function currentSession(context, logLabel) {
    const { data: sessionData, error: sessionError } = await context.client.auth.getSession();
    if (sessionError && logLabel) console.error(`${logLabel} session refresh failed:`, sessionError);

    const session = sessionData?.session || context.session;
    if (!session?.access_token) {
      const error = new Error("unauthorized");
      error.code = "unauthorized";
      throw error;
    }
    return session;
  }

  function throwSupabaseReadError(error, fallbackCode) {
    if (!error) return;
    const readError = new Error(error.code || error.message || fallbackCode);
    readError.code = error.code || fallbackCode;
    readError.detail = error.message || "";
    throw readError;
  }

  function startOfLocalDayIso() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date.toISOString();
  }

  async function countSupabaseRows(query, fallbackCode) {
    const { count, error } = await query;
    throwSupabaseReadError(error, fallbackCode);
    return Number(count || 0);
  }

  function latestApprovalByDraft(approvals = []) {
    return approvals.reduce((map, approval) => {
      const draftId = String(approval?.draft_id || "");
      if (!draftId) return map;
      const previous = map.get(draftId);
      if (!previous || String(approval.created_at || "") > String(previous.created_at || "")) {
        map.set(draftId, approval);
      }
      return map;
    }, new Map());
  }

  function normalizeEbayActivityEvent(row = {}) {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const safetyMetadata = metadata.safety && typeof metadata.safety === "object" ? metadata.safety : {};
    const actor = row.actor_email || row.actor_user_id || null;
    return {
      id: row.id || null,
      event_type: row.event_type || "recorded",
      status: row.status || "recorded",
      created_at: row.created_at || null,
      initiated_by: actor,
      actor_user_id: row.actor_user_id || null,
      actor_email: row.actor_email || null,
      conversation_id: row.conversation_id || null,
      target_message_id: row.target_message_id || null,
      draft_id: row.draft_id || null,
      approval_id: row.approval_id || null,
      send_attempt_id: row.send_attempt_id || null,
      classification_id: row.classification_id || null,
      saved_view_id: row.saved_view_id || null,
      sync_run_id: row.sync_run_id || null,
      title: row.title || null,
      reason: row.detail || row.title || null,
      payload: {
        ...metadata,
        conversation_id: row.conversation_id || null,
        target_message_id: row.target_message_id || null,
        draft_id: row.draft_id || null,
        approval_id: row.approval_id || null,
        send_attempt_id: row.send_attempt_id || null,
        classification_id: row.classification_id || null,
        saved_view_id: row.saved_view_id || null,
        sync_run_id: row.sync_run_id || null,
        safety: {
          ...safetyMetadata,
          ebay_mutation_performed: false,
          automatic_responses_sent: Number(safetyMetadata.automatic_responses_sent || 0),
        },
      },
      metadata,
    };
  }

  function ebayDashboardText(value, maxLength = 4000) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim()
      .slice(0, maxLength);
  }

  function ebayDashboardDraftText(draft = {}) {
    return ebayDashboardText(draft.final_text || draft.edited_text || draft.draft_text || "", 4000);
  }

  function mapDashboardRowsById(rows = []) {
    return rows.reduce((map, row) => {
      if (row?.id) map.set(String(row.id), row);
      return map;
    }, new Map());
  }

  function enrichEbayActivityEvent(event = {}, maps = {}) {
    const attempt = event.send_attempt_id ? maps.attemptsById.get(String(event.send_attempt_id)) : null;
    const draftId = event.draft_id || attempt?.draft_id || null;
    const approvalId = event.approval_id || attempt?.approval_id || null;
    const draft = draftId ? maps.draftsById.get(String(draftId)) : null;
    const approval = approvalId ? maps.approvalsById.get(String(approvalId)) : null;
    const sentText = ebayDashboardDraftText(draft || {});
    const providerResponse = attempt?.provider_response && typeof attempt.provider_response === "object" ? attempt.provider_response : {};
    const attemptMetadata = attempt?.metadata && typeof attempt.metadata === "object" ? attempt.metadata : {};
    const approvalMetadata = approval?.metadata && typeof approval.metadata === "object" ? approval.metadata : {};
    const payload = {
      ...event.payload,
      safety: {
        ...(event.payload?.safety && typeof event.payload.safety === "object" ? event.payload.safety : {}),
        ebay_mutation_performed: attempt?.attempt_status === "succeeded",
        automatic_responses_sent: 0,
      },
      draft_id: draftId || event.draft_id || null,
      approval_id: approvalId || event.approval_id || null,
      target_message_id: event.target_message_id || attempt?.target_message_id || approval?.target_message_id || draft?.target_message_id || null,
      send_attempt_id: event.send_attempt_id || attempt?.id || null,
      operator: event.actor_email || event.actor_user_id || approval?.approved_by_email || attempt?.created_by || null,
      sent_text: sentText || null,
      provider_message_id: attempt?.provider_message_id || event.payload?.provider_message_id || null,
      provider_response: Object.keys(providerResponse).length ? providerResponse : null,
      idempotency_key: attempt?.idempotency_key || approval?.idempotency_key || event.payload?.idempotency_key || null,
      send_attempt: attempt ? { ...attempt, provider_response: providerResponse, metadata: attemptMetadata } : null,
      approval: approval ? { ...approval, metadata: approvalMetadata } : null,
      draft: draft ? {
        id: draft.id || null,
        conversation_id: draft.conversation_id || null,
        target_message_id: draft.target_message_id || null,
        draft_status: draft.draft_status || null,
        validation_status: draft.validation_status || null,
        source_mode: draft.source_mode || null,
        model_name: draft.model_name || null,
        prompt_version: draft.prompt_version || null,
        draft_version: draft.draft_version || null,
        operator_notes: draft.operator_notes || null,
        sent_text: sentText || null,
        created_by: draft.created_by || null,
        updated_by: draft.updated_by || null,
        created_at: draft.created_at || null,
        updated_at: draft.updated_at || null,
      } : null,
      raw_payload: {
        activity_metadata: event.metadata || {},
        send_attempt: attempt || null,
        approval: approval || null,
        draft: draft ? { ...draft, sent_text: sentText || null } : null,
      },
    };

    return {
      ...event,
      payload,
      send_attempt: attempt || null,
      approval: approval || null,
      draft: draft || null,
    };
  }

  function buildEbayTimeline(events = []) {
    return events.slice(0, 20).map((event) => ({
      id: event.id,
      event_type: event.event_type,
      title: event.title || event.event_type,
      detail: event.reason || "",
      actor: event.actor_email || event.initiated_by || null,
      created_at: event.created_at,
      conversation_id: event.conversation_id || null,
      draft_id: event.draft_id || null,
      status: event.status || "recorded",
    }));
  }

  async function fetchEbayOperationsDashboard(context) {
    await currentSession(context, "eBay operations dashboard");
    const todayIso = startOfLocalDayIso();
    const client = context.client;

    const [
      conversationsToday,
      unreadConversations,
      classificationsResult,
      draftsResult,
      approvalsResult,
      attemptsResult,
      eventsResult,
      checkpointsResult,
    ] = await Promise.all([
      countSupabaseRows(
        client
          .from("ebay_conversations")
          .select("id", { count: "exact", head: true })
          .gte("first_seen_at", todayIso),
        "ebay_conversations_today_count_failed",
      ),
      countSupabaseRows(
        client
          .from("ebay_conversations")
          .select("id", { count: "exact", head: true })
          .gt("unread_count", 0),
        "ebay_unread_conversation_count_failed",
      ),
      client
        .from("ebay_conversation_classifications")
        .select("id, conversation_id, priority, response_need, topic_tags, buyer_flags, risk_flags, created_at")
        .eq("is_current", true)
        .order("created_at", { ascending: false })
        .limit(1000),
      client
        .from("ebay_conversation_response_drafts")
        .select("id, conversation_id, target_message_id, draft_status, draft_text, edited_text, final_text, source_mode, model_name, prompt_version, validation_status, operator_notes, draft_version, is_current, created_by, updated_by, created_at, updated_at, discarded_at")
        .order("created_at", { ascending: false })
        .limit(1000),
      client
        .from("ebay_message_approvals")
        .select("id, conversation_id, target_message_id, draft_id, approval_status, approved_by, approved_by_email, approved_at, approval_notes, removed_by, removed_by_email, removed_at, removal_notes, previous_approval_id, idempotency_key, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(1000),
      client
        .from("ebay_message_send_attempts")
        .select("id, conversation_id, target_message_id, draft_id, approval_id, approved_by, approved_at, approval_notes, attempt_status, provider, provider_message_id, provider_correlation_id, idempotency_key, attempt_sequence, duplicate_of_attempt_id, error_message, provider_response, metadata, sent_at, created_by, created_at, updated_at")
        .order("created_at", { ascending: false })
        .limit(100),
      client
        .from("ebay_message_activity_events")
        .select("id, event_type, status, actor_user_id, actor_email, conversation_id, target_message_id, draft_id, approval_id, send_attempt_id, classification_id, saved_view_id, sync_run_id, title, detail, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(60),
      client
        .from("ebay_message_sync_checkpoints")
        .select("id, seller_account_id, checkpoint_scope, conversation_type, status, current_run_id, last_run_id, last_full_backfill_at, last_successful_sync_at, last_conversation_timestamp, last_page_processed, next_offset, total_available, pages_processed, conversations_processed, messages_processed, last_error_code, last_error_message, metadata, updated_at, created_at")
        .eq("checkpoint_scope", "commerce_message_archive")
        .order("updated_at", { ascending: false })
        .limit(10),
    ]);

    throwSupabaseReadError(classificationsResult.error, "ebay_classification_dashboard_failed");
    throwSupabaseReadError(draftsResult.error, "ebay_draft_dashboard_failed");
    throwSupabaseReadError(approvalsResult.error, "ebay_approval_dashboard_failed");
    throwSupabaseReadError(attemptsResult.error, "ebay_send_attempt_dashboard_failed");
    throwSupabaseReadError(eventsResult.error, "ebay_activity_dashboard_failed");
    throwSupabaseReadError(checkpointsResult.error, "ebay_backfill_checkpoint_dashboard_failed");

    const classifications = Array.isArray(classificationsResult.data) ? classificationsResult.data : [];
    const drafts = Array.isArray(draftsResult.data) ? draftsResult.data : [];
    const approvals = Array.isArray(approvalsResult.data) ? approvalsResult.data : [];
    const attempts = Array.isArray(attemptsResult.data) ? attemptsResult.data : [];
    const checkpoints = Array.isArray(checkpointsResult.data) ? checkpointsResult.data : [];
    const dashboardMaps = {
      attemptsById: mapDashboardRowsById(attempts),
      draftsById: mapDashboardRowsById(drafts),
      approvalsById: mapDashboardRowsById(approvals),
    };
    const events = (Array.isArray(eventsResult.data) ? eventsResult.data : [])
      .map(normalizeEbayActivityEvent)
      .map((event) => enrichEbayActivityEvent(event, dashboardMaps));
    const latestApproval = latestApprovalByDraft(approvals);
    const currentDrafts = drafts.filter((draft) =>
      draft.is_current === true &&
      !draft.discarded_at &&
      !["discarded", "sent"].includes(String(draft.draft_status || ""))
    );
    const sentDrafts = drafts.filter((draft) => String(draft.draft_status || "") === "sent");
    const approvedDrafts = currentDrafts.filter((draft) => latestApproval.get(String(draft.id || ""))?.approval_status === "approved");
    const awaitingApproval = currentDrafts.filter((draft) => latestApproval.get(String(draft.id || ""))?.approval_status !== "approved");
    const todayDrafts = drafts.filter((draft) => String(draft.created_at || "") >= todayIso);
    const succeededAttempts = attempts.filter((attempt) => attempt.attempt_status === "succeeded");
    const topicIncludes = (row, value) => Array.isArray(row.topic_tags) && row.topic_tags.includes(value);
    const buyerIncludes = (row, value) => Array.isArray(row.buyer_flags) && row.buyer_flags.includes(value);
    const riskIncludes = (row, value) => Array.isArray(row.risk_flags) && row.risk_flags.includes(value);

    return {
      ok: true,
      generated_at: new Date().toISOString(),
      metrics: {
        conversations_today: conversationsToday,
        unread_conversations: unreadConversations,
        needs_reply: classifications.filter((row) => ["reply_today", "reply_later"].includes(row.response_need)).length,
        high_priority: classifications.filter((row) => row.priority === "high").length,
        returns: classifications.filter((row) => topicIncludes(row, "return")).length,
        refund_risk: classifications.filter((row) => riskIncludes(row, "refund_risk") || topicIncludes(row, "refund_request")).length,
        vip_buyers: classifications.filter((row) => buyerIncludes(row, "vip_buyer")).length,
        drafts_generated: todayDrafts.length,
        drafts_awaiting_approval: awaitingApproval.length,
        approved_drafts: approvedDrafts.length,
        sent_drafts: sentDrafts.length,
        send_attempts_created: attempts.length,
        send_attempts_failed: attempts.filter((attempt) => attempt.attempt_status === "failed").length,
        send_attempts_succeeded: succeededAttempts.length,
        duplicate_sends_prevented: attempts.filter((attempt) => attempt.attempt_status === "duplicate").length,
        backfill_pages: checkpoints.reduce((total, row) => total + Number(row.pages_processed || 0), 0),
        backfill_conversations: checkpoints.reduce((total, row) => total + Number(row.conversations_processed || 0), 0),
        backfill_messages: checkpoints.reduce((total, row) => total + Number(row.messages_processed || 0), 0),
      },
      backfill: {
        checkpoints,
        active: checkpoints.filter((row) => row.status === "running"),
        latest_completed: checkpoints.find((row) => row.status === "succeeded") || null,
        latest_failed: checkpoints.find((row) => row.status === "failed") || null,
      },
      approval_queue: {
        current_drafts: currentDrafts.length,
        awaiting_approval: awaitingApproval.length,
        approved_ready: approvedDrafts.length,
        approval_events: approvals.length,
      },
      send_safety: {
        sends_enabled: true,
        controlled_human_send_only: true,
        ebay_mutation_performed: succeededAttempts.length > 0,
        automatic_responses_sent: 0,
        duplicate_success_guard: "one_success_per_idempotency_key",
      },
      timeline: buildEbayTimeline(events),
      recent_operational_events: events,
      recent_send_attempts: attempts,
    };
  }

  function compactEbayText(value, maxLength = 1000) {
    return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function ebayKey(value) {
    return compactEbayText(value, 240).toLowerCase();
  }

  function uniqueEbayText(values = [], maxItems = 50) {
    const seen = new Set();
    const output = [];
    values.forEach((value) => {
      const text = compactEbayText(value, 500);
      const key = ebayKey(text);
      if (!text || seen.has(key)) return;
      seen.add(key);
      output.push(text);
    });
    return output.slice(0, maxItems);
  }

  function groupEbayRowsBy(rows = [], key) {
    return rows.reduce((groups, row) => {
      const value = row?.[key];
      if (!value) return groups;
      groups.set(value, [...(groups.get(value) || []), row]);
      return groups;
    }, new Map());
  }

  function mapEbayRowsById(rows = []) {
    return rows.reduce((map, row) => {
      if (row?.id) map.set(row.id, row);
      return map;
    }, new Map());
  }

  function ebayMetadataText(link, key) {
    const metadata = link?.metadata && typeof link.metadata === "object" ? link.metadata : {};
    return compactEbayText(metadata[key], 500);
  }

  function pushUniqueEbayValue(target, value, maxItems = 20) {
    const text = compactEbayText(value, 500);
    if (!text) return;
    const exists = target.some((item) => ebayKey(item) === ebayKey(text));
    if (!exists && target.length < maxItems) target.push(text);
  }

  function linkedEbayIds(links = [], field) {
    return uniqueEbayText(links.map((link) => link?.[field]), 500);
  }

  async function fetchEbayRowsByIds(context, table, select, ids, fallbackCode) {
    const uniqueIds = uniqueEbayText(ids, 500);
    if (!uniqueIds.length) return [];
    const { data, error } = await context.client
      .from(table)
      .select(select)
      .in("id", uniqueIds)
      .limit(2000);
    throwSupabaseReadError(error, fallbackCode);
    return data || [];
  }

  async function fetchEbayLinkedContextRows(context, links = []) {
    const directOrderIds = linkedEbayIds(links, "ebay_order_id");
    const orderLineIds = linkedEbayIds(links, "ebay_order_line_id");
    const returnCaseIds = linkedEbayIds(links, "ebay_return_case_id");

    const [orderLines, returnCases] = await Promise.all([
      fetchEbayRowsByIds(
        context,
        "ebay_order_lines",
        "id, order_id, item_number, transaction_id, custom_label, item_title",
        orderLineIds,
        "ebay_conversation_order_line_summary_failed",
      ),
      fetchEbayRowsByIds(
        context,
        "ebay_return_cases",
        "id, ebay_return_id, order_id, order_number, buyer_username, status",
        returnCaseIds,
        "ebay_conversation_return_summary_failed",
      ),
    ]);

    const orderIds = uniqueEbayText([
      ...directOrderIds,
      ...orderLines.map((line) => line.order_id),
      ...returnCases.map((returnCase) => returnCase.order_id),
    ], 500);
    const orders = await fetchEbayRowsByIds(
      context,
      "ebay_orders",
      "id, order_number, buyer_username, buyer_name, buyer_email, status",
      orderIds,
      "ebay_conversation_order_summary_failed",
    );

    return {
      ordersById: mapEbayRowsById(orders),
      orderLinesById: mapEbayRowsById(orderLines),
      returnsById: mapEbayRowsById(returnCases),
    };
  }

  function addEbayBuyerCandidate(summary, username, source, rank, confidence = "derived", extra = {}) {
    const text = compactEbayText(username, 120);
    const key = ebayKey(text);
    if (!text || !key || summary.seller_username_keys.includes(key)) return;
    summary.buyer_candidates.push({
      username: text,
      source,
      rank,
      confidence,
      name: compactEbayText(extra.name, 160),
      email: compactEbayText(extra.email, 180),
    });
  }

  function chooseEbayBuyerIdentity(summary, conversation) {
    const sorted = [...summary.buyer_candidates].sort((left, right) => right.rank - left.rank);
    if (sorted.length) {
      const selected = sorted[0];
      return {
        username: selected.username,
        display_name: selected.username,
        source: selected.source,
        confidence: selected.confidence,
        name: selected.name || "",
        email: selected.email || "",
      };
    }
    if (conversation?.conversation_type === "FROM_EBAY") {
      return {
        username: "eBay",
        display_name: "eBay",
        source: "platform",
        confidence: "platform",
        name: "",
        email: "",
      };
    }
    return {
      username: "",
      display_name: "Unknown buyer",
      source: "none",
      confidence: "none",
      name: "",
      email: "",
    };
  }

  function appendEbaySearchParts(summary, parts = []) {
    parts.forEach((part) => {
      if (part === null || part === undefined || part === "") return;
      const text = typeof part === "object" ? JSON.stringify(part) : compactEbayText(part, 5000);
      if (text && text !== "{}" && text !== "[]") summary.search_parts.push(text);
    });
  }

  function normalizeEbayConversationRow(row = {}, summary = {}, classification = null) {
    return {
      id: row.id || null,
      seller_account_id: row.seller_account_id || null,
      ebay_conversation_id: row.ebay_conversation_id || "",
      conversation_type: row.conversation_type || "",
      conversation_status: row.conversation_status || "",
      conversation_title: row.conversation_title || "",
      other_party_username: row.other_party_username || "",
      buyer_identity: summary.buyer_identity || {
        username: row.other_party_username || "",
        display_name: row.other_party_username || (row.conversation_type === "FROM_EBAY" ? "eBay" : "Unknown buyer"),
        source: row.other_party_username ? "other_party" : "none",
        confidence: row.other_party_username ? "api" : "none",
        name: "",
        email: "",
      },
      reference_id: row.reference_id || "",
      reference_type: row.reference_type || "",
      unread_count: Number(row.unread_count || 0),
      latest_message_id: row.latest_message_id || "",
      latest_message_created_at: row.latest_message_created_at || row.last_message_created_at || null,
      latest_message_preview: row.latest_message_preview || summary.latest_message_preview || "",
      first_message_created_at: row.first_message_created_at || null,
      last_message_created_at: row.last_message_created_at || row.latest_message_created_at || null,
      message_count: Number(row.message_count || 0),
      last_synced_at: row.last_synced_at || null,
      last_detail_synced_at: row.last_detail_synced_at || null,
      updated_at: row.updated_at || null,
      created_at: row.created_at || null,
      summary,
      classification,
      raw: row,
    };
  }

  function buildEbayConversationSummaries(conversations = [], links = [], messages = [], sellerAccounts = [], linkedRows = {}) {
    const summaries = new Map();
    const sellerById = mapEbayRowsById(sellerAccounts);
    const linksByConversation = groupEbayRowsBy(links, "conversation_id");
    const messagesByConversation = groupEbayRowsBy(messages, "conversation_id");
    const ordersById = linkedRows.ordersById || new Map();
    const orderLinesById = linkedRows.orderLinesById || new Map();
    const returnsById = linkedRows.returnsById || new Map();

    conversations.forEach((conversation) => {
      const seller = sellerById.get(conversation.seller_account_id) || {};
      const sellerUsername = compactEbayText(seller.seller_username, 120);
      summaries.set(conversation.id, {
        link_count: 0,
        confirmed_link_count: 0,
        suggested_link_count: 0,
        has_order_link: false,
        has_return_link: false,
        has_inventory_link: false,
        has_listing_reference: false,
        has_buyer_link: false,
        has_media: false,
        media_count: 0,
        needs_context_review: false,
        warnings: [],
        link_types: [],
        buyer_candidates: [],
        buyer_identity: null,
        seller_username: sellerUsername,
        seller_username_keys: uniqueEbayText([sellerUsername], 10).map(ebayKey),
        buyer_usernames: [],
        participant_usernames: [],
        order_numbers: [],
        return_ids: [],
        item_titles: [],
        item_numbers: [],
        listing_ids: [],
        latest_message_preview: "",
        search_parts: [],
        search_text: "",
      });
    });

    links.forEach((link) => {
      const summary = summaries.get(link.conversation_id);
      if (!summary) return;
      const type = String(link.link_type || "");
      summary.link_count += 1;
      if (link.status === "confirmed") summary.confirmed_link_count += 1;
      if (link.status === "suggested") summary.suggested_link_count += 1;
      if (!summary.link_types.includes(type)) summary.link_types.push(type);
      if (type === "ebay_order" || type === "ebay_order_line") summary.has_order_link = true;
      if (type === "ebay_return_case") summary.has_return_link = true;
      if (type === "inventory_listing") summary.has_inventory_link = true;
      if (type === "listing_reference") summary.has_listing_reference = true;
      if (type === "buyer_username") summary.has_buyer_link = true;
    });

    conversations.forEach((conversation) => {
      const summary = summaries.get(conversation.id);
      if (!summary) return;
      const conversationLinks = linksByConversation.get(conversation.id) || [];
      const conversationMessages = messagesByConversation.get(conversation.id) || [];
      const otherParty = compactEbayText(conversation.other_party_username, 120);
      const otherPartyKey = ebayKey(otherParty);

      appendEbaySearchParts(summary, [
        conversation.ebay_conversation_id,
        conversation.conversation_type,
        conversation.conversation_status,
        conversation.conversation_title,
        conversation.other_party_username,
        conversation.reference_id,
        conversation.reference_type,
        conversation.latest_message_preview,
        summary.seller_username,
      ]);

      if (otherParty && !summary.seller_username_keys.includes(otherPartyKey)) {
        addEbayBuyerCandidate(summary, otherParty, "other_party", 60, "api");
      }
      pushUniqueEbayValue(summary.listing_ids, conversation.reference_id);

      conversationLinks.forEach((link) => {
        const order = ordersById.get(link.ebay_order_id);
        const line = orderLinesById.get(link.ebay_order_line_id);
        const lineOrder = line?.order_id ? ordersById.get(line.order_id) : null;
        const returnCase = returnsById.get(link.ebay_return_case_id);
        const metadata = link.metadata && typeof link.metadata === "object" ? link.metadata : {};

        addEbayBuyerCandidate(summary, link.buyer_username, "conversation_link", 80, link.status || "linked");
        addEbayBuyerCandidate(summary, order?.buyer_username, "order", 100, "linked", {
          name: order?.buyer_name,
          email: order?.buyer_email,
        });
        addEbayBuyerCandidate(summary, lineOrder?.buyer_username, "order_line", 95, "linked", {
          name: lineOrder?.buyer_name,
          email: lineOrder?.buyer_email,
        });
        addEbayBuyerCandidate(summary, returnCase?.buyer_username, "return_case", 90, "linked");

        pushUniqueEbayValue(summary.order_numbers, order?.order_number);
        pushUniqueEbayValue(summary.order_numbers, lineOrder?.order_number);
        pushUniqueEbayValue(summary.order_numbers, returnCase?.order_number);
        pushUniqueEbayValue(summary.order_numbers, ebayMetadataText(link, "order_number"));
        pushUniqueEbayValue(summary.return_ids, returnCase?.ebay_return_id);
        pushUniqueEbayValue(summary.return_ids, ebayMetadataText(link, "ebay_return_id"));
        pushUniqueEbayValue(summary.item_titles, line?.item_title);
        pushUniqueEbayValue(summary.item_numbers, line?.item_number);
        pushUniqueEbayValue(summary.item_numbers, ebayMetadataText(link, "item_number"));
        pushUniqueEbayValue(summary.listing_ids, link.reference_id);
        pushUniqueEbayValue(summary.listing_ids, ebayMetadataText(link, "listing_id"));
        pushUniqueEbayValue(summary.listing_ids, ebayMetadataText(link, "item_number"));

        appendEbaySearchParts(summary, [
          link.link_type,
          link.link_key,
          link.reference_id,
          link.reference_type,
          link.buyer_username,
          link.matched_value,
          metadata,
          order,
          line,
          lineOrder,
          returnCase,
        ]);
      });

      conversationMessages.forEach((message) => {
        const sender = compactEbayText(message.sender_username, 120);
        const recipient = compactEbayText(message.recipient_username, 120);
        const direction = String(message.direction || "").toLowerCase();
        const bodyPreview = compactEbayText(message.message_body_preview || message.message_body, 500);
        if (!summary.latest_message_preview && bodyPreview) summary.latest_message_preview = bodyPreview;

        [sender, recipient].forEach((username) => {
          const key = ebayKey(username);
          if (username && !summary.seller_username_keys.includes(key)) pushUniqueEbayValue(summary.participant_usernames, username);
        });

        if (direction === "inbound") addEbayBuyerCandidate(summary, sender, "message_inbound_sender", 40, "inferred");
        if (direction === "outbound") addEbayBuyerCandidate(summary, recipient, "message_outbound_recipient", 40, "inferred");

        if (message.has_media) {
          summary.has_media = true;
          summary.media_count += Number(message.media_count || 1);
        }

        appendEbaySearchParts(summary, [
          message.ebay_message_id,
          message.sender_username,
          message.recipient_username,
          message.subject,
          message.message_body_preview,
          message.message_body,
        ]);
      });

      if (!summary.buyer_candidates.length && summary.seller_username_keys.length && summary.participant_usernames.length === 1) {
        addEbayBuyerCandidate(summary, summary.participant_usernames[0], "message_participant", 30, "inferred");
      }

      summary.buyer_identity = chooseEbayBuyerIdentity(summary, conversation);
      pushUniqueEbayValue(summary.buyer_usernames, summary.buyer_identity.username);
      summary.buyer_candidates.forEach((candidate) => pushUniqueEbayValue(summary.buyer_usernames, candidate.username));
      appendEbaySearchParts(summary, [
        summary.buyer_identity.username,
        summary.buyer_identity.name,
        summary.buyer_identity.email,
        summary.buyer_usernames,
        summary.participant_usernames,
        summary.order_numbers,
        summary.return_ids,
        summary.item_titles,
        summary.item_numbers,
        summary.listing_ids,
      ]);
    });

    summaries.forEach((summary) => {
      summary.needs_context_review = summary.link_count === 0 || summary.suggested_link_count > 0;
      if (summary.link_count === 0) summary.warnings.push("No active context links");
      if (summary.suggested_link_count > 0) summary.warnings.push("Suggested links need review");
      summary.search_text = summary.search_parts
        .map((part) => typeof part === "string" ? part : JSON.stringify(part || {}))
        .join("\n")
        .toLowerCase();
      delete summary.search_parts;
      delete summary.buyer_candidates;
      delete summary.seller_username_keys;
    });

    return summaries;
  }

  async function fetchEbayConversations(context, values = {}) {
    await currentSession(context, "eBay conversations");
    const limit = Math.min(Math.max(Number(values.limit || 100), 1), 250);
    const { data: conversations, error } = await context.client
      .from("ebay_conversations")
      .select("id, seller_account_id, ebay_conversation_id, conversation_type, conversation_status, conversation_title, other_party_username, reference_id, reference_type, unread_count, latest_message_id, latest_message_created_at, latest_message_preview, first_message_created_at, last_message_created_at, message_count, last_synced_at, last_detail_synced_at, updated_at, created_at")
      .order("latest_message_created_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .limit(limit);
    throwSupabaseReadError(error, "ebay_conversation_list_failed");

    const ids = (conversations || []).map((conversation) => conversation.id).filter(Boolean);
    const sellerAccountIds = uniqueEbayText((conversations || []).map((conversation) => conversation.seller_account_id), 500);
    const [linksResult, messagesResult, sellersResult, classificationsResult] = ids.length ? await Promise.all([
      context.client
        .from("ebay_conversation_links")
        .select("conversation_id, link_type, link_key, status, confidence, ebay_order_id, ebay_order_line_id, ebay_return_case_id, reference_id, reference_type, buyer_username, matched_value, metadata")
        .in("conversation_id", ids)
        .in("status", ["confirmed", "suggested"])
        .limit(2000),
      context.client
        .from("ebay_conversation_messages")
        .select("conversation_id, ebay_message_id, sender_username, recipient_username, direction, subject, message_body, message_body_preview, has_media, media_count, created_at_ebay, created_at")
        .in("conversation_id", ids)
        .order("created_at_ebay", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(Math.min(limit * 200, 5000)),
      sellerAccountIds.length ? context.client
        .from("ebay_seller_accounts")
        .select("id, seller_username")
        .in("id", sellerAccountIds)
        .limit(500) : Promise.resolve({ data: [], error: null }),
      context.client
        .from("ebay_conversation_classifications")
        .select("id, conversation_id, latest_message_id, latest_ebay_message_id, conversation_source, classification_status, priority, response_need, topic_tags, buyer_flags, risk_flags, confidence, summary, reasoning_summary, recommended_action, input_hash, context_hash, classifier_name, classifier_version, prompt_version, model_name, is_current, superseded_at, review_state, operator_override_payload, operator_notes, reviewed_by, reviewed_at, created_at, updated_at")
        .in("conversation_id", ids)
        .eq("is_current", true)
        .limit(Math.min(limit, 250)),
    ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }];

    throwSupabaseReadError(linksResult.error, "ebay_conversation_link_summary_failed");
    throwSupabaseReadError(messagesResult.error, "ebay_conversation_message_summary_failed");
    throwSupabaseReadError(sellersResult.error, "ebay_conversation_seller_summary_failed");
    throwSupabaseReadError(classificationsResult.error, "ebay_conversation_classification_summary_failed");

    const linkedRows = await fetchEbayLinkedContextRows(context, linksResult.data || []);
    const summaries = buildEbayConversationSummaries(
      conversations || [],
      linksResult.data || [],
      messagesResult.data || [],
      sellersResult.data || [],
      linkedRows,
    );
    const classificationsByConversation = new Map((classificationsResult.data || []).map((classification) => [classification.conversation_id, classification]));
    return {
      ok: true,
      conversations: (conversations || []).map((conversation) => normalizeEbayConversationRow(
        conversation,
        summaries.get(conversation.id) || {},
        classificationsByConversation.get(conversation.id) || null,
      )),
      loaded_at: new Date().toISOString(),
    };
  }

  async function fetchEbayConversationMessages(context, conversationId) {
    await currentSession(context, "eBay conversation messages");
    if (!conversationId) {
      const error = new Error("conversation_id_required");
      error.code = "conversation_id_required";
      throw error;
    }

    const { data, error } = await context.client
      .from("ebay_conversation_messages")
      .select("id, conversation_id, ebay_message_id, sender_username, recipient_username, direction, direction_confidence, subject, message_body, message_body_preview, read_status, is_read, message_status, created_at_ebay, has_media, media_count, message_media, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at_ebay", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(200);
    throwSupabaseReadError(error, "ebay_conversation_messages_failed");

    return {
      ok: true,
      conversation_id: conversationId,
      messages: data || [],
      loaded_at: new Date().toISOString(),
    };
  }

  async function markEbayConversationRead(context, conversationId) {
    await currentSession(context, "Mark eBay conversation read");
    if (!conversationId) {
      const error = new Error("conversation_id_required");
      error.code = "conversation_id_required";
      throw error;
    }

    const { data, error } = await context.client.rpc("mark_ebay_conversation_read", {
      _conversation_id: conversationId,
    });
    throwSupabaseReadError(error, "ebay_conversation_mark_read_failed");
    return data || {
      ok: true,
      conversation_id: conversationId,
      unread_count: 0,
    };
  }

  async function fetchEbayConversationContext(context, conversationId) {
    const session = await currentSession(context, "eBay conversation context");
    return edgeFetchWithTimeout(EBAY_CONVERSATION_CONTEXT_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "context",
        conversationId,
      }),
    }, TIMEOUTS.ebayConversationContext);
  }

  async function fetchEbayConversationDrafts(context, conversationId) {
    const session = await currentSession(context, "eBay conversation drafts");
    return edgeFetchWithTimeout(EBAY_CONVERSATION_DRAFT_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "view",
        conversationId,
      }),
    }, TIMEOUTS.ebayConversationDraft);
  }

  async function requestEbayConversationDraftAction(context, values = {}) {
    const session = await currentSession(context, "eBay conversation draft action");
    return edgeFetchWithTimeout(EBAY_CONVERSATION_DRAFT_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: values.mode,
        conversationId: values.conversationId,
        targetMessageId: values.targetMessageId || undefined,
        draftId: values.draftId || undefined,
        draftText: values.draftText || undefined,
        improvementInstructions: values.improvementInstructions || undefined,
        operatorNotes: values.operatorNotes || undefined,
        approvalNotes: values.approvalNotes || values.operatorNotes || undefined,
        manualComposer: values.manualComposer === true || undefined,
        sendConfirmed: values.sendConfirmed === true || undefined,
      }),
    }, TIMEOUTS.ebayConversationDraft);
  }

  async function runEbayMessageSync(context, values = {}) {
    const session = await currentSession(context, "eBay message sync");
    const body = {
      mode: "sync",
      runType: values.runType || "manual",
      conversationTypes: values.conversationTypes || ["FROM_MEMBERS", "FROM_EBAY"],
      conversationPageLimit: Number(values.conversationPageLimit || 25),
      messagePageLimit: Number(values.messagePageLimit || 25),
      maxConversationPages: Object.prototype.hasOwnProperty.call(values, "maxConversationPages")
        ? values.maxConversationPages
        : Number(values.runType === "backfill" ? 0 : 1),
      maxDetailPagesPerConversation: Number(values.maxDetailPagesPerConversation || 20),
      classificationMode: values.classificationMode || "none",
      resumeFromCheckpoint: values.resumeFromCheckpoint === true || undefined,
      resetCheckpoint: values.resetCheckpoint === true || undefined,
      rateLimitPauseMs: Object.prototype.hasOwnProperty.call(values, "rateLimitPauseMs") ? Number(values.rateLimitPauseMs || 0) : undefined,
      readOnly: true,
    };
    if (body.runType === "backfill" && body.maxConversationPages === 0) delete body.maxConversationPages;
    if (values.conversationId) body.conversationId = values.conversationId;
    if (values.conversationType && !values.conversationTypes) body.conversationTypes = [values.conversationType];
    if (values.startTime) body.startTime = values.startTime;
    if (values.endTime) body.endTime = values.endTime;
    if (values.otherPartyUsername) body.otherPartyUsername = values.otherPartyUsername;
    if (values.referenceId) body.referenceId = values.referenceId;

    const payload = await edgeFetchWithTimeout(EBAY_MESSAGE_SYNC_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify(body),
    }, body.runType === "backfill" ? TIMEOUTS.ebayMessageBackfill : TIMEOUTS.ebayMessageSync);
    return payload;
  }

  async function classifyEbayConversation(context, conversationId, values = {}) {
    const session = await currentSession(context, "eBay conversation classify");
    return edgeFetchWithTimeout(EBAY_CONVERSATION_CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "classify_conversation",
        conversationId,
        force: values.force === true,
      }),
    }, TIMEOUTS.ebayConversationClassify);
  }

  async function classifyRecentEbayConversations(context, values = {}) {
    const session = await currentSession(context, "eBay conversation classify recent");
    return edgeFetchWithTimeout(EBAY_CONVERSATION_CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "classify_recent",
        limit: Number(values.limit || 10),
        force: values.force === true,
      }),
    }, TIMEOUTS.ebayConversationClassify);
  }

  async function saveEbayConversationClassificationOverride(context, values = {}) {
    const session = await currentSession(context, "eBay conversation classification override");
    return edgeFetchWithTimeout(EBAY_CONVERSATION_CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "review_override",
        conversationId: values.conversationId,
        classificationId: values.classificationId,
        reviewState: values.reviewState || "corrected",
        overridePayload: values.overridePayload || {},
        operatorNotes: values.operatorNotes || "",
      }),
    }, TIMEOUTS.ebayConversationClassify);
  }

  function normalizeEbayConversationSavedView(row = {}) {
    const payload = row.filter_payload && typeof row.filter_payload === "object" ? row.filter_payload : {};
    return {
      id: row.id || row.system_key || "",
      name: row.name || "Untitled folder",
      description: row.description || "",
      filter_payload: payload,
      system_key: row.system_key || "",
      is_system_default: row.is_system_default === true,
      is_active: row.is_active !== false,
      sort_order: Number(row.sort_order || 100),
      created_by: row.created_by || null,
      updated_by: row.updated_by || null,
      created_at: row.created_at || null,
      updated_at: row.updated_at || null,
      deleted_at: row.deleted_at || null,
    };
  }

  async function fetchEbayConversationSavedViews(context) {
    await currentSession(context, "eBay conversation saved views");
    const { data, error } = await context.client
      .from("ebay_conversation_saved_views")
      .select("id, name, description, filter_payload, system_key, is_system_default, is_active, sort_order, created_by, updated_by, created_at, updated_at, deleted_at")
      .eq("is_active", true)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });
    throwSupabaseReadError(error, "ebay_conversation_saved_views_failed");

    return {
      ok: true,
      saved_views: (data || []).map(normalizeEbayConversationSavedView),
      loaded_at: new Date().toISOString(),
    };
  }

  async function createEbayConversationSavedView(context, values = {}) {
    const session = await currentSession(context, "Create eBay conversation saved view");
    const name = String(values.name || "").trim();
    if (!name) {
      const error = new Error("saved_view_name_required");
      error.code = "saved_view_name_required";
      throw error;
    }

    const { data, error } = await context.client
      .from("ebay_conversation_saved_views")
      .insert({
        name,
        description: String(values.description || "").trim() || null,
        filter_payload: values.filterPayload || {},
        is_system_default: false,
        is_active: true,
        sort_order: Number(values.sortOrder || 500),
        created_by: session.user?.id || null,
        updated_by: session.user?.id || null,
      })
      .select("id, name, description, filter_payload, system_key, is_system_default, is_active, sort_order, created_by, updated_by, created_at, updated_at, deleted_at")
      .single();
    throwSupabaseReadError(error, "ebay_conversation_saved_view_create_failed");

    return {
      ok: true,
      saved_view: normalizeEbayConversationSavedView(data),
    };
  }

  async function updateEbayConversationSavedView(context, viewId, values = {}) {
    const session = await currentSession(context, "Update eBay conversation saved view");
    if (!viewId) {
      const error = new Error("saved_view_id_required");
      error.code = "saved_view_id_required";
      throw error;
    }

    const updates = {
      updated_by: session.user?.id || null,
    };
    if (Object.prototype.hasOwnProperty.call(values, "name")) updates.name = String(values.name || "").trim();
    if (Object.prototype.hasOwnProperty.call(values, "description")) updates.description = String(values.description || "").trim() || null;
    if (Object.prototype.hasOwnProperty.call(values, "filterPayload")) updates.filter_payload = values.filterPayload || {};

    const { data, error } = await context.client
      .from("ebay_conversation_saved_views")
      .update(updates)
      .eq("id", viewId)
      .select("id, name, description, filter_payload, system_key, is_system_default, is_active, sort_order, created_by, updated_by, created_at, updated_at, deleted_at")
      .single();
    throwSupabaseReadError(error, "ebay_conversation_saved_view_update_failed");

    return {
      ok: true,
      saved_view: normalizeEbayConversationSavedView(data),
    };
  }

  async function deleteEbayConversationSavedView(context, viewId) {
    const session = await currentSession(context, "Delete eBay conversation saved view");
    if (!viewId) {
      const error = new Error("saved_view_id_required");
      error.code = "saved_view_id_required";
      throw error;
    }

    const { data, error } = await context.client
      .from("ebay_conversation_saved_views")
      .update({
        is_active: false,
        deleted_at: new Date().toISOString(),
        updated_by: session.user?.id || null,
      })
      .eq("id", viewId)
      .select("id, name, description, filter_payload, system_key, is_system_default, is_active, sort_order, created_by, updated_by, created_at, updated_at, deleted_at")
      .single();
    throwSupabaseReadError(error, "ebay_conversation_saved_view_delete_failed");

    return {
      ok: true,
      saved_view: normalizeEbayConversationSavedView(data),
    };
  }

  function normalizeOperationalDashboardPayload(payload = {}) {
    const ebay = payload.ebay && typeof payload.ebay === "object" ? payload.ebay : payload;
    return {
      ok: ebay.ok !== false,
      mode: "operational_dashboard",
      generated_at: ebay.generated_at || new Date().toISOString(),
      ebay,
      recent_operational_events: Array.isArray(ebay.recent_operational_events) ? ebay.recent_operational_events : [],
      safety: ebay.send_safety && typeof ebay.send_safety === "object" ? ebay.send_safety : {},
    };
  }

  async function fetchOperationalDashboard(context) {
    const ebay = await fetchEbayOperationsDashboard(context);
    return normalizeOperationalDashboardPayload({ ebay });
  }

  window.EmailTriageApi = {
    functions: {
      EBAY_CONVERSATION_CONTEXT_FUNCTION,
      EBAY_MESSAGE_SYNC_FUNCTION,
      EBAY_CONVERSATION_CLASSIFY_FUNCTION,
      EBAY_CONVERSATION_DRAFT_FUNCTION,
    },
    DEFAULT_LIMITS,
    TIMEOUTS,
    waitForSupabaseReady,
    requireAdmin,
    functionUrl,
    normalizeEnvelope,
    normalizePage,
    normalizeSafety,
    extractOperationId,
    toSafeErrorEnvelope,
    edgeFetch,
    edgeFetchWithTimeout,
    normalizeOperationalDashboardPayload,
    fetchEbayConversations,
    fetchEbayConversationMessages,
    markEbayConversationRead,
    fetchEbayConversationContext,
    fetchEbayConversationDrafts,
    requestEbayConversationDraftAction,
    runEbayMessageSync,
    classifyEbayConversation,
    classifyRecentEbayConversations,
    saveEbayConversationClassificationOverride,
    fetchEbayConversationSavedViews,
    createEbayConversationSavedView,
    updateEbayConversationSavedView,
    deleteEbayConversationSavedView,
    fetchOperationalDashboard,
  };
})();
