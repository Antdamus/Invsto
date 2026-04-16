# iPhone Capture Phase 4 Plan

## Recommended Phase Name

Phase 4: Capture Control UX + Ready-State Polish

## Why This Should Happen Next

The repo already has a working end-to-end capture pipeline on real hardware. The most valuable next work is not a broad architectural rewrite. It is a tightly scoped operator-experience pass that addresses the three real-world issues discovered during device validation:

- auto capture feels too fast
- there is no manual capture option
- the post-capture screen does not reset cleanly for the next job

These are direct workflow issues on top of an otherwise functioning pipeline. Addressing them next is lower risk than shifting attention to larger hardening or expansion efforts first, because the work can stay mostly within the capture client and preserve the current backend contracts.

## Sequencing Recommendation

Capture-control UX should come before broad reliability hardening, Windows integration expansion, and TestFlight prep.

Reasoning:

- The core pipeline is already proven enough to refine operator behavior safely.
- The current pain points affect every real capture, so they have immediate user value.
- This work can likely be done without changing `capture_jobs`, storage paths, or the current lifecycle RPC contract.
- Broader hardening and release prep will be more useful after the intended operator interaction model is settled.

Recommended order after this planning reset:

1. Phase 4: Capture Control UX + Ready-State Polish
2. Phase 5: Reliability Hardening + Diagnostics
3. Windows integration contract doc / workflow expansion
4. TestFlight readiness and release packaging

## Goal

Improve the operator capture experience while preserving the already working core flow:

- queued job arrives
- phone handles the job
- photo is captured
- image uploads to `capture-photos`
- `capture_jobs` is updated to completed or failed

## Scope

### Included Work

- make pre-shutter timing configurable in the app
- support an optional manual capture mode
- clean up ready-state behavior after success/failure so the UI is clearly prepared for the next job
- preserve realtime listening and the existing lifecycle transitions
- preserve current Supabase schema and storage contract unless a small documentation-only justification later proves a change is unavoidable
- improve operator-facing status wording only where needed to support the new flow

### Excluded Work

- schema redesign for `capture_jobs` or `capture_stations`
- Supabase policy changes unless absolutely required by the chosen implementation
- Windows app implementation
- multi-photo capture sets
- cropping, editing, or post-processing workflows
- inventory creation or downstream AI/item generation
- major auth or station pairing redesign
- TestFlight packaging work
- broad retry/offline architecture redesign beyond what is needed to support the new UX flow

## Recommended Product Decisions for Phase 4

### 1. Default to auto mode, but slow it down

Keep auto capture as the default mode so the station still supports a fast assisted workflow, but replace the hard-coded feel of “immediate” capture with a more deliberate pre-shutter wait.

Recommendation:

- keep a default auto mode
- increase or make adjustable the stabilization delay
- ensure the operator can see the preview long enough to frame and settle

### 2. Add a manual mode without changing the core pipeline

Manual mode should open the camera and hold the job in an active capture state until the operator taps the shutter. This should reuse the same upload and lifecycle completion path after the photo is taken.

### 3. Reset result state after completion

The ready screen should return to a clearly readable idle/listening state after a successful upload or handled failure. The latest-result display can remain available in a lighter-weight recent-status area, but it should not dominate the primary ready screen indefinitely.

## Step-by-Step Execution Outline

### Step 1. Define the Phase 4 interaction model

Decide and document:

- what auto mode means
- what manual mode means
- when the app transitions from `captureRequested` to visible preview
- when the user is allowed to tap a shutter
- when the ready screen clears previous result content

Preferred low-risk model:

- job arrives
- app enters capture-requested state
- preview appears
- app either waits for auto delay then captures, or waits for user tap in manual mode
- after upload success, the app shows a short success state then resets to listening

### Step 2. Isolate capture-control settings

Introduce a small app-side configuration surface for:

- capture mode: auto or manual
- pre-shutter delay in auto mode
- post-result dwell/reset timing

Low-risk preference:

- start with local app configuration or station-local persisted preference
- do not expand the server contract yet unless real usage proves per-job control is necessary

### Step 3. Refactor the ready/capture state machine carefully

Adjust `ReadyViewModel` so it can distinguish:

- listening and idle
- request received
- preview settling
- waiting for manual shutter
- capturing
- uploading
- transient success/failure
- reset to ready

The critical constraint is to preserve the existing claim, upload, and completion behavior.

### Step 4. Update the capture UI

Adjust the ready/capture views so operators can:

- see the live preview before shutter
- understand whether the app is in auto or manual mode
- tap a manual shutter when manual mode is enabled
- clearly tell when the station is ready for the next request

### Step 5. Preserve the current backend contract

Keep using:

- `capture_jobs`
- `capture_stations`
- `capture-photos`
- `update_capture_job_lifecycle(...)`

Avoid any contract change unless implementation proves it is unavoidable. Phase 4 should succeed even if the backend remains exactly as it is today.

### Step 6. Validate on real device

Run repeated device tests that compare:

- current auto mode with revised delay
- manual mode behavior
- reset behavior between sequential jobs
- duplicate queued jobs
- failure recovery from camera or upload issues

## Likely Files and Modules Impacted

These are the most likely modules for a future implementation phase. This plan does not modify them now.

- `OGJewelryCapture/ViewModels/ReadyViewModel.swift`
- `OGJewelryCapture/Services/CameraCaptureService.swift`
- `OGJewelryCapture/Views/ReadyView.swift`
- `OGJewelryCapture/Views/CameraPreviewView.swift`
- potentially `OGJewelryCapture/Models/LocalCaptureResult.swift`
- potentially `OGJewelryCapture/Services/StationSelectionStore.swift` if local capture preferences are persisted

Possible but preferably avoid unless necessary:

- `OGJewelryCapture/Models/CaptureJob.swift`
- `OGJewelryCapture/Services/CaptureJobRepository.swift`
- Supabase migrations

## Risks and Edge Cases

### UX/state risks

- Manual mode can leave a job hanging if the operator walks away.
- Longer auto delay can feel sluggish if over-tuned.
- Resetting the screen too quickly can hide useful success feedback.
- Resetting too slowly recreates the current clutter problem.

### Lifecycle risks

- A manual-flow implementation must not break the existing `capturing -> uploading -> completed|failed` sequence.
- Sequential queued jobs must still process cleanly after a reset.
- Failure states must still release the active-job lock and return the app to a stable listener state.

### Operational risks

- If configuration is only local, different stations may behave differently unless the setting is documented.
- If configuration moves into Supabase too early, the team risks expanding scope and reopening schema decisions before the UX is proven.

## Manual Validation Checklist for the Future Phase

- Verify an authenticated employee can still restore session and return to the ready screen.
- Verify a selected station still persists across relaunch.
- Verify an auto-mode job shows preview before shutter and waits for the configured delay.
- Verify a manual-mode job opens preview and waits for operator shutter input.
- Verify successful captures still upload to `capture-photos`.
- Verify successful captures still mark `capture_jobs` as `completed` with storage metadata.
- Verify failed captures still mark `capture_jobs` as `failed`.
- Verify the ready screen clears prior result clutter and returns to a clear listening state.
- Verify back-to-back queued jobs still process cleanly.
- Verify simulator fallback still works in development if retained.

## Recommendation Relative to Reliability Hardening

Do not skip hardening forever, but do not make it the immediate next phase either.

Recommendation:

- perform this focused UX/control phase first
- follow immediately with a smaller hardening phase for reconnect handling, heartbeat, diagnostics, and tests

Why:

- the real-device findings are immediate operator blockers
- the current pipeline is already good enough to refine interaction behavior
- hardening will be easier once the intended capture mode behavior is settled

## Recommendation Relative to Windows Integration

Do not make Windows integration the next primary implementation phase.

Recommendation:

- keep the existing job contract stable during Phase 4
- document the current contract clearly after Phase 4 behavior is settled
- expand Windows-side capabilities only after the capture client’s operator flow feels right on device

Why:

- upstream integration should target a stable capture-client behavior model
- premature expansion risks forcing the phone app to support a UX contract that is still changing

## Recommendation Relative to TestFlight

TestFlight should follow at least one more implementation-and-hardening pass after Phase 4.

Recommendation:

- complete Phase 4
- complete targeted reliability hardening and basic regression coverage
- then prepare TestFlight

Why:

- current device validation proves the core path works
- the operator experience still needs refinement before a broader distribution cycle
- releasing before reset/manual/settling behavior is settled would lock in avoidable UX issues

## Success Criteria for Phase 4

Phase 4 should be considered complete when:

- the app supports a clearly defined auto capture behavior with a usable pre-shutter wait
- the app supports a manual capture option
- the ready screen resets cleanly after each job
- the existing upload and completion pipeline still works unchanged
- repeated real-device validation confirms the new behavior improves the operator workflow without regressing the backend pipeline
