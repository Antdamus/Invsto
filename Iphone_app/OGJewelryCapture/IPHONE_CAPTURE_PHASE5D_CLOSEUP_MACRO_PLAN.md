# iPhone Capture Phase 5D Close-Up / Macro Plan

## Agreement Gate

Reviewed for this planning pass:

- `IPHONE_CAPTURE_REPO_AUDIT.md`
- `IPHONE_CAPTURE_PHASE4_PLAN.md`
- `IPHONE_CAPTURE_PHASE5B_PLAN.md`
- `OGJewelryCapture/Services/CameraCaptureService.swift`
- `OGJewelryCapture/ViewModels/ReadyViewModel.swift`
- `OGJewelryCapture/Views/ReadyView.swift`
- `OGJewelryCapture/Views/CameraPreviewView.swift`
- current capture mode, focus, exposure, zoom, resolution, local session, and upload flow logic

This task is investigation and planning only. No app code, UI code, backend code, Supabase schema, or build configuration should be changed in Phase 5D.1.

Agreed. Proceeding with Phase 5D planning for close-up / macro jewelry capture optimization.

## 1. Executive Summary

Operators report that very small jewelry pieces are less sharp in the app than in the native iPhone Camera app. The most likely app-side cause is not upload quality or high-resolution still dimensions. The current app always configures a back `builtInWideAngleCamera`, while Apple documents that supported iPhone macro capture uses the Ultra Wide camera and automatically switches near close subjects. In other words, native Camera can move to a better close-focus hardware path that this app never selects.

Recommended v1 direction:

- Add an operator-selectable `Close-Up / Macro` capture resolution/camera mode in a future implementation phase.
- When close-up mode is selected, prefer a macro-capable back camera path on supported devices, likely an Ultra Wide device or an appropriate virtual multi-camera device after real-device testing.
- Add deliberate focus/exposure stabilization before capture so the app does not shoot while autofocus or exposure is still moving.
- Preserve current `Standard` and `High Resolution` behavior for the stable TestFlight pipeline.
- Keep Photo Library upload as a later fallback, not the first fix.

Close-Up / Macro mode appears feasible because AVFoundation exposes back Ultra Wide and multi-camera device types, and the app's current camera setup is centralized in `CameraCaptureService`.

## 2. Current Camera Audit

### Selected Camera Device

Current implementation:

- `CameraCaptureService.configureSessionIfNeeded()` selects `AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)`.
- The selected device is stored as `activeDevice`.
- The session preset is `.photo`.
- The service removes previous inputs/outputs, adds one camera input, and adds one `AVCapturePhotoOutput`.

Audit finding:

- The app is always using the back wide-angle camera when running on device.
- It does not discover or select `builtInUltraWideCamera`.
- It does not discover or select virtual devices such as `builtInDualWideCamera` or `builtInTripleCamera`.
- It does not currently support automatic lens switching for close-up capture.
- It does not expose an operator or app-side way to choose a close-up camera device.

### Focus Behavior

Current implementation:

- During auto capture, `transitionToCapture(for:)` calls `cameraService.enableContinuousPreviewAutoFocus()`, sets `.captureRequested`, and schedules capture after the configured delay.
- During manual capture, `transitionToCapture(for:)` sets `.waitingForManualCapture` but does not explicitly call `enableContinuousPreviewAutoFocus()` in that branch.
- Tap-to-focus is enabled only during `.captureRequested` for Auto mode and `.waitingForManualCapture` for Manual mode.
- `focusAndExpose(at:)` sets focus point of interest when supported, then uses `.autoFocus` if available, otherwise `.continuousAutoFocus`.
- `enableContinuousPreviewAutoFocus()` uses `.continuousAutoFocus` if supported, otherwise `.autoFocus`.
- There is no explicit focus lock before capture.
- There is no explicit wait for `isAdjustingFocus == false` before capture.

Audit finding:

- Continuous autofocus exists for the auto preview branch, but manual preview does not currently receive the same explicit continuous autofocus setup.
- Tap-to-focus is available in the correct pre-capture states, but capture can occur based on a timer rather than confirmed focus completion.
- The app does not currently know whether focus has settled when `capturePhoto(with:)` fires.

### Exposure Behavior

Current implementation:

- `focusAndExpose(at:)` sets exposure point of interest and uses `.continuousAutoExposure` if supported.
- `enableContinuousPreviewAutoFocus()` also enables continuous auto exposure if available.
- No pre-capture routine waits for `isAdjustingExposure == false`.
- No exposure bias, highlight protection, bracket, or diamond/glare-specific behavior is present.

Audit finding:

- Exposure is adjusted with focus when the operator taps the preview.
- Auto exposure is enabled during the auto preview branch.
- The app does not wait for exposure stabilization before capture.
- Diamond glare or highly reflective metal could reduce visible detail through blown highlights even when focus is acceptable. This should be validated separately from lens selection.

### Zoom Behavior

Current implementation:

- Zoom uses `activeDevice.videoZoomFactor`.
- The available range is `1.0 ... min(device.activeFormat.videoMaxZoomFactor, 3.0)`.
- The view model resets zoom to `1.0` when camera availability is prepared or refreshed.
- Pinch zoom is enabled only before capture in `.captureRequested` and `.waitingForManualCapture`.
- Zoom is applied to the current wide-angle device only.

Audit finding:

- In the current app, zoom is digital zoom on the selected wide camera unless the selected device itself is a virtual device that performs optical switching. Because the app selects a single wide camera, zoom should be treated as digital crop/scaling for practical product guidance.
- Relying on pinch zoom can make tiny jewelry look larger in the preview but may reduce real detail.
- The app should guide physical distance and lens mode first, then allow limited zoom for framing.

### Resolution Behavior

Current implementation:

- `CaptureResolutionMode` currently has two cases: `standard` and `highResolution`.
- `CameraCaptureService.applyCaptureResolutionModeToPhotoOutput()` sets `photoOutput.maxPhotoDimensions` from the selected active format.
- `standard` selects the minimum supported max-photo dimensions for the active format.
- `highResolution` selects the maximum supported max-photo dimensions for the active format and also sets `settings.maxPhotoDimensions` on the capture request.
- `AVCapturePhotoSettings` uses JPEG and `photoQualityPrioritization = .quality`.
- Captured image data is taken from `photo.fileDataRepresentation()`.
- Kept session photos are written locally without recompression.
- Upload sends the JPEG data as-is with `contentType: image/jpeg`.

Audit finding:

- High Resolution can improve pixel dimensions, but it does not change close-focus hardware limits.
- High Resolution is applied to the current active wide camera format, not to a macro-capable lens.
- The app does not appear to recompress device-captured JPEGs before local storage or upload.
- Upload compression is not the likely root cause of close-up blur.

### Capture Flow

Current implementation:

- A job is claimed, the camera is prepared, resolution mode is applied, zoom resets to 1.0, and a local multi-photo session is created.
- Auto mode shows live preview, enables continuous autofocus/exposure, waits `autoCaptureDelay` seconds, then captures.
- Manual mode shows live preview and waits for operator shutter.
- Each new capture enters review.
- `Keep` stores the photo locally in the active session.
- `Finish Job` uploads kept photos and finalizes the parent job.

Audit finding:

- The current TestFlight workflow is stable and should be preserved.
- Phase 5D should add close-up capability as an additive mode, not rewrite the lifecycle or multi-photo session pipeline.

## 3. Root-Cause Analysis

The native iPhone Camera app may outperform the app for tiny jewelry because:

- Native Camera can use macro behavior on supported devices. Apple documents that supported iPhones use the Ultra Wide camera for macro close-ups and can automatically switch to it near the subject.
- The app is pinned to the wide camera, which is a general-purpose lens and may not focus as close as the macro-capable Ultra Wide path.
- Native Camera may use private/computational processing unavailable or not enabled through the current AVFoundation path, including stronger sharpening, scene processing, Smart HDR-style highlight handling, and device-specific tuning.
- Native Camera may delay or adapt capture timing around focus and exposure more aggressively than this app's fixed timer.
- The app's pinch zoom is applied after choosing the wide camera. For very small jewelry, digital zoom can make the object look bigger while preserving less optical detail than a closer-focusing lens.
- Bright diamonds and polished metal can create small clipped highlights. Even with correct focus, glare can obscure facets, engraving, or fine links.

High resolution alone is not enough. A large JPEG from the wrong focus distance or wrong lens will still look soft.

References checked for planning:

- Apple Support: supported iPhones use the Ultra Wide camera for macro and switch automatically near close subjects.
- Apple Developer Documentation: `builtInUltraWideCamera` is discoverable via `AVCaptureDevice.DiscoverySession`.
- Apple Developer Documentation: `builtInTripleCamera` can support automatic switching between constituent cameras when zoom, light, and focus position allow.

## 4. Recommended V1 Solution

Recommended v1: Add Close-Up / Macro mode plus focus/exposure stabilization.

This is the best practical next step because it targets both likely causes:

- Lens path: use a camera device that can focus closer on tiny jewelry.
- Timing: avoid firing while focus or exposure is still settling.

The future implementation should preserve the existing behavior:

- `Standard`: current default behavior on wide camera.
- `High Resolution`: current largest-dimensions still capture behavior on wide camera.
- `Close-Up / Macro`: new mode that prefers the close-focus camera path and uses a stabilization gate.

Implementation should avoid changing:

- Supabase schema.
- `capture_jobs` lifecycle.
- multi-photo local session semantics.
- station routing.
- upload path format.
- retry behavior.

Recommended device strategy for v1:

1. Discover supported back cameras with `AVCaptureDevice.DiscoverySession`.
2. Prefer a macro-capable close-up path only when the operator selects Close-Up / Macro.
3. Test on the actual TestFlight device class before choosing the final default between:
   - direct `builtInUltraWideCamera`; or
   - a virtual device such as `builtInDualWideCamera` / `builtInTripleCamera` if it provides better automatic switching and still-photo quality.
4. Fall back to the current wide camera when no suitable close-up path exists.

Recommended stabilization strategy for v1:

- When entering capture preview, enable continuous autofocus and continuous auto exposure for both Auto and Manual modes.
- On tap-to-focus, set focus and exposure points together.
- Before capture, run a short stabilization gate:
  - trigger focus/exposure if a target point exists or use center/default behavior,
  - wait briefly for focus/exposure movement to stop when the device reports adjustment state,
  - apply a bounded timeout so the job cannot hang indefinitely.
- Keep the current configurable auto delay, but treat it as operator framing time, not as proof that focus is stable.

## 5. Fallback Behavior

On devices without a macro-capable camera:

- Keep Standard and High Resolution available exactly as today.
- Show Close-Up / Macro as unavailable, or allow selecting it with clear fallback language such as "Close-Up uses standard camera on this device."
- Prefer physical guidance over digital zoom:
  - move slightly farther back if focus hunts,
  - tap the jewelry,
  - avoid going closer than the lens can focus,
  - use High Resolution with minimal zoom if macro is unavailable.
- Do not fail a capture job simply because macro is unavailable.

On devices where Ultra Wide exists but produces lower-quality images in some lighting:

- Treat Close-Up / Macro as operator-selectable, not automatic for every job.
- Validate whether Ultra Wide close focus beats wide camera plus distance for each jewelry type.
- Consider retaining High Resolution as the default for larger pieces.

## 6. UX Recommendations

Recommended operator-facing controls:

- Keep the existing capture mode selector: Auto / Manual.
- Replace or extend the resolution selector into a capture quality selector:
  - Standard
  - High Resolution
  - Close-Up / Macro
- Lock the selected quality/macro mode for the active multi-photo job, same as current resolution locking.
- Show the active mode in the station header and review screens.

Recommended Close-Up / Macro guidance:

- Mode label: `Close-Up / Macro`.
- Preview hint: `For tiny pieces, move close, tap the jewelry, then wait for sharp focus before capture.`
- If using Auto mode: make the auto delay visibly long enough for the operator to tap and settle focus.
- If using Manual mode: emphasize tap-to-focus and manual shutter when the piece looks sharp.
- If macro is unavailable: show a concise warning that the device is using the standard camera path.
- If zoom is used heavily: warn that zoom is for framing and may reduce detail.

Do not add Photo Library fallback in the same first implementation unless macro/focus work fails real-device validation. It is useful operationally, but it changes the capture source model and can weaken station-controlled consistency.

## 7. Implementation Breakdown

### Phase 5D.1 Planning and Audit

- Complete this document.
- Confirm current code behavior.
- Confirm no app code changed.

### Phase 5D.2 Camera Device and Macro Mode Support

- Add a camera-device abstraction in `CameraCaptureService`.
- Discover available back camera device types.
- Add Close-Up / Macro as a selectable app mode.
- Select Ultra Wide or a suitable virtual multi-camera device only for Close-Up / Macro.
- Preserve current wide-camera path for Standard and High Resolution.
- Report mode availability to the view model.

### Phase 5D.3 Focus and Exposure Stabilization

- Apply continuous autofocus/exposure consistently for auto and manual preview.
- Add a pre-capture stabilization routine with a bounded timeout.
- Preserve tap-to-focus.
- Consider tracking the last tap point so capture can stabilize around the operator's chosen jewelry point.

### Phase 5D.4 Real-Device Validation with Jewelry

- Test on the actual deployed iPhone model(s), especially Pro models used at the station.
- Compare app Standard, High Resolution, Close-Up / Macro, and native Camera under the same lighting.
- Validate that multi-photo, retry, finish job, upload, and station routing remain unchanged.

### Phase 5D.5 Optional Photo Library Fallback

- Add only if operators still need native Camera for edge cases.
- Keep it behind an explicit operator choice such as `Upload from Library`.
- Preserve metadata and session behavior by importing selected images into the same local kept-photo session before Finish Job.

## 8. Risks

- Device compatibility: not every iPhone has the same camera set or macro support.
- Ultra Wide tradeoff: Ultra Wide can focus closer, but may have lower resolution, more distortion, or lower quality in poor lighting than the main wide camera.
- Macro availability: AVFoundation access to hardware does not guarantee parity with native Camera's private macro processing.
- Virtual device behavior: automatic switching may help, but it needs real-device testing to avoid surprising lens changes or dimension changes.
- Digital zoom degradation: operators may use zoom as a substitute for close focus, reducing detail.
- Autofocus instability: shiny jewelry, black backgrounds, tiny edges, and specular highlights can cause focus hunting.
- Exposure/glare: diamonds and polished metal can clip highlights, hiding detail even in sharp images.
- Operator confusion: too many camera modes can slow the station workflow.
- Stable pipeline risk: multi-photo upload, retry, station routing, and TestFlight behavior are currently working and should remain untouched until the mode is isolated and tested.

## 9. Validation Checklist

Real-world tests for the future implementation:

- Tiny cross pendant in Standard, High Resolution, Close-Up / Macro, and native Camera.
- Ring detail, including prongs, engraving, and inner band.
- Fine chain links and clasp detail.
- Diamond glare under current station lighting.
- Gold and silver reflective surfaces.
- Black background with tiny object near the center.
- Tap-to-focus center and off-center.
- Auto mode with default delay.
- Manual mode after tap-to-focus.
- 1.0x versus pinch zoom.
- Macro-capable device versus non-macro fallback device if available.
- Multi-photo job with mixed close-up angles.
- Finish Job upload after several Close-Up / Macro photos.
- Retry after upload failure with local close-up photos preserved.
- Comparison against native Camera at the same distance, same lighting, and similar framing.

Acceptance criteria:

- Close-Up / Macro should visibly improve fine detail on tiny pieces where Standard and High Resolution struggle.
- It must not regress normal jewelry capture.
- It must not change backend completion semantics.
- It must not require operators to leave the app for the default workflow.

## Final Recommendation

Proceed next with a low-risk additive implementation: Close-Up / Macro mode plus focus/exposure stabilization, validated on real jewelry before expanding the workflow. Keep Photo Library fallback as a later operational escape hatch if AVFoundation close-up capture still cannot match native Camera closely enough for the smallest pieces.
