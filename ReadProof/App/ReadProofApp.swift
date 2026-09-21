import SwiftUI

@main
struct ReadProofApp: App {
    @StateObject private var store = ChallengeStore()
    @StateObject private var appState = AppState()
    @StateObject private var solana = SolanaService.shared
    @StateObject private var jev = JevService.shared
    @StateObject private var loc = LocalizationService.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(appState)
                .environmentObject(solana)
                .environmentObject(jev)
                .environmentObject(loc)
                .onAppear { Task { _ = await BackendService.shared.checkHealth() } }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService

    var body: some View {
        Group {
            if let role = appState.role {
                RoleTabsView(role: role)
            } else {
                ChooseRoleView()
            }
        }
        .tint(RPColor.primary)
    }
}

extension Color {
    init(hex: String) {
        let h = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0; Scanner(string: h).scanHexInt64(&int)
        let a, r, g, b: UInt64
        switch h.count {
        case 3: (a,r,g,b) = (255, (int>>8)*17, (int>>4 & 0xF)*17, (int & 0xF)*17)
        case 6: (a,r,g,b) = (255, int>>16, int>>8 & 0xFF, int & 0xFF)
        case 8: (a,r,g,b) = (int>>24, int>>16 & 0xFF, int>>8 & 0xFF, int & 0xFF)
        default: (a,r,g,b) = (255,0,0,0)
        }
        self.init(.sRGB, red: Double(r)/255, green: Double(g)/255, blue: Double(b)/255, opacity: Double(a)/255)
    }
}
