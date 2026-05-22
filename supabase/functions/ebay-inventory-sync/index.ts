import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type JsonRecord = Record<string, unknown>;

type SyncSettings = {
  id: string;
  marketplace_id: string;
  currency: string;
  merchant_location_key: string;
  default_category_id: string;
  default_condition: string;
  listing_format: string;
  payment_policy_id: string | null;
  return_policy_id: string | null;
  fulfillment_policy_id: string | null;
  category_rules: Array<{ match?: string[]; categoryId?: string }>;
  enabled: boolean;
  publish_enabled: boolean;
};

type ItemRow = {
  id: string;
  title: string;
  description: string | null;
  sale_price: number | null;
  barcode: string | null;
  photos: string[] | null;
  photo_url: string | null;
  categories: string[] | null;
  weight: number | null;
  stone_type?: string | null;
  item_length?: string | null;
  deleted_at?: string | null;
};

type PreparedItem = {
  item: ItemRow;
  sku: string;
  quantity: number;
  imageUrls: string[];
  categoryId: string;
  inventoryPayload: JsonRecord;
  offerPayload: JsonRecord | null;
  hash: string;
  warnings: string[];
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const EBAY_CLIENT_ID = Deno.env.get("EBAY_CLIENT_ID") ?? Deno.env.get("EBAY_APP_ID") ?? "";
const EBAY_CLIENT_SECRET = Deno.env.get("EBAY_CLIENT_SECRET") ?? Deno.env.get("EBAY_CERT_ID") ?? "";
const EBAY_REFRESH_TOKEN = Deno.env.get("EBAY_REFRESH_TOKEN") ?? "";
const EBAY_ENV = (Deno.env.get("EBAY_ENV") ?? "production").toLowerCase();
const EBAY_SCOPE = Deno.env.get("EBAY_SCOPE") ?? "https://api.ebay.com/oauth/api_scope/sell.inventory";
const EBAY_SYNC_ALLOW_PUBLISH = (Deno.env.get("EBAY_SYNC_ALLOW_PUBLISH") ?? "false").toLowerCase() === "true";
const SOURCE_PHOTO_BUCKET = Deno.env.get("EBAY_SOURCE_PHOTO_BUCKET") ?? "photos";
const PUBLIC_EBAY_PHOTO_BUCKET = Deno.env.get("EBAY_PUBLIC_PHOTO_BUCKET") ?? "public-ebay-photos";

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

function toMoney(value: unknown): string {
  const numeric = Number(value || 0);
  return Math.max(0, numeric).toFixed(2);
}

function toPositiveInt(value: unknown): number {
  return Math.max(0, Math.trunc(Number(value || 0)));
}

function normalizeSku(value: string): string {
  return value.trim().replace(/\s+/g, "-").slice(0, 50);
}

function normalizePhotoPath(value: string): string {
  return value.split("?")[0].replace(/^\/+/, "");
}

function filenameFromPath(path: string): string {
  return normalizePhotoPath(path).split("/").pop() || "";
}

function contentTypeForPath(path: string): string {
  const ext = filenameFromPath(path).split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function collectPhotoPaths(item: ItemRow): string[] {
  return [
    ...(Array.isArray(item.photos) ? item.photos : []),
    item.photo_url || "",
  ].filter(Boolean).slice(0, 12);
}

function chooseCategoryId(item: ItemRow, settings: SyncSettings): string {
  const haystack = [
    item.title,
    item.description || "",
    ...(Array.isArray(item.categories) ? item.categories : []),
  ].join(" ").toLowerCase();

  for (const rule of settings.category_rules || []) {
    const terms = Array.isArray(rule.match) ? rule.match : [];
    if (rule.categoryId && terms.some((term) => haystack.includes(String(term).toLowerCase()))) {
      return rule.categoryId;
    }
  }

  return settings.default_category_id;
}

function buildAspects(item: ItemRow): Record<string, string[]> {
  const aspects: Record<string, string[]> = {
    Brand: ["Unbranded"],
  };

  if (item.stone_type) aspects["Main Stone"] = [String(item.stone_type)];
  if (item.weight) aspects["Item Weight"] = [`${item.weight} g`];
  if (item.item_length) aspects["Item Length"] = [String(item.item_length)];

  return aspects;
}

async function sha256(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getEbayAccessToken(): Promise<string> {
  if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REFRESH_TOKEN) {
    throw new Error("Missing eBay OAuth secrets. Set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and EBAY_REFRESH_TOKEN.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: EBAY_REFRESH_TOKEN,
    scope: EBAY_SCOPE,
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
    throw new Error(`eBay OAuth refresh failed (${res.status}): ${text.slice(0, 500)}`);
  }

  let payload: any = {};
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`eBay OAuth response was not JSON: ${text.slice(0, 500)}`);
  }
  if (!payload.access_token) throw new Error("eBay OAuth response did not include an access_token.");
  return payload.access_token;
}

async function ebayRequest(token: string, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${EBAY_API_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "Accept": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
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
    throw new Error(`eBay ${method} ${path} failed (${res.status}): ${text.slice(0, 1000)}`);
  }

  return payload;
}

async function ensurePublicImageUrls(supabase: any, item: ItemRow, options: { copyMissing: boolean }): Promise<string[]> {
  const urls: string[] = [];

  for (const rawPath of collectPhotoPaths(item)) {
    if (/^https?:\/\//i.test(rawPath)) {
      urls.push(rawPath);
      continue;
    }

    const sourcePath = normalizePhotoPath(rawPath);
    const filename = filenameFromPath(sourcePath);
    if (!filename) continue;

    const publicPath = filename;
    const { data: publicInfo } = supabase.storage.from(PUBLIC_EBAY_PHOTO_BUCKET).getPublicUrl(publicPath);
    const publicUrl = publicInfo?.publicUrl;
    if (!publicUrl) continue;

    const { data: existing } = await supabase.storage.from(PUBLIC_EBAY_PHOTO_BUCKET).list("", { search: filename });
    if (!Array.isArray(existing) || !existing.some((file: any) => file.name === filename)) {
      if (!options.copyMissing) continue;

      const { data: blob, error: downloadError } = await supabase.storage.from(SOURCE_PHOTO_BUCKET).download(sourcePath);
      if (downloadError || !blob) throw new Error(`Could not read photo ${sourcePath}: ${downloadError?.message || "missing file"}`);

      const { error: uploadError } = await supabase.storage.from(PUBLIC_EBAY_PHOTO_BUCKET).upload(publicPath, blob, {
        upsert: true,
        contentType: contentTypeForPath(sourcePath),
      });
      if (uploadError) throw new Error(`Could not publish photo ${sourcePath}: ${uploadError.message}`);
    }

    urls.push(publicUrl);
  }

  return urls;
}

async function prepareItem(
  supabase: any,
  item: ItemRow,
  quantity: number,
  settings: SyncSettings,
  options: { copyMissingPhotos: boolean },
): Promise<PreparedItem> {
  const warnings: string[] = [];
  const sku = normalizeSku(item.barcode || "");
  if (!sku) throw new Error("Item is missing barcode/SKU.");

  const imageUrls = await ensurePublicImageUrls(supabase, item, { copyMissing: options.copyMissingPhotos });
  if (!imageUrls.length) warnings.push("No public eBay image URLs were found.");

  const categoryId = chooseCategoryId(item, settings);
  const price = Number(item.sale_price || 0);
  if (price <= 0) warnings.push("Item has no sale price.");

  const inventoryPayload = {
    sku,
    locale: "en_US",
    availability: {
      shipToLocationAvailability: {
        quantity,
      },
    },
    condition: settings.default_condition,
    product: {
      title: String(item.title || sku).slice(0, 80),
      description: item.description || item.title || sku,
      imageUrls,
      aspects: buildAspects(item),
    },
  };

  const offerPayload = quantity > 0 && price > 0 ? {
    sku,
    marketplaceId: settings.marketplace_id,
    format: settings.listing_format,
    availableQuantity: quantity,
    categoryId,
    merchantLocationKey: settings.merchant_location_key,
    pricingSummary: {
      price: {
        currency: settings.currency,
        value: toMoney(price),
      },
    },
    listingDescription: item.description || item.title || sku,
    listingPolicies: {
      fulfillmentPolicyId: settings.fulfillment_policy_id,
      paymentPolicyId: settings.payment_policy_id,
      returnPolicyId: settings.return_policy_id,
    },
    includeCatalogProductDetails: false,
  } : null;

  const hash = await sha256({ inventoryPayload, offerPayload });
  return { item, sku, quantity, imageUrls, categoryId, inventoryPayload, offerPayload, hash, warnings };
}

async function loadSettings(supabase: any): Promise<SyncSettings> {
  const { data, error } = await supabase
    .from("ebay_inventory_settings")
    .select("*")
    .eq("id", "default")
    .single();

  if (error || !data) throw new Error(`Could not load ebay_inventory_settings: ${error?.message || "missing default row"}`);
  return data as SyncSettings;
}

async function loadItems(supabase: any, itemIds: string[], limit: number): Promise<Array<ItemRow & { quantity: number }>> {
  let query = supabase
    .from("item_types")
    .select("id,title,description,sale_price,barcode,photos,photo_url,categories,weight,stone_type,item_length,deleted_at")
    .is("deleted_at", null)
    .not("barcode", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (itemIds.length) query = query.in("id", itemIds);

  const { data: items, error } = await query;
  if (error) throw new Error(`Could not load items: ${error.message}`);

  const rows = (items || []) as ItemRow[];
  const ids = rows.map((row) => row.id);
  if (!ids.length) return [];

  const { data: stockRows, error: stockError } = await supabase
    .from("item_stock_locations")
    .select("item_id,quantity")
    .in("item_id", ids);

  if (stockError) throw new Error(`Could not load stock quantities: ${stockError.message}`);

  const quantityByItem = new Map<string, number>();
  for (const row of stockRows || []) {
    quantityByItem.set(row.item_id, (quantityByItem.get(row.item_id) || 0) + toPositiveInt(row.quantity));
  }

  return rows.map((item) => ({ ...item, quantity: quantityByItem.get(item.id) || 0 }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { ok: false, error: "method_not_allowed" });

  const startedAt = new Date().toISOString();
  let runId: string | null = null;

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return jsonResponse(500, { ok: false, error: "missing_supabase_secrets" });
    }

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dryRun !== false;
    const publishRequested = body.publish === true;
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.map(String).filter(Boolean) : [];
    const limit = Math.min(Math.max(Number(body.limit || 25), 1), 100);
    const mode = dryRun ? "dry_run" : publishRequested ? "publish" : "sync";

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const settings = await loadSettings(supabase);
    const publishAllowed = Boolean(publishRequested && settings.publish_enabled && EBAY_SYNC_ALLOW_PUBLISH);

    if (!dryRun && !settings.enabled) {
      return jsonResponse(409, { ok: false, error: "ebay_sync_disabled", detail: "Set ebay_inventory_settings.enabled=true before pushing to eBay." });
    }

    const { data: run, error: runError } = await supabase
      .from("ebay_inventory_sync_runs")
      .insert({
        mode,
        requested_item_ids: itemIds,
        started_at: startedAt,
      })
      .select("id")
      .single();
    if (runError) throw new Error(`Could not create sync run: ${runError.message}`);
    runId = run.id;

    const items = await loadItems(supabase, itemIds, limit);
    const linksResult = await supabase
      .from("ebay_inventory_links")
      .select("*")
      .in("item_type_id", items.map((item) => item.id));
    if (linksResult.error) throw new Error(`Could not load eBay links: ${linksResult.error.message}`);

    const linkByItem = new Map<string, any>((linksResult.data || []).map((link: any) => [link.item_type_id, link]));
    const prepared: PreparedItem[] = [];
    const results: JsonRecord[] = [];
    let skipped = 0;
    let errors = 0;
    let synced = 0;

    for (const item of items) {
      try {
        const next = await prepareItem(supabase, item, item.quantity, settings, { copyMissingPhotos: !dryRun });
        prepared.push(next);
        if (dryRun) {
          results.push({
            itemTypeId: item.id,
            sku: next.sku,
            title: item.title,
            quantity: next.quantity,
            categoryId: next.categoryId,
            price: toMoney(item.sale_price),
            imageCount: next.imageUrls.length,
            status: next.offerPayload ? "ready" : "inventory_only",
            warnings: next.warnings,
          });
        }
      } catch (error) {
        errors++;
        results.push({
          itemTypeId: item.id,
          sku: item.barcode,
          title: item.title,
          status: "error",
          error: error instanceof Error ? error.message : "Unknown preparation error",
        });
      }
    }

    if (!dryRun && prepared.length) {
      const token = await getEbayAccessToken();

      for (let index = 0; index < prepared.length; index += 25) {
        const chunk = prepared.slice(index, index + 25);
        await ebayRequest(token, "POST", "/sell/inventory/v1/bulk_create_or_replace_inventory_item", {
          requests: chunk.map((entry) => entry.inventoryPayload),
        });
      }

      for (const entry of prepared) {
        const existingLink = linkByItem.get(entry.item.id);
        const status = entry.quantity <= 0 ? "out_of_stock" : "synced";

        try {
          let offerId = existingLink?.offer_id || null;
          let offerResponse: JsonRecord = {};
          let publishResponse: JsonRecord = {};

          if (entry.offerPayload) {
            if (offerId) {
              offerResponse = await ebayRequest(token, "PUT", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, entry.offerPayload);
            } else {
              offerResponse = await ebayRequest(token, "POST", "/sell/inventory/v1/offer", entry.offerPayload);
              offerId = String(offerResponse.offerId || "");
            }

            if (publishAllowed && offerId && !existingLink?.listing_id) {
              publishResponse = await ebayRequest(token, "POST", `/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`);
            }
          }

          const listingId = String((publishResponse as any).listingId || existingLink?.listing_id || "");
          await supabase.from("ebay_inventory_links").upsert({
            item_type_id: entry.item.id,
            sku: entry.sku,
            offer_id: offerId,
            listing_id: listingId || null,
            status,
            last_inventory_hash: entry.hash,
            last_synced_at: new Date().toISOString(),
            last_error: null,
            last_payload: {
              inventory: entry.inventoryPayload,
              offer: entry.offerPayload,
            },
            last_response: {
              offer: offerResponse,
              publish: publishResponse,
            },
            updated_at: new Date().toISOString(),
          }, { onConflict: "item_type_id" });

          synced++;
          results.push({
            itemTypeId: entry.item.id,
            sku: entry.sku,
            status,
            offerId,
            listingId: listingId || null,
            published: Boolean((publishResponse as any).listingId),
          });
        } catch (error) {
          errors++;
          const message = error instanceof Error ? error.message : "Unknown eBay sync error";
          await supabase.from("ebay_inventory_links").upsert({
            item_type_id: entry.item.id,
            sku: entry.sku,
            status: "error",
            last_error: message,
            last_payload: {
              inventory: entry.inventoryPayload,
              offer: entry.offerPayload,
            },
            updated_at: new Date().toISOString(),
          }, { onConflict: "item_type_id" });
          results.push({ itemTypeId: entry.item.id, sku: entry.sku, status: "error", error: message });
        }
      }
    }

    skipped = results.filter((row) => row.status === "inventory_only" || row.status === "skipped").length;
    if (dryRun) synced = results.filter((row) => row.status === "ready").length;

    const summary = {
      dryRun,
      publishRequested,
      publishAllowed,
      settings: {
        marketplaceId: settings.marketplace_id,
        merchantLocationKey: settings.merchant_location_key,
        defaultCategoryId: settings.default_category_id,
      },
      results,
    };

    await supabase
      .from("ebay_inventory_sync_runs")
      .update({
        total_items: items.length,
        synced_items: synced,
        skipped_items: skipped,
        error_items: errors,
        summary,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    return jsonResponse(200, {
      ok: errors === 0,
      runId,
      total: items.length,
      synced,
      skipped,
      errors,
      dryRun,
      publishAllowed,
      results,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown sync failure";
    if (runId && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      await supabase
        .from("ebay_inventory_sync_runs")
        .update({
          error_items: 1,
          summary: { error: message },
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    return jsonResponse(500, { ok: false, runId, error: message });
  }
});
