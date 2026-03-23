import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });

  try {
    const url = new URL(req.url);
    const channel = (url.searchParams.get("channel") || "og_main").trim();

    // Always public-safe: ONLY published content returned
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data, error } = await supabase
      .from("storefront_content")
      .select("slot,type,value")
      .eq("channel", channel)
      .eq("status", "published");

    if (error) return json(500, { ok: false, error: error.message });

    const content: Record<string, { type: string; value: any }> = {};
    for (const row of data || []) {
      content[row.slot] = { type: row.type, value: row.value };
    }

    return json(200, { ok: true, channel, content });
  } catch (e) {
    return json(500, { ok: false, error: String(e) });
  }
});
