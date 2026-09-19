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
    static let bg = Color(hex: "#FFFCF5")          // Paper
    static let card = Color.white
    static let line = Color(hex: "#E6DDC8")         // Rule
    static let line2 = Color(hex: "#EDE7D8")
    static let ink = Color(hex: "#0E1E2A")           // Expedition Ink
    static let muted = Color(hex: "#6B7B7F")         // Fog
    static let muted2 = Color(hex: "#9AA8A6")        // Mist
    // primaries
    static let primary = Color(hex: "#16423C")       // Field Green — primary actions
    static let primaryDark = Color(hex: "#0F2F2A")
    static let primaryLight = Color(hex: "#E6F2EE")
    static let primarySoft = Color(hex: "#EEF6F3")
    // signal — słaby pomarańczowy per request, tylko dla nagrody
    static let peach = Color(hex: "#FF8B4D")
    static let peachLight = Color(hex: "#FFF1E6")
    static let peachSoft = Color(hex: "#FFF6EE")
    static let success = Color(hex: "#16423C")
    static let successLight = Color(hex: "#E6F2EE")

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
