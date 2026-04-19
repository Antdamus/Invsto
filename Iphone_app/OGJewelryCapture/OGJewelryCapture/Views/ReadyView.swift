import SwiftUI

struct ReadyView: View {
    @StateObject private var viewModel: ReadyViewModel
    @State private var isShowingCancelConfirmation = false

    let onChangeStation: () -> Void
    let onRefreshStations: () async -> Void
    let onSignOut: () async -> Void

    init(
        employee: AuthenticatedEmployee,
        station: CaptureStation,
        onChangeStation: @escaping () -> Void,
        onRefreshStations: @escaping () async -> Void,
        onSignOut: @escaping () async -> Void
    ) {
        _viewModel = StateObject(wrappedValue: ReadyViewModel(employee: employee, station: station))
        self.onChangeStation = onChangeStation
        self.onRefreshStations = onRefreshStations
        self.onSignOut = onSignOut
    }

    var body: some View {
        List {
            if !viewModel.isShowingPersistentResult && !viewModel.isReviewingCapturedPhoto {
                Section("Listener") {
                    LabeledContent("Station", value: viewModel.station.name)
                    LabeledContent("Employee", value: viewModel.employee.displayName)
                    LabeledContent("Connection", value: viewModel.listenerState.label)
                    LabeledContent("Capture State", value: viewModel.captureState.label)
                    LabeledContent("Camera", value: viewModel.cameraAvailability.label)
                    LabeledContent("Mode", value: viewModel.captureMode.label)
                    LabeledContent("Resolution", value: activeResolutionLabel)

                    if let role = viewModel.employee.role, !role.isEmpty {
                        LabeledContent("Role", value: role)
                    }

                    if let deviceLabel = viewModel.station.deviceLabel, !deviceLabel.isEmpty {
                        LabeledContent("Device", value: deviceLabel)
                    }

                    if viewModel.activeSession != nil {
                        LabeledContent("Kept Photos", value: "\(viewModel.sessionPhotoCount)/\(LocalCaptureSession.softMaxPhotoCount)")
                    }

                    if let finishJobMessage = viewModel.finishJobMessage {
                        Text(finishJobMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Capture Controls") {
                    Picker("Capture Mode", selection: captureModeBinding) {
                        ForEach(ReadyViewModel.CaptureMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)

                    Picker("Resolution", selection: captureResolutionModeBinding) {
                        ForEach(CaptureResolutionMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .disabled(viewModel.isResolutionSelectionLocked)

                    if viewModel.captureMode == .auto {
                        Stepper(value: autoCaptureDelayBinding, in: 0.5 ... 15.0, step: 0.5) {
                            LabeledContent(
                                "Auto Delay",
                                value: "\(viewModel.autoCaptureDelay.formatted(.number.precision(.fractionLength(1)))) sec"
                            )
                        }
                    }

                    switch viewModel.captureState {
                    case .captureRequested:
                        Text("Preview is live. Auto capture will trigger after the configured delay.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    case .waitingForManualCapture:
                        Text("Preview is live. Tap the shutter when framing and focus look right.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    case .sessionReady:
                        Text("Kept photos stay local until Finish Job uploads them sequentially and the backend finalizer completes the parent job.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    case .uploadingFinalSet:
                        Text("Finish Job is uploading the kept photos in order and will complete the parent job only after the backend finalizer succeeds.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    default:
                        EmptyView()
                    }

                    if viewModel.isResolutionSelectionLocked {
                        Text("Resolution is locked for the active capture session and applies to every kept photo in this job.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else if viewModel.captureResolutionMode == .highResolution {
                        Text("High Resolution requests the largest processed still-photo dimensions supported by the active camera format on this device.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if viewModel.hasActiveJob && !viewModel.isShowingPersistentResult {
                Section("Active Job") {
                    LabeledContent("Job", value: viewModel.activeJobReference)
                    LabeledContent("State", value: viewModel.captureState.label)

                    if let cancelJobAvailabilityMessage = viewModel.cancelJobAvailabilityMessage {
                        Text(cancelJobAvailabilityMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    Button("Cancel Job", role: .destructive) {
                        isShowingCancelConfirmation = true
                    }
                    .buttonStyle(.bordered)
                    .disabled(!viewModel.canCancelActiveJob)
                }
            }

            if let activeSession = viewModel.activeSession, !viewModel.isShowingPersistentResult {
                Section("Active Session") {
                    LabeledContent("Job", value: pendingJobReference)
                    LabeledContent("Kept Photos", value: "\(activeSession.keptPhotoCount)/\(LocalCaptureSession.softMaxPhotoCount)")
                    LabeledContent("Resolution", value: activeSession.resolutionMode.label)

                    if let primaryPhoto = activeSession.primaryPhoto {
                        LabeledContent("Primary", value: "Photo \(primaryPhoto.sortOrder + 1)")
                    }

                    if activeSession.keptPhotos.isEmpty {
                        Text("No kept photos yet. Capture and keep at least one photo to enable Finish Job.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(activeSession.keptPhotos) { photo in
                            VStack(alignment: .leading, spacing: 12) {
                                if let image = photo.previewImage {
                                    Image(uiImage: image)
                                        .resizable()
                                        .scaledToFit()
                                        .clipShape(RoundedRectangle(cornerRadius: 16))
                                }

                                HStack {
                                    Text("Photo \(photo.sortOrder + 1)")
                                        .font(.headline)

                                    if photo.isPrimary {
                                        Text("Primary")
                                            .font(.caption.weight(.semibold))
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 4)
                                            .background(Color.accentColor.opacity(0.15), in: Capsule())
                                    }
                                }

                                LabeledContent("Captured", value: photo.capturedAt.formatted(date: .abbreviated, time: .standard))
                                LabeledContent("Size", value: ByteCountFormatter.string(fromByteCount: photo.fileSizeBytes, countStyle: .file))
                                LabeledContent("Dimensions", value: photoDimensionsLabel(photo))
                                LabeledContent("Type", value: photo.mimeType)

                                if photo.isSimulatorFallback {
                                    Text("Captured using the simulator fallback path.")
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }

                                Button("Delete Photo", role: .destructive) {
                                    viewModel.deleteKeptPhoto(photo)
                                }
                                .buttonStyle(.bordered)
                            }
                            .padding(.vertical, 4)
                        }
                    }

                    if !viewModel.canAddMoreSessionPhotos {
                        Text("Soft max reached. Delete a kept photo before capturing another one.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    Button(activeSession.keptPhotos.isEmpty ? "Capture First Photo" : "Add Another Photo") {
                        viewModel.addAnotherPhoto()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!viewModel.canAddMoreSessionPhotos || !isReadyToAddAnotherPhoto)

                    Button("Finish Job") {
                        viewModel.finishJob()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!viewModel.canFinishJob)

                    if let finishJobMessage = viewModel.finishJobMessage {
                        Text(finishJobMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if shouldShowPreview, let session = viewModel.previewSession {
                Section("Live Preview") {
                    CameraPreviewView(
                        session: session,
                        isTapToFocusEnabled: viewModel.isTapToFocusEnabledForCurrentState,
                        isPinchToZoomEnabled: isPreviewZoomEnabled,
                        zoomFactor: viewModel.zoomFactor,
                        onTapToFocus: viewModel.isTapToFocusEnabledForCurrentState ? { devicePoint in
                            _ = Task {
                                await viewModel.focusPreview(at: devicePoint)
                            }
                        } : nil,
                        onPinchToZoom: isPreviewZoomEnabled ? { zoomFactor in
                            viewModel.updatePreviewZoom(to: zoomFactor)
                        } : nil
                    )
                    .frame(height: 320)
                    .overlay(alignment: .topTrailing) {
                        if isPreviewZoomEnabled, viewModel.zoomRange.upperBound > 1.0 {
                            Text("\(Double(viewModel.zoomFactor).formatted(.number.precision(.fractionLength(1))))x")
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(.ultraThinMaterial, in: Capsule())
                                .padding(12)
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .listRowInsets(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))

                    if viewModel.isTapToFocusEnabledForCurrentState {
                        Text(previewInteractionHint)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else if isPreviewZoomEnabled, viewModel.zoomRange.upperBound > 1.0 {
                        Text("Pinch the preview to adjust framing before capture.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    if case .waitingForManualCapture = viewModel.captureState {
                        Button("Capture Photo") {
                            viewModel.triggerManualCapture()
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }

            if viewModel.isReviewingCapturedPhoto {
                Section("Review Capture") {
                    if let image = resultPreviewImage {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                    }

                    LabeledContent("Station", value: viewModel.station.name)
                    LabeledContent("Connection", value: viewModel.listenerState.label)
                    LabeledContent("Capture State", value: viewModel.captureState.label)
                    LabeledContent("Mode", value: viewModel.captureMode.label)
                    LabeledContent("Resolution", value: activeResolutionLabel)

                    if let latestLocalResult = viewModel.latestLocalResult {
                        LabeledContent("Job", value: String(latestLocalResult.jobID.uuidString.prefix(8)).uppercased())
                        LabeledContent("Captured", value: latestLocalResult.capturedAt.formatted(date: .abbreviated, time: .standard))
                        LabeledContent("Bytes", value: ByteCountFormatter.string(fromByteCount: latestLocalResult.fileSizeBytes, countStyle: .file))
                    }

                    Text("Keep stores this photo locally in the active session. Discard clears only this new capture and returns to the same job without uploading.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Button("Keep") {
                        viewModel.keepCapturedPhoto()
                    }
                    .buttonStyle(.borderedProminent)

                    Button("Discard / Retake", role: .destructive) {
                        viewModel.discardCapturedPhoto()
                    }
                    .buttonStyle(.bordered)
                }
            }

            if viewModel.isShowingPersistentResult {
                Section("Result") {
                    if let image = resultPreviewImage {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                    }

                    LabeledContent("Station", value: viewModel.station.name)
                    LabeledContent("Connection", value: viewModel.listenerState.label)
                    LabeledContent("Capture State", value: viewModel.captureState.label)
                    LabeledContent("Mode", value: viewModel.captureMode.label)
                    LabeledContent("Resolution", value: activeResolutionLabel)

                    if let latestUploadResult = viewModel.latestUploadResult {
                        LabeledContent("Job", value: String(latestUploadResult.jobID.uuidString.prefix(8)).uppercased())
                        LabeledContent("Captured", value: latestUploadResult.capturedAt.formatted(date: .abbreviated, time: .standard))
                        LabeledContent("Uploaded", value: latestUploadResult.uploadedAt.formatted(date: .abbreviated, time: .standard))
                        LabeledContent("Bucket", value: latestUploadResult.storageBucket)
                        LabeledContent("Path", value: latestUploadResult.storagePathSummary)
                        LabeledContent("Bytes", value: ByteCountFormatter.string(fromByteCount: latestUploadResult.fileSizeBytes, countStyle: .file))
                        LabeledContent("Type", value: latestUploadResult.mimeType)

                        if latestUploadResult.isSimulatorFallback {
                            Text("Captured using the simulator fallback path.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    } else if let latestLocalResult = viewModel.latestLocalResult {
                        LabeledContent("Job", value: String(latestLocalResult.jobID.uuidString.prefix(8)).uppercased())
                        LabeledContent("Captured", value: latestLocalResult.capturedAt.formatted(date: .abbreviated, time: .standard))
                        LabeledContent("Bytes", value: ByteCountFormatter.string(fromByteCount: latestLocalResult.fileSizeBytes, countStyle: .file))
                    }

                    if case let .failed(jobID, message) = viewModel.captureState {
                        if viewModel.latestLocalResult == nil, let jobID {
                            LabeledContent("Job", value: String(jobID.uuidString.prefix(8)).uppercased())
                        }

                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }

                    Button("Reset") {
                        viewModel.resetResult()
                    }
                    .buttonStyle(.borderedProminent)
                }
            }

            Section {
                Button("Refresh Listener / Jobs") {
                    Task {
                        await onRefreshStations()
                        await viewModel.refreshPendingJob()
                    }
                }

                Button("Change Station") {
                    onChangeStation()
                }

                Button("Log Out", role: .destructive) {
                    Task {
                        await onSignOut()
                    }
                }
            }
        }
        .task {
            await viewModel.start()
        }
        .onDisappear {
            Task {
                await viewModel.stop()
            }
        }
        .alert("Cancel this job?", isPresented: $isShowingCancelConfirmation) {
            Button("Keep Working", role: .cancel) {}
            Button("Cancel Job", role: .destructive) {
                viewModel.cancelActiveJob()
            }
        } message: {
            Text("Are you sure you want to cancel this job? The capture will be failed, local session photos will be cleared, and the station will return to listening.")
        }
    }

    private var activeResolutionLabel: String {
        viewModel.activeSession?.resolutionMode.label ?? viewModel.captureResolutionMode.label
    }

    private var pendingJobReference: String {
        viewModel.activeSession.map { String($0.jobID.uuidString.prefix(8)).uppercased() } ?? viewModel.activeJobReference
    }

    private var shouldShowPreview: Bool {
        switch viewModel.captureState {
        case .captureRequested, .waitingForManualCapture, .capturing:
            true
        case .idle, .listening, .reviewingCapture, .sessionReady, .uploadingFinalSet, .completed, .failed:
            false
        }
    }

    private var previewInteractionHint: String {
        switch viewModel.captureMode {
        case .auto:
            "Tap the preview to refocus and pinch to adjust framing before auto capture fires."
        case .manual:
            "Tap the preview to focus and pinch to adjust framing before taking the photo."
        }
    }

    private var isPreviewZoomEnabled: Bool {
        guard viewModel.zoomRange.upperBound > 1.0 else { return false }

        return switch viewModel.captureState {
        case .captureRequested, .waitingForManualCapture:
            true
        case .idle, .listening, .capturing, .reviewingCapture, .sessionReady, .uploadingFinalSet, .completed, .failed:
            false
        }
    }

    private var isReadyToAddAnotherPhoto: Bool {
        if case .sessionReady = viewModel.captureState {
            return true
        }

        return false
    }

    private var captureModeBinding: Binding<ReadyViewModel.CaptureMode> {
        Binding(
            get: { viewModel.captureMode },
            set: { viewModel.updateCaptureMode($0) }
        )
    }

    private var captureResolutionModeBinding: Binding<CaptureResolutionMode> {
        Binding(
            get: { viewModel.captureResolutionMode },
            set: { viewModel.updateCaptureResolutionMode($0) }
        )
    }

    private var autoCaptureDelayBinding: Binding<Double> {
        Binding(
            get: { viewModel.autoCaptureDelay },
            set: { viewModel.updateAutoCaptureDelay($0) }
        )
    }

    private var resultPreviewImage: UIImage? {
        viewModel.latestUploadResult?.previewImage ?? viewModel.latestLocalResult?.previewImage
    }

    private func photoDimensionsLabel(_ photo: LocalSessionPhoto) -> String {
        guard photo.imageWidth > 0, photo.imageHeight > 0 else { return "Unknown" }
        return "\(photo.imageWidth) × \(photo.imageHeight)"
    }
}

#Preview {
    ReadyView(
        employee: AuthenticatedEmployee(
            employeeID: UUID(),
            userID: UUID(),
            email: "employee@example.com",
            displayName: "Taylor Kim",
            role: "manager"
        ),
        station: CaptureStation(
            id: UUID(),
            name: "Preview Station",
            active: true,
            assignedEmployeeID: nil,
            deviceLabel: "iPhone 16 Pro",
            iosDeviceIdentifier: nil,
            lastSeenAt: nil
        ),
        onChangeStation: {},
        onRefreshStations: {},
        onSignOut: {}
    )
}
