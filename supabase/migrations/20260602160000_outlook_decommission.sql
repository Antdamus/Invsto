-- Step 5F.6Q: Outlook decommission.
-- Archive eBay link bridge rows before removing the legacy email schema.

create table if not exists public.outlook_retirement_ebay_link_archive (
  id uuid primary key default gen_random_uuid(),
  archived_at timestamptz not null default now(),
  source_link_id uuid not null unique,
  conversation_id uuid,
  seller_account_id uuid,
  link_type text,
  link_key text,
  email_message_id uuid,
  provider_message_id text,
  internet_message_id text,
  subject text,
  from_name text,
  from_email text,
  sender_name text,
  sender_email text,
  received_at timestamptz,
  body_preview text,
  original_link_metadata jsonb not null default '{}'::jsonb,
  original_link_payload jsonb not null default '{}'::jsonb,
  email_payload jsonb not null default '{}'::jsonb
);

comment on table public.outlook_retirement_ebay_link_archive
  is 'Step 5F.6Q archive of retired eBay conversation links that previously pointed at legacy email messages.';

do $$
begin
  if to_regclass('public.ebay_conversation_links') is not null
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'ebay_conversation_links'
        and column_name = 'email_message_id'
    )
  then
    if to_regclass('public.email_messages') is not null then
      execute $archive_with_email$
        insert into public.outlook_retirement_ebay_link_archive (
          source_link_id,
          conversation_id,
          seller_account_id,
          link_type,
          link_key,
          email_message_id,
          provider_message_id,
          internet_message_id,
          subject,
          from_name,
          from_email,
          sender_name,
          sender_email,
          received_at,
          body_preview,
          original_link_metadata,
          original_link_payload,
          email_payload
        )
        select
          l.id,
          l.conversation_id,
          l.seller_account_id,
          l.link_type,
          l.link_key,
          l.email_message_id,
          em.provider_message_id,
          em.internet_message_id,
          em.subject,
          em.from_name,
          em.from_email,
          em.sender_name,
          em.sender_email,
          em.received_at,
          em.body_preview,
          coalesce(l.metadata, '{}'::jsonb),
          to_jsonb(l),
          coalesce(to_jsonb(em), '{}'::jsonb)
        from public.ebay_conversation_links l
        left join public.email_messages em
          on em.id = l.email_message_id
        where l.link_type = 'outlook_email'
          or l.email_message_id is not null
        on conflict (source_link_id) do update
        set archived_at = now(),
            conversation_id = excluded.conversation_id,
            seller_account_id = excluded.seller_account_id,
            link_type = excluded.link_type,
            link_key = excluded.link_key,
            email_message_id = excluded.email_message_id,
            provider_message_id = excluded.provider_message_id,
            internet_message_id = excluded.internet_message_id,
            subject = excluded.subject,
            from_name = excluded.from_name,
            from_email = excluded.from_email,
            sender_name = excluded.sender_name,
            sender_email = excluded.sender_email,
            received_at = excluded.received_at,
            body_preview = excluded.body_preview,
            original_link_metadata = excluded.original_link_metadata,
            original_link_payload = excluded.original_link_payload,
            email_payload = excluded.email_payload
      $archive_with_email$;
    else
      execute $archive_links_only$
        insert into public.outlook_retirement_ebay_link_archive (
          source_link_id,
          conversation_id,
          seller_account_id,
          link_type,
          link_key,
          email_message_id,
          original_link_metadata,
          original_link_payload
        )
        select
          l.id,
          l.conversation_id,
          l.seller_account_id,
          l.link_type,
          l.link_key,
          l.email_message_id,
          coalesce(l.metadata, '{}'::jsonb),
          to_jsonb(l)
        from public.ebay_conversation_links l
        where l.link_type = 'outlook_email'
          or l.email_message_id is not null
        on conflict (source_link_id) do update
        set archived_at = now(),
            conversation_id = excluded.conversation_id,
            seller_account_id = excluded.seller_account_id,
            link_type = excluded.link_type,
            link_key = excluded.link_key,
            email_message_id = excluded.email_message_id,
            original_link_metadata = excluded.original_link_metadata,
            original_link_payload = excluded.original_link_payload
      $archive_links_only$;
    end if;

    update public.ebay_conversation_links
    set metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object(
          'retired_email_message_id', email_message_id,
          'retired_email_bridge_at', now()
        ),
        email_message_id = null
    where email_message_id is not null
      and link_type <> 'outlook_email';

    delete from public.ebay_conversation_links
    where link_type = 'outlook_email';
  end if;
end;
$$;

do $$
declare
  constraint_record record;
begin
  if to_regclass('public.ebay_conversation_links') is null then
    return;
  end if;

  for constraint_record in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'ebay_conversation_links'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid) ilike '%email_message_id%'
  loop
    execute format('alter table public.ebay_conversation_links drop constraint if exists %I', constraint_record.conname);
  end loop;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'ebay_conversation_links'
      and column_name = 'email_message_id'
  ) then
    alter table public.ebay_conversation_links
      drop column email_message_id;
  end if;

  for constraint_record in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'ebay_conversation_links'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%link_type%'
      and pg_get_constraintdef(c.oid) ilike '%outlook_email%'
  loop
    execute format('alter table public.ebay_conversation_links drop constraint if exists %I', constraint_record.conname);
  end loop;

  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'ebay_conversation_links'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%link_type%'
  ) then
    alter table public.ebay_conversation_links
      add constraint ebay_conversation_links_link_type_check
      check (link_type in (
        'listing_reference',
        'buyer_username',
        'ebay_order',
        'ebay_order_line',
        'ebay_return_case',
        'inventory_listing'
      ));
  end if;
end;
$$;

do $$
declare
  constraint_record record;
begin
  if to_regclass('public.ebay_message_send_attempts') is null then
    return;
  end if;

  for constraint_record in
    select c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'ebay_message_send_attempts'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%provider%'
      and pg_get_constraintdef(c.oid) ilike '%outlook_relay%'
  loop
    execute format('alter table public.ebay_message_send_attempts drop constraint if exists %I', constraint_record.conname);
  end loop;

  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'ebay_message_send_attempts'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%provider%'
  ) then
    alter table public.ebay_message_send_attempts
      add constraint ebay_message_send_attempts_provider_check
      check (provider in ('ebay_commerce_message', 'ebay_return', 'manual', 'unknown')) not valid;
  end if;
end;
$$;

drop table if exists public.email_response_drafts cascade;
drop table if exists public.email_classification_review_events cascade;
drop table if exists public.email_operational_events cascade;
drop table if exists public.email_message_links cascade;
drop table if exists public.email_message_classifications cascade;
drop table if exists public.email_processing_jobs cascade;
drop table if exists public.email_sync_runs cascade;
drop table if exists public.email_sync_states cascade;
drop table if exists public.email_attachments cascade;
drop table if exists public.email_message_bodies cascade;
drop table if exists public.email_message_recipients cascade;
drop table if exists public.email_messages cascade;
drop table if exists public.email_folders cascade;
drop table if exists public.email_mailboxes cascade;
drop table if exists public.microsoft_mailbox_connection_secrets cascade;
drop table if exists public.microsoft_mailbox_connections cascade;
