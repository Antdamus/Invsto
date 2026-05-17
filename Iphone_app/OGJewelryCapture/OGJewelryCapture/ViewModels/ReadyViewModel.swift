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
        case sessionReady(CaptureJob, LocalCaptureSession)
        case uploadingFinalSet(CaptureJob, LocalCaptureSession)
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
            case .sessionReady:
                "Session ready"
            case .uploadingFinalSet:
                "Finishing job"
            case .completed:
                "Completed"
            case .failed:
                "Failed"
            }
        }
    }

    enum AutoListenStatus: Equatable {
        case off
        case waiting
        case checking
        case paused
        case error(String)

        var label: String {
            switch self {
            case .off:
                "Off"
            case .waiting:
                "Checking every 5s"
            case .checking:
                "Checking now"
            case .paused:
                "Paused until listening"
            case let .error(message):
                "Check failed: \(message)"
            }
        }
    }

    enum SparkleTorchStrength: String, CaseIterable, Identifiable {
        case low
        case medium
        case high

        var id: String { rawValue }

        var label: String {
            switch self {
            case .low:
                "Low"
            case .medium:
                "Medium"
            case .high:
                "High"
            }
        }

        var offsets: [Double] {
            switch self {
            case .low:
                [0.0, 0.08, -0.04, 0.05, -0.06, 0.02, 0.0]
            case .medium:
                [0.0, 0.13, -0.06, 0.08, -0.10, 0.03, 0.0]
            case .high:
                [0.0, 0.18, -0.09, 0.12, -0.14, 0.05, 0.0]
            }
        }
    }

    @Published private(set) var listenerState: CaptureListenerState = .idle
    @Published private(set) var captureState: CaptureState = .idle
    @Published private(set) var cameraAvailability: CameraAvailability = .unknown
    @Published private(set) var latestLocalResult: LocalCaptureResult?
    @Published private(set) var latestUploadResult: CaptureUploadResult?
    @Published private(set) var activeSession: LocalCaptureSession?
    @Published private(set) var captureMode: CaptureMode
    @Published private(set) var captureResolutionMode: CaptureResolutionMode
    @Published private(set) var cameraModeStatus: CameraModeStatus = .unknown
    @Published private(set) var autoCaptureDelay: TimeInterval
    @Published private(set) var zoomFactor: CGFloat
    @Published private(set) var zoomRange: ClosedRange<CGFloat>
    @Published private(set) var finishJobMessage: String?
    @Published private(set) var isAutoListenEnabled: Bool
    @Published private(set) var autoListenStatus: AutoListenStatus = .off
    @Published private(set) var lastAutoListenCheckAt: Date?
    @Published private(set) var isTorchEnabled = false
    @Published private(set) var torchIntensity: Double
    @Published private(set) var torchState: CameraTorchState = .unknown
    @Published private(set) var isSparkleTorchEnabled = false
    @Published private(set) var sparkleTorchStrength: SparkleTorchStrength
    @Published private(set) var photoLibraryImportMessage: String?
    @Published private(set) var isImportingPhotos = false

    let employee: AuthenticatedEmployee
    let station: CaptureStation

    private let repository: CaptureJobRepository
    private let listener: CaptureJobListener
    private let cameraService: CameraCaptureService
    private let uploadService: CapturePhotoUploadService
    private let photoStore: LocalCapturePhotoStore
    private let userDefaults: UserDefaults

    private var pendingJob: CaptureJob?
    private var pendingAutoCaptureTask: Task<Void, Never>?
    private var pendingTorchApplyTask: Task<Void, Never>?
    private var sparkleTorchTask: Task<Void, Never>?
    private var lastAppliedSparkleTorchLevel: Float?
    private var autoListenTask: Task<Void, Never>?
    private var lastHardwareShutterCaptureAt: Date?

    private var handledJobIDs = Set<UUID>()
    private var activeJobID: UUID?
    private var hasStarted = false
    private var isClaimingNewestJob = false

    private static let captureModeKey = "ready.captureMode"
    private static let captureResolutionModeKey = "ready.captureResolutionMode"
    private static let autoCaptureDelayKey = "ready.autoCaptureDelay"
    private static let autoListenEnabledKey = "ready.autoListenEnabled"
    private static let torchIntensityKey = "ready.torchIntensity"
    private static let sparkleTorchStrengthKey = "ready.sparkleTorchStrength"
    private static let autoListenInterval: Duration = .seconds(5)
    private static let torchHardwareUpdateDelay: Duration = .milliseconds(80)
    private static let sparkleTorchUpdateInterval: Duration = .milliseconds(600)
    private static let hardwareShutterDebounceInterval: TimeInterval = 0.75
    private static let defaultAutoCaptureDelay: TimeInterval = 1.2
    private static let defaultTorchIntensity: Double = 0.4
    private static let operatorCancelledFailureCode = "cancelled_by_operator"
    private static let operatorCancelledFailureMessage = "Operator cancelled capture"
    private static let cancelRejectedMessage = "Cancel Job was not accepted. This job is still active on this station."
    private static let failureRejectedMessage = "The job could not be marked failed. It is still active on this station."

    init(
        employee: AuthenticatedEmployee,
        station: CaptureStation,
        repository: CaptureJobRepository = CaptureJobRepository(),
        listener: CaptureJobListener = CaptureJobListener(),
        cameraService: CameraCaptureService = CameraCaptureService(),
        uploadService: CapturePhotoUploadService = CapturePhotoUploadService(),
        photoStore: LocalCapturePhotoStore = LocalCapturePhotoStore(),
        userDefaults: UserDefaults = .standard
    ) {
        self.employee = employee
        self.station = station
        self.repository = repository
        self.listener = listener
        self.cameraService = cameraService
        self.uploadService = uploadService
        self.photoStore = photoStore
        self.userDefaults = userDefaults
        self.captureMode = CaptureMode(rawValue: userDefaults.string(forKey: Self.captureModeKey) ?? "") ?? .auto
        self.captureResolutionMode = CaptureResolutionMode(rawValue: userDefaults.string(forKey: Self.captureResolutionModeKey) ?? "") ?? .standard
        self.isAutoListenEnabled = userDefaults.object(forKey: Self.autoListenEnabledKey) as? Bool ?? false
        self.zoomFactor = CameraZoomState.unavailable.factor
        self.zoomRange = CameraZoomState.unavailable.range

        let storedDelay = userDefaults.object(forKey: Self.autoCaptureDelayKey) as? Double
        let resolvedDelay = storedDelay ?? Self.defaultAutoCaptureDelay
        self.autoCaptureDelay = Self.clampedDelay(resolvedDelay)

        let storedTorchIntensity = userDefaults.object(forKey: Self.torchIntensityKey) as? Double
        self.torchIntensity = Self.clampedTorchIntensity(storedTorchIntensity ?? Self.defaultTorchIntensity)

        self.sparkleTorchStrength = SparkleTorchStrength(
            rawValue: userDefaults.string(forKey: Self.sparkleTorchStrengthKey) ?? ""
        ) ?? .medium
    }

    deinit {
        let listener = listener
        let cameraService = cameraService
        pendingAutoCaptureTask?.cancel()
        pendingTorchApplyTask?.cancel()
        sparkleTorchTask?.cancel()
        autoListenTask?.cancel()

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

    var isResolutionSelectionLocked: Bool {
        activeJobID != nil
    }

    var sessionPhotoCount: Int {
        activeSession?.keptPhotoCount ?? 0
    }

    var canAddMoreSessionPhotos: Bool {
        activeSession?.canAddMorePhotos ?? true
    }

    var canFinishJob: Bool {
        guard let activeSession else { return false }
        return activeSession.keptPhotoCount > 0 && !activeSession.isUploadingFinalSet && !isImportingPhotos
    }

    func start() async {
        guard !hasStarted else { return }
        hasStarted = true

        cameraAvailability = await cameraService.prepareIfNeeded()
        await cameraService.updateCaptureResolutionMode(captureResolutionMode)
        cameraModeStatus = await cameraService.currentCameraModeStatus()
        await refreshZoomState(resetToDefault: true)
        await refreshTorchState()
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
                    await self?.handleRealtimeCaptureCandidate(job)
                }
            }
        )

        await refreshPendingJob()
        updateAutoListenPolling()
    }

    func stop() async {
        pendingAutoCaptureTask?.cancel()
        pendingTorchApplyTask?.cancel()
        stopSparkleTorch(resetToggle: true)
        stopAutoListenPolling()
        await turnTorchOffForInactiveCapture()
        await listener.stopListening()
        cameraService.stopSession()
        pendingJob = nil
        activeJobID = nil
        zoomFactor = CameraZoomState.unavailable.factor
        zoomRange = CameraZoomState.unavailable.range
        cameraModeStatus = .unknown
        hasStarted = false
    }

    func updateAutoListenEnabled(_ isEnabled: Bool) {
        guard isAutoListenEnabled != isEnabled else { return }

        isAutoListenEnabled = isEnabled
        userDefaults.set(isEnabled, forKey: Self.autoListenEnabledKey)
        updateAutoListenPolling()
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
        guard !isResolutionSelectionLocked else { return }
        guard captureResolutionMode != mode else { return }
        captureResolutionMode = mode
        userDefaults.set(mode.rawValue, forKey: Self.captureResolutionModeKey)

        Task { [weak self] in
            guard let self else { return }
            await self.turnTorchOffForInactiveCapture()
            await self.cameraService.updateCaptureResolutionMode(mode)
            await self.refreshCameraModeStatus()
            await self.refreshZoomState(resetToDefault: true)
            await self.refreshTorchState()
        }
    }

    func updateTorchEnabled(_ isEnabled: Bool) {
        guard isTorchEnabled != isEnabled else { return }

        isTorchEnabled = isEnabled
        if !isEnabled {
            stopSparkleTorch(resetToggle: true)
        }

        Task { [weak self] in
            guard let self else { return }
            await self.applyTorch(enabled: isEnabled)
        }
    }

    func updateTorchIntensity(_ intensity: Double) {
        let clampedIntensity = Self.clampedTorchIntensity(intensity)
        guard torchIntensity != clampedIntensity else { return }

        torchIntensity = clampedIntensity
        userDefaults.set(clampedIntensity, forKey: Self.torchIntensityKey)

        guard isTorchEnabled else { return }
        guard !isSparkleTorchEnabled else {
            pendingTorchApplyTask?.cancel()
            pendingTorchApplyTask = nil
            return
        }

        scheduleTorchIntensityApply()
    }

    func updateSparkleTorchEnabled(_ isEnabled: Bool) {
        guard isSparkleTorchEnabled != isEnabled else { return }

        if isEnabled {
            guard canAdjustSparkleTorch else { return }
            isSparkleTorchEnabled = true
            startSparkleTorchIfNeeded()
        } else {
            stopSparkleTorch(resetToggle: true)
        }
    }

    func updateSparkleTorchStrength(_ strength: SparkleTorchStrength) {
        guard sparkleTorchStrength != strength else { return }

        sparkleTorchStrength = strength
        userDefaults.set(strength.rawValue, forKey: Self.sparkleTorchStrengthKey)
    }

    func triggerManualCapture() {
        triggerCaptureNow()
    }

    func triggerHardwareShutterCapture() {
        guard canTriggerHardwareShutterCapture else { return }

        let now = Date()
        if let lastHardwareShutterCaptureAt,
           now.timeIntervalSince(lastHardwareShutterCaptureAt) < Self.hardwareShutterDebounceInterval
        {
            return
        }

        lastHardwareShutterCaptureAt = now
        triggerCaptureNow()
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
        await claimNewestPendingJobForCapture(reportErrorToListener: true)
    }

    private func pollPendingJobForAutoListen() async {
        guard isAutoListenEnabled else {
            autoListenStatus = .off
            return
        }

        guard canAcceptIncomingJobs else {
            autoListenStatus = .paused
            return
        }

        guard !isClaimingNewestJob else {
            autoListenStatus = .waiting
            return
        }

        autoListenStatus = .checking
        isClaimingNewestJob = true
        var didFail = false

        defer {
            lastAutoListenCheckAt = Date()
            isClaimingNewestJob = false

            if !didFail, isAutoListenEnabled {
                autoListenStatus = canAcceptIncomingJobs ? .waiting : .paused
            } else if !didFail {
                autoListenStatus = .off
            }
        }

        do {
            if let job = try await repository.claimNewestCaptureJobForStation(stationID: station.id) {
                await beginCaptureWithClaimedNewestJob(job)
            }
        } catch {
            if canAcceptIncomingJobs {
                didFail = true
                autoListenStatus = .error(error.localizedDescription)
            }
        }
    }

    func resetResult() {
        guard isShowingPersistentResult else { return }

        pendingAutoCaptureTask?.cancel()
        Task { [weak self] in
            await self?.turnTorchOffForInactiveCapture()
        }
        pendingJob = nil
        activeJobID = nil
        activeSession = nil
        latestLocalResult = nil
        latestUploadResult = nil
        finishJobMessage = nil
        captureState = .listening

        Task { [weak self] in
            guard let self else { return }
            await self.turnTorchOffForInactiveCapture()
            self.cameraAvailability = await self.cameraService.prepareIfNeeded()
            self.cameraModeStatus = await self.cameraService.currentCameraModeStatus()
            await self.refreshZoomState(resetToDefault: true)
            await self.refreshTorchState()
            await self.refreshPendingJob()
        }
    }

    func cancelActiveJob() {
        guard let job = pendingJob else { return }
        guard !isUploadingFinalSet else { return }

        Task { [weak self] in
            await self?.performCancelActiveJob(job)
        }
    }

    func keepCapturedPhoto() {
        guard case let .reviewingCapture(job, result) = captureState else { return }

        do {
            let updatedSession = try appendKeptPhoto(result)
            Task { [weak self] in
                await self?.turnTorchOffForInactiveCapture()
            }
            latestLocalResult = nil
            latestUploadResult = nil
            finishJobMessage = nil
            captureState = .sessionReady(job, updatedSession)
        } catch {
            Task { [weak self] in
                await self?.failJob(
                    jobID: job.id,
                    code: "local_session_store_failed",
                    message: error.localizedDescription,
                    clearLocalSession: true
                )
            }
        }
    }

    func discardCapturedPhoto() {
        guard case let .reviewingCapture(job, _) = captureState else { return }

        Task { [weak self] in
            await self?.turnTorchOffForInactiveCapture()
        }
        latestLocalResult = nil
        latestUploadResult = nil
        finishJobMessage = nil
        transitionToCapture(for: job)
    }

    func addAnotherPhoto() {
        guard let job = pendingJob else { return }
        guard canAddMoreSessionPhotos else { return }
        guard case .sessionReady = captureState else { return }

        transitionToCapture(for: job)
    }

    func prepareForPhotoLibraryImport() {
        guard canImportPhotos else { return }

        pendingAutoCaptureTask?.cancel()
        photoLibraryImportMessage = nil

        Task { [weak self] in
            await self?.turnTorchOffForInactiveCapture()
        }
    }

    func resumeCaptureAfterEmptyPhotoLibraryImportIfNeeded() {
        guard case let .captureRequested(job) = captureState else { return }
        guard !isImportingPhotos else { return }

        transitionToCapture(for: job)
    }

    func importPhotoLibraryImageData(_ imageDataItems: [Data?], selectedCount: Int) async {
        guard !imageDataItems.isEmpty else { return }
        guard let job = pendingJob else { return }
        guard canImportPhotos else { return }

        let currentSession = activeSession ?? LocalCaptureSession(
            jobID: job.id,
            finalUploadTargetJobID: nil,
            resolutionMode: captureResolutionMode,
            keptPhotos: [],
            isUploadingFinalSet: false
        )
        guard currentSession.jobID == job.id else { return }

        let remainingSlots = LocalCaptureSession.softMaxPhotoCount - currentSession.keptPhotoCount
        guard remainingSlots > 0 else {
            photoLibraryImportMessage = "Photo limit reached. Delete a kept photo before importing another one."
            return
        }

        pendingAutoCaptureTask?.cancel()
        await turnTorchOffForInactiveCapture()
        isImportingPhotos = true
        photoLibraryImportMessage = "Importing selected photo\(selectedCount == 1 ? "" : "s")..."

        let limitedItems = Array(imageDataItems.prefix(remainingSlots))
        var importedPhotos = [LocalSessionPhoto]()
        var failedImportCount = 0

        for imageData in limitedItems {
            do {
                guard let imageData else {
                    failedImportCount += 1
                    continue
                }

                let importedPhoto = try LocalCapturePhotoStore.ImportedPhotoData(imageData: imageData)
                let storedPhoto = try photoStore.persistImportedPhoto(
                    importedPhoto,
                    jobID: currentSession.jobID,
                    sortOrder: currentSession.keptPhotos.count + importedPhotos.count,
                    isPrimary: currentSession.keptPhotos.isEmpty && importedPhotos.isEmpty
                )
                importedPhotos.append(storedPhoto)
            } catch {
                failedImportCount += 1
            }
        }

        let updatedSession = sessionWithReindexedPhotos(
            jobID: currentSession.jobID,
            finalUploadTargetJobID: currentSession.finalUploadTargetJobID,
            resolutionMode: currentSession.resolutionMode,
            keptPhotos: currentSession.keptPhotos + importedPhotos,
            isUploadingFinalSet: false
        )

        activeSession = updatedSession
        latestLocalResult = nil
        latestUploadResult = nil
        isImportingPhotos = false

        var messages = [String]()
        if !importedPhotos.isEmpty {
            messages.append("Imported \(importedPhotos.count) photo\(importedPhotos.count == 1 ? "" : "s") from Photos.")
        }
        if selectedCount > remainingSlots {
            messages.append("Only \(remainingSlots) slot\(remainingSlots == 1 ? "" : "s") remained, so extra selections were skipped.")
        }
        if failedImportCount > 0 {
            messages.append("\(failedImportCount) selected photo\(failedImportCount == 1 ? "" : "s") could not be imported.")
        }
        photoLibraryImportMessage = messages.isEmpty ? nil : messages.joined(separator: " ")

        if !updatedSession.keptPhotos.isEmpty {
            captureState = .sessionReady(job, updatedSession)
        } else if case .captureRequested = captureState {
            transitionToCapture(for: job)
        }
    }

    func deleteKeptPhoto(_ photo: LocalSessionPhoto) {
        guard let job = pendingJob else { return }
        guard let session = activeSession else { return }
        guard session.jobID == photo.jobID else { return }

        photoStore.deletePhotoFile(at: photo.localFileURL)

        let remainingPhotos = session.keptPhotos.filter { $0.id != photo.id }
        let updatedSession = sessionWithReindexedPhotos(
            jobID: session.jobID,
            finalUploadTargetJobID: session.finalUploadTargetJobID,
            resolutionMode: session.resolutionMode,
            keptPhotos: remainingPhotos,
            isUploadingFinalSet: false
        )

        activeSession = updatedSession
        finishJobMessage = nil

        if updatedSession.keptPhotos.isEmpty {
            transitionToCapture(for: job)
        } else {
            Task { [weak self] in
                await self?.turnTorchOffForInactiveCapture()
            }
            captureState = .sessionReady(job, updatedSession)
        }
    }

    func finishJob() {
        guard let job = pendingJob else {
            finishJobMessage = "No active capture job is available to finish right now."
            return
        }

        guard let session = activeSession, session.jobID == job.id else {
            finishJobMessage = "The active multi-photo session is missing. Capture and keep at least one photo before finishing the job."
            return
        }

        guard session.keptPhotoCount > 0 else {
            finishJobMessage = "Keep at least one photo before finishing the job."
            return
        }

        guard !session.isUploadingFinalSet else {
            finishJobMessage = "Upload and finalization are already in progress for this job."
            return
        }

        Task { [weak self] in
            await self?.performFinishJob(for: job, session: session)
        }
    }

    private func handleRealtimeCaptureCandidate(_ job: CaptureJob) async {
        guard job.stationID == station.id else { return }
        guard job.isCaptureRequestCandidate else { return }
        guard !handledJobIDs.contains(job.id) else { return }
        guard activeJobID == nil else { return }
        guard canAcceptIncomingJobs else { return }

        await claimNewestPendingJobForCapture(reportErrorToListener: true)
    }

    private func claimNewestPendingJobForCapture(reportErrorToListener: Bool) async {
        guard !isClaimingNewestJob else { return }
        guard canAcceptIncomingJobs else { return }

        isClaimingNewestJob = true
        defer {
            isClaimingNewestJob = false
        }

        do {
            if let job = try await repository.claimNewestCaptureJobForStation(stationID: station.id) {
                await beginCaptureWithClaimedNewestJob(job)
            }
        } catch {
            if reportErrorToListener, canAcceptIncomingJobs {
                listenerState = .error(error.localizedDescription)
            }
        }
    }

    private func beginCaptureWithClaimedNewestJob(_ job: CaptureJob) async {
        guard job.stationID == station.id else { return }
        guard !handledJobIDs.contains(job.id) else { return }
        guard activeJobID == nil else { return }
        guard canAcceptIncomingJobs else { return }

        pendingAutoCaptureTask?.cancel()
        await turnTorchOffForInactiveCapture()
        activeJobID = job.id
        handledJobIDs.insert(job.id)
        pendingJob = job
        activeSession = LocalCaptureSession(
            jobID: job.id,
            finalUploadTargetJobID: nil,
            resolutionMode: captureResolutionMode,
            keptPhotos: [],
            isUploadingFinalSet: false
        )
        finishJobMessage = nil

        cameraAvailability = await cameraService.prepareIfNeeded()
        await cameraService.updateCaptureResolutionMode(captureResolutionMode)
        cameraModeStatus = await cameraService.currentCameraModeStatus()
        await refreshZoomState(resetToDefault: true)
        await refreshTorchState()

        switch cameraAvailability {
        case .ready, .simulatorFallback:
            transitionToCapture(for: job)
        case let .unavailable(message):
            let failureAccepted = await failJob(
                jobID: job.id,
                code: "camera_unavailable",
                message: message,
                clearLocalSession: true
            )
            if failureAccepted {
                activeJobID = nil
                pendingJob = nil
            }
        case .unknown:
            let failureAccepted = await failJob(
                jobID: job.id,
                code: "camera_unavailable",
                message: CameraCaptureServiceError.cameraUnavailable.localizedDescription,
                clearLocalSession: true
            )
            if failureAccepted {
                activeJobID = nil
                pendingJob = nil
            }
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
        finishJobMessage = nil
        await freezeSparkleTorchForCapture()
        captureState = .capturing(job)

        switch cameraAvailability {
        case .unknown:
            cameraAvailability = await cameraService.prepareIfNeeded()
        default:
            break
        }

        do {
            let result = try await cameraService.capturePhoto(for: job.id)
            await turnTorchOffForInactiveCapture()
            latestLocalResult = result
            latestUploadResult = nil
            captureState = .reviewingCapture(job, result)
        } catch {
            await turnTorchOffForInactiveCapture()
            let failureAccepted = await failJob(
                jobID: job.id,
                code: "capture_failed",
                message: error.localizedDescription,
                clearLocalSession: true
            )
            if failureAccepted {
                activeJobID = nil
                pendingJob = nil
            }
        }
    }

    private func triggerCaptureNow() {
        guard let job = captureReadyJob else { return }

        pendingAutoCaptureTask?.cancel()
        pendingAutoCaptureTask = Task { [weak self] in
            await self?.performCapture(for: job)
        }
    }

    private func appendKeptPhoto(_ result: LocalCaptureResult) throws -> LocalCaptureSession {
        let currentSession = activeSession ?? LocalCaptureSession(
            jobID: result.jobID,
            finalUploadTargetJobID: nil,
            resolutionMode: captureResolutionMode,
            keptPhotos: [],
            isUploadingFinalSet: false
        )

        let storedPhoto = try photoStore.persistKeptPhoto(
            result,
            sortOrder: currentSession.keptPhotos.count,
            isPrimary: currentSession.keptPhotos.isEmpty
        )

        let updatedSession = sessionWithReindexedPhotos(
            jobID: currentSession.jobID,
            finalUploadTargetJobID: currentSession.finalUploadTargetJobID,
            resolutionMode: currentSession.resolutionMode,
            keptPhotos: currentSession.keptPhotos + [storedPhoto],
            isUploadingFinalSet: false
        )
        activeSession = updatedSession
        return updatedSession
    }

    private func sessionWithReindexedPhotos(
        jobID: UUID,
        finalUploadTargetJobID: UUID?,
        resolutionMode: CaptureResolutionMode,
        keptPhotos: [LocalSessionPhoto],
        isUploadingFinalSet: Bool
    ) -> LocalCaptureSession {
        let sortedPhotos = keptPhotos
            .sorted { lhs, rhs in
                if lhs.sortOrder == rhs.sortOrder {
                    return lhs.capturedAt < rhs.capturedAt
                }

                return lhs.sortOrder < rhs.sortOrder
            }
            .enumerated()
            .map { index, photo in
                LocalSessionPhoto(
                    id: photo.id,
                    jobID: photo.jobID,
                    capturedAt: photo.capturedAt,
                    localFileURL: photo.localFileURL,
                    fileSizeBytes: photo.fileSizeBytes,
                    imageWidth: photo.imageWidth,
                    imageHeight: photo.imageHeight,
                    mimeType: photo.mimeType,
                    sortOrder: index,
                    isPrimary: index == 0,
                    isSimulatorFallback: photo.isSimulatorFallback
                )
            }

        return LocalCaptureSession(
            jobID: jobID,
            finalUploadTargetJobID: finalUploadTargetJobID,
            resolutionMode: resolutionMode,
            keptPhotos: sortedPhotos,
            isUploadingFinalSet: isUploadingFinalSet
        )
    }

    private func transitionToCapture(for job: CaptureJob) {
        latestLocalResult = nil
        latestUploadResult = nil
        stopSparkleTorch(resetToggle: true)
        isTorchEnabled = false
        photoLibraryImportMessage = nil

        switch captureMode {
        case .auto:
            Task {
                await prepareTorchForLivePreview()
                await cameraService.enableContinuousPreviewAutoFocus()
            }
            captureState = .captureRequested(job)
            scheduleAutoCapture(for: job)
        case .manual:
            pendingAutoCaptureTask?.cancel()
            Task {
                await prepareTorchForLivePreview()
                await cameraService.enableContinuousPreviewAutoFocus()
            }
            captureState = .waitingForManualCapture(job)
        }
    }

    private func performFinishJob(for job: CaptureJob, session: LocalCaptureSession) async {
        pendingAutoCaptureTask?.cancel()
        await turnTorchOffForInactiveCapture()

        let uploadingSession = LocalCaptureSession(
            jobID: session.jobID,
            finalUploadTargetJobID: session.finalUploadTargetJobID,
            resolutionMode: session.resolutionMode,
            keptPhotos: session.keptPhotos,
            isUploadingFinalSet: true
        )

        activeSession = uploadingSession
        latestLocalResult = nil
        latestUploadResult = nil
        finishJobMessage = "Resolving the final upload target for \(uploadingSession.keptPhotoCount) kept photo\(uploadingSession.keptPhotoCount == 1 ? "" : "s")."
        captureState = .uploadingFinalSet(job, uploadingSession)

        do {
            let finalTargetJob: CaptureJob
            let resolvedSession: LocalCaptureSession

            if let finalUploadTargetJobID = uploadingSession.finalUploadTargetJobID {
                guard let lockedFinalTargetJob = try await repository.fetchJob(id: finalUploadTargetJobID) else {
                    throw CaptureJobRepository.RepositoryError.transitionRejected
                }

                _ = try await repository.ensureUploadingForMultiPhotoRetry(
                    id: lockedFinalTargetJob.id,
                    captureCompletedAt: Date()
                )
                finalTargetJob = lockedFinalTargetJob
                resolvedSession = uploadingSession
                finishJobMessage = "Retrying upload to the previously resolved final target \(lockedFinalTargetJob.shortReference)."
            } else {
                let resolution = try await repository.resolveFinalCaptureUploadTarget(
                    stationID: station.id,
                    currentActiveJobID: job.id
                )

                finalTargetJob = resolution.job
                resolvedSession = LocalCaptureSession(
                    jobID: uploadingSession.jobID,
                    finalUploadTargetJobID: resolution.job.id,
                    resolutionMode: uploadingSession.resolutionMode,
                    keptPhotos: uploadingSession.keptPhotos,
                    isUploadingFinalSet: true
                )
                activeSession = resolvedSession

                if resolution.targetSwitched {
                    finishJobMessage = "Newest signal found. Uploading kept photos to final target \(resolution.job.shortReference)."
                } else {
                    finishJobMessage = "Final target confirmed. Uploading kept photos to job \(resolution.job.shortReference)."
                }
            }

            let sortedPhotos = resolvedSession.keptPhotos.sorted { $0.sortOrder < $1.sortOrder }
            var mostRecentUploadResult: CapturePhotoUploadService.UploadResult?
            var uploadResultsByPhotoID = [UUID: CapturePhotoUploadService.UploadResult]()

            for photo in sortedPhotos {
                let uploadResult = try await uploadService.uploadSessionPhoto(
                    photo,
                    stationID: station.id,
                    targetJobID: finalTargetJob.id
                )
                let recorded = try await repository.recordCaptureJobPhoto(
                    jobID: finalTargetJob.id,
                    sortOrder: photo.sortOrder,
                    isPrimary: photo.isPrimary,
                    storageBucket: uploadResult.bucket,
                    storagePath: uploadResult.path,
                    fileSizeBytes: photo.fileSizeBytes,
                    imageWidth: photo.imageWidth > 0 ? photo.imageWidth : nil,
                    imageHeight: photo.imageHeight > 0 ? photo.imageHeight : nil,
                    mimeType: photo.mimeType
                )

                guard recorded else {
                    throw CaptureJobRepository.RepositoryError.transitionRejected
                }

                mostRecentUploadResult = uploadResult
                uploadResultsByPhotoID[photo.id] = uploadResult
            }

            let finalized = try await repository.completeCaptureJobMultiPhoto(
                jobID: finalTargetJob.id,
                expectedPhotoCount: sortedPhotos.count,
                uploadCompletedAt: mostRecentUploadResult?.uploadedAt ?? Date()
            )

            guard finalized else {
                throw CaptureJobRepository.RepositoryError.transitionRejected
            }

            let primaryPhoto = sortedPhotos.first(where: \.isPrimary) ?? sortedPhotos.first
            if let primaryPhoto {
                let imageData = try Data(contentsOf: primaryPhoto.localFileURL)
                let primaryUploadResult = uploadResultsByPhotoID[primaryPhoto.id] ?? mostRecentUploadResult

                if let primaryUploadResult {
                    latestUploadResult = CaptureUploadResult(
                        jobID: finalTargetJob.id,
                        capturedAt: primaryPhoto.capturedAt,
                        uploadedAt: primaryUploadResult.uploadedAt,
                        imageData: imageData,
                        isSimulatorFallback: primaryPhoto.isSimulatorFallback,
                        storageBucket: primaryUploadResult.bucket,
                        storagePath: primaryUploadResult.path,
                        fileSizeBytes: primaryPhoto.fileSizeBytes,
                        mimeType: primaryPhoto.mimeType
                    )
                }
            }

            photoStore.clearSession(jobID: session.jobID)
            activeSession = nil
            activeJobID = nil
            pendingJob = nil
            latestLocalResult = nil
            finishJobMessage = "Job \(finalTargetJob.shortReference) uploaded and completed successfully."
            captureState = .listening

            await refreshPendingJob()
        } catch {
            await turnTorchOffForInactiveCapture()
            let recoveredSession = LocalCaptureSession(
                jobID: session.jobID,
                finalUploadTargetJobID: activeSession?.finalUploadTargetJobID ?? session.finalUploadTargetJobID,
                resolutionMode: session.resolutionMode,
                keptPhotos: session.keptPhotos,
                isUploadingFinalSet: false
            )

            activeSession = recoveredSession
            latestUploadResult = nil
            finishJobMessage = "Finish Job failed: \(error.localizedDescription) Retry is available and the kept photo session was preserved."
            captureState = .sessionReady(job, recoveredSession)
        }
    }

    private func performCancelActiveJob(_ job: CaptureJob) async {
        pendingAutoCaptureTask?.cancel()
        await turnTorchOffForInactiveCapture()
        finishJobMessage = nil

        do {
            _ = try await repository.markFailed(
                id: job.id,
                code: Self.operatorCancelledFailureCode,
                message: Self.operatorCancelledFailureMessage
            )
        } catch {
            finishJobMessage = Self.cancelRejectedMessage
            reconfigurePendingCaptureIfNeeded()
            return
        }

        await turnTorchOffForInactiveCapture()
        cameraService.stopSession()
        latestLocalResult = nil
        latestUploadResult = nil
        clearLocalSession(jobID: job.id)
        pendingJob = nil
        activeJobID = nil
        finishJobMessage = nil
        captureState = .listening

        cameraAvailability = await cameraService.prepareIfNeeded()
        await cameraService.updateCaptureResolutionMode(captureResolutionMode)
        cameraModeStatus = await cameraService.currentCameraModeStatus()
        await refreshZoomState(resetToDefault: true)
        await refreshTorchState()
        await refreshPendingJob()
    }

    private func clearLocalSession(jobID: UUID?) {
        guard let jobID else {
            activeSession = nil
            return
        }

        photoStore.clearSession(jobID: jobID)
        activeSession = nil
    }

    @discardableResult
    private func failJob(
        jobID: UUID,
        code: String,
        message: String,
        clearLocalSession: Bool
    ) async -> Bool {
        await turnTorchOffForInactiveCapture()

        do {
            _ = try await repository.markFailed(id: jobID, code: code, message: message)
        } catch {
            finishJobMessage = Self.failureRejectedMessage
            restoreActiveStateAfterFailedLifecycleRejection(for: jobID)
            return false
        }

        if clearLocalSession {
            self.clearLocalSession(jobID: jobID)
        }

        captureState = .failed(jobID: jobID, message: message)
        finishJobMessage = nil
        return true
    }

    private func restoreActiveStateAfterFailedLifecycleRejection(for jobID: UUID) {
        latestUploadResult = nil

        guard let job = pendingJob, job.id == jobID else {
            return
        }

        if let activeSession {
            let restoredSession = LocalCaptureSession(
                jobID: activeSession.jobID,
                finalUploadTargetJobID: activeSession.finalUploadTargetJobID,
                resolutionMode: activeSession.resolutionMode,
                keptPhotos: activeSession.keptPhotos,
                isUploadingFinalSet: false
            )

            self.activeSession = restoredSession

            if restoredSession.keptPhotos.isEmpty {
                switch cameraAvailability {
                case .ready, .simulatorFallback:
                    transitionToCapture(for: job)
                case .unavailable, .unknown:
                    captureState = .listening
                }
            } else {
                captureState = .sessionReady(job, restoredSession)
            }
            return
        }

        switch cameraAvailability {
        case .ready, .simulatorFallback:
            transitionToCapture(for: job)
        case .unavailable, .unknown:
            captureState = .listening
        }
    }

    private static func clampedDelay(_ delay: TimeInterval) -> TimeInterval {
        min(max(delay, 0.5), 15.0)
    }

    private static func clampedTorchIntensity(_ intensity: Double) -> Double {
        min(max(intensity, 0.1), 1.0)
    }

    private func reconfigurePendingCaptureIfNeeded() {
        guard let job = pendingJob else { return }

        switch captureState {
        case .captureRequested, .waitingForManualCapture:
            transitionToCapture(for: job)
        case .idle, .listening, .capturing, .reviewingCapture, .sessionReady, .uploadingFinalSet, .completed, .failed:
            break
        }
    }

    private var canAdjustPreviewZoom: Bool {
        switch captureState {
        case .captureRequested, .waitingForManualCapture:
            true
        case .idle, .listening, .capturing, .reviewingCapture, .sessionReady, .uploadingFinalSet, .completed, .failed:
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

    private func refreshCameraModeStatus() async {
        cameraModeStatus = await cameraService.currentCameraModeStatus()
    }

    private func refreshTorchState() async {
        let state = await cameraService.currentTorchState()
        torchState = state

        if !state.isAvailable || !state.isEnabled {
            isTorchEnabled = false
            stopSparkleTorch(resetToggle: true)
        }
    }

    private func prepareTorchForLivePreview() async {
        stopSparkleTorch(resetToggle: true)
        isTorchEnabled = false
        let state = await cameraService.setTorch(enabled: false, level: Float(torchIntensity))
        torchState = state
    }

    private func applyTorch(enabled: Bool) async {
        guard isTorchControlVisible, torchState.isAvailable else {
            await turnTorchOffForInactiveCapture()
            return
        }

        if !enabled {
            stopSparkleTorch(resetToggle: true)
        }

        let state = await cameraService.setTorch(enabled: enabled, level: Float(torchIntensity))
        torchState = state
        isTorchEnabled = enabled && state.isAvailable && state.isEnabled

        if !isTorchEnabled {
            stopSparkleTorch(resetToggle: true)
        }
    }

    private func scheduleTorchIntensityApply() {
        guard !isSparkleTorchEnabled else {
            pendingTorchApplyTask?.cancel()
            pendingTorchApplyTask = nil
            return
        }

        pendingTorchApplyTask?.cancel()
        pendingTorchApplyTask = Task { [weak self] in
            do {
                try await Task.sleep(for: Self.torchHardwareUpdateDelay)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }
            await self?.applyTorch(enabled: true)
        }
    }

    private func freezeSparkleTorchForCapture() async {
        pendingTorchApplyTask?.cancel()
        pendingTorchApplyTask = nil

        guard isTorchEnabled, torchState.isAvailable else { return }

        if isSparkleTorchEnabled {
            let frozenLevel = lastAppliedSparkleTorchLevel ?? max(torchState.level, Float(torchIntensity))
            stopSparkleTorch(resetToggle: true)
            let state = await cameraService.setTorch(enabled: true, level: frozenLevel)
            torchState = state
            isTorchEnabled = state.isAvailable && state.isEnabled
            return
        }

        let state = await cameraService.setTorch(enabled: true, level: Float(torchIntensity))
        torchState = state
        isTorchEnabled = state.isAvailable && state.isEnabled
    }

    private func turnTorchOffForInactiveCapture() async {
        pendingTorchApplyTask?.cancel()
        pendingTorchApplyTask = nil
        stopSparkleTorch(resetToggle: true)
        isTorchEnabled = false
        let state = await cameraService.setTorch(enabled: false, level: Float(torchIntensity))
        torchState = state
    }

    private func startSparkleTorchIfNeeded() {
        guard isSparkleTorchEnabled, isTorchEnabled, torchState.isAvailable else {
            stopSparkleTorch(resetToggle: true)
            return
        }
        guard sparkleTorchTask == nil else { return }

        pendingTorchApplyTask?.cancel()
        pendingTorchApplyTask = nil
        lastAppliedSparkleTorchLevel = torchState.level > 0 ? torchState.level : Float(torchIntensity)

        sparkleTorchTask = Task { [weak self] in
            await self?.runSparkleTorchLoop()
        }
    }

    private func runSparkleTorchLoop() async {
        var offsetIndex = 0

        while !Task.isCancelled {
            guard isSparkleTorchEnabled, isTorchEnabled, torchState.isAvailable, isTorchControlVisible else {
                stopSparkleTorch(resetToggle: true)
                return
            }

            pendingTorchApplyTask?.cancel()
            pendingTorchApplyTask = nil

            let offsets = sparkleTorchStrength.offsets
            let offset = offsets[offsetIndex % offsets.count]
            let requestedLevel = Float(Self.clampedTorchIntensity(torchIntensity + offset))
            let state = await cameraService.setTorch(enabled: true, level: requestedLevel)
            torchState = state
            isTorchEnabled = state.isAvailable && state.isEnabled

            guard isTorchEnabled else {
                stopSparkleTorch(resetToggle: true)
                return
            }

            lastAppliedSparkleTorchLevel = state.level
            offsetIndex += 1

            do {
                try await Task.sleep(for: Self.sparkleTorchUpdateInterval)
            } catch {
                return
            }
        }
    }

    private func stopSparkleTorch(resetToggle: Bool) {
        sparkleTorchTask?.cancel()
        sparkleTorchTask = nil
        lastAppliedSparkleTorchLevel = nil

        if resetToggle {
            isSparkleTorchEnabled = false
        }
    }

    private func updateAutoListenPolling() {
        guard hasStarted, isAutoListenEnabled else {
            stopAutoListenPolling()
            return
        }

        startAutoListenPollingIfNeeded()
    }

    private func startAutoListenPollingIfNeeded() {
        guard autoListenTask == nil else { return }

        autoListenStatus = canAcceptIncomingJobs ? .waiting : .paused
        autoListenTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: Self.autoListenInterval)
                } catch {
                    return
                }

                guard !Task.isCancelled else { return }
                await self?.pollPendingJobForAutoListen()
            }
        }
    }

    private func stopAutoListenPolling() {
        autoListenTask?.cancel()
        autoListenTask = nil
        autoListenStatus = .off
    }

    var isShowingPersistentResult: Bool {
        switch captureState {
        case .completed, .failed:
            true
        case .idle, .listening, .captureRequested, .waitingForManualCapture, .capturing, .reviewingCapture, .sessionReady, .uploadingFinalSet:
            false
        }
    }

    var isReviewingCapturedPhoto: Bool {
        if case .reviewingCapture = captureState {
            return true
        }

        return false
    }

    var hasActiveJob: Bool {
        pendingJob != nil
    }

    var activeJobReference: String {
        pendingJob?.shortReference ?? "None"
    }

    var isUploadingFinalSet: Bool {
        if case .uploadingFinalSet = captureState {
            return true
        }

        return false
    }

    var canCancelActiveJob: Bool {
        guard hasActiveJob else { return false }
        return !isUploadingFinalSet
    }

    var canChangeStation: Bool {
        !hasActiveJob
    }

    var canLogOut: Bool {
        !hasActiveJob
    }

    var activeJobExitSafetyMessage: String? {
        guard hasActiveJob else { return nil }
        return "Change Station and Log Out are disabled while a job is active. Cancel or finish the job first."
    }

    var cancelJobAvailabilityMessage: String? {
        guard hasActiveJob else { return nil }

        if isUploadingFinalSet {
            return "Cancel Job is disabled while Finish Job is actively uploading and finalizing to avoid interrupting the in-flight multi-photo completion."
        }

        return "Cancel Job fails the active capture request, clears local session photos, and returns this station to listening."
    }

    var canTriggerHardwareShutterCapture: Bool {
        captureReadyJob != nil
    }

    var canImportPhotos: Bool {
        guard hasActiveJob, !isImportingPhotos else { return false }
        guard (activeSession?.keptPhotoCount ?? 0) < LocalCaptureSession.softMaxPhotoCount else { return false }

        switch captureState {
        case .captureRequested, .waitingForManualCapture, .sessionReady:
            return true
        case .idle, .listening, .capturing, .reviewingCapture, .uploadingFinalSet, .completed, .failed:
            return false
        }
    }

    var remainingPhotoImportSlots: Int {
        max(LocalCaptureSession.softMaxPhotoCount - (activeSession?.keptPhotoCount ?? 0), 0)
    }

    var isTorchControlVisible: Bool {
        switch captureState {
        case .captureRequested, .waitingForManualCapture, .capturing:
            return true
        case .idle, .listening, .reviewingCapture, .sessionReady, .uploadingFinalSet, .completed, .failed:
            return false
        }
    }

    var canAdjustTorch: Bool {
        guard torchState.isAvailable else { return false }

        switch captureState {
        case .captureRequested, .waitingForManualCapture:
            return true
        case .idle, .listening, .capturing, .reviewingCapture, .sessionReady, .uploadingFinalSet, .completed, .failed:
            return false
        }
    }

    var torchAvailabilityMessage: String? {
        guard isTorchControlVisible else { return nil }
        guard !torchState.isAvailable else { return torchState.message }
        return torchState.message
    }

    var isSparkleTorchControlVisible: Bool {
        isTorchControlVisible && torchState.isAvailable && isTorchEnabled
    }

    var canAdjustSparkleTorch: Bool {
        canAdjustTorch && isTorchEnabled && torchState.isAvailable
    }

    private var canAcceptIncomingJobs: Bool {
        switch captureState {
        case .idle, .listening:
            return activeJobID == nil
        case .captureRequested, .waitingForManualCapture, .capturing, .reviewingCapture, .sessionReady, .uploadingFinalSet, .completed, .failed:
            return false
        }
    }

    private var captureReadyJob: CaptureJob? {
        guard let pendingJob else { return nil }

        switch captureState {
        case let .captureRequested(job), let .waitingForManualCapture(job):
            guard job.id == pendingJob.id else { return nil }
            return job
        case .idle, .listening, .capturing, .reviewingCapture, .sessionReady, .uploadingFinalSet, .completed, .failed:
            return nil
        }
    }
}
