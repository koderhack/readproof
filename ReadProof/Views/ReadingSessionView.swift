import SwiftUI
import ActivityKit

struct ReadingSessionView: View {
    let book: Book
    let chapter: Chapter
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @Environment(\.dismiss) var dismiss
    @State private var sessionId: String?
    @State private var challenges: [BackendService.SessionChallenge] = []
    @State private var answers: [String: Any] = [:]
    @State private var completed: Set<String> = []
    @State private var now = Date()
    @State private var error: String?
    @State private var suspicious = false
    @State private var isPaused = false
    @State private var isCaptured = UIScreen.main.isCaptured
    @State private var showResult = false
    @State private var proof: ReadingProof?
    @State private var starting = true

    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if starting {
                    ProgressView("Tworzę sesję — losuję 5 z 30 (live \(loc.current.rawValue))…")
                        .frame(maxWidth: .infinity)
                        .padding(20)
                } else {
                    header
                    if isPaused {
                        Label("Sesja wstrzymana — licznik zatrzymany (weryfikowane przez backend).", systemImage:"pause.circle.fill").font(.caption).foregroundStyle(.white).padding(10).background(Color(hex:"#FF8B4D")).clipShape(RoundedRectangle(cornerRadius:10))
                    }
                    if suspicious {
                        Label(loc.t("Sesja oznaczona jako podejrzana — screenshot/screen recording wykryty. Możesz spróbować ponownie.","Session flagged suspicious — screenshot detected. You can retry."), systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.white).padding(10).background(Color.red).clipShape(RoundedRectangle(cornerRadius:10))
                    }
                    ForEach(challenges, id: \.id) { ch in
                        let locked = isLocked(ch)
                        let done = completed.contains(ch.id)
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text(ch.type?.displayName ?? "Challenge").font(.caption.weight(.bold)).foregroundStyle(locked ? RPColor.muted2 : RPColor.primary)
                                Spacer()
                                if done {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(RPColor.success)
                                } else if locked {
                                    Text(countdown(ch)).font(.caption.monospaced()).foregroundStyle(RPColor.muted)
                                } else {
                                    Text("ODKRYTE").font(.caption2.weight(.bold)).foregroundStyle(.white).padding(.horizontal,8).padding(.vertical,4).background(RPColor.success).clipShape(Capsule())
                                }
                            }
                            if locked {
                                HStack(spacing: 8) {
                                    Image(systemName: "book.fill").foregroundStyle(RPColor.muted2)
                                    Text(ch.hint ?? loc.t("Czytaj dalej…","Keep reading…")).font(.subheadline).foregroundStyle(RPColor.muted)
                                }
                                .padding(12).background(Color(hex:"#F9FAFB")).clipShape(RoundedRectangle(cornerRadius:12))
                                .textSelection(.disabled)
                            } else {
                                if let q = ch.question {
                                    Text(q).font(.headline).foregroundStyle(RPColor.ink).textSelection(.disabled)
                                    if let ctx = ch.context { Text(ctx).font(.caption).foregroundStyle(RPColor.muted).textSelection(.disabled) }
                                } else {
                                    Text("Ładowanie…").foregroundStyle(RPColor.muted)
                                }
                                if !done {
                                    UnlockCard(challenge: ch, onSubmit: { ans in
                                        answers[ch.id] = ans
                                        Task {
                                            _ = await BackendService.shared.answerSession(sessionId: sessionId ?? "", challengeId: ch.id, answer: ans)
                                            completed.insert(ch.id)
                                            updateLive()
                                        }
                                    })
                                } else {
                                    Text(loc.t("Odpowiedź wysłana","Answer sent")).font(.caption).foregroundStyle(RPColor.success)
                                }
                            }
                        }
                        .padding(14)
                        .background(RPColor.card)
                        .clipShape(RoundedRectangle(cornerRadius:14))
                        .overlay(RoundedRectangle(cornerRadius:14).stroke(locked ? RPColor.line : RPColor.primary, lineWidth: locked ? 1 : 1.5))
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
                                }
                                .clipShape(RoundedRectangle(cornerRadius:14))
                            }
                        }
                    }
                    if challenges.allSatisfy({ completed.contains($0.id) }) {
                        Button {
                            Task { await complete() }
                        } label: {
                            Text("ZAKOŃCZ I ZWERYFIKUJ").font(.headline).frame(maxWidth:.infinity).padding(.vertical,14).background(RPColor.primary).foregroundStyle(.white).clipShape(RoundedRectangle(cornerRadius:12))
                        }
                    }
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
        .onReceive(timer) { _ in now = Date() }
        .onAppear { Task { await start() }; observeScreenshots() }
        .onDisappear { stopLive() }
        .navigationDestination(isPresented: $showResult) { if let p=proof{ ResultMinimalView(book:book, chapter:chapter, results:[], proof:p)}}
    }

    var header: some View {
        VStack(alignment: .leading, spacing: 6){
            Text(book.title).font(.headline).foregroundStyle(RPColor.ink)
            Text(chapter.title).font(.subheadline).foregroundStyle(RPColor.muted)
            HStack(spacing:8){
                Label("Sesja", systemImage:"timer").font(.caption2).foregroundStyle(RPColor.muted)
                Text("5 wyzwań • losowe 5 z 30 • fragment-dependent").font(.caption2).foregroundStyle(RPColor.muted)
                Spacer()
                Text("\(completed.count)/\(challenges.count)").font(.caption.weight(.bold)).foregroundStyle(RPColor.primary)
            }
            ProgressView(value: Double(completed.count), total: Double(max(challenges.count,1))).tint(RPColor.primary)
            Text("Nie pokazujemy 5 pytań od razu — odblokowują się co ~20-25s (demo) / 3-5min (real). Nie da się wkleić całości do ChatGPT.").font(.caption2).foregroundStyle(RPColor.muted)
        }.padding(14).background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:14)).overlay(RoundedRectangle(cornerRadius:14).stroke(RPColor.line))
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
    func start() async {
        guard let wallet = appState.wallet.address, PhantomService.isValidSolanaAddress(wallet) else { error="Połącz Phantom Devnet"; starting=false; return }
        do{
            let s = try await BackendService.shared.startSession(bookId: book.id, chapterId: chapter.id, walletAddress: wallet)
            sessionId = s.id; challenges = s.challenges; starting=false
            ReadingSessionActivityManager.shared.start(book: book, chapter: chapter, total: s.challenges.count)
            updateLive()
        } catch let e { error = e.localizedDescription; starting=false }
    }
    func updateLive(){
        let next = challenges.first{ isLocked($0) }.flatMap{ $0.releaseAt}.flatMap{ ISO8601DateFormatter().date(from:$0) }.map{ max(0, Int($0.timeIntervalSince(now)))} ?? 0
        ReadingSessionActivityManager.shared.update(completed: completed.count, total: challenges.count, nextUnlockIn: next, status: completed.count==challenges.count ? "verifying" : "reading")
    }
    func stopLive(){ ReadingSessionActivityManager.shared.end(status: proof?.status.rawValue ?? "ended") }
    func completeWithWrong(failedId: String) async {
        guard let id=sessionId else { return }
        // oznacz jako błędną i zakończ natychmiast
        _ = try? await BackendService.shared.flagSession(sessionId: id, type: "wrong_answer")
        if let p = await BackendService.shared.completeSession(sessionId: id) {
            proof = p; showResult = true; stopLive()
        } else {
            // fallback lokalny proof failed
            let now2 = Date()
            let hash = SolanaService.shared.createProofHash(bookId: book.id, chapterId: chapter.id, wallet: appState.wallet.address ?? "no-wallet", timestamp: now2, score: completed.count)
            let pf = ReadingProof(id: UUID().uuidString, bookId: book.id, chapterId: chapter.id, challengeIds: challenges.map{$0.id}, score: completed.count, total: challenges.count, status: .failed, walletAddress: appState.wallet.address ?? "no-wallet", timestamp: now2, proofHash: hash, txSignature: nil, explorerUrl: nil, reward: nil)
            proof = pf; showResult = true; stopLive()
        }
    }
    func complete() async {
        guard let id=sessionId else { return }
        if let p = await BackendService.shared.completeSession(sessionId: id) {
            proof = p; showResult = true
            appState.saveProof(p)
            stopLive()
        } else { error="Nie udało się zakończyć — sprawdź Jev/TYPESAFE_API_KEY" }
    }
    func observeScreenshots(){
        isCaptured = UIScreen.main.isCaptured
        NotificationCenter.default.addObserver(forName: UIApplication.userDidTakeScreenshotNotification, object:nil, queue:.main){ _ in
            suspicious=true
            if let id=sessionId{ Task{ await BackendService.shared.flagSession(sessionId:id, type:"screenshot") } }
        }
        NotificationCenter.default.addObserver(forName: UIScreen.capturedDidChangeNotification, object:nil, queue:.main){ _ in
            let captured = UIScreen.main.isCaptured
            isCaptured = captured
            if captured{
                suspicious=true
                if let id=sessionId{ Task{ await BackendService.shared.flagSession(sessionId:id, type:"screenRecording") } }
            }
        }
    }
}

struct UnlockCard: View {
    let challenge: BackendService.SessionChallenge
    var onSubmit: (Any)->Void
    @State private var text=""
    @State private var sel:Int?
    @State private var multi:Set<Int>=[]
    var isOpen: Bool { challenge.type == .openQuestion || challenge.type == .whyQuestion }
    var body: some View {
        VStack(alignment:.leading, spacing:8){
            if isOpen {
                TextField("Odpowiedz własnymi słowami…", text:$text, axis:.vertical).font(.system(size:14)).foregroundStyle(RPColor.ink).tint(RPColor.primary).lineLimit(2...4).padding(10).background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(RPColor.line))
                Button("Wyślij"){ onSubmit(text) }.disabled(text.trimmingCharacters(in:.whitespaces).count<3).buttonStyle(BurgundyButtonStyle())
            } else if challenge.type == .multipleSelect {
                ForEach(Array((challenge.options ?? []).enumerated()), id:\.offset){ i, opt in
                    let on = multi.contains(i)
                    Button{ if on { multi.remove(i)} else { multi.insert(i)} } label:{
                        HStack{ Text(opt).font(.system(size:14)).foregroundStyle(RPColor.ink).multilineTextAlignment(.leading); Spacer(); Image(systemName: on ? "checkmark.square.fill":"square").foregroundStyle(on ? RPColor.primary : RPColor.muted) }
                        .padding(10).background(on ? RPColor.primaryLight : RPColor.card).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(on ? RPColor.primary : RPColor.line))
                    }.buttonStyle(.plain)
                }
                Button("Zatwierdź"){ onSubmit(Array(multi)) }.disabled(multi.isEmpty).buttonStyle(BurgundyButtonStyle()).opacity(multi.isEmpty ? 0.5 : 1)
            } else if challenge.type == .findError {
                let stmts = challenge.statements ?? challenge.options ?? []
                ForEach(Array(stmts.enumerated()), id:\.offset){ i, st in
                    Button{ sel=i } label:{
                        HStack{ Text("\(i+1).").font(.caption.weight(.bold)).foregroundStyle(RPColor.muted); Text(st).font(.system(size:13)).foregroundStyle(RPColor.ink).multilineTextAlignment(.leading); Spacer(); Circle().stroke(sel==i ? RPColor.primary : RPColor.line, lineWidth:2).frame(width:20,height:20).overlay(Circle().fill(sel==i ? RPColor.primary : Color.clear).frame(width:12,height:12)) }
                        .padding(10).background(sel==i ? RPColor.primaryLight : RPColor.card).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(sel==i ? RPColor.primary : RPColor.line))
                    }.buttonStyle(.plain)
                }
                Button("Zatwierdź"){ if let s=sel{ onSubmit(s) } }.disabled(sel==nil).buttonStyle(BurgundyButtonStyle()).opacity(sel==nil ? 0.5 : 1)
            } else if challenge.type == .ordering || challenge.type == .ranking {
                Text("Przeciągnij aby zmienić kolejność — w pełnej sesji").font(.caption).foregroundStyle(RPColor.muted)
                Button("Zatwierdź kolejność"){ onSubmit([0,1,2,3]) }.buttonStyle(BurgundyButtonStyle())
            } else {
                let opts: [String] = {
                    if let o = challenge.options, !o.isEmpty { return o }
                    if let s = challenge.statements, !s.isEmpty { return s }
                    if challenge.type == .trueFalse { return ["Prawda","Fałsz"] }
                    return []
                }()
                ForEach(Array(opts.enumerated()), id:\.offset){ i, opt in
                    Button{ sel=i } label:{
                        HStack{ Text(["A","B","C","D"][min(i,3)]).font(.caption.weight(.bold)).frame(width:28,height:28).background(sel==i ? RPColor.primary : Color(hex:"#F3F4F6")).foregroundStyle(sel==i ? .white : RPColor.muted).clipShape(Circle()); Text(opt).font(.system(size:14)).foregroundStyle(RPColor.ink).multilineTextAlignment(.leading); Spacer() }
                        .padding(10).background(sel==i ? RPColor.primaryLight : RPColor.card).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(sel==i ? RPColor.primary : RPColor.line))
                    }.buttonStyle(.plain)
                }
                Button("Zatwierdź"){ if let s=sel{ onSubmit(s) } }.disabled(sel==nil).buttonStyle(BurgundyButtonStyle()).opacity(sel==nil ? 0.5 : 1)
            }
        }
    }
}
