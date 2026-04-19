import SwiftUI

struct ReadyView: View {
    @StateObject private var viewModel: ReadyViewModel

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
                    LabeledContent("Resolution", value: viewModel.captureResolutionMode.label)

                    if let role = viewModel.employee.role, !role.isEmpty {
                        LabeledContent("Role", value: role)
                    }

                    if let deviceLabel = viewModel.station.deviceLabel, !deviceLabel.isEmpty {
                        LabeledContent("Device", value: deviceLabel)
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
                    default:
                        EmptyView()
                    }

                    if viewModel.captureResolutionMode == .highResolution {
                        Text("High Resolution requests the largest processed still-photo dimensions supported by the active camera format on this device.")
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
                    LabeledContent("Resolution", value: viewModel.captureResolutionMode.label)

                    if let latestLocalResult = viewModel.latestLocalResult {
                        LabeledContent("Job", value: String(latestLocalResult.jobID.uuidString.prefix(8)).uppercased())
                        LabeledContent("Captured", value: latestLocalResult.capturedAt.formatted(date: .abbreviated, time: .standard))
                        LabeledContent("Bytes", value: ByteCountFormatter.string(fromByteCount: Int64(latestLocalResult.fileSizeBytes), countStyle: .file))
                    }

                    Text("Keep uploads and finalizes this capture. Discard clears it and returns to the same job without leaving capture mode.")
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
                    LabeledContent("Resolution", value: viewModel.captureResolutionMode.label)

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
                        LabeledContent("Bytes", value: ByteCountFormatter.string(fromByteCount: Int64(latestLocalResult.fileSizeBytes), countStyle: .file))
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

#if DEBUG
                Button("Simulate Capture Request") {
                    Task {
                        await viewModel.simulateCaptureRequest()
                    }
                }
#endif

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
    }

    private var shouldShowPreview: Bool {
        switch viewModel.captureState {
        case .captureRequested, .waitingForManualCapture, .capturing:
            true
        case .idle, .listening, .reviewingCapture, .uploading, .completed, .failed:
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
        case .idle, .listening, .capturing, .reviewingCapture, .uploading, .completed, .failed:
            false
        }
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
}

#Preview {
    ReadyView(
        employee: AuthenticatedEmployee(
            employeeID: UUID(),
            userID: UUID(),
            email: "employee@example.com",
            displayName: "OG Employee",
            role: "employee"
        ),
        station: CaptureStation(
            id: UUID(),
            name: "Photo Table 1",
            active: true,
            assignedEmployeeID: nil,
            deviceLabel: "Front iPhone",
            iosDeviceIdentifier: nil,
            lastSeenAt: nil
        ),
        onChangeStation: {},
        onRefreshStations: {},
        onSignOut: {}
    )
}
