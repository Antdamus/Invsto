import AVFoundation
import Foundation
import ImageIO
import UIKit

struct CameraZoomState: Equatable {
    let factor: CGFloat
    let range: ClosedRange<CGFloat>

    static let unavailable = CameraZoomState(factor: 1.0, range: 1.0 ... 1.0)

    var isAvailable: Bool {
        range.upperBound > range.lowerBound
    }
}

struct CameraTorchState: Equatable {
    let isAvailable: Bool
    let isEnabled: Bool
    let level: Float
    let message: String?

    static let unknown = CameraTorchState(
        isAvailable: false,
        isEnabled: false,
        level: 0,
        message: "Torch availability is not ready yet."
    )

    static let simulatorUnavailable = CameraTorchState(
        isAvailable: false,
        isEnabled: false,
        level: 0,
        message: "Torch is unavailable in simulator preview."
    )

    static func unavailable(_ message: String) -> CameraTorchState {
        CameraTorchState(isAvailable: false, isEnabled: false, level: 0, message: message)
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

enum CaptureResolutionMode: String, CaseIterable, Identifiable {
    case standard
    case highResolution
    case closeUpMacro

    var id: String { rawValue }

    var label: String {
        switch self {
        case .standard:
            "Standard"
        case .highResolution:
            "High Resolution"
        case .closeUpMacro:
            "Close-Up / Macro"
        }
    }
}

struct CameraModeStatus: Equatable {
    let requestedMode: CaptureResolutionMode
    let activeCameraLabel: String
    let isUsingCloseUpCamera: Bool
    let isUsingStandardFallback: Bool
    let message: String?

    static let unknown = CameraModeStatus(
        requestedMode: .standard,
        activeCameraLabel: "Unknown camera",
        isUsingCloseUpCamera: false,
        isUsingStandardFallback: false,
        message: nil
    )
}

final class CameraCaptureService: NSObject {
    fileprivate static let jpegMimeType = "image/jpeg"

    let previewSession = AVCaptureSession()

    private let sessionQueue = DispatchQueue(label: "og.capture.camera.session")
    private let photoOutput = AVCapturePhotoOutput()
    private var activeDevice: AVCaptureDevice?

    private var isConfigured = false
    private var isRunning = false
    private var isCapturingPhoto = false
    private var availability: CameraAvailability = .unknown
    private var activeProcessor: PhotoCaptureProcessor?
    private var captureResolutionMode: CaptureResolutionMode = .standard
    private var cameraModeStatus: CameraModeStatus = .unknown
    private var torchState: CameraTorchState = .unknown

    private let preferredMaximumZoomFactor: CGFloat = 3.0

    func prepareIfNeeded() async -> CameraAvailability {
        if case .ready = availability {
            await startSessionIfNeeded()
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

    func updateCaptureResolutionMode(_ mode: CaptureResolutionMode) async {
        captureResolutionMode = mode

        guard availability != .simulatorFallback else {
            cameraModeStatus = CameraModeStatus(
                requestedMode: mode,
                activeCameraLabel: "Simulator fallback",
                isUsingCloseUpCamera: mode == .closeUpMacro,
                isUsingStandardFallback: false,
                message: nil
            )
            torchState = .simulatorUnavailable
            return
        }
        guard isConfigured else { return }

        await withCheckedContinuation { continuation in
            sessionQueue.async {
                do {
                    try self.configureSession(for: mode, forceReconfigure: false)
                } catch {
                    self.applyCaptureResolutionModeToPhotoOutput()
                    self.torchState = self.currentTorchStateLocked()
                }
                continuation.resume()
            }
        }
    }

    func currentCameraModeStatus() async -> CameraModeStatus {
        guard availability != .simulatorFallback else {
            return CameraModeStatus(
                requestedMode: captureResolutionMode,
                activeCameraLabel: "Simulator fallback",
                isUsingCloseUpCamera: captureResolutionMode == .closeUpMacro,
                isUsingStandardFallback: false,
                message: nil
            )
        }

        return await withCheckedContinuation { continuation in
            sessionQueue.async {
                continuation.resume(returning: self.cameraModeStatus)
            }
        }
    }

    func currentTorchState() async -> CameraTorchState {
        guard availability != .simulatorFallback else {
            return .simulatorUnavailable
        }

        return await withCheckedContinuation { continuation in
            sessionQueue.async {
                self.torchState = self.currentTorchStateLocked()
                continuation.resume(returning: self.torchState)
            }
        }
    }

    // Public AVFoundation torch controls expose brightness level, not beam spread,
    // cone angle, or physical beam focus.
    func setTorch(enabled: Bool, level requestedLevel: Float) async -> CameraTorchState {
        guard availability != .simulatorFallback else {
            torchState = .simulatorUnavailable
            return torchState
        }

        return await withCheckedContinuation { continuation in
            sessionQueue.async {
                let state = self.setTorchLocked(enabled: enabled, level: requestedLevel)
                self.torchState = state
                continuation.resume(returning: state)
            }
        }
    }

    func stopSession() {
        sessionQueue.async {
            self.turnTorchOffLocked()

            if self.isRunning {
                self.previewSession.stopRunning()
                self.isRunning = false
            }
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
                    try self.configureSession(for: self.captureResolutionMode, forceReconfigure: true)
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func configureSession(for mode: CaptureResolutionMode, forceReconfigure: Bool) throws {
        let selection = try cameraSelection(for: mode)

        if
            !forceReconfigure,
            let activeDevice,
            activeDevice.uniqueID == selection.device.uniqueID,
            isConfigured
        {
            captureResolutionMode = mode
            cameraModeStatus = selection.status(for: mode)
            applyCaptureResolutionModeToPhotoOutput()
            torchState = currentTorchStateLocked()
            return
        }

        turnTorchOffLocked()
        previewSession.beginConfiguration()
        previewSession.sessionPreset = .photo

        do {
            previewSession.inputs.forEach { previewSession.removeInput($0) }

            if !previewSession.outputs.contains(where: { $0 === photoOutput }) {
                guard previewSession.canAddOutput(photoOutput) else {
                    throw CameraCaptureServiceError.cameraUnavailable
                }
                previewSession.addOutput(photoOutput)
            }

            let input = try AVCaptureDeviceInput(device: selection.device)

            guard previewSession.canAddInput(input) else {
                throw CameraCaptureServiceError.cameraUnavailable
            }

            previewSession.addInput(input)
            photoOutput.maxPhotoQualityPrioritization = .quality
            activeDevice = selection.device
            captureResolutionMode = mode
            cameraModeStatus = selection.status(for: mode)
            applyCaptureResolutionModeToPhotoOutput()
            torchState = currentTorchStateLocked()

            previewSession.commitConfiguration()
            isConfigured = true
        } catch {
            torchState = currentTorchStateLocked()
            previewSession.commitConfiguration()
            throw error
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

                if self.captureResolutionMode.requestsMaximumStillDimensions,
                   let maxPhotoDimensions = self.maximumSupportedPhotoDimensions()
                {
                    settings.maxPhotoDimensions = maxPhotoDimensions
                }

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

        let dimensions = Self.extractPixelDimensions(from: data)
        return LocalCaptureResult(
            jobID: jobID,
            capturedAt: Date(),
            imageData: data,
            fileSizeBytes: Int64(data.count),
            imageWidth: dimensions.width,
            imageHeight: dimensions.height,
            mimeType: Self.jpegMimeType,
            isSimulatorFallback: true
        )
    }

    private func zoomRange(for device: AVCaptureDevice) -> ClosedRange<CGFloat> {
        let supportedMaximum = min(device.activeFormat.videoMaxZoomFactor, preferredMaximumZoomFactor)
        let resolvedMaximum = max(1.0, supportedMaximum)
        return 1.0 ... resolvedMaximum
    }

    private func currentTorchStateLocked() -> CameraTorchState {
        guard availability != .simulatorFallback else {
            return .simulatorUnavailable
        }

        guard let device = activeDevice else {
            return .unavailable("Torch is not available until the camera is ready.")
        }

        guard device.hasTorch, device.isTorchModeSupported(.on) else {
            return .unavailable(torchUnavailableMessage())
        }

        guard device.isTorchAvailable else {
            return .unavailable("Torch is temporarily unavailable. Let the device cool, then try again.")
        }

        return CameraTorchState(
            isAvailable: true,
            isEnabled: device.torchMode == .on || device.isTorchActive,
            level: device.torchLevel,
            message: nil
        )
    }

    private func setTorchLocked(enabled: Bool, level requestedLevel: Float) -> CameraTorchState {
        guard let device = activeDevice else {
            return .unavailable("Torch is not available until the camera is ready.")
        }

        guard device.hasTorch, device.isTorchModeSupported(.on) else {
            return .unavailable(torchUnavailableMessage())
        }

        if !enabled {
            do {
                try device.lockForConfiguration()
                device.torchMode = .off
                device.unlockForConfiguration()
            } catch {
                // Best-effort cleanup only. Return the refreshed state below.
            }

            return currentTorchStateLocked()
        }

        guard device.isTorchAvailable else {
            return .unavailable("Torch is temporarily unavailable. Let the device cool, then try again.")
        }

        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }

            let clampedLevel = Self.clampedTorchLevel(requestedLevel)
            try device.setTorchModeOn(level: clampedLevel)

            return CameraTorchState(
                isAvailable: true,
                isEnabled: device.torchMode == .on,
                level: device.torchLevel,
                message: nil
            )
        } catch {
            turnTorchOffLocked()
            return CameraTorchState(
                isAvailable: false,
                isEnabled: false,
                level: 0,
                message: "Torch is temporarily unavailable. Let the device cool, then try again."
            )
        }
    }

    private func turnTorchOffLocked() {
        guard let device = activeDevice else {
            torchState = .unavailable("Torch is not available until the camera is ready.")
            return
        }

        guard device.hasTorch, device.isTorchModeSupported(.off) else {
            torchState = currentTorchStateLocked()
            return
        }

        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            device.torchMode = .off
        } catch {
            // Best-effort cleanup only. The next availability refresh will surface state.
        }

        torchState = currentTorchStateLocked()
    }

    private func torchUnavailableMessage() -> String {
        if captureResolutionMode == .closeUpMacro, cameraModeStatus.isUsingCloseUpCamera {
            return "Torch is unavailable with the current Close-Up / Macro camera path."
        }

        return "Torch is not available on this camera."
    }

    private static func clampedTorchLevel(_ level: Float) -> Float {
        min(max(level, 0.1), 1.0)
    }

    private func applyCaptureResolutionModeToPhotoOutput() {
        guard let photoDimensions = resolvedPhotoDimensions(for: captureResolutionMode) else { return }
        photoOutput.maxPhotoDimensions = photoDimensions
    }

    private func maximumSupportedPhotoDimensions() -> CMVideoDimensions? {
        guard let device = activeDevice else { return nil }
        return maximumDimensions(in: device.activeFormat.supportedMaxPhotoDimensions)
    }

    private func resolvedPhotoDimensions(for mode: CaptureResolutionMode) -> CMVideoDimensions? {
        guard let device = activeDevice else { return nil }

        let supportedDimensions = device.activeFormat.supportedMaxPhotoDimensions
        guard !supportedDimensions.isEmpty else { return nil }

        switch mode {
        case .standard:
            return minimumDimensions(in: supportedDimensions)
        case .highResolution, .closeUpMacro:
            return maximumDimensions(in: supportedDimensions)
        }
    }

    private func cameraSelection(for mode: CaptureResolutionMode) throws -> CameraSelection {
        switch mode {
        case .standard, .highResolution:
            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                throw CameraCaptureServiceError.cameraUnavailable
            }

            return CameraSelection(device: device, path: .wide)
        case .closeUpMacro:
            if let ultraWide = firstBackCamera(of: .builtInUltraWideCamera) {
                return CameraSelection(device: ultraWide, path: .ultraWide)
            }

            if let dualWide = firstBackCamera(of: .builtInDualWideCamera) {
                return CameraSelection(device: dualWide, path: .dualWide)
            }

            if let triple = firstBackCamera(of: .builtInTripleCamera) {
                return CameraSelection(device: triple, path: .triple)
            }

            guard let wide = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
                throw CameraCaptureServiceError.cameraUnavailable
            }

            return CameraSelection(device: wide, path: .wideFallback)
        }
    }

    private func firstBackCamera(of deviceType: AVCaptureDevice.DeviceType) -> AVCaptureDevice? {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [deviceType],
            mediaType: .video,
            position: .back
        ).devices.first
    }

    private func maximumDimensions(in supportedDimensions: [CMVideoDimensions]) -> CMVideoDimensions? {
        supportedDimensions.max(by: { photoDimensionArea($0) < photoDimensionArea($1) })
    }

    private func minimumDimensions(in supportedDimensions: [CMVideoDimensions]) -> CMVideoDimensions? {
        supportedDimensions.min(by: { photoDimensionArea($0) < photoDimensionArea($1) })
    }

    private func photoDimensionArea(_ dimensions: CMVideoDimensions) -> Int64 {
        Int64(dimensions.width) * Int64(dimensions.height)
    }

    fileprivate static func extractPixelDimensions(from imageData: Data) -> (width: Int, height: Int) {
        guard
            let source = CGImageSourceCreateWithData(imageData as CFData, nil),
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? Int,
            let height = properties[kCGImagePropertyPixelHeight] as? Int
        else {
            return (0, 0)
        }

        return (width, height)
    }
}

private extension CaptureResolutionMode {
    var requestsMaximumStillDimensions: Bool {
        switch self {
        case .standard:
            false
        case .highResolution, .closeUpMacro:
            true
        }
    }
}

private struct CameraSelection {
    enum Path {
        case wide
        case ultraWide
        case dualWide
        case triple
        case wideFallback

        var label: String {
            switch self {
            case .wide, .wideFallback:
                "Back Wide camera"
            case .ultraWide:
                "Back Ultra Wide camera"
            case .dualWide:
                "Back Dual Wide camera"
            case .triple:
                "Back Triple camera"
            }
        }

        var isCloseUpCamera: Bool {
            switch self {
            case .ultraWide, .dualWide, .triple:
                true
            case .wide, .wideFallback:
                false
            }
        }

        var isStandardFallback: Bool {
            if case .wideFallback = self {
                return true
            }

            return false
        }
    }

    let device: AVCaptureDevice
    let path: Path

    func status(for mode: CaptureResolutionMode) -> CameraModeStatus {
        let message: String?

        switch (mode, path) {
        case (.closeUpMacro, .wideFallback):
            message = "Close-Up uses the standard camera on this device."
        case (.closeUpMacro, .ultraWide):
            message = "Close-Up / Macro is using the Ultra Wide camera."
        case (.closeUpMacro, .dualWide), (.closeUpMacro, .triple):
            message = "Close-Up / Macro is using a multi-camera close-up path."
        default:
            message = nil
        }

        return CameraModeStatus(
            requestedMode: mode,
            activeCameraLabel: path.label,
            isUsingCloseUpCamera: path.isCloseUpCamera,
            isUsingStandardFallback: path.isStandardFallback,
            message: message
        )
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
                {
                    let dimensions = CameraCaptureService.extractPixelDimensions(from: data)
                    return LocalCaptureResult(
                        jobID: jobID,
                        capturedAt: Date(),
                        imageData: data,
                        fileSizeBytes: Int64(data.count),
                        imageWidth: dimensions.width,
                        imageHeight: dimensions.height,
                        mimeType: CameraCaptureService.jpegMimeType,
                        isSimulatorFallback: false
                    )
                }()
            )
        )
    }
}
