# iPhone Capture Phase 5E Active Capture UX + Auto Listen Plan

## Phase 5E.1 Agreement Gate

Reviewed for this planning pass:

- `IPHONE_CAPTURE_REPO_AUDIT.md`
- `IPHONE_CAPTURE_PHASE4_PLAN.md`
- `IPHONE_CAPTURE_PHASE5B_PLAN.md`
- `IPHONE_CAPTURE_PHASE5D_CLOSEUP_MACRO_PLAN.md`
- `OGJewelryCapture/ViewModels/ReadyViewModel.swift`
- `OGJewelryCapture/Views/ReadyView.swift`
- `OGJewelryCapture/Views/CameraPreviewView.swift`
- `OGJewelryCapture/Services/CaptureJobListener.swift`
- `OGJewelryCapture/Services/CaptureJobRepository.swift`
- `OGJewelryCapture/Services/CameraCaptureService.swift`
- `OGJewelryCapture/Models/LocalCaptureSession.swift`
- `OGJewelryCapture/Services/LocalCapturePhotoStore.swift`
- `OGJewelryCapture/Views/OGVisualStyle.swift`
- current code related to listener refresh, pending-job fetch, active job/session state, capture review, kept photos, Add Another Photo, Finish Job, Cancel Job, active-job button disabling, and capture quality / macro display

This task is planning and audit only. No app code, backend code, Supabase schema, upload contract, station routing, camera behavior, or Windows-side behavior should be changed in Phase 5E.1.

Agreed. Proceeding with Phase 5E.1 - Active Capture UX + Auto Listen Planning Audit.

## 1. Executive Summary

The app already has a working TestFlight-validated capture pipeline with station routing, realtime job intake, manual refresh, Auto/Manual capture, Standard/High Resolution/Close-Up Macro modes, local multi-photo review, kept-photo deletion, Finish Job upload, retry after upload failure, and Cancel Job.

The next operator problem is not core functionality. It is active-capture ergonomics:

- The ready screen is a vertically stacked `List`.
- During an active job, job controls, session details, kept photos, live preview, review, and bottom utility buttons appear in separate sections.
- Kept photos render as full vertical cards with large images and metadata.
- The live preview can appear below active-job and active-session sections, so after one or more kept photos the operator may scroll to return to capture controls.
- Add Another Photo and Finish Job live inside the growing session section.

Recommended direction:

- Keep the current backend, local session model, upload/finalization contract, station routing, and camera/macro behavior.
- Add Auto Listen as a persisted ready-state toggle that performs a periodic `fetchNextPendingJob` check while the app is idle/listening.
- Preserve the existing Supabase Realtime listener and manual `Refresh Listener / Jobs` button.
- Redesign the active-job UI around a capture-first surface where preview/review and primary actions are near the top, Finish Job and Cancel Job remain reachable, and kept photos appear as compact thumbnails/gallery instead of stacked full cards.

## 2. Current Listener / Refresh Behavior Audit

### How Jobs Currently Arrive

`ReadyViewModel.start()` prepares camera state, sets `captureState = .listening`, starts `CaptureJobListener`, then calls `refreshPendingJob()`.

`CaptureJobListener.startListening(stationID:onStateChange:onJobDetected:)`:

- stops any prior listener
- creates a Supabase Realtime channel named for the station
- listens to `InsertAction` and `UpdateAction` on `public.capture_jobs`
- filters events by `station_id`
- fetches the full job row by id through `CaptureJobRepository.fetchJob(id:)`
- forwards only jobs where `job.isCaptureRequestCandidate` is true

`CaptureJob.isCaptureRequestCandidate` currently means status is `queued` or `assigned`.

### What Refresh Listener / Jobs Does

The `ReadyView` bottom action labeled `Refresh Listener / Jobs` currently runs:

1. `onRefreshStations()`
2. `viewModel.refreshPendingJob()`

It does not restart the Realtime listener directly. It refreshes station data via the parent view callback, then performs a direct pending-job fetch for the selected station.

### What Manual Refresh Adds Beyond Realtime

Realtime handles insert/update events while the channel is subscribed, but manual refresh covers gaps:

- jobs that existed before the listener subscribed
- missed events during temporary connection issues
- operator-initiated recovery after uncertainty
- station refresh from the parent app state

`ReadyViewModel.start()` already performs one pending-job fetch after listener startup for the same reason.

### How Pending Jobs Are Fetched

`CaptureJobRepository.fetchNextPendingJob(for:)` selects one job from `capture_jobs` where:

- `station_id` equals the selected station
- `status` is `queued` or `assigned`
- ordered by `requested_at` ascending
- limited to 1

The returned job is passed into the same `handleIncomingJob(_:)` path used by Realtime.

### Duplicate and Active-Job Guards

`ReadyViewModel.handleIncomingJob(_:)` guards intake with:

- station id must match
- job must be `queued` or `assigned`
- `handledJobIDs` must not contain the job id
- `activeJobID` must be nil
- `canAcceptIncomingJobs` must be true

`canAcceptIncomingJobs` returns true only when `captureState` is `.idle` or `.listening` and `activeJobID == nil`. It returns false during preview, manual wait, capture, review, session ready, upload, completed, and failed states.

After a job passes guards, the view model:

- cancels any pending auto-capture task
- sets `activeJobID`
- stores `pendingJob`
- creates an empty `LocalCaptureSession`
- calls `repository.claimJobForCapture(id:)`
- only enters capture flow if the claim succeeds

If the claim is rejected, the view model returns to listening and clears the active job/session fields. This is the important server-side duplicate-claim protection.

### What Happens If Another Job Arrives While One Is Active

Realtime events or manual refresh can still deliver candidates while an active job exists, but `handleIncomingJob(_:)` ignores them because `activeJobID != nil` and `canAcceptIncomingJobs == false`.

After Finish Job or Cancel Job succeeds, the view model clears the active job/session state, returns to `.listening`, and calls `refreshPendingJob()`. That means queued jobs are picked up one at a time after the station becomes available.

### Safest Auto Listen Method

Auto Listen should be implemented as periodic pending-job fetch, not periodic listener restart and not realtime-only.

Rationale:

- The direct fetch path already exists and is used by startup, manual refresh, finish, cancel, and reset.
- The fetch path reuses the same `handleIncomingJob(_:)` claim and duplicate guards.
- Realtime should remain subscribed for low-latency events.
- Restarting the listener every interval would add churn, increase connection risk, and fight the existing channel lifecycle.
- Realtime-only does not solve the operator request because it does not provide a visible, predictable "checking" behavior for missed/pre-existing jobs.

Recommended behavior is hybrid:

- Realtime listener remains on.
- Auto Listen, when enabled, periodically calls the existing pending-job fetch only when the view model is idle/listening.
- Manual refresh remains available as an explicit operator action.

## 3. Current Active Capture UI Audit

### Top-Level ReadyView Layout

`ReadyView` is a SwiftUI `List` with conditional sections:

- station header card
- Listener section
- Capture Controls section
- Active Job section
- Active Session section
- Live Preview section
- Review Capture section
- Result section
- bottom actions section with Refresh Listener / Jobs, Change Station, and Log Out

The view uses the shared OG visual style:

- dark gradient screen background
- dark panels and elevated panels
- gold accent/tint
- `OGActionButtonStyle` for primary, secondary, and destructive actions
- `ogListChrome()` for inset grouped list styling

### Listening / Ready State

When no active job and no persistent result is showing, the UI shows:

- station header with station name, listener state, capture mode, and active quality
- Listener section with station, employee, connection, capture state, camera availability, camera path, mode, capture quality, role/device when present
- Capture Controls section with Auto/Manual picker, Capture Quality picker, Auto Delay stepper when in auto mode, and quality/macro messaging
- bottom Refresh / Change Station / Log Out actions

### Active Job Before Capture

When a job is claimed, `activeSession` is created immediately and the app transitions to `.captureRequested` for Auto or `.waitingForManualCapture` for Manual.

The UI then shows:

- station header
- Listener section
- Capture Controls section
- Active Job section with job short reference, state, Cancel Job message/button
- Active Session section, even with zero kept photos
- Live Preview section lower on the screen
- bottom utility actions

This means the camera is not the first active-job element. It appears after several sections.

### Camera Preview

The live preview appears only for `.captureRequested`, `.waitingForManualCapture`, and `.capturing`.

It is rendered in a `Live Preview` section with:

- `CameraPreviewView`
- fixed height of 320
- rounded clipping
- zoom badge when zoom is available
- tap-to-focus / pinch hint
- `Capture Photo` button only in manual mode

Because the preview section comes after the Active Session section, it moves farther down as kept-photo content grows.

### Review After Capture

For `.reviewingCapture`, the top header and listener/control sections are hidden. The `Review Capture` section shows:

- captured preview image
- station, connection, capture state, mode, capture quality
- latest local result metadata
- explanatory text
- Keep button
- Discard / Retake button

Cancel Job is not visible in the review branch because the Active Job section is rendered only when `!viewModel.isReviewingCapturedPhoto`.

### Session With Kept Photos

`Active Session` shows:

- job reference
- kept photo count
- capture quality
- primary photo number
- for each kept photo: large preview image, photo label, primary badge, captured time, file size, dimensions, MIME type, simulator fallback message, Delete Photo button
- Add Another Photo after kept photos exist
- Finish Job
- finish/retry message

This is the main scrolling problem. Every kept photo adds a full-size vertical card with image and metadata before the operator reaches Add Another Photo or Finish Job.

### Upload / Finalization

During `.uploadingFinalSet`, the Active Session section remains visible with kept photos and Finish Job disabled because `activeSession.isUploadingFinalSet` is true. The Capture Controls section shows explanatory upload text. Cancel Job is disabled while uploading.

On successful completion, current code clears the local session and returns `captureState` to `.listening` with a success message. On upload failure, the active session is preserved and the UI returns to `.sessionReady` for retry.

### Cancellation / Failure

Cancel Job is available from the Active Job section for active jobs except while uploading. It calls `markFailed` with `cancelled_by_operator`, clears local session photos, stops/reprepares camera, returns to listening, and fetches the next pending job.

Persistent `.failed` state shows a Result section with failure message and Reset. Some failures preserve active state if the backend rejects the failure transition.

### Current Button Locations

- Keep: inside `Review Capture`
- Discard / Retake: inside `Review Capture`
- Add Another Photo: near the bottom of `Active Session`, after all full kept-photo cards
- Finish Job: below Add Another Photo in `Active Session`
- Cancel Job: in `Active Job`, hidden during captured-photo review and disabled during upload
- Refresh Listener / Jobs: bottom utility section

## 4. Capture-First UI Recommendation

### Product Goal

When a job is active, the first screen should feel like a capture station:

- camera or current review image immediately visible
- primary action close to the image
- job and mode context compact
- kept-photo count always visible
- Finish Job and Cancel Job reachable without long scrolling
- kept photos visible as thumbnails/gallery, not stacked cards

### Recommended Architecture

Keep the ready/listening screen mostly as-is, but branch active-job rendering into a dedicated capture-first layout.

Recommended implementation direction:

- In `ReadyView`, render a separate active-job surface when `viewModel.hasActiveJob && !viewModel.isShowingPersistentResult`.
- Put compact active-job header first: job short id, station, capture mode, quality/macro mode, camera path if useful, and `Photos: n/10`.
- Put the media surface immediately below: live `CameraPreviewView` for capture states, captured image for review, upload/progress summary for finalization.
- Put primary actions immediately below the media surface.
- Use a compact bottom or near-bottom action row for Finish Job and Cancel Job.
- Move detailed session metadata and full photo management into a thumbnail gallery/detail sheet.

Do not rely primarily on auto-scroll to fix the problem. Auto-scroll can be a helpful polish when a job starts, but the durable solution is to make the active-job layout camera-first.

### A. Active Capture State

Applies to `.captureRequested`, `.waitingForManualCapture`, and `.capturing`.

Visible without scrolling:

- job short id
- station name
- Auto or Manual
- Standard, High Resolution, or Close-Up / Macro
- camera path / macro fallback message when relevant
- photo count, for example `Photos: 2/10`
- live camera preview
- Capture Photo button in Manual mode
- Auto capture status/delay in Auto mode
- Finish Job disabled until at least one photo is kept
- Cancel Job available unless upload is in progress
- compact thumbnail strip/grid if photos already exist

Recommended action behavior:

- Manual mode: primary button is `Capture Photo`.
- Auto mode: primary area shows that auto capture is pending, with Retake/Cancel not shown until review.
- If kept count is greater than zero, Finish Job should be visible and enabled outside of upload.
- If kept count is zero, Finish Job should remain visible but disabled with concise helper text or disabled styling.

### B. New Capture Review State

Applies to `.reviewingCapture`.

Visible without scrolling:

- captured preview image in the same media area where live preview was
- job short id, station, mode, quality
- current kept count
- Keep
- Discard / Retake
- Cancel Job
- optional thumbnail strip of already kept photos

After Keep:

- append to the existing local session exactly as today
- return directly to active capture or a compact session-ready state without forcing a scroll
- preferred operator flow is "Keep, then camera is ready for the next photo" if under the soft max

Implementation note: current `keepCapturedPhoto()` moves to `.sessionReady`. In the future UI phase this can remain logically true while the UI renders session-ready as a compact capture station with `Add Another Photo` prominent, or the view model can be adjusted later to transition directly back to capture after Keep if product validation confirms that as the desired default. Lowest-risk first UI work should avoid changing the capture state machine unless needed.

### C. Kept-Photo Management

Replace the full vertical kept-photo cards during active capture with compact thumbnails.

Recommended v1 gallery:

- horizontal thumbnail strip near the media/actions area, or a compact 2-3 column grid below primary controls
- show photo number and primary badge/check on the thumbnail
- tapping a thumbnail opens a sheet/detail view with larger image, captured time, size, dimensions, type, simulator fallback note, and Delete Photo
- deletion should call the existing `deleteKeptPhoto(_:)`
- preserve existing reindex behavior where the earliest remaining photo becomes primary
- preserve `LocalCaptureSession` and `LocalSessionPhoto` as the data model unless thumbnail performance requires a tiny view-only cache later

Kept photos should be shown as thumbnails, not hidden and not stacked as full cards. Hiding them entirely would reduce operator confidence, while full cards create the current scroll problem.

### D. Finish Workflow

Finish Job should remain available once at least one photo is kept.

Keep current behavior:

- Finish Job uploads all kept photos in order.
- Each photo is recorded through `recordCaptureJobPhoto`.
- Parent job is completed through `completeCaptureJobMultiPhoto`.
- Upload failure preserves the local session and returns to a retryable `.sessionReady`.
- No backend or upload contract changes are needed for this UX phase.

Recommended UI:

- show Finish Job near preview/actions as a persistent secondary primary action
- disable while zero kept photos or while uploading
- during upload, replace capture controls with clear finishing status and keep Cancel disabled

## 5. Auto Listen Toggle Recommendation

### Recommended Behavior

Add an `Auto Listen` toggle in the ready/listening area.

When ON:

- periodically call the existing `refreshPendingJob()` / repository fetch path
- initial interval: 5 seconds for TestFlight/operator validation
- consider 10 seconds later if network load or operator feedback suggests it
- skip polling while any active job/session/review/upload/failure result is blocking intake
- resume polling when the view model returns to idle/listening
- do not start or claim a new job when `activeJobID` exists

When OFF:

- preserve current manual refresh behavior
- keep Realtime listener running exactly as it does now

### Where State Should Live

Add state to `ReadyViewModel` in a future implementation phase:

- `@Published var isAutoListenEnabled`
- `@Published private(set) var autoListenStatus`
- `@Published private(set) var lastAutoListenCheckAt`
- private polling task/timer, for example `autoListenTask: Task<Void, Never>?`
- persisted user default key, for example `ready.autoListenEnabled`

The view model is the correct owner because it already owns listener startup/shutdown, station identity, pending-job fetch, active-job guards, and lifecycle cleanup.

### Persistence

Auto Listen should persist across app launches as a station/operator device preference.

Recommended default:

- default OFF for the first rollout if the team wants maximum conservatism
- acceptable alternative: default ON after operator approval, since operators explicitly requested it

For lowest-risk rollout, start OFF and let operators enable it. Persist their choice in `UserDefaults` similar to capture mode, quality, and auto delay.

### Startup Timing

When the view model starts after login/station selection:

- start the Realtime listener as today
- perform the existing one-time pending-job refresh as today
- if Auto Listen is enabled, start the polling loop after initial setup

Polling should be station-scoped. When station changes or the view disappears, stop the loop. A new `ReadyViewModel` for the new station can start its own loop from persisted state.

### Avoiding Duplicate Claims

Use the existing single intake path:

- Auto Listen fetches the oldest queued/assigned job.
- It passes the job into `handleIncomingJob(_:)`.
- `activeJobID`, `canAcceptIncomingJobs`, candidate status, and backend `claimJobForCapture` continue to protect the station.

Do not add a second claim path. Do not locally mutate job status outside the existing repository/RPC methods.

### Manual Refresh While Auto Listen Is ON

Manual `Refresh Listener / Jobs` should remain visible when Auto Listen is ON.

Recommended label/status:

- show toggle: `Auto Listen`
- show status text such as `Checking every 5s`
- show `Last checked: 2:14 PM` when available
- keep button label as `Refresh Listener / Jobs` or shorten to `Refresh Now`

Manual refresh is useful for operator confidence and should simply trigger the same fetch path immediately. The polling loop should tolerate a manual refresh happening between ticks.

### Multiple Queued Jobs

If Auto Listen finds multiple queued jobs, it should process only the oldest one returned by `fetchNextPendingJob(for:)`.

After that job is finished or cancelled, the existing post-completion/post-cancel `refreshPendingJob()` should pick up the next oldest job. The polling loop may also find it on its next eligible tick.

Do not batch-claim multiple jobs. The phone is a single active capture station.

## 6. Safety and State Machine Considerations

Required safety rules for future implementation:

- No new job interrupts an active job.
- Auto Listen never runs a separate claim path.
- Auto Listen does not restart or replace the existing Realtime listener.
- Manual refresh remains available whether Auto Listen is on or off.
- Polling skips while `hasActiveJob` is true.
- Polling skips during `.captureRequested`, `.waitingForManualCapture`, `.capturing`, `.reviewingCapture`, `.sessionReady`, `.uploadingFinalSet`, `.completed`, and `.failed`.
- Polling can run only during `.idle` or `.listening`, matching `canAcceptIncomingJobs`.
- Timers/tasks stop in `stop()` and `deinit`.
- Station changes stop the current view model and therefore stop polling.
- Logout stops polling through the same view disappearance/view-model stop path.
- Cancel and Finish return the app to listening safely and can then resume polling.
- Upload failure should not allow polling because the active session is still recoverable.
- Failure result screens should not accept new jobs until reset/clear behavior returns the app to listening.
- No backend, schema, or Supabase policy changes are required for Auto Listen.

Recommended polling implementation detail:

- Use a single cancellable `Task` loop in `ReadyViewModel`, not a repeating UIKit timer in the view.
- Each loop tick should check `Task.isCancelled`, sleep for the configured interval, then on the main actor verify Auto Listen is still enabled and intake is allowed.
- Avoid overlapping fetches with a small `isAutoListenChecking` flag.
- Set `lastAutoListenCheckAt` in a `defer` after each attempted fetch.
- If fetch fails, show non-blocking Auto Listen status and avoid overwriting an active job error unless the app is idle/listening.

## 7. Recommended Implementation Breakdown

### Phase 5E.1 - Planning / Audit

- Create this document.
- Audit current listener, refresh, active-job UI, local session, and capture workflow.
- Make no Swift/backend/workflow changes.

### Phase 5E.2 - Auto Listen Toggle

- Add persisted `Auto Listen` state to `ReadyViewModel`.
- Add a cancellable polling loop that calls the existing pending-job fetch path every 5 seconds while idle/listening.
- Preserve the Realtime listener.
- Preserve manual Refresh Listener / Jobs.
- Display status: on/off, interval, last checked, checking/error when useful.
- Test no duplicate claims with Realtime and polling both active.
- Test station change, logout, view disappearance, finish, cancel, upload failure, and reset behavior.

### Phase 5E.3 - Capture-First Active Job UI

- Refactor `ReadyView` active-job rendering into a camera-first active surface.
- Place compact job/mode/count header at the top.
- Place live preview or captured review image immediately below.
- Keep primary actions close to the media area.
- Keep Finish Job and Cancel Job visible/reachable without long scrolling.
- Preserve current view-model workflow initially unless a tiny state transition change is needed.

### Phase 5E.4 - Thumbnail Gallery / Kept-Photo Management Polish

- Replace full kept-photo cards in the active flow with compact thumbnails.
- Add thumbnail detail sheet/modal for large review and metadata.
- Preserve `deleteKeptPhoto(_:)`, reindexing, primary-photo behavior, local storage, and soft max.
- Consider lazy thumbnail loading or cached preview images only if performance requires it.

### Phase 5E.5 - Validation / TestFlight Feedback

- Validate with operators on real devices.
- Confirm Auto Listen interval feels right.
- Confirm repeated multi-photo capture no longer requires long scrolling.
- Confirm Finish Job, Cancel Job, retry, delete, macro mode display, and station routing remain intact.
- Adjust wording, layout density, and interval after operator feedback.

## 8. Explicit Recommendations

1. Auto Listen should use hybrid behavior: keep Realtime listener plus periodic pending-job polling. It should not be realtime-only and should not restart the listener repeatedly.
2. Initial interval should be 5 seconds for validation. Consider 10 seconds for production only if needed.
3. Auto Listen state should persist across app launches in `UserDefaults`.
4. Manual Refresh should remain visible when Auto Listen is ON.
5. If multiple jobs are queued, process only the oldest fetched job; pick up the next one after finish/cancel/listening resumes.
6. Active capture UI should be reorganized into a capture-first surface with compact header, media area, nearby primary controls, visible Finish/Cancel, and compact session summary.
7. Kept photos should be shown as thumbnails/gallery during capture, with full review/delete in a sheet or detail view.
8. The app should not rely on auto-scroll as the main fix. The active-job layout itself should place the camera/review first. Auto-scroll on job start is optional polish.
9. Lowest-risk sequence is: planning, Auto Listen polling, capture-first active layout, thumbnail gallery, operator validation.

## 9. Out of Scope

Phase 5E should not:

- change Supabase schema
- change backend functions or storage policies
- change upload/completion contract
- change station routing
- change camera/macro implementation
- change Windows-side behavior
- remove existing manual refresh or Realtime listener behavior
- remove existing capture, review, delete, retry, Finish Job, or Cancel Job functionality

## 10. Validation Checklist for Future Phases

Auto Listen:

- Auto Listen off preserves current behavior.
- Auto Listen on finds a pre-existing queued job without tapping Refresh.
- Realtime still detects newly inserted/updated jobs.
- Manual Refresh still works while Auto Listen is on.
- Polling pauses during active capture, review, session ready, upload, failure result, and upload retry state.
- Polling resumes after successful finish, successful cancel, or reset to listening.
- Station change and logout stop polling.
- No duplicate active jobs are claimed under rapid Realtime + polling events.

Capture-first UI:

- Job starts with camera preview visible near the top.
- Manual Capture Photo is reachable without scrolling.
- Auto mode status is visible near preview.
- Keep and Discard / Retake are reachable without scrolling.
- Cancel Job is reachable during capture and review.
- Finish Job is visible and disabled with zero kept photos.
- Finish Job is visible and enabled after at least one kept photo.
- After Keep, operator can continue without scrolling through full kept-photo cards.
- Thumbnails show kept photos compactly.
- Thumbnail delete preserves reindex and primary-photo behavior.
- Upload failure preserves retry session.
- Close-Up / Macro label and camera path/fallback messaging remain visible enough for operators.

## 11. Phase 5E.1 Completion Statement

Phase 5E.1 is complete when this document exists as the source-of-truth planning artifact and no Swift, backend, migration, upload, station-routing, camera, or Windows-side workflow files have been changed for this task.
