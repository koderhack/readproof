import SwiftUI

struct ResultMinimalView: View {
    let book: Book; let chapter: Chapter; let results:[ChallengeResult]; let proof: ReadingProof
    @Environment(\.dismiss) var dismiss
    var isVerified: Bool { proof.status == .verified || proof.status == .comprehensionVerified }
    var body: some View {
        ScrollView{
            VStack(spacing:16){
                header
                rewardCard
                attestation
                actions
            }.padding(16)
        }.background(RPColor.bg)
        .navigationTitle("Szczegóły Weryfikacji")
        .navigationBarTitleDisplayMode(.inline)
    }
    var header: some View {
        VStack(spacing:8){
            Text("Dowód Zrozumienia\nZatwierdzony").font(.system(size:24, weight:.bold, design:.rounded)).multilineTextAlignment(.center)
            Text("Twój test lektury został zweryfikowany kryptograficznie w sieci Base zk-Rollup.").font(.system(size:13)).foregroundStyle(RPColor.muted).multilineTextAlignment(.center)
        }.padding(.vertical,8)
    }
    var rewardCard: some View {
        VStack(alignment:.leading, spacing:12){
            HStack{ Label("NAGRODA PROTOKOLARNA", systemImage:"checkmark.seal.fill").font(.system(size:11, weight:.bold, design:.rounded)).tracking(0.6).foregroundStyle(RPColor.primary); Spacer(); ZStack{ Circle().fill(RPColor.primaryLight).frame(width:36,height:36); Image(systemName:"wallet.pass.fill").foregroundStyle(RPColor.primary)}}
            HStack(alignment:.firstTextBaseline, spacing:6){ Text("+\(proof.reward ?? "$15.00")").font(.system(size:28, weight:.bold, design:.rounded)); Text("USDC").font(.system(size:14, weight:.medium)).foregroundStyle(RPColor.muted) }
            HStack(spacing:8){
                HStack(spacing:6){ Circle().fill(RPColor.primary).frame(width:8,height:8); Text("Dostępna do natychmiastowej wypłaty").font(.system(size:12)).foregroundStyle(RPColor.ink)}
                Spacer()
                Text("Zero prowizji").font(.system(size:11)).foregroundStyle(RPColor.muted).padding(.horizontal,8).padding(.vertical,6).background(Color.white).clipShape(RoundedRectangle(cornerRadius:8)).overlay(RoundedRectangle(cornerRadius:8).stroke(RPColor.line))
            }.padding(10).background(Color(hex:"#F9FAFB")).clipShape(RoundedRectangle(cornerRadius:12))
            if let url=proof.explorerUrl, let u=URL(string:url){ Link(destination:u){ Label("Zobacz w Explorer (Devnet)", systemImage:"link").font(.system(size:12, weight:.semibold)) }.tint(RPColor.primary)}
        }.padding(16).card()
    }
    var attestation: some View {
        VStack(alignment:.leading, spacing:12){
            HStack{ Text("ATESTATACJA ZK-SNARK").font(.system(size:11, weight:.bold, design:.rounded)).tracking(0.6).foregroundStyle(RPColor.muted); Spacer(); Text(isVerified ? "Zweryfikowano" : "Nie powiodło się").font(.system(size:13, weight:.semibold)).foregroundStyle(isVerified ? RPColor.primary : RPColor.muted)}
            row(icon:"books.vertical", title:"Publikacja", value: book.title, sub: book.author)
            Divider().opacity(0.5)
            row(icon:"checkmark.shield", title:"Wynik egzaminu", value:"\(proof.score)/\(proof.total) \(isVerified ? "100% poprawnych" : "spróbuj ponownie")", sub: "\(proof.status.rawValue)")
            Divider().opacity(0.5)
            rowCopy(icon:"number", title:"Skrót dowodu (ZK Hash)", value: String(proof.proofHash.prefix(10))+"…\(proof.proofHash.suffix(4))")
            Divider().opacity(0.5)
            row(icon:"chart.line.uptrend.xyaxis", title:"Percentyl zrozumienia", value: isVerified ? "Światowa czołówka" : "Poniżej progu", sub: isVerified ? "98. percentyl" : "\(proof.score)/\(proof.total)")
            if let s=proof.txSignature{
                Divider().opacity(0.5)
                row(icon:"link", title:"Tx Signature", value: String(s.prefix(12))+"…", sub: "Solana Devnet")
            }
            Divider().opacity(0.5)
            HStack{ HStack(spacing:12){ SoftIcon(system:"banknote"); VStack(alignment:.leading){ Text("Opłata sieciowa zk-Rollup").font(.system(size:11)).foregroundStyle(RPColor.muted); Text("Sponsorowana przez ReadProof").font(.system(size:13, weight:.medium))}} ; Spacer(); Text("0.00 zł").font(.system(size:16, weight:.semibold)).foregroundStyle(RPColor.primary)}
        }.padding(16).card()
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
            Button{ if let url=proof.explorerUrl, let u=URL(string:url){ UIApplication.shared.open(u)}} label:{ HStack{ Image(systemName:"wallet.pass"); Text("Wypłać \(proof.reward ?? "$15.00") do Portfela").font(.system(size:15, weight:.semibold, design:.rounded))}.frame(maxWidth:.infinity).padding(.vertical,14).background(RPColor.ink).foregroundStyle(.white).clipShape(RoundedRectangle(cornerRadius:14))}
            HStack(spacing:10){
                Button{} label:{ HStack{ Image(systemName:"square.and.arrow.up"); Text("Udostępnij").font(.system(size:13, weight:.medium))}.frame(maxWidth:.infinity).padding(.vertical,12).background(Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(RPColor.line))}.tint(RPColor.ink)
                Button{} label:{ HStack{ Image(systemName:"doc.text"); Text("Certyfikat ZK").font(.system(size:13, weight:.medium))}.frame(maxWidth:.infinity).padding(.vertical,12).background(Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(RPColor.line))}.tint(RPColor.ink)
            }
            Label("Poufność tożsamości chroniona dowodami Zero-Knowledge", systemImage:"lock").font(.system(size:11)).foregroundStyle(RPColor.muted)
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
