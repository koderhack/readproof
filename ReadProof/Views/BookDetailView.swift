import SwiftUI

struct BookDetailView: View {
    let book: Book
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var store: ChallengeStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                source
                chapters
            }.padding(16)
        }
        .background(RPColor.parchment)
        .navigationTitle(book.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(RPColor.parchment, for: .navigationBar)
    }

    var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 14) {
                Text(book.coverEmoji).font(.system(size: 44)).frame(width: 86, height: 110).background(RPColor.cream).clipShape(RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(RPColor.line))
                VStack(alignment: .leading, spacing: 6) {
                    Text(book.title).font(.system(size: 18, weight: .bold, design: .serif)).foregroundStyle(RPColor.ink)
                    Text(book.author).font(.system(size: 12, design: .serif)).foregroundStyle(RPColor.muted2)
                    MonoPill(text: "Reward: \(book.rewardPerChapter) / chapter", fg: RPColor.success, bg: Color.white, border: RPColor.success.opacity(0.3))
                }
            }
            Text(book.description).font(.system(size: 12, design: .serif)).foregroundStyle(RPColor.muted2).lineSpacing(2)
            Label("Czytasz fizyczną książkę — tu tylko weryfikujemy zrozumienie (Comprehension Verified).", systemImage: "eye").font(.system(size: 10, design: .serif)).foregroundStyle(RPColor.muted)
        }.padding(14).parchmentCard()
    }

    var source: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Pełny tekst z domeny publicznej", systemImage: "books.vertical").font(.system(size: 11, weight: .bold, design: .serif)).foregroundStyle(RPColor.ink)
            HStack(spacing: 8) {
                MonoPill(text: book.license ?? "Public domain", fg: RPColor.burgundy)
                if let url = book.sourceUrl { Link(destination: URL(string: url)!) { MonoPill(text: "Gutenberg", fg: RPColor.success) } }
            }
            Text("Tekst służy wyłącznie do generowania pytań przez LLM na backendzie — nie jest udostępniany w całości w apce (fizyczna książka).").font(.system(size: 9, design: .serif)).foregroundStyle(RPColor.muted)
        }.padding(12).parchmentCard(dashed: true)
    }

    var chapters: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Rozdziały • Reading Challenge = 5 zadań").font(.system(size: 12, weight: .bold, design: .serif)).foregroundStyle(RPColor.ink)
            ForEach(book.chapters) { ch in
                let verified = appState.isChapterVerified(ch.id)
                NavigationLink(destination: ChapterIntroView(book: book, chapter: ch)) {
                    HStack(spacing: 12) {
                        ZStack { Circle().fill(verified ? RPColor.success.opacity(0.15) : RPColor.cream).frame(width: 42, height: 42); Text("\(ch.index)").font(.system(size: 14, weight: .bold, design: .serif)).foregroundStyle(verified ? RPColor.success : RPColor.burgundy) }
                        VStack(alignment: .leading, spacing: 4) {
                            Text(ch.title).font(.system(size: 13, weight: .semibold, design: .serif)).foregroundStyle(RPColor.ink)
                            Text(ch.summary).font(.system(size: 11, design: .serif)).foregroundStyle(RPColor.muted2).lineLimit(2)
                            HStack(spacing: 6) { MonoPill(text: ch.reward, fg: RPColor.success); if verified { MonoPill(text: "Reading Verified", fg: RPColor.success) } }
                        }
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption2).foregroundStyle(RPColor.muted)
                    }.padding(12).parchmentCard()
                }.buttonStyle(.plain)
            }
        }
    }
}

// TextViewer usunięty — brak dostępu do pełnego tekstu w apce (anti-AI, fizyczna książka)
