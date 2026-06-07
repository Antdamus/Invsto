(function () {
  "use strict";

  const {
    requireAdmin,
    fetchOperationalDashboard,
    fetchEbayConversations,
    fetchEbayConversationMessages,
    markEbayConversationRead,
    fetchEbayConversationContext,
    fetchEbayConversationDrafts,
    requestEbayConversationDraftAction,
    runEbayMessageSync,
    classifyEbayConversation,
    classifyRecentEbayConversations,
    saveEbayConversationClassificationOverride,
    fetchEbayConversationSavedViews,
    createEbayConversationSavedView,
    updateEbayConversationSavedView,
    deleteEbayConversationSavedView,
  } = window.EmailTriageApi;
  const { TRANSITIONS, createInitialState, createStore } = window.EmailTriageState;
  const {
    getStoredDensityMode,
    storeDensityMode,
    getStoredEbayConversationDensityMode,
    storeEbayConversationDensityMode,
    clampNumber,
    getStoredPanelWidths,
    storePanelWidths,
    applyPanelWidths: applyStoredPanelWidths,
    getStoredEbayConversationPanelWidths,
    storeEbayConversationPanelWidths,
    applyEbayConversationPanelWidths: applyStoredEbayConversationPanelWidths,
    normalizeEbayConversationPanelVisibility,
    getStoredEbayConversationPanelVisibility,
    storeEbayConversationPanelVisibility,
    escapeHtml,
    formatDateTime,
    formatEmailAge,
    formatCompactEmailAge,
    humanizeValue,
    formatConfidence,
    compactId,
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
    categoryMatchesGroup: categoryMatchesGroupBase,
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
  } = window.EmailTriageRenderUtils;
  const { renderOperationalDashboard } = window.EmailTriageDiagnostics;
  const {
    CLASSIFICATION_CATEGORIES,
    REVIEW_STATES,
    OVERRIDE_PRIORITIES,
    OVERRIDE_URGENCIES,
    CATEGORY_GROUPS,
    EBAY_TOPIC_TAGS,
    EBAY_PRIORITIES,
    EBAY_RESPONSE_NEEDS,
    EBAY_CONVERSATION_SOURCE_TYPES,
    EBAY_BUYER_FLAGS,
    EBAY_RISK_FLAGS,
    EBAY_REVIEW_STATES,
  } = window.EmailTriageClassifications;

  const DASHBOARD_COLLAPSED_STORAGE_KEY = "og-email-triage-dashboard-collapsed";
  const CATEGORY_SORT_STORAGE_KEY = "og-email-triage-category-sort";
  const CUSTOM_CATEGORY_ORDER_STORAGE_KEY = "og-email-triage-custom-category-order";
  const CLASSIFICATION_FILTERS_EXPANDED_STORAGE_KEY = "og-email-triage-classification-filters-expanded";
  const EBAY_CONVERSATION_FILTERS_EXPANDED_STORAGE_KEY = "og-email-triage-ebay-conversation-filters-expanded";
  const EBAY_CLASSIFICATION_EXPANDED_STORAGE_KEY = "og-email-triage-ebay-classification-expanded";
  const EBAY_DRAFT_METADATA_COLLAPSED_STORAGE_KEY = "og-email-triage-ebay-draft-metadata-collapsed";
  const EBAY_RECLASSIFY_RECENT_LIMIT = 20;
  const EBAY_FILTER_GROUPS = [
    { key: "sourceTypes", label: "System source", values: EBAY_CONVERSATION_SOURCE_TYPES },
    { key: "topics", label: "Topics", values: EBAY_TOPIC_TAGS },
    { key: "buyerFlags", label: "Buyer flags", values: EBAY_BUYER_FLAGS },
    { key: "riskFlags", label: "Risk flags", values: EBAY_RISK_FLAGS },
    { key: "priorities", label: "Priority", values: EBAY_PRIORITIES },
    { key: "responseNeeds", label: "Response", values: EBAY_RESPONSE_NEEDS },
  ];
  const EBAY_SAVED_VIEW_ICONS = {
    all: "inbox",
    members: "message-circle",
    ebay_notifications: "bell",
    unread: "circle-dot",
    unclassified: "circle-help",
    returns: "undo-2",
    shipping_issues: "truck",
    needs_reply_today: "alarm-clock",
    vip_buyers: "star",
    high_value_buyers: "gem",
    refund_risk: "badge-alert",
    review_queue: "list-checks",
    has_order: "receipt-text",
    has_return: "undo-2",
    has_media: "paperclip",
    needs_context_review: "badge-alert",
  };
  const EBAY_SEND_SUCCESS_MESSAGE = "✓ Sent";
  const EBAY_SEND_SUCCESS_VISIBLE_MS = 5500;
  const EBAY_NOTIFICATION_BLOCK_TAGS = new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "center",
    "dd",
    "div",
    "dl",
    "dt",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "nav",
    "ol",
    "p",
    "section",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
  ]);
  const EBAY_NOTIFICATION_ALLOWED_TAGS = new Set([
    ...EBAY_NOTIFICATION_BLOCK_TAGS,
    "a",
    "b",
    "br",
    "em",
    "i",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "u",
  ]);
  const EBAY_NOTIFICATION_DROP_TAGS = new Set([
    "base",
    "button",
    "canvas",
    "embed",
    "form",
    "head",
    "iframe",
    "input",
    "link",
    "meta",
    "noscript",
    "object",
    "script",
    "select",
    "style",
    "svg",
    "textarea",
    "video",
  ]);
  const EBAY_NOTIFICATION_KIND_RULES = [
    { label: "Refund Decision", icon: "badge-dollar-sign", pattern: /\b(refund|reimburs|credit issued|money back)\b/i },
    { label: "Case Review", icon: "file-check-2", pattern: /\b(case|customer service review|request closed|case closed)\b/i },
    { label: "Order Cancellation", icon: "ban", pattern: /\b(cancel|cancellation)\b/i },
    { label: "Payment Dispute", icon: "credit-card", pattern: /\b(dispute|chargeback|payment dispute)\b/i },
    { label: "Payout Notice", icon: "receipt", pattern: /\b(payout|deposit|funds available)\b/i },
    { label: "Return Update", icon: "undo-2", pattern: /\b(return|returned item)\b/i },
  ];
  const ebayDraftActionMessageTimers = new Map();
  let ebayConversationReloadTimer = null;

  const els = {
    refreshClassificationAdmin: document.getElementById("refresh-classification-admin"),
    toggleCategoryPanel: document.getElementById("toggle-category-panel"),
    toggleDetailPanel: document.getElementById("toggle-detail-panel"),
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
    operationalDashboardSection: document.querySelector(".operational-dashboard-section"),
    operationalDashboardToggle: document.getElementById("toggle-operational-dashboard"),
    operationalDashboardBody: document.getElementById("operational-dashboard-body"),
    operationalDashboardRefresh: document.getElementById("refresh-operational-dashboard"),
    operationalDashboardStatus: document.getElementById("operational-dashboard-status"),
    operationalDashboard: document.getElementById("operational-dashboard"),
    ebayConversationRefresh: document.getElementById("ebay-conversation-refresh"),
    ebayConversationSync: document.getElementById("ebay-conversation-sync"),
    ebayConversationBackfill: document.getElementById("ebay-conversation-backfill"),
    ebayConversationBackfillClassifyNew: document.getElementById("ebay-conversation-backfill-classify-new"),
    ebayConversationBackfillReclassifyAll: document.getElementById("ebay-conversation-backfill-reclassify-all"),
    ebayConversationClassifyRecent: document.getElementById("ebay-conversation-classify-recent"),
    ebayConversationReclassifyAll: document.getElementById("ebay-conversation-reclassify-all"),
    ebayConversationStatus: document.getElementById("ebay-conversation-status"),
    ebayConversationSearch: document.getElementById("ebay-conversation-search"),
    ebayConversationSearchClear: document.getElementById("ebay-conversation-search-clear"),
    ebayConversationFilterToggle: document.getElementById("ebay-conversation-filter-toggle"),
    ebayConversationFilterLabel: document.getElementById("ebay-conversation-filter-label"),
    ebayConversationFilterPanel: document.getElementById("ebay-conversation-filter-panel"),
    ebayConversationActiveFilters: document.getElementById("ebay-conversation-active-filters"),
    ebayConversationClearFilters: document.getElementById("ebay-conversation-clear-filters"),
    ebayConversationTagHelpToggle: document.getElementById("ebay-conversation-tag-help-toggle"),
    ebayConversationTagHelp: document.getElementById("ebay-conversation-tag-help"),
    ebayConversationTagSuggestions: document.getElementById("ebay-conversation-tag-suggestions"),
    ebayConversationSaveView: document.getElementById("ebay-conversation-save-view"),
    ebayConversationReloadViews: document.getElementById("ebay-conversation-reload-views"),
    ebaySmartFolderEditToggle: document.getElementById("ebay-smart-folder-edit-toggle"),
    ebayConversationSavedViews: document.getElementById("ebay-conversation-saved-views"),
    ebayConversationDensityInputs: document.querySelectorAll("input[name='ebay-conversation-density']"),
    ebayConversationPanelToggleButtons: document.querySelectorAll("[data-ebay-panel-toggle]"),
    ebayConversationSyncResult: document.getElementById("ebay-conversation-sync-result"),
    ebayConversationSummary: document.getElementById("ebay-conversation-summary"),
    ebayConversationShell: document.getElementById("ebay-conversation-shell"),
    ebayConversationPanelResizeHandles: document.querySelectorAll("[data-ebay-panel-resize]"),
    ebayConversationList: document.getElementById("ebay-conversation-list"),
    ebayConversationLoadMore: document.getElementById("ebay-conversation-load-more"),
    ebayConversationDetail: document.getElementById("ebay-conversation-detail"),
    ebayConversationContext: document.getElementById("ebay-conversation-context"),
    classificationSort: document.getElementById("classification-sort"),
    classificationPageSize: document.getElementById("classification-page-size"),
    classificationPriorityFilter: document.getElementById("classification-priority-filter"),
    classificationStatusFilter: document.getElementById("classification-status-filter"),
    classificationCategorySort: document.getElementById("classification-category-sort"),
    classificationFiltersToggle: document.getElementById("classification-filters-toggle"),
    classificationFiltersLabel: document.getElementById("classification-filters-label"),
    classificationFilterPanel: document.getElementById("classification-filter-panel"),
    classificationFilterToggles: document.querySelectorAll("[data-classification-filter]"),
    classificationDensityInputs: document.querySelectorAll("input[name='classification-density']"),
    classificationInboxShell: document.getElementById("classification-inbox-shell"),
    panelResizeHandles: document.querySelectorAll("[data-panel-resize]"),
    classificationCategoryList: document.getElementById("classification-category-list"),
    classificationPageSummary: document.getElementById("classification-page-summary"),
    classificationPrevPage: document.getElementById("classification-prev-page"),
    classificationNextPage: document.getElementById("classification-next-page"),
    classificationPageIndicator: document.getElementById("classification-page-indicator"),
    classificationList: document.getElementById("classification-list"),
    classificationDetail: document.getElementById("classification-detail"),
    greeting: document.getElementById("admin-greeting"),
  };

  function getStoredDashboardCollapsed() {
    try {
      const stored = window.localStorage?.getItem(DASHBOARD_COLLAPSED_STORAGE_KEY);
      return stored == null ? true : stored === "true";
    } catch (error) {
      return true;
    }
  }

  function storeDashboardCollapsed(collapsed) {
    try {
      window.localStorage?.setItem(DASHBOARD_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
    } catch (error) {
      // The toggle still works for this session if local storage is unavailable.
    }
  }

  function getStoredBooleanPreference(key, fallback) {
    try {
      const stored = window.localStorage?.getItem(key);
      return stored == null ? fallback : stored === "true";
    } catch (error) {
      return fallback;
    }
  }

  function storeBooleanPreference(key, value) {
    try {
      window.localStorage?.setItem(key, value ? "true" : "false");
    } catch (error) {
      // Preference changes still apply in memory when local storage is unavailable.
    }
  }

  function getStoredCategorySortMode() {
    try {
      const stored = window.localStorage?.getItem(CATEGORY_SORT_STORAGE_KEY);
      return ["alphabetical", "custom"].includes(stored) ? stored : "default";
    } catch (error) {
      return "default";
    }
  }

  function storeCategorySortMode(mode) {
    try {
      window.localStorage?.setItem(CATEGORY_SORT_STORAGE_KEY, ["alphabetical", "custom"].includes(mode) ? mode : "default");
    } catch (error) {
      // Category sorting remains available for the current session.
    }
  }

  function getStoredCustomCategoryOrder() {
    try {
      const parsed = JSON.parse(window.localStorage?.getItem(CUSTOM_CATEGORY_ORDER_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? normalizeCustomCategoryOrderIds(parsed) : [];
    } catch (error) {
      return [];
    }
  }

  function storeCustomCategoryOrder(order) {
    try {
      window.localStorage?.setItem(CUSTOM_CATEGORY_ORDER_STORAGE_KEY, JSON.stringify(normalizeCustomCategoryOrderIds(order)));
    } catch (error) {
      // Custom ordering still works in memory if local storage is unavailable.
    }
  }

  function clearStoredCustomCategoryOrder() {
    try {
      window.localStorage?.removeItem(CUSTOM_CATEGORY_ORDER_STORAGE_KEY);
    } catch (error) {
      // Reset remains available in memory if local storage is unavailable.
    }
  }

  function normalizeAdminViewPayload() {
    return {
      classifications: [],
      replay_operations: [],
      failed_jobs: [],
      page: {},
      queue_summary: {},
      classification_counts: {},
      validation_diagnostics: {},
    };
  }

  function isAdminViewEmpty(data = normalizeAdminViewPayload()) {
    return !data.classifications.length
      && !data.replay_operations.length
      && !data.failed_jobs.length
      && Object.values(data.queue_summary).every((value) => Number(value || 0) === 0)
      && Object.values(data.validation_diagnostics).every((value) => Number(value || 0) === 0);
  }

  const triageStore = createStore(createInitialState({
    data: normalizeAdminViewPayload({}),
    densityMode: getStoredDensityMode(),
    ebayConversationDensityMode: getStoredEbayConversationDensityMode(),
    ebayConversationPanelVisibility: getStoredEbayConversationPanelVisibility(),
    filtersExpanded: getStoredBooleanPreference(CLASSIFICATION_FILTERS_EXPANDED_STORAGE_KEY, false),
    ebayConversationFiltersExpanded: getStoredBooleanPreference(EBAY_CONVERSATION_FILTERS_EXPANDED_STORAGE_KEY, false),
    categorySortMode: getStoredCategorySortMode(),
    customCategoryOrder: getStoredCustomCategoryOrder(),
    operationalDashboardCollapsed: getStoredDashboardCollapsed(),
    ebayConversationClassificationCollapsed: !getStoredBooleanPreference(EBAY_CLASSIFICATION_EXPANDED_STORAGE_KEY, false),
    ebayDraftMetadataCollapsed: getStoredBooleanPreference(EBAY_DRAFT_METADATA_COLLAPSED_STORAGE_KEY, true),
  }));
  let adminClassificationState = triageStore.getState();
  function safePreviewImportability(state) {
    if (window.EmailTriageInbox?.previewImportability) {
      return window.EmailTriageInbox.previewImportability(state);
    }
    return { previewRowsCount: 0, importableLikelyCount: 0, selectedImportableCount: 0 };
  }

  function debugCategoryCounts(state) {
    const data = state.data || normalizeAdminViewPayload({});
    const classifications = data.classifications || [];
    return buildCategorySidebarGroups(data, state.categorySortMode, state.customCategoryOrder)
      .reduce((counts, group) => {
        counts[group.id] = sidebarGroupDisplayCount(data, classifications, group, state.activeFilters);
        return counts;
      }, {});
  }

  function selectedEmailHasLinks(state) {
    const selected = (state.data?.classifications || []).find((classification) => classification.id === state.selectedClassificationId) || null;
    const messageId = state.selectedMessageId || selected?.message_id || "";
    if (!messageId) return false;
    const context = state.matchContextsByMessageId?.[messageId];
    return Array.isArray(context?.matches) && context.matches.length > 0;
  }

  function pageInfoFromData(data = {}) {
    const counts = data.classification_counts || {};
    const page = data.page || {};
    return {
      page: Number(page.page || counts.page || 1) || 1,
      pageSize: Number(page.pageSize || counts.page_size || counts.current_limit_used || 25) || 25,
      offset: Number(page.offset || counts.page_offset || 0) || 0,
      totalPages: Math.max(Number(page.total_pages || counts.total_pages || 1) || 1, 1),
      filteredRows: Number(page.filtered_rows || counts.filtered_current_valid || counts.total_current_valid || 0) || 0,
      visibleRows: Number(page.visible_rows || counts.visible_rows || data.classifications?.length || 0) || 0,
      totalClassifiedRows: Number(page.total_classified_rows || counts.total_current_valid || 0) || 0,
      hasNextPage: page.has_more === true || counts.has_next_page === true,
      hasPreviousPage: page.has_previous_page === true || counts.has_previous_page === true,
    };
  }

  function classificationQueryFromState(state, overrides = {}) {
    const pagination = state.pagination || {};
    const pageSize = Number(overrides.pageSize || pagination.pageSize || pagination.limit || 25);
    return {
      page: Math.max(Number(overrides.page || pagination.page || 1) || 1, 1),
      pageSize: Math.min(Math.max(pageSize || 25, 1), 100),
      sort: overrides.sort || state.sortMode || "newest",
      category: overrides.category || state.selectedCategory || "all",
      priority: overrides.priority || state.priorityFilter || "all",
      status: overrides.status || state.statusFilter || "all",
      filters: Array.isArray(overrides.filters) ? overrides.filters : (state.activeFilters || []),
    };
  }

  function mergeSelectedClassificationCache(state, classifications = []) {
    const next = { ...(state.selectedClassificationsById || {}) };
    classifications.forEach((classification) => {
      if (classification?.id) next[classification.id] = classification;
    });
    return next;
  }

  triageStore.subscribe((state) => {
    adminClassificationState = state;
    const importability = safePreviewImportability(state);
    window.__emailTriageDebugState = {
      activeView: state.activeView,
      loading: state.loading,
      operationInFlight: state.operationInFlight,
      inboxPreviewLoading: state.inboxPreviewLoading,
      inboxImportLoading: state.inboxImportLoading,
      inboxLiveRefreshLoading: state.inboxLiveRefreshLoading,
      inboxRematchLoading: state.inboxRematchLoading,
      inboxPreviewCounts: state.inboxPreviewResult ? {
        messages_previewed: state.inboxPreviewResult.messages_previewed,
        messages_returned: state.inboxPreviewResult.messages_returned,
      } : null,
      previewRowsCount: importability.previewRowsCount,
      importableLikelyCount: importability.importableLikelyCount,
      selectedImportableCount: importability.selectedImportableCount,
      categoryCounts: debugCategoryCounts(state),
      selectedEmailId: state.selectedMessageId || selectedClassificationById(state.selectedClassificationId)?.message_id || null,
      selectedEmailHasLinks: selectedEmailHasLinks(state),
      lastOperationSummary: state.lastOperationSummary || null,
      dashboardLastLoadedAt: state.operationalDashboardUpdatedAt || null,
      inboxPreviewError: state.inboxPreviewError,
      inboxLastOperationId: state.inboxLastOperationId,
      inboxLastRefreshedAt: state.inboxLastRefreshedAt,
      inboxPreviewControls: state.inboxPreviewControls,
      ebayConversationLoading: state.ebayConversationLoading,
      ebayConversationCount: state.ebayConversations?.length || 0,
      ebayConversationSearchQuery: state.ebayConversationSearchQuery || "",
      ebayConversationFilter: state.ebayConversationFilter || "all",
      ebayConversationClassificationFilters: state.ebayConversationClassificationFilters || {},
      ebayConversationDensityMode: state.ebayConversationDensityMode || "compact",
      ebayConversationPanelVisibility: normalizeEbayConversationPanelVisibility(state.ebayConversationPanelVisibility),
      ebayConversationSmartFoldersEditing: state.ebayConversationSmartFoldersEditing === true,
      selectedEbayConversationId: state.selectedEbayConversationId,
      ebayConversationSyncLoading: state.ebayConversationSyncLoading,
      ebayConversationSyncResult: state.ebayConversationSyncResult,
      ebayConversationDraftLoadingId: state.ebayConversationDraftLoadingId,
      ebayConversationDraftActionLoadingId: state.ebayConversationDraftActionLoadingId,
    };
  });

  function applyPanelWidths(widths = getStoredPanelWidths()) {
    applyStoredPanelWidths(els.classificationInboxShell, widths);
  }

  function applyEbayPanelWidths(widths = getStoredEbayConversationPanelWidths()) {
    applyStoredEbayConversationPanelWidths(els.ebayConversationShell, widths);
  }

  function applyEbayWorkspacePanelVisibility(visibility = adminClassificationState.ebayConversationPanelVisibility) {
    if (!els.ebayConversationShell) return;
    const normalized = normalizeEbayConversationPanelVisibility(visibility);
    const showFolders = normalized.folders && normalized.list;
    const showList = normalized.list;
    const showContext = normalized.context;
    const columns = [];
    if (showFolders) columns.push("minmax(170px, var(--ebay-folder-panel-width))", "7px");
    if (showList) columns.push("minmax(260px, var(--ebay-list-panel-width))", "7px");
    columns.push(showFolders || showList || showContext ? "minmax(360px, 1fr)" : "minmax(0, 1fr)");
    if (showContext) columns.push("7px", "minmax(280px, var(--ebay-context-panel-width))");

    els.ebayConversationShell.style.setProperty("--ebay-workspace-columns", columns.join(" "));
    els.ebayConversationShell.classList.toggle("is-folders-collapsed", !showFolders);
    els.ebayConversationShell.classList.toggle("is-list-collapsed", !showList);
    els.ebayConversationShell.classList.toggle("is-context-collapsed", !showContext);

    els.ebayConversationPanelToggleButtons?.forEach((button) => {
      const panel = button.getAttribute("data-ebay-panel-toggle");
      const collapsed = panel === "folders"
        ? !normalized.folders
        : panel === "list" ? !normalized.list : panel === "context" ? !normalized.context : false;
      button.setAttribute("aria-pressed", collapsed ? "true" : "false");
      button.classList.toggle("is-active", collapsed);
    });
  }

  function bindPanelResizeEvents() {
    if (!els.classificationInboxShell || !els.panelResizeHandles?.length) return;
    applyPanelWidths();

    els.panelResizeHandles.forEach((handle) => {
      handle.addEventListener("pointerdown", (event) => {
        const panel = handle.getAttribute("data-panel-resize");
        if (!panel || window.matchMedia("(max-width: 760px)").matches) return;
        const shellRect = els.classificationInboxShell.getBoundingClientRect();
        const startX = event.clientX;
        const startWidths = getStoredPanelWidths();
        handle.setPointerCapture?.(event.pointerId);
        document.body.classList.add("is-resizing-email-panels");
        els.classificationInboxShell.classList.add("is-resizing");

        const move = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          const next = { ...startWidths };
          if (panel === "category") {
            next.category = clampNumber(startWidths.category + delta, 150, 340);
          } else if (panel === "detail") {
            next.detail = clampNumber(startWidths.detail - delta, 300, Math.min(680, shellRect.width - 460));
          }
          applyPanelWidths(next);
        };

        const finish = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", finish);
          document.removeEventListener("pointercancel", finish);
          document.body.classList.remove("is-resizing-email-panels");
          els.classificationInboxShell.classList.remove("is-resizing");
          const styles = window.getComputedStyle(els.classificationInboxShell);
          storePanelWidths({
            category: parseFloat(styles.getPropertyValue("--category-panel-width")) || startWidths.category,
            detail: parseFloat(styles.getPropertyValue("--detail-panel-width")) || startWidths.detail,
          });
        };

        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", finish, { once: true });
        document.addEventListener("pointercancel", finish, { once: true });
      });
    });
  }

  function bindEbayPanelResizeEvents() {
    if (!els.ebayConversationShell || !els.ebayConversationPanelResizeHandles?.length) return;
    applyEbayPanelWidths();

    els.ebayConversationPanelResizeHandles.forEach((handle) => {
      handle.addEventListener("pointerdown", (event) => {
        const panel = handle.getAttribute("data-ebay-panel-resize");
        if (!panel || window.matchMedia("(max-width: 1180px)").matches) return;
        const shellRect = els.ebayConversationShell.getBoundingClientRect();
        const startX = event.clientX;
        const startWidths = getStoredEbayConversationPanelWidths();
        handle.setPointerCapture?.(event.pointerId);
        document.body.classList.add("is-resizing-ebay-panels");
        els.ebayConversationShell.classList.add("is-resizing");

        const maxSideWidth = Math.max(280, Math.min(560, shellRect.width - 560));
        const move = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          const next = { ...startWidths };
          if (panel === "folders") {
            next.folders = clampNumber(startWidths.folders + delta, 170, Math.min(360, shellRect.width - 820));
          } else if (panel === "list") {
            next.list = clampNumber(startWidths.list + delta, 260, Math.min(520, shellRect.width - 640));
          } else if (panel === "context") {
            next.context = clampNumber(startWidths.context - delta, 280, maxSideWidth);
          }
          applyEbayPanelWidths(next);
        };

        const finish = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", finish);
          document.removeEventListener("pointercancel", finish);
          document.body.classList.remove("is-resizing-ebay-panels");
          els.ebayConversationShell.classList.remove("is-resizing");
          const styles = window.getComputedStyle(els.ebayConversationShell);
          storeEbayConversationPanelWidths({
            folders: parseFloat(styles.getPropertyValue("--ebay-folder-panel-width")) || startWidths.folders,
            list: parseFloat(styles.getPropertyValue("--ebay-list-panel-width")) || startWidths.list,
            context: parseFloat(styles.getPropertyValue("--ebay-context-panel-width")) || startWidths.context,
          });
        };

        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", finish, { once: true });
        document.addEventListener("pointercancel", finish, { once: true });
      });
    });
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

  function categoryMatchesGroup(classification, groupId) {
    const id = canonicalGroupId(groupId);
    if (id === "all") return true;
    if (id === "human_review") return categoryMatchesGroupBase(classification, id, CATEGORY_GROUPS);
    if (String(id || "").startsWith("category:")) {
      const category = getClassificationCategory(classification);
      return canonicalCategoryGroupId(category) === id;
    }
    const group = CATEGORY_GROUPS.find((item) => item.id === id);
    if (!group) return true;
    const categoryKey = canonicalCategoryKey(getClassificationCategory(classification));
    return group.categories.map(canonicalCategoryKey).includes(categoryKey);
  }

  function filteredClassifications(data, groupId, activeFilters = [], sortMode = "newest") {
    return sortedClassifications(data, sortMode).filter((classification) => (
      categoryMatchesGroup(classification, groupId)
      && matchesActiveFilters(classification, activeFilters)
    ));
  }

  function getClassificationCategory(classification) {
    return String(classification?.effective_category || classification?.category || "").trim();
  }

  function sidebarGroupCount(classifications, group, activeFilters) {
    if (group.id === "all") {
      return classifications.filter((classification) => matchesActiveFilters(classification, activeFilters)).length;
    }
    return classifications.filter((classification) => (
      categoryMatchesGroup(classification, group.id)
      && matchesActiveFilters(classification, activeFilters)
    )).length;
  }

  function exactCategoryTotalsAvailable(data, activeFilters = []) {
    return data.classification_counts?.category_totals_are_exact === true;
  }

  function exactSidebarGroupCount(data, group) {
    const counts = data.classification_counts || {};
    if (group.id === "all") return Number(counts.total_current_valid || 0);
    if (group.id === "human_review") return Number(counts.human_review_total || 0);

    const categoryTotals = counts.category_totals || {};
    const categoryEntries = Object.entries(categoryTotals);
    const matchesCategory = (category) => {
      const categoryKey = canonicalCategoryKey(category);
      if (String(group.id || "").startsWith("category:")) {
        return canonicalCategoryGroupId(categoryKey) === group.id;
      }
      const staticGroup = CATEGORY_GROUPS.find((item) => item.id === group.id);
      return staticGroup
        ? staticGroup.categories.map(canonicalCategoryKey).includes(categoryKey)
        : false;
    };

    return categoryEntries.reduce((total, [category, value]) => (
      matchesCategory(category) ? total + Number(value || 0) : total
    ), 0);
  }

  function sidebarGroupDisplayCount(data, classifications, group, activeFilters = []) {
    if (exactCategoryTotalsAvailable(data, activeFilters)) return exactSidebarGroupCount(data, group);
    return sidebarGroupCount(classifications, group, activeFilters);
  }

  function mergeCustomCategoryOrder(groups, customCategoryOrder = []) {
    const groupIds = new Set(groups.map((group) => group.id));
    const normalizedOrder = normalizeCustomCategoryOrderIds(customCategoryOrder);
    const orderedIds = [
      ...normalizedOrder.filter((id) => groupIds.has(id)),
      ...groups.map((group) => group.id).filter((id) => !normalizedOrder.includes(id)),
    ];
    const groupById = new Map(groups.map((group) => [group.id, group]));
    return orderedIds.map((id) => groupById.get(id)).filter(Boolean);
  }

  function buildCategorySidebarGroups(data, categorySortMode = "default", customCategoryOrder = []) {
    const classifications = data.classifications || [];
    const totalCategories = Object.keys(data.classification_counts?.category_totals || {});
    const representedCategories = [...new Set([
      ...classifications.map(getClassificationCategory).filter(Boolean),
      ...totalCategories.filter(Boolean),
    ])];
    const mergedStaticAliasKeys = new Set(["return_requests", "shipping_labels", "marketing_or_promotion", "item_not_as_described"]);
    const dynamicGroupById = new Map();
    representedCategories.forEach((category) => {
      const canonicalKey = canonicalCategoryKey(category);
      if (mergedStaticAliasKeys.has(canonicalKey)) return;
      const normalized = categoryDisplayGroup(category);
      const group = dynamicGroupById.get(normalized.id) || {
        id: normalized.id,
        label: normalized.label,
        categories: [],
        isDynamic: true,
      };
      group.categories.push(category);
      dynamicGroupById.set(normalized.id, group);
    });
    const dynamicGroups = [...dynamicGroupById.values()];
    const groups = [...CATEGORY_GROUPS, ...dynamicGroups];

    if (categorySortMode === "custom") return mergeCustomCategoryOrder(groups, customCategoryOrder);
    if (categorySortMode !== "alphabetical") return groups;

    const allGroup = groups.filter((group) => group.id === "all");
    const reviewGroup = groups.filter((group) => group.id === "human_review");
    const sortedGroups = groups
      .filter((group) => group.id !== "all" && group.id !== "human_review")
      .sort((left, right) => left.label.localeCompare(right.label));
    return [...allGroup, ...sortedGroups, ...reviewGroup];
  }

  function canonicalCategoryKey(category) {
    const key = String(category || "")
      .trim()
      .toLowerCase()
      .replace(/[/\s-]+/g, "_")
      .replace(/_+/g, "_");
    const aliases = {
      return_request: "return_requests",
      return_requests: "return_requests",
      shipping_label: "shipping_labels",
      shipping_labels: "shipping_labels",
      marketing_or_promotion: "marketing_or_promotion",
      marketing_promotion: "marketing_or_promotion",
    };
    return aliases[key] || key;
  }

  function categoryDisplayGroup(category) {
    const labels = {
      return_requests: "Return Requests",
      shipping_labels: "Shipping Labels",
      marketing_or_promotion: "Marketing/Promotion",
    };
    const canonicalKey = canonicalCategoryKey(category);
    return {
      id: `category:${canonicalKey}`,
      label: labels[canonicalKey] || humanizeValue(canonicalKey),
    };
  }

  function canonicalCategoryGroupId(category) {
    return `category:${canonicalCategoryKey(category)}`;
  }

  function staticGroupIdForCategoryKey(categoryKey) {
    const canonicalKey = canonicalCategoryKey(categoryKey);
    const staticAliasGroupIds = {
      return_requests: "return_requests",
      shipping_labels: "shipping_labels",
      marketing_or_promotion: "marketing_or_promotion",
      item_not_as_described: "item_not_as_described",
    };
    if (staticAliasGroupIds[canonicalKey]) return staticAliasGroupIds[canonicalKey];
    return "";
  }

  function canonicalGroupId(groupId) {
    const id = String(groupId || "").trim();
    const groupAliases = {
      marketing_promotion: "marketing_or_promotion",
    };
    if (groupAliases[id]) return groupAliases[id];
    if (!id.startsWith("category:")) return id;
    const canonicalKey = canonicalCategoryKey(id.slice("category:".length));
    return staticGroupIdForCategoryKey(canonicalKey) || `category:${canonicalKey}`;
  }

  function normalizeCustomCategoryOrderIds(order = []) {
    const seen = new Set();
    return order
      .filter((id) => typeof id === "string" && id.trim())
      .map(canonicalGroupId)
      .filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
  }

  function mergedCustomCategoryOrder(data, customCategoryOrder = []) {
    return buildCategorySidebarGroups(data, "custom", customCategoryOrder).map((group) => group.id);
  }

  function preserveHiddenCustomCategoryIds(visibleOrder, customCategoryOrder = []) {
    const normalizedVisibleOrder = normalizeCustomCategoryOrderIds(visibleOrder);
    const normalizedCustomOrder = normalizeCustomCategoryOrderIds(customCategoryOrder);
    const visibleIds = new Set(normalizedVisibleOrder);
    return [
      ...normalizedVisibleOrder,
      ...normalizedCustomOrder.filter((id) => !visibleIds.has(id)),
    ];
  }

  function moveCustomCategory(data, categoryId, direction, customCategoryOrder = []) {
    const order = mergedCustomCategoryOrder(data, customCategoryOrder);
    const index = order.indexOf(categoryId);
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || nextIndex < 0 || nextIndex >= order.length) return customCategoryOrder;
    const nextOrder = [...order];
    [nextOrder[index], nextOrder[nextIndex]] = [nextOrder[nextIndex], nextOrder[index]];
    return preserveHiddenCustomCategoryIds(nextOrder, customCategoryOrder);
  }

  function stalenessState(record) {
    const staleness = record?.staleness && typeof record.staleness === "object" ? record.staleness : {};
    return {
      status: String(staleness.status || ""),
      isStale: staleness.is_stale === true || staleness.status === "stale",
      message: String(staleness.message || ""),
      reasonCode: String(staleness.reason_code || ""),
      checkedAt: staleness.checked_at || null,
    };
  }

  function renderStaleClassificationWarning(classification) {
    const stale = stalenessState(classification);
    if (!stale.isStale) return "";
    return `
      <div class="classification-notice is-warning stale-context-notice">
        <strong>Classification may be stale.</strong>
        <span>${escapeHtml(stale.message || "Deterministic context changed after this classification was generated. Reclassify before trusting it.")}</span>
      </div>
    `;
  }

  function renderStaleDraftWarning(draftOrPayload) {
    const stale = stalenessState(draftOrPayload?.staleness ? draftOrPayload : { staleness: draftOrPayload });
    if (!stale.isStale) return "";
    return `
      <div class="classification-notice is-warning stale-context-notice">
        <strong>Draft may be stale.</strong>
        <span>${escapeHtml(stale.message || "This draft was generated before current context changed. Regenerate after reclassification or context confirmation.")}</span>
      </div>
    `;
  }

  function renderCustomCategoryOrderActions(state) {
    if (state.categorySortMode !== "custom") return "";
    if (state.customCategoryOrderEditing === true) {
      return `
        <div class="category-order-actions is-editing" aria-label="Custom category order actions">
          <button type="button" class="category-order-action-btn is-primary" data-category-order-action="save">Save order</button>
          <button type="button" class="category-order-action-btn" data-category-order-action="cancel">Cancel</button>
          <button type="button" class="category-order-action-btn is-danger" data-category-order-action="reset">Reset custom order</button>
        </div>
      `;
    }
    return `
      <div class="category-order-actions" aria-label="Custom category order actions">
        <button type="button" class="category-order-action-btn" data-category-order-action="edit">Edit order</button>
      </div>
    `;
  }

  function renderCategorySidebar(state, data) {
    if (!els.classificationCategoryList) return;

    const classifications = data.classifications || [];
    const customMode = state.categorySortMode === "custom";
    const editingCustomOrder = customMode && state.customCategoryOrderEditing === true;
    const activeCustomOrder = editingCustomOrder && Array.isArray(state.customCategoryOrderDraft)
      ? state.customCategoryOrderDraft
      : state.customCategoryOrder;
    const groups = buildCategorySidebarGroups(data, state.categorySortMode, activeCustomOrder);
    const showingExactTotals = exactCategoryTotalsAvailable(data, state.activeFilters);
    const countNote = showingExactTotals
      ? "Counts are exact totals for the current query."
      : "Counts are loaded-view rows for the active filters.";
    const countTitle = showingExactTotals
      ? "Exact current valid classifications"
      : "Loaded rows in the current filtered admin view";
    const countSuffix = showingExactTotals ? "total" : "loaded";
    els.classificationCategoryList.classList.toggle("is-custom-order", customMode);
    els.classificationCategoryList.classList.toggle("is-editing-order", editingCustomOrder);
    els.classificationCategoryList.innerHTML = `
      <p class="classification-loaded-count-note">${escapeHtml(countNote)}</p>
    ` + groups.map((group, index) => {
      const count = sidebarGroupDisplayCount(data, classifications, group, state.activeFilters);
      const active = canonicalGroupId(state.selectedCategory) === group.id;
      const dynamicClass = group.isDynamic ? " is-dynamic" : "";
      const moveControls = editingCustomOrder ? `
        <span class="category-order-controls" aria-label="Move ${escapeHtml(group.label)}">
          <button type="button" class="category-order-btn" data-category-move="up" data-category-id="${escapeHtml(group.id)}" aria-label="Move ${escapeHtml(group.label)} up" ${index === 0 ? "disabled" : ""}>
            <i data-lucide="arrow-up"></i>
          </button>
          <button type="button" class="category-order-btn" data-category-move="down" data-category-id="${escapeHtml(group.id)}" aria-label="Move ${escapeHtml(group.label)} down" ${index === groups.length - 1 ? "disabled" : ""}>
            <i data-lucide="arrow-down"></i>
          </button>
        </span>
      ` : "";

      return `
        <div class="classification-category-item${editingCustomOrder ? " has-order-controls" : ""}">
          ${moveControls}
          <button type="button" class="classification-category-button${active ? " is-active" : ""}${group.id === "human_review" ? " is-review" : ""}${dynamicClass}" data-category-id="${escapeHtml(group.id)}">
            <span>${escapeHtml(group.label)}</span>
            <b title="${escapeHtml(countTitle)}">${escapeHtml(count)} ${escapeHtml(countSuffix)}</b>
          </button>
        </div>
      `;
    }).join("") + renderCustomCategoryOrderActions(state);
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function renderClassificationList(state, data) {
    if (!els.classificationList) return;

    const rows = data.classifications || [];
    if (!rows.length) {
      const emptyText = data.classifications.length
        ? "No classifications are on this page."
        : "No durable rows match the current query.";
      els.classificationList.innerHTML = `<div class="classification-empty">${escapeHtml(emptyText)}</div>`;
      return;
    }

    const compactMode = state.densityMode === "compact";

    els.classificationList.innerHTML = rows.map((classification) => {
      const selected = state.selectedClassificationId === classification.id;
      const humanReview = hasHumanReviewSignal(classification);
      const receivedAt = getClassificationReceivedAt(classification);
      const dateLabel = receivedAt ? formatDateTime(receivedAt) : `Classified ${formatDateTime(classification.created_at)}`;
      const ageLabel = receivedAt ? formatCompactEmailAge(receivedAt) : formatCompactEmailAge(classification.created_at);
      const rowMeta = renderWorkflowMetaText(classification, ageLabel, { includeCategory: true });
      const compactRowMeta = renderWorkflowMetaText(classification, "", { includeCategory: true });
      const stale = stalenessState(classification);

      if (compactMode) {
        return `
          <button type="button" class="classification-row is-compact${selected ? " is-selected" : ""}" data-classification-id="${escapeHtml(classification.id)}">
            <span class="classification-compact-main">
              <strong>${escapeHtml(getClassificationTitle(classification))}</strong>
              <span>${escapeHtml(getClassificationSender(classification))}</span>
            </span>
            <span class="classification-compact-badges">
              ${compactRowMeta}
              ${stale.isStale ? renderBadge("Stale context", "warning") : ""}
            </span>
            <span class="classification-compact-time">${escapeHtml(ageLabel)}</span>
          </button>
        `;
      }

      return `
        <button type="button" class="classification-row${selected ? " is-selected" : ""}" data-classification-id="${escapeHtml(classification.id)}">
          <span class="classification-row-top">
            <strong>${escapeHtml(getClassificationTitle(classification))}</strong>
          </span>
          <span class="classification-row-meta">
            ${rowMeta}
          </span>
          <span class="classification-row-meta">
            <span>${escapeHtml(dateLabel)}</span>
          </span>
          <span class="classification-row-meta">
            <span>${escapeHtml(getClassificationSender(classification))}</span>
          </span>
          <span class="classification-row-preview">${escapeHtml(getClassificationPreview(classification))}</span>
          ${humanReview ? `<span class="classification-row-alert">Human review</span>` : ""}
          ${stale.isStale ? `<span class="classification-row-alert is-stale">Stale context</span>` : ""}
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
        <details class="classification-detail-section email-body-section detail-disclosure stored-body-disclosure" open>
          <summary>
            <span>Stored Body Text</span>
            <i data-lucide="chevron-down"></i>
          </summary>
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
        </details>
      `;
    }

    return `
      <details class="classification-detail-section email-body-section detail-disclosure stored-body-disclosure">
        <summary>
          <span>Stored Body Text</span>
          <i data-lucide="chevron-down"></i>
        </summary>
        <p>${escapeHtml(selected.message_body_preview || "No body preview available.")}</p>
        ${error ? `<div class="classification-notice is-error">Could not load full email text: ${escapeHtml(error)}</div>` : ""}
        <button type="button" class="secondary-btn classification-body-action" data-message-detail-action="${detail ? "expand" : "load"}" data-message-id="${escapeHtml(messageId)}" ${isLoading || !messageId ? "disabled" : ""}>
          <i data-lucide="${isLoading ? "loader-circle" : detail ? "chevron-down" : "file-text"}"></i>
          ${isLoading ? "Loading Email" : "View Full Email"}
        </button>
      </details>
    `;
  }

  function safeArray(value) {
    return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== "") : [];
  }

  function safeText(value, fallback = "--") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function formatContextDate(value) {
    return value ? formatDateTime(value) : "--";
  }

  function formatContextMoney(value) {
    if (value === null || value === undefined || value === "") return "--";
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return number.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }

  function formatContextNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "--";
    return number.toLocaleString();
  }

  function renderInfoChips(items = [], emptyText = "None") {
    const chips = safeArray(items);
    if (!chips.length) return `<span class="context-info-chip is-muted">${escapeHtml(emptyText)}</span>`;
    return chips.map((item) => `<span class="context-info-chip">${escapeHtml(humanizeValue(item))}</span>`).join("");
  }

  function warningParts(warning) {
    if (warning && typeof warning === "object") {
      return {
        code: warning.code || warning.type || "context_warning",
        message: warning.message || warning.detail || warning.code || "Context warning",
        severity: String(warning.severity || warning.level || "warning").toLowerCase(),
      };
    }
    return {
      code: String(warning || "context_warning"),
      message: humanizeValue(warning || "Context warning"),
      severity: "warning",
    };
  }

  function renderWarningPanel(detailWarnings = [], contextWarnings = []) {
    const warnings = [
      ...safeArray(detailWarnings).map((warning) => ({ ...warningParts(warning), source: "Thread" })),
      ...safeArray(contextWarnings).map((warning) => ({ ...warningParts(warning), source: "Context" })),
    ];
    if (!warnings.length) return "";

    return `
      <div class="context-warning-panel" aria-label="Context warnings">
        <strong>Context Notes</strong>
        <div class="context-warning-list">
          ${warnings.map((warning) => `
            <span class="context-warning-chip is-${escapeHtml(warning.severity === "error" ? "error" : warning.severity === "info" ? "info" : "warning")}">
              <b>${escapeHtml(warning.source)}</b>
              ${escapeHtml(warning.message || humanizeValue(warning.code))}
            </span>
          `).join("")}
        </div>
      </div>
    `;
  }

  function threadRoleLabel(role) {
    const value = String(role || "").toLowerCase();
    if (value === "buyer") return "Buyer";
    if (value === "operator" || value === "seller") return "OG / Seller";
    if (value === "platform" || value === "ebay") return "eBay";
    return "Unknown";
  }

  function threadRoleClass(role) {
    const value = String(role || "").toLowerCase();
    if (value === "buyer") return "buyer";
    if (value === "operator" || value === "seller") return "seller";
    if (value === "platform" || value === "ebay") return "ebay";
    return "unknown";
  }

  function renderThreadText(text) {
    const cleaned = safeText(text, "No stored body text for this thread block.");
    const isLong = cleaned.length > 1200;
    const excerpt = isLong ? `${cleaned.slice(0, 1200).trim()}...` : cleaned;
    if (!isLong) return `<pre class="thread-card-text">${escapeHtml(cleaned)}</pre>`;
    return `
      <pre class="thread-card-text">${escapeHtml(excerpt)}</pre>
      <details class="thread-card-more">
        <summary>Show full stored text</summary>
        <pre>${escapeHtml(cleaned)}</pre>
      </details>
    `;
  }

  function renderConversationSection(state, selected) {
    const messageId = selected?.message_id || "";
    const detail = messageId ? state.messageDetailsById[messageId] : null;
    const error = messageId ? state.messageDetailErrorsById[messageId] : null;
    const isLoading = state.messageDetailLoadingId === messageId;
    const blocks = safeArray(detail?.thread_blocks);

    if (!detail) {
      return renderCoreDisclosure(
        "Conversation",
        renderBadge("Stored thread", "muted"),
        `
          <p class="conversation-empty">Load the selected message detail to view stored thread blocks.</p>
          ${error ? `<div class="classification-notice is-error">Could not load conversation: ${escapeHtml(error)}</div>` : ""}
          <button type="button" class="secondary-btn classification-body-action" data-message-detail-action="load" data-message-id="${escapeHtml(messageId)}" ${isLoading || !messageId ? "disabled" : ""}>
            <i data-lucide="${isLoading ? "loader-circle" : "messages-square"}"></i>
            ${escapeHtml(isLoading ? "Loading Conversation" : "View Full Email")}
          </button>
        `,
        "thread-section",
      );
    }

    return renderCoreDisclosure(
      "Conversation",
      renderBadge(`${blocks.length} ${blocks.length === 1 ? "block" : "blocks"}`, blocks.length ? "category" : "muted"),
      `
        ${blocks.length ? `
          <div class="thread-card-list">
            ${blocks.map((block) => {
              const sender = [block.sender_name, block.sender_email ? `<${block.sender_email}>` : ""].filter(Boolean).join(" ");
              const timestamp = block.received_at || block.sent_at;
              return `
                <article class="thread-card">
                  <div class="thread-card-head">
                    <div class="thread-card-sender">
                      <strong>${escapeHtml(sender || "Sender unavailable")}</strong>
                      <span>${escapeHtml(formatContextDate(timestamp))}</span>
                    </div>
                    <span class="thread-role-badge is-${escapeHtml(threadRoleClass(block.role))}">${escapeHtml(threadRoleLabel(block.role))}</span>
                  </div>
                  ${block.subject ? `<div class="thread-card-subject">${escapeHtml(block.subject)}</div>` : ""}
                  ${safeArray(block.warnings).length ? `<div class="thread-card-warnings">${renderInfoChips(block.warnings, "No warnings")}</div>` : ""}
                  ${renderThreadText(block.text)}
                </article>
              `;
            }).join("")}
          </div>
        ` : `<div class="classification-empty matched-context-empty">No stored thread blocks were available for this message.</div>`}
        ${renderWarningPanel(detail.warnings, [])}
      `,
      "thread-section",
    );
  }

  function renderOperatorReviewSection(state, selected) {
    const reviewState = String(selected.classification_review_state || "pending_review");
    const saving = state.reviewSavingId === selected.id;
    const error = state.reviewErrorsById[selected.id];
    const effectiveCategory = selected.effective_category || selected.operator_override_category || selected.category || "";
    const effectivePriority = selected.effective_priority || selected.operator_override_priority || selected.priority || "";
    const effectiveUrgency = selected.effective_urgency || selected.operator_override_urgency || selected.urgency || "";

    return `
      <details class="classification-detail-section classification-review-section detail-disclosure">
        <summary>
          <span>Operator Review Details</span>
          <i data-lucide="chevron-down"></i>
        </summary>
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
      </details>
    `;
  }

  function currentDraftFromPayload(payload) {
    const drafts = Array.isArray(payload?.drafts) ? payload.drafts : [];
    return drafts.find((draft) => draft.is_current === true) || drafts[0] || null;
  }

  function currentDraftForMessage(messageId) {
    return currentDraftFromPayload(adminClassificationState.draftsByMessageId[messageId]);
  }

  function logEmailTriageDraftDebug(selected, payload) {
    if (window.DEBUG_EMAIL_TRIAGE !== true) return;
    const currentDraft = currentDraftFromPayload(payload);
    console.debug("[email-triage] draft selector debug", {
      selected_message_id: selected?.message_id || null,
      selected_classification_id: selected?.id || selected?.classification_id || null,
      current_draft_id: currentDraft?.id || null,
      current_draft_classification_id: currentDraft?.classification_id || null,
      classification_mismatch_metadata: {
        classification_mismatch: payload?.classification_mismatch === true,
        selected_classification_id: payload?.selected_classification_id || null,
        current_draft_classification_id: payload?.current_draft_classification_id || null,
      },
      validation_status: currentDraft?.validation_status || null,
      draft_body_returned: currentDraft?.draft_content_returned === true,
      fallback_used: currentDraft?.fallback_used === true || currentDraft?.metadata?.fallback_used === true,
    });
  }

  function validationExplanationsForDraft(draft) {
    if (!draft || typeof draft !== "object") return [];
    if (Array.isArray(draft.primary_validation_error_explanations) && draft.primary_validation_error_explanations.length) {
      return draft.primary_validation_error_explanations;
    }
    if (Array.isArray(draft.validation_error_explanations) && draft.validation_error_explanations.length) {
      return draft.validation_error_explanations;
    }
    const metadata = draft.metadata && typeof draft.metadata === "object" ? draft.metadata : {};
    if (Array.isArray(metadata.primary_validation_error_explanations)) return metadata.primary_validation_error_explanations;
    if (Array.isArray(metadata.validation_error_explanations)) return metadata.validation_error_explanations;
    return [];
  }

  function renderValidationExplanations(explanations = []) {
    const list = Array.isArray(explanations) ? explanations.filter(Boolean) : [];
    if (!list.length) return "";
    return `
      <div class="validation-explanation-list">
        ${list.slice(0, 6).map((item) => `
          <div class="validation-explanation-row">
            <strong>${escapeHtml(item.operator_label || humanizeValue(item.error_code || "Validation issue"))}</strong>
            <p>${escapeHtml(item.reason || "The original draft included a claim that could not be verified.")}</p>
            ${item.safe_alternative ? `<span>${escapeHtml(item.safe_alternative)}</span>` : ""}
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderDraftMetaGrid(draft) {
    const metadata = draft?.metadata && typeof draft.metadata === "object" ? draft.metadata : {};
    return `
      <dl class="classification-detail-grid draft-detail-grid">
        <div>
          <dt>Version</dt>
          <dd>v${escapeHtml(draft.draft_version || "--")}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>${renderBadge(humanizeValue(draft.draft_status || "Unknown"), statusBadgeVariant(draft.draft_status))}</dd>
        </div>
        <div>
          <dt>Validation</dt>
          <dd>${renderBadge(humanizeValue(draft.validation_status || "Unknown"), statusBadgeVariant(draft.validation_status))}</dd>
        </div>
        <div>
          <dt>Human Review</dt>
          <dd>${renderBadge(draft.requires_human_review === false ? "Not required" : "Required", draft.requires_human_review === false ? "muted" : "warning")}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>${escapeHtml(formatDateTime(draft.created_at))}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>${escapeHtml([draft.model_name, draft.model_version].filter(Boolean).join(" ") || "Unavailable")}</dd>
        </div>
        <div>
          <dt>Prompt</dt>
          <dd>${escapeHtml(draft.prompt_version || metadata.prompt_version || "Unavailable")}</dd>
        </div>
        <div>
          <dt>Content</dt>
          <dd>${renderBadge(draft.draft_content_returned ? "Returned" : humanizeValue(draft.draft_content_omitted_reason || "Omitted"), draft.draft_content_returned ? "success" : "warning")}</dd>
        </div>
      </dl>
    `;
  }

  function renderDraftHistory(drafts = []) {
    if (!drafts.length) return `<div class="classification-empty draft-empty">No draft history yet.</div>`;

    return `
      <div class="draft-history-list" aria-label="Draft history">
        ${drafts.map((draft) => `
          <div class="draft-history-row">
            <strong>v${escapeHtml(draft.draft_version || "--")}</strong>
            <span>${draft.is_current ? "Current" : "Non-current"}</span>
            ${stalenessState(draft).isStale ? renderBadge("Stale", "warning") : ""}
            ${renderBadge(humanizeValue(draft.draft_status || "Unknown"), statusBadgeVariant(draft.draft_status))}
            ${renderBadge(humanizeValue(draft.validation_status || "Unknown"), statusBadgeVariant(draft.validation_status))}
            <time>${escapeHtml(formatDateTime(draft.created_at))}</time>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderAdvancedDisclosure(title, badgeHtml, bodyHtml) {
    return `
      <details class="classification-detail-section detail-disclosure">
        <summary>
          <span>${escapeHtml(title)}</span>
          <i data-lucide="chevron-down"></i>
        </summary>
        ${bodyHtml}
      </details>
    `;
  }

  function renderCoreDisclosure(title, badgeHtml, bodyHtml, className = "") {
    return `
      <details class="classification-detail-section detail-disclosure core-disclosure ${escapeHtml(className)}" open>
        <summary>
          <span>${escapeHtml(title)}</span>
          <i data-lucide="chevron-down"></i>
        </summary>
        ${bodyHtml}
      </details>
    `;
  }

  function renderResponseDraftSection(state, selected) {
    const messageId = selected?.message_id || "";
    const payload = messageId ? state.draftsByMessageId[messageId] : null;
    const drafts = Array.isArray(payload?.drafts) ? payload.drafts : [];
    const currentDraft = currentDraftFromPayload(payload);
    const isLoading = state.draftLoadingMessageId === messageId;
    const isActing = state.draftActionMessageId === messageId;
    const error = messageId ? state.draftErrorsByMessageId[messageId] : null;
    const actionError = messageId ? state.draftActionErrorsByMessageId[messageId] : null;
    const actionMessage = messageId ? state.draftActionMessagesByMessageId[messageId] : null;
    const actionMode = currentDraft ? "regenerate_response" : "generate_response";
    const actionLabel = currentDraft ? "Regenerate Draft" : "Generate Draft";
    const fallbackUsed = currentDraft?.fallback_used === true || currentDraft?.metadata?.fallback_used === true;
    const fallbackBodySaved = currentDraft?.fallback_body_saved === true || currentDraft?.metadata?.fallback_body_saved === true;
    const weakMatchTreatedAsUnverified = currentDraft?.weak_match_treated_as_unverified === true || currentDraft?.metadata?.weak_match_treated_as_unverified === true;
    const fallbackContentReturned = fallbackUsed && fallbackBodySaved && String(currentDraft?.draft_body_text || "").trim();
    const canEditDraft = currentDraft?.draft_content_returned === true || Boolean(fallbackContentReturned);
    const reviewDisabled = isLoading || isActing || !currentDraft?.id || !canEditDraft;
    const primaryValidationErrors = Array.isArray(currentDraft?.primary_validation_errors) && currentDraft.primary_validation_errors.length
      ? currentDraft.primary_validation_errors
      : Array.isArray(currentDraft?.metadata?.primary_validation_errors) ? currentDraft.metadata.primary_validation_errors : [];
    const validationExplanations = validationExplanationsForDraft(currentDraft);

    return `
      <details class="classification-detail-section response-draft-section detail-disclosure core-disclosure" open>
        <summary>
          <span>AI Response Draft</span>
          ${currentDraft ? `<span class="draft-version-subtle">v${escapeHtml(currentDraft.draft_version || "--")}</span>` : ""}
          <i data-lucide="chevron-down"></i>
        </summary>
        <div class="classification-notice is-warning draft-safety-notice">
          Draft requires human review. Approved does not send. Rejected does not delete draft.
        </div>
        ${error ? `<div class="classification-notice is-error">Could not load draft view: ${escapeHtml(error)}</div>` : ""}
        ${actionError ? `<div class="classification-notice is-error">Draft action failed: ${escapeHtml(actionError)}</div>` : ""}
        ${actionMessage ? `<div class="classification-notice is-success">${escapeHtml(actionMessage)}</div>` : ""}
        ${currentDraft ? renderStaleDraftWarning(currentDraft) : renderStaleDraftWarning(payload)}
        ${fallbackUsed ? `
          <div class="classification-notice is-warning draft-fallback-notice">
            <strong>Conservative safe draft available.</strong>
            <span>${primaryValidationErrors.length ? "Original AI draft was blocked." : weakMatchTreatedAsUnverified ? "Weak match context was treated as unverified for buyer-facing content." : "Specific buyer-facing context was not verified."} This fallback is conservative, editable, and still requires human review.</span>
            ${primaryValidationErrors.length ? `
              <div class="draft-fallback-blocked">
                <span>Original draft blocked because:</span>
                ${renderCompactList(primaryValidationErrors, "No original validation failures")}
              </div>
            ` : ""}
            ${renderValidationExplanations(validationExplanations)}
          </div>
        ` : ""}
        <div class="draft-actions">
          <button type="button" class="${currentDraft ? "secondary-btn" : "primary-btn"}" data-draft-action="${escapeHtml(actionMode)}" data-message-id="${escapeHtml(messageId)}" data-classification-id="${escapeHtml(selected.id)}" data-draft-id="${escapeHtml(currentDraft?.id || "")}" ${isLoading || isActing || !messageId ? "disabled" : ""}>
            <i data-lucide="${isActing ? "loader-circle" : currentDraft ? "refresh-cw" : "wand-sparkles"}"></i>
            ${escapeHtml(isActing ? (currentDraft ? "Regenerating Draft" : "Generating Draft") : actionLabel)}
          </button>
          <button type="button" class="secondary-btn" data-draft-action="refresh" data-message-id="${escapeHtml(messageId)}" data-classification-id="${escapeHtml(selected.id)}" ${isLoading || isActing || !messageId ? "disabled" : ""}>
            <i data-lucide="${isLoading ? "loader-circle" : "refresh-cw"}"></i>
            ${escapeHtml(isLoading ? "Loading Drafts" : "Refresh Drafts")}
          </button>
        </div>
        ${isLoading && !payload ? `<div class="classification-empty draft-empty">Loading draft history.</div>` : ""}
        ${currentDraft ? `
          <form class="draft-review-form" data-draft-review-form>
            <input type="hidden" name="messageId" value="${escapeHtml(messageId)}" />
            <input type="hidden" name="classificationId" value="${escapeHtml(selected.id)}" />
            <input type="hidden" name="draftId" value="${escapeHtml(currentDraft.id)}" />
            <label class="draft-field">
              <span>Draft Subject</span>
              <input name="draftSubject" type="text" maxlength="180" value="${escapeHtml(currentDraft.draft_subject || "")}" ${reviewDisabled ? "disabled" : ""} />
            </label>
            <label class="draft-field">
              <span>Draft Body</span>
              <textarea name="draftBodyText" rows="10" maxlength="5000" ${reviewDisabled ? "disabled" : ""}>${escapeHtml(currentDraft.draft_body_text || "")}</textarea>
            </label>
            <label class="draft-field">
              <span>Operator Notes</span>
              <textarea name="operatorNotes" rows="3" maxlength="2000" ${isLoading || isActing || !currentDraft?.id ? "disabled" : ""}>${escapeHtml(currentDraft.operator_notes || "")}</textarea>
            </label>
            ${!canEditDraft && !fallbackUsed ? `<div class="classification-notice is-warning">Draft content is not editable because validation or safety checks blocked returning the body.</div>` : ""}
            <div class="draft-actions draft-review-actions">
              <button type="button" class="secondary-btn" data-draft-review-action="save_draft_review" ${reviewDisabled ? "disabled" : ""}>
                <i data-lucide="${isActing ? "loader-circle" : "save"}"></i>
                ${escapeHtml(isActing ? "Saving" : "Save Draft Edits")}
              </button>
              <button type="button" class="primary-btn" data-draft-review-action="approve_draft" ${reviewDisabled ? "disabled" : ""}>
                <i data-lucide="${isActing ? "loader-circle" : "check-circle"}"></i>
                ${escapeHtml(isActing ? "Approving" : "Approve Draft")}
              </button>
              <button type="button" class="danger-btn" data-draft-review-action="reject_draft" ${isLoading || isActing || !currentDraft?.id ? "disabled" : ""}>
                <i data-lucide="${isActing ? "loader-circle" : "x-circle"}"></i>
                ${escapeHtml(isActing ? "Rejecting" : "Reject Draft")}
              </button>
            </div>
          </form>
          ${renderAdvancedDisclosure(
            "Workflow / Draft Metadata",
            renderBadge(`v${currentDraft.draft_version || "--"}`, "muted"),
            `
              ${renderDraftMetaGrid(currentDraft)}
              <div class="draft-safety-flags">
                <span>Safety Flags</span>
                <div class="classification-pill-list">${renderPillList(currentDraft.safety_flags, "No safety flags")}</div>
              </div>
              ${Array.isArray(currentDraft.validation_errors) && currentDraft.validation_errors.length ? `
                <div class="draft-safety-flags">
                  <span>Validation Errors</span>
                  <div class="classification-pill-list">${renderPillList(currentDraft.validation_errors, "No validation errors")}</div>
                </div>
              ` : ""}
              ${fallbackUsed && primaryValidationErrors.length ? `
                <div class="draft-safety-flags">
                  <span>Original Validation Errors</span>
                  <div class="classification-pill-list">${renderPillList(primaryValidationErrors, "No original validation errors")}</div>
                </div>
              ` : ""}
              ${renderValidationExplanations(validationExplanations)}
            `,
          )}
        ` : (!isLoading ? `<div class="classification-empty draft-empty">No response draft exists for this selected email yet.</div>` : "")}
        ${renderAdvancedDisclosure(
          "Draft History",
          renderBadge(`${drafts.length} ${drafts.length === 1 ? "version" : "versions"}`, "muted"),
          renderDraftHistory(drafts),
        )}
      </details>
    `;
  }

  function renderCompactList(items = [], emptyText = "None") {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length) return `<div class="classification-empty matched-context-empty">${escapeHtml(emptyText)}</div>`;
    return `
      <ul class="matched-context-list">
        ${list.slice(0, 8).map((item) => `<li>${escapeHtml(humanizeValue(item))}</li>`).join("")}
      </ul>
    `;
  }

  function contextConfidenceVariant(confidence) {
    const value = String(confidence || "").toLowerCase();
    if (value === "confirmed" || value === "strong") return "success";
    if (value === "medium") return "category";
    if (value === "suggested" || value === "weak") return "warning";
    return "muted";
  }

  function renderContextFactGrid(items = []) {
    return `
      <dl class="context-fact-grid">
        ${items.map((item) => `
          <div${item.wide ? ' class="context-fact-wide"' : ""}>
            <dt>${escapeHtml(item.label)}</dt>
            <dd>${escapeHtml(safeText(item.value))}</dd>
          </div>
        `).join("")}
      </dl>
    `;
  }

  function renderBuyerSummaryCard(context) {
    const buyer = context?.buyer && typeof context.buyer === "object" ? context.buyer : {};
    const history = context?.buyer_history_summary && typeof context.buyer_history_summary === "object"
      ? context.buyer_history_summary
      : null;
    const coverage = history?.coverage && typeof history.coverage === "object" ? history.coverage : {};
    const confidence = String(buyer.confidence || "none").toLowerCase();
    const weakIdentity = confidence === "weak" || confidence === "none";

    return `
      <section class="context-card buyer-summary-card">
        <div class="context-card-head">
          <h4>Buyer Summary</h4>
          ${renderBadge(humanizeValue(confidence), contextConfidenceVariant(confidence))}
        </div>
        ${weakIdentity ? `
          <div class="classification-notice is-warning">
            Buyer identity is ${escapeHtml(humanizeValue(confidence))}. Treat this as operator-only context and avoid assuming it is the buyer in draft text.
          </div>
        ` : ""}
        ${renderContextFactGrid([
          { label: "Username", value: buyer.username || "No buyer identified" },
          { label: "Name", value: buyer.name || "Unavailable" },
          { label: "Email", value: buyer.email || "Unavailable" },
          { label: "Matched From", value: buyer.matched_from ? humanizeValue(buyer.matched_from) : "Unavailable" },
        ])}
        <div class="buyer-metric-grid">
          ${[
            ["Prior Orders", formatContextNumber(history?.prior_order_count)],
            ["Gross Value", formatContextMoney(history?.gross_value)],
            ["Retained Value", formatContextMoney(history?.retained_value)],
            ["Average Order", formatContextMoney(history?.average_order_value)],
            ["Returns", formatContextNumber(history?.return_count)],
            ["Open Returns", formatContextNumber(history?.open_return_count)],
            ["Cancellations", formatContextNumber(history?.cancellation_count)],
            ["Coverage", coverage.status ? humanizeValue(coverage.status) : "Unavailable"],
          ].map(([label, value]) => `
            <div>
              <span>${escapeHtml(label)}</span>
              <strong>${escapeHtml(value)}</strong>
            </div>
          `).join("")}
        </div>
        ${renderContextFactGrid([
          { label: "First Prior Purchase", value: formatContextDate(history?.first_prior_purchase_at) },
          { label: "Last Prior Purchase", value: formatContextDate(history?.last_prior_purchase_at) },
          { label: "Archive Coverage", value: coverage.covered_by_account_archive === true ? "Covered by account archive" : coverage.covered_by_account_archive === false ? "Not covered by account archive" : "Unknown" },
          { label: "Coverage Last Success", value: formatContextDate(coverage.last_success_at) },
        ])}
      </section>
    `;
  }

  function renderOrderContextCard(orders = []) {
    const rows = safeArray(orders);
    return `
      <section class="context-card">
        <div class="context-card-head">
          <h4>Matched Orders</h4>
          ${renderBadge(`${rows.length} ${rows.length === 1 ? "order" : "orders"}`, rows.length ? "category" : "muted")}
        </div>
        ${rows.length ? `
          <div class="context-row-list">
            ${rows.map((order) => `
              <div class="context-row order-row">
                ${renderContextFactGrid([
                  { label: "Order", value: order.order_number || "Unavailable" },
                  { label: "Status", value: order.status || "Unknown" },
                  { label: "Buyer", value: order.buyer_username || "Unknown" },
                  { label: "Sale Date", value: formatContextDate(order.sale_date) },
                  { label: "Paid", value: formatContextDate(order.paid_on_date) },
                  { label: "Ship By", value: formatContextDate(order.ship_by_date) },
                  { label: "Shipped", value: formatContextDate(order.shipped_on_date) },
                  { label: "Total Price", value: formatContextMoney(order.total_price) },
                  { label: "Net Payout", value: formatContextMoney(order.net_payout) },
                  { label: "Tracking", value: order.tracking_number || "Unavailable" },
                  { label: "Carrier", value: order.carrier || "Unavailable" },
                  { label: "Shipment Status", value: order.shipment_status || order.label_status || "Unavailable" },
                  { label: "Shipping Service", value: order.shipping_service || "Unavailable", wide: true },
                ])}
              </div>
            `).join("")}
          </div>
        ` : `<div class="classification-empty matched-context-empty">No matched eBay order found.</div>`}
      </section>
    `;
  }

  function renderOrderLineContextCard(lines = []) {
    const rows = safeArray(lines);
    return `
      <section class="context-card">
        <div class="context-card-head">
          <h4>Matched Items / Order Lines</h4>
          ${renderBadge(`${rows.length} ${rows.length === 1 ? "line" : "lines"}`, rows.length ? "category" : "muted")}
        </div>
        ${rows.length ? `
          <div class="context-row-list">
            ${rows.map((line) => `
              <div class="context-row item-row">
                ${renderContextFactGrid([
                  { label: "Item", value: line.item_title || "Untitled item", wide: true },
                  { label: "Order", value: line.order_number || "Unavailable" },
                  { label: "Item Number", value: line.item_number || "Unavailable" },
                  { label: "Transaction ID", value: line.transaction_id || "Unavailable" },
                  { label: "SKU / Custom Label", value: line.custom_label || "Unavailable" },
                  { label: "Quantity", value: formatContextNumber(line.quantity) },
                  { label: "Sold For", value: formatContextMoney(line.sold_for) },
                  { label: "Total Price", value: formatContextMoney(line.total_price) },
                  { label: "Line Status", value: line.line_status || "Unknown" },
                ])}
              </div>
            `).join("")}
          </div>
        ` : `<div class="classification-empty matched-context-empty">No matched order line found.</div>`}
      </section>
    `;
  }

  function renderReturnContextCard(returns = []) {
    const rows = safeArray(returns);
    return `
      <section class="context-card">
        <div class="context-card-head">
          <h4>Returns</h4>
          ${renderBadge(`${rows.length} ${rows.length === 1 ? "return" : "returns"}`, rows.length ? "warning" : "muted")}
        </div>
        ${rows.length ? `
          <div class="context-row-list">
            ${rows.map((returnCase) => `
              <div class="context-row return-row">
                ${renderContextFactGrid([
                  { label: "Return ID", value: returnCase.ebay_return_id || "Unavailable" },
                  { label: "Order", value: returnCase.order_number || "Unavailable" },
                  { label: "Status", value: returnCase.status || "Unknown" },
                  { label: "Reason", value: returnCase.return_reason || "Unavailable", wide: true },
                  { label: "Opened", value: formatContextDate(returnCase.opened_at) },
                  { label: "Received", value: formatContextDate(returnCase.received_at) },
                  { label: "Closed", value: formatContextDate(returnCase.closed_at) },
                  { label: "Tracking", value: returnCase.return_tracking_number || "Unavailable" },
                ])}
                ${safeArray(returnCase.items).length ? `
                  <div class="return-item-list">
                    ${returnCase.items.map((item) => `
                      <span>${escapeHtml(safeText(item.item_title || item.item_number, "Return item"))} · expected ${escapeHtml(formatContextNumber(item.expected_quantity))} · received ${escapeHtml(formatContextNumber(item.received_quantity))}</span>
                    `).join("")}
                  </div>
                ` : ""}
              </div>
            `).join("")}
          </div>
        ` : `<div class="classification-empty matched-context-empty is-quiet">No related returns found.</div>`}
      </section>
    `;
  }

  function renderBuyerValueLinesCard(lines = []) {
    const rows = safeArray(lines);
    if (!rows.length) {
      return `
        <section class="context-card">
          <div class="context-card-head">
            <h4>Buyer History Snapshot</h4>
            ${renderBadge("No lines", "muted")}
          </div>
          <div class="classification-empty matched-context-empty is-quiet">No recent buyer value lines were returned.</div>
        </section>
      `;
    }

    return `
      <section class="context-card context-card-wide">
        <div class="context-card-head">
          <h4>Buyer History Snapshot</h4>
          ${renderBadge(`${rows.length} ${rows.length === 1 ? "line" : "lines"}`, "category")}
        </div>
        <div class="buyer-value-table-wrap">
          <table class="buyer-value-table">
            <thead>
              <tr>
                <th>Purchase</th>
                <th>Order</th>
                <th>Item</th>
                <th>State</th>
                <th>Gross</th>
                <th>Returned</th>
                <th>Retained</th>
                <th>Returns</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((line) => `
                <tr>
                  <td>${escapeHtml(formatContextDate(line.purchase_at))}</td>
                  <td>${escapeHtml(safeText(line.order_number))}</td>
                  <td>${escapeHtml(safeText(line.title))}</td>
                  <td>${escapeHtml(safeText(line.item_state))}</td>
                  <td>${escapeHtml(formatContextMoney(line.gross_value))}</td>
                  <td>${escapeHtml(formatContextMoney(line.returned_value))}</td>
                  <td>${escapeHtml(formatContextMoney(line.retained_value))}</td>
                  <td>${escapeHtml(formatContextNumber(line.return_count))} / ${escapeHtml(formatContextNumber(line.open_return_count))} open</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderStoredMatchedContextSection(state, selected) {
    const messageId = selected?.message_id || "";
    const detail = messageId ? state.messageDetailsById[messageId] : null;
    const isLoading = state.messageDetailLoadingId === messageId;
    const context = detail?.matched_context && typeof detail.matched_context === "object" ? detail.matched_context : null;

    if (!detail) {
      return renderCoreDisclosure(
        "Buyer / Order Context",
        renderBadge("Load detail", "muted"),
        `
          <p class="conversation-empty">Load the selected message detail to view stored eBay buyer, order, item, return, and history context.</p>
          <button type="button" class="secondary-btn classification-body-action" data-message-detail-action="load" data-message-id="${escapeHtml(messageId)}" ${isLoading || !messageId ? "disabled" : ""}>
            <i data-lucide="${isLoading ? "loader-circle" : "database"}"></i>
            ${escapeHtml(isLoading ? "Loading Context" : "Load Context")}
          </button>
        `,
        "stored-context-section",
      );
    }

    const safeContext = context || {};
    return renderCoreDisclosure(
      "Buyer / Order Context",
      renderBadge(context ? "Stored eBay context" : "Unavailable", context ? "category" : "muted"),
      `
        <div class="stored-context-grid">
          ${renderBuyerSummaryCard(safeContext)}
          ${renderOrderContextCard(safeContext.orders)}
          ${renderOrderLineContextCard(safeContext.order_lines)}
          ${renderReturnContextCard(safeContext.returns)}
          ${renderBuyerValueLinesCard(safeContext.buyer_value_line_breakdown)}
        </div>
        ${renderWarningPanel(detail.warnings, safeContext.warnings)}
      `,
      "stored-context-section",
    );
  }

  function matchStatusVariant(status) {
    const value = String(status || "").toLowerCase();
    if (value === "confirmed") return "success";
    if (value === "suggested") return "warning";
    if (value === "rejected") return "danger";
    if (value === "stale") return "muted";
    return "muted";
  }

  function renderMatchRow(match, selected, state) {
    const order = match.order || {};
    const returnCase = match.return_case || {};
    const shipping = match.shipping || {};
    const verified = match.verified_context || {};
    const status = String(match.status || "unknown").toLowerCase();
    const isActing = state.matchActionLinkId === match.link_id;
    const controls = status === "suggested"
      ? `
        <div class="matched-context-actions">
          <button type="button" class="secondary-btn" data-match-action="confirm_match" data-message-id="${escapeHtml(selected.message_id || "")}" data-link-id="${escapeHtml(match.link_id || "")}" ${isActing ? "disabled" : ""}>
            <i data-lucide="${isActing ? "loader-circle" : "check"}"></i>
            Confirm Match
          </button>
          <button type="button" class="secondary-btn" data-match-action="reject_match" data-message-id="${escapeHtml(selected.message_id || "")}" data-link-id="${escapeHtml(match.link_id || "")}" ${isActing ? "disabled" : ""}>
            <i data-lucide="${isActing ? "loader-circle" : "x"}"></i>
            Reject Match
          </button>
        </div>
      `
      : status === "confirmed"
        ? `
          <div class="matched-context-actions">
            <button type="button" class="secondary-btn" data-match-action="mark_match_stale" data-message-id="${escapeHtml(selected.message_id || "")}" data-link-id="${escapeHtml(match.link_id || "")}" ${isActing ? "disabled" : ""}>
              <i data-lucide="${isActing ? "loader-circle" : "clock"}"></i>
              Mark Stale
            </button>
          </div>
        `
        : "";

    return `
      <div class="matched-context-row">
        <div class="matched-context-topline">
          ${renderBadge(humanizeValue(status), matchStatusVariant(status))}
          ${renderBadge(formatConfidence(match.confidence), confidenceBadgeVariant({ confidence: match.confidence }))}
          <span>${escapeHtml(humanizeValue(match.match_method || "Unknown method"))}</span>
        </div>
        <dl class="matched-context-facts">
          <div><dt>Order</dt><dd>${escapeHtml(order.order_number || "Unavailable")}</dd></div>
          <div><dt>Buyer</dt><dd>${escapeHtml(order.buyer_username || returnCase.buyer_username || "Unknown")}</dd></div>
          <div><dt>Status</dt><dd>${escapeHtml(order.status || "Unknown")}</dd></div>
          <div><dt>Tracking</dt><dd>${escapeHtml(shipping.tracking_number || "Unavailable")}</dd></div>
          ${returnCase.ebay_return_id ? `<div><dt>Return</dt><dd>${escapeHtml(returnCase.ebay_return_id)}</dd></div>` : ""}
          ${shipping.shipping_service ? `<div><dt>Service</dt><dd>${escapeHtml(shipping.shipping_service)}</dd></div>` : ""}
          ${match.item_title ? `<div class="matched-context-wide"><dt>Item</dt><dd>${escapeHtml(match.item_title)}</dd></div>` : ""}
        </dl>
        ${match.evidence?.length ? `<div class="matched-context-evidence">${renderCompactList(match.evidence, "No evidence stored")}</div>` : ""}
        <div class="matched-context-indicators">
          ${renderBadge(verified.has_order ? "Verified order" : "Order unknown", verified.has_order ? "success" : "muted")}
          ${renderBadge(verified.has_shipping ? "Verified shipping" : "Shipping unknown", verified.has_shipping ? "success" : "muted")}
          ${renderBadge(verified.has_return_case ? "Return linked" : "No return case", verified.has_return_case ? "success" : "muted")}
        </div>
        ${controls}
      </div>
    `;
  }

  function renderMatchedContextSection(state, selected) {
    const messageId = selected?.message_id || "";
    const payload = messageId ? state.matchContextsByMessageId[messageId] : null;
    const isLoading = state.matchContextLoadingId === messageId;
    const error = messageId ? state.matchContextErrorsByMessageId[messageId] : null;
    const actionMessage = messageId ? state.matchActionMessagesByMessageId[messageId] : null;
    const matches = Array.isArray(payload?.matches) ? payload.matches : [];
    const validation = payload?.validation || {};
    const validationErrors = Array.isArray(validation.validation_errors) ? validation.validation_errors : [];
    const primaryValidationErrors = Array.isArray(validation.primary_validation_errors) ? validation.primary_validation_errors : [];
    const weakMatchTreatedAsUnverified = validation.weak_match_treated_as_unverified === true;
    const validationExplanations = Array.isArray(validation.primary_validation_error_explanations) && validation.primary_validation_error_explanations.length
      ? validation.primary_validation_error_explanations
      : Array.isArray(validation.validation_error_explanations) ? validation.validation_error_explanations : [];
    const safetyFlags = Array.isArray(validation.safety_flags) ? validation.safety_flags : [];
    const unknown = Array.isArray(payload?.unknown) ? payload.unknown : [];
    const doNotClaim = Array.isArray(payload?.do_not_claim) ? payload.do_not_claim : [];

    return `
      <details class="classification-detail-section matched-context-section detail-disclosure core-disclosure" open>
        <summary>
          <span>Deterministic Link Review</span>
          ${payload ? renderBadge(`${matches.length} ${matches.length === 1 ? "match" : "matches"}`, matches.length ? "category" : "muted") : ""}
          <i data-lucide="chevron-down"></i>
        </summary>
        ${error ? `<div class="classification-notice is-error">Could not load matched context: ${escapeHtml(error)}</div>` : ""}
        ${actionMessage ? `<div class="classification-notice is-success">${escapeHtml(actionMessage)}</div>` : ""}
        <div class="draft-actions matched-context-toolbar">
          <button type="button" class="secondary-btn" data-match-action="refresh" data-message-id="${escapeHtml(messageId)}" ${isLoading || !messageId ? "disabled" : ""}>
            <i data-lucide="${isLoading ? "loader-circle" : "refresh-cw"}"></i>
            ${escapeHtml(isLoading ? "Loading Context" : "Refresh Context")}
          </button>
        </div>
        ${isLoading && !payload ? `<div class="classification-empty matched-context-empty">Loading matched order context.</div>` : ""}
        ${payload && !matches.length ? `<div class="classification-empty matched-context-empty">No deterministic links exist for this email yet.</div>` : ""}
        ${matches.map((match) => renderMatchRow(match, selected, state)).join("")}
        ${validation.fallback_used === true ? `
          <div class="matched-context-block matched-context-fallback">
            <strong>Conservative safe draft available</strong>
            <p>${primaryValidationErrors.length ? "Original AI draft was blocked." : weakMatchTreatedAsUnverified ? "Weak match context was treated as unverified for buyer-facing content." : "Specific buyer-facing context was not verified."} The fallback remains editable and requires human review.</p>
            ${primaryValidationErrors.length ? `
              <span>Original draft blocked because:</span>
              ${renderCompactList(primaryValidationErrors, "No original validation failures")}
            ` : ""}
            ${renderValidationExplanations(validationExplanations)}
          </div>
        ` : ""}
        ${validationErrors.length ? `
          <div class="matched-context-block">
            <strong>Draft blocked by validation:</strong>
            ${renderCompactList(validationErrors, "No validation failures")}
            ${renderValidationExplanations(validationExplanations)}
          </div>
        ` : ""}
        ${safetyFlags.length ? `
          <div class="matched-context-block">
            <strong>Safety flags:</strong>
            ${renderCompactList(safetyFlags, "No safety flags")}
          </div>
        ` : ""}
        ${unknown.length ? `
          <div class="matched-context-block">
            <strong>Unknown:</strong>
            ${renderCompactList(unknown, "No unknown context")}
          </div>
        ` : ""}
        ${doNotClaim.length ? `
          <div class="matched-context-block">
            <strong>Do not claim:</strong>
            ${renderCompactList(doNotClaim, "No restrictions")}
          </div>
        ` : ""}
      </details>
    `;
  }

  function renderClassificationDetail(state, data) {
    if (!els.classificationDetail) return;

    const selected = selectedClassificationById(state.selectedClassificationId);
    const selectedOnPage = (data.classifications || []).some((classification) => classification.id === state.selectedClassificationId);
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
    const ageLabel = receivedAt ? formatCompactEmailAge(receivedAt) : "--";
    const reviewBadge = humanReview ? renderBadge("Human review", "warning") : renderBadge("No review flag", "muted");
    const confidenceBadge = renderBadge(formatConfidence(selected.confidence), confidenceBadgeVariant(selected));
    const validationBadge = renderBadge(humanizeValue(selected.validation_status || "Unknown"), statusBadgeVariant(selected.validation_status));
    const actionBadge = renderBadge(humanizeValue(selected.recommended_action || "Review only"), actionBadgeVariant(selected.recommended_action));
    const overrideBadge = selected.has_operator_override === true ? renderBadge("Operator Override", "warning") : renderBadge("AI Effective", "muted");
    const refundRiskBadge = renderBadge(selected.refund_risk === true ? "Refund Risk" : "No Refund Risk", selected.refund_risk === true ? "danger" : "muted");
    const chargebackRiskBadge = renderBadge(selected.chargeback_risk === true ? "Chargeback Risk" : "No Chargeback Risk", selected.chargeback_risk === true ? "critical" : "muted");
    const customerRiskBadge = renderBadge(`Customer Risk: ${humanizeValue(workflowCustomerRisk(selected))}`, priorityBadgeVariant({ priority_level: workflowCustomerRisk(selected) }));

    els.classificationDetail.innerHTML = `
      <div class="classification-detail-head">
        <span class="eyebrow">${humanReview ? "Human Review" : "Selected Email"}</span>
        <h3>${escapeHtml(getClassificationTitle(selected))}</h3>
        <div class="selected-email-meta">
          <span>${escapeHtml(getClassificationSender(selected))}</span>
          <span>${escapeHtml(receivedAt ? formatDateTime(receivedAt) : "Received unavailable")}</span>
          <span>${escapeHtml(ageLabel)}</span>
        </div>
        <div class="classification-head-meta">
          ${renderWorkflowMetaText(selected, "", { includeCategory: true })}
        </div>
      </div>

      ${renderStaleClassificationWarning(selected)}

      ${!selectedOnPage ? `
        <div class="classification-notice is-warning">
          Selected email is outside the current page or filter slice. Selection is preserved; change filters or refresh details deliberately.
        </div>
      ` : ""}

      <div class="detail-panel-actions" aria-label="Detail section controls">
        <button type="button" class="secondary-btn" data-detail-sections-action="expand">
          <i data-lucide="chevrons-down"></i>
          Expand All
        </button>
        <button type="button" class="secondary-btn" data-detail-sections-action="collapse">
          <i data-lucide="chevrons-up"></i>
          Collapse All
        </button>
      </div>

      ${renderCoreDisclosure(
        "AI Summary",
        actionBadge,
        `<p>${escapeHtml(selected.summary || "No AI summary available.")}</p>`,
        "ai-summary-section",
      )}

      ${renderConversationSection(state, selected)}

      ${renderStoredMatchedContextSection(state, selected)}

      ${renderResponseDraftSection(state, selected)}

      ${renderMatchedContextSection(state, selected)}

      ${renderEmailBodySection(state, selected)}

      ${renderAdvancedDisclosure(
        "AI Classification Details",
        confidenceBadge,
        `
          <div class="classification-pill-list">
            ${renderBadge(humanizeValue(selected.category || "Uncategorized"), "category")}
            ${confidenceBadge}
            ${validationBadge}
            ${actionBadge}
            ${renderBadge(selected.response_needed === true ? "Response needed" : "No response needed", selected.response_needed === true ? "warning" : "muted")}
          </div>
          <p>${escapeHtml(selected.reasoning_summary || "No reasoning summary available.")}</p>
        `,
      )}

      ${renderOperatorReviewSection(state, selected)}

      ${renderAdvancedDisclosure(
        "Workflow / Draft Metadata",
        overrideBadge,
        `
          <dl class="classification-detail-grid classification-workflow-grid">
            <div>
              <dt>Response Timing</dt>
              <dd>${renderBadge(timingBadgeLabel(selected), timingBadgeVariant(selected))}</dd>
            </div>
            <div>
              <dt>Customer Risk</dt>
              <dd>${customerRiskBadge}</dd>
            </div>
            <div>
              <dt>Classified</dt>
              <dd>${escapeHtml(formatDateTime(selected.created_at))}</dd>
            </div>
            <div>
              <dt>Message Reference</dt>
              <dd class="classification-mono">${escapeHtml(selected.message_id || "Unavailable")}</dd>
            </div>
            <div>
              <dt>Classification Run</dt>
              <dd class="classification-mono">${escapeHtml(selected.classification_run_id || "Unavailable")}</dd>
            </div>
            <div>
              <dt>Input Version</dt>
              <dd class="classification-mono">${escapeHtml(selected.input_version || "Unavailable")}</dd>
            </div>
          </dl>
        `,
      )}

      ${renderAdvancedDisclosure(
        "Safety / Validation Details",
        validationBadge,
        `
          <div class="classification-pill-list">
            ${reviewBadge}
            ${refundRiskBadge}
            ${chargebackRiskBadge}
            ${renderPillList(selected.safety_flags, "No safety flags")}
          </div>
          <p>${humanReview ? "Required or recommended based on review flags, safety flags, or confidence." : "No human-review signal returned."}</p>
        `,
      )}
    `;

    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function setAdminClassificationState(next) {
    const transition = next.loading
      ? TRANSITIONS.LOAD_STARTED
      : next.fetch_failed || next.unauthorized
        ? TRANSITIONS.LOAD_FAILED
        : next.status === "ready"
          ? TRANSITIONS.LOAD_SUCCEEDED
          : TRANSITIONS.SET_STATE;
    triageStore.dispatch({ type: transition, payload: next });
    adminClassificationState = triageStore.getState();
    renderAdminClassificationDebug(adminClassificationState);
  }

  function clearDraftActionStateForMessage(messageId) {
    if (!messageId) return {};
    return {
      draftActionErrorsByMessageId: {
        ...adminClassificationState.draftActionErrorsByMessageId,
        [messageId]: null,
      },
      draftActionMessagesByMessageId: {
        ...adminClassificationState.draftActionMessagesByMessageId,
        [messageId]: null,
      },
    };
  }

  function classificationAdminReadyStatus(data, emptyResults) {
    const counts = data.classification_counts || {};
    const loaded = Number(counts.loaded_current_valid ?? data.classifications?.length ?? 0);
    const total = Number(counts.total_current_valid ?? 0);
    const filtered = Number(counts.filtered_current_valid ?? total);
    if (!loaded && !total && emptyResults) {
      return "Fetch succeeded. No current valid classifications returned yet.";
    }
    if (filtered !== total && total > 0) {
      return `Showing ${loaded} visible rows from ${filtered} filtered classifications.`;
    }
    if (Number.isFinite(total) && total > 0) {
      return `Showing ${loaded} visible rows from ${total} current valid classifications.`;
    }
    return emptyResults ? "Fetch succeeded. No loaded current valid rows returned yet." : "Fetch succeeded. Browse loaded current valid rows below.";
  }

  function renderClassificationPageControls(state, data) {
    const page = pageInfoFromData(data);
    const prepareProgress = state.inboxPrepareResult?.progress || {};
    const preparedRows = Number(prepareProgress.processed_total || 0);
    if (els.classificationPageSummary) {
      const activeParts = [
        state.selectedCategory && state.selectedCategory !== "all" ? `category ${humanizeValue(state.selectedCategory.replace(/^category:/, ""))}` : "",
        state.priorityFilter && state.priorityFilter !== "all" ? `${humanizeValue(state.priorityFilter)} priority` : "",
        state.statusFilter && state.statusFilter !== "all" ? humanizeValue(state.statusFilter) : "",
        state.activeFilters?.length ? `${state.activeFilters.length} advanced filter${state.activeFilters.length === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      els.classificationPageSummary.innerHTML = `
        <div>
          <strong>Classifications</strong>
          <span>${escapeHtml(preparedRows)} prepared · ${escapeHtml(page.totalClassifiedRows)} classified · ${escapeHtml(page.filteredRows)} filtered · ${escapeHtml(page.visibleRows)} visible</span>
        </div>
        <div>
          <strong>Page</strong>
          <span>${escapeHtml(page.page)} of ${escapeHtml(page.totalPages)} · ${escapeHtml(page.pageSize)} per page${activeParts.length ? ` · ${escapeHtml(activeParts.join(" · "))}` : ""}</span>
        </div>
      `;
    }
    if (els.classificationPrevPage) els.classificationPrevPage.disabled = state.loading || !page.hasPreviousPage;
    if (els.classificationNextPage) els.classificationNextPage.disabled = state.loading || !page.hasNextPage;
    if (els.classificationPageIndicator) {
      els.classificationPageIndicator.textContent = `Page ${page.page} of ${page.totalPages}`;
    }
  }

  function renderAdminClassificationDebug(state) {
    if (!els.classificationAdminDebug) return;

    els.classificationAdminDebug.classList.remove("hidden");
    els.classificationAdminDebug.classList.toggle("is-error", state.fetch_failed || state.unauthorized);
    els.classificationAdminDebug.classList.toggle("is-empty", state.empty_results);
    if (els.refreshClassificationAdmin) {
      els.refreshClassificationAdmin.disabled = state.loading;
      els.refreshClassificationAdmin.setAttribute("aria-busy", state.loading ? "true" : "false");
      els.refreshClassificationAdmin.classList.toggle("is-loading", state.loading === true);
    }

    const data = state.data || normalizeAdminViewPayload({});
    const statusText = {
      idle: "Waiting for admin session.",
      loading: "Fetching admin_view payload.",
      ready: classificationAdminReadyStatus(data, state.empty_results),
      fetch_failed: `Fetch failed: ${state.error || "unknown_error"}`,
      unauthorized: "Unauthorized. Sign in again with an active admin account.",
    }[state.status] || "Waiting for admin session.";

    if (els.classificationAdminStatus) els.classificationAdminStatus.textContent = statusText;
    if (els.classificationSort && els.classificationSort.value !== state.sortMode) {
      els.classificationSort.value = state.sortMode;
    }
    if (els.classificationPageSize && Number(els.classificationPageSize.value) !== Number(state.pagination?.pageSize || 25)) {
      els.classificationPageSize.value = String(state.pagination?.pageSize || 25);
    }
    if (els.classificationPriorityFilter && els.classificationPriorityFilter.value !== (state.priorityFilter || "all")) {
      els.classificationPriorityFilter.value = state.priorityFilter || "all";
    }
    if (els.classificationStatusFilter && els.classificationStatusFilter.value !== (state.statusFilter || "all")) {
      els.classificationStatusFilter.value = state.statusFilter || "all";
    }
    if (els.classificationCategorySort && els.classificationCategorySort.value !== state.categorySortMode) {
      els.classificationCategorySort.value = state.categorySortMode;
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
    if (els.classificationInboxShell) {
      els.classificationInboxShell.classList.toggle("is-category-collapsed", state.categoryPanelCollapsed === true);
      els.classificationInboxShell.classList.toggle("is-detail-collapsed", state.detailPanelCollapsed === true);
    }
    if (els.toggleCategoryPanel) {
      const collapsed = state.categoryPanelCollapsed === true;
      els.toggleCategoryPanel.setAttribute("aria-pressed", collapsed ? "true" : "false");
      els.toggleCategoryPanel.innerHTML = `<i data-lucide="${collapsed ? "panel-left-open" : "panel-left-close"}"></i> Categories`;
    }
    if (els.toggleDetailPanel) {
      const collapsed = state.detailPanelCollapsed === true;
      els.toggleDetailPanel.setAttribute("aria-pressed", collapsed ? "true" : "false");
      els.toggleDetailPanel.innerHTML = `<i data-lucide="${collapsed ? "panel-right-open" : "panel-right-close"}"></i> Details`;
    }

    if (els.classificationAdminSummary) {
      els.classificationAdminSummary.innerHTML = renderAdminSummary(data);
    }

    renderCategorySidebar(state, data);
    renderClassificationPageControls(state, data);
    renderClassificationList(state, data);
    renderClassificationDetail(state, data);
  }

  function renderOperationalDashboardPanel(state = triageStore.getState()) {
    if (!els.operationalDashboard) return;
    const collapsed = state.operationalDashboardCollapsed === true;
    if (els.operationalDashboardSection) {
      els.operationalDashboardSection.classList.toggle("is-collapsed", collapsed);
    }
    if (els.operationalDashboardBody) {
      els.operationalDashboardBody.hidden = collapsed;
    }
    if (els.operationalDashboardToggle) {
      els.operationalDashboardToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      els.operationalDashboardToggle.innerHTML = `<i data-lucide="${collapsed ? "chevron-down" : "chevron-up"}"></i> ${collapsed ? "Show Dashboard" : "Hide Dashboard"}`;
    }
    if (els.operationalDashboardRefresh) {
      els.operationalDashboardRefresh.disabled = state.operationalDashboardLoading === true;
      els.operationalDashboardRefresh.setAttribute("aria-busy", state.operationalDashboardLoading ? "true" : "false");
      els.operationalDashboardRefresh.classList.toggle("is-loading", state.operationalDashboardLoading === true);
    }
    if (els.operationalDashboardStatus) {
      if (state.operationalDashboardLoading) {
        els.operationalDashboardStatus.textContent = "Refreshing operational dashboard.";
      } else if (state.operationalDashboardError) {
        els.operationalDashboardStatus.textContent = `Dashboard refresh failed: ${state.operationalDashboardError}`;
      } else if (state.operationalDashboardUpdatedAt) {
        els.operationalDashboardStatus.textContent = `Operational dashboard refreshed ${formatDateTime(state.operationalDashboardUpdatedAt)}.`;
      } else {
        els.operationalDashboardStatus.textContent = "Manual refresh only. No autonomous polling is active.";
      }
    }
    els.operationalDashboard.innerHTML = renderOperationalDashboard(state);
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function setOperationalDashboardState(next) {
    triageStore.dispatch({ type: TRANSITIONS.SET_STATE, payload: next });
    renderOperationalDashboardPanel(triageStore.getState());
  }

  async function loadOperationalDashboard(context, options = {}) {
    if (!els.operationalDashboard) return;
    const previous = triageStore.getState();
    setOperationalDashboardState({
      operationalDashboardLoading: true,
      operationalDashboardError: null,
      operationalDashboardSnapshot: options.keepPrevious === false ? null : previous.operationalDashboardSnapshot,
    });

    try {
      const snapshot = await fetchOperationalDashboard(context);
      setOperationalDashboardState({
        operationalDashboardLoading: false,
        operationalDashboardError: snapshot.ok === false ? "diagnostics_partial_failure" : null,
        operationalDashboardSnapshot: snapshot,
        operationalDashboardUpdatedAt: new Date().toISOString(),
      });
      return snapshot;
    } catch (error) {
      setOperationalDashboardState({
        operationalDashboardLoading: false,
        operationalDashboardError: error.code || error.message || "operational_dashboard_failed",
      });
      console.error("[email-triage] operational dashboard fetch failed:", error);
      return null;
    }
  }

  function ebayConversationTime(conversation) {
    return conversation?.latest_message_created_at ||
      conversation?.last_message_created_at ||
      conversation?.updated_at ||
      conversation?.created_at ||
      null;
  }

  function compactConversationText(value, fallback = "") {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text || fallback;
  }

  function normalizeEbaySearchText(value) {
    return compactConversationText(value)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function ebayBuyerIdentity(conversation) {
    const identity = conversation?.buyer_identity && typeof conversation.buyer_identity === "object"
      ? conversation.buyer_identity
      : {};
    const displayName = compactConversationText(
      identity.display_name || identity.username,
      conversation?.conversation_type === "FROM_EBAY" ? "eBay" : "Unknown buyer",
    );
    return {
      username: compactConversationText(identity.username, displayName === "Unknown buyer" ? "" : displayName),
      displayName,
      source: compactConversationText(identity.source, displayName === "Unknown buyer" ? "none" : "other_party"),
      confidence: compactConversationText(identity.confidence, "derived"),
      name: compactConversationText(identity.name),
      email: compactConversationText(identity.email),
    };
  }

  function ebayIdentitySourceLabel(source) {
    const labels = {
      order: "Order buyer",
      order_line: "Order-line buyer",
      return_case: "Return buyer",
      conversation_link: "Linked buyer",
      other_party: "eBay contact",
      message_inbound_sender: "Inbound sender",
      message_outbound_recipient: "Outbound recipient",
      message_participant: "Message participant",
      platform: "From eBay",
      none: "Unknown buyer",
    };
    return labels[source] || humanizeValue(source || "Derived buyer");
  }

  function ebayConversationInitials(conversation) {
    const label = ebayBuyerIdentity(conversation).displayName;
    if (label === "Unknown buyer") return "?";
    const clean = label.replace(/[^a-z0-9]+/gi, " ").trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    return clean.slice(0, 2).toUpperCase() || "?";
  }

  function ebayConversationTitle(conversation) {
    const summary = ebayConversationSummary(conversation);
    return safeText(
      summary.item_titles[0] ||
        conversation?.conversation_title ||
        (summary.listing_ids[0] ? `Listing ${summary.listing_ids[0]}` : "") ||
        conversation?.ebay_conversation_id,
      "Untitled conversation",
    );
  }

  function ebayConversationParty(conversation) {
    return ebayBuyerIdentity(conversation).displayName;
  }

  function ebayConversationSnippet(conversation) {
    return compactConversationText(
      conversation?.latest_message_preview || ebayConversationSummary(conversation).latest_message_preview,
      "No latest message preview stored.",
    );
  }

  function ebayConversationRowSummary(conversation) {
    const classification = ebayConversationClassification(conversation);
    return compactConversationText(classification?.effective_summary, ebayConversationSnippet(conversation));
  }

  function ebayConversationLatestSnippetLine(conversation) {
    const snippet = ebayConversationSnippet(conversation);
    const summary = ebayConversationRowSummary(conversation);
    return normalizeEbaySearchText(snippet) === normalizeEbaySearchText(summary) ? "" : snippet;
  }

  function ebayNotificationListText(value) {
    return compactConversationText(
      String(value || "")
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/\b(view|respond|learn more|details)\b\s*(?:\||$)/gi, " ")
        .replace(/\s+/g, " "),
      "",
    );
  }

  function ebayNotificationKindFromConversation(conversation) {
    const classification = ebayConversationClassification(conversation);
    const textValue = [
      conversation?.conversation_title,
      conversation?.latest_message_preview,
      classification?.effective_summary,
      classification?.effective_topic_tags,
    ].flat().filter(Boolean).join(" ");
    return EBAY_NOTIFICATION_KIND_RULES.find((rule) => rule.pattern.test(textValue)) || {
      label: "eBay Notification",
      icon: "bell",
    };
  }

  function ebayNotificationPreviewLabel(conversation) {
    const kind = ebayNotificationKindFromConversation(conversation);
    if (kind?.label) return kind.label;
    const classification = ebayConversationClassification(conversation);
    const blob = normalizeEbaySearchText([
      conversation?.conversation_title,
      conversation?.latest_message_preview,
      classification?.effective_summary,
      classification?.effective_topic_tags,
    ].flat().filter(Boolean).join(" "));
    if (/\bcancel|cancellation\b/.test(blob)) return "Cancellation summary";
    if (/\brefund|reimburs|credit\b/.test(blob)) return "Refund summary";
    if (/\bcase|request_closed|customer_service\b/.test(blob)) return "Case summary";
    if (/\breturn|returned\b/.test(blob)) return "Return summary";
    return "Notification summary";
  }

  function ebayConversationPreviewLines(conversation) {
    const classification = ebayConversationClassification(conversation);
    const snippet = ebayConversationSnippet(conversation);
    const aiSummary = compactConversationText(classification?.effective_summary);
    const isPlatform = ebayConversationIsPlatform(conversation);
    if (isPlatform) {
      const notificationText = ebayNotificationListText(snippet || conversation?.conversation_title);
      const notificationTitle = ebayNotificationPreviewLabel(conversation);
      return {
        previewLabel: "Notice",
        preview: notificationTitle,
        summaryLabel: "Summary",
        summary: aiSummary || notificationText || "No notification summary stored.",
      };
    }
    return {
      previewLabel: "Preview",
      preview: compactConversationText(snippet, "No latest message preview stored."),
      summaryLabel: "AI",
      summary: aiSummary || "No AI summary stored.",
    };
  }

  function ebayConversationSearchBlob(conversation) {
    const summary = ebayConversationSummary(conversation);
    const classification = ebayConversationClassification(conversation);
    return normalizeEbaySearchText([
      summary.search_text,
      conversation?.ebay_conversation_id,
      conversation?.conversation_title,
      conversation?.other_party_username,
      conversation?.reference_id,
      conversation?.reference_type,
      conversation?.latest_message_preview,
      ebayConversationParty(conversation),
      summary.buyer_usernames,
      summary.participant_usernames,
      summary.order_numbers,
      summary.return_ids,
      summary.item_titles,
      summary.item_numbers,
      summary.listing_ids,
      ebayConversationSource(conversation),
      classification?.effective_summary,
    ].flat().filter(Boolean).join("\n"));
  }

  function normalizeEbayStructuredTokenValue(value) {
    return normalizeEbaySearchText(value)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function ebayClassificationTagValues(classification) {
    if (!classification) return [];
    return [
      classification.effective_conversation_source,
      classification.effective_priority,
      classification.effective_response_need,
      classification.effective_topic_tags,
      classification.effective_buyer_flags,
      classification.effective_risk_flags,
    ].flat().map((item) => compactConversationText(item)).filter(Boolean);
  }

  function parseEbayStructuredSearch(query) {
    const parsed = {
      terms: [],
      structured: {
        tags: [],
        sourceTypes: [],
        topics: [],
        buyerFlags: [],
        riskFlags: [],
        priorities: [],
        responseNeeds: [],
      },
      structuredTokens: [],
    };
    const text = String(query || "");
    const tokenPattern = /([a-z]+):"([^"]+)"|([a-z]+):([^\s]+)|"([^"]+)"|(\S+)/gi;
    let match;
    while ((match = tokenPattern.exec(text)) !== null) {
      const key = normalizeEbaySearchText(match[1] || match[3] || "");
      const rawStructuredValue = match[2] || match[4] || "";
      const quotedText = match[5] || "";
      const plainText = match[6] || "";

      if (key && rawStructuredValue) {
        const value = normalizeEbayStructuredTokenValue(rawStructuredValue);
        if (!value) continue;
        const token = `${key}:${value}`;
        if (key === "tag") parsed.structured.tags.push(value);
        else if (key === "source") parsed.structured.sourceTypes.push(value);
        else if (key === "topic") parsed.structured.topics.push(value);
        else if (key === "buyer") parsed.structured.buyerFlags.push(value);
        else if (key === "risk") parsed.structured.riskFlags.push(value);
        else if (key === "priority") parsed.structured.priorities.push(value);
        else if (key === "response") parsed.structured.responseNeeds.push(value);
        else {
          parsed.terms.push(normalizeEbaySearchText(`${key}:${rawStructuredValue}`));
          continue;
        }
        parsed.structuredTokens.push(token);
        continue;
      }

      const term = normalizeEbaySearchText(quotedText || plainText);
      if (term) parsed.terms.push(term);
    }

    Object.keys(parsed.structured).forEach((key) => {
      parsed.structured[key] = parsed.structured[key].filter((value, index, rows) => value && rows.indexOf(value) === index);
    });
    parsed.terms = parsed.terms.join(" ").split(/\s+/).filter(Boolean);
    return parsed;
  }

  function ebayConversationMatchesStructuredSearch(conversation, structured = {}) {
    const classification = ebayConversationClassification(conversation);
    const tags = ebayClassificationTagValues(classification);
    const tagSet = new Set(tags);
    const hasAll = (values, allowed) => safeArray(values).every((value) => allowed.includes(value));
    const needsStoredClassification = [
      structured.tags,
      structured.topics,
      structured.buyerFlags,
      structured.riskFlags,
      structured.priorities,
      structured.responseNeeds,
    ].some((values) => safeArray(values).length);
    if (!classification && needsStoredClassification) return false;
    return hasAll(structured.tags, tags)
      && hasAll(structured.sourceTypes, [ebayConversationSource(conversation)])
      && hasAll(structured.topics, classification?.effective_topic_tags || [])
      && hasAll(structured.buyerFlags, classification?.effective_buyer_flags || [])
      && hasAll(structured.riskFlags, classification?.effective_risk_flags || [])
      && safeArray(structured.priorities).every((value) => tagSet.has(value))
      && safeArray(structured.responseNeeds).every((value) => tagSet.has(value));
  }

  function ebayConversationSummary(conversation) {
    const summary = conversation?.summary && typeof conversation.summary === "object" ? conversation.summary : {};
    return {
      link_count: Number(summary.link_count || 0),
      confirmed_link_count: Number(summary.confirmed_link_count || 0),
      suggested_link_count: Number(summary.suggested_link_count || 0),
      has_order_link: summary.has_order_link === true,
      has_return_link: summary.has_return_link === true,
      has_inventory_link: summary.has_inventory_link === true,
      has_listing_reference: summary.has_listing_reference === true,
      has_buyer_link: summary.has_buyer_link === true,
      has_media: summary.has_media === true,
      media_count: Number(summary.media_count || 0),
      needs_context_review: summary.needs_context_review === true,
      warnings: safeArray(summary.warnings),
      seller_username: compactConversationText(summary.seller_username),
      buyer_usernames: safeArray(summary.buyer_usernames).map((item) => compactConversationText(item)).filter(Boolean),
      participant_usernames: safeArray(summary.participant_usernames).map((item) => compactConversationText(item)).filter(Boolean),
      order_numbers: safeArray(summary.order_numbers).map((item) => compactConversationText(item)).filter(Boolean),
      return_ids: safeArray(summary.return_ids).map((item) => compactConversationText(item)).filter(Boolean),
      item_titles: safeArray(summary.item_titles).map((item) => compactConversationText(item)).filter(Boolean),
      item_numbers: safeArray(summary.item_numbers).map((item) => compactConversationText(item)).filter(Boolean),
      listing_ids: safeArray(summary.listing_ids).map((item) => compactConversationText(item)).filter(Boolean),
      latest_message_preview: compactConversationText(summary.latest_message_preview),
      search_text: String(summary.search_text || ""),
    };
  }

  function ebayConversationDefaultClassificationFilters() {
    return {
      sourceTypes: [],
      topics: [],
      buyerFlags: [],
      riskFlags: [],
      priorities: [],
      responseNeeds: [],
    };
  }

  function safeEbayClassificationFilters(filters = {}) {
    const source = filters && typeof filters === "object" ? filters : {};
    const normalize = (key, allowed) => {
      const allowedSet = new Set(allowed);
      return safeArray(source[key])
        .map((item) => compactConversationText(item))
        .filter((item, index, rows) => item && allowedSet.has(item) && rows.indexOf(item) === index);
    };
    return {
      sourceTypes: normalize("sourceTypes", EBAY_CONVERSATION_SOURCE_TYPES),
      topics: normalize("topics", EBAY_TOPIC_TAGS),
      buyerFlags: normalize("buyerFlags", EBAY_BUYER_FLAGS),
      riskFlags: normalize("riskFlags", EBAY_RISK_FLAGS),
      priorities: normalize("priorities", EBAY_PRIORITIES),
      responseNeeds: normalize("responseNeeds", EBAY_RESPONSE_NEEDS),
    };
  }

  function ebaySavedViewFilterPayload(payload = {}) {
    const source = payload && typeof payload === "object" ? payload : {};
    return {
      version: 1,
      system_filter: compactConversationText(source.system_filter, "all"),
      search_query: compactConversationText(source.search_query),
      classification_filters: safeEbayClassificationFilters(source.classification_filters),
    };
  }

  function ebayCurrentSavedViewPayload(state = adminClassificationState) {
    return ebaySavedViewFilterPayload({
      system_filter: state.ebayConversationFilter || "all",
      search_query: state.ebayConversationSearchQuery || "",
      classification_filters: state.ebayConversationClassificationFilters || ebayConversationDefaultClassificationFilters(),
    });
  }

  function ebaySavedViewSystemRuleRows(systemFilter = "all") {
    const rules = {
      all: [{ label: "Scope", value: "All conversations" }],
      members: [{ label: "Source", value: "Member Message" }],
      ebay_notifications: [{ label: "Source", value: "Platform Notification" }],
      unread: [{ label: "Unread State", value: "Unread" }],
      unclassified: [{ label: "Classification", value: "No current classification" }],
      returns: [{ label: "Topic", value: "Return" }],
      shipping_issues: [{ label: "Topic", value: "Shipping Issue, Missing Item, Order Status, or Delivery Timing" }],
      needs_reply_today: [{ label: "Response Status", value: "Reply Today" }],
      vip_buyers: [{ label: "Buyer Flag", value: "VIP Buyer" }],
      high_value_buyers: [{ label: "Buyer Flag", value: "High Value Buyer or High Retained Value Buyer" }],
      refund_risk: [{ label: "Risk Flag", value: "Refund Risk, Chargeback Risk, or Unsupported Claim Risk" }],
      review_queue: [{ label: "Review", value: "Unclassified, stale, needs review, or low confidence" }],
      has_order: [{ label: "System Label", value: "Has Order" }],
      has_return: [{ label: "System Label", value: "Has Return" }],
      has_media: [{ label: "System Label", value: "Has Media" }],
      needs_context_review: [{ label: "System Label", value: "Needs Review" }],
    };
    return rules[systemFilter] || rules.all;
  }

  function ebaySavedViewRuleRows(view = {}) {
    const payload = ebaySavedViewFilterPayload(view.filter_payload);
    const rows = [];
    const seen = new Set();
    const pushRule = (label, value) => {
      const cleanLabel = compactConversationText(label);
      const cleanValue = compactConversationText(value);
      const key = `${cleanLabel}:${cleanValue}`.toLowerCase();
      if (!cleanLabel || !cleanValue || seen.has(key)) return;
      seen.add(key);
      rows.push({ label: cleanLabel, value: cleanValue });
    };
    const systemFilter = view.system_key || payload.system_filter || "all";
    if (systemFilter && systemFilter !== "all") {
      ebaySavedViewSystemRuleRows(systemFilter).forEach((rule) => pushRule(rule.label, rule.value));
    }
    const filters = payload.classification_filters;
    const addFilterRows = (label, values = []) => {
      values.forEach((value) => pushRule(label, humanizeValue(value)));
    };
    addFilterRows("Source", filters.sourceTypes);
    addFilterRows("Topic", filters.topics);
    addFilterRows("Buyer Flag", filters.buyerFlags);
    addFilterRows("Risk Flag", filters.riskFlags);
    addFilterRows("Priority", filters.priorities);
    addFilterRows("Response Status", filters.responseNeeds);
    if (payload.search_query) pushRule("Search", payload.search_query);
    if (!rows.length) ebaySavedViewSystemRuleRows("all").forEach((rule) => pushRule(rule.label, rule.value));
    return rows;
  }

  function ebaySavedViewRuleSummary(view = {}) {
    return ebaySavedViewRuleRows(view)
      .map((rule) => `${rule.label}: ${rule.value}`)
      .join(" · ");
  }

  function defaultEbayConversationSavedViews() {
    const rows = [
      ["all", "All", 10],
      ["members", "Members", 15],
      ["ebay_notifications", "eBay Notifications", 16],
      ["unread", "Unread", 20],
      ["unclassified", "Unclassified", 21],
      ["returns", "Returns", 30],
      ["shipping_issues", "Shipping", 40],
      ["needs_reply_today", "Reply today", 50],
      ["vip_buyers", "VIP buyers", 60],
      ["high_value_buyers", "High value", 70],
      ["refund_risk", "Refund risk", 80],
      ["review_queue", "Review queue", 90],
      ["has_order", "Has order", 100],
      ["has_return", "Has return", 110],
      ["has_media", "Has media", 120],
      ["needs_context_review", "Needs review", 130],
    ];
    return rows.map(([systemKey, name, sortOrder]) => ({
      id: systemKey,
      name,
      description: "",
      filter_payload: ebaySavedViewFilterPayload({ system_filter: systemKey }),
      system_key: systemKey,
      is_system_default: true,
      is_active: true,
      sort_order: sortOrder,
    }));
  }

  function ebaySavedViewsForState(state = adminClassificationState) {
    const rows = safeArray(state.ebayConversationSavedViews);
    return rows.length ? rows : defaultEbayConversationSavedViews();
  }

  function countEbayClassificationFilters(filters = {}) {
    const normalized = safeEbayClassificationFilters(filters);
    return Object.values(normalized).reduce((count, values) => count + values.length, 0);
  }

  function ebayClassificationHasAny(values = [], selected = []) {
    if (!selected.length) return true;
    const valueSet = new Set(safeArray(values).map((item) => compactConversationText(item)).filter(Boolean));
    return selected.some((item) => valueSet.has(item));
  }

  function ebayClassificationHasAll(values = [], selected = []) {
    if (!selected.length) return true;
    const valueSet = new Set(safeArray(values).map((item) => compactConversationText(item)).filter(Boolean));
    return selected.every((item) => valueSet.has(item));
  }

  function ebayClassificationMatchesFilters(conversation, filters = {}) {
    const selected = safeEbayClassificationFilters(filters);
    if (!countEbayClassificationFilters(selected)) return true;
    const classification = ebayConversationClassification(conversation);
    if (!classification && selected.topics.length + selected.buyerFlags.length + selected.riskFlags.length + selected.priorities.length + selected.responseNeeds.length) return false;
    return ebayClassificationHasAll([ebayConversationSource(conversation)], selected.sourceTypes)
      && ebayClassificationHasAll(classification?.effective_topic_tags || [], selected.topics)
      && ebayClassificationHasAll(classification?.effective_buyer_flags || [], selected.buyerFlags)
      && ebayClassificationHasAll(classification?.effective_risk_flags || [], selected.riskFlags)
      && ebayClassificationHasAll(classification?.effective_priority ? [classification.effective_priority] : [], selected.priorities)
      && ebayClassificationHasAll(classification?.effective_response_need ? [classification.effective_response_need] : [], selected.responseNeeds);
  }

  function ebayConversationHasTopic(conversation, values = []) {
    const classification = ebayConversationClassification(conversation);
    return ebayClassificationHasAny(classification?.effective_topic_tags || [], values);
  }

  function ebayConversationHasBuyerFlag(conversation, values = []) {
    const classification = ebayConversationClassification(conversation);
    return ebayClassificationHasAny(classification?.effective_buyer_flags || [], values);
  }

  function ebayConversationHasRiskFlag(conversation, values = []) {
    const classification = ebayConversationClassification(conversation);
    return ebayClassificationHasAny(classification?.effective_risk_flags || [], values);
  }

  function ebaySavedViewMatches(conversation, filter = "all") {
    const summary = ebayConversationSummary(conversation);
    const classification = ebayConversationClassification(conversation);
    if (filter === "members") return ebayConversationSource(conversation) === "member_message";
    if (filter === "ebay_notifications") return ebayConversationSource(conversation) === "platform_notification";
    if (filter === "unread") return Number(conversation.unread_count || 0) > 0;
    if (filter === "unclassified") return !classification;
    if (filter === "returns") return ebayConversationHasTopic(conversation, ["return"]);
    if (filter === "shipping_issues") return ebayConversationHasTopic(conversation, ["shipping_issue", "missing_item", "order_status", "delivery_timing"]);
    if (filter === "needs_reply_today") return classification?.effective_response_need === "reply_today";
    if (filter === "vip_buyers") return ebayConversationHasBuyerFlag(conversation, ["vip_buyer"]);
    if (filter === "high_value_buyers") return ebayConversationHasBuyerFlag(conversation, ["high_value_buyer", "high_retained_value_buyer"]);
    if (filter === "refund_risk") return ebayConversationHasRiskFlag(conversation, ["refund_risk", "chargeback_risk", "unsupported_claim_risk"]);
    if (filter === "review_queue") {
      return !classification ||
        summary.needs_context_review ||
        ebayClassificationIsStale(conversation, classification) ||
        ebayConversationHasRiskFlag(conversation, ["context_review_needed", "low_confidence"]);
    }
    if (filter === "has_order") return summary.has_order_link;
    if (filter === "has_return") return summary.has_return_link;
    if (filter === "has_media") return summary.has_media;
    if (filter === "needs_context_review") return summary.needs_context_review;
    return true;
  }

  function ebayMailboxUsesServerFilters(state = adminClassificationState) {
    return state.ebayMailboxMode === "rpc";
  }

  function ebayMailboxPageInfo(state = adminClassificationState) {
    const page = state.ebayMailboxPagination && typeof state.ebayMailboxPagination === "object"
      ? state.ebayMailboxPagination
      : {};
    return {
      canonical_total: Number.isFinite(Number(page.canonical_total)) ? Number(page.canonical_total) : null,
      matching_total: Number.isFinite(Number(page.matching_total)) ? Number(page.matching_total) : null,
      loaded_count: Number.isFinite(Number(page.loaded_count)) ? Number(page.loaded_count) : safeArray(state.ebayConversations).length,
      page_size: Number(page.page_size || 100) || 100,
      offset: Number(page.offset || 0) || 0,
      next_offset: page.next_offset === null || page.next_offset === undefined ? null : Number(page.next_offset),
      has_more: page.has_more === true,
      rpc_version: page.rpc_version || null,
    };
  }

  function ebayMailboxCountValue(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function ebayMailboxSmartCounts(state = adminClassificationState) {
    return state.ebayMailboxSmartFolderCounts && typeof state.ebayMailboxSmartFolderCounts === "object"
      ? state.ebayMailboxSmartFolderCounts
      : {};
  }

  function ebayMailboxOptionCounts(state = adminClassificationState) {
    return state.ebayMailboxFilterOptionCounts && typeof state.ebayMailboxFilterOptionCounts === "object"
      ? state.ebayMailboxFilterOptionCounts
      : {};
  }

  const EBAY_CANONICAL_SMART_FOLDER_COUNT_KEYS = Object.freeze({
    all: "all",
    members: "members",
    ebay_notifications: "ebay_notifications",
    unread: "unread",
    unclassified: "unclassified",
    returns: "returns",
    shipping: "shipping",
    shipping_issues: "shipping",
    needs_reply_today: "needs_reply_today",
    vip_buyers: "vip_buyers",
    high_value_buyers: "high_value_buyers",
    refund_risk: "refund_risk",
    review_queue: "review_queue",
    has_order: "has_order",
    has_return: "has_return",
    has_media: "has_media",
    needs_context_review: "needs_context_review",
  });

  function ebayCanonicalSmartFolderCountKey(systemFilter = "all") {
    const key = compactConversationText(systemFilter, "all");
    return EBAY_CANONICAL_SMART_FOLDER_COUNT_KEYS[key] || "";
  }

  function ebayMailboxFetchValuesFromState(state = adminClassificationState, options = {}) {
    const search = parseEbayStructuredSearch(state.ebayConversationSearchQuery || "");
    return {
      limit: Math.min(Math.max(Number(options.limit || ebayMailboxPageInfo(state).page_size || 100), 1), 100),
      offset: Math.max(Number(options.offset || 0) || 0, 0),
      systemFilter: state.ebayConversationFilter || "all",
      searchTerms: search.terms,
      structuredFilters: search.structured,
      classificationFilters: safeEbayClassificationFilters(state.ebayConversationClassificationFilters),
    };
  }

  function mergeEbayConversationPages(existing = [], incoming = []) {
    const byId = new Map();
    safeArray(existing).forEach((conversation) => {
      if (conversation?.id) byId.set(conversation.id, conversation);
    });
    safeArray(incoming).forEach((conversation) => {
      if (conversation?.id) byId.set(conversation.id, conversation);
    });
    return [...byId.values()];
  }

  function ebayMailboxStateFromPayload(payload = {}, conversations = []) {
    return {
      ebayMailboxMode: payload.mailbox_mode || "rpc",
      ebayMailboxWarning: payload.warning || null,
      ebayMailboxPagination: {
        canonical_total: Number.isFinite(Number(payload.canonical_total)) ? Number(payload.canonical_total) : null,
        matching_total: Number.isFinite(Number(payload.matching_total)) ? Number(payload.matching_total) : null,
        loaded_count: safeArray(conversations).length,
        page_size: Number(payload.page_size || 100) || 100,
        offset: Number(payload.offset || 0) || 0,
        next_offset: payload.next_offset === null || payload.next_offset === undefined ? null : Number(payload.next_offset),
        has_more: payload.has_more === true,
        rpc_version: payload.rpc_version || null,
      },
      ebayMailboxSmartFolderCounts: payload.smart_folder_counts && typeof payload.smart_folder_counts === "object"
        ? payload.smart_folder_counts
        : {},
      ebayMailboxFilterOptionCounts: payload.filter_option_counts && typeof payload.filter_option_counts === "object"
        ? payload.filter_option_counts
        : {},
    };
  }

  function filteredEbayConversations(state) {
    if (ebayMailboxUsesServerFilters(state)) return safeArray(state.ebayConversations);
    const filter = state.ebayConversationFilter || "all";
    const search = parseEbayStructuredSearch(state.ebayConversationSearchQuery || "");
    return safeArray(state.ebayConversations).filter((conversation) => {
      if (!ebaySavedViewMatches(conversation, filter)) return false;
      if (!ebayClassificationMatchesFilters(conversation, state.ebayConversationClassificationFilters)) return false;
      if (!ebayConversationMatchesStructuredSearch(conversation, search.structured)) return false;
      if (!search.terms.length) return true;
      const searchBlob = ebayConversationSearchBlob(conversation);
      return search.terms.every((term) => searchBlob.includes(term));
    });
  }

  function selectedEbayConversationById(conversationId, state = adminClassificationState) {
    if (!conversationId) return null;
    return safeArray(state.ebayConversations).find((conversation) => conversation.id === conversationId) || null;
  }

  function ebayMessagesMarkedRead(messages = []) {
    return safeArray(messages).map((message) => ({
      ...message,
      read_status: "Read",
      is_read: true,
    }));
  }

  function normalizeEbayMessagesForReadState(conversationId, messages = [], state = adminClassificationState) {
    const conversation = selectedEbayConversationById(conversationId, state);
    if (Number(conversation?.unread_count || 0) > 0) return safeArray(messages);
    return ebayMessagesMarkedRead(messages);
  }

  function ebayConversationStateMarkedRead(conversationId, state = adminClassificationState) {
    if (!conversationId) return {};
    const conversations = safeArray(state.ebayConversations);
    const nextConversations = conversations.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      return {
        ...conversation,
        unread_count: 0,
        raw: conversation.raw && typeof conversation.raw === "object"
          ? { ...conversation.raw, unread_count: 0 }
          : conversation.raw,
      };
    });
    const existingMessages = state.ebayConversationMessagesById?.[conversationId];
    return {
      ebayConversations: nextConversations,
      ebayConversationMessagesById: existingMessages
        ? {
          ...state.ebayConversationMessagesById,
          [conversationId]: ebayMessagesMarkedRead(existingMessages),
        }
        : state.ebayConversationMessagesById,
    };
  }

  function contextFromEbayPayload(payload) {
    return payload?.context && typeof payload.context === "object"
      ? payload.context
      : payload?.data?.context && typeof payload.data.context === "object" ? payload.data.context : null;
  }

  function setEbayConversationState(next) {
    triageStore.dispatch({ type: TRANSITIONS.SET_STATE, payload: next });
    adminClassificationState = triageStore.getState();
    renderEbayConversationInbox(adminClassificationState);
  }

  function ebayConversationClassification(conversation) {
    const row = conversation?.classification && typeof conversation.classification === "object" ? conversation.classification : null;
    if (!row?.id) return null;
    const override = row.operator_override_payload && typeof row.operator_override_payload === "object" ? row.operator_override_payload : {};
    const topicTags = safeArray(override.topic_tags || row.effective_topic_tags || row.topic_tags).map((item) => compactConversationText(item)).filter(Boolean);
    const buyerFlags = safeArray(override.buyer_flags || row.effective_buyer_flags || row.buyer_flags).map((item) => compactConversationText(item)).filter(Boolean);
    const riskFlags = safeArray(override.risk_flags || row.effective_risk_flags || row.risk_flags).map((item) => compactConversationText(item)).filter(Boolean);
    return {
      ...row,
      effective_conversation_source: ebayConversationSource(conversation),
      effective_priority: compactConversationText(override.priority || row.effective_priority || row.priority, "normal"),
      effective_response_need: compactConversationText(override.response_need || row.effective_response_need || row.response_need, "reply_later"),
      effective_topic_tags: topicTags,
      effective_buyer_flags: buyerFlags,
      effective_risk_flags: riskFlags,
      effective_summary: compactConversationText(override.summary || row.effective_summary || row.summary),
      effective_reasoning_summary: compactConversationText(override.reasoning_summary || row.effective_reasoning_summary || row.reasoning_summary),
      effective_recommended_action: compactConversationText(override.recommended_action || row.effective_recommended_action || row.recommended_action),
      has_operator_override: Object.keys(override).length > 0 || row.has_operator_override === true,
    };
  }

  function ebayClassificationIsStale(conversation, classification = ebayConversationClassification(conversation)) {
    if (!conversation || !classification) return false;
    if (conversation.latest_message_id && classification.latest_ebay_message_id && conversation.latest_message_id !== classification.latest_ebay_message_id) return true;
    const classifiedAt = new Date(classification.created_at || 0).getTime();
    const latestAt = new Date(conversation.latest_message_created_at || conversation.last_message_created_at || 0).getTime();
    return Number.isFinite(classifiedAt) && Number.isFinite(latestAt) && latestAt > classifiedAt + 1000;
  }

  function ebayPriorityBadgeVariant(value) {
    const priority = String(value || "").toLowerCase();
    if (priority === "high") return "danger";
    if (priority === "normal") return "default";
    return "muted";
  }

  function ebayResponseBadgeVariant(value) {
    const need = String(value || "").toLowerCase();
    if (need === "reply_today") return "warning";
    if (need === "reply_later") return "default";
    return "muted";
  }

  function ebayTopicBadgeVariant(value) {
    const tag = String(value || "").toLowerCase();
    if (["return", "refund_request", "not_as_described", "missing_item", "wrong_item", "cancellation"].includes(tag)) return "warning";
    if (["buyer_complaint", "payment_issue", "feedback_issue"].includes(tag)) return "danger";
    if (tag === "platform_notice") return "muted";
    return "category";
  }

  function strongestBuyerFlag(flags = []) {
    const order = ["vip_buyer", "high_value_buyer", "repeat_buyer", "high_retained_value_buyer", "return_prone_buyer", "high_return_risk_buyer", "new_buyer", "low_risk_buyer"];
    return order.find((flag) => flags.includes(flag)) || flags[0] || "";
  }

  function renderEbayClassificationListBadges(conversation, options = {}) {
    const classification = ebayConversationClassification(conversation);
    if (!classification) return "";
    const topic = classification.effective_topic_tags[0];
    const buyerFlag = strongestBuyerFlag(classification.effective_buyer_flags);
    const badges = [
      classification.effective_priority ? renderBadge(humanizeValue(classification.effective_priority), ebayPriorityBadgeVariant(classification.effective_priority)) : "",
      topic ? renderBadge(humanizeValue(topic), ebayTopicBadgeVariant(topic)) : "",
      buyerFlag ? renderBadge(humanizeValue(buyerFlag), buyerFlag === "vip_buyer" ? "success" : "category") : "",
    ].filter(Boolean).slice(0, 3);
    return badges.join("");
  }

  function renderEbayConversationBadges(conversation, options = {}) {
    const compact = options.compact === true;
    const badges = [
      renderEbayClassificationListBadges(conversation, { compact }),
      Number(conversation.unread_count || 0) > 0 ? renderBadge("Unread", "warning") : "",
    ].filter(Boolean);
    return `<span class="ebay-conversation-badges">${badges.join("")}</span>`;
  }

  function ebayFilterLabel(filter) {
    const labels = {
      all: "All",
      members: "Members",
      ebay_notifications: "eBay Notifications",
      unread: "Unread",
      unclassified: "Unclassified",
      returns: "Returns",
      shipping_issues: "Shipping Issues",
      needs_reply_today: "Needs Reply Today",
      vip_buyers: "VIP Buyers",
      high_value_buyers: "High Value Buyers",
      refund_risk: "Refund Risk",
      review_queue: "Review Queue",
      has_order: "Has order",
      has_return: "Has return",
      has_media: "Has media",
      needs_context_review: "Needs review",
    };
    return labels[filter] || "All";
  }

  function ebaySavedViewStateFromPayload(payload, baseState = adminClassificationState) {
    const savedPayload = ebaySavedViewFilterPayload(payload);
    return {
      ...baseState,
      ebayConversationFilter: savedPayload.system_filter || "all",
      ebayConversationSearchQuery: savedPayload.search_query || "",
      ebayConversationClassificationFilters: savedPayload.classification_filters,
    };
  }

  function ebaySavedViewCount(state, savedView) {
    const nextState = ebaySavedViewStateFromPayload(savedView?.filter_payload, state);
    if (ebayMailboxUsesServerFilters(state)) {
      const payload = ebaySavedViewFilterPayload(savedView?.filter_payload);
      const systemKey = compactConversationText(savedView?.system_key || payload.system_filter || "all", "all");
      const canonicalCountKey = ebayCanonicalSmartFolderCountKey(systemKey);
      const hasCustomRules = compactConversationText(payload.search_query) || countEbayClassificationFilters(payload.classification_filters) > 0;
      const counts = ebayMailboxSmartCounts(state);
      const isSystemSmartFolder = savedView?.is_system_default === true || Boolean(savedView?.system_key);
      if (canonicalCountKey && (isSystemSmartFolder || !hasCustomRules) && Object.prototype.hasOwnProperty.call(counts, canonicalCountKey)) {
        return ebayMailboxCountValue(counts[canonicalCountKey], 0);
      }
    }
    return filteredEbayConversations({ ...nextState, ebayMailboxMode: "legacy" }).length;
  }

  function renderEbaySavedViewButton(view, state) {
    const payload = ebaySavedViewFilterPayload(view.filter_payload);
    const icon = EBAY_SAVED_VIEW_ICONS[view.system_key || payload.system_filter] || "folder";
    const count = ebaySavedViewCount(state, view);
    const active = view.id && view.id === state.selectedEbaySavedViewId;
    const canManage = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(view.id || ""));
    const editing = state.ebayConversationSmartFoldersEditing === true;
    const rules = ebaySavedViewRuleSummary(view);
    return `
      <div class="ebay-smart-folder-row${active ? " is-active" : ""}${canManage && editing ? " is-editing" : ""}" data-ebay-saved-view-row="${escapeHtml(view.id)}">
        <button type="button" data-ebay-saved-view-select="${escapeHtml(view.id)}" title="${escapeHtml(`${view.name}: ${rules}`)}">
          <i data-lucide="${escapeHtml(icon)}"></i>
          <span>${escapeHtml(view.name)}</span>
          <b>${escapeHtml(count)}</b>
        </button>
        ${canManage && editing ? `
          <button type="button" class="ebay-smart-folder-icon-btn" data-ebay-saved-view-rename="${escapeHtml(view.id)}" aria-label="Rename ${escapeHtml(view.name)}">
            <i data-lucide="pencil"></i>
          </button>
          <button type="button" class="ebay-smart-folder-icon-btn" data-ebay-saved-view-update="${escapeHtml(view.id)}" aria-label="Update ${escapeHtml(view.name)} filters">
            <i data-lucide="save"></i>
          </button>
          <button type="button" class="ebay-smart-folder-icon-btn is-danger" data-ebay-saved-view-delete="${escapeHtml(view.id)}" aria-label="Delete ${escapeHtml(view.name)}">
            <i data-lucide="trash-2"></i>
          </button>
        ` : ""}
        ${editing ? `<div class="ebay-smart-folder-rules">${escapeHtml(rules)}</div>` : ""}
      </div>
    `;
  }

  function renderEbaySavedViews(state) {
    if (!els.ebayConversationSavedViews) return;
    if (els.ebaySmartFolderEditToggle) {
      const editing = state.ebayConversationSmartFoldersEditing === true;
      els.ebaySmartFolderEditToggle.setAttribute("aria-pressed", editing ? "true" : "false");
      els.ebaySmartFolderEditToggle.classList.toggle("is-active", editing);
      const label = els.ebaySmartFolderEditToggle.querySelector("span");
      if (label) label.textContent = editing ? "Done" : "Edit";
    }
    if (state.ebayConversationSavedViewsLoading) {
      els.ebayConversationSavedViews.innerHTML = `<div class="classification-empty matched-context-empty is-quiet">Loading smart folders.</div>`;
      return;
    }
    const views = ebaySavedViewsForState(state);
    if (!views.length) {
      els.ebayConversationSavedViews.innerHTML = `<div class="classification-empty matched-context-empty is-quiet">No smart folders yet.</div>`;
      return;
    }
    const error = state.ebayConversationSavedViewsError
      ? `<div class="classification-notice is-error">Smart folders are using local defaults until the database table is available.</div>`
      : "";
    const actionError = state.ebayConversationSavedViewActionError
      ? `<div class="classification-notice is-error">Smart folder save failed: ${escapeHtml(state.ebayConversationSavedViewActionError)}</div>`
      : "";
    els.ebayConversationSavedViews.innerHTML = `${error}${actionError}${views.map((view) => renderEbaySavedViewButton(view, state)).join("")}`;
  }

  function countEbayFilterOption(rows, groupKey, value) {
    if (ebayMailboxUsesServerFilters(adminClassificationState)) {
      return ebayMailboxCountValue(ebayMailboxOptionCounts(adminClassificationState)?.[groupKey]?.[value], 0);
    }
    return rows.filter((conversation) => {
      if (groupKey === "sourceTypes") return ebayConversationSource(conversation) === value;
      const classification = ebayConversationClassification(conversation);
      if (!classification) return false;
      if (groupKey === "topics") return classification.effective_topic_tags.includes(value);
      if (groupKey === "buyerFlags") return classification.effective_buyer_flags.includes(value);
      if (groupKey === "riskFlags") return classification.effective_risk_flags.includes(value);
      if (groupKey === "priorities") return classification.effective_priority === value;
      if (groupKey === "responseNeeds") return classification.effective_response_need === value;
      return false;
    }).length;
  }

  function ebayFilterActiveChips(filters = {}) {
    const normalized = safeEbayClassificationFilters(filters);
    return EBAY_FILTER_GROUPS.flatMap((group) => normalized[group.key].map((value) => ({
      groupKey: group.key,
      groupLabel: group.label,
      value,
      label: humanizeValue(value),
    })));
  }

  function renderEbayFilterGroup(group, state) {
    const rows = safeArray(state.ebayConversations);
    const selected = new Set(safeEbayClassificationFilters(state.ebayConversationClassificationFilters)[group.key]);
    return `
      <section class="ebay-filter-group">
        <h4>${escapeHtml(group.label)}</h4>
        <div class="ebay-filter-chip-grid">
          ${group.values.map((value) => {
            const count = countEbayFilterOption(rows, group.key, value);
            return `
              <label class="ebay-filter-chip${selected.has(value) ? " is-active" : ""}${count ? "" : " is-empty"}">
                <input type="checkbox" data-ebay-filter-group="${escapeHtml(group.key)}" value="${escapeHtml(value)}"${selected.has(value) ? " checked" : ""} />
                <span>${escapeHtml(humanizeValue(value))}</span>
                <em>${escapeHtml(count)}</em>
              </label>
            `;
          }).join("")}
        </div>
      </section>
    `;
  }

  function ebaySearchSuggestionRows(state = adminClassificationState) {
    const query = String(state.ebayConversationSearchQuery || "");
    const lastToken = query.split(/\s+/).pop() || "";
    const tokenMatch = lastToken.match(/^([a-z]+):([^ ]*)$/i);
    const requestedKey = normalizeEbaySearchText(tokenMatch?.[1] || "");
    const typedValue = normalizeEbayStructuredTokenValue(tokenMatch?.[2] || "");
    const rows = [
      ...EBAY_TOPIC_TAGS.map((value) => ({ key: "topic", broadKey: "tag", group: "Topics", value })),
      ...EBAY_CONVERSATION_SOURCE_TYPES.map((value) => ({ key: "source", broadKey: "tag", group: "Source", value })),
      ...EBAY_BUYER_FLAGS.map((value) => ({ key: "buyer", broadKey: "tag", group: "Buyer flags", value })),
      ...EBAY_RISK_FLAGS.map((value) => ({ key: "risk", broadKey: "tag", group: "Risk flags", value })),
      ...EBAY_PRIORITIES.map((value) => ({ key: "priority", broadKey: "tag", group: "Priority", value })),
      ...EBAY_RESPONSE_NEEDS.map((value) => ({ key: "response", broadKey: "tag", group: "Response", value })),
    ];
    if (!requestedKey) return rows.slice(0, 16);
    return rows.filter((row) => {
      const keyMatches = requestedKey === "tag" || row.key === requestedKey || row.broadKey === requestedKey;
      const valueMatches = !typedValue || row.value.includes(typedValue);
      return keyMatches && valueMatches;
    }).slice(0, 16);
  }

  function renderEbayTagButton(row, options = {}) {
    const key = options.forceTag === true ? "tag" : row.key;
    const token = `${key}:${row.value}`;
    return `
      <button type="button" data-ebay-search-token="${escapeHtml(token)}">
        <span>${escapeHtml(row.group)}</span>
        ${escapeHtml(token)}
      </button>
    `;
  }

  function renderEbaySearchSuggestions(state) {
    if (!els.ebayConversationTagSuggestions) return;
    const query = String(state.ebayConversationSearchQuery || "");
    const shouldShow = document.activeElement === els.ebayConversationSearch && /(?:^|\s)(tag|source|topic|buyer|risk|priority|response):/i.test(query);
    if (!shouldShow) {
      els.ebayConversationTagSuggestions.hidden = true;
      els.ebayConversationTagSuggestions.innerHTML = "";
      return;
    }
    const rows = ebaySearchSuggestionRows(state);
    const forceTag = /(?:^|\s)tag:[^\s]*$/i.test(query);
    els.ebayConversationTagSuggestions.hidden = !rows.length;
    els.ebayConversationTagSuggestions.innerHTML = rows.length ? rows.map((row) => renderEbayTagButton(row, { forceTag })).join("") : "";
  }

  function renderEbayTagHelp(state) {
    if (!els.ebayConversationTagHelp) return;
    const open = state.ebayConversationTagHelpOpen === true;
    els.ebayConversationTagHelp.hidden = !open;
    if (els.ebayConversationTagHelpToggle) {
      els.ebayConversationTagHelpToggle.setAttribute("aria-expanded", open ? "true" : "false");
      els.ebayConversationTagHelpToggle.classList.toggle("is-active", open);
    }
    if (!open) {
      els.ebayConversationTagHelp.innerHTML = "";
      return;
    }
    els.ebayConversationTagHelp.innerHTML = `
      ${EBAY_FILTER_GROUPS.map((group) => {
        const prefix = group.key === "topics"
          ? "topic"
          : group.key === "sourceTypes" ? "source"
          : group.key === "buyerFlags" ? "buyer" : group.key === "riskFlags" ? "risk" : group.key === "priorities" ? "priority" : "response";
        return `
          <section>
            <h4>${escapeHtml(group.label)}</h4>
            <div>${group.values.map((value) => renderEbayTagButton({ key: prefix, group: group.label, value })).join("")}</div>
          </section>
        `;
      }).join("")}
    `;
  }

  function renderEbayClassificationFilterPanel(state) {
    const activeChips = ebayFilterActiveChips(state.ebayConversationClassificationFilters);
    const activeFilterCount = activeChips.length;
    const query = compactConversationText(state.ebayConversationSearchQuery);
    const savedView = state.ebayConversationFilter || "all";
    const hasNonDefaultView = savedView !== "all";
    const selectedSavedView = ebaySavedViewsForState(state).find((view) => view.id === state.selectedEbaySavedViewId);
    const search = parseEbayStructuredSearch(query);
    const hasActiveControls = activeFilterCount > 0 || query || hasNonDefaultView || Boolean(state.selectedEbaySavedViewId);

    if (els.ebayConversationFilterToggle) {
      els.ebayConversationFilterToggle.setAttribute("aria-expanded", state.ebayConversationFiltersExpanded ? "true" : "false");
      els.ebayConversationFilterToggle.classList.toggle("is-active", state.ebayConversationFiltersExpanded === true);
    }
    if (els.ebayConversationFilterLabel) {
      els.ebayConversationFilterLabel.textContent = activeFilterCount ? `Classification filters (${activeFilterCount})` : "Classification filters";
    }
    if (els.ebayConversationFilterPanel) {
      els.ebayConversationFilterPanel.hidden = state.ebayConversationFiltersExpanded !== true;
      els.ebayConversationFilterPanel.innerHTML = EBAY_FILTER_GROUPS.map((group) => renderEbayFilterGroup(group, state)).join("");
    }
    if (els.ebayConversationActiveFilters) {
      const chips = [
        selectedSavedView ? `<button type="button" data-ebay-clear-view><span>Folder</span>${escapeHtml(selectedSavedView.name)}<i data-lucide="x"></i></button>` : "",
        hasNonDefaultView && !selectedSavedView ? `<button type="button" data-ebay-clear-view><span>View</span>${escapeHtml(ebayFilterLabel(savedView))}<i data-lucide="x"></i></button>` : "",
        query ? `<button type="button" data-ebay-clear-search><span>${search.structuredTokens.length ? "Structured search" : "Search"}</span>${escapeHtml(query)}<i data-lucide="x"></i></button>` : "",
        ...activeChips.map((chip) => `
          <button type="button" data-ebay-remove-filter-group="${escapeHtml(chip.groupKey)}" data-ebay-remove-filter-value="${escapeHtml(chip.value)}">
            <span>${escapeHtml(chip.groupLabel)}</span>${escapeHtml(chip.label)}<i data-lucide="x"></i>
          </button>
        `),
      ].filter(Boolean);
      els.ebayConversationActiveFilters.innerHTML = chips.length
        ? chips.join("")
        : `<span>No classification filters active</span>`;
    }
    if (els.ebayConversationClearFilters) {
      els.ebayConversationClearFilters.disabled = !hasActiveControls;
    }
    if (els.ebayConversationSaveView) {
      els.ebayConversationSaveView.disabled = state.ebayConversationSavedViewsLoading === true || state.ebayConversationSavedViewSavingId === "create";
      els.ebayConversationSaveView.classList.toggle("is-loading", state.ebayConversationSavedViewSavingId === "create");
    }
    renderEbaySearchSuggestions(state);
    renderEbayTagHelp(state);
  }

  function ebayConversationMetaItems(conversation, maxItems = 4) {
    const summary = ebayConversationSummary(conversation);
    const items = [
      summary.order_numbers[0] ? `Order ${summary.order_numbers[0]}` : "",
      summary.return_ids[0] ? `Return ${summary.return_ids[0]}` : "",
      summary.listing_ids[0] ? `Listing ${summary.listing_ids[0]}` : "",
      summary.item_numbers[0] ? `Item ${summary.item_numbers[0]}` : "",
      conversation.ebay_conversation_id ? `Conversation ${conversation.ebay_conversation_id}` : "",
    ].filter(Boolean);
    return items.slice(0, maxItems);
  }

  function renderEbayConversationList(state) {
    if (!els.ebayConversationList) return;
    const rows = filteredEbayConversations(state);
    const densityMode = state.ebayConversationDensityMode === "expanded" ? "expanded" : "compact";
    const compact = densityMode === "compact";
    els.ebayConversationList.classList.toggle("is-compact-density", compact);
    els.ebayConversationList.classList.toggle("is-expanded-density", !compact);
    if (!rows.length) {
      if (state.ebayConversationLoading || state.ebayConversationLoadingMore) {
        els.ebayConversationList.innerHTML = `<div class="classification-empty matched-context-empty is-quiet">Loading canonical eBay conversations.</div>`;
        return;
      }
      const query = compactConversationText(state.ebayConversationSearchQuery);
      els.ebayConversationList.innerHTML = `<div class="classification-empty">${query ? `No canonical eBay conversations match "${escapeHtml(query)}".` : "No canonical eBay conversations match this filter."}</div>`;
      return;
    }

    els.ebayConversationList.innerHTML = rows.map((conversation) => {
      const selected = conversation.id === state.selectedEbayConversationId;
      const identity = ebayBuyerIdentity(conversation);
      const summary = ebayConversationSummary(conversation);
      const metaItems = ebayConversationMetaItems(conversation, 3);
      const previewLines = ebayConversationPreviewLines(conversation);
      const unread = Number(conversation.unread_count || 0) > 0;
      return `
        <button type="button" class="ebay-conversation-row is-${escapeHtml(densityMode)}${ebayConversationIsPlatform(conversation) ? " is-platform-conversation" : ""}${selected ? " is-selected" : ""}${unread ? " is-unread" : ""}" data-ebay-conversation-id="${escapeHtml(conversation.id)}">
          <span class="ebay-conversation-row-top">
            <span class="ebay-conversation-party">
              <span class="ebay-conversation-avatar" aria-hidden="true">${escapeHtml(ebayConversationInitials(conversation))}</span>
              <span class="ebay-conversation-party-copy">
                <strong>${escapeHtml(identity.displayName)}</strong>
                ${compact ? "" : `<small>${escapeHtml(ebayIdentitySourceLabel(identity.source))}</small>`}
              </span>
            </span>
            <time>${escapeHtml(formatCompactEmailAge(ebayConversationTime(conversation)))}</time>
          </span>
          <span class="ebay-conversation-row-ai-summary"><b>${escapeHtml(previewLines.summaryLabel)}</b>${escapeHtml(previewLines.summary)}</span>
          ${compact ? "" : `<span class="ebay-conversation-row-title">${escapeHtml(ebayConversationTitle(conversation))}</span>`}
          <span class="ebay-conversation-row-preview"><b>${escapeHtml(previewLines.previewLabel)}</b>${escapeHtml(previewLines.preview)}</span>
          ${compact ? "" : `
            <span class="ebay-conversation-row-meta">
              ${metaItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
              ${summary.seller_username ? `<span>Seller ${escapeHtml(summary.seller_username)}</span>` : ""}
            </span>
          `}
          ${renderEbayConversationBadges(conversation, { compact })}
        </button>
      `;
    }).join("");
  }

  function renderEbayConversationSummary(state) {
    if (!els.ebayConversationSummary) return;
    const rows = safeArray(state.ebayConversations);
    const filtered = filteredEbayConversations(state);
    const page = ebayMailboxPageInfo(state);
    const smartCounts = ebayMailboxSmartCounts(state);
    const canonicalTotal = page.canonical_total ?? ebayMailboxCountValue(smartCounts.all, rows.length);
    const matchingTotal = page.matching_total ?? filtered.length;
    const members = ebayMailboxCountValue(smartCounts.members, rows.filter((conversation) => ebaySavedViewMatches(conversation, "members")).length);
    const notifications = ebayMailboxCountValue(smartCounts.ebay_notifications, rows.filter((conversation) => ebaySavedViewMatches(conversation, "ebay_notifications")).length);
    const unread = ebayMailboxCountValue(smartCounts.unread, rows.filter((conversation) => Number(conversation.unread_count || 0) > 0).length);
    const unclassified = ebayMailboxCountValue(smartCounts.unclassified, rows.filter((conversation) => ebaySavedViewMatches(conversation, "unclassified")).length);
    const returns = ebayMailboxCountValue(smartCounts.returns, rows.filter((conversation) => ebaySavedViewMatches(conversation, "returns")).length);
    const query = compactConversationText(state.ebayConversationSearchQuery);
    const activeFilterCount = countEbayClassificationFilters(state.ebayConversationClassificationFilters);
    const degraded = state.ebayMailboxMode === "legacy" || Boolean(state.ebayMailboxWarning);
    const modeLabel = degraded ? "Degraded legacy fallback" : `RPC ${page.rpc_version || "v2"}`;
    els.ebayConversationSummary.innerHTML = `
      ${degraded ? `
        <div class="ebay-conversation-summary-warning">
          <strong>Degraded mode</strong>
          <span>Counts, search, and filters are limited to loaded legacy rows.</span>
        </div>
      ` : ""}
      <div>
        <strong>Canonical: ${escapeHtml(formatContextNumber(canonicalTotal))}</strong>
        <span>Matching: ${escapeHtml(formatContextNumber(matchingTotal))}</span>
      </div>
      <div>
        <strong>Loaded: ${escapeHtml(formatContextNumber(rows.length))}</strong>
        <span>Displayed: ${escapeHtml(formatContextNumber(filtered.length))}</span>
      </div>
      <div>
        <strong>Members: ${escapeHtml(formatContextNumber(members))}</strong>
        <span>eBay Notifications: ${escapeHtml(formatContextNumber(notifications))}</span>
      </div>
      <div>
        <strong>Unread: ${escapeHtml(formatContextNumber(unread))}</strong>
        <span>Unclassified: ${escapeHtml(formatContextNumber(unclassified))}</span>
      </div>
      <div>
        <strong>${query ? "Search" : "Labels"}: ${escapeHtml(query || formatContextNumber(activeFilterCount))}</strong>
        <span>${escapeHtml(formatContextNumber(returns))} returns · ${escapeHtml(modeLabel)}</span>
      </div>
    `;
  }

  function ebayConversationIsPlatform(conversation) {
    const type = String(conversation?.conversation_type || conversation?.raw?.conversation_type || "").toUpperCase();
    const identity = ebayBuyerIdentity(conversation);
    return type === "FROM_EBAY" ||
      identity.source === "platform" ||
      normalizeEbaySearchText(identity.displayName) === "ebay";
  }

  function normalizeEbayConversationSourceType(value) {
    const source = compactConversationText(value);
    return EBAY_CONVERSATION_SOURCE_TYPES.includes(source) ? source : "";
  }

  function ebayConversationSource(conversation) {
    return normalizeEbayConversationSourceType(
      ebayConversationIsPlatform(conversation) ? "platform_notification" : "member_message",
    ) || "member_message";
  }

  function ebayMessageDirection(message) {
    const direction = String(message?.direction || "unknown").toLowerCase();
    return ["inbound", "outbound", "platform", "unknown"].includes(direction) ? direction : "unknown";
  }

  function ebayMessageLooksLikeHtml(value) {
    const text = String(value || "");
    return /<!doctype\s+html|<html[\s>]|<body[\s>]|<\/?[a-z][\s\S]*>/i.test(text);
  }

  function ebayMessageSenderIsEbay(message) {
    return normalizeEbaySearchText([
      message?.sender_username,
      message?.recipient_username,
      message?.subject,
    ].filter(Boolean).join(" ")) === "ebay" ||
      /\bebay\b/i.test(String(message?.sender_username || message?.subject || ""));
  }

  function ebayMessageIsNotification(message, conversation) {
    const direction = ebayMessageDirection(message);
    if (direction === "platform") return true;
    if (ebayConversationIsPlatform(conversation)) return true;
    return ebayMessageLooksLikeHtml(ebayMessageText(message)) && ebayMessageSenderIsEbay(message);
  }

  function parseEbayNotificationHtml(html) {
    if (!ebayMessageLooksLikeHtml(html) || !window.DOMParser) return null;
    try {
      return new window.DOMParser().parseFromString(String(html || ""), "text/html");
    } catch (error) {
      return null;
    }
  }

  function safeEbayNotificationUrl(value) {
    let text = String(value || "").trim();
    if (!text) return "";
    if (text.startsWith("//")) text = `https:${text}`;
    if (/^www\./i.test(text)) text = `https://${text}`;
    try {
      const url = text.startsWith("/") ? new URL(text, "https://www.ebay.com") : new URL(text);
      if (!["http:", "https:"].includes(url.protocol)) return "";
      return url.href;
    } catch (error) {
      return "";
    }
  }

  function sanitizeEbayNotificationNode(node) {
    if (!node) return "";
    if (node.nodeType === 3) return escapeHtml(node.textContent || "");
    if (node.nodeType !== 1) return "";

    const tag = String(node.nodeName || "").toLowerCase();
    if (EBAY_NOTIFICATION_DROP_TAGS.has(tag)) return "";
    if (tag === "br") return "<br />";
    if (tag === "img") return "";
    if (tag === "hr") return "<hr />";

    const content = Array.from(node.childNodes || []).map(sanitizeEbayNotificationNode).join("");
    if (tag === "a") {
      const href = safeEbayNotificationUrl(node.getAttribute("href"));
      if (!href) return content;
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${content || escapeHtml(href)}</a>`;
    }

    if (!EBAY_NOTIFICATION_ALLOWED_TAGS.has(tag)) return content;
    const hasContent = compactConversationText(content.replace(/<[^>]+>/g, "")) || /<br|<hr|<table|<ul|<ol/i.test(content);
    if (!hasContent) return "";
    return `<${tag}>${content}</${tag}>`;
  }

  function renderPlainNotificationText(text) {
    const fallbackText = ebayMessageLooksLikeHtml(text)
      ? String(text || "")
        .replace(/<\s*br\s*\/?>/gi, "\n")
        .replace(/<\/\s*(p|div|tr|li|h[1-6])\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
      : String(text || "");
    const rows = fallbackText
      .split(/\n{2,}|\r?\n/)
      .map((line) => compactConversationText(line))
      .filter(Boolean)
      .slice(0, 30);
    if (!rows.length) return `<p>No notification body stored.</p>`;
    return rows.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  }

  function sanitizedEbayNotificationBody(rawBody, doc) {
    if (!doc?.body) return renderPlainNotificationText(rawBody);
    const body = Array.from(doc.body.childNodes || []).map(sanitizeEbayNotificationNode).join("").trim();
    return body || renderPlainNotificationText(doc.body.textContent || rawBody);
  }

  function ebayNotificationTextFromNode(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.textContent || "";
    if (node.nodeType !== 1) return "";

    const tag = String(node.nodeName || "").toLowerCase();
    if (EBAY_NOTIFICATION_DROP_TAGS.has(tag)) return "";
    if (tag === "br" || tag === "hr") return "\n";
    const text = Array.from(node.childNodes || []).map(ebayNotificationTextFromNode).join("");
    if (EBAY_NOTIFICATION_BLOCK_TAGS.has(tag)) return `\n${text}\n`;
    return text;
  }

  function ebayNotificationPlainText(rawBody, doc) {
    const text = doc?.body
      ? Array.from(doc.body.childNodes || []).map(ebayNotificationTextFromNode).join("\n")
      : String(rawBody || "");
    return text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function ebayNotificationActionLabel(label, href) {
    const text = compactConversationText(label);
    const blob = `${text} ${href}`.toLowerCase();
    if (/cancel/.test(blob)) return "See cancel details";
    if (/\bcase\b|customer-service|resolution/.test(blob)) return "See case details";
    if (/dispute|chargeback/.test(blob)) return "See dispute details";
    if (/return/.test(blob)) return "See return details";
    if (/refund/.test(blob)) return "See refund details";
    if (/order|purchase/.test(blob)) return "Open order";
    if (/item|itm|listing/.test(blob)) return "Open item";
    if (text && !/^(click here|view|details|see details)$/i.test(text)) return text.slice(0, 80);
    try {
      return new URL(href).hostname.replace(/^www\./, "");
    } catch (error) {
      return "Open eBay link";
    }
  }

  function extractEbayNotificationLinks(rawBody, doc) {
    const links = [];
    const seen = new Set();
    const addLink = (hrefValue, labelValue) => {
      const href = safeEbayNotificationUrl(hrefValue);
      if (!href || seen.has(href)) return;
      seen.add(href);
      links.push({
        href,
        label: ebayNotificationActionLabel(labelValue, href),
      });
    };

    if (doc?.body) {
      Array.from(doc.body.querySelectorAll("a[href]")).forEach((link) => {
        addLink(link.getAttribute("href"), link.textContent || link.getAttribute("aria-label") || "");
      });
    } else {
      String(rawBody || "").replace(/href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
        addLink(href, String(label || "").replace(/<[^>]+>/g, " "));
        return "";
      });
    }

    return links.slice(0, 12);
  }

  function imageCandidateScore(candidate) {
    const blob = `${candidate.url} ${candidate.alt || ""}`.toLowerCase();
    let score = 0;
    if (/i\.ebayimg\.com|thumbs\d*\.ebaystatic\.com/.test(blob)) score += 8;
    if (/item|listing|photo|image|product/.test(blob)) score += 4;
    if (Number(candidate.width || 0) >= 80 || Number(candidate.height || 0) >= 80) score += 3;
    if (/logo|spacer|pixel|tracking|transparent|icon/.test(blob)) score -= 8;
    return score;
  }

  function extractUrlFromMediaRecord(record, depth = 0) {
    if (!record || depth > 3) return "";
    if (typeof record === "string") return safeEbayNotificationUrl(record);
    if (Array.isArray(record)) {
      for (const item of record) {
        const url = extractUrlFromMediaRecord(item, depth + 1);
        if (url) return url;
      }
      return "";
    }
    if (typeof record !== "object") return "";
    const keys = ["url", "src", "href", "mediaUrl", "media_url", "imageUrl", "image_url", "thumbnailUrl", "thumbnail_url"];
    for (const key of keys) {
      const url = safeEbayNotificationUrl(record[key]);
      if (url) return url;
    }
    for (const value of Object.values(record)) {
      const url = extractUrlFromMediaRecord(value, depth + 1);
      if (url) return url;
    }
    return "";
  }

  function extractEbayNotificationImage(message, doc) {
    const candidates = [];
    const messageMedia = Array.isArray(message?.message_media)
      ? message.message_media
      : message?.message_media ? [message.message_media] : [];
    messageMedia.forEach((item) => {
      const url = extractUrlFromMediaRecord(item);
      if (url) candidates.push({ url, alt: "eBay item image", score: 10 });
    });

    if (doc?.body) {
      Array.from(doc.body.querySelectorAll("img[src]")).forEach((image) => {
        const url = safeEbayNotificationUrl(image.getAttribute("src"));
        if (!url) return;
        const candidate = {
          url,
          alt: compactConversationText(image.getAttribute("alt") || image.getAttribute("title") || "eBay notification image"),
          width: Number(image.getAttribute("width") || 0),
          height: Number(image.getAttribute("height") || 0),
        };
        candidates.push({ ...candidate, score: imageCandidateScore(candidate) });
      });
    }

    return candidates
      .filter((candidate, index, rows) => rows.findIndex((row) => row.url === candidate.url) === index)
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0))[0] || null;
  }

  function addEbayNotificationFact(facts, seen, label, value) {
    const cleanValue = compactConversationText(value);
    if (!cleanValue) return;
    const key = `${label}:${cleanValue}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ label, value: cleanValue });
  }

  function extractEbayNotificationFacts(message, conversation, plainText) {
    const facts = [];
    const seen = new Set();
    const summary = ebayConversationSummary(conversation);
    addEbayNotificationFact(facts, seen, "Order", summary.order_numbers[0]);
    addEbayNotificationFact(facts, seen, "Return", summary.return_ids[0]);
    addEbayNotificationFact(facts, seen, "Item", summary.item_numbers[0] || summary.listing_ids[0]);
    addEbayNotificationFact(facts, seen, "Buyer", summary.buyer_usernames[0] || conversation?.other_party_username);

    const text = String(plainText || "");
    const patterns = [
      ["Order", /\bOrder(?:\s+(?:number|ID))?\s*[:#]?\s*([A-Z0-9-]{5,})/i],
      ["Case", /\bCase(?:\s+(?:number|ID))?\s*[:#]?\s*([A-Z0-9-]{4,})/i],
      ["Return", /\bReturn(?:\s+(?:request|ID|number))?\s*[:#]?\s*([A-Z0-9-]{4,})/i],
      ["Cancellation", /\bCancellation(?:\s+(?:ID|number))?\s*[:#]?\s*([A-Z0-9-]{4,})/i],
      ["Dispute", /\b(?:Payment\s+)?Dispute(?:\s+(?:ID|number))?\s*[:#]?\s*([A-Z0-9-]{4,})/i],
      ["Item", /\bItem(?:\s+(?:ID|number))?\s*[:#]?\s*([A-Z0-9-]{5,})/i],
      ["Refund", /\b(?:Refund amount|Amount refunded|Total refund)\s*[:#]?\s*(\$?[0-9][0-9,]*(?:\.[0-9]{2})?)/i],
      ["Buyer", /\bBuyer\s*[:#]?\s*([A-Za-z0-9_.-]{3,})/i],
    ];
    patterns.forEach(([label, pattern]) => {
      const match = text.match(pattern);
      if (match?.[1]) addEbayNotificationFact(facts, seen, label, match[1]);
    });

    return facts.slice(0, 8);
  }

  function ebayNotificationKind(subject, plainText) {
    const blob = `${subject} ${plainText}`.slice(0, 4000);
    return EBAY_NOTIFICATION_KIND_RULES.find((rule) => rule.pattern.test(blob)) || {
      label: "eBay Notification",
      icon: "bell",
    };
  }

  function buildEbayNotification(message, conversation) {
    const rawBody = ebayMessageText(message);
    const doc = parseEbayNotificationHtml(rawBody);
    const plainText = ebayNotificationPlainText(rawBody, doc);
    const subject = compactConversationText(message?.subject);
    const heading = compactConversationText(
      doc?.querySelector("h1, h2, h3, title, strong")?.textContent,
    );
    const kind = ebayNotificationKind(subject || heading, plainText);
    const title = subject || heading || kind.label;
    return {
      kind,
      title,
      plainText,
      bodyHtml: sanitizedEbayNotificationBody(rawBody, doc),
      links: extractEbayNotificationLinks(rawBody, doc),
      image: extractEbayNotificationImage(message, doc),
      facts: extractEbayNotificationFacts(message, conversation, plainText),
    };
  }

  function renderEbayNotificationFacts(facts = []) {
    const rows = safeArray(facts);
    if (!rows.length) return "";
    return `<div class="ebay-notification-facts">${renderContextFactGrid(rows)}</div>`;
  }

  function renderEbayNotificationActions(links = []) {
    const rows = safeArray(links);
    if (!rows.length) return "";
    return `
      <div class="ebay-notification-actions" aria-label="eBay notification links">
        ${rows.map((link) => `
          <a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">
            <i data-lucide="external-link"></i>
            ${escapeHtml(link.label)}
          </a>
        `).join("")}
      </div>
    `;
  }

  function renderEbayNotificationCard(message, conversation) {
    const notification = buildEbayNotification(message, conversation);
    const sender = safeText(message.sender_username, "eBay");
    const recipient = safeText(message.recipient_username, "OG / Seller");
    return `
      <article class="ebay-message-row is-platform is-notification">
        <section class="ebay-notification-card">
          <div class="ebay-notification-topline">
            <span>eBay Notification</span>
            <time>${escapeHtml(formatContextDate(ebayMessageCreatedAt(message)))}</time>
          </div>
          <div class="ebay-notification-head">
            <span class="ebay-notification-icon" aria-hidden="true"><i data-lucide="${escapeHtml(notification.kind.icon)}"></i></span>
            <div>
              <span class="eyebrow">${escapeHtml(notification.kind.label)}</span>
              <h4>${escapeHtml(notification.title)}</h4>
            </div>
          </div>
          ${notification.image ? `
            <figure class="ebay-notification-media">
              <img src="${escapeHtml(notification.image.url)}" alt="${escapeHtml(notification.image.alt || "eBay notification image")}" loading="lazy" />
            </figure>
          ` : ""}
          ${renderEbayNotificationFacts(notification.facts)}
          <div class="ebay-notification-body">${notification.bodyHtml}</div>
          ${renderEbayNotificationActions(notification.links)}
          <div class="ebay-message-foot">
            <span>From ${escapeHtml(sender)}</span>
            <span>To ${escapeHtml(recipient)}</span>
          </div>
          <details class="ebay-message-debug">
            <summary>Message details</summary>
            ${renderContextFactGrid([
              { label: "eBay Message ID", value: message.ebay_message_id || "Unavailable", wide: true },
              { label: "Read Status", value: message.read_status || (message.is_read === true ? "Read" : message.is_read === false ? "Unread" : "Unknown") },
              { label: "Message Status", value: message.message_status || "Unknown" },
              { label: "Direction Confidence", value: message.direction_confidence || "Unknown" },
            ])}
          </details>
        </section>
      </article>
    `;
  }

  function ebayMessageRole(direction) {
    const value = String(direction || "").toLowerCase();
    if (value === "inbound") return "Buyer";
    if (value === "outbound") return "OG / Seller";
    if (value === "platform") return "eBay";
    return "Unknown";
  }

  function renderEbayMessageBubble(message, conversation) {
    if (ebayMessageIsNotification(message, conversation)) return renderEbayNotificationCard(message, conversation);
    const direction = ebayMessageDirection(message);
    const body = ebayMessageText(message);
    const sender = safeText(message.sender_username, "Sender unavailable");
    const recipient = safeText(message.recipient_username, "Recipient unavailable");
    const mediaCount = Number(message.media_count || 0);
    const draft = currentEbayConversationDraft(conversation?.id);
    const isDraftTarget = draft?.target_message_id &&
      draft.target_message_id === message.id &&
      !ebayDraftIsSent(draft) &&
      !ebayDraftCanSendWithoutApproval(draft);
    const isActionLoading = adminClassificationState.ebayConversationDraftActionLoadingId === conversation?.id;
    const canGenerate = direction === "inbound" && conversation?.id && message.id;
    return `
      <article class="ebay-message-row is-${escapeHtml(direction)}${message.optimistic_send ? " is-optimistic-send" : ""}">
        <div class="ebay-message-bubble">
          <div class="ebay-message-meta">
            <strong>${escapeHtml(sender)}</strong>
            <span>${escapeHtml(ebayMessageRole(direction))}</span>
            <time>${escapeHtml(formatContextDate(ebayMessageCreatedAt(message)))}</time>
          </div>
          ${message.subject ? `<div class="ebay-message-subject">${escapeHtml(message.subject)}</div>` : ""}
          <pre>${escapeHtml(body)}</pre>
          <div class="ebay-message-foot">
            <span>To ${escapeHtml(recipient)}</span>
            ${message.has_media ? `<span><i data-lucide="paperclip"></i>${escapeHtml(mediaCount || 1)} media</span>` : ""}
            ${message.optimistic_send ? `<span class="ebay-message-draft-target"><i data-lucide="check-circle-2"></i>Sent via eBay</span>` : ""}
            ${isDraftTarget ? `<span class="ebay-message-draft-target"><i data-lucide="reply"></i>Composer target</span>` : ""}
          </div>
          ${canGenerate ? `
            <div class="ebay-message-actions">
              <button type="button" class="secondary-btn" data-ebay-draft-action="generate" data-ebay-conversation-id="${escapeHtml(conversation.id)}" data-ebay-target-message-id="${escapeHtml(message.id)}" ${isActionLoading ? "disabled" : ""}>
                <i data-lucide="${isActionLoading ? "loader-circle" : "wand-sparkles"}"></i>
                ${escapeHtml(isActionLoading ? "Generating" : "Generate AI Reply")}
              </button>
            </div>
          ` : ""}
          <details class="ebay-message-debug">
            <summary>Message details</summary>
            ${renderContextFactGrid([
              { label: "eBay Message ID", value: message.ebay_message_id || "Unavailable", wide: true },
              { label: "Read Status", value: message.read_status || (message.is_read === true ? "Read" : message.is_read === false ? "Unread" : "Unknown") },
              { label: "Message Status", value: message.message_status || "Unknown" },
              { label: "Direction Confidence", value: message.direction_confidence || "Unknown" },
            ])}
          </details>
        </div>
      </article>
    `;
  }

  function renderEbayClassificationPills(values = [], emptyLabel = "None") {
    const rows = safeArray(values).map((item) => compactConversationText(item)).filter(Boolean);
    if (!rows.length) return `<span class="classification-pill is-muted">${escapeHtml(emptyLabel)}</span>`;
    return rows.map((value) => `<span class="classification-pill">${escapeHtml(humanizeValue(value))}</span>`).join("");
  }

  function renderEbayClassificationOptions(values, selectedValues, name) {
    const selected = new Set(safeArray(selectedValues));
    return values.map((value) => `
      <label class="ebay-classification-chip-option">
        <input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${selected.has(value) ? " checked" : ""} />
        <span>${escapeHtml(humanizeValue(value))}</span>
      </label>
    `).join("");
  }

  function renderRequiredOptions(values, selectedValue) {
    return values.map((value) => `<option value="${escapeHtml(value)}"${value === selectedValue ? " selected" : ""}>${escapeHtml(humanizeValue(value))}</option>`).join("");
  }

  function ebayConversationReadState(conversation) {
    return Number(conversation?.unread_count || 0) > 0 ? "unread" : "read";
  }

  function ebayConversationIsActive(conversation) {
    const status = compactConversationText(conversation?.conversation_status);
    if (!status) return true;
    return !["closed", "archived", "deleted", "inactive", "ended"].includes(status);
  }

  function ebaySystemLabelGroups(conversation, classification = ebayConversationClassification(conversation)) {
    const summary = ebayConversationSummary(conversation);
    const stale = classification ? ebayClassificationIsStale(conversation, classification) : false;
    const contextLabels = [
      summary.has_order_link ? "Has Order" : "",
      summary.has_return_link ? "Has Return" : "",
      summary.has_media ? "Has Media" : "",
      summary.has_listing_reference ? "Has Listing" : "",
    ].filter(Boolean);
    const reviewLabels = [
      summary.needs_context_review ? "Needs Review" : "",
      stale ? "Needs Reclassification" : "",
    ].filter(Boolean);
    const statusLabels = [
      ebayConversationIsActive(conversation) ? "Active" : humanizeValue(conversation?.conversation_status || "Inactive"),
    ].filter(Boolean);
    return [
      { label: "Source", values: [humanizeValue(ebayConversationSource(conversation))] },
      { label: "Unread State", values: [humanizeValue(ebayConversationReadState(conversation))] },
      { label: "Context", values: contextLabels.length ? contextLabels : ["No order, return, listing, or media label"] },
      { label: "Status", values: statusLabels },
      { label: "Review", values: reviewLabels.length ? reviewLabels : ["No deterministic review label"] },
      { label: "Warning Explanation", values: summary.warnings.length ? summary.warnings : ["No active warnings"] },
    ];
  }

  function renderEbayLabelFactGrid(groups = []) {
    return `
      <div class="ebay-classification-facts">
        ${groups.map((group) => `
          <div>
            <dt>${escapeHtml(group.label)}</dt>
            <dd>${renderEbayClassificationPills(group.values, "None")}</dd>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderEbaySystemLabelSection(conversation, classification = ebayConversationClassification(conversation)) {
    return `
      <section class="ebay-label-section">
        <div class="ebay-label-section-head">
          <h5>System Labels</h5>
          <span>Deterministic metadata</span>
        </div>
        ${renderEbayLabelFactGrid(ebaySystemLabelGroups(conversation, classification))}
      </section>
    `;
  }

  function renderEbayAiLabelSection(classification) {
    if (!classification) {
      return `
        <section class="ebay-label-section">
          <div class="ebay-label-section-head">
            <h5>AI Classification</h5>
            <span>Not classified</span>
          </div>
          ${renderEbayLabelFactGrid([
            { label: "Topics", values: ["Unclassified"] },
            { label: "Buyer Flags", values: ["Unclassified"] },
            { label: "Risk Flags", values: ["Unclassified"] },
            { label: "Priority", values: ["Unclassified"] },
            { label: "Response Status", values: ["Unclassified"] },
          ])}
        </section>
      `;
    }
    return `
      <section class="ebay-label-section">
        <div class="ebay-label-section-head">
          <h5>AI Classification</h5>
          <span>Model-generated labels</span>
        </div>
        ${renderEbayLabelFactGrid([
          { label: "Topics", values: classification.effective_topic_tags.length ? classification.effective_topic_tags.map(humanizeValue) : ["No Topic"] },
          { label: "Buyer Flags", values: classification.effective_buyer_flags.length ? classification.effective_buyer_flags.map(humanizeValue) : ["No Buyer Flags"] },
          { label: "Risk Flags", values: classification.effective_risk_flags.length ? classification.effective_risk_flags.map(humanizeValue) : ["No Risk Flags"] },
          { label: "Priority", values: [humanizeValue(classification.effective_priority)] },
          { label: "Response Status", values: [humanizeValue(classification.effective_response_need)] },
        ])}
      </section>
    `;
  }

  function renderEbayClassificationEditor(conversation, classification) {
    if (!classification) return "";
    return `
      <form class="ebay-classification-editor" data-ebay-classification-form data-conversation-id="${escapeHtml(conversation.id)}" data-classification-id="${escapeHtml(classification.id)}">
        <div class="ebay-classification-editor-grid">
          <label>
            <span>Priority</span>
            <select name="priority">${renderRequiredOptions(EBAY_PRIORITIES, classification.effective_priority)}</select>
          </label>
          <label>
            <span>Response</span>
            <select name="response_need">${renderRequiredOptions(EBAY_RESPONSE_NEEDS, classification.effective_response_need)}</select>
          </label>
          <label>
            <span>Review</span>
            <select name="review_state">${renderRequiredOptions(EBAY_REVIEW_STATES, classification.review_state === "pending_review" ? "corrected" : classification.review_state || "corrected")}</select>
          </label>
        </div>
        <div class="ebay-classification-editor-block">
          <strong>Topics</strong>
          <div class="ebay-classification-chip-grid">${renderEbayClassificationOptions(EBAY_TOPIC_TAGS, classification.effective_topic_tags, "topic_tags")}</div>
        </div>
        <div class="ebay-classification-editor-block">
          <strong>Buyer flags</strong>
          <div class="ebay-classification-chip-grid">${renderEbayClassificationOptions(EBAY_BUYER_FLAGS, classification.effective_buyer_flags, "buyer_flags")}</div>
        </div>
        <div class="ebay-classification-editor-block">
          <strong>Risk flags</strong>
          <div class="ebay-classification-chip-grid">${renderEbayClassificationOptions(EBAY_RISK_FLAGS, classification.effective_risk_flags, "risk_flags")}</div>
        </div>
        <label class="ebay-classification-editor-note">
          <span>Operator notes</span>
          <textarea name="operator_notes" rows="2" placeholder="Optional note for override history">${escapeHtml(classification.operator_notes || "")}</textarea>
        </label>
        <div class="ebay-classification-editor-actions">
          <button type="submit" class="primary-btn" ${adminClassificationState.ebayConversationClassificationSavingId === classification.id ? "disabled" : ""}>
            <i data-lucide="${adminClassificationState.ebayConversationClassificationSavingId === classification.id ? "loader-circle" : "save"}"></i>
            Save labels
          </button>
          <button type="button" class="secondary-btn" data-ebay-detail-action="cancel-classification-edit" data-ebay-conversation-id="${escapeHtml(conversation.id)}">
            Cancel
          </button>
        </div>
      </form>
    `;
  }

  function renderEbayClassificationCard(conversation) {
    const classification = ebayConversationClassification(conversation);
    const isLoading = adminClassificationState.ebayConversationClassificationLoadingId === conversation.id;
    const error = adminClassificationState.ebayConversationClassificationErrorsById?.[conversation.id];
    const saveError = classification?.id ? adminClassificationState.ebayConversationClassificationSaveErrorsById?.[classification.id] : null;
    const editing = classification?.id && adminClassificationState.ebayConversationClassificationEditingId === classification.id;
    const openAttribute = adminClassificationState.ebayConversationClassificationCollapsed === true && !editing ? "" : " open";
    if (!classification) {
      return `
        <details class="ebay-classification-card" data-ebay-detail-preference="classification"${openAttribute}>
          <summary class="context-card-head">
            <h4>AI Classification</h4>
            <span class="ebay-classification-head-badges">
              ${renderBadge("Unclassified", "muted")}
              <i data-lucide="chevron-down"></i>
            </span>
          </summary>
          <p>Classify this canonical eBay conversation using the chat timeline and linked buyer/order context.</p>
          ${error ? `<div class="classification-notice is-error">Classification failed: ${escapeHtml(error)}</div>` : ""}
          ${renderEbayAiLabelSection(null)}
          ${renderEbaySystemLabelSection(conversation, null)}
          <button type="button" class="secondary-btn" data-ebay-detail-action="classify-conversation" data-ebay-conversation-id="${escapeHtml(conversation.id)}" ${isLoading ? "disabled" : ""}>
            <i data-lucide="${isLoading ? "loader-circle" : "sparkles"}"></i>
            ${escapeHtml(isLoading ? "Classifying" : "Classify conversation")}
          </button>
        </details>
      `;
    }

    const stale = ebayClassificationIsStale(conversation, classification);
    return `
      <details class="ebay-classification-card${stale ? " is-stale" : ""}" data-ebay-detail-preference="classification"${openAttribute}>
        <summary class="context-card-head">
          <h4>AI Classification</h4>
          <span class="ebay-classification-head-badges">
            ${renderBadge(humanizeValue(classification.effective_priority), ebayPriorityBadgeVariant(classification.effective_priority))}
            ${renderBadge(humanizeValue(classification.effective_response_need), ebayResponseBadgeVariant(classification.effective_response_need))}
            ${classification.has_operator_override ? renderBadge("Operator edited", "warning") : ""}
            <i data-lucide="chevron-down"></i>
          </span>
        </summary>
        ${stale ? `<div class="classification-notice is-warning">Classification may be stale because a newer eBay message is stored.</div>` : ""}
        ${error ? `<div class="classification-notice is-error">Classification failed: ${escapeHtml(error)}</div>` : ""}
        ${saveError ? `<div class="classification-notice is-error">Override save failed: ${escapeHtml(saveError)}</div>` : ""}
        ${renderEbayAiLabelSection(classification)}
        ${renderEbaySystemLabelSection(conversation, classification)}
        <p>${escapeHtml(classification.effective_summary || "No summary stored.")}</p>
        <div class="ebay-classification-reason">${escapeHtml(classification.effective_reasoning_summary || "No reason stored.")}</div>
        <div class="selected-email-meta">
          <span>Confidence ${escapeHtml(formatConfidence(classification.confidence))}</span>
          <span>${escapeHtml(humanizeValue(classification.review_state || "pending_review"))}</span>
          <span>${escapeHtml(formatContextDate(classification.created_at))}</span>
        </div>
        <div class="ebay-classification-actions">
          <button type="button" class="secondary-btn" data-ebay-detail-action="classify-conversation" data-ebay-conversation-id="${escapeHtml(conversation.id)}" ${isLoading ? "disabled" : ""}>
            <i data-lucide="${isLoading ? "loader-circle" : "refresh-cw"}"></i>
            ${escapeHtml(isLoading ? "Classifying" : "Reclassify")}
          </button>
          <button type="button" class="secondary-btn" data-ebay-detail-action="edit-classification" data-ebay-conversation-id="${escapeHtml(conversation.id)}" data-classification-id="${escapeHtml(classification.id)}">
            <i data-lucide="sliders-horizontal"></i>
            Edit labels
          </button>
        </div>
        ${editing ? renderEbayClassificationEditor(conversation, classification) : ""}
      </details>
    `;
  }

  function ebayDraftPayload(conversationId, state = adminClassificationState) {
    return state.ebayConversationDraftsById?.[conversationId] || null;
  }

  function currentEbayConversationDraft(conversationId, state = adminClassificationState) {
    const payload = ebayDraftPayload(conversationId, state);
    const drafts = safeArray(payload?.drafts);
    return payload?.current_draft || drafts.find((draft) => draft.is_current === true && !draft.discarded_at) || null;
  }

  function ebayDraftDisplayText(draft) {
    return safeText(draft?.final_text || draft?.edited_text || draft?.draft_text, "");
  }

  function ebayMessageText(message) {
    return safeText(message?.body || message?.message_body || message?.message_body_preview, "No message body stored.");
  }

  function ebayMessageCreatedAt(message) {
    return message?.created_at_ebay || message?.created_at || null;
  }

  function ebayMessageIdentifier(message) {
    return message?.ebay_message_id || message?.id || "Unavailable";
  }

  function ebayMessageById(messages = [], messageId = "") {
    const id = String(messageId || "");
    if (!id) return null;
    return safeArray(messages).find((message) => String(message?.id || "") === id) || null;
  }

  function latestInboundEbayMessage(messages = []) {
    return safeArray(messages)
      .slice()
      .reverse()
      .find((message) => ebayMessageDirection(message) === "inbound") || null;
  }

  function ebayMessageBodySignature(message) {
    return normalizeEbaySearchText(ebayMessageText(message)).slice(0, 500);
  }

  function ebayMessageTimeMs(message) {
    const time = Date.parse(ebayMessageCreatedAt(message) || "");
    return Number.isFinite(time) ? time : 0;
  }

  function ebayCanonicalMatchesOptimisticMessage(canonical, optimistic) {
    if (!canonical || !optimistic) return false;
    const canonicalProviderId = String(canonical.ebay_message_id || "");
    const optimisticProviderId = String(optimistic.provider_message_id || optimistic.ebay_message_id || "");
    if (canonicalProviderId && optimisticProviderId && canonicalProviderId === optimisticProviderId) return true;
    if (ebayMessageDirection(canonical) !== "outbound") return false;
    if (ebayMessageBodySignature(canonical) !== ebayMessageBodySignature(optimistic)) return false;
    const delta = Math.abs(ebayMessageTimeMs(canonical) - ebayMessageTimeMs(optimistic));
    return delta > 0 && delta < 10 * 60 * 1000;
  }

  function ebayConversationTimelineMessages(messages = [], conversation, state = adminClassificationState) {
    const canonicalMessages = safeArray(messages);
    const optimisticMessages = safeArray(state.ebayConversationOptimisticMessagesById?.[conversation?.id]);
    const visibleOptimistic = optimisticMessages.filter((optimistic) => (
      !canonicalMessages.some((canonical) => ebayCanonicalMatchesOptimisticMessage(canonical, optimistic))
    ));
    return [...canonicalMessages, ...visibleOptimistic].sort((left, right) => {
      const leftTime = ebayMessageTimeMs(left);
      const rightTime = ebayMessageTimeMs(right);
      if (leftTime !== rightTime) return leftTime - rightTime;
      return String(left.id || "").localeCompare(String(right.id || ""));
    });
  }

  function buildOptimisticSentEbayMessage(conversation, draft, payload = {}) {
    if (!conversation?.id || !draft?.id) return null;
    const sendAttempt = payload.send_attempt && typeof payload.send_attempt === "object" ? payload.send_attempt : {};
    const sendState = draft.send_state && typeof draft.send_state === "object" ? draft.send_state : {};
    const providerMessageId = payload.provider_message_id || sendAttempt.provider_message_id || sendState.provider_message_id || "";
    const sentAt = payload.sent_at || sendAttempt.sent_at || sendState.sent_at || new Date().toISOString();
    const attemptId = sendAttempt.id || sendState.latest_attempt_id || "";
    const summary = ebayConversationSummary(conversation);
    const sellerUsername = summary.seller_username || "OG / Seller";
    const recipient = ebayBuyerIdentity(conversation).username || conversation.other_party_username || "Buyer";
    const draftText = ebayDraftDisplayText(draft);
    if (!draftText) return null;

    return {
      id: `optimistic-send-${attemptId || draft.id}`,
      conversation_id: conversation.id,
      ebay_message_id: providerMessageId || `send-${attemptId || draft.id}`,
      provider_message_id: providerMessageId || null,
      send_attempt_id: attemptId || null,
      sender_username: sellerUsername,
      recipient_username: recipient,
      direction: "outbound",
      direction_confidence: "strong",
      subject: draft.subject || "",
      message_body: draftText,
      message_body_preview: compactConversationText(draftText).slice(0, 240),
      read_status: "Sent",
      is_read: true,
      message_status: "sent",
      created_at_ebay: sentAt,
      created_at: sentAt,
      has_media: false,
      media_count: 0,
      message_media: [],
      optimistic_send: true,
    };
  }

  function optimisticEbayMessagesMapWith(conversationId, message) {
    const existingMap = adminClassificationState.ebayConversationOptimisticMessagesById || {};
    const existingRows = safeArray(existingMap[conversationId]);
    if (!message?.id) return existingMap;
    return {
      ...existingMap,
      [conversationId]: [
        ...existingRows.filter((row) => String(row.id || "") !== String(message.id)),
        message,
      ].slice(-5),
    };
  }

  function clearEbayDraftActionMessageLater(conversationId, message) {
    if (!conversationId || !message) return;
    if (ebayDraftActionMessageTimers.has(conversationId)) {
      window.clearTimeout(ebayDraftActionMessageTimers.get(conversationId));
    }
    const timer = window.setTimeout(() => {
      ebayDraftActionMessageTimers.delete(conversationId);
      const current = adminClassificationState.ebayConversationDraftActionMessagesById?.[conversationId];
      if (current !== message) return;
      setEbayConversationState({
        ebayConversationDraftActionMessagesById: {
          ...adminClassificationState.ebayConversationDraftActionMessagesById,
          [conversationId]: null,
        },
      });
    }, EBAY_SEND_SUCCESS_VISIBLE_MS);
    ebayDraftActionMessageTimers.set(conversationId, timer);
  }

  function ebayDraftTargetMessage(draft, messages = []) {
    if (!draft) return null;
    return ebayMessageById(messages, draft.target_message_id) ||
      (draft.target_message && typeof draft.target_message === "object" ? draft.target_message : null);
  }

  function ebayDraftSourceLabel(draft) {
    const source = String(draft?.source_mode || "").toLowerCase();
    if (source === "operator_edit") return "Manual";
    if (source === "generate") return "AI draft";
    if (source === "regenerate") return "AI regenerate";
    if (source === "improve") return "AI improved";
    if (source === "system_fallback") return "Safe fallback";
    return humanizeValue(source || "Draft");
  }

  function ebayDraftIsSent(draft) {
    const sendState = draft?.send_state || {};
    return draft?.draft_status === "sent" || sendState.is_sent === true;
  }

  function ebayDraftCanSendWithoutApproval(draft) {
    if (!draft?.id || ebayDraftIsSent(draft)) return false;
    if (String(draft.source_mode || "").toLowerCase() === "operator_edit") return true;
    return draft.manual_send_bypass === true || draft.grounding_summary?.draft_request?.manual_send_bypass === true;
  }

  function renderEbayDraftTargetSummary(draft, messages = []) {
    const target = ebayDraftTargetMessage(draft, messages);
    if (!target) {
      return `
        <div class="ebay-reply-target is-empty">
          <span>Replying to</span>
          <strong>Target buyer message unavailable</strong>
          <p>The draft target was not returned with the saved draft payload.</p>
        </div>
      `;
    }

    return `
      <div class="ebay-reply-target">
        <span>Replying to</span>
        <strong>${escapeHtml(formatContextDate(ebayMessageCreatedAt(target)))}</strong>
        <dl>
          <div><dt>Message ID</dt><dd>${escapeHtml(ebayMessageIdentifier(target))}</dd></div>
          <div><dt>Buyer Message</dt><dd>${escapeHtml(target.sender_username || "Buyer")}</dd></div>
        </dl>
        <pre>${escapeHtml(ebayMessageText(target))}</pre>
      </div>
    `;
  }

  function ebayDraftSuccessMessage(mode, payload = {}) {
    const labels = {
      generate: "AI reply draft generated. Nothing was sent.",
      regenerate: "AI reply draft regenerated. Nothing was sent.",
      improve: "Draft improved and saved as the current suggestion. Nothing was sent.",
      save_edit: payload.created_manual_draft ? "Manual reply saved. Nothing was sent." : "Draft edits saved. Nothing was sent.",
      discard: "Draft discarded and preserved in history. Nothing was sent.",
      approve: "Draft approved as ready for controlled send. Nothing was sent.",
      unapprove: "Draft approval removed. Nothing was sent.",
      send: payload.duplicate_prevented ? (payload.message || "Duplicate send prevented. Nothing was sent twice.") : EBAY_SEND_SUCCESS_MESSAGE,
    };
    return labels[mode] || "Draft action completed. Nothing was sent.";
  }

  function ebayDraftActionErrorMessage(error, mode) {
    const code = error?.code || error?.message || "ebay_conversation_draft_action_failed";
    if (mode !== "send") return code;
    const detail = error?.detail ? ` ${error.detail}` : "";
    const provider = error?.providerResponse && typeof error.providerResponse === "object"
      ? ` Provider status: ${error.providerResponse.status || "unknown"}.`
      : "";
    return `Failed to send: ${code}.${detail}${provider} Retry guidance: verify the eBay conversation and send-attempt audit before trying again.`;
  }

  function renderEbayDraftFactRows(items = [], emptyText = "No facts listed") {
    const rows = safeArray(items);
    if (!rows.length) return `<div class="classification-empty matched-context-empty is-quiet">${escapeHtml(emptyText)}</div>`;
    return `
      <div class="ebay-draft-grounding-list">
        ${rows.slice(0, 10).map((item) => {
          const row = item && typeof item === "object" ? item : { label: String(item || ""), value: "" };
          const label = safeText(row.label || row.id, "Fact");
          const value = row.value === null || row.value === undefined || row.value === "" ? "" : `: ${String(row.value)}`;
          return `<span>${escapeHtml(label)}${escapeHtml(value)}</span>`;
        }).join("")}
      </div>
    `;
  }

  function renderEbayDraftMetadataGrid(draft) {
    const stale = draft ? stalenessState(draft) : null;
    const approval = draft?.approval || {};
    return `
      <dl class="ebay-draft-metadata-grid">
        <div><dt>Status</dt><dd>${escapeHtml(humanizeValue(draft?.draft_status || "generated"))}</dd></div>
        <div><dt>Approval</dt><dd>${escapeHtml(humanizeValue(approval.status || "not_approved"))}</dd></div>
        <div><dt>Validation</dt><dd>${escapeHtml(humanizeValue(draft?.validation_status || "not_validated"))}</dd></div>
        <div><dt>Confidence</dt><dd>${escapeHtml(draft?.confidence == null ? "--" : formatConfidence(draft.confidence))}</dd></div>
        <div><dt>Stale Status</dt><dd>${escapeHtml(stale?.message || "Draft staleness unavailable.")}</dd></div>
        <div><dt>Target Message</dt><dd>${escapeHtml(draft?.target_message_id || "Unavailable")}</dd></div>
        <div><dt>Version</dt><dd>${escapeHtml(draft?.draft_version || 1)}</dd></div>
      </dl>
    `;
  }

  function approvalActorLabel(approval = {}) {
    return approval.approved_by_email || approval.removed_by_email || approval.approved_by || approval.removed_by || "Unknown operator";
  }

  function renderEbayDraftApprovalHistory(draft) {
    const approval = draft?.approval || {};
    const history = safeArray(approval.history);
    const approved = approval.is_approved === true;
    const ready = approval.ready_to_send === true;
    return `
      <details class="ebay-draft-approval-history">
        <summary>
          <span>Approval Audit</span>
          <span class="ebay-classification-head-badges">
            ${renderBadge(approved ? "Approved" : "Not approved", approved ? "success" : "muted")}
            ${ready ? renderBadge("Ready to send", "success") : ""}
            <i data-lucide="chevron-down"></i>
          </span>
        </summary>
        <div class="ebay-draft-approval-grid">
          <div><span>Approved By</span><strong>${escapeHtml(approval.approved_by_email || approval.approved_by || "--")}</strong></div>
          <div><span>Approved At</span><strong>${escapeHtml(approval.approved_at ? formatContextDate(approval.approved_at) : "--")}</strong></div>
          <div><span>Send Key</span><strong>${escapeHtml(approval.idempotency_key ? compactId(approval.idempotency_key) : "--")}</strong></div>
        </div>
        <div class="ebay-draft-approval-list">
          ${history.length ? history.slice(0, 8).map((event) => `
            <div class="ebay-draft-approval-row">
              <strong>${escapeHtml(humanizeValue(event.approval_status || "approval_event"))}</strong>
              <span>${escapeHtml(approvalActorLabel(event))}</span>
              <time>${escapeHtml(formatContextDate(event.created_at || event.approved_at || event.removed_at))}</time>
              ${event.approval_notes || event.removal_notes ? `<p>${escapeHtml(event.approval_notes || event.removal_notes)}</p>` : ""}
            </div>
          `).join("") : `<div class="classification-empty matched-context-empty is-quiet">No approval events yet.</div>`}
        </div>
      </details>
    `;
  }

  function ebayDraftSendStatusNotice(draft) {
    const sendState = draft?.send_state || {};
    const latest = safeArray(sendState.history)[0] || null;
    if (sendState.is_sent === true) {
      return `
        <div class="classification-notice is-success ebay-send-status-notice">
          <i data-lucide="check-circle-2"></i>
          <strong>${escapeHtml(EBAY_SEND_SUCCESS_MESSAGE)}</strong>
        </div>
      `;
    }
    if (latest?.attempt_status === "failed") {
      const response = latest.provider_response && typeof latest.provider_response === "object" ? latest.provider_response : {};
      const status = response.status ? ` Provider status ${response.status}.` : "";
      return `<div class="classification-notice is-error"><strong>Failed to send.</strong> ${escapeHtml(`${latest.error_message || "Provider send failed."}${status} Retry guidance: verify the eBay conversation and send-attempt audit before trying again.`)}</div>`;
    }
    if (latest?.attempt_status === "duplicate") {
      return `<div class="classification-notice is-warning"><strong>Duplicate send prevented.</strong> ${escapeHtml(latest.error_message || "This approved draft already has a send attempt in progress or completed.")}</div>`;
    }
    if (latest?.attempt_status === "sending") {
      return `<div class="classification-notice"><strong>Sending.</strong> The send attempt is in progress in the audit ledger.</div>`;
    }
    return "";
  }

  function renderEbayDraftSendHistory(draft) {
    const sendState = draft?.send_state || {};
    const attempts = safeArray(sendState.history);
    if (!attempts.length) return "";
    const latest = attempts[0] || {};
    return `
      <details class="ebay-draft-send-history">
        <summary>
          <span>Send Audit</span>
          <span class="ebay-classification-head-badges">
            ${renderBadge(humanizeValue(sendState.status || "not_sent"), sendState.is_sent ? "success" : latest.attempt_status === "failed" ? "danger" : latest.attempt_status === "duplicate" ? "warning" : "muted")}
            <i data-lucide="chevron-down"></i>
          </span>
        </summary>
        <div class="ebay-draft-approval-grid">
          <div><span>Latest Attempt</span><strong>${escapeHtml(latest.id ? compactId(latest.id) : "--")}</strong></div>
          <div><span>Provider Message</span><strong>${escapeHtml(sendState.provider_message_id ? compactId(sendState.provider_message_id) : "--")}</strong></div>
          <div><span>Sent At</span><strong>${escapeHtml(sendState.sent_at ? formatContextDate(sendState.sent_at) : "--")}</strong></div>
        </div>
        <div class="ebay-draft-approval-list">
          ${attempts.slice(0, 8).map((attempt) => {
            const providerResponse = attempt.provider_response && typeof attempt.provider_response === "object" ? attempt.provider_response : {};
            const providerStatus = providerResponse.status ? `Provider ${providerResponse.status}` : "";
            return `
              <div class="ebay-draft-approval-row">
                <strong>${escapeHtml(humanizeValue(attempt.attempt_status || "send_attempt"))}</strong>
                <span>${escapeHtml([providerStatus, attempt.provider_message_id ? `message ${compactId(attempt.provider_message_id)}` : ""].filter(Boolean).join(" · ") || humanizeValue(attempt.provider || "provider"))}</span>
                <time>${escapeHtml(formatContextDate(attempt.created_at || attempt.sent_at))}</time>
                ${attempt.error_message ? `<p>${escapeHtml(attempt.error_message)}</p>` : ""}
              </div>
            `;
          }).join("")}
        </div>
      </details>
    `;
  }

  function renderEbayDraftGrounding(draft) {
    const grounding = draft?.grounding_summary && typeof draft.grounding_summary === "object" ? draft.grounding_summary : {};
    const factsUsed = safeArray(grounding.facts_used);
    const missing = safeArray(grounding.missing_context || draft?.missing_context);
    const safety = safeArray(grounding.safety_warnings || draft?.safety_warnings);
    const validationErrors = safeArray(draft?.validation_errors);
    const warnings = [...safety, ...validationErrors.map((item) => `Validation: ${item}`)];
    const openAttribute = adminClassificationState.ebayDraftMetadataCollapsed === true ? "" : " open";
    return `
      <details class="ebay-draft-grounding" data-ebay-detail-preference="draft-metadata"${openAttribute}>
        <summary>
          <span>AI Draft Metadata</span>
          <span class="ebay-classification-head-badges">
            ${renderBadge(`${factsUsed.length} facts`, factsUsed.length ? "category" : "muted")}
            <i data-lucide="chevron-down"></i>
          </span>
        </summary>
        ${renderEbayDraftMetadataGrid(draft)}
        <div class="ebay-draft-grounding-grid">
          <section>
            <strong>Facts Used</strong>
            ${renderEbayDraftFactRows(factsUsed, "No objective facts were used. Draft should stay general.")}
          </section>
          <section>
            <strong>Missing Context</strong>
            ${renderEbayDraftFactRows(missing, "No missing context flagged.")}
          </section>
          <section>
            <strong>Safety Notes</strong>
            ${renderEbayDraftFactRows(warnings, "No safety notes flagged.")}
          </section>
        </div>
      </details>
    `;
  }

  function ebayDraftSendBlockReason(draft, stale, approved, readyToSend, draftText) {
    const sendState = draft?.send_state || {};
    if (draft?.draft_status === "sent" || sendState.is_sent === true) return "Sent";
    if (!approved) return "Approve Draft First";
    if (stale?.isStale) return stale.message || "Draft is stale";
    if (!readyToSend) return "Send Blocked";
    if (!draft?.target_message_id) return "Target message required";
    if (!draftText) return "Draft text required";
    if (draftText.length > 2000) return "Draft exceeds eBay limit";
    return "";
  }

  function confirmEbayDraftSend(conversation, draft, messages = []) {
    const target = ebayDraftTargetMessage(draft, messages);
    const preview = ebayDraftDisplayText(draft).slice(0, 700);
    const lines = [
      "Send this message to buyer?",
      "",
      `Conversation: ${ebayConversationTitle(conversation)}`,
      `Buyer: ${ebayConversationParty(conversation)}`,
      `Target Message: ${target ? ebayMessageIdentifier(target) : "Unavailable"}`,
      "",
      "Draft Preview:",
      preview || "No draft text.",
    ];
    return window.confirm(lines.join("\n"));
  }

  function renderEbayManualComposer(conversation, messages = [], options = {}) {
    const target = options.target || latestInboundEbayMessage(messages);
    const draft = options.draft || null;
    const isActionLoading = adminClassificationState.ebayConversationDraftActionLoadingId === conversation.id;
    const error = adminClassificationState.ebayConversationDraftErrorsById?.[conversation.id] ||
      adminClassificationState.ebayConversationDraftActionErrorsById?.[conversation.id];
    const message = adminClassificationState.ebayConversationDraftActionMessagesById?.[conversation.id];
    const targetId = target?.id || "";
    const draftText = ebayDraftDisplayText(draft);
    const canAct = Boolean(targetId) && !isActionLoading;
    return `
      <section class="ebay-draft-card ebay-reply-composer is-manual">
        <div class="context-card-head">
          <h4>Message</h4>
          <span class="ebay-classification-head-badges">
            ${renderBadge("Normal chat", "success")}
          </span>
        </div>
        ${error ? `<div class="classification-notice is-error">Draft action failed: ${escapeHtml(error)}</div>` : ""}
        ${message ? `<div class="classification-notice is-success">${escapeHtml(message)}</div>` : ""}
        <form class="ebay-draft-form" data-ebay-draft-form data-ebay-composer-mode="normal" data-ebay-conversation-id="${escapeHtml(conversation.id)}" data-draft-id="${escapeHtml(draft?.id || "")}" data-ebay-target-message-id="${escapeHtml(targetId)}">
          <label class="ebay-draft-field">
            <span>Message</span>
            <textarea name="draftText" rows="4" placeholder="Type a message to the buyer..." ${isActionLoading ? "disabled" : ""}>${escapeHtml(draftText)}</textarea>
          </label>
          <label class="ebay-draft-field ebay-draft-notes-field">
            <span>Operator Notes</span>
            <input name="operatorNotes" type="text" value="${escapeHtml(draft?.operator_notes || "")}" placeholder="Optional internal note" ${isActionLoading ? "disabled" : ""} />
          </label>
          <label class="ebay-draft-field ebay-draft-instructions-field">
            <span>AI Instructions</span>
            <input name="improvementInstructions" type="text" maxlength="1000" placeholder="Optional tone or wording guidance" ${isActionLoading ? "disabled" : ""} />
          </label>
          <div class="ebay-draft-actions">
            <button type="button" class="secondary-btn" data-ebay-draft-action="improve" ${canAct ? "" : "disabled"}>
              <i data-lucide="wand-sparkles"></i>
              Improve Text
            </button>
            <button type="button" class="primary-btn" data-ebay-draft-action="send" ${canAct ? "" : "disabled"}>
              <i data-lucide="${isActionLoading ? "loader-circle" : "send"}"></i>
              ${escapeHtml(isActionLoading ? "Sending" : "Send")}
            </button>
          </div>
        </form>
      </section>
    `;
  }

  function renderEbaySentDraftReceipt(draft) {
    const sendState = draft?.send_state || {};
    const latest = safeArray(sendState.history)[0] || {};
    const sentAt = sendState.sent_at || latest.sent_at || draft?.updated_at || draft?.created_at;
    return `
      <section class="ebay-draft-card ebay-reply-composer is-sent is-sent-compact">
        <div class="ebay-sent-compact">
          <span><i data-lucide="check-circle-2"></i>${escapeHtml(EBAY_SEND_SUCCESS_MESSAGE)}</span>
          <time>${escapeHtml(sentAt ? formatContextDate(sentAt) : "Send recorded")}</time>
          ${sendState.provider_message_id ? `<b>Provider ${escapeHtml(compactId(sendState.provider_message_id))}</b>` : ""}
        </div>
      </section>
    `;
  }

  function renderEbayConversationDraftCard(conversation, messages = []) {
    const payload = ebayDraftPayload(conversation.id);
    const draft = currentEbayConversationDraft(conversation.id);
    const isLoading = adminClassificationState.ebayConversationDraftLoadingId === conversation.id;
    const isActionLoading = adminClassificationState.ebayConversationDraftActionLoadingId === conversation.id;
    const error = adminClassificationState.ebayConversationDraftErrorsById?.[conversation.id] ||
      adminClassificationState.ebayConversationDraftActionErrorsById?.[conversation.id];
    const message = adminClassificationState.ebayConversationDraftActionMessagesById?.[conversation.id];
    const stale = draft ? stalenessState(draft) : null;
    const draftText = ebayDraftDisplayText(draft);
    const approval = draft?.approval || {};
    const sendState = draft?.send_state || {};
    const approved = approval.is_approved === true;
    const readyToSend = approval.ready_to_send === true;
    const isSent = ebayDraftIsSent(draft);
    const manualSend = ebayDraftCanSendWithoutApproval(draft);
    const sendBlockReason = draft ? ebayDraftSendBlockReason(draft, stale, approved, readyToSend, draftText) : "";
    const validationVariant = draft?.validation_status === "valid"
      ? "success"
      : draft?.validation_status === "warning" ? "warning" : draft ? "muted" : "muted";

    if (isLoading && !payload) {
      return `
        <section class="ebay-draft-card ebay-reply-composer">
          <div class="context-card-head">
            <h4>Reply Composer</h4>
            ${renderBadge("Loading", "muted")}
          </div>
          <div class="classification-empty matched-context-empty is-quiet">Loading saved drafts.</div>
        </section>
      `;
    }

    if (!draft) {
      return renderEbayManualComposer(conversation, messages);
    }

    if (isSent) {
      return `${renderEbaySentDraftReceipt(draft)}${renderEbayManualComposer(conversation, messages)}`;
    }

    if (manualSend) {
      return renderEbayManualComposer(conversation, messages, { draft });
    }

    return `
      <section class="ebay-draft-card ebay-reply-composer${stale?.isStale ? " is-stale" : ""}">
        <div class="context-card-head">
          <h4>AI Reply</h4>
          <span class="ebay-classification-head-badges">
            ${renderBadge(ebayDraftSourceLabel(draft), draft.source_mode === "operator_edit" ? "success" : "category")}
            ${renderBadge(humanizeValue(draft.draft_status || "generated"), "muted")}
            ${renderBadge(humanizeValue(draft.validation_status || "not_validated"), validationVariant)}
            ${approved ? renderBadge("Approved", "success") : renderBadge("Awaiting approval", "warning")}
            ${readyToSend && !isSent ? renderBadge("Ready to send", "success") : ""}
          </span>
        </div>
        ${stale?.isStale ? renderStaleDraftWarning(draft) : ""}
        ${error ? `<div class="classification-notice is-error">Draft action failed: ${escapeHtml(error)}</div>` : ""}
        ${message ? `<div class="classification-notice is-success">${escapeHtml(message)}</div>` : ""}
        ${renderEbayDraftTargetSummary(draft, messages)}
        <form class="ebay-draft-form" data-ebay-draft-form data-ebay-composer-mode="ai_reply" data-ebay-conversation-id="${escapeHtml(conversation.id)}" data-draft-id="${escapeHtml(draft.id)}" data-ebay-target-message-id="${escapeHtml(draft.target_message_id || "")}">
          <label class="ebay-draft-field">
            <span>Message</span>
            <textarea name="draftText" rows="6" placeholder="Type a reply to the buyer..." ${isActionLoading ? "disabled" : ""}>${escapeHtml(draftText)}</textarea>
          </label>
          <label class="ebay-draft-field ebay-draft-notes-field">
            <span>Operator Notes</span>
            <input name="operatorNotes" type="text" value="${escapeHtml(draft.operator_notes || "")}" placeholder="Optional internal note" ${isActionLoading ? "disabled" : ""} />
          </label>
          <label class="ebay-draft-field ebay-draft-instructions-field">
            <span>AI Instructions</span>
            <input name="improvementInstructions" type="text" maxlength="1000" placeholder="Optional tone or wording guidance" ${isActionLoading ? "disabled" : ""} />
          </label>
          <div class="ebay-draft-actions">
            ${approved ? `
              <button type="button" class="secondary-btn" data-ebay-draft-action="unapprove" ${isActionLoading ? "disabled" : ""}>
                <i data-lucide="shield-x"></i>
                Unapprove Draft
              </button>
            ` : `
              <button type="button" class="secondary-btn" data-ebay-draft-action="approve" ${isActionLoading ? "disabled" : ""}>
                <i data-lucide="shield-check"></i>
                Approve Draft
              </button>
            `}
            ${approved && !sendBlockReason ? `
              <button type="button" class="primary-btn" data-ebay-draft-action="send" ${isActionLoading ? "disabled" : ""}>
                <i data-lucide="${isActionLoading ? "loader-circle" : "send"}"></i>
                ${escapeHtml(isActionLoading ? "Sending" : "Send")}
              </button>
            ` : `
              <button type="button" class="secondary-btn" disabled title="${escapeHtml(sendBlockReason || "Approve Draft First")}">
                <i data-lucide="lock"></i>
                ${escapeHtml(sendBlockReason || "Approve Draft First")}
              </button>
            `}
            <button type="button" class="secondary-btn" data-ebay-draft-action="improve" ${isActionLoading ? "disabled" : ""}>
              <i data-lucide="wand-sparkles"></i>
              Improve Draft
            </button>
            <button type="button" class="secondary-btn" data-ebay-draft-action="regenerate" ${isActionLoading ? "disabled" : ""}>
              <i data-lucide="refresh-cw"></i>
              Generate AI Reply
            </button>
            <button type="button" class="secondary-btn is-danger" data-ebay-draft-action="discard" ${isActionLoading ? "disabled" : ""}>
              <i data-lucide="trash-2"></i>
              Discard Draft
            </button>
          </div>
        </form>
        <div class="selected-email-meta ebay-draft-compact-state">
          <span>${escapeHtml(draft.model_name || "Model unavailable")}</span>
          <span>Version ${escapeHtml(draft.draft_version || 1)}</span>
          <span>${escapeHtml(formatContextDate(draft.updated_at || draft.created_at))}</span>
          <span>Target ${escapeHtml(draft.target_message_id ? compactId(draft.target_message_id) : "Unavailable")}</span>
          ${approved ? `<span>Approved ${escapeHtml(formatContextDate(approval.approved_at))}</span>` : ""}
        </div>
      </section>
    `;
  }

  function renderEbayConversationDetail(state) {
    if (!els.ebayConversationDetail) return;
    const conversation = selectedEbayConversationById(state.selectedEbayConversationId, state);
    if (!conversation) {
      els.ebayConversationDetail.innerHTML = `<div class="classification-empty">Select an eBay conversation to view the clean chat timeline.</div>`;
      return;
    }

    const storedMessages = safeArray(state.ebayConversationMessagesById?.[conversation.id]);
    const messages = ebayConversationTimelineMessages(storedMessages, conversation, state);
    const isLoading = state.ebayConversationMessagesLoadingId === conversation.id;
    const error = state.ebayConversationMessageErrorsById?.[conversation.id];
    const identity = ebayBuyerIdentity(conversation);
    const metaItems = ebayConversationMetaItems(conversation, 5);
    const isPlatformConversation = ebayConversationIsPlatform(conversation);

    els.ebayConversationDetail.innerHTML = `
      <div class="ebay-detail-head">
        <div>
          <span class="eyebrow">${escapeHtml(isPlatformConversation ? "Selected eBay Notification" : "Selected eBay Chat")}</span>
          <h3>${escapeHtml(isPlatformConversation ? ebayConversationTitle(conversation) : ebayConversationParty(conversation))}</h3>
          <div class="selected-email-meta">
            <span>${escapeHtml(ebayIdentitySourceLabel(identity.source))}</span>
            <span>${escapeHtml(ebayConversationTitle(conversation))}</span>
            ${metaItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
          </div>
        </div>
        <button type="button" class="secondary-btn" data-ebay-detail-action="refresh-messages" data-ebay-conversation-id="${escapeHtml(conversation.id)}" title="Deep refresh only this selected conversation and reload its timeline." ${isLoading ? "disabled" : ""}>
          <i data-lucide="${isLoading ? "loader-circle" : "refresh-cw"}"></i>
          ${escapeHtml(isLoading ? "Refreshing selected conversation" : "Refresh Timeline")}
        </button>
      </div>
      ${error ? `<div class="classification-notice is-error">Could not load eBay messages: ${escapeHtml(error)}</div>` : ""}
      ${renderEbayClassificationCard(conversation)}
      <div class="ebay-chat-timeline${isPlatformConversation ? " is-notification-timeline" : ""}" aria-label="${escapeHtml(isPlatformConversation ? "Clean eBay notification timeline" : "Clean eBay message timeline")}">
        ${isLoading && !messages.length ? `<div class="classification-empty">Loading clean eBay ${escapeHtml(isPlatformConversation ? "notifications" : "chat messages")}.</div>` : ""}
        ${messages.length ? messages.map((message) => renderEbayMessageBubble(message, conversation)).join("") : (!isLoading ? `<div class="classification-empty">No canonical eBay ${escapeHtml(isPlatformConversation ? "notifications" : "messages")} are stored for this conversation yet.</div>` : "")}
      </div>
      ${isPlatformConversation ? "" : renderEbayConversationDraftCard(conversation, messages)}
    `;
  }

  function renderInventoryContextCard(inventory = []) {
    const rows = safeArray(inventory);
    return `
      <section class="context-card">
        <div class="context-card-head">
          <h4>Inventory / Listing Context</h4>
          ${renderBadge(`${rows.length} ${rows.length === 1 ? "link" : "links"}`, rows.length ? "category" : "muted")}
        </div>
        ${rows.length ? `
          <div class="context-row-list">
            ${rows.map((link) => `
              <div class="context-row">
                ${renderContextFactGrid([
                  { label: "SKU", value: link.sku || "Unavailable" },
                  { label: "Listing ID", value: link.listing_id || "Unavailable" },
                  { label: "Offer ID", value: link.offer_id || "Unavailable" },
                  { label: "Status", value: link.status || "Unknown" },
                  { label: "Last Synced", value: formatContextDate(link.last_synced_at) },
                  { label: "Updated", value: formatContextDate(link.updated_at) },
                ])}
              </div>
            `).join("")}
          </div>
        ` : `<div class="classification-empty matched-context-empty is-quiet">No inventory or listing bridge context found.</div>`}
      </section>
    `;
  }

  function renderEbayConversationContextPanel(state) {
    if (!els.ebayConversationContext) return;
    const conversation = selectedEbayConversationById(state.selectedEbayConversationId, state);
    if (!conversation) {
      els.ebayConversationContext.innerHTML = `<div class="classification-empty">Select a conversation to view buyer, order, return, and listing context.</div>`;
      return;
    }

    const payload = state.ebayConversationContextsById?.[conversation.id] || null;
    const context = contextFromEbayPayload(payload);
    const isLoading = state.ebayConversationContextLoadingId === conversation.id;
    const error = state.ebayConversationContextErrorsById?.[conversation.id];
    const linkConfidence = context?.link_confidence || {};

    els.ebayConversationContext.innerHTML = `
      <div class="ebay-context-head">
        <div>
          <span class="eyebrow">Business Context</span>
          <h3>Buyer / Order Context</h3>
        </div>
        <button type="button" class="secondary-btn" data-ebay-detail-action="refresh-context" data-ebay-conversation-id="${escapeHtml(conversation.id)}" ${isLoading ? "disabled" : ""}>
          <i data-lucide="${isLoading ? "loader-circle" : "refresh-cw"}"></i>
          ${escapeHtml(isLoading ? "Loading" : "Refresh Context")}
        </button>
      </div>
      ${error ? `<div class="classification-notice is-error">Could not load eBay context: ${escapeHtml(error)}</div>` : ""}
      ${isLoading && !context ? `<div class="classification-empty">Loading linked buyer and order context.</div>` : ""}
      ${context ? `
        <section class="context-card ebay-link-confidence-card">
          <div class="context-card-head">
            <h4>Link Confidence</h4>
            ${renderBadge(humanizeValue(linkConfidence.level || "none"), contextConfidenceVariant(linkConfidence.level))}
          </div>
          ${renderContextFactGrid([
            { label: "Confirmed Links", value: formatContextNumber(linkConfidence.confirmed_links) },
            { label: "Suggested Links", value: formatContextNumber(linkConfidence.suggested_links) },
            { label: "Active Links", value: formatContextNumber(linkConfidence.total_active_links) },
            { label: "Max Confidence", value: linkConfidence.max_confidence == null ? "--" : formatConfidence(linkConfidence.max_confidence) },
          ])}
        </section>
        <div class="stored-context-grid ebay-context-grid">
          ${renderBuyerSummaryCard(context)}
          ${renderOrderContextCard(context.matched_orders)}
          ${renderOrderLineContextCard(context.matched_order_lines)}
          ${renderReturnContextCard(context.matched_returns)}
          ${renderBuyerValueLinesCard(context.buyer_value_line_breakdown)}
          ${renderInventoryContextCard(context.inventory_listing_context)}
        </div>
        ${renderWarningPanel([], context.warnings)}
      ` : (!isLoading ? `<div class="classification-empty">No context payload is loaded for this conversation yet.</div>` : "")}
    `;
  }

  function classificationMetricValue(source = {}, keys = [], fallback = 0) {
    for (const key of keys) {
      const value = Number(source?.[key]);
      if (Number.isFinite(value)) return value;
    }
    return fallback;
  }

  function renderEbaySyncResult(state) {
    if (!els.ebayConversationSyncResult) return;
    const result = state.ebayConversationSyncResult;
    const error = state.ebayConversationSyncError;
    const classificationResult = state.ebayConversationClassificationResult;
    if (classificationResult?.reconciling === true) {
      els.ebayConversationSyncResult.innerHTML = `
        <div class="classification-notice is-warning">
          <strong>Classification request timed out.</strong>
          Checking latest classification results...
        </div>
      `;
      return;
    }
    if (state.ebayConversationClassificationBatchLoading) {
      els.ebayConversationSyncResult.innerHTML = `<div class="classification-notice">Classification batch is running. This writes OG classification records only and targets the current bounded queue.</div>`;
      return;
    }
    if (classificationResult) {
      const modeLabel = classificationResult.force === true ? `Reclassify recent ${EBAY_RECLASSIFY_RECENT_LIMIT} conversations` : "Classify unclassified conversations";
      const rows = safeArray(classificationResult.results || classificationResult.data?.results);
      const requested = classificationMetricValue(classificationResult, ["requested"], classificationResult.force === true ? EBAY_RECLASSIFY_RECENT_LIMIT : rows.length);
      const examined = classificationMetricValue(classificationResult, ["candidates_examined", "processed"], rows.length);
      const classified = classificationMetricValue(classificationResult, ["actually_classified", "classified_count", "succeeded"], 0);
      const failed = classificationMetricValue(classificationResult, ["failed_count", "failed"], 0);
      const skippedCount = classificationMetricValue(classificationResult, ["skipped_count", "skipped"], 0);
      const remainingUnclassified = classificationMetricValue(
        classificationResult,
        ["remaining_unclassified", "unclassified_after"],
        ebayMailboxCountValue(ebayMailboxSmartCounts(state).unclassified, 0),
      );
      const timedOut = classificationResult.timed_out === true;
      const noticeClass = timedOut ? "is-warning" : failed > 0 ? "is-warning" : "is-success";
      const skipped = rows.filter((row) => row.skipped === true);
      const skippedReasons = skipped.reduce((map, row) => {
        const reason = row.skip_reason || "skipped";
        map[reason] = (map[reason] || 0) + 1;
        return map;
      }, {});
      const failedRows = rows.filter((row) => row.ok === false && row.skipped !== true);
      els.ebayConversationSyncResult.innerHTML = `
        <div class="classification-notice ${escapeHtml(noticeClass)}">
          <strong>${escapeHtml(timedOut ? "Classification request timed out; durable state refreshed." : `${modeLabel} finished.`)}</strong>
          ${classificationResult.force === true ? `Bounded scope requested: ${escapeHtml(formatContextNumber(requested))};` : ""}
          Candidates examined: ${escapeHtml(formatContextNumber(examined))};
          actually classified: ${escapeHtml(formatContextNumber(classified))};
          skipped already classified: ${escapeHtml(formatContextNumber(skippedCount))};
          failed: ${escapeHtml(formatContextNumber(failed))};
          remaining unclassified: ${escapeHtml(formatContextNumber(remainingUnclassified))}.
        </div>
        ${timedOut ? `<div class="classification-notice">Checked durable classification run state, mailbox counts, and operational events before showing this summary.</div>` : ""}
        ${Object.keys(skippedReasons).length ? `
          <div class="inbox-skipped-reasons">
            ${Object.entries(skippedReasons).map(([reason, count]) => `<b>${escapeHtml(humanizeValue(reason))} <em>${escapeHtml(count)}</em></b>`).join("")}
          </div>
        ` : ""}
        ${failedRows.length ? `
          <details class="inbox-result-details">
            <summary>Classification failures</summary>
            <div class="inbox-skipped-reasons">
              ${failedRows.slice(0, 8).map((row) => `<b>${escapeHtml(compactId(row.conversation_id || ""))}: <em>${escapeHtml(humanizeValue(row.error || "failed"))}</em></b>`).join("")}
            </div>
          </details>
        ` : ""}
      `;
      return;
    }
    if (!result && !error && !state.ebayConversationSyncLoading) {
      els.ebayConversationSyncResult.innerHTML = "";
      return;
    }
    if (state.ebayConversationSyncLoading) {
      const operation = state.ebayConversationSyncOperation || {};
      const runningText = operation.target === "timeline_refresh"
        ? "Running selected-conversation deep refresh. This updates only the open conversation timeline."
        : operation.runType === "backfill"
        ? "Running historical archive backfill chunk. This imports a bounded archive chunk and records durable checkpoint progress."
        : "Running recent mailbox scan. This is an incremental, limited latest-scope sync, not a full archive refresh.";
      els.ebayConversationSyncResult.innerHTML = `<div class="classification-notice">${escapeHtml(runningText)}</div>`;
      return;
    }
    if (error) {
      els.ebayConversationSyncResult.innerHTML = `<div class="classification-notice is-error">eBay sync failed: ${escapeHtml(error)}</div>`;
      return;
    }
    if (result?.requestTimedOut === true && result?.durable_run_found !== true) {
      els.ebayConversationSyncResult.innerHTML = `
        <div class="classification-notice is-warning">
          <strong>eBay operation request timed out.</strong>
          Refreshed mailbox counts and operational dashboard state from the database.
        </div>
      `;
      return;
    }
    const counters = result?.counters || {};
    const warnings = safeArray(counters.warnings);
    const isBackfill = result?.runType === "backfill";
    const isTargetedRefresh = Boolean(result?.targeted_conversation_id || result?.targeted_ebay_conversation_id);
    const classificationMode = result?.classificationMode || "none";
    const progress = result?.backfillProgress && typeof result.backfillProgress === "object" ? result.backfillProgress : null;
    const progressStatus = String(progress?.status || "");
    const backfillComplete = progress?.completed === true || progressStatus === "completed";
    const estimatedPages = progress?.estimated_total_pages ?? null;
    const pagesProcessed = progress?.pages_processed ?? counters.pagesFetched ?? 0;
    const pagesRemaining = progress?.pages_remaining ?? null;
    const completionLabel = isTargetedRefresh
      ? "Selected conversation refresh finished; timeline and drafts were reloaded for this conversation"
      : isBackfill
      ? (backfillComplete ? "Historical archive backfill complete" : "Archive backfill chunk finished; click again to continue")
      : "Recent mailbox scan finished; incremental sync covered a limited latest scope";
    const canonicalTotal = result?.canonicalTotalConversations ?? result?.canonical_total_conversations ?? null;
    const messagesSeen = Number(counters.messagesSeen || counters.messages_processed || 0);
    const messagesInserted = Number(counters.messagesInserted ?? counters.messages_inserted ?? 0);
    const messagesChanged = Number(counters.messagesUpdated ?? counters.messages_updated ?? 0);
    const classificationSucceeded = Number(counters.classificationSucceeded ?? counters.classification_succeeded ?? result?.classification_succeeded ?? 0);
    const classificationFailed = Number(counters.classificationFailed ?? counters.classification_failed ?? result?.classification_failed ?? 0);
    const classificationSkipped = Number(counters.classificationSkipped ?? counters.classification_skipped ?? result?.classification_skipped ?? 0);
    const messagesRechecked = Number(
      counters.messagesRechecked ??
      counters.messages_rechecked ??
      result?.messages_rechecked ??
      Math.max(messagesSeen - messagesInserted, 0)
    );
    const recovered = result?.requestTimedOut === true && result?.durable_run_found === true;
    const lifecycleStatus = String(result?.status || "").toLowerCase();
    const noticeClass = lifecycleStatus === "failed"
      ? "is-error"
      : lifecycleStatus === "partial_success" || classificationFailed > 0 || warnings.length || Number(counters.errors || 0) > 0
      ? "is-warning"
      : "is-success";
    els.ebayConversationSyncResult.innerHTML = `
      <div class="classification-notice ${escapeHtml(noticeClass)}">
        ${escapeHtml(recovered ? `${completionLabel}; durable run state recovered after browser timeout` : completionLabel)}.
        Run id: ${escapeHtml(result?.runId ? compactId(result.runId) : "--")};
        Conversations seen: ${escapeHtml(formatContextNumber(counters.conversationsSeen))};
        inserted: ${escapeHtml(formatContextNumber(counters.conversationsInserted || 0))};
        updated: ${escapeHtml(formatContextNumber(counters.conversationsUpdated || 0))};
        unchanged: ${escapeHtml(formatContextNumber(counters.conversationsUnchanged || 0))};
        skipped: ${escapeHtml(formatContextNumber(counters.conversationsSkipped || 0))};
        messages scanned: ${escapeHtml(formatContextNumber(messagesSeen))};
        existing messages rechecked: ${escapeHtml(formatContextNumber(messagesRechecked))};
        messages inserted: ${escapeHtml(formatContextNumber(messagesInserted))};
        messages changed: ${escapeHtml(formatContextNumber(messagesChanged))};
        canonical total: ${escapeHtml(canonicalTotal === null || canonicalTotal === undefined ? "--" : formatContextNumber(canonicalTotal))};
        pages: ${escapeHtml(formatContextNumber(counters.pagesFetched || 0))};
        classification: ${escapeHtml(humanizeValue(classificationMode))};
        classified: ${escapeHtml(formatContextNumber(classificationSucceeded))};
        classification failed: ${escapeHtml(formatContextNumber(classificationFailed))};
        classification skipped: ${escapeHtml(formatContextNumber(classificationSkipped))};
        remaining unclassified: ${escapeHtml(result?.remainingUnclassified === null || result?.remainingUnclassified === undefined ? "--" : formatContextNumber(result.remainingUnclassified))};
        warnings: ${escapeHtml(formatContextNumber(warnings.length || counters.errors || 0))}.
      </div>
      ${recovered ? `<div class="classification-notice">Checked durable sync run state, latest activity event, mailbox counts, and checkpoint counters before showing this summary.</div>` : ""}
      ${isBackfill && progress ? `
        <div class="inbox-skipped-reasons">
          <b>Status <em>${escapeHtml(humanizeValue(progressStatus || "paused"))}</em></b>
          <b>Pages <em>${escapeHtml(`${formatContextNumber(pagesProcessed)}${estimatedPages === null || estimatedPages === undefined ? "" : ` / ${formatContextNumber(estimatedPages)}`}`)}</em></b>
          <b>Remaining <em>${escapeHtml(pagesRemaining === null || pagesRemaining === undefined ? "--" : formatContextNumber(pagesRemaining))}</em></b>
          <b>Conversations imported <em>${escapeHtml(formatContextNumber(progress.conversations_imported || 0))}</em></b>
          <b>Messages imported <em>${escapeHtml(formatContextNumber(progress.messages_imported || 0))}</em></b>
        </div>
      ` : ""}
      ${warnings.length ? renderWarningPanel([], warnings.slice(0, 6)) : ""}
    `;
  }

  function renderEbayConversationInbox(state) {
    if (!els.ebayConversationList || !els.ebayConversationDetail || !els.ebayConversationContext) return;

    if (els.ebayConversationStatus) {
      if (state.ebayConversationLoading) {
        els.ebayConversationStatus.textContent = "Loading canonical eBay conversations.";
      } else if (state.ebayMailboxWarning) {
        els.ebayConversationStatus.textContent = `DEGRADED MODE: ${state.ebayMailboxWarning} Loaded ${safeArray(state.ebayConversations).length} conversations at ${formatDateTime(state.ebayConversationLastLoadedAt)}.`;
      } else if (state.ebayConversationError) {
        els.ebayConversationStatus.textContent = `eBay conversation load failed: ${state.ebayConversationError}`;
      } else if (state.ebayConversationLastLoadedAt) {
        const page = ebayMailboxPageInfo(state);
        const canonical = page.canonical_total === null ? "" : ` Canonical total: ${formatContextNumber(page.canonical_total)}.`;
        els.ebayConversationStatus.textContent = `Loaded ${safeArray(state.ebayConversations).length} canonical eBay conversations at ${formatDateTime(state.ebayConversationLastLoadedAt)}.${canonical}`;
      } else {
        els.ebayConversationStatus.textContent = "Canonical eBay inbox is ready to load.";
      }
    }

    [
      els.ebayConversationRefresh,
      els.ebayConversationSync,
      els.ebayConversationBackfill,
      els.ebayConversationBackfillClassifyNew,
      els.ebayConversationBackfillReclassifyAll,
      els.ebayConversationClassifyRecent,
      els.ebayConversationReclassifyAll,
    ].forEach((button) => {
      if (!button) return;
      const busy = state.ebayConversationLoading || state.ebayConversationLoadingMore || state.ebayConversationSyncLoading || state.ebayConversationClassificationBatchLoading;
      button.disabled = busy;
      button.setAttribute("aria-busy", busy ? "true" : "false");
      button.classList.toggle("is-loading", busy);
    });

    if (els.ebayConversationLoadMore) {
      const page = ebayMailboxPageInfo(state);
      const busy = state.ebayConversationLoading || state.ebayConversationLoadingMore || state.ebayConversationSyncLoading || state.ebayConversationClassificationBatchLoading;
      const remaining = page.matching_total === null ? null : Math.max(0, page.matching_total - safeArray(state.ebayConversations).length);
      els.ebayConversationLoadMore.hidden = page.has_more !== true;
      els.ebayConversationLoadMore.disabled = busy || page.has_more !== true;
      els.ebayConversationLoadMore.setAttribute("aria-busy", state.ebayConversationLoadingMore ? "true" : "false");
      els.ebayConversationLoadMore.classList.toggle("is-loading", state.ebayConversationLoadingMore === true);
      els.ebayConversationLoadMore.innerHTML = `
        <i data-lucide="${state.ebayConversationLoadingMore ? "loader-2" : "chevrons-down"}"></i>
        ${state.ebayConversationLoadingMore ? "Loading more" : `Load more${remaining === null ? "" : ` (${formatContextNumber(remaining)} remaining)`}`}
      `;
    }

    renderEbaySavedViews(state);

    const searchQuery = state.ebayConversationSearchQuery || "";
    if (els.ebayConversationSearch && document.activeElement !== els.ebayConversationSearch && els.ebayConversationSearch.value !== searchQuery) {
      els.ebayConversationSearch.value = searchQuery;
    }
    if (els.ebayConversationSearchClear) {
      els.ebayConversationSearchClear.disabled = !compactConversationText(searchQuery);
    }
    els.ebayConversationSearch?.closest(".ebay-conversation-search")?.classList.toggle("has-query", Boolean(compactConversationText(searchQuery)));
    els.ebayConversationDensityInputs?.forEach((input) => {
      input.checked = input.value === (state.ebayConversationDensityMode || "compact");
    });

    renderEbayClassificationFilterPanel(state);
    renderEbaySyncResult(state);
    applyEbayWorkspacePanelVisibility(state.ebayConversationPanelVisibility);
    renderEbayConversationSummary(state);
    renderEbayConversationList(state);
    renderEbayConversationDetail(state);
    renderEbayConversationContextPanel(state);
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  async function loadEbayConversationMessages(context, conversationId, options = {}) {
    if (!conversationId) return;
    if (!options.force && adminClassificationState.ebayConversationMessagesById?.[conversationId]) return;
    setEbayConversationState({
      ebayConversationMessagesLoadingId: conversationId,
      ebayConversationMessageErrorsById: {
        ...adminClassificationState.ebayConversationMessageErrorsById,
        [conversationId]: null,
      },
    });

    try {
      const payload = await fetchEbayConversationMessages(context, conversationId);
      setEbayConversationState({
        ebayConversationMessagesLoadingId: null,
        ebayConversationMessagesById: {
          ...adminClassificationState.ebayConversationMessagesById,
          [conversationId]: normalizeEbayMessagesForReadState(conversationId, payload.messages),
        },
        ebayConversationMessageErrorsById: {
          ...adminClassificationState.ebayConversationMessageErrorsById,
          [conversationId]: null,
        },
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_messages_failed";
      setEbayConversationState({
        ebayConversationMessagesLoadingId: null,
        ebayConversationMessageErrorsById: {
          ...adminClassificationState.ebayConversationMessageErrorsById,
          [conversationId]: code,
        },
      });
      console.error("[email-triage] eBay conversation messages failed:", error);
    }
  }

  function ebayConversationTypeForSync(conversation) {
    const type = String(conversation?.conversation_type || conversation?.raw?.conversation_type || "").toUpperCase();
    return ["FROM_MEMBERS", "FROM_EBAY"].includes(type) ? type : "";
  }

  async function refreshEbayConversationTimeline(context, conversationId) {
    const conversation = selectedEbayConversationById(conversationId, adminClassificationState);
    if (!conversation?.id) return;
    const ebayConversationId = compactConversationText(conversation.ebay_conversation_id);
    if (!ebayConversationId) {
      setEbayConversationState({
        ebayConversationMessageErrorsById: {
          ...adminClassificationState.ebayConversationMessageErrorsById,
          [conversation.id]: "ebay_conversation_id_required",
        },
      });
      return;
    }

    setEbayConversationState({
      ebayConversationMessagesLoadingId: conversation.id,
      ebayConversationSyncLoading: true,
      ebayConversationSyncOperation: {
        runType: "manual",
        classificationMode: "none",
        target: "timeline_refresh",
      },
      ebayConversationSyncResult: null,
      ebayConversationSyncError: null,
      ebayConversationMessageErrorsById: {
        ...adminClassificationState.ebayConversationMessageErrorsById,
        [conversation.id]: null,
      },
    });

    try {
      const conversationType = ebayConversationTypeForSync(conversation);
      const syncPayload = await runEbayMessageSync(context, {
        conversationId: ebayConversationId,
        conversationTypes: conversationType ? [conversationType] : ["FROM_MEMBERS", "FROM_EBAY"],
        conversationPageLimit: 1,
        messagePageLimit: 50,
        maxConversationPages: 1,
        maxDetailPagesPerConversation: 20,
      });
      const listRequest = ebayMailboxFetchValuesFromState(adminClassificationState, { limit: 100, offset: 0 });
      const [messagesPayload, draftsPayload, listPayload] = await Promise.all([
        fetchEbayConversationMessages(context, conversation.id),
        fetchEbayConversationDrafts(context, conversation.id),
        fetchEbayConversations(context, listRequest),
      ]);
      const conversations = safeArray(listPayload.conversations);
      const mailboxState = ebayMailboxStateFromPayload(listPayload, conversations);
      const selectedStillLoaded = conversations.some((row) => row.id === conversation.id);
      setEbayConversationState({
        ebayConversationMessagesLoadingId: null,
        ebayConversationSyncLoading: false,
        ebayConversationSyncOperation: null,
        ebayConversations: conversations.length ? conversations : adminClassificationState.ebayConversations,
        selectedEbayConversationId: selectedStillLoaded ? conversation.id : adminClassificationState.selectedEbayConversationId,
        ebayConversationLastLoadedAt: listPayload.loaded_at || new Date().toISOString(),
        ...mailboxState,
        ebayConversationMessagesById: {
          ...adminClassificationState.ebayConversationMessagesById,
          [conversation.id]: normalizeEbayMessagesForReadState(conversation.id, messagesPayload.messages),
        },
        ebayConversationDraftsById: {
          ...adminClassificationState.ebayConversationDraftsById,
          [conversation.id]: draftsPayload,
        },
        ebayConversationMessageErrorsById: {
          ...adminClassificationState.ebayConversationMessageErrorsById,
          [conversation.id]: null,
        },
        ebayConversationSyncResult: {
          ...syncPayload,
          targeted_conversation_id: conversation.id,
          targeted_ebay_conversation_id: ebayConversationId,
        },
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_timeline_refresh_failed";
      setEbayConversationState({
        ebayConversationMessagesLoadingId: null,
        ebayConversationSyncLoading: false,
        ebayConversationSyncOperation: null,
        ebayConversationMessageErrorsById: {
          ...adminClassificationState.ebayConversationMessageErrorsById,
          [conversation.id]: code,
        },
        ebayConversationSyncError: code,
      });
      console.error("[email-triage] eBay targeted timeline refresh failed:", error);
    }
  }

  async function loadEbayConversationContext(context, conversationId, options = {}) {
    if (!conversationId) return;
    if (!options.force && adminClassificationState.ebayConversationContextsById?.[conversationId]) return;
    setEbayConversationState({
      ebayConversationContextLoadingId: conversationId,
      ebayConversationContextErrorsById: {
        ...adminClassificationState.ebayConversationContextErrorsById,
        [conversationId]: null,
      },
    });

    try {
      const payload = await fetchEbayConversationContext(context, conversationId);
      setEbayConversationState({
        ebayConversationContextLoadingId: null,
        ebayConversationContextsById: {
          ...adminClassificationState.ebayConversationContextsById,
          [conversationId]: payload,
        },
        ebayConversationContextErrorsById: {
          ...adminClassificationState.ebayConversationContextErrorsById,
          [conversationId]: null,
        },
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_context_failed";
      setEbayConversationState({
        ebayConversationContextLoadingId: null,
        ebayConversationContextErrorsById: {
          ...adminClassificationState.ebayConversationContextErrorsById,
          [conversationId]: code,
        },
      });
      console.error("[email-triage] eBay conversation context failed:", error);
    }
  }

  async function loadEbayConversationDrafts(context, conversationId, options = {}) {
    if (!conversationId) return;
    if (!options.force && adminClassificationState.ebayConversationDraftsById?.[conversationId]) return;
    setEbayConversationState({
      ebayConversationDraftLoadingId: conversationId,
      ebayConversationDraftErrorsById: {
        ...adminClassificationState.ebayConversationDraftErrorsById,
        [conversationId]: null,
      },
    });

    try {
      const payload = await fetchEbayConversationDrafts(context, conversationId);
      setEbayConversationState({
        ebayConversationDraftLoadingId: null,
        ebayConversationDraftsById: {
          ...adminClassificationState.ebayConversationDraftsById,
          [conversationId]: payload,
        },
        ebayConversationDraftErrorsById: {
          ...adminClassificationState.ebayConversationDraftErrorsById,
          [conversationId]: null,
        },
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_drafts_failed";
      setEbayConversationState({
        ebayConversationDraftLoadingId: null,
        ebayConversationDraftErrorsById: {
          ...adminClassificationState.ebayConversationDraftErrorsById,
          [conversationId]: code,
        },
      });
      console.error("[email-triage] eBay conversation drafts failed:", error);
    }
  }

  async function markEbayConversationReadLocally(context, conversationId) {
    if (!conversationId) return;
    const conversation = selectedEbayConversationById(conversationId, adminClassificationState);
    if (Number(conversation?.unread_count || 0) <= 0) return;
    setEbayConversationState(ebayConversationStateMarkedRead(conversationId));
    try {
      await markEbayConversationRead(context, conversationId);
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_mark_read_failed";
      setEbayConversationState({
        ebayConversationMessageErrorsById: {
          ...adminClassificationState.ebayConversationMessageErrorsById,
          [conversationId]: code,
        },
      });
      console.error("[email-triage] eBay conversation mark read failed:", error);
    }
  }

  async function runEbayConversationDraftAction(context, values = {}) {
    const conversationId = values.conversationId;
    if (!conversationId || !values.mode) return;
    setEbayConversationState({
      ebayConversationDraftActionLoadingId: conversationId,
      ebayConversationDraftActionErrorsById: {
        ...adminClassificationState.ebayConversationDraftActionErrorsById,
        [conversationId]: null,
      },
      ebayConversationDraftActionMessagesById: {
        ...adminClassificationState.ebayConversationDraftActionMessagesById,
        [conversationId]: null,
      },
    });

    try {
      const isSend = values.mode === "send";
      const payload = await requestEbayConversationDraftAction(context, values);
      if (isSend) {
        await loadEbayConversationMessages(context, conversationId, { force: true }).catch((loadError) => {
          console.error("[email-triage] eBay conversation messages reload after send failed:", loadError);
        });
      }
      await loadEbayConversationDrafts(context, conversationId, { force: true });
      if (isSend) {
        const conversation = selectedEbayConversationById(conversationId, adminClassificationState);
        const draft = currentEbayConversationDraft(conversationId) ||
          (payload.current_draft && typeof payload.current_draft === "object" ? payload.current_draft : null);
        const optimisticMessage = payload.duplicate_prevented ? null : buildOptimisticSentEbayMessage(conversation, draft, payload);
        if (optimisticMessage) {
          setEbayConversationState({
            ebayConversationOptimisticMessagesById: optimisticEbayMessagesMapWith(conversationId, optimisticMessage),
          });
        }
        loadOperationalDashboard(context, { keepPrevious: true });
      }
      const successMessage = ebayDraftSuccessMessage(values.mode, payload);
      setEbayConversationState({
        ebayConversationDraftActionLoadingId: null,
        ebayConversationDraftActionErrorsById: {
          ...adminClassificationState.ebayConversationDraftActionErrorsById,
          [conversationId]: null,
        },
        ebayConversationDraftActionMessagesById: {
          ...adminClassificationState.ebayConversationDraftActionMessagesById,
          [conversationId]: successMessage,
        },
      });
      if (isSend && !payload.duplicate_prevented) clearEbayDraftActionMessageLater(conversationId, successMessage);
    } catch (error) {
      const code = ebayDraftActionErrorMessage(error, values.mode);
      if (values.mode === "send") {
        await loadEbayConversationDrafts(context, conversationId, { force: true }).catch((loadError) => {
          console.error("[email-triage] eBay conversation drafts reload after send failure failed:", loadError);
        });
        loadOperationalDashboard(context, { keepPrevious: true });
      }
      setEbayConversationState({
        ebayConversationDraftActionLoadingId: null,
        ebayConversationDraftActionErrorsById: {
          ...adminClassificationState.ebayConversationDraftActionErrorsById,
          [conversationId]: code,
        },
      });
      console.error("[email-triage] eBay conversation draft action failed:", error);
    }
  }

  async function selectEbayConversation(context, conversationId) {
    if (!conversationId) return;
    setEbayConversationState({ selectedEbayConversationId: conversationId });
    markEbayConversationReadLocally(context, conversationId);
    loadEbayConversationMessages(context, conversationId);
    loadEbayConversationContext(context, conversationId);
    loadEbayConversationDrafts(context, conversationId);
  }

  async function loadEbayConversationList(context, options = {}) {
    if (ebayConversationReloadTimer) {
      window.clearTimeout(ebayConversationReloadTimer);
      ebayConversationReloadTimer = null;
    }
    const append = options.append === true;
    const currentState = adminClassificationState;
    const currentPage = ebayMailboxPageInfo(currentState);
    const offset = append
      ? Number.isFinite(Number(currentPage.next_offset)) ? Number(currentPage.next_offset) : safeArray(currentState.ebayConversations).length
      : 0;
    if (append && currentPage.has_more !== true) return;

    setEbayConversationState({
      ebayConversationLoading: append ? adminClassificationState.ebayConversationLoading : true,
      ebayConversationLoadingMore: append,
      ebayConversationError: null,
      ebayConversationClassificationResult: options.preserveClassificationResult === true
        ? adminClassificationState.ebayConversationClassificationResult
        : null,
    });

    try {
      const request = ebayMailboxFetchValuesFromState(currentState, {
        limit: options.limit || currentPage.page_size || 100,
        offset,
      });
      const payload = await fetchEbayConversations(context, request);
      const pageConversations = safeArray(payload.conversations);
      const conversations = append
        ? mergeEbayConversationPages(currentState.ebayConversations, pageConversations)
        : pageConversations;
      const mailboxState = ebayMailboxStateFromPayload(payload, conversations);
      const previousSelectedId = options.preserveSelectionId || currentState.selectedEbayConversationId;
      const visibleRows = filteredEbayConversations({
        ...adminClassificationState,
        ...mailboxState,
        ebayConversations: conversations,
      });
      const selectedStillVisible = visibleRows.some((conversation) => conversation.id === previousSelectedId);
      const selectedEbayConversationId = selectedStillVisible ? previousSelectedId : visibleRows[0]?.id || null;
      setEbayConversationState({
        ebayConversationLoading: false,
        ebayConversationLoadingMore: false,
        ebayConversationError: null,
        ebayConversations: conversations,
        selectedEbayConversationId,
        ebayConversationLastLoadedAt: payload.loaded_at || new Date().toISOString(),
        ...mailboxState,
      });
      if (selectedEbayConversationId && (!append || selectedEbayConversationId !== previousSelectedId || options.forceSelectionReload === true)) {
        loadEbayConversationMessages(context, selectedEbayConversationId);
        loadEbayConversationContext(context, selectedEbayConversationId);
        loadEbayConversationDrafts(context, selectedEbayConversationId, { force: true });
      }
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_list_failed";
      setEbayConversationState({
        ebayConversationLoading: false,
        ebayConversationLoadingMore: false,
        ebayConversationError: code,
      });
      console.error("[email-triage] eBay conversation list failed:", error);
    }
  }

  function scheduleEbayConversationListReload(context, options = {}) {
    if (ebayConversationReloadTimer) window.clearTimeout(ebayConversationReloadTimer);
    const delay = Number(options.delay || 0);
    ebayConversationReloadTimer = window.setTimeout(() => {
      ebayConversationReloadTimer = null;
      loadEbayConversationList(context, {
        limit: options.limit || 100,
        forceSelectionReload: options.forceSelectionReload === true,
      });
    }, Math.max(delay, 0));
  }

  async function loadEbayConversationSavedViews(context) {
    setEbayConversationState({
      ebayConversationSavedViewsLoading: true,
      ebayConversationSavedViewsError: null,
    });

    try {
      const payload = await fetchEbayConversationSavedViews(context);
      setEbayConversationState({
        ebayConversationSavedViewsLoading: false,
        ebayConversationSavedViewsError: null,
        ebayConversationSavedViews: safeArray(payload.saved_views),
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_saved_views_failed";
      setEbayConversationState({
        ebayConversationSavedViewsLoading: false,
        ebayConversationSavedViewsError: code,
        ebayConversationSavedViews: defaultEbayConversationSavedViews(),
      });
      console.error("[email-triage] eBay saved views failed:", error);
    }
  }

  function replaceEbayConversationSavedView(savedView) {
    const rows = safeArray(adminClassificationState.ebayConversationSavedViews);
    if (!savedView?.id) return rows;
    const exists = rows.some((view) => view.id === savedView.id);
    const next = exists
      ? rows.map((view) => (view.id === savedView.id ? savedView : view))
      : [...rows, savedView];
    return next
      .filter((view) => view.is_active !== false && !view.deleted_at)
      .sort((a, b) => (Number(a.sort_order || 100) - Number(b.sort_order || 100)) || String(a.name || "").localeCompare(String(b.name || "")));
  }

  async function createSmartFolderFromCurrentFilters(context) {
    const name = window.prompt("Smart folder name?");
    if (!compactConversationText(name)) return;
    setEbayConversationState({
      ebayConversationSavedViewSavingId: "create",
      ebayConversationSavedViewActionError: null,
    });

    try {
      const result = await createEbayConversationSavedView(context, {
        name,
        filterPayload: ebayCurrentSavedViewPayload(adminClassificationState),
      });
      const savedView = result.saved_view || result.data?.saved_view;
      setEbayConversationState({
        ebayConversationSavedViewSavingId: null,
        ebayConversationSavedViewActionError: null,
        ebayConversationSavedViews: replaceEbayConversationSavedView(savedView),
        selectedEbaySavedViewId: savedView?.id || null,
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_saved_view_create_failed";
      setEbayConversationState({
        ebayConversationSavedViewSavingId: null,
        ebayConversationSavedViewActionError: code,
      });
      console.error("[email-triage] smart folder create failed:", error);
    }
  }

  async function renameSmartFolder(context, viewId) {
    const view = ebaySavedViewsForState(adminClassificationState).find((item) => item.id === viewId);
    if (!view) return;
    const name = window.prompt("Rename smart folder", view.name);
    if (!compactConversationText(name) || compactConversationText(name) === view.name) return;
    setEbayConversationState({
      ebayConversationSavedViewSavingId: viewId,
      ebayConversationSavedViewActionError: null,
    });

    try {
      const result = await updateEbayConversationSavedView(context, viewId, { name });
      const savedView = result.saved_view || result.data?.saved_view;
      setEbayConversationState({
        ebayConversationSavedViewSavingId: null,
        ebayConversationSavedViewActionError: null,
        ebayConversationSavedViews: replaceEbayConversationSavedView(savedView),
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_saved_view_update_failed";
      setEbayConversationState({
        ebayConversationSavedViewSavingId: null,
        ebayConversationSavedViewActionError: code,
      });
      console.error("[email-triage] smart folder rename failed:", error);
    }
  }

  async function updateSmartFolderFilters(context, viewId) {
    const view = ebaySavedViewsForState(adminClassificationState).find((item) => item.id === viewId);
    if (!view) return;
    const ok = window.confirm(`Update "${view.name}" to the current search and filters?`);
    if (!ok) return;
    setEbayConversationState({
      ebayConversationSavedViewSavingId: viewId,
      ebayConversationSavedViewActionError: null,
    });

    try {
      const result = await updateEbayConversationSavedView(context, viewId, {
        filterPayload: ebayCurrentSavedViewPayload(adminClassificationState),
      });
      const savedView = result.saved_view || result.data?.saved_view;
      setEbayConversationState({
        ebayConversationSavedViewSavingId: null,
        ebayConversationSavedViewActionError: null,
        ebayConversationSavedViews: replaceEbayConversationSavedView(savedView),
        selectedEbaySavedViewId: savedView?.id || adminClassificationState.selectedEbaySavedViewId,
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_saved_view_update_failed";
      setEbayConversationState({
        ebayConversationSavedViewSavingId: null,
        ebayConversationSavedViewActionError: code,
      });
      console.error("[email-triage] smart folder filter update failed:", error);
    }
  }

  async function deleteSmartFolder(context, viewId) {
    const view = ebaySavedViewsForState(adminClassificationState).find((item) => item.id === viewId);
    if (!view) return;
    const ok = window.confirm(`Delete "${view.name}"?`);
    if (!ok) return;
    setEbayConversationState({
      ebayConversationSavedViewSavingId: viewId,
      ebayConversationSavedViewActionError: null,
    });

    try {
      await deleteEbayConversationSavedView(context, viewId);
      setEbayConversationState({
        ebayConversationSavedViewSavingId: null,
        ebayConversationSavedViewActionError: null,
        ebayConversationSavedViews: safeArray(adminClassificationState.ebayConversationSavedViews).filter((item) => item.id !== viewId),
        selectedEbaySavedViewId: adminClassificationState.selectedEbaySavedViewId === viewId ? null : adminClassificationState.selectedEbaySavedViewId,
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_saved_view_delete_failed";
      setEbayConversationState({
        ebayConversationSavedViewSavingId: null,
        ebayConversationSavedViewActionError: code,
      });
      console.error("[email-triage] smart folder delete failed:", error);
    }
  }

  async function syncLatestEbayConversations(context) {
    return runEbayConversationImport(context, {
      runType: "incremental",
      classificationMode: "none",
      checkpointScope: "commerce_message_latest_sync",
      latestSyncLookbackDays: 14,
      reloadLimit: 100,
    });
  }

  function ebayDashboardSyncRuns(snapshot = {}) {
    const ebay = snapshot?.ebay && typeof snapshot.ebay === "object" ? snapshot.ebay : {};
    return safeArray(ebay.sync_runs);
  }

  function latestDurableSyncRun(snapshot, options = {}) {
    const startedAtMs = new Date(options.startedAt || 0).getTime();
    const minStartedAtMs = Number.isFinite(startedAtMs) ? startedAtMs - 5000 : 0;
    return ebayDashboardSyncRuns(snapshot).find((run) => {
      if (options.runType && String(run.run_type || "") !== String(options.runType)) return false;
      const payload = run.payload && typeof run.payload === "object" ? run.payload : {};
      const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
      const mode = payload.classification_mode || payload.classificationMode || metadata.classificationMode || metadata.classification_mode || "none";
      if (options.classificationMode && String(mode || "none") !== String(options.classificationMode || "none")) return false;
      const runMs = new Date(run.started_at || payload.started_at || 0).getTime();
      return Number.isFinite(runMs) ? runMs >= minStartedAtMs : true;
    }) || null;
  }

  function syncResultFromDurableRun(run, snapshot = {}, options = {}) {
    if (!run) return null;
    const payload = run.payload && typeof run.payload === "object" ? run.payload : {};
    const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
    const backfillProgress = payload.backfillProgress || payload.backfill_progress || metadata.backfillProgress || metadata.backfill_progress || snapshot?.ebay?.backfill || null;
    return {
      ok: true,
      requestTimedOut: options.timedOut === true,
      reconciled: true,
      durable_run_found: true,
      runType: run.run_type || options.runType || "manual",
      classificationMode: payload.classification_mode || payload.classificationMode || metadata.classificationMode || metadata.classification_mode || options.classificationMode || "none",
      runId: run.id || run.run_id || payload.sync_run_id || null,
      status: run.status || payload.status || null,
      counters: {
        pagesFetched: Number(payload.pages_processed || 0),
        detailPagesFetched: Number(payload.detail_pages_processed || 0),
        conversationsSeen: Number(payload.conversations_seen || 0),
        conversationsInserted: Number(payload.conversations_inserted || 0),
        conversationsUpdated: Number(payload.conversations_updated || 0),
        conversationsUnchanged: Number(payload.conversations_unchanged || 0),
        conversationsSkipped: Number(payload.conversations_skipped || 0),
        messagesSeen: Number(payload.messages_seen || payload.messages_processed || 0),
        messagesInserted: Number(payload.messages_inserted || 0),
        messagesUpdated: Number(payload.messages_updated || 0),
        messagesRechecked: Number(payload.messages_rechecked || 0),
        classificationProcessed: Number(payload.classification_processed || 0),
        classificationSucceeded: Number(payload.classification_succeeded || payload.classified_count || 0),
        classificationFailed: Number(payload.classification_failed || 0),
        classificationSkipped: Number(payload.classification_skipped || 0),
        warnings: safeArray(run.warnings || payload.warnings),
        errors: Number(payload.failed_count || 0),
      },
      backfillProgress,
      canonicalTotalConversations: payload.canonical_total_conversations ?? metadata.canonicalTotalConversations ?? snapshot?.ebay?.metrics?.canonical_conversations ?? null,
      unclassifiedBefore: payload.unclassified_before ?? metadata.unclassifiedBefore ?? null,
      unclassifiedAfter: payload.unclassified_after ?? metadata.unclassifiedAfter ?? null,
      remainingUnclassified: payload.remaining_unclassified ?? payload.unclassified_after ?? metadata.unclassifiedAfter ?? null,
    };
  }

  async function refreshSyncDurableState(context, options = {}) {
    if (options.delayMs) await waitForEbayReconciliation(options.delayMs);
    await loadEbayConversationList(context, { limit: options.reloadLimit || 100 });
    const snapshot = await loadOperationalDashboard(context, { keepPrevious: true });
    const durableRun = latestDurableSyncRun(snapshot, options);
    return syncResultFromDurableRun(durableRun, snapshot, {
      ...options,
      timedOut: true,
    });
  }

  async function runEbayConversationImport(context, options = {}) {
    const runType = options.runType || "manual";
    const classificationMode = options.classificationMode || "none";
    const startedAt = new Date().toISOString();
    setEbayConversationState({
      ebayConversationSyncLoading: true,
      ebayConversationSyncOperation: {
        runType,
        classificationMode,
        target: options.target || "mailbox_sync",
      },
      ebayConversationSyncResult: null,
      ebayConversationSyncError: null,
      ebayConversationClassificationResult: null,
    });

    try {
      const result = await runEbayMessageSync(context, {
        runType,
        classificationMode,
        conversationPageLimit: 25,
        messagePageLimit: runType === "backfill" ? 50 : 25,
        maxConversationPages: 1,
        maxDetailPagesPerConversation: runType === "backfill" ? 50 : 20,
        resumeFromCheckpoint: runType === "backfill",
        checkpointScope: options.checkpointScope || (runType === "backfill" ? "commerce_message_archive" : undefined),
        latestSyncLookbackDays: options.latestSyncLookbackDays,
        rateLimitPauseMs: runType === "backfill" ? 100 : 0,
      });
      setEbayConversationState({
        ebayConversationSyncLoading: false,
        ebayConversationSyncOperation: null,
        ebayConversationSyncResult: result,
        ebayConversationSyncError: null,
      });
      await loadEbayConversationList(context, { limit: options.reloadLimit || 100 });
      loadOperationalDashboard(context, { keepPrevious: true });
    } catch (error) {
      const code = error.code || error.message || "ebay_message_sync_failed";
      if (code === "request_timeout") {
        const durableResult = await refreshSyncDurableState(context, {
          startedAt,
          runType,
          classificationMode,
          reloadLimit: options.reloadLimit || 100,
          delayMs: 1500,
        });
        setEbayConversationState({
          ebayConversationSyncLoading: false,
          ebayConversationSyncOperation: null,
          ebayConversationSyncError: null,
          ebayConversationSyncResult: durableResult || {
            ok: true,
            requestTimedOut: true,
            reconciled: true,
            runType,
            classificationMode,
          },
        });
        return;
      }
      setEbayConversationState({
        ebayConversationSyncLoading: false,
        ebayConversationSyncOperation: null,
        ebayConversationSyncError: code,
      });
      console.error("[email-triage] eBay message sync failed:", error);
    }
  }

  async function backfillEbayConversations(context, classificationMode = "none") {
    if (classificationMode === "reclassify_all") {
      const ok = window.confirm("Backfill the historical archive in chunks and reclassify conversations imported in each chunk? Click again to continue until archive checkpoints complete.");
      if (!ok) return;
    }
    return runEbayConversationImport(context, {
      runType: "backfill",
      classificationMode,
      reloadLimit: 250,
    });
  }

  function mergeEbayConversationClassification(conversationId, classification) {
    return safeArray(adminClassificationState.ebayConversations).map((conversation) => (
      conversation.id === conversationId ? { ...conversation, classification } : conversation
    ));
  }

  function ebayUnclassifiedSmartCount(state = adminClassificationState) {
    const count = Number(ebayMailboxSmartCounts(state).unclassified);
    return Number.isFinite(count) ? count : null;
  }

  function waitForEbayReconciliation(delayMs = 0) {
    return new Promise((resolve) => window.setTimeout(resolve, Math.max(Number(delayMs || 0), 0)));
  }

  function ebayDashboardEvents(snapshot = {}) {
    const ebay = snapshot?.ebay && typeof snapshot.ebay === "object" ? snapshot.ebay : {};
    return safeArray(ebay.recent_operational_events || snapshot.recent_operational_events);
  }

  function ebayActivityPayload(event = {}) {
    if (event.payload && typeof event.payload === "object") return event.payload;
    if (event.metadata && typeof event.metadata === "object") return event.metadata;
    return {};
  }

  function ebayDashboardClassificationRuns(snapshot = {}) {
    const ebay = snapshot?.ebay && typeof snapshot.ebay === "object" ? snapshot.ebay : {};
    const classificationRuns = ebay.classification_runs && typeof ebay.classification_runs === "object"
      ? ebay.classification_runs
      : {};
    return safeArray(classificationRuns.runs);
  }

  function latestDurableClassificationRun(snapshot, options = {}) {
    const startedAtMs = new Date(options.startedAt || 0).getTime();
    const minStartedAtMs = Number.isFinite(startedAtMs) ? startedAtMs - 5000 : 0;
    const durableRun = ebayDashboardClassificationRuns(snapshot).find((run) => {
      if (run.force !== undefined && Boolean(run.force) !== Boolean(options.force)) return false;
      const payload = run.payload && typeof run.payload === "object" ? run.payload : run;
      if (payload.force !== undefined && Boolean(payload.force) !== Boolean(options.force)) return false;
      const eventMs = new Date(run.started_at || payload.started_at || 0).getTime();
      return Number.isFinite(eventMs) ? eventMs >= minStartedAtMs : true;
    });
    if (durableRun) return durableRun;
    return ebayDashboardEvents(snapshot).find((event) => {
      if (event.event_type !== "conversation_classified") return false;
      const payload = ebayActivityPayload(event);
      const run = payload.classification_run && typeof payload.classification_run === "object" ? payload.classification_run : payload;
      if (run.force !== undefined && Boolean(run.force) !== Boolean(options.force)) return false;
      const eventMs = new Date(run.started_at || event.created_at || 0).getTime();
      return Number.isFinite(eventMs) ? eventMs >= minStartedAtMs : true;
    }) || null;
  }

  function classificationResultWithVisibility(result = {}, options = {}) {
    const source = result.data && typeof result.data === "object" ? { ...result.data, ...result } : result;
    const unclassifiedAfter = options.unclassifiedAfter ?? source.unclassified_after ?? source.remaining_unclassified ?? null;
    return {
      ...source,
      force: options.force === true || source.force === true,
      timed_out: options.timedOut === true || source.timed_out === true,
      reconciled: options.reconciled === true || source.reconciled === true,
      durable_event_found: options.durableEventFound === true || source.durable_event_found === true,
      candidates_examined: classificationMetricValue(source, ["candidates_examined", "processed"], 0),
      actually_classified: classificationMetricValue(source, ["actually_classified", "classified_count", "succeeded"], 0),
      classified_count: classificationMetricValue(source, ["classified_count", "actually_classified", "succeeded"], 0),
      failed_count: classificationMetricValue(source, ["failed_count", "failed"], 0),
      skipped_count: classificationMetricValue(source, ["skipped_count", "skipped"], 0),
      unclassified_before: source.unclassified_before ?? options.unclassifiedBefore ?? null,
      unclassified_after: unclassifiedAfter,
      remaining_unclassified: source.remaining_unclassified ?? unclassifiedAfter,
    };
  }

  function classificationResultFromDurableEvent(event, options = {}) {
    if (!event) return null;
    if (event.run_mode || event.payload?.run_mode) {
      const run = event.payload && typeof event.payload === "object" ? event.payload : event;
      return classificationResultWithVisibility({
        ...run,
        run_id: event.run_id || event.id || run.run_id || null,
        runId: event.run_id || event.id || run.runId || null,
        processed: run.processed_count ?? run.processed,
        succeeded: run.succeeded_count ?? run.classified_count ?? run.succeeded,
        failed: run.failed_count ?? run.failed,
        skipped: run.skipped_count ?? run.skipped,
        attempted: run.attempted_count ?? run.attempted,
        failures: run.failures || [],
        skipped_results: run.skipped_results || [],
      }, {
        ...options,
        timedOut: true,
        reconciled: true,
        durableEventFound: true,
        unclassifiedAfter: options.unclassifiedAfter ?? run.remaining_unclassified ?? run.unclassified_after,
      });
    }
    const payload = ebayActivityPayload(event);
    const run = payload.classification_run && typeof payload.classification_run === "object" ? payload.classification_run : payload;
    return classificationResultWithVisibility({
      ...run,
      processed: payload.processed_count ?? run.processed,
      succeeded: payload.succeeded_count ?? run.succeeded,
      failed: payload.failed_count ?? run.failed,
      skipped: payload.skipped_count ?? run.skipped,
      attempted: payload.attempted_count ?? run.attempted,
      failures: payload.failures || run.failures || [],
      skipped_results: payload.skipped || run.skipped_results || [],
    }, {
      ...options,
      timedOut: true,
      reconciled: true,
      durableEventFound: true,
      unclassifiedAfter: options.unclassifiedAfter ?? payload.unclassified_after ?? run.unclassified_after,
    });
  }

  async function refreshClassificationDurableState(context, options = {}) {
    if (options.delayMs) await waitForEbayReconciliation(options.delayMs);
    const attempts = Math.max(Number(options.maxAttempts || 1), 1);
    let snapshot = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await loadEbayConversationList(context, {
        limit: options.reloadLimit || 100,
        preserveSelectionId: options.preserveSelectionId || adminClassificationState.selectedEbayConversationId,
        preserveClassificationResult: true,
      });
      snapshot = await loadOperationalDashboard(context, { keepPrevious: true });
      const run = latestDurableClassificationRun(snapshot, options);
      const status = String(run?.status || run?.payload?.status || "").toLowerCase();
      if (!run || ["succeeded", "partial_success", "failed"].includes(status) || attempt + 1 >= attempts) break;
      await waitForEbayReconciliation(options.intervalMs || 2500);
    }
    return {
      snapshot,
      unclassifiedAfter: ebayUnclassifiedSmartCount(adminClassificationState),
    };
  }

  async function classifySelectedEbayConversation(context, conversationId) {
    if (!conversationId) return;
    setEbayConversationState({
      ebayConversationClassificationLoadingId: conversationId,
      ebayConversationClassificationResult: null,
      ebayConversationClassificationErrorsById: {
        ...adminClassificationState.ebayConversationClassificationErrorsById,
        [conversationId]: null,
      },
    });

    try {
      const result = await classifyEbayConversation(context, conversationId);
      const classification = result.classification || result.data?.classification || null;
      setEbayConversationState({
        ebayConversationClassificationLoadingId: null,
        ebayConversations: classification
          ? mergeEbayConversationClassification(conversationId, classification)
          : adminClassificationState.ebayConversations,
        ebayConversationClassificationErrorsById: {
          ...adminClassificationState.ebayConversationClassificationErrorsById,
          [conversationId]: null,
        },
      });
      await refreshClassificationDurableState(context, {
        preserveSelectionId: conversationId,
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_classification_failed";
      if (code === "request_timeout") {
        setEbayConversationState({
          ebayConversationClassificationLoadingId: null,
          ebayConversationClassificationErrorsById: {
            ...adminClassificationState.ebayConversationClassificationErrorsById,
            [conversationId]: null,
          },
        });
        await refreshClassificationDurableState(context, {
          preserveSelectionId: conversationId,
          delayMs: 1500,
        });
        return;
      }
      setEbayConversationState({
        ebayConversationClassificationLoadingId: null,
        ebayConversationClassificationErrorsById: {
          ...adminClassificationState.ebayConversationClassificationErrorsById,
          [conversationId]: code,
        },
      });
      console.error("[email-triage] eBay conversation classification failed:", error);
    }
  }

  async function classifyRecentEbayConversationRows(context, options = {}) {
    const force = options.force === true;
    const loadedCount = safeArray(adminClassificationState.ebayConversations).length;
    const limit = force ? EBAY_RECLASSIFY_RECENT_LIMIT : Math.min(Math.max(loadedCount || 100, 1), 100);
    const startedAt = new Date().toISOString();
    const unclassifiedBefore = ebayUnclassifiedSmartCount(adminClassificationState);
    setEbayConversationState({
      ebayConversationClassificationBatchLoading: true,
      ebayConversationClassificationResult: null,
      ebayConversationSyncResult: null,
      ebayConversationSyncError: null,
    });

    try {
      const result = await classifyRecentEbayConversations(context, { limit, force });
      const refreshed = await refreshClassificationDurableState(context, {
        preserveSelectionId: adminClassificationState.selectedEbayConversationId,
      });
      setEbayConversationState({
        ebayConversationClassificationBatchLoading: false,
        ebayConversationClassificationResult: classificationResultWithVisibility(result, {
          force,
          reconciled: true,
          unclassifiedBefore,
          unclassifiedAfter: refreshed.unclassifiedAfter,
        }),
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_conversation_batch_classification_failed";
      if (code === "request_timeout") {
        setEbayConversationState({
          ebayConversationClassificationBatchLoading: false,
          ebayConversationClassificationResult: {
            reconciling: true,
            force,
          },
        });
        const refreshed = await refreshClassificationDurableState(context, {
          preserveSelectionId: adminClassificationState.selectedEbayConversationId,
          delayMs: 1500,
          startedAt,
          force,
          maxAttempts: 8,
          intervalMs: 2500,
        });
        const durableEvent = latestDurableClassificationRun(refreshed.snapshot, { startedAt, force });
        const durableResult = classificationResultFromDurableEvent(durableEvent, {
          force,
          unclassifiedBefore,
          unclassifiedAfter: refreshed.unclassifiedAfter,
        });
        const fallbackClassified = unclassifiedBefore !== null && refreshed.unclassifiedAfter !== null
          ? Math.max(Number(unclassifiedBefore) - Number(refreshed.unclassifiedAfter), 0)
          : 0;
        setEbayConversationState({
          ebayConversationClassificationBatchLoading: false,
          ebayConversationClassificationResult: durableResult || classificationResultWithVisibility({
            force,
            timed_out: true,
            reconciled: true,
            durable_event_found: false,
            candidates_examined: 0,
            actually_classified: fallbackClassified,
            classified_count: fallbackClassified,
            failed_count: 0,
            skipped_count: 0,
          }, {
            force,
            timedOut: true,
            reconciled: true,
            unclassifiedBefore,
            unclassifiedAfter: refreshed.unclassifiedAfter,
          }),
        });
        return;
      }
      setEbayConversationState({
        ebayConversationClassificationBatchLoading: false,
        ebayConversationClassificationResult: classificationResultWithVisibility({
          processed: 0,
          succeeded: 0,
          failed: 1,
          skipped: 0,
          force,
          error: code,
        }, { force, unclassifiedBefore, unclassifiedAfter: ebayUnclassifiedSmartCount(adminClassificationState) }),
      });
      console.error("[email-triage] eBay recent conversation classification failed:", error);
    }
  }

  async function saveEbayClassificationOverride(context, form) {
    const conversationId = form.getAttribute("data-conversation-id");
    const classificationId = form.getAttribute("data-classification-id");
    if (!conversationId || !classificationId) return;
    const formData = new FormData(form);
    const overridePayload = {
      priority: formData.get("priority") || "",
      response_need: formData.get("response_need") || "",
      topic_tags: formData.getAll("topic_tags"),
      buyer_flags: formData.getAll("buyer_flags"),
      risk_flags: formData.getAll("risk_flags"),
    };
    const reviewState = String(formData.get("review_state") || "corrected");
    const operatorNotes = String(formData.get("operator_notes") || "");
    setEbayConversationState({
      ebayConversationClassificationSavingId: classificationId,
      ebayConversationClassificationSaveErrorsById: {
        ...adminClassificationState.ebayConversationClassificationSaveErrorsById,
        [classificationId]: null,
      },
    });

    try {
      const result = await saveEbayConversationClassificationOverride(context, {
        conversationId,
        classificationId,
        reviewState,
        overridePayload,
        operatorNotes,
      });
      const classification = result.classification || result.data?.classification || null;
      setEbayConversationState({
        ebayConversationClassificationSavingId: null,
        ebayConversationClassificationEditingId: null,
        ebayConversations: classification
          ? mergeEbayConversationClassification(conversationId, classification)
          : adminClassificationState.ebayConversations,
        ebayConversationClassificationSaveErrorsById: {
          ...adminClassificationState.ebayConversationClassificationSaveErrorsById,
          [classificationId]: null,
        },
      });
    } catch (error) {
      const code = error.code || error.message || "ebay_classification_override_failed";
      setEbayConversationState({
        ebayConversationClassificationSavingId: null,
        ebayConversationClassificationSaveErrorsById: {
          ...adminClassificationState.ebayConversationClassificationSaveErrorsById,
          [classificationId]: code,
        },
      });
      console.error("[email-triage] eBay classification override failed:", error);
    }
  }

  function applyEbayConversationListControls(context, updates = {}) {
    const shouldClearSavedView = updates.preserveSavedView !== true && Object.keys(updates).some((key) => (
      ["ebayConversationFilter", "ebayConversationSearchQuery", "ebayConversationClassificationFilters"].includes(key)
    ));
    const cleanUpdates = { ...updates };
    delete cleanUpdates.preserveSavedView;
    if (shouldClearSavedView && !Object.prototype.hasOwnProperty.call(cleanUpdates, "selectedEbaySavedViewId")) {
      cleanUpdates.selectedEbaySavedViewId = null;
    }
    const searchChanged = Object.prototype.hasOwnProperty.call(cleanUpdates, "ebayConversationSearchQuery");
    setEbayConversationState({
      ...cleanUpdates,
      ebayConversationLoading: true,
      ebayConversationLoadingMore: false,
      ebayConversationError: null,
      ebayConversations: [],
      selectedEbayConversationId: null,
      ebayMailboxWarning: null,
      ebayMailboxPagination: {
        ...ebayMailboxPageInfo(adminClassificationState),
        loaded_count: 0,
        offset: 0,
        next_offset: null,
        has_more: false,
      },
    });
    scheduleEbayConversationListReload(context, { delay: searchChanged ? 350 : 0 });
  }

  function updateEbayConversationClassificationFilter(context, groupKey, value, active) {
    const group = EBAY_FILTER_GROUPS.find((item) => item.key === groupKey);
    if (!group || !group.values.includes(value)) return;
    const filters = safeEbayClassificationFilters(adminClassificationState.ebayConversationClassificationFilters);
    const set = new Set(filters[groupKey]);
    if (active) set.add(value);
    else set.delete(value);
    applyEbayConversationListControls(context, {
      ebayConversationClassificationFilters: {
        ...filters,
        [groupKey]: [...set],
      },
    });
  }

  function clearEbayConversationFilters(context) {
    if (els.ebayConversationSearch) els.ebayConversationSearch.value = "";
    applyEbayConversationListControls(context, {
      ebayConversationFilter: "all",
      ebayConversationSearchQuery: "",
      ebayConversationClassificationFilters: ebayConversationDefaultClassificationFilters(),
      selectedEbaySavedViewId: null,
    });
  }

  function insertEbaySearchToken(context, token) {
    if (!token || !els.ebayConversationSearch) return;
    const input = els.ebayConversationSearch;
    const value = String(input.value || "");
    const beforeCursor = value.slice(0, input.selectionStart || value.length);
    const afterCursor = value.slice(input.selectionEnd || value.length);
    const replacedBefore = /(?:^|\s)(tag|source|topic|buyer|risk|priority|response):[^\s]*$/i.test(beforeCursor)
      ? beforeCursor.replace(/(?:^|\s)(tag|source|topic|buyer|risk|priority|response):[^\s]*$/i, (match) => `${match.startsWith(" ") ? " " : ""}${token}`)
      : `${beforeCursor}${beforeCursor && !beforeCursor.endsWith(" ") ? " " : ""}${token}`;
    const nextValue = `${replacedBefore} ${afterCursor.trimStart()}`.trimStart();
    input.value = nextValue;
    applyEbayConversationListControls(context, { ebayConversationSearchQuery: nextValue });
    input.focus();
  }

  function applyEbaySavedView(context, viewId) {
    const view = ebaySavedViewsForState(adminClassificationState).find((item) => item.id === viewId);
    if (!view) return;
    const payload = ebaySavedViewFilterPayload(view.filter_payload);
    if (els.ebayConversationSearch) els.ebayConversationSearch.value = payload.search_query || "";
    applyEbayConversationListControls(context, {
      ebayConversationFilter: payload.system_filter || "all",
      ebayConversationSearchQuery: payload.search_query || "",
      ebayConversationClassificationFilters: payload.classification_filters,
      selectedEbaySavedViewId: view.id,
      preserveSavedView: true,
    });
  }

  function bindEbayConversationEvents(context) {
    els.ebayConversationRefresh?.addEventListener("click", () => loadEbayConversationList(context, { limit: 100 }));
    els.ebayConversationLoadMore?.addEventListener("click", () => loadEbayConversationList(context, { append: true }));
    els.ebayConversationSync?.addEventListener("click", () => syncLatestEbayConversations(context));
    els.ebayConversationBackfill?.addEventListener("click", () => backfillEbayConversations(context, "none"));
    els.ebayConversationBackfillClassifyNew?.addEventListener("click", () => backfillEbayConversations(context, "classify_new"));
    els.ebayConversationBackfillReclassifyAll?.addEventListener("click", () => backfillEbayConversations(context, "reclassify_all"));
    els.ebayConversationClassifyRecent?.addEventListener("click", () => classifyRecentEbayConversationRows(context, { force: false }));
    els.ebayConversationReclassifyAll?.addEventListener("click", () => classifyRecentEbayConversationRows(context, { force: true }));
    els.ebayConversationSavedViews?.addEventListener("click", (event) => {
      const select = event.target.closest("[data-ebay-saved-view-select]");
      if (select) {
        applyEbaySavedView(context, select.getAttribute("data-ebay-saved-view-select"));
        return;
      }
      const rename = event.target.closest("[data-ebay-saved-view-rename]");
      if (rename) {
        renameSmartFolder(context, rename.getAttribute("data-ebay-saved-view-rename"));
        return;
      }
      const update = event.target.closest("[data-ebay-saved-view-update]");
      if (update) {
        updateSmartFolderFilters(context, update.getAttribute("data-ebay-saved-view-update"));
        return;
      }
      const deleteButton = event.target.closest("[data-ebay-saved-view-delete]");
      if (deleteButton) {
        deleteSmartFolder(context, deleteButton.getAttribute("data-ebay-saved-view-delete"));
      }
    });
    els.ebayConversationReloadViews?.addEventListener("click", () => loadEbayConversationSavedViews(context));
    els.ebaySmartFolderEditToggle?.addEventListener("click", () => {
      setEbayConversationState({
        ebayConversationSmartFoldersEditing: adminClassificationState.ebayConversationSmartFoldersEditing !== true,
      });
    });
    els.ebayConversationSaveView?.addEventListener("click", () => createSmartFolderFromCurrentFilters(context));
    els.ebayConversationPanelToggleButtons?.forEach((button) => {
      button.addEventListener("click", () => {
        const panel = button.getAttribute("data-ebay-panel-toggle");
        if (!["folders", "list", "context"].includes(panel)) return;
        const visibility = normalizeEbayConversationPanelVisibility(adminClassificationState.ebayConversationPanelVisibility);
        const next = { ...visibility, [panel]: visibility[panel] === false };
        storeEbayConversationPanelVisibility(next);
        setEbayConversationState({ ebayConversationPanelVisibility: next });
      });
    });
    els.ebayConversationTagHelpToggle?.addEventListener("click", () => {
      setEbayConversationState({ ebayConversationTagHelpOpen: adminClassificationState.ebayConversationTagHelpOpen !== true });
    });
    els.ebayConversationTagHelp?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-ebay-search-token]");
      if (!button) return;
      insertEbaySearchToken(context, button.getAttribute("data-ebay-search-token"));
    });
    els.ebayConversationTagSuggestions?.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    els.ebayConversationTagSuggestions?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-ebay-search-token]");
      if (!button) return;
      insertEbaySearchToken(context, button.getAttribute("data-ebay-search-token"));
    });
    els.ebayConversationSearch?.addEventListener("input", () => {
      applyEbayConversationListControls(context, {
        ebayConversationSearchQuery: els.ebayConversationSearch.value || "",
      });
    });
    els.ebayConversationSearch?.addEventListener("focus", () => renderEbaySearchSuggestions(adminClassificationState));
    els.ebayConversationSearch?.addEventListener("blur", () => {
      window.setTimeout(() => renderEbaySearchSuggestions(adminClassificationState), 120);
    });
    els.ebayConversationSearchClear?.addEventListener("click", () => {
      if (els.ebayConversationSearch) els.ebayConversationSearch.value = "";
      applyEbayConversationListControls(context, { ebayConversationSearchQuery: "" });
      els.ebayConversationSearch?.focus();
    });
    els.ebayConversationFilterToggle?.addEventListener("click", () => {
      const expanded = adminClassificationState.ebayConversationFiltersExpanded !== true;
      storeBooleanPreference(EBAY_CONVERSATION_FILTERS_EXPANDED_STORAGE_KEY, expanded);
      setEbayConversationState({
        ebayConversationFiltersExpanded: expanded,
      });
    });
    els.ebayConversationClearFilters?.addEventListener("click", () => {
      clearEbayConversationFilters(context);
    });
    els.ebayConversationFilterPanel?.addEventListener("change", (event) => {
      const input = event.target.closest("[data-ebay-filter-group]");
      if (!input) return;
      updateEbayConversationClassificationFilter(
        context,
        input.getAttribute("data-ebay-filter-group"),
        input.value,
        input.checked,
      );
    });
    els.ebayConversationActiveFilters?.addEventListener("click", (event) => {
      const clearView = event.target.closest("[data-ebay-clear-view]");
      if (clearView) {
        applyEbayConversationListControls(context, { ebayConversationFilter: "all" });
        return;
      }
      const clearSearch = event.target.closest("[data-ebay-clear-search]");
      if (clearSearch) {
        if (els.ebayConversationSearch) els.ebayConversationSearch.value = "";
        applyEbayConversationListControls(context, { ebayConversationSearchQuery: "" });
        return;
      }
      const remove = event.target.closest("[data-ebay-remove-filter-group]");
      if (!remove) return;
      updateEbayConversationClassificationFilter(
        context,
        remove.getAttribute("data-ebay-remove-filter-group"),
        remove.getAttribute("data-ebay-remove-filter-value"),
        false,
      );
    });
    els.ebayConversationDensityInputs?.forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const ebayConversationDensityMode = input.value === "expanded" ? "expanded" : "compact";
        storeEbayConversationDensityMode(ebayConversationDensityMode);
        setEbayConversationState({ ebayConversationDensityMode });
      });
    });
    els.ebayConversationList?.addEventListener("click", (event) => {
      const row = event.target.closest("[data-ebay-conversation-id]");
      if (!row) return;
      selectEbayConversation(context, row.getAttribute("data-ebay-conversation-id"));
    });
    const handleDetailClick = (event) => {
      const draftButton = event.target.closest("[data-ebay-draft-action]");
      if (draftButton) {
        const form = draftButton.closest("[data-ebay-draft-form]");
        const action = draftButton.getAttribute("data-ebay-draft-action");
        const conversationId = draftButton.getAttribute("data-ebay-conversation-id") ||
          form?.getAttribute("data-ebay-conversation-id") ||
          adminClassificationState.selectedEbayConversationId;
        const draftId = form?.getAttribute("data-draft-id") || draftButton.getAttribute("data-draft-id") || "";
        const targetMessageId = draftButton.getAttribute("data-ebay-target-message-id") ||
          form?.getAttribute("data-ebay-target-message-id") ||
          "";
        const formData = form ? new FormData(form) : null;
        const composerMode = form?.getAttribute("data-ebay-composer-mode") || "";
        if (action === "send") {
          const conversation = selectedEbayConversationById(conversationId, adminClassificationState);
          const draft = currentEbayConversationDraft(conversationId);
          const messages = safeArray(adminClassificationState.ebayConversationMessagesById?.[conversationId]);
          const manualSend = composerMode === "normal" || !draft || ebayDraftCanSendWithoutApproval(draft);
          if (!conversation) return;
          if (!manualSend && (!draft || !confirmEbayDraftSend(conversation, draft, messages))) return;
        }
        runEbayConversationDraftAction(context, {
          mode: action,
          conversationId,
          targetMessageId,
          draftId,
          draftText: formData ? String(formData.get("draftText") || "") : "",
          improvementInstructions: formData ? String(formData.get("improvementInstructions") || "") : "",
          operatorNotes: formData ? String(formData.get("operatorNotes") || "") : "",
          approvalNotes: formData ? String(formData.get("operatorNotes") || "") : "",
          manualComposer: composerMode === "normal",
          sendConfirmed: action === "send",
        });
        return;
      }
      const button = event.target.closest("[data-ebay-detail-action]");
      if (!button) return;
      const conversationId = button.getAttribute("data-ebay-conversation-id");
      const action = button.getAttribute("data-ebay-detail-action");
      if (action === "refresh-messages") {
        refreshEbayConversationTimeline(context, conversationId);
        return;
      }
      if (action === "refresh-context") {
        loadEbayConversationContext(context, conversationId, { force: true });
        return;
      }
      if (action === "classify-conversation") {
        classifySelectedEbayConversation(context, conversationId);
        return;
      }
      if (action === "edit-classification") {
        setEbayConversationState({ ebayConversationClassificationEditingId: button.getAttribute("data-classification-id") });
        return;
      }
      if (action === "cancel-classification-edit") {
        setEbayConversationState({ ebayConversationClassificationEditingId: null });
      }
    };
    els.ebayConversationDetail?.addEventListener("click", handleDetailClick);
    els.ebayConversationContext?.addEventListener("click", handleDetailClick);
    els.ebayConversationDetail?.addEventListener("toggle", (event) => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      const preference = details.getAttribute("data-ebay-detail-preference");
      if (preference === "classification") {
        const collapsed = details.open !== true;
        if (collapsed === adminClassificationState.ebayConversationClassificationCollapsed) return;
        storeBooleanPreference(EBAY_CLASSIFICATION_EXPANDED_STORAGE_KEY, !collapsed);
        setEbayConversationState({ ebayConversationClassificationCollapsed: collapsed });
      }
      if (preference === "draft-metadata") {
        const collapsed = details.open !== true;
        if (collapsed === adminClassificationState.ebayDraftMetadataCollapsed) return;
        storeBooleanPreference(EBAY_DRAFT_METADATA_COLLAPSED_STORAGE_KEY, collapsed);
        setEbayConversationState({ ebayDraftMetadataCollapsed: collapsed });
      }
    }, true);
    els.ebayConversationDetail?.addEventListener("submit", (event) => {
      if (event.target.closest("[data-ebay-draft-form]")) {
        event.preventDefault();
        return;
      }
      const form = event.target.closest("[data-ebay-classification-form]");
      if (!form) return;
      event.preventDefault();
      saveEbayClassificationOverride(context, form);
    });
  }

  function operationalEventById(id, state = triageStore.getState()) {
    const events = Array.isArray(state.operationalDashboardSnapshot?.ebay?.recent_operational_events)
      ? state.operationalDashboardSnapshot.ebay.recent_operational_events
      : Array.isArray(state.operationalDashboardSnapshot?.recent_operational_events)
        ? state.operationalDashboardSnapshot.recent_operational_events
      : [];
    return events.find((event) => String(event.id || "") === String(id || "")) || null;
  }

  function closeOperationalEventDetail() {
    setOperationalDashboardState({
      operationalEventDetailOpen: false,
      selectedOperationalEventId: null,
      selectedOperationalEventDetail: null,
    });
  }

  function openOperationalEventDetail(id) {
    const event = operationalEventById(id);
    if (!event) return;
    setOperationalDashboardState({
      operationalEventDetailOpen: true,
      selectedOperationalEventId: event.id || id,
      selectedOperationalEventDetail: event,
    });
  }

  function handleOperationalDashboardClick(event) {
    if (event.target.closest("[data-operational-event-close]")) {
      closeOperationalEventDetail();
      return;
    }
    const row = event.target.closest("[data-operational-event-id]");
    if (!row) return;
    openOperationalEventDetail(row.getAttribute("data-operational-event-id"));
  }

  function handleOperationalDashboardKeydown(event) {
    if (event.key === "Escape" && triageStore.getState().operationalEventDetailOpen) {
      closeOperationalEventDetail();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest("[data-operational-event-id]");
    if (!row) return;
    event.preventDefault();
    openOperationalEventDetail(row.getAttribute("data-operational-event-id"));
  }

  async function loadAdminClassificationData(context, options = {}) {
    const currentState = triageStore.getState();
    const classificationQuery = classificationQueryFromState(currentState, options.classificationQuery || {});
    setAdminClassificationState({
      status: "loading",
      loading: true,
      fetch_failed: false,
      unauthorized: false,
      empty_results: false,
      error: null,
    });

    try {
      const data = await fetchAdminClassificationView(context, { classificationQuery });
      const empty = isAdminViewEmpty(data);
      const page = pageInfoFromData(data);
      const selectedClassificationId = currentState.selectedClassificationId || data.classifications?.[0]?.id || null;
      setAdminClassificationState({
        status: "ready",
        loading: false,
        fetch_failed: false,
        unauthorized: false,
        empty_results: empty,
        error: null,
        data,
        selectedClassificationId,
        selectedClassificationsById: mergeSelectedClassificationCache(currentState, data.classifications || []),
        pagination: {
          ...currentState.pagination,
          page: page.page,
          pageSize: page.pageSize,
          limit: page.pageSize,
          offset: page.offset,
          has_more: page.hasNextPage,
          has_previous_page: page.hasPreviousPage,
          total_pages: page.totalPages,
          filtered_rows: page.filteredRows,
          total_classified_rows: page.totalClassifiedRows,
          filters: {
            category: classificationQuery.category,
            priority: classificationQuery.priority,
            status: classificationQuery.status,
            activeFilters: classificationQuery.filters,
          },
          sort: classificationQuery.sort,
        },
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

  async function updateClassificationQueryAndLoad(context, overrides = {}) {
    const current = triageStore.getState();
    const query = classificationQueryFromState(current, overrides);
    setAdminClassificationState({
      selectedCategory: query.category,
      sortMode: query.sort,
      priorityFilter: query.priority,
      statusFilter: query.status,
      activeFilters: query.filters,
      pagination: {
        ...current.pagination,
        page: query.page,
        pageSize: query.pageSize,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      },
    });
    await loadAdminClassificationData(context, { classificationQuery: query });
    const selected = selectedClassificationById(triageStore.getState().selectedClassificationId);
    if (selected) {
      loadDraftView(context, selected);
      loadMatchContext(context, selected);
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

  async function loadDraftView(context, selected, options = {}) {
    const messageId = selected?.message_id || "";
    const classificationId = selected?.id || selected?.classification_id || "";
    if (!messageId || !classificationId) return;
    if (!options.force && adminClassificationState.draftsByMessageId[messageId]) return;

    setAdminClassificationState({
      draftLoadingMessageId: messageId,
      draftErrorsByMessageId: {
        ...adminClassificationState.draftErrorsByMessageId,
        [messageId]: null,
      },
      ...clearDraftActionStateForMessage(messageId),
    });

    try {
      const payload = await fetchDraftView(context, { messageId, classificationId });
      logEmailTriageDraftDebug(selected, payload);
      setAdminClassificationState({
        draftLoadingMessageId: null,
        draftsByMessageId: {
          ...adminClassificationState.draftsByMessageId,
          [messageId]: payload,
        },
        draftErrorsByMessageId: {
          ...adminClassificationState.draftErrorsByMessageId,
          [messageId]: null,
        },
        draftActionErrorsByMessageId: {
          ...adminClassificationState.draftActionErrorsByMessageId,
          [messageId]: null,
        },
      });
    } catch (error) {
      const code = error.code || error.message || "draft_view_failed";
      setAdminClassificationState({
        draftLoadingMessageId: null,
        draftErrorsByMessageId: {
          ...adminClassificationState.draftErrorsByMessageId,
          [messageId]: code,
        },
      });
      console.error("[email-triage] admin_draft_view fetch failed:", error);
    }
  }

  async function loadMatchContext(context, selected, options = {}) {
    const messageId = selected?.message_id || "";
    if (!messageId) return;
    if (!options.force && adminClassificationState.matchContextsByMessageId[messageId]) return;

    setAdminClassificationState({
      matchContextLoadingId: messageId,
      matchContextErrorsByMessageId: {
        ...adminClassificationState.matchContextErrorsByMessageId,
        [messageId]: null,
      },
    });

    try {
      const payload = await fetchMatchContext(context, messageId);
      setAdminClassificationState({
        matchContextLoadingId: null,
        matchContextsByMessageId: {
          ...adminClassificationState.matchContextsByMessageId,
          [messageId]: payload,
        },
        matchContextErrorsByMessageId: {
          ...adminClassificationState.matchContextErrorsByMessageId,
          [messageId]: null,
        },
      });
    } catch (error) {
      const code = error.code || error.message || "match_context_failed";
      setAdminClassificationState({
        matchContextLoadingId: null,
        matchContextErrorsByMessageId: {
          ...adminClassificationState.matchContextErrorsByMessageId,
          [messageId]: code,
        },
      });
      console.error("[email-triage] operator_match_context fetch failed:", error);
    }
  }

  function selectedClassificationById(classificationId) {
    if (!classificationId) return null;
    const data = adminClassificationState.data || normalizeAdminViewPayload({});
    return (data.classifications || []).find((classification) => classification.id === classificationId)
      || adminClassificationState.selectedClassificationsById?.[classificationId]
      || null;
  }

  function selectedClassificationForDraft(messageId, classificationId) {
    const byClassification = classificationId ? selectedClassificationById(classificationId) : null;
    if (byClassification) return byClassification;
    const data = adminClassificationState.data || normalizeAdminViewPayload({});
    return (data.classifications || []).find((classification) => classification.message_id === messageId) || null;
  }

  async function loadSelectedDraftView(context, options = {}) {
    const selected = selectedClassificationById(adminClassificationState.selectedClassificationId);
    if (!selected) return;
    await loadDraftView(context, selected, options);
  }

  async function loadSelectedMatchContext(context, options = {}) {
    const selected = selectedClassificationById(adminClassificationState.selectedClassificationId);
    if (!selected) return;
    await loadMatchContext(context, selected, options);
  }

  async function runDraftAction(context, values) {
    const selected = selectedClassificationForDraft(values.messageId, values.classificationId);
    if (!selected?.message_id || !selected?.id) return;

    setAdminClassificationState({
      draftActionMessageId: selected.message_id,
      draftActionErrorsByMessageId: {
        ...adminClassificationState.draftActionErrorsByMessageId,
        [selected.message_id]: null,
      },
      draftActionMessagesByMessageId: {
        ...adminClassificationState.draftActionMessagesByMessageId,
        [selected.message_id]: null,
      },
    });

    try {
      await requestResponseDraft(context, {
        mode: values.mode,
        messageId: selected.message_id,
      });
      setAdminClassificationState({
        draftActionMessageId: null,
        draftActionErrorsByMessageId: {
          ...adminClassificationState.draftActionErrorsByMessageId,
          [selected.message_id]: null,
        },
      });
      await loadDraftView(context, selected, { force: true });
      await loadMatchContext(context, selected, { force: true });
    } catch (error) {
      const code = error.code || error.message || "draft_action_failed";
      setAdminClassificationState({
        draftActionMessageId: null,
        draftActionErrorsByMessageId: {
          ...adminClassificationState.draftActionErrorsByMessageId,
          [selected.message_id]: code,
        },
      });
      console.error("[email-triage] response draft action failed:", error);
    }
  }

  async function runDraftReviewAction(context, values) {
    const selected = selectedClassificationForDraft(values.messageId, values.classificationId);
    if (!selected?.message_id || !selected?.id || !values.draftId) return;
    const currentDraft = currentDraftForMessage(selected.message_id);
    if (!currentDraft?.id || String(currentDraft.id) !== String(values.draftId)) return;

    setAdminClassificationState({
      draftActionMessageId: selected.message_id,
      draftActionErrorsByMessageId: {
        ...adminClassificationState.draftActionErrorsByMessageId,
        [selected.message_id]: null,
      },
      draftActionMessagesByMessageId: {
        ...adminClassificationState.draftActionMessagesByMessageId,
        [selected.message_id]: null,
      },
    });

    try {
      const result = await requestDraftReviewAction(context, {
        mode: values.mode,
        messageId: selected.message_id,
        classificationId: null,
        draftId: values.draftId,
        draftSubject: values.draftSubject,
        draftBodyText: values.draftBodyText,
        operatorNotes: values.operatorNotes,
      });
      setAdminClassificationState({
        draftActionMessageId: null,
        draftActionErrorsByMessageId: {
          ...adminClassificationState.draftActionErrorsByMessageId,
          [selected.message_id]: null,
        },
        draftActionMessagesByMessageId: {
          ...adminClassificationState.draftActionMessagesByMessageId,
          [selected.message_id]: successMessageForAction(result.mode),
        },
      });
      await loadDraftView(context, selected, { force: true });
    } catch (error) {
      const code = error.code || error.message || "draft_review_failed";
      setAdminClassificationState({
        draftActionMessageId: null,
        draftActionErrorsByMessageId: {
          ...adminClassificationState.draftActionErrorsByMessageId,
          [selected.message_id]: code,
        },
      });
      console.error("[email-triage] draft review action failed:", error);
    }
  }

  async function runMatchReviewAction(context, values) {
    const selected = selectedClassificationForDraft(values.messageId, "");
    if (!selected?.message_id || !values.linkId) return;

    setAdminClassificationState({
      matchActionLinkId: values.linkId,
      matchContextErrorsByMessageId: {
        ...adminClassificationState.matchContextErrorsByMessageId,
        [selected.message_id]: null,
      },
      matchActionMessagesByMessageId: {
        ...adminClassificationState.matchActionMessagesByMessageId,
        [selected.message_id]: null,
      },
    });

    try {
      const result = await requestMatchReviewAction(context, values);
      const labels = {
        confirm_match: "Match confirmed. Drafts and sending remain human-controlled.",
        reject_match: "Match rejected and preserved for audit.",
        mark_match_stale: "Match marked stale.",
      };
      setAdminClassificationState({
        matchActionLinkId: null,
        matchActionMessagesByMessageId: {
          ...adminClassificationState.matchActionMessagesByMessageId,
          [selected.message_id]: labels[result.mode] || "Match review saved.",
        },
      });
      await loadAdminClassificationData(context);
      await loadMatchContext(context, selected, { force: true });
      await loadDraftView(context, selected, { force: true });
    } catch (error) {
      const code = error.code || error.message || "match_review_failed";
      setAdminClassificationState({
        matchActionLinkId: null,
        matchContextErrorsByMessageId: {
          ...adminClassificationState.matchContextErrorsByMessageId,
          [selected.message_id]: code,
        },
      });
      console.error("[email-triage] match review action failed:", error);
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
      const selected = classifications.find((classification) => classification.id === classificationId);
      if (selected?.message_id) {
        await loadDraftView(context, selected, { force: true });
      }
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

  function bindClassificationInboxEvents(context) {
    els.classificationCategoryList?.addEventListener("click", (event) => {
      const orderActionButton = event.target.closest("[data-category-order-action]");
      if (orderActionButton) {
        const action = orderActionButton.getAttribute("data-category-order-action");
        const data = adminClassificationState.data || normalizeAdminViewPayload({});
        const savedOrder = adminClassificationState.customCategoryOrder;

        if (action === "edit") {
          setAdminClassificationState({
            customCategoryOrderEditing: true,
            customCategoryOrderDraft: preserveHiddenCustomCategoryIds(mergedCustomCategoryOrder(data, savedOrder), savedOrder),
          });
          return;
        }

        if (action === "save") {
          const nextOrder = preserveHiddenCustomCategoryIds(
            mergedCustomCategoryOrder(data, adminClassificationState.customCategoryOrderDraft || savedOrder),
            adminClassificationState.customCategoryOrderDraft || savedOrder,
          );
          storeCustomCategoryOrder(nextOrder);
          setAdminClassificationState({
            customCategoryOrder: nextOrder,
            customCategoryOrderEditing: false,
            customCategoryOrderDraft: null,
          });
          return;
        }

        if (action === "cancel") {
          setAdminClassificationState({
            customCategoryOrderEditing: false,
            customCategoryOrderDraft: null,
          });
          return;
        }

        if (action === "reset") {
          const nextOrder = mergedCustomCategoryOrder(data, []);
          clearStoredCustomCategoryOrder();
          setAdminClassificationState({
            customCategoryOrder: nextOrder,
            customCategoryOrderEditing: false,
            customCategoryOrderDraft: null,
          });
          return;
        }
      }

      const moveButton = event.target.closest("[data-category-move]");
      if (moveButton) {
        const categoryId = moveButton.getAttribute("data-category-id") || "";
        const direction = moveButton.getAttribute("data-category-move") === "up" ? "up" : "down";
        const data = adminClassificationState.data || normalizeAdminViewPayload({});
        const draftOrder = adminClassificationState.customCategoryOrderDraft || adminClassificationState.customCategoryOrder;
        const customCategoryOrderDraft = moveCustomCategory(data, categoryId, direction, draftOrder);
        setAdminClassificationState({ customCategoryOrderDraft });
        return;
      }

      const button = event.target.closest("[data-category-id]");
      if (!button) return;

      const selectedCategory = canonicalGroupId(button.getAttribute("data-category-id") || "all");
      updateClassificationQueryAndLoad(context, { category: selectedCategory, page: 1 });
    });

    els.classificationList?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-classification-id]");
      if (!button) return;
      const classificationId = button.getAttribute("data-classification-id");

      setAdminClassificationState({
        selectedClassificationId: classificationId,
        ...clearDraftActionStateForMessage(selectedClassificationById(classificationId)?.message_id || ""),
      });
      const selected = selectedClassificationById(classificationId);
      if (selected) {
        loadDraftView(context, selected);
        loadMatchContext(context, selected);
      }
    });

    els.classificationDetail?.addEventListener("click", (event) => {
      const detailSectionsButton = event.target.closest("[data-detail-sections-action]");
      if (detailSectionsButton) {
        const shouldOpen = detailSectionsButton.getAttribute("data-detail-sections-action") === "expand";
        els.classificationDetail
          ?.querySelectorAll("details.detail-disclosure")
          .forEach((section) => { section.open = shouldOpen; });
        return;
      }

      const draftReviewButton = event.target.closest("[data-draft-review-action]");
      if (draftReviewButton) {
        const form = draftReviewButton.closest("[data-draft-review-form]");
        const formData = new FormData(form);
        const action = draftReviewButton.getAttribute("data-draft-review-action");
        runDraftReviewAction(context, {
          mode: action,
          messageId: String(formData.get("messageId") || ""),
          classificationId: String(formData.get("classificationId") || ""),
          draftId: String(formData.get("draftId") || ""),
          draftSubject: String(formData.get("draftSubject") || ""),
          draftBodyText: String(formData.get("draftBodyText") || ""),
          operatorNotes: String(formData.get("operatorNotes") || ""),
        });
        return;
      }

      const matchButton = event.target.closest("[data-match-action]");
      if (matchButton) {
        const action = matchButton.getAttribute("data-match-action");
        const messageId = matchButton.getAttribute("data-message-id");
        const linkId = matchButton.getAttribute("data-link-id");
        const selected = selectedClassificationForDraft(messageId, "");
        if (action === "refresh") {
          if (selected) loadMatchContext(context, selected, { force: true });
          return;
        }
        if (action === "reject_match") {
          const reason = window.prompt("Reason for rejecting this match?");
          if (!reason) return;
          runMatchReviewAction(context, { mode: action, messageId, linkId, reason });
          return;
        }
        if (action === "confirm_match" || action === "mark_match_stale") {
          runMatchReviewAction(context, { mode: action, messageId, linkId });
          return;
        }
      }

      const draftButton = event.target.closest("[data-draft-action]");
      if (draftButton) {
        const action = draftButton.getAttribute("data-draft-action");
        const messageId = draftButton.getAttribute("data-message-id");
        const classificationId = draftButton.getAttribute("data-classification-id");
        const draftId = draftButton.getAttribute("data-draft-id");
        const selected = selectedClassificationForDraft(messageId, classificationId);
        if (action === "refresh") {
          if (selected) loadDraftView(context, selected, { force: true });
          return;
        }
        if (action === "generate_response" || action === "regenerate_response") {
          runDraftAction(context, {
            mode: action,
            messageId,
            classificationId,
            draftId,
          });
          return;
        }
      }

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

    els.classificationDetail?.addEventListener("submit", (event) => {
      if (event.target.closest("[data-draft-review-form]")) {
        event.preventDefault();
      }
    });

    els.classificationSort?.addEventListener("change", (event) => {
      const sortMode = event.target.value || "newest";
      updateClassificationQueryAndLoad(context, { sort: sortMode, page: 1 });
    });

    els.classificationPageSize?.addEventListener("change", (event) => {
      updateClassificationQueryAndLoad(context, { pageSize: Number(event.target.value || 25), page: 1 });
    });

    els.classificationPriorityFilter?.addEventListener("change", (event) => {
      updateClassificationQueryAndLoad(context, { priority: event.target.value || "all", page: 1 });
    });

    els.classificationStatusFilter?.addEventListener("change", (event) => {
      updateClassificationQueryAndLoad(context, { status: event.target.value || "all", page: 1 });
    });

    els.classificationPrevPage?.addEventListener("click", () => {
      const currentPage = Number(adminClassificationState.pagination?.page || 1);
      if (currentPage <= 1) return;
      updateClassificationQueryAndLoad(context, { page: currentPage - 1 });
    });

    els.classificationNextPage?.addEventListener("click", () => {
      const currentPage = Number(adminClassificationState.pagination?.page || 1);
      updateClassificationQueryAndLoad(context, { page: currentPage + 1 });
    });

    els.classificationCategorySort?.addEventListener("change", (event) => {
      const categorySortMode = ["alphabetical", "custom"].includes(event.target.value) ? event.target.value : "default";
      const data = adminClassificationState.data || normalizeAdminViewPayload({});
      const currentCustomOrder = adminClassificationState.customCategoryOrder;
      const customCategoryOrder = categorySortMode === "custom"
        ? preserveHiddenCustomCategoryIds(mergedCustomCategoryOrder(data, currentCustomOrder), currentCustomOrder)
        : currentCustomOrder;
      storeCategorySortMode(categorySortMode);
      if (categorySortMode === "custom") storeCustomCategoryOrder(customCategoryOrder);
      setAdminClassificationState({
        categorySortMode,
        customCategoryOrder,
        customCategoryOrderEditing: false,
        customCategoryOrderDraft: null,
      });
    });

    els.classificationFiltersToggle?.addEventListener("click", () => {
      const expanded = !adminClassificationState.filtersExpanded;
      storeBooleanPreference(CLASSIFICATION_FILTERS_EXPANDED_STORAGE_KEY, expanded);
      setAdminClassificationState({
        filtersExpanded: expanded,
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
        updateClassificationQueryAndLoad(context, { filters: activeFilters, page: 1 });
      });
    });
  }

  async function init() {
    const context = await requireAdmin({ greetingEl: els.greeting });
    if (!context) return;

    bindEbayConversationEvents(context);
    renderEbayConversationInbox(adminClassificationState);
    bindPanelResizeEvents();
    bindEbayPanelResizeEvents();
    els.operationalDashboardRefresh?.addEventListener("click", () => loadOperationalDashboard(context));
    els.operationalDashboardToggle?.addEventListener("click", () => {
      const operationalDashboardCollapsed = !adminClassificationState.operationalDashboardCollapsed;
      storeDashboardCollapsed(operationalDashboardCollapsed);
      setOperationalDashboardState({ operationalDashboardCollapsed });
    });
    els.operationalDashboard?.addEventListener("click", handleOperationalDashboardClick);
    els.operationalDashboard?.addEventListener("keydown", handleOperationalDashboardKeydown);
    loadEbayConversationSavedViews(context);
    loadEbayConversationList(context);
    renderOperationalDashboardPanel(adminClassificationState);
    loadOperationalDashboard(context, { keepPrevious: false });

    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  init().catch((error) => {
    console.error("Email triage initialization failed:", error);
    setStatus("Error", "Email triage could not initialize", error.message || "Unexpected setup error.", "error");
  });
})();
