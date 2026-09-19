import SwiftUI

// Minimal native iOS — słaby pomarańczowy (peach) + system SF, duzo bieli
enum RPColor {
    // tlo systemowe
    static let bg = Color(hex: "#F6F7F8")
    static let card = Color.white
    static let line = Color(hex: "#E8EAED")
    static let line2 = Color(hex: "#F0F2F3")
    // tekst
    static let ink = Color(hex: "#111418")
    static let muted = Color(hex: "#6B7280")
    static let muted2 = Color(hex: "#9CA3AF")
    // pomarancz slaby — primary peach
    static let primary = Color(hex: "#FF8B4D") // slaby pomarancz, nie neon
    static let primaryDark = Color(hex: "#E86F2C")
    static let primaryLight = Color(hex: "#FFF1E6")
    static let primarySoft = Color(hex: "#FFF6EE")
    // akcenty
    static let success = Color(hex: "#0F766E")
    static let successLight = Color(hex: "#ECFDF5")

    // compat aliasy (stary kod uzywal burgundy/amber)
    static let parchment = bg
    static let parchment2 = bg
    static let paper = card
    static let cream = primarySoft
    static let burgundy = primary
    static let burgundyDark = primaryDark
    static let burgundyLight = primaryLight
    static let gold = primary
    static let goldLight = primaryLight
    static let ink2 = ink
    static let warn = primary
    static let success2 = success
}

// Karta — biala, zaokraglona 16, cien bardzo delikatny
struct Card: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(RPColor.card)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .shadow(color: .black.opacity(0.05), radius: 10, x: 0, y: 4)
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(RPColor.line, lineWidth: 1))
    }
}
extension View {
    func card() -> some View { modifier(Card()) }
    func cardSoft() -> some View { self.background(RPColor.card).clipShape(RoundedRectangle(cornerRadius: 14)).shadow(color:.black.opacity(0.04), radius: 8, y: 2).overlay(RoundedRectangle(cornerRadius:14).stroke(RPColor.line, lineWidth:1)) }
}

// compat
extension RPColor {
    static let bg2 = bg
}
struct MonoPill: View {
    var text:String; var fg:Color=RPColor.muted; var bg:Color=Color.white; var border:Color=RPColor.line
    var body: some View {
        Text(text).font(.system(size:10, weight:.semibold, design:.rounded)).tracking(0.2)
            .padding(.horizontal,8).padding(.vertical,5)
            .background(bg).foregroundStyle(fg)
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(border, lineWidth:1))
            .clipShape(Capsule())
    }
}
struct Pill: View { var text:String; var color:Color=RPColor.primary; var body: some View { MonoPill(text:text, fg:color, bg:color.opacity(0.12), border:.clear)}}
struct ProgressBar: View {
    var value:Double; var tint:Color=RPColor.primary
    var body: some View {
        GeometryReader{ g in
            ZStack(alignment:.leading){
                Capsule().fill(Color(hex:"#EDEFF1"))
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
// male pomocnicze
struct SoftIcon: View {
    var system:String; var size:CGFloat=16
    var body: some View {
        ZStack{ RoundedRectangle(cornerRadius:8).fill(RPColor.primarySoft).frame(width:28,height:28); Image(systemName:system).font(.system(size:size, weight:.medium)).foregroundStyle(RPColor.primary)}
    }
}
