begin;
set local lock_timeout='1s';
set local statement_timeout='15s';
create function public.set_live_sale_session_draft(_session_id uuid,_saved boolean)
returns public.live_sale_sessions language plpgsql security definer set search_path='' as $$
declare s public.live_sale_sessions;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if _saved is null then raise exception 'Choose save or resume' using errcode='22023';end if;
 select * into s from public.live_sale_sessions where id=_session_id for update;
 if not found or s.status<>'active' then raise exception 'This show is already closed or unavailable' using errcode='22023';end if;
 if (s.saved_for_later_at is not null)=_saved then return s;end if;
 update public.live_sale_sessions
 set saved_for_later_at=case when _saved then clock_timestamp() end,
     saved_for_later_by=case when _saved then auth.uid() end
 where id=s.id returning * into s;
 insert into public.live_sale_events(session_id,event_type,actor_email,payload)
 values(s.id,case when _saved then 'session_saved_for_later' else 'session_resumed' end,
 (select email from auth.users where id=auth.uid()),jsonb_build_object('saved_for_later_at',s.saved_for_later_at));
 return s;
end $$;
revoke all on function public.set_live_sale_session_draft(uuid,boolean) from public,anon,authenticated;
grant execute on function public.set_live_sale_session_draft(uuid,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
