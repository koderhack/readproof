import SwiftUI

struct ResultMinimalView: View {
    let book: Book; let chapter: Chapter; let results:[ChallengeResult]; let proof: ReadingProof
    @Environment(\.dismiss) var dismiss
    @State private var now = Date()
    @State private var sealAppeared = false
    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    var isVerified: Bool { proof.status == .verified || proof.status == .comprehensionVerified }
    var isFailed: Bool { proof.status == .failed }
    var blockedUntil: Date { proof.timestamp.addingTimeInterval(0) } // bez blokady — od razu ponawianie
    var body: some View {
        ScrollView{
            VStack(spacing:16){
                header
                if isFailed { cooldownCard } else { rewardCard }
                attestation
                actions
            }.padding(16)
        }.background(RPColor.bg)
        .navigationTitle("Szczegóły Weryfikacji")
        .navigationBarTitleDisplayMode(.inline)
        .onReceive(timer) { _ in now = Date() }
        .onAppear {
            if isVerified {
                withAnimation(.spring(response: 0.45, dampingFraction: 0.55)) { sealAppeared = true }
            }
        }
    }
    var header: some View {
        VStack(spacing:8){
            if isVerified {
                ZStack {
                    Circle()
                        .stroke(RPColor.primary.opacity(0.35), lineWidth: 4)
                        .frame(width: 110, height: 110)
                        .scaleEffect(sealAppeared ? 1 : 0.4)
                        .opacity(sealAppeared ? 1 : 0)
                    VStack(spacing: 2) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 36))
                            .foregroundStyle(RPColor.primary)
                        Text("VERIFIED")
                            .font(.system(size: 12, weight: .black, design: .rounded))
                            .tracking(1.2)
                            .foregroundStyle(RPColor.primary)
                        Text(String(proof.proofHash.prefix(8)).uppercased())
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundStyle(RPColor.muted)
                    }
                    .scaleEffect(sealAppeared ? 1 : 0.2)
                    .opacity(sealAppeared ? 1 : 0)
                }
                .padding(.bottom, 4)
                Text("Dowód Zrozumienia\nZatwierdzony").font(.system(size:24, weight:.bold, design:.rounded)).foregroundStyle(RPColor.ink).multilineTextAlignment(.center)
                Text(proof.txSignature == nil
                    ? "Sesja zweryfikowana. proofHash zapisany w backendzie (demo/mock payout — brak live transferu USDC, dopóki nie ma tx na Devnecie). Treść i odpowiedzi nie trafiają on-chain."
                    : "Verification Engine zweryfikował sesję; proofHash + tx na Solana Devnet (niezmienny dowód, treść i odpowiedzi nie trafiają on-chain)."
                ).font(.system(size:13)).foregroundStyle(RPColor.muted).multilineTextAlignment(.center)
            } else {
                Image(systemName: isFailed ? "xmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.system(size: 44)).foregroundStyle(isFailed ? Color.red : RPColor.primary)
                Text(isFailed ? "Dowód Zrozumienia\nNIE ZATWIERDZONY" : "Sesja wymaga poprawy").font(.system(size:24, weight:.bold, design:.rounded)).foregroundStyle(RPColor.ink).multilineTextAlignment(.center)
                if isFailed {
                    Text("Błędna odpowiedź lub podejrzana czynność (screenshot/kamera). Sesja oznaczona jako Failed — nagroda nie przysługuje.").font(.system(size:13)).foregroundStyle(RPColor.muted).multilineTextAlignment(.center)
                }
            }
        }.padding(.vertical,8)
    }
    var cooldownCard: some View {
        return VStack(alignment:.leading, spacing:10){
            HStack{ Label("SESJA ZAKOŃCZONA", systemImage:"xmark.circle.fill").font(.system(size:11, weight:.bold, design:.rounded)).tracking(0.6).foregroundStyle(Color.red); Spacer() }
            HStack(spacing:8){
                Image(systemName:"arrow.counterclockwise").font(.system(size:22)).foregroundStyle(Color.red)
                VStack(alignment:.leading, spacing:2){
                    Text("Błędna odpowiedź lub screenshot — możesz spróbować ponownie od razu").font(.system(size:13, weight:.semibold)).foregroundStyle(RPColor.ink)
                    Text("Bez blokady czasowej — 5 min na każde pytanie").font(.system(size:12)).foregroundStyle(RPColor.muted)
                }
                Spacer()
            }
            Text("Bez zgadywania — pytania wymagają przeczytania, ale bez kary czasowej.").font(.system(size:11)).foregroundStyle(RPColor.muted)
        }.padding(16).background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:16)).overlay(RoundedRectangle(cornerRadius:16).stroke(Color.red.opacity(0.5)))
    }
    var rewardCard: some View {
        VStack(alignment:.leading, spacing:12){
            HStack{ Label("NAGRODA PROTOKOLARNA", systemImage:"checkmark.seal.fill").font(.system(size:11, weight:.bold, design:.rounded)).tracking(0.6).foregroundStyle(RPColor.primary); Spacer(); ZStack{ Circle().fill(RPColor.primaryLight).frame(width:36,height:36); Image(systemName:"wallet.pass.fill").foregroundStyle(RPColor.primary)}}
            HStack(alignment:.firstTextBaseline, spacing:6){ Text("+\(proof.reward ?? "5 USDC")").font(.system(size:28, weight:.bold, design:.rounded)); Text(proof.txSignature == nil ? "(demo)" : "USDC").font(.system(size:14, weight:.medium)).foregroundStyle(RPColor.muted) }
            HStack(spacing:8){
                HStack(spacing:6){
                    Circle().fill(proof.txSignature == nil ? Color.orange : RPColor.primary).frame(width:8,height:8)
                    Text(proof.txSignature == nil ? "Mock / demo — bez live transferu na Devnecie" : "Wysłane na Solana Devnet").font(.system(size:12)).foregroundStyle(RPColor.ink)
                }
                Spacer()
                Text(proof.txSignature == nil ? "proofHash OK" : "Zero prowizji").font(.system(size:11)).foregroundStyle(RPColor.muted).padding(.horizontal,8).padding(.vertical,6).background(Color.white).clipShape(RoundedRectangle(cornerRadius:8)).overlay(RoundedRectangle(cornerRadius:8).stroke(RPColor.line))
            }.padding(10).background(Color(hex:"#F9FAFB")).clipShape(RoundedRectangle(cornerRadius:12))
            if let url=proof.explorerUrl, let u=URL(string:url){ Link(destination:u){ Label("Zobacz w Explorer (Devnet)", systemImage:"link").font(.system(size:12, weight:.semibold)) }.tint(RPColor.primary)}
            else if isVerified {
                Text("Brak txSignature — payout mockowy (ustaw SOLANA_PAYER_PRIVATE_KEY na backendzie, żeby odpalić real Devnet USDC).").font(.system(size:11)).foregroundStyle(RPColor.muted)
            }
        }.padding(16).card()
    }
    var attestation: some View {
        VStack(alignment:.leading, spacing:12){
            HStack{ Text("DOWÓD READING PROOF (SOLANA)").font(.system(size:11, weight:.bold, design:.rounded)).tracking(0.6).foregroundStyle(RPColor.muted); Spacer(); Text(isVerified ? "Zweryfikowano" : "Nie powiodło się").font(.system(size:13, weight:.semibold)).foregroundStyle(isVerified ? RPColor.primary : RPColor.muted)}
            row(icon:"books.vertical", title:"Publikacja", value: book.title, sub: book.author)
            Divider().opacity(0.5)
            row(icon:"checkmark.shield", title:"Wynik egzaminu", value:"\(proof.score)/\(proof.total) \(isVerified ? "100% poprawnych" : "spróbuj ponownie")", sub: "\(proof.status.rawValue)")
            Divider().opacity(0.5)
            rowCopy(icon:"number", title:"Skrót dowodu (proofHash)", value: String(proof.proofHash.prefix(10))+"…\(proof.proofHash.suffix(4))")
            Divider().opacity(0.5)
            row(icon:"chart.line.uptrend.xyaxis", title:"Czas trwania sesji", value: duration(proof.durationSec ?? 0), sub: proof.durationSec == nil ? "Solana Devnet" : "licznik zatrzymany przy screenshot")
            Divider().opacity(0.5)
            row(icon:"checkmark.shield.fill", title:"Wersja reguł (Verification Engine)", value: proof.verificationVersion ?? "readproof-v1", sub: "proof = hash(wallet+book+chapter+session+results+ts)")
            if let s=proof.txSignature{
                Divider().opacity(0.5)
                row(icon:"link", title:"Tx Signature", value: String(s.prefix(12))+"…", sub: "Solana Devnet")
            }
            Divider().opacity(0.5)
            HStack{ HStack(spacing:12){ SoftIcon(system:"banknote"); VStack(alignment:.leading){ Text("Opłata sieciowa Solana Devnet").font(.system(size:11)).foregroundStyle(RPColor.muted); Text("Sponsorowana przez ReadProof").font(.system(size:13, weight:.medium))}} ; Spacer(); Text("0.00").font(.system(size:16, weight:.semibold)).foregroundStyle(RPColor.primary)}
        }.padding(16).card()
    }
    func duration(_ sec: Int) -> String {
        let m = sec / 60, s = sec % 60
        return String(format: "%d:%02d min", m, s)
    }
    func row(icon:String, title:String, value:String, sub:String?=nil) -> some View {
        HStack(alignment:.top, spacing:12){
            SoftIcon(system:icon)
            VStack(alignment:.leading, spacing:2){ Text(title).font(.system(size:11)).foregroundStyle(RPColor.muted); Text(value).font(.system(size:15, weight:.medium, design:.rounded)).foregroundStyle(RPColor.ink); if let s=sub{ Text(s).font(.system(size:12)).foregroundStyle(RPColor.muted)}}
            Spacer()
        }
    }
    func rowCopy(icon:String, title:String, value:String) -> some View {
        HStack{
            SoftIcon(system:icon)
            VStack(alignment:.leading){ Text(title).font(.system(size:11)).foregroundStyle(RPColor.muted); Text(value).font(.system(size:13, weight:.medium, design:.rounded))}
            Spacer()
            Button{ UIPasteboard.general.string=value } label:{ HStack(spacing:4){ Image(systemName:"doc.on.doc"); Text("Kopiuj").font(.system(size:12, weight:.medium))}.padding(.horizontal,10).padding(.vertical,6).background(Color(hex:"#F3F4F6")).clipShape(RoundedRectangle(cornerRadius:8))}.tint(RPColor.ink)
        }
    }
    var actions: some View {
        VStack(spacing:10){
            if isFailed {
                Button{ dismiss() } label:{ HStack{ Image(systemName:"arrow.left"); Text("Wróć do książki — spróbuj od razu").font(.system(size:15, weight:.semibold, design:.rounded))}.frame(maxWidth:.infinity).padding(.vertical,14).foregroundStyle(.white).background(RPColor.inkFixed).clipShape(RoundedRectangle(cornerRadius:14))}
                Text("Możesz spróbować ponownie od razu — bez blokady.").font(.system(size:11)).foregroundStyle(RPColor.muted)
            } else {
                Button{ if let url=proof.explorerUrl, let u=URL(string:url){ UIApplication.shared.open(u)}} label:{ HStack{ Image(systemName: proof.txSignature == nil ? "checkmark.seal" : "wallet.pass"); Text(proof.txSignature == nil ? "Dowód gotowy (demo — bez live USDC)" : "Wypłać \(proof.reward ?? "5 USDC") do Portfela").font(.system(size:15, weight:.semibold, design:.rounded))}.frame(maxWidth:.infinity).padding(.vertical,14).background(RPColor.inkFixed).foregroundStyle(.white).clipShape(RoundedRectangle(cornerRadius:14))}
                HStack(spacing:10){
                    Button{} label:{ HStack{ Image(systemName:"square.and.arrow.up"); Text("Udostępnij").font(.system(size:13, weight:.medium))}.frame(maxWidth:.infinity).padding(.vertical,12).background(Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(RPColor.line))}.tint(RPColor.ink)
                    Button{} label:{ HStack{ Image(systemName:"doc.text"); Text("Dowód").font(.system(size:13, weight:.medium))}.frame(maxWidth:.infinity).padding(.vertical,12).background(Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(RPColor.line))}.tint(RPColor.ink)
                }
                Label("Zapisano w Solana Devnet: wallet, book, chapter, session, score, duration, verificationVersion, proofHash, timestamp", systemImage:"lock").font(.system(size:11)).foregroundStyle(RPColor.muted)
            }
        }
    }
}

// compat wrapper used by navigation
typealias ResultCollegiumView = ResultMinimalView
struct ProofsListView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @State private var serverProofs: [ReadingProof] = []
    var all: [ReadingProof] { (serverProofs.isEmpty ? appState.proofs : serverProofs).sorted{ $0.timestamp > $1.timestamp } }
    var body: some View {
        NavigationStack{
            List{
                if all.isEmpty {
                    ContentUnavailableView(loc.t("Brak dowodów","No proofs"), systemImage:"checkmark.seal", description: Text(loc.t("Ukończ 4–5/5 aby otrzymać Reading Verified. Dane z serwera.","Complete 4–5/5 to get Reading Verified. Data from server.")))
                } else {
                    ForEach(all){ p in
                        NavigationLink(destination: ProofDetailMinimal(proof:p)){
                            HStack(spacing:12){
                                Image(systemName: p.status == .verified ? "checkmark.seal.fill":"xmark.seal").foregroundStyle(p.status == .verified ? RPColor.primary : RPColor.muted)
                                VStack(alignment:.leading, spacing:2){
                                    Text("\(p.bookId) • \(p.chapterId)").font(.subheadline.weight(.semibold)).foregroundStyle(RPColor.ink)
                                    Text("\(p.score)/\(p.total) • \(p.status.rawValue) • \(p.timestamp.formatted(date:.abbreviated, time:.shortened))").font(.caption).foregroundStyle(RPColor.muted)
                                }
                                Spacer()
                                if let r=p.reward{ Text(r).font(.caption.weight(.semibold)).foregroundStyle(RPColor.primary) }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Dowody","Proofs"))
            .refreshable { await load() }
            .task { await load() }
        }
    }
    func load() async {
        if let w = appState.wallet.address, let proofs = await BackendService.shared.fetchProofs(wallet: w) {
            serverProofs = proofs
        } else if let proofs = await BackendService.shared.fetchProofs() {
            serverProofs = proofs
        }
    }
}
struct ProofDetailMinimal: View {
    let proof:ReadingProof
    var body: some View{
        List{
            Section("Proof"){ Labeled("ID", proof.id); Labeled("Hash", proof.proofHash); Labeled("Score", "\(proof.score)/\(proof.total) • \(proof.status.rawValue)") }
            if let s=proof.txSignature{ Section("Solana Devnet"){ Labeled("Signature", s); if let url=proof.explorerUrl, let u=URL(string:url){ Link("Explorer", destination:u)} } }
        }.navigationTitle("Proof")
    }
    func Labeled(_ k:String,_ v:String)->some View{ HStack{ Text(k).foregroundStyle(.secondary); Spacer(); Text(v).lineLimit(1).truncationMode(.middle)} }
}
