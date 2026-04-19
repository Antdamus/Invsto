import Foundation
import UIKit

struct LocalCaptureResult: Identifiable, Equatable {
    let id = UUID()
    let jobID: UUID
    let capturedAt: Date
    let imageData: Data
    let fileSizeBytes: Int64
    let imageWidth: Int
    let imageHeight: Int
    let mimeType: String
    let isSimulatorFallback: Bool

    var previewImage: UIImage? {
        UIImage(data: imageData)
    }
}
