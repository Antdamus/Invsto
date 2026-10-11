-- Keep the database in sync with the watch conditions already offered at intake.
-- These values must be saved faithfully even when the item is inventory-only or
-- awaiting pricing. Marketplace/category eligibility is checked before publishing.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

alter table public.item_types
  drop constraint if exists item_types_ebay_condition_check,
  add constraint item_types_ebay_condition_check check (
    ebay_condition is null or ebay_condition in (
      'NEW', 'LIKE_NEW', 'NEW_OTHER', 'NEW_WITH_DEFECTS',
      'MANUFACTURER_REFURBISHED', 'CERTIFIED_REFURBISHED',
      'EXCELLENT_REFURBISHED', 'VERY_GOOD_REFURBISHED', 'GOOD_REFURBISHED',
      'SELLER_REFURBISHED', 'PRE_OWNED_EXCELLENT', 'PRE_OWNED_FAIR',
      'USED_EXCELLENT', 'USED_VERY_GOOD', 'USED_GOOD', 'USED_ACCEPTABLE',
      'FOR_PARTS_OR_NOT_WORKING'
    )
  );

commit;
