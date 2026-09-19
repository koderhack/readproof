import SwiftUI

struct BackendHealthView: View {
    @ObservedObject private var backend = BackendService.shared
    @State private var testing = false
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(backend.isReachable ? Color.green : Color.red).frame(width: 8, height: 8)
            Text(backend.isReachable ? "Backend OK — \(backend.baseURL)" : "Backend offline — używam bundled JSON + mock")
                .font(.system(size: 9, design: .monospaced)).foregroundStyle(RPColor.muted2)
            Spacer()
            if testing { ProgressView().scaleEffect(0.7) }
        }
        .task { await check() }
        .onTapGesture { Task { await check() } }
    }
    func check() async {
        testing = true; _ = await backend.checkHealth(); testing = false
    }
}
