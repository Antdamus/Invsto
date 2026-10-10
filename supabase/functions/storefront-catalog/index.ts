import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// Curated catalogues use a separate, service-only RPC. Never spread inventory
// records into the public response or accept photo keys supplied in a request.
async function sharedCatalogue(client: any, token: string, projectUrl: string) {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(token)) return json(404, { error: "catalogue_unavailable" });
  const { data, error } = await client.rpc("shared_inventory_catalogue", { _token: token });
  if (error) return json(503, { error: "catalogue_temporarily_unavailable" });
  if (!data) return json(404, { error: "catalogue_unavailable" });
  const keys = new Map<string, string>();
  const external = new Map<string, string>();
  for (const item of data.items || []) for (const photo of item.photos || []) {
    if (typeof photo !== "string" || photo.length > 2000) continue;
    if (/^https:\/\//i.test(photo)) {
      try {
        const u = new URL(photo);
        const prefix = "/storage/v1/object/";
        if (u.origin === new URL(projectUrl).origin && u.pathname.startsWith(prefix)) {
          const path = u.pathname.slice(prefix.length).replace(/^(?:sign|public|authenticated)\/photos\//, "");
          if (path !== u.pathname.slice(prefix.length)) keys.set(photo, decodeURIComponent(path));
        } else if (!u.username && !u.password) external.set(photo, u.href);
      } catch { /* Invalid photo is omitted, not reflected to the client. */ }
    } else if (!photo.includes(":") && !photo.split("/").includes("..")) keys.set(photo, normalizeKey(photo));
  }
  const signed = new Map<string, string>();
  const paths = uniq([...keys.values()]);
  if (paths.length) {
    const { data: urls, error: signingError } = await client.storage.from("photos").createSignedUrls(paths, 300);
    if (signingError) return json(503, { error: "photos_temporarily_unavailable" });
    for (const row of urls || []) if (row.path && row.signedUrl) signed.set(row.path, row.signedUrl);
  }
  return json(200, {
    title: data.title, introduction: data.introduction, credit: data.credit, currency: "USD",
    items: (data.items || []).map((item: any) => ({
      id: item.id, name: item.name, description: item.description,
      retail_price: item.retail_price, category: item.category,
      images: (item.photos || []).map((p: string) => signed.get(keys.get(p) || "") || external.get(p)).filter(Boolean),
    })),
    expires_in: 300,
  });
}

// Keep the receipt allowlist independent of staff records and future columns.
function publicReceipt(data: any) {
 return {reference:data.reference,title:data.title,status:data.status,revision:data.revision,message:data.message,
  total:data.total,credit_applied:data.credit_applied,balance:data.balance,currency:"USD",delivery:data.delivery,
  created_at:data.created_at,updated_at:data.updated_at,
  items:(data.items || []).map((i:any)=>({id:i.id,name:i.name,retail_price:i.retail_price}))};
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!["GET", "POST"].includes(req.method)) return json(405, { error: "method_not_allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "missing_service_secrets" });

  const url = new URL(req.url);
  const channel = (url.searchParams.get("channel") || "og_main").trim();

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (url.searchParams.has("catalogue")) {
    const token = url.searchParams.get("catalogue") || "";
    const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
    if (!uuid.test(token)) return json(404, { error: "catalogue_unavailable" });
    if (req.method === "POST") {
      // Bound streamed bytes too: Content-Length alone is client controlled.
      let input: any;
      try {
        const reader = req.body?.getReader(); let text = "", size = 0;
        if (!reader) return json(400, { error: "invalid_request" });
        const decoder = new TextDecoder();
        while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength;
          if (size > 24000) { await reader.cancel(); return json(413, {error:"request_too_large"}); }
          text += decoder.decode(value,{stream:true}); }
        input = JSON.parse(text + decoder.decode());
      } catch { return json(400, {error:"invalid_request"}); }
      if (!uuid.test(input?.receipt || "") || !Array.isArray(input.items) || input.items.length > 100 ||
          typeof input.name !== "string" || typeof input.contact !== "string" || typeof input.delivery !== "string" ||
          (input.note !== undefined && typeof input.note !== "string") ||
          !input.items.every((i:any) => uuid.test(i?.id || "") && typeof i.retail_price === "number" && Number.isFinite(i.retail_price) && i.retail_price > 0) ||
          !(input.credit === null || (typeof input.credit === "number" && Number.isFinite(input.credit) && input.credit >= 0)) ||
          (input.revision !== null && input.revision !== undefined && !Number.isSafeInteger(input.revision))) return json(400,{error:"invalid_request"});
      const {data,error} = await supabase.rpc("submit_catalogue_request", {
        _token:token,_receipt:input.receipt,_revision:input.revision ?? null,
        _name:input.name,_contact:input.contact,_delivery:input.delivery,_note:input.note || "",
        _items:input.items.map((i:any)=>({id:i.id,retail_price:i.retail_price})),_expected_credit:input.credit,
      });
      if (error) {
        const known = ["selection_changed","catalogue_unavailable","request_limit","invalid_selection","invalid_contact","invalid_request"];
        const reason = known.includes(error.message) ? error.message : "request_temporarily_unavailable";
        return json(reason === "request_limit" ? 429 : reason === "selection_changed" ? 409 : reason === "catalogue_unavailable" ? 404 : reason.startsWith("invalid_") ? 400 : 503,{error:reason});
      }
      return json(200, publicReceipt(data));
    }
    if (url.searchParams.has("receipt")) {
      const receipt = url.searchParams.get("receipt") || "";
      if (!uuid.test(receipt)) return json(404,{error:"request_unavailable"});
      const {data,error} = await supabase.rpc("catalogue_request_receipt",{_token:token,_receipt:receipt});
      if (error) return json(503,{error:"request_temporarily_unavailable"});
      return data ? json(200,publicReceipt(data)) : json(404,{error:"request_unavailable"});
    }
    return sharedCatalogue(supabase, token, SUPABASE_URL);
  }
  if (req.method !== "GET") return json(405, {error:"method_not_allowed"});

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
