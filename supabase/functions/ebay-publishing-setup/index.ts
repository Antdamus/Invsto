import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const EBAY_CLIENT_ID = (Deno.env.get("EBAY_CLIENT_ID") ?? Deno.env.get("EBAY_APP_ID") ?? "").trim();
const EBAY_CLIENT_SECRET = (Deno.env.get("EBAY_CLIENT_SECRET") ?? Deno.env.get("EBAY_CERT_ID") ?? "").trim();
const EBAY_REFRESH_TOKEN = (Deno.env.get("EBAY_REFRESH_TOKEN") ?? "").trim();
const EBAY_ENV = (Deno.env.get("EBAY_ENV") ?? "production").trim().toLowerCase();
const EBAY_ACCOUNT_SCOPE = (Deno.env.get("EBAY_ACCOUNT_SCOPE") ??
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly https://api.ebay.com/oauth/api_scope/sell.inventory").trim();

const EBAY_API_BASE = EBAY_ENV === "sandbox" ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: JsonRecord) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function getEbayAccessToken(): Promise<string> {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REFRESH_TOKEN) {
    throw new Error("Missing eBay OAuth secrets. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REFRESH_TOKEN.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: EBAY_REFRESH_TOKEN,
    scope: EBAY_ACCOUNT_SCOPE,
  });

  const res = await fetch(`${EBAY_API_BASE}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${btoa(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`eBay OAuth refresh failed (${res.status}): ${text.slice(0, 800)}`);
  }

  const payload = JSON.parse(text);
  if (!payload.access_token) throw new Error("eBay OAuth response did not include an access_token.");
  return payload.access_token;
}

async function ebayRequest(token: string, path: string): Promise<any> {
  const res = await fetch(`${EBAY_API_BASE}${path}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "Accept-Language": "en-US",
      "Content-Language": "en-US",
    },
  });

  const text = await res.text();
  let payload: any = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!res.ok) {
    throw new Error(`eBay GET ${path} failed (${res.status}): ${text.slice(0, 1000)}`);
  }
  return payload;
}

function compactPolicy(policy: any, idField: string) {
  return {
    id: policy?.[idField] ?? null,
    name: policy?.name ?? null,
    marketplaceId: policy?.marketplaceId ?? null,
    categoryTypes: policy?.categoryTypes ?? [],
  };
}

function compactLocation(location: any) {
  return {
    merchantLocationKey: location?.merchantLocationKey ?? null,
    name: location?.name ?? null,
    merchantLocationStatus: location?.merchantLocationStatus ?? null,
    locationTypes: location?.locationTypes ?? [],
    address: location?.location?.address ?? null,
  };
}

async function loadSettings(supabase: any) {
  const { data, error } = await supabase
    .from("ebay_inventory_settings")
    .select("*")
    .eq("id", "default")
    .single();

  if (error || !data) throw new Error(`Could not load ebay_inventory_settings: ${error?.message || "missing default row"}`);
  return data;
}

async function listSetup(supabase: any) {
  const settings = await loadSettings(supabase);
  const marketplaceId = String(settings.marketplace_id || "EBAY_US");
  const token = await getEbayAccessToken();
  const marketplace = encodeURIComponent(marketplaceId);

  const [paymentPayload, returnPayload, fulfillmentPayload, locationPayload] = await Promise.all([
    ebayRequest(token, `/sell/account/v1/payment_policy?marketplace_id=${marketplace}`),
    ebayRequest(token, `/sell/account/v1/return_policy?marketplace_id=${marketplace}`),
    ebayRequest(token, `/sell/account/v1/fulfillment_policy?marketplace_id=${marketplace}`),
    ebayRequest(token, "/sell/inventory/v1/location"),
  ]);

  const paymentPolicies = (paymentPayload.paymentPolicies || []).map((policy: any) => compactPolicy(policy, "paymentPolicyId"));
  const returnPolicies = (returnPayload.returnPolicies || []).map((policy: any) => compactPolicy(policy, "returnPolicyId"));
  const fulfillmentPolicies = (fulfillmentPayload.fulfillmentPolicies || []).map((policy: any) => compactPolicy(policy, "fulfillmentPolicyId"));
  const locations = (locationPayload.locations || []).map(compactLocation);

  return {
    settings,
    policies: {
      paymentPolicies,
      returnPolicies,
      fulfillmentPolicies,
    },
    locations,
    suggested: {
      paymentPolicyId: settings.payment_policy_id || paymentPolicies[0]?.id || null,
      returnPolicyId: settings.return_policy_id || returnPolicies[0]?.id || null,
      fulfillmentPolicyId: settings.fulfillment_policy_id || fulfillmentPolicies[0]?.id || null,
      merchantLocationKey: settings.merchant_location_key || locations[0]?.merchantLocationKey || null,
    },
  };
}

async function saveSetup(supabase: any, body: JsonRecord) {
  const patch: JsonRecord = { updated_at: new Date().toISOString() };
  const fieldMap: Record<string, string> = {
    paymentPolicyId: "payment_policy_id",
    returnPolicyId: "return_policy_id",
    fulfillmentPolicyId: "fulfillment_policy_id",
    merchantLocationKey: "merchant_location_key",
  };

  for (const [inputKey, column] of Object.entries(fieldMap)) {
    if (typeof body[inputKey] === "string" && String(body[inputKey]).trim()) {
      patch[column] = String(body[inputKey]).trim();
    }
  }

  if (typeof body.publishEnabled === "boolean") {
    patch.publish_enabled = body.publishEnabled;
  }

  const { data, error } = await supabase
    .from("ebay_inventory_settings")
    .update(patch)
    .eq("id", "default")
    .select("*")
    .single();

  if (error || !data) throw new Error(`Could not update ebay_inventory_settings: ${error?.message || "missing default row"}`);
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse(500, { ok: false, error: "missing_supabase_secrets" });
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "list");
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (action === "save") {
      const settings = await saveSetup(supabase, body);
      return jsonResponse(200, { ok: true, settings });
    }

    const setup = await listSetup(supabase);
    return jsonResponse(200, { ok: true, ...setup });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown setup failure";
    return jsonResponse(500, { ok: false, error: message });
  }
});
