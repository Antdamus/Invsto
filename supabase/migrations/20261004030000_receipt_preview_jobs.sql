-- The original and its audit entry are durable before optional previews finish.
-- Pending work lives on that entry, so closing a tab cannot lose the retry.
create index if not exists receipt_preview_jobs_idx
  on public.ebay_order_task_events(signed_by, created_at)
  where photo_attachments @> '[{"metadata":{"receipt_previews_pending":true}}]'::jsonb;

create function public.list_pending_receipt_previews()
returns setof jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not public.can_manage_inventory() then raise exception 'Staff required' using errcode='42501'; end if;
  return query
  select jsonb_build_object('task_id',e.task_id,'photo',p.photo)
  from public.ebay_order_task_events e
  cross join lateral jsonb_array_elements(e.photo_attachments) p(photo)
  where e.signed_by=auth.uid()
    and e.photo_attachments @> '[{"metadata":{"receipt_previews_pending":true}}]'::jsonb
    and p.photo #>> '{metadata,receipt_previews_pending}'='true'
    and p.photo->>'bucket'='order-evidence-photos'
    and p.photo->>'path' like 'video-receipts/%.png'
  order by e.created_at limit 10;
end $$;

create function public.finish_receipt_previews(_task_id uuid, _path text, _derivatives jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare e public.ebay_order_task_events; next_photos jsonb;
  preview text:=regexp_replace(_path,'/([^/]+)\.png$','/derivatives/\1-preview.jpg');
  thumbnail text:=regexp_replace(_path,'/([^/]+)\.png$','/derivatives/\1-thumb.jpg');
begin
  if not public.can_manage_inventory() then raise exception 'Staff required' using errcode='42501'; end if;
  if _path is null or _path not like 'video-receipts/%.png'
    or (_derivatives->>'preview_path') is distinct from preview
    or (_derivatives->>'thumbnail_path') is distinct from thumbnail
    or (_derivatives->>'preview_bucket') is distinct from 'order-evidence-photos'
    or (_derivatives->>'thumbnail_bucket') is distinct from 'order-evidence-photos' then
    raise exception 'Invalid receipt preview references' using errcode='22023';
  end if;
  select * into e from public.ebay_order_task_events
    where task_id=_task_id and photo_attachments @> jsonb_build_array(jsonb_build_object(
      'bucket','order-evidence-photos','path',_path))
    limit 1 for update;
  if not found then return false; end if; -- Removed: never resurrect it.
  if not e.photo_attachments @> jsonb_build_array(jsonb_build_object('path',_path,
    'metadata',jsonb_build_object('receipt_previews_pending',true))) then return true; end if;
  if not exists(select 1 from storage.objects where bucket_id='order-evidence-photos' and name=preview)
    or not exists(select 1 from storage.objects where bucket_id='order-evidence-photos' and name=thumbnail) then
    raise exception 'Receipt previews have not finished uploading' using errcode='22023';
  end if;
  select jsonb_agg(case when p->>'path'=_path and p->>'bucket'='order-evidence-photos' then
    jsonb_set(p || jsonb_build_object('preview_bucket','order-evidence-photos','preview_path',preview,
      'thumbnail_bucket','order-evidence-photos','thumbnail_path',thumbnail),
      '{metadata}',coalesce(p->'metadata','{}') || '{"receipt_previews_pending":false}'::jsonb)
    else p end order by n) into next_photos
    from jsonb_array_elements(e.photo_attachments) with ordinality a(p,n);
  update public.ebay_order_task_events set photo_attachments=next_photos where id=e.id;
  return true;
end $$;
revoke all on function public.list_pending_receipt_previews() from public,anon;
revoke all on function public.finish_receipt_previews(uuid,text,jsonb) from public,anon;
grant execute on function public.list_pending_receipt_previews() to authenticated;
grant execute on function public.finish_receipt_previews(uuid,text,jsonb) to authenticated;
