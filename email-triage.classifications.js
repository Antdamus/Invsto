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
    "return_request",
    "cancellation_request",
    "shipping_status_tracking",
    "shipping_problem",
    "payment_issue",
    "item_question",
    "condition_authenticity_question",
    "missing_item",
    "wrong_item_received",
    "not_as_described",
    "damage_claim",
    "refund_request",
    "buyer_complaint",
    "feedback_issue",
    "custom_order_question",
    "general_question",
    "platform_notice",
  ];
  const EBAY_PRIORITIES = ["high", "normal", "low"];
  const EBAY_RESPONSE_NEEDS = [
    "needs_reply",
    "reply_today",
    "needs_refund_decision",
    "needs_return_approval",
    "needs_shipping_follow_up",
    "needs_inventory_check",
    "needs_photos_evidence",
    "send_template_reply",
    "escalate_to_manager",
    "waiting_on_buyer",
    "waiting_on_carrier",
    "waiting_on_ebay",
    "resolved_closed",
  ];
  const EBAY_CONVERSATION_SOURCE_TYPES = ["member_message", "platform_notification"];
  const EBAY_BUYER_FLAGS = [
    "vip_buyer",
    "high_order_value",
    "repeat_buyer",
    "new_buyer",
    "return_prone_buyer",
    "low_risk_buyer",
  ];
  const EBAY_RISK_FLAGS = [
    "negative_feedback_risk",
    "case_dispute_risk",
    "fraud_abuse_risk",
    "high_dollar_risk",
    "deadline_sensitive",
    "angry_buyer",
    "manager_review",
    "high_return_risk",
    "context_review_needed",
    "low_confidence",
    "stale_context",
  ];
  const EBAY_REVIEW_STATES = ["pending_review", "approved", "corrected", "dismissed"];
  const EMAIL_TRIAGE_TAXONOMY_VERSION = "taxonomy-20260625";

  window.EmailTriageClassifications = {
    EMAIL_TRIAGE_TAXONOMY_VERSION,
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
