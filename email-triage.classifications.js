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

  const EBAY_TOPIC_TAGS = [
    "return",
    "cancellation",
    "shipping_issue",
    "payment_issue",
    "item_question",
    "missing_item",
    "wrong_item",
    "not_as_described",
    "refund_request",
    "buyer_complaint",
    "custom_order_question",
    "general_question",
    "platform_notice",
    "feedback_issue",
    "offer_question",
    "order_status",
    "delivery_timing",
    "address_change",
  ];
  const EBAY_PRIORITIES = ["high", "normal", "low"];
  const EBAY_RESPONSE_NEEDS = ["reply_today", "reply_later", "no_reply_needed"];
  const EBAY_CONVERSATION_SOURCE_TYPES = ["member_message", "platform_notification"];
  const EBAY_BUYER_FLAGS = [
    "vip_buyer",
    "high_value_buyer",
    "repeat_buyer",
    "new_buyer",
    "high_retained_value_buyer",
    "return_prone_buyer",
    "high_return_risk_buyer",
    "low_risk_buyer",
  ];
  const EBAY_RISK_FLAGS = [
    "refund_risk",
    "chargeback_risk",
    "negative_feedback_risk",
    "return_escalation_risk",
    "cancellation_risk",
    "buyer_unhappy",
    "context_review_needed",
    "low_confidence",
    "unsupported_claim_risk",
  ];
  const EBAY_REVIEW_STATES = ["pending_review", "approved", "corrected", "dismissed"];

  window.EmailTriageClassifications = {
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
  };
})();
