-- Step 5F.6P.5 operator-created eBay chat tags in server mailbox filters.
-- The UI stores manual/custom chat tags in operator_override_payload because
-- the classifier topic_tags column intentionally allows only AI taxonomy tags.
-- Make the canonical mailbox RPC filter/search/count against the effective
-- operator state so filters like tag:possible_sale find the full mailbox.

do $migration$
declare
  v_signature regprocedure := 'public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb)'::regprocedure;
  v_sql text;
  v_next text;
begin
  v_sql := pg_get_functiondef(v_signature);

  if position('classification_effective' in v_sql) = 0 then
    v_next := v_sql;

    v_next := replace(
      v_next,
      '      cc.priority,',
      '      classification_effective.priority,'
    );
    v_next := replace(
      v_next,
      '      cc.response_need,',
      '      classification_effective.response_need,'
    );
    v_next := replace(
      v_next,
      '      coalesce(cc.topic_tags, ''{}''::text[]) as topic_tags,',
      '      classification_effective.topic_tags,'
    );
    v_next := replace(
      v_next,
      '      coalesce(cc.buyer_flags, ''{}''::text[]) as buyer_flags,',
      '      classification_effective.buyer_flags,'
    );
    v_next := replace(
      v_next,
      '      coalesce(cc.risk_flags, ''{}''::text[]) as risk_flags,',
      '      classification_effective.risk_flags,'
    );
    v_next := replace(
      v_next,
      '        cc.priority,',
      '        classification_effective.priority,'
    );
    v_next := replace(
      v_next,
      '        cc.response_need,',
      '        classification_effective.response_need,'
    );
    v_next := replace(
      v_next,
      '        array_to_string(coalesce(cc.topic_tags, ''{}''::text[]), '' ''),',
      '        array_to_string(classification_effective.topic_tags, '' ''),'
    );
    v_next := replace(
      v_next,
      '        array_to_string(coalesce(cc.buyer_flags, ''{}''::text[]), '' ''),',
      '        array_to_string(classification_effective.buyer_flags, '' ''),'
    );
    v_next := replace(
      v_next,
      '        array_to_string(coalesce(cc.risk_flags, ''{}''::text[]), '' ''),',
      '        array_to_string(classification_effective.risk_flags, '' ''),'
    );

    v_next := replace(
      v_next,
      '      and cc.is_current = true',
      $new$
      and cc.is_current = true
    left join lateral (
      select
        coalesce(nullif(btrim(coalesce(cc.operator_override_payload, '{}'::jsonb) ->> 'priority'), ''), cc.priority) as priority,
        coalesce(nullif(btrim(coalesce(cc.operator_override_payload, '{}'::jsonb) ->> 'response_need'), ''), cc.response_need) as response_need,
        case
          when jsonb_typeof(coalesce(cc.operator_override_payload, '{}'::jsonb) -> 'topic_tags') = 'array' then coalesce((
            select array_agg(distinct lower(btrim(item.value)) order by lower(btrim(item.value)))
            from jsonb_array_elements_text(coalesce(cc.operator_override_payload, '{}'::jsonb) -> 'topic_tags') as item(value)
            where btrim(item.value) <> ''
          ), '{}'::text[])
          else coalesce(cc.topic_tags, '{}'::text[])
        end as topic_tags,
        case
          when jsonb_typeof(coalesce(cc.operator_override_payload, '{}'::jsonb) -> 'buyer_flags') = 'array' then coalesce((
            select array_agg(distinct lower(btrim(item.value)) order by lower(btrim(item.value)))
            from jsonb_array_elements_text(coalesce(cc.operator_override_payload, '{}'::jsonb) -> 'buyer_flags') as item(value)
            where btrim(item.value) <> ''
          ), '{}'::text[])
          else coalesce(cc.buyer_flags, '{}'::text[])
        end as buyer_flags,
        case
          when jsonb_typeof(coalesce(cc.operator_override_payload, '{}'::jsonb) -> 'risk_flags') = 'array' then coalesce((
            select array_agg(distinct lower(btrim(item.value)) order by lower(btrim(item.value)))
            from jsonb_array_elements_text(coalesce(cc.operator_override_payload, '{}'::jsonb) -> 'risk_flags') as item(value)
            where btrim(item.value) <> ''
          ), '{}'::text[])
          else coalesce(cc.risk_flags, '{}'::text[])
        end as risk_flags
    ) classification_effective on true
$new$
    );

    if v_next = v_sql or position('classification_effective' in v_next) = 0 then
      raise exception 'operator_override_tag_filter_rpc_patch_not_applied';
    end if;

    execute v_next;
  end if;
end;
$migration$;

comment on function public.get_ebay_canonical_mailbox_v2(integer, integer, text, text[], jsonb, jsonb)
  is 'Versioned canonical eBay mailbox read model with effective operator override tags in server-side filters/search/counts. Read-only; no eBay mutation.';
