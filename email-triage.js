(function () {
  "use strict";

  const {
    functions: { START_FUNCTION, MESSAGES_FUNCTION, STATUS_FUNCTION, DISCONNECT_FUNCTION },
    requireAdmin,
    edgeFetch,
    normalizeAdminViewPayload,
    isAdminViewEmpty,
    fetchAdminClassificationView,
    fetchOperationalDashboard,
    fetchMessageDetail,
    fetchDraftView,
    requestResponseDraft,
    requestDraftReviewAction,
    fetchMatchContext,
    requestMatchReviewAction,
    saveClassificationReview,
  } = window.EmailTriageApi;
  const { TRANSITIONS, createInitialState, createStore } = window.EmailTriageState;
  const {
    getStoredDensityMode,
    storeDensityMode,
    clampNumber,
    getStoredPanelWidths,
    storePanelWidths,
    applyPanelWidths: applyStoredPanelWidths,
    escapeHtml,
    formatDateTime,
    formatEmailAge,
    formatCompactEmailAge,
    safeErrorMessage,
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
  const { renderMessageRows, bindInboxPreviewImport } = window.EmailTriageInbox;
  const { renderAdminSummary, renderOperationalDashboard } = window.EmailTriageDiagnostics;
  const { successMessageForAction } = window.EmailTriageDrafts;
  const {
    CLASSIFICATION_CATEGORIES,
    REVIEW_STATES,
    OVERRIDE_PRIORITIES,
    OVERRIDE_URGENCIES,
    CATEGORY_GROUPS,
  } = window.EmailTriageClassifications;

  const DASHBOARD_COLLAPSED_STORAGE_KEY = "og-email-triage-dashboard-collapsed";
  const CATEGORY_SORT_STORAGE_KEY = "og-email-triage-category-sort";
  const CUSTOM_CATEGORY_ORDER_STORAGE_KEY = "og-email-triage-custom-category-order";

  const els = {
    connect: document.getElementById("connect-outlook"),
    refresh: document.getElementById("refresh-messages"),
    disconnect: document.getElementById("disconnect-outlook"),
    adminDiagnosticsToggle: document.getElementById("admin-diagnostics-toggle"),
    adminDiagnosticsDrawer: document.getElementById("admin-diagnostics-drawer"),
    mailboxConnectionDot: document.getElementById("mailbox-connection-dot"),
    mailboxToolbarState: document.getElementById("mailbox-toolbar-state"),
    mailboxToolbarEmail: document.getElementById("mailbox-toolbar-email"),
    mailboxToolbarChecked: document.getElementById("mailbox-toolbar-checked"),
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

  const triageStore = createStore(createInitialState({
    data: normalizeAdminViewPayload({}),
    densityMode: getStoredDensityMode(),
    categorySortMode: getStoredCategorySortMode(),
    customCategoryOrder: getStoredCustomCategoryOrder(),
    operationalDashboardCollapsed: getStoredDashboardCollapsed(),
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
      totalMailboxRows: Number(page.total_mailbox_rows || counts.total_mailbox_rows || 0) || 0,
      totalClassifiedRows: Number(page.total_classified_rows || counts.total_current_valid || 0) || 0,
      hasNextPage: page.has_more === true || counts.has_next_page === true,
      hasPreviousPage: page.has_previous_page === true || counts.has_previous_page === true,
    };
  }

  function mailboxQueryFromState(state, overrides = {}) {
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
    };
  });

  function applyPanelWidths(widths = getStoredPanelWidths()) {
    applyStoredPanelWidths(els.classificationInboxShell, widths);
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


  function setStatus(kicker, title, detail, state = "") {
    if (els.statusKicker) els.statusKicker.textContent = kicker;
    if (els.statusTitle) els.statusTitle.textContent = title;
    if (els.statusDetail) els.statusDetail.textContent = detail;
    if (els.statusPanel) {
      els.statusPanel.classList.toggle("is-success", state === "success");
      els.statusPanel.classList.toggle("is-error", state === "error");
    }
  }

  function setMailboxSummary(values = {}) {
    const state = values.state || "checking";
    const email = values.email || "Mailbox unavailable";
    const lastChecked = values.lastChecked ? formatDateTime(values.lastChecked) : "--";
    if (els.mailboxToolbarState) els.mailboxToolbarState.textContent = state;
    if (els.mailboxToolbarEmail) els.mailboxToolbarEmail.textContent = email;
    if (els.mailboxToolbarChecked) els.mailboxToolbarChecked.textContent = `Last checked: ${lastChecked}`;
    if (els.mailboxConnectionDot) {
      els.mailboxConnectionDot.classList.toggle("is-connected", values.status === "connected");
      els.mailboxConnectionDot.classList.toggle("is-attention", values.status === "attention");
    }
  }

  function setStatusMeta(items = []) {
    if (!els.statusMeta) return;
    if (!items.length) {
      els.statusMeta.classList.add("hidden");
      els.statusMeta.innerHTML = "";
      return;
    }

    els.statusMeta.innerHTML = items.map((item) => `
      <div>
        <dt>${escapeHtml(item.label)}</dt>
        <dd>${escapeHtml(item.value || "--")}</dd>
      </div>
    `).join("");
    els.statusMeta.classList.remove("hidden");
  }

  function setLoading(isLoading) {
    [els.connect, els.refresh, els.disconnect].forEach((button) => {
      if (!button) return;
      button.disabled = isLoading;
      button.setAttribute("aria-busy", isLoading ? "true" : "false");
      button.classList.toggle("is-loading", isLoading);
    });
  }

  function setButtonMode(mode) {
    if (mode === "connected") {
      els.refresh?.classList.remove("hidden", "secondary-btn");
      els.refresh?.classList.add("primary-btn");
      els.disconnect?.classList.remove("hidden");
      if (els.connect) {
        els.connect.classList.remove("hidden", "primary-btn");
        els.connect.classList.add("secondary-btn");
        els.connect.innerHTML = `<i data-lucide="mail-plus"></i> Reconnect Outlook`;
      }
    } else if (mode === "attention") {
      els.refresh?.classList.remove("hidden", "primary-btn");
      els.refresh?.classList.add("secondary-btn");
      els.disconnect?.classList.remove("hidden");
      if (els.connect) {
        els.connect.classList.remove("hidden", "secondary-btn");
        els.connect.classList.add("primary-btn");
        els.connect.innerHTML = `<i data-lucide="mail-plus"></i> Reconnect Outlook`;
      }
    } else {
      els.refresh?.classList.add("hidden");
      els.disconnect?.classList.add("hidden");
      if (els.connect) {
        els.connect.classList.remove("hidden", "secondary-btn");
        els.connect.classList.add("primary-btn");
        els.connect.innerHTML = `<i data-lucide="mail-plus"></i> Connect Outlook Mailbox`;
      }
    }

    if (window.lucide?.createIcons) window.lucide.createIcons();
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
      ? "Counts are exact totals for the current mailbox query."
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
        : "No durable mailbox rows match the current query.";
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
          <p class="conversation-empty">Load the selected message detail to view stored Outlook thread blocks.</p>
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
          Draft requires human review. Approved does not send email. Rejected does not delete draft. No Outlook mutation.
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
    if (value === "confirmed") return "success";
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
    const totalMailbox = Number(counts.total_mailbox_rows || 0);
    if (!loaded && !total && emptyResults) {
      return "Fetch succeeded. No current valid classifications returned yet.";
    }
    if (filtered !== total && total > 0) {
      return `Showing ${loaded} visible rows from ${filtered} filtered classifications. Mailbox has ${totalMailbox} imported rows.`;
    }
    if (Number.isFinite(total) && total > 0) {
      return `Showing ${loaded} visible rows from ${total} current valid classifications. Mailbox has ${totalMailbox} imported rows.`;
    }
    return emptyResults ? "Fetch succeeded. No loaded current valid rows returned yet." : "Fetch succeeded. Browse loaded current valid rows below.";
  }

  function renderMailboxPageControls(state, data) {
    const page = pageInfoFromData(data);
    const prepareProgress = state.inboxPrepareResult?.progress || state.inboxMailboxImportResult?.preparation_progress || {};
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
          <strong>Mailbox</strong>
          <span>${escapeHtml(page.totalMailboxRows)} imported · ${escapeHtml(preparedRows)} prepared · ${escapeHtml(page.totalClassifiedRows)} classified · ${escapeHtml(page.filteredRows)} filtered · ${escapeHtml(page.visibleRows)} visible</span>
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
    renderMailboxPageControls(state, data);
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
    } catch (error) {
      setOperationalDashboardState({
        operationalDashboardLoading: false,
        operationalDashboardError: error.code || error.message || "operational_dashboard_failed",
      });
      console.error("[email-triage] operational dashboard fetch failed:", error);
    }
  }

  function operationalEventById(id, state = triageStore.getState()) {
    const events = Array.isArray(state.operationalDashboardSnapshot?.recent_operational_events)
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
    const mailboxQuery = mailboxQueryFromState(currentState, options.mailboxQuery || {});
    setAdminClassificationState({
      status: "loading",
      loading: true,
      fetch_failed: false,
      unauthorized: false,
      empty_results: false,
      error: null,
    });

    try {
      const data = await fetchAdminClassificationView(context, { mailboxQuery });
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
          total_mailbox_rows: page.totalMailboxRows,
          total_classified_rows: page.totalClassifiedRows,
          filters: {
            category: mailboxQuery.category,
            priority: mailboxQuery.priority,
            status: mailboxQuery.status,
            activeFilters: mailboxQuery.filters,
          },
          sort: mailboxQuery.sort,
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

  async function updateMailboxQueryAndLoad(context, overrides = {}) {
    const current = triageStore.getState();
    const query = mailboxQueryFromState(current, overrides);
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
    await loadAdminClassificationData(context, { mailboxQuery: query });
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

  async function loadMailboxStatus(context) {
    return edgeFetch(STATUS_FUNCTION, context.session, { method: "GET" });
  }

  function renderConnectionStatus(connection) {
    const status = String(connection?.status || "").toLowerCase();
    const email = connection?.mailbox_email || "Unknown mailbox";
    const displayName = connection?.display_name || "Not provided";
    const lastChecked = connection?.last_successful_check_at || connection?.updated_at || "";
    const lastError = connection?.last_error_code || "none";

    setMailboxSummary({
      state: status === "error" || status === "reconnect_required" ? "needs attention" : "connected",
      status: status === "error" || status === "reconnect_required" ? "attention" : "connected",
      email,
      lastChecked,
    });

    setStatusMeta([
      { label: "Connected mailbox", value: email },
      { label: "Display name", value: displayName },
      { label: "Status", value: status || "connected" },
      { label: "Last checked", value: formatDateTime(lastChecked) },
      { label: "Last error", value: lastError },
    ]);

    if (status === "error" || status === "reconnect_required") {
      setButtonMode("attention");
      setStatus(
        "Mailbox needs attention",
        "Outlook connection needs attention",
        safeErrorMessage(connection?.last_error_code || status),
        "error",
      );
      return false;
    }

    setButtonMode("connected");
    setStatus(
      "Connected",
      `Outlook mailbox connected: ${email}`,
      "Latest messages will load automatically from the persisted mailbox connection.",
      "success",
    );
    return true;
  }

  function renderDisconnectedStatus() {
    setButtonMode("disconnected");
    setMailboxSummary({
      state: "not connected",
      status: "disconnected",
      email: "Connect Outlook mailbox",
      lastChecked: "",
    });
    setStatusMeta([]);
    els.messagesSection?.classList.add("hidden");
    renderMessages([]);
    setStatus("Not connected", "Outlook connection required", "Connect the OG mailbox to display the latest 10 messages.");
  }

  function renderMessages(messages = []) {
    if (!els.messagesBody) return;

    if (!messages.length) {
      els.messagesBody.innerHTML = `<tr><td colspan="4">No Outlook messages returned.</td></tr>`;
    } else {
      els.messagesBody.innerHTML = renderMessageRows(messages);
    }

    if (els.countPill) {
      const count = messages.length;
      els.countPill.textContent = `${count} ${count === 1 ? "message" : "messages"}`;
    }
  }

  async function loadMessages(context) {
    setLoading(true);
    setMailboxSummary({
      state: "checking",
      status: "attention",
      email: els.mailboxToolbarEmail?.textContent || "Mailbox unavailable",
      lastChecked: new Date().toISOString(),
    });
    setStatus("Checking", "Reading latest Outlook emails", "Calling Microsoft Graph through the Supabase Edge Function.");

    try {
      const payload = await edgeFetch(MESSAGES_FUNCTION, context.session, { method: "POST", body: "{}" });
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      renderMessages(messages);
      els.messagesSection?.classList.remove("hidden");
      setButtonMode("connected");
      setMailboxSummary({
        state: "connected",
        status: "connected",
        email: els.mailboxToolbarEmail?.textContent || "Connected mailbox",
        lastChecked: new Date().toISOString(),
      });
      setStatus("Connected", "Outlook mailbox connected", `Loaded ${messages.length} sanitized message previews.`, "success");
    } catch (error) {
      const code = error.code || error.message;
      renderMessages([]);
      els.messagesSection?.classList.add("hidden");
      setButtonMode(code === "mailbox_not_connected" ? "disconnected" : "attention");
      setMailboxSummary({
        state: code === "mailbox_not_connected" ? "not connected" : "needs attention",
        status: code === "mailbox_not_connected" ? "disconnected" : "attention",
        email: els.mailboxToolbarEmail?.textContent || "Mailbox unavailable",
        lastChecked: new Date().toISOString(),
      });
      setStatus("Mailbox needs attention", "Could not load Outlook emails", safeErrorMessage(code), "error");
    } finally {
      setLoading(false);
    }
  }

  async function connectOutlook(context) {
    setLoading(true);
    setMailboxSummary({
      state: "connecting",
      status: "attention",
      email: els.mailboxToolbarEmail?.textContent || "Microsoft sign-in",
      lastChecked: new Date().toISOString(),
    });
    setStatus("Redirecting", "Opening Microsoft login", "You will return here after Microsoft authorizes mailbox read access.");

    try {
      const payload = await edgeFetch(START_FUNCTION, context.session, {
        method: "POST",
        body: JSON.stringify({ returnTo: window.location.href.split("?")[0] }),
      });

      if (!payload.authorizationUrl) throw new Error("Microsoft authorization URL was not returned.");
      window.location.href = payload.authorizationUrl;
    } catch (error) {
      setStatus("Error", "Could not start Microsoft login", error.message || "Try again after checking Edge Function configuration.", "error");
      setLoading(false);
    }
  }

  async function disconnectOutlook(context) {
    const confirmed = window.confirm("Disconnect Outlook for email triage? This removes the stored server-side refresh token and stops automatic mailbox loading.");
    if (!confirmed) return;

    setLoading(true);
    setMailboxSummary({
      state: "disconnecting",
      status: "attention",
      email: els.mailboxToolbarEmail?.textContent || "Connected mailbox",
      lastChecked: new Date().toISOString(),
    });
    setStatus("Disconnecting", "Disconnecting Outlook mailbox", "Removing the persisted mailbox secret from the server.");

    try {
      await edgeFetch(DISCONNECT_FUNCTION, context.session, {
        method: "POST",
        body: "{}",
      });
      renderDisconnectedStatus();
      setStatus(
        "Disconnected",
        "Outlook mailbox disconnected",
        "Connect Outlook Mailbox is available when you are ready to reconnect.",
      );
    } catch (error) {
      const code = error.code || error.message;
      if (code === "mailbox_not_connected") {
        renderDisconnectedStatus();
        return;
      }
      setButtonMode("attention");
      setStatus("Mailbox needs attention", "Could not disconnect Outlook", safeErrorMessage(code), "error");
    } finally {
      setLoading(false);
    }
  }

  function handleOutlookQueryNotice() {
    const params = new URLSearchParams(window.location.search);
    const outlook = params.get("outlook");
    if (!outlook) return;

    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);

    if (outlook === "error") {
      const reason = params.get("reason") || "reconnect_required";
      setStatus("Mailbox needs attention", "Microsoft login did not finish", safeErrorMessage(reason), "error");
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
      updateMailboxQueryAndLoad(context, { category: selectedCategory, page: 1 });
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
      updateMailboxQueryAndLoad(context, { sort: sortMode, page: 1 });
    });

    els.classificationPageSize?.addEventListener("change", (event) => {
      updateMailboxQueryAndLoad(context, { pageSize: Number(event.target.value || 25), page: 1 });
    });

    els.classificationPriorityFilter?.addEventListener("change", (event) => {
      updateMailboxQueryAndLoad(context, { priority: event.target.value || "all", page: 1 });
    });

    els.classificationStatusFilter?.addEventListener("change", (event) => {
      updateMailboxQueryAndLoad(context, { status: event.target.value || "all", page: 1 });
    });

    els.classificationPrevPage?.addEventListener("click", () => {
      const currentPage = Number(adminClassificationState.pagination?.page || 1);
      if (currentPage <= 1) return;
      updateMailboxQueryAndLoad(context, { page: currentPage - 1 });
    });

    els.classificationNextPage?.addEventListener("click", () => {
      const currentPage = Number(adminClassificationState.pagination?.page || 1);
      updateMailboxQueryAndLoad(context, { page: currentPage + 1 });
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
      setAdminClassificationState({
        filtersExpanded: !adminClassificationState.filtersExpanded,
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
        updateMailboxQueryAndLoad(context, { filters: activeFilters, page: 1 });
      });
    });
  }

  async function init() {
    const context = await requireAdmin({ greetingEl: els.greeting });
    if (!context) return;

    els.connect?.addEventListener("click", () => connectOutlook(context));
    els.refresh?.addEventListener("click", () => loadMessages(context));
    els.disconnect?.addEventListener("click", () => disconnectOutlook(context));
    els.adminDiagnosticsToggle?.addEventListener("click", () => {
      const expanded = els.adminDiagnosticsToggle.getAttribute("aria-expanded") === "true";
      els.adminDiagnosticsToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      els.adminDiagnosticsDrawer?.classList.toggle("hidden", expanded);
    });
    bindPanelResizeEvents();
    bindInboxPreviewImport(context, triageStore, {
      onImportComplete: () => {
        loadAdminClassificationData(context);
        loadOperationalDashboard(context);
      },
      onMailboxImportComplete: () => {
        loadOperationalDashboard(context);
      },
      onPrepareComplete: () => {
        loadAdminClassificationData(context);
        loadOperationalDashboard(context);
        loadSelectedMatchContext(context, { force: true });
        loadSelectedDraftView(context, { force: true });
      },
      onLiveRefreshComplete: () => {
        loadAdminClassificationData(context);
        loadOperationalDashboard(context);
        loadSelectedMatchContext(context, { force: true });
        loadSelectedDraftView(context, { force: true });
      },
      onRematchComplete: () => {
        loadAdminClassificationData(context);
        loadOperationalDashboard(context);
        loadSelectedMatchContext(context, { force: true });
        loadSelectedDraftView(context, { force: true });
      },
    });
    els.refreshClassificationAdmin?.addEventListener("click", () => loadAdminClassificationData(context));
    els.operationalDashboardRefresh?.addEventListener("click", () => loadOperationalDashboard(context));
    els.operationalDashboardToggle?.addEventListener("click", () => {
      const operationalDashboardCollapsed = !adminClassificationState.operationalDashboardCollapsed;
      storeDashboardCollapsed(operationalDashboardCollapsed);
      setOperationalDashboardState({ operationalDashboardCollapsed });
    });
    els.operationalDashboard?.addEventListener("click", handleOperationalDashboardClick);
    els.operationalDashboard?.addEventListener("keydown", handleOperationalDashboardKeydown);
    els.toggleCategoryPanel?.addEventListener("click", () => {
      setAdminClassificationState({
        categoryPanelCollapsed: !adminClassificationState.categoryPanelCollapsed,
      });
    });
    els.toggleDetailPanel?.addEventListener("click", () => {
      setAdminClassificationState({
        detailPanelCollapsed: !adminClassificationState.detailPanelCollapsed,
      });
    });
    bindClassificationInboxEvents(context);

    handleOutlookQueryNotice();
    renderOperationalDashboardPanel(adminClassificationState);
    await loadAdminClassificationData(context);
    loadOperationalDashboard(context, { keepPrevious: false });
    loadSelectedDraftView(context);
    loadSelectedMatchContext(context);

    setLoading(true);
    setMailboxSummary({
      state: "checking",
      status: "attention",
      email: "Mailbox unavailable",
      lastChecked: new Date().toISOString(),
    });
    setStatus("Checking", "Checking persisted Outlook connection", "Loading mailbox status from the Supabase Edge Function.");
    try {
      const payload = await loadMailboxStatus(context);
      if (payload.connected && payload.connection) {
        const canAutoLoad = renderConnectionStatus(payload.connection);
        setLoading(false);
        if (canAutoLoad) await loadMessages(context);
      } else {
        renderDisconnectedStatus();
        setLoading(false);
      }
    } catch (error) {
      setButtonMode("attention");
      setStatusMeta([]);
      setMailboxSummary({
        state: "needs attention",
        status: "attention",
        email: "Mailbox status unavailable",
        lastChecked: new Date().toISOString(),
      });
      setStatus("Mailbox needs attention", "Could not load mailbox status", safeErrorMessage(error.code || error.message), "error");
      setLoading(false);
    }

    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  init().catch((error) => {
    console.error("Email triage initialization failed:", error);
    setStatus("Error", "Email triage could not initialize", error.message || "Unexpected setup error.", "error");
  });
})();
