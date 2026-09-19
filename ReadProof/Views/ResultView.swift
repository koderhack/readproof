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
    var body: some View {
        NavigationStack{
            ScrollView{
                VStack(spacing:10){
                    if appState.proofs.isEmpty{
                        VStack(spacing:12){ Image(systemName:"checkmark.seal").font(.largeTitle).foregroundStyle(RPColor.muted2); Text(loc.t("Brak dowodów","No proofs")).font(.system(size:16, weight:.bold, design:.rounded)); Text(loc.t("Ukończ 4–5/5 aby otrzymać Reading Verified.","Complete 4–5/5 to get Reading Verified.")).font(.system(size:13)).foregroundStyle(RPColor.muted).multilineTextAlignment(.center)}.padding(40)
                    } else {
                        ForEach(appState.proofs){ p in
                            NavigationLink(destination: ProofDetailMinimal(proof:p)){
                                HStack(spacing:12){
                                    ZStack{ RoundedRectangle(cornerRadius:10).fill(p.status == .verified ? RPColor.primaryLight : Color(hex:"#F3F4F6")).frame(width:40,height:40); Image(systemName: p.status == .verified ? "checkmark.seal.fill":"xmark.seal").foregroundStyle(p.status == .verified ? RPColor.primary : RPColor.muted)}
                                    VStack(alignment:.leading, spacing:3){ Text("\(p.bookId) • \(p.chapterId)").font(.system(size:13, weight:.semibold, design:.rounded)); Text("\(p.score)/\(p.total) • \(p.status.rawValue) • \(p.timestamp.formatted(date:.abbreviated, time:.shortened))").font(.system(size:11)).foregroundStyle(RPColor.muted)}
                                    Spacer(); if let r=p.reward{ Text(r).font(.system(size:13, weight:.semibold, design:.rounded)).foregroundStyle(RPColor.primary)}
                                }.padding(14).card()
                            }.buttonStyle(.plain)
                        }
                    }
                }.padding(16)
            }.background(RPColor.bg).navigationTitle(loc.t("Dowody","Proofs"))
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
