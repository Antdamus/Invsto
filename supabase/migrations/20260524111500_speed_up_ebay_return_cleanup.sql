-- Speeds up the return cleaner that resolves local eBay return work
-- after the return no longer appears in eBay's open-return list.

create index if not exists ebay_return_cases_open_ebay_return_idx
  on public.ebay_return_cases(ebay_return_id, status)
  where ebay_return_id is not null
    and status not in ('closed', 'cancelled');

