#!/usr/bin/env node
"use strict";

const DEFAULT_FUNCTION_NAME = "microsoft-email-classify";
const DEFAULT_TIMEOUT_MS = 30000;

const KNOWN_MESSAGES = [
  {
    id: "4effe1f7-2f82-4a86-b8c4-94e986267986",
    label: "weak cancellation",
    expectedDraft: true,
    duplicateClassificationsAreWarning: false,
  },
  {
    id: "514a6c14-2cf6-4233-8fef-95798437ff62",
    label: "return request",
    expectedDraft: true,
    duplicateClassificationsAreWarning: true,
  },
];

function parseArgs(argv) {
  const options = {
    generate: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--generate") options.generate = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (String(process.env.EMAIL_TRIAGE_RUN_MUTATING_CHECKS || "").toLowerCase() === "true") {
    options.generate = true;
  }

  return options;
}

function usage() {
  return [
    "Email Triage Draft Regression Checks",
    "",
    "Usage:",
    "  node tools/email-triage/run-draft-regression-checks.js",
    "  node tools/email-triage/run-draft-regression-checks.js --generate",
    "",
    "Required environment variables:",
    "  SUPABASE_URL",
    "  SUPABASE_ANON_KEY",
    "  EMAIL_TRIAGE_ADMIN_ACCESS_TOKEN",
    "",
    "Optional environment variables:",
    "  EMAIL_TRIAGE_FUNCTION_NAME=microsoft-email-classify",
    "  EMAIL_TRIAGE_REQUEST_TIMEOUT_MS=30000",
    "  EMAIL_TRIAGE_RUN_MUTATING_CHECKS=true",
    "",
    "Default mode is read-only. --generate runs mutating regenerate_response checks.",
  ].join("\n");
}

function readConfig() {
  const missing = [];
  const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const anonKey = String(process.env.SUPABASE_ANON_KEY || "").trim();
  const accessToken = String(process.env.EMAIL_TRIAGE_ADMIN_ACCESS_TOKEN || "").trim();
  const functionName = String(process.env.EMAIL_TRIAGE_FUNCTION_NAME || DEFAULT_FUNCTION_NAME).trim();
  const timeoutMs = Number(process.env.EMAIL_TRIAGE_REQUEST_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);

  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!anonKey) missing.push("SUPABASE_ANON_KEY");
  if (!accessToken) missing.push("EMAIL_TRIAGE_ADMIN_ACCESS_TOKEN");
  if (!functionName) missing.push("EMAIL_TRIAGE_FUNCTION_NAME");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) missing.push("EMAIL_TRIAGE_REQUEST_TIMEOUT_MS");

  if (missing.length) {
    const error = new Error([
      `Missing or invalid required setup: ${missing.join(", ")}`,
      "",
      "Set an authenticated admin session token in EMAIL_TRIAGE_ADMIN_ACCESS_TOKEN.",
      "Do not use a service-role key here. The token is sent as the Bearer token and is never printed.",
      "",
      usage(),
    ].join("\n"));
    error.code = "missing_config";
    throw error;
  }

  return {
    functionUrl: `${supabaseUrl}/functions/v1/${functionName}`,
    anonKey,
    accessToken,
    timeoutMs,
  };
}

function compactJson(value) {
  return JSON.stringify(value, null, 2);
}

function getCurrentDraft(draftViewPayload) {
  const drafts = Array.isArray(draftViewPayload?.drafts) ? draftViewPayload.drafts : [];
  return drafts.find((draft) => draft?.is_current === true) || drafts[0] || null;
}

function bodyPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasDuplicateClassifications(messageStatePayload) {
  return Array.isArray(messageStatePayload?.classifications) && messageStatePayload.classifications.length > 1;
}

function add(results, status, name, details = {}) {
  results.push({ status, name, details });
}

function pass(results, name, details = {}) {
  add(results, "PASS", name, details);
}

function warn(results, name, details = {}) {
  add(results, "WARN", name, details);
}

function fail(results, name, details = {}) {
  add(results, "FAIL", name, details);
}

async function callEdge(config, input) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.functionUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        apikey: config.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new Error(`Non-JSON response from ${input.mode}: HTTP ${response.status}`);
      }
    }

    if (!response.ok || payload?.ok === false) {
      const code = payload?.error || payload?.error_description || payload?.detail || `request_failed_${response.status}`;
      const error = new Error(`${input.mode} failed: ${code}`);
      error.payload = payload;
      throw error;
    }

    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${input.mode} timed out after ${config.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkNoPollutedCurrentDrafts(config, results) {
  const payload = await callEdge(config, {
    mode: "diagnose_all_bad_current_drafts",
    limit: 100,
  });

  const pollutedDrafts = Array.isArray(payload?.polluted_drafts) ? payload.polluted_drafts : [];
  if (Number(payload?.affected_messages || 0) === 0 && pollutedDrafts.length === 0) {
    pass(results, "no polluted current drafts");
    return payload;
  }

  for (const draft of pollutedDrafts) {
    fail(results, "polluted current draft detected", {
      message_id: draft?.message_id || null,
      draft_id: draft?.bad_current_draft_id || null,
      validation_status: draft?.validation_status || null,
      validation_errors: draft?.validation_errors || [],
      suggested_action: "run repair_bad_current_drafts dryRun=true",
    });
  }

  if (!pollutedDrafts.length) {
    fail(results, "polluted current draft detected", {
      affected_messages: payload?.affected_messages,
      suggested_action: "run repair_bad_current_drafts dryRun=true",
    });
  }

  return payload;
}

function validateMessageState(results, message, payload) {
  const canonical = payload?.canonical_current_draft || null;
  const diagnostics = payload?.diagnostics || {};

  if (payload?.pollution_detected === false) {
    pass(results, `${message.label} pollution not detected`);
  } else {
    fail(results, `${message.label} polluted current draft`, {
      message_id: message.id,
      diagnostics,
      canonical_current_draft: canonical,
      suggested_action: "run repair_bad_current_drafts dryRun=true",
    });
  }

  if (canonical?.validation_status === "valid") {
    pass(results, `${message.label} current draft valid`);
  } else {
    fail(results, `${message.label} current draft invalid or missing`, {
      message_id: message.id,
      canonical_current_draft: canonical,
    });
  }

  if (diagnostics.invalid_current_draft_exists === false) {
    pass(results, `${message.label} no invalid current draft`);
  } else {
    fail(results, `${message.label} invalid current draft exists`, {
      message_id: message.id,
      diagnostics,
    });
  }

  if (diagnostics.bodyless_current_draft_exists === false) {
    pass(results, `${message.label} no bodyless current draft`);
  } else {
    fail(results, `${message.label} bodyless current draft exists`, {
      message_id: message.id,
      diagnostics,
    });
  }

  if (message.id === "514a6c14-2cf6-4233-8fef-95798437ff62") {
    if (payload?.best_usable_draft) {
      pass(results, `${message.label} best usable draft exists`);
    } else {
      fail(results, `${message.label} best usable draft missing`, {
        message_id: message.id,
      });
    }
  }

  if (message.duplicateClassificationsAreWarning && hasDuplicateClassifications(payload)) {
    warn(results, `${message.label} has duplicate classifications`, {
      message_id: message.id,
      classification_count: payload.classifications.length,
    });
  }
}

function validateSelectorContract(results, message, payload) {
  const currentDraft = payload?.current_draft || null;
  const uiRisk = payload?.ui_risk || {};

  if (currentDraft?.validation_status === "valid") {
    pass(results, `${message.label} selector current draft usable`);
  } else {
    fail(results, `${message.label} selector current draft not usable`, {
      message_id: message.id,
      current_draft: currentDraft,
    });
  }

  if (uiRisk.classification_mismatch_possible === true) {
    warn(results, `${message.label} selector risk explicit`, {
      message_id: message.id,
      ui_risk: uiRisk,
    });
  } else {
    pass(results, `${message.label} selector risk clear`);
  }
}

function validateDraftView(results, message, payload) {
  const currentDraft = getCurrentDraft(payload);
  if (!currentDraft) {
    const detail = { message_id: message.id, draft_count: payload?.draft_count || 0 };
    if (message.expectedDraft) fail(results, `${message.label} admin_draft_view current draft missing`, detail);
    else warn(results, `${message.label} admin_draft_view current draft missing`, detail);
    return;
  }

  if (currentDraft.validation_status === "valid") {
    pass(results, `${message.label} admin_draft_view current draft valid`);
  } else {
    fail(results, `${message.label} admin_draft_view current draft invalid`, {
      message_id: message.id,
      draft_id: currentDraft.id,
      validation_status: currentDraft.validation_status,
      validation_errors: currentDraft.validation_errors || [],
    });
  }

  if (currentDraft.draft_content_returned === true && bodyPresent(currentDraft.draft_body_text)) {
    pass(results, `${message.label} admin_draft_view returns body`);
  } else {
    fail(results, `${message.label} admin_draft_view body missing`, {
      message_id: message.id,
      draft_id: currentDraft.id,
      draft_content_returned: currentDraft.draft_content_returned,
      draft_content_omitted_reason: currentDraft.draft_content_omitted_reason || null,
    });
  }
}

async function checkKnownMessage(config, results, message) {
  const state = await callEdge(config, {
    mode: "diagnose_message_draft_state",
    messageId: message.id,
  });
  validateMessageState(results, message, state);

  const selector = await callEdge(config, {
    mode: "diagnose_selector_contract",
    messageId: message.id,
  });
  validateSelectorContract(results, message, selector);

  const draftView = await callEdge(config, {
    mode: "admin_draft_view",
    messageId: message.id,
    includeDraftBody: true,
    limit: 20,
  });
  validateDraftView(results, message, draftView);

  return { state, selector, draftView };
}

async function checkRegenerate(config, results, message) {
  const draftViewBefore = await callEdge(config, {
    mode: "admin_draft_view",
    messageId: message.id,
    includeDraftBody: true,
    limit: 20,
  });
  const currentDraftBefore = getCurrentDraft(draftViewBefore);

  const payload = await callEdge(config, {
    mode: "regenerate_response",
    messageId: message.id,
    classificationId: currentDraftBefore?.classification_id || undefined,
    draftId: currentDraftBefore?.id || undefined,
  });

  if (payload?.draft_became_current === true) {
    const generatedDraftView = payload?.draft_id
      ? await callEdge(config, {
        mode: "admin_draft_view",
        draftId: payload.draft_id,
        includeDraftBody: true,
        limit: 1,
      })
      : null;
    const generatedDraft = getCurrentDraft(generatedDraftView);

    if (
      payload.validation_status === "valid" &&
      generatedDraft?.draft_content_returned === true &&
      bodyPresent(generatedDraft?.draft_body_text)
    ) {
      pass(results, `${message.label} mutating regenerate valid current with body`);
    } else {
      fail(results, `${message.label} mutating regenerate current draft unsafe`, {
        message_id: message.id,
        draft_id: payload?.draft_id || null,
        validation_status: payload?.validation_status || null,
        draft_content_returned: generatedDraft?.draft_content_returned || false,
        draft_body_text_present: bodyPresent(generatedDraft?.draft_body_text),
        draft_content_omitted_reason: generatedDraft?.draft_content_omitted_reason || null,
      });
    }
  } else if (payload?.draft_became_current === false) {
    if (payload.previous_current_draft_preserved === true) {
      pass(results, `${message.label} mutating regenerate preserved previous current`);
    } else {
      fail(results, `${message.label} mutating regenerate did not preserve previous current`, {
        message_id: message.id,
        draft_id: payload?.draft_id || null,
        validation_status: payload?.validation_status || null,
      });
    }
  } else {
    fail(results, `${message.label} mutating regenerate missing current-state result`, {
      message_id: message.id,
      payload,
    });
  }

  const stateAfter = await callEdge(config, {
    mode: "diagnose_message_draft_state",
    messageId: message.id,
  });

  if (stateAfter?.pollution_detected === false) {
    pass(results, `${message.label} mutating regenerate created no pollution`);
  } else {
    fail(results, `${message.label} mutating regenerate created polluted current draft`, {
      message_id: message.id,
      diagnostics: stateAfter?.diagnostics || {},
      canonical_current_draft: stateAfter?.canonical_current_draft || null,
    });
  }
}

function printSummary(results, options) {
  console.log("");
  console.log("Email Triage Draft Regression Checks");
  console.log("");
  console.log(`Mode: ${options.generate ? "MUTATING --generate" : "read-only"}`);
  console.log("");

  for (const result of results) {
    console.log(`${result.status} ${result.name}`);
    if (result.status === "FAIL") {
      for (const [key, value] of Object.entries(result.details || {})) {
        const printable = typeof value === "string" || value === null ? value : compactJson(value);
        console.log(`  ${key}: ${printable}`);
      }
    }
  }

  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});

  console.log("");
  console.log(`Summary: ${counts.PASS || 0} pass, ${counts.WARN || 0} warn, ${counts.FAIL || 0} fail`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const config = readConfig();
  const results = [];

  await checkNoPollutedCurrentDrafts(config, results);

  for (const message of KNOWN_MESSAGES) {
    await checkKnownMessage(config, results, message);
  }

  if (options.generate) {
    warn(results, "mutating checks enabled", {
      note: "regenerate_response creates draft rows and may change the current draft only when the generated draft is valid",
    });
    for (const message of KNOWN_MESSAGES) {
      await checkRegenerate(config, results, message);
    }
  }

  printSummary(results, options);

  if (results.some((result) => result.status === "FAIL")) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("");
  console.error("Email Triage Draft Regression Checks");
  console.error("");
  console.error("FAIL setup or request failed");
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
