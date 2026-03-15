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
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") return json(405, { error: "method_not_allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!SUPABASE_URL || !SERVICE_ROLE) return json(500, { error: "missing_service_secrets" });

  try {
    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get("limit") || "8");
    const limit = Math.max(1, Math.min(12, Number.isFinite(limitRaw) ? limitRaw : 8));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data, error } = await supabase.rpc("get_storefront_testimonials", {
      p_limit: limit,
    });

    if (error) {
      return json(500, { error: "testimonial_query_failed", detail: error.message });
    }

    return json(200, {
      ok: true,
      items: Array.isArray(data) ? data : [],
    });
  } catch (error) {
    return json(500, {
      error: "unexpected_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});
