// supabase/functions/storefront-sign-photos/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "supabase";


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type Body = {
  channel_id: string;
  item_type_id: string;
  photo_keys: string[];
};

function uniq(arr: string[]) {
  return Array.from(new Set(arr.filter(Boolean)));
}

// Normalize keys so "/item_photos/..." becomes "item_photos/..."
function normalizeKey(k: string) {
  return String(k || "").trim().replace(/^\/+/, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json(500, { error: "missing_service_secrets" });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const channel_id = (body.channel_id || "").trim();
  const item_type_id = (body.item_type_id || "").trim();
  const requestedKeys = uniq((body.photo_keys || []).map(normalizeKey));

  if (!channel_id || !item_type_id || requestedKeys.length === 0) {
    return json(400, {
      error: "missing_fields",
      required: ["channel_id", "item_type_id", "photo_keys[]"],
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Load settings (bucket + ttl)
  const { data: settings, error: settingsErr } = await supabase
    .from("storefront_settings")
    .select("private_photo_bucket, signed_url_ttl_seconds")
    .eq("id", "global")
    .single();

  if (settingsErr || !settings) {
    return json(500, { error: "settings_load_failed", detail: settingsErr?.message });
  }

  const bucket = settings.private_photo_bucket || "photos";
  const ttl = Math.max(60, Math.min(3600, settings.signed_url_ttl_seconds || 900)); // 1min–1hr clamp

  // Strict allowlist: listing must be published + channel active + keys must be allowed
  const { data: listing, error: listingErr } = await supabase
    .from("storefront_listings")
    .select("public_photo_keys")
    .eq("channel_id", channel_id)
    .eq("item_type_id", item_type_id)
    .eq("published", true)
    .single();

  if (listingErr || !listing) {
    return json(404, { error: "not_published_or_not_found" });
  }

  const { data: ch, error: chErr } = await supabase
    .from("sales_channels")
    .select("active")
    .eq("id", channel_id)
    .single();

  if (chErr || !ch || ch.active !== true) {
    return json(404, { error: "channel_inactive_or_not_found" });
  }

  const allowed = new Set((listing.public_photo_keys || []).map((x: string) => normalizeKey(String(x))));
  const keysToSign = requestedKeys.filter((k) => allowed.has(k));

  if (keysToSign.length === 0) {
    return json(403, { error: "no_allowed_keys" });
  }

  // Batch sign (faster + cleaner)
  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(keysToSign, ttl);

  if (error || !data) {
    return json(500, { error: "sign_failed", detail: error?.message });
  }

  // Supabase returns [{ path, signedUrl }]
  const urls = data.map((row: any) => ({
    key: row.path,
    url: row.signedUrl || null,
  }));

  return json(200, { urls, expires_in: ttl, bucket });
});
