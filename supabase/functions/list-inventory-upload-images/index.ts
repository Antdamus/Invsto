import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_BUCKET = "InventoryUpload";
const ALLOWED_BUCKETS = new Set(["InventoryUpload", "capture-photos"]);
const IMAGE_NAME_REGEX = /\.(png|jpe?g|webp|gif|heic|heif)$/i;
const THUMBNAIL_TRANSFORM = {
  width: 240,
  height: 240,
  resize: "cover",
  quality: 55,
};

type RequestBody = {
  bucket?: string;
  limit?: number;
  prefix?: string;
};

type ListedImage = {
  path: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function asTrimmedString(value: unknown) {
  return String(value || "").trim();
}

function clampLimit(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizePath(prefix: string, name: string) {
  return [prefix, name].filter(Boolean).join("/").replace(/^\/+/, "");
}

function isFolderLike(item: any) {
  return !item?.id && !IMAGE_NAME_REGEX.test(String(item?.name || ""));
}

function isSupportedImage(item: any) {
  return IMAGE_NAME_REGEX.test(String(item?.name || ""));
}

function compareNewestFirst(a: ListedImage, b: ListedImage) {
  const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
  const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
  return bTime - aTime;
}

async function createSignedImageUrl(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  path: string,
  transform?: Record<string, unknown>
) {
  try {
    const storage = supabase.storage.from(bucket);
    const { data, error } = transform
      ? await storage.createSignedUrl(path, 60 * 10, { transform })
      : await storage.createSignedUrl(path, 60 * 10);

    if (!error && data?.signedUrl) return data.signedUrl;
    if (!transform) return "";
  } catch (_) {
    if (!transform) return "";
  }

  return createSignedImageUrl(supabase, bucket, path);
}

async function listImagesRecursively(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  prefix = "",
  depth = 0,
  maxDepth = 4
): Promise<ListedImage[]> {
  if (depth > maxDepth) return [];

  const { data, error } = await supabase.storage
    .from(bucket)
    .list(prefix, {
      limit: 100,
      sortBy: { column: "created_at", order: "desc" },
    });

  if (error) {
    throw error;
  }

  const images: ListedImage[] = [];

  for (const item of data || []) {
    const path = normalizePath(prefix, item.name);

    if (isFolderLike(item)) {
      const nestedImages = await listImagesRecursively(supabase, bucket, path, depth + 1, maxDepth);
      images.push(...nestedImages);
      continue;
    }

    if (!isSupportedImage(item)) continue;

    images.push({
      path,
      name: item.name,
      createdAt: item.created_at || "",
      updatedAt: item.updated_at || item.created_at || "",
    });
  }

  return images;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  try {
    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const bucket = asTrimmedString(body.bucket || DEFAULT_BUCKET);
    const limit = clampLimit(body.limit, 1, 80, 12);
    const prefix = asTrimmedString(body.prefix).replace(/^\/+|\/+$/g, "");

    if (!ALLOWED_BUCKETS.has(bucket)) {
      return json(400, { ok: false, error: "invalid_bucket" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return json(500, { ok: false, error: "missing_supabase_service_credentials" });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const listedImages = await listImagesRecursively(supabase, bucket, prefix);
    const recentImages = listedImages.sort(compareNewestFirst).slice(0, limit);

    if (recentImages.length === 0) {
      return json(200, {
        ok: true,
        bucket,
        images: [],
      });
    }

    const images = await Promise.all(
      recentImages.map(async (image) => {
        const [previewUrl, thumbnailUrl] = await Promise.all([
          createSignedImageUrl(supabase, bucket, image.path),
          createSignedImageUrl(supabase, bucket, image.path, THUMBNAIL_TRANSFORM),
        ]);

        return {
          path: image.path,
          name: image.name,
          createdAt: image.createdAt,
          updatedAt: image.updatedAt,
          previewUrl,
          thumbnailUrl: thumbnailUrl || previewUrl,
        };
      })
    );

    return json(200, {
      ok: true,
      bucket,
      images,
    });
  } catch (error) {
    return json(500, {
      ok: false,
      error: "unexpected_error",
      detail: String(error),
    });
  }
});
