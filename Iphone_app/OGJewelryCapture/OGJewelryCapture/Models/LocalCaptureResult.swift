import Foundation
import UIKit

struct LocalCaptureResult: Identifiable, Equatable {
    let id = UUID()
    let jobID: UUID
    let capturedAt: Date
    let imageData: Data
    let isSimulatorFallback: Bool

    var previewImage: UIImage? {
        UIImage(data: imageData)
    }

    var fileSizeBytes: Int {
        imageData.count
    }
}
