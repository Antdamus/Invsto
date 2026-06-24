-- New migration on purpose: deployed Supabase databases do not replay edited old files.
-- Adds admin/service helpers for one-time evidence image derivative backfills.

create or replace function public.list_order_evidence_derivative_backfill_candidates(
  _limit integer default 50
)
returns table (
  event_id uuid,
  task_id uuid,
  order_id uuid,
  photo_index integer,
  bucket text,
  path text,
  label text,
  mime_type text,
  preview_path text,
  thumbnail_path text,
  photo jsonb,
  event_created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' and not public.is_admin() then
    raise exception 'admin_required' using errcode = 'P0001';
  end if;

  return query
  select
    e.id as event_id,
    e.task_id,
    e.order_id,
    (p.ordinality - 1)::integer as photo_index,
    refs.bucket,
    refs.path,
    coalesce(p.photo->>'label', '') as label,
    coalesce(p.photo->>'mime_type', '') as mime_type,
    coalesce(nullif(p.photo->>'preview_path', ''), nullif(p.photo #>> '{variants,preview,path}', '')) as preview_path,
    coalesce(
      nullif(p.photo->>'thumbnail_path', ''),
      nullif(p.photo #>> '{variants,thumbnail,path}', ''),
      nullif(p.photo #>> '{variants,thumb,path}', '')
    ) as thumbnail_path,
    p.photo,
    e.created_at as event_created_at
  from public.ebay_order_task_events e
  cross join lateral jsonb_array_elements(coalesce(e.photo_attachments, '[]'::jsonb)) with ordinality as p(photo, ordinality)
  cross join lateral (
    select
      coalesce(nullif(p.photo->>'bucket', ''), nullif(p.photo->>'storage_bucket', ''), 'order-evidence-photos') as bucket,
      coalesce(nullif(p.photo->>'path', ''), nullif(p.photo->>'storage_path', '')) as path
  ) refs
  where refs.bucket = 'order-evidence-photos'
    and refs.path <> ''
    and refs.path not like '%/derivatives/%'
    and (
      coalesce(p.photo->>'mime_type', '') ilike 'image/%'
      or refs.path ~* '\.(png|jpe?g|webp)$'
    )
    and (
      coalesce(nullif(p.photo->>'preview_path', ''), nullif(p.photo #>> '{variants,preview,path}', '')) is null
      or coalesce(
        nullif(p.photo->>'thumbnail_path', ''),
        nullif(p.photo #>> '{variants,thumbnail,path}', ''),
        nullif(p.photo #>> '{variants,thumb,path}', '')
      ) is null
    )
  order by e.created_at desc, e.id, p.ordinality
  limit greatest(1, least(coalesce(_limit, 50), 500));
end;
$$;

create or replace function public.apply_order_evidence_derivative_backfill(
  _event_id uuid,
  _bucket text,
  _path text,
  _preview_bucket text default 'order-evidence-photos',
  _preview_path text default null,
  _preview_meta jsonb default '{}'::jsonb,
  _thumbnail_bucket text default 'order-evidence-photos',
  _thumbnail_path text default null,
  _thumbnail_meta jsonb default '{}'::jsonb,
  _signed_by_email text default null
)
returns table (
  updated boolean,
  updated_photo_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.ebay_order_task_events%rowtype;
  v_photo jsonb;
  v_next jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_bucket text := coalesce(nullif(_bucket, ''), 'order-evidence-photos');
  v_preview_bucket text := coalesce(nullif(_preview_bucket, ''), v_bucket);
  v_thumbnail_bucket text := coalesce(nullif(_thumbnail_bucket, ''), v_bucket);
  v_preview_path text := nullif(_preview_path, '');
  v_thumbnail_path text := nullif(_thumbnail_path, '');
  v_variants jsonb;
begin
  if auth.role() <> 'service_role' and not public.is_admin() then
    raise exception 'admin_required' using errcode = 'P0001';
  end if;

  if _event_id is null or nullif(_path, '') is null then
    raise exception 'missing_event_or_path' using errcode = 'P0001';
  end if;

  select *
  into v_event
  from public.ebay_order_task_events
  where id = _event_id
  for update;

  if not found then
    return query select false, 0;
    return;
  end if;

  for v_photo in
    select value
    from jsonb_array_elements(coalesce(v_event.photo_attachments, '[]'::jsonb)) as entry(value)
  loop
    if coalesce(nullif(v_photo->>'bucket', ''), nullif(v_photo->>'storage_bucket', ''), 'order-evidence-photos') = v_bucket
       and coalesce(nullif(v_photo->>'path', ''), nullif(v_photo->>'storage_path', '')) = _path then
      v_count := v_count + 1;

      v_variants := coalesce(v_photo->'variants', '{}'::jsonb)
        || jsonb_build_object(
          'original',
          jsonb_strip_nulls(jsonb_build_object(
            'bucket', v_bucket,
            'path', _path,
            'mime_type', nullif(v_photo->>'mime_type', ''),
            'size_bytes', case
              when coalesce(v_photo->>'size_bytes', '') ~ '^\d+$' then (v_photo->>'size_bytes')::bigint
              else null
            end
          ))
        );

      if v_preview_path is not null then
        v_photo := v_photo || jsonb_build_object(
          'preview_bucket', v_preview_bucket,
          'preview_path', v_preview_path
        );
        v_variants := v_variants || jsonb_build_object(
          'preview',
          coalesce(_preview_meta, '{}'::jsonb) || jsonb_build_object(
            'bucket', v_preview_bucket,
            'path', v_preview_path
          )
        );
      end if;

      if v_thumbnail_path is not null then
        v_photo := v_photo || jsonb_build_object(
          'thumbnail_bucket', v_thumbnail_bucket,
          'thumbnail_path', v_thumbnail_path
        );
        v_variants := v_variants || jsonb_build_object(
          'thumbnail',
          coalesce(_thumbnail_meta, '{}'::jsonb) || jsonb_build_object(
            'bucket', v_thumbnail_bucket,
            'path', v_thumbnail_path
          )
        );
      end if;

      v_photo := jsonb_set(v_photo, '{variants}', v_variants, true);
      v_photo := jsonb_set(
        v_photo,
        '{metadata}',
        coalesce(v_photo->'metadata', '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
          'derivative_backfilled_at', now(),
          'derivative_backfilled_by', nullif(_signed_by_email, '')
        )),
        true
      );
    end if;

    v_next := v_next || jsonb_build_array(v_photo);
  end loop;

  if v_count > 0 then
    update public.ebay_order_task_events
    set
      photo_attachments = v_next,
      payload = coalesce(payload, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
        'evidence_derivatives_backfilled_at', now(),
        'evidence_derivatives_backfilled_by', nullif(_signed_by_email, '')
      ))
    where id = _event_id;
  end if;

  return query select v_count > 0, v_count;
end;
$$;

revoke all on function public.list_order_evidence_derivative_backfill_candidates(integer) from public;
grant execute on function public.list_order_evidence_derivative_backfill_candidates(integer) to authenticated, service_role;

revoke all on function public.apply_order_evidence_derivative_backfill(uuid, text, text, text, text, jsonb, text, text, jsonb, text) from public;
grant execute on function public.apply_order_evidence_derivative_backfill(uuid, text, text, text, text, jsonb, text, text, jsonb, text) to authenticated, service_role;
