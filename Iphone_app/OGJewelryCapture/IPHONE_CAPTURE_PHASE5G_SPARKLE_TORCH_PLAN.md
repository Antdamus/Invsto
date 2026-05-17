# iPhone Capture Phase 5G.4 Sparkle Torch Mode Planning Audit

## Agreement Gate

Reviewed for this planning pass:

- `IPHONE_CAPTURE_PHASE5G_TORCH_LIGHT_PLAN.md`
- `IPHONE_CAPTURE_REPO_AUDIT.md`
- `IPHONE_CAPTURE_PHASE5D_CLOSEUP_MACRO_PLAN.md`
- `IPHONE_CAPTURE_PHASE5E_ACTIVE_CAPTURE_UX_PLAN.md`
- `IPHONE_CAPTURE_PHASE5F_NEWEST_SIGNAL_QUEUE_POLICY_PLAN.md`
- `OGJewelryCapture/Services/CameraCaptureService.swift`
- `OGJewelryCapture/ViewModels/ReadyViewModel.swift`
- `OGJewelryCapture/Views/ReadyView.swift`
- current continuous torch implementation
- current torch intensity control
- current AVFoundation torch APIs
- current camera/capture states
- current cleanup behavior on review, upload, cancel, failure, reset, stop, and camera reconfiguration

This phase is limited to:

- investigating sparkle/pulse torch feasibility
- planning safe shimmer behavior
- identifying risks and implementation strategy
- no code changes yet

Agreed. Proceeding with Phase 5G.4 - Sparkle Torch Mode Planning Audit.

## Executive Summary

Sparkle Torch is feasible as an optional live-preview-only behavior because the current app already controls the real device torch through `AVCaptureDevice.setTorchModeOn(level:)` on the active camera device. AVFoundation supports setting torch brightness repeatedly while torch mode is on, as long as the app locks the device for configuration, uses a valid level, and respects current torch availability.

Recommended v1:

- add a compact `Sparkle Light` toggle only when normal `Torch` is on and available
- keep the selected intensity slider value as the base intensity
- vary the real torch level slowly every `0.6` seconds
- use a small bounded shimmer range, initially `+0.08 / -0.06` around the base, clamped to `0.1 ... min(1.0, AVCaptureDevice.maxAvailableTorchLevel)`
- stop the sparkle loop when capture starts and freeze the torch at the current sparkle level for the photo
- keep all behavior local to `CameraCaptureService`, `ReadyViewModel`, and `ReadyView`
- do not change backend, upload, queue, station, Supabase, or camera selection behavior

This should be implemented as a separate future phase, Phase 5G.5, after real-device expectations are accepted.

## Current Implementation Audit

### Continuous Torch

`CameraCaptureService` owns the hardware path:

- stores the active `AVCaptureDevice` in `activeDevice`
- exposes `currentTorchState()`
- exposes `setTorch(enabled:level:)`
- serializes torch writes through `sessionQueue`
- checks simulator fallback, active device presence, `hasTorch`, `isTorchModeSupported(.on)`, and `isTorchAvailable`
- locks the active device before changing torch state
- calls `setTorchModeOn(level:)` for enabled torch
- sets `torchMode = .off` for disabled torch
- turns torch off before camera reconfiguration and in `stopSession()`

The current implementation is real torch control, not a preview overlay and not still-photo flash.

### Intensity Control

`ReadyViewModel` owns operator state:

- `isTorchEnabled`
- `torchIntensity`
- persisted intensity in `UserDefaults`
- clamp range `0.1 ... 1.0`
- 80 ms delayed hardware apply for slider changes through `pendingTorchApplyTask`
- `flushPendingTorchIntensityBeforeCapture()` before capture

`ReadyView` renders:

- `Torch` toggle
- `Intensity` slider from `0.1 ... 1.0`
- percent label
- availability message

Controls are visible in `.captureRequested`, `.waitingForManualCapture`, and `.capturing`, and adjustable only before the active capture state enters `.capturing`.

### Capture States and Cleanup

Sparkle must align with these current state boundaries:

- live preview states: `.captureRequested`, `.waitingForManualCapture`, `.capturing`
- inactive/non-preview states: `.idle`, `.listening`, `.reviewingCapture`, `.sessionReady`, `.uploadingFinalSet`, `.completed`, `.failed`

Existing torch cleanup already occurs when:

- capture completes and moves to review
- capture fails
- `keepCapturedPhoto()` transitions back toward session-ready behavior
- `discardCapturedPhoto()` retakes or exits review
- `performFinishJob(...)` starts final upload
- `performCancelActiveJob(...)` cancels the active job
- `resetResult()` clears result state
- `stop()` runs
- `deinit` cancels pending tasks and stops the session
- camera mode reconfiguration turns torch off before replacing the active device

Future Sparkle cleanup should hook into the same points and should cancel before any normal torch-off call.

## AVFoundation Feasibility

Use official AVFoundation torch APIs:

- `AVCaptureDevice.hasTorch`
- `AVCaptureDevice.isTorchAvailable`
- `AVCaptureDevice.isTorchActive`
- `AVCaptureDevice.torchLevel`
- `AVCaptureDevice.torchMode`
- `AVCaptureDevice.isTorchModeSupported(_:)`
- `AVCaptureDevice.setTorchModeOn(level:)`
- `AVCaptureDevice.maxAvailableTorchLevel`
- `lockForConfiguration()` / `unlockForConfiguration()`

Apple documents `setTorchModeOn(level:)` as setting torch mode to `.on` and setting the illumination level. The level must be in `0.0 ... 1.0`, and callers must lock the device for configuration before changing it. Apple also documents that `isTorchAvailable` can become false, for example when the device overheats, and that `maxAvailableTorchLevel` can be lower under thermal duress.

Planning references:

- Apple Developer Documentation: [`AVCaptureDevice.setTorchModeOn(level:)`](https://developer.apple.com/documentation/avfoundation/avcapturedevice/settorchmodeon%28level%3A%29)
- Apple Developer Documentation: [`AVCaptureDevice.maxAvailableTorchLevel`](https://developer.apple.com/documentation/avfoundation/avcapturedevice/maxavailabletorchlevel)
- Apple Developer Documentation: [`AVCaptureDevice.hasTorch`](https://developer.apple.com/documentation/avfoundation/avcapturedevice/hastorch)
- Apple Developer Documentation: [`AVCaptureDevice.isTorchAvailable`](https://developer.apple.com/documentation/avfoundation/avcapturedevice/istorchavailable)

Audit finding: repeated torch-level updates are technically possible because they are the same hardware operation as a manual intensity change. They should be safe only at a slow cadence, with one serialized update at a time, and with immediate cancellation on unavailable/error states.

## Recommended Shimmer Behavior

### Cadence

Recommended initial cadence: update every `0.6` seconds.

Acceptable v1 range: `0.4 ... 0.8` seconds.

Avoid faster flicker. Sparkle should read as a subtle lighting change, not a strobe. The cadence should be deliberately slower than the existing 80 ms slider debounce and should never enqueue overlapping hardware writes.

### Pattern

Use a deterministic small pattern instead of random jitter for v1:

```text
0.00, +0.08, -0.04, +0.05, -0.06, +0.02, +0.00
```

For a base intensity of `0.50`, this yields:

```text
0.50 -> 0.58 -> 0.46 -> 0.55 -> 0.44 -> 0.52 -> 0.50
```

If real-device testing shows the lower dip is too visible, tighten to:

```text
+0.06 / -0.04
```

If jewelry reflections are too subtle, allow a later tuning pass up to approximately `+0.12 / -0.08`, but do not exceed `±0.15` in v1.

### Task/Timer Choice

Recommended implementation: a single `Task<Void, Never>` owned by `ReadyViewModel`, similar to the current auto-capture and torch slider tasks.

Why:

- the view model already owns UI state and cancellable tasks
- `Task.sleep(for:)` fits the desired cadence
- cancellation can be explicit in every lifecycle path
- each loop iteration can `await cameraService.setTorch(enabled:true, level:)`
- hardware writes stay serialized inside `CameraCaptureService.sessionQueue`

Do not use multiple timers or schedule per-step delayed tasks. Avoid Combine unless the view model already adopts it elsewhere for similar hardware loops.

### Overlap Prevention

The sparkle loop should:

1. keep one `sparkleTorchTask`
2. cancel any existing sparkle task before starting a new one
3. `await` each torch apply before sleeping or proceeding to the next level
4. stop if torch is off, unavailable, not visible, or capture state leaves live preview
5. cancel `pendingTorchApplyTask` before each sparkle-owned hardware apply, or route both manual and sparkle writes through one coordinator method

This prevents slider smoothing and sparkle from fighting each other.

## Intensity Bounds

Sparkle must respect the operator-selected base intensity and device constraints.

Recommended clamp:

```text
base = clamp(userSelectedIntensity, 0.1, 1.0)
availableMax = min(1.0, AVCaptureDevice.maxAvailableTorchLevel)
target = clamp(base + sparkleOffset, 0.1, availableMax)
```

The current `CameraCaptureService.clampedTorchLevel(_:)` clamps to `0.1 ... 1.0`. Phase 5G.5 should enhance the service-side clamp to also respect `AVCaptureDevice.maxAvailableTorchLevel` before calling `setTorchModeOn(level:)`.

Examples:

- base `0.20`, offset `-0.06` -> target `0.14`
- base `0.12`, offset `-0.06` -> target `0.10`
- base `0.95`, offset `+0.08`, available max `1.0` -> target `1.0`
- base `0.95`, offset `+0.08`, available max `0.80` -> target `0.80`, or sparkle should disable if the requested base is no longer practically available

If `setTorchModeOn(level:)` throws or torch becomes unavailable, stop Sparkle, turn the UI toggle off, and surface the existing temporary-unavailable message.

## Capture Behavior

Recommended v1 behavior: Option C - freeze at the current sparkle level when capture starts.

Reasoning:

- preserves the operator-visible sparkle moment
- avoids torch changes during the actual photo capture call
- is more consistent than continuing to pulse during capture
- avoids flattening the effect back to base intensity
- requires only tracking the most recent applied sparkle level

Implementation plan:

1. When capture begins, cancel the sparkle task.
2. Capture the last successfully applied sparkle level.
3. Apply that level once if needed.
4. Proceed with `capturePhoto(for:)`.
5. Existing cleanup turns torch off when the app transitions to review or failure.

Fallback if Option C becomes awkward: Option A, capture at whatever level is active and cancel immediately after capture starts. Do not choose Option B for v1 because returning to base intensity removes much of the operator-requested changing-highlight benefit.

Do not add complex exposure stabilization in this phase. Existing focus/exposure behavior can remain unchanged for Sparkle v1, with real-device validation watching for exposure pulsing or clipped highlights.

## UI Plan

Minimal UI:

- keep `Torch` as the main control
- keep the existing `Intensity` slider as base brightness
- show `Sparkle Light` only when torch is available and `Torch` is on
- no additional intensity or speed slider in v1
- use selected intensity as the sparkle base level
- compact helper copy is acceptable:

```text
Sparkle gently varies torch brightness for reflective jewelry.
```

Recommended state behavior:

- Torch off: hide or disable `Sparkle Light`, force Sparkle off
- Torch unavailable: hide or disable `Sparkle Light`, force Sparkle off
- Sparkle on: slider still displays and controls base intensity
- Capture/review/upload/session-ready: Sparkle toggle not visible and sparkle loop stopped
- Add Another Photo: Sparkle starts off until operator turns it on again

Do not redesign the active capture UI.

## Slider Interaction

Recommended v1 behavior:

- slider updates the base intensity
- Sparkle continues around the new base
- manual slider hardware apply should not independently fire while Sparkle is active
- if the operator drags rapidly, Sparkle may pause briefly and resume around the final base value

Implementation strategy:

- keep `torchIntensity` as the persisted base
- when Sparkle is off, use the existing 80 ms delayed apply
- when Sparkle is on, do not schedule normal `pendingTorchApplyTask`; let the next sparkle tick use the new base
- optionally apply the new base immediately when dragging ends if SwiftUI gesture tracking is added later

This preserves Phase 5G.3 slider smoothness without creating two competing writers.

## Lifecycle Cleanup Plan

Sparkle must stop whenever torch turns off or live preview ends.

Cancel Sparkle in all paths that already cancel or disable torch:

- `transitionToCapture(for:)` should start with Sparkle off for each new live preview
- `performCapture(for:)` should cancel/freeze Sparkle before setting `.capturing`
- successful capture before `.reviewingCapture`
- capture failure before `.failed`
- `keepCapturedPhoto()`
- `discardCapturedPhoto()`
- `.sessionReady`
- Add Another Photo entry until operator explicitly enables Sparkle again
- `performFinishJob(...)`
- upload start, upload retry, upload success, upload failure
- `performCancelActiveJob(...)`
- `resetResult()`
- `stop()`
- `deinit`
- `CameraCaptureService.stopSession()`
- camera reconfiguration / capture mode change before replacing `activeDevice`
- station change/logout through `ReadyView.onDisappear` and `stop()`
- app background if future scene lifecycle handling is added

Recommended helper naming for future implementation:

- `updateSparkleTorchEnabled(_:)`
- `startSparkleTorchIfNeeded()`
- `stopSparkleTorch(resetToggle: Bool)`
- `cancelSparkleTorchTask()`
- `freezeSparkleTorchForCapture()`

The service should remain the hardware owner. The view model should own the sparkle loop and cancellation.

## Risks

- visible flicker may look unprofessional if cadence is too fast
- brightness changes can affect exposure consistency
- repeated torch updates may increase heat and battery use
- rapid lock/configuration calls may stress the capture device path
- too much variation can annoy operators
- jewelry glare can worsen if the bright peaks are too strong
- macro/close-up camera paths may not expose torch
- thermal pressure may reduce max torch level or make torch unavailable
- Sparkle could fight manual slider smoothing if writes are not coordinated
- capture brightness may vary shot to shot
- real devices may respond differently across iPhone models

Risk controls:

- default Sparkle off
- slow cadence
- small variation
- strict clamp
- one serialized update loop
- stop on unavailable/errors
- real-device Phase 5G.6 validation before treating it as production-polished

## Required Recommendations

1. Is Sparkle Torch feasible?

Yes. It is feasible on torch-capable active camera devices because the app already applies real torch intensity with `AVCaptureDevice.setTorchModeOn(level:)`. It must remain device-availability-gated.

2. What API should be used?

Use `AVCaptureDevice.setTorchModeOn(level:)`, with `lockForConfiguration()`, `unlockForConfiguration()`, `hasTorch`, `isTorchAvailable`, `isTorchModeSupported(.on)`, `torchLevel`, and `AVCaptureDevice.maxAvailableTorchLevel`.

3. What update cadence is safest?

Start at one update every `0.6` seconds. Keep the acceptable tuning range to `0.4 ... 0.8` seconds. Avoid rapid flicker.

4. What intensity variation range is recommended?

Start with about `+0.08 / -0.06` around the selected base intensity. Keep v1 within roughly `±0.05 ... ±0.10`, with a hard planning maximum of about `±0.15`.

5. Should capture freeze at base intensity, current sparkle level, or keep pulsing?

Freeze at the current sparkle level for v1. If that proves awkward, capture at the active level. Do not freeze back to base by default.

6. How should UI expose Sparkle Light?

Add a compact `Sparkle Light` toggle only when Torch is on and available. Use the existing intensity slider as the base brightness. No extra slider in v1.

7. How should Sparkle interact with the normal torch slider?

The slider updates the base intensity. Sparkle continues around the new base, while normal debounced slider hardware applies are suppressed or coordinated so they do not fight the sparkle loop.

8. When should Sparkle automatically stop?

Stop whenever torch turns off, live preview ends, capture starts, review starts, keep/discard runs, session-ready begins, Add Another Photo resets preview, Finish Job/upload starts, cancel/failure/reset/stop/deinit runs, camera reconfigures, station/logout exits the view, or app/background handling later requires cleanup.

9. What are the main risks?

Flicker, exposure inconsistency, heat/battery usage, glare, operator annoyance, device-specific torch availability, thermal limits, and conflict with slider smoothing.

10. Should this be implemented as a separate phase after audit?

Yes. Implement as Phase 5G.5 only after this audit is accepted, then validate on real devices in Phase 5G.6.

## Suggested Future Implementation Breakdown

### Phase 5G.5 - Sparkle Torch Implementation

- add `Sparkle Light` view model state
- add compact toggle in `ReadyView`
- add one cancellable shimmer task
- apply safe clamped sparkle levels through `CameraCaptureService`
- enhance service clamp with `AVCaptureDevice.maxAvailableTorchLevel`
- coordinate Sparkle with slider smoothing
- freeze at current sparkle level on capture
- stop Sparkle on all torch cleanup paths
- preserve backend/upload/queue behavior

### Phase 5G.6 - Real Device Validation

Test:

- Standard mode
- High Resolution mode
- Close-Up / Macro when torch is available
- manual capture with Sparkle on
- auto capture with Sparkle on
- hardware shutter with Sparkle on
- slider changes while Sparkle is on
- review/upload/cancel cleanup
- heat and battery comfort
- whether jewelry reflections improve or glare worsens

## Out of Scope

This phase does not:

- implement Swift code
- change backend or Supabase behavior
- change upload/session logic
- change queue policy
- change camera device selection
- add fake UI sparkle overlays
- use private APIs
- use flashlight hacks
- implement beam focusing

## Verification

Created planning document:

- `IPHONE_CAPTURE_PHASE5G_SPARKLE_TORCH_PLAN.md`

No Swift files, SQL migrations, backend behavior, upload behavior, queue behavior, camera behavior, or app behavior are changed by this planning phase.

Phase 5G.4 - Sparkle Torch Mode Planning Audit is complete.
