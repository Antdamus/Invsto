begin;
set local lock_timeout='5s';

-- Derive only an additional aggregate from the already saved Studio evidence.
-- Missing or unrecognized values remain null. No hourly audience curve is inferred.
with observed as (
 select k.event_id,regexp_match(m->>'value','^([0-9]+)m ([0-9]{2})s$') parts
 from public.weekly_ebay_show_catalog k
 cross join lateral jsonb_array_elements(coalesce(k.insights->'metrics','[]'::jsonb)) m
 where upper(m->>'name')='AVG VIEWING TIME'
), parsed as (
 select event_id,max(parts[1]::integer*60+parts[2]::integer) seconds
 from observed where parts is not null and parts[2]::integer<60 group by event_id
)
update public.weekly_ebay_show_catalog k
set insights=jsonb_set(k.insights,'{average_viewing_seconds}',to_jsonb(p.seconds))
from parsed p where p.event_id=k.event_id
 and (k.insights->>'average_viewing_seconds') is distinct from p.seconds::text;

notify pgrst,'reload schema';
commit;
