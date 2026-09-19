import SwiftUI

struct PassportView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @State private var input=""
    @State private var showCopied=false

    var body: some View {
        NavigationStack{
            ScrollView{
                VStack(spacing:14){
                    profile
                    funds
                    statsPair
                    performance
                    history
                    languagePicker
                    backendCard
                }.padding(16)
            }.background(RPColor.bg)
            .navigationTitle("Profil")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar{ ToolbarItem(placement:.principal){ HStack(spacing:8){ ZStack{ RoundedRectangle(cornerRadius:8).fill(RPColor.primary).frame(width:28,height:28); Image(systemName:"books.vertical.fill").foregroundStyle(.white).font(.system(size:12))}; Text("ReadProof").font(.system(size:16, weight:.bold, design:.rounded))} } }
        }
    }

    var profile: some View {
        HStack(spacing:12){
            ZStack(alignment:.bottomTrailing){
                Circle().fill(Color(hex:"#E5E7EB")).frame(width:56,height:56).overlay(Image(systemName:"person.fill").foregroundStyle(RPColor.muted))
                Circle().fill(RPColor.primary).frame(width:18,height:18).overlay(Image(systemName:"checkmark").font(.system(size:10, weight:.bold)).foregroundStyle(.white)).offset(x:2,y:2)
            }
            VStack(alignment:.leading, spacing:3){
                Text(appState.wallet.address ?? "Elena Rostova").font(.system(size:16, weight:.bold, design:.rounded)).lineLimit(1)
                Text("@\(appState.wallet.address?.prefix(8) ?? "elena_reads")").font(.system(size:13)).foregroundStyle(RPColor.muted)
                HStack(spacing:6){
                    MonoPill(text: loc.t("Top 5% Czytelników","Top 5% Readers"), fg:RPColor.primary, bg:RPColor.primaryLight, border:.clear)
                    HStack(spacing:4){ Circle().fill(RPColor.primary).frame(width:6,height:6); Text(loc.t("On-Chain aktywna","On-Chain active")).font(.system(size:11, weight:.semibold)).foregroundStyle(RPColor.ink)}.padding(.horizontal,8).padding(.vertical,4).background(Color.white).clipShape(Capsule()).overlay(Capsule().stroke(RPColor.line))
                }
            }
            Spacer()
        }.padding(14).card()
    }

    var funds: some View {
        VStack(alignment:.leading, spacing:12){
            HStack{ Text("Dostępne środki").font(.system(size:12)).foregroundStyle(.white.opacity(0.85)); Spacer(); Button{} label:{ Image(systemName:"wallet.pass").foregroundStyle(.white).padding(8).background(Color.white.opacity(0.15)).clipShape(Circle())}}
            Text("$135.00").font(.system(size:28, weight:.bold, design:.rounded)).foregroundStyle(.white) + Text(" USDC").font(.system(size:16, weight:.medium)).foregroundStyle(.white.opacity(0.85))
            HStack(spacing:10){
                Button{} label:{ HStack{ Image(systemName:"paperplane"); Text("Przelej").font(.system(size:13, weight:.semibold, design:.rounded))}.frame(maxWidth:.infinity).padding(.vertical,10).background(Color.white).foregroundStyle(RPColor.ink).clipShape(RoundedRectangle(cornerRadius:12))}.buttonStyle(.plain)
                Button{} label:{HStack{ Image(systemName:"arrow.down"); Text("Wypłać").font(.system(size:13, weight:.semibold, design:.rounded))}.frame(maxWidth:.infinity).padding(.vertical,10).background(Color.white.opacity(0.18)).foregroundStyle(.white).clipShape(RoundedRectangle(cornerRadius:12))}.buttonStyle(.plain)
            }
            if !appState.wallet.isConnected {
                HStack{ TextField("Solana address", text:$input).font(.system(size:12, design:.monospaced)).padding(10).background(Color.white).clipShape(RoundedRectangle(cornerRadius:10)); Button("Połącz"){ appState.connectWallet(address:input); input=""}.buttonStyle(BurgundyButtonStyle()) }
            } else {
                HStack{ Text(appState.wallet.address ?? "").font(.system(size:10, design:.monospaced)).foregroundStyle(.white.opacity(0.85)).lineLimit(1).truncationMode(.middle); Spacer(); Button(showCopied ? "OK" : "Kopiuj"){ UIPasteboard.general.string=appState.wallet.address; showCopied=true; DispatchQueue.main.asyncAfter(deadline:.now()+1.5){showCopied=false}}.font(.system(size:11, weight:.semibold)).tint(.white); Button("Rozłącz", role:.destructive){ appState.disconnect()}.font(.system(size:11)).tint(.white) }
            }
        }.padding(16).background(RPColor.ink).clipShape(RoundedRectangle(cornerRadius:16))
    }

    var statsPair: some View {
        HStack(spacing:12){
            VStack(alignment:.leading, spacing:10){
                HStack{ Text("Seria czytania").font(.system(size:12)).foregroundStyle(RPColor.muted); Spacer(); ZStack{ Circle().fill(Color(hex:"#FEF3C7")).frame(width:24,height:24); Image(systemName:"flame.fill").foregroundStyle(RPColor.primary).font(.system(size:12))}}
                HStack(alignment:.firstTextBaseline, spacing:4){ Text("18").font(.system(size:26, weight:.bold, design:.rounded)); Text("Dni").font(.system(size:13)).foregroundStyle(RPColor.muted)}
                Label("+3 dni od zeszłego tyg.", systemImage:"chart.line.uptrend.xyaxis").font(.system(size:11)).foregroundStyle(RPColor.success)
            }.padding(14).card()
            VStack(alignment:.leading, spacing:10){
                HStack{ Text("Zweryfikowane").font(.system(size:12)).foregroundStyle(RPColor.muted); Spacer(); ZStack{ Circle().fill(RPColor.primaryLight).frame(width:24,height:24); Image(systemName:"books.vertical.fill").foregroundStyle(RPColor.primary).font(.system(size:12))}}
                HStack(alignment:.firstTextBaseline, spacing:4){ Text("9").font(.system(size:26, weight:.bold, design:.rounded)); Text("Książek").font(.system(size:13)).foregroundStyle(RPColor.muted)}
                Label("100% z testami wiedzy", systemImage:"checkmark.seal.fill").font(.system(size:11)).foregroundStyle(RPColor.primary)
            }.padding(14).card()
        }
    }

    var performance: some View {
        VStack(alignment:.leading, spacing:10){
            HStack{ Text("EFEKTYWNOŚĆ PRZYSWAJANIA").font(.system(size:11, weight:.bold, design:.rounded)).tracking(0.6).foregroundStyle(RPColor.muted); Spacer(); VStack(alignment:.trailing){ Text("3 420").font(.system(size:18, weight:.bold, design:.rounded)); Text("stron przeczytanych").font(.system(size:11)).foregroundStyle(RPColor.muted)} }
            HStack(alignment:.firstTextBaseline, spacing:6){ Text("98.4%").font(.system(size:24, weight:.bold, design:.rounded)); Text("zrozumienia").font(.system(size:13)).foregroundStyle(RPColor.muted)}
            // sparkline
            GeometryReader{ geo in
                let w=geo.size.width; let h:CGFloat=40
                ZStack(alignment:.bottom){
                    LinearGradient(colors:[RPColor.primary.opacity(0.2), .clear], startPoint:.top, endPoint:.bottom).clipShape(Path{ p in p.move(to: CGPoint(x:0,y:h)); p.addCurve(to: CGPoint(x:w,y:10), control1: CGPoint(x:w*0.25,y:h), control2: CGPoint(x:w*0.6,y:4)); p.addLine(to: CGPoint(x:w,y:h)); p.closeSubpath() })
                    Path{ p in p.move(to: CGPoint(x:0,y:h-6)); p.addCurve(to: CGPoint(x:w,y:12), control1: CGPoint(x:w*0.3,y:h-8), control2: CGPoint(x:w*0.6,y:6))}.stroke(RPColor.primary, style:StrokeStyle(lineWidth:2, lineCap:.round))
                    Circle().fill(RPColor.primary).frame(width:10,height:10).position(x:w-8,y:12).shadow(color: RPColor.primary.opacity(0.3), radius:4)
                }
            }.frame(height:44)
            HStack{ Text("Lipiec").font(.system(size:11)).foregroundStyle(RPColor.muted2); Spacer(); Text("Sierpień").font(.system(size:11)).foregroundStyle(RPColor.muted2); Spacer(); Text("Wrzesień").font(.system(size:11)).foregroundStyle(RPColor.muted2); Spacer(); Text("Październik").font(.system(size:11, weight:.semibold)).foregroundStyle(RPColor.primary)}
        }.padding(14).card()
    }

    var history: some View {
        VStack(alignment:.leading, spacing:10){
            Text("HISTORIA DOWODÓW CZYTELNICTWA").font(.system(size:11, weight:.bold, design:.rounded)).tracking(0.6).foregroundStyle(RPColor.muted)
            if appState.proofs.isEmpty{
                VStack(spacing:8){
                    HistRow(title:"Pułapki myślenia", sub:"Kahneman • Dzisiaj", amount:"+$15.00 USDC")
                    HistRow(title:"Klara i słońce", sub:"Ishiguro • 12 Paź", amount:"+$12.00 USDC")
                    HistRow(title:"Sapiens", sub:"Harari • 28 Wrz", amount:"+$20.00 USDC")
                    HistRow(title:"Psychologia pieniądza", sub:"Housel • 14 Wrz", amount:"+$10.00 USDC")
                }
            } else {
                ForEach(appState.proofs){ p in
                    HStack(spacing:10){
                        ZStack{ RoundedRectangle(cornerRadius:8).fill(RPColor.primarySoft).frame(width:36,height:36); Image(systemName:"checkmark.seal.fill").foregroundStyle(RPColor.primary)}
                        VStack(alignment:.leading){ Text(p.bookId).font(.system(size:13, weight:.semibold, design:.rounded)).lineLimit(1); Text(p.chapterId).font(.system(size:11)).foregroundStyle(RPColor.muted)}
                        Spacer(); Text(p.reward ?? "").font(.system(size:12, weight:.semibold)).foregroundStyle(RPColor.primary)
                    }.padding(12).card()
                }
            }
            NavigationLink(destination: Text("Eksport")){ HStack(spacing:10){ ZStack{ RoundedRectangle(cornerRadius:8).fill(RPColor.primaryLight).frame(width:36,height:36); Image(systemName:"square.and.arrow.up").foregroundStyle(RPColor.primary)}; VStack(alignment:.leading){ Text("Eksportuj atestacje do LinkedIn / CV").font(.system(size:13, weight:.semibold, design:.rounded)); Text("Kryptograficzny certyfikat kompetencji czytelniczych").font(.system(size:11)).foregroundStyle(RPColor.muted)}; Spacer(); Image(systemName:"chevron.right").foregroundStyle(RPColor.muted2)} .padding(14).card() }.buttonStyle(.plain)
        }
    }

    var languagePicker: some View {
        VStack(alignment:.leading, spacing:8){
            Text(loc.t("Język pytań","Question language")).font(.system(size:13, weight:.semibold, design:.rounded))
            Text(loc.t("Domyślnie język urządzenia. Pytania generuje LLM (OpenRouter free) w wybranym języku.","Default is device language. LLM generates in chosen language (OpenRouter free).")).font(.system(size:11)).foregroundStyle(RPColor.muted)
            Picker("Lang", selection: Binding(get:{loc.current}, set:{loc.current=$0})){
                ForEach(AppLanguage.allCases, id:\.rawValue){ l in Text("\(l.flag) \(l.displayName)").tag(l)}
            }.pickerStyle(.segmented)
        }.padding(14).card()
    }

    var backendCard: some View {
        VStack(alignment:.leading, spacing:8){
            Text("Backend").font(.system(size:11, weight:.bold, design:.rounded)).tracking(0.6).foregroundStyle(RPColor.muted)
            HStack{
                TextField("http://127.0.0.1:32288", text: Binding(get:{UserDefaults.standard.string(forKey:"backend_url") ?? ""}, set:{UserDefaults.standard.set($0, forKey:"backend_url")})).font(.system(size:11, design:.monospaced)).padding(10).background(RPColor.bg).clipShape(RoundedRectangle(cornerRadius:10)).overlay(RoundedRectangle(cornerRadius:10).stroke(RPColor.line))
                Button("Test"){ Task{ _=await BackendService.shared.checkHealth()}}.buttonStyle(.bordered).tint(RPColor.primary)
            }
            BackendHealthView()
            Text("Jev = oficjalne API (nie OpenRouter) → backend /api/evaluate → mock fallback. LLM = OpenRouter free → backend /api/generate. Frontend bez AI.").font(.system(size:10)).foregroundStyle(RPColor.muted)
        }.padding(14).card()
    }
}

struct HistRow: View {
    var title:String; var sub:String; var amount:String
    var body: some View {
        HStack(spacing:10){
            ZStack{ RoundedRectangle(cornerRadius:8).fill(RPColor.primarySoft).frame(width:36,height:36); Image(systemName:"brain.head.profile").foregroundStyle(RPColor.primary)}
            VStack(alignment:.leading){ Text(title).font(.system(size:13, weight:.semibold, design:.rounded)); Text(sub).font(.system(size:11)).foregroundStyle(RPColor.muted)}
            Spacer(); Text(amount).font(.system(size:12, weight:.semibold)).foregroundStyle(RPColor.primary)
        }.padding(12).card()
    }
}
typealias WalletView = PassportView
