-- Expand eBay category inference without changing internal store categories.
-- Store categories remain free-form; ebay_category_id is the publishing category.

update public.ebay_inventory_settings
set
  category_rules = '[
    { "match": ["bracelet", "bangle", "tennis"], "categoryId": "261988" },
    { "match": ["brooch", "pin"], "categoryId": "261989" },
    { "match": ["earring", "earrings", "stud", "hoop"], "categoryId": "261990" },
    { "match": ["jewelry set", "jewellery set"], "categoryId": "261992" },
    { "match": ["pendant", "necklace", "chain", "charm"], "categoryId": "261993" },
    { "match": ["toe ring"], "categoryId": "261995" },
    { "match": ["ring"], "categoryId": "261994" }
  ]'::jsonb,
  updated_at = now()
where id = 'default';

with source as (
  select
    id,
    lower(concat_ws(' ', title, description, array_to_string(categories, ' '))) as text_blob
  from public.item_types
  where deleted_at is null
    and ebay_category_id is null
),
inferred as (
  select
    id,
    case
      when text_blob ~ '(bracelet|bangle|tennis)' then '261988'
      when text_blob ~ '(brooch|pin)' then '261989'
      when text_blob ~ '(earring|earrings|stud|hoop)' then '261990'
      when text_blob ~ '(jewelry set|jewellery set)' then '261992'
      when text_blob ~ '(pendant|necklace|chain|charm)' then '261993'
      when text_blob ~ '(toe ring)' then '261995'
      when text_blob ~ '\mring\M' then '261994'
      else null
    end as category_id
  from source
)
update public.item_types item
set ebay_category_id = inferred.category_id
from inferred
where item.id = inferred.id
  and inferred.category_id is not null;
