create index if not exists ebay_return_cases_buyer_status_opened_idx
  on public.ebay_return_cases(buyer_username, status, opened_at desc)
  where buyer_username is not null;

create index if not exists ebay_return_cases_order_status_opened_idx
  on public.ebay_return_cases(order_number, status, opened_at desc)
  where order_number is not null;
