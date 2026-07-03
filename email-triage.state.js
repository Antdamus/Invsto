(function () {
  "use strict";

  const DEFAULT_PAGE = {
    page: 1,
    pageSize: 25,
    limit: 25,
    offset: 0,
    cursor: null,
    has_more: false,
    has_previous_page: false,
    total_pages: 1,
    filtered_rows: 0,
    total_classified_rows: 0,
    filters: {},
    sort: "newest",
  };

  const TRANSITIONS = {
    LOAD_STARTED: "LOAD_STARTED",
    LOAD_SUCCEEDED: "LOAD_SUCCEEDED",
    LOAD_FAILED: "LOAD_FAILED",
    OPERATION_STARTED: "OPERATION_STARTED",
    OPERATION_COMPLETED: "OPERATION_COMPLETED",
    OPERATION_FAILED: "OPERATION_FAILED",
    SET_STATE: "SET_STATE",
  };

  function createInitialState(overrides = {}) {
    return {
      activeView: "classifications",
      status: "idle",
      loading: false,
      fetch_failed: false,
      unauthorized: false,
      empty_results: false,
      error: null,
      data: overrides.data || {},
      selectedCategory: "all",
      selectedClassificationId: null,
      selectedMessageId: null,
      selectedDraftId: null,
      categoryPanelCollapsed: false,
      detailPanelCollapsed: false,
      activeFilters: [],
      priorityFilter: "all",
      statusFilter: "all",
      filtersExpanded: Object.prototype.hasOwnProperty.call(overrides, "filtersExpanded")
        ? overrides.filtersExpanded === true
        : false,
      sortMode: "newest",
      pagination: { ...DEFAULT_PAGE },
      queueStatus: {},
      operationInFlight: null,
      lastRefreshTimestamps: {},
      rolloutStatus: {},
      liveSyncStatus: {},
      diagnosticsSnapshot: null,
      operationalDashboardLoading: false,
      operationalDashboardError: null,
      operationalDashboardSnapshot: null,
      operationalDashboardUpdatedAt: null,
      selectedOperationalEventId: null,
      selectedOperationalEventDetail: null,
      operationalEventDetailOpen: false,
      ebayConversationLoading: false,
      ebayConversationLoadingMore: false,
      ebayConversationError: null,
      ebayConversations: [],
      ebayMailboxMode: "rpc",
      ebayMailboxWarning: null,
      ebayMailboxPagination: {
        canonical_total: null,
        matching_total: null,
        loaded_count: 0,
        page_size: 100,
        offset: 0,
        next_offset: null,
        has_more: false,
        rpc_version: null,
      },
      ebayMailboxSmartFolderCounts: {},
      ebayMailboxFilterOptionCounts: {},
      ebayConversationFilter: "all",
      ebayConversationSearchQuery: "",
      ebayConversationClassificationFilters: {
        sourceTypes: [],
        topics: [],
        buyerFlags: [],
        riskFlags: [],
        priorities: [],
        responseNeeds: [],
      },
      ebayConversationSavedViews: [],
      ebayConversationSavedViewsLoading: false,
      ebayConversationSavedViewsError: null,
      ebayConversationSavedViewSavingId: null,
      ebayConversationSavedViewActionError: null,
      ebayConversationSavedViewCounts: {},
      ebayConversationSavedViewCountsLoading: false,
      ebayConversationUserReadStates: overrides.ebayConversationUserReadStates || {},
      selectedEbaySavedViewId: null,
      ebayConversationSmartFoldersEditing: false,
      ebayConversationSmartFolderEditDraft: null,
      ebayConversationSmartFolderCreateDraft: null,
      ebayConversationPanelVisibility: overrides.ebayConversationPanelVisibility || {
        folders: true,
        list: true,
        context: true,
      },
      ebayConversationTagHelpOpen: false,
      ebayConversationFiltersExpanded: Object.prototype.hasOwnProperty.call(overrides, "ebayConversationFiltersExpanded")
        ? overrides.ebayConversationFiltersExpanded === true
        : false,
      ebayConversationDensityMode: overrides.ebayConversationDensityMode || "compact",
      selectedEbayConversationId: null,
      ebayConversationLastLoadedAt: null,
      ebayConversationMessagesById: {},
      ebayConversationOptimisticMessagesById: {},
      ebayConversationMessagesLoadingId: null,
      ebayConversationMessageErrorsById: {},
      ebayConversationContextsById: {},
      ebayConversationContextLoadingId: null,
      ebayConversationContextErrorsById: {},
      ebayConversationDraftsById: {},
      ebayConversationDraftLoadingId: null,
      ebayConversationDraftErrorsById: {},
      ebayConversationDraftActionLoadingId: null,
      ebayConversationDraftActionErrorsById: {},
      ebayConversationDraftActionMessagesById: {},
      ebayMessageTranslationsById: {},
      ebayMessageTranslationLoadingId: null,
      ebayMessageTranslationErrorsById: {},
      ebayConversationTaskModal: null,
      ebayConversationTaskAssignees: [],
      ebayConversationTaskAssigneesLoading: false,
      ebayConversationTaskSaving: false,
      ebayConversationTaskError: null,
      ebayConversationTaskMessage: null,
      ebayConversationTaskSummariesById: {},
      ebayConversationTaskSummariesLoading: false,
      ebayConversationTaskSummariesError: null,
      ebayConversationTaskAuditModal: null,
      ebayConversationClassificationCollapsed: Object.prototype.hasOwnProperty.call(overrides, "ebayConversationClassificationCollapsed")
        ? overrides.ebayConversationClassificationCollapsed === true
        : false,
      ebayDraftMetadataCollapsed: Object.prototype.hasOwnProperty.call(overrides, "ebayDraftMetadataCollapsed")
        ? overrides.ebayDraftMetadataCollapsed === true
        : true,
      ebayConversationSyncLoading: false,
      ebayConversationSyncOperation: null,
      ebayConversationSyncResult: null,
      ebayConversationSyncError: null,
      ebayConversationReadSyncLoadingId: null,
      ebayConversationClassificationLoadingId: null,
      ebayConversationClassificationBatchLoading: false,
      ebayConversationClassificationResult: null,
      ebayConversationClassificationErrorsById: {},
      ebayConversationClassificationEditingId: null,
      ebayConversationClassificationSavingId: null,
      ebayConversationClassificationSaveErrorsById: {},
      operationalDashboardCollapsed: Object.prototype.hasOwnProperty.call(overrides, "operationalDashboardCollapsed")
        ? overrides.operationalDashboardCollapsed === true
        : true,
      inboxPreviewLoading: false,
      inboxPreviewError: null,
      inboxPreviewResult: null,
      inboxPreviewSelectedProviderMessageIds: [],
      inboxImportLoading: false,
      inboxImportResult: null,
      inboxImportResultCleared: false,
      inboxPrepareLoading: false,
      inboxPrepareResult: null,
      inboxPrepareResultCleared: false,
      inboxLiveRefreshLoading: false,
      inboxLiveRefreshResult: null,
      inboxLiveRefreshResultCleared: false,
      inboxRematchLoading: false,
      inboxRematchResult: null,
      inboxRematchResultCleared: false,
      inboxRematchScope: "selected",
      inboxLastOperationId: null,
      inboxLastRefreshedAt: null,
      inboxActiveBucketFilter: "likely_ebay",
      inboxPreviewControls: {
        limit: 25,
        daysBack: "",
        bucketMode: "ebay_only",
      },
      densityMode: overrides.densityMode || "expanded",
      categorySortMode: overrides.categorySortMode || "default",
      customCategoryOrder: Array.isArray(overrides.customCategoryOrder) ? overrides.customCategoryOrder : [],
      customCategoryOrderEditing: overrides.customCategoryOrderEditing === true,
      customCategoryOrderDraft: Array.isArray(overrides.customCategoryOrderDraft) ? overrides.customCategoryOrderDraft : null,
      messageDetailsById: {},
      selectedClassificationsById: {},
      messageDetailLoadingId: null,
      messageDetailErrorsById: {},
      expandedMessageIds: {},
      reviewSavingId: null,
      reviewErrorsById: {},
      draftsByMessageId: {},
      draftLoadingMessageId: null,
      draftErrorsByMessageId: {},
      draftActionMessageId: null,
      draftActionErrorsByMessageId: {},
      draftActionMessagesByMessageId: {},
      matchContextsByMessageId: {},
      matchContextLoadingId: null,
      matchContextErrorsByMessageId: {},
      matchActionLinkId: null,
      matchActionMessagesByMessageId: {},
      updatedAt: null,
      ...overrides,
    };
  }

  function reducer(state, action = {}) {
    const now = new Date().toISOString();
    const payload = action.payload || {};

    if (action.type === TRANSITIONS.LOAD_STARTED) {
      return {
        ...state,
        ...payload,
        loading: true,
        error: null,
        operationInFlight: payload.operationInFlight || state.operationInFlight,
      };
    }

    if (action.type === TRANSITIONS.LOAD_SUCCEEDED) {
      return {
        ...state,
        ...payload,
        loading: false,
        fetch_failed: false,
        unauthorized: false,
        error: null,
        operationInFlight: null,
        updatedAt: payload.updatedAt || now,
        lastRefreshTimestamps: {
          ...state.lastRefreshTimestamps,
          [payload.refreshKey || "default"]: payload.updatedAt || now,
        },
      };
    }

    if (action.type === TRANSITIONS.LOAD_FAILED) {
      return {
        ...state,
        ...payload,
        loading: false,
        fetch_failed: payload.fetch_failed ?? true,
        error: payload.error || state.error,
        operationInFlight: null,
        updatedAt: payload.updatedAt || now,
      };
    }

    if (action.type === TRANSITIONS.OPERATION_STARTED) {
      return {
        ...state,
        ...payload,
        operationInFlight: payload.operationInFlight || payload.operationId || action.operationId || "operation",
      };
    }

    if (action.type === TRANSITIONS.OPERATION_COMPLETED) {
      return {
        ...state,
        ...payload,
        operationInFlight: null,
        updatedAt: payload.updatedAt || now,
      };
    }

    if (action.type === TRANSITIONS.OPERATION_FAILED) {
      return {
        ...state,
        ...payload,
        operationInFlight: null,
        error: payload.error || state.error,
        updatedAt: payload.updatedAt || now,
      };
    }

    if (action.type === TRANSITIONS.SET_STATE) {
      return {
        ...state,
        ...payload,
      };
    }

    return state;
  }

  function createStore(initialState = createInitialState()) {
    let state = initialState;
    const listeners = new Set();

    function getState() {
      return state;
    }

    function dispatch(action) {
      state = reducer(state, action);
      listeners.forEach((listener) => listener(state, action));
      return action;
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    return { getState, dispatch, subscribe };
  }

  window.EmailTriageState = {
    DEFAULT_PAGE,
    TRANSITIONS,
    createInitialState,
    reducer,
    createStore,
  };
})();
