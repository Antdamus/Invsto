import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

serve(async (req) => {
  const { user } = await req.json();

  const claims = {
    role: user?.user_metadata?.role ?? "authenticated",
  };

  return new Response(JSON.stringify({ claims }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
});
