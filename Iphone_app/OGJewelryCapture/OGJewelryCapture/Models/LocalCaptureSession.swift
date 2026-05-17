import Foundation
import UIKit

struct LocalSessionPhoto: Identifiable, Equatable {
    let id: UUID
    let jobID: UUID
    let capturedAt: Date
    let localFileURL: URL
    let fileSizeBytes: Int64
    let imageWidth: Int
    let imageHeight: Int
    let mimeType: String
    let sortOrder: Int
    let isPrimary: Bool
    let isSimulatorFallback: Bool

    var previewImage: UIImage? {
        UIImage(contentsOfFile: localFileURL.path)
    }
}

struct LocalCaptureSession: Equatable {
    static let softMaxPhotoCount = 10

    let jobID: UUID
    let finalUploadTargetJobID: UUID?
    let resolutionMode: CaptureResolutionMode
    let keptPhotos: [LocalSessionPhoto]
    let isUploadingFinalSet: Bool

    var keptPhotoCount: Int {
        keptPhotos.count
    }

    var canAddMorePhotos: Bool {
        keptPhotos.count < Self.softMaxPhotoCount
    }

    var primaryPhoto: LocalSessionPhoto? {
        keptPhotos.first(where: \.isPrimary)
    }
}
