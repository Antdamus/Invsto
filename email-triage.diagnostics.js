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

  window.EmailTriageDiagnostics = {
    queueSummaryItems,
    safetySummaryItems,
    replaySummaryItems,
    renderSummaryItems,
    renderAdminSummary,
  };
})();
