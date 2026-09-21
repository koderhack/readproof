import Foundation
import SwiftUI

/// Rola użytkownika — jeden system, różne nawigacje i stany.
enum UserRole: String, CaseIterable, Codable {
    case student
    case reader
    case teacher
}

@MainActor
final class AppState: ObservableObject {
    @Published var wallet = WalletState(address: UserDefaults.standard.string(forKey: "wallet_address"), balance: "0.00 USDC (Devnet)", history: [])
    @Published var proofs: [ReadingProof] = []
    @Published var path = NavigationPath()
    @Published var role: UserRole? = UserRole(rawValue: UserDefaults.standard.string(forKey: "user_role") ?? "")

    init() {
        if let data = UserDefaults.standard.data(forKey: "proofs_v1"),
           let decoded = try? JSONDecoder().decode([ReadingProof].self, from: data) {
            proofs = decoded
            wallet.history = decoded
        }
        // fake balance when connected
        if wallet.isConnected { wallet.balance = "12.50 USDC (Devnet)" }
    }

    func connectWallet(address: String) {
        let addr = address.trimmingCharacters(in: .whitespaces)
        guard !addr.isEmpty else { return }
        wallet.address = addr
        wallet.balance = "12.50 USDC (Devnet)"
        UserDefaults.standard.set(addr, forKey: "wallet_address")
    }

    func disconnect() {
        wallet.address = nil
        wallet.balance = "0.00 USDC (Devnet)"
        UserDefaults.standard.removeObject(forKey: "wallet_address")
    }

    // MARK: - Role (student / reader / teacher)

    func setRole(_ role: UserRole) {
        self.role = role
        UserDefaults.standard.set(role.rawValue, forKey: "user_role")
    }

    func clearRole() {
        role = nil
        UserDefaults.standard.removeObject(forKey: "user_role")
    }

    func saveProof(_ proof: ReadingProof) {
        proofs.insert(proof, at: 0)
        wallet.history = proofs
        if let data = try? JSONEncoder().encode(proofs) {
            UserDefaults.standard.set(data, forKey: "proofs_v1")
        }
    }

    func progress(for book: Book) -> Double {
        let done = Set(proofs.filter { $0.bookId == book.id && $0.status == .verified }.map { $0.chapterId }).count
        return Double(done) / Double(max(book.chapters.count,1))
    }

    func isChapterVerified(_ chapterId: String) -> Bool {
        proofs.contains { $0.chapterId == chapterId && Scoring.isPassing(score: $0.score) }
    }
}
