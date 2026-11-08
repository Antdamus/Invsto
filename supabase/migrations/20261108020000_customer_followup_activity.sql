begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Reuse the access, revision, photo, task-completion and retry checks for the conversation.
create function public.record_customer_followup_activity(
 _id uuid, _revision integer, _request_id uuid, _action text, _note text, _photos jsonb default '[]'
) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.customer_followups; details jsonb; result jsonb; note text:=btrim(coalesce(_note,''));
begin
 if not public.can_access_customer_followups() then raise exception 'Active staff access required' using errcode='42501'; end if;
 if _action is null or _action not in ('update','done','reopen') then raise exception 'Choose Update, Done or Reopen'; end if;
 if _action in ('done','reopen') and note='' then raise exception 'Write what happened before marking Done or reopening this record'; end if;
 select * into r from public.customer_followups where id=_id for update;
 if not found then raise exception 'Follow-up not found'; end if;
 details:=jsonb_build_object('activity_action',_action,'note',note,'photos',coalesce(_photos,'[]'));
 if _action='done' then details:=details||jsonb_build_object('status','closed'); end if;
 if _action='done' and r.kind='manual_return' then details:=details||jsonb_build_object('return_stage','resolved'); end if;
 if _action='reopen' then details:=details||jsonb_build_object('status','open'); end if;
 -- A lost response can be retried after Done moved the record to History.
 if not exists(select 1 from public.customer_followup_events where followup_id=_id and created_by=auth.uid() and request_id=_request_id) then
  if _action='done' and r.status in ('closed','cancelled') then raise exception 'This record is already in History. Refresh to see the outcome.'; end if;
  if _action='reopen' and r.status not in ('closed','cancelled') then raise exception 'This record is already active. Refresh before reopening it.'; end if;
 end if;
 result:=public.update_customer_followup(_id,_revision,_request_id,details);
 update public.customer_followup_events set action=case _action when 'update' then 'note_added' when 'done' then 'done' else 'reopened' end
 where followup_id=_id and created_by=auth.uid() and request_id=_request_id;
 return result;
end $$;
revoke all on function public.record_customer_followup_activity(uuid,integer,uuid,text,text,jsonb) from public,anon;
grant execute on function public.record_customer_followup_activity(uuid,integer,uuid,text,text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
