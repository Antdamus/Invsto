(function () {
  "use strict";

  const DEFAULT_PAGE = {
    limit: 50,
    cursor: null,
    has_more: false,
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
      filtersExpanded: false,
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
      operationalDashboardCollapsed: Object.prototype.hasOwnProperty.call(overrides, "operationalDashboardCollapsed")
        ? overrides.operationalDashboardCollapsed === true
        : true,
      inboxPreviewLoading: false,
      inboxPreviewError: null,
      inboxPreviewResult: null,
      inboxPreviewSelectedProviderMessageIds: [],
      inboxImportLoading: false,
      inboxImportResult: null,
      inboxLiveRefreshLoading: false,
      inboxLiveRefreshResult: null,
      inboxRematchLoading: false,
      inboxRematchResult: null,
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
