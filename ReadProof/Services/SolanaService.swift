import Foundation
import CryptoKit

// Solana Devnet — real RPC per https://solana.com/developers
// Wyłącznie Devnet: mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU, RPC https://api.devnet.solana.com
// Brak mock signature — wypłata tylko przez backend z SOLANA_PAYER_PRIVATE_KEY
final class SolanaService: ObservableObject {
    static let shared = SolanaService()
    @Published var lastTx: String?

    let devnetRPC = "https://api.devnet.solana.com"
    let explorerBase = "https://explorer.solana.com/tx/"

    func createProofHash(bookId: String, chapterId: String, wallet: String, timestamp: Date, score: Int) -> String {
        let input = "\(bookId)|\(chapterId)|\(wallet)|\(timestamp.timeIntervalSince1970)|\(score)"
        let hash = SHA256.hash(data: Data(input.utf8))
        return hash.map { String(format: "%02x", $0) }.joined().prefix(16).description
    }

    func checkDevnet() async -> Bool {
        var req = URLRequest(url: URL(string: devnetRPC)!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String:Any] = ["jsonrpc":"2.0","id":1,"method":"getHealth"]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 5
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            return (resp as? HTTPURLResponse)?.statusCode == 200
        } catch { return false }
    }
}
