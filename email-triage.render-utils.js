(function () {
  "use strict";

  const LOW_CONFIDENCE_THRESHOLD = 0.75;
  const DENSITY_STORAGE_KEY = "og-email-triage-density";
  const PANEL_WIDTHS_STORAGE_KEY = "og-email-triage-panel-widths";
  const PANEL_WIDTH_LIMITS = {
    category: { min: 150, max: 340, fallback: 220 },
    detail: { min: 300, max: 680, fallback: 420 },
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

  function clampNumber(value, min, max) {
    return Math.min(Math.max(Number(value) || 0, min), max);
  }

  function getStoredPanelWidths() {
    try {
      const parsed = JSON.parse(window.localStorage?.getItem(PANEL_WIDTHS_STORAGE_KEY) || "{}");
      return {
        category: clampNumber(parsed.category, PANEL_WIDTH_LIMITS.category.min, PANEL_WIDTH_LIMITS.category.max) || PANEL_WIDTH_LIMITS.category.fallback,
        detail: clampNumber(parsed.detail, PANEL_WIDTH_LIMITS.detail.min, PANEL_WIDTH_LIMITS.detail.max) || PANEL_WIDTH_LIMITS.detail.fallback,
      };
    } catch (error) {
      return {
        category: PANEL_WIDTH_LIMITS.category.fallback,
        detail: PANEL_WIDTH_LIMITS.detail.fallback,
      };
    }
  }

  function storePanelWidths(widths) {
    try {
      window.localStorage?.setItem(PANEL_WIDTHS_STORAGE_KEY, JSON.stringify(widths));
    } catch (error) {
      // Panel resizing is still useful for the current session if storage is unavailable.
    }
  }

  function applyPanelWidths(shell, widths = getStoredPanelWidths()) {
    if (!shell) return;
    const categoryWidth = clampNumber(widths.category, PANEL_WIDTH_LIMITS.category.min, PANEL_WIDTH_LIMITS.category.max);
    const detailWidth = clampNumber(widths.detail, PANEL_WIDTH_LIMITS.detail.min, PANEL_WIDTH_LIMITS.detail.max);
    shell.style.setProperty("--category-panel-width", `${categoryWidth}px`);
    shell.style.setProperty("--detail-panel-width", `${detailWidth}px`);
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

  function formatCompactEmailAge(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    const diffMs = Math.max(0, Date.now() - date.getTime());
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo`;
    return `${Math.floor(months / 12)}y`;
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
        if (reviewDelta) return reviewDelta;
        return classificationTimeMs(right) - classificationTimeMs(left);
      }
      if (sortMode === "priority_high") {
        const priorityDelta = priorityRank(right) - priorityRank(left);
        if (priorityDelta) return priorityDelta;
        return classificationTimeMs(right) - classificationTimeMs(left);
      }
      if (sortMode === "priority_low") {
        const priorityDelta = priorityRank(left) - priorityRank(right);
        if (priorityDelta) return priorityDelta;
        return classificationTimeMs(right) - classificationTimeMs(left);
      }
      if (sortMode === "urgency_first") {
        const urgencyDelta = urgencyRank(right) - urgencyRank(left);
        if (urgencyDelta) return urgencyDelta;
        const priorityDelta = priorityRank(right) - priorityRank(left);
        if (priorityDelta) return priorityDelta;
        return classificationTimeMs(right) - classificationTimeMs(left);
      }
      if (sortMode === "immediate_attention") {
        const immediateDelta = Number(isImmediateAttention(right)) - Number(isImmediateAttention(left));
        if (immediateDelta) return immediateDelta;
        const timingDelta = responseTimingRank(right) - responseTimingRank(left);
        if (timingDelta) return timingDelta;
        return classificationTimeMs(right) - classificationTimeMs(left);
      }
      if (sortMode === "oldest_urgent") {
        const urgentDelta = Number(isUrgentWorkflow(right)) - Number(isUrgentWorkflow(left));
        if (urgentDelta) return urgentDelta;
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

  function categoryMatchesGroup(classification, groupId, groups = []) {
    if (groupId === "all") return true;
    if (groupId === "human_review") return hasHumanReviewSignal(classification);

    const group = groups.find((item) => item.id === groupId);
    if (!group) return true;
    return group.categories.includes(String(classification?.effective_category || classification?.category || ""));
  }

  function filteredClassifications(data, groupId, activeFilters = [], sortMode = "newest", groups = []) {
    return sortedClassifications(data, sortMode).filter((classification) => (
      categoryMatchesGroup(classification, groupId, groups)
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
    if (status === "warning") return "warning";
    if (status === "error") return "danger";
    if (status === "approved") return "success";
    if (status === "rejected") return "danger";
    if (status === "reviewing") return "warning";
    if (status === "generated") return "default";
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

  function renderWorkflowMetaText(classification, ageLabel = "", options = {}) {
    const items = [
      options.includeCategory ? humanizeValue(classification.effective_category || classification.category || "Uncategorized") : "",
      `${humanizeValue(workflowPriority(classification))} Priority`,
      humanizeValue(workflowUrgency(classification)),
      timingBadgeLabel(classification),
      ageLabel,
    ].filter(Boolean);
    const riskItems = [
      classification.chargeback_risk === true ? "Chargeback Risk" : "",
      classification.refund_risk === true ? "Refund Risk" : "",
    ].filter(Boolean);
    const reviewText = humanizeValue(classification.classification_review_state || "Pending Review");
    const overrideText = classification.has_operator_override === true ? "Override" : "";
    return `
      <span class="classification-secondary-meta">
        ${items.map((item, index) => `<span${options.includeCategory && index === 0 ? ' class="is-category-text"' : ""}>${escapeHtml(item)}</span>`).join("")}
        ${riskItems.map((item) => `<span class="is-risk">${escapeHtml(item)}</span>`).join("")}
        <span>${escapeHtml(reviewText)}</span>
        ${overrideText ? `<span>${escapeHtml(overrideText)}</span>` : ""}
      </span>
    `;
  }

  function filterToggleLabel(activeCount) {
    if (!activeCount) return "Filters";
    return `Filters (${activeCount} active)`;
  }

  window.EmailTriageRenderUtils = {
    LOW_CONFIDENCE_THRESHOLD,
    DENSITY_STORAGE_KEY,
    PANEL_WIDTHS_STORAGE_KEY,
    PANEL_WIDTH_LIMITS,
    getStoredDensityMode,
    storeDensityMode,
    clampNumber,
    getStoredPanelWidths,
    storePanelWidths,
    applyPanelWidths,
    escapeHtml,
    formatDateTime,
    formatEmailAge,
    formatCompactEmailAge,
    safeErrorMessage,
    humanizeValue,
    formatConfidence,
    compactId,
    classificationTimeMs,
    confidenceNumber,
    workflowPriority,
    workflowUrgency,
    workflowResponseTiming,
    workflowCustomerRisk,
    priorityRank,
    urgencyRank,
    responseTimingRank,
    isImmediateAttention,
    needsResponseToday,
    isUrgentWorkflow,
    sortedClassifications,
    hasLowConfidenceSignal,
    hasSafetyFlags,
    hasHumanReviewSignal,
    isReviewResolved,
    isInvalidClassification,
    isOlderThan,
    matchesActiveFilters,
    categoryMatchesGroup,
    filteredClassifications,
    getClassificationTitle,
    getClassificationSender,
    getClassificationReceivedAt,
    getClassificationPreview,
    renderPillList,
    renderBadge,
    renderSelectOptions,
    reviewBadgeVariant,
    confidenceBadgeVariant,
    statusBadgeVariant,
    actionBadgeVariant,
    priorityBadgeVariant,
    urgencyBadgeVariant,
    timingBadgeLabel,
    timingBadgeVariant,
    renderWorkflowMetaText,
    filterToggleLabel,
  };
})();
