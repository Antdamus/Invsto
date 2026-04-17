import AVFoundation
import SwiftUI

struct CameraPreviewView: UIViewRepresentable {
    let session: AVCaptureSession
    let isTapToFocusEnabled: Bool
    let onTapToFocus: ((CGPoint) -> Void)?

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.videoPreviewLayer.videoGravity = .resizeAspectFill
        view.videoPreviewLayer.session = session
        view.onTapToFocus = onTapToFocus
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        uiView.videoPreviewLayer.session = session
        uiView.isTapToFocusEnabled = isTapToFocusEnabled
        uiView.onTapToFocus = onTapToFocus
    }
}

final class PreviewView: UIView {
    var isTapToFocusEnabled = false {
        didSet { tapGestureRecognizer.isEnabled = isTapToFocusEnabled }
    }

    var onTapToFocus: ((CGPoint) -> Void)?

    private let tapGestureRecognizer = UITapGestureRecognizer()
    private let focusIndicatorView: UIView = {
        let view = UIView(frame: CGRect(x: 0, y: 0, width: 84, height: 84))
        view.layer.borderColor = UIColor.systemYellow.cgColor
        view.layer.borderWidth = 2
        view.layer.cornerRadius = 12
        view.backgroundColor = .clear
        view.alpha = 0
        view.isUserInteractionEnabled = false
        return view
    }()

    override init(frame: CGRect) {
        super.init(frame: frame)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    override class var layerClass: AnyClass {
        AVCaptureVideoPreviewLayer.self
    }

    var videoPreviewLayer: AVCaptureVideoPreviewLayer {
        guard let layer = layer as? AVCaptureVideoPreviewLayer else {
            fatalError("Expected AVCaptureVideoPreviewLayer")
        }
        return layer
    }

    private func commonInit() {
        tapGestureRecognizer.addTarget(self, action: #selector(handleTap(_:)))
        tapGestureRecognizer.isEnabled = false
        addGestureRecognizer(tapGestureRecognizer)
        addSubview(focusIndicatorView)
    }

    @objc
    private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard isTapToFocusEnabled else { return }

        let point = gesture.location(in: self)
        let devicePoint = videoPreviewLayer.captureDevicePointConverted(fromLayerPoint: point)
        showFocusIndicator(at: point)
        onTapToFocus?(devicePoint)
    }

    private func showFocusIndicator(at point: CGPoint) {
        focusIndicatorView.layer.removeAllAnimations()
        focusIndicatorView.center = point
        focusIndicatorView.transform = CGAffineTransform(scaleX: 1.25, y: 1.25)
        focusIndicatorView.alpha = 1

        UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseOut]) {
            self.focusIndicatorView.transform = .identity
        }

        UIView.animate(withDuration: 0.22, delay: 0.85, options: [.curveEaseIn]) {
            self.focusIndicatorView.alpha = 0
        }
    }
}
