const EBAY_CLIENT_ID = (Deno.env.get("EBAY_CLIENT_ID") ?? "").trim();
const EBAY_CLIENT_SECRET = (Deno.env.get("EBAY_CLIENT_SECRET") ?? "").trim();
const EBAY_OAUTH_RUNAME = (Deno.env.get("EBAY_OAUTH_RUNAME") ?? "").trim();
const EBAY_ENV = (Deno.env.get("EBAY_ENV") ?? "production").trim().toLowerCase();

const EBAY_API_BASE = EBAY_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

function html(body: string, status = 200) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OG Jewelers eBay OAuth</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; line-height: 1.5; color: #161616; }
    code, pre { background: #f4f4f4; border-radius: 8px; padding: 10px; display: block; white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>${body}</body>
</html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function exchangeCode(code: string) {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_OAUTH_RUNAME) {
    throw new Error("Missing EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, or EBAY_OAUTH_RUNAME Supabase secret.");
  }

  const basic = btoa(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: EBAY_OAUTH_RUNAME,
  });

  const res = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  let payload: any = {};
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`eBay token exchange failed (${res.status}): ${text}`);
  }

  return payload;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (url.searchParams.has("privacy")) {
    return html(`<h1>Privacy Policy</h1>
      <p>OG Jewelers uses authorized eBay API access only to manage seller inventory, listings, orders, and related account workflows requested by the account owner.</p>
      <p>OAuth tokens are stored as private Supabase secrets and are not sold or shared.</p>`);
  }

  if (url.searchParams.has("declined")) {
    return html(`<h1>Authorization declined</h1><p>eBay access was not granted.</p>`);
  }

  const error = url.searchParams.get("error");
  if (error) {
    return html(`<h1>eBay OAuth error</h1><pre>${escapeHtml(url.search)}</pre>`, 400);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return html(`<h1>OG Jewelers eBay OAuth Callback</h1>
      <p>This endpoint receives eBay OAuth authorization codes.</p>
      <p>Use this as the eBay Auth accepted URL:</p>
      <code>https://byhytmarmigalvawkedi.functions.supabase.co/ebay-oauth-callback</code>`);
  }

  try {
    const tokenPayload = await exchangeCode(code);
    const refreshToken = String(tokenPayload.refresh_token || "");
    const accessToken = String(tokenPayload.access_token || "");

    return html(`<h1>eBay OAuth Connected</h1>
      <p>Copy the refresh token below into Supabase as <strong>EBAY_REFRESH_TOKEN</strong>.</p>
      <h2>Refresh token</h2>
      <pre>${escapeHtml(refreshToken || "No refresh_token returned")}</pre>
      <h2>Access token</h2>
      <pre>${escapeHtml(accessToken || "No access_token returned")}</pre>
      <p>After saving the refresh token, close this page.</p>`);
  } catch (err) {
    return html(`<h1>Token exchange failed</h1><pre>${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>`, 500);
  }
});
