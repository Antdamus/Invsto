begin;
set local statement_timeout = '20s';
set local timezone = 'UTC';
do $$
declare
  actor uuid := (select user_id from public.employees where active is distinct from false and role='admin' limit 1);
  show_id uuid; bag_id uuid; order_id uuid; line_id uuid; old_line uuid;
  auction text := 'DATE-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
  payload jsonb; row record; order_date timestamptz; expected_start timestamptz; expected_end timestamptz;
begin
  assert actor is not null;
  perform set_config('request.jwt.claim.sub', actor::text, true);
  -- The bag is made five days before the show, and closes two days after it.
  insert into public.live_sale_sessions(title,started_at)
    values('__bag_date_range_test', now()-interval '5 days') returning id into show_id;
  insert into public.live_sale_lots(session_id,auction_number,created_at,closed_at)
    values(show_id,auction,now()-interval '10 days',now()-interval '3 days') returning id into bag_id;
  expected_start := now()-interval '17 days';
  expected_end := now()+interval '27 days';
  for row in select * from (values
    ('lower boundary', -17, true), ('upper boundary', 27, true),
    ('order after bag and show', 20, true), ('previous week', -15, true),
    ('too early', -18, false), ('too late', 28, false)
  ) cases(label, days, expected) loop
    order_date := now()+make_interval(days=>row.days);
    insert into public.ebay_orders(order_number,buyer_username,sale_date)
      values('__bag_date_'||gen_random_uuid(),auction,order_date) returning id into order_id;
    insert into public.ebay_order_lines(order_id,item_title,sold_for)
      values(order_id,'#'||auction||' - range fixture',50) returning id into line_id;
    payload := public.get_live_bag_order_matches(bag_id);
    assert (payload->>'date_window_start')::timestamptz=expected_start;
    assert (payload->>'date_window_end')::timestamptz=expected_end;
    assert exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}'=line_id::text)=row.expected,
      'Date range failed: '||row.label;
    if row.label='too early' then old_line:=line_id; end if;
  end loop;
  -- A missing sale date uses paid/imported timestamps, without requiring the same day.
  update public.ebay_orders set sale_date=null,paid_on_date=now()+interval '12 days' where id=order_id;
  payload:=public.get_live_bag_order_matches(bag_id);
  assert exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}'=line_id::text), 'Paid date fallback';
  update public.ebay_orders set paid_on_date=null,imported_at=now()+interval '14 days' where id=order_id;
  payload:=public.get_live_bag_order_matches(bag_id);
  assert exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}'=line_id::text), 'Import date fallback';
  -- Different calendar dates/time zones are compared as instants within the range.
  update public.ebay_orders set sale_date=now()+interval '1 day 23 hours' where id=order_id;
  payload:=public.get_live_bag_order_matches(bag_id);
  assert exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}'=line_id::text), 'Cross-midnight order';
  payload:=public.get_live_bag_order_matches(bag_id,auction);
  assert exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}'=old_line::text), 'Manual search has no date cutoff';
  perform public.set_live_bag_order_link(bag_id,old_line,null);
  payload:=public.get_live_bag_order_matches(bag_id);
  assert payload#>>'{matches,0,line,id}'=old_line::text and (payload#>>'{matches,0,linked}')::boolean, 'Saved links have no date cutoff';
  raise notice 'ok bag date ranges: early bags, delayed orders, inclusive boundaries, fallback dates, midnight, unrestricted search and saved links';
end $$;
rollback;
