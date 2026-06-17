# iPhone Capture Phase 5F Macro / Depth-of-Field Sharpness Plan

## Phase 5F.1 Agreement Gate

Reviewed for this planning pass:

- `IPHONE_CAPTURE_REPO_AUDIT.md`
- `IPHONE_CAPTURE_PHASE4_PLAN.md`
- `IPHONE_CAPTURE_PHASE5B_PLAN.md`
- `IPHONE_CAPTURE_PHASE5D_CLOSEUP_MACRO_PLAN.md`
- `IPHONE_CAPTURE_PHASE5E_ACTIVE_CAPTURE_UX_PLAN.md`
- `OGJewelryCapture/Services/CameraCaptureService.swift`
- `OGJewelryCapture/ViewModels/ReadyViewModel.swift`
- `OGJewelryCapture/Views/ReadyView.swift`
- `OGJewelryCapture/Views/CameraPreviewView.swift`
- current capture quality / Macro mode implementation
- current camera device discovery and selection logic
- current focus, exposure, tap-to-focus, and zoom behavior
- current high-resolution still-photo settings
- current Auto and Manual capture paths
- current import-from-Photos fallback behavior

This task is audit and planning only. No Swift files, backend files, upload/session behavior, or active capture workflow should be changed in Phase 5F.1.

Agreed. Proceeding with Phase 5F.1 - Macro / Depth-of-Field Sharpness Audit.

## 1. Executive Summary

Operators report that Close-Up / Macro works well for small jewelry but can leave elongated vertical pieces sharp in the center and soft toward the top or bottom. The example barber-pole pendant pattern is more consistent with finite depth of field, close-distance geometry, lens/device selection, or capture timing than with a simple upload or compression issue.

Current code already includes `Close-Up / Macro`, but its camera priority is direct back Ultra Wide first. On devices where Ultra Wide exists, the app does not first use a virtual Triple or Dual Wide camera path that may behave closer to the native Camera app's automatic lens switching. The current path also does not wait for `isAdjustingFocus == false` or `isAdjustingExposure == false` before still capture.

Recommended next step: do not remove the current Macro mode. Keep the stable workflow and run a focused Phase 5F.2 camera strategy experiment that compares the current Ultra Wide-first Macro against a virtual multi-camera or "Full Item" close-up strategy. In parallel or immediately after, implement the previously deferred bounded focus/exposure stabilization gate from Phase 5D.3, because it is low-risk and directly addresses capture timing in both Auto and Manual paths.

Implementation is needed now only as a controlled next phase, not in this planning task.

## 2. Current Camera Implementation Audit

### Current Macro Camera Device Path

`CaptureResolutionMode` has three operator-facing choices:

- `Standard`
- `High Resolution`
- `Close-Up / Macro`

For `Standard` and `High Resolution`, `CameraCaptureService.cameraSelection(for:)` selects:

1. `AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)`

For `Close-Up / Macro`, current fallback order is:

1. first discovered back `.builtInUltraWideCamera`
2. first discovered back `.builtInDualWideCamera`
3. first discovered back `.builtInTripleCamera`
4. default back `.builtInWideAngleCamera` as standard fallback

Audit finding:

- The app effectively forces direct Ultra Wide for Macro on devices that have Ultra Wide.
- The app only reaches Dual Wide or Triple when Ultra Wide is not found.
- On typical Pro devices with both Ultra Wide and Triple available, current Macro will not use Triple first.
- Direct Ultra Wide is a physical camera path, not the same as the native Camera app's higher-level automatic virtual-camera behavior.
- The code does not explicitly configure or rely on automatic constituent-camera switching for the common Macro path.
- The current path may differ from native Camera, especially for elongated items where native Camera may choose a different standoff distance, virtual device, lens transition, or processing path.

### Focus and Exposure Behavior

Current focus/exposure behavior:

- Entering Auto preview calls `enableContinuousPreviewAutoFocus()`.
- Entering Manual preview also now calls `enableContinuousPreviewAutoFocus()`.
- `enableContinuousPreviewAutoFocus()` chooses `.continuousAutoFocus` when available, otherwise `.autoFocus`.
- It also chooses `.continuousAutoExposure` when available, otherwise `.autoExpose`.
- Tap-to-focus is enabled in Auto `.captureRequested` and Manual `.waitingForManualCapture`.
- `focusAndExpose(at:)` sets focus and exposure points of interest when supported.
- Tap-to-focus uses `.autoFocus` when available, otherwise `.continuousAutoFocus`.
- The view shows a focus indicator at the tapped point.

Audit finding:

- The current code has good baseline continuous AF/AE setup for live preview.
- Tap-to-focus is present and mapped through `AVCaptureVideoPreviewLayer.captureDevicePointConverted(fromLayerPoint:)`.
- The app does not store the last tap point as an explicit capture-time focus target.
- The app does not wait until `activeDevice.isAdjustingFocus == false`.
- The app does not wait until `activeDevice.isAdjustingExposure == false`.
- The app does not run a bounded focus/exposure stabilization wait before `photoOutput.capturePhoto(...)`.
- Auto capture can fire after the configured timer even if focus/exposure is still moving.
- Manual capture can fire immediately after a tap or after a hardware shutter press even if focus/exposure is still moving.

### Zoom Behavior

Current zoom behavior:

- `zoomRange(for:)` allows `1.0 ... min(device.activeFormat.videoMaxZoomFactor, 3.0)`.
- `ReadyViewModel.refreshZoomState(resetToDefault: true)` resets zoom to `1.0` when the camera is prepared or mode changes.
- Pinch zoom is enabled only in pre-capture preview states.
- `setZoomFactor(_:)` writes `activeDevice.videoZoomFactor`.

Audit finding:

- In Standard and High Resolution, zoom applies to the selected back Wide camera.
- In Close-Up / Macro on common devices, zoom applies to the direct Ultra Wide camera because Ultra Wide is selected first.
- If the active device is a virtual camera in fallback cases, zoom may interact with that virtual device's switching behavior, but this is not the common current path.
- Zoom is primarily a framing control and can reduce effective detail if it acts as digital crop.
- For elongated pieces, moving slightly farther back and using a higher-resolution or virtual path may preserve more full-item sharpness than pinching in close on Ultra Wide.

### Resolution and Quality Behavior

Current still-photo behavior:

- `photoOutput.maxPhotoQualityPrioritization = .quality`.
- Each `AVCapturePhotoSettings` uses JPEG.
- Each capture sets `settings.photoQualityPrioritization = .quality`.
- `Standard` applies the minimum supported `maxPhotoDimensions` for the active format.
- `High Resolution` applies the maximum supported dimensions for the active format.
- `Close-Up / Macro` also requests the maximum supported dimensions for the active format.
- Captured image data comes from `photo.fileDataRepresentation()`.
- Kept session photos are written to local temporary storage without recompression.
- Finish Job uploads the local file data with the photo MIME type.
- Imported Photos data is stored and uploaded without app-side recompression.

Audit finding:

- The app already uses quality prioritization.
- Macro is already using maximum supported still dimensions for the selected active camera format.
- The upload path is not the likely cause of softness.
- Any observed softness is very likely present before upload, either in the camera capture itself or in the operator's selected source photo.

### Auto, Manual, and Import Paths

Auto capture:

- A claimed job enters `.captureRequested`.
- Continuous AF/AE and torch preparation are started asynchronously.
- The app waits `autoCaptureDelay` seconds.
- `performCapture(for:)` freezes sparkle torch if needed and calls `cameraService.capturePhoto(for:)`.

Manual capture:

- A claimed job enters `.waitingForManualCapture`.
- Continuous AF/AE and torch preparation are started asynchronously.
- Operator taps `Capture Photo` or hardware shutter.
- Capture occurs without an additional focus/exposure settle wait.

Import from Photos:

- Available during active capture states when the local session has room.
- It pauses pending auto capture and turns torch off.
- Imported image bytes are validated through `CGImageSource`, persisted locally, and added to the same local session.
- Finish Job uploads imported and in-app photos through the same session/finalization flow.

Audit finding:

- Import from Photos is a valuable fallback and should remain.
- It should not become the primary solution unless AVFoundation strategies fail real jewelry validation.
- Auto and Manual capture share the same final capture path, so a stabilization gate can benefit both.

## 3. Root-Cause Analysis

### Depth of Field vs Autofocus

The reported pattern matters:

- center of item sharp
- top and/or bottom softer
- issue appears on elongated objects
- native Camera can often do better

This does not look like a total autofocus miss. If autofocus simply failed, the whole object would often look soft or focus would land on the background. A sharp center with softer longitudinal ends suggests the focus plane intersects the center but does not cover the full object at the current distance, angle, lens, or processing path.

Most likely contributing factors:

- finite depth of field at very close subject distance
- object or phone not perfectly parallel to the focus plane
- direct Ultra Wide macro path producing uneven full-item sharpness for long objects
- top/bottom portions falling into less favorable lens area or distortion-correction region
- capture firing while AF/AE is still settling after preview start, tap, zoom, or torch adjustment

Less likely as primary causes:

- upload compression, because in-app captures and kept photos are not recompressed before upload
- resolution mode alone, because Macro already requests maximum supported still dimensions
- pure glare/exposure, unless softness corresponds to clipped highlights or reflective caps rather than actual blur

### Lens Selection

Ultra Wide-first Macro is sensible for tiny pieces that need very close focus. It may not be ideal for an elongated pendant that needs uniform sharpness over a longer physical depth and image height.

For a full elongated item, a better result may come from:

- standing slightly farther back
- using Wide or a virtual multi-camera path
- capturing at high still dimensions
- letting the device choose the best constituent lens under the current focus distance and lighting
- avoiding heavy pinch zoom

The current code's Ultra Wide-first ordering prevents this comparison from happening automatically on common devices.

### Native Camera Differences

Native Camera may be doing several things the app is not doing.

Likely accessible or partially accessible through AVFoundation:

- selecting a virtual device such as Triple Camera or Dual Wide
- using device discovery to choose different camera paths by mode
- using continuous focus/exposure and tap-to-focus
- waiting for focus/exposure to settle before capture
- using quality prioritization and maximum photo dimensions
- using torch/lighting controls exposed by AVFoundation

Potentially accessible but requiring investigation:

- lens distortion correction behavior for photo output
- auto still image stabilization / capture stabilization behavior on supported iOS/device combinations
- scene monitoring and refocus after subject area changes
- virtual device constituent switching behavior under zoom, light, and focus constraints

Likely private or not reproducible exactly:

- native Camera's full computational photography pipeline
- device-specific Smart HDR and multi-frame tuning decisions
- private sharpening/detail enhancement
- private macro switching heuristics
- focus-stacking-like behavior, if any is used
- native Camera's exact capture timing and image fusion choices

Recommendation from this analysis: target the accessible gaps first. The app does not need exact native Camera parity to improve the operator workflow.

### Elongated Object Geometry

Elongated jewelry oriented along the long axis of the phone frame can expose issues that tiny centered pieces do not:

- the object spans more of the preview and photo frame
- any tilt between phone and object changes distance from center to ends
- the center focus point may be correct while caps are outside the sharp depth range
- direct Ultra Wide close-up can exaggerate perspective and edge-region behavior
- operators may move too close because Macro mode invites close positioning

For a barber-pole pendant, the best instruction may be "Full Item close-up" rather than "as close as possible."

### Glare and Exposure

Glare should be treated as a secondary validation axis. Polished caps, diamonds, and reflective metal can look soft if highlights clip or smear. The app now has torch controls and sparkle torch behavior, so validation should include:

- torch off
- steady torch at low/medium intensity
- sparkle torch off for sharpness comparison
- same lighting against native Camera

However, the reported center-sharp/end-soft pattern points first to depth of field, lens, and stabilization.

## 4. Solution Options

### Option A - Keep Current Ultra Wide-First Macro

Pros:

- preserves the mode that currently works well for very small objects
- minimal implementation risk
- no operator retraining
- direct Ultra Wide is the expected close-focus camera on supported iPhones

Cons:

- likely keeps the elongated-object softness problem
- direct Ultra Wide may not match native Camera's virtual-device behavior
- encourages very close subject distance, which can narrow practical depth coverage
- may produce lower full-item detail than Wide or virtual camera at a farther distance

Recommendation: keep it, but do not treat it as the only close-up strategy.

### Option B - Use Virtual Triple or Dual Wide First for Macro

Pros:

- may better approximate native Camera behavior
- may allow automatic constituent-camera switching
- may choose a better lens/distance combination for elongated objects
- could improve full-item sharpness without adding a separate UI mode

Cons:

- could regress tiny-object macro if the virtual path does not switch close enough or consistently
- device behavior may differ by iPhone model
- automatic switching can be hard to reason about and test
- torch availability and max dimensions may differ by selected path

Recommendation: test as a controlled experiment before making it the default Macro path.

### Option C - Add a Second Close-Up Mode

Potential labels:

- `Macro`
- `Full Item`
- `Detail`
- `Wide Detail`

Pros:

- preserves current Macro for tiny pieces
- gives operators a simple answer for elongated pieces
- allows different device priority without hidden behavior changes
- maps well to the field distinction between tiny close-ups and full elongated objects

Cons:

- adds one more operator choice
- must be labeled carefully to avoid technical camera jargon
- requires validation that operators can reliably choose the right mode

Recommendation: likely best if virtual strategy materially improves elongated pieces but might regress tiny Macro.

### Option D - Add an Operator-Selectable Lens Strategy

Example choices:

- `Macro Close`
- `Macro Full Item`
- `High Resolution Wide`

Pros:

- maximum control for edge cases
- helps advanced operators troubleshoot difficult pieces

Cons:

- too technical for a fast station workflow
- increases training burden
- may create inconsistent captures between operators

Recommendation: avoid unless validation shows two simple quality labels are insufficient.

### Option E - Use Import From Photos as Fallback Only

Pros:

- already present
- native Camera can handle hard edge cases today
- no camera implementation risk

Cons:

- disrupts the ideal in-app flow
- weakens station consistency
- adds operator steps
- does not solve the core quality gap

Recommendation: keep as fallback, not as the primary Phase 5F answer.

### Option F - Focus/Exposure Stabilization Without Lens Change

Pros:

- benefits Auto and Manual
- low operator complexity
- addresses capture firing during AF/AE movement
- aligns with previously deferred Phase 5D.3

Cons:

- may not solve depth-of-field limitations
- can add capture latency
- must be bounded so the app does not hang on reflective jewelry

Recommendation: implement, but do not expect it to fully solve elongated-object softness by itself.

### Option G - Hybrid Strategy

Hybrid approach:

- preserve current Macro
- add a bounded focus/exposure stabilization gate
- test a virtual-camera or Full Item close-up path
- expose a second simple mode only if validation shows real benefit

Pros:

- protects the stable workflow
- addresses both timing and lens strategy
- avoids overcommitting before real jewelry validation
- keeps import fallback as a safety net

Cons:

- requires careful real-device comparison
- may need one small UI addition if two close-up strategies are kept

Recommendation: preferred path.

## 5. Recommended Path

Recommended Phase 5F direction:

1. Preserve current `Close-Up / Macro` behavior for tiny pieces during experimentation.
2. Add instrumentation or a temporary internal strategy switch to compare:
   - current direct Ultra Wide-first Macro
   - virtual Triple-first Macro where available
   - virtual Dual Wide-first Macro where available
   - High Resolution Wide at a slightly farther distance
3. Implement a bounded focus/exposure stabilization gate before still capture.
4. Validate with real elongated jewelry against native Camera.
5. If virtual or Wide-based strategy clearly improves elongated pieces, add the simplest operator-facing mode, likely `Full Item` or `Wide Detail`, while keeping current Macro.

Recommended camera priority for the experiment:

- Current Macro control: Ultra Wide, Dual Wide, Triple, Wide fallback.
- Candidate Full Item strategy: Triple, Dual Wide, Wide, Ultra Wide fallback.
- Candidate native-like Macro strategy: Triple, Dual Wide, Ultra Wide, Wide fallback.

Do not change backend, upload/session logic, station routing, active capture UI structure, or import fallback as part of the camera experiment.

### Phase 5D.3 Stabilization Decision

Phase 5D.3 should now be implemented in the next implementation phase.

Reasoning:

- current code does not wait for focus/exposure stabilization
- Auto capture is timer-based rather than focus-state-based
- Manual/hardware shutter can fire immediately after tap-to-focus
- stabilization is additive and should not require backend or workflow changes
- even if lens strategy is the main issue, stabilization reduces false negatives during validation

Recommended stabilization shape:

- track the last tap-to-focus point if available
- before capture, optionally reapply focus/exposure to last tap point or center
- wait until focus and exposure are no longer adjusting
- use a short bounded timeout, for example around 0.6 to 1.2 seconds after any existing auto delay
- proceed on timeout rather than failing the job
- avoid blocking the main actor or UI

## 6. Suggested Implementation Breakdown

### Phase 5F.1 - Audit / Plan

- Create this planning document.
- Confirm current camera, focus, zoom, quality, auto/manual, upload, and import behavior.
- Confirm no Swift/backend/workflow changes.

### Phase 5F.2 - Camera Strategy Experiment

- Add an internal camera strategy abstraction in `CameraCaptureService`.
- Compare current Ultra Wide-first Macro against virtual-first and Wide-based full-item strategies.
- Surface active camera path in existing status text for validation.
- Keep the current operator workflow unchanged during the experiment.
- Avoid committing to new UI labels until real jewelry results justify them.

### Phase 5F.3 - Focus / Exposure Stabilization

- Add a bounded pre-capture stabilization routine.
- Use it for Auto, Manual, and hardware shutter capture.
- Track last tap point if feasible.
- Wait for focus/exposure settling without failing capture on timeout.
- Validate latency impact with operators.

### Phase 5F.4 - Operator Mode Decision

- If virtual-first or Wide-based strategy improves elongated pieces without hurting tiny pieces, consider changing the Macro default.
- If it improves elongated pieces but hurts tiny close-up objects, keep current `Close-Up / Macro` and add one simple mode:
  - preferred label: `Full Item`
  - alternate label: `Wide Detail`
- Do not expose raw lens names unless needed for diagnostics.

### Phase 5F.5 - Real Jewelry Validation

- Test deployed iPhone model(s), not only simulator.
- Compare app results against native Camera and import fallback.
- Lock the final mode naming and default only after field validation.

## 7. Validation Checklist

Use same distance, same lighting, same background, and same framing whenever possible.

Objects:

- barber-pole pendant / charm
- elongated vertical charm
- tiny cross pendant
- ring with prongs or engraving
- chain and clasp
- reflective gold item
- reflective silver item
- item on black cloth background

Capture comparisons:

- native Camera
- current app `Close-Up / Macro`
- app `High Resolution`
- app `Standard`
- candidate virtual-first Macro strategy
- candidate Full Item / Wide Detail strategy if added
- import-from-Photos fallback using native Camera result

Focus comparisons:

- Auto capture, no tap
- Auto capture with center tap-to-focus
- Manual capture, no tap
- Manual capture with center tap-to-focus
- Manual capture with top tap-to-focus
- Manual capture with bottom tap-to-focus
- capture immediately after tap
- capture after stabilization wait

Framing and distance:

- very close macro distance
- slightly farther full-item distance
- no pinch zoom
- moderate pinch zoom
- portrait orientation with long item vertical
- landscape orientation if useful for long horizontal pieces

Lighting:

- station lighting only
- torch off
- steady torch low
- steady torch medium
- sparkle torch off for baseline sharpness
- glare-prone reflective caps

Acceptance criteria:

- elongated object should be visibly sharper from top to bottom than current Macro baseline
- tiny-object Macro quality must not regress
- capture latency must remain acceptable
- operators should not need native Camera except exceptional cases
- upload/session/finalization behavior must remain unchanged

## 8. Risks

- Destabilizing a successful Macro mode: current Macro works well for tiny objects, so changes must be additive or validated before default changes.
- Operator UI complexity: extra camera choices can slow the station if labels are too technical.
- Ultra Wide tradeoffs: Ultra Wide focuses close but can have distortion, edge softness, lower light performance, and different torch availability.
- Virtual-camera variability: Triple and Dual Wide behavior can vary by device model, zoom, focus distance, and lighting.
- Native Camera parity limits: some native Camera processing is private and may not be exactly reproducible in AVFoundation.
- Stabilization latency: waiting too long can make Auto capture feel sluggish.
- Focus hunting: shiny jewelry and black backgrounds can keep focus/exposure adjusting until timeout.
- Validation ambiguity: glare, motion, object tilt, and depth-of-field can look similar without controlled tests.
- Device differences: a strategy that works on one deployed iPhone may not be optimal on another.
- Digital zoom degradation: zoom can make framing easier while reducing useful detail.

## Final Recommendation

Proceed with a hybrid Phase 5F implementation after this audit:

- keep current `Close-Up / Macro`
- add bounded focus/exposure stabilization
- test a virtual-first or Full Item close-up camera strategy on real elongated jewelry
- add a simple operator-facing `Full Item` or `Wide Detail` mode only if validation proves it improves sharpness without confusing the workflow
- keep import from Photos as the fallback, not the primary path

The likely root issue is not upload or general high-resolution quality. It is the interaction between close-distance depth of field, elongated-object geometry, current Ultra Wide-first Macro selection, and capture timing without an AF/AE stabilization gate.
