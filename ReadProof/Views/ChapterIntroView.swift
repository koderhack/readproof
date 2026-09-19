import SwiftUI

struct ChapterIntroView: View {
    let book: Book
    let chapter: Chapter
    @EnvironmentObject var store: ChallengeStore
    @EnvironmentObject var appState: AppState
    @State private var goChallenge = false
    @State private var picked: [Challenge] = []

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                card
                excerpt
                Button {
                    picked = store.pickFive(for: chapter.id)
                    goChallenge = true
                } label: { HStack { Image(systemName: "play.fill"); Text("Start Reading Challenge") }.font(.system(size: 14, weight: .bold, design: .serif)) }
                .buttonStyle(BurgundyButtonStyle())
                Text("5 różnych zadań • jedno otwarte oceni Jev (próg 80%) • 4–5/5 = Comprehension Verified").font(.system(size: 9, design: .monospaced)).foregroundStyle(RPColor.muted).multilineTextAlignment(.center)
                if appState.wallet.address == nil {
                    NavigationLink(destination: PassportView()) { Label("Podłącz wallet aby odebrać nagrodę (Devnet) — Paszport", systemImage: "wallet.pass").font(.system(size: 11, weight: .semibold, design: .serif)) }.tint(RPColor.burgundy)
                }
            }.padding(16)
        }
        .background(RPColor.parchment)
        .navigationTitle("Chapter \(chapter.index)")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $goChallenge) { ChallengeFlowView(book: book, chapter: chapter, challenges: picked) }
    }

    var card: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { MonoPill(text: "Reward: \(chapter.reward) • Solana Devnet", fg: RPColor.success); Spacer(); Text("5 zadań").font(.system(size: 9, design: .monospaced)).foregroundStyle(RPColor.muted) }
            Text(chapter.title).font(.system(size: 18, weight: .bold, design: .serif)).foregroundStyle(RPColor.ink)
            Text(chapter.summary).font(.system(size: 12, design: .serif)).foregroundStyle(RPColor.muted2)
            HStack(spacing: 8) { Label("~3 min", systemImage: "clock").font(.system(size: 10, design: .monospaced)); Label("Jev inside", systemImage: "brain").font(.system(size: 10, design: .monospaced)); Spacer() }.foregroundStyle(RPColor.muted)
        }.padding(14).parchmentCard()
    }

    var excerpt: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Image(systemName: "book"); Text("Przeczytaj rozdział w fizycznej książce").font(.system(size: 12, weight: .semibold, design: .serif)); Spacer() }
            Text(chapter.contextExcerpt).font(.system(size: 11, design: .serif)).foregroundStyle(RPColor.muted2).padding(10).background(RPColor.cream.opacity(0.6)).clipShape(RoundedRectangle(cornerRadius: 8))
            NavigationLink(destination: TextViewer(book: book)) { Label("Zobacz pełny tekst (Gutenberg) w apce — legal public domain", systemImage: "doc.text.magnifyingglass").font(.system(size: 10, design: .serif)) }.tint(RPColor.burgundy)
            Text("App nie jest ebook readerem — służy weryfikacji zrozumienia. Pełny tekst do czytania poza apką lub podgląd w bundlu.").font(.system(size: 9, design: .serif)).foregroundStyle(RPColor.muted)
        }.padding(14).parchmentCard(dashed: true)
    }
}
