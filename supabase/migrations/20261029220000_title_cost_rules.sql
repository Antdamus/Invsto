-- Shared title-based estimates for live reports. Inventory costs are not rewritten.
begin;
alter table public.material_cost_settings
 add column title_cost_rules jsonb not null default '[]',
 add column title_rules_updated_at timestamptz,
 add column title_rules_updated_by uuid references auth.users(id);

create table public.title_cost_rule_events (
 id uuid primary key default gen_random_uuid(),
 actor uuid not null references auth.users(id),
 created_at timestamptz not null default clock_timestamp(),
 old_rules jsonb not null, new_rules jsonb not null
);
alter table public.title_cost_rule_events enable row level security;
revoke all on public.title_cost_rule_events from public,anon,authenticated;

create function public.save_title_cost_rules(_rules jsonb,_expected_updated_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare settings public.material_cost_settings; rule jsonb; phrase text; normalized text;
 seen text[]:='{}'; clean jsonb:='[]'; amount numeric;
begin
 if auth.uid() is null or not public.can_manage_inventory() or not public.is_admin() then
   raise exception 'An administrator must update shared title cost rules' using errcode='42501';
 end if;
 if _rules is null or jsonb_typeof(_rules)<>'array' then raise exception 'Enter a list of title cost rules';end if;
 if jsonb_array_length(_rules)>100 then raise exception 'Use at most 100 title cost rules';end if;
 for rule in select value from jsonb_array_elements(_rules) loop
   if jsonb_typeof(rule)<>'object' or jsonb_typeof(rule->'phrase') is distinct from 'string'
     or jsonb_typeof(rule->'base_cost') is distinct from 'number'
     or jsonb_typeof(rule->'enabled') is distinct from 'boolean' then
     raise exception 'Each rule needs a phrase, numeric base cost and enabled state';
   end if;
   phrase:=btrim(regexp_replace(rule->>'phrase','[[:space:]]+',' ','g'));
   normalized:=lower(phrase);
   if length(phrase)<2 or length(phrase)>120 then raise exception 'Use a phrase between 2 and 120 characters';end if;
   if normalized=any(seen) then raise exception 'Each title phrase must be unique, ignoring case and extra spaces';end if;
   seen:=array_append(seen,normalized);
   amount:=(rule->>'base_cost')::numeric;
   if amount<0 or amount>9999999999.99 or amount<>round(amount,2) then
     raise exception 'Use a base cost from zero to 9,999,999,999.99 with at most two decimals';
   end if;
   clean:=clean||jsonb_build_array(jsonb_build_object('phrase',phrase,'base_cost',amount,'enabled',rule->'enabled'));
 end loop;
 select * into settings from public.material_cost_settings where singleton for update;
 if settings.title_rules_updated_at is distinct from _expected_updated_at then
   raise exception 'Title rules changed on another device. Reload rules and review before saving.' using errcode='40001';
 end if;
 update public.material_cost_settings set title_cost_rules=clean,title_rules_updated_at=clock_timestamp(),title_rules_updated_by=auth.uid() where singleton;
 insert into public.title_cost_rule_events(actor,old_rules,new_rules) values(auth.uid(),settings.title_cost_rules,clean);
 return public.get_material_cost_settings();
end $$;
revoke all on function public.save_title_cost_rules(jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.save_title_cost_rules(jsonb,timestamptz) to authenticated;
commit;
