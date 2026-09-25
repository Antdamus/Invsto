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
