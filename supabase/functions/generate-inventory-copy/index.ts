import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ALLOWED_BUCKET = "InventoryUpload";

type RequestBody = {
  bucket?: string;
  imagePath?: string;
  material?: string;
  purity?: string;
  weight?: number;
  stoneType?: string;
  notes?: string;
  category?: string;
  qrType?: string;
  existingTitle?: string;
  existingDescription?: string;
};

type CopyResult = {
  mode: "placeholder" | "openai";
  generatedTitle: string;
  generatedDescription: string;
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

function normalizePath(value: string) {
  return String(value || "").trim().replace(/^\/+/, "");
}

function asTrimmedString(value: unknown) {
  return String(value || "").trim();
}

function sentenceCase(value: string) {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function detectKnownItemType(notes: string, category: string) {
  const combined = `${notes} ${category}`.toLowerCase();
  const candidates = [
    "ring",
    "pendant",
    "necklace",
    "bracelet",
    "earrings",
    "band",
    "chain",
    "brooch",
    "charm",
    "watch",
    "cufflinks",
  ];

  const match = candidates.find((candidate) => combined.includes(candidate));
  return match ? sentenceCase(match) : "Jewelry Item";
}

function buildPlaceholderCopy(body: Required<Pick<RequestBody, "material" | "purity" | "weight">> & Partial<RequestBody>): CopyResult {
  const material = asTrimmedString(body.material);
  const purity = asTrimmedString(body.purity);
  const stoneType = asTrimmedString(body.stoneType);
  const notes = asTrimmedString(body.notes);
  const category = asTrimmedString(body.category);
  const itemType = detectKnownItemType(notes, category);
  const measuredWeight = Number(body.weight || 0);

  const titleParts = [material, purity];
  if (stoneType) titleParts.push(stoneType);
  titleParts.push(itemType);

  const generatedTitle = titleParts.join(" ").replace(/\s+/g, " ").trim();

  const descriptionParts = [
    `${material} ${purity} ${itemType.toLowerCase()} suitable for inventory entry.`,
    `Measured weight: ${measuredWeight.toFixed(2)} g.`,
  ];

  if (stoneType) {
    descriptionParts.push(`Stone type provided by intake: ${stoneType}.`);
  }

  if (notes) {
    descriptionParts.push(`Intake notes: ${notes}.`);
  }

  descriptionParts.push(
    "Review the selected photo and edit this copy as needed before final item creation."
  );

  return {
    mode: "placeholder",
    generatedTitle,
    generatedDescription: descriptionParts.join(" "),
  };
}

function sanitizeGeneratedCopy(result: Partial<CopyResult>, fallback: CopyResult): CopyResult {
  const generatedTitle = asTrimmedString(result.generatedTitle);
  const generatedDescription = asTrimmedString(result.generatedDescription);

  if (!generatedTitle || !generatedDescription) {
    return fallback;
  }

  return {
    mode: result.mode === "openai" ? "openai" : "placeholder",
    generatedTitle,
    generatedDescription,
  };
}

function tryParseJsonObject(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractOutputText(payload: any): string {
  if (typeof payload?.output_text === "string") return payload.output_text;

  const chunks = payload?.output
    ?.flatMap((entry: any) => entry?.content || [])
    ?.map((content: any) => content?.text || "")
    ?.filter(Boolean);

  return Array.isArray(chunks) ? chunks.join("\n").trim() : "";
}

async function tryGenerateWithOpenAI(
  body: RequestBody,
  signedImageUrl: string,
  fallback: CopyResult
): Promise<CopyResult | null> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL");

  if (!apiKey || !model) {
    return null;
  }

  const prompt = [
    "Generate strict JSON with keys generatedTitle and generatedDescription.",
    "Use known metadata as source of truth and do not invent missing facts.",
    "Do not invent brand names, gemstone authenticity, dimensions, designer, or unsupported metal details.",
    "Title must be concise, searchable, and inventory-friendly.",
    "Description must be polished, commercially useful, and factually restrained.",
    `Known metadata: ${JSON.stringify({
      material: body.material,
      purity: body.purity,
      weight: body.weight,
      stoneType: body.stoneType,
      notes: body.notes,
      category: body.category,
      qrType: body.qrType,
    })}`,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: "You write safe inventory copy for jewelry intake. Return JSON only.",
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: signedImageUrl },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status})`);
  }

  const payload = await response.json();
  const outputText = extractOutputText(payload);
  const parsed = tryParseJsonObject(outputText);
  if (!parsed) {
    return null;
  }

  return sanitizeGeneratedCopy(
    {
      mode: "openai",
      generatedTitle: parsed.generatedTitle,
      generatedDescription: parsed.generatedDescription,
    },
    fallback
  );
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  try {
    const body = (await req.json()) as RequestBody;
    const bucket = asTrimmedString(body.bucket || ALLOWED_BUCKET);
    const imagePath = normalizePath(body.imagePath || "");
    const material = asTrimmedString(body.material);
    const purity = asTrimmedString(body.purity);
    const weight = Number(body.weight);

    if (bucket !== ALLOWED_BUCKET) {
      return json(400, { ok: false, error: "invalid_bucket" });
    }

    if (!imagePath || !material || !purity || !Number.isFinite(weight)) {
      return json(400, {
        ok: false,
        error: "missing_required_fields",
        required: ["imagePath", "material", "purity", "weight"],
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return json(500, { ok: false, error: "missing_supabase_service_credentials" });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data: signedData, error: signedError } = await supabase.storage
      .from(ALLOWED_BUCKET)
      .createSignedUrl(imagePath, 60 * 10);

    if (signedError || !signedData?.signedUrl) {
      return json(500, {
        ok: false,
        error: "image_sign_failed",
        detail: signedError?.message || "No signed URL returned",
      });
    }

    const fallback = buildPlaceholderCopy({
      ...body,
      material,
      purity,
      weight,
    });

    let generated = fallback;

    try {
      const openAIResult = await tryGenerateWithOpenAI(body, signedData.signedUrl, fallback);
      if (openAIResult) {
        generated = openAIResult;
      }
    } catch (error) {
      console.error("OpenAI generation failed, falling back to placeholder:", error);
    }

    return json(200, {
      ok: true,
      mode: generated.mode,
      generatedTitle: generated.generatedTitle,
      generatedDescription: generated.generatedDescription,
      selectedImagePath: imagePath,
      selectedImageSignedUrl: signedData.signedUrl,
    });
  } catch (error) {
    return json(500, {
      ok: false,
      error: "unexpected_error",
      detail: String(error),
    });
  }
});
