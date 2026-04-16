# iPhone Capture Repo Audit

## Purpose

This document is the current repo-grounded source of truth for the OG Jewelers iPhone capture app as of April 15, 2026.

It exists because `IPHONE_CAPTURE_APP_PLAN.md` began as a forward-looking implementation plan, but the repo has since advanced into a working end-to-end capture client. This audit documents what is actually built today, where the repo has drifted from the original plan, and what should now be treated as the authoritative current state.

## Inputs Reviewed

- `IPHONE_CAPTURE_APP_PLAN.md`
- `../../docs/REPO_SUMMARY.mmd`
- `OGJewelryCapture/App/OGJewelryCaptureApp.swift`
- `OGJewelryCapture/Models/*`
- `OGJewelryCapture/Services/*`
- `OGJewelryCapture/ViewModels/*`
- `OGJewelryCapture/Views/*`
- `../../supabase/migrations/20260321120000_capture_phase_2_foundation.sql`
- `../../supabase/migrations/20260321121000_capture_phase_2_bootstrap_station.sql`
- `../../supabase/migrations/20260321143000_capture_phase_3b_upload_lifecycle.sql`
- `OGJewelryCapture.xcodeproj/project.pbxproj`

## Executive Summary

The iPhone capture app is no longer a scaffolding project. The repo contains a working SwiftUI capture client with:

- employee auth against `employees`
- session restore on launch
- station selection and local persistence
- Supabase-backed `capture_stations` and `capture_jobs`
- realtime listener flow for queued and assigned jobs
- native AVFoundation capture on device
- simulator fallback capture for development
- upload to the private `capture-photos` bucket
- constrained lifecycle mutation via `update_capture_job_lifecycle(...)`
- completion and failure state handling in the app

The old plan should now be treated as historical context plus design rationale, not as the live implementation checklist.

## Current Implementation Status by Original Plan Phase

### Phase 1-style foundation work

Status: effectively completed

Implemented in repo:

- App bootstraps through `AppRootView` and `AuthViewModel`.
- Supabase client is configured through `AppConfig` + `SupabaseService`.
- `SupabaseConfig.plist` and `SupabaseConfig.example.plist` exist, so the app is not relying on service-role credentials and is not using the earlier browser-style inline-key pattern.
- Camera usage description is present in the Xcode project.
- The `Supabase` Swift package is referenced in the Xcode project.

### Auth and employee validation

Status: completed

Implemented in repo:

- `AuthService` signs in with email/password through Supabase Auth.
- Session restore is attempted on launch.
- Authenticated users are validated against `public.employees`.
- Missing employee records and inactive employees are rejected cleanly.
- Sign-out is implemented.

### Station identity and persistence

Status: completed for the current routing model

Implemented in repo:

- `StationRepository` reads active rows from `public.capture_stations`.
- `StationSelectionView` lets the operator choose a station.
- `StationSelectionStore` persists the selected station locally in `UserDefaults`.
- `StationViewModel` restores the saved station and refreshes it against live Supabase data.

Not yet implemented:

- active heartbeat / `last_seen_at` updates from device to station row
- explicit device pairing flow beyond station selection

### Capture job schema and policies

Status: completed for the shipped single-photo pipeline

Implemented in repo and migrations:

- `public.capture_stations` exists with `name`, `active`, `assigned_employee_id`, `device_label`, `ios_device_identifier`, and `last_seen_at`.
- `public.capture_jobs` exists with lifecycle timestamps, storage metadata, failure metadata, `control_payload`, and `result_payload`.
- RLS is enabled on both tables.
- Active employees can read capture stations and jobs.
- Admins/managers have broad write access.
- A security-definer function `public.update_capture_job_lifecycle(...)` exists for app-driven lifecycle transitions.
- A private `capture-photos` storage bucket exists with employee-scoped insert/read policies tied to station and job path segments.

### Realtime listening and dispatch

Status: completed

Implemented in repo:

- `CaptureJobListener` subscribes to `public.capture_jobs` realtime changes filtered by `station_id`.
- Both insert and update events are handled.
- `ReadyViewModel` also performs an initial fetch of the next pending job so pre-existing queued work is not missed.
- Local dedupe and single-active-job protection are present through `handledJobIDs` and `activeJobID`.

### Native capture flow

Status: completed

Implemented in repo:

- `CameraCaptureService` prepares AVFoundation capture on device.
- Back camera access is requested and enforced.
- `AVCaptureSession` + `AVCapturePhotoOutput` are used for still capture.
- Live preview is shown during requested/capturing states.
- A built-in stabilization delay is already present and defaults to `1.2` seconds in `ReadyViewModel`.
- Simulator fallback generates a synthetic JPEG for development and validation.

### Upload flow and lifecycle updates

Status: completed

Implemented in repo:

- `CapturePhotoUploadService` uploads JPEG data to `capture-photos`.
- Object keys follow the pattern `{station_id}/{job_id}/{timestamp}-capture.jpg`.
- `CaptureJobRepository` drives lifecycle progression through the RPC:
  - `capturing`
  - `uploading`
  - `completed`
  - `failed`
- File size, MIME type, bucket, path, and timestamps are persisted on completion.

### Operator UX hardening

Status: partially completed

Implemented:

- connection state is surfaced
- capture state is surfaced
- failure messages are surfaced
- refresh action exists
- change-station action exists
- logout exists

Still rough or incomplete:

- no manual shutter option
- stabilization timing is fixed in code, not operator-configurable
- success/result UI remains visible after completion instead of clearly resetting for the next job
- no explicit auto-return-to-clean-ready-state behavior after successful capture
- no explicit offline recovery UX beyond listener state exposure

### Tests and validation

Status: partially completed

Implemented:

- placeholder unit and UI test targets exist

Missing:

- meaningful unit coverage for auth, station selection, listener coordination, and lifecycle state handling
- meaningful UI automation around login, station selection, and ready-state transitions
- documented repeatable local validation script/checklist in the repo

### Windows/browser integration handoff

Status: partially completed

Implemented indirectly:

- the data contract is visible in `capture_jobs`, storage paths, and lifecycle transitions
- the app is already compatible with queued-job insertion and downstream completion observation

Still missing:

- dedicated integration document for the external job creator / downstream consumer contract
- explicit Windows-side contract doc for `control_payload` and `result_payload`

## What Is Fully Completed

- SwiftUI app shell and boot flow
- Supabase iOS client integration
- config-based public Supabase client setup
- employee login
- session restore
- sign out
- station list fetch
- station selection persistence
- capture station schema
- capture job schema
- realtime listener
- pending-job fetch on startup
- queued and assigned job intake
- atomic job claim/start through RPC
- native camera capture
- simulator fallback capture
- photo upload to `capture-photos`
- lifecycle updates to uploading/completed/failed
- latest result display

## What Is Partially Completed

- operator-facing ready-state polish
- reconnect/offline resilience UX
- station presence / heartbeat
- automated testing
- integration documentation for upstream/downstream clients
- observability and operational diagnostics

## What Remains Missing

- optional manual capture mode
- configurable or policy-driven pre-shutter timing
- clear post-capture reset behavior
- stronger regression coverage
- explicit heartbeat / availability reporting
- broader operational hardening for flaky connectivity and abandoned-job scenarios
- TestFlight readiness work
- Windows integration documentation as a first-class artifact

## Repo Drift From the Original Plan

## 1. The old plan still frames major shipped work as future work

The biggest drift is simple maturity. The plan still contains “implement” steps for auth, station selection, realtime listening, camera capture, upload, and lifecycle updates that are already present in code and supported by migrations.

## 2. The schema is no longer hypothetical

The plan proposed `capture_jobs` and `capture_stations`. Those are now real Supabase entities with RLS, indexes, and lifecycle RPC support. The app and database have already converged on `capture_stations` as the routing entity.

## 3. Lifecycle updates are more advanced than the early plan assumed

The old plan discussed the possibility of RPC-based lifecycle transitions. The repo now uses a security-definer RPC as the actual mechanism for app-side state mutation.

## 4. Config handling improved from the earlier browser-pattern warning

The plan warned against copying browser-side inline-key patterns into the iPhone app. The repo followed that recommendation by loading the public URL and anon key from plist config instead of hardcoding them in Swift source.

## 5. The remaining product gaps are now UX-centric, not architecture-first

The original plan focused on building the pipeline. The current repo has the pipeline. The most immediate next gaps are operator usability issues observed on real hardware.

## Current Architecture Based on Actual Code

### App flow

1. `OGJewelryCaptureApp` injects `AuthViewModel` and `StationViewModel`.
2. `AppRootView` bootstraps auth and routes to login or authenticated flow.
3. `AuthenticatedView` either shows station selection or the ready/listening screen.
4. `ReadyView` owns `ReadyViewModel`, which coordinates listener, camera, repository, and upload services.

### Service responsibilities

- `AuthService`
  - sign in
  - restore session
  - validate employee status

- `StationRepository`
  - fetch active capture stations

- `StationSelectionStore`
  - persist selected station locally

- `CaptureJobListener`
  - subscribe to station-filtered realtime events
  - translate realtime records into fresh `CaptureJob` reads

- `CaptureJobRepository`
  - fetch pending jobs
  - fetch individual jobs
  - transition lifecycle through RPC

- `CameraCaptureService`
  - prepare camera
  - expose preview session
  - capture device photo
  - provide simulator fallback

- `CapturePhotoUploadService`
  - upload JPEGs to `capture-photos`
  - return completion metadata

### Database and storage responsibilities

- `capture_stations`
  - routing entity for device/operator selection

- `capture_jobs`
  - request and result lifecycle source of truth

- `capture-photos`
  - private original image storage

- `update_capture_job_lifecycle(...)`
  - constrained write path for app-owned state transitions

## Known Technical Debt, Warnings, and Risks

### Product/UX debt

- The app currently auto-captures after a fixed delay. Real-device feedback says the current timing still feels too fast for reliable focus/exposure settling in practice.
- There is no manual operator-controlled shutter path today.
- Completed result content remains on screen, which increases clutter and can blur whether the station is ready for the next job.

### Operational debt

- `last_seen_at` exists in schema but heartbeat is still deferred and called out as TODO in `StationRepository`.
- The app has only light local dedupe protections; there is no richer in-app event/audit history for diagnosing operational race conditions.
- The listener reports state, but there is limited operator guidance for recovery if auth expires or connectivity degrades.

### Testing debt

- Test targets are mostly placeholders.
- There is no strong automated regression coverage around the capture state machine.

### Documentation debt

- The original plan contains implementation notes, but it is not a clean current-state artifact anymore.
- Upstream/downstream job contract documentation is still implicit in code and schema rather than documented as a dedicated interface.

## Confirmed Real-Device Validation

The following validation results were provided as confirmed recent execution results and are consistent with the current code and schema:

- a queued job is inserted into `public.capture_jobs`
- the phone detects the request
- the real camera opens
- a photo is taken
- the photo uploads to Supabase Storage
- the `capture_jobs` row updates to `completed` with storage metadata
- repeated queued jobs have been processed successfully

This means the core end-to-end capture pipeline should now be considered validated in real use, not merely implemented in theory.

## Recommended Current Source of Truth

Use the following hierarchy going forward:

1. This audit for current repo state and implementation truth
2. `IPHONE_CAPTURE_PHASE4_PLAN.md` for the next tightly scoped phase
3. `IPHONE_CAPTURE_APP_PLAN.md` as historical planning context and rationale

In practical terms, the current source of truth is:

- The app is a working authenticated station-based capture client.
- Supabase is the live transport, auth, storage, and lifecycle backbone.
- The core single-photo pipeline is already working on real hardware.
- The next phase should optimize capture-control UX and ready-state clarity without destabilizing the existing pipeline.
