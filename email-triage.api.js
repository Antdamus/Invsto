(function () {
  "use strict";

  const START_FUNCTION = "microsoft-auth-start";
  const MESSAGES_FUNCTION = "microsoft-latest-messages";
  const STATUS_FUNCTION = "microsoft-mailbox-status";
  const DISCONNECT_FUNCTION = "microsoft-mailbox-disconnect";
  const CLASSIFY_FUNCTION = "microsoft-email-classify";
  const SYNC_FUNCTION = "microsoft-email-sync";
  const PROCESS_FUNCTION = "microsoft-email-process";
  const EBAY_CONVERSATION_CONTEXT_FUNCTION = "ebay-conversation-context";
  const EBAY_MESSAGE_SYNC_FUNCTION = "ebay-message-sync";
  const EBAY_CONVERSATION_CLASSIFY_FUNCTION = "ebay-conversation-classify";
  const EBAY_CONVERSATION_DRAFT_FUNCTION = "ebay-conversation-draft";

  const DEFAULT_LIMITS = {
    classificationLimit: 25,
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
    mailboxImport: 60000,
    mailboxPrepare: 60000,
    rematchExisting: 60000,
    operationalDashboard: 30000,
    ebayConversations: 15000,
    ebayConversationMessages: 15000,
    ebayConversationContext: 30000,
    ebayMessageSync: 90000,
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
    const querySource = source.mailbox_query && typeof source.mailbox_query === "object" ? source.mailbox_query : {};
    return {
      page: Number(querySource.page || pageSource.page || source.page_number || 1) || 1,
      pageSize: Number(querySource.page_size || querySource.pageSize || pageSource.page_size || pageSource.pageSize || source.limit || 0) || null,
      limit: Number(querySource.page_size || querySource.pageSize || pageSource.limit || source.limit || 0) || null,
      offset: Number(querySource.offset || pageSource.offset || 0) || 0,
      cursor: source.cursor || pageSource.cursor || null,
      has_more: Boolean(querySource.has_next_page || source.has_more || source.hasMore || pageSource.has_more || pageSource.hasMore),
      has_previous_page: Boolean(querySource.has_previous_page || pageSource.has_previous_page),
      total_pages: Number(querySource.total_pages || pageSource.total_pages || 1) || 1,
      filtered_rows: Number(querySource.filtered_rows || pageSource.filtered_rows || 0) || 0,
      total_mailbox_rows: Number(querySource.total_mailbox_rows || pageSource.total_mailbox_rows || 0) || 0,
      total_classified_rows: Number(querySource.total_classified_rows || pageSource.total_classified_rows || 0) || 0,
      visible_rows: Number(querySource.visible_rows || pageSource.visible_rows || 0) || 0,
      filters: querySource.filters || source.filters || pageSource.filters || {},
      sort: querySource.sort || source.sort || pageSource.sort || null,
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
      filtered_current_valid: Number(counts.filtered_current_valid || 0),
      visible_rows: Number(counts.visible_rows || loadedRows || 0),
      total_mailbox_rows: Number(counts.total_mailbox_rows || 0),
      category_totals: normalizeNumberMap(counts.category_totals),
      human_review_total: Number(counts.human_review_total || 0),
      category_totals_are_exact: counts.category_totals_are_exact === true,
      category_total_rows_loaded: Number(counts.category_total_rows_loaded || 0),
      category_total_scan_limit: Number(counts.category_total_scan_limit || 0),
      page: Number(counts.page || 1),
      page_size: Number(counts.page_size || counts.current_limit_used || 0),
      page_offset: Number(counts.page_offset || 0),
      total_pages: Number(counts.total_pages || 1),
      has_next_page: counts.has_next_page === true,
      has_previous_page: counts.has_previous_page === true,
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
      mailbox_query: source?.mailbox_query && typeof source.mailbox_query === "object"
        ? source.mailbox_query
        : {},
      page: normalizePage(source || {}),
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
    const mailboxQuery = limits.mailboxQuery && typeof limits.mailboxQuery === "object" ? limits.mailboxQuery : {};
    const pageSize = Number(mailboxQuery.pageSize || limits.classificationLimit || DEFAULT_LIMITS.classificationLimit);
    const payload = await edgeFetchWithTimeout(CLASSIFY_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "admin_view",
        classificationLimit: pageSize,
        replayLimit: limits.replayLimit || DEFAULT_LIMITS.replayLimit,
        failedJobLimit: limits.failedJobLimit || DEFAULT_LIMITS.failedJobLimit,
        mailboxQuery: {
          page: Number(mailboxQuery.page || 1),
          pageSize,
          sort: mailboxQuery.sort || "newest",
          category: mailboxQuery.category || "all",
          priority: mailboxQuery.priority || "all",
          status: mailboxQuery.status || "all",
          filters: Array.isArray(mailboxQuery.filters) ? mailboxQuery.filters : [],
        },
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

  function normalizeMailboxImportPayload(payload) {
    const source = normalizeEnvelope(payload, "mailbox_import").data || {};
    const progress = source.progress && typeof source.progress === "object" ? source.progress : {};
    const batch = source.batch && typeof source.batch === "object" ? source.batch : {};
    const safety = source.safety && typeof source.safety === "object" ? source.safety : {};
    const preparationProgress = source.preparation_progress && typeof source.preparation_progress === "object" ? source.preparation_progress : null;
    return {
      ok: source.ok !== false,
      mode: source.mode || "mailbox_import",
      action: source.action || null,
      operation_event_id: source.operation_event_id || source.operationEventId || null,
      sync_run_id: source.sync_run_id || source.syncRunId || null,
      target_count: Number(source.target_count || progress.target_count || 0),
      imported_total: Number(source.imported_total || progress.imported_total || 0),
      already_imported_total: Number(source.already_imported_total || progress.already_imported_total || 0),
      failed_total: Number(source.failed_total || progress.failed_total || 0),
      remaining_estimate: Number(source.remaining_estimate || progress.remaining_estimate || 0),
      has_more: source.has_more === true || progress.has_more === true,
      continuation_available: source.continuation_available === true || progress.continuation_available === true,
      progress: {
        status: progress.status || source.status || "not_started",
        target_count: Number(progress.target_count || source.target_count || 0),
        imported_total: Number(progress.imported_total || source.imported_total || 0),
        already_imported_total: Number(progress.already_imported_total || source.already_imported_total || 0),
        failed_total: Number(progress.failed_total || source.failed_total || 0),
        messages_seen_total: Number(progress.messages_seen_total || 0),
        deleted_total: Number(progress.deleted_total || 0),
        completed_total: Number(progress.completed_total || 0),
        remaining_estimate: Number(progress.remaining_estimate || source.remaining_estimate || 0),
        has_more: progress.has_more === true || source.has_more === true,
        continuation_available: progress.continuation_available === true || source.continuation_available === true,
        started_at: progress.started_at || null,
        updated_at: progress.updated_at || null,
        completed_at: progress.completed_at || null,
        remaining_to_process: progress.remaining_to_process ?? source.remaining_to_process ?? null,
        remaining_to_classify: progress.remaining_to_classify ?? source.remaining_to_classify ?? null,
      },
      preparation_progress: preparationProgress ? {
        imported_active: Number(preparationProgress.imported_active || 0),
        processed_total: Number(preparationProgress.processed_total || 0),
        classified_total: Number(preparationProgress.classified_total || 0),
        remaining_to_process: Number(preparationProgress.remaining_to_process || 0),
        remaining_to_classify: Number(preparationProgress.remaining_to_classify || 0),
        processing_failed: Number(preparationProgress.processing_failed || 0),
        processing_skipped: Number(preparationProgress.processing_skipped || 0),
        classification_failed: Number(preparationProgress.classification_failed || 0),
        classification_skipped: Number(preparationProgress.classification_skipped || 0),
        actionable_remaining_to_process: Number(preparationProgress.actionable_remaining_to_process || 0),
        actionable_remaining_to_classify: Number(preparationProgress.actionable_remaining_to_classify || 0),
        queued_or_running: Number(preparationProgress.queued_or_running || 0),
        only_failures_remain: preparationProgress.only_failures_remain === true,
        has_more: preparationProgress.has_more === true,
        source: preparationProgress.source || "email_tables",
        scope: preparationProgress.scope || "not_reported",
        is_limited: preparationProgress.is_limited === true,
      } : null,
      batch: {
        pages_fetched: Number(batch.pages_fetched || 0),
        messages_seen: Number(batch.messages_seen || 0),
        imported_count: Number(batch.imported_count || 0),
        already_imported_count: Number(batch.already_imported_count || 0),
        deleted_count: Number(batch.deleted_count || 0),
        failed_count: Number(batch.failed_count || 0),
      },
      failures: Array.isArray(source.failures) ? source.failures : [],
      safety: {
        outlook_mutation_performed: safety.outlook_mutation_performed === true,
        automatic_responses_sent: Number(safety.automatic_responses_sent || 0),
        drafts_created: Number(safety.drafts_created || 0),
        attachments_fetched: Number(safety.attachments_fetched || 0),
        sync_checkpoint_updated: safety.sync_checkpoint_updated === true,
        processing_triggered: safety.processing_triggered === true,
        classification_triggered: safety.classification_triggered === true,
      },
      raw: source,
    };
  }

  function normalizeMailboxPreparePayload(payload) {
    const source = normalizeEnvelope(payload, "prepare_mailbox").data || {};
    const progress = source.progress && typeof source.progress === "object" ? source.progress : {};
    const before = source.before && typeof source.before === "object" ? source.before : {};
    const processing = source.processing && typeof source.processing === "object" ? source.processing : {};
    const classification = source.classification && typeof source.classification === "object" ? source.classification : {};
    const safety = source.safety && typeof source.safety === "object" ? source.safety : {};
    return {
      ok: source.ok !== false,
      mode: source.mode || "prepare_mailbox",
      mailbox_id: source.mailbox_id || null,
      disabled: source.disabled === true,
      reason: source.reason || null,
      process_batch_size: Number(source.process_batch_size || 0),
      classify_batch_size: Number(source.classify_batch_size || 0),
      progress: {
        imported_active: Number(progress.imported_active || 0),
        processed_total: Number(progress.processed_total || 0),
        classified_total: Number(progress.classified_total || 0),
        remaining_to_process: Number(progress.remaining_to_process || 0),
        remaining_to_classify: Number(progress.remaining_to_classify || 0),
        processing_failed: Number(progress.processing_failed || 0),
        processing_skipped: Number(progress.processing_skipped || 0),
        classification_failed: Number(progress.classification_failed || 0),
        classification_skipped: Number(progress.classification_skipped || 0),
        actionable_remaining_to_process: Number(progress.actionable_remaining_to_process || 0),
        actionable_remaining_to_classify: Number(progress.actionable_remaining_to_classify || 0),
        queued_or_running: Number(progress.queued_or_running || 0),
        only_failures_remain: progress.only_failures_remain === true,
        has_more: progress.has_more === true,
        source: progress.source || "email_tables",
        scope: progress.scope || "not_reported",
        is_limited: progress.is_limited === true,
      },
      before,
      processing: {
        candidate_source: processing.candidate_source || null,
        candidate_count: Number(processing.candidate_count || 0),
        processed_count: Number(processing.processed_count || 0),
        failed_count: Number(processing.failed_count || 0),
        skipped_count: Number(processing.skipped_count || 0),
        jobs_enqueued: Number(processing.jobs_enqueued || 0),
        jobs_processed: Number(processing.jobs_processed || 0),
        already_processed_count: Number(processing.already_processed_count || 0),
        currently_processing_count: Number(processing.currently_processing_count || 0),
        permanently_failed_count: Number(processing.permanently_failed_count || 0),
      },
      classification: {
        candidate_source: classification.candidate_source || null,
        candidate_count: Number(classification.candidate_count || 0),
        classified_count: Number(classification.classified_count || 0),
        failed_count: Number(classification.failed_count || 0),
        skipped_count: Number(classification.skipped_count || 0),
        jobs_enqueued: Number(classification.jobs_enqueued || 0),
        jobs_processed: Number(classification.jobs_processed || 0),
        already_classified_count: Number(classification.already_classified_count || 0),
        currently_classifying_count: Number(classification.currently_classifying_count || 0),
        permanently_failed_count: Number(classification.permanently_failed_count || 0),
        processing_incomplete_count: Number(classification.processing_incomplete_count || 0),
        processing_failed_count: Number(classification.processing_failed_count || 0),
      },
      queue_saturated_after_processing: source.queue_saturated_after_processing === true,
      queue_saturation_reason: source.queue_saturation_reason || null,
      queue_state: source.queue_state && typeof source.queue_state === "object" ? source.queue_state : {},
      child_operations: source.child_operations && typeof source.child_operations === "object" ? source.child_operations : {},
      safety: {
        outlook_mutation_performed: safety.outlook_mutation_performed === true,
        automatic_responses_sent: Number(safety.automatic_responses_sent || 0),
        drafts_created: Number(safety.drafts_created || 0),
        attachments_fetched: Number(safety.attachments_fetched || 0),
        sync_checkpoint_updated: safety.sync_checkpoint_updated === true,
        processing_triggered: safety.processing_triggered === true,
        classification_triggered: safety.classification_triggered === true,
      },
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
      scope: source.scope || null,
      limit: Number(source.limit || 0),
      cursor: source.cursor || null,
      scanned: Number(source.scanned || 0),
      rematched: Number(source.rematched || 0),
      unchanged: Number(source.unchanged || 0),
      changed_link_count: Number(source.changed_link_count || 0),
      links_created: Number(source.links_created || 0),
      links_updated: Number(source.links_updated || 0),
      order_link_changes: Number(source.order_link_changes || 0),
      item_link_changes: Number(source.item_link_changes || 0),
      inventory_link_changes: Number(source.inventory_link_changes || 0),
      buyer_link_changes: Number(source.buyer_link_changes || 0),
      tracking_label_link_changes: Number(source.tracking_label_link_changes || 0),
      ambiguous: Number(source.ambiguous || 0),
      skipped: Number(source.skipped || 0),
      failed: Number(source.failed || 0),
      message_ids: Array.isArray(source.message_ids) ? source.message_ids : [],
      message_ids_changed: Array.isArray(source.message_ids_changed) ? source.message_ids_changed : [],
      failures: Array.isArray(source.failures) ? source.failures : [],
      continuation: source.continuation && typeof source.continuation === "object"
        ? {
          has_more: source.continuation.has_more === true,
          next_cursor: source.continuation.next_cursor || null,
          total: Number(source.continuation.total || 0),
          offset: Number(source.continuation.offset || 0),
          chunk_limit: Number(source.continuation.chunk_limit || 0),
        }
        : { has_more: source.has_more === true, next_cursor: source.next_cursor || null, total: 0, offset: 0, chunk_limit: 0 },
      has_more: source.has_more === true || source.continuation?.has_more === true,
      next_cursor: source.next_cursor || source.continuation?.next_cursor || null,
      mailbox_query: source.mailbox_query && typeof source.mailbox_query === "object" ? source.mailbox_query : null,
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
    const ebay = payload.ebay && typeof payload.ebay === "object" ? payload.ebay : null;
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
      ok: pipelineEnvelope.ok !== false && liveSyncEnvelope.ok !== false && mailboxEnvelope.ok !== false && mailbox.ok !== false && (!ebay || ebay.ok !== false),
      mode: "operational_dashboard",
      generated_at: new Date().toISOString(),
      ebay,
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

  async function runMailboxImport(context, values = {}) {
    const session = await currentSession(context, "Mailbox import");
    const body = {
      mode: "mailbox_import",
      action: values.action === "continue" ? "continue" : "start",
      targetCount: Number(values.targetCount || values.target_count || 100),
      pageSize: Number(values.pageSize || 50),
      maxPages: Number(values.maxPages || 3),
    };

    const payload = await edgeFetchWithTimeout(SYNC_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify(body),
    }, TIMEOUTS.mailboxImport);

    return normalizeMailboxImportPayload(payload);
  }

  async function fetchMailboxImportStatus(context) {
    const session = await currentSession(context, "Mailbox import status");
    const payload = await edgeFetchWithTimeout(SYNC_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({ mode: "mailbox_import_status" }),
    }, TIMEOUTS.operationalDashboard);

    return normalizeMailboxImportPayload(payload);
  }

  async function prepareMailbox(context, values = {}) {
    const session = await currentSession(context, "Prepare mailbox");
    const payload = await edgeFetchWithTimeout(SYNC_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify({
        mode: "prepare_mailbox",
        processBatchSize: Number(values.processBatchSize || 25),
        classifyBatchSize: Number(values.classifyBatchSize || 10),
      }),
    }, TIMEOUTS.mailboxPrepare);

    return normalizeMailboxPreparePayload(payload);
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
      scope: values.scope,
      messageId: values.messageId || null,
      messageIds: Array.isArray(values.messageIds) ? values.messageIds : [],
      limit: Number(values.limit || 50),
      cursor: values.cursor || null,
      mailboxQuery: values.mailboxQuery && typeof values.mailboxQuery === "object" ? values.mailboxQuery : undefined,
      jobTypes: ["match_order"],
    };

    const payload = await edgeFetchWithTimeout(PROCESS_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify(body),
    }, TIMEOUTS.rematchExisting);

    return normalizeRematchExistingPayload(payload);
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
          ebay_mutation_performed: false,
          outlook_mutation_performed: false,
          automatic_responses_sent: 0,
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
        outlook_mutation_performed: false,
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
    ]);

    throwSupabaseReadError(classificationsResult.error, "ebay_classification_dashboard_failed");
    throwSupabaseReadError(draftsResult.error, "ebay_draft_dashboard_failed");
    throwSupabaseReadError(approvalsResult.error, "ebay_approval_dashboard_failed");
    throwSupabaseReadError(attemptsResult.error, "ebay_send_attempt_dashboard_failed");
    throwSupabaseReadError(eventsResult.error, "ebay_activity_dashboard_failed");

    const classifications = Array.isArray(classificationsResult.data) ? classificationsResult.data : [];
    const drafts = Array.isArray(draftsResult.data) ? draftsResult.data : [];
    const approvals = Array.isArray(approvalsResult.data) ? approvalsResult.data : [];
    const attempts = Array.isArray(attemptsResult.data) ? attemptsResult.data : [];
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
        outlook_mutation_performed: false,
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
        .select("id, conversation_id, latest_message_id, latest_ebay_message_id, classification_status, priority, response_need, topic_tags, buyer_flags, risk_flags, confidence, summary, reasoning_summary, recommended_action, input_hash, context_hash, classifier_name, classifier_version, prompt_version, model_name, is_current, superseded_at, review_state, operator_override_payload, operator_notes, reviewed_by, reviewed_at, created_at, updated_at")
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
        sendConfirmed: values.sendConfirmed === true || undefined,
      }),
    }, TIMEOUTS.ebayConversationDraft);
  }

  async function runEbayMessageSync(context, values = {}) {
    const session = await currentSession(context, "eBay message sync");
    const body = {
      mode: "sync",
      runType: "manual",
      conversationTypes: values.conversationTypes || ["FROM_MEMBERS", "FROM_EBAY"],
      conversationPageLimit: Number(values.conversationPageLimit || 25),
      messagePageLimit: Number(values.messagePageLimit || 25),
      maxConversationPages: Number(values.maxConversationPages || 1),
      maxDetailPagesPerConversation: Number(values.maxDetailPagesPerConversation || 20),
      readOnly: true,
    };
    if (values.conversationId) body.conversationId = values.conversationId;
    if (values.conversationType && !values.conversationTypes) body.conversationTypes = [values.conversationType];
    if (values.startTime) body.startTime = values.startTime;
    if (values.endTime) body.endTime = values.endTime;
    if (values.otherPartyUsername) body.otherPartyUsername = values.otherPartyUsername;
    if (values.referenceId) body.referenceId = values.referenceId;

    const payload = await edgeFetchWithTimeout(EBAY_MESSAGE_SYNC_FUNCTION, session, {
      method: "POST",
      body: JSON.stringify(body),
    }, TIMEOUTS.ebayMessageSync);
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

  async function fetchOperationalDashboard(context) {
    const session = await currentSession(context, "Operational dashboard");
    const [mailboxResult, pipelineResult, liveSyncResult, ebayResult] = await Promise.allSettled([
      edgeFetchWithTimeout(STATUS_FUNCTION, session, { method: "GET" }, TIMEOUTS.operationalDashboard),
      edgeFetchWithTimeout(SYNC_FUNCTION, session, {
        method: "POST",
        body: JSON.stringify({ mode: "pipeline_diagnostics" }),
      }, TIMEOUTS.operationalDashboard),
      edgeFetchWithTimeout(SYNC_FUNCTION, session, {
        method: "POST",
        body: JSON.stringify({ mode: "live_sync_status" }),
      }, TIMEOUTS.operationalDashboard),
      fetchEbayOperationsDashboard(context),
    ]);
    const mailbox = mailboxResult.status === "fulfilled" ? mailboxResult.value : mailboxResult.reason?.envelope || toSafeErrorEnvelope(mailboxResult.reason, "mailbox_status_failed");
    const pipeline = pipelineResult.status === "fulfilled" ? pipelineResult.value : pipelineResult.reason?.envelope || toSafeErrorEnvelope(pipelineResult.reason, "pipeline_diagnostics_failed");
    const liveSync = liveSyncResult.status === "fulfilled" ? liveSyncResult.value : liveSyncResult.reason?.envelope || toSafeErrorEnvelope(liveSyncResult.reason, "live_sync_status_failed");
    const ebay = ebayResult.status === "fulfilled"
      ? ebayResult.value
      : {
        ok: false,
        error: ebayResult.reason?.code || ebayResult.reason?.message || "ebay_operations_dashboard_failed",
        generated_at: new Date().toISOString(),
        metrics: {},
        timeline: [],
        recent_operational_events: [],
      };

    return normalizeOperationalDashboardPayload({ mailbox, pipeline, liveSync, ebay });
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
    normalizeMailboxImportPayload,
    normalizeMailboxPreparePayload,
    normalizeLiveRefreshPayload,
    normalizeRematchExistingPayload,
    normalizeOperationalDashboardPayload,
    fetchEbayConversations,
    fetchEbayConversationMessages,
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
    fetchInboxPreview,
    importApprovedInboxPreview,
    runMailboxImport,
    fetchMailboxImportStatus,
    prepareMailbox,
    runInboxLiveRefresh,
    rematchExistingEmails,
    fetchOperationalDashboard,
  };
})();
