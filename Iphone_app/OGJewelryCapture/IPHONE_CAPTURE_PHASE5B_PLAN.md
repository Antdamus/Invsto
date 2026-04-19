# iPhone Capture Phase 5B Plan

## Phase Name

Phase 5B: Multi-Photo Capture Session + Backend Contract

## Phase 5B.1 Agreement Gate

Agreed Phase 5B workflow:

- local multi-photo session per job
- soft max of 10 kept photos per job
- upload only when the operator presses Finish Job
- parent job becomes completed only after the final approved photo set uploads successfully

Agreed minimal-risk planning approach:

- define backend shape first
- define job completion semantics first
- do not code the app workflow yet

This document is the Phase 5B.1 source of truth for planning and schema design only.

## Why This Should Happen Next

The current app and backend are validated for a single-photo flow:

- one `capture_jobs` row represents one requested capture
- the app performs local review for one captured image
- keeping the image immediately uploads it
- the parent job is marked `completed` with a single `storage_path`

That architecture is correct for the shipped flow, but it is too narrow for the Phase 5B product model where one job can produce multiple photos and the operator chooses when to upload the final set. The next safest step is to lock the new session model and backend contract before changing app behavior or database objects.

## Current Repo Constraints That Must Be Preserved During 5B.1

Confirmed from current code and migrations:

- `capture_jobs` is the current parent job table and lifecycle source of truth.
- `update_capture_job_lifecycle(...)` currently supports one completion event on the parent row.
- `capture_jobs.storage_bucket`, `storage_path`, `file_size_bytes`, and `mime_type` are currently modeled as single-file metadata.
- storage object paths and storage policies already expect the pattern `{station_id}/{job_id}/{file_name}`.
- `ReadyViewModel` currently supports local review of a just-captured photo with Keep or Discard / Retake.
- Standard and High Resolution are already operator-selectable and should remain job-scoped in v1.

Because of those constraints, multi-photo should be introduced as an additive design:

- keep `capture_jobs` as the parent request and lifecycle row
- add child rows for uploaded photos
- keep local capture review in the app
- move upload timing from Keep to Finish Job in the future implementation phase

## Product Workflow

### Intended Operator Flow

1. A queued job arrives and is claimed as usual.
2. The app opens an active multi-photo capture session for that job.
3. The operator captures the first photo using the existing auto or manual capture mode.
4. The app presents review controls for the newly captured photo:
   - Keep
   - Discard / Retake
5. If the operator chooses Keep:
   - the photo is stored locally in the active session only
   - it is appended to the kept-photo set
   - the first kept photo becomes the default primary photo in v1
   - no upload happens yet
6. If the operator chooses Discard / Retake:
   - the temporary photo is dropped
   - the session returns to live preview for the same job
   - no job completion or upload occurs
7. After at least one kept photo exists, the operator can:
   - add another photo
   - delete any previously kept photo
   - finish the job
8. The operator may continue adding photos freely up to a soft max of 10 kept photos.
9. When the operator presses Finish Job:
   - the app validates that at least one kept photo remains
   - the app uploads the final kept set
   - the app marks the parent job completed only after the full approved set uploads successfully
10. After completion:
   - local session data is cleared
   - the app returns to a clean ready/listening state for the next job

### First Photo Rules

- The first photo uses the same capture controls already established in Phase 4 and 5A.
- Keep stores the photo into a session-scoped local array instead of uploading immediately.
- Finish Job remains disabled until at least one photo has been kept.

### Repeated Photo Addition Rules

- After keeping a photo, the operator can immediately capture another photo for the same job.
- The same resolution mode applies to every photo in the session.
- Mid-job resolution switching is out of scope for v1 and should be blocked in the eventual implementation.
- The soft max of 10 should be enforced in the UI as an operator guardrail, but it should be treated as a product-level soft cap rather than a deep schema assumption.

### Review Rules for Each New Capture

Every newly captured photo goes through the same review gate:

- Keep: add to local kept-photo set and return to session summary / live capture state
- Discard / Retake: discard the temporary photo and return to capture for the same job

In v1, the review decision applies only to the newly captured photo. It does not finalize the job.

### Deleting a Previously Kept Photo

- The operator must be able to delete any previously kept photo before finishing the job.
- Deleting a kept photo removes it from the local session set.
- If the deleted photo was the current primary photo:
  - the earliest remaining kept photo becomes primary in v1
- If deletion leaves zero kept photos:
  - Finish Job becomes disabled again
  - the session remains open so the operator can capture another photo

### Finish Job Rules

- Finish Job is allowed only when the session contains at least one kept photo.
- Pressing Finish Job starts a single upload-and-complete flow for the entire kept set.
- Upload is all-or-nothing from the parent job completion perspective:
  - success means all kept photos uploaded and the parent job moved to `completed`
  - failure means the parent job does not move to `completed`

### Reset and Post-Completion Behavior

- After successful completion, the app clears all session-local captures and result state for that job.
- The app returns to a clear ready/listening state for the next job.
- Reset should not be used as an alternate completion path for an active multi-photo session in v1.
- If an operator abandons a session before finishing, the job remains in a non-completed state and should be handled by explicit failure, retry, or recovery behavior in a later implementation phase.

## Recommended App-Side Session State Model

Phase 5B implementation should evolve the single-photo state machine into an explicit multi-photo session model.

### Parent Session Concepts

- `activeJob`
  - the currently claimed parent `capture_jobs` row
- `sessionResolutionMode`
  - locked when the first capture session begins
- `keptPhotos`
  - ordered local collection of kept, not-yet-uploaded photos
- `currentReviewPhoto`
  - the most recently captured photo awaiting Keep or Discard / Retake
- `isUploadingFinalSet`
  - upload/finish gate for the whole session

### Recommended High-Level States

- `idle`
  - no active claimed job
- `listening`
  - waiting for work
- `sessionStarting(job)`
  - job claimed and session being initialized
- `capturing(job, keptCount)`
  - live preview for adding a photo to the current session
- `reviewingNewCapture(job, pendingPhoto, keptCount)`
  - newly captured photo awaiting Keep or Discard / Retake
- `sessionReady(job, keptPhotos)`
  - at least one photo kept and operator can add more, delete photos, or finish
- `uploadingFinalSet(job, keptPhotos)`
  - final approved set is uploading
- `completed(job, uploadedPhotoCount)`
  - all uploads succeeded and parent job completed
- `failed(job, message, recoverableState)`
  - capture or upload failure prevented completion

### Recommended Local Data Shape for a Future App Phase

The future implementation will likely need a session-local model more expressive than the current `LocalCaptureResult`.

Recommended fields for a local kept-photo model:

- local photo identifier
- parent `jobID`
- `capturedAt`
- `imageData` or file URL for temporary local storage
- `fileSizeBytes`
- `imageWidth`
- `imageHeight`
- `mimeType`
- `sortOrder`
- `isPrimary`
- `isSimulatorFallback` if that behavior remains useful in development

The important v1 planning choice is that kept photos remain local until Finish Job.

## Backend Schema Recommendation

## Recommended Direction

Use the preferred relational design:

- keep `public.capture_jobs` as the parent job table
- add `public.capture_job_photos` as a child table
- keep one row per successfully uploaded photo

This is the lowest-risk scalable design because it preserves the current parent job lifecycle model while adding the minimum structure needed for multi-photo storage, ordering, and future extensibility.

### Proposed `capture_job_photos` Table

Recommended columns:

- `id uuid primary key default gen_random_uuid()`
- `capture_job_id uuid not null references public.capture_jobs(id) on delete cascade`
- `sort_order integer not null`
- `is_primary boolean not null default false`
- `storage_bucket text not null`
- `storage_path text not null`
- `file_size_bytes bigint not null`
- `image_width integer null`
- `image_height integer null`
- `mime_type text not null`
- `label text null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### Recommended Constraints and Indexes

- unique constraint on `id`
- unique constraint on `(capture_job_id, sort_order)`
- partial unique index on `(capture_job_id)` where `is_primary = true`
- check that `sort_order >= 0`
- check that `storage_bucket <> ''`
- check that `storage_path <> ''`
- optional check that `label`, if present, is not blank after trim
- index on `(capture_job_id, sort_order)`

### Column Rationale

- `capture_job_id`
  - preserves the existing parent-child job model
- `sort_order`
  - represents session order and downstream display order
- `is_primary`
  - supports the locked product decision that the first kept photo is primary in v1
- `storage_bucket` and `storage_path`
  - preserve explicit object-location metadata per file
- `file_size_bytes`, `image_width`, `image_height`, `mime_type`
  - allow downstream consumers to reason about image payloads without extra storage reads
- `label`
  - optional only; keep nullable and unused in v1 unless the team wants a harmless placeholder for future front/back/side semantics

### Recommended Parent Row Treatment

Do not remove the existing parent metadata fields yet in the future backend phase. Instead:

- retain `capture_jobs.storage_bucket`, `storage_path`, `file_size_bytes`, and `mime_type` during the first multi-photo rollout for backward compatibility
- repurpose those parent single-file fields to mirror the primary photo after completion in the future migration and contract phase
- treat `capture_job_photos` as the authoritative multi-photo list

That preserves compatibility for existing downstream readers while giving the app and backend a normalized child-photo source of truth.

## Contract Semantics

### Parent Job Completion Rule

The parent `capture_jobs` row should move to `completed` only after:

- at least one kept photo exists locally
- every photo in the final approved session set uploads successfully
- the child photo rows for that final set are successfully created
- the parent completion mutation succeeds

In other words, `completed` means the entire final approved photo set is durable, not merely that one file uploaded.

### Photo Row Creation Timing

Recommended rule:

- create `capture_job_photos` rows only after each corresponding storage upload succeeds

Reasoning:

- this avoids durable photo rows pointing at missing objects
- it keeps child rows aligned with actual stored files
- it avoids needing a second cleanup path for rows representing failed uploads

For the full Finish Job flow, the recommended sequence in the later implementation phase is:

1. Parent job is already in an active claimed state.
2. Operator presses Finish Job.
3. Parent job moves into the upload phase for the final set.
4. App uploads each kept photo.
5. After each successful file upload, the backend records its `capture_job_photos` row.
6. After all photos are uploaded and recorded, the parent job is marked `completed`.

### Partial Upload Failure Rule

If any photo upload fails during Finish Job:

- the parent job must not be marked `completed`
- the failure should be surfaced to the operator
- already-uploaded files from that failed attempt may exist in storage
- child rows may exist only for photos whose uploads actually succeeded before the failure

Recommended v1 contract for the later implementation phase:

- treat the parent job as not completed
- mark the parent job `failed` if the chosen retry model does not support staying in an upload-pending state
- allow a future retry strategy to be defined explicitly rather than assumed here

Recommended planning stance for 5B.1:

- do not promise automatic rollback deletion of already-uploaded files in v1
- do not promise resumable partial upload recovery in v1
- instead, define the contract so completion remains atomic at the parent-job level

### Primary Photo Rule

- The first kept photo in session order is the default primary photo in v1.
- If the first kept photo is deleted before finish, the earliest remaining kept photo becomes primary.
- On successful final upload, the photo with `sort_order = 0` among the final set should be recorded as `is_primary = true`.
- Parent `capture_jobs.storage_*` metadata should mirror the primary photo in the first backend rollout to preserve compatibility.

### Storage Path Recommendation

Keep the current job-scoped storage structure and extend only the file naming:

- bucket: `capture-photos`
- path prefix: `{station_id}/{job_id}/`

Recommended multi-photo file pattern:

- `{station_id}/{job_id}/{sort_order}-{timestamp}-capture.jpg`

Example:

- `station-uuid/job-uuid/00-20260419T154501123Z-capture.jpg`
- `station-uuid/job-uuid/01-20260419T154532456Z-capture.jpg`

Why this is the right next-step pattern:

- it preserves existing storage policy assumptions
- it keeps all files for one job in one folder
- it preserves deterministic ordering
- it avoids requiring new bucket structure or path parsing rules

## Scope Boundaries

### In Scope for Phase 5B Overall

- define the multi-photo product workflow
- add backend support for one-to-many job photos
- evolve the app from single-photo review to local multi-photo session management
- upload the final approved set only on Finish Job
- complete the parent job only after the final set succeeds

### In Scope for Phase 5B.1 Only

- planning and source-of-truth documentation
- backend schema recommendation
- lifecycle and completion semantics
- implementation breakdown and risk mapping

### Explicitly Out of Scope for 5B.1

- app implementation changes
- migrations
- RPC changes
- storage policy changes
- current single-photo flow changes
- downstream inventory or AI integration changes

### Explicitly Out of Scope for the Initial Phase 5B Implementation

- RAW or ProRAW capture
- per-photo editing, cropping, or annotation
- unlimited photo count
- advanced photo labeling workflow
- mid-job resolution switching
- automatic upload resume after crash
- full transactional rollback of already-uploaded files
- downstream inventory generation or merchandising integration

## Recommended Implementation Breakdown

### Phase 5B.1

Multi-photo planning and schema design

- confirm workflow and session semantics
- confirm parent completion semantics
- lock recommended backend direction
- document risks and boundaries

### Phase 5B.2

Backend migration and contract update

- add `capture_job_photos`
- add indexes and constraints
- update RLS and storage-related assumptions if required
- introduce the minimum contract changes needed so the app can record multiple uploaded photos and complete the parent job safely
- preserve backward compatibility for existing parent job readers

### Phase 5B.3

App-side local multi-photo session

- replace single-photo keep-immediately-uploads behavior with session-local kept-photo management
- add session summary UI
- support repeated photo addition
- support deleting previously kept photos
- lock resolution mode for the active session

### Phase 5B.4

Final upload and completion flow

- upload all kept photos on Finish Job
- record child photo rows
- mark parent completed only after final-set success
- surface upload failure cleanly without false completion

### Phase 5B.5

Validation and hardening

- real-device multi-photo validation
- sequential job validation
- partial failure validation
- high-resolution memory/load validation
- documentation update for downstream consumers

## Risks and Edge Cases

### App Crash Before Finish Job

Risk:

- kept photos are local-only until Finish Job, so a crash may lose the session-local set if it is only kept in memory

Recommended 5B.1 stance:

- do not treat crash recovery as required for the first implementation unless the team decides temporary on-disk local persistence is necessary
- call out that in-memory-only session storage is simplest but more fragile
- if the team wants safer behavior in 5B.3, prefer temporary local file persistence per kept photo without changing backend semantics

### Zero-Photo Finish Attempt

Risk:

- the operator may try to finish without any kept photos

Recommended behavior:

- Finish Job disabled when `keptPhotos.count == 0`
- backend should also reject completion if no uploaded child rows exist for the job in the final contract phase

### Deletion of Previously Kept Photos

Risk:

- deleting a primary or middle photo can leave ordering ambiguous

Recommended behavior:

- reindex local `sort_order` after deletion before final upload
- reassign primary to the first remaining kept photo

### Partial Upload Failure

Risk:

- some files may upload before a later one fails

Recommended behavior:

- parent job remains not completed
- operator sees an actionable failure state
- implementation can choose failed-state retry semantics later, but completion must remain all-or-nothing at the parent-job level

### High Resolution Memory and Load

Risk:

- multiple high-resolution photos kept locally may increase memory pressure and upload time

Recommended behavior:

- use temporary local file-backed storage rather than holding every full-resolution image only in memory during the future app implementation
- keep the soft max at 10 in v1
- validate real-device memory and upload behavior before broad rollout

### Repeated Jobs After Session Completion

Risk:

- residual local session state could bleed into the next job

Recommended behavior:

- clear session-local kept photos, review photo, and finish/upload state immediately after completion or explicit failure handling
- preserve the existing clean return to listening behavior as a hard requirement

## Recommendation

The right next step before coding is to adopt an additive relational model:

- `capture_jobs` stays the parent lifecycle row
- `capture_job_photos` becomes the per-photo durable record
- kept photos remain local until Finish Job
- the parent job completes only after the final set uploads successfully

This is the lowest-risk design because it preserves the existing validated single-job lifecycle while adding the minimum backend structure required for multi-photo capture, ordering, primary-photo selection, and future downstream compatibility.

## Phase 5B.1 Deliverable Boundary

This document intentionally does not:

- modify Swift app behavior
- change Supabase schema
- change RPCs
- change storage paths in production
- implement upload batching

It exists so those changes can be implemented safely in the next phases without forcing premature backend or UI decisions.
