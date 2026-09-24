import SwiftUI

struct HomeView: View {
    @EnvironmentObject var store: ChallengeStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @State private var query = ""
    @State private var selectedCat = "Wszystkie"
    @State private var campaigns: [BackendService.PublisherCampaign] = []
    let cats = ["Wszystkie","Przygodowe","Detektyw"]

    var filteredCampaigns: [BackendService.PublisherCampaign] {
        campaigns.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || ($0.author ?? "").localizedCaseInsensitiveContains(query) }
    }

    var filtered: [Book] {
        store.books.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.author.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            List {
                if let main = filtered.first {
                    Section {
                        NavigationLink(destination: BookDetailView(book: main)) {
                            MainRow(book: main)
                        }
                    } header: {
                        Text(loc.t("Główne wyzwanie","Featured")).font(.caption.weight(.semibold))
                    }
                }
                Section(loc.t("Katalog","Catalog")) {
                    ForEach(filtered) { book in
                        NavigationLink(destination: BookDetailView(book: book)) {
                            BookRowClean(book: book)
                        }
                    }
                }
                if !filteredCampaigns.isEmpty {
                    Section(loc.t("Od wydawców","From publishers")) {
                        ForEach(filteredCampaigns) { camp in
                            NavigationLink(destination: ChapterIntroView(book: campBook(camp), chapter: campChapter(camp), campaignId: camp.id)) {
                                CampaignRowClean(camp: camp)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: loc.t("Szukaj książek…","Search books…"))
            .navigationTitle("ReadProof")
            .toolbar {
            ToolbarItem(placement:.principal){ HStack(spacing:8){ Image(systemName:"books.vertical.fill").foregroundStyle(RPColor.primary); Text("ReadProof").font(.headline)} }
            ToolbarItem(placement:.navigationBarTrailing) {
                Button(action: { appState.logout() }) {
                    Label("Wyloguj", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        }
        .task { await refreshFromServer() }
        .refreshable { await refreshFromServer() }
    }

    func refreshFromServer() async {
        if let books = await BackendService.shared.fetchBooks() {
            await MainActor.run {
                store.books = books
                // also refresh challenges map via health? For now keep bundled map; backend pools are larger
            }
        }
        // kampanie wydawców (Kopciuszek, Grimm, własne) — żeby nie znikały z katalogu
        if let camps = await BackendService.shared.fetchCampaigns() {
            await MainActor.run { campaigns = camps }
        }
    }

    // syntetyczny Book/Chapter z kampanii — sesja startuje przez endpoint kampanii (campaignId)
    func campBook(_ c: BackendService.PublisherCampaign) -> Book {
        Book(id: c.id, title: c.title, author: c.author ?? "Wydawca", coverEmoji: "❦", coverUrl: c.coverUrl,
             description: c.description ?? "", totalChapters: 1, rewardPerChapter: c.rewardLabel,
             chapters: [campChapter(c)])
    }
    func campChapter(_ c: BackendService.PublisherCampaign) -> Chapter {
        Chapter(id: c.id, bookId: c.id, index: 1, title: c.title, summary: c.description ?? "",
                contextExcerpt: "", reward: c.rewardLabel)
    }
}

struct MainRow: View {
    let book: Book
    var body: some View {
        HStack(spacing:12){
            RemoteCoverView(book: book, width:64, height:88)
            VStack(alignment:.leading, spacing:4){
                Text(book.title).font(.headline).foregroundStyle(RPColor.ink).lineLimit(2)
                Text(book.author).font(.subheadline).foregroundStyle(RPColor.muted)
                HStack(spacing:6){
                    Text(book.rewardPerChapter).font(.caption.weight(.semibold)).padding(.horizontal,8).padding(.vertical,4).background(RPColor.peachLight).foregroundStyle(RPColor.peach).clipShape(Capsule())
                    Text("\(book.chapters.count) rozdz.").font(.caption).foregroundStyle(RPColor.muted)
                }
            }
            Spacer()
        }.padding(.vertical,4)
    }
}

struct BookRowClean: View {
    let book: Book
    var body: some View {
        HStack(spacing:12){
            RemoteCoverView(book: book, width:44, height:60)
            VStack(alignment:.leading, spacing:2){
                Text(book.title).font(.subheadline.weight(.semibold)).foregroundStyle(RPColor.ink).lineLimit(1)
                Text(book.author).font(.caption).foregroundStyle(RPColor.muted)
            }
            Spacer()
            Image(systemName:"chevron.right").font(.caption2).foregroundStyle(RPColor.muted2)
        }
    }
}

struct CampaignRowClean: View {
    let camp: BackendService.PublisherCampaign
    var body: some View {
        HStack(spacing:12){
            ZStack {
                RoundedRectangle(cornerRadius:8).fill(RPColor.peachLight).frame(width:44, height:60)
                Image(systemName:"books.vertical.fill").foregroundStyle(RPColor.peach)
            }
            VStack(alignment:.leading, spacing:2){
                Text(camp.title).font(.subheadline.weight(.semibold)).foregroundStyle(RPColor.ink).lineLimit(1)
                HStack(spacing:6){
                    Text(camp.author ?? "Wydawca").font(.caption).foregroundStyle(RPColor.muted)
                    Text(camp.isActive ? "active" : (camp.status ?? "draft")).font(.caption2.weight(.bold)).foregroundStyle(camp.isActive ? RPColor.success : RPColor.muted)
                        .padding(.horizontal,6).padding(.vertical,2).background(camp.isActive ? RPColor.success.opacity(0.12) : RPColor.card).clipShape(Capsule())
                }
            }
            Spacer()
            Image(systemName:"chevron.right").font(.caption2).foregroundStyle(RPColor.muted2)
        }
    }
}
