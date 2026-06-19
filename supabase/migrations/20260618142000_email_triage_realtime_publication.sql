-- Enable live email-triage timeline updates across open admin/worker sessions.
-- RLS still controls which authenticated users can receive row payloads.

do $$
begin
  alter publication supabase_realtime add table public.ebay_conversation_messages;
exception
  when duplicate_object then null;
  when undefined_object then null;
  when undefined_table then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.ebay_conversations;
exception
  when duplicate_object then null;
  when undefined_object then null;
  when undefined_table then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.team_tasks;
exception
  when duplicate_object then null;
  when undefined_object then null;
  when undefined_table then null;
end $$;
