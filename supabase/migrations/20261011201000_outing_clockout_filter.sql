begin;
alter table public.work_outings add column shift_ended_offsite boolean not null default false;
create function public.stamp_outing_clockout() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if new.action='finish' or (new.action='resolve' and coalesce((new.details->>'finish_shift')::boolean,false)) then
   update public.work_outings set shift_ended_offsite=true where id=new.outing_id;
 end if;
 return new;
end; $$;
create trigger work_outing_events_clockout after insert on public.work_outing_events for each row execute function public.stamp_outing_clockout();
update public.work_outings w set shift_ended_offsite=true where exists(select 1 from public.work_outing_events e where e.outing_id=w.id
 and (e.action='finish' or (e.action='resolve' and coalesce((e.details->>'finish_shift')::boolean,false))));
notify pgrst,'reload schema';
commit;
