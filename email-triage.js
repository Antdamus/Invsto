(function () {
  "use strict";

  const START_FUNCTION = "microsoft-auth-start";
  const MESSAGES_FUNCTION = "microsoft-latest-messages";
  const STATUS_FUNCTION = "microsoft-mailbox-status";
  const DISCONNECT_FUNCTION = "microsoft-mailbox-disconnect";

  const els = {
    connect: document.getElementById("connect-outlook"),
    refresh: document.getElementById("refresh-messages"),
    disconnect: document.getElementById("disconnect-outlook"),
    statusPanel: document.getElementById("email-status-panel"),
    statusKicker: document.getElementById("email-status-kicker"),
    statusTitle: document.getElementById("email-status-title"),
    statusDetail: document.getElementById("email-status-detail"),
    statusMeta: document.getElementById("email-status-meta"),
    messagesSection: document.getElementById("email-messages-section"),
    messagesBody: document.getElementById("email-messages-body"),
    countPill: document.getElementById("message-count-pill"),
    greeting: document.getElementById("admin-greeting"),
  };

  function waitForSupabaseReady(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (window.supabase?.auth?.getSession) return resolve(window.supabase);

      let done = false;
      const timeout = window.setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error("Supabase not ready. Did initSupabase.js load?"));
      }, timeoutMs);

      document.addEventListener("supabase-ready", () => {
        if (done) return;
        if (!window.supabase?.auth?.getSession) return;
        done = true;
        window.clearTimeout(timeout);
        resolve(window.supabase);
      }, { once: true });
    });
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "--";
    return date.toLocaleString(undefined, {
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function safeErrorMessage(code) {
    const messages = {
      mailbox_not_connected: "No persisted Outlook mailbox is connected yet.",
      token_refresh_failed: "Microsoft could not refresh mailbox access. Reconnect Outlook to restore message loading.",
      reconnect_required: "Outlook access needs to be renewed. Reconnect Outlook to continue.",
      graph_messages_failed: "Microsoft Graph could not return the latest messages. Try Refresh, then reconnect if it continues.",
      multiple_active_connections: "More than one active mailbox connection was found. Ask an admin to clean up the connection records.",
      admin_required: "Only active admins can manage the Outlook mailbox connection.",
      configuration_error: "The mailbox Edge Function is missing required server configuration.",
      unauthorized: "Your admin session expired. Sign in again before loading mailbox status.",
      invalid_session: "Your admin session expired. Sign in again before loading messages.",
      missing_authorization: "Your admin session was not sent to the mailbox function.",
      forbidden: "Only active admins can disconnect the Outlook mailbox.",
      disconnect_failed: "Outlook could not be disconnected. Try again, then check the Edge Function logs if it continues.",
      status_lookup_failed: "Mailbox status could not be loaded. Try refreshing the page.",
      connection_lookup_failed: "Mailbox connection records could not be checked. Try refreshing the page.",
      missing_connection_secret: "The mailbox connection is missing its server-side secret. Reconnect Outlook to restore access.",
      refresh_token_decrypt_failed: "Stored mailbox access could not be read. Reconnect Outlook to restore access.",
      outlook_connection_expired: "The temporary Outlook proof expired. Reconnect Outlook to continue.",
      outlook_connection_user_mismatch: "The temporary Outlook proof belongs to another admin session.",
    };
    return messages[code] || "Mailbox status needs attention. Try Refresh, then reconnect if it continues.";
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

  async function requireAdmin() {
    const client = await waitForSupabaseReady();
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) console.error("Email triage session lookup failed:", sessionError);

    const session = sessionData?.session;
    if (!session?.user?.id) {
      window.location.href = "index.html?next=" + encodeURIComponent("email-triage.html");
      return null;
    }

    const { data: employee, error: employeeError } = await client
      .from("employees")
      .select("role, active, display_name")
      .eq("user_id", session.user.id)
      .maybeSingle();

    if (employeeError || !employee || employee.active === false) {
      console.error("Email triage admin guard failed:", employeeError);
      window.location.href = "index.html?next=" + encodeURIComponent("email-triage.html");
      return null;
    }

    const role = String(employee.role || "").toLowerCase();
    if (role !== "admin") {
      window.location.href = "worker-dashboard.html";
      return null;
    }

    if (els.greeting) {
      const name = employee.display_name ? `, ${employee.display_name}` : "";
      els.greeting.textContent = `Email Triage${name}`;
    }

    return { client, session, employee };
  }

  function functionUrl(functionName) {
    const baseUrl = String(window.SUPABASE_URL || "").replace(/\/+$/, "");
    if (!baseUrl) throw new Error("Missing Supabase URL");
    return `${baseUrl}/functions/v1/${functionName}`;
  }

  async function edgeFetch(functionName, session, options = {}) {
    const headers = {
      Authorization: `Bearer ${session.access_token}`,
      apikey: window.SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    const response = await fetch(functionUrl(functionName), {
      ...options,
      headers,
      credentials: "include",
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const code = payload.error || payload.error_description || payload.detail || `request_failed_${response.status}`;
      const error = new Error(code);
      error.code = code;
      throw error;
    }
    return payload;
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
      els.messagesBody.innerHTML = messages.map((message) => `
        <tr>
          <td class="email-sender">${escapeHtml(message.from || "Unknown sender")}</td>
          <td class="email-subject">${escapeHtml(message.subject || "(No subject)")}</td>
          <td class="email-received">${escapeHtml(formatDateTime(message.receivedDateTime))}</td>
          <td class="email-preview">${escapeHtml(message.bodyPreview || "")}</td>
        </tr>
      `).join("");
    }

    if (els.countPill) {
      const count = messages.length;
      els.countPill.textContent = `${count} ${count === 1 ? "message" : "messages"}`;
    }
  }

  async function loadMessages(context) {
    setLoading(true);
    setStatus("Checking", "Reading latest Outlook emails", "Calling Microsoft Graph through the Supabase Edge Function.");

    try {
      const payload = await edgeFetch(MESSAGES_FUNCTION, context.session, { method: "POST", body: "{}" });
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      renderMessages(messages);
      els.messagesSection?.classList.remove("hidden");
      setButtonMode("connected");
      setStatus("Connected", "Outlook mailbox connected", `Loaded ${messages.length} sanitized message previews.`, "success");
    } catch (error) {
      const code = error.code || error.message;
      renderMessages([]);
      els.messagesSection?.classList.add("hidden");
      setButtonMode(code === "mailbox_not_connected" ? "disconnected" : "attention");
      setStatus("Mailbox needs attention", "Could not load Outlook emails", safeErrorMessage(code), "error");
    } finally {
      setLoading(false);
    }
  }

  async function connectOutlook(context) {
    setLoading(true);
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

  async function init() {
    const context = await requireAdmin();
    if (!context) return;

    els.connect?.addEventListener("click", () => connectOutlook(context));
    els.refresh?.addEventListener("click", () => loadMessages(context));
    els.disconnect?.addEventListener("click", () => disconnectOutlook(context));

    handleOutlookQueryNotice();

    setLoading(true);
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
