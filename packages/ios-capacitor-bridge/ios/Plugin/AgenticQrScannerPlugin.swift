import AVFoundation
import Capacitor
import Foundation
import UIKit

// Native AVFoundation QR scanner for Plan Connector pairing. WKWebView does not reliably support the
// BarcodeDetector API, so the phone-side pairing flow (apps/browser-demo/src/iosPairBridge.ts) calls
// this plugin to scan the QR shown on the user's computer. The relay claim, E2EE, and credential
// storage all happen in JS — this plugin's ONLY job is to return the scanned string.
//
// Result envelope mirrors the Android scanner so the shared UI copy (nativeQrScanErrorMessage) reuses
// the same codes: { ok: true, rawValue } on success; { ok: false, error } with one of
// "permission_denied" | "camera_unavailable" | "cancelled" | "scanner_busy" | "scan_failed".
@objc(AgenticQrScannerPlugin)
public class AgenticQrScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgenticQrScannerPlugin"
    public let jsName = "AgenticQrScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

    private var activeScanner: AgenticQrScannerViewController?

    @objc func scan(_ call: CAPPluginCall) {
        guard AgenticBridgeOrigin.validate(call, on: bridge) else { return }
        if activeScanner != nil {
            AgenticIOSLog.fail("AgenticQrScanner", "scan", "REJECT", "scanner already open")
            call.resolve(["ok": false, "error": "scanner_busy"])
            return
        }
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        switch status {
        case .authorized:
            presentScanner(call)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted {
                        self?.presentScanner(call)
                    } else {
                        AgenticIOSLog.fail("AgenticQrScanner", "scan", "REJECT", "camera permission denied")
                        call.resolve(["ok": false, "error": "permission_denied"])
                    }
                }
            }
        default:
            AgenticIOSLog.fail("AgenticQrScanner", "scan", "REJECT", "camera permission unavailable", ["status": String(status.rawValue)])
            call.resolve(["ok": false, "error": "permission_denied"])
        }
    }

    private func presentScanner(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let presenter = self.bridge?.viewController else {
                AgenticIOSLog.fail("AgenticQrScanner", "scan", "FAIL", "no presenting view controller")
                call.resolve(["ok": false, "error": "camera_unavailable"])
                return
            }
            let scanner = AgenticQrScannerViewController()
            scanner.modalPresentationStyle = .fullScreen
            scanner.onResult = { [weak self] result in
                self?.activeScanner = nil
                switch result {
                case .success(let value):
                    AgenticIOSLog.info("AgenticQrScanner", "scan", "DONE", "qr captured", ["chars": String(value.count)])
                    call.resolve(["ok": true, "rawValue": value])
                case .failure(let code):
                    AgenticIOSLog.info("AgenticQrScanner", "scan", "DONE", "no qr", ["error": code])
                    call.resolve(["ok": false, "error": code])
                }
            }
            self.activeScanner = scanner
            AgenticIOSLog.info("AgenticQrScanner", "scan", "START", "presenting scanner")
            presenter.present(scanner, animated: true)
        }
    }
}

// Full-screen camera scanner. Self-contained: builds the AVCaptureSession, shows a preview + Cancel
// button + instruction label, and reports exactly one result (first QR, cancel, or camera failure).
final class AgenticQrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    enum ScanResult {
        case success(String)
        case failure(String)
    }

    var onResult: ((ScanResult) -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "com.agentic.qrscanner.session")
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var settled = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard configureSession() else {
            finish(.failure("camera_unavailable"))
            return
        }

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.layer.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        addChrome()
        sessionQueue.async { [weak self] in
            guard let self, !self.settled else { return }
            self.session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.layer.bounds
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Belt-and-suspenders: if the view goes away without a settled result (e.g. an OS-level
        // dismissal), report a cancel so the JS promise never hangs.
        if !settled { finish(.failure("cancelled")) }
    }

    private func configureSession() -> Bool {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
            ?? AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: device) else {
            return false
        }
        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            return false
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            return false
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        // metadataObjectTypes must be set AFTER the output is added to the session.
        output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []
        session.commitConfiguration()
        return !output.metadataObjectTypes.isEmpty
    }

    private func addChrome() {
        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = "Point at the QR on your computer’s connector page"
        label.textColor = .white
        label.font = .systemFont(ofSize: 15, weight: .medium)
        label.numberOfLines = 0
        label.textAlignment = .center
        label.shadowColor = .black
        label.shadowOffset = CGSize(width: 0, height: 1)
        view.addSubview(label)

        let cancel = UIButton(type: .system)
        cancel.translatesAutoresizingMaskIntoConstraints = false
        var cancelConfig = UIButton.Configuration.plain()
        var cancelTitle = AttributeContainer()
        cancelTitle.font = .systemFont(ofSize: 17, weight: .semibold)
        cancelConfig.attributedTitle = AttributedString("Cancel", attributes: cancelTitle)
        cancelConfig.baseForegroundColor = .white
        cancelConfig.background.backgroundColor = UIColor(white: 0, alpha: 0.55)
        cancelConfig.background.cornerRadius = 10
        cancelConfig.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 24, bottom: 10, trailing: 24)
        cancel.configuration = cancelConfig
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        view.addSubview(cancel)

        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -28),
        ])
    }

    @objc private func cancelTapped() {
        finish(.failure("cancelled"))
    }

    public func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !settled else { return }
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
            object.type == .qr,
            let value = object.stringValue,
            !value.isEmpty else {
            return
        }
        finish(.success(value))
    }

    private func finish(_ result: ScanResult) {
        guard !settled else { return }
        settled = true
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning { self.session.stopRunning() }
        }
        let deliver = { [weak self] in
            self?.onResult?(result)
            self?.onResult = nil
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.presentingViewController != nil && self.isBeingDismissed == false {
                self.dismiss(animated: true, completion: deliver)
            } else {
                deliver()
            }
        }
    }
}
