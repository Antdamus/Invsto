import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "supabase";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      // Prevent stale prices (browser + CDN)
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
    },
  });
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr.filter(Boolean)));
}
function normalizeKey(k: string) {
  return String(k || "").trim().replace(/^\/+/, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") return json(405, { error: "method_not_allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "missing_service_secrets" });

  const url = new URL(req.url);
  const channel = (url.searchParams.get("channel") || "og_main").trim();

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Settings (bucket + ttl)
  const { data: settings, error: settingsErr } = await supabase
    .from("storefront_settings")
    .select("private_photo_bucket, signed_url_ttl_seconds")
    .eq("id", "global")
    .single();

  if (settingsErr || !settings) {
    return json(500, { error: "settings_load_failed", detail: settingsErr?.message });
  }

  const bucket = settings.private_photo_bucket || "photos";
  const ttl = Math.max(60, Math.min(3600, settings.signed_url_ttl_seconds || 900));

  // Pull catalog items (computed prices from RPC)
  const { data: items, error: rpcErr } = await supabase.rpc("rpc_storefront_catalog", {
    p_channel_id: channel,
  });

  if (rpcErr) return json(500, { error: "rpc_failed", detail: rpcErr.message });

  const list = Array.isArray(items) ? items : [];

  // Build allowlist of keys for this channel from published listings
  const { data: listings, error: listErr } = await supabase
    .from("storefront_listings")
    .select("item_type_id, public_photo_keys")
    .eq("channel_id", channel)
    .eq("published", true);

  if (listErr) return json(500, { error: "listing_load_failed", detail: listErr.message });

  const allowedByItem = new Map<string, Set<string>>();
  for (const r of listings || []) {
    const id = String((r as any).item_type_id);
    const keys = ((r as any).public_photo_keys || []).map((x: string) => normalizeKey(String(x)));
    allowedByItem.set(id, new Set(keys));
  }

  // Sign first photo per item (fast grid)
  const firstKeys = uniq(
    list
      .map((it: any) => {
        const id = String(it.item_type_id);
        const keys = Array.isArray(it.photo_keys) ? it.photo_keys : [];
        const first = normalizeKey(keys[0] || "");
        const allowed = allowedByItem.get(id);
        return allowed && allowed.has(first) ? first : null;
      })
      .filter(Boolean)
  ) as string[];

  const signedMap = new Map<string, string>();
  if (firstKeys.length) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(firstKeys, ttl);
    if (!error && data) {
      for (const row of data as any[]) {
        if (row?.path && row?.signedUrl) signedMap.set(row.path, row.signedUrl);
      }
    }
  }

  const out = list.map((it: any) => {
    const keys = Array.isArray(it.photo_keys) ? it.photo_keys : [];
    const first = normalizeKey(keys[0] || "");
    return { ...it, image_url: first ? (signedMap.get(first) || null) : null };
  });

  return json(200, { channel, items: out, expires_in: ttl });
});
