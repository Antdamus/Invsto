# iPhone Capture Phase 5F.4.1 Newest Signal Queue Policy Plan

## Agreement Gate

Reviewed for this revision:

- `IPHONE_CAPTURE_PHASE5F_NEWEST_SIGNAL_QUEUE_POLICY_PLAN.md`
- `IPHONE_CAPTURE_REPO_AUDIT.md`
- `IPHONE_CAPTURE_PHASE5B_PLAN.md`
- `IPHONE_CAPTURE_PHASE5E_ACTIVE_CAPTURE_UX_PLAN.md`
- `OGJewelryCapture/ViewModels/ReadyViewModel.swift`
- `OGJewelryCapture/Services/CaptureJobRepository.swift`
- `OGJewelryCapture/Services/CaptureJobListener.swift`
- `OGJewelryCapture/Models/LocalCaptureSession.swift`
- Supabase migrations and RPCs for `capture_jobs`, `capture_job_photos`, `update_capture_job_lifecycle(...)`, `record_capture_job_photo(...)`, and `complete_capture_job_multi_photo(...)`

This task is limited to revising the plan, updating the recommended policy, and defining required backend/app implementation phases. No Swift code, SQL migration, schema, RPC, backend behavior, app behavior, queue behavior, upload behavior, session behavior, camera behavior, or UI behavior is changed in Phase 5F.4.1 Revision.

Agreed. Proceeding with Phase 5F.4.1 Revision – Final Upload Target Newest Signal Policy Plan.

## Executive Summary

The previous version of this plan recommended newest-before-capture only and advised against changing job IDs at Finish Job. Stakeholder direction has changed: because Windows keeps the operator locked on the same inventory item, repeated same-station capture jobs are duplicate signals for that item. The final upload target must now be the newest valid queued or assigned signal for the station at Finish Job time.

Revised source-of-truth policy:

- Select the newest valid signal before capture starts.
- Keep captured photos local until Finish Job, as the app already does.
- Immediately before the first photo upload starts, resolve the final upload target again.
- If a newer valid queued or assigned job exists, atomically supersede the original active job and intermediate duplicate jobs, claim the newest job for the current handler, and upload the local photos under that newest job ID.
- If no newer valid job exists, keep the originally active job as the final upload target and supersede older pending duplicates.
- Once upload starts, the final target job ID is locked and must not change.
- If upload fails after a final target is chosen, retry must continue using that same final target job ID.

This is not safe to implement app-side with the current RPCs alone. A new atomic Supabase RPC is required before app retargeting is implemented.

## 1. Current Queue Behavior

`CaptureJobRepository.fetchNextPendingJob(for:)` currently reads `capture_jobs` for a station, filters to `queued` or `assigned`, orders by `requested_at` ascending, and limits to one row. This means the current direct fetch path is oldest-first.

The direct fetch path is used by:

- startup after listener subscription
- manual `Refresh Listener / Jobs`
- Auto Listen polling
- post-finish refresh
- post-cancel refresh
- reset recovery

`CaptureJobListener` subscribes to insert and update events on `public.capture_jobs` filtered by `station_id`. For each event, it fetches the full job row and forwards it only when `CaptureJob.isCaptureRequestCandidate` is true, which currently means `queued` or `assigned`.

`ReadyViewModel.handleIncomingJob(_:)` prevents duplicate active work locally:

- station id must match
- job must be a capture request candidate
- `handledJobIDs` must not contain the job id
- `activeJobID` must be nil
- `canAcceptIncomingJobs` must be true

`canAcceptIncomingJobs` is true only while idle/listening with no active job. Realtime events or manual refreshes that arrive during an active session are ignored by the app and handled later only after the station returns to listening.

## 2. Current Claim Lifecycle

The app claims a job in `handleIncomingJob(_:)`.

Before the server claim returns, the view model stores:

- `activeJobID = job.id`
- `pendingJob = job`
- `activeSession = LocalCaptureSession(jobID: job.id, ...)`

It then calls `CaptureJobRepository.claimJobForCapture(id:)`, which calls `update_capture_job_lifecycle(...)` with target status `capturing`.

The current lifecycle RPC claim transition:

- only allows jobs in `queued` or `assigned`
- sets status to `capturing`
- sets `claimed_at`
- sets `capture_started_at`
- clears failure metadata
- writes handler metadata into `result_payload`

The server row status plus handler metadata is the durable claim. `activeJobID` is the app-side active-work lock.

Current limitation: `update_capture_job_lifecycle(...)` can mark `failed` only from `capturing` or `uploading`, and only for the handler user. It cannot safely supersede old `queued` or `assigned` duplicates.

## 3. Current Finish / Upload Lifecycle

The app already has the key property that makes Finish Job retargeting possible: kept photos remain local until the operator taps Finish Job.

Current `ReadyViewModel.performFinishJob(for:session:)`:

- validates an active `pendingJob`
- validates `activeSession.jobID == pendingJob.id`
- marks the local session as uploading
- calls `ensureUploadingForMultiPhotoRetry(id:captureCompletedAt:)`
- uploads each local `LocalSessionPhoto`
- records each uploaded photo through `record_capture_job_photo(...)`
- finalizes the parent through `complete_capture_job_multi_photo(...)`

Current upload and finalization are keyed to the original job id:

- `CapturePhotoUploadService.uploadSessionPhoto(...)` builds storage paths from `photo.jobID`
- storage paths currently look like `{station_id}/{job_id}/{sort_order}-{timestamp}-capture.jpg`
- `record_capture_job_photo(...)` requires the parent job to be `uploading`
- `record_capture_job_photo(...)` verifies the storage path station id and job id match the parent job
- `complete_capture_job_multi_photo(...)` finalizes that same parent job

For the revised policy, future app code must resolve a final target job before upload and then use that final job id consistently for storage paths, child rows, parent finalization, success UI, cleanup, and retry state.

## 4. Revised Final Upload Target Policy

The final job ID used for upload must be resolved at Finish Job time.

Detailed rule:

1. The app may start capture under Job A.
2. Photos captured during the session remain local until Finish Job.
3. When the operator taps Finish Job, before any photo upload starts, the app calls a backend RPC to resolve the final target.
4. The RPC checks whether a newer valid `queued` or `assigned` job exists for the station.
5. If a newer job exists, the RPC supersedes Job A and all older duplicate pending jobs, claims the newest job for the current handler, and returns that newest job as the final upload target.
6. If no newer job exists, the RPC keeps Job A as the final upload target, transitions or confirms it for upload, supersedes older duplicate pending jobs, and returns Job A.
7. The app uploads every kept local photo under the returned final target job id.
8. Once the first upload begins, the target job id must not change again.

Retargeting is allowed only before the first photo upload starts.

This is a controlled retarget, not a mid-upload migration. No already uploaded photo should ever be moved, rewritten, or reparented by app logic.

## 5. Backend / RPC Requirement

The revised policy requires backend support before app implementation.

Recommended design:

- one atomic RPC for resolving the final upload target at Finish Job
- one separate atomic RPC for newest-before-capture intake, unless the final-target RPC can be generalized cleanly without confusing the lifecycle

Do not implement Finish Job retargeting as a sequence of independent app calls. The handoff touches multiple jobs and must not leave the original active job stuck in `capturing`.

### RPC 1: Claim Newest Before Capture

Purpose: when the station is idle/listening, select the newest valid signal and clean up older duplicates before capture starts.

Recommended behavior:

- receive station id
- authenticate active employee
- lock relevant `queued` and `assigned` station jobs
- choose newest by `requested_at desc`, with deterministic tie-breakers such as `created_at desc` and `id`
- mark older `queued` or `assigned` jobs as superseded
- claim newest job as `capturing` for the current handler
- return the claimed job row or enough fields for the app to proceed

This avoids Realtime event order and oldest-first fetch order defining business behavior.

### RPC 2: Resolve Final Upload Target

Purpose: immediately before upload, atomically decide which job receives the photos.

Recommended parameters:

- station id
- current active job id
- optional expected current active status, likely `capturing`
- optional current handler/user context inferred from `auth.uid()`
- optional captured photo count for audit or guardrails

Recommended behavior:

- authenticate active employee
- lock the current active job row
- verify the current active job belongs to the station
- verify the current active job is handled by this user
- verify the current active job is in a resolvable state, normally `capturing`
- lock valid pending duplicate jobs for the station
- find newest valid `queued` or `assigned` job for the station
- compare newest pending job with the current active job by `requested_at`, with deterministic tie-breakers
- if a newer pending job exists:
  - mark the current active job as superseded
  - mark older and intermediate `queued` or `assigned` jobs as superseded
  - claim the newest job for the current handler
  - move the newest job to `uploading` or return it for a subsequent existing uploading transition
  - return the newest job as final upload target
- if no newer pending job exists:
  - keep the current active job as final upload target
  - mark older queued or assigned duplicates as superseded
  - move or confirm the current active job as `uploading`
  - return the current job as final upload target
- never modify `completed` jobs
- never supersede unrelated `uploading` jobs
- never leave the original active job in `capturing` when it is not the final upload target
- return enough data for the app to upload under the final target job id

Preferred return shape:

- final target job id
- final target requested_at
- whether the target switched
- original active job id
- list or count of superseded job ids
- final target status, preferably already `uploading`
- short operator/debug message

Recommendation: the final-target RPC should move the final target to `uploading` inside the same transaction. That removes the race between final-target resolution and `ensureUploadingForMultiPhotoRetry(...)`. After this RPC succeeds, the app can upload and then call the existing `record_capture_job_photo(...)` and `complete_capture_job_multi_photo(...)` against the returned final target.

## 6. Superseded Job Semantics

Use an explicit terminal state. Do not silently ignore duplicate jobs and do not leave them queued.

Recommended state:

- `status = 'failed'`
- `failure_code = 'superseded_by_newer_request'`
- `failure_message = 'Superseded by newer capture request for this station.'`

For the originally active job replaced at Finish Job, use a distinct code:

- `failure_code = 'superseded_by_newer_request_at_finish'`
- `failure_message = 'Superseded at Finish Job by newer capture request for this station.'`

Reason for distinction:

- pending duplicates superseded before capture are normal queue cleanup
- an active job superseded at Finish Job is a more important lifecycle event
- Windows/admin tooling can report the two cases differently
- no schema change is required

Recommended `result_payload` metadata for superseded jobs:

- `superseded_by_job_id`
- `superseded_at`
- `superseded_reason`
- `original_active_job_id` when applicable
- `handler_user_id` and `handler_employee_id` when the current handler caused the supersede
- `capture_client = 'iphone_app'`

No schema change is preferred for Phase 5F.4.2. `result_payload` is sufficient for audit metadata unless Windows reporting later needs indexed supersede relationships.

## 7. App Retargeting Behavior

Future app implementation should treat the local session photos as source media and the RPC-returned final target as the upload destination.

Important behavior:

- local files do not need to move on disk
- local photo metadata can retain original capture timestamps, dimensions, MIME type, sort order, and primary flag
- upload service must be able to build object paths with a final target job id rather than always using `LocalSessionPhoto.jobID`
- storage paths must use `{station_id}/{final_job_id}/{sort_order}-{timestamp}-capture.jpg`
- `capture_job_photos.capture_job_id` must be the final target job id
- `complete_capture_job_multi_photo(...)` must finalize the final target job id
- `latestUploadResult.jobID` should be the final target job id
- local cleanup must clear the local session that was created under the original job id

Likely Swift files for later implementation:

- `OGJewelryCapture/ViewModels/ReadyViewModel.swift`
- `OGJewelryCapture/Services/CaptureJobRepository.swift`
- `OGJewelryCapture/Services/CapturePhotoUploadService.swift`
- `OGJewelryCapture/Services/CaptureJobListener.swift`, if Realtime events become triggers for backend newest-selection rather than direct job acceptance
- `OGJewelryCapture/Models/LocalCaptureSession.swift`, only if the app needs to persist `finalTargetJobID` or upload retry state in the session model

The cleanest app-side shape is likely a small final-target state object stored by the view model after the first Finish Job attempt succeeds, containing:

- original active job id
- final target job id
- whether target switched
- final target job reference
- superseded count or ids for diagnostics
- resolution timestamp

## 8. Intake-Time Newest Selection

Newest-before-capture remains required.

When the app is idle/listening and multiple valid pending jobs exist:

- choose the newest
- supersede older pending duplicates
- claim the newest
- start capture under that newest job

Startup, manual refresh, Auto Listen, post-cancel refresh, post-completion refresh, and Realtime-triggered intake should all use the same newest-selection path. Realtime should be treated as a signal to run newest-selection, not as proof that the event row is the correct job to claim.

## 9. Safety Rules

The implementation must follow these safety rules:

- once upload starts, target job cannot change
- retargeting is allowed only before the first photo upload starts
- if final target resolution fails, do not upload
- if final target resolution switches jobs, the original active job must be terminal/superseded
- if upload fails after final target is chosen, retry must continue using the same final target
- do not re-resolve to an even newer job during retry
- do not leave older queued jobs pending
- do not leave the original active job stuck in `capturing`
- do not silently drop jobs without status metadata
- do not mutate or reparent already uploaded photos
- do not allow final target resolution while another upload is already in progress
- do not let Realtime event order override the backend-selected newest job

## 10. Failure / Retry Behavior

Required retry policy:

1. On the first Finish Job tap, resolve the final upload target.
2. Once the final target is chosen, store it in active upload/retry state.
3. Upload and finalization use that final target.
4. If upload or finalization fails, retry uses the same final target job id.
5. Retry must not check for a newer job again.

Reason:

- the target resolution already made a server-side lifecycle decision
- the original active job may already be superseded
- some photos may already have uploaded to the chosen final target
- switching again during retry could split one local photo set across multiple parent jobs
- fixed retry target preserves all-or-nothing parent completion semantics

If the app loses memory of the chosen final target after a crash, recovery should be designed separately. A conservative future recovery strategy is to inspect server state for the original active job and final target metadata in `result_payload`, then either resume the known final target or require operator/admin intervention.

## 11. Biggest Risks

The revised policy is implementable, but it is riskier than newest-before-capture only.

Main risks:

- orphaning the original active job if final-target handoff is not atomic
- uploading to a job that was not successfully claimed for the current handler
- storage path and `capture_job_photos.capture_job_id` mismatch
- retry accidentally resolving to a different newer job
- Windows expecting one job id while the app completes another without clear supersede metadata
- duplicate Realtime events racing with manual refresh or Auto Listen
- app crash after final target resolution but before all uploads complete
- downstream reporting treating superseded `failed` rows as real failures unless `failure_code` is handled

These risks are why backend/RPC work must precede app behavior changes.

## 12. Required Questions Answered

1. How does newest signal before capture work?

When idle/listening, the app calls a backend newest-selection path. The backend locks station pending jobs, claims the newest valid `queued` or `assigned` job, marks older pending duplicates superseded, and returns the claimed job for capture.

2. How does newest signal at Finish Job work?

On first Finish Job tap, before any upload, the app calls an atomic final-target RPC. The RPC compares the current active job with newer valid pending jobs for the station, chooses the newest valid signal, supersedes duplicates, prepares the final target for upload, and returns the final job id. The app uploads all local photos under that returned job id.

3. What happens to the originally claimed job if a newer job exists at Finish Job?

It is marked terminal/superseded, recommended as `failed` with `failure_code = 'superseded_by_newer_request_at_finish'`, and `result_payload` records the final target job id and supersede metadata.

4. What happens to intermediate jobs?

Intermediate `queued` or `assigned` jobs are marked superseded, recommended as `failed` with `failure_code = 'superseded_by_newer_request'`.

5. When is the final target job ID locked?

Immediately after the final-target RPC succeeds and before the first photo upload starts.

6. What happens if upload fails after final target job is chosen?

The local photo session is preserved for retry, and retry continues uploading/finalizing the same final target job id.

7. Should retry re-check for a newer job or stay with the chosen target?

Retry should stay with the chosen target. It should not re-check for a newer job.

8. What new RPCs are required?

At minimum, an atomic `resolve final upload target` RPC is required. A separate `claim newest before capture` RPC is also recommended so intake behavior is consistent and race-safe.

9. Can this be done without schema changes?

Yes, likely. Use `status = 'failed'`, existing failure fields, and `result_payload` metadata. A schema change is not required unless later Windows reporting needs indexed supersede relationships.

10. Which Swift files likely need changes later?

Likely `ReadyViewModel.swift`, `CaptureJobRepository.swift`, and `CapturePhotoUploadService.swift`. `CaptureJobListener.swift` may change if Realtime becomes a trigger for newest-selection. `LocalCaptureSession.swift` changes only if final target or retry state belongs in that model.

11. What are the biggest risks?

Atomicity, orphan active jobs, path/job mismatches, retry target drift, Realtime races, crash recovery after target resolution, and downstream interpretation of superseded failed rows.

12. What manual validation is required?

See Phase 5F.4.5 below.

## 13. Revised Implementation Breakdown

### Phase 5F.4.1 Revision - Plan Update

- Revise this document only.
- Make no code, schema, RPC, migration, or behavior changes.
- Establish newest-at-Finish as the stakeholder-required source-of-truth policy.

### Phase 5F.4.2 - Backend / RPC Support

- Add atomic RPC for newest-before-capture selection and claiming.
- Add atomic RPC for final upload target resolution.
- Mark superseded pending duplicates with terminal failure metadata.
- Mark original active job superseded at finish when a newer final target wins.
- Prefer moving the final target to `uploading` inside the final-target RPC.
- Preserve existing `record_capture_job_photo(...)` and `complete_capture_job_multi_photo(...)` contracts if possible.

### Phase 5F.4.3 - App Queue Intake Update

- Replace oldest-first pending fetch behavior with the newest-before-capture RPC.
- Use the same path for startup, manual refresh, Auto Listen, post-finish refresh, post-cancel refresh, and reset.
- Treat Realtime events as triggers to run newest-selection while idle/listening.
- Preserve existing active-job guards during active capture.

### Phase 5F.4.4 - App Finish Job Retargeting

- On first Finish Job tap, call the final-target RPC before upload.
- Store the returned final target in upload/retry state.
- Upload local photos using final target job id in storage paths.
- Record `capture_job_photos` rows under final target job id.
- Complete final target parent job.
- Preserve retry against the same final target if upload/finalization fails.
- Do not re-resolve during retry.

### Phase 5F.4.5 - Validation

Manual validation must cover:

- one queued job still captures and completes normally
- multiple signals before capture: newest is claimed, older jobs are superseded
- multiple rapid Realtime inserts while idle: newest wins independent of event order
- Auto Listen uses newest-selection and does not process oldest first
- multiple signals during active capture: active capture continues locally
- Finish Job with newer pending jobs: final target switches to newest
- original active job is terminal/superseded after target switch
- intermediate jobs are terminal/superseded
- no photos upload to superseded jobs
- storage paths contain final target job id
- `capture_job_photos.capture_job_id` is final target job id
- parent completion is final target job id
- upload failure after target switch preserves local session
- retry uses same final target and does not re-resolve
- cancel active job still marks the active job cancelled/failed appropriately before final target resolution
- Windows retrieves photos and completion state from the final newest job
- downstream/admin views distinguish superseded failures from real capture failures by `failure_code`

## 14. Verification Notes For This Revision

Modified document:

- `IPHONE_CAPTURE_PHASE5F_NEWEST_SIGNAL_QUEUE_POLICY_PLAN.md`

No Swift files changed.

No SQL or migration files changed.

No backend behavior changed.

No app behavior changed.

Phase 5F.4.1 Revision – Final Upload Target Newest Signal Policy Plan is complete.
