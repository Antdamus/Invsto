import AVFoundation
import Foundation
import UIKit

struct CameraZoomState: Equatable {
    let factor: CGFloat
    let range: ClosedRange<CGFloat>

    static let unavailable = CameraZoomState(factor: 1.0, range: 1.0 ... 1.0)

    var isAvailable: Bool {
        range.upperBound > range.lowerBound
    }
}

enum CameraAvailability: Equatable {
    case unknown
    case ready
    case simulatorFallback
    case unavailable(String)

    var label: String {
        switch self {
        case .unknown:
            "Checking camera"
        case .ready:
            "Camera ready"
        case .simulatorFallback:
            "Simulator fallback"
        case let .unavailable(message):
            "Unavailable: \(message)"
        }
    }
}

enum CameraCaptureServiceError: LocalizedError {
    case permissionDenied
    case cameraUnavailable
    case captureInProgress
    case missingImageData

    var errorDescription: String? {
        switch self {
        case .permissionDenied:
            "Camera access is denied for this app."
        case .cameraUnavailable:
            "No usable back camera is available."
        case .captureInProgress:
            "A capture is already in progress."
        case .missingImageData:
            "The camera did not return image data."
        }
    }
}

final class CameraCaptureService: NSObject {
    let previewSession = AVCaptureSession()

    private let sessionQueue = DispatchQueue(label: "og.capture.camera.session")
    private let photoOutput = AVCapturePhotoOutput()
    private var activeDevice: AVCaptureDevice?

    private var isConfigured = false
    private var isRunning = false
    private var isCapturingPhoto = false
    private var availability: CameraAvailability = .unknown
    private var activeProcessor: PhotoCaptureProcessor?

    private let preferredMaximumZoomFactor: CGFloat = 3.0

    func prepareIfNeeded() async -> CameraAvailability {
        if case .ready = availability {
            return availability
        }

        if case .simulatorFallback = availability {
            return availability
        }

#if targetEnvironment(simulator)
        availability = .simulatorFallback
        return availability
#else
        let authorization = await requestAuthorizationIfNeeded()
        guard authorization == .authorized else {
            availability = .unavailable(CameraCaptureServiceError.permissionDenied.localizedDescription)
            return availability
        }

        do {
            try await configureSessionIfNeeded()
            await startSessionIfNeeded()
            availability = .ready
        } catch {
            availability = .unavailable(error.localizedDescription)
        }

        return availability
#endif
    }

    func capturePhoto(for jobID: UUID) async throws -> LocalCaptureResult {
        let availability = await prepareIfNeeded()

        switch availability {
        case .ready:
            await startSessionIfNeeded()
            return try await captureFromDevice(jobID: jobID)
        case .simulatorFallback:
            return try await simulateCapture(jobID: jobID)
        case let .unavailable(message):
            throw NSError(domain: "CameraCaptureService", code: 1, userInfo: [
                NSLocalizedDescriptionKey: message
            ])
        case .unknown:
            throw CameraCaptureServiceError.cameraUnavailable
        }
    }

    func stopSession() {
        sessionQueue.async {
            guard self.isRunning else { return }
            self.previewSession.stopRunning()
            self.isRunning = false
        }
    }

    private func requestAuthorizationIfNeeded() async -> AVAuthorizationStatus {
        let currentStatus = AVCaptureDevice.authorizationStatus(for: .video)
        switch currentStatus {
        case .notDetermined:
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            return granted ? .authorized : .denied
        default:
            return currentStatus
        }
    }

    private func configureSessionIfNeeded() async throws {
        guard !isConfigured else { return }

        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async {
                do {
                    self.previewSession.beginConfiguration()
                    self.previewSession.sessionPreset = .photo

                    self.previewSession.inputs.forEach { self.previewSession.removeInput($0) }
                    self.previewSession.outputs.forEach { self.previewSession.removeOutput($0) }

                    guard
                        let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                    else {
                        throw CameraCaptureServiceError.cameraUnavailable
                    }

                    let input = try AVCaptureDeviceInput(device: camera)

                    guard self.previewSession.canAddInput(input) else {
                        throw CameraCaptureServiceError.cameraUnavailable
                    }

                    guard self.previewSession.canAddOutput(self.photoOutput) else {
                        throw CameraCaptureServiceError.cameraUnavailable
                    }

                    self.previewSession.addInput(input)
                    self.previewSession.addOutput(self.photoOutput)
                    self.photoOutput.maxPhotoQualityPrioritization = .quality
                    self.activeDevice = camera

                    self.previewSession.commitConfiguration()
                    self.isConfigured = true
                    continuation.resume()
                } catch {
                    self.previewSession.commitConfiguration()
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func startSessionIfNeeded() async {
        guard availability != .simulatorFallback else { return }

        await withCheckedContinuation { continuation in
            sessionQueue.async {
                guard !self.isRunning else {
                    continuation.resume()
                    return
                }

                self.previewSession.startRunning()
                self.isRunning = true
                continuation.resume()
            }
        }
    }

    func focusAndExpose(at devicePoint: CGPoint) async {
        guard availability != .simulatorFallback else { return }

        await withCheckedContinuation { continuation in
            sessionQueue.async {
                guard let device = self.activeDevice else {
                    continuation.resume()
                    return
                }

                do {
                    try device.lockForConfiguration()
                    defer { device.unlockForConfiguration() }

                    if device.isFocusPointOfInterestSupported {
                        device.focusPointOfInterest = devicePoint
                    }

                    if device.isFocusModeSupported(.autoFocus) {
                        device.focusMode = .autoFocus
                    } else if device.isFocusModeSupported(.continuousAutoFocus) {
                        device.focusMode = .continuousAutoFocus
                    }

                    if device.isExposurePointOfInterestSupported {
                        device.exposurePointOfInterest = devicePoint
                    }

                    if device.isExposureModeSupported(.continuousAutoExposure) {
                        device.exposureMode = .continuousAutoExposure
                    }

                    if device.isSubjectAreaChangeMonitoringEnabled != true {
                        device.isSubjectAreaChangeMonitoringEnabled = true
                    }
                } catch {
                    // Ignore focus configuration failures so capture flow remains unaffected.
                }

                continuation.resume()
            }
        }
    }

    func enableContinuousPreviewAutoFocus() async {
        guard availability != .simulatorFallback else { return }

        await withCheckedContinuation { continuation in
            sessionQueue.async {
                guard let device = self.activeDevice else {
                    continuation.resume()
                    return
                }

                do {
                    try device.lockForConfiguration()
                    defer { device.unlockForConfiguration() }

                    if device.isFocusModeSupported(.continuousAutoFocus) {
                        device.focusMode = .continuousAutoFocus
                    } else if device.isFocusModeSupported(.autoFocus) {
                        device.focusMode = .autoFocus
                    }

                    if device.isExposureModeSupported(.continuousAutoExposure) {
                        device.exposureMode = .continuousAutoExposure
                    } else if device.isExposureModeSupported(.autoExpose) {
                        device.exposureMode = .autoExpose
                    }

                    if device.isSubjectAreaChangeMonitoringEnabled != true {
                        device.isSubjectAreaChangeMonitoringEnabled = true
                    }
                } catch {
                    // Ignore preview autofocus configuration failures so capture flow remains unaffected.
                }

                continuation.resume()
            }
        }
    }

    func zoomState() async -> CameraZoomState {
        guard availability != .simulatorFallback else { return .unavailable }

        return await withCheckedContinuation { continuation in
            sessionQueue.async {
                guard let device = self.activeDevice else {
                    continuation.resume(returning: .unavailable)
                    return
                }

                let range = self.zoomRange(for: device)
                let factor = min(max(device.videoZoomFactor, range.lowerBound), range.upperBound)
                continuation.resume(returning: CameraZoomState(factor: factor, range: range))
            }
        }
    }

    func setZoomFactor(_ requestedFactor: CGFloat) async -> CameraZoomState {
        guard availability != .simulatorFallback else { return .unavailable }

        return await withCheckedContinuation { continuation in
            sessionQueue.async {
                guard let device = self.activeDevice else {
                    continuation.resume(returning: .unavailable)
                    return
                }

                let range = self.zoomRange(for: device)
                let clampedFactor = min(max(requestedFactor, range.lowerBound), range.upperBound)

                do {
                    try device.lockForConfiguration()
                    device.videoZoomFactor = clampedFactor
                    device.unlockForConfiguration()
                } catch {
                    let currentFactor = min(max(device.videoZoomFactor, range.lowerBound), range.upperBound)
                    continuation.resume(returning: CameraZoomState(factor: currentFactor, range: range))
                    return
                }

                continuation.resume(returning: CameraZoomState(factor: clampedFactor, range: range))
            }
        }
    }

    private func captureFromDevice(jobID: UUID) async throws -> LocalCaptureResult {
        try await withCheckedThrowingContinuation { continuation in
            sessionQueue.async {
                guard !self.isCapturingPhoto else {
                    continuation.resume(throwing: CameraCaptureServiceError.captureInProgress)
                    return
                }

                self.isCapturingPhoto = true

                let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                settings.photoQualityPrioritization = .quality
                let processor = PhotoCaptureProcessor(jobID: jobID) { result in
                    self.sessionQueue.async {
                        self.isCapturingPhoto = false
                        self.activeProcessor = nil

                        switch result {
                        case let .success(localResult):
                            continuation.resume(returning: localResult)
                        case let .failure(error):
                            continuation.resume(throwing: error)
                        }
                    }
                }

                self.activeProcessor = processor
                self.photoOutput.capturePhoto(with: settings, delegate: processor)
            }
        }
    }

    private func simulateCapture(jobID: UUID) async throws -> LocalCaptureResult {
        let bounds = CGRect(x: 0, y: 0, width: 1200, height: 1600)
        let renderer = UIGraphicsImageRenderer(bounds: bounds)
        let timestamp = Date().formatted(date: .abbreviated, time: .standard)

        let image = renderer.image { context in
            UIColor(red: 0.10, green: 0.11, blue: 0.14, alpha: 1).setFill()
            context.fill(bounds)

            let accentRect = CGRect(x: 60, y: 60, width: 1080, height: 1480)
            UIColor(red: 0.88, green: 0.90, blue: 0.93, alpha: 1).setStroke()
            UIBezierPath(roundedRect: accentRect, cornerRadius: 28).stroke()

            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center

            let titleAttributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 54, weight: .semibold),
                .foregroundColor: UIColor.white,
                .paragraphStyle: paragraph,
            ]
            let detailAttributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.monospacedSystemFont(ofSize: 34, weight: .medium),
                .foregroundColor: UIColor(white: 0.82, alpha: 1),
                .paragraphStyle: paragraph,
            ]

            NSString(string: "Simulator Capture").draw(
                in: CGRect(x: 120, y: 520, width: 960, height: 70),
                withAttributes: titleAttributes
            )
            NSString(string: "Job \(String(jobID.uuidString.prefix(8)).uppercased())").draw(
                in: CGRect(x: 120, y: 640, width: 960, height: 50),
                withAttributes: detailAttributes
            )
            NSString(string: timestamp).draw(
                in: CGRect(x: 120, y: 715, width: 960, height: 50),
                withAttributes: detailAttributes
            )
        }

        guard let data = image.jpegData(compressionQuality: 0.92) else {
            throw CameraCaptureServiceError.missingImageData
        }

        return LocalCaptureResult(
            jobID: jobID,
            capturedAt: Date(),
            imageData: data,
            isSimulatorFallback: true
        )
    }

    private func zoomRange(for device: AVCaptureDevice) -> ClosedRange<CGFloat> {
        let supportedMaximum = min(device.activeFormat.videoMaxZoomFactor, preferredMaximumZoomFactor)
        let resolvedMaximum = max(1.0, supportedMaximum)
        return 1.0 ... resolvedMaximum
    }
}

private final class PhotoCaptureProcessor: NSObject, AVCapturePhotoCaptureDelegate {
    private let jobID: UUID
    private let completion: (Result<LocalCaptureResult, Error>) -> Void

    init(jobID: UUID, completion: @escaping (Result<LocalCaptureResult, Error>) -> Void) {
        self.jobID = jobID
        self.completion = completion
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        if let error {
            completion(.failure(error))
            return
        }

        guard let data = photo.fileDataRepresentation() else {
            completion(.failure(CameraCaptureServiceError.missingImageData))
            return
        }

        completion(
            .success(
                LocalCaptureResult(
                jobID: jobID,
                capturedAt: Date(),
                imageData: data,
                isSimulatorFallback: false
            )
            )
        )
    }
}
