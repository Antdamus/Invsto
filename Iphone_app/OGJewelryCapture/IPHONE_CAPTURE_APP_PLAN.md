# OG Jewelry Capture iPhone App Plan

## 1. Objective

Build an internal iPhone companion app that connects to the existing OG Supabase project, identifies a device/station, listens for capture jobs initiated elsewhere, captures a native photo, uploads the image to Supabase Storage, and updates capture job status back to Supabase.

This app is a focused capture terminal, not the broader inventory or AI workflow.

## 2. Scope

### Phase 1 in scope

- Supabase authentication for internal users/devices
- Device or station identity setup
- Ready/listening state for incoming capture jobs
- Native camera preview and single-photo capture
- Image upload to Supabase Storage
- Database status updates for capture job lifecycle
- Basic success, failure, retry, and reconnect UX

### Phase 1 explicitly out of scope

- Scale integration
- Inventory item creation
- OpenAI API calls
- JSON generation
- Item card creation
- Multi-step inventory workflow orchestration
- Advanced editing/cropping pipeline
- Multi-photo capture sets unless later confirmed

## 3. Repo Audit Findings

### Relevant files reviewed

- `initSupabase.js`
- `StoreWebsite/initSupabase.js`
- `Join/initSupabase.js`
- `StoreWebsite/StoreAdmin/index.js`
- `auth.js`
- `timeclock.js`
- `additem.js`
- `add-inventory.js`
- `stock.js`
- `admin.js`
- `supabase/config.toml`
- `supabase/functions/og_send_magic_link/index.ts`
- `supabase/functions/jwt-custom-claims/index.ts`
- `supabase/functions/storefront-catalog/index.ts`
- `supabase/functions/storefront-sign-photos/index.ts`
- `supabase/migrations/20260124184912_remote_schema.sql`
- `supabase/migrations/20260124185608_storefront_phase_3_rls.sql`
- `supabase/migrations/20260124190702_storefront_phase_4_media_settings.sql`
- `supabase/migrations/20260125214712_joinpagelogic.sql`
- `docs/REPO_SUMMARY.mmd`
- `docs/legacy/STOREWEBSITE_AUDIT.md`
- `iphone_app/OGJewelryCapture/OGJewelryCapture/ContentView.swift`
- `iphone_app/OGJewelryCapture/OGJewelryCapture/OGJewelryCaptureApp.swift`
- `iphone_app/OGJewelryCapture/OGJewelryCapture.xcodeproj/project.pbxproj`

### Existing Supabase client initialization and config patterns

- The web apps use duplicated browser-side `initSupabase.js` files that call `supabase.createClient(...)`, expose `window.supabase` and `window.supabaseClient`, and dispatch `supabase-ready`.
- Those files currently embed the project URL and anon key directly in source. That establishes the current repo pattern, but it is not a good pattern to copy into the native app unchanged.
- The app ecosystem already depends on authenticated client access plus RLS, not on shipping service-role credentials to clients.

### Existing auth flow patterns

- Internal portal login in `auth.js` uses `supabase.auth.signInWithPassword(...)` and then reads `public.employees` to determine role and active status.
- Storefront admin login in `StoreWebsite/StoreAdmin/index.js` uses password auth and then checks `public.user_roles`. That table is referenced in code but was not found in migrations reviewed, so it should not be treated as the primary pattern.
- Public member flows use a server-side Edge Function `og_send_magic_link` to send OTP/magic links safely with service-role credentials and rate limiting.
- JWT custom claims currently expose `user_metadata.role`, and several RLS/storage rules rely on that claim.

### Environment variable / secret handling

- Browser code currently contains the public project URL and anon key inline in repo files.
- Edge Functions correctly use `Deno.env.get(...)` for service-role secrets.
- There is no iOS-specific secret/config handling yet in `iphone_app/OGJewelryCapture`.
- Recommendation: for the iPhone app, use a local config file or build settings approach that keeps the public URL and anon key out of the planning doc and ideally out of committed source. Never embed service-role secrets in the app.

### Existing table naming conventions

- Tables are mostly snake_case in `public`, for example:
  - `employees`
  - `item_types`
  - `item_stock_locations`
  - `metadata`
  - `store_locations`
  - `storefront_listings`
  - `storefront_settings`
  - `time_entries`
  - `time_breaks`
  - `timeclock_day_exceptions`
  - `members`
- IDs are generally UUIDs, with `auth.users.id` linked through `employees.user_id` or directly in `members.id`.
- Existing naming strongly suggests any new tables should follow snake_case, `created_at`/`updated_at`, status columns, and UUID primary keys.

### Existing storage bucket conventions

- Existing buckets in code/migrations include:
  - `photos`
  - `timeclock-photos`
  - `dymo-labels`
  - `location-assets`
  - `public-ebay-photos`
- Current inventory photo uploads use `photos`.
- Timeclock uploads use a dedicated `timeclock-photos` bucket with path validation based on employee identity.
- Existing pattern: store durable storage paths in DB, not signed URLs. Signed URLs are generated later when needed.

### Existing realtime usage

- `admin.js` subscribes to `postgres_changes` on `time_entries`, `time_breaks`, and `employees`.
- `stock.js` subscribes to `postgres_changes` on `metadata` for inventory refresh behavior.
- There is no existing capture-job realtime implementation, but the repo already uses Supabase Realtime as a first-class pattern for operational updates.

### Existing RLS assumptions

- The repo uses RLS heavily.
- Common access patterns:
  - own-row access via `auth.uid()`
  - staff access based on an active `employees` row
  - admin access via `public.is_admin()` or JWT `user_metadata.role = 'admin'`
- Storage policies also enforce identity via object path prefixes. Example: `timeclock-photos` insert/read policies require the first path segment to match the employee UUID.
- Timeclock also uses `SECURITY DEFINER` RPCs like `attach_punch_photo`, `attach_break_photo`, `clock_in_now_geo`, and `clock_out_now_geo` to enforce server-side rules while keeping clients simple.

### Inventory / draft item patterns that may influence future integration

- `item_types` holds item data including `photos text[]`, title, description, pricing, barcode, and related metadata.
- `metadata` is used as a lightweight realtime versioning row for inventory refresh.
- `storefront_listings` overlays publishing/public photo behavior on top of `item_types`.
- These patterns suggest the iPhone app should not write directly into `item_types` in phase 1. It should produce a capture artifact and status record that downstream systems can later bind to inventory items.

### Existing content inside `iphone_app/OGJewelryCapture`

- Only the default SwiftUI scaffold exists.
- `ContentView.swift` still contains the starter “Hello, world!” UI.
- The Xcode project currently has:
  - no Supabase package dependency
  - no camera permissions config yet
  - generated Info.plist settings
  - deployment target currently set very high in the project file and likely needing normalization before real implementation

### Relevant architecture docs

- `docs/REPO_SUMMARY.mmd` is useful as a high-level map of the current repo and confirms current Supabase, storage, timeclock, and admin patterns.
- `docs/legacy/STOREWEBSITE_AUDIT.md` is useful for understanding duplicated Supabase init patterns and browser-side app structure.
- No existing docs describe an iPhone capture workflow yet.

### Key reuse recommendations from audit

- Reuse authenticated client + RLS architecture, not a custom relay server.
- Reuse Supabase Realtime for job listening.
- Reuse “store storage path in DB, signed URL generated later” pattern.
- Reuse server-side RPC or constrained table updates for sensitive state transitions where business rules matter.
- Reuse snake_case naming, UUID IDs, and `created_at`/`updated_at` conventions.

### Risks and constraints discovered

- Current repo exposes public Supabase credentials inline in JS. The iPhone app should not repeat that casually; use app config/build settings instead.
- `StoreWebsite/StoreAdmin/index.js` references `user_roles`, but the migration set reviewed does not establish that table. The more reliable internal auth pattern appears to be `employees`.
- Existing storage/RLS rules rely on path structure. Capture upload design should intentionally encode device/job identity in object keys so policies remain enforceable.
- Existing internal policies often assume a human employee-authenticated session. Device/station operation may need either:
  - employee-authenticated usage with a linked station row, or
  - a dedicated device auth model added explicitly.

## 4. Proposed Architecture

### System model

`iPhone app <-> Supabase <-> future Windows/browser control app`

### Recommended phase-1 interaction model

1. A Windows/browser control app creates a capture job row in Supabase.
2. The iPhone app is authenticated, associated with a station/device identity, and subscribed to relevant capture job changes through Supabase Realtime.
3. When a new assigned job enters a ready state, the iPhone app presents the capture screen and takes a native photo.
4. The iPhone app uploads the image to a dedicated capture storage location in Supabase Storage.
5. The iPhone app updates the capture job row with status, timestamps, storage path, and basic capture metadata.
6. The Windows/browser app or later backend flow continues the workflow from that stored result.

### Authentication concept

- Phase 1 should follow existing internal patterns and use Supabase Auth with authenticated users linked to `employees`.
- Recommended default: employee login on the iPhone app, then a device/station assignment record stored separately.
- Avoid embedding any service-role credential in the app.
- If hands-free unattended station auth becomes required later, add a formal device auth flow rather than overloading anon access.

### Capture job concept

- Capture jobs should be database rows with a clear lifecycle such as:
  - `queued`
  - `assigned`
  - `capturing`
  - `uploading`
  - `completed`
  - `failed`
  - `canceled`
- The iPhone app should subscribe only to jobs relevant to its assigned station/device.

### Photo upload concept

- Use Supabase Storage for the original image.
- Store only the storage path and metadata in the database.
- Follow the repo’s established pattern of generating signed URLs later, outside the capture client, when downstream consumers need access.

### Job status update concept

- The app should write job status transitions back to the database.
- Where rules become non-trivial, prefer a server-side RPC for atomic transitions over unconstrained direct table updates.

### Storage vs database responsibilities

- Storage:
  - original photo binary
  - optional derived preview later if needed
- Database:
  - capture job intent
  - assignment and state
  - device/station linkage
  - storage path
  - timestamps
  - failure reason
  - minimal capture metadata

## 5. Recommended Supabase Integration Approach

### Recommendation

Use a database-backed capture job table with Supabase Realtime subscriptions for dispatch, Supabase Storage for photo binaries, and a small set of constrained table updates or RPCs for job lifecycle transitions.

### Why this matches the repo

- The repo already uses Supabase Realtime for operational updates in `admin.js` and `stock.js`.
- The repo already uses Storage path persistence plus later signed URL creation.
- The repo already uses RLS and `SECURITY DEFINER` functions where update rules need enforcement.
- The repo does not show an existing custom message broker, queue server, or websocket backend outside Supabase.

### Recommended phase-1 mechanics

- Authenticated iPhone app subscribes to `capture_jobs` changes filtered by assigned station/device.
- On accepted job:
  - app marks job as `capturing`
  - app captures one photo
  - app uploads to a dedicated bucket or dedicated path namespace
  - app marks job `completed` with `storage_path`
- On failure:
  - app marks job `failed`
  - stores a short machine-readable failure code plus human-readable message

### Storage recommendation

- Prefer a dedicated bucket for this app, for example `capture-photos`, instead of reusing `photos`.
- Reason:
  - clearer policy boundary
  - cleaner operational ownership
  - less coupling to inventory/storefront assumptions
- If the team prefers reusing `photos`, use a dedicated top-level prefix such as `capture_jobs/...` and add explicit policies. A dedicated bucket is cleaner.

### Database write recommendation

- Use direct authenticated table reads/subscriptions where safe.
- Use RPCs for lifecycle transitions if phase 1 needs stronger guarantees around:
  - only one active claimant
  - job reassignment safety
  - immutable completion payloads
  - cancel/timeout behavior

## 6. Proposed Phase-1 Feature Set for the iPhone App

- Employee login screen using Supabase Auth
- Session restore on app relaunch
- Station/device setup screen
- Ready/listening screen showing current station and connection status
- Realtime job listening for this station/device
- Native camera preview
- Single high-quality photo capture
- Upload progress state
- Completion confirmation state
- Error state with retry for:
  - network failure
  - upload failure
  - job already canceled/reassigned
  - auth/session expiry
- Manual “mark unavailable” or “refresh listener” action

## 7. Proposed Data Model / Entities

This is a planning draft only. Final schema should be confirmed before migration work.

### A. `capture_jobs` (new, proposed)

Purpose: source of truth for requested captures and their lifecycle.

Suggested fields:

- `id uuid primary key`
- `created_at timestamptz`
- `updated_at timestamptz`
- `requested_by uuid null`
- `station_id uuid null`
- `device_id uuid null`
- `status text`
- `requested_at timestamptz`
- `claimed_at timestamptz null`
- `capture_started_at timestamptz null`
- `capture_completed_at timestamptz null`
- `upload_completed_at timestamptz null`
- `storage_bucket text`
- `storage_path text`
- `file_size_bytes bigint null`
- `image_width integer null`
- `image_height integer null`
- `mime_type text null`
- `failure_code text null`
- `failure_message text null`
- `control_payload jsonb null`
- `result_payload jsonb null`

Notes:

- `control_payload` can hold the initial Windows/browser-side request contract without forcing schema churn.
- `result_payload` can hold capture-only output details that downstream inventory flow will consume later.

### B. `capture_stations` or `capture_devices` (new, proposed)

Purpose: station identity and routing target for jobs.

Suggested fields:

- `id uuid primary key`
- `name text`
- `active boolean`
- `created_at timestamptz`
- `updated_at timestamptz`
- `assigned_employee_id uuid null`
- `device_label text null`
- `ios_device_identifier text null`
- `last_seen_at timestamptz null`

Recommendation:

- Prefer `capture_stations` as the stable routing entity.
- Let the physical iPhone register as the active device for a station.
- This matches the user’s “pairing/identity for a station or device” requirement without hard-binding the architecture too early.

### C. Optional `capture_job_events` (new, optional)

Purpose: append-only job audit trail if state debugging becomes important.

Not required for the first pass if `capture_jobs` timestamps are sufficient.

### D. Storage path convention (proposed)

- Dedicated bucket: `capture-photos`
- Suggested object key shape:
  - `{station_id}/{job_id}/original.jpg`
  - or `{device_or_station_id}/{yyyy}/{mm}/{dd}/{job_id}.jpg`

Recommendation:

- Include the routing identity in the first path segment so storage RLS can enforce ownership similarly to `timeclock-photos`.

## 8. UX / Screen Plan

Keep v1 lean.

### 1. Login Screen

- Email/password login for internal user
- Loading and error states
- Session restore on launch

### 2. Station Setup Screen

- Select or enter station identity
- Optionally show current employee and device name
- Persist local selection

### 3. Ready / Listening Screen

- Main idle state
- Shows:
  - station name
  - connection/auth status
  - listening status
  - most recent job outcome
- When a job arrives, transitions into capture flow

### 4. Capture Screen

- Full camera preview
- clear job context
- capture button
- cancel/back handling only if job state allows it

### 5. Upload / Result Screen

- Upload progress
- success/failure result
- retry if safe
- return to listening state automatically after completion

## 9. Step-by-Step Execution Plan

### Step 1. Normalize the Xcode app foundation

- Confirm minimum iOS deployment target
- Add required camera usage descriptions and app permissions
- Set bundle/config naming cleanly
- Add local config mechanism for Supabase URL and anon key

### Step 2. Add Supabase client layer for iOS

- Add Swift Supabase package dependency
- Create a single app-side Supabase service
- Implement session persistence and bootstrap
- Verify login and session restore

### Step 3. Implement internal auth flow

- Build login screen
- Authenticate with Supabase Auth
- Fetch current employee context from `employees`
- Reject inactive or unauthorized users cleanly

### Step 4. Implement station/device identity

- Design local pairing/setup UI
- Create or integrate station/device table
- Persist selected station locally
- Add presence/last_seen update pattern

### Step 5. Add capture job schema and policy layer

- Create migrations for `capture_jobs` and station/device entity
- Add RLS policies
- Add any helper RPCs needed for claim/start/complete/fail transitions
- Validate Realtime eligibility for the chosen tables

Phase 2 implementation note:

- The iPhone app now treats `capture_stations` as a selection-only routing entity fetched from Supabase and persisted locally after login/session restore.
- `capture_jobs` includes only the metadata needed for single-photo capture routing and storage-path-first completion, plus light file metadata (`file_size_bytes`, `mime_type`) for Phase 3 upload completion.
- Phase 3A implementation note: the ready screen now uses a lean `capture_jobs` Realtime listener filtered by `station_id`, does an initial pending-job fetch to avoid missing pre-existing requests, and keeps job dedupe local in-app for now because employee-level RLS does not yet allow the capture client to persist lifecycle claims. Native capture uses `AVCaptureSession` plus `AVCapturePhotoOutput` with a small configurable stabilization delay and a DEBUG-only simulator trigger/fallback for manual validation before Phase 3B upload/state finalization.
- RLS currently allows active employees to read stations/jobs, while write access is limited to active admins/managers. Device heartbeat and job lifecycle mutation paths are intentionally deferred until Phase 3 so the app does not rely on premature write rules or RPCs.

### Step 6. Implement ready/listening experience

- Subscribe to assigned job rows with Supabase Realtime
- Show connection state and current listener state
- Handle reconnects and duplicate events safely

### Step 7. Implement native camera capture flow

- Build AVFoundation-based preview
- Capture one high-quality still image
- Collect basic image metadata
- Keep UX focused and minimal

### Step 8. Implement storage upload flow

- Upload captured image to dedicated bucket/path
- Persist only storage path and metadata in DB
- Handle retry and partial-failure behavior

### Step 9. Implement job lifecycle updates

- Claim job
- mark capturing
- mark uploading
- mark completed or failed
- verify state transitions from both app and database side

### Step 10. Add basic operational UX hardening

- offline/reconnect handling
- session expiry handling
- duplicate job protection
- job canceled while app is mid-flow
- retry rules and user messaging

### Step 11. Add tests and validation pass

- unit tests for client state machine where feasible
- manual end-to-end validation with Supabase
- verify storage path, DB rows, and realtime behavior

### Step 12. Prepare handoff for Windows/browser integration

- Document the job contract expected by the iPhone app
- Document the completion payload returned by the iPhone app
- Confirm any downstream signed-URL or processing expectations

## 10. Open Questions / Decisions Needed

- Should phase 1 use employee-authenticated sessions only, or is a dedicated unattended device auth model required?
- What should the authoritative routing entity be: `station`, `device`, or station plus active device?
- What is the exact job contract created by the future Windows/browser app?
- Should a job capture exactly one photo in phase 1, or is there a near-term requirement for multiple angles?
- Should the app auto-capture immediately when a job arrives, or should the operator always tap capture?
- Is a dedicated storage bucket acceptable for this app, or must it reuse an existing bucket?
- Should final job state transitions be plain table updates or protected RPCs from day one?
- What employee roles are allowed to operate capture stations?
- Should completed images be private-only and consumed through signed URLs later, or is any broader internal access needed?
- What timeout/cancel/reassignment behavior should occur if the phone is offline or an operator abandons a job?
- Does the iPhone app need to show any item metadata from the job request, or should the capture UI remain nearly context-free?
- Is the current `public.user_roles` usage legacy and ignorable for this app, with `employees` as the real internal auth source of truth?

## 11. Definition of Done for Phase 1

Phase 1 is done when all of the following are working:

- An internal user can sign in on the iPhone app with Supabase Auth.
- The app can persist and restore the authenticated session.
- The app can identify itself as a specific station/device.
- A test capture job inserted in Supabase for that station/device appears in the app via Realtime.
- The app can open camera preview and capture one native still image.
- The app can upload the image to Supabase Storage successfully.
- The app writes the final storage path and completion metadata back to the job record.
- Failure paths update the job record consistently and show understandable operator feedback.
- The app returns to a stable ready/listening state after success or failure.
- No service-role secret is embedded in the mobile app.

## Recommended Next Implementation Target

When implementation begins, the safest first executable milestone is:

1. Step 1: normalize the iOS project foundation and config handling
2. Step 2: add the Supabase client layer
3. Step 3: implement internal auth against the existing `employees` pattern

That sequence reuses the strongest existing repo conventions before introducing any new capture-specific schema.
