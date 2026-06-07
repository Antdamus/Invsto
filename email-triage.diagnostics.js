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
    const eventType = String(event.event_type || "");
    const payload = eventPayload(event);
    if (eventType === "conversation_classified" && payload.classification_run) {
      return event.title || "Classification Run Completed";
    }
    if (eventType === "message_sync_completed") return event.title || "Sync Recent Mailbox Completed";
    if (eventType === "message_sync_failed") return event.title || "Sync Recent Mailbox Failed";
    if (eventType === "message_backfill_started") return "Backfill Started";
    if (eventType === "message_backfill_progress") return "Backfill Progress";
    if (eventType === "message_backfill_completed") return "Backfill Completed";
    if (eventType === "message_backfill_failed") return "Backfill Failed";
    if (eventType === "send_attempt_succeeded") return "Send Attempt Succeeded";
    if (eventType === "send_attempt_failed") return "Send Attempt Failed";
    if (eventType === "duplicate_send_prevented") return "Duplicate Send Prevented";
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
    const status = String(event.status || "").toLowerCase();
    if (status.includes("partial")) return "warning";
    const failed = status.includes("fail") || Number(counters.failed_count || 0) > 0 || Number(eventPayload(event).failed || 0) > 0;
    if (failed) return "danger";
    if (status.includes("running") || status.includes("pending")) return "warning";
    if (status.includes("warn")) return "warning";
    if (status.includes("complete") || status.includes("success")) return "success";
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
      draft_approved: "An operator approved the draft as ready for controlled send.",
      approval_removed: "An operator removed draft approval.",
      send_attempt_created: "A controlled send attempt row was created.",
      send_attempt_failed: "A send attempt failed.",
      send_attempt_succeeded: "A send attempt succeeded.",
      duplicate_send_prevented: "A duplicate send was blocked before another provider call.",
      smart_folder_created: "An eBay smart folder was created.",
      smart_folder_updated: "An eBay smart folder was updated.",
      message_sync_completed: "Recent incremental mailbox scan completed as one aggregate operation.",
      message_sync_failed: "Recent incremental mailbox scan failed as one aggregate operation.",
      message_backfill_started: "Historical eBay message archive import started.",
      message_backfill_progress: String(status || "").toLowerCase().includes("partial")
        ? "Historical eBay message archive chunk completed with partial success; inspect classification counts below."
        : "Historical eBay message archive import chunk completed and paused at a safe checkpoint.",
      message_backfill_completed: String(status || "").toLowerCase().includes("partial")
        ? "Historical eBay message archive completed with partial success; inspect classification counts below."
        : "Historical eBay message archive import completed.",
      message_backfill_failed: "Historical eBay message archive import failed.",
    };
    const description = firstValue([
      event.reason,
      payload.reason,
      event.replay_source ? `Replay source: ${event.replay_source}` : "",
      ebayDescriptions[eventType],
      eventType === "rematch_existing" ? "Deterministic link rematch completed for an explicit scope." : "",
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
      message_sync_completed: [
        metricText(metricValue([payload], ["conversations_seen", "processed_count"]) || 0, "seen"),
        metricText(metricValue([payload], ["conversations_inserted"]) || 0, "inserted"),
        metricText(metricValue([payload], ["conversations_updated"]) || 0, "changed"),
        metricText(metricValue([payload], ["conversations_unchanged"]) || 0, "unchanged"),
        metricText(metricValue([payload], ["messages_rechecked"]) || 0, "messages rechecked"),
      ],
      message_sync_failed: [
        metricText(metricValue([payload], ["conversations_seen", "processed_count"]) || 0, "seen"),
        metricText(metricValue([payload], ["conversations_inserted"]) || 0, "inserted"),
        metricText(metricValue([payload], ["conversations_updated"]) || 0, "changed"),
        metricText(metricValue([payload], ["failed_count"]) || 1, "failed"),
      ],
      conversation_classified: payload.classification_run || payload.processed_count !== undefined ? [
        metricText(metricValue([payload], ["candidates_examined", "processed_count"]) ?? payload.classification_run?.processed, "examined"),
        metricText(metricValue([payload], ["actually_classified", "classified_count", "succeeded_count"]) ?? payload.classification_run?.succeeded, "classified"),
        metricText(metricValue([payload], ["failed_count"]) ?? payload.classification_run?.failed, "failed"),
        metricText(metricValue([payload], ["skipped_count"]) ?? payload.classification_run?.skipped, "skipped"),
        metricText(metricValue([payload], ["remaining_unclassified", "unclassified_after"]) ?? payload.classification_run?.unclassified_after, "remaining"),
      ] : [
        payload.priority ? utils.humanizeValue(payload.priority) : "",
        payload.response_need ? utils.humanizeValue(payload.response_need) : "",
        Array.isArray(payload.topic_tags) ? metricText(payload.topic_tags.length, "topics") : "",
      ],
      message_backfill_started: [
        metricText(metricValue([payload], ["processed_count"]) || 0, "processed"),
        payload.classification_mode ? utils.humanizeValue(payload.classification_mode) : "",
        Array.isArray(payload.conversation_types) ? payload.conversation_types.join(", ") : "",
      ],
      message_backfill_progress: [
        metricText(metricValue([payload], ["processed_count", "conversations_processed"]) || 0, "processed"),
        metricText(metricValue([payload], ["messages_processed"]) || 0, "messages"),
        metricText(metricValue([payload.progress || {}], ["pages_remaining"]) || 0, "pages remaining"),
        payload.classification_mode ? utils.humanizeValue(payload.classification_mode) : "",
      ],
      message_backfill_completed: [
        metricText(metricValue([payload], ["processed_count", "conversations_processed"]) || 0, "processed"),
        metricText(metricValue([payload], ["succeeded_count", "conversations_succeeded"]) || 0, "succeeded"),
        metricText(metricValue([payload], ["failed_count"]) || 0, "failed"),
        metricText(metricValue([payload], ["messages_processed"]) || 0, "messages"),
      ],
      message_backfill_failed: [
        metricText(metricValue([payload], ["processed_count", "conversations_processed"]) || 0, "processed"),
        metricText(metricValue([payload], ["succeeded_count", "conversations_succeeded"]) || 0, "succeeded"),
        metricText(metricValue([payload], ["failed_count"]) || 1, "failed"),
        payload.error_code ? utils.humanizeValue(payload.error_code) : "",
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
      duplicate_send_prevented: [
        payload.provider ? utils.humanizeValue(payload.provider) : "",
        payload.duplicate_of_attempt_id ? `duplicate of ${utils.compactId(payload.duplicate_of_attempt_id)}` : "",
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
    const ebayMutation = safety.ebay_mutation_performed === true;
    const sends = Number(safety.automatic_responses_sent || safety.emails_sent || 0);
    const parts = [
      ebayMutation ? "eBay mutation: true" : "no eBay mutation",
      sends ? `${sends} sends` : "no sends",
    ];
    return `${ebayMutation || sends ? "Safety" : "Safe"}: ${parts.join(" · ")}`;
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

    if (eventType === "conversation_classified" && (payload.classification_run || payload.processed_count !== undefined)) {
      const run = payload.classification_run && typeof payload.classification_run === "object" ? payload.classification_run : payload;
      return [
        ["Candidates Examined", metricValue([payload, run, counters], ["candidates_examined", "processed_count", "processed"])],
        ["Attempted", metricValue([payload, run, counters], ["attempted_count", "attempted"])],
        ["Actually Classified", metricValue([payload, run, counters], ["actually_classified", "classified_count", "succeeded_count", "succeeded"])],
        ["Failed", metricValue([payload, run, counters], ["failed_count", "failed"])],
        ["Skipped", metricValue([payload, run, counters], ["skipped_count", "skipped"])],
        ["Unclassified Before", metricValue([payload, run, counters], ["unclassified_before"])],
        ["Unclassified After", metricValue([payload, run, counters], ["unclassified_after"])],
        ["Remaining Unclassified", metricValue([payload, run, counters], ["remaining_unclassified", "unclassified_after"])],
        ["Requested", metricValue([payload, run], ["requested_count", "requested"])],
        ["Classification Version", metricValue([payload, run], ["classification_version"])],
        ["Prompt Version", metricValue([payload, run], ["prompt_version"])],
        ["Model", metricValue([payload, run], ["model_name"])],
        ["Duration", metricValue([payload, run], ["duration_ms"]) !== null ? `${metricValue([payload, run], ["duration_ms"])} ms` : null],
        ["Mode", metricValue([run, payload], ["run_mode"])],
        ["Conversation IDs", Array.isArray(run.conversation_ids) ? run.conversation_ids.slice(0, 24).join(", ") : null],
      ];
    }

    if (eventType.startsWith("message_backfill_")) {
      const run = payload.backfill_run && typeof payload.backfill_run === "object" ? payload.backfill_run : payload;
      return [
        ["Processed", metricValue([payload, run, counters], ["processed_count", "conversations_processed"])],
        ["Succeeded", metricValue([payload, run, counters], ["succeeded_count", "conversations_succeeded"])],
        ["Failed", metricValue([payload, run, counters], ["failed_count"])],
        ["Skipped", metricValue([payload, run, counters], ["skipped_count"])],
        ["Pages", metricValue([payload, run, counters], ["pages_processed"])],
        ["Pages Remaining", metricValue([payload.progress || {}, run.progress || {}], ["pages_remaining"])],
        ["Estimated Total Pages", metricValue([payload.progress || {}, run.progress || {}], ["estimated_total_pages"])],
        ["Messages", metricValue([payload, run, counters], ["messages_processed"])],
        ["Classification Mode", metricValue([payload, run], ["classification_mode"])],
        ["Classified", metricValue([payload, run], ["classification_succeeded"])],
        ["Classification Failed", metricValue([payload, run], ["classification_failed"])],
        ["Classification Skipped", metricValue([payload, run], ["classification_skipped"])],
        ["Unclassified Before", metricValue([payload, run, counters], ["unclassified_before"])],
        ["Unclassified After", metricValue([payload, run, counters], ["unclassified_after"])],
        ["Remaining Unclassified", metricValue([payload, run, counters], ["remaining_unclassified", "unclassified_after"])],
        ["Duration", metricValue([payload, run], ["duration_ms"]) !== null ? `${metricValue([payload, run], ["duration_ms"])} ms` : null],
        ["Error", metricValue([payload, run], ["error_code", "last_error_code"])],
      ];
    }

    if (eventType.startsWith("message_sync_")) {
      const run = payload.sync_run && typeof payload.sync_run === "object" ? payload.sync_run : payload;
      return [
        ["Conversations Seen", metricValue([payload, run, counters], ["conversations_seen", "processed_count"])],
        ["Conversations Inserted", metricValue([payload, run, counters], ["conversations_inserted"])],
        ["Conversations Changed", metricValue([payload, run, counters], ["conversations_updated"])],
        ["Conversations Unchanged", metricValue([payload, run, counters], ["conversations_unchanged"])],
        ["Succeeded", metricValue([payload, run, counters], ["succeeded_count", "conversations_succeeded"])],
        ["Failed", metricValue([payload, run, counters], ["failed_count"])],
        ["Skipped", metricValue([payload, run, counters], ["skipped_count", "conversations_skipped"])],
        ["Pages", metricValue([payload, run, counters], ["pages_processed"])],
        ["Messages Scanned", metricValue([payload, run, counters], ["messages_seen", "messages_processed"])],
        ["Existing Messages Rechecked", metricValue([payload, run, counters], ["messages_rechecked"])],
        ["Messages Inserted", metricValue([payload, run, counters], ["messages_inserted"])],
        ["Messages Changed", metricValue([payload, run, counters], ["messages_updated"])],
        ["Canonical Total After Sync", metricValue([payload, run, counters], ["canonical_total_conversations", "canonicalTotalConversations"])],
        ["Unclassified Before", metricValue([payload, run, counters], ["unclassified_before"])],
        ["Unclassified After", metricValue([payload, run, counters], ["unclassified_after"])],
        ["Remaining Unclassified", metricValue([payload, run, counters], ["remaining_unclassified", "unclassified_after"])],
        ["Warnings", metricValue([payload, run, counters], ["warnings_count"])],
        ["Duration", metricValue([payload, run], ["duration_ms"]) !== null ? `${metricValue([payload, run], ["duration_ms"])} ms` : null],
        ["Checkpoint Scope", metricValue([payload, run], ["checkpoint_scope"])],
        ["Conversation IDs", Array.isArray(run.conversation_ids) ? run.conversation_ids.slice(0, 50).join(", ") : null],
        ["eBay Endpoint", metricValue([payload.ebay_api, run.ebay_api], ["endpoint"])],
        ["eBay Params", payload.ebay_api?.parameters ? JSON.stringify(payload.ebay_api.parameters) : (run.ebay_api?.parameters ? JSON.stringify(run.ebay_api.parameters) : null)],
        ["HTTP Status", metricValue([payload.ebay_api, run.ebay_api], ["http_status"])],
        ["Error", metricValue([payload, run], ["error_code", "last_error_code"])],
      ];
    }

    if (eventType.includes("send_attempt") || eventType === "duplicate_send_prevented") {
      const attempt = payload.send_attempt && typeof payload.send_attempt === "object" ? payload.send_attempt : {};
      const approval = payload.approval && typeof payload.approval === "object" ? payload.approval : {};
      const draft = payload.draft && typeof payload.draft === "object" ? payload.draft : {};
      const providerResponse = payload.provider_response && typeof payload.provider_response === "object" ? payload.provider_response : {};
      return [
        ["Send Attempt ID", metricValue([attempt, payload], ["id", "send_attempt_id"])],
        ["Draft ID", metricValue([draft, attempt, payload], ["id", "draft_id"])],
        ["Approval ID", metricValue([approval, attempt, payload], ["id", "approval_id"])],
        ["Target Message ID", metricValue([attempt, approval, draft, payload], ["target_message_id"])],
        ["Operator", metricValue([payload, event, approval, attempt], ["operator", "actor_email", "initiated_by", "approved_by_email", "created_by"])],
        ["Sent Text", metricValue([payload, draft], ["sent_text"])],
        ["Provider Message ID", metricValue([attempt, payload], ["provider_message_id"])],
        ["Provider", metricValue([attempt, payload], ["provider"])],
        ["Provider Status", metricValue([providerResponse, attempt, payload], ["status", "attempt_status"])],
        ["Provider Response", Object.keys(providerResponse).length ? JSON.stringify(providerResponse) : null],
        ["Provider Correlation ID", metricValue([attempt, payload], ["provider_correlation_id"])],
        ["Idempotency Key", metricValue([attempt, approval, payload], ["idempotency_key"])],
        ["Attempt Sequence", metricValue([attempt, payload], ["attempt_sequence"])],
        ["Created At", metricValue([attempt, event], ["created_at"])],
        ["Sent At", metricValue([attempt, payload], ["sent_at"])],
        ["Updated At", metricValue([attempt], ["updated_at"])],
        ["Error", metricValue([attempt, payload], ["error_message"])],
      ];
    }

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

    if (eventType === "sync_import_approved") {
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

  function renderClassificationRunDetails(event = {}, utils = window.EmailTriageRenderUtils) {
    const payload = eventPayload(event);
    const run = payload.classification_run && typeof payload.classification_run === "object" ? payload.classification_run : payload;
    const conversationIds = Array.isArray(run.conversation_ids) ? run.conversation_ids : [];
    const failures = Array.isArray(run.failures) ? run.failures : Array.isArray(payload.failures) ? payload.failures : [];
    const skipped = Array.isArray(run.skipped_results) ? run.skipped_results : Array.isArray(payload.skipped) ? payload.skipped : [];
    if (!payload.classification_run && payload.processed_count === undefined) return "";
    return `
      <div class="operational-detail-classification-run">
        <section>
          <h4>Conversation IDs</h4>
          ${conversationIds.length ? `
            ${conversationIds.slice(0, 50).map((id) => `
              <div>
                <span>${utils.escapeHtml(id)}</span>
                <strong>${utils.escapeHtml(utils.compactId(id))}</strong>
              </div>
            `).join("")}
          ` : `<div class="classification-empty operational-empty">No conversation ids recorded.</div>`}
        </section>
        <section>
          <h4>Failures</h4>
          ${failures.length ? `
            ${failures.slice(0, 12).map((row) => `
              <div>
                <span>${utils.escapeHtml(row.conversation_id || row.ebay_conversation_id || "Unknown conversation")}</span>
                <strong>${utils.escapeHtml(row.error || "failed")}</strong>
                <em>${utils.escapeHtml(row.reason || "No reason recorded")}</em>
              </div>
            `).join("")}
          ` : `<div class="classification-empty operational-empty">No failures recorded.</div>`}
        </section>
        <section>
          <h4>Skipped Reasons</h4>
          ${skipped.length ? `
            ${skipped.slice(0, 12).map((row) => `
              <div>
                <span>${utils.escapeHtml(row.conversation_id || row.ebay_conversation_id || "Unknown conversation")}</span>
                <strong>${utils.escapeHtml(utils.humanizeValue(row.reason || "skipped"))}</strong>
                <em>${utils.escapeHtml(row.classification_id ? `Classification ${row.classification_id}` : "No classification id recorded")}</em>
              </div>
            `).join("")}
          ` : `<div class="classification-empty operational-empty">No skipped conversations recorded.</div>`}
        </section>
      </div>
    `;
  }

  function renderOperationalEventDetail(event = null, utils = window.EmailTriageRenderUtils) {
    if (!event) {
      return `<div class="classification-empty operational-empty">Select an operational event to inspect details.</div>`;
    }
    const payload = eventPayload(event);
    const summary = summarizeOperationalEvent(event, utils);
    const safety = payload.safety && typeof payload.safety === "object" ? payload.safety : event.safety || {};
    const safetyFlags = [
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
      ${renderClassificationRunDetails(event, utils)}
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

  function renderBackfillCheckpointRows(checkpoints = [], utils = window.EmailTriageRenderUtils) {
    if (!checkpoints.length) {
      return `<div class="classification-empty operational-empty">No historical backfill checkpoint has been recorded yet.</div>`;
    }

    return checkpoints.slice(0, 4).map((checkpoint) => {
      const total = Number(checkpoint.total_available || 0);
      const page = Number(checkpoint.pages_processed || 0);
      const providedEstimate = Number(checkpoint.estimated_total_pages || 0);
      const estimatedPages = providedEstimate || (
        total && Number(checkpoint.metadata?.last_page_processed || checkpoint.last_page_processed || 0) >= 0
          ? Math.ceil(total / Math.max(1, Number(checkpoint.metadata?.page_limit || 25)))
          : null
      );
      const remaining = checkpoint.pages_remaining === null || checkpoint.pages_remaining === undefined
        ? (estimatedPages ? Math.max(estimatedPages - page, 0) : null)
        : Number(checkpoint.pages_remaining);
      const status = String(checkpoint.status || "idle");
      const statusVariant = status === "succeeded" ? "success" : status === "failed" ? "danger" : status === "running" ? "warning" : status === "paused" || status === "idle" ? "muted" : "muted";
      const statusLabel = status === "idle" ? "paused" : status;
      const pageText = estimatedPages ? `${page} / ${estimatedPages}` : String(page || "--");
      const remainingText = remaining === null || !Number.isFinite(remaining) ? "" : ` · ${remaining} remaining`;
      return `
        <div class="operational-row">
          <span>${utils.escapeHtml(checkpoint.conversation_type || "Conversation type")}</span>
          <strong>${utils.escapeHtml(`Pages ${pageText}`)}</strong>
          <em>${utils.escapeHtml(`${checkpoint.conversations_processed || 0} conversations · ${checkpoint.messages_processed || 0} messages${remainingText} · updated ${utils.formatDateTime(checkpoint.updated_at)}`)}</em>
          ${dashboardBadge(utils.humanizeValue(statusLabel), statusVariant, utils)}
        </div>
      `;
    }).join("");
  }

  function renderEbayOperationalDashboard(state = {}, snapshot = {}, utils = window.EmailTriageRenderUtils) {
    const ebay = snapshot.ebay || {};
    const metrics = ebay.metrics || {};
    const safety = ebay.send_safety || {};
    const approvalQueue = ebay.approval_queue || {};
    const latestSync = ebay.latest_sync || {};
    const latestSyncRun = latestSync.run || {};
    const activeSyncRuns = Array.isArray(latestSync.active_runs) ? latestSync.active_runs : [];
    const classificationRuns = ebay.classification_runs || {};
    const latestClassificationRun = classificationRuns.latest || {};
    const activeClassificationRuns = Array.isArray(classificationRuns.active) ? classificationRuns.active : [];
    const backfill = ebay.backfill || {};
    const checkpoints = Array.isArray(backfill.checkpoints) ? backfill.checkpoints : [];
    const activeBackfills = Array.isArray(backfill.active) ? backfill.active : [];
    const latestSyncStatus = activeSyncRuns.length
      ? "running"
      : latestSyncRun.status || latestSync.event?.status || "not_started";
    const latestSyncStatusVariant = latestSyncStatus === "succeeded" || latestSyncStatus === "completed"
      ? "success"
      : latestSyncStatus === "failed"
      ? "danger"
      : latestSyncStatus === "running" || latestSyncStatus === "pending"
      ? "warning"
      : "muted";
    const backfillStatus = String(backfill.status || "not_started");
    const backfillStatusVariant = backfillStatus === "completed" ? "success" : backfillStatus === "failed" ? "danger" : backfillStatus === "running" ? "warning" : "muted";
    const classificationStatus = activeClassificationRuns.length
      ? "running"
      : latestClassificationRun.status || "not_started";
    const classificationStatusVariant = eventStatusVariant({ status: classificationStatus });
    const events = Array.isArray(ebay.recent_operational_events) ? ebay.recent_operational_events : [];
    const blocked = ebay.ok === false || Number(metrics.send_attempts_failed || 0) > 0 || safety.automatic_responses_sent > 0;

    return `
      <div class="operational-dashboard-status">
        <span>${state.operationalDashboardLoading ? "Refreshing eBay operations" : `eBay operations refreshed ${utils.formatDateTime(state.operationalDashboardUpdatedAt || ebay.generated_at || snapshot.generated_at)}`}</span>
        ${state.operationalDashboardError ? dashboardBadge(`Error: ${state.operationalDashboardError}`, "danger", utils) : ""}
        ${ebay.ok === false ? dashboardBadge(ebay.error || "eBay dashboard partial", "warning", utils) : ""}
        ${dashboardBadge(blocked ? "Attention needed" : "Controlled send enabled", blocked ? "warning" : "success", utils)}
      </div>

      <div class="operational-dashboard-grid">
        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>eBay Message Metrics</strong>
            ${dashboardBadge("Canonical", "success", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Total canonical", value: metrics.canonical_conversations },
              { label: "Conversations today", value: metrics.conversations_today },
              { label: "Unread conversations", value: metrics.unread_conversations },
              { label: "Unclassified", value: metrics.unclassified_conversations },
              { label: "Needs reply", value: metrics.needs_reply },
              { label: "High priority", value: metrics.high_priority },
              { label: "Returns", value: metrics.returns },
              { label: "Refund risk", value: metrics.refund_risk },
              { label: "VIP buyers", value: metrics.vip_buyers },
              { label: "Drafts generated today", value: metrics.drafts_generated },
              { label: "Sent drafts", value: metrics.sent_drafts },
            ], utils)}
          </div>
        </section>

        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>Latest Sync</strong>
            ${dashboardBadge(activeSyncRuns.length ? "Running" : "Recent incremental", activeSyncRuns.length ? "warning" : "muted", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Lifecycle status", html: dashboardBadge(utils.humanizeValue(latestSyncStatus), latestSyncStatusVariant, utils) },
              { label: "Started", value: latestSyncRun.started_at ? utils.formatDateTime(latestSyncRun.started_at) : "--" },
              { label: "Completed", value: latestSyncRun.completed_at ? utils.formatDateTime(latestSyncRun.completed_at) : "--" },
              { label: "Conversations scanned", value: metrics.latest_sync_conversations_seen },
              { label: "Inserted", value: metrics.latest_sync_conversations_inserted },
              { label: "Changed", value: metrics.latest_sync_conversations_updated },
              { label: "Unchanged", value: metrics.latest_sync_conversations_unchanged },
              { label: "Messages scanned", value: metrics.latest_sync_messages_scanned },
              { label: "Messages rechecked", value: metrics.latest_sync_messages_rechecked },
              { label: "Messages inserted", value: metrics.latest_sync_messages_inserted },
              { label: "Messages changed", value: metrics.latest_sync_messages_changed ?? metrics.latest_sync_messages_updated },
              { label: "Canonical after sync", value: metrics.latest_sync_canonical_total_after ?? metrics.canonical_conversations },
            ], utils)}
          </div>
        </section>

        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>Latest Classification Batch</strong>
            ${dashboardBadge(activeClassificationRuns.length ? "Running" : utils.humanizeValue(classificationStatus), activeClassificationRuns.length ? "warning" : classificationStatusVariant, utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Lifecycle status", html: dashboardBadge(utils.humanizeValue(classificationStatus), classificationStatusVariant, utils) },
              { label: "Run id", value: latestClassificationRun.id ? utils.compactId(latestClassificationRun.id) : "--" },
              { label: "Mode", value: latestClassificationRun.payload?.run_mode ? utils.humanizeValue(latestClassificationRun.payload.run_mode) : "--" },
              { label: "Started", value: latestClassificationRun.started_at ? utils.formatDateTime(latestClassificationRun.started_at) : "--" },
              { label: "Completed", value: latestClassificationRun.completed_at ? utils.formatDateTime(latestClassificationRun.completed_at) : "--" },
              { label: "Requested limit", value: latestClassificationRun.payload?.requested_limit ?? latestClassificationRun.requested_limit ?? "--" },
              { label: "Processed", value: metrics.latest_classification_processed },
              { label: "Classified", value: metrics.latest_classification_classified },
              { label: "Failed", value: metrics.latest_classification_failed },
              { label: "Skipped", value: metrics.latest_classification_skipped },
              { label: "Remaining unclassified", value: metrics.latest_classification_remaining_unclassified ?? "--" },
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
            ${dashboardBadge("Human confirmed", "success", utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Controlled sends", html: dashboardBadge(safety.sends_enabled ? "enabled" : "disabled", safety.sends_enabled ? "success" : "muted", utils) },
              { label: "Send attempts", value: metrics.send_attempts_created },
              { label: "Failed attempts", value: metrics.send_attempts_failed },
              { label: "Succeeded attempts", value: metrics.send_attempts_succeeded },
              { label: "Duplicates blocked", value: metrics.duplicate_sends_prevented },
            ], utils)}
          </div>
          ${renderOperationalNote(`Duplicate guard: ${utils.humanizeValue(safety.duplicate_success_guard || "one_success_per_idempotency_key")}.`, utils)}
        </section>

        <section class="operational-panel operational-panel-wide">
          <div class="operational-panel-head">
            <strong>Historical Backfill</strong>
            ${dashboardBadge(activeBackfills.length ? `${activeBackfills.length} running` : utils.humanizeValue(backfillStatus), activeBackfills.length ? "warning" : backfillStatusVariant, utils)}
          </div>
          <div class="operational-metric-grid">
            ${renderKeyValueGrid([
              { label: "Status", value: utils.humanizeValue(backfillStatus) },
              { label: "Pages", value: metrics.backfill_pages },
              { label: "Estimated total pages", value: metrics.backfill_pages_total_estimate ?? "--" },
              { label: "Pages remaining", value: metrics.backfill_pages_remaining ?? "--" },
              { label: "Conversations", value: metrics.backfill_conversations },
              { label: "Messages", value: metrics.backfill_messages },
              { label: "Last full backfill", value: backfill.latest_completed?.last_full_backfill_at ? utils.formatDateTime(backfill.latest_completed.last_full_backfill_at) : "--" },
            ], utils)}
          </div>
          <div class="operational-activity-list">
            ${renderBackfillCheckpointRows(checkpoints, utils)}
          </div>
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
            ${dashboardBadge(`eBay provider send: ${safety.ebay_mutation_performed ? "yes" : "no"}`, safety.ebay_mutation_performed ? "success" : "muted", utils)}
            ${dashboardBadge(`Auto-send: ${safety.automatic_responses_sent || 0}`, safety.automatic_responses_sent ? "danger" : "success", utils)}
            ${dashboardBadge(`Human-only send: ${safety.controlled_human_send_only ? "true" : "false"}`, safety.controlled_human_send_only ? "success" : "warning", utils)}
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
    return renderEbayOperationalDashboard(state, snapshot, utils);
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
