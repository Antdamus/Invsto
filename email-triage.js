(function () {
  "use strict";

  const START_FUNCTION = "microsoft-auth-start";
  const MESSAGES_FUNCTION = "microsoft-latest-messages";
  const STATUS_FUNCTION = "microsoft-mailbox-status";
  const DISCONNECT_FUNCTION = "microsoft-mailbox-disconnect";
  const CLASSIFY_FUNCTION = "microsoft-email-classify";
  const ADMIN_VIEW_DEFAULT_LIMITS = {
    classificationLimit: 50,
    replayLimit: 20,
    failedJobLimit: 20,
  };
  const ADMIN_VIEW_TIMEOUT_MS = 15000;
  const MESSAGE_DETAIL_TIMEOUT_MS = 15000;
  const LOW_CONFIDENCE_THRESHOLD = 0.75;
  const DENSITY_STORAGE_KEY = "og-email-triage-density";
  const CLASSIFICATION_CATEGORIES = [
    "buyer_message",
    "order_paid",
    "shipping_label",
    "shipping_issue",
    "return_request",
    "refund_request",
    "cancellation_request",
    "item_not_received",
    "item_not_as_described",
    "payment_issue",
    "offer_or_negotiation",
    "inventory_question",
    "authenticity_or_condition_question",
    "platform_notice",
    "account_security",
    "marketing_or_promotion",
    "spam_or_noise",
    "internal_or_other",
  ];
  const REVIEW_STATES = ["pending_review", "approved", "corrected", "dismissed"];
  const OVERRIDE_PRIORITIES = ["low", "medium", "high", "critical"];
  const OVERRIDE_URGENCIES = ["none", "later", "soon", "today", "immediate"];
  const CATEGORY_GROUPS = [
    { id: "all", label: "All", categories: [] },
    { id: "return_requests", label: "Return Requests", categories: ["return_request", "refund_request", "cancellation_request"] },
    { id: "item_not_as_described", label: "Item Not As Described", categories: ["item_not_as_described"] },
    { id: "shipping_labels", label: "Shipping Labels", categories: ["shipping_label", "shipping_issue", "item_not_received"] },
    { id: "marketing_promotion", label: "Marketing/Promotion", categories: ["marketing_or_promotion"] },
    { id: "internal_other", label: "Internal/Other", categories: ["internal_or_other", "spam_or_noise", "platform_notice", "buyer_message", "order_paid", "payment_issue", "offer_or_negotiation", "inventory_question", "authenticity_or_condition_question", "account_security"] },
    { id: "human_review", label: "Human Review", categories: [] },
  ];

  const els = {
    connect: document.getElementById("connect-outlook"),
    refresh: document.getElementById("refresh-messages"),
    disconnect: document.getElementById("disconnect-outlook"),
    refreshClassificationAdmin: document.getElementById("refresh-classification-admin"),
    statusPanel: document.getElementById("email-status-panel"),
    statusKicker: document.getElementById("email-status-kicker"),
    statusTitle: document.getElementById("email-status-title"),
    statusDetail: document.getElementById("email-status-detail"),
    statusMeta: document.getElementById("email-status-meta"),
    messagesSection: document.getElementById("email-messages-section"),
    messagesBody: document.getElementById("email-messages-body"),
    countPill: document.getElementById("message-count-pill"),
    classificationAdminDebug: document.getElementById("classification-admin-debug"),
    classificationAdminStatus: document.getElementById("classification-admin-status"),
    classificationAdminSummary: document.getElementById("classification-admin-summary"),
    classificationSort: document.getElementById("classification-sort"),
    classificationFiltersToggle: document.getElementById("classification-filters-toggle"),
    classificationFiltersLabel: document.getElementById("classification-filters-label"),
    classificationFilterPanel: document.getElementById("classification-filter-panel"),
    classificationFilterToggles: document.querySelectorAll("[data-classification-filter]"),
    classificationDensityInputs: document.querySelectorAll("input[name='classification-density']"),
    classificationCategoryList: document.getElementById("classification-category-list"),
    classificationList: document.getElementById("classification-list"),
    classificationDetail: document.getElementById("classification-detail"),
    greeting: document.getElementById("admin-greeting"),
  };

  const adminClassificationState = {
    status: "idle",
    loading: false,
    fetch_failed: false,
    unauthorized: false,
    empty_results: false,
    error: null,
    data: normalizeAdminViewPayload({}),
    selectedCategory: "all",
    selectedClassificationId: null,
    activeFilters: [],
    filtersExpanded: false,
    sortMode: "newest",
    densityMode: getStoredDensityMode(),
    messageDetailsById: {},
    messageDetailLoadingId: null,
    messageDetailErrorsById: {},
    expandedMessageIds: {},
    reviewSavingId: null,
    reviewErrorsById: {},
    updatedAt: null,
  };

  function getStoredDensityMode() {
    try {
      const stored = window.localStorage?.getItem(DENSITY_STORAGE_KEY);
      return stored === "compact" ? "compact" : "expanded";
    } catch (error) {
      return "expanded";
    }
  }

  function storeDensityMode(mode) {
    try {
      window.localStorage?.setItem(DENSITY_STORAGE_KEY, mode);
    } catch (error) {
      // Ignore storage failures; density still works for the current session.
    }
  }

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

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatEmailAge(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Age unavailable";
    const diffMs = Math.max(0, Date.now() - date.getTime());
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "Just received";
    if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} old`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} old`;
    const days = Math.floor(hours / 24);
    return `${days} ${days === 1 ? "day" : "days"} old`;
  }

  function safeErrorMessage(code) {
    const messages = {
      mailbox_not_connected: "No persisted Outlook mailbox is connected yet.",
      token_refresh_failed: "Microsoft could not refresh mailbox access. Reconnect Outlook to restore message loading.",
      reconnect_required: "Outlook access needs to be renewed. Reconnect Outlook to continue.",
      graph_messages_failed: "Microsoft Graph could not return the latest messages. Try Refresh, then reconnect if it continues.",
      multiple_active_connections: "More than one active mailbox connection was found. Ask an admin to clean up the connection records.",
      admin_required: "Only active admins can manage the Outlook mailbox connection.",
      configuration_error: "The mailbox Edge Function is missing required server configuration.",
      unauthorized: "Your admin session expired. Sign in again before loading mailbox status.",
      invalid_session: "Your admin session expired. Sign in again before loading messages.",
      missing_authorization: "Your admin session was not sent to the mailbox function.",
      forbidden: "Only active admins can disconnect the Outlook mailbox.",
      disconnect_failed: "Outlook could not be disconnected. Try again, then check the Edge Function logs if it continues.",
      status_lookup_failed: "Mailbox status could not be loaded. Try refreshing the page.",
      connection_lookup_failed: "Mailbox connection records could not be checked. Try refreshing the page.",
      missing_connection_secret: "The mailbox connection is missing its server-side secret. Reconnect Outlook to restore access.",
      refresh_token_decrypt_failed: "Stored mailbox access could not be read. Reconnect Outlook to restore access.",
      outlook_connection_expired: "The temporary Outlook proof expired. Reconnect Outlook to continue.",
      outlook_connection_user_mismatch: "The temporary Outlook proof belongs to another admin session.",
    };
    return messages[code] || "Mailbox status needs attention. Try Refresh, then reconnect if it continues.";
  }

  function setStatus(kicker, title, detail, state = "") {
    if (els.statusKicker) els.statusKicker.textContent = kicker;
    if (els.statusTitle) els.statusTitle.textContent = title;
    if (els.statusDetail) els.statusDetail.textContent = detail;
    if (els.statusPanel) {
      els.statusPanel.classList.toggle("is-success", state === "success");
      els.statusPanel.classList.toggle("is-error", state === "error");
    }
  }

  function setStatusMeta(items = []) {
    if (!els.statusMeta) return;
    if (!items.length) {
      els.statusMeta.classList.add("hidden");
      els.statusMeta.innerHTML = "";
      return;
    }

    els.statusMeta.innerHTML = items.map((item) => `
      <div>
        <dt>${escapeHtml(item.label)}</dt>
        <dd>${escapeHtml(item.value || "--")}</dd>
      </div>
    `).join("");
    els.statusMeta.classList.remove("hidden");
  }

  function setLoading(isLoading) {
    [els.connect, els.refresh, els.disconnect].forEach((button) => {
      if (!button) return;
      button.disabled = isLoading;
      button.setAttribute("aria-busy", isLoading ? "true" : "false");
    });
  }

  function setButtonMode(mode) {
    if (mode === "connected") {
      els.refresh?.classList.remove("hidden", "secondary-btn");
      els.refresh?.classList.add("primary-btn");
      els.disconnect?.classList.remove("hidden");
      if (els.connect) {
        els.connect.classList.remove("hidden", "primary-btn");
        els.connect.classList.add("secondary-btn");
        els.connect.innerHTML = `<i data-lucide="mail-plus"></i> Reconnect Outlook`;
      }
    } else if (mode === "attention") {
      els.refresh?.classList.remove("hidden", "primary-btn");
      els.refresh?.classList.add("secondary-btn");
      els.disconnect?.classList.remove("hidden");
      if (els.connect) {
        els.connect.classList.remove("hidden", "secondary-btn");
        els.connect.classList.add("primary-btn");
        els.connect.innerHTML = `<i data-lucide="mail-plus"></i> Reconnect Outlook`;
      }
    } else {
      els.refresh?.classList.add("hidden");
      els.disconnect?.classList.add("hidden");
      if (els.connect) {
        els.connect.classList.remove("hidden", "secondary-btn");
        els.connect.classList.add("primary-btn");
        els.connect.innerHTML = `<i data-lucide="mail-plus"></i> Connect Outlook Mailbox`;
      }
    }

    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  async function requireAdmin() {
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

    if (els.greeting) {
      const name = employee.display_name ? `, ${employee.display_name}` : "";
      els.greeting.textContent = `Email Triage${name}`;
    }

    return { client, session, employee };
  }

  function functionUrl(functionName) {
    const baseUrl = String(window.SUPABASE_URL || "").replace(/\/+$/, "");
    if (!baseUrl) throw new Error("Missing Supabase URL");
    return `${baseUrl}/functions/v1/${functionName}`;
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
      throw error;
    }
    return payload;
  }

  function normalizeAdminViewPayload(payload) {
    const classifications = Array.isArray(payload?.classifications) ? payload.classifications : [];
    const replayOperations = Array.isArray(payload?.replay_operations) ? payload.replay_operations : [];
    const failedJobs = Array.isArray(payload?.failed_jobs) ? payload.failed_jobs : [];
    const queueSummary = payload?.queue_summary && typeof payload.queue_summary === "object"
      ? payload.queue_summary
      : {};
    const validationDiagnostics = payload?.validation_diagnostics && typeof payload.validation_diagnostics === "object"
      ? payload.validation_diagnostics
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

  async function fetchAdminClassificationView(context, limits = ADMIN_VIEW_DEFAULT_LIMITS) {
    const { data: sessionData, error: sessionError } = await context.client.auth.getSession();
    if (sessionError) console.error("Classification admin session refresh failed:", sessionError);

    const session = sessionData?.session || context.session;
    if (!session?.access_token) {
      const error = new Error("unauthorized");
      error.code = "unauthorized";
      throw error;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), ADMIN_VIEW_TIMEOUT_MS);

    try {
      const payload = await edgeFetch(CLASSIFY_FUNCTION, session, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          mode: "admin_view",
          classificationLimit: limits.classificationLimit || ADMIN_VIEW_DEFAULT_LIMITS.classificationLimit,
          replayLimit: limits.replayLimit || ADMIN_VIEW_DEFAULT_LIMITS.replayLimit,
          failedJobLimit: limits.failedJobLimit || ADMIN_VIEW_DEFAULT_LIMITS.failedJobLimit,
        }),
      });

      return normalizeAdminViewPayload(payload);
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error("request_timeout");
        timeoutError.code = "request_timeout";
        throw timeoutError;
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function fetchMessageDetail(context, messageId) {
    const { data: sessionData, error: sessionError } = await context.client.auth.getSession();
    if (sessionError) console.error("Message detail session refresh failed:", sessionError);

    const session = sessionData?.session || context.session;
    if (!session?.access_token) {
      const error = new Error("unauthorized");
      error.code = "unauthorized";
      throw error;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), MESSAGE_DETAIL_TIMEOUT_MS);

    try {
      return await edgeFetch(CLASSIFY_FUNCTION, session, {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          mode: "message_detail",
          messageId,
        }),
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error("request_timeout");
        timeoutError.code = "request_timeout";
        throw timeoutError;
      }
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function saveClassificationReview(context, values) {
    const { data: sessionData, error: sessionError } = await context.client.auth.getSession();
    if (sessionError) console.error("Review save session refresh failed:", sessionError);

    const session = sessionData?.session || context.session;
    if (!session?.access_token) {
      const error = new Error("unauthorized");
      error.code = "unauthorized";
      throw error;
    }

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

  function humanizeValue(value) {
    return String(value || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
      .trim();
  }

  function formatConfidence(value) {
    const confidence = Number(value);
    if (!Number.isFinite(confidence)) return "--";
    return `${Math.round(confidence * 100)}%`;
  }

  function compactId(value) {
    const text = String(value || "");
    return text ? text.slice(0, 8) : "unknown";
  }

  function classificationTimeMs(classification) {
    const date = new Date(getClassificationReceivedAt(classification) || classification?.created_at || 0);
    const time = date.getTime();
    return Number.isNaN(time) ? 0 : time;
  }

  function confidenceNumber(classification) {
    const confidence = Number(classification?.confidence);
    return Number.isFinite(confidence) ? confidence : -1;
  }

  function workflowPriority(classification) {
    return String(classification?.operator_override_priority || classification?.effective_priority || classification?.priority_level || classification?.priority || "low").toLowerCase();
  }

  function workflowUrgency(classification) {
    const urgency = String(classification?.operator_override_urgency || classification?.effective_urgency || classification?.urgency_level || classification?.urgency || "low").toLowerCase();
    if (urgency === "none" || urgency === "later" || urgency === "soon") return "low";
    return urgency;
  }

  function workflowResponseTiming(classification) {
    const timing = String(classification?.response_timing || "").toLowerCase();
    if (timing) return timing;
    if (workflowUrgency(classification) === "immediate") return "immediate_attention";
    if (workflowUrgency(classification) === "today") return "within_24_hours";
    return classification?.response_needed === true ? "within_72_hours" : "no_response_needed";
  }

  function workflowCustomerRisk(classification) {
    return String(classification?.customer_risk || workflowPriority(classification) || "low").toLowerCase();
  }

  function priorityRank(classification) {
    return { low: 1, medium: 2, high: 3, critical: 4 }[workflowPriority(classification)] || 0;
  }

  function urgencyRank(classification) {
    return { low: 1, today: 2, immediate: 3 }[workflowUrgency(classification)] || 0;
  }

  function responseTimingRank(classification) {
    return {
      no_response_needed: 0,
      within_72_hours: 1,
      within_24_hours: 2,
      immediate_attention: 3,
    }[workflowResponseTiming(classification)] || 0;
  }

  function isImmediateAttention(classification) {
    return workflowUrgency(classification) === "immediate" || workflowResponseTiming(classification) === "immediate_attention";
  }

  function needsResponseToday(classification) {
    return classification?.response_needed === true
      && (workflowUrgency(classification) === "today"
        || workflowUrgency(classification) === "immediate"
        || workflowResponseTiming(classification) === "within_24_hours"
        || workflowResponseTiming(classification) === "immediate_attention");
  }

  function isUrgentWorkflow(classification) {
    return urgencyRank(classification) >= 2 || priorityRank(classification) >= 3 || responseTimingRank(classification) >= 2;
  }

  function sortedClassifications(data, sortMode = "newest") {
    return [...(data?.classifications || [])].sort((left, right) => {
      if (sortMode === "oldest") return classificationTimeMs(left) - classificationTimeMs(right);
      if (sortMode === "confidence_high") return confidenceNumber(right) - confidenceNumber(left);
      if (sortMode === "confidence_low") return confidenceNumber(left) - confidenceNumber(right);
      if (sortMode === "human_review") {
        const reviewDelta = Number(hasHumanReviewSignal(right)) - Number(hasHumanReviewSignal(left));
        if (reviewDelta !== 0) return reviewDelta;
      }
      if (sortMode === "priority_high") {
        const priorityDelta = priorityRank(right) - priorityRank(left);
        if (priorityDelta !== 0) return priorityDelta;
      }
      if (sortMode === "priority_low") {
        const priorityDelta = priorityRank(left) - priorityRank(right);
        if (priorityDelta !== 0) return priorityDelta;
      }
      if (sortMode === "urgency_first") {
        const urgencyDelta = urgencyRank(right) - urgencyRank(left);
        if (urgencyDelta !== 0) return urgencyDelta;
        const priorityDelta = priorityRank(right) - priorityRank(left);
        if (priorityDelta !== 0) return priorityDelta;
      }
      if (sortMode === "immediate_attention") {
        const immediateDelta = Number(isImmediateAttention(right)) - Number(isImmediateAttention(left));
        if (immediateDelta !== 0) return immediateDelta;
        const timingDelta = responseTimingRank(right) - responseTimingRank(left);
        if (timingDelta !== 0) return timingDelta;
      }
      if (sortMode === "oldest_urgent") {
        const urgentDelta = Number(isUrgentWorkflow(right)) - Number(isUrgentWorkflow(left));
        if (urgentDelta !== 0) return urgentDelta;
        if (isUrgentWorkflow(left) && isUrgentWorkflow(right)) return classificationTimeMs(left) - classificationTimeMs(right);
      }
      return classificationTimeMs(right) - classificationTimeMs(left);
    });
  }

  function hasLowConfidenceSignal(classification) {
    const confidence = Number(classification?.confidence);
    return Number.isFinite(confidence) && confidence < LOW_CONFIDENCE_THRESHOLD;
  }

  function hasSafetyFlags(classification) {
    return Array.isArray(classification?.safety_flags) && classification.safety_flags.length > 0;
  }

  function hasHumanReviewSignal(classification) {
    if (isReviewResolved(classification)) return false;
    return classification?.requires_human_review === true
      || hasSafetyFlags(classification)
      || hasLowConfidenceSignal(classification);
  }

  function isReviewResolved(classification) {
    return ["approved", "corrected", "dismissed"].includes(String(classification?.classification_review_state || ""));
  }

  function isInvalidClassification(classification) {
    return String(classification?.validation_status || "").toLowerCase() === "invalid";
  }

  function isOlderThan(classification, thresholdMs) {
    const time = classificationTimeMs(classification);
    return time > 0 && Date.now() - time >= thresholdMs;
  }

  function matchesActiveFilters(classification, activeFilters = []) {
    return activeFilters.every((filter) => {
      if (filter === "needs_review") return classification?.requires_human_review === true;
      if (filter === "low_confidence") return hasLowConfidenceSignal(classification);
      if (filter === "safety_flags") return hasSafetyFlags(classification);
      if (filter === "invalid") return isInvalidClassification(classification);
      if (filter === "older_24h") return isOlderThan(classification, 24 * 60 * 60 * 1000);
      if (filter === "older_3d") return isOlderThan(classification, 3 * 24 * 60 * 60 * 1000);
      if (filter === "critical_priority") return workflowPriority(classification) === "critical";
      if (filter === "high_priority") return workflowPriority(classification) === "high";
      if (filter === "immediate_attention") return isImmediateAttention(classification);
      if (filter === "needs_response_today") return needsResponseToday(classification);
      if (filter === "refund_risk") return classification?.refund_risk === true;
      if (filter === "chargeback_risk") return classification?.chargeback_risk === true;
      return true;
    });
  }

  function categoryMatchesGroup(classification, groupId) {
    if (groupId === "all") return true;
    if (groupId === "human_review") return hasHumanReviewSignal(classification);

    const group = CATEGORY_GROUPS.find((item) => item.id === groupId);
    if (!group) return true;
    return group.categories.includes(String(classification?.effective_category || classification?.category || ""));
  }

  function filteredClassifications(data, groupId, activeFilters = [], sortMode = "newest") {
    return sortedClassifications(data, sortMode).filter((classification) => (
      categoryMatchesGroup(classification, groupId)
      && matchesActiveFilters(classification, activeFilters)
    ));
  }

  function getClassificationTitle(classification) {
    return classification?.subject
      || classification?.message_subject
      || classification?.subject_normalized
      || `Email ${compactId(classification?.message_id)}`;
  }

  function getClassificationSender(classification) {
    const name = classification?.message_sender_name
      || classification?.from_name
      || classification?.sender_name
      || "";
    const email = classification?.message_sender_email
      || classification?.from_email
      || classification?.sender_email
      || "";

    if (name && email) return `${name} <${email}>`;
    return name
      || email
      || classification?.from
      || classification?.from_email
      || classification?.sender_email
      || classification?.from_name
      || classification?.sender_name
      || "Sender unavailable";
  }

  function getClassificationReceivedAt(classification) {
    return classification?.message_received_at || classification?.received_at || "";
  }

  function getClassificationPreview(classification) {
    return classification?.message_body_preview
      || classification?.summary
      || "No body preview available.";
  }

  function renderPillList(values = [], emptyLabel = "None") {
    const safeValues = Array.isArray(values) ? values.filter(Boolean) : [];
    if (!safeValues.length) return `<span class="classification-pill is-muted">${escapeHtml(emptyLabel)}</span>`;
    return safeValues.map((value) => `<span class="classification-pill">${escapeHtml(humanizeValue(value))}</span>`).join("");
  }

  function renderBadge(value, variant = "default") {
    return `<span class="classification-badge is-${escapeHtml(variant)}">${escapeHtml(value)}</span>`;
  }

  function renderSelectOptions(values, selectedValue, emptyLabel = "No override") {
    const selected = String(selectedValue || "");
    return [
      `<option value="">${escapeHtml(emptyLabel)}</option>`,
      ...values.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(humanizeValue(value))}</option>`),
    ].join("");
  }

  function reviewBadgeVariant(classification) {
    const state = String(classification?.classification_review_state || "pending_review");
    if (state === "approved") return "success";
    if (state === "corrected") return "warning";
    if (state === "dismissed") return "muted";
    return "default";
  }

  function confidenceBadgeVariant(classification) {
    if (hasLowConfidenceSignal(classification)) return "warning";
    const confidence = Number(classification?.confidence);
    if (Number.isFinite(confidence) && confidence >= 0.9) return "success";
    return "default";
  }

  function statusBadgeVariant(value) {
    const status = String(value || "").toLowerCase();
    if (status === "valid") return "success";
    if (status === "invalid") return "danger";
    return "muted";
  }

  function actionBadgeVariant(value) {
    const action = String(value || "").toLowerCase();
    if (action.includes("security") || action.includes("escalate")) return "danger";
    if (action.includes("review") || action.includes("refund") || action.includes("return") || action.includes("cancellation")) return "warning";
    return "default";
  }

  function priorityBadgeVariant(classification) {
    const priority = workflowPriority(classification);
    if (priority === "critical") return "critical";
    if (priority === "high") return "danger";
    if (priority === "medium") return "warning";
    return "muted";
  }

  function urgencyBadgeVariant(classification) {
    const urgency = workflowUrgency(classification);
    if (urgency === "immediate") return "critical";
    if (urgency === "today") return "warning";
    return "muted";
  }

  function timingBadgeLabel(classification) {
    const timing = workflowResponseTiming(classification);
    const labels = {
      no_response_needed: "No Response",
      within_72_hours: "72H",
      within_24_hours: "24H",
      immediate_attention: "Immediate",
    };
    return labels[timing] || humanizeValue(timing || "Unknown");
  }

  function timingBadgeVariant(classification) {
    const timing = workflowResponseTiming(classification);
    if (timing === "immediate_attention") return "critical";
    if (timing === "within_24_hours") return "warning";
    if (timing === "within_72_hours") return "default";
    return "muted";
  }

  function renderWorkflowBadges(classification, options = {}) {
    const prefix = options.prefix || "";
    return [
      renderBadge(`${prefix}${humanizeValue(workflowPriority(classification))} Priority`, priorityBadgeVariant(classification)),
      renderBadge(`${prefix}${humanizeValue(workflowUrgency(classification))}`, urgencyBadgeVariant(classification)),
      renderBadge(`${prefix}${timingBadgeLabel(classification)}`, timingBadgeVariant(classification)),
    ].join("");
  }

  function filterToggleLabel(activeCount) {
    if (!activeCount) return "Filters";
    return `Filters (${activeCount} active)`;
  }

  function renderCategorySidebar(state, data) {
    if (!els.classificationCategoryList) return;

    const classifications = data.classifications || [];
    els.classificationCategoryList.innerHTML = CATEGORY_GROUPS.map((group) => {
      const count = group.id === "all"
        ? classifications.filter((classification) => matchesActiveFilters(classification, state.activeFilters)).length
        : classifications.filter((classification) => (
          categoryMatchesGroup(classification, group.id)
          && matchesActiveFilters(classification, state.activeFilters)
        )).length;
      const active = state.selectedCategory === group.id;

      return `
        <button type="button" class="classification-category-button${active ? " is-active" : ""}${group.id === "human_review" ? " is-review" : ""}" data-category-id="${escapeHtml(group.id)}">
          <span>${escapeHtml(group.label)}</span>
          <b>${escapeHtml(count)}</b>
        </button>
      `;
    }).join("");
  }

  function renderClassificationList(state, data) {
    if (!els.classificationList) return;

    const rows = filteredClassifications(data, state.selectedCategory, state.activeFilters, state.sortMode);
    if (!rows.length) {
      const emptyText = data.classifications.length
        ? "No classifications match these filters."
        : "No classified emails returned yet.";
      els.classificationList.innerHTML = `<div class="classification-empty">${escapeHtml(emptyText)}</div>`;
      return;
    }

    const compactMode = state.densityMode === "compact";

    els.classificationList.innerHTML = rows.map((classification) => {
      const selected = state.selectedClassificationId === classification.id;
      const humanReview = hasHumanReviewSignal(classification);
      const receivedAt = getClassificationReceivedAt(classification);
      const dateLabel = receivedAt ? formatDateTime(receivedAt) : `Classified ${formatDateTime(classification.created_at)}`;
      const ageLabel = receivedAt ? formatEmailAge(receivedAt) : formatEmailAge(classification.created_at);
      const categoryBadge = renderBadge(humanizeValue(classification.effective_category || classification.category || "Uncategorized"), "category");
      const overrideBadge = classification.has_operator_override === true ? renderBadge("Override", "warning") : "";
      const reviewStateBadge = renderBadge(humanizeValue(classification.classification_review_state || "Pending Review"), reviewBadgeVariant(classification));
      const confidenceBadge = renderBadge(formatConfidence(classification.confidence), confidenceBadgeVariant(classification));
      const priorityBadge = renderBadge(`${humanizeValue(workflowPriority(classification))} Priority`, priorityBadgeVariant(classification));
      const urgencyBadge = renderBadge(humanizeValue(workflowUrgency(classification)), urgencyBadgeVariant(classification));
      const workflowBadges = renderWorkflowBadges(classification);
      const riskBadges = [
        classification.chargeback_risk === true ? renderBadge("Chargeback Risk", "critical") : "",
        classification.refund_risk === true ? renderBadge("Refund Risk", "danger") : "",
      ].join("");

      if (compactMode) {
        return `
          <button type="button" class="classification-row is-compact${selected ? " is-selected" : ""}" data-classification-id="${escapeHtml(classification.id)}">
            <span class="classification-compact-main">
              <strong>${escapeHtml(getClassificationTitle(classification))}</strong>
              <span>${escapeHtml(getClassificationSender(classification))}</span>
            </span>
            <span class="classification-compact-badges">
              ${categoryBadge}
              ${priorityBadge}
              ${urgencyBadge}
              ${overrideBadge}
            </span>
            <span class="classification-compact-time">${escapeHtml(ageLabel)}</span>
          </button>
        `;
      }

      return `
        <button type="button" class="classification-row${selected ? " is-selected" : ""}" data-classification-id="${escapeHtml(classification.id)}">
          <span class="classification-row-top">
            <strong>${escapeHtml(getClassificationTitle(classification))}</strong>
            ${confidenceBadge}
          </span>
          <span class="classification-row-meta">
            ${categoryBadge}
            <span class="classification-workflow-badges">${workflowBadges}${riskBadges}</span>
          </span>
          <span class="classification-row-meta">
            <span>${escapeHtml(dateLabel)}</span>
          </span>
          <span class="classification-row-meta">
            <span>${escapeHtml(getClassificationSender(classification))}</span>
            <span>${escapeHtml(ageLabel)}</span>
          </span>
          <span class="classification-row-preview">${escapeHtml(getClassificationPreview(classification))}</span>
          ${humanReview ? renderBadge("Human review", "warning") : reviewStateBadge}
          ${overrideBadge}
        </button>
      `;
    }).join("");
  }

  function renderEmailBodySection(state, selected) {
    const messageId = selected?.message_id || "";
    const detail = messageId ? state.messageDetailsById[messageId] : null;
    const error = messageId ? state.messageDetailErrorsById[messageId] : null;
    const isLoading = state.messageDetailLoadingId === messageId;
    const isExpanded = state.expandedMessageIds[messageId] === true;
    const bodyText = detail?.normalized_text || "";
    const bodySource = detail?.body_source ? `Source: ${humanizeValue(detail.body_source)}` : "Preview only";
    const chars = detail
      ? `${Number(detail.body_chars_returned || 0).toLocaleString()} of ${Number(detail.body_chars_original || 0).toLocaleString()} chars`
      : "";

    if (detail && isExpanded) {
      return `
        <div class="classification-detail-section email-body-section">
          <div class="classification-section-title-row">
            <h4>Email Body</h4>
            ${renderBadge(bodySource, "muted")}
          </div>
          ${detail.body_truncated ? `
            <div class="classification-notice is-warning">
              Body is capped for admin viewing. Showing ${escapeHtml(chars)}.
            </div>
          ` : ""}
          <pre class="classification-email-body">${escapeHtml(bodyText || "No body text available.")}</pre>
          <button type="button" class="secondary-btn classification-body-action" data-message-detail-action="collapse" data-message-id="${escapeHtml(messageId)}">
            <i data-lucide="chevron-up"></i>
            Collapse Email
          </button>
        </div>
      `;
    }

    return `
      <div class="classification-detail-section email-body-section">
        <div class="classification-section-title-row">
          <h4>Email Body</h4>
          ${renderBadge(bodySource, "muted")}
        </div>
        <p>${escapeHtml(selected.message_body_preview || "No body preview available.")}</p>
        ${error ? `<div class="classification-notice is-error">Could not load full email text: ${escapeHtml(error)}</div>` : ""}
        <button type="button" class="secondary-btn classification-body-action" data-message-detail-action="${detail ? "expand" : "load"}" data-message-id="${escapeHtml(messageId)}" ${isLoading || !messageId ? "disabled" : ""}>
          <i data-lucide="${isLoading ? "loader-circle" : detail ? "chevron-down" : "file-text"}"></i>
          ${isLoading ? "Loading Email" : "View Full Email"}
        </button>
      </div>
    `;
  }

  function renderOperatorReviewSection(state, selected) {
    const reviewState = String(selected.classification_review_state || "pending_review");
    const saving = state.reviewSavingId === selected.id;
    const error = state.reviewErrorsById[selected.id];
    const effectiveCategory = selected.effective_category || selected.operator_override_category || selected.category || "";
    const effectivePriority = selected.effective_priority || selected.operator_override_priority || selected.priority || "";
    const effectiveUrgency = selected.effective_urgency || selected.operator_override_urgency || selected.urgency || "";

    return `
      <div class="classification-detail-section classification-review-section">
        <div class="classification-section-title-row">
          <h4>Operator Review</h4>
          ${renderBadge(humanizeValue(reviewState), reviewBadgeVariant(selected))}
        </div>
        <div class="classification-compare-grid">
          <div>
            <span>AI Category</span>
            <strong>${escapeHtml(humanizeValue(selected.category || "Uncategorized"))}</strong>
          </div>
          <div>
            <span>Operator Override</span>
            <strong>${escapeHtml(selected.operator_override_category ? humanizeValue(selected.operator_override_category) : "None")}</strong>
          </div>
          <div>
            <span>Effective Category</span>
            <strong>${escapeHtml(humanizeValue(effectiveCategory || "Uncategorized"))}</strong>
          </div>
          <div>
            <span>AI Priority</span>
            <strong>${escapeHtml(humanizeValue(selected.priority || "Unknown"))}</strong>
          </div>
          <div>
            <span>Operator Override</span>
            <strong>${escapeHtml(selected.operator_override_priority ? humanizeValue(selected.operator_override_priority) : "None")}</strong>
          </div>
          <div>
            <span>Effective Priority</span>
            <strong>${escapeHtml(humanizeValue(effectivePriority || "Unknown"))}</strong>
          </div>
          <div>
            <span>AI Urgency</span>
            <strong>${escapeHtml(humanizeValue(selected.urgency || "Unknown"))}</strong>
          </div>
          <div>
            <span>Operator Override</span>
            <strong>${escapeHtml(selected.operator_override_urgency ? humanizeValue(selected.operator_override_urgency) : "None")}</strong>
          </div>
          <div>
            <span>Effective Urgency</span>
            <strong>${escapeHtml(humanizeValue(effectiveUrgency || "Unknown"))}</strong>
          </div>
        </div>
        <div class="classification-review-actions" aria-label="Review actions">
          <button type="button" class="secondary-btn" data-review-state-button="approved">Approve Classification</button>
          <button type="button" class="secondary-btn" data-review-state-button="corrected">Mark Corrected</button>
          <button type="button" class="secondary-btn" data-review-state-button="dismissed">Dismiss Review</button>
        </div>
        <form class="classification-review-form" data-review-form data-classification-id="${escapeHtml(selected.id)}">
          <label>
            <span>Review State</span>
            <select name="reviewState">
              ${REVIEW_STATES.map((value) => `<option value="${escapeHtml(value)}"${value === reviewState ? " selected" : ""}>${escapeHtml(humanizeValue(value))}</option>`).join("")}
            </select>
          </label>
          <label>
            <span>Override Category</span>
            <select name="overrideCategory">${renderSelectOptions(CLASSIFICATION_CATEGORIES, selected.operator_override_category)}</select>
          </label>
          <label>
            <span>Override Priority</span>
            <select name="overridePriority">${renderSelectOptions(OVERRIDE_PRIORITIES, selected.operator_override_priority)}</select>
          </label>
          <label>
            <span>Override Urgency</span>
            <select name="overrideUrgency">${renderSelectOptions(OVERRIDE_URGENCIES, selected.operator_override_urgency)}</select>
          </label>
          <label class="classification-review-notes">
            <span>Operator Notes</span>
            <textarea name="operatorNotes" rows="3" maxlength="2000">${escapeHtml(selected.operator_notes || "")}</textarea>
          </label>
          <div class="classification-effective-strip">
            <span>Effective: ${escapeHtml(humanizeValue(effectiveCategory || "Uncategorized"))}</span>
            <span>${escapeHtml(humanizeValue(effectivePriority || "Unknown"))} priority</span>
            <span>${escapeHtml(humanizeValue(effectiveUrgency || "Unknown"))} urgency</span>
          </div>
          ${selected.reviewed_at ? `<p class="classification-review-meta">Reviewed ${escapeHtml(formatDateTime(selected.reviewed_at))}</p>` : ""}
          ${error ? `<div class="classification-notice is-error">Could not save review: ${escapeHtml(error)}</div>` : ""}
          <button type="button" class="primary-btn classification-review-save" data-review-save ${saving ? "disabled" : ""}>
            <i data-lucide="${saving ? "loader-circle" : "save"}"></i>
            ${saving ? "Saving Review" : "Save Review"}
          </button>
        </form>
      </div>
    `;
  }

  function renderClassificationDetail(state, data) {
    if (!els.classificationDetail) return;

    const selected = (data.classifications || []).find((classification) => classification.id === state.selectedClassificationId);
    if (!selected) {
      els.classificationDetail.innerHTML = `
        <div class="classification-empty">
          Select a classified email to inspect AI triage details.
        </div>
      `;
      return;
    }

    const receivedAt = getClassificationReceivedAt(selected);
    const humanReview = hasHumanReviewSignal(selected);
    const ageLabel = receivedAt ? formatEmailAge(receivedAt) : "Age unavailable";
    const reviewBadge = humanReview ? renderBadge("Human review", "warning") : renderBadge("No review flag", "muted");
    const categoryBadge = renderBadge(humanizeValue(selected.effective_category || selected.category || "Uncategorized"), "category");
    const confidenceBadge = renderBadge(formatConfidence(selected.confidence), confidenceBadgeVariant(selected));
    const validationBadge = renderBadge(humanizeValue(selected.validation_status || "Unknown"), statusBadgeVariant(selected.validation_status));
    const actionBadge = renderBadge(humanizeValue(selected.recommended_action || "Review only"), actionBadgeVariant(selected.recommended_action));
    const workflowBadges = renderWorkflowBadges(selected);
    const reviewStateBadge = renderBadge(humanizeValue(selected.classification_review_state || "Pending Review"), reviewBadgeVariant(selected));
    const overrideBadge = selected.has_operator_override === true ? renderBadge("Operator Override", "warning") : renderBadge("AI Effective", "muted");
    const refundRiskBadge = renderBadge(selected.refund_risk === true ? "Refund Risk" : "No Refund Risk", selected.refund_risk === true ? "danger" : "muted");
    const chargebackRiskBadge = renderBadge(selected.chargeback_risk === true ? "Chargeback Risk" : "No Chargeback Risk", selected.chargeback_risk === true ? "critical" : "muted");
    const customerRiskBadge = renderBadge(`Customer Risk: ${humanizeValue(workflowCustomerRisk(selected))}`, priorityBadgeVariant({ priority_level: workflowCustomerRisk(selected) }));

    els.classificationDetail.innerHTML = `
      <div class="classification-detail-head">
        <span class="eyebrow">${humanReview ? "Human Review" : "Classification"}</span>
        <h3>${escapeHtml(getClassificationTitle(selected))}</h3>
        <div>${escapeHtml(getClassificationSender(selected))}</div>
        <div class="classification-head-badges">
          ${categoryBadge}
          ${workflowBadges}
          ${confidenceBadge}
          ${reviewBadge}
          ${reviewStateBadge}
          ${overrideBadge}
          ${validationBadge}
        </div>
      </div>

      <div class="classification-detail-section">
        <h4>Message</h4>
        <dl class="classification-detail-grid">
          <div>
            <dt>Sender</dt>
            <dd>${escapeHtml(getClassificationSender(selected))}</dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd>${escapeHtml(receivedAt ? formatDateTime(receivedAt) : "Unavailable")}</dd>
          </div>
          <div>
            <dt>Email Age</dt>
            <dd>${escapeHtml(ageLabel)}</dd>
          </div>
          <div>
            <dt>Classified</dt>
            <dd>${escapeHtml(formatDateTime(selected.created_at))}</dd>
          </div>
        </dl>
      </div>

      <div class="classification-detail-section">
        <h4>AI Classification</h4>
        <div class="classification-pill-list">
          ${renderBadge(humanizeValue(selected.category || "Uncategorized"), "category")}
          ${confidenceBadge}
          ${validationBadge}
        </div>
        <p>${escapeHtml(selected.summary || "No AI summary available.")}</p>
      </div>

      ${renderOperatorReviewSection(state, selected)}

      <div class="classification-detail-section">
        <h4>Workflow Priority</h4>
        <dl class="classification-detail-grid classification-workflow-grid">
          <div>
            <dt>Priority</dt>
            <dd>${renderBadge(humanizeValue(workflowPriority(selected)), priorityBadgeVariant(selected))}</dd>
          </div>
          <div>
            <dt>Urgency</dt>
            <dd>${renderBadge(humanizeValue(workflowUrgency(selected)), urgencyBadgeVariant(selected))}</dd>
          </div>
          <div>
            <dt>Response Timing</dt>
            <dd>${renderBadge(timingBadgeLabel(selected), timingBadgeVariant(selected))}</dd>
          </div>
          <div>
            <dt>Customer Risk</dt>
            <dd>${customerRiskBadge}</dd>
          </div>
          <div>
            <dt>Refund Risk</dt>
            <dd>${refundRiskBadge}</dd>
          </div>
          <div>
            <dt>Chargeback Risk</dt>
            <dd>${chargebackRiskBadge}</dd>
          </div>
        </dl>
      </div>

      <div class="classification-detail-section">
        <h4>Recommended Action</h4>
        <div class="classification-pill-list">
          ${actionBadge}
          ${renderBadge(selected.response_needed === true ? "Response needed" : "No response needed", selected.response_needed === true ? "warning" : "muted")}
        </div>
        <p>${escapeHtml(selected.reasoning_summary || "No reasoning summary available.")}</p>
      </div>

      <div class="classification-detail-section">
        <h4>Safety / Review</h4>
        <div class="classification-pill-list">
          ${reviewBadge}
          ${renderPillList(selected.safety_flags, "No safety flags")}
        </div>
        <p>${humanReview ? "Required or recommended based on review flags, safety flags, or confidence." : "No human-review signal returned."}</p>
      </div>

      ${renderEmailBodySection(state, selected)}

      <div class="classification-detail-section">
        <h4>Message Reference</h4>
        <p class="classification-mono">${escapeHtml(selected.message_id || "Unavailable")}</p>
      </div>
    `;

    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function setAdminClassificationState(next) {
    Object.assign(adminClassificationState, next);
    renderAdminClassificationDebug(adminClassificationState);
  }

  function renderAdminClassificationDebug(state) {
    if (!els.classificationAdminDebug) return;

    els.classificationAdminDebug.classList.remove("hidden");
    els.classificationAdminDebug.classList.toggle("is-error", state.fetch_failed || state.unauthorized);
    els.classificationAdminDebug.classList.toggle("is-empty", state.empty_results);
    if (els.refreshClassificationAdmin) {
      els.refreshClassificationAdmin.disabled = state.loading;
      els.refreshClassificationAdmin.setAttribute("aria-busy", state.loading ? "true" : "false");
    }

    const data = state.data || normalizeAdminViewPayload({});
    if (!state.selectedClassificationId && data.classifications.length) {
      const selected = filteredClassifications(data, state.selectedCategory, state.activeFilters, state.sortMode)[0];
      state.selectedClassificationId = selected?.id || null;
    } else if (state.selectedClassificationId && !data.classifications.some((classification) => classification.id === state.selectedClassificationId)) {
      const selected = filteredClassifications(data, state.selectedCategory, state.activeFilters, state.sortMode)[0];
      state.selectedClassificationId = selected?.id || null;
    } else if (state.selectedClassificationId && !filteredClassifications(data, state.selectedCategory, state.activeFilters, state.sortMode).some((classification) => classification.id === state.selectedClassificationId)) {
      const selected = filteredClassifications(data, state.selectedCategory, state.activeFilters, state.sortMode)[0];
      state.selectedClassificationId = selected?.id || null;
    }

    const statusText = {
      idle: "Waiting for admin session.",
      loading: "Fetching admin_view payload.",
      ready: state.empty_results ? "Fetch succeeded. No classification operations returned yet." : "Fetch succeeded. Browse classifications below.",
      fetch_failed: `Fetch failed: ${state.error || "unknown_error"}`,
      unauthorized: "Unauthorized. Sign in again with an active admin account.",
    }[state.status] || "Waiting for admin session.";

    if (els.classificationAdminStatus) els.classificationAdminStatus.textContent = statusText;
    if (els.classificationSort && els.classificationSort.value !== state.sortMode) {
      els.classificationSort.value = state.sortMode;
    }
    const activeFilterCount = state.activeFilters.length;
    const filtersExpanded = state.filtersExpanded === true;
    if (els.classificationFiltersLabel) {
      els.classificationFiltersLabel.textContent = filterToggleLabel(activeFilterCount);
    }
    if (els.classificationFiltersToggle) {
      els.classificationFiltersToggle.setAttribute("aria-expanded", filtersExpanded ? "true" : "false");
      els.classificationFiltersToggle.classList.toggle("has-active-filters", activeFilterCount > 0);
      els.classificationFiltersToggle.classList.toggle("is-expanded", filtersExpanded);
    }
    if (els.classificationFilterPanel) {
      els.classificationFilterPanel.hidden = !filtersExpanded;
      els.classificationFilterPanel.classList.toggle("is-expanded", filtersExpanded);
    }
    els.classificationFilterToggles?.forEach((input) => {
      input.checked = state.activeFilters.includes(input.getAttribute("data-classification-filter"));
    });
    els.classificationDensityInputs?.forEach((input) => {
      input.checked = input.value === state.densityMode;
    });
    els.classificationList?.classList.toggle("is-compact-density", state.densityMode === "compact");

    if (els.classificationAdminSummary) {
      els.classificationAdminSummary.innerHTML = [
        { label: "Queued", value: data.queue_summary.queued },
        { label: "Processing", value: data.queue_summary.processing },
        { label: "Succeeded", value: data.queue_summary.succeeded },
        { label: "Failed", value: data.queue_summary.failed },
        { label: "Valid", value: data.validation_diagnostics.valid_classifications },
        { label: "Invalid", value: data.validation_diagnostics.invalid_classifications },
        { label: "Open Review", value: data.validation_diagnostics.pending_human_review },
        { label: "AI Review Flags", value: data.validation_diagnostics.requires_human_review },
        { label: "Replay Generated", value: data.validation_diagnostics.replay_generated_classifications },
      ].map((item) => `
        <div>
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </div>
      `).join("");
    }

    renderCategorySidebar(state, data);
    renderClassificationList(state, data);
    renderClassificationDetail(state, data);
  }

  async function loadAdminClassificationData(context) {
    setAdminClassificationState({
      status: "loading",
      loading: true,
      fetch_failed: false,
      unauthorized: false,
      empty_results: false,
      error: null,
    });

    try {
      const data = await fetchAdminClassificationView(context);
      const empty = isAdminViewEmpty(data);
      setAdminClassificationState({
        status: "ready",
        loading: false,
        fetch_failed: false,
        unauthorized: false,
        empty_results: empty,
        error: null,
        data,
        updatedAt: new Date().toISOString(),
      });
      console.log("[email-triage] admin_view classification data", data);
    } catch (error) {
      const code = error.code || error.message || "fetch_failed";
      const unauthorized = code === "unauthorized" || code === "invalid_session" || code === "admin_required" || code === "request_failed_401" || code === "request_failed_403";
      setAdminClassificationState({
        status: unauthorized ? "unauthorized" : "fetch_failed",
        loading: false,
        fetch_failed: !unauthorized,
        unauthorized,
        empty_results: false,
        error: code,
        updatedAt: new Date().toISOString(),
      });
      console.error("[email-triage] admin_view classification fetch failed:", error);
    }
  }

  async function loadMessageDetail(context, messageId) {
    if (!messageId) return;
    if (adminClassificationState.messageDetailsById[messageId]) return;

    setAdminClassificationState({
      messageDetailLoadingId: messageId,
      messageDetailErrorsById: {
        ...adminClassificationState.messageDetailErrorsById,
        [messageId]: null,
      },
    });

    try {
      const detail = await fetchMessageDetail(context, messageId);
      setAdminClassificationState({
        messageDetailLoadingId: null,
        messageDetailsById: {
          ...adminClassificationState.messageDetailsById,
          [messageId]: detail,
        },
        expandedMessageIds: {
          ...adminClassificationState.expandedMessageIds,
          [messageId]: true,
        },
        messageDetailErrorsById: {
          ...adminClassificationState.messageDetailErrorsById,
          [messageId]: null,
        },
      });
    } catch (error) {
      const code = error.code || error.message || "message_detail_failed";
      setAdminClassificationState({
        messageDetailLoadingId: null,
        messageDetailErrorsById: {
          ...adminClassificationState.messageDetailErrorsById,
          [messageId]: code,
        },
      });
      console.error("[email-triage] message_detail fetch failed:", error);
    }
  }

  async function saveSelectedReview(context, values) {
    const classificationId = values.classificationId;
    if (!classificationId) return;

    setAdminClassificationState({
      reviewSavingId: classificationId,
      reviewErrorsById: {
        ...adminClassificationState.reviewErrorsById,
        [classificationId]: null,
      },
    });

    try {
      const result = await saveClassificationReview(context, values);
      const data = adminClassificationState.data || normalizeAdminViewPayload({});
      const classifications = (data.classifications || []).map((classification) => {
        if (classification.id !== classificationId) return classification;
        return {
          ...classification,
          classification_review_state: result.classification_review_state,
          operator_override_category: result.operator_override_category,
          operator_override_priority: result.operator_override_priority,
          operator_override_urgency: result.operator_override_urgency,
          operator_notes: result.operator_notes,
          reviewed_by: result.reviewed_by,
          reviewed_at: result.reviewed_at,
          effective_category: result.effective_category,
          effective_priority: result.effective_priority,
          effective_urgency: result.effective_urgency,
          has_operator_override: result.has_operator_override === true,
        };
      });

      setAdminClassificationState({
        reviewSavingId: null,
        reviewErrorsById: {
          ...adminClassificationState.reviewErrorsById,
          [classificationId]: null,
        },
        data: {
          ...data,
          classifications,
        },
      });
    } catch (error) {
      const code = error.code || error.message || "review_save_failed";
      setAdminClassificationState({
        reviewSavingId: null,
        reviewErrorsById: {
          ...adminClassificationState.reviewErrorsById,
          [classificationId]: code,
        },
      });
      console.error("[email-triage] review save failed:", error);
    }
  }

  async function loadMailboxStatus(context) {
    return edgeFetch(STATUS_FUNCTION, context.session, { method: "GET" });
  }

  function renderConnectionStatus(connection) {
    const status = String(connection?.status || "").toLowerCase();
    const email = connection?.mailbox_email || "Unknown mailbox";
    const displayName = connection?.display_name || "Not provided";
    const lastChecked = connection?.last_successful_check_at || connection?.updated_at || "";
    const lastError = connection?.last_error_code || "none";

    setStatusMeta([
      { label: "Connected mailbox", value: email },
      { label: "Display name", value: displayName },
      { label: "Status", value: status || "connected" },
      { label: "Last checked", value: formatDateTime(lastChecked) },
      { label: "Last error", value: lastError },
    ]);

    if (status === "error" || status === "reconnect_required") {
      setButtonMode("attention");
      setStatus(
        "Mailbox needs attention",
        "Outlook connection needs attention",
        safeErrorMessage(connection?.last_error_code || status),
        "error",
      );
      return false;
    }

    setButtonMode("connected");
    setStatus(
      "Connected",
      `Outlook mailbox connected: ${email}`,
      "Latest messages will load automatically from the persisted mailbox connection.",
      "success",
    );
    return true;
  }

  function renderDisconnectedStatus() {
    setButtonMode("disconnected");
    setStatusMeta([]);
    els.messagesSection?.classList.add("hidden");
    renderMessages([]);
    setStatus("Not connected", "Outlook connection required", "Connect the OG mailbox to display the latest 10 messages.");
  }

  function renderMessages(messages = []) {
    if (!els.messagesBody) return;

    if (!messages.length) {
      els.messagesBody.innerHTML = `<tr><td colspan="4">No Outlook messages returned.</td></tr>`;
    } else {
      els.messagesBody.innerHTML = messages.map((message) => `
        <tr>
          <td class="email-sender">${escapeHtml(message.from || "Unknown sender")}</td>
          <td class="email-subject">${escapeHtml(message.subject || "(No subject)")}</td>
          <td class="email-received">${escapeHtml(formatDateTime(message.receivedDateTime))}</td>
          <td class="email-preview">${escapeHtml(message.bodyPreview || "")}</td>
        </tr>
      `).join("");
    }

    if (els.countPill) {
      const count = messages.length;
      els.countPill.textContent = `${count} ${count === 1 ? "message" : "messages"}`;
    }
  }

  async function loadMessages(context) {
    setLoading(true);
    setStatus("Checking", "Reading latest Outlook emails", "Calling Microsoft Graph through the Supabase Edge Function.");

    try {
      const payload = await edgeFetch(MESSAGES_FUNCTION, context.session, { method: "POST", body: "{}" });
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      renderMessages(messages);
      els.messagesSection?.classList.remove("hidden");
      setButtonMode("connected");
      setStatus("Connected", "Outlook mailbox connected", `Loaded ${messages.length} sanitized message previews.`, "success");
    } catch (error) {
      const code = error.code || error.message;
      renderMessages([]);
      els.messagesSection?.classList.add("hidden");
      setButtonMode(code === "mailbox_not_connected" ? "disconnected" : "attention");
      setStatus("Mailbox needs attention", "Could not load Outlook emails", safeErrorMessage(code), "error");
    } finally {
      setLoading(false);
    }
  }

  async function connectOutlook(context) {
    setLoading(true);
    setStatus("Redirecting", "Opening Microsoft login", "You will return here after Microsoft authorizes mailbox read access.");

    try {
      const payload = await edgeFetch(START_FUNCTION, context.session, {
        method: "POST",
        body: JSON.stringify({ returnTo: window.location.href.split("?")[0] }),
      });

      if (!payload.authorizationUrl) throw new Error("Microsoft authorization URL was not returned.");
      window.location.href = payload.authorizationUrl;
    } catch (error) {
      setStatus("Error", "Could not start Microsoft login", error.message || "Try again after checking Edge Function configuration.", "error");
      setLoading(false);
    }
  }

  async function disconnectOutlook(context) {
    const confirmed = window.confirm("Disconnect Outlook for email triage? This removes the stored server-side refresh token and stops automatic mailbox loading.");
    if (!confirmed) return;

    setLoading(true);
    setStatus("Disconnecting", "Disconnecting Outlook mailbox", "Removing the persisted mailbox secret from the server.");

    try {
      await edgeFetch(DISCONNECT_FUNCTION, context.session, {
        method: "POST",
        body: "{}",
      });
      renderDisconnectedStatus();
      setStatus(
        "Disconnected",
        "Outlook mailbox disconnected",
        "Connect Outlook Mailbox is available when you are ready to reconnect.",
      );
    } catch (error) {
      const code = error.code || error.message;
      if (code === "mailbox_not_connected") {
        renderDisconnectedStatus();
        return;
      }
      setButtonMode("attention");
      setStatus("Mailbox needs attention", "Could not disconnect Outlook", safeErrorMessage(code), "error");
    } finally {
      setLoading(false);
    }
  }

  function handleOutlookQueryNotice() {
    const params = new URLSearchParams(window.location.search);
    const outlook = params.get("outlook");
    if (!outlook) return;

    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);

    if (outlook === "error") {
      const reason = params.get("reason") || "reconnect_required";
      setStatus("Mailbox needs attention", "Microsoft login did not finish", safeErrorMessage(reason), "error");
    }
  }

  function bindClassificationInboxEvents(context) {
    els.classificationCategoryList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-category-id]");
      if (!button) return;

      const selectedCategory = button.getAttribute("data-category-id") || "all";
      const data = adminClassificationState.data || normalizeAdminViewPayload({});
      const firstMatch = filteredClassifications(
        data,
        selectedCategory,
        adminClassificationState.activeFilters,
        adminClassificationState.sortMode,
      )[0] || null;

      setAdminClassificationState({
        selectedCategory,
        selectedClassificationId: firstMatch?.id || null,
      });
    });

    els.classificationList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-classification-id]");
      if (!button) return;

      setAdminClassificationState({
        selectedClassificationId: button.getAttribute("data-classification-id"),
      });
    });

    els.classificationDetail?.addEventListener("click", (event) => {
      const reviewStateButton = event.target.closest("[data-review-state-button]");
      if (reviewStateButton) {
        const form = reviewStateButton.closest(".classification-review-section")?.querySelector("[data-review-form]");
        const stateSelect = form?.querySelector("select[name='reviewState']");
        const nextState = reviewStateButton.getAttribute("data-review-state-button") || "pending_review";
        if (stateSelect) stateSelect.value = nextState;
        if (nextState === "approved" || nextState === "dismissed") {
          form?.querySelectorAll("select[name='overrideCategory'], select[name='overridePriority'], select[name='overrideUrgency']")
            .forEach((select) => { select.value = ""; });
        }
        return;
      }

      const saveButton = event.target.closest("[data-review-save]");
      if (saveButton) {
        const form = saveButton.closest("[data-review-form]");
        const classificationId = form?.getAttribute("data-classification-id");
        if (!form || !classificationId) return;
        const formData = new FormData(form);
        saveSelectedReview(context, {
          classificationId,
          reviewState: String(formData.get("reviewState") || "pending_review"),
          overrideCategory: String(formData.get("overrideCategory") || ""),
          overridePriority: String(formData.get("overridePriority") || ""),
          overrideUrgency: String(formData.get("overrideUrgency") || ""),
          operatorNotes: String(formData.get("operatorNotes") || ""),
        });
        return;
      }

      const button = event.target.closest("[data-message-detail-action]");
      if (!button) return;
      const messageId = button.getAttribute("data-message-id");
      const action = button.getAttribute("data-message-detail-action");
      if (action === "collapse") {
        setAdminClassificationState({
          expandedMessageIds: {
            ...adminClassificationState.expandedMessageIds,
            [messageId]: false,
          },
        });
        return;
      }
      if (action === "expand") {
        setAdminClassificationState({
          expandedMessageIds: {
            ...adminClassificationState.expandedMessageIds,
            [messageId]: true,
          },
        });
        return;
      }
      loadMessageDetail(context, messageId);
    });

    els.classificationSort?.addEventListener("change", (event) => {
      const sortMode = event.target.value || "newest";
      const data = adminClassificationState.data || normalizeAdminViewPayload({});
      const firstMatch = filteredClassifications(
        data,
        adminClassificationState.selectedCategory,
        adminClassificationState.activeFilters,
        sortMode,
      )[0] || null;

      setAdminClassificationState({
        sortMode,
        selectedClassificationId: firstMatch?.id || null,
      });
    });

    els.classificationFiltersToggle?.addEventListener("click", () => {
      setAdminClassificationState({
        filtersExpanded: !adminClassificationState.filtersExpanded,
      });
    });

    els.classificationDensityInputs?.forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const densityMode = input.value === "compact" ? "compact" : "expanded";
        storeDensityMode(densityMode);
        setAdminClassificationState({ densityMode });
      });
    });

    els.classificationFilterToggles?.forEach((input) => {
      input.addEventListener("change", () => {
        const activeFilters = [...(els.classificationFilterToggles || [])]
          .filter((item) => item.checked)
          .map((item) => item.getAttribute("data-classification-filter"))
          .filter(Boolean);
        const data = adminClassificationState.data || normalizeAdminViewPayload({});
        const firstMatch = filteredClassifications(
          data,
          adminClassificationState.selectedCategory,
          activeFilters,
          adminClassificationState.sortMode,
        )[0] || null;

        setAdminClassificationState({
          activeFilters,
          selectedClassificationId: firstMatch?.id || null,
        });
      });
    });
  }

  async function init() {
    const context = await requireAdmin();
    if (!context) return;

    els.connect?.addEventListener("click", () => connectOutlook(context));
    els.refresh?.addEventListener("click", () => loadMessages(context));
    els.disconnect?.addEventListener("click", () => disconnectOutlook(context));
    els.refreshClassificationAdmin?.addEventListener("click", () => loadAdminClassificationData(context));
    bindClassificationInboxEvents(context);

    handleOutlookQueryNotice();
    loadAdminClassificationData(context);

    setLoading(true);
    setStatus("Checking", "Checking persisted Outlook connection", "Loading mailbox status from the Supabase Edge Function.");
    try {
      const payload = await loadMailboxStatus(context);
      if (payload.connected && payload.connection) {
        const canAutoLoad = renderConnectionStatus(payload.connection);
        setLoading(false);
        if (canAutoLoad) await loadMessages(context);
      } else {
        renderDisconnectedStatus();
        setLoading(false);
      }
    } catch (error) {
      setButtonMode("attention");
      setStatusMeta([]);
      setStatus("Mailbox needs attention", "Could not load mailbox status", safeErrorMessage(error.code || error.message), "error");
      setLoading(false);
    }

    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  init().catch((error) => {
    console.error("Email triage initialization failed:", error);
    setStatus("Error", "Email triage could not initialize", error.message || "Unexpected setup error.", "error");
  });
})();
