import SwiftUI

struct HomeView: View {
    @EnvironmentObject var store: ChallengeStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @State private var query = ""
    @State private var selectedCat = "Wszystkie"
    let cats = ["Wszystkie","Przygodowe","Detektyw"]

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
            }
            .listStyle(.insetGrouped)
            .searchable(text: $query, prompt: loc.t("Szukaj książek…","Search books…"))
            .navigationTitle("ReadProof")
            .toolbar { ToolbarItem(placement:.principal){ HStack(spacing:8){ Image(systemName:"books.vertical.fill").foregroundStyle(RPColor.primary); Text("ReadProof").font(.headline)} } }
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
