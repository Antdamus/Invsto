import Foundation

struct LocalCapturePhotoStore {
    enum StoreError: LocalizedError {
        case failedToCreateDirectory

        var errorDescription: String? {
            switch self {
            case .failedToCreateDirectory:
                "The app could not prepare local temporary storage for this capture session."
            }
        }
    }

    private let fileManager: FileManager
    private let rootDirectory: URL
    private let formatter: ISO8601DateFormatter

    init(
        fileManager: FileManager = .default,
        rootDirectory: URL? = nil
    ) {
        self.fileManager = fileManager
        self.rootDirectory = rootDirectory ?? fileManager.temporaryDirectory.appendingPathComponent("OGJewelryCaptureSessions", isDirectory: true)

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        self.formatter = formatter
    }

    func persistKeptPhoto(
        _ capture: LocalCaptureResult,
        sortOrder: Int,
        isPrimary: Bool
    ) throws -> LocalSessionPhoto {
        let sessionDirectory = try makeSessionDirectory(jobID: capture.jobID)
        let timestamp = formatter.string(from: capture.capturedAt).replacingOccurrences(of: ":", with: "-")
        let fileURL = sessionDirectory.appendingPathComponent("\(timestamp)-\(UUID().uuidString.lowercased()).jpg")

        try capture.imageData.write(to: fileURL, options: [.atomic])

        return LocalSessionPhoto(
            id: UUID(),
            jobID: capture.jobID,
            capturedAt: capture.capturedAt,
            localFileURL: fileURL,
            fileSizeBytes: capture.fileSizeBytes,
            imageWidth: capture.imageWidth,
            imageHeight: capture.imageHeight,
            mimeType: capture.mimeType,
            sortOrder: sortOrder,
            isPrimary: isPrimary,
            isSimulatorFallback: capture.isSimulatorFallback
        )
    }

    func deletePhotoFile(at fileURL: URL) {
        guard fileManager.fileExists(atPath: fileURL.path) else { return }
        try? fileManager.removeItem(at: fileURL)
    }

    func clearSession(jobID: UUID) {
        let sessionDirectory = directoryURL(for: jobID)
        guard fileManager.fileExists(atPath: sessionDirectory.path) else { return }
        try? fileManager.removeItem(at: sessionDirectory)
    }

    private func makeSessionDirectory(jobID: UUID) throws -> URL {
        let directoryURL = directoryURL(for: jobID)

        do {
            try fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)
            return directoryURL
        } catch {
            throw StoreError.failedToCreateDirectory
        }
    }

    private func directoryURL(for jobID: UUID) -> URL {
        rootDirectory
            .appendingPathComponent(jobID.uuidString.lowercased(), isDirectory: true)
    }
}
