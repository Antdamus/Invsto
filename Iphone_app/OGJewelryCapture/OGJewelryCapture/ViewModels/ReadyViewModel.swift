import AVFoundation
import Combine
import Foundation

@MainActor
final class ReadyViewModel: ObservableObject {
    enum CaptureState: Equatable {
        case idle
        case listening
        case captureRequested(CaptureJob)
        case capturing(CaptureJob)
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
                "Capture requested"
            case .capturing:
                "Capturing"
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

    let employee: AuthenticatedEmployee
    let station: CaptureStation

    private let repository: CaptureJobRepository
    private let listener: CaptureJobListener
    private let cameraService: CameraCaptureService
    private let uploadService: CapturePhotoUploadService
    private let stabilizationDelay: TimeInterval

    private var handledJobIDs = Set<UUID>()
    private var activeJobID: UUID?
    private var hasStarted = false

    init(
        employee: AuthenticatedEmployee,
        station: CaptureStation,
        repository: CaptureJobRepository = CaptureJobRepository(),
        listener: CaptureJobListener = CaptureJobListener(),
        cameraService: CameraCaptureService = CameraCaptureService(),
        uploadService: CapturePhotoUploadService = CapturePhotoUploadService(),
        stabilizationDelay: TimeInterval = 1.2
    ) {
        self.employee = employee
        self.station = station
        self.repository = repository
        self.listener = listener
        self.cameraService = cameraService
        self.uploadService = uploadService
        self.stabilizationDelay = stabilizationDelay
    }

    deinit {
        let listener = listener
        let cameraService = cameraService

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
        await listener.stopListening()
        cameraService.stopSession()
        hasStarted = false
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

        do {
            if let job = try await repository.fetchNextPendingJob(for: station.id) {
                await handleIncomingJob(job)
            }
        } catch {
            captureState = .failed(jobID: nil, message: error.localizedDescription)
        }
    }

    private func handleIncomingJob(_ job: CaptureJob) async {
        guard job.stationID == station.id else { return }
        guard job.isCaptureRequestCandidate else { return }
        guard !handledJobIDs.contains(job.id) else { return }
        guard activeJobID == nil else { return }

        activeJobID = job.id
        captureState = .captureRequested(job)

        do {
            let claimed = try await repository.claimJobForCapture(id: job.id)
            guard claimed else {
                captureState = .listening
                activeJobID = nil
                return
            }

            await performCapture(for: job)
        } catch {
            captureState = .failed(jobID: job.id, message: error.localizedDescription)
            activeJobID = nil
        }
    }

    private func performCapture(for job: CaptureJob) async {
        captureState = .capturing(job)

        switch cameraAvailability {
        case .unknown:
            cameraAvailability = await cameraService.prepareIfNeeded()
        default:
            break
        }

        do {
            let result = try await cameraService.capturePhoto(
                for: job.id,
                stabilizationDelay: stabilizationDelay
            )
            latestLocalResult = result
            try await uploadCaptureResult(result, for: job)
        } catch {
            await failJob(jobID: job.id, code: "capture_failed", message: error.localizedDescription)
        }

        activeJobID = nil
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
}
