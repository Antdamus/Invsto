import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ServiceClient = ReturnType<typeof createClient>;
type JsonRecord = Record<string, unknown>;

type Candidate = {
  event_id: string;
  task_id: string;
  order_id: string;
  photo_index: number;
  bucket: string;
  path: string;
  label: string | null;
  mime_type: string | null;
  preview_path: string | null;
  thumbnail_path: string | null;
  photo: JsonRecord | null;
  event_created_at: string | null;
};

type Operator = {
  actorType: "service_role" | "admin";
  userId: string | null;
  email: string | null;
};

type TransformOptions = {
  width: number;
  height: number;
  resize: "contain";
  quality: number;
};

class BackfillError extends Error {
  code: string;
  status: number;
  phase: string;
  details: JsonRecord;

  constructor(code: string, options: { status?: number; phase?: string; message?: string; details?: JsonRecord } = {}) {
    super(options.message || code);
    this.code = code;
    this.status = options.status || 500;
    this.phase = options.phase || "unknown";
    this.details = options.details || {};
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_BUCKET = "order-evidence-photos";
const PREVIEW_TRANSFORM: TransformOptions = { width: 1800, height: 1800, resize: "contain", quality: 82 };
const THUMBNAIL_TRANSFORM: TransformOptions = { width: 420, height: 420, resize: "contain", quality: 70 };
const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 20_000;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new BackfillError("missing_env", { phase: "env", details: { name } });
  return value;
}

function serviceClient() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getBearerToken(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

async function requireAdmin(req: Request, supabase: ServiceClient): Promise<Operator> {
  const accessToken = getBearerToken(req);
  if (!accessToken) throw new BackfillError("unauthorized", { status: 401, phase: "auth" });

  if (accessToken === requiredEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    return { actorType: "service_role", userId: null, email: null };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  const user = userData?.user;
  if (userError || !user?.id) throw new BackfillError("unauthorized", { status: 401, phase: "auth" });

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (employeeError) throw new BackfillError("employee_lookup_failed", { phase: "auth", details: { message: employeeError.message } });
  const role = String(employee?.role || "").toLowerCase();
  if (!employee || employee.active === false || role !== "admin") {
    throw new BackfillError("admin_required", { status: 403, phase: "auth" });
  }

  return { actorType: "admin", userId: user.id, email: user.email || null };
}

async function parseInput(req: Request) {
  const url = new URL(req.url);
  let body: JsonRecord = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const rawLimit = Number(body.limit || body.batch || url.searchParams.get("limit") || 5);
  const limit = Math.max(1, Math.min(25, Number.isFinite(rawLimit) ? rawLimit : 5));
  const rawImageTimeoutMs = Number(body.imageTimeoutMs || body.image_timeout_ms || url.searchParams.get("imageTimeoutMs") || DEFAULT_IMAGE_FETCH_TIMEOUT_MS);
  const imageTimeoutMs = Math.max(5_000, Math.min(60_000, Number.isFinite(rawImageTimeoutMs) ? rawImageTimeoutMs : DEFAULT_IMAGE_FETCH_TIMEOUT_MS));
  const dryRun = body.dryRun === true
    || body.dry_run === true
    || url.searchParams.get("dryRun") === "1"
    || url.searchParams.get("dry_run") === "1";

  return { limit, dryRun, imageTimeoutMs };
}

function safeSegment(value: string, fallback = "evidence") {
  const cleaned = String(value || "")
    .trim()
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  return cleaned || fallback;
}

function derivativeBasePath(originalPath: string) {
  const path = String(originalPath || "").trim();
  const slashIndex = path.lastIndexOf("/");
  const folder = slashIndex >= 0 ? path.slice(0, slashIndex) : "";
  const filename = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const baseName = safeSegment(filename.replace(/\.[a-z0-9]{2,5}$/i, ""), "evidence");
  return folder ? `${folder}/derivatives/${baseName}` : `derivatives/${baseName}`;
}

function derivativePath(originalPath: string, variant: "preview" | "thumbnail") {
  const suffix = variant === "thumbnail" ? "thumb" : "preview";
  return `${derivativeBasePath(originalPath)}-${suffix}.jpg`;
}

async function fetchTransformedImage(
  supabase: ServiceClient,
  candidate: Candidate,
  transform: TransformOptions,
  timeoutMs = DEFAULT_IMAGE_FETCH_TIMEOUT_MS,
) {
  const { data, error } = await supabase.storage
    .from(candidate.bucket || DEFAULT_BUCKET)
    .createSignedUrl(candidate.path, 120, { transform });

  if (error || !data?.signedUrl) {
    throw new BackfillError("sign_transform_failed", {
      phase: "storage_sign",
      details: { path: candidate.path, message: error?.message || "no_signed_url" },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(data.signedUrl, {
      headers: { Accept: "image/jpeg,image/png,image/*,*/*" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new BackfillError("fetch_transform_failed", {
      phase: "storage_fetch",
      message: error instanceof Error && error.name === "AbortError" ? "storage_transform_timeout" : undefined,
      details: {
        path: candidate.path,
        timeout_ms: timeoutMs,
        message: error instanceof Error ? error.message : String(error || "fetch_failed"),
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new BackfillError("fetch_transform_failed", {
      phase: "storage_fetch",
      details: { path: candidate.path, status: response.status, text: await response.text().catch(() => "") },
    });
  }

  const bytes = await response.arrayBuffer();
  if (!bytes.byteLength) {
    throw new BackfillError("empty_transform", { phase: "storage_fetch", details: { path: candidate.path } });
  }

  return {
    bytes,
    contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg",
  };
}

async function uploadDerivative(
  supabase: ServiceClient,
  candidate: Candidate,
  targetPath: string,
  transform: TransformOptions,
  timeoutMs = DEFAULT_IMAGE_FETCH_TIMEOUT_MS,
) {
  const image = await fetchTransformedImage(supabase, candidate, transform, timeoutMs);
  const { error } = await supabase.storage
    .from(candidate.bucket || DEFAULT_BUCKET)
    .upload(targetPath, new Blob([image.bytes], { type: image.contentType }), {
      contentType: image.contentType,
      cacheControl: "31536000",
      upsert: true,
    });

  if (error) {
    throw new BackfillError("upload_derivative_failed", {
      phase: "storage_upload",
      details: { path: candidate.path, targetPath, message: error.message },
    });
  }

  return {
    bucket: candidate.bucket || DEFAULT_BUCKET,
    path: targetPath,
    mime_type: image.contentType,
    size_bytes: image.bytes.byteLength,
    transform_width: transform.width,
    transform_height: transform.height,
    transform_resize: transform.resize,
    transform_quality: transform.quality,
    generated_at: new Date().toISOString(),
    generated_by: "backfill-order-evidence-derivatives",
  };
}

async function listCandidates(supabase: ServiceClient, limit: number): Promise<Candidate[]> {
  const { data, error } = await supabase.rpc("list_order_evidence_derivative_backfill_candidates", {
    _limit: limit,
  });
  if (error) {
    throw new BackfillError("candidate_query_failed", {
      phase: "candidate_query",
      details: { message: error.message },
    });
  }
  return (Array.isArray(data) ? data : []) as Candidate[];
}

async function applyBackfill(
  supabase: ServiceClient,
  candidate: Candidate,
  options: {
    previewPath: string;
    thumbnailPath: string;
    previewMeta: JsonRecord | null;
    thumbnailMeta: JsonRecord | null;
    actorEmail: string;
  },
) {
  const { data, error } = await supabase.rpc("apply_order_evidence_derivative_backfill", {
    _event_id: candidate.event_id,
    _bucket: candidate.bucket || DEFAULT_BUCKET,
    _path: candidate.path,
    _preview_bucket: candidate.bucket || DEFAULT_BUCKET,
    _preview_path: options.previewPath || null,
    _preview_meta: options.previewMeta || {},
    _thumbnail_bucket: candidate.bucket || DEFAULT_BUCKET,
    _thumbnail_path: options.thumbnailPath || null,
    _thumbnail_meta: options.thumbnailMeta || {},
    _signed_by_email: options.actorEmail || "backfill-order-evidence-derivatives",
  });
  if (error) {
    throw new BackfillError("apply_backfill_failed", {
      phase: "apply_backfill",
      details: { eventId: candidate.event_id, path: candidate.path, message: error.message },
    });
  }
  return Array.isArray(data) ? data[0] : data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  try {
    const supabase = serviceClient();
    const operator = await requireAdmin(req, supabase);
    const input = await parseInput(req);
    const candidates = await listCandidates(supabase, input.limit);
    const results: JsonRecord[] = [];
    let uploaded = 0;
    let updated = 0;
    let failed = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      const existingPreviewPath = String(candidate.preview_path || "");
      const existingThumbnailPath = String(candidate.thumbnail_path || "");
      const nextPreviewPath = existingPreviewPath || derivativePath(candidate.path, "preview");
      const nextThumbnailPath = existingThumbnailPath || derivativePath(candidate.path, "thumbnail");

      if (input.dryRun) {
        results.push({
          event_id: candidate.event_id,
          path: candidate.path,
          label: candidate.label,
          needs_preview: !existingPreviewPath,
          needs_thumbnail: !existingThumbnailPath,
          preview_path: nextPreviewPath,
          thumbnail_path: nextThumbnailPath,
        });
        skipped += 1;
        continue;
      }

      try {
        const [previewResult, thumbnailResult] = await Promise.all([
          !existingPreviewPath
            ? uploadDerivative(supabase, candidate, nextPreviewPath, PREVIEW_TRANSFORM, input.imageTimeoutMs)
              .then((meta) => ({ meta, uploaded: 1 }))
            : Promise.resolve({
              meta: { bucket: candidate.bucket || DEFAULT_BUCKET, path: existingPreviewPath, preserved_existing: true },
              uploaded: 0,
            }),
          !existingThumbnailPath
            ? uploadDerivative(supabase, candidate, nextThumbnailPath, THUMBNAIL_TRANSFORM, input.imageTimeoutMs)
              .then((meta) => ({ meta, uploaded: 1 }))
            : Promise.resolve({
              meta: { bucket: candidate.bucket || DEFAULT_BUCKET, path: existingThumbnailPath, preserved_existing: true },
              uploaded: 0,
            }),
        ]);
        uploaded += previewResult.uploaded + thumbnailResult.uploaded;

        const applyResult = await applyBackfill(supabase, candidate, {
          previewPath: nextPreviewPath,
          thumbnailPath: nextThumbnailPath,
          previewMeta: previewResult.meta,
          thumbnailMeta: thumbnailResult.meta,
          actorEmail: operator.email || operator.actorType,
        });
        updated += Number((applyResult as JsonRecord | null)?.updated_photo_count || 0);
        results.push({
          ok: true,
          event_id: candidate.event_id,
          path: candidate.path,
          preview_path: nextPreviewPath,
          thumbnail_path: nextThumbnailPath,
          updated_photo_count: Number((applyResult as JsonRecord | null)?.updated_photo_count || 0),
        });
      } catch (error) {
        failed += 1;
        results.push({
          ok: false,
          event_id: candidate.event_id,
          path: candidate.path,
          error: error instanceof BackfillError ? error.code : "unknown_error",
          message: error instanceof Error ? error.message : String(error || "Unknown error"),
          details: error instanceof BackfillError ? error.details : {},
        });
      }
    }

    return json(200, {
      ok: failed === 0,
      dry_run: input.dryRun,
      scanned: candidates.length,
      uploaded,
      updated,
      skipped,
      failed,
      remaining_hint: candidates.length >= input.limit ? "Run again to continue the next batch." : "No more candidates returned in this batch.",
      results,
    });
  } catch (error) {
    const known = error instanceof BackfillError ? error : null;
    return json(known?.status || 500, {
      ok: false,
      error: known?.code || "unknown_error",
      phase: known?.phase || "unknown",
      message: error instanceof Error ? error.message : String(error || "Unknown error"),
      details: known?.details || {},
    });
  }
});
