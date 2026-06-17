import AVFoundation
import PhotosUI
import SwiftUI

struct ReadyView: View {
    @StateObject private var viewModel: ReadyViewModel
    @State private var isShowingCancelConfirmation = false
    @State private var isShowingPhotoLibraryPicker = false
    @State private var selectedPhotoLibraryItems = [PhotosPickerItem]()
    @State private var previewedPhotoID: LocalSessionPhoto.ID?
    @State private var selectedThumbnailPhotoID: LocalSessionPhoto.ID?

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
            if !viewModel.isShowingPersistentResult && !viewModel.isReviewingCapturedPhoto && !viewModel.hasActiveJob {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(viewModel.station.name)
                            .font(.system(.title2, design: .serif).weight(.bold))
                            .foregroundStyle(OGVisualStyle.textPrimary)

                        HStack(spacing: 10) {
                            Label(viewModel.listenerState.label, systemImage: "dot.radiowaves.left.and.right")
                            Label(viewModel.captureMode.label, systemImage: "camera.aperture")
                            Label(activeQualityLabel, systemImage: "photo")
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(OGVisualStyle.goldSoft)
                    }
                    .ogCard(elevated: true, padding: 20)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
                }
            }

            if !viewModel.isShowingPersistentResult && !viewModel.isReviewingCapturedPhoto && !viewModel.hasActiveJob {
                Section("Listener") {
                    LabeledContent("Station", value: viewModel.station.name)
                    LabeledContent("Employee", value: viewModel.employee.displayName)
                    LabeledContent("Connection", value: viewModel.listenerState.label)
                    LabeledContent("Capture State", value: viewModel.captureState.label)
                    LabeledContent("Camera", value: viewModel.cameraAvailability.label)
                    LabeledContent("Camera Path", value: viewModel.cameraModeStatus.activeCameraLabel)
                    LabeledContent("Mode", value: viewModel.captureMode.label)
                    LabeledContent("Capture Quality", value: activeQualityLabel)
                    LabeledContent("Auto Listen", value: viewModel.autoListenStatus.label)

                    if let lastAutoListenCheckAt = viewModel.lastAutoListenCheckAt {
                        LabeledContent("Last Auto Check", value: lastAutoListenCheckAt.formatted(date: .omitted, time: .standard))
                    }

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
                .listRowBackground(OGVisualStyle.panel)

                Section("Capture Controls") {
                    Toggle("Auto Listen", isOn: autoListenBinding)

                    Text(autoListenHelpText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    Picker("Capture Mode", selection: captureModeBinding) {
                        ForEach(ReadyViewModel.CaptureMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)

                    Picker("Capture Quality", selection: captureResolutionModeBinding) {
                        ForEach(CaptureResolutionMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.menu)
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
                        Text("Capture quality is locked for the active capture session and applies to every kept photo in this job.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else if viewModel.captureResolutionMode == .highResolution {
                        Text("High Resolution requests the largest processed still-photo dimensions supported by the active camera format on this device.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else if viewModel.captureResolutionMode == .closeUpMacro {
                        Text("Macro is best for tiny close-up details.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else if viewModel.captureResolutionMode == .fullItem {
                        Text("Full Item is better for longer pieces and full-object sharpness.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    if let cameraModeMessage = viewModel.cameraModeStatus.message {
                        Text(cameraModeMessage)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .listRowBackground(OGVisualStyle.panel)
            }

            if viewModel.hasActiveJob && !viewModel.isShowingPersistentResult {
                Section {
                    activeCaptureStation
                        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                }
                .listRowBackground(Color.clear)
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
                    LabeledContent("Capture Quality", value: activeQualityLabel)

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
                    .buttonStyle(OGActionButtonStyle(role: .secondary))
                }
                .listRowBackground(OGVisualStyle.panel)
            }

            Section {
                Button("Refresh Now") {
                    Task {
                        await onRefreshStations()
                        await viewModel.refreshPendingJob()
                    }
                }
                .buttonStyle(OGActionButtonStyle(role: .secondary))

                Button("Change Station") {
                    onChangeStation()
                }
                .buttonStyle(OGActionButtonStyle(role: .secondary))
                .disabled(!viewModel.canChangeStation)

                Button("Log Out", role: .destructive) {
                    Task {
                        await onSignOut()
                    }
                }
                .buttonStyle(OGActionButtonStyle(role: .destructive))
                .disabled(!viewModel.canLogOut)

                if let activeJobExitSafetyMessage = viewModel.activeJobExitSafetyMessage {
                    Text(activeJobExitSafetyMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .ogListChrome()
        .navigationBarTitleDisplayMode(.inline)
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
        .fullScreenCover(isPresented: photoPreviewPresentationBinding) {
            keptPhotoPreviewCover
        }
        .photosPicker(
            isPresented: $isShowingPhotoLibraryPicker,
            selection: $selectedPhotoLibraryItems,
            maxSelectionCount: max(viewModel.remainingPhotoImportSlots, 1),
            matching: .images,
            preferredItemEncoding: .current
        )
        .onChange(of: selectedPhotoLibraryItems) { _, newItems in
            guard !newItems.isEmpty else { return }

            Task {
                let selectedCount = newItems.count
                var imageDataItems = [Data?]()
                for item in newItems {
                    imageDataItems.append(try? await item.loadTransferable(type: Data.self))
                }

                await viewModel.importPhotoLibraryImageData(imageDataItems, selectedCount: selectedCount)
                selectedPhotoLibraryItems = []
            }
        }
        .onChange(of: isShowingPhotoLibraryPicker) { _, isPresented in
            guard !isPresented, selectedPhotoLibraryItems.isEmpty else { return }
            viewModel.resumeCaptureAfterEmptyPhotoLibraryImportIfNeeded()
        }
    }

    private var activeCaptureStation: some View {
        VStack(alignment: .leading, spacing: 12) {
            activeCaptureHeader
            activeMediaArea

            if viewModel.isTorchControlVisible {
                torchControls
            }

            activeCaptureActions

            if let activeSession = viewModel.activeSession {
                keptPhotoSummary(activeSession)
            }

            activeJobFooterActions
        }
        .ogCard(elevated: true, padding: 14)
    }

    private var activeCaptureHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Job \(viewModel.activeJobReference)")
                        .font(.system(.title3, design: .serif).weight(.bold))
                        .foregroundStyle(OGVisualStyle.textPrimary)

                    Text(viewModel.station.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(OGVisualStyle.textSecondary)
                }

                Spacer(minLength: 12)

                Text("Photos: \(viewModel.sessionPhotoCount)/\(LocalCaptureSession.softMaxPhotoCount)")
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(OGVisualStyle.gold.opacity(0.18), in: Capsule())
                    .foregroundStyle(OGVisualStyle.goldSoft)
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    activeCapturePill(viewModel.captureMode.label, systemImage: "camera.aperture")
                    activeCapturePill(activeQualityLabel, systemImage: "photo")
                    activeCapturePill(viewModel.captureState.label, systemImage: "circle.dotted")
                }

                Text("\(viewModel.cameraModeStatus.activeCameraLabel) · \(viewModel.autoListenStatus.label)")
                    .font(.caption)
                    .foregroundStyle(OGVisualStyle.textSecondary)
                    .lineLimit(2)
            }
        }
    }

    private func activeCapturePill(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.78)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(OGVisualStyle.panel, in: Capsule())
            .foregroundStyle(OGVisualStyle.goldSoft)
    }

    @ViewBuilder
    private var activeMediaArea: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack {
                Rectangle()
                    .fill(Color.black)

                switch viewModel.captureState {
                case .reviewingCapture:
                    if let image = resultPreviewImage {
                        activeMediaImage(image)
                    } else {
                        activeMediaPlaceholder(title: "Review Capture", message: "Captured photo is loading.")
                    }
                case .uploadingFinalSet:
                    activeMediaPlaceholder(title: "Finishing Job", message: uploadProgressText)
                case .sessionReady:
                    if let image = viewModel.activeSession?.keptPhotos.last?.previewImage {
                        activeMediaImage(image)
                    } else {
                        activeMediaPlaceholder(title: "Ready For Capture", message: "Capture and keep at least one photo.")
                    }
                default:
                    if shouldShowPreview, let session = viewModel.previewSession {
                        livePreview(session)
                    } else {
                        activeMediaPlaceholder(title: viewModel.captureState.label, message: activeMediaStatusText)
                    }
                }
            }
            .aspectRatio(3.0 / 4.0, contentMode: .fit)
            .frame(maxWidth: .infinity)
            .overlay(
                Rectangle()
                    .stroke(OGVisualStyle.strokeStrong, lineWidth: 1)
            )

            if let mediaHint = activeMediaHint {
                Text(mediaHint)
                    .font(.footnote)
                    .foregroundStyle(OGVisualStyle.textSecondary)
            }
        }
    }

    private func activeMediaImage(_ image: UIImage) -> some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func livePreview(_ session: AVCaptureSession) -> some View {
        CameraPreviewView(
            session: session,
            isTapToFocusEnabled: viewModel.isTapToFocusEnabledForCurrentState,
            isPinchToZoomEnabled: isPreviewZoomEnabled,
            isHardwareShutterEnabled: isHardwareShutterEnabled,
            zoomFactor: viewModel.zoomFactor,
            onTapToFocus: viewModel.isTapToFocusEnabledForCurrentState ? { devicePoint in
                _ = Task {
                    await viewModel.focusPreview(at: devicePoint)
                }
            } : nil,
            onPinchToZoom: isPreviewZoomEnabled ? { zoomFactor in
                viewModel.updatePreviewZoom(to: zoomFactor)
            } : nil,
            onHardwareShutter: isHardwareShutterEnabled ? {
                viewModel.triggerHardwareShutterCapture()
            } : nil
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
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
    }

    private func activeMediaPlaceholder(title: String, message: String) -> some View {
        VStack(spacing: 8) {
            ProgressView()
                .tint(OGVisualStyle.gold)

            Text(title)
                .font(.headline)
                .foregroundStyle(OGVisualStyle.textPrimary)

            Text(message)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(OGVisualStyle.textSecondary)
                .padding(.horizontal, 20)
        }
    }

    private var torchControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Toggle("Torch", isOn: torchEnabledBinding)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(OGVisualStyle.textPrimary)
                    .disabled(!viewModel.canAdjustTorch)

                Spacer(minLength: 10)

                Text(viewModel.isTorchEnabled ? "On" : "Off")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(viewModel.isTorchEnabled ? OGVisualStyle.goldSoft : OGVisualStyle.textSecondary)
            }

            HStack(spacing: 12) {
                Text("Intensity")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OGVisualStyle.textSecondary)

                Slider(value: torchIntensityBinding, in: 0.1 ... 1.0)
                    .disabled(!viewModel.canAdjustTorch || !viewModel.isTorchEnabled)

                Text(torchIntensityPercent)
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(OGVisualStyle.goldSoft)
                    .frame(width: 44, alignment: .trailing)
            }

            if viewModel.isSparkleTorchControlVisible {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Toggle("Sparkle Light", isOn: sparkleTorchEnabledBinding)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(OGVisualStyle.textPrimary)
                            .disabled(!viewModel.canAdjustSparkleTorch)

                        Spacer(minLength: 10)

                        Text(viewModel.isSparkleTorchEnabled ? "On" : "Off")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(viewModel.isSparkleTorchEnabled ? OGVisualStyle.goldSoft : OGVisualStyle.textSecondary)
                    }

                    Text("Gently varies torch brightness for reflective jewelry.")
                        .font(.footnote)
                        .foregroundStyle(OGVisualStyle.textSecondary)

                    if viewModel.isSparkleTorchEnabled {
                        Picker("Sparkle Strength", selection: sparkleTorchStrengthBinding) {
                            ForEach(ReadyViewModel.SparkleTorchStrength.allCases) { strength in
                                Text(strength.label).tag(strength)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
            }

            if let message = viewModel.torchAvailabilityMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(OGVisualStyle.textSecondary)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(OGVisualStyle.panel)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(OGVisualStyle.stroke, lineWidth: 1)
                )
        )
    }

    @ViewBuilder
    private var activeCaptureActions: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch viewModel.captureState {
            case .waitingForManualCapture:
                Button("Capture Photo") {
                    viewModel.triggerManualCapture()
                }
                .buttonStyle(OGActionButtonStyle(role: .primary))
            case .captureRequested:
                Text("Auto capture is armed for \(viewModel.autoCaptureDelay.formatted(.number.precision(.fractionLength(1)))) seconds.")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OGVisualStyle.goldSoft)
            case .capturing:
                Text("Capturing photo...")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OGVisualStyle.goldSoft)
            case .reviewingCapture:
                HStack(spacing: 10) {
                    Button("Keep") {
                        viewModel.keepCapturedPhoto()
                    }
                    .buttonStyle(OGActionButtonStyle(role: .primary))

                    Button("Discard / Retake", role: .destructive) {
                        viewModel.discardCapturedPhoto()
                    }
                    .buttonStyle(OGActionButtonStyle(role: .destructive))
                }
            case .sessionReady:
                Button("Add Another Photo") {
                    viewModel.addAnotherPhoto()
                }
                .buttonStyle(OGActionButtonStyle(role: .primary))
                .disabled(!viewModel.canAddMoreSessionPhotos || !isReadyToAddAnotherPhoto)
            case .uploadingFinalSet:
                Text(uploadProgressText)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OGVisualStyle.goldSoft)
            case .idle, .listening, .completed, .failed:
                EmptyView()
            }

            if viewModel.canImportPhotos {
                Button("Import From Photos") {
                    viewModel.prepareForPhotoLibraryImport()
                    isShowingPhotoLibraryPicker = true
                }
                .buttonStyle(OGActionButtonStyle(role: .secondary))
            }

            if let photoLibraryImportMessage = viewModel.photoLibraryImportMessage {
                Text(photoLibraryImportMessage)
                    .font(.footnote)
                    .foregroundStyle(OGVisualStyle.textSecondary)
            }

            if let actionHelpText {
                Text(actionHelpText)
                    .font(.footnote)
                    .foregroundStyle(OGVisualStyle.textSecondary)
            }
        }
    }

    private func keptPhotoSummary(_ activeSession: LocalCaptureSession) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Kept Photos")
                    .font(.headline)
                    .foregroundStyle(OGVisualStyle.textPrimary)

                Spacer()

                Text("\(activeSession.keptPhotoCount)/\(LocalCaptureSession.softMaxPhotoCount)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OGVisualStyle.textSecondary)
            }

            if activeSession.keptPhotos.isEmpty {
                Text("No kept photos yet.")
                    .font(.footnote)
                    .foregroundStyle(OGVisualStyle.textSecondary)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(activeSession.keptPhotos) { photo in
                            compactKeptPhotoCard(photo)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }

            if !viewModel.canAddMoreSessionPhotos {
                Text("Soft max reached. Delete a kept photo before capturing another one.")
                    .font(.footnote)
                    .foregroundStyle(OGVisualStyle.textSecondary)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(OGVisualStyle.panel)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(OGVisualStyle.stroke, lineWidth: 1)
                )
        )
    }

    private func compactKeptPhotoCard(_ photo: LocalSessionPhoto) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Button {
                previewedPhotoID = photo.id
                selectedThumbnailPhotoID = photo.id
            } label: {
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(OGVisualStyle.panelElevated)

                    if let image = photo.previewImage {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                    }

                    if photo.isPrimary {
                        Text("Primary")
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 4)
                            .background(OGVisualStyle.gold.opacity(0.9), in: Capsule())
                            .foregroundStyle(Color.black.opacity(0.85))
                            .padding(6)
                    }
                }
                .frame(width: 112, height: 84)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(
                            selectedThumbnailPhotoID == photo.id ? OGVisualStyle.goldSoft : OGVisualStyle.strokeStrong,
                            lineWidth: selectedThumbnailPhotoID == photo.id ? 2 : 1
                        )
                )
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Preview photo \(photo.sortOrder + 1)")

            HStack(spacing: 5) {
                Text("Photo \(photo.sortOrder + 1)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OGVisualStyle.textPrimary)

                if selectedThumbnailPhotoID == photo.id {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(OGVisualStyle.goldSoft)
                }
            }

            Button("Delete", role: .destructive) {
                viewModel.deleteKeptPhoto(photo)
                if previewedPhotoID == photo.id {
                    previewedPhotoID = nil
                }
                if selectedThumbnailPhotoID == photo.id {
                    selectedThumbnailPhotoID = nil
                }
            }
            .font(.caption.weight(.semibold))
            .buttonStyle(.bordered)
            .tint(OGVisualStyle.destructive)
        }
        .frame(width: 112, alignment: .leading)
    }

    @ViewBuilder
    private var keptPhotoPreviewCover: some View {
        if let photos = viewModel.activeSession?.keptPhotos, !photos.isEmpty {
            KeptPhotoPreviewView(
                photos: photos,
                selectedPhotoID: selectedPreviewPhotoBinding(photos: photos),
                onClose: {
                    previewedPhotoID = nil
                },
                onDelete: {
                    deletePreviewedPhoto(from: photos)
                }
            )
        } else {
            Color.black
                .ignoresSafeArea()
                .onAppear {
                    previewedPhotoID = nil
                }
        }
    }

    private var photoPreviewPresentationBinding: Binding<Bool> {
        Binding(
            get: { previewedPhotoID != nil },
            set: { isPresented in
                if !isPresented {
                    previewedPhotoID = nil
                }
            }
        )
    }

    private func selectedPreviewPhotoBinding(photos: [LocalSessionPhoto]) -> Binding<LocalSessionPhoto.ID> {
        Binding(
            get: {
                guard let previewedPhotoID, photos.contains(where: { $0.id == previewedPhotoID }) else {
                    return photos[0].id
                }

                return previewedPhotoID
            },
            set: { newValue in
                previewedPhotoID = newValue
                selectedThumbnailPhotoID = newValue
            }
        )
    }

    private func deletePreviewedPhoto(from photos: [LocalSessionPhoto]) {
        let selectedID = previewedPhotoID ?? photos[0].id
        guard let selectedIndex = photos.firstIndex(where: { $0.id == selectedID }) else {
            previewedPhotoID = nil
            return
        }

        let photo = photos[selectedIndex]
        let remainingPhotos = photos.filter { $0.id != photo.id }
        viewModel.deleteKeptPhoto(photo)

        guard !remainingPhotos.isEmpty else {
            previewedPhotoID = nil
            selectedThumbnailPhotoID = nil
            return
        }

        let nextIndex = min(selectedIndex, remainingPhotos.count - 1)
        previewedPhotoID = remainingPhotos[nextIndex].id
        selectedThumbnailPhotoID = remainingPhotos[nextIndex].id
    }

    private var activeJobFooterActions: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button("Finish Job") {
                    viewModel.finishJob()
                }
                .buttonStyle(OGActionButtonStyle(role: .primary))
                .disabled(!canFinishJobFromActiveSurface)

                Button("Cancel Job", role: .destructive) {
                    isShowingCancelConfirmation = true
                }
                .buttonStyle(OGActionButtonStyle(role: .destructive))
                .disabled(!viewModel.canCancelActiveJob)
            }

            if let finishJobMessage = viewModel.finishJobMessage {
                Text(finishJobMessage)
                    .font(.footnote)
                    .foregroundStyle(OGVisualStyle.textSecondary)
            } else if !canFinishJobFromActiveSurface {
                Text(finishDisabledReason)
                    .font(.footnote)
                    .foregroundStyle(OGVisualStyle.textSecondary)
            }

            if let cancelJobAvailabilityMessage = viewModel.cancelJobAvailabilityMessage {
                Text(cancelJobAvailabilityMessage)
                    .font(.footnote)
                    .foregroundStyle(OGVisualStyle.textSecondary)
            }
        }
    }

    private var activeQualityLabel: String {
        viewModel.activeSession?.resolutionMode.label ?? viewModel.captureResolutionMode.label
    }

    private var shouldShowPreview: Bool {
        switch viewModel.captureState {
        case .captureRequested, .waitingForManualCapture, .capturing:
            true
        case .idle, .listening, .reviewingCapture, .sessionReady, .uploadingFinalSet, .completed, .failed:
            false
        }
    }

    private var activeMediaStatusText: String {
        switch viewModel.captureState {
        case .sessionReady:
            "Ready for the next photo."
        case .uploadingFinalSet:
            uploadProgressText
        case .capturing:
            "Saving the current frame for review."
        default:
            "Preparing the capture station."
        }
    }

    private var activeMediaHint: String? {
        switch viewModel.captureState {
        case .captureRequested, .waitingForManualCapture:
            previewInteractionHint
        case .reviewingCapture:
            "Review this capture before adding it to the local photo set."
        case .sessionReady:
            "The last kept photo is shown here. Add another photo or finish the job."
        case .uploadingFinalSet:
            nil
        case .idle, .listening, .capturing, .completed, .failed:
            nil
        }
    }

    private var actionHelpText: String? {
        switch viewModel.captureState {
        case .captureRequested:
            "Cancel Job remains available while auto capture is waiting."
        case .waitingForManualCapture:
            "Tap Capture Photo when framing and focus look right."
        case .reviewingCapture:
            "Keep stores this photo locally. Discard clears only this new capture and returns to the same job."
        case .sessionReady:
            "Kept photos stay local until Finish Job uploads the approved set."
        case .uploadingFinalSet:
            nil
        case .idle, .listening, .capturing, .completed, .failed:
            nil
        }
    }

    private var uploadProgressText: String {
        if let activeSession = viewModel.activeSession {
            return "Uploading \(activeSession.keptPhotoCount) kept photo\(activeSession.keptPhotoCount == 1 ? "" : "s") and finalizing."
        }

        return "Uploading kept photos and finalizing."
    }

    private var canFinishJobFromActiveSurface: Bool {
        guard viewModel.canFinishJob else { return false }

        if case .reviewingCapture = viewModel.captureState {
            return false
        }

        return true
    }

    private var finishDisabledReason: String {
        if viewModel.isReviewingCapturedPhoto {
            return "Keep or discard the current capture before finishing the job."
        }

        if viewModel.sessionPhotoCount == 0 {
            return "Finish Job enables after at least one photo is kept."
        }

        if viewModel.isUploadingFinalSet {
            return "Finish Job is already uploading."
        }

        if viewModel.isImportingPhotos {
            return "Photo import is still processing."
        }

        return "Finish Job is temporarily unavailable."
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

    private var isHardwareShutterEnabled: Bool {
        previewedPhotoID == nil && viewModel.canTriggerHardwareShutterCapture
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

    private var autoListenBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isAutoListenEnabled },
            set: { viewModel.updateAutoListenEnabled($0) }
        )
    }

    private var autoListenHelpText: String {
        if viewModel.isAutoListenEnabled {
            return viewModel.lastAutoListenCheckAt.map {
                "Auto Listen is \(viewModel.autoListenStatus.label.lowercased()). Last checked \($0.formatted(date: .omitted, time: .standard))."
            } ?? "Auto Listen is \(viewModel.autoListenStatus.label.lowercased())."
        }

        return "Auto Listen is off. Realtime listener and Refresh Now remain available."
    }

    private var captureResolutionModeBinding: Binding<CaptureResolutionMode> {
        Binding(
            get: { viewModel.captureResolutionMode },
            set: { viewModel.updateCaptureResolutionMode($0) }
        )
    }

    private var torchEnabledBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isTorchEnabled },
            set: { viewModel.updateTorchEnabled($0) }
        )
    }

    private var torchIntensityBinding: Binding<Double> {
        Binding(
            get: { viewModel.torchIntensity },
            set: { viewModel.updateTorchIntensity($0) }
        )
    }

    private var sparkleTorchEnabledBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isSparkleTorchEnabled },
            set: { viewModel.updateSparkleTorchEnabled($0) }
        )
    }

    private var sparkleTorchStrengthBinding: Binding<ReadyViewModel.SparkleTorchStrength> {
        Binding(
            get: { viewModel.sparkleTorchStrength },
            set: { viewModel.updateSparkleTorchStrength($0) }
        )
    }

    private var torchIntensityPercent: String {
        viewModel.torchIntensity.formatted(.percent.precision(.fractionLength(0)))
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

private struct KeptPhotoPreviewView: View {
    let photos: [LocalSessionPhoto]
    @Binding var selectedPhotoID: LocalSessionPhoto.ID
    let onClose: () -> Void
    let onDelete: () -> Void

    @State private var isShowingDeleteConfirmation = false

    var body: some View {
        ZStack {
            Color.black
                .ignoresSafeArea()

            VStack(spacing: 0) {
                header

                TabView(selection: $selectedPhotoID) {
                    ForEach(photos) { photo in
                        previewPage(photo)
                            .tag(photo.id)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: photos.count > 1 ? .automatic : .never))

                footer
            }
        }
        .tint(OGVisualStyle.gold)
        .confirmationDialog(
            "Delete this kept photo?",
            isPresented: $isShowingDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete Photo", role: .destructive) {
                onDelete()
            }

            Button("Keep Photo", role: .cancel) {}
        } message: {
            Text("This removes the local kept photo from the active session. Remaining photos will keep their current order rules.")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                onClose()
            } label: {
                Image(systemName: "xmark")
                    .font(.headline.weight(.bold))
                    .frame(width: 42, height: 42)
                    .background(OGVisualStyle.panelElevated, in: Circle())
                    .foregroundStyle(OGVisualStyle.textPrimary)
            }
            .accessibilityLabel("Close photo preview")

            VStack(alignment: .leading, spacing: 3) {
                Text(currentPhoto.map { "Photo \($0.sortOrder + 1)" } ?? "Kept Photo")
                    .font(.system(.title3, design: .serif).weight(.bold))
                    .foregroundStyle(OGVisualStyle.textPrimary)

                Text(photoPositionText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OGVisualStyle.textSecondary)
            }

            Spacer(minLength: 12)

            if currentPhoto?.isPrimary == true {
                Text("Primary")
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(OGVisualStyle.gold.opacity(0.92), in: Capsule())
                    .foregroundStyle(Color.black.opacity(0.86))
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 18)
        .padding(.bottom, 10)
    }

    private func previewPage(_ photo: LocalSessionPhoto) -> some View {
        VStack(spacing: 12) {
            if let image = photo.previewImage {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.horizontal, 10)
            } else {
                VStack(spacing: 10) {
                    Image(systemName: "photo")
                        .font(.largeTitle.weight(.semibold))
                        .foregroundStyle(OGVisualStyle.goldSoft)

                    Text("Photo preview is unavailable.")
                        .font(.headline)
                        .foregroundStyle(OGVisualStyle.textPrimary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 14) {
            if let currentPhoto {
                metadata(for: currentPhoto)
            }

            HStack(spacing: 10) {
                Button("Close") {
                    onClose()
                }
                .buttonStyle(OGActionButtonStyle(role: .secondary))

                Button("Delete Photo", role: .destructive) {
                    isShowingDeleteConfirmation = true
                }
                .buttonStyle(OGActionButtonStyle(role: .destructive))
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 10)
        .padding(.bottom, 20)
        .background(
            LinearGradient(
                colors: [
                    Color.black.opacity(0.0),
                    Color.black.opacity(0.88)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
        )
    }

    private func metadata(for photo: LocalSessionPhoto) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                metadataItem("Captured", photo.capturedAt.formatted(date: .abbreviated, time: .shortened))
                Spacer(minLength: 12)
                metadataItem("Size", ByteCountFormatter.string(fromByteCount: photo.fileSizeBytes, countStyle: .file))
            }

            HStack {
                metadataItem("Dimensions", "\(photo.imageWidth)x\(photo.imageHeight)")
                Spacer(minLength: 12)
                metadataItem("Type", photo.mimeType)
            }

            if photo.isSimulatorFallback {
                Text("Simulator fallback capture")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(OGVisualStyle.textSecondary)
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(OGVisualStyle.panel.opacity(0.94))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(OGVisualStyle.strokeStrong, lineWidth: 1)
                )
        )
    }

    private func metadataItem(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(OGVisualStyle.textSecondary)

            Text(value)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.78)
                .foregroundStyle(OGVisualStyle.textPrimary)
        }
    }

    private var currentPhoto: LocalSessionPhoto? {
        photos.first { $0.id == selectedPhotoID } ?? photos.first
    }

    private var photoPositionText: String {
        guard let currentIndex = photos.firstIndex(where: { $0.id == selectedPhotoID }) else {
            return "\(photos.count) kept photo\(photos.count == 1 ? "" : "s")"
        }

        return "\(currentIndex + 1) of \(photos.count)"
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
