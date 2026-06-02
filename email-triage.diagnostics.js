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
    const counts = data.classification_counts || {};
    return [
      { label: "Visible Rows", value: counts.visible_rows ?? counts.loaded_current_valid ?? data.classifications?.length },
      { label: "Filtered Rows", value: counts.filtered_current_valid ?? counts.total_current_valid ?? data.validation_diagnostics?.valid_classifications },
      { label: "Mailbox Rows", value: counts.total_mailbox_rows ?? 0 },
      { label: "Classified Rows", value: counts.total_current_valid ?? data.validation_diagnostics?.valid_classifications },
      { label: "Open Review", value: data.validation_diagnostics?.pending_human_review },
      { label: "Invalid History", value: data.validation_diagnostics?.invalid_classifications },
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
    const actor = event.initiated_by || event.actor_email || event.actor_user_id || "";
    const pieces = [
      event.id ? `id ${utils.compactId(event.id)}` : "",
      event.created_at ? utils.formatDateTime(event.created_at) : "",
      actor ? `by ${actor}` : "",
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

  function eventPayload(event = {}) {
    if (event.payload && typeof event.payload === "object") return event.payload;
    if (event.metadata && typeof event.metadata === "object") return event.metadata;
    return {};
  }

  function numberMetric(source = {}, keys = []) {
    for (const key of keys) {
      const value = Number(source?.[key]);
      if (Number.isFinite(value) && value !== 0) return value;
    }
    return 0;
  }

  function metricText(value, suffix) {
    const number = Number(value || 0);
    return `${number} ${suffix}`;
  }

  function eventStatusVariant(event = {}) {
    const counters = event.counters && typeof event.counters === "object" ? event.counters : {};
    const failed = String(event.status || "").toLowerCase().includes("fail") || Number(counters.failed_count || 0) > 0 || Number(eventPayload(event).failed || 0) > 0;
    if (failed) return "danger";
    if (String(event.status || "").toLowerCase().includes("complete")) return "success";
    return "muted";
  }

  function summarizeOperationalEvent(event = {}, utils = window.EmailTriageRenderUtils) {
    const payload = eventPayload(event);
    const counters = event.counters && typeof event.counters === "object" ? event.counters : {};
    const eventType = String(event.event_type || "");
    const title = operationTitle(event, utils);
    const status = event.status || payload.status || "recorded";
    const ebayDescriptions = {
      conversation_synced: "Canonical eBay conversation data was refreshed into Supabase.",
      conversation_classified: "AI classification was stored for an eBay conversation.",
      classification_changed: "An operator changed the stored eBay classification.",
      draft_generated: "AI generated an eBay reply draft.",
      draft_improved: "AI improved an existing eBay reply draft.",
      draft_edited: "An operator edited the saved eBay draft.",
      draft_discarded: "An operator discarded the eBay draft.",
      draft_approved: "An operator approved the draft as ready for future controlled send.",
      approval_removed: "An operator removed draft approval.",
      send_attempt_created: "A future send attempt row was created.",
      send_attempt_failed: "A send attempt failed.",
      send_attempt_succeeded: "A send attempt succeeded.",
      smart_folder_created: "An eBay smart folder was created.",
      smart_folder_updated: "An eBay smart folder was updated.",
    };
    const description = firstValue([
      event.reason,
      payload.reason,
      event.replay_source ? `Replay source: ${event.replay_source}` : "",
      ebayDescriptions[eventType],
      eventType === "rematch_existing" ? "Deterministic link rematch completed for an explicit scope." : "",
      eventType === "sync_import_approved" ? "Approved Outlook messages were imported into the local mailbox." : "",
      eventType === "run_live_refresh" ? "Bounded preview, import, processing, and classification pass." : "",
      eventType === "classify_imported" ? "Imported messages were considered for classification." : "",
      eventType === "process_imported" ? "Imported messages were considered for processing and matching." : "",
      "Operational event recorded.",
    ]);
    const rematchChanges = numberMetric(payload, ["changed_link_count"]) || Number(counters.links_created || 0) + Number(counters.links_updated || 0);
    const metricsByType = {
      rematch_existing: [
        metricText(numberMetric(payload, ["scanned"]), "scanned"),
        metricText(numberMetric(payload, ["rematched"]) || counters.rematched_count, "rematched"),
        metricText(rematchChanges, "link changes"),
        metricText(numberMetric(payload, ["failed"]) || counters.failed_count, "failed"),
      ],
      sync_import_approved: [
        metricText(numberMetric(payload, ["target_count", "limit"]), "target"),
        metricText(numberMetric(payload, ["imported_count"]) || counters.imported_count, "imported"),
        metricText(numberMetric(payload, ["already_imported_count", "skipped_already_imported_count"]) || counters.already_imported_count, "already"),
        metricText(numberMetric(payload, ["failed_count"]) || counters.failed_count, "failed"),
      ],
      mailbox_import: [
        metricText(numberMetric(payload.progress || payload, ["target_count"]) || numberMetric(payload, ["target_count"]), "target"),
        metricText(numberMetric(payload.progress || payload, ["imported_total", "imported_count"]) || counters.imported_count, "imported"),
        metricText(numberMetric(payload.progress || payload, ["already_imported_total", "already_imported_count"]) || counters.already_imported_count, "already"),
        metricText(numberMetric(payload.progress || payload, ["failed_total", "failed_count"]) || counters.failed_count, "failed"),
      ],
      classify_imported: [
        metricText(numberMetric(payload, ["candidate_count"]), "candidates"),
        metricText(numberMetric(payload, ["classified_count"]) || counters.classified_count, "classified"),
        metricText(numberMetric(payload, ["skipped_count"]) || counters.skipped_count, "skipped"),
        metricText(numberMetric(payload, ["failed_count"]) || counters.failed_count, "failed"),
      ],
      process_imported: [
        metricText(numberMetric(payload, ["candidate_count", "queued_count"]), "candidates"),
        metricText(numberMetric(payload, ["jobs_enqueued"]) || counters.jobs_enqueued, "jobs enqueued"),
        metricText(numberMetric(payload, ["processed_count"]) || counters.processed_count, "processed"),
        metricText(numberMetric(payload, ["failed_count"]) || counters.failed_count, "failed"),
      ],
      run_live_refresh: [
        metricText(numberMetric(payload.preview || {}, ["previewed_count"]) || counters.previewed_count, "previewed"),
        metricText(numberMetric(payload.import || {}, ["imported_count"]) || counters.imported_count, "imported"),
        metricText(numberMetric(payload.processing || {}, ["processed_count"]) || counters.processed_count, "processed"),
        metricText(numberMetric(payload.classification || {}, ["classified_count"]) || counters.classified_count, "classified"),
      ],
      conversation_synced: [
        payload.unread_count !== undefined ? metricText(payload.unread_count, "unread") : "",
        payload.latest_message_id ? `latest ${utils.compactId(payload.latest_message_id)}` : "",
      ],
      conversation_classified: [
        payload.priority ? utils.humanizeValue(payload.priority) : "",
        payload.response_need ? utils.humanizeValue(payload.response_need) : "",
        Array.isArray(payload.topic_tags) ? metricText(payload.topic_tags.length, "topics") : "",
      ],
      draft_generated: [
        payload.draft_version ? `v${payload.draft_version}` : "",
        payload.validation_status ? utils.humanizeValue(payload.validation_status) : "",
      ],
      draft_improved: [
        payload.draft_version ? `v${payload.draft_version}` : "",
        payload.validation_status ? utils.humanizeValue(payload.validation_status) : "",
      ],
      draft_approved: [
        payload.idempotency_key ? "idempotency ready" : "",
        payload.approval_status ? utils.humanizeValue(payload.approval_status) : "",
      ],
      approval_removed: [
        payload.previous_approval_id ? `prev ${utils.compactId(payload.previous_approval_id)}` : "",
      ],
      send_attempt_created: [
        payload.provider ? utils.humanizeValue(payload.provider) : "",
        payload.attempt_sequence ? `attempt ${payload.attempt_sequence}` : "",
      ],
      send_attempt_failed: [
        payload.provider ? utils.humanizeValue(payload.provider) : "",
        payload.attempt_sequence ? `attempt ${payload.attempt_sequence}` : "",
      ],
      send_attempt_succeeded: [
        payload.provider ? utils.humanizeValue(payload.provider) : "",
        payload.provider_message_id ? `provider ${utils.compactId(payload.provider_message_id)}` : "",
      ],
    };
    const genericMetrics = [
      counters.imported_count ? metricText(counters.imported_count, "imported") : "",
      counters.processed_count ? metricText(counters.processed_count, "processed") : "",
      counters.classified_count ? metricText(counters.classified_count, "classified") : "",
      counters.skipped_count ? metricText(counters.skipped_count, "skipped") : "",
      counters.failed_count ? metricText(counters.failed_count, "failed") : "",
    ].filter(Boolean).slice(0, 4);

    return {
      title,
      status,
      description,
      metrics: (metricsByType[eventType] || genericMetrics).filter(Boolean).slice(0, 4),
    };
  }

  function extractOperationalEventMetrics(event = {}, utils = window.EmailTriageRenderUtils) {
    return summarizeOperationalEvent(event, utils).metrics;
  }

  function renderSafetySummary(payload = {}, utils = window.EmailTriageRenderUtils) {
    const safety = payload.safety && typeof payload.safety === "object" ? payload.safety : payload;
    const outlookMutation = safety.outlook_mutation_performed === true;
    const ebayMutation = safety.ebay_mutation_performed === true;
    const sends = Number(safety.automatic_responses_sent || safety.emails_sent || 0);
    const parts = [
      outlookMutation ? "Outlook mutation: true" : "no Outlook mutation",
      ebayMutation ? "eBay mutation: true" : "no eBay mutation",
      sends ? `${sends} sends` : "no sends",
    ];
    return `${outlookMutation || ebayMutation || sends ? "Safety" : "Safe"}: ${parts.join(" · ")}`;
  }

  function renderMetricCard(label, value, note = "", utils = window.EmailTriageRenderUtils) {
    const displayValue = value === undefined || value === null || value === "" ? "Not recorded for this event" : value;
    return `
      <div class="operational-detail-metric">
        <span>${utils.escapeHtml(label)}</span>
        <strong>${utils.escapeHtml(displayValue)}</strong>
        ${note ? `<em>${utils.escapeHtml(note)}</em>` : ""}
      </div>
    `;
  }

  function metricValue(sources = [], keys = []) {
    for (const source of sources) {
      if (!source || typeof source !== "object") continue;
      for (const key of keys) {
        if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
      }
    }
    return null;
  }

  function detailMetricItems(event = {}) {
    const payload = eventPayload(event);
    const counters = event.counters && typeof event.counters === "object" ? event.counters : {};
    const progress = payload.progress && typeof payload.progress === "object" ? payload.progress : {};
    const batch = payload.batch && typeof payload.batch === "object" ? payload.batch : {};
    const processing = payload.processing && typeof payload.processing === "object" ? payload.processing : {};
    const classification = payload.classification && typeof payload.classification === "object" ? payload.classification : {};
    const preview = payload.preview && typeof payload.preview === "object" ? payload.preview : {};
    const imported = payload.import && typeof payload.import === "object" ? payload.import : {};
    const eventType = String(event.event_type || "");

    if (eventType === "rematch_existing") {
      return [
        ["Scanned", metricValue([payload, counters], ["scanned", "previewed_count"])],
        ["Rematched", metricValue([payload, counters], ["rematched", "rematched_count"])],
        ["Unchanged", metricValue([payload], ["unchanged"])],
        ["Ambiguous", metricValue([payload, counters], ["ambiguous", "ambiguous_count"])],
        ["Skipped", metricValue([payload, counters], ["skipped", "skipped_count"])],
        ["Failed", metricValue([payload, counters], ["failed", "failed_count"])],
        ["Link changes", metricValue([payload], ["changed_link_count"]) ?? Number(counters.links_created || 0) + Number(counters.links_updated || 0)],
        ["Created links", metricValue([payload, counters], ["links_created"])],
        ["Updated links", metricValue([payload, counters], ["links_updated"])],
        ["Order links", metricValue([payload], ["order_link_changes"])],
        ["Item links", metricValue([payload], ["item_link_changes"])],
        ["Inventory links", metricValue([payload], ["inventory_link_changes"])],
        ["Buyer links", metricValue([payload], ["buyer_link_changes"])],
        ["Tracking/label links", metricValue([payload], ["tracking_label_link_changes"])],
      ];
    }

    if (eventType === "sync_import_approved" || eventType === "mailbox_import") {
      return [
        ["Target", metricValue([progress, payload], ["target_count", "limit"])],
        ["Imported", metricValue([progress, batch, payload, imported, counters], ["imported_total", "imported_count"])],
        ["Already imported", metricValue([progress, batch, payload, imported, counters], ["already_imported_total", "already_imported_count", "skipped_already_imported_count"])],
        ["Failed", metricValue([progress, batch, payload, imported, counters], ["failed_total", "failed_count"])],
        ["Skipped", metricValue([batch, payload, imported, counters], ["skipped_count"])],
        ["Pages", metricValue([batch, payload], ["pages_fetched"])],
        ["Seen", metricValue([batch, payload], ["messages_seen"])],
        ["Has more", metricValue([progress, payload], ["has_more"])],
        ["Continuation", metricValue([progress, payload], ["continuation_available"])],
        ["Checkpoint updated", metricValue([payload.safety || {}, payload], ["sync_checkpoint_updated"])],
      ];
    }

    return [
      ["Candidates", metricValue([progress, processing, classification, payload], ["candidate_count", "queued_count"])],
      ["Jobs enqueued", metricValue([processing, classification, payload, counters], ["jobs_enqueued"])],
      ["Jobs processed", metricValue([processing, classification, payload], ["jobs_processed"])],
      ["Processed", metricValue([processing, payload, counters], ["processed_count"])],
      ["Classified", metricValue([classification, payload, counters], ["classified_count"])],
      ["Skipped", metricValue([classification, processing, payload, counters], ["skipped_count"])],
      ["Failed", metricValue([classification, processing, payload, counters], ["failed_count"])],
      ["Remaining", metricValue([progress, payload], ["remaining_to_process", "remaining_to_classify", "remaining_estimate"])],
      ["Drafts created", metricValue([payload.safety || {}, payload], ["drafts_created"])],
      ["Emails sent", metricValue([payload.safety || {}, payload], ["automatic_responses_sent", "emails_sent"])],
      ["Previewed", metricValue([preview, payload, counters], ["previewed_count"])],
      ["Imported", metricValue([imported, payload, counters], ["imported_count"])],
    ];
  }

  function sanitizeOperationalPayload(value, key = "", depth = 0) {
    const sensitiveKey = /(body|html|content|draft|reply|normalized_text|raw_text|message_text)/i.test(key);
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      if (sensitiveKey) return `[omitted ${key || "text"}]`;
      return value.length > 240 ? `${value.slice(0, 240)}... [truncated]` : value;
    }
    if (typeof value !== "object") return value;
    if (depth > 6) return "[omitted nested payload]";
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeOperationalPayload(item, key, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeOperationalPayload(childValue, childKey, depth + 1),
    ]));
  }

  function renderOperationalEventDetail(event = null, utils = window.EmailTriageRenderUtils) {
    if (!event) {
      return `<div class="classification-empty operational-empty">Select an operational event to inspect details.</div>`;
    }
    const payload = eventPayload(event);
    const summary = summarizeOperationalEvent(event, utils);
    const safety = payload.safety && typeof payload.safety === "object" ? payload.safety : event.safety || {};
    const safetyFlags = [
      ["Outlook fetch", metricValue([safety, payload], ["outlook_fetch_performed"])],
      ["Outlook mutation", metricValue([safety, payload], ["outlook_mutation_performed"])],
      ["eBay mutation", metricValue([safety, payload], ["ebay_mutation_performed"])],
      ["Classification", metricValue([safety, payload], ["classification_triggered"])],
      ["Drafts created", metricValue([safety, payload], ["drafts_created"])],
      ["Emails sent", metricValue([safety, payload], ["automatic_responses_sent", "emails_sent"])],
    ];
    const rawPayload = Object.keys(payload).length ? payload : event;
    const rawJson = JSON.stringify(sanitizeOperationalPayload(rawPayload), null, 2);

    return `
      <div class="operational-detail-header">
        <div>
          <span class="eyebrow">Operational Event</span>
          <h3>${utils.escapeHtml(summary.title)}</h3>
          <p>${utils.escapeHtml(summary.description)}</p>
        </div>
        <button type="button" class="secondary-btn" data-operational-event-close>
          <i data-lucide="x"></i>
          Close
        </button>
      </div>
      <div class="operational-detail-meta">
        ${renderMetricCard("Event id", event.id || "Not recorded for this event", "", utils)}
        ${renderMetricCard("Timestamp", event.created_at ? utils.formatDateTime(event.created_at) : null, "", utils)}
        ${renderMetricCard("Actor", event.initiated_by || event.actor_email || event.actor_user_id || "Not recorded for this event", "", utils)}
        ${renderMetricCard("Status", summary.status, "", utils)}
      </div>
      <div class="operational-detail-metric-grid">
        ${detailMetricItems(event).map(([label, value]) => renderMetricCard(label, value, "", utils)).join("")}
      </div>
      <div class="operational-detail-safety">
        <strong>${utils.escapeHtml(renderSafetySummary({ ...payload, safety }, utils))}</strong>
        <div>
          ${safetyFlags.map(([label, value]) => dashboardBadge(`${label}: ${value === null ? "not recorded" : String(value)}`, value === true && !/fetch/i.test(label) ? "danger" : "muted", utils)).join("")}
        </div>
      </div>
      ${renderChildOperations(event, utils)}
      <details class="operational-raw-payload">
        <summary>Raw payload JSON</summary>
        <pre>${utils.escapeHtml(rawJson)}</pre>
      </details>
    `;
  }

  function renderOperationalEventDetailDrawer(state = {}, snapshot = {}, utils = window.EmailTriageRenderUtils) {
    if (state.operationalEventDetailOpen !== true) return "";
    const events = Array.isArray(snapshot.recent_operational_events) ? snapshot.recent_operational_events : [];
    const selectedId = state.selectedOperationalEventId;
    const selected = events.find((event) => String(event.id || "") === String(selectedId || ""))
      || state.selectedOperationalEventDetail
      || null;
    return `
      <div class="operational-detail-backdrop" data-operational-event-close></div>
      <aside class="operational-detail-drawer" role="dialog" aria-modal="true" aria-label="Operational event detail">
        ${renderOperationalEventDetail(selected, utils)}
      </aside>
    `;
  }

  function renderOperationalEventRows(events = [], utils = window.EmailTriageRenderUtils) {
    if (!events.length) {
      return `<div class="classification-empty operational-empty">No operational events returned yet.</div>`;
    }

    return events.slice(0, 12).map((event) => {
      const payload = eventPayload(event);
      const summary = summarizeOperationalEvent(event, utils);
      const isReplay = String(event.event_type || "").includes("replay") || String(event.event_type || "").includes("requeue");
      const isFailure = eventStatusVariant(event) === "danger";

      return `
        <article class="operational-event-row${isReplay ? " is-replay" : ""}${isFailure ? " is-failure" : ""}" role="button" tabindex="0" data-operational-event-id="${utils.escapeHtml(event.id || "")}">
          <div class="operational-event-main">
            <strong>${utils.escapeHtml(summary.title)}</strong>
            <span>${utils.escapeHtml(operationMeta(event, utils))}</span>
          </div>
          <p>${utils.escapeHtml(summary.description)}</p>
          <div class="operational-event-summary">
            <div class="operational-event-counts">
              ${summary.metrics.length ? summary.metrics.map((part) => dashboardBadge(part, part.includes("failed") ? "danger" : "muted", utils)).join("") : dashboardBadge("No counts", "muted", utils)}
              ${dashboardBadge(utils.humanizeValue(summary.status), eventStatusVariant(event), utils)}
            </div>
            <span class="operational-safety-line">${utils.escapeHtml(renderSafetySummary({ ...payload, safety: event.safety || payload.safety || {} }, utils))}</span>
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

  function renderEbayTimelineRows(timeline = [], utils = window.EmailTriageRenderUtils) {
    if (!timeline.length) {
      return `<div class="classification-empty operational-empty">No eBay activity has been recorded yet.</div>`;
    }

    return timeline.slice(0, 14).map((item) => `
      <div class="operational-row">
        <span>${utils.escapeHtml(item.created_at ? utils.formatDateTime(item.created_at) : "--")}</span>
        <strong>${utils.escapeHtml(item.title || utils.humanizeValue(item.event_type || "activity"))}</strong>
        <em>${utils.escapeHtml(item.detail || item.actor || item.conversation_id || "--")}</em>
      </div>
    `).join("");
  }

  function renderEbayOperationalDashboard(state = {}, snapshot = {}, utils = window.EmailTriageRenderUtils) {
    const ebay = snapshot.ebay || {};
    const metrics = ebay.metrics || {};
    const safety = ebay.send_safety || {};
    const approvalQueue = ebay.approval_queue || {};
    const events = Array.isArray(ebay.recent_operational_events) ? ebay.recent_operational_events : [];
    const blocked = ebay.ok === false || Number(metrics.send_attempts_failed || 0) > 0 || safety.ebay_mutation_performed === true || safety.automatic_responses_sent > 0;

    return `
      <div class="operational-dashboard-status">
        <span>${state.operationalDashboardLoading ? "Refreshing eBay operations" : `eBay operations refreshed ${utils.formatDateTime(state.operationalDashboardUpdatedAt || ebay.generated_at || snapshot.generated_at)}`}</span>
        ${state.operationalDashboardError ? dashboardBadge(`Error: ${state.operationalDashboardError}`, "danger", utils) : ""}
        ${ebay.ok === false ? dashboardBadge(ebay.error || "eBay dashboard partial", "warning", utils) : ""}
        ${dashboardBadge(blocked ? "Attention needed" : "No-send visibility mode", blocked ? "warning" : "success", utils)}
      </div>

      <div class="operational-dashboard-grid">
        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>eBay Message Metrics</strong>
            ${dashboardBadge("Canonical", "success", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Conversations today", value: metrics.conversations_today },
              { label: "Unread conversations", value: metrics.unread_conversations },
              { label: "Needs reply", value: metrics.needs_reply },
              { label: "High priority", value: metrics.high_priority },
              { label: "Returns", value: metrics.returns },
              { label: "Refund risk", value: metrics.refund_risk },
              { label: "VIP buyers", value: metrics.vip_buyers },
              { label: "Drafts generated today", value: metrics.drafts_generated },
            ], utils)}
          </div>
        </section>

        <section class="operational-panel">
          <div class="operational-panel-head">
            <strong>Approval Queue</strong>
            ${dashboardBadge(`${approvalQueue.approved_ready || 0} approved`, Number(approvalQueue.approved_ready || 0) ? "success" : "muted", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Current drafts", value: approvalQueue.current_drafts },
              { label: "Awaiting approval", value: metrics.drafts_awaiting_approval },
              { label: "Approved drafts", value: metrics.approved_drafts },
              { label: "Approval events", value: approvalQueue.approval_events },
            ], utils)}
          </div>
        </section>

        <section class="operational-panel">
          <div class="operational-panel-head">
            <strong>Send Safety</strong>
            ${dashboardBadge("No send control", "success", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Sends enabled", html: dashboardBadge(safety.sends_enabled ? "true" : "false", safety.sends_enabled ? "danger" : "success", utils) },
              { label: "Send attempts", value: metrics.send_attempts_created },
              { label: "Failed attempts", value: metrics.send_attempts_failed },
              { label: "Succeeded attempts", value: metrics.send_attempts_succeeded },
            ], utils)}
          </div>
          ${renderOperationalNote(`Duplicate guard: ${utils.humanizeValue(safety.duplicate_success_guard || "one_success_per_idempotency_key")}.`, utils)}
        </section>

        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>Activity Timeline</strong>
            ${dashboardBadge(`${(ebay.timeline || []).length} visible`, "muted", utils)}
          </div>
          <div class="operational-activity-list">
            ${renderEbayTimelineRows(ebay.timeline || [], utils)}
          </div>
        </section>

        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>Recent eBay Activity</strong>
            ${dashboardBadge(`${events.length} events`, "muted", utils)}
          </div>
          <div class="operational-event-list">
            ${renderOperationalEventRows(events, utils)}
          </div>
        </section>

        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>Safety Flags</strong>
            ${dashboardBadge("Audit only", "success", utils)}
          </div>
          <div class="operational-safety-strip">
            ${dashboardBadge(`eBay mutation: ${safety.ebay_mutation_performed ? "true" : "false"}`, safety.ebay_mutation_performed ? "danger" : "success", utils)}
            ${dashboardBadge(`Outlook mutation: ${safety.outlook_mutation_performed ? "true" : "false"}`, safety.outlook_mutation_performed ? "danger" : "success", utils)}
            ${dashboardBadge(`Auto-send: ${safety.automatic_responses_sent || 0}`, safety.automatic_responses_sent ? "danger" : "success", utils)}
            ${dashboardBadge(`Sends enabled: ${safety.sends_enabled ? "true" : "false"}`, safety.sends_enabled ? "danger" : "success", utils)}
          </div>
        </section>
      </div>
      ${renderOperationalEventDetailDrawer(state, { recent_operational_events: events }, utils)}
    `;
  }

  function renderOperationalDashboard(state = {}, utils = window.EmailTriageRenderUtils) {
    const snapshot = state.operationalDashboardSnapshot;
    if (state.operationalDashboardLoading && !snapshot) {
      return `<div class="workspace-status operational-dashboard-status">Loading operational dashboard.</div>`;
    }
    if (!snapshot) {
      return `<div class="workspace-status operational-dashboard-status">Refresh dashboard to load operational visibility.</div>`;
    }
    if (snapshot.ebay) {
      return renderEbayOperationalDashboard(state, snapshot, utils);
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
      ${renderOperationalEventDetailDrawer(state, snapshot, utils)}
    `;
  }

  window.EmailTriageDiagnostics = {
    queueSummaryItems,
    safetySummaryItems,
    replaySummaryItems,
    renderSummaryItems,
    renderAdminSummary,
    summarizeOperationalEvent,
    extractOperationalEventMetrics,
    renderOperationalEventRow: renderOperationalEventRows,
    renderOperationalEventDetail,
    renderSafetySummary,
    renderMetricCard,
    renderOperationalDashboard,
  };
})();
