(function () {
  "use strict";

  const START_FUNCTION = "microsoft-auth-start";
  const MESSAGES_FUNCTION = "microsoft-latest-messages";
  const STATUS_FUNCTION = "microsoft-mailbox-status";
  const DISCONNECT_FUNCTION = "microsoft-mailbox-disconnect";
  const CLASSIFY_FUNCTION = "microsoft-email-classify";

  const DEFAULT_LIMITS = {
    classificationLimit: 50,
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

  window.EmailTriageApi = {
    functions: {
      START_FUNCTION,
      MESSAGES_FUNCTION,
      STATUS_FUNCTION,
      DISCONNECT_FUNCTION,
      CLASSIFY_FUNCTION,
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
  };
})();
