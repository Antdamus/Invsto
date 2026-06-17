import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct SystemCameraCaptureView: UIViewControllerRepresentable {
    enum CaptureError: LocalizedError {
        case cameraUnavailable
        case missingImage
        case missingJPEGData

        var errorDescription: String? {
            switch self {
            case .cameraUnavailable:
                "System Camera is unavailable on this device."
            case .missingImage:
                "System Camera did not return a captured image."
            case .missingJPEGData:
                "System Camera returned an image that could not be stored as JPEG data."
            }
        }
    }

    static var isAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    let onCapture: (Data) -> Void
    let onCancel: () -> Void
    let onFailure: (String) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.delegate = context.coordinator
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.cameraDevice = .rear
        picker.allowsEditing = false
        picker.mediaTypes = [UTType.image.identifier]
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onCapture: onCapture,
            onCancel: onCancel,
            onFailure: onFailure
        )
    }
}

extension SystemCameraCaptureView {
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onCapture: (Data) -> Void
        private let onCancel: () -> Void
        private let onFailure: (String) -> Void

        init(
            onCapture: @escaping (Data) -> Void,
            onCancel: @escaping () -> Void,
            onFailure: @escaping (String) -> Void
        ) {
            self.onCapture = onCapture
            self.onCancel = onCancel
            self.onFailure = onFailure
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCancel()
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage else {
                onFailure(SystemCameraCaptureView.CaptureError.missingImage.localizedDescription)
                return
            }

            let metadata = info[.mediaMetadata] as? [String: Any]

            guard let imageData = Self.makeJPEGData(from: image, metadata: metadata) else {
                onFailure(SystemCameraCaptureView.CaptureError.missingJPEGData.localizedDescription)
                return
            }

            onCapture(imageData)
        }

        private static func makeJPEGData(from image: UIImage, metadata: [String: Any]?) -> Data? {
            guard let cgImage = image.cgImage else {
                return image.jpegData(compressionQuality: 0.96)
            }

            let imageData = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(
                imageData,
                UTType.jpeg.identifier as CFString,
                1,
                nil
            ) else {
                return image.jpegData(compressionQuality: 0.96)
            }

            var properties = metadata ?? [:]
            properties[kCGImageDestinationLossyCompressionQuality as String] = 0.96
            properties[kCGImagePropertyOrientation as String] = image.imageOrientation.cgImagePropertyOrientation.rawValue

            CGImageDestinationAddImage(destination, cgImage, properties as CFDictionary)

            guard CGImageDestinationFinalize(destination) else {
                return image.jpegData(compressionQuality: 0.96)
            }

            return imageData as Data
        }
    }
}

private extension UIImage.Orientation {
    var cgImagePropertyOrientation: CGImagePropertyOrientation {
        switch self {
        case .up:
            .up
        case .upMirrored:
            .upMirrored
        case .down:
            .down
        case .downMirrored:
            .downMirrored
        case .left:
            .left
        case .leftMirrored:
            .leftMirrored
        case .right:
            .right
        case .rightMirrored:
            .rightMirrored
        @unknown default:
            .up
        }
    }
}
