import SwiftUI

// === Design plan — Field Ledger for Adventure Proofs ===
// Subject: 5 public-domain adventure books, read physically, verified cryptographically. Audience: 18-35, hackathon judges. Job: pick a book → prove comprehension → get reward.
// Palette (opinionated, not default cream/terracotta):
//  Ink #0E1E2A (deep expedition navy, text/headers)
//  Paper #FFFCF5 (warm book paper, background)
//  Rule #E6DDC8 (ledger hairline)
//  Field #16423C (expedition green, primary actions/structure)
//  Peach #FF8B4D (weak orange — signal only for reward/bonus, per request, not dominant)
//  Fog #6B7B7F / Mist #9AA8A6 (muted)
// Type: Display — serif (Libre Baskerville style via .serif, tight tracking), Body — SF rounded, Utility — mono (JetBrains-like) for hashes/rewards
// Layout: Ledger desk — header is catalog meta (CAT. NO / SEASON), cards are field cards with top rule + corner stamp, progress is a traced line
// Signature: Wax seal stamp on proof/reward — single memorable motion (scale+fade)

enum RPColor {
    static let bg = Color(UIColor.systemGroupedBackground)          // adaptive: białe w light, ciemne w dark
    static let card = Color(UIColor.secondarySystemGroupedBackground) // adaptive card
    static let line = Color(UIColor.separator)         // adaptive hairline
    static let line2 = Color(UIColor.opaqueSeparator)
    static let ink = Color(UIColor.label)           // adaptive: czarne w light, białe w dark
    static let muted = Color(UIColor.secondaryLabel)         // adaptive secondary
    static let muted2 = Color(UIColor.tertiaryLabel)        // adaptive tertiary
    static let inkFixed = Color(hex: "#0B0B0F") // fixed dark for dark cards (funds)
    static let cardFixedWhite = Color.white // fixed white for light cards when needed
    // primaries — Duolingo green per request (native iOS, zielony)
    static let primary = Color(hex: "#58CC02")       // Duo Green
    static let primaryDark = Color(hex: "#46A302")
    static let primaryLight = Color(hex: "#E8FFD6")
    static let primarySoft = Color(hex: "#F0FCE4")
    // signal — słaby pomarańczowy per request, tylko dla nagrody/bonus
    static let peach = Color(hex: "#FF8B4D")
    static let peachLight = Color(hex: "#FFF1E6")
    static let peachSoft = Color(hex: "#FFF6EE")
    static let success = Color(hex: "#58CC02")
    static let successLight = Color(hex: "#E8FFD6")
    // Duolingo quiz palette
    static let duoGreen = Color(hex: "#58CC02")
    static let duoGreenDark = Color(hex: "#46A302")
    static let duoGreenLight = Color(hex: "#E8FFD6")
    static let duoYellow = Color(hex: "#FFCA00")
    static let duoBlue = Color(hex: "#1CB0F6")
    static let duoGray = Color(hex: "#E5E5E5")
    static let duoGrayDark = Color(hex: "#777777")
    static let duoText = Color(hex: "#4B4B4B")

    // compat (stary kod)
    static let parchment = bg
    static let parchment2 = bg
    static let paper = card
    static let cream = peachSoft
    static let burgundy = primary
    static let burgundyDark = primaryDark
    static let burgundyLight = primaryLight
    static let gold = peach
    static let goldLight = peachLight
    static let ink2 = ink
    static let warn = peach
    static let bg2 = bg
}

struct Card: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(RPColor.card)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(RPColor.line, lineWidth: 1))
            .shadow(color: Color(hex:"#0E1E2A").opacity(0.04), radius: 12, x: 0, y: 6)
    }
}
extension View {
    func card() -> some View { modifier(Card()) }
    func cardSoft() -> some View { self.background(RPColor.card).clipShape(RoundedRectangle(cornerRadius:14)).shadow(color:.black.opacity(0.04), radius:8, y:2).overlay(RoundedRectangle(cornerRadius:14).stroke(RPColor.line, lineWidth:1)) }
}

struct MonoPill: View {
    var text:String; var fg:Color=RPColor.muted; var bg:Color=Color.white; var border:Color=RPColor.line
    var body: some View {
        Text(text).font(.system(size:10, weight:.semibold, design:.monospaced)).tracking(0.4)
            .padding(.horizontal,8).padding(.vertical,5)
            .background(bg).foregroundStyle(fg)
            .overlay(RoundedRectangle(cornerRadius:20).stroke(border, lineWidth:1))
            .clipShape(Capsule())
    }
}
struct Pill: View { var text:String; var color:Color=RPColor.primary; var body: some View { MonoPill(text:text, fg:color, bg:color.opacity(0.10), border:.clear)}}
struct ProgressBar: View {
    var value:Double; var tint:Color=RPColor.primary
    var body: some View {
        GeometryReader{ g in
            ZStack(alignment:.leading){
                Capsule().fill(Color(hex:"#E9ECEB"))
                Capsule().fill(tint).frame(width: g.size.width * CGFloat(min(max(value,0),1)))
            }
        }.frame(height:6)
    }
}
struct CollegiumProgress: View { var value:Double; var body: some View{ ProgressBar(value:value)}}
struct DashedDivider: View { var body: some View{ Divider().overlay(RPColor.line)}}
struct DashedLine: View { var body: some View{ Divider()}}
struct ParchmentCard: ViewModifier { var dashed:Bool=false; func body(content:Content)->some View{ content.card()}}
extension View { func parchmentCard(dashed:Bool=false) -> some View{ card()}}
struct BurgundyButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size:15, weight:.semibold, design:.rounded)).tracking(0.2)
            .foregroundStyle(.white).frame(maxWidth:.infinity).padding(.vertical,14)
            .background(RPColor.primary).clipShape(RoundedRectangle(cornerRadius: 14))
            .opacity(configuration.isPressed ? 0.88 : 1)
    }
}
struct PeachButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size:15, weight:.semibold, design:.rounded))
            .foregroundStyle(.white).frame(maxWidth:.infinity).padding(.vertical,14)
            .background(RPColor.peach).clipShape(RoundedRectangle(cornerRadius: 14))
            .opacity(configuration.isPressed ? 0.90 : 1)
    }
}
struct SoftIcon: View {
    var system:String; var size:CGFloat=15
    var body: some View {
        ZStack{ RoundedRectangle(cornerRadius:8).fill(RPColor.primarySoft).frame(width:28,height:28); Image(systemName:system).font(.system(size:size, weight:.medium)).foregroundStyle(RPColor.primary)}
    }
}
struct CatalogEyebrow: View {
    var text:String
    var body: some View {
        Text(text).font(.system(size:10, weight:.bold, design:.monospaced)).tracking(1.0).foregroundStyle(RPColor.muted)
    }
}
