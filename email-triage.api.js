(function () {
  "use strict";

  const START_FUNCTION = "microsoft-auth-start";
  const MESSAGES_FUNCTION = "microsoft-latest-messages";
  const STATUS_FUNCTION = "microsoft-mailbox-status";
  const DISCONNECT_FUNCTION = "microsoft-mailbox-disconnect";
  const CLASSIFY_FUNCTION = "microsoft-email-classify";
  const SYNC_FUNCTION = "microsoft-email-sync";
  const PROCESS_FUNCTION = "microsoft-email-process";

  const DEFAULT_LIMITS = {
    classificationLimit: 100,
    replayLimit: 20,
    failedJobLimit: 20,
  };

  const TIMEOUTS = {
    adminView: 15000,
    messageDetail: 15000,
    draftView: 15000,
    draftGeneration: 45000,
    draftReview: 15000,
    matchContext: 15000,
    inboxPreview: 30000,
    inboxImport: 60000,
    rematchExisting: 60000,
    operationalDashboard: 30000,
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
      options.greetingEl.textContent = `Email Triage${name}`;
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
    return {
      limit: Number(source.limit || source.page?.limit || 0) || null,
      cursor: source.cursor || source.page?.cursor || null,
      has_more: Boolean(source.has_more || source.hasMore || source.page?.has_more || source.page?.hasMore),
      filters: source.filters || source.page?.filters || {},
      sort: source.sort || source.page?.sort || null,
    };
  }

  function normalizeNumberMap(source = {}) {
    if (!source || typeof source !== "object") return {};
    return Object.entries(source).reduce((map, [key, value]) => {
      map[key] = Number(value || 0);
      return map;
    }, {});
  }

  function normalizeClassificationCounts(source = {}, loadedRows = 0) {
    const counts = source && typeof source === "object" ? source : {};
    return {
      scope: counts.scope || "current_valid",
      total_current_valid: Number(counts.total_current_valid || 0),
      loaded_current_valid: Number(counts.loaded_current_valid || loadedRows || 0),
      current_limit_used: Number(counts.current_limit_used || 0),
      result_limited: counts.result_limited === true,
      category_totals: normalizeNumberMap(counts.category_totals),
      human_review_total: Number(counts.human_review_total || 0),
      category_totals_are_exact: counts.category_totals_are_exact === true,
      category_total_rows_loaded: Number(counts.category_total_rows_loaded || 0),
      category_total_scan_limit: Number(counts.category_total_scan_limit || 0),
    };
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

  function normalizeAdminViewPayload(payload) {
    const source = normalizeEnvelope(payload, "admin_view").data;
    const classifications = Array.isArray(source?.classifications) ? source.classifications : [];
    const replayOperations = Array.isArray(source?.replay_operations) ? source.replay_operations : [];
    const failedJobs = Array.isArray(source?.failed_jobs) ? source.failed_jobs : [];
    const queueSummary = source?.queue_summary && typeof source.queue_summary === "object"
      ? source.queue_summary
      : {};
    const validationDiagnostics = source?.validation_diagnostics && typeof source.validation_diagnostics === "object"
      ? source.validation_diagnostics
      : {};
    const classificationCounts = normalizeClassificationCounts(
      source?.classification_counts || { total_current_valid: validationDiagnostics.valid_classifications },
      classifications.length,
    );

    return {
      classifications,
      replay_operations: replayOperations,
      failed_jobs: failedJobs,
      queue_summary: {
        queued: Number(queueSummary.queued || 0),
        processing: Number(queueSummary.processing || 0),
        succeeded: Number(queueSummary.succeeded || 0),
        failed: Number(queueSummary.failed || 0),
      },
      classification_counts: classificationCounts,
      validation_diagnostics: {
        valid_classifications: Number(validationDiagnostics.valid_classifications || 0),
        invalid_classifications: Number(validationDiagnostics.invalid_classifications || 0),
        requires_human_review: Number(validationDiagnostics.requires_human_review || 0),
        pending_human_review: Number(validationDiagnostics.pending_human_review || 0),
        replay_generated_classifications: Number(validationDiagnostics.replay_generated_classifications || 0),
      },
    };
  }

  function isAdminViewEmpty(data) {
    return !data.classifications.length
      && !data.replay_operations.length
      && !data.failed_jobs.length
      && Object.values(data.queue_summary).every((value) => Number(value || 0) === 0)
      && Object.values(data.validation_diagnostics).every((value) => Number(value || 0) === 0);
  }

  async function fetchAdminClassificationView(context, limits = DEFAULT_LIMITS) {
    const session = await currentSession(context, "Classification admin");
    const payload = await edgeFetchWithTimeout(CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "admin_view",
        classificationLimit: limits.classificationLimit || DEFAULT_LIMITS.classificationLimit,
        replayLimit: limits.replayLimit || DEFAULT_LIMITS.replayLimit,
        failedJobLimit: limits.failedJobLimit || DEFAULT_LIMITS.failedJobLimit,
      }),
    }, TIMEOUTS.adminView);

    return normalizeAdminViewPayload(payload);
  }

  async function fetchMessageDetail(context, messageId) {
    const session = await currentSession(context, "Message detail");
    return edgeFetchWithTimeout(CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({ mode: "message_detail", messageId }),
    }, TIMEOUTS.messageDetail);
  }

  async function fetchDraftView(context, values) {
    const session = await currentSession(context, "Draft view");
    return edgeFetchWithTimeout(CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "admin_draft_view",
        messageId: values.messageId,
        classificationId: values.classificationId || undefined,
        includeDraftBody: true,
        limit: 20,
      }),
    }, TIMEOUTS.draftView);
  }

  async function requestResponseDraft(context, values) {
    const session = await currentSession(context, "Draft generation");
    const body = {
      mode: values.mode,
      messageId: values.messageId,
    };
    if (values.useDraftSelector && values.draftId) body.draftId = values.draftId;
    if (values.useClassificationSelector && values.classificationId) body.classificationId = values.classificationId;

    return edgeFetchWithTimeout(CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify(body),
    }, TIMEOUTS.draftGeneration);
  }

  async function requestDraftReviewAction(context, values) {
    const session = await currentSession(context, "Draft review");
    const body = {
      mode: values.mode,
      messageId: values.messageId,
      draftId: values.draftId,
      draftSubject: values.draftSubject,
      draftBodyText: values.draftBodyText,
      operatorNotes: values.operatorNotes || "",
    };
    if (values.classificationId) body.classificationId = values.classificationId;

    return edgeFetchWithTimeout(CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify(body),
    }, TIMEOUTS.draftReview);
  }

  async function fetchMatchContext(context, messageId) {
    const session = await currentSession(context, "Match context");
    return edgeFetchWithTimeout(CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({ mode: "operator_match_context", messageId }),
    }, TIMEOUTS.matchContext);
  }

  async function requestMatchReviewAction(context, values) {
    const session = await currentSession(context, "Match review");
    return edgeFetch(CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: values.mode,
        linkId: values.linkId,
        reason: values.reason || undefined,
      }),
    });
  }

  async function saveClassificationReview(context, values) {
    const session = await currentSession(context, "Review save");
    return edgeFetch(CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "save_review",
        classificationId: values.classificationId,
        reviewState: values.reviewState,
        overrideCategory: values.overrideCategory || null,
        overridePriority: values.overridePriority || null,
        overrideUrgency: values.overrideUrgency || null,
        operatorNotes: values.operatorNotes || "",
      }),
    });
  }

  function normalizeInboxPreviewPayload(payload) {
    const source = normalizeEnvelope(payload, "sync_preview").data || {};
    const messages = Array.isArray(source.messages) ? source.messages : [];
    const bucketSummary = source.bucket_summary && typeof source.bucket_summary === "object" ? source.bucket_summary : {};
    const importedSummary = source.already_imported_summary && typeof source.already_imported_summary === "object" ? source.already_imported_summary : {};
    const senderDomainSummary = source.sender_domain_summary && typeof source.sender_domain_summary === "object" ? source.sender_domain_summary : {};

    return {
      ok: source.ok !== false,
      mode: source.mode || "sync_preview",
      limit: Number(source.limit || 25),
      daysBack: source.daysBack ?? null,
      bucketMode: source.bucketMode || "ebay_only",
      messages_previewed: Number(source.messages_previewed || messages.length || 0),
      messages_returned: Number(source.messages_returned || messages.length || 0),
      bucket_summary: {
        likely_ebay: Number(bucketSummary.likely_ebay || 0),
        maybe_ebay: Number(bucketSummary.maybe_ebay || 0),
        not_ebay: Number(bucketSummary.not_ebay || 0),
      },
      already_imported_summary: {
        imported: Number(importedSummary.imported || 0),
        not_imported: Number(importedSummary.not_imported || 0),
      },
      sender_domain_summary: senderDomainSummary,
      messages,
      raw: source,
    };
  }

  function normalizeInboxImportPayload(payload) {
    const source = normalizeEnvelope(payload, "sync_import_approved").data || {};
    const skippedReasons = source.skipped_reasons && typeof source.skipped_reasons === "object" ? source.skipped_reasons : {};

    return {
      ok: source.ok !== false,
      mode: source.mode || "sync_import_approved",
      imported_count: Number(source.imported_count || 0),
      already_imported_count: Number(source.already_imported_count || 0),
      skipped_count: Number(source.skipped_count || 0),
      skipped_reasons: skippedReasons,
      operation_event_id: source.operation_event_id || source.operationEventId || null,
      classification_created: Number(source.classification_created || 0),
      drafts_created: Number(source.drafts_created || 0),
      outlook_mutation_performed: source.outlook_mutation_performed === true,
      sync_checkpoint_updated: source.sync_checkpoint_updated === true,
      messages: Array.isArray(source.messages) ? source.messages : [],
      raw: source,
    };
  }

  function normalizeLiveRefreshPayload(payload) {
    const source = normalizeEnvelope(payload, "run_live_refresh").data || {};
    const preview = source.preview && typeof source.preview === "object" ? source.preview : {};
    const imported = source.import && typeof source.import === "object" ? source.import : {};
    const processing = source.processing && typeof source.processing === "object" ? source.processing : {};
    const classification = source.classification && typeof source.classification === "object" ? source.classification : {};
    const safety = source.safety && typeof source.safety === "object" ? source.safety : {};
    const previewMessages = Array.isArray(preview.messages) ? preview.messages : [];

    return {
      ok: source.ok !== false,
      mode: source.mode || "run_live_refresh",
      operation_id: source.operation_id || source.operationId || null,
      live_sync_enabled: source.live_sync_enabled === true,
      blocked: source.blocked === true || source.disabled === true || source.queue_saturated === true,
      reason: source.reason || source.queue_saturation_reason || null,
      preview: {
        previewed_count: Number(preview.previewed_count || 0),
        likely_ebay_count: Number(preview.likely_ebay_count || 0),
        maybe_ebay_count: Number(preview.maybe_ebay_count || 0),
        not_ebay_count: Number(preview.not_ebay_count || 0),
        messages_returned: Number(preview.messages_returned || previewMessages.length || 0),
      },
      preview_result: {
        ok: true,
        mode: "sync_preview",
        limit: Number(source.requested_limit || preview.limit || preview.previewed_count || previewMessages.length || 25),
        daysBack: source.requested_daysBack ?? null,
        bucketMode: source.bucketMode || "ebay_only",
        messages_previewed: Number(preview.previewed_count || previewMessages.length || 0),
        messages_returned: Number(preview.messages_returned || previewMessages.length || 0),
        bucket_summary: {
          likely_ebay: Number(preview.likely_ebay_count || 0),
          maybe_ebay: Number(preview.maybe_ebay_count || 0),
          not_ebay: Number(preview.not_ebay_count || 0),
        },
        already_imported_summary: {
          imported: previewMessages.filter((message) => message.already_imported === true).length,
          not_imported: previewMessages.filter((message) => message.already_imported !== true).length,
        },
        sender_domain_summary: {},
        messages: previewMessages,
        raw: preview,
      },
      import: {
        imported_count: Number(imported.imported_count || 0),
        already_imported_count: Number(imported.already_imported_count || 0),
        skipped_count: Number(imported.skipped_count || 0),
      },
      processing: {
        processed_count: Number(processing.processed_count || 0),
        failed_count: Number(processing.failed_count || 0),
        skipped_count: Number(processing.skipped_count || 0),
        jobs_enqueued: Number(processing.jobs_enqueued || 0),
        jobs_processed: Number(processing.jobs_processed || 0),
      },
      classification: {
        classified_count: Number(classification.classified_count || 0),
        failed_count: Number(classification.failed_count || 0),
        skipped_count: Number(classification.skipped_count || 0),
      },
      queue_state: source.queue_state && typeof source.queue_state === "object" ? source.queue_state : {},
      child_operations: source.child_operations && typeof source.child_operations === "object" ? source.child_operations : {},
      safety: {
        outlook_mutation_performed: safety.outlook_mutation_performed === true,
        automatic_responses_sent: Number(safety.automatic_responses_sent || 0),
        drafts_created: Number(safety.drafts_created || 0),
        attachments_fetched: Number(safety.attachments_fetched || 0),
        sync_checkpoint_updated: safety.sync_checkpoint_updated === true,
        polling_started: safety.polling_started === true,
        scheduler_started: safety.scheduler_started === true,
        realtime_listener_started: safety.realtime_listener_started === true,
      },
      raw: source,
    };
  }

  function normalizeRematchExistingPayload(payload) {
    const source = normalizeEnvelope(payload, "rematch_existing").data || {};
    const safety = source.safety && typeof source.safety === "object" ? source.safety : {};
    return {
      ok: source.ok !== false,
      mode: source.mode || "rematch_existing",
      operation_event_id: source.operation_event_id || source.operationEventId || source.replay_operation_reference?.operation_event_id || null,
      limit: Number(source.limit || 0),
      scanned: Number(source.scanned || 0),
      rematched: Number(source.rematched || 0),
      links_created: Number(source.links_created || 0),
      links_updated: Number(source.links_updated || 0),
      ambiguous: Number(source.ambiguous || 0),
      skipped: Number(source.skipped || 0),
      failed: Number(source.failed || 0),
      message_ids: Array.isArray(source.message_ids) ? source.message_ids : [],
      failures: Array.isArray(source.failures) ? source.failures : [],
      safety: {
        outlook_fetch_performed: safety.outlook_fetch_performed === true,
        outlook_mutation_performed: safety.outlook_mutation_performed === true,
        ebay_mutation_performed: safety.ebay_mutation_performed === true,
        classification_triggered: safety.classification_triggered === true,
        drafts_created: Number(safety.drafts_created || 0),
        automatic_responses_sent: Number(safety.automatic_responses_sent || 0),
      },
      raw: source,
    };
  }

  function normalizeOperationalDashboardPayload(payload = {}) {
    const pipelineEnvelope = normalizeEnvelope(payload.pipeline, "pipeline_diagnostics");
    const liveSyncEnvelope = normalizeEnvelope(payload.liveSync, "live_sync_status");
    const mailboxEnvelope = normalizeEnvelope(payload.mailbox, "mailbox_status");
    const pipeline = pipelineEnvelope.data || {};
    const liveSync = liveSyncEnvelope.data || {};
    const mailbox = payload.mailbox && typeof payload.mailbox === "object" ? payload.mailbox : {};
    const connection = mailbox.connection && typeof mailbox.connection === "object" ? mailbox.connection : mailbox;
    const queueSummary = pipeline.queue_summary && typeof pipeline.queue_summary === "object" ? pipeline.queue_summary : {};
    const liveQueue = liveSync.queue_state && typeof liveSync.queue_state === "object" ? liveSync.queue_state : {};
    const classification = pipeline.classification_summary && typeof pipeline.classification_summary === "object" ? pipeline.classification_summary : {};
    const failures = pipeline.failure_summary && typeof pipeline.failure_summary === "object" ? pipeline.failure_summary : {};
    const timing = pipeline.timing_summary && typeof pipeline.timing_summary === "object" ? pipeline.timing_summary : {};
    const replay = pipeline.replay_summary && typeof pipeline.replay_summary === "object" ? pipeline.replay_summary : {};
    const gaps = pipeline.pipeline_gap_summary && typeof pipeline.pipeline_gap_summary === "object" ? pipeline.pipeline_gap_summary : {};
    const visibility = pipeline.table_pipeline_visibility_summary && typeof pipeline.table_pipeline_visibility_summary === "object" ? pipeline.table_pipeline_visibility_summary : {};
    const events = Array.isArray(pipeline.recent_operational_events) ? pipeline.recent_operational_events : [];
    const latestByType = (types = []) => events.find((event) => types.includes(String(event.event_type || ""))) || null;
    const latestFailedEvent = events.find((event) => {
      const status = String(event.status || "").toLowerCase();
      const counters = event.counters && typeof event.counters === "object" ? event.counters : {};
      return status.includes("fail") || Number(counters.failed_count || 0) > 0;
    }) || null;

    return {
      ok: pipelineEnvelope.ok !== false && liveSyncEnvelope.ok !== false && mailboxEnvelope.ok !== false && mailbox.ok !== false,
      mode: "operational_dashboard",
      generated_at: new Date().toISOString(),
      mailbox: {
        status: connection.status || connection.mailbox_status || "unknown",
        connected: Boolean(connection.mailbox_email || connection.status || connection.mailbox_status),
        mailbox_email: connection.mailbox_email || connection.email || null,
        display_name: connection.display_name || null,
        last_checked_at: connection.last_successful_check_at || connection.last_successful_sync_at || connection.updated_at || timing.latest_live_refresh_at || null,
        live_sync_enabled: liveSync.live_sync_enabled === true || pipeline.live_sync_enabled === true,
      },
      queue: {
        queued: Number(liveQueue.queued ?? queueSummary.queued ?? 0),
        running: Number(liveQueue.running ?? queueSummary.running ?? 0),
        succeeded: Number(queueSummary.succeeded || 0),
        skipped: Number(queueSummary.skipped || 0),
        failed: Number(queueSummary.failed || 0),
        permanently_failed: Number(queueSummary.permanently_failed || 0),
        saturated: liveQueue.saturated === true || queueSummary.saturated === true,
        oldest_queued_age_seconds: queueSummary.oldest_queued_age_seconds ?? null,
      },
      activity: {
        latest_live_refresh: latestByType(["run_live_refresh"]),
        latest_import: latestByType(["sync_import_approved"]),
        latest_processing: latestByType(["process_imported"]),
        latest_classification: latestByType(["classify_imported", "classification_replay"]),
        latest_rematch: latestByType(["rematch_existing"]),
        latest_replay: latestByType(["classification_replay", "processing_replay", "processing_requeue", "sync_replay"]),
        latest_failed_operation: latestFailedEvent,
        timing,
      },
      replay: {
        import_operations: Number(replay.import_operations || 0),
        classify_operations: Number(replay.classify_operations || 0),
        process_operations: Number(replay.process_operations || 0),
        live_refresh_operations: Number(replay.live_refresh_operations || 0),
        rematch_operations: Number(replay.rematch_operations || 0),
        latest_operation_at: replay.latest_operation_at || null,
        latest_operation_type: replay.latest_operation_type || null,
        replay_safe: replay.replay_safe === true,
      },
      pipeline_gaps: {
        approved_imported_total: Number(gaps.approved_imported_total || 0),
        active_imported_total: Number(gaps.active_imported_total || 0),
        fully_processed_imported_total: Number(gaps.fully_processed_imported_total || 0),
        current_classified_imported_total: Number(gaps.current_classified_imported_total || 0),
        imported_without_processing: Number(gaps.imported_without_processing || 0),
        processed_without_classification: Number(gaps.processed_without_classification || 0),
      },
      pipeline_visibility: {
        source: visibility.source || "email_tables",
        scope: visibility.scope || "not_reported",
        is_limited: visibility.is_limited === true,
        scan_limit: Number(visibility.scan_limit || 0),
        sampled_imported_count: Number(visibility.sampled_imported_count || 0),
        active_imported_total: Number(visibility.active_imported_total || 0),
        fully_processed_imported_count: Number(visibility.fully_processed_imported_count || 0),
        current_valid_classified_imported_total: Number(visibility.current_valid_classified_imported_total || 0),
        unclassified_imported_total: Number(visibility.unclassified_imported_total || 0),
        imported_without_processing_count: Number(visibility.imported_without_processing_count || 0),
        processed_without_classification_count: Number(visibility.processed_without_classification_count || 0),
        processing_failed_jobs: Number(visibility.processing_failed_jobs || 0),
        processing_skipped_jobs: Number(visibility.processing_skipped_jobs || 0),
        classification_failed_jobs: Number(visibility.classification_failed_jobs || 0),
        classification_skipped_jobs: Number(visibility.classification_skipped_jobs || 0),
      },
      failures: {
        failed_jobs_total: Number(failures.failed_jobs_total || 0),
        failed_classifications_total: Number(failures.failed_classifications_total || classification.permanently_failed_total || 0),
        permanently_failed_classifications: Number(classification.permanently_failed_total || 0),
        failed_reasons: failures.failed_reasons && typeof failures.failed_reasons === "object" ? failures.failed_reasons : {},
      },
      recent_operational_events: events,
      safety: {
        outlook_mutation_performed: pipeline.safety?.outlook_mutation_performed === true || liveSync.safety?.outlook_mutation_performed === true,
        sync_checkpoint_updated: pipeline.safety?.sync_checkpoint_updated === true || liveSync.safety?.sync_checkpoint_updated === true,
        drafts_created: Number(pipeline.safety?.drafts_created || liveSync.safety?.drafts_created || 0),
        automatic_responses_sent: Number(pipeline.safety?.automatic_responses_sent || liveSync.safety?.automatic_responses_sent || 0),
        scheduler_started: liveSync.safety?.scheduler_started === true || false,
        polling_started: liveSync.safety?.polling_started === true || false,
        realtime_listener_started: liveSync.safety?.realtime_listener_started === true || false,
      },
      raw: { pipeline, liveSync, mailbox },
    };
  }

  async function fetchInboxPreview(context, values = {}) {
    const session = await currentSession(context, "Inbox preview");
    const body = {
      mode: "sync_preview",
      limit: Number(values.limit || 25),
      daysBack: values.daysBack === "" || values.daysBack == null ? null : Number(values.daysBack),
      bucketMode: values.bucketMode || "ebay_only",
    };

    const payload = await edgeFetchWithTimeout(SYNC_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify(body),
    }, TIMEOUTS.inboxPreview);

    return normalizeInboxPreviewPayload(payload);
  }

  async function importApprovedInboxPreview(context, values = {}) {
    const session = await currentSession(context, "Inbox approved import");
    const providerMessageIds = Array.isArray(values.providerMessageIds)
      ? values.providerMessageIds.filter(Boolean)
      : [];
    const body = {
      mode: "sync_import_approved",
      source: "preview",
      importBucket: values.importBucket || "likely_ebay",
      limit: Number(values.limit || 25),
      bucketMode: values.bucketMode || "ebay_only",
      confirmImport: "IMPORT_PREVIEW_APPROVED",
    };
    const daysBack = values.daysBack === "" || values.daysBack == null ? null : Number(values.daysBack);
    body.daysBack = daysBack;
    if (providerMessageIds.length) body.providerMessageIds = providerMessageIds;

    const payload = await edgeFetchWithTimeout(SYNC_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify(body),
    }, TIMEOUTS.inboxImport);

    return normalizeInboxImportPayload(payload);
  }

  async function runInboxLiveRefresh(context, values = {}) {
    const session = await currentSession(context, "Inbox live refresh");
    const body = {
      mode: "run_live_refresh",
      limit: Number(values.limit || 25),
      daysBack: values.daysBack === "" || values.daysBack == null ? null : Number(values.daysBack),
      bucketMode: values.bucketMode || "ebay_only",
    };

    const payload = await edgeFetchWithTimeout(SYNC_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify(body),
    }, TIMEOUTS.inboxImport);

    return normalizeLiveRefreshPayload(payload);
  }

  async function rematchExistingEmails(context, values = {}) {
    const session = await currentSession(context, "Rematch existing emails");
    const body = {
      mode: "rematch_existing",
      limit: Number(values.limit || 25),
      jobTypes: ["match_order"],
    };

    const payload = await edgeFetchWithTimeout(PROCESS_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify(body),
    }, TIMEOUTS.rematchExisting);

    return normalizeRematchExistingPayload(payload);
  }

  async function fetchOperationalDashboard(context) {
    const session = await currentSession(context, "Operational dashboard");
    const [mailboxResult, pipelineResult, liveSyncResult] = await Promise.allSettled([
      edgeFetchWithTimeout(STATUS_FUNCTION, session, { method: "GET" }, TIMEOUTS.operationalDashboard),
      edgeFetchWithTimeout(SYNC_FUNCTION, session, {
        method: "POST",
        body: JSON.stringify({ mode: "pipeline_diagnostics" }),
      }, TIMEOUTS.operationalDashboard),
      edgeFetchWithTimeout(SYNC_FUNCTION, session, {
        method: "POST",
        body: JSON.stringify({ mode: "live_sync_status" }),
      }, TIMEOUTS.operationalDashboard),
    ]);
    const mailbox = mailboxResult.status === "fulfilled" ? mailboxResult.value : mailboxResult.reason?.envelope || toSafeErrorEnvelope(mailboxResult.reason, "mailbox_status_failed");
    const pipeline = pipelineResult.status === "fulfilled" ? pipelineResult.value : pipelineResult.reason?.envelope || toSafeErrorEnvelope(pipelineResult.reason, "pipeline_diagnostics_failed");
    const liveSync = liveSyncResult.status === "fulfilled" ? liveSyncResult.value : liveSyncResult.reason?.envelope || toSafeErrorEnvelope(liveSyncResult.reason, "live_sync_status_failed");

    return normalizeOperationalDashboardPayload({ mailbox, pipeline, liveSync });
  }

  window.EmailTriageApi = {
    functions: {
      START_FUNCTION,
      MESSAGES_FUNCTION,
      STATUS_FUNCTION,
      DISCONNECT_FUNCTION,
      CLASSIFY_FUNCTION,
      SYNC_FUNCTION,
      PROCESS_FUNCTION,
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
    normalizeAdminViewPayload,
    isAdminViewEmpty,
    fetchAdminClassificationView,
    fetchMessageDetail,
    fetchDraftView,
    requestResponseDraft,
    requestDraftReviewAction,
    fetchMatchContext,
    requestMatchReviewAction,
    saveClassificationReview,
    normalizeInboxPreviewPayload,
    normalizeInboxImportPayload,
    normalizeLiveRefreshPayload,
    normalizeRematchExistingPayload,
    normalizeOperationalDashboardPayload,
    fetchInboxPreview,
    importApprovedInboxPreview,
    runInboxLiveRefresh,
    rematchExistingEmails,
    fetchOperationalDashboard,
  };
})();
