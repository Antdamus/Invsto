(function () {
  "use strict";

  function operationLabel(mode) {
    return String(mode || "operation").replace(/_/g, " ");
  }

  function liveSyncSummary(connection = {}) {
    return {
      enabled: connection.live_sync_enabled === true,
      eligible: connection.live_sync_eligible === true,
      lastChecked: connection.last_successful_check_at || connection.updated_at || null,
    };
  }

  window.EmailTriageOperations = {
    operationLabel,
    liveSyncSummary,
  };
})();
