import AVFoundation
import Combine
import Foundation

@MainActor
final class ReadyViewModel: ObservableObject {
    enum CaptureMode: String, CaseIterable, Identifiable {
        case auto
        case manual

        var id: String { rawValue }

        var label: String {
            switch self {
            case .auto:
                "Auto"
            case .manual:
                "Manual"
            }
        }
    }

    enum CaptureState: Equatable {
        case idle
        case listening
        case captureRequested(CaptureJob)
        case waitingForManualCapture(CaptureJob)
        case capturing(CaptureJob)
        case reviewingCapture(CaptureJob, LocalCaptureResult)
        case uploading(CaptureJob)
        case completed(CaptureUploadResult)
        case failed(jobID: UUID?, message: String)

        var label: String {
            switch self {
            case .idle:
                "Idle"
            case .listening:
                "Listening"
            case .captureRequested:
                "Preview ready"
            case .waitingForManualCapture:
                "Waiting for shutter"
            case .capturing:
                "Capturing"
            case .reviewingCapture:
                "Review Capture"
            case .uploading:
                "Uploading"
            case .completed:
                "Completed"
            case .failed:
                "Failed"
            }
        }
    }

    @Published private(set) var listenerState: CaptureListenerState = .idle
    @Published private(set) var captureState: CaptureState = .idle
    @Published private(set) var cameraAvailability: CameraAvailability = .unknown
    @Published private(set) var latestLocalResult: LocalCaptureResult?
    @Published private(set) var latestUploadResult: CaptureUploadResult?
    @Published private(set) var captureMode: CaptureMode
    @Published private(set) var captureResolutionMode: CaptureResolutionMode
    @Published private(set) var autoCaptureDelay: TimeInterval
    @Published private(set) var zoomFactor: CGFloat
    @Published private(set) var zoomRange: ClosedRange<CGFloat>

    let employee: AuthenticatedEmployee
    let station: CaptureStation

    private let repository: CaptureJobRepository
    private let listener: CaptureJobListener
    private let cameraService: CameraCaptureService
    private let uploadService: CapturePhotoUploadService
    private let userDefaults: UserDefaults

    private var pendingJob: CaptureJob?
    private var pendingAutoCaptureTask: Task<Void, Never>?
    private var pendingUploadTask: Task<Void, Never>?

    private var handledJobIDs = Set<UUID>()
    private var activeJobID: UUID?
    private var hasStarted = false

    private static let captureModeKey = "ready.captureMode"
    private static let captureResolutionModeKey = "ready.captureResolutionMode"
    private static let autoCaptureDelayKey = "ready.autoCaptureDelay"
    private static let defaultAutoCaptureDelay: TimeInterval = 1.2

    init(
        employee: AuthenticatedEmployee,
        station: CaptureStation,
        repository: CaptureJobRepository = CaptureJobRepository(),
        listener: CaptureJobListener = CaptureJobListener(),
        cameraService: CameraCaptureService = CameraCaptureService(),
        uploadService: CapturePhotoUploadService = CapturePhotoUploadService(),
        userDefaults: UserDefaults = .standard
    ) {
        self.employee = employee
        self.station = station
        self.repository = repository
        self.listener = listener
        self.cameraService = cameraService
        self.uploadService = uploadService
        self.userDefaults = userDefaults
        self.captureMode = CaptureMode(rawValue: userDefaults.string(forKey: Self.captureModeKey) ?? "") ?? .auto
        self.captureResolutionMode = CaptureResolutionMode(rawValue: userDefaults.string(forKey: Self.captureResolutionModeKey) ?? "") ?? .standard
        self.zoomFactor = CameraZoomState.unavailable.factor
        self.zoomRange = CameraZoomState.unavailable.range

        let storedDelay = userDefaults.object(forKey: Self.autoCaptureDelayKey) as? Double
        let resolvedDelay = storedDelay ?? Self.defaultAutoCaptureDelay
        self.autoCaptureDelay = Self.clampedDelay(resolvedDelay)
    }

    deinit {
        let listener = listener
        let cameraService = cameraService
        pendingAutoCaptureTask?.cancel()
        pendingUploadTask?.cancel()

        Task {
            await listener.stopListening()
            await MainActor.run {
                cameraService.stopSession()
            }
        }
    }

    var previewSession: AVCaptureSession? {
        switch cameraAvailability {
        case .ready:
            cameraService.previewSession
        default:
            nil
        }
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true

        cameraAvailability = await cameraService.prepareIfNeeded()
        await cameraService.updateCaptureResolutionMode(captureResolutionMode)
        await refreshZoomState(resetToDefault: true)
        captureState = .listening

        await listener.startListening(
            stationID: station.id,
            onStateChange: { [weak self] newState in
                Task { @MainActor [weak self] in
                    self?.listenerState = newState
                }
            },
            onJobDetected: { [weak self] job in
                Task { @MainActor [weak self] in
                    await self?.handleIncomingJob(job)
                }
            }
        )

        await refreshPendingJob()
    }

    func stop() async {
        pendingAutoCaptureTask?.cancel()
        pendingUploadTask?.cancel()
        await listener.stopListening()
        cameraService.stopSession()
        pendingJob = nil
        activeJobID = nil
        zoomFactor = CameraZoomState.unavailable.factor
        zoomRange = CameraZoomState.unavailable.range
        hasStarted = false
    }

    func updateCaptureMode(_ mode: CaptureMode) {
        guard captureMode != mode else { return }
        captureMode = mode
        userDefaults.set(mode.rawValue, forKey: Self.captureModeKey)
        reconfigurePendingCaptureIfNeeded()
    }

    func updateAutoCaptureDelay(_ delay: TimeInterval) {
        let clampedDelay = Self.clampedDelay(delay)
        guard autoCaptureDelay != clampedDelay else { return }
        autoCaptureDelay = clampedDelay
        userDefaults.set(clampedDelay, forKey: Self.autoCaptureDelayKey)
        reconfigurePendingCaptureIfNeeded()
    }

    func updateCaptureResolutionMode(_ mode: CaptureResolutionMode) {
        guard captureResolutionMode != mode else { return }
        captureResolutionMode = mode
        userDefaults.set(mode.rawValue, forKey: Self.captureResolutionModeKey)

        Task { [weak self] in
            guard let self else { return }
            await self.cameraService.updateCaptureResolutionMode(mode)
        }
    }

    func triggerManualCapture() {
        guard captureMode == .manual else { return }
        guard let job = pendingJob else { return }
        guard case .waitingForManualCapture = captureState else { return }

        pendingAutoCaptureTask?.cancel()
        pendingAutoCaptureTask = Task { [weak self] in
            await self?.performCapture(for: job)
        }
    }

    func focusPreview(at devicePoint: CGPoint) async {
        guard isTapToFocusEnabledForCurrentState else { return }
        await cameraService.focusAndExpose(at: devicePoint)
    }

    func updatePreviewZoom(to factor: CGFloat) {
        guard canAdjustPreviewZoom else { return }

        Task { [weak self] in
            guard let self else { return }
            let zoomState = await cameraService.setZoomFactor(factor)
            await MainActor.run {
                self.zoomFactor = zoomState.factor
                self.zoomRange = zoomState.range
            }
        }
    }

    func refreshPendingJob() async {
        do {
            if let job = try await repository.fetchNextPendingJob(for: station.id) {
                await handleIncomingJob(job)
            }
        } catch {
            listenerState = .error(error.localizedDescription)
        }
    }

    func simulateCaptureRequest() async {
        guard activeJobID == nil else { return }
        guard canAcceptIncomingJobs else { return }

        do {
            if let job = try await repository.fetchNextPendingJob(for: station.id) {
                await handleIncomingJob(job)
            }
        } catch {
            captureState = .failed(jobID: nil, message: error.localizedDescription)
        }
    }

    func resetResult() {
        guard isShowingPersistentResult else { return }

        pendingAutoCaptureTask?.cancel()
        pendingUploadTask?.cancel()
        pendingJob = nil
        activeJobID = nil
        latestLocalResult = nil
        latestUploadResult = nil
        captureState = .listening

        Task { [weak self] in
            guard let self else { return }
            self.cameraAvailability = await self.cameraService.prepareIfNeeded()
            await self.refreshZoomState(resetToDefault: true)
            await self.refreshPendingJob()
        }
    }

    private func handleIncomingJob(_ job: CaptureJob) async {
        guard job.stationID == station.id else { return }
        guard job.isCaptureRequestCandidate else { return }
        guard !handledJobIDs.contains(job.id) else { return }
        guard activeJobID == nil else { return }
        guard canAcceptIncomingJobs else { return }

        pendingAutoCaptureTask?.cancel()
        activeJobID = job.id
        pendingJob = job

        do {
            let claimed = try await repository.claimJobForCapture(id: job.id)
            guard claimed else {
                captureState = .listening
                activeJobID = nil
                pendingJob = nil
                return
            }

            cameraAvailability = await cameraService.prepareIfNeeded()
            await refreshZoomState(resetToDefault: true)

            switch cameraAvailability {
            case .ready, .simulatorFallback:
                switch captureMode {
                case .auto:
                    await cameraService.enableContinuousPreviewAutoFocus()
                    captureState = .captureRequested(job)
                    scheduleAutoCapture(for: job)
                case .manual:
                    captureState = .waitingForManualCapture(job)
                }
            case let .unavailable(message):
                await failJob(jobID: job.id, code: "camera_unavailable", message: message)
                activeJobID = nil
                pendingJob = nil
            case .unknown:
                await failJob(jobID: job.id, code: "camera_unavailable", message: CameraCaptureServiceError.cameraUnavailable.localizedDescription)
                activeJobID = nil
                pendingJob = nil
            }
        } catch {
            captureState = .failed(jobID: job.id, message: error.localizedDescription)
            activeJobID = nil
            pendingJob = nil
        }
    }

    private func scheduleAutoCapture(for job: CaptureJob) {
        pendingAutoCaptureTask?.cancel()
        pendingAutoCaptureTask = Task { [weak self] in
            guard let self else { return }

            do {
                if autoCaptureDelay > 0 {
                    try await Task.sleep(for: .seconds(autoCaptureDelay))
                }
            } catch {
                return
            }

            guard !Task.isCancelled else { return }
            await performCapture(for: job)
        }
    }

    private func performCapture(for job: CaptureJob) async {
        pendingAutoCaptureTask = nil
        captureState = .capturing(job)

        switch cameraAvailability {
        case .unknown:
            cameraAvailability = await cameraService.prepareIfNeeded()
        default:
            break
        }

        do {
            let result = try await cameraService.capturePhoto(for: job.id)
            latestLocalResult = result
            latestUploadResult = nil
            captureState = .reviewingCapture(job, result)
        } catch {
            await failJob(jobID: job.id, code: "capture_failed", message: error.localizedDescription)
            activeJobID = nil
            pendingJob = nil
        }
    }

    func keepCapturedPhoto() {
        guard case let .reviewingCapture(job, result) = captureState else { return }

        pendingUploadTask?.cancel()
        pendingUploadTask = Task { [weak self] in
            guard let self else { return }

            do {
                try await self.uploadCaptureResult(result, for: job)
            } catch {
                await self.failJob(jobID: job.id, code: "upload_failed", message: error.localizedDescription)
            }

            await MainActor.run {
                self.pendingUploadTask = nil
                self.activeJobID = nil
                self.pendingJob = nil
            }
        }
    }

    func discardCapturedPhoto() {
        guard case let .reviewingCapture(job, _) = captureState else { return }

        pendingUploadTask?.cancel()
        latestLocalResult = nil
        latestUploadResult = nil

        switch captureMode {
        case .auto:
            Task {
                await cameraService.enableContinuousPreviewAutoFocus()
            }
            captureState = .captureRequested(job)
            scheduleAutoCapture(for: job)
        case .manual:
            pendingAutoCaptureTask?.cancel()
            captureState = .waitingForManualCapture(job)
        }
    }

    private func uploadCaptureResult(_ result: LocalCaptureResult, for job: CaptureJob) async throws {
        let markedUploading = try await repository.markUploading(id: job.id, captureCompletedAt: result.capturedAt)
        guard markedUploading else {
            throw CaptureJobRepository.RepositoryError.transitionRejected
        }

        captureState = .uploading(job)

        do {
            let upload = try await uploadService.uploadCapture(result, stationID: station.id)
            let markedCompleted = try await repository.markCompleted(id: job.id, uploadResult: upload)

            guard markedCompleted else {
                throw CaptureJobRepository.RepositoryError.transitionRejected
            }

            handledJobIDs.insert(job.id)
            let completedResult = CaptureUploadResult(
                jobID: job.id,
                capturedAt: result.capturedAt,
                uploadedAt: upload.uploadedAt,
                imageData: result.imageData,
                isSimulatorFallback: result.isSimulatorFallback,
                storageBucket: upload.bucket,
                storagePath: upload.path,
                fileSizeBytes: upload.fileSizeBytes,
                mimeType: upload.mimeType
            )
            latestUploadResult = completedResult
            captureState = .completed(completedResult)
        } catch {
            await failJob(jobID: job.id, code: "upload_failed", message: error.localizedDescription)
        }
    }

    private func failJob(jobID: UUID, code: String, message: String) async {
        do {
            _ = try await repository.markFailed(id: jobID, code: code, message: message)
        } catch {
            captureState = .failed(jobID: jobID, message: error.localizedDescription)
            return
        }

        captureState = .failed(jobID: jobID, message: message)
    }

    private static func clampedDelay(_ delay: TimeInterval) -> TimeInterval {
        min(max(delay, 0.5), 15.0)
    }

    private func reconfigurePendingCaptureIfNeeded() {
        guard let job = pendingJob else { return }

        switch captureState {
        case .captureRequested, .waitingForManualCapture:
            switch captureMode {
            case .auto:
                Task {
                    await cameraService.enableContinuousPreviewAutoFocus()
                }
                captureState = .captureRequested(job)
                scheduleAutoCapture(for: job)
            case .manual:
                pendingAutoCaptureTask?.cancel()
                captureState = .waitingForManualCapture(job)
            }
        case .idle, .listening, .capturing, .reviewingCapture, .uploading, .completed, .failed:
            break
        }
    }

    private var canAdjustPreviewZoom: Bool {
        switch captureState {
        case .captureRequested, .waitingForManualCapture:
            true
        case .idle, .listening, .capturing, .reviewingCapture, .uploading, .completed, .failed:
            false
        }
    }

    var isTapToFocusEnabledForCurrentState: Bool {
        switch captureMode {
        case .auto:
            if case .captureRequested = captureState {
                return true
            }
            return false
        case .manual:
            if case .waitingForManualCapture = captureState {
                return true
            }
            return false
        }
    }

    private func refreshZoomState(resetToDefault: Bool) async {
        switch cameraAvailability {
        case .ready:
            let zoomState: CameraZoomState
            if resetToDefault {
                zoomState = await cameraService.setZoomFactor(1.0)
            } else {
                zoomState = await cameraService.zoomState()
            }

            zoomFactor = zoomState.factor
            zoomRange = zoomState.range
        case .simulatorFallback, .unavailable, .unknown:
            zoomFactor = CameraZoomState.unavailable.factor
            zoomRange = CameraZoomState.unavailable.range
        }
    }

    var isShowingPersistentResult: Bool {
        switch captureState {
        case .completed, .failed:
            true
        case .idle, .listening, .captureRequested, .waitingForManualCapture, .capturing, .reviewingCapture, .uploading:
            false
        }
    }

    var isReviewingCapturedPhoto: Bool {
        if case .reviewingCapture = captureState {
            return true
        }

        return false
    }

    private var canAcceptIncomingJobs: Bool {
        switch captureState {
        case .idle, .listening:
            true
        case .captureRequested, .waitingForManualCapture, .capturing, .reviewingCapture, .uploading, .completed, .failed:
            false
        }
    }
}
