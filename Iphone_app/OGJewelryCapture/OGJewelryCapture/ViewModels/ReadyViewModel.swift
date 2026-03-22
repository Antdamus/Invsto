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
        case captureComplete(LocalCaptureResult)
        case captureFailed(jobID: UUID?, message: String)

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
            case .captureComplete:
                "Capture complete"
            case .captureFailed:
                "Capture failed"
            }
        }
    }

    @Published private(set) var listenerState: CaptureListenerState = .idle
    @Published private(set) var captureState: CaptureState = .idle
    @Published private(set) var cameraAvailability: CameraAvailability = .unknown
    @Published private(set) var latestResult: LocalCaptureResult?

    let employee: AuthenticatedEmployee
    let station: CaptureStation

    private let repository: CaptureJobRepository
    private let listener: CaptureJobListener
    private let cameraService: CameraCaptureService
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
        stabilizationDelay: TimeInterval = 1.2
    ) {
        self.employee = employee
        self.station = station
        self.repository = repository
        self.listener = listener
        self.cameraService = cameraService
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
        let job = CaptureJob(
            id: UUID(),
            requestedBy: employee.employeeID,
            stationID: station.id,
            status: .queued,
            requestedAt: Date(),
            claimedAt: nil,
            captureStartedAt: nil,
            captureCompletedAt: nil,
            uploadCompletedAt: nil,
            storageBucket: nil,
            storagePath: nil,
            fileSizeBytes: nil,
            mimeType: nil,
            failureCode: nil,
            failureMessage: nil,
            controlPayload: nil,
            resultPayload: nil,
            createdAt: Date(),
            updatedAt: Date()
        )

        await handleIncomingJob(job)
    }

    private func handleIncomingJob(_ job: CaptureJob) async {
        guard job.stationID == station.id else { return }
        guard job.isCaptureRequestCandidate else { return }
        guard !handledJobIDs.contains(job.id) else { return }
        guard activeJobID == nil else { return }

        activeJobID = job.id
        captureState = .captureRequested(job)

        await performCapture(for: job)
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
            handledJobIDs.insert(job.id)
            latestResult = result
            captureState = .captureComplete(result)
        } catch {
            captureState = .captureFailed(jobID: job.id, message: error.localizedDescription)
        }

        activeJobID = nil
    }
}
