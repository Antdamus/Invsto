# Inventory copy and watch reference lookup

Watches can generate copy from `watchDetails.name` (including the brand) and
`watchDetails.model` without an image or weight. With a photo, the reference is
optional. Jewelry still requires an image, material, purity, and positive weight.

Watch references use Responses API web search before the existing copy-writing
request. `OPENAI_API_KEY` is shared by both requests. `OPENAI_MODEL` remains the
copy model; `OPENAI_WATCH_LOOKUP_MODEL` optionally overrides the lookup default,
`gpt-5.5`. A lookup model must support web search source records and low reasoning.
The initial non-reasoning lookup model did not return source records in live
testing, so it could not safely support the citation checks.

The lookup accepts only exact reference matches and facts linked to URLs actually
returned by web search. It returns `found`, `ambiguous`, `not_found`, `unavailable`,
or `not_requested`, with sources and review notes. Missing evidence never becomes
an inferred specification. Factory model details are presented separately from
the seller's physical watch; supplied materials and modifications take priority.
Lookup and writing requests have 55-second and 40-second limits respectively.

The page displays clickable sources, preserves the result in account drafts, and
saves it under `item_types.watch_details.referenceLookup`. No additional migration
is needed beyond the existing JSONB watch-details column. Changing generation
inputs invalidates the preview and discards an in-flight outdated result.

Deployment uses the existing `verify_jwt = false` setting in `supabase/config.toml`
and `supabase functions deploy generate-inventory-copy --no-verify-jwt --use-api`.
Run `npm run test:add-item` for request and browser regression checks.

API reference: https://developers.openai.com/api/docs/guides/tools-web-search

## Collector coins

`itemKind: "coin"` accepts `coinDetails` with a required name and optional year,
country, denomination, mint, metal, fineness (parts per 1,000), reported condition,
variety, finish, fine-metal content with its unit, composition and alteration notes.
Grading status is `ungraded`, `self-assessed`, or `certified`. A stated grade is
required for the latter two, and certified entries also require a grading service.
Certification numbers remain strings so leading zeros are preserved.

Coin copy uses the supplied facts and optional photo, without reference web search,
appraisal, authentication, or inferred grading. Inactive certification fields are
discarded, and plated/mixed compositions do not inherit a single fineness.
The wizard uses direct pricing and stores structured details in
`item_types.coin_details` alongside a readable description appendix. Migration
`20260926120000_item_coin_details.sql` also bypasses the existing jewelry-specific
eBay defaulting trigger for coin rows. Coin eBay sync stays off in intake until
coin category and condition-descriptor publishing is supported.
