(function () {
  "use strict";

  const CLASSIFICATION_CATEGORIES = [
    "buyer_message",
    "order_paid",
    "shipping_label",
    "shipping_issue",
    "return_request",
    "refund_request",
    "cancellation_request",
    "item_not_received",
    "item_not_as_described",
    "payment_issue",
    "offer_or_negotiation",
    "inventory_question",
    "authenticity_or_condition_question",
    "platform_notice",
    "account_security",
    "marketing_or_promotion",
    "spam_or_noise",
    "internal_or_other",
  ];

  const REVIEW_STATES = ["pending_review", "approved", "corrected", "dismissed"];
  const OVERRIDE_PRIORITIES = ["low", "medium", "high", "critical"];
  const OVERRIDE_URGENCIES = ["none", "later", "soon", "today", "immediate"];
  const CATEGORY_GROUPS = [
    { id: "all", label: "All", categories: [] },
    { id: "return_requests", label: "Return Requests", categories: ["return_request", "refund_request", "cancellation_request"] },
    { id: "item_not_as_described", label: "Item Not As Described", categories: ["item_not_as_described"] },
    { id: "shipping_labels", label: "Shipping Labels", categories: ["shipping_label", "shipping_issue", "item_not_received"] },
    { id: "marketing_or_promotion", label: "Marketing/Promotion", categories: ["marketing_or_promotion"] },
    { id: "internal_other", label: "Internal/Other", categories: ["internal_or_other", "spam_or_noise", "platform_notice", "buyer_message", "order_paid", "payment_issue", "offer_or_negotiation", "inventory_question", "authenticity_or_condition_question", "account_security"] },
    { id: "human_review", label: "Human Review", categories: [] },
  ];

  window.EmailTriageClassifications = {
    CLASSIFICATION_CATEGORIES,
    REVIEW_STATES,
    OVERRIDE_PRIORITIES,
    OVERRIDE_URGENCIES,
    CATEGORY_GROUPS,
  };
})();
