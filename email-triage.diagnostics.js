(function () {
  "use strict";

  function queueSummaryItems(data = {}) {
    return [
      { label: "Queued", value: data.queue_summary?.queued },
      { label: "Processing", value: data.queue_summary?.processing },
      { label: "Succeeded", value: data.queue_summary?.succeeded },
      { label: "Failed", value: data.queue_summary?.failed },
    ];
  }

  function safetySummaryItems(data = {}) {
    return [
      { label: "Valid", value: data.validation_diagnostics?.valid_classifications },
      { label: "Invalid", value: data.validation_diagnostics?.invalid_classifications },
      { label: "Open Review", value: data.validation_diagnostics?.pending_human_review },
      { label: "AI Review Flags", value: data.validation_diagnostics?.requires_human_review },
    ];
  }

  function replaySummaryItems(data = {}) {
    return [
      { label: "Replay Generated", value: data.validation_diagnostics?.replay_generated_classifications },
    ];
  }

  function renderSummaryItems(items = [], utils = window.EmailTriageRenderUtils) {
    return items.map((item) => `
      <div>
        <span>${utils.escapeHtml(item.label)}</span>
        <strong>${utils.escapeHtml(item.value ?? 0)}</strong>
      </div>
    `).join("");
  }

  function renderAdminSummary(data = {}, utils = window.EmailTriageRenderUtils) {
    return renderSummaryItems([
      ...queueSummaryItems(data),
      ...safetySummaryItems(data),
      ...replaySummaryItems(data),
    ], utils);
  }

  function dashboardBadge(label, variant = "muted", utils = window.EmailTriageRenderUtils) {
    return `<span class="inbox-chip is-${utils.escapeHtml(variant)}">${utils.escapeHtml(label)}</span>`;
  }

  function formatAgeSeconds(seconds, utils = window.EmailTriageRenderUtils) {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return "--";
    if (value < 60) return `${Math.max(Math.round(value), 0)}s`;
    if (value < 3600) return `${Math.round(value / 60)}m`;
    if (value < 86400) return `${Math.round(value / 3600)}h`;
    return `${Math.round(value / 86400)}d`;
  }

  function firstValue(values = []) {
    return values.find((value) => value !== undefined && value !== null && value !== "") ?? null;
  }

  function operationTitle(event = {}, utils = window.EmailTriageRenderUtils) {
    return utils.humanizeValue(event.event_type || "No event");
  }

  function operationMeta(event = {}, utils = window.EmailTriageRenderUtils) {
    if (!event) return "--";
    const pieces = [
      event.id ? `id ${utils.compactId(event.id)}` : "",
      event.created_at ? utils.formatDateTime(event.created_at) : "",
      event.initiated_by ? `by ${event.initiated_by}` : "",
    ].filter(Boolean);
    return pieces.join(" · ") || "--";
  }

  function renderKeyValueGrid(items = [], utils = window.EmailTriageRenderUtils) {
    return items.map((item) => `
      <div>
        <span>${utils.escapeHtml(item.label)}</span>
        <strong>${item.html || utils.escapeHtml(item.value ?? "--")}</strong>
      </div>
    `).join("");
  }

  function renderActivityRows(snapshot = {}, utils = window.EmailTriageRenderUtils) {
    const activity = snapshot.activity || {};
    const rows = [
      ["Latest live refresh", activity.latest_live_refresh, activity.timing?.latest_live_refresh_at],
      ["Latest import", activity.latest_import, activity.timing?.latest_import_at],
      ["Latest processing", activity.latest_processing, activity.timing?.latest_process_operation_at || activity.timing?.latest_processing_at],
      ["Latest classification", activity.latest_classification, activity.timing?.latest_classification_at],
      ["Latest rematch", activity.latest_rematch, activity.timing?.latest_rematch_at],
      ["Latest replay", activity.latest_replay, snapshot.replay?.latest_operation_at],
      ["Latest failed operation", activity.latest_failed_operation, null],
    ];

    return rows.map(([label, event, fallbackAt]) => `
      <div class="operational-row">
        <span>${utils.escapeHtml(label)}</span>
        <strong>${utils.escapeHtml(event ? operationTitle(event, utils) : (fallbackAt ? "Recorded" : "None"))}</strong>
        <em>${utils.escapeHtml(event ? operationMeta(event, utils) : (fallbackAt ? utils.formatDateTime(fallbackAt) : "--"))}</em>
      </div>
    `).join("");
  }

  function renderChildOperations(event = {}, utils = window.EmailTriageRenderUtils) {
    const children = Object.entries(event.child_operations || {}).filter(([, value]) => value);
    if (!children.length) return "";
    return `
      <div class="operational-child-refs">
        ${children.map(([key, value]) => `<b>${utils.escapeHtml(utils.humanizeValue(key))}: <em>${utils.escapeHtml(utils.compactId(value))}</em></b>`).join("")}
      </div>
    `;
  }

  function renderOperationalEventRows(events = [], utils = window.EmailTriageRenderUtils) {
    if (!events.length) {
      return `<div class="classification-empty operational-empty">No operational events returned yet.</div>`;
    }

    return events.slice(0, 12).map((event) => {
      const counters = event.counters && typeof event.counters === "object" ? event.counters : {};
      const safety = event.safety && typeof event.safety === "object" ? event.safety : {};
      const countParts = [
        Number(counters.previewed_count || 0) ? `${counters.previewed_count} previewed` : "",
        Number(event.message_count || 0) ? `${event.message_count} messages` : "",
        Number(event.new_job_count || 0) ? `${event.new_job_count} new jobs` : "",
        Number(counters.imported_count || 0) ? `${counters.imported_count} imported` : "",
        Number(counters.already_imported_count || 0) ? `${counters.already_imported_count} already` : "",
        Number(counters.processed_count || 0) ? `${counters.processed_count} processed` : "",
        Number(counters.jobs_enqueued || 0) ? `${counters.jobs_enqueued} jobs enqueued` : "",
        Number(counters.classified_count || 0) ? `${counters.classified_count} classified` : "",
        Number(counters.rematched_count || 0) ? `${counters.rematched_count} rematched` : "",
        Number(counters.links_created || 0) ? `${counters.links_created} links created` : "",
        Number(counters.links_updated || 0) ? `${counters.links_updated} links updated` : "",
        Number(counters.ambiguous_count || 0) ? `${counters.ambiguous_count} ambiguous` : "",
        Number(counters.skipped_count || 0) ? `${counters.skipped_count} skipped` : "",
        Number(counters.failed_count || 0) ? `${counters.failed_count} failed` : "",
        Number(counters.duration_ms || 0) ? `${Math.round(Number(counters.duration_ms || 0) / 1000)}s` : "",
      ].filter(Boolean);
      const isReplay = String(event.event_type || "").includes("replay") || String(event.event_type || "").includes("requeue");
      const isFailure = String(event.status || "").includes("fail") || Number(counters.failed_count || 0) > 0;
      const safetyParts = [
        safety.outlook_fetch_performed === false ? "Outlook fetch false" : "",
        safety.outlook_mutation_performed === false ? "Outlook mutation false" : "",
        safety.ebay_mutation_performed === false ? "eBay mutation false" : "",
        safety.classification_triggered === false ? "Classification false" : "",
        Number(safety.drafts_created || 0) === 0 && Object.prototype.hasOwnProperty.call(safety, "drafts_created") ? "Drafts 0" : "",
      ].filter(Boolean);

      return `
        <article class="operational-event-row${isReplay ? " is-replay" : ""}${isFailure ? " is-failure" : ""}">
          <div>
            <strong>${utils.escapeHtml(operationTitle(event, utils))}</strong>
            <span>${utils.escapeHtml(operationMeta(event, utils))}</span>
          </div>
          <p>${utils.escapeHtml(firstValue([event.reason, event.replay_source, "No reason recorded"]))}</p>
          <div class="operational-event-counts">
            ${countParts.length ? countParts.map((part) => dashboardBadge(part, part.includes("failed") ? "danger" : "muted", utils)).join("") : dashboardBadge("No counts", "muted", utils)}
            ${event.status ? dashboardBadge(utils.humanizeValue(event.status), isFailure ? "danger" : "success", utils) : ""}
            ${safetyParts.map((part) => dashboardBadge(part, "success", utils)).join("")}
          </div>
          ${renderChildOperations(event, utils)}
        </article>
      `;
    }).join("");
  }

  function renderFailureReasons(reasons = {}, utils = window.EmailTriageRenderUtils) {
    const rows = Object.entries(reasons)
      .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))
      .slice(0, 8);
    if (!rows.length) return `<div class="classification-empty operational-empty">No failure reasons reported.</div>`;
    return rows.map(([reason, count]) => `
      <div class="operational-reason-row">
        <span>${utils.escapeHtml(utils.humanizeValue(reason))}</span>
        <strong>${utils.escapeHtml(count)}</strong>
      </div>
    `).join("");
  }

  function renderOperationalNote(text, utils = window.EmailTriageRenderUtils) {
    return `<div class="classification-empty operational-empty">${utils.escapeHtml(text)}</div>`;
  }

  function renderOperationalDashboard(state = {}, utils = window.EmailTriageRenderUtils) {
    const snapshot = state.operationalDashboardSnapshot;
    if (state.operationalDashboardLoading && !snapshot) {
      return `<div class="workspace-status operational-dashboard-status">Loading operational dashboard.</div>`;
    }
    if (!snapshot) {
      return `<div class="workspace-status operational-dashboard-status">Refresh dashboard to load operational visibility.</div>`;
    }

    const mailbox = snapshot.mailbox || {};
    const queue = snapshot.queue || {};
    const failures = snapshot.failures || {};
    const safety = snapshot.safety || {};
    const gaps = snapshot.pipeline_gaps || {};
    const visibility = snapshot.pipeline_visibility || {};
    const connected = mailbox.connected && String(mailbox.status || "").toLowerCase() !== "disconnected";
    const visibleGapCount = Number(visibility.imported_without_processing_count || 0)
      + Number(visibility.processed_without_classification_count || 0)
      + Number(visibility.unclassified_imported_total || 0)
      + Number(visibility.processing_failed_jobs || 0)
      + Number(visibility.classification_failed_jobs || 0)
      + Number(visibility.classification_skipped_jobs || 0);
    const gapCount = visibleGapCount || Number(gaps.imported_without_processing || 0) + Number(gaps.processed_without_classification || 0);
    const blocked = queue.saturated || gapCount > 0 || safety.outlook_mutation_performed || safety.automatic_responses_sent > 0 || safety.polling_started || safety.scheduler_started || safety.realtime_listener_started;
    const visibilityLimited = visibility.is_limited === true;
    const visibilityScopeLabel = visibilityLimited
      ? `sampled ${visibility.sampled_imported_count || 0} of ${visibility.active_imported_total || 0}`
      : "table-derived";

    return `
      <div class="operational-dashboard-status">
        <span>${state.operationalDashboardLoading ? "Refreshing dashboard" : `Dashboard refreshed ${utils.formatDateTime(state.operationalDashboardUpdatedAt || snapshot.generated_at)}`}</span>
        ${state.operationalDashboardError ? dashboardBadge(`Error: ${state.operationalDashboardError}`, "danger", utils) : ""}
        ${dashboardBadge(blocked ? "Attention needed" : "Safe visibility mode", blocked ? "warning" : "success", utils)}
      </div>

      <div class="operational-dashboard-grid">
        <section class="operational-panel">
          <div class="operational-panel-head">
            <strong>Mailbox Status</strong>
            ${dashboardBadge(connected ? "Connected" : "Disconnected", connected ? "success" : "warning", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Mailbox", value: mailbox.mailbox_email || "Unavailable" },
              { label: "Identity", value: mailbox.display_name || "Not provided" },
              { label: "Last checked", value: mailbox.last_checked_at ? utils.formatDateTime(mailbox.last_checked_at) : "--" },
              { label: "Live sync enabled", html: dashboardBadge(mailbox.live_sync_enabled ? "true" : "false", mailbox.live_sync_enabled ? "success" : "muted", utils) },
            ], utils)}
          </div>
        </section>

        <section class="operational-panel">
          <div class="operational-panel-head">
            <strong>Queue Health</strong>
            ${dashboardBadge(queue.saturated ? "Saturated" : "Within bounds", queue.saturated ? "danger" : "success", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Queued jobs", value: queue.queued },
              { label: "Running jobs", value: queue.running },
              { label: "Failed jobs", value: queue.failed },
              { label: "Oldest queued age", value: queue.oldest_queued_age_seconds == null ? "Not reported" : formatAgeSeconds(queue.oldest_queued_age_seconds, utils) },
            ], utils)}
          </div>
        </section>

        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>Operational Activity</strong>
            ${snapshot.activity?.latest_live_refresh?.id ? dashboardBadge(`Live ${utils.compactId(snapshot.activity.latest_live_refresh.id)}`, "muted", utils) : dashboardBadge("No live id", "muted", utils)}
          </div>
          <div class="operational-activity-list">
            ${renderActivityRows(snapshot, utils)}
          </div>
        </section>

        <section class="operational-panel">
          <div class="operational-panel-head">
            <strong>Replay Visibility</strong>
            ${dashboardBadge(snapshot.replay?.replay_safe ? "Replay-safe" : "No replay flag", snapshot.replay?.replay_safe ? "success" : "muted", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Import operations", value: snapshot.replay?.import_operations },
              { label: "Classify operations", value: snapshot.replay?.classify_operations },
              { label: "Process operations", value: snapshot.replay?.process_operations },
              { label: "Live refresh operations", value: snapshot.replay?.live_refresh_operations },
              { label: "Rematch operations", value: snapshot.replay?.rematch_operations },
            ], utils)}
          </div>
        </section>

        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>Pipeline Visibility</strong>
            ${dashboardBadge(gapCount ? "Partial states visible" : "No visible gaps", gapCount ? "warning" : "success", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Imported rows (active)", value: visibility.active_imported_total },
              { label: "Fully processed rows", value: visibility.fully_processed_imported_count },
              { label: "Current valid AI classified", value: visibility.current_valid_classified_imported_total },
              { label: "Unclassified imported rows", value: visibility.unclassified_imported_total },
              { label: "Imported, not fully processed", value: visibility.imported_without_processing_count },
              { label: "Processed, not classified", value: visibility.processed_without_classification_count },
              { label: "Processing failed jobs", value: visibility.processing_failed_jobs },
              { label: "Classification failed/skipped jobs", value: Number(visibility.classification_failed_jobs || 0) + Number(visibility.classification_skipped_jobs || 0) },
            ], utils)}
          </div>
          ${renderOperationalNote(`${visibilityScopeLabel}. Imports can be complete while processing and classification are still pending; this card does not enqueue work. Live refresh classification can be capped, so remaining rows may stay unclassified.`, utils)}
        </section>

        <section class="operational-panel">
          <div class="operational-panel-head">
            <strong>Event-Derived Gaps</strong>
            ${dashboardBadge("Limited by event history", "muted", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Approved imports seen in events", value: gaps.approved_imported_total },
              { label: "Active event imports", value: gaps.active_imported_total },
              { label: "Event imports fully processed", value: gaps.fully_processed_imported_total },
              { label: "Event imports classified", value: gaps.current_classified_imported_total },
              { label: "Event imports not processed", value: gaps.imported_without_processing },
              { label: "Event processed not classified", value: gaps.processed_without_classification },
            ], utils)}
          </div>
          ${renderOperationalNote("Event-derived counts can miss imported rows when audit event inserts fail or fall outside the dashboard lookup window.", utils)}
        </section>

        <section class="operational-panel">
          <div class="operational-panel-head">
            <strong>Failure Visibility</strong>
            ${dashboardBadge(failures.failed_jobs_total || failures.failed_classifications_total ? "Failures present" : "No failures", failures.failed_jobs_total || failures.failed_classifications_total ? "danger" : "success", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Failed processing jobs", value: failures.failed_jobs_total },
              { label: "Failed classifications", value: failures.failed_classifications_total },
              { label: "Permanent classify failures", value: failures.permanently_failed_classifications },
              { label: "Blocked/safe state", html: dashboardBadge(blocked ? "attention" : "safe", blocked ? "warning" : "success", utils) },
            ], utils)}
          </div>
          <div class="operational-reason-list">
            ${renderFailureReasons(failures.failed_reasons, utils)}
          </div>
        </section>

        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>Recent Operational Events</strong>
            ${dashboardBadge(`${snapshot.recent_operational_events.length} visible`, "muted", utils)}
          </div>
          <div class="operational-event-list">
            ${renderOperationalEventRows(snapshot.recent_operational_events, utils)}
          </div>
        </section>

        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>Safety Flags</strong>
            ${dashboardBadge("Visibility only", "success", utils)}
          </div>
          <div class="operational-safety-strip">
            ${dashboardBadge(`Outlook mutation: ${safety.outlook_mutation_performed ? "true" : "false"}`, safety.outlook_mutation_performed ? "danger" : "success", utils)}
            ${dashboardBadge(`Auto-send: ${safety.automatic_responses_sent || 0}`, safety.automatic_responses_sent ? "danger" : "success", utils)}
            ${dashboardBadge(`Drafts created: ${safety.drafts_created || 0}`, safety.drafts_created ? "warning" : "success", utils)}
            ${dashboardBadge(`Scheduler: ${safety.scheduler_started ? "true" : "false"}`, safety.scheduler_started ? "danger" : "success", utils)}
            ${dashboardBadge(`Polling: ${safety.polling_started ? "true" : "false"}`, safety.polling_started ? "danger" : "success", utils)}
            ${dashboardBadge(`Realtime: ${safety.realtime_listener_started ? "true" : "false"}`, safety.realtime_listener_started ? "danger" : "success", utils)}
          </div>
        </section>
      </div>
    `;
  }

  window.EmailTriageDiagnostics = {
    queueSummaryItems,
    safetySummaryItems,
    replaySummaryItems,
    renderSummaryItems,
    renderAdminSummary,
    renderOperationalDashboard,
  };
})();
