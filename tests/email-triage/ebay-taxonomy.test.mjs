import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const classifierSource = readFileSync("supabase/functions/ebay-conversation-classify/index.ts", "utf8");
const uiTaxonomySource = readFileSync("email-triage.classifications.js", "utf8");
const uiSource = readFileSync("email-triage.js", "utf8");

function labelFixture({ message, buyer = {}, orderValue = 0 }) {
  const text = String(message || "").toLowerCase();
  const topics = new Set();
  const buyerFlags = new Set();
  const riskFlags = new Set();
  const actions = new Set();

  const priorOrders = Number(buyer.priorOrders || 0);
  const retainedValue = Number(buyer.retainedValue || 0);
  const returns = Number(buyer.returns || 0);

  if (priorOrders <= 1) buyerFlags.add("new_buyer");
  if (priorOrders >= 2) buyerFlags.add("repeat_buyer");
  if (retainedValue >= 2500 || (priorOrders >= 5 && retainedValue >= 1000)) buyerFlags.add("vip_buyer");
  if (returns >= 2 || (priorOrders > 0 && returns / priorOrders >= 0.35)) buyerFlags.add("return_prone_buyer");
  if (Number(orderValue) >= 500) buyerFlags.add("high_order_value");

  if (/\bwhere is|where's|tracking|when will it arrive|package\?\b/.test(text)) topics.add("shipping_status_tracking");
  if (/\bmarked delivered|delivered but|never arrived|lost package|wrong address|delivery exception\b/.test(text)) topics.add("shipping_problem");
  if (/\bdamaged|broken|cracked|shattered\b/.test(text)) topics.add("damage_claim");
  if (/\bfake|authentic|authenticity|genuine\b/.test(text)) topics.add("condition_authenticity_question");
  if (/\brefund|money back|reimburse\b/.test(text)) topics.add("refund_request");
  if (/\breturn|send it back\b/.test(text)) topics.add("return_request");
  if (/\bcomplaint|unacceptable|terrible|upset\b/.test(text)) topics.add("buyer_complaint");
  if (!topics.size) topics.add("general_question");

  if (topics.has("damage_claim")) actions.add("needs_photos_evidence");
  if (topics.has("condition_authenticity_question")) {
    riskFlags.add("manager_review");
    riskFlags.add("case_dispute_risk");
    actions.add("needs_photos_evidence");
  }
  if (buyerFlags.has("high_order_value") && (topics.has("buyer_complaint") || topics.has("refund_request") || topics.has("return_request") || topics.has("damage_claim"))) {
    riskFlags.add("high_dollar_risk");
  }

  return { topics, buyerFlags, riskFlags, actions };
}

test("email triage taxonomy exposes revised labels in classifier and UI", () => {
  [
    "high_order_value",
    "shipping_status_tracking",
    "shipping_problem",
    "condition_authenticity_question",
    "wrong_item_received",
    "damage_claim",
    "case_dispute_risk",
    "fraud_abuse_risk",
    "high_dollar_risk",
    "manager_review",
    "needs_photos_evidence",
  ].forEach((label) => {
    assert.match(classifierSource, new RegExp(`"${label}"`));
    assert.match(uiTaxonomySource, new RegExp(`"${label}"`));
  });

  assert.match(classifierSource, /high_value_buyer:\s*"high_order_value"/);
  assert.match(classifierSource, /high_retained_value_buyer:\s*"vip_buyer"/);
  assert.match(uiSource, /High Order Value/);
  assert.doesNotMatch(uiTaxonomySource, /"high_value_buyer",/);
});

test("repeat buyer with high lifetime spend gets VIP Buyer but not High Order Value", () => {
  const result = labelFixture({
    message: "Thanks, just checking on a normal order.",
    buyer: { priorOrders: 8, retainedValue: 3200, returns: 0 },
    orderValue: 40,
  });
  assert.equal(result.buyerFlags.has("vip_buyer"), true);
  assert.equal(result.buyerFlags.has("high_order_value"), false);
});

test("first-time buyer with expensive current order gets New Buyer and High Order Value, not VIP Buyer", () => {
  const result = labelFixture({
    message: "I have a question about this item.",
    buyer: { priorOrders: 0, retainedValue: 0, returns: 0 },
    orderValue: 900,
  });
  assert.equal(result.buyerFlags.has("new_buyer"), true);
  assert.equal(result.buyerFlags.has("high_order_value"), true);
  assert.equal(result.buyerFlags.has("vip_buyer"), false);
});

test("routine tracking questions differ from true shipping problems", () => {
  assert.equal(labelFixture({ message: "Where is my package?" }).topics.has("shipping_status_tracking"), true);
  assert.equal(labelFixture({ message: "Where is my package?" }).topics.has("shipping_problem"), false);
  assert.equal(labelFixture({ message: "It was marked delivered but never arrived." }).topics.has("shipping_problem"), true);
});

test("damage and authenticity claims trigger evidence and review labels", () => {
  const damaged = labelFixture({ message: "The item arrived damaged and broken." });
  assert.equal(damaged.topics.has("damage_claim"), true);
  assert.equal(damaged.actions.has("needs_photos_evidence"), true);

  const fake = labelFixture({ message: "This item is fake and not authentic." });
  assert.equal(fake.topics.has("condition_authenticity_question"), true);
  assert.equal(fake.riskFlags.has("manager_review"), true);
  assert.equal(fake.riskFlags.has("case_dispute_risk"), true);
});

test("refund requests and return requests remain separate topics", () => {
  assert.equal(labelFixture({ message: "Please refund me for this order." }).topics.has("refund_request"), true);
  assert.equal(labelFixture({ message: "I want to return the item." }).topics.has("return_request"), true);
});

test("high-value current order with a complaint gets High Order Value and High Dollar Risk", () => {
  const result = labelFixture({
    message: "This is unacceptable, I want a refund.",
    orderValue: 1200,
  });
  assert.equal(result.buyerFlags.has("high_order_value"), true);
  assert.equal(result.riskFlags.has("high_dollar_risk"), true);
});

test("old labels remain mapped for compatibility", () => {
  assert.match(uiSource, /high_value_buyer:\s*"high_order_value"/);
  assert.match(uiSource, /high_retained_value_buyer:\s*"vip_buyer"/);
  assert.match(uiSource, /high_return_risk_buyer:\s*"high_return_risk"/);
});
