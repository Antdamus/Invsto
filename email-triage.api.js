(function () {
  "use strict";

  const EBAY_CONVERSATION_CONTEXT_FUNCTION = "ebay-conversation-context";
  const EBAY_MESSAGE_SYNC_FUNCTION = "ebay-message-sync";
  const EBAY_MESSAGE_READ_SYNC_FUNCTION = "ebay-message-read-sync";
  const EBAY_CONVERSATION_CLASSIFY_FUNCTION = "ebay-conversation-classify";
  const EBAY_CONVERSATION_DRAFT_FUNCTION = "ebay-conversation-draft";
  const EBAY_CANONICAL_MAILBOX_RPC = "get_ebay_canonical_mailbox_v2";
  const EBAY_MAILBOX_RPC_FALLBACK_WARNING = "Degraded mailbox mode: canonical RPC is unavailable. Counts, search, and filters are limited to loaded legacy rows.";

  const DEFAULT_LIMITS = {
    conversationLimit: 100,
  };

  const TIMEOUTS = {
    operationalDashboard: 30000,
    ebayConversations: 15000,
    ebayConversationMessages: 15000,
    ebayConversationContext: 30000,
    ebayMessageSync: 90000,
    ebayMessageReadSync: 30000,
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

  async function optionalCountSupabaseRows(query, warningCode) {
    try {
      return await countSupabaseRows(query, warningCode);
    } catch (error) {
      console.warn(`[email-triage] Optional dashboard count skipped: ${warningCode}`, error);
      return null;
    }
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

  function normalizeEbaySyncRun(row = {}) {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const counters = metadata.counters && typeof metadata.counters === "object" ? metadata.counters : {};
    return {
      id: row.id || null,
      seller_account_id: row.seller_account_id || null,
      run_type: row.run_type || "manual",
      status: row.status || "running",
      conversation_type: row.conversation_type || null,
      started_at: row.started_at || null,
      completed_at: row.completed_at || null,
      last_error_code: row.last_error_code || null,
      last_error_message: row.last_error_message || null,
      metadata,
      payload: {
        ...metadata,
        sync_run_id: row.id || null,
        run_type: row.run_type || "manual",
        status: row.status || "running",
        conversations_seen: Number(row.conversations_seen || 0),
        conversations_inserted: Number(row.conversations_inserted || 0),
        conversations_updated: Number(row.conversations_updated || 0),
        messages_seen: Number(row.messages_seen || 0),
        messages_inserted: Number(row.messages_inserted || 0),
        messages_updated: Number(row.messages_updated || 0),
        messages_rechecked: Number(metadata.messages_rechecked ?? counters.messages_rechecked ?? 0),
        classification_processed: Number(metadata.classificationProcessed ?? metadata.classification_processed ?? 0),
        classification_succeeded: Number(metadata.classificationSucceeded ?? metadata.classification_succeeded ?? 0),
        classification_failed: Number(metadata.classificationFailed ?? metadata.classification_failed ?? 0),
        classification_skipped: Number(metadata.classificationSkipped ?? metadata.classification_skipped ?? 0),
        classified_count: Number(metadata.classified_count ?? metadata.classificationSucceeded ?? metadata.classification_succeeded ?? 0),
        pages_processed: Number(row.pages_fetched || 0),
        detail_pages_processed: Number(row.detail_pages_fetched || 0),
        warnings_count: Array.isArray(row.warnings) ? row.warnings.length : Number(metadata.warnings_count || 0),
        failed_count: Number(row.errors || 0),
        started_at: row.started_at || null,
        completed_at: row.completed_at || null,
        last_error_code: row.last_error_code || null,
        last_error_message: row.last_error_message || null,
      },
    };
  }

  function normalizeEbayClassificationRun(row = {}) {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    const payload = {
      ...metadata,
      run_id: row.id || null,
      runId: row.id || null,
      status: row.status || "pending",
      run_mode: row.run_mode || "",
      force: row.force === true,
      started_at: row.started_at || null,
      completed_at: row.completed_at || null,
      requested_limit: Number(row.requested_limit || 0),
      requested: Number(row.requested_limit || 0),
      target_count: Number(row.target_count || 0),
      processed_count: Number(row.processed_count || 0),
      processed: Number(row.processed_count || 0),
      attempted_count: Number(row.attempted_count || 0),
      attempted: Number(row.attempted_count || 0),
      classified_count: Number(row.classified_count || 0),
      actually_classified: Number(row.classified_count || 0),
      succeeded_count: Number(row.classified_count || 0),
      succeeded: Number(row.classified_count || 0),
      failed_count: Number(row.failed_count || 0),
      failed: Number(row.failed_count || 0),
      skipped_count: Number(row.skipped_count || 0),
      skipped: Number(row.skipped_count || 0),
      remaining_unclassified: row.remaining_unclassified === null || row.remaining_unclassified === undefined ? null : Number(row.remaining_unclassified),
      unclassified_before: row.unclassified_before === null || row.unclassified_before === undefined ? null : Number(row.unclassified_before),
      unclassified_after: row.remaining_unclassified === null || row.remaining_unclassified === undefined ? null : Number(row.remaining_unclassified),
      classification_version: row.classification_version || null,
      prompt_version: row.prompt_version || null,
      model_name: row.model_name || null,
      duration_ms: Number(row.duration_ms || 0),
      conversation_ids: Array.isArray(row.conversation_ids) ? row.conversation_ids : [],
      succeeded_conversation_ids: Array.isArray(row.succeeded_conversation_ids) ? row.succeeded_conversation_ids : [],
      failed_conversation_ids: Array.isArray(row.failed_conversation_ids) ? row.failed_conversation_ids : [],
      skipped_conversation_ids: Array.isArray(row.skipped_conversation_ids) ? row.skipped_conversation_ids : [],
      failures: Array.isArray(row.failures) ? row.failures : [],
      skipped_results: Array.isArray(row.skipped_results) ? row.skipped_results : [],
      queue_source: row.queue_source || null,
      canonical_queue: row.canonical_queue || null,
      safety: {
        ebay_mutation_performed: false,
        automatic_responses_sent: 0,
        classification_triggered: Number(row.attempted_count || 0) > 0,
      },
    };
    return {
      id: row.id || null,
      run_id: row.id || null,
      run_mode: row.run_mode || "",
      status: row.status || "pending",
      started_at: row.started_at || null,
      completed_at: row.completed_at || null,
      requested_limit: Number(row.requested_limit || 0),
      processed_count: Number(row.processed_count || 0),
      classified_count: Number(row.classified_count || 0),
      failed_count: Number(row.failed_count || 0),
      skipped_count: Number(row.skipped_count || 0),
      remaining_unclassified: payload.remaining_unclassified,
      force: row.force === true,
      metadata,
      payload,
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

  function classificationRunIdFromActivityEvent(event = {}) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const run = payload.classification_run && typeof payload.classification_run === "object" ? payload.classification_run : {};
    return payload.run_id || run.run_id || run.id || null;
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
    const classificationRunId = classificationRunIdFromActivityEvent(event);
    const currentClassificationRun = classificationRunId ? maps.classificationRunsById?.get(String(classificationRunId)) : null;
    const currentClassificationRunPayload = currentClassificationRun?.payload && typeof currentClassificationRun.payload === "object"
      ? currentClassificationRun.payload
      : null;
    const shouldEnrichStartedClassificationRun = event.event_type === "conversation_classified"
      && event.payload?.lifecycle_status === "started"
      && currentClassificationRunPayload
      && ["pending", "running"].includes(String(currentClassificationRunPayload.status || ""));
    const classificationRunPayload = shouldEnrichStartedClassificationRun
      ? currentClassificationRunPayload
      : event.payload?.classification_run;
    const payload = {
      ...event.payload,
      ...(shouldEnrichStartedClassificationRun ? currentClassificationRunPayload : {}),
      classification_run: classificationRunPayload,
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
      status: shouldEnrichStartedClassificationRun ? currentClassificationRunPayload.status : event.status,
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

  function checkpointPageLimit(row = {}) {
    const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
    return Math.max(1, Number(metadata.page_limit || 25));
  }

  function checkpointEstimatedPages(row = {}) {
    const total = Number(row.total_available || 0);
    if (!Number.isFinite(total) || total <= 0) return null;
    return Math.ceil(total / checkpointPageLimit(row));
  }

  function normalizedBackfillCheckpointStatus(row = {}) {
    const status = String(row.status || "idle");
    if (status !== "running") return status;
    const updatedAt = Date.parse(row.updated_at || row.created_at || "");
    if (!Number.isFinite(updatedAt)) return status;
    return Date.now() - updatedAt > 8 * 60 * 1000 ? "paused" : status;
  }

  function summarizeBackfillCheckpoints(checkpoints = []) {
    const rows = checkpoints.map((row) => {
      const estimated = checkpointEstimatedPages(row);
      const pages = Number(row.pages_processed || 0);
      const normalizedStatus = normalizedBackfillCheckpointStatus(row);
      return {
        ...row,
        raw_status: row.status || null,
        status: normalizedStatus,
        stale_running: row.status === "running" && normalizedStatus === "paused",
        estimated_total_pages: estimated,
        pages_remaining: estimated === null ? null : Math.max(estimated - pages, 0),
      };
    });
    const hasUnknownEstimate = rows.some((row) => row.estimated_total_pages === null);
    const statuses = rows.map((row) => String(row.status || "idle"));
    const status = statuses.some((value) => value === "running")
      ? "running"
      : statuses.some((value) => value === "failed")
      ? "failed"
      : rows.length && statuses.every((value) => value === "succeeded")
      ? "completed"
      : rows.length
      ? "paused"
      : "not_started";
    return {
      status,
      checkpoints: rows,
      pages_processed: rows.reduce((total, row) => total + Number(row.pages_processed || 0), 0),
      estimated_total_pages: hasUnknownEstimate ? null : rows.reduce((total, row) => total + Number(row.estimated_total_pages || 0), 0),
      pages_remaining: hasUnknownEstimate ? null : rows.reduce((total, row) => total + Number(row.pages_remaining || 0), 0),
      conversations_imported: rows.reduce((total, row) => total + Number(row.conversations_processed || 0), 0),
      messages_imported: rows.reduce((total, row) => total + Number(row.messages_processed || 0), 0),
    };
  }

  async function reconcileEbayClassificationRuns(client) {
    if (!client?.rpc) return;
    const { error } = await client.rpc("reconcile_ebay_conversation_classification_runs", {
      _stale_after_seconds: 90,
    });
    if (error) {
      console.warn("[email-triage] eBay classification run reconciliation skipped:", error.message || error);
    }
  }

  async function fetchEbayOperationsDashboard(context) {
    await currentSession(context, "eBay operations dashboard");
    const todayIso = startOfLocalDayIso();
    const client = context.client;
    await reconcileEbayClassificationRuns(client);

    const [
      canonicalConversations,
      conversationsToday,
      unreadConversations,
      providerUnreadConversations,
      localUnreadConversations,
      pendingProviderReadSync,
      failedProviderReadSync,
      currentClassifications,
      classificationsResult,
      draftsResult,
      approvalsResult,
      attemptsResult,
      eventsResult,
      checkpointsResult,
      syncRunsResult,
      classificationRunsResult,
    ] = await Promise.all([
      countSupabaseRows(
        client
          .from("ebay_conversations")
          .select("id", { count: "exact", head: true }),
        "ebay_canonical_conversation_count_failed",
      ),
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
      optionalCountSupabaseRows(
        client
          .from("ebay_conversations")
          .select("id", { count: "exact", head: true })
          .eq("provider_read_state", "unread"),
        "ebay_provider_unread_conversation_count_failed",
      ),
      optionalCountSupabaseRows(
        client
          .from("ebay_conversations")
          .select("id", { count: "exact", head: true })
          .eq("local_read_state", "unread"),
        "ebay_local_unread_conversation_count_failed",
      ),
      optionalCountSupabaseRows(
        client
          .from("ebay_conversations")
          .select("id", { count: "exact", head: true })
          .eq("pending_provider_update", true),
        "ebay_pending_provider_read_sync_count_failed",
      ),
      optionalCountSupabaseRows(
        client
          .from("ebay_conversations")
          .select("id", { count: "exact", head: true })
          .eq("read_sync_status", "provider_update_failed"),
        "ebay_failed_provider_read_sync_count_failed",
      ),
      countSupabaseRows(
        client
          .from("ebay_conversation_classifications")
          .select("conversation_id", { count: "exact", head: true })
          .eq("is_current", true),
        "ebay_current_classification_count_failed",
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
      client
        .from("ebay_message_sync_runs")
        .select("id, seller_account_id, run_type, status, conversation_type, conversation_page_limit, message_page_limit, max_conversation_pages, max_detail_pages_per_conversation, pages_fetched, detail_pages_fetched, conversations_seen, conversations_inserted, conversations_updated, messages_seen, messages_inserted, messages_updated, media_seen, errors, warnings, last_error_code, last_error_message, metadata, started_at, completed_at")
        .order("started_at", { ascending: false })
        .limit(12),
      client
        .from("ebay_conversation_classification_runs")
        .select("id, run_mode, status, started_by, started_at, completed_at, requested_limit, target_count, processed_count, attempted_count, classified_count, failed_count, skipped_count, remaining_unclassified, unclassified_before, force, queue_source, canonical_queue, classification_version, prompt_version, model_name, duration_ms, conversation_ids, succeeded_conversation_ids, failed_conversation_ids, skipped_conversation_ids, failures, skipped_results, metadata, created_at, updated_at")
        .order("started_at", { ascending: false })
        .limit(12),
    ]);

    throwSupabaseReadError(classificationsResult.error, "ebay_classification_dashboard_failed");
    throwSupabaseReadError(draftsResult.error, "ebay_draft_dashboard_failed");
    throwSupabaseReadError(approvalsResult.error, "ebay_approval_dashboard_failed");
    throwSupabaseReadError(attemptsResult.error, "ebay_send_attempt_dashboard_failed");
    throwSupabaseReadError(eventsResult.error, "ebay_activity_dashboard_failed");
    throwSupabaseReadError(checkpointsResult.error, "ebay_backfill_checkpoint_dashboard_failed");
    throwSupabaseReadError(syncRunsResult.error, "ebay_sync_run_dashboard_failed");
    throwSupabaseReadError(classificationRunsResult.error, "ebay_classification_run_dashboard_failed");

    const classifications = Array.isArray(classificationsResult.data) ? classificationsResult.data : [];
    const drafts = Array.isArray(draftsResult.data) ? draftsResult.data : [];
    const approvals = Array.isArray(approvalsResult.data) ? approvalsResult.data : [];
    const attempts = Array.isArray(attemptsResult.data) ? attemptsResult.data : [];
    const checkpoints = Array.isArray(checkpointsResult.data) ? checkpointsResult.data : [];
    const syncRuns = (Array.isArray(syncRunsResult.data) ? syncRunsResult.data : []).map(normalizeEbaySyncRun);
    const classificationRuns = (Array.isArray(classificationRunsResult.data) ? classificationRunsResult.data : []).map(normalizeEbayClassificationRun);
    const backfillProgress = summarizeBackfillCheckpoints(checkpoints);
    const dashboardMaps = {
      attemptsById: mapDashboardRowsById(attempts),
      draftsById: mapDashboardRowsById(drafts),
      approvalsById: mapDashboardRowsById(approvals),
      classificationRunsById: mapDashboardRowsById(classificationRuns),
    };
    const events = (Array.isArray(eventsResult.data) ? eventsResult.data : [])
      .map(normalizeEbayActivityEvent)
      .map((event) => enrichEbayActivityEvent(event, dashboardMaps));
    const latestSyncEvent = events.find((event) => event.event_type === "message_sync_completed" || event.event_type === "message_sync_failed") || null;
    const latestSyncPayload = latestSyncEvent?.payload?.sync_run && typeof latestSyncEvent.payload.sync_run === "object"
      ? latestSyncEvent.payload.sync_run
      : latestSyncEvent?.payload || {};
    const latestSyncRun = syncRuns.find((run) => String(run.run_type || "") !== "backfill") || null;
    const latestSyncMetricPayload = Object.keys(latestSyncPayload).length ? latestSyncPayload : latestSyncRun?.payload || {};
    const latestClassificationRun = classificationRuns[0] || null;
    const latestMessageRechecked = Number(
      latestSyncMetricPayload.messages_rechecked ??
      Math.max(Number(latestSyncMetricPayload.messages_seen || 0) - Number(latestSyncMetricPayload.messages_inserted || 0), 0)
    );
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
        canonical_conversations: canonicalConversations,
        conversations_today: conversationsToday,
        unread_conversations: unreadConversations,
        provider_unread_conversations: providerUnreadConversations,
        local_unread_conversations: localUnreadConversations,
        pending_provider_read_sync: pendingProviderReadSync,
        failed_provider_read_sync: failedProviderReadSync,
        read_state_schema_available: [
          providerUnreadConversations,
          localUnreadConversations,
          pendingProviderReadSync,
          failedProviderReadSync,
        ].every((value) => value !== null && value !== undefined),
        unclassified_conversations: Math.max(Number(canonicalConversations || 0) - Number(currentClassifications || 0), 0),
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
        backfill_pages: backfillProgress.pages_processed,
        backfill_pages_total_estimate: backfillProgress.estimated_total_pages,
        backfill_pages_remaining: backfillProgress.pages_remaining,
        backfill_conversations: backfillProgress.conversations_imported,
        backfill_messages: backfillProgress.messages_imported,
        latest_sync_conversations_seen: Number(latestSyncMetricPayload.conversations_seen || latestSyncMetricPayload.processed_count || 0),
        latest_sync_conversations_inserted: Number(latestSyncMetricPayload.conversations_inserted || 0),
        latest_sync_conversations_updated: Number(latestSyncMetricPayload.conversations_updated || 0),
        latest_sync_conversations_unchanged: Number(latestSyncMetricPayload.conversations_unchanged || 0),
        latest_sync_messages_scanned: Number(latestSyncMetricPayload.messages_seen || latestSyncMetricPayload.messages_processed || 0),
        latest_sync_messages_rechecked: latestMessageRechecked,
        latest_sync_messages_inserted: Number(latestSyncMetricPayload.messages_inserted || 0),
        latest_sync_messages_changed: Number(latestSyncMetricPayload.messages_updated || 0),
        latest_sync_messages_updated: Number(latestSyncMetricPayload.messages_updated || 0),
        latest_sync_provider_read_state_changes: Number(latestSyncMetricPayload.provider_read_state_changes || 0),
        latest_sync_pending_read_sync_conversations: Number(latestSyncMetricPayload.pending_read_sync_conversations || 0),
        latest_sync_canonical_total_after: Number(latestSyncMetricPayload.canonical_total_conversations || canonicalConversations),
        latest_classification_processed: Number(latestClassificationRun?.processed_count || 0),
        latest_classification_classified: Number(latestClassificationRun?.classified_count || 0),
        latest_classification_failed: Number(latestClassificationRun?.failed_count || 0),
        latest_classification_skipped: Number(latestClassificationRun?.skipped_count || 0),
        latest_classification_remaining_unclassified: latestClassificationRun?.remaining_unclassified ?? Math.max(Number(canonicalConversations || 0) - Number(currentClassifications || 0), 0),
      },
      latest_sync: {
        event: latestSyncEvent,
        run: latestSyncRun,
        active_runs: syncRuns.filter((run) => String(run.run_type || "") !== "backfill" && String(run.status || "") === "running"),
        payload: latestSyncMetricPayload,
      },
      backfill: {
        ...backfillProgress,
        runs: syncRuns.filter((run) => String(run.run_type || "") === "backfill"),
        checkpoints: backfillProgress.checkpoints,
        active: backfillProgress.checkpoints.filter((row) => row.status === "running"),
        paused: backfillProgress.checkpoints.filter((row) => ["paused", "idle"].includes(String(row.status || ""))),
        latest_completed: checkpoints.find((row) => row.status === "succeeded") || null,
        latest_paused: backfillProgress.checkpoints.find((row) => ["paused", "idle"].includes(String(row.status || ""))) || null,
        latest_failed: checkpoints.find((row) => row.status === "failed") || null,
      },
      classification_runs: {
        latest: latestClassificationRun,
        runs: classificationRuns,
        active: classificationRuns.filter((run) => ["pending", "running"].includes(String(run.status || ""))),
        latest_completed: classificationRuns.find((run) => ["succeeded", "partial_success", "failed"].includes(String(run.status || ""))) || null,
      },
      sync_runs: syncRuns,
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
      provider_read_state: row.provider_read_state || "",
      local_read_state: row.local_read_state || "",
      pending_provider_update: row.pending_provider_update === true,
      last_provider_seen_at: row.last_provider_seen_at || null,
      last_local_read_at: row.last_local_read_at || null,
      last_read_sync_at: row.last_read_sync_at || null,
      read_sync_status: row.read_sync_status || "",
      read_sync_error: row.read_sync_error || "",
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

  function clampEbayMailboxNumber(value, fallback, min, max) {
    const number = Number(value);
    const normalized = Number.isFinite(number) ? number : fallback;
    return Math.min(Math.max(normalized, min), max);
  }

  function ebayMailboxObject(value, fallback = {}) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  }

  function ebayMailboxArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function ebayRpcConversationSummary(row = {}) {
    const source = ebayMailboxObject(row.summary);
    const links = ebayMailboxArray(source.links);
    const sourceBuyerUsernames = ebayMailboxArray(source.buyer_usernames);
    const sourceParticipantUsernames = ebayMailboxArray(source.participant_usernames);
    const sourceMessageBuyerUsername = compactEbayText(source.message_buyer_username, 120);
    const summary = {
      ...source,
      seller_username: compactEbayText(source.seller_username || row.seller_username, 120),
      buyer_usernames: uniqueEbayText(sourceBuyerUsernames, 20),
      participant_usernames: uniqueEbayText([row.other_party_username, sourceParticipantUsernames].flat(), 20),
      order_numbers: [],
      return_ids: [],
      item_titles: [],
      item_numbers: [],
      listing_ids: [],
      latest_message_preview: compactEbayText(source.latest_message_preview || row.latest_message_preview, 1000),
      search_text: compactEbayText(source.search_text, 5000),
    };

    links.forEach((link) => {
      pushUniqueEbayValue(summary.buyer_usernames, link.buyer_username);
      pushUniqueEbayValue(summary.buyer_usernames, link.order_buyer_username);
      pushUniqueEbayValue(summary.buyer_usernames, link.return_buyer_username);
      pushUniqueEbayValue(summary.order_numbers, link.order_number);
      pushUniqueEbayValue(summary.return_ids, link.ebay_return_id);
      pushUniqueEbayValue(summary.item_titles, link.item_title);
      pushUniqueEbayValue(summary.item_numbers, link.item_number);
      if (String(link.reference_type || "").toLowerCase().includes("listing")) {
        pushUniqueEbayValue(summary.listing_ids, link.reference_id);
      }
    });

    const buyerUsernameCountBeforeMessageFallback = summary.buyer_usernames.length;
    pushUniqueEbayValue(summary.buyer_usernames, sourceMessageBuyerUsername);
    if (!summary.buyer_usernames.length) pushUniqueEbayValue(summary.buyer_usernames, row.other_party_username);
    if (!summary.buyer_usernames.length && row.conversation_type !== "FROM_EBAY") {
      pushUniqueEbayValue(summary.buyer_usernames, summary.participant_usernames[0]);
    }
    const sourceFromMessage = sourceMessageBuyerUsername &&
      summary.buyer_usernames.some((value) => ebayKey(value) === ebayKey(sourceMessageBuyerUsername)) &&
      buyerUsernameCountBeforeMessageFallback === 0;
    summary.buyer_identity = row.conversation_type === "FROM_EBAY"
      ? {
        username: "eBay",
        display_name: "eBay",
        source: "platform",
        confidence: "platform",
        name: "",
        email: "",
      }
      : {
        username: summary.buyer_usernames[0] || row.other_party_username || "",
        display_name: summary.buyer_usernames[0] || row.other_party_username || "Unknown buyer",
        source: sourceFromMessage ? "message_inbound_sender" : summary.buyer_usernames.length ? "linked_context" : row.other_party_username ? "other_party" : "none",
        confidence: summary.buyer_usernames.length ? "derived" : row.other_party_username ? "api" : "none",
        name: "",
        email: "",
      };

    return summary;
  }

  function normalizeEbayMailboxPayload(payload = {}, source = "rpc", fallbackMeta = {}) {
    const data = ebayMailboxObject(payload);
    const conversations = ebayMailboxArray(data.conversations).map((row) => normalizeEbayConversationRow(
      row,
      ebayRpcConversationSummary(row),
      row.classification && typeof row.classification === "object" ? row.classification : null,
    ));
    const pageSize = clampEbayMailboxNumber(data.page_size || fallbackMeta.pageSize, conversations.length || 100, 1, 250);
    const offset = Math.max(Number(data.offset || fallbackMeta.offset || 0) || 0, 0);
    const canonicalTotal = Number.isFinite(Number(data.canonical_total)) ? Number(data.canonical_total) : conversations.length;
    const matchingTotal = Number.isFinite(Number(data.matching_total)) ? Number(data.matching_total) : canonicalTotal;
    const loadedCount = Number.isFinite(Number(data.loaded_count)) ? Number(data.loaded_count) : conversations.length;
    const nextOffset = data.next_offset === null || data.next_offset === undefined ? null : Number(data.next_offset);
    const hasMore = data.has_more === true || (Number.isFinite(nextOffset) && nextOffset > offset);

    return {
      ok: data.ok !== false,
      mailbox_mode: source,
      rpc_version: data.rpc_version || null,
      canonical_total: canonicalTotal,
      matching_total: matchingTotal,
      loaded_count: loadedCount,
      page_size: pageSize,
      offset,
      next_offset: Number.isFinite(nextOffset) ? nextOffset : null,
      has_more: hasMore,
      system_filter: data.system_filter || fallbackMeta.systemFilter || "all",
      search_terms: ebayMailboxArray(data.search_terms),
      structured_filters: ebayMailboxObject(data.structured_filters),
      classification_filters: ebayMailboxObject(data.classification_filters),
      smart_folder_counts: normalizeNumberMap(data.smart_folder_counts),
      filter_option_counts: ebayMailboxObject(data.filter_option_counts),
      conversations,
      loaded_at: data.loaded_at || new Date().toISOString(),
      warning: data.warning || null,
      raw: data,
    };
  }

  function ebayLegacyConversationSource(conversation = {}) {
    return String(conversation.conversation_type || conversation.raw?.conversation_type || "").toUpperCase() === "FROM_EBAY"
      ? "platform_notification"
      : "member_message";
  }

  function ebayLegacyClassification(conversation = {}) {
    return conversation.classification && typeof conversation.classification === "object" ? conversation.classification : {};
  }

  function ebayLegacySummary(conversation = {}) {
    return conversation.summary && typeof conversation.summary === "object" ? conversation.summary : {};
  }

  function ebayLegacyHasAny(values = [], selected = []) {
    const set = new Set(ebayMailboxArray(values).map((value) => compactEbayText(value)));
    return selected.some((value) => set.has(value));
  }

  function ebayLegacySmartFolderCounts(conversations = []) {
    const rows = ebayMailboxArray(conversations);
    return {
      all: rows.length,
      members: rows.filter((conversation) => ebayLegacyConversationSource(conversation) === "member_message").length,
      ebay_notifications: rows.filter((conversation) => ebayLegacyConversationSource(conversation) === "platform_notification").length,
      unread: rows.filter((conversation) => Number(conversation.unread_count || 0) > 0).length,
      unclassified: rows.filter((conversation) => !ebayLegacyClassification(conversation).id).length,
      returns: rows.filter((conversation) => ebayLegacySummary(conversation).has_return_link === true || ebayLegacyHasAny(ebayLegacyClassification(conversation).topic_tags, ["return"])).length,
      shipping: rows.filter((conversation) => ebayLegacyHasAny(ebayLegacyClassification(conversation).topic_tags, ["shipping_issue", "missing_item", "order_status", "delivery_timing"])).length,
      shipping_issues: rows.filter((conversation) => ebayLegacyHasAny(ebayLegacyClassification(conversation).topic_tags, ["shipping_issue", "missing_item", "order_status", "delivery_timing"])).length,
      needs_reply_today: rows.filter((conversation) => ebayLegacyClassification(conversation).response_need === "reply_today").length,
      vip_buyers: rows.filter((conversation) => ebayLegacyHasAny(ebayLegacyClassification(conversation).buyer_flags, ["vip_buyer"])).length,
      high_value_buyers: rows.filter((conversation) => ebayLegacyHasAny(ebayLegacyClassification(conversation).buyer_flags, ["high_value_buyer", "high_retained_value_buyer"])).length,
      refund_risk: rows.filter((conversation) => ebayLegacyHasAny(ebayLegacyClassification(conversation).risk_flags, ["refund_risk", "chargeback_risk", "unsupported_claim_risk"])).length,
      review_queue: rows.filter((conversation) => {
        const summary = ebayLegacySummary(conversation);
        const classification = ebayLegacyClassification(conversation);
        return !classification.id || summary.needs_context_review === true || ebayLegacyHasAny(classification.risk_flags, ["context_review_needed", "low_confidence"]);
      }).length,
      has_order: rows.filter((conversation) => ebayLegacySummary(conversation).has_order_link === true).length,
      has_return: rows.filter((conversation) => ebayLegacySummary(conversation).has_return_link === true).length,
      has_media: rows.filter((conversation) => ebayLegacySummary(conversation).has_media === true).length,
      needs_context_review: rows.filter((conversation) => ebayLegacySummary(conversation).needs_context_review === true).length,
    };
  }

  function ebayLegacyFilterOptionCounts(conversations = []) {
    const groups = {
      sourceTypes: {},
      topics: {},
      buyerFlags: {},
      riskFlags: {},
      priorities: {},
      responseNeeds: {},
    };
    const increment = (group, value) => {
      const key = compactEbayText(value);
      if (!key) return;
      groups[group][key] = Number(groups[group][key] || 0) + 1;
    };
    ebayMailboxArray(conversations).forEach((conversation) => {
      const classification = ebayLegacyClassification(conversation);
      increment("sourceTypes", ebayLegacyConversationSource(conversation));
      ebayMailboxArray(classification.topic_tags).forEach((value) => increment("topics", value));
      ebayMailboxArray(classification.buyer_flags).forEach((value) => increment("buyerFlags", value));
      ebayMailboxArray(classification.risk_flags).forEach((value) => increment("riskFlags", value));
      increment("priorities", classification.priority);
      increment("responseNeeds", classification.response_need);
    });
    return groups;
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

  async function fetchLegacyEbayConversations(context, values = {}) {
    await currentSession(context, "eBay conversations");
    const limit = clampEbayMailboxNumber(values.limit || values.pageSize, 100, 1, 250);
    const offset = Math.max(Number(values.offset || 0) || 0, 0);
    const { data: conversations, error, count } = await context.client
      .from("ebay_conversations")
      .select("id, seller_account_id, ebay_conversation_id, conversation_type, conversation_status, conversation_title, other_party_username, reference_id, reference_type, unread_count, provider_read_state, local_read_state, pending_provider_update, last_provider_seen_at, last_local_read_at, last_read_sync_at, read_sync_status, read_sync_error, latest_message_id, latest_message_created_at, latest_message_preview, first_message_created_at, last_message_created_at, message_count, last_synced_at, last_detail_synced_at, updated_at, created_at", { count: "exact" })
      .order("latest_message_created_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false })
      .range(offset, offset + limit - 1);
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
    const normalizedConversations = (conversations || []).map((conversation) => normalizeEbayConversationRow(
      conversation,
      summaries.get(conversation.id) || {},
      classificationsByConversation.get(conversation.id) || null,
    ));
    const canonicalTotal = Number.isFinite(Number(count)) ? Number(count || 0) : offset + normalizedConversations.length;
    const hasMore = offset + normalizedConversations.length < canonicalTotal;
    return {
      ok: true,
      mailbox_mode: "legacy",
      canonical_total: canonicalTotal,
      matching_total: canonicalTotal,
      loaded_count: normalizedConversations.length,
      page_size: limit,
      offset,
      next_offset: hasMore ? offset + normalizedConversations.length : null,
      has_more: hasMore,
      system_filter: "all",
      search_terms: [],
      structured_filters: {},
      classification_filters: {},
      smart_folder_counts: ebayLegacySmartFolderCounts(normalizedConversations),
      filter_option_counts: ebayLegacyFilterOptionCounts(normalizedConversations),
      conversations: normalizedConversations,
      loaded_at: new Date().toISOString(),
      warning: values.warning || null,
    };
  }

  async function fetchEbayCanonicalMailboxRpc(context, values = {}) {
    await currentSession(context, "Canonical eBay mailbox RPC");
    const pageSize = clampEbayMailboxNumber(values.limit || values.pageSize, 100, 1, 100);
    const offset = Math.max(Number(values.offset || 0) || 0, 0);
    const systemFilter = compactEbayText(values.systemFilter || values.system_filter || "all", 80) || "all";
    const searchTerms = ebayMailboxArray(values.searchTerms || values.search_terms).map((term) => compactEbayText(term, 240)).filter(Boolean);
    const structuredFilters = ebayMailboxObject(values.structuredFilters || values.structured_filters);
    const classificationFilters = ebayMailboxObject(values.classificationFilters || values.classification_filters);
    const { data, error } = await context.client.rpc(EBAY_CANONICAL_MAILBOX_RPC, {
      _page_size: pageSize,
      _offset: offset,
      _system_filter: systemFilter,
      _search_terms: searchTerms,
      _structured_filters: structuredFilters,
      _classification_filters: classificationFilters,
    });
    throwSupabaseReadError(error, "ebay_canonical_mailbox_rpc_failed");
    return normalizeEbayMailboxPayload(data || {}, "rpc", {
      pageSize,
      offset,
      systemFilter,
    });
  }

  async function fetchEbayConversations(context, values = {}) {
    if (values.useRpc === false) {
      return fetchLegacyEbayConversations(context, values);
    }

    try {
      return await fetchEbayCanonicalMailboxRpc(context, values);
    } catch (error) {
      console.warn("[email-triage] Canonical mailbox RPC failed; falling back to legacy mailbox mode:", error);
      const fallback = await fetchLegacyEbayConversations(context, {
        ...values,
        warning: EBAY_MAILBOX_RPC_FALLBACK_WARNING,
      });
      return {
        ...fallback,
        fallback_from_rpc: true,
        warning: EBAY_MAILBOX_RPC_FALLBACK_WARNING,
        rpc_error: error.code || error.message || "ebay_canonical_mailbox_rpc_failed",
      };
    }
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

  async function syncEbayProviderReadState(context, conversationId, readState = "read", options = {}) {
    const session = await currentSession(context, "Sync eBay provider read state");
    if (!conversationId) {
      const error = new Error("conversation_id_required");
      error.code = "conversation_id_required";
      throw error;
    }
    const normalizedReadState = String(readState || "").trim().toLowerCase() === "unread" ? "unread" : "read";
    return edgeFetchWithTimeout(EBAY_MESSAGE_READ_SYNC_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "set_read_state",
        conversationId,
        readState: normalizedReadState,
        dryRun: options.dryRun === true || undefined,
      }),
    }, TIMEOUTS.ebayMessageReadSync);
  }

  async function processPendingEbayProviderReadState(context, options = {}) {
    const session = await currentSession(context, "Process pending eBay provider read state");
    return edgeFetchWithTimeout(EBAY_MESSAGE_READ_SYNC_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "process_pending_read",
        limit: Math.min(Math.max(Number(options.limit || 10) || 10, 1), 25),
        dryRun: options.dryRun === true || undefined,
      }),
    }, TIMEOUTS.ebayMessageReadSync);
  }

  async function fetchEbayConversationContext(context, conversationId) {
    const session = await currentSession(context, "eBay conversation context");
    return edgeFetchWithTimeout(EBAY_CONVERSATION_CONTEXT_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "link_and_context",
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
    const ebayMessagePageLimit = (value, fallback) => Math.min(Math.max(Number(value || fallback), 1), 50);
    const body = {
      mode: "sync",
      runType: values.runType || "manual",
      conversationTypes: values.conversationTypes || ["FROM_MEMBERS", "FROM_EBAY"],
      conversationPageLimit: ebayMessagePageLimit(values.conversationPageLimit, 25),
      messagePageLimit: ebayMessagePageLimit(values.messagePageLimit, 25),
      maxConversationPages: Object.prototype.hasOwnProperty.call(values, "maxConversationPages")
        ? values.maxConversationPages
        : 1,
      maxDetailPagesPerConversation: Number(values.maxDetailPagesPerConversation || 20),
      classificationMode: values.classificationMode || "none",
      resumeFromCheckpoint: values.resumeFromCheckpoint === true || undefined,
      resetCheckpoint: values.resetCheckpoint === true || undefined,
      checkpointScope: values.checkpointScope || undefined,
      latestSyncLookbackDays: values.latestSyncLookbackDays ? Number(values.latestSyncLookbackDays) : undefined,
      rateLimitPauseMs: Object.prototype.hasOwnProperty.call(values, "rateLimitPauseMs") ? Number(values.rateLimitPauseMs || 0) : undefined,
      readOnly: true,
    };
    if (values.chunkPages && !Object.prototype.hasOwnProperty.call(values, "maxConversationPages")) {
      body.maxConversationPages = Number(values.chunkPages);
    }
    if (body.runType === "backfill" && body.maxConversationPages === 0) body.maxConversationPages = 1;
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
      EBAY_MESSAGE_READ_SYNC_FUNCTION,
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
    syncEbayProviderReadState,
    processPendingEbayProviderReadState,
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
