import AVFoundation
import Vision
import CoreML
import CoreImage
import UIKit

/// Anti-screenshot: przednia kamera wykrywa, czy ktoś celuje drugim telefonem/ekranem w nasz ekran.
/// W 100% on-device (AVFoundation + Vision + Core ML MobileNet), free/open, zero zapisu klatek.
///
/// Kanały (fail przy SCORE >= 6 — wcześniej 3, było za czułe):
/// 1. SZYBKIE PIKSELE  — jasność / % bieli / krawędzie (CPU, co ~0.9 s) — progi podniesione 0.65/0.60/0.08.
/// 2. VISION (2 s cache) — twarz w kadrze (legitymizacja) + duży prostokąt.
/// 3. MODEL MobileNet (ImageNet, 16MB via Core ML) — rozpoznaje „telefon/monitor/laptop” tylko przy conf >=0.50 (było 0.30) → +2.
/// 4. YOLOv8n cell phone — conf >=0.40 + 0.35 threshold (było 0.20/0.15), bez natychmiastowego fire, przez scoring.
/// 5. TRUEDEPTH — baseline ×2.5 i nearRatio 0.60/0.80 (było 2.0× 0.45/0.75).
final class FrontCameraMonitor: NSObject {
    struct CameraSignal {
        var score = 0.0
        var bigRect = false
        var bright = 0.0
        var noFace = false
        var luma = 0.0
        var depthNear = false
        var edge = 0.0
        var rect: CGRect?          // box Vision — rysowany na podglądzie
        var depthFrames = 0        // czy depth w ogóle dochodzi
        var depthActive = false
        var modelLabel: String?    // werdykt MobileNet
        var modelConf = 0.0
        var modelHit = false
        var phoneBackHit = false   // custom MobileNetV3 phone-back
        var phoneBackProb = 0.0
        var faceCount = 0
        var yoloHit = false        // YOLOv8n (COCO) wykrył "cell phone"
        var yoloConf = 0.0
        var yoloBox: CGRect?       // box telefonu (znormalizowany, origin bottom-left)
    }
    let session = AVCaptureSession() // podgląd w Dev Mode
    private let queue = DispatchQueue(label: "readproof.frontcamera", qos: .utility)
    private var lastSample = Date.distantPast
    private var lastVisionAt = Date.distantPast
    private var lastDepthAt = Date.distantPast
    private var started = false
    private var hasDepth = false
    private var faceSeen = true    // zakładamy twarz na starcie
    private var faceCount = 0
    private var faceCenter = true
    private var cachedRect: CGRect?
    private var modelHit = false
    private var modelLabel: String?
    private var modelConf = 0.0
    private var phoneBackHit = false
    private var phoneBackProb = 0.0
    // adaptacyjny depth
    private var depthBaseline: Float = 0
    private var depthBaselineValid = false
    private var depthSpikeCount = 0
    private(set) var isActive = false
    private(set) var videoFrames = 0
    private(set) var currentSignal = CameraSignal()
    private(set) var stalled = false      // kamera niby działa, ale klatki nie dochodzą
    private var stallTimer: Timer?
    private var framesAtCheck = 0
    private var lastFireAt = Date.distantPast

    var onScreenDetected: (() -> Void)?

    /// MobileNet (ImageNet) — mały model 16MB, klasyfikator „telefon/screen/…”, via Core ML
    private lazy var classifier: VNCoreMLRequest? = {
        let exts = ["mlmodelc", "mlpackage", "mlmodel"]
        var url: URL?
        for e in exts { if let u = Bundle.main.url(forResource: "MobileNet", withExtension: e) { url = u; break } }
        guard let url,
              let model = try? MLModel(contentsOf: url),
              let vn = try? VNCoreMLModel(for: model) else { return nil }
        let req = VNCoreMLRequest(model: vn)
        req.imageCropAndScaleOption = .centerCrop
        return req
    }()

    /// YOLOv8n — gotowy detektor obiektów COCO (klasa 67 = "cell phone"), 6.2 MB. Wykrywa tyły telefonów bez treningu.
    private lazy var yoloModel: MLModel? = {
        for n in ["yolov8n", "yolov8n.mlmodelc"] {
            if let u = Bundle.main.url(forResource: n, withExtension: n.contains(".") ? nil : "mlmodelc") {
                if let m = try? MLModel(contentsOf: u) { return m }
            }
        }
        if let u = Bundle.main.url(forResource: "yolov8n", withExtension: "mlmodelc"),
           let m = try? MLModel(contentsOf: u) { return m }
        return nil
    }()
    private let yoloCIContext = CIContext()
    private var yoloHit = false
    private var yoloConf = 0.0
    private var yoloBox: CGRect?

    private static let screenLike = [
        "cellular telephone", "mobile phone", "cellphone", "cell phone",
        "monitor", "screen, crt screen", "screen",
        "laptop", "desktop computer", "notebook", "hand-held computer"
    ]
    private static var phoneBackThreshold: Double {
        let demo = UserDefaults.standard.bool(forKey: "pitch_demo_mode") || UserDefaults.standard.bool(forKey: "admin_dev_mode")
        return demo ? 0.78 : 0.55
    }
    private static func isScreenLike(_ id: String) -> Bool {
        let idl = id.lowercased()
        return screenLike.contains { idl.contains($0) }
    }

    /// YOLOv8n (COCO 67 = cell phone) — letterbox 640 + MLModel, bez Vision. Zwraca (hit, conf, box znormalizowany origin bottom-left).
    private func yoloDetect(_ px: CVPixelBuffer) -> (hit: Bool, conf: Double, box: CGRect?) {
        guard let model = yoloModel else { return (false, 0, nil) }
        let w = CVPixelBufferGetWidth(px), h = CVPixelBufferGetHeight(px)
        guard w > 0, h > 0 else { return (false, 0, nil) }
        let ow = CGFloat(h), oh = CGFloat(w) // after .leftMirrored (90 deg)
        let scale = min(CGFloat(640) / ow, CGFloat(640) / oh)
        let newW = ow * scale, newH = oh * scale
        let padX = (CGFloat(640) - newW) / 2, padY = (CGFloat(640) - newH) / 2
        let ci = CIImage(cvPixelBuffer: px).oriented(.leftMirrored)
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .transformed(by: CGAffineTransform(translationX: padX, y: padY))
        var outBuf: CVPixelBuffer?
        let attrs: [String: Any] = [kCVPixelBufferCGImageCompatibilityKey as String: true, kCVPixelBufferCGBitmapContextCompatibilityKey as String: true]
        CVPixelBufferCreate(kCFAllocatorDefault, 640, 640, kCVPixelFormatType_32BGRA, attrs as CFDictionary, &outBuf)
        guard let out = outBuf else { return (false, 0, nil) }
        yoloCIContext.render(ci, to: out, bounds: CGRect(x: 0, y: 0, width: 640, height: 640), colorSpace: CGColorSpaceCreateDeviceRGB())
        guard let provider = try? MLDictionaryFeatureProvider(dictionary: [
            "image": MLFeatureValue(pixelBuffer: out),
            "iouThreshold": MLFeatureValue(double: 0.45),
            "confidenceThreshold": MLFeatureValue(double: 0.35)
        ]), let outFeat = try? model.prediction(from: provider),
              let coords = outFeat.featureValue(for: "coordinates")?.multiArrayValue,
              let conf = outFeat.featureValue(for: "confidence")?.multiArrayValue else { return (false, 0, nil) }
        let n = coords.shape[0].intValue
        var bestConf = 0.0
        var bestBox: CGRect?
        for i in 0..<n {
            var maxC = 0.0
            var maxIdx = -1
            for c in 0..<80 {
                let v = conf[[i, c] as [NSNumber]].doubleValue
                if v > maxC { maxC = v; maxIdx = c }
            }
            if maxIdx == 67 && maxC >= 0.40 && maxC > bestConf { // podniesiony próg: wcześniej 0.20 łapał fragmenty/tła
                let cx = coords[[i, 0] as [NSNumber]].doubleValue
                let cy = coords[[i, 1] as [NSNumber]].doubleValue
                let ww = coords[[i, 2] as [NSNumber]].doubleValue
                let hh = coords[[i, 3] as [NSNumber]].doubleValue
                let cxPix = cx * 640, cyPix = cy * 640, wPix = ww * 640, hPix = hh * 640
                let xo = (cxPix - Double(padX)) / Double(newW)
                let yo = (cyPix - Double(padY)) / Double(newH)
                let wn = wPix / Double(newW), hn = hPix / Double(newH)
                let rx = xo - wn / 2
                let ryTop = yo - hn / 2
                let ry = 1 - (ryTop + hn)
                let box = CGRect(x: rx, y: ry, width: wn, height: hn)
                bestConf = maxC
                bestBox = box
            }
        }
        return (bestConf > 0, bestConf, bestBox)
    }

    func start() {
        guard !started else { return }
        started = true
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            beginCapture()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] ok in
                guard ok else { self?.started = false; DispatchQueue.main.async { self?.isActive = false }; return }
                DispatchQueue.main.async { self?.beginCapture() }
            }
        default:
            started = false // brak zgody — sesja gra dalej, tylko bez kamery
        }
    }

    func stop() {
        stallTimer?.invalidate(); stallTimer = nil
        if session.isRunning { session.stopRunning() }
        session.inputs.forEach(session.removeInput)
        session.outputs.forEach(session.removeOutput)
        started = false
        isActive = false
        videoFrames = 0
        stalled = false
        currentSignal = CameraSignal()
    }

    private func startStallWatch() {
        stallTimer?.invalidate()
        framesAtCheck = videoFrames
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.stallTimer = Timer.scheduledTimer(withTimeInterval: 2.5, repeats: true) { [weak self] _ in
                guard let self else { return }
                self.stalled = self.isActive && self.videoFrames == self.framesAtCheck
                self.framesAtCheck = self.videoFrames
            }
        }
    }

    /// Konfiguracja wg oficjalnego wzorca Apple: preset + format z głębią + dwa outputy.
    private func beginCapture() {
        let device = AVCaptureDevice.default(.builtInTrueDepthCamera, for: .video, position: .front)
            ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
        guard let device else { isActive = false; return }
        do {
            session.beginConfiguration()
            session.sessionPreset = .high
            let depthCapable = device.formats.first(where: {
                $0.supportedDepthDataFormats.contains(where: {
                    CMFormatDescriptionGetMediaSubType($0.formatDescription) == kCVPixelFormatType_DepthFloat16
                })
            })
            hasDepth = depthCapable != nil
            if let f = depthCapable {
                try device.lockForConfiguration()
                device.activeFormat = f
                device.unlockForConfiguration()
            }
            let input = try AVCaptureDeviceInput(device: device)
            guard session.canAddInput(input) else { isActive = false; return }
            session.addInput(input)
            let out = AVCaptureVideoDataOutput()
            out.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            out.alwaysDiscardsLateVideoFrames = true
            out.setSampleBufferDelegate(self, queue: queue)
            guard session.canAddOutput(out) else { isActive = false; return }
            session.addOutput(out)
            if hasDepth {
                let depthOut = AVCaptureDepthDataOutput()
                depthOut.isFilteringEnabled = true
                depthOut.setDelegate(self, callbackQueue: queue)
                if session.canAddOutput(depthOut) { session.addOutput(depthOut) } else { hasDepth = false }
            }
            session.commitConfiguration()
            session.startRunning()
            isActive = session.isRunning
            startStallWatch()
            print("[camera] startRunning=\(isActive) device=\(device.localizedName) depth=\(hasDepth)")
        } catch {
            print("[camera] beginCapture error: \(error)")
            isActive = false
        }
    }
}

extension FrontCameraMonitor: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureVideoDataOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        videoFrames += 1
        if videoFrames % 60 == 0 {
            print("[camera] HB frames=\(videoFrames) active=\(isActive) score=\(String(format: "%.1f", currentSignal.score)) faceN=\(currentSignal.faceCount) depth=\(currentSignal.depthActive ? "ON" : "-") yolo=\(yoloHit ? String(format:"%.2f", yoloConf) : "-") label=\(modelLabel ?? "-")")
        }
        let now = Date()
        guard now.timeIntervalSince(lastSample) > 0.9, let px = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastSample = now

        if now.timeIntervalSince(lastVisionAt) > 1.0 {
            lastVisionAt = now
            runVision(px) // twarz + box + MobileNet + YOLOv8n (od razu fail gdy YOLO hit)
        }

        let (white, luma, edge) = fastScan(px)

        var s = CameraSignal()
        s.rect = cachedRect
        s.bigRect = cachedRect.map { $0.width > 0.35 && $0.height > 0.25 } ?? false
        s.bright = white
        s.luma = luma
        s.edge = edge
        s.noFace = faceCount == 0
        s.faceCount = faceCount
        s.modelLabel = modelLabel
        s.modelConf = modelConf
        s.modelHit = modelHit
        s.phoneBackHit = phoneBackHit
        s.phoneBackProb = phoneBackProb
        s.yoloHit = yoloHit
        s.yoloConf = yoloConf
        s.yoloBox = yoloBox
        if let yb = yoloBox, yoloHit { s.rect = yb } // prefer phone box
        s.depthFrames = currentSignal.depthFrames
        s.depthActive = currentSignal.depthActive
        s.depthNear = currentSignal.depthNear

        var sc = 0.0
        // Złagodzone progi — wcześniej łapało białą ścianę/kartkę jako telefon
        if white > 0.65 && luma > 0.60 { sc += 2 }                 // był 0.55/0.5 +3
        if luma > 0.85 { sc += 1 }                                // był 0.8 +2
        if edge > 0.08 && white > 0.30 { sc += 1 }                // był 0.06/0.2 +2
        if modelHit { sc += 2 }                                   // był +3, wymaga teraz conf >=0.50
        if phoneBackHit { sc += 3 }                               // był +4
        if yoloHit && yoloConf >= 0.45 { sc += 3 }                // był +5 bez progu, teraz tylko pewny cell phone
        // usunięte: `white >0.5 +1` — podwójnie liczyło biel i powodowało false-positive
        // face jest tylko informacyjnie — nie gate'uje detekcji

        s.score = sc
        currentSignal = s
        // Podniesiony próg dla obu trybów — prod był 3.0 i wywalał na jasnej kartce
        let demo = UserDefaults.standard.bool(forKey: "pitch_demo_mode") || UserDefaults.standard.bool(forKey: "admin_dev_mode")
        let failAt = demo ? 7.0 : 6.0
        if sc >= failAt { fireDebounced(demo: demo) }
    }


    /// Vision: twarz (cała + centrum), duży prostokąt, MobileNet — co ~2 s.
    /// UWAGA: bufor z kamery jest w orientacji czujnika — bez korekty Vision nie widzi twarzy.
    private func runVision(_ px: CVPixelBuffer) {
        let faceReq = VNDetectFaceRectanglesRequest()
        let rectReq = VNDetectRectanglesRequest()
        rectReq.minimumSize = 0.35
        rectReq.minimumAspectRatio = 0.3
        rectReq.maximumAspectRatio = 3.0
        rectReq.maximumObservations = 1
        rectReq.quadratureTolerance = 30
        var requests: [VNRequest] = [faceReq, rectReq]
        if let c = classifier { requests.append(c) }
        do {
            try VNImageRequestHandler(cvPixelBuffer: px, orientation: .leftMirrored, options: [:]).perform(requests)

            var faces = faceReq.results ?? []
            if faces.isEmpty {
                // fallback — inna orientacja (różne urządzenia / obrót)
                let alt = VNDetectFaceRectanglesRequest()
                if (try? VNImageRequestHandler(cvPixelBuffer: px, orientation: .up, options: [:]).perform([alt])) != nil {
                    faces = alt.results ?? []
                }
            }
            faceCount = faces.count
            faceSeen = faceCount > 0
            if faceSeen {
                let fx = faces.map { $0.boundingBox.midX }.reduce(0, +) / Double(faces.count)
                let fy = faces.map { $0.boundingBox.midY }.reduce(0, +) / Double(faces.count)
                faceCenter = fx > 0.2 && fx < 0.8 && fy > 0.2 && fy < 0.8
            } else {
                faceCenter = false
            }
            cachedRect = rectReq.results?.first?.boundingBox

            if let top = classifier?.results?.first as? VNClassificationObservation {
                modelLabel = top.identifier
                modelConf = Double(top.confidence)
                modelHit = Self.isScreenLike(top.identifier) && top.confidence >= 0.50
            }
            phoneBackHit = false
            phoneBackProb = 0
            let y = yoloDetect(px)
            yoloHit = y.hit
            yoloConf = y.conf
            yoloBox = y.box
            if yoloHit, let b = y.box { cachedRect = b }
            // usunięte natychmiastowe `fire()` - YOLO idzie teraz przez scoring + debounce (score + failAt)
        } catch {
            // Vision/CoreML padło — zostaw poprzedni stan
        }
    }

    private func fire() {
        DispatchQueue.main.async { [weak self] in self?.onScreenDetected?() }
    }

    private func fireDebounced(demo: Bool) {
        let gap: TimeInterval = demo ? 2.5 : 0.4
        let now = Date()
        guard now.timeIntervalSince(lastFireAt) >= gap else { return }
        lastFireAt = now
        fire()
    }

    /// Szybki przebieg CPU (BGRA): zwraca (BIAŁE %, LUMA, KRAWĘDZIE) w centrum kadru.
    private func fastScan(_ px: CVPixelBuffer) -> (Double, Double, Double) {
        CVPixelBufferLockBaseAddress(px, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(px, .readOnly) }
        let w = CVPixelBufferGetWidth(px), h = CVPixelBufferGetHeight(px)
        guard let base = CVPixelBufferGetBaseAddress(px), w > 0, h > 0 else { return (0, 0, 0) }
        let row = CVPixelBufferGetBytesPerRow(px)
        let buf = base.assumingMemoryBound(to: UInt8.self)
        let sx = w * 2 / 5, ex = w * 3 / 5, sy = h * 2 / 5, ey = h * 3 / 5
        var white = 0, edges = 0, total = 0, totalEdge = 0
        var sumLuma = 0.0
        for y in stride(from: sy, to: ey - 3, by: 3) {
            for x in stride(from: sx, to: ex - 3, by: 3) {
                let i = y * row + x * 4
                let r = Double(buf[i + 2]), g = Double(buf[i + 1]), b = Double(buf[i])
                let lum = 0.299 * r + 0.587 * g + 0.114 * b
                total += 1
                sumLuma += lum
                if r > 200 && g > 200 && b > 200 { white += 1 }
                let ir = i + 4
                let id = (y + 2) * row + x * 4
                let lr = 0.299 * Double(buf[ir + 2]) + 0.587 * Double(buf[ir + 1]) + 0.114 * Double(buf[ir])
                let ld = 0.299 * Double(buf[id + 2]) + 0.587 * Double(buf[id + 1]) + 0.114 * Double(buf[id])
                totalEdge += 2
                if abs(lum - lr) > 45 { edges += 1 }
                if abs(lum - ld) > 45 { edges += 1 }
            }
        }
        guard total > 0 else { return (0, 0, 0) }
        return (Double(white) / Double(total), sumLuma / Double(total) / 255.0, Double(edges) / Double(max(totalEdge, 1)))
    }
}

extension FrontCameraMonitor: AVCaptureDepthDataOutputDelegate {
    /// TRUEDEPTH — adaptacyjnie. Bez ręcznych progów dystansów.
    func depthDataOutput(_ output: AVCaptureDepthDataOutput, didOutput depthData: AVDepthData, timestamp: CMTime, connection: AVCaptureConnection) {
        let now = Date()
        guard now.timeIntervalSince(lastDepthAt) > 1 else { return }
        lastDepthAt = now
        currentSignal.depthFrames += 1
        currentSignal.depthActive = true
        let map = depthData.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32).depthDataMap
        CVPixelBufferLockBaseAddress(map, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
        let w = CVPixelBufferGetWidth(map), h = CVPixelBufferGetHeight(map)
        guard let base = CVPixelBufferGetBaseAddress(map), w > 0, h > 0 else { return }
        let row = CVPixelBufferGetBytesPerRow(map)
        let buf = base.assumingMemoryBound(to: Float32.self)

        // mediana dysparyty w centrum (przybliżenie przez próbkę)
        let sx = w / 4, ex = w * 3 / 4, sy = h / 4, ey = h * 3 / 4
        var vals = [Float]()
        vals.reserveCapacity(64)
        var covered = 0, sampled = 0
        for y in stride(from: sy, to: ey, by: 3) {
            for x in stride(from: sx, to: ex, by: 3) {
                let v = buf[y * row / 4 + x]
                sampled += 1
                if v.isFinite && v > 0 { covered += 1; vals.append(v) }
            }
        }
        guard covered > 24 else { return } // za mało danych z depth → pomiń (baseline zostaje)
        vals.sort()
        let med = vals[vals.count / 2]

        // 1. UCZ SIĘ baseline (normalna sesja z twarzą)
        if !depthBaselineValid {
            depthBaseline = med
            depthBaselineValid = true
            return
        }
        // 2. Ile pikseli w centrum jest dużo bliżej niż baseline (ekran/telefon przed kamerą)
        let spikeV = max(depthBaseline, 0.001) * 2.5
        var near = 0
        for v in vals where v > spikeV { near += 1 }
        let nearRatio = Double(near) / Double(vals.count)
        if nearRatio > 0.60 {
            depthSpikeCount += 1
            if nearRatio > 0.80 || depthSpikeCount >= 2 { // był 0.45/0.75 i 2.0× — teraz 0.60/0.80 i 2.5×
                depthSpikeCount = 0
                currentSignal.depthNear = true
                fire()
            }
        } else {
            depthSpikeCount = 0
            depthBaseline = depthBaseline * 0.95 + med * 0.05 // powolna adaptacja do „normalnego”
        }
    }
}