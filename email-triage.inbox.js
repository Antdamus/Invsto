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
      body: document.getElementById("inbox-preview-body"),
      importLikely: document.getElementById("inbox-import-likely"),
      importSelected: document.getElementById("inbox-import-selected"),
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
        <strong>Approved import result</strong>
        ${result.operation_event_id ? `<span>Operation event ${utils.escapeHtml(result.operation_event_id)}</span>` : "<span>No operation event id returned</span>"}
      </div>
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

    const loading = state.inboxPreviewLoading === true || state.inboxImportLoading === true;
    [els.run, els.importLikely, els.importSelected, els.clear].forEach((button) => {
      if (!button) return;
      button.setAttribute("aria-busy", loading ? "true" : "false");
    });

    if (els.run) els.run.disabled = state.inboxPreviewLoading === true || state.inboxImportLoading === true;
    const likelyImportable = (result?.messages || []).some((row) => bucketFor(row) === "likely_ebay" && row.already_imported !== true);
    if (els.importLikely) els.importLikely.disabled = loading || !likelyImportable;
    if (els.importSelected) els.importSelected.disabled = loading || selectedIds(state).length === 0;
    if (els.clear) els.clear.disabled = loading || !result;

    if (els.status) {
      if (state.inboxPreviewLoading) els.status.textContent = "Loading Outlook preview.";
      else if (state.inboxImportLoading) els.status.textContent = "Importing approved messages.";
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
    renderImportResult(state, els, utils);
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

    els.run?.addEventListener("click", async () => {
      const controls = previewControlsFromEls(els);
      update({
        inboxPreviewControls: controls,
        inboxPreviewLoading: true,
        inboxPreviewError: null,
        inboxImportResult: null,
        inboxPreviewSelectedProviderMessageIds: [],
      });
      try {
        const result = await api.fetchInboxPreview(context, controls);
        update({
          inboxPreviewLoading: false,
          inboxPreviewResult: result,
          inboxLastRefreshedAt: new Date().toISOString(),
          inboxPreviewSelectedProviderMessageIds: [],
        });
      } catch (error) {
        update({
          inboxPreviewLoading: false,
          inboxPreviewError: error.code || error.message || "sync_preview_failed",
        });
      }
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
      update({ inboxImportLoading: true, inboxPreviewError: null });
      try {
        const result = await api.importApprovedInboxPreview(context, {
          ...controls,
          importBucket: "likely_ebay",
        });
        update({
          inboxImportLoading: false,
          inboxImportResult: result,
          inboxLastOperationId: result.operation_event_id,
        });
      } catch (error) {
        update({
          inboxImportLoading: false,
          inboxPreviewError: error.code || error.message || "sync_import_approved_failed",
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
      update({ inboxImportLoading: true, inboxPreviewError: null });
      try {
        const result = await api.importApprovedInboxPreview(context, {
          ...controls,
          providerMessageIds: safeIds,
          importBucket: "likely_ebay",
        });
        update({
          inboxImportLoading: false,
          inboxImportResult: result,
          inboxLastOperationId: result.operation_event_id,
          inboxPreviewSelectedProviderMessageIds: [],
        });
      } catch (error) {
        update({
          inboxImportLoading: false,
          inboxPreviewError: error.code || error.message || "sync_import_approved_failed",
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
        inboxLastOperationId: null,
        inboxLastRefreshedAt: null,
      });
    });
  }

  window.EmailTriageInbox = {
    renderMessageRows,
    renderInboxPreviewImport,
    bindInboxPreviewImport,
  };
})();
