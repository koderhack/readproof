import WidgetKit
import SwiftUI
import ActivityKit

struct ReadProofLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ReadingSessionAttributes.self) { context in
            // Lock screen
            VStack(alignment:.leading, spacing:6){
                HStack{
                    Image(systemName:"books.vertical.fill").foregroundStyle(Color(hex:"#58CC02"))
                    Text("\(context.state.bookTitle) — \(context.state.chapterTitle)").font(.caption.weight(.semibold)).lineLimit(1)
                    Spacer()
                    Text("\(context.state.completed)/\(context.state.total)").font(.caption2.weight(.bold)).padding(.horizontal,6).padding(.vertical,3).background(Color(hex:"#58CC02")).foregroundStyle(.white).clipShape(Capsule())
                }
                ProgressView(value: context.state.progress).tint(Color(hex:"#58CC02"))
                HStack{
                    Label(context.state.status, systemImage:"timer").font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    if context.state.nextUnlockIn > 0 {
                        Text("następne za \(context.state.nextUnlockIn)s").font(.caption2.monospaced()).foregroundStyle(.secondary)
                    } else {
                        Text("odkryte").font(.caption2.weight(.bold)).foregroundStyle(Color(hex:"#58CC02"))
                    }
                }
            }.padding(14)
            .activityBackgroundTint(Color.white)
            .activitySystemActionForegroundColor(Color(hex:"#58CC02"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading){
                    HStack{
                        Image(systemName:"books.vertical.fill").foregroundStyle(Color(hex:"#58CC02"))
                        Text("\(context.state.completed)/\(context.state.total)").font(.caption.weight(.bold))
                    }
                }
                DynamicIslandExpandedRegion(.center){
                    VStack{
                        Text(context.state.bookTitle).font(.caption2.weight(.semibold)).lineLimit(1)
                        ProgressView(value: context.state.progress).tint(Color(hex:"#58CC02"))
                    }
                }
                DynamicIslandExpandedRegion(.trailing){
                    if context.state.nextUnlockIn > 0 {
                        Text("\(context.state.nextUnlockIn)s").font(.caption2.monospaced()).foregroundStyle(.secondary)
                    } else {
                        Image(systemName:"checkmark.circle.fill").foregroundStyle(Color(hex:"#58CC02"))
                    }
                }
            } compactLeading: {
                Image(systemName:"books.vertical.fill").foregroundStyle(Color(hex:"#58CC02"))
            } compactTrailing: {
                Text("\(context.state.completed)/\(context.state.total)").font(.caption2.weight(.bold))
            } minimal: {
                Image(systemName:"book.fill").foregroundStyle(Color(hex:"#58CC02"))
            }
            .widgetURL(URL(string:"readproof://session/\(context.attributes.sessionId)"))
            .keylineTint(Color(hex:"#58CC02"))
        }
    }
}

extension Color {
    init(hex:String){
        let h = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int:UInt64=0; Scanner(string:h).scanHexInt64(&int)
        let a,r,g,b:UInt64
        switch h.count{
        case 3: (a,r,g,b)=(255,(int>>8)*17,(int>>4 & 0xF)*17,(int & 0xF)*17)
        case 6: (a,r,g,b)=(255,int>>16,int>>8 & 0xFF,int & 0xFF)
        case 8: (a,r,g,b)=(int>>24,int>>16 & 0xFF,int>>8 & 0xFF,int & 0xFF)
        default: (a,r,g,b)=(255,0,0,0)
        }
        self.init(.sRGB, red:Double(r)/255, green:Double(g)/255, blue:Double(b)/255, opacity:Double(a)/255)
    }
}
