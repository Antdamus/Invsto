import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "supabase";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Use POST" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const METALSDEV_API_KEY = Deno.env.get("METALSDEV_API_KEY")!;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // unit=g => prices returned in USD per gram (super clean)
    const url =
      `https://api.metals.dev/v1/latest?api_key=${encodeURIComponent(METALSDEV_API_KEY)}&currency=USD&unit=g`;

    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`Metals.Dev HTTP ${r.status}`);
    const data = await r.json();

    if (data?.status !== "success") {
      throw new Error(`Metals.Dev failure: ${data?.error_code} ${data?.error_message}`);
    }

    // Docs show: data.metals.gold and data.metals.silver :contentReference[oaicite:1]{index=1}
    const gold = Number(data?.metals?.gold);
    const silver = Number(data?.metals?.silver);

    if (!Number.isFinite(gold) || gold <= 0) throw new Error("Bad gold value");
    if (!Number.isFinite(silver) || silver <= 0) throw new Error("Bad silver value");

    const asOf = data?.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString();
    const source = "metals.dev";

    const rows = [
      { metal: "gold", price_per_gram: gold, as_of: asOf, source },
      { metal: "silver", price_per_gram: silver, as_of: asOf, source },
    ];

    const { error } = await supabase
      .from("metal_spot_prices")
      .upsert(rows, { onConflict: "metal" });

    if (error) throw error;

    return json(200, { ok: true, rows });
  } catch (e) {
    return json(500, { ok: false, error: String(e) });
  }
});
