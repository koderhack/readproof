import SwiftUI
import ActivityKit
import AVFoundation

struct ReadingSessionView: View {
    let book: Book
    let chapter: Chapter
    var campaignId: String? = nil // ustawione dla książek wydawców (start przez /api/publisher/campaigns/:id/start)
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @Environment(\.dismiss) var dismiss
    @State private var sessionId: String?
    @State private var challenges: [BackendService.SessionChallenge] = []
    @State private var answers: [String: Any] = [:]
    @State private var completed: Set<String> = []
    @State private var failed: Set<String> = [] // źle odpowiedziane — znikają, pokazujemy następne
    var answeredCount: Int { completed.count + failed.count }
    @State private var now = Date()
    @State private var error: String?
    @State private var suspicious = false
    @State private var isPaused = false
    @State private var isCaptured = UIScreen.main.isCaptured
    @State private var showResult = false
    @State private var proof: ReadingProof?
    @State private var starting = false
    @State private var lastResult: (challengeId: String, correct: Bool)?
    @State private var lastCorrectText: String?
    @State private var aiBlocked = false
    @State private var hearts = 3
    let maxHearts = 3
    @State private var rulesAccepted = false
    @State private var cooldownUntil: Date?
    @State private var cameraMonitor = FrontCameraMonitor()
    @State private var cameraOK = false
    @State private var cameraSignal = FrontCameraMonitor.CameraSignal()
    @State private var cameraFrames = 0
    @State private var showCameraPreview = false

    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if starting {
                    ProgressView("Przygotowujemy Twoją sesję…")
                        .frame(maxWidth: .infinity)
                        .padding(20)
                } else {
                    header
                    cameraStatus
                    if isPaused {
                        Label("Sesja wstrzymana — licznik zatrzymany (weryfikowane przez backend).", systemImage:"pause.circle.fill").font(.caption).foregroundStyle(.white).padding(10).background(Color(hex:"#FF8B4D")).clipShape(RoundedRectangle(cornerRadius:10))
                    }
                    if suspicious {
                        Label(loc.t("Sesja oznaczona jako podejrzana — screenshot/screen recording wykryty. Możesz spróbować ponownie.","Session flagged suspicious — screenshot detected. You can retry."), systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.white).padding(10).background(Color.red).clipShape(RoundedRectangle(cornerRadius:10))
                    }
                    if let cd = cooldownUntil {
                        blockedCard(cd)
                    } else if !rulesAccepted {
                        rulesCard
                    } else {
                        // 1 pytanie na ekran — jak Duolingo, nie lista
                    if let active = challenges.first(where: { !isLocked($0) && !completed.contains($0.id) && !failed.contains($0.id) }) {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text(active.type?.displayName ?? "Challenge").font(.caption.weight(.bold)).foregroundStyle(RPColor.primary)
                                Spacer()
                                Text("Pytanie \(answeredCount+1)/\(challenges.count)").font(.caption2.weight(.bold)).foregroundStyle(RPColor.muted)
                            }
                            if let q = active.question {
                                Text(q).font(.headline).foregroundStyle(RPColor.ink).textSelection(.disabled)
                                if let ctx = active.context { Text(ctx).font(.caption).foregroundStyle(RPColor.muted).textSelection(.disabled) }
                            }
                            // wynik — pokazujemy też poprawną odpowiedź, mniej agresywne czerwone
                            if let fb = lastResult, fb.challengeId == active.id {
                                VStack(alignment:.leading, spacing:6){
                                    HStack(spacing: 8) {
                                        Image(systemName: fb.correct ? "checkmark.circle.fill" : "xmark.circle.fill").font(.title3)
                                        VStack(alignment:.leading, spacing:2){
                                            if aiBlocked {
                                                Text(loc.t("Wykryto odpowiedź AI","AI-written answer detected")).font(.headline.weight(.bold))
                                                Text(loc.t("Odpowiedzi wklejane z ChatGPT blokują sesję jak cheatowanie.","Answers pasted from ChatGPT block the session like cheating.")).font(.caption2)
                                            } else {
                                                Text(fb.correct ? loc.t("Dobrze!","Correct!") : loc.t(hearts<=0 ? "Źle — koniec serc" : "Źle — straciłeś serce","Wrong — lost a heart")).font(.headline.weight(.bold))
                                                if !fb.correct { Text(hearts<=0 ? loc.t("Sesja zakończona — możesz spróbować ponownie od razu","Session ended — you can retry right away") : loc.t("Zostało \(hearts) \(hearts==1 ? "serce" : "serca")","\(hearts) hearts left")).font(.caption2) }
                                            }
                                        }
                                        Spacer()
                                    }
                                    if !fb.correct, !aiBlocked, let ct = lastCorrectText, !ct.isEmpty {
                                        Text(loc.t("Poprawna odpowiedź: ","Correct answer: ") + ct).font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.95)).padding(.top,2)
                                    }
                                }
                                .foregroundStyle(.white).padding(12).background(fb.correct ? RPColor.success : Color.red.opacity(0.88)).clipShape(RoundedRectangle(cornerRadius:10))
                            }
                            UnlockCard(challenge: active, answered: lastResult?.challengeId == active.id ? lastResult?.correct : nil, correctText: lastCorrectText, onSubmit: { ans in
                                answers[active.id] = ans
                                Task {
                                    let ok = await BackendService.shared.answerSessionDetailed(sessionId: sessionId ?? "", challengeId: active.id, answer: ans)
                                    let correct = ok?.correct ?? false
                                    if !correct { lastCorrectText = ok?.correctText ?? correctAnswerText(for: active) }
                                    lastResult = (active.id, correct)
                                    // AI-writing: backend wykrył tekst z AI — blokada sesji jak przy cheatowaniu
                                    if ok?.aiDetected == true {
                                        aiBlocked = true; hearts -= 1
                                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                                        aiBlocked = false
                                        await completeWithWrong()
                                        return
                                    }
                                    if correct {
                                        try? await Task.sleep(nanoseconds: 900_000_000)
                                        completed.insert(active.id)
                                        lastResult = nil; lastCorrectText = nil
                                        updateLive()
                                    } else {
                                        hearts -= 1
                                        if hearts <= 0 {
                                            try? await Task.sleep(nanoseconds: 2_000_000_000)
                                            await completeWithWrong()
                                        } else {
                                            // ŹLE: pokaż poprawną odpowiedź dłużej, potem pytanie ZNIKA i wchodzi następne
                                            try? await Task.sleep(nanoseconds: 2_500_000_000)
                                            failed.insert(active.id)
                                            lastResult = nil; lastCorrectText = nil
                                            updateLive()
                                        }
                                    }
                                }
                            })
                            .id(active.id)
                        }
                        .padding(14).background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:14)).overlay(RoundedRectangle(cornerRadius:14).stroke(RPColor.primary, lineWidth: 1.5))
                        .blur(radius: isCaptured ? 16 : 0)
                        .privacySensitive()
                        .overlay {
                            if isCaptured {
                                ZStack {
                                    Color.black.opacity(0.5)
                                    VStack(spacing: 6) {
                                        Image(systemName: "eye.slash.fill").foregroundStyle(.white).font(.title2)
                                        Text("Treść ukryta — nagrywanie ekranu").font(.caption.weight(.bold)).foregroundStyle(.white)
                                        Text("Jak w banku").font(.caption2).foregroundStyle(.white.opacity(0.8))
                                    }
                                }.clipShape(RoundedRectangle(cornerRadius:14))
                            }
                        }
                    } else if let next = challenges.filter({ isLocked($0) && !completed.contains($0.id) && !failed.contains($0.id) }).sorted(by: { ($0.releaseAt ?? "") < ($1.releaseAt ?? "") }).first {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack { Image(systemName: "book.fill").foregroundStyle(RPColor.muted2); Text(next.hint ?? loc.t("Czytaj dalej…","Keep reading…")).font(.subheadline).foregroundStyle(RPColor.muted) }
                                .padding(12).background(Color(hex:"#F9FAFB")).clipShape(RoundedRectangle(cornerRadius:12)).textSelection(.disabled)
                            HStack { Spacer(); Text(loc.t("Następne za","Next in") + " \(countdown(next))").font(.caption.monospaced()).foregroundStyle(RPColor.muted) }
                        }.padding(14).background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:14)).overlay(RoundedRectangle(cornerRadius:14).stroke(RPColor.line))
                    }
                    if answeredCount >= 1 || challenges.allSatisfy({ completed.contains($0.id) || failed.contains($0.id) }) {
                        Button {
                            Task { await complete() }
                        } label: {
                            Text(answeredCount == challenges.count ? "ZAKOŃCZ I ZWERYFIKUJ" : "ZAKOŃCZ WCZEŚNIEJ (\(answeredCount)/\(challenges.count))").font(.headline).frame(maxWidth:.infinity).padding(.vertical,14).background(RPColor.primary).foregroundStyle(.white).clipShape(RoundedRectangle(cornerRadius:12))
                        }
                    }
                    } // else cooldown
                }
                if let e = error { Text(e).foregroundStyle(.red).font(.caption) }
            }
            .padding(16)
        }
        .background(RPColor.bg)
        .navigationTitle("Proof of Comprehension")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(RPColor.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button {
                    stopLive()
                    dismiss()
                } label: {
                    HStack(spacing: 4) { Image(systemName: "chevron.left"); Text("Wyjdź") }.font(.system(size:14, weight:.semibold)).foregroundStyle(RPColor.primary)
                }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Menu {
                    Button("Anuluj sesję", role: .destructive) { Task { if let id=sessionId{ await BackendService.shared.flagSession(sessionId:id, type:"userCancel") }; stopLive(); dismiss() } }
                    Button("Paszport") { dismiss() }
                } label: { Image(systemName: "ellipsis.circle").foregroundStyle(RPColor.ink) }
            }
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .tabBar) // dół menu znika na czas sesji — nie da się przełączyć zakładki
        .onReceive(timer) { _ in now = Date(); cameraOK = cameraMonitor.isActive; cameraSignal = cameraMonitor.currentSignal; cameraFrames = cameraMonitor.videoFrames }
        .onAppear { cameraMonitor.onScreenDetected = { print("[camera] wykryto ekran — nie oznaczam od razu jako podejrzana (złagodzone, wcześniej false-positive gdy nic nie zrobiono)") }; observeScreenshots() }
        .onDisappear { stopLive() }
        .navigationDestination(isPresented: $showResult) { if let p=proof{ ResultMinimalView(book:book, chapter:chapter, results:[], proof:p)}}
    }

    var cameraStatus: some View {
        HStack(spacing: 6) {
            Circle().fill(cameraOK ? Color.green : RPColor.muted.opacity(0.4)).frame(width: 8, height: 8)
            Text(cameraOK ? "Kamera aktywna" : "Kamera wyłączona").font(.caption2.weight(.medium)).foregroundStyle(RPColor.muted)
            Spacer()
            Image(systemName: cameraOK ? "video.fill" : "video.slash.fill").font(.caption2).foregroundStyle(RPColor.muted)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RPColor.card).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    var header: some View {
        VStack(alignment: .leading, spacing: 6){
            Text(book.title).font(.headline).foregroundStyle(RPColor.ink)
            Text(chapter.title).font(.subheadline).foregroundStyle(RPColor.muted)
            HStack(spacing:8){
                Label("Sesja", systemImage:"timer").font(.caption2).foregroundStyle(RPColor.muted)
                Text("5 wyzwań • losowe 5 z 30 • fragment-dependent").font(.caption2).foregroundStyle(RPColor.muted)
                Spacer()
                HStack(spacing:2){
                    ForEach(0..<maxHearts, id:\.self){ i in Image(systemName: i < hearts ? "heart.fill" : "heart").font(.caption2).foregroundStyle(i < hearts ? Color.red : RPColor.line) }
                    Text("\(hearts)/\(maxHearts)").font(.caption2.monospaced()).foregroundStyle(RPColor.muted)
                }
                if UserDefaults.standard.bool(forKey:"pitch_demo_mode") || UserDefaults.standard.bool(forKey:"admin_dev_mode") {
                    Text("DEMO").font(.caption2.weight(.black)).foregroundStyle(.white)
                        .padding(.horizontal,8).padding(.vertical,3)
                        .background(RPColor.primary).clipShape(Capsule())
                }
                Text("\(answeredCount)/\(challenges.count)").font(.caption.weight(.bold)).foregroundStyle(RPColor.primary)
            }
            ProgressView(value: Double(answeredCount), total: Double(max(challenges.count,1))).tint(RPColor.primary)
            Text("Nie pokazujemy 5 pytań od razu — odblokowują się co ~2 min (demo) / 5 min (real). Nie da się wkleić całości do ChatGPT. Masz 3 ❤️ — 3 złe odpowiedzi kończą sesję; screenshot/telefon kończy od razu. Bez blokady czasowej.").font(.caption2).foregroundStyle(RPColor.muted)
        }.padding(14).background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:14)).overlay(RoundedRectangle(cornerRadius:14).stroke(RPColor.line))
    }

    var rulesCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Zasady testu", systemImage: "exclamationmark.shield.fill").font(.headline).foregroundStyle(RPColor.ink)
            VStack(alignment: .leading, spacing: 8) {
                Label("Możesz korzystać tylko z książki — zabronione są podpowiedzi (AI, ChatGPT, notatki, drugi telefon).", systemImage: "book.fill").font(.caption).foregroundStyle(RPColor.ink)
                Label("Aplikacja posiada zabezpieczenia wykrywające screenshoty i nagrywanie ekranu.", systemImage: "eye.slash.fill").font(.caption).foregroundStyle(RPColor.ink)
                Label("Kamera obserwuje i wykrywa nagrywanie oraz zdjęcia z innego telefonu.", systemImage: "camera.fill").font(.caption).foregroundStyle(RPColor.ink)
            }
            Text("Kontynuując, potwierdzasz że zapoznałeś się z zasadami.").font(.caption2).foregroundStyle(RPColor.muted)
            Button {
                rulesAccepted = true
                starting = true
                Task { await start() }
            } label: {
                Text("Akceptuję zasady — rozpocznij test").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 12)
            }.buttonStyle(BurgundyButtonStyle())
        }.padding(14).background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:14)).overlay(RoundedRectangle(cornerRadius:14).stroke(RPColor.primary, lineWidth: 1.5))
    }

    func correctAnswerText(for ch: BackendService.SessionChallenge) -> String? {
        if let idx = ch.correctAnswer, let opts = ch.options, idx >= 0, idx < opts.count { return opts[idx] }
        if let idxs = ch.correctAnswers, let opts = ch.options, !idxs.isEmpty { return idxs.compactMap{ $0 < opts.count ? opts[$0] : nil }.joined(separator: ", ") }
        if let pairs = ch.pairs, !pairs.isEmpty { return pairs.map{ "\($0.left) → \($0.right)" }.joined(separator: ", ") }
        if let exp = ch.expectedMeaning, !exp.isEmpty { return exp }
        if let err = ch.errorIndex, let stmts = ch.statements, err < stmts.count { return stmts[err] }
        if let items = ch.items, let order = ch.correctOrder, !order.isEmpty { return order.map{ $0 < items.count ? items[$0] : "" }.joined(separator: " → ") }
        return nil
    }
    func isLocked(_ ch: BackendService.SessionChallenge) -> Bool {
        if UserDefaults.standard.bool(forKey:"admin_dev_mode") { return false }
        guard let ra = ch.releaseAt, let d = ISO8601DateFormatter().date(from: ra) else { return ch.locked ?? false }
        return d > now
    }
    func countdown(_ ch: BackendService.SessionChallenge) -> String {
        guard let ra = ch.releaseAt, let d = ISO8601DateFormatter().date(from: ra) else { return "" }
        let sec = max(0, Int(d.timeIntervalSince(now)))
        return String(format:"%02d:%02d", sec/60, sec%60)
    }
    func cooldownRemaining(_ until: Date) -> String {
        let sec = max(0, Int(until.timeIntervalSince(now)))
        return String(format:"%02d:%02d", sec/60, sec%60)
    }
    func blockedCard(_ until: Date) -> some View {
        let left = max(0, Int(until.timeIntervalSince(now)))
        let _ = left // zachowane dla kompatybilności, ale ignorowane — brak blokady
        return VStack(alignment: .center, spacing: 12) {
            Image(systemName: "lock.fill").font(.system(size: 34)).foregroundStyle(RPColor.primary)
            Text(loc.t("Blokada po oszukanej próbie","Locked after suspicious attempt")).font(.headline).foregroundStyle(RPColor.ink)
            Text(loc.t("Jedna błędna odpowiedź lub screenshot kończy sesję — możesz zacząć nową od razu, bez czekania.","A wrong answer or screenshot ends the session — you can start a new one right away."))
                .font(.caption).foregroundStyle(RPColor.muted).multilineTextAlignment(.center)
            VStack(spacing: 2) {
                Text(loc.t("Ponowna próba dostępna od razu","Retry available now")).font(.caption).foregroundStyle(RPColor.muted)
                if left > 0 {
                    Text(cooldownRemaining(until)).font(.system(size: 40, weight: .black, design: .rounded)).monospacedDigit().foregroundStyle(RPColor.ink)
                }
            }.padding(.vertical, 4)
            Button {
                Task { await start() }
            } label: {
                Text(loc.t("SPRÓBUJ PONOWNIE","TRY AGAIN"))
                    .font(.headline).frame(maxWidth:.infinity).padding(.vertical,14)
            }
            .buttonStyle(BurgundyButtonStyle())
            Text(loc.t("Bez blokady czasowej — więcej minut na każde pytanie (5 min).","No time lock — more minutes per question (5 min).")).font(.caption2).foregroundStyle(RPColor.muted).multilineTextAlignment(.center)
        }
        .padding(18).frame(maxWidth:.infinity, alignment: .center)
        .background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:14)).overlay(RoundedRectangle(cornerRadius:14).stroke(RPColor.primary, lineWidth:1.5))
    }
    func start() async {
        guard let wallet = appState.wallet.address, PhantomService.isValidSolanaAddress(wallet) else { error="Połącz Phantom Devnet"; starting=false; return }
        do{
            // książki wydawców startują przez /api/publisher/campaigns/:id/start (ta sama sesja/answer/complete)
            if let cid = campaignId {
                let s = try await BackendService.shared.startCampaignSession(campaignId: cid, walletAddress: wallet)
                guard let sid = s.sessionId, let chs = s.challenges else { throw BackendService.GenError.parse }
                sessionId = sid; challenges = chs; starting=false; cooldownUntil=nil; hearts = maxHearts; completed = []; failed = []; answers = [:]; lastResult = nil; lastCorrectText = nil; aiBlocked = false; error = nil
            } else {
                let s = try await BackendService.shared.startSession(bookId: book.id, chapterId: chapter.id, walletAddress: wallet)
                sessionId = s.id; challenges = s.challenges; starting=false; cooldownUntil=nil; hearts = maxHearts; completed = []; failed = []; answers = [:]; lastResult = nil; lastCorrectText = nil; aiBlocked = false; error = nil
            }
            ReadingSessionActivityManager.shared.start(book: book, chapter: chapter, total: s.challenges.count)
            cameraMonitor.start() // anty-zdjęcie drugim telefonem — dopiero gdy sesja naprawdę ruszyła
            updateLive()
        } catch BackendService.GenError.cooldown(let retryAfter, let until) {
            // blokada po oszukanej próbie — pokaż odliczanie do odblokowania, nie kod błędu
            cooldownUntil = until ?? (retryAfter > 0 ? Date().addingTimeInterval(retryAfter) : nil)
            starting = false; error = nil
        } catch let e { error = e.localizedDescription; starting=false }
    }
    func updateLive(){
        let next = challenges.first{ isLocked($0) }.flatMap{ $0.releaseAt}.flatMap{ ISO8601DateFormatter().date(from:$0) }.map{ max(0, Int($0.timeIntervalSince(now)))} ?? 0
        ReadingSessionActivityManager.shared.update(completed: answeredCount, total: challenges.count, nextUnlockIn: next, status: answeredCount==challenges.count ? "verifying" : "reading")
    }
    func stopLive(){ ReadingSessionActivityManager.shared.end(status: proof?.status.rawValue ?? "ended"); cameraMonitor.stop() }
    func completeWithWrong() async {
        guard let id=sessionId else { return }
        suspicious=true
        stopLive()
        // zakończ od razu (fail=1) — status Failed, blokada 30 min na ponowne podejście
        if let p = await BackendService.shared.completeSession(sessionId: id, endEarly: true) {
            proof = p; showResult = true
        } else {
            let now2 = Date()
            let hash = SolanaService.shared.createProofHash(bookId: book.id, chapterId: chapter.id, wallet: appState.wallet.address ?? "no-wallet", timestamp: now2, score: completed.count)
            let pf = ReadingProof(id: UUID().uuidString, bookId: book.id, chapterId: chapter.id, challengeIds: challenges.map{$0.id}, score: completed.count, total: challenges.count, status: .failed, walletAddress: appState.wallet.address ?? "no-wallet", timestamp: now2, proofHash: hash, txSignature: nil, explorerUrl: nil, reward: nil, verificationVersion: "readproof-v1", durationSec: nil)
            proof = pf; showResult = true
        }
    }
    func complete() async {
        guard let id=sessionId else { error="Brak sesji — zacznij test od nowa"; return }
        if let p = await BackendService.shared.completeSession(sessionId: id) {
            proof = p; showResult = true
            appState.saveProof(p)
            stopLive()
        } else {
            // PRAWDZIWY powód z backendu zamiast mylącego "sprawdź Jev"
            if let d = BackendService.shared.lastError, !d.isEmpty {
                error = "Nie udało się zakończyć: \(d.prefix(300))"
            } else {
                error = "Nie udało się zakończyć — sprawdź połączenie z backendem i spróbuj ponownie"
            }
        }
    }
    func failOnSuspicion(type: String) {
        suspicious=true
        stopLive()
        guard let id=sessionId else { return }
        Task {
            _ = await BackendService.shared.flagSession(sessionId: id, type: type)
            // natychmiast kończymy sesję i pokazujemy wynik — brak nagrody, blokada 30 min
            if let p = await BackendService.shared.completeSession(sessionId: id, endEarly: true) {
                proof = p; showResult = true
            }
        }
    }
    func observeScreenshots(){
        isCaptured = UIScreen.main.isCaptured
        NotificationCenter.default.addObserver(forName: UIApplication.userDidTakeScreenshotNotification, object:nil, queue:.main){ _ in
            failOnSuspicion(type: "screenshot")
        }
        NotificationCenter.default.addObserver(forName: UIScreen.capturedDidChangeNotification, object:nil, queue:.main){ _ in
            isCaptured = UIScreen.main.isCaptured
            if UIScreen.main.isCaptured { failOnSuspicion(type: "screenRecording") }
        }
    }
}

struct CameraPreviewView: UIViewRepresentable {
    let monitor: FrontCameraMonitor
    func makeUIView(context: Context) -> CameraPreviewUIView { CameraPreviewUIView(monitor: monitor) }
    func updateUIView(_ uiView: CameraPreviewUIView, context: Context) {
        // nakładaj box wykryty przez Vision z normalnej przedniej kamery
        uiView.updateOverlay(rect: monitor.currentSignal.rect)
    }
}

final class CameraPreviewUIView: UIView {
    private let preview = AVCaptureVideoPreviewLayer()
    private let box = CAShapeLayer()
    init(monitor: FrontCameraMonitor) {
        super.init(frame: .zero)
        preview.session = monitor.session
        preview.videoGravity = .resizeAspectFill
        layer.addSublayer(preview)
        box.strokeColor = UIColor.systemRed.cgColor
        box.fillColor = UIColor.clear.cgColor
        box.lineWidth = 3
        box.isHidden = true
        layer.addSublayer(box)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() {
        super.layoutSubviews()
        preview.frame = bounds
    }
    /// Vision (normalized, y ↑) → warstwa podglądu
    func updateOverlay(rect: CGRect?) {
        guard let rect else { box.path = nil; box.isHidden = true; return }
        let tl = preview.layerPointConverted(fromCaptureDevicePoint: CGPoint(x: rect.minX, y: 1 - rect.maxY))
        let br = preview.layerPointConverted(fromCaptureDevicePoint: CGPoint(x: rect.maxX, y: 1 - rect.minY))
        let r = CGRect(x: min(tl.x, br.x), y: min(tl.y, br.y), width: abs(br.x - tl.x), height: abs(br.y - tl.y))
        box.path = CGPath(rect: r, transform: nil)
        box.isHidden = false
    }
}

struct UnlockCard: View {
    let challenge: BackendService.SessionChallenge
    var answered: Bool? = nil // nil = nie odpowiedziano, true/false = wynik
    var correctText: String? = nil
    var onSubmit: (Any)->Void
    @State private var text=""
    @State private var sel:Int?
    @State private var multi:Set<Int>=[]
    @State private var order: [Int] = []
    var isOpen: Bool { challenge.type == .openQuestion || challenge.type == .whyQuestion || challenge.type == .whoSaid }
    var isDisabled: Bool { answered != nil }
    private func moveOrder(from: Int, to: Int){
        guard from != to, from >= 0, to >= 0, from < order.count, to < order.count else { return }
        var o = order; o.insert(o.remove(at: from), at: to); _order.wrappedValue = o
    }
    var body: some View {
        VStack(alignment:.leading, spacing:8){
            if isOpen {
                TextField("Odpowiedz własnymi słowami…", text:$text, axis:.vertical).font(.system(size:14)).foregroundStyle(RPColor.ink).tint(RPColor.primary).lineLimit(2...4).padding(10).background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(RPColor.line)).disabled(isDisabled)
                Button("Wyślij"){ onSubmit(text) }.disabled(isDisabled || text.trimmingCharacters(in:.whitespaces).count<3).buttonStyle(BurgundyButtonStyle())
                if let ct = correctText, answered == false { Text("Poprawna: \(ct)").font(.caption.weight(.semibold)).foregroundStyle(RPColor.success) }
            } else if challenge.type == .multipleSelect {
                ForEach(Array((challenge.options ?? []).enumerated()), id:\.offset){ i, opt in
                    let on = multi.contains(i)
                    let isCorrect = (challenge.correctAnswers ?? []).contains(i)
                    Button{ if !isDisabled { if on { multi.remove(i)} else { multi.insert(i)} } } label:{
                        HStack{ Text(opt).font(.system(size:14)).foregroundStyle(RPColor.ink).multilineTextAlignment(.leading); Spacer(); Image(systemName: on ? "checkmark.square.fill":"square").foregroundStyle(isDisabled && isCorrect ? RPColor.success : (on ? RPColor.primary : RPColor.muted)) }
                        .padding(10).background(isDisabled && isCorrect ? Color.green.opacity(0.12) : (on ? RPColor.primaryLight : RPColor.card)).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(isDisabled && isCorrect ? RPColor.success : (on ? RPColor.primary : RPColor.line)))
                    }.buttonStyle(.plain).disabled(isDisabled)
                }
                Button("Zatwierdź"){ onSubmit(Array(multi)) }.disabled(isDisabled || multi.isEmpty).buttonStyle(BurgundyButtonStyle()).opacity(isDisabled || multi.isEmpty ? 0.5 : 1)
            } else if challenge.type == .findError {
                let stmts = challenge.statements ?? challenge.options ?? []
                ForEach(Array(stmts.enumerated()), id:\.offset){ i, st in
                    let isCorrect = challenge.errorIndex == i
                    Button{ if !isDisabled { sel=i } } label:{
                        HStack{ Text("\(i+1).").font(.caption.weight(.bold)).foregroundStyle(RPColor.muted); Text(st).font(.system(size:13)).foregroundStyle(RPColor.ink).multilineTextAlignment(.leading); Spacer(); Circle().stroke(sel==i ? RPColor.primary : (isDisabled && isCorrect ? RPColor.success : RPColor.line), lineWidth:2).frame(width:20,height:20).overlay(Circle().fill(sel==i ? RPColor.primary : (isDisabled && isCorrect ? RPColor.success : Color.clear)).frame(width:12,height:12)) }
                        .padding(10).background(isDisabled && isCorrect ? Color.green.opacity(0.12) : (sel==i ? RPColor.primaryLight : RPColor.card)).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(isDisabled && isCorrect ? RPColor.success : (sel==i ? RPColor.primary : RPColor.line)))
                    }.buttonStyle(.plain).disabled(isDisabled)
                }
                Button("Zatwierdź"){ if let s=sel{ onSubmit(s) } }.disabled(isDisabled || sel==nil).buttonStyle(BurgundyButtonStyle()).opacity(isDisabled || sel==nil ? 0.5 : 1)
            } else if challenge.type == .ordering || challenge.type == .ranking {
                let items = challenge.items ?? []
                VStack(alignment:.leading, spacing:8){
                    ForEach(Array(order.enumerated()), id:\.element){ idx, itemIdx in
                        HStack{
                            Text("\(idx+1).").font(.caption.weight(.bold)).foregroundStyle(RPColor.muted).frame(width:20)
                            Text(itemIdx < items.count ? items[itemIdx] : "").font(.system(size:13)).foregroundStyle(RPColor.ink)
                            Spacer()
                            if !isDisabled {
                                VStack(spacing:4){
                                    Button{ moveOrder(from: idx, to: idx-1) } label:{ Image(systemName:"chevron.up").font(.caption2) }.disabled(idx==0)
                                    Button{ moveOrder(from: idx, to: idx+1) } label:{ Image(systemName:"chevron.down").font(.caption2) }.disabled(idx==order.count-1)
                                }.tint(RPColor.primary)
                            }
                        }
                        .padding(8).background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:8)).overlay(RoundedRectangle(cornerRadius:8).stroke(RPColor.line))
                    }
                    if isDisabled, let ct = correctText { Text("Poprawna kolejność: \(ct)").font(.caption.weight(.semibold)).foregroundStyle(RPColor.success).padding(.top,4) }
                }
                .onAppear{ if order.isEmpty { order = Array(0..<items.count) } }
                Button("Zatwierdź kolejność"){ onSubmit(order) }.buttonStyle(BurgundyButtonStyle()).disabled(isDisabled)
            } else {
                let opts: [String] = {
                    if let o = challenge.options, !o.isEmpty { return o }
                    if let s = challenge.statements, !s.isEmpty { return s }
                    if challenge.type == .trueFalse { return ["Prawda","Fałsz"] }
                    return []
                }()
                ForEach(Array(opts.enumerated()), id:\.offset){ i, opt in
                    let isCorrect = challenge.correctAnswer == i
                    Button{ if !isDisabled { sel=i } } label:{
                        HStack{ Text(["A","B","C","D"][min(i,3)]).font(.caption.weight(.bold)).frame(width:28,height:28).background(sel==i ? RPColor.primary : (isDisabled && isCorrect ? RPColor.success : Color(hex:"#F3F4F6"))).foregroundStyle(sel==i || (isDisabled && isCorrect) ? .white : RPColor.muted).clipShape(Circle()); Text(opt).font(.system(size:14)).foregroundStyle(RPColor.ink).multilineTextAlignment(.leading); Spacer(); if isDisabled && isCorrect { Image(systemName:"checkmark.circle.fill").foregroundStyle(RPColor.success) } }
                        .padding(10).background(sel==i ? RPColor.primaryLight : (isDisabled && isCorrect ? Color.green.opacity(0.12) : RPColor.card)).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(isDisabled && isCorrect ? RPColor.success : (sel==i ? RPColor.primary : RPColor.line)))
                    }.buttonStyle(.plain).disabled(isDisabled)
                }
                Button("Zatwierdź"){ if let s=sel{ onSubmit(s) } }.disabled(isDisabled || sel==nil).buttonStyle(BurgundyButtonStyle()).opacity(isDisabled || sel==nil ? 0.5 : 1)
            }
        }
    }
}
