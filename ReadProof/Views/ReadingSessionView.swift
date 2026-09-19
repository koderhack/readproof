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
    @State private var showResult = false
    @State private var proof: ReadingProof?
    @State private var starting = true

    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(alignment:.leading, spacing:16){
                if starting {
                    ProgressView("Tworzę sesję — losuję 5 z 20 (live \(loc.current.rawValue))…")
                        .frame(maxWidth:.infinity).padding(20)
                } else {
                    header
                    if suspicious {
                        Label(loc.t("Sesja oznaczona jako podejrzana — screenshot/screen recording wykryty. Możesz spróbować ponownie.","Session flagged suspicious — screenshot detected. You can retry."), systemImage:"exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.white).padding(10).background(Color.red).clipShape(RoundedRectangle(cornerRadius:10))
                    }
                    ForEach(challenges, id:\.id){ ch in
                        let locked = isLocked(ch)
                        let done = completed.contains(ch.id)
                        VStack(alignment:.leading, spacing:10){
                            HStack{
                                Text(ch.type?.displayName ?? "Challenge").font(.caption.weight(.bold)).foregroundStyle(locked ? RPColor.muted2 : RPColor.primary)
                                Spacer()
                                if done { Image(systemName:"checkmark.circle.fill").foregroundStyle(RPColor.success) }
                                else if locked { Text(countdown(ch)).font(.caption.monospaced()).foregroundStyle(RPColor.muted) }
                                else { Text("ODKRYTE").font(.caption2.weight(.bold)).foregroundStyle(.white).padding(.horizontal,8).padding(.vertical,4).background(RPColor.success).clipShape(Capsule()) }
                            }
                            if locked {
                                HStack(spacing:8){ Image(systemName:"book.fill").foregroundStyle(RPColor.muted2); Text(ch.hint ?? loc.t("Czytaj dalej…","Keep reading…")).font(.subheadline).foregroundStyle(RPColor.muted) }
                                .padding(12).background(Color(hex:"#F9FAFB")).clipShape(RoundedRectangle(cornerRadius:12))
                                .textSelection(.disabled)
                            } else {
                                if let q = ch.question {
                                    Text(q).font(.headline).foregroundStyle(RPColor.ink).textSelection(.disabled)
                                    if let ctx = ch.context { Text(ctx).font(.caption).foregroundStyle(RPColor.muted).textSelection(.disabled) }
                                } else {
                                    // full challenge not yet fetched — fetch via getSession
                                    Text("Ładowanie…").foregroundStyle(RPColor.muted)
                                }
                                // answer UI — reuse Duo card for unlocked
                                if !done {
                                    UnlockCard(challengeId: ch.id, onSubmit: { ans in
                                        answers[ch.id]=ans
                                        Task { _ = await BackendService.shared.answerSession(sessionId: sessionId ?? "", challengeId: ch.id, answer: ans); completed.insert(ch.id); updateLive() }
                                    })
                                } else {
                                    Text(loc.t("Odpowiedź wysłana","Answer sent")).font(.caption).foregroundStyle(RPColor.success)
                                }
                            }
                        }.padding(14).background(Color.white).clipShape(RoundedRectangle(cornerRadius:14)).overlay(RoundedRectangle(cornerRadius:14).stroke(locked ? RPColor.line : RPColor.primary, lineWidth: locked ? 1 : 1.5))
                    }
                    if challenges.allSatisfy({ completed.contains($0.id) }) {
                        Button{
                            Task{ await complete() }
                        } label:{
                            Text("ZAKOŃCZ I ZWERYFIKUJ").font(.headline).frame(maxWidth:.infinity).padding(.vertical,14).background(RPColor.primary).foregroundStyle(.white).clipShape(RoundedRectangle(cornerRadius:12))
                        }
                    }
                }
                if let e = error { Text(e).foregroundStyle(.red).font(.caption) }
            }.padding(16)
        }
        .background(RPColor.bg)
        .navigationTitle("Proof of Comprehension")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(RPColor.bg, for:.navigationBar)
        .onReceive(timer){ _ in now = Date() }
        .onAppear{ Task{ await start() }; observeScreenshots() }
        .onDisappear{ stopLive() }
        .navigationDestination(isPresented:$showResult){ if let p=proof{ ResultMinimalView(book:book, chapter:chapter, results:[], proof:p)}}
    }

    var header: some View {
        VStack(alignment:.leading, spacing:6){
            Text(book.title).font(.headline).foregroundStyle(RPColor.ink)
            Text(chapter.title).font(.subheadline).foregroundStyle(RPColor.muted)
            HStack(spacing:8){
                Label("Sesja", systemImage:"timer").font(.caption2).foregroundStyle(RPColor.muted)
                Text("5 wyzwań • losowe 5 z 20 • fragment-dependent").font(.caption2).foregroundStyle(RPColor.muted)
                Spacer()
                Text("\(completed.count)/\(challenges.count)").font(.caption.weight(.bold)).foregroundStyle(RPColor.primary)
            }
            ProgressView(value: Double(completed.count), total: Double(max(challenges.count,1))).tint(RPColor.primary)
            Text("Nie pokazujemy 5 pytań od razu — odblokowują się co ~20-25s (demo) / 3-5min (real). Nie da się wkleić całości do ChatGPT.").font(.caption2).foregroundStyle(RPColor.muted)
        }.padding(14).background(Color.white).clipShape(RoundedRectangle(cornerRadius:14)).overlay(RoundedRectangle(cornerRadius:14).stroke(RPColor.line))
    }

    func isLocked(_ ch: BackendService.SessionChallenge) -> Bool {
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
            // Live Activity — zielony + Dynamic Island
            ReadingSessionActivityManager.shared.start(book: book, chapter: chapter, total: s.challenges.count)
            updateLive()
        } catch let e { error = e.localizedDescription; starting=false }
    }
    func updateLive(){
        let next = challenges.first{ isLocked($0) }.flatMap{ $0.releaseAt}.flatMap{ ISO8601DateFormatter().date(from:$0) }.map{ max(0, Int($0.timeIntervalSince(now)))} ?? 0
        ReadingSessionActivityManager.shared.update(completed: completed.count, total: challenges.count, nextUnlockIn: next, status: completed.count==challenges.count ? "verifying" : "reading")
    }
    func stopLive(){ ReadingSessionActivityManager.shared.end(status: proof?.status.rawValue ?? "ended") }
    func complete() async {
        guard let id=sessionId else { return }
        if let p = await BackendService.shared.completeSession(sessionId: id) {
            proof = p; showResult = true
            if let w = appState.wallet.address { appState.saveProof(p) }
            stopLive()
        } else { error="Nie udało się zakończyć — sprawdź Jev/TYPESAFE_API_KEY" }
    }
    func observeScreenshots(){
        NotificationCenter.default.addObserver(forName: UIApplication.userDidTakeScreenshotNotification, object:nil, queue:.main){ _ in
            suspicious=true
            if let id=sessionId{ Task{ await BackendService.shared.flagSession(sessionId:id, type:"screenshot") } }
        }
        NotificationCenter.default.addObserver(forName: UIScreen.capturedDidChangeNotification, object:nil, queue:.main){ _ in
            if UIScreen.main.isCaptured{
                suspicious=true
                if let id=sessionId{ Task{ await BackendService.shared.flagSession(sessionId:id, type:"screenRecording") } }
            }
        }
    }
}

struct UnlockCard: View {
    let challengeId: String
    var onSubmit: (Any)->Void
    @State private var text=""
    @State private var sel:Int?
    var body: some View {
        VStack(alignment:.leading, spacing:8){
            // Dla MVP: jeśli open_question to TextField, jeśli ABCD to 4 przyciski — uproszczone
            // Używamy heurystyki: jeśli challengeId zawiera open/why -> text
            if challengeId.lowercased().contains("open") || challengeId.contains("why") || challengeId.contains("c1-3") {
                TextField("Odpowiedz własnymi słowami…", text:$text, axis:.vertical).font(.system(size:14)).foregroundStyle(Color.black).tint(RPColor.primary).lineLimit(2...4).padding(10).background(Color.white).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(RPColor.line))
                Button("Wyślij"){
                    onSubmit(text)
                }.disabled(text.trimmingCharacters(in:.whitespaces).count<3).buttonStyle(BurgundyButtonStyle())
            } else {
                // ABCD fallback — 4 opcje mock
                ForEach(0..<4, id:\.self){ i in
                    Button{ sel=i } label:{
                        HStack{ Text(["A","B","C","D"][i]).font(.caption.weight(.bold)).frame(width:28,height:28).background(sel==i ? RPColor.primary : Color(hex:"#F3F4F6")).foregroundStyle(sel==i ? .white : RPColor.muted).clipShape(Circle()); Text("Opcja \(i+1)").foregroundStyle(Color.black); Spacer() }
                        .padding(10).background(sel==i ? RPColor.primaryLight : Color.white).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(sel==i ? RPColor.primary : RPColor.line))
                    }.buttonStyle(.plain)
                }
                Button("Zatwierdź"){ if let s=sel{ onSubmit(s) } }.disabled(sel==nil).buttonStyle(BurgundyButtonStyle()).opacity(sel==nil ? 0.5 : 1)
            }
        }
    }
}
