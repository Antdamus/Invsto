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
      rematchExistingResult: document.getElementById("inbox-rematch-existing-result"),
      clear: document.getElementById("inbox-preview-clear"),
      bucketFilters: document.querySelectorAll("[data-inbox-bucket-filter]"),
      section: document.getElementById("inbox-preview-section"),
    };
  }

  function previewControlsFromEls(els) {
    return {
      limit: Number(els.limit?.value || 25),
      daysBack: els.daysBack?.value || "",
      bucketMode: els.bucketMode?.value || "ebay_only",
    };
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
    if (!result) {
      els.importResult.innerHTML = "";
      return;
    }
    const skippedReasons = Object.entries(result.skipped_reasons || {});
    els.importResult.innerHTML = `
      <div class="inbox-import-result-head">
        <strong>Approved import-only result</strong>
        ${result.operation_event_id ? `<span>Operation event ${utils.escapeHtml(result.operation_event_id)}</span>` : "<span>No operation event id returned</span>"}
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
    if (!result) {
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
    if (!result) {
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
    if (!result) {
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
    if (!result) {
      els.rematchExistingResult.innerHTML = "";
      return;
    }

    const safety = result.safety || {};
    const changedLinkCount = Number(result.links_created || 0) + Number(result.links_updated || 0);
    const scannedIds = Array.isArray(result.message_ids) ? result.message_ids : [];
    const failures = Array.isArray(result.failures) ? result.failures : [];
    els.rematchExistingResult.innerHTML = `
      <div class="inbox-live-refresh-head">
        <strong>Rematch existing emails result</strong>
        <span>${utils.escapeHtml(result.scanned || 0)} scanned · ${utils.escapeHtml(changedLinkCount)} link changes</span>
      </div>
      <p class="inbox-result-note">
        Rematch recalculates deterministic links only. Classifications and drafts are not recomputed here.
        ${changedLinkCount ? "Created or updated links are counted below." : "No link records changed; candidates may still have been scanned."}
      </p>
      <div class="inbox-live-refresh-grid">
        ${renderStageCounts("Matching", result, [
          ["scanned", "Scanned"],
          ["rematched", "Rematched"],
          ["ambiguous", "Ambiguous"],
          ["skipped", "Skipped"],
          ["failed", "Failed"],
        ], utils)}
        ${renderStageCounts("Links", result, [
          ["links_created", "Created"],
          ["links_updated", "Updated"],
        ], utils)}
      </div>
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

    const loading = state.inboxPreviewLoading === true || state.inboxImportLoading === true || state.inboxMailboxImportLoading === true || state.inboxPrepareLoading === true || state.inboxLiveRefreshLoading === true || state.inboxRematchLoading === true;
    const importability = previewImportability(state);
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
    if (els.rematchExisting) els.rematchExisting.disabled = loading;
    if (els.clear) els.clear.disabled = loading || !result;

    if (els.status) {
      if (state.inboxPreviewLoading) els.status.textContent = "Loading Outlook preview.";
      else if (state.inboxImportLoading) els.status.textContent = "Importing approved messages only.";
      else if (state.inboxMailboxImportLoading) els.status.textContent = "Importing mailbox batch.";
      else if (state.inboxPrepareLoading) els.status.textContent = "Preparing mailbox rows for classification.";
      else if (state.inboxLiveRefreshLoading) els.status.textContent = "Running bounded live refresh.";
      else if (state.inboxRematchLoading) els.status.textContent = "Rematching existing imported emails.";
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
      update({ inboxImportLoading: true, inboxPreviewError: null, operationInFlight: "sync_import_approved" });
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
      update({ inboxImportLoading: true, inboxPreviewError: null, operationInFlight: "sync_import_approved" });
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

    els.rematchExisting?.addEventListener("click", async () => {
      const controls = previewControlsFromEls(els);
      update({
        inboxPreviewControls: controls,
        inboxRematchLoading: true,
        inboxPreviewError: null,
        inboxRematchResult: null,
        operationInFlight: "rematch_existing",
      });
      try {
        const result = await api.rematchExistingEmails(context, controls);
        update({
          inboxRematchLoading: false,
          inboxRematchResult: result,
          inboxLastOperationId: result.operation_event_id || null,
          inboxLastRefreshedAt: new Date().toISOString(),
          operationInFlight: null,
          lastOperationSummary: {
            mode: "rematch_existing",
            operation_event_id: result.operation_event_id || null,
            scanned: result.scanned,
            rematched: result.rematched,
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
    });

    els.clear?.addEventListener("click", () => {
      update({
        inboxPreviewLoading: false,
        inboxPreviewError: null,
        inboxPreviewResult: null,
        inboxPreviewSelectedProviderMessageIds: [],
        inboxImportLoading: false,
        inboxImportResult: null,
        inboxMailboxImportLoading: false,
        inboxPrepareLoading: false,
        inboxPrepareResult: null,
        inboxLiveRefreshLoading: false,
        inboxLiveRefreshResult: null,
        inboxRematchLoading: false,
        inboxRematchResult: null,
        inboxLastOperationId: null,
        inboxLastRefreshedAt: null,
        operationInFlight: null,
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
