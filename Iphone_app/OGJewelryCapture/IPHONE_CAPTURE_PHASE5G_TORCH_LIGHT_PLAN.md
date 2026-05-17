# iPhone Capture Phase 5G.1 Continuous Torch / Adjustable Light Plan

## Agreement Gate

Reviewed for this planning pass:

- `IPHONE_CAPTURE_REPO_AUDIT.md`
- `IPHONE_CAPTURE_PHASE5D_CLOSEUP_MACRO_PLAN.md`
- `IPHONE_CAPTURE_PHASE5E_ACTIVE_CAPTURE_UX_PLAN.md`
- `IPHONE_CAPTURE_PHASE5F_NEWEST_SIGNAL_QUEUE_POLICY_PLAN.md`
- `OGJewelryCapture/Services/CameraCaptureService.swift`
- `OGJewelryCapture/ViewModels/ReadyViewModel.swift`
- `OGJewelryCapture/Views/ReadyView.swift`
- `OGJewelryCapture/Views/CameraPreviewView.swift`
- current camera device selection
- current active `AVCaptureDevice` handling
- current Standard / High Resolution / Close-Up Macro mode logic
- current active capture UI controls
- current camera lifecycle cleanup on finish, cancel, logout, station change, view disappearance, view model stop/deinit, and session stop

This task is limited to:

- investigating continuous torch support
- planning adjustable torch controls
- identifying lifecycle and safety concerns
- no implementation yet

Agreed. Proceeding with Phase 5G.1 - Continuous Torch / Adjustable Light Planning Audit.

## 1. Executive Summary

Continuous torch mode is feasible in the current app, with one important device-dependent caveat: support must be checked against the currently active `AVCaptureDevice`, not assumed globally for the phone.

The requested feature is torch, not still-photo flash. Torch is continuous illumination during live preview and can remain on while `AVCapturePhotoOutput.capturePhoto(with:delegate:)` captures the photo. The app already centralizes camera configuration in `CameraCaptureService`, stores the active camera device as `activeDevice`, and drives capture states from `ReadyViewModel`, so the feature can be added without changing backend, Supabase, upload, queue, or capture-job lifecycle behavior.

Recommended v1 behavior:

- default torch OFF for every job
- remember the last intensity only, defaulting to `0.4` or `0.5`
- expose torch controls only while a live preview/capture-ready state is active
- apply torch to the active camera device after mode selection has resolved
- turn torch off aggressively whenever the app leaves live capture
- do not add still-photo flash

## 2. Current Camera Implementation Audit

### Device Selection

Current `CameraCaptureService.cameraSelection(for:)` behavior:

- `Standard` uses `AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)`.
- `High Resolution` uses the same back Wide camera path as Standard.
- `Close-Up / Macro` prefers, in order:
  - back `builtInUltraWideCamera`
  - back `builtInDualWideCamera`
  - back `builtInTripleCamera`
  - fallback back Wide camera

The selected device is assigned to private `activeDevice` during `configureSession(for:forceReconfigure:)`. Focus, exposure, zoom, still-photo dimension selection, and capture all operate against that same active device.

### Resolution / Macro Mode Logic

Current mode behavior:

- `Standard` requests the minimum supported max-photo dimensions for the active format.
- `High Resolution` requests the maximum supported max-photo dimensions on the Wide camera.
- `Close-Up / Macro` requests the maximum supported max-photo dimensions on the resolved close-up path.
- Capture quality selection is locked once a job is active through `isResolutionSelectionLocked`.
- Reconfiguring mode resets zoom to `1.0`.

Torch availability should therefore be refreshed whenever the camera mode changes or the session is configured for a newly accepted job.

### Active Capture UI

The current active UI is a capture-first surface:

- active job card
- active media area with live preview, review image, upload placeholder, or last kept photo
- primary capture/review/add-another actions
- compact kept-photo strip
- Finish Job and Cancel Job footer actions
- full-screen gallery preview for kept photos

Live preview is shown only during:

- `.captureRequested`
- `.waitingForManualCapture`
- `.capturing`

Tap-to-focus and pinch-to-zoom are available only in the pre-capture preview states. Hardware shutter can trigger capture when a job is capture-ready.

### Cleanup / Exit Paths

Current cleanup behavior:

- `ReadyView.onDisappear` calls `viewModel.stop()`.
- `ReadyViewModel.stop()` cancels auto capture, stops Auto Listen, stops the listener, stops the camera session, clears active job IDs, resets zoom and camera status.
- `ReadyViewModel.deinit` cancels tasks, stops listener, and stops camera session.
- `performCancelActiveJob(_:)` marks the job failed, stops the camera session, clears local session state, returns to listening, then prepares camera again.
- Successful `performFinishJob(for:session:)` clears local session state and returns to listening, but does not currently stop the camera session.
- Change Station and Log Out are disabled while a job is active. When allowed, they remove `ReadyView` and trigger `onDisappear` / `stop()`.
- There is no current `scenePhase` or app-background handling in the Swift files reviewed.

Future torch cleanup must be added before or alongside these existing session cleanup calls because `stopSession()` currently only stops `previewSession`; it does not have any torch-specific off behavior.

## 3. Torch API Recommendation

Use AVFoundation torch APIs on the active `AVCaptureDevice`:

- `hasTorch`
- `isTorchAvailable`
- `isTorchModeSupported(.on)`
- `setTorchModeOn(level:)`
- `torchMode = .off`
- `torchLevel`
- `AVCaptureDevice.maxAvailableTorchLevel`
- `lockForConfiguration()` / `unlockForConfiguration()`

Apple documents `setTorchModeOn(level:)` as accepting a `Float` from `0.0` through `1.0`; it turns torch mode on and sets the illumination level. Apple also documents `maxAvailableTorchLevel` for the maximum currently available level, noting that under thermal pressure the available maximum can be less than `1.0`.

Planning references:

- Apple Developer Documentation: [`AVCaptureDevice.setTorchModeOn(level:)`](https://developer.apple.com/documentation/avfoundation/avcapturedevice/settorchmodeon%28level%3A%29)
- Apple Developer Documentation: [`AVCaptureDevice.maxAvailableTorchLevel`](https://developer.apple.com/documentation/avfoundation/avcapturedevice/maxavailabletorchlevel)
- Apple Developer Documentation: [`AVCaptureDevice.hasTorch`](https://developer.apple.com/documentation/avfoundation/avcapturedevice/hastorch)

Implementation should never use private APIs, still-photo flash, volume-button flashlight hacks, or app-global flashlight shortcuts.

## 4. Device / Mode Support Plan

Torch support should be evaluated per active device after camera selection resolves.

Recommended availability state:

- available only when the app is on device, camera availability is `.ready`, `activeDevice` exists, `hasTorch == true`, `isTorchAvailable == true`, and `.on` is supported
- unavailable in simulator fallback
- unavailable when no active camera device is configured
- temporarily unavailable if thermal/system state makes `isTorchAvailable` false or `setTorchModeOn(level:)` fails

Expected mode support:

- `Standard`: likely supported on iPhone back Wide camera when the hardware has a torch.
- `High Resolution`: likely supported because it uses the same back Wide camera path as Standard.
- `Close-Up / Macro`: uncertain and must be validated on real devices because the app may use Ultra Wide or a virtual multi-camera path. The plan should not assume torch remains available after switching away from Wide.

Macro strategy recommendation:

- Do not change the current macro camera strategy in Phase 5G just to preserve torch.
- If Close-Up / Macro selects Ultra Wide and torch is unavailable, show a concise unavailable message rather than silently switching away from the macro path.
- If real-device validation proves that a virtual multi-camera device preserves both close-up quality and torch better than direct Ultra Wide, treat that as a future camera-selection planning item, not part of torch v1.

Suggested unavailable messages:

- Simulator: `Torch is unavailable in simulator preview.`
- No hardware torch: `Torch is not available on this camera.`
- Macro path lacks torch: `Torch is unavailable with the current Close-Up / Macro camera path.`
- Thermal/system unavailable: `Torch is temporarily unavailable. Let the device cool, then try again.`

## 5. Intensity Design

Recommended operator control:

- toggle: `Torch`
- slider: `Intensity`
- range: `0.1 ... 1.0`
- step: `0.1`
- default remembered value: `0.4` or `0.5`

The values map directly to `setTorchModeOn(level:)` because Apple accepts values in the `0.0 ... 1.0` range. The app should intentionally avoid `0.0` as an operator intensity because `0.0` is not a useful visible light level and OFF should be represented by the toggle.

Device-specific handling:

- clamp UI values into `0.1 ... 1.0`
- before applying, clamp requested level to the currently valid maximum if the implementation can derive it safely
- handle `setTorchModeOn(level:)` failure by turning UI state back off or showing unavailable/error state
- after applying, read `torchLevel` if useful for status display, but keep the UI simple for v1

Because thermal conditions can reduce the maximum available torch level, the future implementation should tolerate a request for `1.0` being unavailable even on a device that normally supports it.

## 6. UI Placement Plan

Add a minimal torch control group to the active capture surface, near live preview/capture controls.

Recommended placement:

- inside the active job card, directly below the media preview or near `activeCaptureActions`
- shown only when the active camera preview is relevant
- hidden from idle/listening settings to avoid suggesting torch can be armed before a job
- omitted from full-screen kept-photo gallery preview

Recommended states:

- available live preview: show `Torch` toggle and `Intensity` slider
- torch OFF: keep slider disabled or visually secondary, preserving the last intensity value
- torch ON: enable 0.1-step slider
- unavailable: show a disabled toggle plus concise note

Suggested copy:

```text
Torch: Off / On
Intensity: 0.4
[slider]
```

Keep the OG dark/gold styling. Do not redesign the active capture workflow.

## 7. State Ownership

Recommended ownership:

### `CameraCaptureService`

Owns hardware truth:

- inspect active-device torch availability
- expose a `TorchAvailability` / `CameraTorchState` style value
- lock active device for configuration
- call `setTorchModeOn(level:)`
- set `torchMode = .off`
- turn torch off before device reconfiguration and session stop
- report unavailable/error cases without crashing capture flow

### `ReadyViewModel`

Owns operator/UI state:

- `@Published` torch enabled state
- `@Published` torch intensity
- `@Published` torch availability/message
- persist last intensity in `UserDefaults`
- default torch enabled to OFF per job
- reset enabled state on new job, finish, cancel, failure, logout/station exit, upload, and stop
- request service updates only in live-preview states

### `ReadyView`

Owns controls:

- render toggle/slider
- disable controls when unavailable or not live
- keep UI compact and capture-adjacent
- show concise unavailable note

Persistence recommendation:

- persist last intensity only
- do not persist torch ON/OFF
- default torch OFF for every new job
- do not automatically turn torch ON when a new job starts

Default intensity recommendation:

- choose `0.4` if prioritizing glare reduction for jewelry
- choose `0.5` if prioritizing operator familiarity and a more obvious mid-point
- this plan slightly prefers `0.4` because jewelry is reflective and a lower default reduces blown highlights

## 8. Capture Interaction Rules

### Manual Mode

- Torch can be toggled ON/OFF while `.waitingForManualCapture`.
- Intensity can be adjusted before the operator taps `Capture Photo`.
- Torch should remain on while the still photo is captured.

### Auto Mode

- Torch can be toggled ON/OFF while `.captureRequested`.
- Intensity can be adjusted during the auto-delay window.
- Torch should remain on while the auto capture fires.
- If torch changes reset exposure, the existing auto delay should give the operator a moment to settle framing; future real-device validation should decide whether an extra short exposure settle is needed after intensity changes.

### Capturing

- Torch remains on through `.capturing`.
- Controls may be disabled while the photo request is in progress to avoid changing device configuration mid-capture.

### Review

Recommendation: turn torch off when entering `.reviewingCapture`.

Rationale:

- review shows the captured still, not live preview
- leaving torch on during human review can heat the device and drain battery
- operators may spend time deciding whether to keep/discard
- the app can restore a previous requested ON state only if the operator returns to live preview, but v1 should be conservative and require explicit re-enable if needed

Alternative for future validation: keep torch on through immediate review if operators strongly prefer rapid repeated captures. This should be tested against heat, battery, and accidental unattended-light risk before adoption.

### Keep / Session Ready / Add Another Photo

- After `Keep`, `.sessionReady` shows the last kept photo, not live preview. Torch should stay off.
- When the operator taps `Add Another Photo`, the app returns to live preview. Torch should remain default OFF unless the operator turns it on again.
- This avoids leaving light on while the app is not actively showing live camera.

### Discard / Retake

- On discard, torch should already be off from review.
- Returning to live preview should keep torch OFF by default for v1.

### Full-Screen Gallery Preview

- Gallery preview should never turn torch on.
- Opening gallery while torch is on should not be possible under the recommended review/session behavior; if a future flow allows it, opening gallery should turn torch off.

### Uploading

- Torch must be off before or at entry to `.uploadingFinalSet`.
- Upload does not need live preview.

### Cancel / Failure

- Torch must turn off before clearing local session state or marking the app failed/listening.
- Failure states should never leave torch active.

## 9. Lifecycle Cleanup Plan

Torch should automatically turn off in all of these cases:

- before camera device reconfiguration for mode changes
- when a new active camera device replaces the old one
- when `CameraCaptureService.stopSession()` runs
- when `ReadyViewModel.stop()` runs
- when `ReadyViewModel.deinit` cleanup runs
- when the app enters review after a capture
- when the operator keeps or discards a capture
- when the operator taps Finish Job, before final-target resolution/upload begins
- when Finish Job succeeds and the station returns to listening
- when Finish Job fails and the app returns to `.sessionReady`
- when Cancel Job starts or completes
- when `failJob(...)` transitions into `.failed`
- when Reset clears a persistent result
- when Change Station or Log Out causes `ReadyView.onDisappear`
- when the app backgrounds or becomes inactive, if future scene-phase handling is added

Safest implementation hook hierarchy:

1. Hardware guarantee in `CameraCaptureService.stopSession()` and any future `reconfigure` path.
2. State-transition guarantee in `ReadyViewModel` before leaving live preview states.
3. View lifecycle guarantee through existing `ReadyView.onDisappear` -> `viewModel.stop()`.
4. Future app lifecycle guarantee through `scenePhase` if added.

This belt-and-suspenders approach is warranted because torch can remain physically active even after UI state changes if the active device is not explicitly configured off.

## 10. Safety / Heat / Battery

Torch can heat the device and drain battery quickly. Jewelry capture also risks glare and blown highlights, especially with diamonds, polished gold, and reflective watch surfaces.

Safety recommendations:

- default OFF
- do not persist ON
- turn off outside live preview
- turn off during review, session-ready, gallery, upload, cancel, failure, logout, station change, stop, and deinit
- surface temporary unavailability as a normal state, not as a job failure
- consider a future timeout only if operators leave preview active with torch on for long periods

Do not implement a timeout in Phase 5G.2 unless real-world testing shows unattended torch-on time is a problem. The immediate v1 safety design should rely on aggressive state cleanup.

## 11. Required Recommendations

1. Is continuous torch mode feasible in the current app?

Yes. The app already owns the active `AVCaptureDevice` inside `CameraCaptureService` and shows live preview through an `AVCaptureSession`, which is the right structure for continuous torch during preview and capture.

2. Which API should be used?

Use `AVCaptureDevice` torch APIs: `hasTorch`, `isTorchAvailable`, `isTorchModeSupported(.on)`, `setTorchModeOn(level:)`, `torchMode = .off`, `torchLevel`, `AVCaptureDevice.maxAvailableTorchLevel`, and `lockForConfiguration()`.

3. Which camera modes/devices likely support torch?

Standard and High Resolution likely support torch on physical iPhones because they use the back Wide camera path. Close-Up / Macro is device/path-dependent because it may use Ultra Wide or a virtual multi-camera path. Real-device validation is required.

4. How should unavailable torch be handled?

Disable the toggle/slider and show a concise note. Do not fail the capture job and do not silently switch camera paths just to get torch.

5. Should intensity range be `0.1 ... 1.0`?

Yes. Apple accepts torch levels in `0.0 ... 1.0`; using `0.1 ... 1.0` gives useful operator brightness levels while reserving OFF for the toggle.

6. Should slider step be `0.1`?

Yes. It is precise enough for jewelry lighting and avoids overly sensitive continuous slider behavior.

7. Where should torch state live?

Hardware availability and device configuration should live in `CameraCaptureService`. Published operator state and lifecycle decisions should live in `ReadyViewModel`. Controls should live in `ReadyView`.

8. Should torch setting persist?

Persist only intensity. Do not persist enabled state. Default torch OFF for every job and every app entry into live capture.

9. When should torch automatically turn off?

Turn it off when leaving live preview/capture states, including review, keep/discard, session-ready, upload, finish success/failure, cancel, failure, reset, station change, logout, view disappearance, view model stop/deinit, camera session stop, device reconfiguration, and future app background/inactive handling.

10. Should torch remain on during review or turn off after capture?

Turn it off after capture when entering review. This is safest for heat, battery, and unattended behavior. Reconsider only after real-device operator testing.

11. What is the safest implementation phase breakdown?

Use a staged rollout: service foundation first, UI controls second, real-device validation third. Keep backend/upload/queue behavior untouched.

## 12. Suggested Future Implementation Breakdown

### Phase 5G.2 - Camera Service Torch Foundation

- add a small torch availability/state model
- add service methods to refresh torch availability for `activeDevice`
- add `setTorch(enabled:level:)`
- add `turnTorchOff()`
- clamp intensity values
- handle `lockForConfiguration()` failures
- turn torch off before session stop and device reconfiguration
- no major UI yet except possibly internal status plumbing

### Phase 5G.3 - Active Capture UI Controls

- add `ReadyViewModel` published torch state
- add `UserDefaults` persistence for intensity only
- reset torch enabled to OFF per job and outside live preview
- add compact `Torch` toggle and `Intensity` slider to the active capture surface
- disable controls when unavailable
- show concise unavailable messaging
- keep app behavior/backend unchanged

### Phase 5G.4 - Real Device Validation

Test on the actual TestFlight device classes:

- Standard mode torch availability and level changes
- High Resolution torch availability and level changes
- Close-Up / Macro with Ultra Wide
- Close-Up / Macro with virtual multi-camera path if available
- Manual mode capture while torch remains on
- Auto mode capture while torch remains on
- capture-to-review torch-off behavior
- Keep, Discard / Retake, Add Another Photo behavior
- Finish Job upload cleanup
- Cancel Job cleanup
- failure and retry cleanup
- station change/logout cleanup
- app background/inactive behavior if scene-phase handling is added
- heat, battery, glare, reflection, and jewelry detail comfort

### Phase 5G.5 - Optional Refinement

Only if validation requires it:

- choose whether review should optionally keep torch on for rapid repeated capture
- add a preview-only torch timeout
- add a mode-specific availability badge
- revisit macro camera selection if virtual devices provide better torch plus close-up behavior

## 13. Non-Goals

Do not change:

- backend/Supabase
- migrations
- upload/session logic
- queue policy
- capture job lifecycle
- active capture workflow
- camera device selection in Phase 5G.1

Do not add:

- still-photo flash
- private APIs
- unsupported flashlight hacks
- volume/flash workarounds
