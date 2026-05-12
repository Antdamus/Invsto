import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_BUCKETS = new Set(["InventoryUpload", "capture-photos", "photos"]);
const SUPPORTED_BACKGROUNDS = new Set(["black", "white", "edited", "uploaded"]);

type RequestBody = {
  bucket?: string;
  imagePath?: string;
  background?: "black" | "white" | "edited" | "uploaded";
  imageBase64?: string;
  imageDataUrl?: string;
  processedImageBase64?: string;
  processedImageDataUrl?: string;
  normalizedMimeType?: string;
  processedMimeType?: string;
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

function normalizePath(value: string) {
  return String(value || "").trim().replace(/^\/+/, "");
}

function safeFilePart(value: string) {
  return String(value || "image")
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

function extensionForMime(mimeType: string) {
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  return "png";
}

function normalizeImageMimeType(value: unknown) {
  const mimeType = asTrimmedString(value).toLowerCase();
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "image/jpeg";
  if (mimeType.includes("png")) return "image/png";
  if (mimeType.includes("webp")) return "image/webp";
  return "image/jpeg";
}

function assertSupportedSourceImage(imagePath: string) {
  if (!/\.(png|jpe?g|webp)$/i.test(imagePath)) {
    throw new Error(
      "OpenAI background processing supports PNG, JPG, and WEBP source images. Please capture or upload this image as JPG/PNG/WEBP before processing."
    );
  }
}

function decodeBase64(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeImagePayload(dataUrlValue: unknown, base64ValueInput: unknown, mimeTypeValue: unknown) {
  const dataUrl = asTrimmedString(dataUrlValue);
  const base64Value = asTrimmedString(base64ValueInput);
  const dataUrlMatch = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i);
  const mimeType = dataUrlMatch
    ? normalizeImageMimeType(dataUrlMatch[1])
    : normalizeImageMimeType(mimeTypeValue);
  const base64 = dataUrlMatch ? dataUrlMatch[2] : base64Value;

  if (!base64) return null;

  const bytes = decodeBase64(base64.replace(/\s/g, ""));
  if (bytes.byteLength > 8 * 1024 * 1024) {
    throw new Error("Normalized source image is too large. Please use a smaller capture or try again.");
  }

  return {
    bytes,
    contentType: mimeType,
  };
}

function decodeImageBody(body: RequestBody) {
  return decodeImagePayload(body.imageDataUrl, body.imageBase64, body.normalizedMimeType);
}

function decodeProcessedImageBody(body: RequestBody) {
  return decodeImagePayload(body.processedImageDataUrl, body.processedImageBase64, body.processedMimeType);
}

async function fetchArrayBuffer(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch generated image (${response.status})`);
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || "image/png",
  };
}

async function uploadNormalizedSourceImage(
  supabase: ReturnType<typeof createClient>,
  bucket: string,
  imagePath: string,
  normalizedImage: { bytes: Uint8Array; contentType: string }
) {
  const originalName = safeFilePart(imagePath.split("/").pop() || "image");
  const extension = extensionForMime(normalizedImage.contentType);
  const normalizedPath = [
    "processed-backgrounds",
    "normalized-sources",
    `${new Date().toISOString().replace(/[:.]/g, "-")}_${originalName}.${extension}`,
  ].join("/");

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(normalizedPath, new Blob([normalizedImage.bytes], { type: normalizedImage.contentType }), {
      upsert: true,
      contentType: normalizedImage.contentType,
    });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

  const { data: signedData, error: signedError } = await supabase.storage
    .from(bucket)
    .createSignedUrl(normalizedPath, 60 * 10);

  if (signedError || !signedData?.signedUrl) {
    throw new Error(signedError?.message || "No signed URL returned for normalized source image.");
  }

  return {
    path: normalizedPath,
    signedUrl: signedData.signedUrl,
  };
}

async function editImageWithOpenAI(signedImageUrl: string, background: "black" | "white") {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_IMAGE_MODEL") || "gpt-image-1";

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const backgroundInstruction = background === "black"
    ? "a pure deep black studio background"
    : "a pure clean white studio background";

  const prompt = `
Isolate the jewelry object from the input image and place the exact same object on ${backgroundInstruction}.
Keep the jewelry unchanged: same shape, color, stones, metal, proportions, and visible details.
Remove the original background completely.
Use a polished ecommerce product-photo style with clean lighting and a natural subtle shadow.
Do not add text, logos, props, hands, boxes, display stands, or extra objects.
Return a square product image focused on the item.
`.trim();

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      images: [{ image_url: signedImageUrl }],
      prompt,
      background: "opaque",
      output_format: "png",
      size: "1024x1024",
      quality: "medium",
      n: 1,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI image edit failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const payload = await response.json();
  const firstImage = payload?.data?.[0];

  if (firstImage?.b64_json) {
    return {
      bytes: decodeBase64(firstImage.b64_json),
      contentType: "image/png",
    };
  }

  if (firstImage?.url) {
    return await fetchArrayBuffer(firstImage.url);
  }

  throw new Error("OpenAI image edit returned no image data.");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  try {
    const body = (await req.json()) as RequestBody;
    const bucket = asTrimmedString(body.bucket);
    const imagePath = normalizePath(body.imagePath || "");
    const background = asTrimmedString(body.background).toLowerCase() as "black" | "white" | "edited" | "uploaded";
    let normalizedImage: { bytes: Uint8Array; contentType: string } | null;
    let processedImage: { bytes: Uint8Array; contentType: string } | null;
    try {
      normalizedImage = decodeImageBody(body);
      processedImage = decodeProcessedImageBody(body);
    } catch (error) {
      return json(400, {
        ok: false,
        error: "invalid_image_payload",
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    if (!ALLOWED_BUCKETS.has(bucket)) {
      return json(400, { ok: false, error: "invalid_bucket", bucket });
    }

    if (!imagePath || !SUPPORTED_BACKGROUNDS.has(background)) {
      return json(400, {
        ok: false,
        error: "missing_required_fields",
        required: ["bucket", "imagePath", "background:black|white|edited|uploaded"],
      });
    }

    if (!normalizedImage && !processedImage) {
      try {
        assertSupportedSourceImage(imagePath);
      } catch (error) {
        return json(400, {
          ok: false,
          error: "unsupported_source_image_format",
          detail: error instanceof Error ? error.message : String(error),
          imagePath,
        });
      }
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return json(500, { ok: false, error: "missing_supabase_service_credentials" });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    if (processedImage) {
      const extension = extensionForMime(processedImage.contentType);
      const originalName = safeFilePart(imagePath.split("/").pop() || "image");
      const outputPath = [
        "processed-backgrounds",
        `${new Date().toISOString().replace(/[:.]/g, "-")}_${background}_${originalName}.${extension}`,
      ].join("/");

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(outputPath, new Blob([processedImage.bytes], { type: processedImage.contentType }), {
          upsert: true,
          contentType: processedImage.contentType,
        });

      if (uploadError) {
        return json(500, {
          ok: false,
          error: "processed_upload_failed",
          detail: uploadError.message,
        });
      }

      const { data: outputSignedData, error: outputSignedError } = await supabase.storage
        .from(bucket)
        .createSignedUrl(outputPath, 60 * 10);

      if (outputSignedError || !outputSignedData?.signedUrl) {
        return json(500, {
          ok: false,
          error: "processed_sign_failed",
          detail: outputSignedError?.message || "No signed URL returned",
        });
      }

      return json(200, {
        ok: true,
        bucket,
        path: outputPath,
        name: background === "edited"
          ? `edited crop - ${imagePath.split("/").pop() || "processed image"}`
          : background === "uploaded"
            ? `uploaded document - ${imagePath.split("/").pop() || "processed image"}`
            : `${background} background - ${imagePath.split("/").pop() || "processed image"}`,
        background,
        previewUrl: outputSignedData.signedUrl,
        mimeType: processedImage.contentType,
        createdAt: new Date().toISOString(),
        processingMode: "pixel-preserving-composite",
      });
    }

    let normalizedSource: { path: string; signedUrl: string };
    if (background === "edited" || background === "uploaded") {
      return json(400, {
        ok: false,
        error: "processed_upload_requires_image",
        detail: "Edited and uploaded image writes must include processedImageBase64 or processedImageDataUrl.",
      });
    }
    if (normalizedImage) {
      try {
        normalizedSource = await uploadNormalizedSourceImage(supabase, bucket, imagePath, normalizedImage);
      } catch (error) {
        return json(500, {
          ok: false,
          error: "source_image_normalization_upload_failed",
          detail: error instanceof Error ? error.message : String(error),
          bucket,
          imagePath,
        });
      }
    } else {
      const { data: signedData, error: signedError } = await supabase.storage
        .from(bucket)
        .createSignedUrl(imagePath, 60 * 10);

      if (signedError || !signedData?.signedUrl) {
        return json(500, {
          ok: false,
          error: "image_sign_failed",
          detail: signedError?.message || "No signed URL returned",
        });
      }

      normalizedSource = {
        path: imagePath,
        signedUrl: signedData.signedUrl,
      };
    }

    let editedImage: { bytes: Uint8Array; contentType: string };
    try {
      editedImage = await editImageWithOpenAI(normalizedSource.signedUrl, background);
    } catch (error) {
      return json(500, {
        ok: false,
        error: "openai_image_edit_failed",
        detail: error instanceof Error ? error.message : String(error),
        bucket,
        imagePath,
        normalizedImagePath: normalizedSource.path,
        background,
      });
    }

    const extension = extensionForMime(editedImage.contentType);
    const originalName = safeFilePart(imagePath.split("/").pop() || "image");
    const outputPath = [
      "processed-backgrounds",
      `${new Date().toISOString().replace(/[:.]/g, "-")}_${background}_${originalName}.${extension}`,
    ].join("/");

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(outputPath, new Blob([editedImage.bytes], { type: editedImage.contentType }), {
        upsert: true,
        contentType: editedImage.contentType,
      });

    if (uploadError) {
      return json(500, {
        ok: false,
        error: "processed_upload_failed",
        detail: uploadError.message,
      });
    }

    const { data: outputSignedData, error: outputSignedError } = await supabase.storage
      .from(bucket)
      .createSignedUrl(outputPath, 60 * 10);

    if (outputSignedError || !outputSignedData?.signedUrl) {
      return json(500, {
        ok: false,
        error: "processed_sign_failed",
        detail: outputSignedError?.message || "No signed URL returned",
      });
    }

    return json(200, {
      ok: true,
      bucket,
      path: outputPath,
      name: `${background} background - ${imagePath.split("/").pop() || "processed image"}`,
      background,
      previewUrl: outputSignedData.signedUrl,
      mimeType: editedImage.contentType,
      normalizedSourcePath: normalizedSource.path,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("process-inventory-image failed:", error);
    return json(500, {
      ok: false,
      error: "unexpected_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});
