# eBay Inventory Sync

This project now has a safe first pass for syncing internal `item_types` inventory to eBay through the Sell Inventory API.

## Flow

1. Internal item `barcode` becomes the eBay SKU.
2. Stock quantity is summed from `item_stock_locations`.
3. Photos are copied from the private `photos` bucket to the public `public-ebay-photos` bucket so eBay can fetch them.
4. The Edge Function creates/replaces eBay inventory item records.
5. For in-stock priced items, it creates or updates eBay offers.
6. Publishing live listings is blocked unless both `ebay_inventory_settings.publish_enabled` and `EBAY_SYNC_ALLOW_PUBLISH` are true.

## Required Supabase secrets

Set these on the deployed Supabase project:

```text
EBAY_CLIENT_ID=...
EBAY_CLIENT_SECRET=...
EBAY_REFRESH_TOKEN=...
EBAY_ENV=production
EBAY_SCOPE=https://api.ebay.com/oauth/api_scope/sell.inventory
EBAY_ACCOUNT_SCOPE=https://api.ebay.com/oauth/api_scope/sell.account.readonly https://api.ebay.com/oauth/api_scope/sell.inventory
EBAY_OAUTH_SCOPES=https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account.readonly
EBAY_SYNC_ALLOW_PUBLISH=false
EBAY_SOURCE_PHOTO_BUCKET=photos
EBAY_PUBLIC_PHOTO_BUCKET=public-ebay-photos
```

Use a refresh token created with the authorization-code user consent flow. Inventory writes require the `sell.inventory` scope. The publishing setup helper also needs `sell.account.readonly` so it can list business policy IDs.

## Required settings row

Update `public.ebay_inventory_settings` before the first real sync:

```sql
update public.ebay_inventory_settings
set
  enabled = true,
  marketplace_id = 'EBAY_US',
  currency = 'USD',
  merchant_location_key = 'og-miami',
  payment_policy_id = '<eBay payment policy id>',
  return_policy_id = '<eBay return policy id>',
  fulfillment_policy_id = '<eBay fulfillment policy id>',
  publish_enabled = false
where id = 'default';
```

Keep `publish_enabled = false` until dry runs and unpublished offer creation look correct.

## Publishing setup helper

Deploy the helper:

```bash
supabase functions deploy ebay-publishing-setup
```

List eBay business policies and inventory locations:

```bash
curl -X POST "$SUPABASE_FUNCTIONS_URL/ebay-publishing-setup" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  --data '{"action":"list"}'
```

Save selected policy IDs to `ebay_inventory_settings`:

```bash
curl -X POST "$SUPABASE_FUNCTIONS_URL/ebay-publishing-setup" \
  -H "Authorization: Bearer $SUPABASE_ANON_KEY" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Content-Type: application/json" \
  --data '{"action":"save","paymentPolicyId":"...","returnPolicyId":"...","fulfillmentPolicyId":"...","publishEnabled":false}'
```

## Invoke

Dry run:

```bash
supabase functions invoke ebay-inventory-sync --body '{"dryRun":true,"limit":10}'
```

Dry runs do not call eBay and do not copy missing photos into the public eBay photo bucket. A no-photo warning in dry run can simply mean the public copy has not been created yet.

Push inventory items and unpublished offers:

```bash
supabase functions invoke ebay-inventory-sync --body '{"dryRun":false,"limit":10}'
```

Publish live listings only after explicitly enabling both DB and secret gates:

```bash
supabase functions invoke ebay-inventory-sync --body '{"dryRun":false,"publish":true,"itemIds":["<item_type_uuid>"]}'
```
