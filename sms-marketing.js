(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);

  let supabaseClient = null;
  let latestSummary = null;

  function waitForSupabaseReady(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const ready = () => window.supabaseClient || window.supabase;
      const current = ready();
      if (current?.auth?.getSession) return resolve(current);

      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Supabase did not finish loading."));
      }, timeoutMs);

      document.addEventListener("supabase-ready", () => {
        if (settled) return;
        const client = ready();
        if (!client?.auth?.getSession) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(client);
      }, { once: true });
    });
  }

  function show(el, visible) {
    if (el) el.classList.toggle("hidden", !visible);
  }

  function setStatus(message, kind = "") {
    const el = $("#sendStatus");
    if (!el) return;
    el.textContent = message || "";
    el.className = `send-status ${kind}`.trim();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Not set";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function normalizeSpaces(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function cleanLink(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function buildPreviewBody() {
    let body = normalizeSpaces($("#messageBody")?.value || "Our live show starts tonight at 8 PM.");
    const link = cleanLink($("#linkUrl")?.value);
    if (link && !body.includes(link)) body = `${body} ${link}`;
    if (!/^og jewel(?:ry|ers):/i.test(body)) body = `OG Jewelry: ${body}`;
    if (!/\breply\s+stop\b|\bstop\s+to\s+unsubscribe\b|\bunsubscribe\b/i.test(body)) {
      body = `${body.replace(/[. ]+$/, "")}. Reply STOP to unsubscribe.`;
    }
    return normalizeSpaces(body);
  }

  function updatePreview() {
    const body = buildPreviewBody();
    const preview = $("#smsPreview");
    const count = $("#charCount");
    if (preview) preview.textContent = body;
    if (count) {
      count.textContent = `${body.length} / 480`;
      count.style.color = body.length > 480 ? "var(--danger)" : "";
    }
    const sendBtn = $("#sendBtn");
    if (sendBtn) sendBtn.disabled = body.length > 480;
  }

  async function ensureAdmin() {
    const { data: sessionData } = await supabaseClient.auth.getSession();
    const user = sessionData?.session?.user;
    if (!user?.id) {
      window.location.href = "index.html?next=" + encodeURIComponent("sms-marketing.html");
      return false;
    }

    const { data: employee, error } = await supabaseClient
      .from("employees")
      .select("role, active")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error || !employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
      show($("#guardDenied"), true);
      return false;
    }

    return true;
  }

  async function invokeSmsAdmin(payload) {
    const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
    if (sessionError) throw sessionError;
    const token = sessionData?.session?.access_token;
    if (!token) throw new Error("Missing admin session.");

    const url = `${window.SUPABASE_URL}/functions/v1/sms-marketing-admin`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": window.SUPABASE_ANON_KEY || "",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.ok === false) {
      throw new Error(data?.message || data?.error || `Request failed (${response.status})`);
    }
    return data;
  }

  function renderCounts(summary) {
    $("#subscribedCount").textContent = Number(summary?.subscribedCount || 0).toLocaleString();
    $("#unsubscribedCount").textContent = Number(summary?.unsubscribedCount || 0).toLocaleString();
    $("#totalCount").textContent = Number(summary?.totalCount || 0).toLocaleString();
    $("#audiencePill").textContent = `${Number(summary?.subscribedCount || 0).toLocaleString()} recipients`;
  }

  function renderSubscribers(rows = []) {
    const host = $("#recentSubscribers");
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = `<div class="subscriber-row"><span>No SMS subscribers yet.</span></div>`;
      return;
    }

    host.innerHTML = rows.map((row) => `
      <article class="subscriber-row">
        <strong>${escapeHtml(row.phone_e164)}</strong>
        <span>${escapeHtml(row.name || row.email || "Customer")}</span>
        <span>${escapeHtml(row.status || "unknown")} / ${escapeHtml(row.source || "direct")}${row.campaign ? ` / ${escapeHtml(row.campaign)}` : ""}</span>
        <span>${escapeHtml(row.status === "unsubscribed" ? formatDate(row.opted_out_at) : formatDate(row.opted_in_at || row.last_inbound_at))}</span>
      </article>
    `).join("");
  }

  function renderCampaigns(rows = []) {
    const host = $("#campaignHistory");
    if (!host) return;
    if (!rows.length) {
      host.innerHTML = `<div class="campaign-row"><span>No SMS campaigns sent yet.</span></div>`;
      return;
    }

    host.innerHTML = rows.map((row) => `
      <article class="campaign-row">
        <strong>${escapeHtml(row.title || "SMS campaign")}</strong>
        <p>${escapeHtml(row.final_body || "")}</p>
        <div class="campaign-meta">
          <span>${escapeHtml(row.status || "unknown")}</span>
          <span>${Number(row.sent_count || 0).toLocaleString()} sent</span>
          <span>${Number(row.failed_count || 0).toLocaleString()} failed</span>
          <span>${Number(row.skipped_count || 0).toLocaleString()} skipped</span>
          <span>${escapeHtml(formatDate(row.created_at))}</span>
        </div>
      </article>
    `).join("");
  }

  function renderSummary(summary) {
    latestSummary = summary || {};
    renderCounts(latestSummary);
    renderSubscribers(latestSummary.recentSubscribers || []);
    renderCampaigns(latestSummary.recentCampaigns || []);
  }

  async function loadSummary() {
    setStatus("Refreshing...");
    const data = await invokeSmsAdmin({ action: "summary" });
    renderSummary(data.summary || {});
    setStatus("");
  }

  async function sendCampaign(event) {
    event.preventDefault();
    setStatus("");
    updatePreview();

    const audienceCount = Number(latestSummary?.subscribedCount || 0);
    const body = buildPreviewBody();
    if (!String($("#messageBody")?.value || "").trim()) {
      setStatus("Write the message first.", "error");
      $("#messageBody")?.focus();
      return;
    }
    if (body.length > 480) {
      setStatus("The final SMS is too long.", "error");
      return;
    }
    if (audienceCount <= 0) {
      setStatus("There are no subscribed customers yet.", "error");
      return;
    }

    const ok = window.confirm(`Send this SMS to ${audienceCount.toLocaleString()} subscribed customers?`);
    if (!ok) return;

    const sendBtn = $("#sendBtn");
    if (sendBtn) sendBtn.disabled = true;
    setStatus("Sending SMS campaign...");

    try {
      const data = await invokeSmsAdmin({
        action: "send",
        confirm: "SEND_OG_SMS",
        title: $("#campaignTitle")?.value || "",
        message: $("#messageBody")?.value || "",
        linkUrl: $("#linkUrl")?.value || "",
      });

      const result = data.result || {};
      renderSummary(data.summary || latestSummary || {});
      setStatus(
        `Sent ${Number(result.sentCount || 0).toLocaleString()} of ${Number(result.audienceCount || 0).toLocaleString()} recipients. Failed: ${Number(result.failedCount || 0).toLocaleString()}. Skipped: ${Number(result.skippedCount || 0).toLocaleString()}.`,
        result.failedCount || result.skippedCount ? "error" : "ok",
      );
    } catch (error) {
      setStatus(error?.message || "SMS campaign failed.", "error");
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      updatePreview();
    }
  }

  async function init() {
    supabaseClient = await waitForSupabaseReady();
    show($("#guardLoading"), true);
    show($("#guardDenied"), false);
    show($("#smsApp"), false);

    const allowed = await ensureAdmin();
    show($("#guardLoading"), false);
    show($("#smsApp"), allowed);
    if (!allowed) return;

    $("#refreshBtn")?.addEventListener("click", () => {
      loadSummary().catch((error) => setStatus(error?.message || "Refresh failed.", "error"));
    });
    $("#smsForm")?.addEventListener("submit", sendCampaign);
    $("#messageBody")?.addEventListener("input", updatePreview);
    $("#linkUrl")?.addEventListener("input", updatePreview);

    updatePreview();
    await loadSummary();
  }

  document.addEventListener("DOMContentLoaded", () => {
    init().catch((error) => {
      console.error("[sms-marketing] init failed", error);
      show($("#guardLoading"), false);
      show($("#guardDenied"), true);
      setStatus(error?.message || "SMS Alerts could not load.", "error");
    });
  });
})();
