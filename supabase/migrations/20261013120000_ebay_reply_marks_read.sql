begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- Keep the successful send that established a read in the audit trail.
alter table public.ebay_message_read_events
  add column send_attempt_id uuid references public.ebay_message_send_attempts(id) on delete set null;
create unique index ebay_message_read_events_send_idx
  on public.ebay_message_read_events(message_id, send_attempt_id)
  where send_attempt_id is not null;

-- Only the server can write the send ledger. Record receipts in the same
-- transaction as its confirmed success, even if the browser closes afterwards.
create function public.mark_ebay_reply_messages_read()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target public.ebay_conversation_messages;
  reader text;
  m record;
  recorded uuid;
begin
  if new.attempt_status <> 'succeeded' or new.sent_at is null or new.created_by is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.attempt_status = 'succeeded' then return new; end if;
  end if;

  perform 1 from public.ebay_conversations where id = new.conversation_id for update;
  select * into target from public.ebay_conversation_messages
    where id = new.target_message_id and conversation_id = new.conversation_id and direction = 'inbound';
  if not found then return new; end if;

  select coalesce(nullif(display_name, ''), email) into reader
    from public.employees where user_id = new.created_by limit 1;
  reader := coalesce(reader, nullif(new.metadata->>'sent_by_email', ''), 'Staff member');

  -- Read the message being answered and earlier messages already present when
  -- this send began. A newer buyer reply or a later import must remain unread.
  for m in
    select id from public.ebay_conversation_messages
    where conversation_id = new.conversation_id and direction <> 'outbound'
      and (id = target.id or (
        created_at <= new.created_at
        and coalesce(created_at_ebay, created_at) <= coalesce(target.created_at_ebay, target.created_at)
      ))
    order by id
  loop
    insert into public.ebay_message_read_events(message_id, conversation_id, is_read, actor_user_id, actor_name, created_at, send_attempt_id)
    values(m.id, new.conversation_id, true, new.created_by, reader, new.sent_at, new.id)
    on conflict(message_id, send_attempt_id) where send_attempt_id is not null do nothing
    returning id into recorded;
    if recorded is null then continue; end if;

    insert into public.ebay_message_team_reads as r
      (message_id, is_read, first_read_by, first_read_name, first_read_at, last_read_by, last_read_name, last_read_at, changed_by, changed_at)
    values(m.id, true, new.created_by, reader, new.sent_at, new.created_by, reader, new.sent_at, new.created_by, new.sent_at)
    on conflict(message_id) do update set
      is_read = true,
      first_read_by = coalesce(r.first_read_by, excluded.first_read_by),
      first_read_name = coalesce(r.first_read_name, excluded.first_read_name),
      first_read_at = coalesce(r.first_read_at, excluded.first_read_at),
      last_read_by = excluded.last_read_by,
      last_read_name = excluded.last_read_name,
      last_read_at = excluded.last_read_at,
      changed_by = excluded.changed_by,
      changed_at = excluded.changed_at
    -- A delayed confirmation must not undo a newer explicit staff action.
    where r.changed_at <= excluded.changed_at;
  end loop;
  return new;
end $$;
revoke all on function public.mark_ebay_reply_messages_read() from public, anon, authenticated;
create trigger ebay_reply_marks_messages_read
  after insert or update of attempt_status on public.ebay_message_send_attempts
  for each row when (new.attempt_status = 'succeeded')
  execute function public.mark_ebay_reply_messages_read();

notify pgrst, 'reload schema';
commit;
