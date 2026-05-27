// supabase/functions/enqueue-task-due-reminders/index.ts
//
// Scheduler-safe wrapper for public.enqueue_task_due_reminders().
// The database function owns the task filtering, duplicate prevention,
// notification creation, and SMS audit logging.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

Deno.serve(async () => {
  try {
    const { data, error } = await supabase.rpc("enqueue_task_due_reminders");

    if (error) {
      console.error("RPC error:", error);
      return new Response(
        JSON.stringify({ ok: false, error: error.message }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, summary: data || [] }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
});
