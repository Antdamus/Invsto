-- Task email notification delivery.
-- Adds an email queue/audit path beside the existing task SMS workflow.

create table if not exists public.user_notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  can_email boolean not null default true,
  preferred_task_channel text not null default 'auto',
  urgent_send_both boolean not null default false,
  email_override text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  constraint user_notification_preferences_channel_check
    check (preferred_task_channel in ('auto', 'sms', 'email', 'both', 'dashboard')),
  constraint user_notification_preferences_email_override_check
    check (email_override is null or email_override ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  to_email text not null,
  subject text not null,
  text_body text not null,
  html_body text,
  send_after timestamptz not null default now(),
  status text not null default 'pending',
  provider text not null default 'resend',
  provider_message_id text,
  meta jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_outbox_to_email_check
    check (to_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  constraint email_outbox_subject_check
    check (length(nullif(btrim(subject), '')) between 1 and 240),
  constraint email_outbox_text_body_check
    check (length(nullif(btrim(text_body), '')) between 1 and 12000),
  constraint email_outbox_status_check
    check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled'))
);

create table if not exists public.task_notification_email_dedupe (
  dedupe_key text primary key,
  notification_type text not null,
  source text not null,
  task_id uuid not null,
  recipient_user_id uuid,
  created_at timestamptz not null default now()
);

alter table public.user_notification_preferences enable row level security;
alter table public.email_outbox enable row level security;
alter table public.task_notification_email_dedupe enable row level security;

create index if not exists email_outbox_processing_idx
  on public.email_outbox(status, send_after, created_at)
  where status in ('pending', 'sending');

create index if not exists email_outbox_recipient_idx
  on public.email_outbox(to_email, created_at desc);

create index if not exists email_outbox_task_notification_idx
  on public.email_outbox((meta->>'task_notification_id'))
  where meta ? 'task_notification_id';

create index if not exists user_notification_preferences_channel_idx
  on public.user_notification_preferences(preferred_task_channel);

alter table public.task_notification_attempts
  add column if not exists channel text not null default 'sms',
  add column if not exists email_outbox_id uuid,
  add column if not exists to_email text;

alter table public.task_notification_attempts
  drop constraint if exists task_notification_attempts_channel_check;

alter table public.task_notification_attempts
  add constraint task_notification_attempts_channel_check
  check (channel in ('sms', 'email'));

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'task_notification_attempts_email_outbox_fkey'
      and conrelid = 'public.task_notification_attempts'::regclass
  ) then
    alter table public.task_notification_attempts
      add constraint task_notification_attempts_email_outbox_fkey
      foreign key (email_outbox_id) references public.email_outbox(id) on delete set null;
  end if;
end
$$;

create index if not exists task_notification_attempts_email_outbox_idx
  on public.task_notification_attempts(email_outbox_id)
  where email_outbox_id is not null;

drop policy if exists "user_notification_preferences_admin_all" on public.user_notification_preferences;
create policy "user_notification_preferences_admin_all"
on public.user_notification_preferences
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "user_notification_preferences_self_select" on public.user_notification_preferences;
create policy "user_notification_preferences_self_select"
on public.user_notification_preferences
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "email_outbox_admin_select" on public.email_outbox;
create policy "email_outbox_admin_select"
on public.email_outbox
for select
to authenticated
using (public.is_admin());

grant select, insert, update on public.user_notification_preferences to authenticated;
grant select on public.email_outbox to authenticated;
grant select, insert, update, delete on public.user_notification_preferences to service_role;
grant select, insert, update, delete on public.email_outbox to service_role;
grant select, insert, update, delete on public.task_notification_email_dedupe to service_role;

create or replace function public.admin_upsert_user_phone(
  _user_id uuid,
  _phone_e164 text,
  _can_sms boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text := nullif(btrim(coalesce(_phone_e164, '')), '');
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if _user_id is null then
    raise exception 'User id is required';
  end if;

  if v_phone is null then
    delete from public.user_phones where user_id = _user_id;
    return;
  end if;

  if v_phone !~ '^\+\d{7,15}$' then
    raise exception 'Phone must be a valid E.164 number';
  end if;

  insert into public.user_phones (
    user_id,
    phone_e164,
    can_sms,
    verified_at
  )
  values (
    _user_id,
    v_phone,
    coalesce(_can_sms, true),
    null
  )
  on conflict (user_id)
  do update set
    phone_e164 = excluded.phone_e164,
    can_sms = excluded.can_sms,
    verified_at = case
      when user_phones.phone_e164 <> excluded.phone_e164 then null
      else user_phones.verified_at
    end;
end;
$$;

revoke all on function public.admin_upsert_user_phone(uuid, text, boolean) from public, anon;
grant execute on function public.admin_upsert_user_phone(uuid, text, boolean) to authenticated, service_role;

create or replace function public.admin_upsert_user_notification_preferences(
  _user_id uuid,
  _can_email boolean default true,
  _preferred_task_channel text default 'auto',
  _urgent_send_both boolean default false,
  _email_override text default null
)
returns public.user_notification_preferences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_channel text := lower(nullif(btrim(coalesce(_preferred_task_channel, 'auto')), ''));
  v_email text := lower(nullif(btrim(coalesce(_email_override, '')), ''));
  v_row public.user_notification_preferences;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  if _user_id is null then
    raise exception 'User id is required';
  end if;

  if v_channel not in ('auto', 'sms', 'email', 'both', 'dashboard') then
    raise exception 'Invalid notification channel';
  end if;

  if v_email is not null and v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Invalid email override';
  end if;

  insert into public.user_notification_preferences (
    user_id,
    can_email,
    preferred_task_channel,
    urgent_send_both,
    email_override,
    updated_at,
    updated_by
  )
  values (
    _user_id,
    coalesce(_can_email, true),
    v_channel,
    coalesce(_urgent_send_both, false),
    v_email,
    now(),
    auth.uid()
  )
  on conflict (user_id)
  do update set
    can_email = excluded.can_email,
    preferred_task_channel = excluded.preferred_task_channel,
    urgent_send_both = excluded.urgent_send_both,
    email_override = excluded.email_override,
    updated_at = now(),
    updated_by = auth.uid()
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.admin_upsert_user_notification_preferences(uuid, boolean, text, boolean, text) from public, anon;
grant execute on function public.admin_upsert_user_notification_preferences(uuid, boolean, text, boolean, text) to authenticated, service_role;

create or replace function public.task_notification_html_escape(_value text)
returns text
language sql
immutable
as $$
  select replace(
    replace(
      replace(
        replace(
          replace(coalesce(_value, ''), '&', '&amp;'),
          '<', '&lt;'
        ),
        '>', '&gt;'
      ),
      '"', '&quot;'
    ),
    '''', '&#39;'
  )
$$;

create or replace function public.task_notification_app_path(_source text, _task_id uuid)
returns text
language sql
stable
as $$
  select case
    when _source = 'order' then 'pending-orders.html?orderTaskId=' || coalesce(_task_id::text, '') || '#order-task-panel'
    when _source = 'return' then 'ebay-returns.html?returnTaskId=' || coalesce(_task_id::text, '') || '#return-work-queue'
    else 'team-tasks.html?taskId=' || coalesce(_task_id::text, '')
  end
$$;

create or replace function public.get_task_notification_email(
  _user_id uuid,
  _recipient_email text default null
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with pref as (
    select lower(nullif(btrim(email_override), '')) as email_override
    from public.user_notification_preferences
    where user_id = _user_id
  ),
  employee_match as (
    select lower(nullif(btrim(e.email), '')) as employee_email
    from public.employees e
    where (_user_id is not null and e.user_id = _user_id)
       or (_recipient_email is not null and lower(e.email) = lower(_recipient_email))
    order by e.active desc, e.created_at desc
    limit 1
  ),
  candidate as (
    select coalesce(
      (select email_override from pref),
      (select employee_email from employee_match),
      lower(nullif(btrim(_recipient_email), ''))
    ) as email
  )
  select case
    when email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then email
    else null
  end
  from candidate
$$;

create or replace function public.get_task_notification_preference(
  _user_id uuid
)
returns table(can_email boolean, preferred_task_channel text, urgent_send_both boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(p.can_email, true) as can_email,
    coalesce(nullif(p.preferred_task_channel, ''), 'auto') as preferred_task_channel,
    coalesce(p.urgent_send_both, false) as urgent_send_both
  from (select 1) seed
  left join public.user_notification_preferences p on p.user_id = _user_id
$$;

create or replace function public.task_notification_should_email(
  _notification_type text,
  _recipient_user_id uuid,
  _recipient_email text,
  _priority text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pref record;
  v_email text;
  v_sms_phone text;
  v_priority text := lower(coalesce(_priority, ''));
begin
  select * into v_pref
  from public.get_task_notification_preference(_recipient_user_id)
  limit 1;

  if coalesce(v_pref.can_email, true) is not true then
    return false;
  end if;

  v_email := public.get_task_notification_email(_recipient_user_id, _recipient_email);
  if v_email is null then
    return false;
  end if;

  if coalesce(v_pref.preferred_task_channel, 'auto') = 'dashboard' then
    return false;
  end if;

  if coalesce(v_pref.preferred_task_channel, 'auto') in ('email', 'both') then
    return true;
  end if;

  v_sms_phone := public.get_task_notification_sms_phone(_recipient_user_id, _recipient_email);

  if coalesce(v_pref.preferred_task_channel, 'auto') = 'sms' then
    if v_sms_phone is null then
      return true;
    end if;

    return coalesce(v_pref.urgent_send_both, false)
      and (
        v_priority in ('urgent', 'high')
        or _notification_type in ('task_due_today', 'task_overdue_assignee', 'task_overdue_assigner')
      );
  end if;

  if v_sms_phone is null then
    return true;
  end if;

  return coalesce(v_pref.urgent_send_both, false)
    and (
      v_priority in ('urgent', 'high')
      or _notification_type in ('task_due_today', 'task_overdue_assignee', 'task_overdue_assigner')
    );
end;
$$;

create or replace function public.task_notification_should_sms(
  _notification_type text,
  _recipient_user_id uuid,
  _recipient_email text,
  _priority text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_pref record;
  v_email text;
  v_phone text;
  v_priority text := lower(coalesce(_priority, ''));
begin
  v_phone := public.get_task_notification_sms_phone(_recipient_user_id, _recipient_email);
  if v_phone is null then
    return false;
  end if;

  select * into v_pref
  from public.get_task_notification_preference(_recipient_user_id)
  limit 1;

  if coalesce(v_pref.preferred_task_channel, 'auto') = 'dashboard' then
    return false;
  end if;

  if coalesce(v_pref.preferred_task_channel, 'auto') in ('sms', 'both', 'auto') then
    return true;
  end if;

  if coalesce(v_pref.preferred_task_channel, 'auto') = 'email' then
    v_email := public.get_task_notification_email(_recipient_user_id, _recipient_email);
    if v_email is null then
      return true;
    end if;

    return coalesce(v_pref.urgent_send_both, false)
      and (
        v_priority in ('urgent', 'high')
        or _notification_type in ('task_due_today', 'task_overdue_assignee', 'task_overdue_assigner')
      );
  end if;

  return true;
end;
$$;

create or replace function public.enqueue_task_notification_sms()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text;
  v_body text;
  v_sms_id uuid;
  v_dedupe_key text;
  v_claimed boolean := false;
  v_actor_name text;
  v_status text;
  v_should_sms boolean := false;
begin
  if new.notification_type not in (
    'task_assigned',
    'subtask_assigned',
    'shipment_assigned',
    'packaging_assigned',
    'return_task_assigned',
    'task_progress_update',
    'task_completed',
    'task_ready_for_review',
    'task_due_tomorrow',
    'task_due_today',
    'task_overdue_assignee',
    'task_overdue_assigner'
  ) then
    return new;
  end if;

  v_dedupe_key := coalesce(
    nullif(new.metadata->>'dedupe_key', ''),
    public.task_notification_default_dedupe_key(
      new.id,
      new.notification_type,
      new.source,
      new.task_id,
      new.recipient_user_id,
      new.event_id,
      new.due_at
    )
  );

  insert into public.task_notification_dedupe (
    dedupe_key,
    notification_type,
    source,
    task_id,
    recipient_user_id
  )
  values (
    v_dedupe_key,
    new.notification_type,
    new.source,
    new.task_id,
    new.recipient_user_id
  )
  on conflict do nothing
  returning true into v_claimed;

  if coalesce(v_claimed, false) is not true then
    insert into public.task_notification_attempts (
      channel, task_notification_id, dedupe_key, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, status, error_message, metadata
    )
    values (
      'sms', new.id, v_dedupe_key, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, 'duplicate_prevented',
      'Duplicate notification prevented by dedupe key.',
      coalesce(new.metadata, '{}'::jsonb)
    );
    return new;
  end if;

  v_phone := public.get_task_notification_sms_phone(new.recipient_user_id, new.recipient_email);
  if v_phone is null then
    insert into public.task_notification_attempts (
      channel, task_notification_id, dedupe_key, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, status, error_message, metadata
    )
    values (
      'sms', new.id, v_dedupe_key, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, 'skipped',
      'No valid SMS phone number found for recipient.',
      coalesce(new.metadata, '{}'::jsonb)
    );
    return new;
  end if;

  v_should_sms := public.task_notification_should_sms(
    new.notification_type,
    new.recipient_user_id,
    new.recipient_email,
    new.priority
  );

  if v_should_sms is not true then
    insert into public.task_notification_attempts (
      channel, task_notification_id, dedupe_key, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, to_phone, status, error_message, metadata
    )
    values (
      'sms', new.id, v_dedupe_key, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, v_phone, 'skipped',
      'SMS delivery skipped by recipient notification preferences.',
      coalesce(new.metadata, '{}'::jsonb)
    );
    return new;
  end if;

  v_actor_name := coalesce(
    nullif(new.metadata->>'actor_name', ''),
    public.task_notification_display_name(new.actor_user_id, new.actor_email, new.actor_email)
  );
  v_status := coalesce(nullif(new.metadata->>'status', ''), nullif(new.metadata->>'task_status', ''));
  v_body := public.format_task_sms_message(
    new.notification_type,
    new.title,
    new.body,
    v_actor_name,
    new.priority,
    new.due_at,
    v_status,
    new.created_at
  );

  v_sms_id := public.enqueue_sms(
    v_phone,
    v_body,
    now(),
    jsonb_build_object(
      'type', 'task_notification',
      'task_notification_id', new.id,
      'dedupe_key', v_dedupe_key,
      'notification_type', new.notification_type,
      'source', new.source,
      'task_id', new.task_id,
      'recipient_user_id', new.recipient_user_id
    )
  );

  insert into public.task_notification_attempts (
    channel, task_notification_id, sms_outbox_id, dedupe_key, notification_type, source,
    task_id, event_id, recipient_user_id, recipient_email, to_phone, status, metadata
  )
  values (
    'sms', new.id, v_sms_id, v_dedupe_key, new.notification_type, new.source,
    new.task_id, new.event_id, new.recipient_user_id, new.recipient_email,
    v_phone, 'pending', coalesce(new.metadata, '{}'::jsonb)
  );

  return new;
end;
$$;

create or replace function public.format_task_email_subject(
  _notification_type text,
  _title text,
  _priority text default null
)
returns text
language sql
stable
as $$
  select left(regexp_replace(case
    when _notification_type in ('task_assigned', 'subtask_assigned', 'shipment_assigned', 'packaging_assigned', 'return_task_assigned') then
      'New task: ' || public.task_notification_brief_text(_title, 'Task', 120)
    when _notification_type = 'task_progress_update' then
      'Task update: ' || public.task_notification_brief_text(_title, 'Task', 120)
    when _notification_type in ('task_completed', 'task_ready_for_review') then
      'Task ready for review: ' || public.task_notification_brief_text(_title, 'Task', 120)
    when _notification_type = 'task_due_tomorrow' then
      'Task due tomorrow: ' || public.task_notification_brief_text(_title, 'Task', 120)
    when _notification_type = 'task_due_today' then
      'Task due today: ' || public.task_notification_brief_text(_title, 'Task', 120)
    when _notification_type in ('task_overdue_assignee', 'task_overdue_assigner') then
      'Overdue task: ' || public.task_notification_brief_text(_title, 'Task', 120)
    else
      'Task notification: ' || public.task_notification_brief_text(_title, 'Task', 120)
  end || case when lower(coalesce(_priority, '')) = 'urgent' then ' [URGENT]' else '' end, '\s+', ' ', 'g'), 240)
$$;

create or replace function public.format_task_email_text(
  _notification_type text,
  _title text,
  _body text,
  _actor_name text default null,
  _priority text default null,
  _due_at timestamptz default null,
  _status text default null,
  _happened_at timestamptz default now(),
  _source text default 'team',
  _task_id uuid default null
)
returns text
language plpgsql
stable
as $$
declare
  v_title text := public.task_notification_brief_text(_title, 'Task', 180);
  v_body text := public.task_notification_brief_text(_body, 'No note provided', 1200);
  v_actor text := public.task_notification_brief_text(_actor_name, 'Someone', 120);
  v_priority text := public.task_notification_priority_text(_priority);
  v_due text := public.task_notification_due_text(_due_at);
  v_status text := public.task_notification_status_text(_status);
  v_time text := public.task_notification_time_text(_happened_at);
  v_path text := public.task_notification_app_path(_source, _task_id);
begin
  return regexp_replace(
    'OG task notification' || chr(10) || chr(10)
    || 'Task: ' || v_title || chr(10)
    || 'Type: ' || replace(initcap(coalesce(_notification_type, 'task_notification')), '_', ' ') || chr(10)
    || 'Priority: ' || v_priority || chr(10)
    || 'Due: ' || v_due || chr(10)
    || 'Status: ' || v_status || chr(10)
    || 'Actor: ' || v_actor || chr(10)
    || 'When: ' || v_time || chr(10) || chr(10)
    || v_body || chr(10) || chr(10)
    || 'Open task: {{APP_BASE_URL}}/' || v_path,
    '[\t ]+', ' ', 'g'
  );
end;
$$;

create or replace function public.format_task_email_html(
  _notification_type text,
  _title text,
  _body text,
  _actor_name text default null,
  _priority text default null,
  _due_at timestamptz default null,
  _status text default null,
  _happened_at timestamptz default now(),
  _source text default 'team',
  _task_id uuid default null
)
returns text
language plpgsql
stable
as $$
declare
  v_title text := public.task_notification_html_escape(public.task_notification_brief_text(_title, 'Task', 180));
  v_body text := public.task_notification_html_escape(public.task_notification_brief_text(_body, 'No note provided', 1600));
  v_actor text := public.task_notification_html_escape(public.task_notification_brief_text(_actor_name, 'Someone', 120));
  v_priority text := public.task_notification_html_escape(public.task_notification_priority_text(_priority));
  v_due text := public.task_notification_html_escape(public.task_notification_due_text(_due_at));
  v_status text := public.task_notification_html_escape(public.task_notification_status_text(_status));
  v_time text := public.task_notification_html_escape(public.task_notification_time_text(_happened_at));
  v_type text := public.task_notification_html_escape(replace(initcap(coalesce(_notification_type, 'task_notification')), '_', ' '));
  v_path text := public.task_notification_html_escape(public.task_notification_app_path(_source, _task_id));
begin
  return
    '<!doctype html><html><body style="margin:0;background:#08090b;color:#f6f1e8;font-family:Arial,Helvetica,sans-serif;">'
    || '<div style="max-width:680px;margin:0 auto;padding:28px;">'
    || '<div style="border:1px solid #4b3b1f;border-radius:18px;background:#151619;padding:24px;">'
    || '<p style="margin:0 0 8px;color:#f3cf7a;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;">OG task notification</p>'
    || '<h1 style="margin:0 0 14px;font-size:26px;line-height:1.2;color:#fff;">' || v_title || '</h1>'
    || '<p style="margin:0 0 18px;color:#d7d2c9;font-size:16px;line-height:1.55;">' || replace(v_body, chr(10), '<br>') || '</p>'
    || '<table style="width:100%;border-collapse:collapse;margin:0 0 20px;">'
    || '<tr><td style="padding:8px 0;color:#9ea3aa;">Type</td><td style="padding:8px 0;text-align:right;color:#fff;font-weight:700;">' || v_type || '</td></tr>'
    || '<tr><td style="padding:8px 0;color:#9ea3aa;">Priority</td><td style="padding:8px 0;text-align:right;color:#fff;font-weight:700;">' || v_priority || '</td></tr>'
    || '<tr><td style="padding:8px 0;color:#9ea3aa;">Due</td><td style="padding:8px 0;text-align:right;color:#fff;font-weight:700;">' || v_due || '</td></tr>'
    || '<tr><td style="padding:8px 0;color:#9ea3aa;">Status</td><td style="padding:8px 0;text-align:right;color:#fff;font-weight:700;">' || v_status || '</td></tr>'
    || '<tr><td style="padding:8px 0;color:#9ea3aa;">Actor</td><td style="padding:8px 0;text-align:right;color:#fff;font-weight:700;">' || v_actor || '</td></tr>'
    || '<tr><td style="padding:8px 0;color:#9ea3aa;">When</td><td style="padding:8px 0;text-align:right;color:#fff;font-weight:700;">' || v_time || '</td></tr>'
    || '</table>'
    || '<a href="{{APP_BASE_URL}}/' || v_path || '" style="display:inline-block;background:#f1c96b;color:#17130a;text-decoration:none;font-weight:800;border-radius:999px;padding:13px 18px;">Open task</a>'
    || '</div></div></body></html>';
end;
$$;

create or replace function public.enqueue_email(
  _to_email text,
  _subject text,
  _text_body text,
  _html_body text default null,
  _send_after timestamptz default now(),
  _meta jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.email_outbox (to_email, subject, text_body, html_body, send_after, meta)
  values (
    lower(nullif(btrim(coalesce(_to_email, '')), '')),
    nullif(btrim(coalesce(_subject, '')), ''),
    nullif(btrim(coalesce(_text_body, '')), ''),
    nullif(btrim(coalesce(_html_body, '')), ''),
    coalesce(_send_after, now()),
    coalesce(_meta, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.email_outbox_claim(_batch integer default 25)
returns setof public.email_outbox
language sql
security definer
set search_path = public, pg_temp
as $$
  with picked as (
    select id
    from public.email_outbox
    where (
        status = 'pending'
        and send_after <= now()
      )
      or (
        status = 'sending'
        and updated_at < now() - interval '15 minutes'
      )
    order by created_at asc
    limit greatest(1, least(coalesce(_batch, 25), 100))
    for update skip locked
  )
  update public.email_outbox o
  set status = 'sending',
      attempts = o.attempts + 1,
      updated_at = now()
  from picked
  where o.id = picked.id
  returning o.*;
$$;

create or replace function public.task_notification_email_dedupe_key(
  _notification_id uuid,
  _notification_type text,
  _source text,
  _task_id uuid,
  _recipient_user_id uuid,
  _event_id uuid,
  _due_at timestamptz default null
)
returns text
language sql
stable
as $$
  select 'task_email:' || public.task_notification_default_dedupe_key(
    _notification_id,
    _notification_type,
    _source,
    _task_id,
    _recipient_user_id,
    _event_id,
    _due_at
  )
$$;

create or replace function public.enqueue_task_notification_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_subject text;
  v_text_body text;
  v_html_body text;
  v_email_id uuid;
  v_dedupe_key text;
  v_claimed boolean := false;
  v_actor_name text;
  v_status text;
  v_should_email boolean := false;
begin
  if new.notification_type not in (
    'task_assigned',
    'subtask_assigned',
    'shipment_assigned',
    'packaging_assigned',
    'return_task_assigned',
    'task_progress_update',
    'task_completed',
    'task_ready_for_review',
    'task_due_tomorrow',
    'task_due_today',
    'task_overdue_assignee',
    'task_overdue_assigner'
  ) then
    return new;
  end if;

  v_email := public.get_task_notification_email(new.recipient_user_id, new.recipient_email);

  if v_email is null then
    insert into public.task_notification_attempts (
      channel, task_notification_id, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, status, error_message, metadata
    )
    values (
      'email', new.id, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, 'skipped',
      'No valid email address found for recipient.',
      coalesce(new.metadata, '{}'::jsonb)
    );
    return new;
  end if;

  v_should_email := public.task_notification_should_email(
    new.notification_type,
    new.recipient_user_id,
    new.recipient_email,
    new.priority
  );

  if v_should_email is not true then
    insert into public.task_notification_attempts (
      channel, task_notification_id, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, to_email, status, error_message, metadata
    )
    values (
      'email', new.id, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, v_email, 'skipped',
      'Email delivery skipped by recipient notification preferences.',
      coalesce(new.metadata, '{}'::jsonb)
    );
    return new;
  end if;

  v_dedupe_key := coalesce(
    'task_email:' || nullif(new.metadata->>'dedupe_key', ''),
    public.task_notification_email_dedupe_key(
      new.id,
      new.notification_type,
      new.source,
      new.task_id,
      new.recipient_user_id,
      new.event_id,
      new.due_at
    )
  );

  insert into public.task_notification_email_dedupe (
    dedupe_key,
    notification_type,
    source,
    task_id,
    recipient_user_id
  )
  values (
    v_dedupe_key,
    new.notification_type,
    new.source,
    new.task_id,
    new.recipient_user_id
  )
  on conflict do nothing
  returning true into v_claimed;

  if coalesce(v_claimed, false) is not true then
    insert into public.task_notification_attempts (
      channel, task_notification_id, dedupe_key, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, to_email, status, error_message, metadata
    )
    values (
      'email', new.id, v_dedupe_key, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, v_email, 'duplicate_prevented',
      'Duplicate email notification prevented by dedupe key.',
      coalesce(new.metadata, '{}'::jsonb)
    );
    return new;
  end if;

  v_actor_name := coalesce(
    nullif(new.metadata->>'actor_name', ''),
    public.task_notification_display_name(new.actor_user_id, new.actor_email, new.actor_email)
  );
  v_status := coalesce(nullif(new.metadata->>'status', ''), nullif(new.metadata->>'task_status', ''));
  v_subject := public.format_task_email_subject(new.notification_type, new.title, new.priority);
  v_text_body := public.format_task_email_text(
    new.notification_type, new.title, new.body, v_actor_name, new.priority,
    new.due_at, v_status, new.created_at, new.source, new.task_id
  );
  v_html_body := public.format_task_email_html(
    new.notification_type, new.title, new.body, v_actor_name, new.priority,
    new.due_at, v_status, new.created_at, new.source, new.task_id
  );

  v_email_id := public.enqueue_email(
    v_email,
    v_subject,
    v_text_body,
    v_html_body,
    now(),
    jsonb_build_object(
      'type', 'task_notification',
      'channel', 'email',
      'task_notification_id', new.id,
      'dedupe_key', v_dedupe_key,
      'notification_type', new.notification_type,
      'source', new.source,
      'task_id', new.task_id,
      'recipient_user_id', new.recipient_user_id,
      'app_path', public.task_notification_app_path(new.source, new.task_id)
    )
  );

  insert into public.task_notification_attempts (
    channel, task_notification_id, email_outbox_id, dedupe_key, notification_type, source,
    task_id, event_id, recipient_user_id, recipient_email, to_email, status, metadata
  )
  values (
    'email', new.id, v_email_id, v_dedupe_key, new.notification_type, new.source,
    new.task_id, new.event_id, new.recipient_user_id, new.recipient_email,
    v_email, 'pending', coalesce(new.metadata, '{}'::jsonb)
  );

  return new;
end;
$$;

drop trigger if exists trg_enqueue_task_notification_email on public.task_notifications;
create trigger trg_enqueue_task_notification_email
after insert on public.task_notifications
for each row
execute function public.enqueue_task_notification_email();

create or replace function public.sync_task_notification_attempt_from_email_outbox()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.task_notification_attempts
  set status = case
        when new.status = 'sent' then 'sent'
        when new.status = 'failed' then 'failed'
        when new.status = 'cancelled' then 'failed'
        else 'pending'
      end,
      error_message = new.last_error,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'email_status', new.status,
        'email_attempts', new.attempts,
        'email_updated_at', now(),
        'provider_message_id', new.provider_message_id
      )
  where email_outbox_id = new.id
    and channel = 'email';

  return new;
end;
$$;

drop trigger if exists trg_sync_task_notification_attempt_from_email_outbox on public.email_outbox;
create trigger trg_sync_task_notification_attempt_from_email_outbox
after update of status, last_error, provider_message_id on public.email_outbox
for each row
execute function public.sync_task_notification_attempt_from_email_outbox();

grant execute on function public.get_task_notification_email(uuid, text) to authenticated, service_role;
grant execute on function public.get_task_notification_preference(uuid) to authenticated, service_role;
grant execute on function public.task_notification_should_sms(text, uuid, text, text) to authenticated, service_role;
grant execute on function public.task_notification_should_email(text, uuid, text, text) to authenticated, service_role;
grant execute on function public.enqueue_email(text, text, text, text, timestamptz, jsonb) to service_role;
grant execute on function public.email_outbox_claim(integer) to service_role;
grant execute on function public.format_task_email_subject(text, text, text) to authenticated, service_role;
grant execute on function public.format_task_email_text(text, text, text, text, text, timestamptz, text, timestamptz, text, uuid) to authenticated, service_role;
grant execute on function public.format_task_email_html(text, text, text, text, text, timestamptz, text, timestamptz, text, uuid) to authenticated, service_role;

comment on table public.email_outbox
  is 'Provider-neutral outbound email queue. Task notifications currently enqueue Resend-compatible messages here.';

comment on table public.user_notification_preferences
  is 'Per-user task notification delivery preferences. Auto sends email when SMS cannot be used.';
