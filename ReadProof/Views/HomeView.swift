import SwiftUI

struct HomeView: View {
    @EnvironmentObject var store: ChallengeStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @State private var query = ""
    @State private var selectedCat = "Wszystkie"
    let cats = ["Wszystkie","Przygodowe","Detektyw","Klasyka"]

    var filtered: [Book] {
        store.books.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.author.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading, spacing:18){
                    // ledger header — encoding: catalog meta
                    HStack{
                        CatalogEyebrow(text: "CATALOG  •  SEASON IV  •  DEVNET")
                        Spacer()
                        MonoPill(text: "\(filtered.count) TITLES", fg: RPColor.ink, bg: RPColor.card, border: RPColor.line)
                    }
                    Text(loc.t("Odkrywaj. Czytaj.\nUdowodnij.", "Discover. Read.\nProve it."))
                        .font(.system(size:32, weight:.bold, design:.serif)).tracking(-1).foregroundStyle(RPColor.ink).lineSpacing(-1)
                    Text(loc.t("5 przygodowych książek z pełnym tekstem public domain (Gutenberg). Pytania generuje LLM na żywo w języku urządzenia.",
                               "5 adventure books, full public-domain text (Gutenberg). Questions are generated live in your device language."))
                        .font(.system(size:13, design:.rounded)).foregroundStyle(RPColor.ink).lineSpacing(2)

                    search
                    chips

                    if let main = filtered.first {
                        NavigationLink(destination: BookDetailView(book: main)){
                            MainFieldCard(book: main)
                        }.buttonStyle(.plain)
                    }

                    sprints
                    lastAttestations
                }.padding(16)
            }
            .background(RPColor.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar{ ToolbarItem(placement:.principal){ HStack(spacing:8){
                ZStack{ RoundedRectangle(cornerRadius:8).fill(RPColor.ink).frame(width:32,height:32); Image(systemName:"books.vertical.fill").foregroundStyle(.white).font(.system(size:14))}
                VStack(alignment:.leading, spacing:1){ Text("ReadProof").font(.system(size:15, weight:.bold, design:.serif)); Text("ATTESTED READING").font(.system(size:8, weight:.bold, design:.monospaced)).tracking(1).foregroundStyle(RPColor.muted)}
                Spacer()
                NavigationLink(destination: PassportView()){ Circle().fill(Color(hex:"#E6ECEB")).frame(width:28,height:28).overlay(Image(systemName:"person.fill").font(.system(size:12)).foregroundStyle(RPColor.muted))}
            }}}
        }
    }

    var search: some View {
        HStack(spacing:8){
            Image(systemName:"magnifyingglass").foregroundStyle(RPColor.muted2)
            TextField(loc.t("Szukaj tytułów, autorów…","Search titles, authors…"), text:$query).font(.system(size:15, design:.rounded)).foregroundStyle(RPColor.ink).tint(RPColor.primary).autocorrectionDisabled()
        }.padding(12).background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(RPColor.line))
    }

    var chips: some View {
        ScrollView(.horizontal, showsIndicators:false){
            HStack(spacing:8){
                ForEach(cats, id:\.self){ c in
                    Text(c).font(.system(size:13, weight: selectedCat==c ? .semibold : .regular, design:.rounded))
                        .padding(.horizontal,14).padding(.vertical,8)
                        .background(selectedCat==c ? RPColor.ink : RPColor.card).foregroundStyle(selectedCat==c ? .white : RPColor.ink)
                        .clipShape(Capsule()).overlay(Capsule().stroke(selectedCat==c ? RPColor.ink : RPColor.line))
                        .onTapGesture{ selectedCat=c }
                }
            }
        }
    }

    var sprints: some View {
        VStack(alignment:.leading, spacing:12){
            HStack{ Text("Sprinty czytelnicze").font(.system(size:18, weight:.bold, design:.serif)); Spacer(); Button(loc.t("Zobacz 18","See 18")){}.font(.system(size:13, weight:.semibold)).tint(RPColor.primary)}
            ScrollView(.horizontal, showsIndicators:false){
                HStack(spacing:12){
                    ForEach(store.books){ b in
                        NavigationLink(destination: BookDetailView(book: b)){
                            SprintFieldCard(book: b)
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
    }

    var lastAttestations: some View {
        VStack(alignment:.leading, spacing:12){
            HStack{ Text("Ostatnie atestacje").font(.system(size:18, weight:.bold, design:.serif)); Spacer(); Text("Na żywo w sieci").font(.system(size:11)).foregroundStyle(RPColor.muted)}
            VStack(spacing:8){
                AttestRow(name:"aleksandra.eth", book:"Człowiek w poszukiwaniu sensu", mins:"2 min temu", amount:"+$12.50")
                AttestRow(name:"0x7F2…91bc", book:"Sapiens: Od zwierząt do bogów", mins:"9 min temu", amount:"+$18.00")
                AttestRow(name:"kamil_reader.lens", book:"Głęboka praca (Deep Work)", mins:"24 min temu", amount:"+$15.00")
            }
        }
    }
}

struct MainFieldCard: View {
    let book: Book
    var body: some View {
        VStack(alignment:.leading, spacing:12){
            // top rule — structural device encoding catalog
            Rectangle().fill(RPColor.line).frame(height:1)
            HStack{ CatalogEyebrow(text:"GŁÓWNE WYZWANIE • \(book.id.uppercased())"); Spacer(); MonoPill(text:"$15.00 USDC", fg:.white, bg:RPColor.peach, border:.clear)}
            Text(book.title).font(.system(size:22, weight:.bold, design:.serif)).foregroundStyle(RPColor.ink).lineLimit(2)
            Text(book.author).font(.system(size:13, design:.rounded)).foregroundStyle(RPColor.muted)
            HStack(alignment:.top, spacing:12){
                RemoteCoverView(book: book, width:88, height:118)
                VStack(alignment:.leading, spacing:8){
                    HStack{ Text("Miejsca w puli:").font(.system(size:11)).foregroundStyle(RPColor.muted); Spacer(); Text("352 / 400").font(.system(size:12, weight:.semibold, design:.monospaced))}
                    ProgressBar(value:0.88, tint: RPColor.primary)
                    Text("Pozostało 12% • 14 dni • 3 etapy ZK").font(.system(size:10, design:.monospaced)).foregroundStyle(RPColor.muted)
                }
            }
            // CTA — primary is field green, reward is peach (weak orange) only as pill
            HStack(spacing:10){
                Text("Rozpocznij wyzwanie →").font(.system(size:14, weight:.semibold, design:.rounded)).frame(maxWidth:.infinity).padding(.vertical,13).background(RPColor.primary).foregroundStyle(.white).clipShape(RoundedRectangle(cornerRadius:12))
            }
        }.padding(16).card()
    }
}

struct SprintFieldCard: View {
    let book: Book
    var body: some View {
        VStack(alignment:.leading, spacing:8){
            // cover with corner ledger label
            ZStack(alignment:.topLeading){
                RemoteCoverView(book: book, width:148, height:96)
                Text(book.rewardPerChapter).font(.system(size:10, weight:.bold, design:.monospaced)).padding(.horizontal,7).padding(.vertical,4).background(Color.black.opacity(0.78)).foregroundStyle(.white).clipShape(Capsule()).padding(6)
            }
            Text(book.title).font(.system(size:12, weight:.semibold, design:.rounded)).lineLimit(1)
            Text(book.author).font(.system(size:11)).foregroundStyle(RPColor.muted).lineLimit(1)
            HStack(spacing:6){
                MonoPill(text:"7 dni", fg:RPColor.primary, bg:RPColor.primaryLight, border:.clear)
                Text("642 czytelników").font(.system(size:10)).foregroundStyle(RPColor.muted)
            }
        }.frame(width:164).padding(10).card()
    }
}

struct AttestRow: View {
    var name:String; var book:String; var mins:String; var amount:String
    var body: some View {
        HStack(spacing:10){
            Image(systemName:"person.crop.circle.fill").font(.system(size:30)).foregroundStyle(RPColor.muted2)
            VStack(alignment:.leading, spacing:2){
                HStack(spacing:4){ Text(name).font(.system(size:12, weight:.semibold, design:.rounded)); Image(systemName:"checkmark.seal.fill").font(.system(size:10)).foregroundStyle(RPColor.primary)}
                Text(book).font(.system(size:11)).foregroundStyle(RPColor.muted).lineLimit(1)
                Text(mins).font(.system(size:10)).foregroundStyle(RPColor.muted2)
            }
            Spacer()
            Text(amount).font(.system(size:12, weight:.bold, design:.monospaced)).foregroundStyle(RPColor.peach)
        }.padding(12).card()
    }
}
