# eBay Inventory Sync

This project now has a safe first pass for syncing internal `item_types` inventory to eBay through the Sell Inventory API.

## Flow

1. Internal item `barcode` becomes the eBay SKU.
2. Stock quantity is summed from `item_stock_locations`.
3. Photos are copied from the private `photos` bucket to the public `public-ebay-photos` bucket so eBay can fetch them.
4. The Edge Function creates/replaces eBay inventory item records.
5. For priced items, it first looks for an existing eBay offer with the same SKU. If one exists, it updates that offer/listing; if not, it creates a new offer only for in-stock items.
6. Publishing live listings is blocked unless both `ebay_inventory_settings.publish_enabled` and `EBAY_SYNC_ALLOW_PUBLISH` are true.

## Item metadata

The sync uses normal inventory fields first, then eBay-specific overrides when present:

- `barcode` is the eBay SKU.
- `sale_price` is the eBay offer price.
- `item_stock_locations.quantity` is summed into eBay quantity.
- `metal`, `purity_basis_points`, `stone_type`, `item_length`, `categories`, `title`, and `description` are used to build eBay item specifics.
- `ebay_category_id`, `ebay_condition`, and `ebay_aspects` override inferred eBay values for one-off items.
- `ebay_sync_enabled = false` excludes an item from automatic sync.

Publishing is blocked for an item until it has title, description, SKU, price, stock, category, at least one public image, and the key jewelry aspects eBay expects: Brand, Type, Style, Main Stone, Metal, and Metal Purity.

Admins can mark test items directly from the Stock page: select the cards, then use `Exclude eBay` in the bulk toolbar. Excluded cards show an `eBay sync off` badge and are skipped by both automatic sync and the older eBay export.

Store categories stay free-form. eBay categories are tracked separately in `ebay_category_id`, and admins can set them from the Stock page with `eBay Category` in the bulk toolbar. The current fine-jewelry category presets are:

- `261988` Fine Jewelry > Bracelets & Charms
- `261989` Fine Jewelry > Brooches & Pins
- `261990` Fine Jewelry > Earrings
- `261992` Fine Jewelry > Jewelry Sets
- `261993` Fine Jewelry > Necklaces & Pendants
- `261995` Fine Jewelry > Toe Rings
- `261994` Fine Jewelry > Rings

If an item only falls back to the default category instead of matching a rule or an explicit `ebay_category_id`, the sync will still prepare inventory, but publishing is blocked until a real eBay category is assigned.

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
npx supabase functions deploy ebay-publishing-setup --no-verify-jwt --project-ref byhytmarmigalvawkedi
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

Deploy the sync function:

```bash
npx supabase functions deploy ebay-inventory-sync --no-verify-jwt --project-ref byhytmarmigalvawkedi
```

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
