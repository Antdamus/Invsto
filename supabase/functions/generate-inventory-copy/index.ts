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

type OpenAIDebugInfo = {
  openaiAttempted: boolean;
  openaiStatus: string;
  openaiErrorSummary: string;
  parseFailure: boolean;
  rawOutputPreview: string;
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

function truncateForPreview(value: unknown, maxLength = 400) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function summarizeError(error: unknown) {
  if (error instanceof Error) return error.message;
  return truncateForPreview(error, 200);
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
): Promise<{ result: CopyResult | null; debug: OpenAIDebugInfo }> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL");
  const debug: OpenAIDebugInfo = {
    openaiAttempted: false,
    openaiStatus: "not_attempted",
    openaiErrorSummary: "",
    parseFailure: false,
    rawOutputPreview: "",
  };

  console.log("[generate-inventory-copy] OpenAI config check", {
    hasOpenAIKey: Boolean(apiKey),
    model: model || "(missing)",
  });

  if (!apiKey || !model) {
    debug.openaiStatus = "missing_config";
    debug.openaiErrorSummary = !apiKey && !model
      ? "OPENAI_API_KEY and OPENAI_MODEL are missing"
      : !apiKey
        ? "OPENAI_API_KEY is missing"
        : "OPENAI_MODEL is missing";
    return { result: null, debug };
  }

  debug.openaiAttempted = true;
  debug.openaiStatus = "request_started";

const userPrompt = `
Known metadata:
- Material: ${body.material ?? ""}
- Purity: ${body.purity ?? ""}
- Weight: ${body.weight ?? ""}
- Stone type: ${body.stoneType ?? ""}
- Notes: ${body.notes ?? ""}
- Category: ${body.category ?? ""}
- QR type: ${body.qrType ?? ""}

Write:
1. a concise, searchable jewelry listing title
2. a polished buyer-facing product description

Use the structured metadata as source of truth.
Use the selected image to identify visible style, shape, finish, setting, and item type.
Make the description feel premium, elegant, and commercially appealing, while remaining factually restrained.

Return valid JSON only with exactly:
{
  "generatedTitle": "string",
  "generatedDescription": "string"
}
`.trim();

  try {
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
      text: `
You are writing polished product copy for a jewelry seller.

Your task is to generate:
1. a concise, searchable product title
2. a polished product description that sounds appealing to a buyer

You will receive:
- a selected product photo
- measured weight from the scale
- structured item metadata entered by the user

Your job is to combine all of that into clean, attractive, commercially useful jewelry listing copy.

Core writing goal:
Write like refined ecommerce jewelry copy intended to help sell the item.
The result should feel elegant, professional, and desirable, while remaining factually grounded.

Use these sources correctly:
- The structured metadata entered by the user is the source of truth.
- The selected image should be used to identify visible style, shape, item type, silhouette, finish, setting, and overall visual appeal.
- The measured weight should be used as supporting context only.
- If the item type is visually clear, name it specifically.
- If the item type is not fully clear, use safe but still appealing wording.

Style requirements:
- polished
- elegant
- commercially useful
- refined
- natural
- buyer-facing
- suitable for a jewelry product listing
- attractive without sounding fake or exaggerated

The title should be:
- concise
- searchable
- inventory-friendly
- suitable for a product listing
- specific when the visual item type is clear

The description should be:
- 2 to 4 polished sentences
- written like real jewelry listing copy
- attractive to a buyer
- based on visible design and known metadata
- natural and confident in tone
- refined, not robotic
- commercially appealing, not internal or technical

The description should focus on:
- visible design
- overall look and presence
- finish
- silhouette
- styling versatility
- sparkle or texture if clearly visible
- craftsmanship language only when visually supported
- weight in a natural way when helpful

Important truthfulness rules:
- Do not invent brand names
- Do not invent designer associations
- Do not invent provenance, rarity, or exclusivity
- Do not assert gemstone authenticity unless explicitly provided
- Do not invent metal or purity if not provided
- Do not invent dimensions if not known
- Do not invent stone type if not provided
- Do not overstate what can be concluded from weight alone
- Do not make unsupported luxury claims
- Do not describe details that are not visible or not provided

Important tone rules:
Do NOT sound like:
- an inventory database
- an appraisal report
- a compliance document
- a generic AI assistant
- a placeholder text generator

Do NOT use phrases like:
- "suitable for inventory entry"
- "review and edit as needed"
- "jewelry item"
- "product shown"

Instead, sound like:
- polished ecommerce jewelry copy
- refined product listing language
- elegant selling copy
- strong but believable commercial writing

Weight usage rule:
- Use the measured weight as helpful supporting detail when appropriate
- Integrate it naturally if it improves the listing
- Do not force the weight into the title unless it truly helps
- Do not make unsupported conclusions from the weight

Metadata priority rule:
If material, purity, stone type, or other structured fields are provided by the user, treat them as authoritative.
Do not contradict them.
Do not replace them with guesses from the image.

Image usage rule:
Use the image mainly to determine:
- item category
- visual style
- shape
- structure
- finish
- setting/look
- overall aesthetic presence

If the image clearly shows a specific item type, prefer that over vague wording.
Examples of specific item-type language when visually justified:
- pendant
- cross pendant
- ring
- bracelet
- chain
- earrings
- necklace
- charm

If the exact item type is unclear, use safe but polished wording.

Output format:
Return valid JSON only.
Do not include markdown.
Do not include commentary outside the JSON.

Return exactly this structure:
{
  "generatedTitle": "string",
  "generatedDescription": "string"
}
      `.trim(),
    },
  ],
},
          {
            role: "user",
            content: [
              { type: "input_text", text: userPrompt },
              { type: "input_image", image_url: signedImageUrl },
            ],
          },
        ],
      }),
    });

    debug.openaiStatus = `http_${response.status}`;
    console.log("[generate-inventory-copy] OpenAI HTTP status", {
      status: response.status,
      ok: response.ok,
      model,
    });

    if (!response.ok) {
      const failedBody = await response.text();
      const failedBodyPreview = truncateForPreview(failedBody);
      debug.openaiErrorSummary = `OpenAI request failed (${response.status})`;
      debug.rawOutputPreview = failedBodyPreview;
      console.error("[generate-inventory-copy] OpenAI request failed", {
        status: response.status,
        bodyPreview: failedBodyPreview,
      });
      return { result: null, debug };
    }

    const payload = await response.json();
    const outputText = extractOutputText(payload);
    debug.rawOutputPreview = truncateForPreview(outputText || JSON.stringify(payload));

    const parsed = tryParseJsonObject(outputText);
    if (!parsed) {
      debug.parseFailure = true;
      debug.openaiStatus = "parse_failed";
      debug.openaiErrorSummary = "Model output could not be parsed as JSON";
      console.error("[generate-inventory-copy] Failed to parse OpenAI output as JSON", {
        rawOutputPreview: debug.rawOutputPreview,
      });
      return { result: null, debug };
    }

    debug.openaiStatus = "success";

    return {
      result: sanitizeGeneratedCopy(
        {
          mode: "openai",
          generatedTitle: parsed.generatedTitle,
          generatedDescription: parsed.generatedDescription,
        },
        fallback
      ),
      debug,
    };
  } catch (error) {
    debug.openaiStatus = "request_exception";
    debug.openaiErrorSummary = summarizeError(error);
    console.error("[generate-inventory-copy] OpenAI request exception", {
      error: debug.openaiErrorSummary,
      model,
    });
    return { result: null, debug };
  }
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
    let openAIDebug: OpenAIDebugInfo = {
      openaiAttempted: false,
      openaiStatus: "not_attempted",
      openaiErrorSummary: "",
      parseFailure: false,
      rawOutputPreview: "",
    };

    try {
      const { result, debug } = await tryGenerateWithOpenAI(body, signedData.signedUrl, fallback);
      openAIDebug = debug;
      if (result) {
        generated = result;
      }
    } catch (error) {
      console.error("OpenAI generation failed, falling back to placeholder:", error);
      openAIDebug.openaiAttempted = true;
      openAIDebug.openaiStatus = "unexpected_wrapper_exception";
      openAIDebug.openaiErrorSummary = summarizeError(error);
    }

    return json(200, {
      ok: true,
      mode: generated.mode,
      generatedTitle: generated.generatedTitle,
      generatedDescription: generated.generatedDescription,
      openaiAttempted: openAIDebug.openaiAttempted,
      openaiStatus: openAIDebug.openaiStatus,
      openaiErrorSummary: openAIDebug.openaiErrorSummary,
      parseFailure: openAIDebug.parseFailure,
      rawOutputPreview: openAIDebug.rawOutputPreview,
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
