import Foundation
import UIKit

struct CaptureUploadResult: Identifiable, Equatable {
    let id = UUID()
    let jobID: UUID
    let capturedAt: Date
    let uploadedAt: Date
    let imageData: Data
    let isSimulatorFallback: Bool
    let storageBucket: String
    let storagePath: String
    let fileSizeBytes: Int64
    let mimeType: String

    var previewImage: UIImage? {
        UIImage(data: imageData)
    }

    var storagePathSummary: String {
        let parts = storagePath.split(separator: "/")
        guard parts.count >= 2 else { return storagePath }
        return parts.suffix(2).joined(separator: "/")
    }
}

