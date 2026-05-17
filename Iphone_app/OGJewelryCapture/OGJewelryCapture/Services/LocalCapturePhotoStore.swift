import Foundation
import ImageIO
import UniformTypeIdentifiers

struct LocalCapturePhotoStore {
    enum StoreError: LocalizedError {
        case failedToCreateDirectory
        case invalidImportedImage

        var errorDescription: String? {
            switch self {
            case .failedToCreateDirectory:
                "The app could not prepare local temporary storage for this capture session."
            case .invalidImportedImage:
                "One selected photo could not be read as a full-size image."
            }
        }
    }

    struct ImportedPhotoData {
        let imageData: Data
        let capturedAt: Date
        let fileSizeBytes: Int64
        let imageWidth: Int
        let imageHeight: Int
        let mimeType: String
        let fileExtension: String

        init(imageData: Data, capturedAt: Date = Date()) throws {
            guard
                let source = CGImageSourceCreateWithData(imageData as CFData, nil),
                let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
            else {
                throw StoreError.invalidImportedImage
            }

            let typeIdentifier = CGImageSourceGetType(source) as String?
            let type = typeIdentifier.flatMap { UTType($0) }

            self.imageData = imageData
            self.capturedAt = capturedAt
            self.fileSizeBytes = Int64(imageData.count)
            self.imageWidth = properties[kCGImagePropertyPixelWidth] as? Int ?? 0
            self.imageHeight = properties[kCGImagePropertyPixelHeight] as? Int ?? 0
            self.mimeType = type?.preferredMIMEType ?? "application/octet-stream"
            self.fileExtension = type?.preferredFilenameExtension ?? "img"
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

    func persistImportedPhoto(
        _ importedPhoto: ImportedPhotoData,
        jobID: UUID,
        sortOrder: Int,
        isPrimary: Bool
    ) throws -> LocalSessionPhoto {
        let sessionDirectory = try makeSessionDirectory(jobID: jobID)
        let timestamp = formatter.string(from: importedPhoto.capturedAt).replacingOccurrences(of: ":", with: "-")
        let fileExtension = importedPhoto.fileExtension.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedExtension = fileExtension.isEmpty ? "img" : fileExtension
        let fileURL = sessionDirectory.appendingPathComponent(
            "\(timestamp)-\(UUID().uuidString.lowercased()).\(resolvedExtension)"
        )

        try importedPhoto.imageData.write(to: fileURL, options: [.atomic])

        return LocalSessionPhoto(
            id: UUID(),
            jobID: jobID,
            capturedAt: importedPhoto.capturedAt,
            localFileURL: fileURL,
            fileSizeBytes: importedPhoto.fileSizeBytes,
            imageWidth: importedPhoto.imageWidth,
            imageHeight: importedPhoto.imageHeight,
            mimeType: importedPhoto.mimeType,
            sortOrder: sortOrder,
            isPrimary: isPrimary,
            isSimulatorFallback: false
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
