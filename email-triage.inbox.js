(function () {
  "use strict";

  const BUCKET_LABELS = {
    likely_ebay: "Likely eBay",
    maybe_ebay: "Maybe eBay",
    not_ebay: "Not eBay",
  };

  function renderMessageRows(messages = [], utils = window.EmailTriageRenderUtils) {
    if (!messages.length) {
      return `<tr><td colspan="4">No messages loaded.</td></tr>`;
    }

    return messages.map((message) => `
      <tr>
        <td class="email-sender">${utils.escapeHtml(message.from || "Unknown sender")}</td>
        <td class="email-subject">${utils.escapeHtml(message.subject || "(No subject)")}</td>
        <td class="email-received">${utils.escapeHtml(utils.formatDateTime(message.receivedDateTime))}</td>
        <td class="email-preview">${utils.escapeHtml(message.bodyPreview || "")}</td>
      </tr>
    `).join("");
  }

  function getInboxPreviewElements() {
    return {
      run: document.getElementById("inbox-preview-run"),
      limit: document.getElementById("inbox-preview-limit"),
      daysBack: document.getElementById("inbox-preview-days-back"),
      bucketMode: document.getElementById("inbox-preview-bucket-mode"),
      status: document.getElementById("inbox-preview-status"),
      countPill: document.getElementById("inbox-preview-count-pill"),
      summary: document.getElementById("inbox-preview-summary"),
      importResult: document.getElementById("inbox-preview-import-result"),
      mailboxImportTarget: document.getElementById("inbox-mailbox-import-target"),
      mailboxImportStart: document.getElementById("inbox-mailbox-import-start"),
      mailboxImportContinue: document.getElementById("inbox-mailbox-import-continue"),
      mailboxImportResult: document.getElementById("inbox-mailbox-import-result"),
      prepareMailboxRun: document.getElementById("inbox-prepare-mailbox-run"),
      prepareMailboxContinue: document.getElementById("inbox-prepare-mailbox-continue"),
      prepareMailboxResult: document.getElementById("inbox-prepare-mailbox-result"),
      body: document.getElementById("inbox-preview-body"),
      importLikely: document.getElementById("inbox-import-likely"),
      importSelected: document.getElementById("inbox-import-selected"),
      liveRefresh: document.getElementById("inbox-live-refresh-run"),
      liveRefreshResult: document.getElementById("inbox-live-refresh-result"),
      rematchExisting: document.getElementById("inbox-rematch-existing-run"),
      rematchContinue: document.getElementById("inbox-rematch-existing-continue"),
      rematchScope: document.getElementById("inbox-rematch-scope"),
      rematchExistingResult: document.getElementById("inbox-rematch-existing-result"),
      clear: document.getElementById("inbox-preview-clear"),
      bucketFilters: document.querySelectorAll("[data-inbox-bucket-filter]"),
      section: document.getElementById("admin-diagnostics-drawer"),
    };
  }

  function previewControlsFromEls(els) {
    return {
      limit: Number(els.limit?.value || 25),
      daysBack: els.daysBack?.value || "",
      bucketMode: els.bucketMode?.value || "ebay_only",
    };
  }

  function selectedMailboxMessageId(state) {
    if (state.selectedMessageId) return String(state.selectedMessageId);
    const selected = state.selectedClassificationsById?.[state.selectedClassificationId];
    return selected?.message_id ? String(selected.message_id) : "";
  }

  function currentPageMessageIds(state) {
    const rows = Array.isArray(state.data?.classifications) ? state.data.classifications : [];
    return [...new Set(rows.map((row) => String(row?.message_id || "").trim()).filter(Boolean))];
  }

  function mailboxQueryFromState(state) {
    const pagination = state.pagination || {};
    return {
      page: Number(pagination.page || 1),
      pageSize: Number(pagination.pageSize || pagination.limit || 25),
      sort: pagination.sort || state.sortMode || "newest",
      category: state.selectedCategory || pagination.filters?.category || "all",
      priority: state.priorityFilter || pagination.filters?.priority || "all",
      status: state.statusFilter || pagination.filters?.status || "all",
      filters: Array.isArray(state.activeFilters) ? state.activeFilters : [],
    };
  }

  function rematchPayloadFromState(state, els, options = {}) {
    const uiScope = options.scope || els.rematchScope?.value || state.inboxRematchScope || "selected";
    const continuation = options.continuation || null;
    const payload = {
      scope: uiScope,
      limit: 50,
      cursor: continuation?.next_cursor || null,
      messageIds: [],
    };

    if (uiScope === "selected") {
      payload.scope = "selected";
      payload.limit = 1;
      payload.messageId = selectedMailboxMessageId(state);
    } else if (uiScope === "current_page") {
      payload.scope = "current_page";
      payload.messageIds = currentPageMessageIds(state);
      payload.limit = payload.messageIds.length || Number((state.pagination || {}).pageSize || 25);
    } else if (uiScope === "current_filter") {
      payload.scope = "current_filter";
      payload.limit = 50;
      payload.mailboxQuery = continuation?.mailbox_query || mailboxQueryFromState(state);
    } else if (uiScope === "latest_100") {
      payload.scope = "latest";
      payload.limit = 100;
    } else if (uiScope === "all_imported") {
      payload.scope = "all_imported";
      payload.limit = 50;
    } else {
      payload.scope = "latest";
      payload.limit = 25;
    }

    return payload;
  }

  function rematchRunLabel(scope) {
    const labels = {
      selected: "Run Selected Rematch",
      current_page: "Run Page Rematch",
      current_filter: "Run Filter Rematch",
      latest_25: "Run Latest 25 Rematch",
      latest_100: "Run Latest 100 Rematch",
      all_imported: "Run Chunked Rematch",
    };
    return labels[scope] || "Run Rematch";
  }

  function rematchScopeLabel(scope) {
    const labels = {
      selected: "Selected email",
      current_page: "Current loaded page",
      current_filter: "Current category/filter",
      latest: "Latest imported emails",
      latest_25: "Latest 25 imported emails",
      latest_100: "Latest 100 imported emails",
      all_imported: "All imported emails, chunked",
    };
    return labels[scope] || "Explicit scope";
  }

  function providerIdFor(row) {
    return String(row?.provider_message_id || row?.providerMessageId || "");
  }

  function bucketFor(row) {
    return String(row?.bucket || "not_ebay");
  }

  function rowSender(row) {
    const name = row?.from_name || row?.sender_name || "";
    const email = row?.from_email || row?.sender_email || "";
    return [name, email].filter(Boolean).join(" <") + (name && email ? ">" : "") || "Unknown sender";
  }

  function sortedDomainSummary(summary = {}) {
    return Object.entries(summary)
      .sort((left, right) => Number(right[1] || 0) - Number(left[1] || 0))
      .slice(0, 8);
  }

  function selectedIds(state) {
    return Array.isArray(state.inboxPreviewSelectedProviderMessageIds)
      ? state.inboxPreviewSelectedProviderMessageIds
      : [];
  }

  function selectableRows(state) {
    const rows = Array.isArray(state.inboxPreviewResult?.messages) ? state.inboxPreviewResult.messages : [];
    return rows.filter((row) => providerIdFor(row) && row.already_imported !== true && bucketFor(row) !== "not_ebay");
  }

  function likelyImportableRows(state) {
    const rows = Array.isArray(state.inboxPreviewResult?.messages) ? state.inboxPreviewResult.messages : [];
    return rows.filter((row) => providerIdFor(row) && row.already_imported !== true && bucketFor(row) === "likely_ebay");
  }

  function selectedImportableIds(state) {
    const allowed = new Set(selectableRows(state).map(providerIdFor));
    return selectedIds(state).filter((id) => allowed.has(id));
  }

  function previewImportability(state) {
    const rows = Array.isArray(state.inboxPreviewResult?.messages) ? state.inboxPreviewResult.messages : [];
    return {
      previewRowsCount: rows.length,
      importableLikelyCount: likelyImportableRows(state).length,
      selectedImportableCount: selectedImportableIds(state).length,
    };
  }

  function previewResultAfterImport(state, result) {
    const preview = state.inboxPreviewResult;
    const rows = Array.isArray(preview?.messages) ? preview.messages : [];
    const importedMessages = Array.isArray(result?.messages) ? result.messages : [];
    if (!preview || !rows.length || !importedMessages.length) return preview || null;

    const importedByProviderId = new Map(
      importedMessages
        .filter((message) => message?.provider_message_id && ["imported", "already_imported"].includes(String(message.import_status || "")))
        .map((message) => [String(message.provider_message_id), message]),
    );
    if (!importedByProviderId.size) return preview;

    const nextRows = rows.map((row) => {
      const imported = importedByProviderId.get(providerIdFor(row));
      if (!imported) return row;
      return {
        ...row,
        already_imported: true,
        existing_message_id: imported.message_id || row.existing_message_id || null,
      };
    });
    const importedCount = nextRows.filter((row) => row.already_imported === true).length;
    return {
      ...preview,
      already_imported_summary: {
        imported: importedCount,
        not_imported: Math.max(nextRows.length - importedCount, 0),
      },
      messages: nextRows,
    };
  }

  function importControlsFromState(state) {
    const controls = state.inboxPreviewControls || {};
    return {
      limit: Number(controls.limit || 25),
      daysBack: controls.daysBack === "" || controls.daysBack == null ? null : Number(controls.daysBack),
      bucketMode: controls.bucketMode || "ebay_only",
    };
  }

  function renderReasonCodes(codes = [], utils = window.EmailTriageRenderUtils) {
    const list = Array.isArray(codes) ? codes.filter(Boolean) : [];
    if (!list.length) return `<span class="inbox-chip is-muted">No reason</span>`;
    return list.map((code) => `<span class="inbox-chip">${utils.escapeHtml(code)}</span>`).join("");
  }

  function renderInboxBadge(label, variant = "muted", utils = window.EmailTriageRenderUtils) {
    return `<span class="inbox-chip is-${utils.escapeHtml(variant)}">${utils.escapeHtml(label)}</span>`;
  }

  function renderInboxSummary(state, els, utils = window.EmailTriageRenderUtils) {
    if (!els.summary) return;
    const result = state.inboxPreviewResult;
    if (!result) {
      els.summary.innerHTML = "";
      return;
    }

    const bucket = result.bucket_summary || {};
    const imported = result.already_imported_summary || {};
    const domains = sortedDomainSummary(result.sender_domain_summary);
    els.summary.innerHTML = `
      <div><span>Total Previewed</span><strong>${utils.escapeHtml(result.messages_previewed || 0)}</strong></div>
      <div><span>Likely eBay</span><strong>${utils.escapeHtml(bucket.likely_ebay || 0)}</strong></div>
      <div><span>Maybe eBay</span><strong>${utils.escapeHtml(bucket.maybe_ebay || 0)}</strong></div>
      <div><span>Not eBay</span><strong>${utils.escapeHtml(bucket.not_ebay || 0)}</strong></div>
      <div><span>Already Imported</span><strong>${utils.escapeHtml(imported.imported || 0)}</strong></div>
      <div><span>Not Imported</span><strong>${utils.escapeHtml(imported.not_imported || 0)}</strong></div>
      <div class="inbox-summary-wide">
        <span>Sender / Domain Summary</span>
        <div class="inbox-domain-list">
          ${domains.length ? domains.map(([domain, count]) => `<b>${utils.escapeHtml(domain)} <em>${utils.escapeHtml(count)}</em></b>`).join("") : "<b>None</b>"}
        </div>
      </div>
    `;
  }

  function renderImportResult(state, els, utils = window.EmailTriageRenderUtils) {
    if (!els.importResult) return;
    const result = state.inboxImportResult;
    if (!result || state.inboxImportResultCleared) {
      els.importResult.innerHTML = "";
      return;
    }
    const skippedReasons = Object.entries(result.skipped_reasons || {});
    els.importResult.innerHTML = `
      <div class="inbox-import-result-head">
        <strong>Approved import-only result</strong>
        <span>${result.operation_event_id ? `Operation event ${utils.escapeHtml(result.operation_event_id)}` : "No operation event id returned"}</span>
        <button type="button" class="secondary-btn inbox-result-clear-btn" data-inbox-clear-result="import">Clear Import Result</button>
      </div>
      <p class="inbox-result-note">Messages were persisted, then mailbox preparation was requested. Preparation is bounded, so continue if remaining work is shown.</p>
      <dl>
        <div><dt>Imported</dt><dd>${utils.escapeHtml(result.imported_count)}</dd></div>
        <div><dt>Already Imported</dt><dd>${utils.escapeHtml(result.already_imported_count)}</dd></div>
        <div><dt>Skipped</dt><dd>${utils.escapeHtml(result.skipped_count)}</dd></div>
        <div><dt>Classification Created</dt><dd>${utils.escapeHtml(result.classification_created)}</dd></div>
        <div><dt>Drafts Created</dt><dd>${utils.escapeHtml(result.drafts_created)}</dd></div>
        <div><dt>Outlook Mutation</dt><dd>${renderInboxBadge(result.outlook_mutation_performed ? "true" : "false", result.outlook_mutation_performed ? "danger" : "success", utils)}</dd></div>
        <div><dt>Checkpoint Updated</dt><dd>${renderInboxBadge(result.sync_checkpoint_updated ? "true" : "false", result.sync_checkpoint_updated ? "danger" : "success", utils)}</dd></div>
      </dl>
      <div class="inbox-skipped-reasons">
        <span>Skipped Reasons</span>
        ${skippedReasons.length ? skippedReasons.map(([reason, count]) => `<b>${utils.escapeHtml(reason)} <em>${utils.escapeHtml(count)}</em></b>`).join("") : "<b>None</b>"}
      </div>
    `;
  }

  function renderMailboxImportResult(state, els, utils = window.EmailTriageRenderUtils) {
    if (!els.mailboxImportResult) return;
    const result = state.inboxMailboxImportResult;
    if (!result || state.inboxMailboxImportResultCleared) {
      els.mailboxImportResult.innerHTML = "";
      return;
    }

    const progress = result.progress || {};
    const batch = result.batch || {};
    const safety = result.safety || {};
    const completed = Number(progress.completed_total || 0);
    const target = Number(progress.target_count || result.target_count || 0);
    const percent = target > 0 ? Math.min(Math.round((completed / target) * 100), 100) : 0;
    els.mailboxImportResult.innerHTML = `
      <div class="inbox-import-result-head">
        <strong>Mailbox import progress</strong>
        <span>${utils.escapeHtml(progress.status || "not_started")}${result.operation_event_id ? ` · operation ${utils.escapeHtml(result.operation_event_id)}` : ""}</span>
        <button type="button" class="secondary-btn inbox-result-clear-btn" data-inbox-clear-result="mailbox_import">Clear Import Result</button>
      </div>
      <p class="inbox-result-note">Bounded mailbox import persists messages in batches. This screen can prepare imported rows afterward without drafts, sending, or Outlook mutation.</p>
      <dl>
        <div><dt>Target</dt><dd>${utils.escapeHtml(target || "--")}</dd></div>
        <div><dt>Progress</dt><dd>${utils.escapeHtml(`${completed}/${target || "--"} (${percent}%)`)}</dd></div>
        <div><dt>Imported</dt><dd>${utils.escapeHtml(progress.imported_total || 0)}</dd></div>
        <div><dt>Already Imported</dt><dd>${utils.escapeHtml(progress.already_imported_total || 0)}</dd></div>
        <div><dt>Failed</dt><dd>${utils.escapeHtml(progress.failed_total || 0)}</dd></div>
        <div><dt>Remaining</dt><dd>${utils.escapeHtml(progress.remaining_estimate || 0)}</dd></div>
        <div><dt>Has More</dt><dd>${renderInboxBadge(progress.has_more ? "true" : "false", progress.has_more ? "warning" : "success", utils)}</dd></div>
        <div><dt>Continuation</dt><dd>${renderInboxBadge(progress.continuation_available ? "available" : "none", progress.continuation_available ? "warning" : "muted", utils)}</dd></div>
      </dl>
      <div class="inbox-skipped-reasons">
        <span>Last Batch</span>
        <b>pages <em>${utils.escapeHtml(batch.pages_fetched || 0)}</em></b>
        <b>seen <em>${utils.escapeHtml(batch.messages_seen || 0)}</em></b>
        <b>new <em>${utils.escapeHtml(batch.imported_count || 0)}</em></b>
        <b>already <em>${utils.escapeHtml(batch.already_imported_count || 0)}</em></b>
        <b>failed <em>${utils.escapeHtml(batch.failed_count || 0)}</em></b>
      </div>
      <dl class="inbox-live-refresh-safety">
        <div><dt>Outlook Mutation</dt><dd>${renderInboxBadge(safety.outlook_mutation_performed ? "true" : "false", safety.outlook_mutation_performed ? "danger" : "success", utils)}</dd></div>
        <div><dt>Processing</dt><dd>${renderInboxBadge(safety.processing_triggered ? "true" : "false", safety.processing_triggered ? "danger" : "muted", utils)}</dd></div>
        <div><dt>Classification</dt><dd>${renderInboxBadge(safety.classification_triggered ? "true" : "false", safety.classification_triggered ? "danger" : "muted", utils)}</dd></div>
        <div><dt>Checkpoint Updated</dt><dd>${renderInboxBadge(safety.sync_checkpoint_updated ? "true" : "false", safety.sync_checkpoint_updated ? "success" : "muted", utils)}</dd></div>
      </dl>
    `;
  }

  function renderPrepareMailboxResult(state, els, utils = window.EmailTriageRenderUtils) {
    if (!els.prepareMailboxResult) return;
    const result = state.inboxPrepareResult;
    if (!result || state.inboxPrepareResultCleared) {
      els.prepareMailboxResult.innerHTML = "";
      return;
    }

    const progress = result.progress || {};
    const processing = result.processing || {};
    const classification = result.classification || {};
    const safety = result.safety || {};
    const status = result.disabled
      ? `Paused: ${result.reason || "disabled"}`
      : progress.has_more
      ? "More preparation available"
      : progress.only_failures_remain
      ? "Only failures remain"
      : "Mailbox ready";

    els.prepareMailboxResult.innerHTML = `
      <div class="inbox-import-result-head">
        <strong>Mailbox preparation progress</strong>
        <span>${utils.escapeHtml(status)}</span>
        <button type="button" class="secondary-btn inbox-result-clear-btn" data-inbox-clear-result="prepare">Clear Preparation Result</button>
      </div>
      <p class="inbox-result-note">Preparation normalizes messages, matches local eBay context, and classifies eligible emails in bounded batches. Drafts and sending stay manual.</p>
      <dl>
        <div><dt>Imported Active</dt><dd>${utils.escapeHtml(progress.imported_active || 0)}</dd></div>
        <div><dt>Processed</dt><dd>${utils.escapeHtml(progress.processed_total || 0)}</dd></div>
        <div><dt>Classified</dt><dd>${utils.escapeHtml(progress.classified_total || 0)}</dd></div>
        <div><dt>Remaining To Process</dt><dd>${utils.escapeHtml(progress.remaining_to_process || 0)}</dd></div>
        <div><dt>Remaining To Classify</dt><dd>${utils.escapeHtml(progress.remaining_to_classify || 0)}</dd></div>
        <div><dt>Processing Failed</dt><dd>${utils.escapeHtml(progress.processing_failed || 0)}</dd></div>
        <div><dt>Classification Failed/Skipped</dt><dd>${utils.escapeHtml(Number(progress.classification_failed || 0) + Number(progress.classification_skipped || 0))}</dd></div>
        <div><dt>Has More</dt><dd>${renderInboxBadge(progress.has_more ? "yes" : "no", progress.has_more ? "warning" : "success", utils)}</dd></div>
      </dl>
      <div class="inbox-live-refresh-grid">
        ${renderStageCounts("This Processing Pass", processing, [
          ["candidate_count", "Candidates"],
          ["jobs_enqueued", "Jobs enqueued"],
          ["jobs_processed", "Jobs processed"],
          ["failed_count", "Failed"],
        ], utils)}
        ${renderStageCounts("This Classification Pass", classification, [
          ["candidate_count", "Candidates"],
          ["classified_count", "Classified"],
          ["failed_count", "Failed"],
          ["skipped_count", "Skipped"],
        ], utils)}
      </div>
      <dl class="inbox-live-refresh-safety">
        <div><dt>Outlook Mutation</dt><dd>${renderInboxBadge(safety.outlook_mutation_performed ? "true" : "false", safety.outlook_mutation_performed ? "danger" : "success", utils)}</dd></div>
        <div><dt>Drafts Created</dt><dd>${renderInboxBadge(String(safety.drafts_created || 0), safety.drafts_created ? "danger" : "success", utils)}</dd></div>
        <div><dt>Emails Sent</dt><dd>${renderInboxBadge(String(safety.automatic_responses_sent || 0), safety.automatic_responses_sent ? "danger" : "success", utils)}</dd></div>
        <div><dt>Source</dt><dd>${utils.escapeHtml(progress.source || "email_tables")}</dd></div>
      </dl>
    `;
  }

  function renderCompactIdList(ids = [], emptyLabel = "None", utils = window.EmailTriageRenderUtils) {
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) return `<b>${utils.escapeHtml(emptyLabel)}</b>`;
    const visible = list.slice(0, 20);
    const overflow = list.length - visible.length;
    return `
      ${visible.map((id) => `<b title="${utils.escapeHtml(id)}">${utils.escapeHtml(utils.compactId(id))}</b>`).join("")}
      ${overflow > 0 ? `<b><em>+${utils.escapeHtml(overflow)}</em> more</b>` : ""}
    `;
  }

  function renderRematchFailures(failures = [], utils = window.EmailTriageRenderUtils) {
    const list = Array.isArray(failures) ? failures : [];
    if (!list.length) return `<b>None</b>`;
    return list.slice(0, 12).map((failure) => {
      const messageId = failure?.message_id || failure?.messageId || "unknown";
      const reason = failure?.error || failure?.code || failure?.reason || "failed";
      const phase = failure?.phase ? ` (${failure.phase})` : "";
      return `<b title="${utils.escapeHtml(messageId)}">${utils.escapeHtml(utils.compactId(messageId))} <em>${utils.escapeHtml(`${reason}${phase}`)}</em></b>`;
    }).join("") + (list.length > 12 ? `<b><em>+${utils.escapeHtml(list.length - 12)}</em> more</b>` : "");
  }

  function renderStageCounts(title, counts = {}, fields = [], utils = window.EmailTriageRenderUtils) {
    return `
      <div class="inbox-live-stage">
        <strong>${utils.escapeHtml(title)}</strong>
        <dl>
          ${fields.map(([key, label]) => `
            <div><dt>${utils.escapeHtml(label)}</dt><dd>${utils.escapeHtml(counts[key] || 0)}</dd></div>
          `).join("")}
        </dl>
      </div>
    `;
  }

  function renderLiveRefreshResult(state, els, utils = window.EmailTriageRenderUtils) {
    if (!els.liveRefreshResult) return;
    const result = state.inboxLiveRefreshResult;
    if (!result || state.inboxLiveRefreshResultCleared) {
      els.liveRefreshResult.innerHTML = "";
      return;
    }

    const safety = result.safety || {};
    const queue = result.queue_state || {};
    const children = Object.entries(result.child_operations || {}).filter(([, value]) => value);
    els.liveRefreshResult.innerHTML = `
      <div class="inbox-live-refresh-head">
        <strong>Live refresh result</strong>
        <span>${result.operation_id ? `Operation ${utils.escapeHtml(result.operation_id)}` : "No parent operation id returned"}</span>
        <button type="button" class="secondary-btn inbox-result-clear-btn" data-inbox-clear-result="live_refresh">Clear Operation Result</button>
      </div>
      ${result.blocked ? `<div class="workspace-status inbox-preview-status">Live refresh blocked safely: ${utils.escapeHtml(result.reason || "blocked")}</div>` : ""}
      <div class="inbox-live-refresh-scope">
        <div>
          <strong>This operation:</strong>
          <ul>
            <li>previews Outlook emails</li>
            <li>imports likely eBay messages</li>
            <li>processes imported messages</li>
            <li>classifies processed messages</li>
          </ul>
        </div>
        <div>
          <strong>This operation DOES NOT:</strong>
          <ul>
            <li>send emails</li>
            <li>mutate Outlook</li>
            <li>auto-generate drafts</li>
            <li>start autonomous sync</li>
          </ul>
        </div>
      </div>
      <div class="inbox-live-refresh-grid">
        ${renderStageCounts("Preview", result.preview, [
          ["previewed_count", "Previewed"],
          ["likely_ebay_count", "Likely"],
          ["maybe_ebay_count", "Maybe"],
          ["not_ebay_count", "Not eBay"],
        ], utils)}
        ${renderStageCounts("Import", result.import, [
          ["imported_count", "Imported"],
          ["already_imported_count", "Already"],
          ["skipped_count", "Skipped"],
        ], utils)}
        ${renderStageCounts("Processing", result.processing, [
          ["processed_count", "Processed"],
          ["jobs_enqueued", "Jobs enqueued"],
          ["jobs_processed", "Jobs processed"],
          ["failed_count", "Failed"],
          ["skipped_count", "Skipped"],
        ], utils)}
        ${renderStageCounts("Classification", result.classification, [
          ["classified_count", "Classified"],
          ["failed_count", "Failed"],
          ["skipped_count", "Skipped"],
        ], utils)}
      </div>
      <dl class="inbox-live-refresh-safety">
        <div><dt>Live Sync Enabled</dt><dd>${renderInboxBadge(result.live_sync_enabled ? "true" : "false", result.live_sync_enabled ? "success" : "danger", utils)}</dd></div>
        <div><dt>Outlook Mutation</dt><dd>${renderInboxBadge(safety.outlook_mutation_performed ? "true" : "false", safety.outlook_mutation_performed ? "danger" : "success", utils)}</dd></div>
        <div><dt>Emails Sent</dt><dd>${renderInboxBadge(String(safety.automatic_responses_sent || 0), safety.automatic_responses_sent ? "danger" : "success", utils)}</dd></div>
        <div><dt>Drafts Created</dt><dd>${renderInboxBadge(String(safety.drafts_created || 0), safety.drafts_created ? "danger" : "success", utils)}</dd></div>
        <div><dt>Attachments Fetched</dt><dd>${renderInboxBadge(String(safety.attachments_fetched || 0), safety.attachments_fetched ? "danger" : "success", utils)}</dd></div>
        <div><dt>Checkpoint Updated</dt><dd>${renderInboxBadge(safety.sync_checkpoint_updated ? "true" : "false", safety.sync_checkpoint_updated ? "danger" : "success", utils)}</dd></div>
        <div><dt>Queue</dt><dd>${utils.escapeHtml(`queued ${queue.queued || 0}, running ${queue.running || 0}${queue.saturated ? ", saturated" : ""}`)}</dd></div>
      </dl>
      <div class="inbox-skipped-reasons">
        <span>Child Operations</span>
        ${children.length ? children.map(([key, value]) => `<b>${utils.escapeHtml(key)} <em>${utils.escapeHtml(value)}</em></b>`).join("") : "<b>None</b>"}
      </div>
    `;
  }

  function renderRematchExistingResult(state, els, utils = window.EmailTriageRenderUtils) {
    if (!els.rematchExistingResult) return;
    const result = state.inboxRematchResult;
    if (!result || state.inboxRematchResultCleared) {
      els.rematchExistingResult.innerHTML = "";
      return;
    }

    const safety = result.safety || {};
    const changedLinkCount = Number(result.changed_link_count || 0) || Number(result.links_created || 0) + Number(result.links_updated || 0);
    const scannedIds = Array.isArray(result.message_ids) ? result.message_ids : [];
    const changedIds = Array.isArray(result.message_ids_changed) ? result.message_ids_changed : [];
    const failures = Array.isArray(result.failures) ? result.failures : [];
    const continuation = result.continuation || {};
    const hasMore = result.has_more === true || continuation.has_more === true;
    els.rematchExistingResult.innerHTML = `
      <div class="inbox-live-refresh-head">
        <strong>Rematch result: ${utils.escapeHtml(rematchScopeLabel(result.scope))}</strong>
        <span>${utils.escapeHtml(result.scanned || 0)} scanned · ${utils.escapeHtml(changedLinkCount)} link changes${hasMore ? " · more available" : ""}</span>
        <button type="button" class="secondary-btn inbox-result-clear-btn" data-inbox-clear-result="rematch">Clear Rematch Result</button>
      </div>
      <p class="inbox-result-note">
        Rematch recalculates deterministic eBay links only. Classifications and drafts were not recomputed, and nothing was sent.
        ${changedLinkCount ? "Changed context may make existing classifications or drafts stale; reloads are triggered after this operation." : "No link records changed; candidates may still have been scanned."}
      </p>
      <div class="inbox-live-refresh-grid">
        ${renderStageCounts("Matching", result, [
          ["scanned", "Scanned"],
          ["rematched", "Rematched"],
          ["unchanged", "Unchanged"],
          ["ambiguous", "Ambiguous"],
          ["skipped", "Skipped"],
          ["failed", "Failed"],
        ], utils)}
        ${renderStageCounts("Links", result, [
          ["changed_link_count", "Changed"],
          ["links_created", "Created"],
          ["links_updated", "Updated"],
        ], utils)}
        ${renderStageCounts("Link Types", result, [
          ["order_link_changes", "Order"],
          ["item_link_changes", "Item"],
          ["inventory_link_changes", "Inventory"],
          ["buyer_link_changes", "Buyer"],
          ["tracking_label_link_changes", "Tracking/label"],
        ], utils)}
      </div>
      ${hasMore ? `<p class="inbox-result-note">This scope is chunked. Continue from ${utils.escapeHtml(Number(continuation.offset || 0) + Number(result.scanned || 0))} of ${utils.escapeHtml(continuation.total || "unknown")} with Continue Rematch.</p>` : ""}
      <dl class="inbox-live-refresh-safety">
        <div><dt>Outlook Fetch</dt><dd>${renderInboxBadge(safety.outlook_fetch_performed ? "true" : "false", safety.outlook_fetch_performed ? "danger" : "success", utils)}</dd></div>
        <div><dt>Outlook Mutation</dt><dd>${renderInboxBadge(safety.outlook_mutation_performed ? "true" : "false", safety.outlook_mutation_performed ? "danger" : "success", utils)}</dd></div>
        <div><dt>eBay Mutation</dt><dd>${renderInboxBadge(safety.ebay_mutation_performed ? "true" : "false", safety.ebay_mutation_performed ? "danger" : "success", utils)}</dd></div>
        <div><dt>Classification</dt><dd>${renderInboxBadge(safety.classification_triggered ? "true" : "false", safety.classification_triggered ? "danger" : "success", utils)}</dd></div>
        <div><dt>Drafts Created</dt><dd>${renderInboxBadge(String(safety.drafts_created || 0), safety.drafts_created ? "danger" : "success", utils)}</dd></div>
      </dl>
      <details class="inbox-result-details">
        <summary>Message IDs and failures</summary>
        <div class="inbox-skipped-reasons">
          <span>Scanned Message IDs</span>
          <div class="inbox-message-id-list">${renderCompactIdList(scannedIds, "No message ids returned", utils)}</div>
        </div>
        <div class="inbox-skipped-reasons">
          <span>Changed Message IDs</span>
          <div class="inbox-message-id-list">${renderCompactIdList(changedIds, "No changed message ids", utils)}</div>
        </div>
        <div class="inbox-skipped-reasons">
          <span>Failures</span>
          <div class="inbox-message-id-list">${renderRematchFailures(failures, utils)}</div>
        </div>
      </details>
    `;
  }

  function renderInboxRows(state, els, utils = window.EmailTriageRenderUtils) {
    if (!els.body) return;
    const rows = Array.isArray(state.inboxPreviewResult?.messages) ? state.inboxPreviewResult.messages : [];
    const activeBucket = state.inboxActiveBucketFilter || "likely_ebay";
    const visibleRows = activeBucket === "all" ? rows : rows.filter((row) => bucketFor(row) === activeBucket);
    const selected = new Set(selectedIds(state));

    if (!rows.length) {
      els.body.innerHTML = `<tr><td colspan="9">No inbox preview loaded.</td></tr>`;
      return;
    }

    if (!visibleRows.length) {
      els.body.innerHTML = `<tr><td colspan="9">No messages in this bucket.</td></tr>`;
      return;
    }

    els.body.innerHTML = visibleRows.map((row) => {
      const id = providerIdFor(row);
      const bucket = bucketFor(row);
      const alreadyImported = row.already_imported === true;
      const disabled = !id || alreadyImported || bucket === "not_ebay";
      const bucketVariant = bucket === "likely_ebay" ? "success" : bucket === "maybe_ebay" ? "warning" : "muted";
      const status = alreadyImported
        ? renderInboxBadge("Already imported", "success", utils)
        : renderInboxBadge("Not imported", "muted", utils);

      return `
        <tr>
          <td>
            <input type="checkbox" data-inbox-message-id="${utils.escapeHtml(id)}" ${selected.has(id) ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="Select message" />
          </td>
          <td class="email-sender">${utils.escapeHtml(rowSender(row))}</td>
          <td class="email-subject">${utils.escapeHtml(row.subject || "(No subject)")}</td>
          <td class="email-received">${utils.escapeHtml(utils.formatDateTime(row.received_at || row.receivedDateTime))}</td>
          <td class="email-preview">${utils.escapeHtml(row.body_preview || row.bodyPreview || "")}</td>
          <td>${renderInboxBadge(BUCKET_LABELS[bucket] || bucket, bucketVariant, utils)}</td>
          <td>${utils.escapeHtml(row.score ?? "--")}</td>
          <td><div class="inbox-reason-list">${renderReasonCodes(row.reason_codes, utils)}</div></td>
          <td>${status}</td>
        </tr>
      `;
    }).join("");
  }

  function renderInboxPreviewImport(state, els = getInboxPreviewElements(), utils = window.EmailTriageRenderUtils) {
    const result = state.inboxPreviewResult;
    const controls = state.inboxPreviewControls || {};
    if (els.limit && String(els.limit.value) !== String(controls.limit || 25)) els.limit.value = String(controls.limit || 25);
    if (els.daysBack && String(els.daysBack.value) !== String(controls.daysBack ?? "")) els.daysBack.value = String(controls.daysBack ?? "");
    if (els.bucketMode && els.bucketMode.value !== (controls.bucketMode || "ebay_only")) els.bucketMode.value = controls.bucketMode || "ebay_only";
    if (els.mailboxImportTarget && String(els.mailboxImportTarget.value) !== String(state.inboxMailboxImportTarget || 100)) {
      els.mailboxImportTarget.value = String(state.inboxMailboxImportTarget || 100);
    }
    if (els.rematchScope && els.rematchScope.value !== (state.inboxRematchScope || "selected")) {
      els.rematchScope.value = state.inboxRematchScope || "selected";
    }

    const loading = state.inboxPreviewLoading === true || state.inboxImportLoading === true || state.inboxMailboxImportLoading === true || state.inboxPrepareLoading === true || state.inboxLiveRefreshLoading === true || state.inboxRematchLoading === true;
    const importability = previewImportability(state);
    const rematchScope = state.inboxRematchScope || els.rematchScope?.value || "selected";
    const selectedMessageId = selectedMailboxMessageId(state);
    const pageMessageIds = currentPageMessageIds(state);
    const canRunRematch = !loading
      && (rematchScope !== "selected" || Boolean(selectedMessageId))
      && (rematchScope !== "current_page" || pageMessageIds.length > 0);
    const canContinueRematch = !loading
      && state.inboxRematchResult?.continuation?.has_more === true
      && ["current_filter", "all_imported"].includes(state.inboxRematchResult?.scope);
    const mailboxProgress = state.inboxMailboxImportResult?.progress || {};
    const prepareProgress = state.inboxPrepareResult?.progress || {};
    const selectedMailboxTarget = Number(state.inboxMailboxImportTarget || els.mailboxImportTarget?.value || 100);
    const mailboxCompleted = Number(mailboxProgress.completed_total || 0);
    const canContinueMailboxImport = mailboxProgress.continuation_available === true && selectedMailboxTarget > mailboxCompleted;
    const canContinuePreparing = prepareProgress.has_more === true;
    const buttonLoadingStates = new Map([
      [els.run, state.inboxPreviewLoading === true],
      [els.importLikely, state.inboxImportLoading === true],
      [els.importSelected, state.inboxImportLoading === true],
      [els.mailboxImportStart, state.inboxMailboxImportLoading === true],
      [els.mailboxImportContinue, state.inboxMailboxImportLoading === true],
      [els.prepareMailboxRun, state.inboxPrepareLoading === true],
      [els.prepareMailboxContinue, state.inboxPrepareLoading === true],
      [els.liveRefresh, state.inboxLiveRefreshLoading === true],
      [els.rematchExisting, state.inboxRematchLoading === true],
      [els.rematchContinue, state.inboxRematchLoading === true],
      [els.clear, false],
    ]);
    buttonLoadingStates.forEach((isBusy, button) => {
      if (!button) return;
      button.setAttribute("aria-busy", isBusy ? "true" : "false");
      button.classList.toggle("is-loading", isBusy);
    });

    if (els.run) els.run.disabled = loading;
    if (els.importLikely) els.importLikely.disabled = loading || importability.importableLikelyCount === 0;
    if (els.importSelected) els.importSelected.disabled = loading || importability.selectedImportableCount === 0;
    if (els.mailboxImportStart) els.mailboxImportStart.disabled = loading;
    if (els.mailboxImportContinue) els.mailboxImportContinue.disabled = loading || !canContinueMailboxImport;
    if (els.prepareMailboxRun) els.prepareMailboxRun.disabled = loading;
    if (els.prepareMailboxContinue) els.prepareMailboxContinue.disabled = loading || !canContinuePreparing;
    if (els.liveRefresh) els.liveRefresh.disabled = loading;
    if (els.rematchExisting) {
      els.rematchExisting.disabled = !canRunRematch;
      const icon = els.rematchExisting.querySelector("i");
      els.rematchExisting.textContent = rematchRunLabel(rematchScope);
      if (icon) els.rematchExisting.prepend(icon);
    }
    if (els.rematchContinue) els.rematchContinue.disabled = !canContinueRematch;
    if (els.rematchScope) els.rematchScope.disabled = loading;
    if (els.clear) els.clear.disabled = loading || !result;

    if (els.status) {
      if (state.inboxPreviewLoading) els.status.textContent = "Loading Outlook preview.";
      else if (state.inboxImportLoading) els.status.textContent = "Importing approved messages only.";
      else if (state.inboxMailboxImportLoading) els.status.textContent = "Importing mailbox batch.";
      else if (state.inboxPrepareLoading) els.status.textContent = "Preparing mailbox rows for classification.";
      else if (state.inboxLiveRefreshLoading) els.status.textContent = "Running bounded live refresh.";
      else if (state.inboxRematchLoading) els.status.textContent = "Rematching deterministic links for an explicit scope.";
      else if (state.inboxPreviewError) els.status.textContent = `Preview failed: ${state.inboxPreviewError}`;
      else if (result) els.status.textContent = `Preview refreshed ${utils.formatDateTime(state.inboxLastRefreshedAt)}. Selected ${selectedIds(state).length} message${selectedIds(state).length === 1 ? "" : "s"}.`;
      else els.status.textContent = "Run preview to inspect recent Outlook emails before importing.";
    }

    if (els.countPill) {
      const count = result?.messages_returned || 0;
      els.countPill.textContent = result ? `${count} returned` : "No preview";
    }

    els.bucketFilters?.forEach((button) => {
      button.classList.toggle("is-active", button.getAttribute("data-inbox-bucket-filter") === (state.inboxActiveBucketFilter || "likely_ebay"));
    });

    renderInboxSummary(state, els, utils);
    renderMailboxImportResult(state, els, utils);
    renderPrepareMailboxResult(state, els, utils);
    renderImportResult(state, els, utils);
    renderLiveRefreshResult(state, els, utils);
    renderRematchExistingResult(state, els, utils);
    renderInboxRows(state, els, utils);
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function createInboxDispatcher(store, render, els) {
    return function updateInboxState(next) {
      store.dispatch({ type: window.EmailTriageState.TRANSITIONS.SET_STATE, payload: next });
      render(store.getState(), els);
    };
  }

  function bindInboxPreviewImport(context, store, options = {}) {
    const api = window.EmailTriageApi;
    const els = options.els || getInboxPreviewElements();
    if (!els.section || !store || !api) return;
    const update = createInboxDispatcher(store, renderInboxPreviewImport, els);

    renderInboxPreviewImport(store.getState(), els);

    api.fetchMailboxImportStatus?.(context)
      .then((result) => {
        const preparationProgress = result.preparation_progress || null;
        update({
          inboxMailboxImportResult: result,
          inboxMailboxImportTarget: result.target_count || store.getState().inboxMailboxImportTarget || 100,
          inboxPrepareResult: preparationProgress ? {
            ok: true,
            mode: "prepare_mailbox",
            progress: preparationProgress,
            processing: {},
            classification: {},
            safety: {
              outlook_mutation_performed: false,
              automatic_responses_sent: 0,
              drafts_created: 0,
              attachments_fetched: 0,
              sync_checkpoint_updated: false,
              processing_triggered: false,
              classification_triggered: false,
            },
          } : store.getState().inboxPrepareResult,
        });
      })
      .catch(() => {});

    els.run?.addEventListener("click", async () => {
      const controls = previewControlsFromEls(els);
      update({
        inboxPreviewControls: controls,
        inboxPreviewLoading: true,
        inboxPreviewError: null,
        inboxImportResult: null,
        inboxImportResultCleared: false,
        inboxPreviewSelectedProviderMessageIds: [],
        operationInFlight: "sync_preview",
      });
      try {
        const result = await api.fetchInboxPreview(context, controls);
        update({
          inboxPreviewLoading: false,
          inboxPreviewResult: result,
          inboxLastRefreshedAt: new Date().toISOString(),
          inboxPreviewSelectedProviderMessageIds: [],
          operationInFlight: null,
          lastOperationSummary: {
            mode: "sync_preview",
            previewed_count: result.messages_previewed,
            returned_count: result.messages_returned,
          },
        });
      } catch (error) {
        update({
          inboxPreviewLoading: false,
          inboxPreviewError: error.code || error.message || "sync_preview_failed",
          operationInFlight: null,
        });
      }
    });

    async function runMailboxImportAction(action) {
      const targetCount = Number(els.mailboxImportTarget?.value || store.getState().inboxMailboxImportTarget || 100);
      update({
        inboxMailboxImportLoading: true,
        inboxMailboxImportTarget: targetCount,
        inboxMailboxImportResultCleared: false,
        inboxPrepareResultCleared: false,
        inboxPreviewError: null,
        operationInFlight: "mailbox_import",
      });
      try {
        const result = await api.runMailboxImport(context, {
          action,
          targetCount,
          pageSize: 50,
          maxPages: 3,
        });
        update({
          inboxMailboxImportLoading: false,
          inboxMailboxImportResult: result,
          inboxMailboxImportTarget: result.target_count || targetCount,
          inboxLastOperationId: result.operation_event_id,
          inboxLastRefreshedAt: new Date().toISOString(),
          operationInFlight: null,
          lastOperationSummary: {
            mode: "mailbox_import",
            action,
            imported_total: result.imported_total,
            already_imported_total: result.already_imported_total,
            failed_total: result.failed_total,
            has_more: result.has_more,
          },
        });
        if (typeof options.onMailboxImportComplete === "function") {
          options.onMailboxImportComplete(result);
        }
        await runPrepareMailboxAction("after_import");
      } catch (error) {
        update({
          inboxMailboxImportLoading: false,
          inboxPreviewError: error.code || error.message || "mailbox_import_failed",
          operationInFlight: null,
        });
      }
    }

    async function runPrepareMailboxAction(source = "manual") {
      update({
        inboxPrepareLoading: true,
        inboxPrepareResultCleared: false,
        inboxPreviewError: null,
        operationInFlight: "prepare_mailbox",
      });
      try {
        const result = await api.prepareMailbox(context, {
          processBatchSize: 25,
          classifyBatchSize: 10,
        });
        update({
          inboxPrepareLoading: false,
          inboxPrepareResult: result,
          inboxLastRefreshedAt: new Date().toISOString(),
          operationInFlight: null,
          lastOperationSummary: {
            mode: "prepare_mailbox",
            source,
            imported_active: result.progress?.imported_active || 0,
            processed_total: result.progress?.processed_total || 0,
            classified_total: result.progress?.classified_total || 0,
            remaining_to_process: result.progress?.remaining_to_process || 0,
            remaining_to_classify: result.progress?.remaining_to_classify || 0,
            has_more: result.progress?.has_more === true,
          },
        });
        if (typeof options.onPrepareComplete === "function") {
          options.onPrepareComplete(result);
        }
      } catch (error) {
        update({
          inboxPrepareLoading: false,
          inboxPreviewError: error.code || error.message || "prepare_mailbox_failed",
          operationInFlight: null,
        });
      }
    }

    els.mailboxImportTarget?.addEventListener("change", () => {
      update({ inboxMailboxImportTarget: Number(els.mailboxImportTarget.value || 100) });
    });

    els.mailboxImportStart?.addEventListener("click", () => {
      runMailboxImportAction("start");
    });

    els.mailboxImportContinue?.addEventListener("click", () => {
      runMailboxImportAction("continue");
    });

    els.prepareMailboxRun?.addEventListener("click", () => {
      runPrepareMailboxAction("manual");
    });

    els.prepareMailboxContinue?.addEventListener("click", () => {
      runPrepareMailboxAction("continue");
    });

    els.body?.addEventListener("change", (event) => {
      const input = event.target.closest("[data-inbox-message-id]");
      if (!input) return;
      const id = input.getAttribute("data-inbox-message-id");
      const current = new Set(selectedIds(store.getState()));
      if (input.checked) current.add(id);
      else current.delete(id);
      update({ inboxPreviewSelectedProviderMessageIds: Array.from(current) });
    });

    els.bucketFilters?.forEach((button) => {
      button.addEventListener("click", () => {
        update({ inboxActiveBucketFilter: button.getAttribute("data-inbox-bucket-filter") || "likely_ebay" });
      });
    });

    els.importLikely?.addEventListener("click", async () => {
      const state = store.getState();
      const controls = importControlsFromState(state);
      update({
        inboxImportLoading: true,
        inboxImportResultCleared: false,
        inboxPrepareResultCleared: false,
        inboxPreviewError: null,
        operationInFlight: "sync_import_approved",
      });
      try {
        const result = await api.importApprovedInboxPreview(context, {
          ...controls,
          importBucket: "likely_ebay",
        });
        update({
          inboxImportLoading: false,
          inboxImportResult: result,
          inboxPreviewResult: previewResultAfterImport(store.getState(), result),
          inboxLastOperationId: result.operation_event_id,
          operationInFlight: null,
          lastOperationSummary: {
            mode: "sync_import_approved",
            imported_count: result.imported_count,
            already_imported_count: result.already_imported_count,
            skipped_count: result.skipped_count,
            classification_created: result.classification_created,
            drafts_created: result.drafts_created,
          },
        });
        if (typeof options.onImportComplete === "function") {
          options.onImportComplete(result);
        }
        await runPrepareMailboxAction("after_import_likely");
      } catch (error) {
        update({
          inboxImportLoading: false,
          inboxPreviewError: error.code || error.message || "sync_import_approved_failed",
          operationInFlight: null,
        });
      }
    });

    els.importSelected?.addEventListener("click", async () => {
      const state = store.getState();
      const ids = selectedIds(state);
      if (!ids.length) return;
      const allowed = new Set(selectableRows(state).map(providerIdFor));
      const safeIds = ids.filter((id) => allowed.has(id));
      if (!safeIds.length) return;
      const controls = importControlsFromState(state);
      update({
        inboxImportLoading: true,
        inboxImportResultCleared: false,
        inboxPrepareResultCleared: false,
        inboxPreviewError: null,
        operationInFlight: "sync_import_approved",
      });
      try {
        const result = await api.importApprovedInboxPreview(context, {
          ...controls,
          providerMessageIds: safeIds,
          importBucket: "likely_ebay",
        });
        update({
          inboxImportLoading: false,
          inboxImportResult: result,
          inboxPreviewResult: previewResultAfterImport(store.getState(), result),
          inboxLastOperationId: result.operation_event_id,
          inboxPreviewSelectedProviderMessageIds: [],
          operationInFlight: null,
          lastOperationSummary: {
            mode: "sync_import_approved",
            imported_count: result.imported_count,
            already_imported_count: result.already_imported_count,
            skipped_count: result.skipped_count,
            classification_created: result.classification_created,
            drafts_created: result.drafts_created,
          },
        });
        if (typeof options.onImportComplete === "function") {
          options.onImportComplete(result);
        }
        await runPrepareMailboxAction("after_import_selected");
      } catch (error) {
        update({
          inboxImportLoading: false,
          inboxPreviewError: error.code || error.message || "sync_import_approved_failed",
          operationInFlight: null,
        });
      }
    });

    els.liveRefresh?.addEventListener("click", async () => {
      const controls = previewControlsFromEls(els);
      update({
        inboxPreviewControls: controls,
        inboxLiveRefreshLoading: true,
        inboxPreviewError: null,
        inboxLiveRefreshResult: null,
        inboxLiveRefreshResultCleared: false,
        operationInFlight: "run_live_refresh",
      });
      try {
        const result = await api.runInboxLiveRefresh(context, controls);
        update({
          inboxLiveRefreshLoading: false,
          inboxLiveRefreshResult: result,
          inboxPreviewResult: result.preview_result || null,
          inboxPreviewSelectedProviderMessageIds: [],
          inboxLastOperationId: result.operation_id,
          inboxLastRefreshedAt: new Date().toISOString(),
          operationInFlight: null,
          lastOperationSummary: {
            mode: "run_live_refresh",
            operation_id: result.operation_id,
            previewed_count: result.preview?.previewed_count || 0,
            imported_count: result.import?.imported_count || 0,
            processed_count: result.processing?.processed_count || 0,
            classified_count: result.classification?.classified_count || 0,
          },
        });
        if (typeof options.onLiveRefreshComplete === "function") {
          options.onLiveRefreshComplete(result);
        }
      } catch (error) {
        update({
          inboxLiveRefreshLoading: false,
          inboxPreviewError: error.code || error.message || "run_live_refresh_failed",
          operationInFlight: null,
        });
      }
    });

    async function executeRematch(optionsForRun = {}) {
      const currentState = store.getState();
      const payload = optionsForRun.payload || rematchPayloadFromState(currentState, els, optionsForRun);
      const uiScope = optionsForRun.uiScope || els.rematchScope?.value || currentState.inboxRematchScope || "selected";
      update({
        inboxRematchScope: uiScope,
        inboxRematchLoading: true,
        inboxPreviewError: null,
        inboxRematchResult: optionsForRun.append ? currentState.inboxRematchResult : null,
        inboxRematchResultCleared: false,
        operationInFlight: "rematch_existing",
      });
      try {
        const result = await api.rematchExistingEmails(context, payload);
        update({
          inboxRematchLoading: false,
          inboxRematchResult: result,
          inboxLastOperationId: result.operation_event_id || null,
          inboxLastRefreshedAt: new Date().toISOString(),
          operationInFlight: null,
          lastOperationSummary: {
            mode: "rematch_existing",
            operation_event_id: result.operation_event_id || null,
            scope: result.scope,
            scanned: result.scanned,
            rematched: result.rematched,
            unchanged: result.unchanged,
            changed_link_count: result.changed_link_count,
            links_created: result.links_created,
            links_updated: result.links_updated,
            ambiguous: result.ambiguous,
            skipped: result.skipped,
            failed: result.failed,
          },
        });
        if (typeof options.onRematchComplete === "function") {
          options.onRematchComplete(result);
        }
      } catch (error) {
        update({
          inboxRematchLoading: false,
          inboxPreviewError: error.code || error.message || "rematch_existing_failed",
          operationInFlight: null,
        });
      }
    }

    els.rematchScope?.addEventListener("change", () => {
      update({
        inboxRematchScope: els.rematchScope.value || "selected",
        inboxRematchResult: null,
      });
    });

    els.rematchExisting?.addEventListener("click", async () => {
      await executeRematch();
    });

    els.rematchContinue?.addEventListener("click", async () => {
      const currentState = store.getState();
      const result = currentState.inboxRematchResult || {};
      const continuation = result.continuation || {};
      if (!continuation.has_more || !continuation.next_cursor) return;
      const scope = result.scope === "current_filter" ? "current_filter" : "all_imported";
      const payload = rematchPayloadFromState(currentState, els, {
        scope,
        continuation: {
          next_cursor: continuation.next_cursor,
          mailbox_query: result.mailbox_query || null,
        },
      });
      await executeRematch({ payload, append: true, uiScope: scope === "current_filter" ? "current_filter" : "all_imported" });
    });

    els.section?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-inbox-clear-result]");
      if (!button) return;
      const target = button.getAttribute("data-inbox-clear-result");
      if (target === "mailbox_import") {
        update({ inboxMailboxImportResultCleared: true });
      } else if (target === "prepare") {
        update({ inboxPrepareResultCleared: true });
      } else if (target === "import") {
        update({ inboxImportResultCleared: true });
      } else if (target === "live_refresh") {
        update({ inboxLiveRefreshResultCleared: true });
      } else if (target === "rematch") {
        update({ inboxRematchResultCleared: true });
      }
    });

    els.clear?.addEventListener("click", () => {
      update({
        inboxPreviewLoading: false,
        inboxPreviewError: null,
        inboxPreviewResult: null,
        inboxPreviewSelectedProviderMessageIds: [],
        inboxLastRefreshedAt: null,
      });
    });
  }

  window.EmailTriageInbox = {
    renderMessageRows,
    renderInboxPreviewImport,
    bindInboxPreviewImport,
    previewImportability,
  };
})();
