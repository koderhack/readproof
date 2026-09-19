import SwiftUI

struct ChapterIntroView: View {
    let book: Book
    let chapter: Chapter
    @EnvironmentObject var store: ChallengeStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @State private var goSession = false

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                card
                excerpt
                Button {
                    goSession = true
                } label: { HStack { Image(systemName: "play.fill"); Text(loc.t("Start Reading Session","Start Reading Session")) }.font(.system(size: 15, weight:.bold, design:.rounded)) }
                .buttonStyle(BurgundyButtonStyle())
                Text(loc.t("Proof of Comprehension — nie dowód fizycznego czytania. 5 wyzwań losowanych z 20 (backend), odblokowywane co ~20s/3min, fragment-dependent, limit 8min/12min, Jev, anti-copy, screenshot→suspicious, Live Activity.","Proof of Comprehension — not physical reading. 5 random from 20, staged unlock, fragment-dependent, time limit, Jev, anti-copy, screenshot→suspicious, Live Activity.")).font(.system(size: 10)).foregroundStyle(RPColor.muted).multilineTextAlignment(.center)
                if appState.wallet.address == nil {
                    NavigationLink(destination: PassportView()) { Label(loc.t("Podłącz Phantom aby odebrać nagrodę (Devnet)","Connect Phantom to claim reward"), systemImage: "wallet.pass").font(.system(size: 12, weight:.semibold, design:.rounded)) }.tint(RPColor.primary)
                }
            }.padding(16)
        }
        .background(RPColor.bg)
        .navigationTitle("Chapter \(chapter.index)")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(isPresented: $goSession) { ReadingSessionView(book: book, chapter: chapter) }
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
            Text(chapter.contextExcerpt).font(.system(size: 11, design: .serif)).foregroundStyle(Color.black).padding(10).background(Color.white).clipShape(RoundedRectangle(cornerRadius: 8)).overlay(RoundedRectangle(cornerRadius:8).stroke(RPColor.line)).textSelection(.disabled)
            Text("Brak pełnego tekstu w apce — celowo. Czytaj fizyczną książkę, apka weryfikuje zrozumienie fragmentów (anti-AI).").font(.system(size: 9, design: .serif)).foregroundStyle(RPColor.muted)
        }.padding(14).card()
    }
}
