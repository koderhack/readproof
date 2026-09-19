import SwiftUI

struct HomeView: View {
    @EnvironmentObject var store: ChallengeStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @State private var query = ""
    @State private var selectedCat = "Wszystkie"
    let cats = ["Wszystkie","Filozofia","Psychologia","Nauka","Przygodowe"]

    var filtered: [Book] {
        let byCat: [Book]
        if selectedCat == "Przygodowe" { byCat = store.books }
        else { byCat = store.books }
        if query.isEmpty { return byCat }
        return byCat.filter{ $0.title.localizedCaseInsensitiveContains(query) || $0.author.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading, spacing:16){
                    search
                    chips
                    if let main = filtered.first {
                        NavigationLink(destination: BookDetailView(book: main)){
                            MainChallengeCard(book: main)
                        }.buttonStyle(.plain)
                    }
                    sprints
                    lastAttestations
                }.padding(16)
            }
            .background(RPColor.bg)
            .navigationTitle("ReadProof")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar{ ToolbarItem(placement:.principal){ HStack(spacing:8){ ZStack{ RoundedRectangle(cornerRadius:8).fill(RPColor.primary).frame(width:32,height:32); Image(systemName:"books.vertical.fill").foregroundStyle(.white).font(.system(size:14))}; Text("ReadProof").font(.system(size:18, weight:.bold, design:.rounded)); Spacer(); NavigationLink(destination: PassportView()){ Image(systemName:"person.crop.circle.fill").font(.title2).foregroundStyle(RPColor.muted)} } } }
            .toolbarBackground(RPColor.bg, for:.navigationBar)
        }
    }

    var search: some View {
        HStack(spacing:8){
            Image(systemName:"magnifyingglass").foregroundStyle(RPColor.muted2)
            TextField(loc.t("Szukaj tytułów, autorów…","Search titles, authors…"), text:$query).font(.system(size:15))
        }.padding(12).background(Color.white).clipShape(RoundedRectangle(cornerRadius:12)).overlay(RoundedRectangle(cornerRadius:12).stroke(RPColor.line))
    }

    var chips: some View {
        ScrollView(.horizontal, showsIndicators:false){
            HStack(spacing:8){
                ForEach(cats, id:\.self){ c in
                    Text(c).font(.system(size:14, weight: selectedCat==c ? .semibold : .regular, design:.rounded))
                        .padding(.horizontal,14).padding(.vertical,8)
                        .background(selectedCat==c ? RPColor.ink : Color.white).foregroundStyle(selectedCat==c ? .white : RPColor.ink)
                        .clipShape(Capsule()).overlay(Capsule().stroke(selectedCat==c ? RPColor.ink : RPColor.line))
                        .onTapGesture{ selectedCat=c }
                }
            }
        }
    }

    var sprints: some View {
        VStack(alignment:.leading, spacing:12){
            HStack{ Text("Sprinty czytelnicze").font(.system(size:18, weight:.bold, design:.rounded)); Spacer(); Button(loc.t("Zobacz 18","See 18")){}.font(.system(size:13, weight:.semibold)).tint(RPColor.primary) }
            ScrollView(.horizontal, showsIndicators:false){
                HStack(spacing:12){
                    ForEach(store.books){ b in
                        NavigationLink(destination: BookDetailView(book: b)){
                            SprintCard(book: b)
                        }.buttonStyle(.plain)
                    }
                }
            }
        }
    }

    var lastAttestations: some View {
        VStack(alignment:.leading, spacing:12){
            HStack{ Text("Ostatnie atestacje").font(.system(size:18, weight:.bold, design:.rounded)); Spacer(); Text("Na żywo w sieci").font(.system(size:12)).foregroundStyle(RPColor.muted) }
            VStack(spacing:8){
                AttestRow(name:"aleksandra.eth", book:"Człowiek w poszukiwaniu sensu", mins:"2 min temu", amount:"+$12.50", color: RPColor.primary)
                AttestRow(name:"0x7F2…91bc", book:"Sapiens: Od zwierząt do bogów", mins:"9 min temu", amount:"+$18.00", color: Color(hex:"#0F766E"))
                AttestRow(name:"kamil_reader.lens", book:"Głęboka praca (Deep Work)", mins:"24 min temu", amount:"+$15.00", color: RPColor.primary)
            }
        }
    }
}

struct MainChallengeCard: View {
    let book: Book
    @EnvironmentObject var appState: AppState
    var body: some View {
        VStack(alignment:.leading, spacing:12){
            HStack{ Label("GŁÓWNE WYZWANIE", systemImage:"circle.fill").font(.system(size:11, weight:.bold, design:.rounded)).tracking(0.6).foregroundStyle(RPColor.primary); Spacer(); MonoPill(text:"$15.00 USDC", fg:RPColor.ink, bg:Color.white, border:RPColor.line)}
            Text(book.title).font(.system(size:22, weight:.bold, design:.rounded)).foregroundStyle(RPColor.ink).lineLimit(2)
            Text(book.author).font(.system(size:13)).foregroundStyle(RPColor.muted)
            HStack(alignment:.top, spacing:12){
                RemoteCoverView(book: book, width:86, height:116)
                VStack(alignment:.leading, spacing:8){
                    HStack{ Text("Miejsca w puli:").font(.system(size:12)).foregroundStyle(RPColor.muted); Spacer(); Text("352 / 400").font(.system(size:13, weight:.semibold)) }
                    ProgressBar(value:0.88, tint: RPColor.primary)
                    Text("Pozostało 12%").font(.system(size:11)).foregroundStyle(RPColor.muted).frame(maxWidth:.infinity, alignment:.trailing)
                    HStack(spacing:12){
                        Label("14 dni", systemImage:"clock").font(.system(size:11)).foregroundStyle(RPColor.muted)
                        Label("3 etapy ZK", systemImage:"checkmark.shield").font(.system(size:11)).foregroundStyle(RPColor.muted)
                    }
                }
            }
            Text("Rozpocznij wyzwanie →").font(.system(size:15, weight:.semibold, design:.rounded)).frame(maxWidth:.infinity).padding(.vertical,14).background(RPColor.primary).foregroundStyle(.white).clipShape(RoundedRectangle(cornerRadius:14))
        }.padding(16).card()
    }
}

struct SprintCard: View {
    let book: Book
    var body: some View {
        VStack(alignment:.leading, spacing:8){
            ZStack(alignment:.topTrailing){
                RemoteCoverView(book: book, width: 140, height: 88)
                MonoPill(text: book.rewardPerChapter, fg:.white, bg:Color.black.opacity(0.75), border:.clear).padding(6)
            }
            Text(book.title).font(.system(size:13, weight:.semibold, design:.rounded)).lineLimit(1)
            Text(book.author).font(.system(size:12)).foregroundStyle(RPColor.muted).lineLimit(1)
            HStack(spacing:6){
                MonoPill(text:"7 dni", fg:RPColor.primary, bg:RPColor.primaryLight, border:.clear)
                Text("642 czytelników").font(.system(size:11)).foregroundStyle(RPColor.muted)
            }
        }.frame(width:160).padding(10).card()
    }
}

struct AttestRow: View {
    var name:String; var book:String; var mins:String; var amount:String; var color:Color
    var body: some View {
        HStack(spacing:10){
            Image(systemName:"person.crop.circle.fill").font(.system(size:32)).foregroundStyle(RPColor.muted2)
            VStack(alignment:.leading, spacing:2){
                HStack(spacing:4){ Text(name).font(.system(size:13, weight:.semibold, design:.rounded)); Image(systemName:"checkmark.seal.fill").font(.system(size:10)).foregroundStyle(color) }
                Text(book).font(.system(size:12)).foregroundStyle(RPColor.muted).lineLimit(1)
                Text(mins).font(.system(size:11)).foregroundStyle(RPColor.muted2)
            }
            Spacer()
            Text(amount).font(.system(size:14, weight:.semibold, design:.rounded)).foregroundStyle(RPColor.primary)
        }.padding(12).card()
    }
}
