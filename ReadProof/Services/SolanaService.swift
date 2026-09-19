import Foundation
import CryptoKit

// Solana Devnet — MVP mock with real architecture hook
// Real RPC can be added via jsonRPC to https://api.devnet.solana.com
final class SolanaService: ObservableObject {
    static let shared = SolanaService()
    @Published var lastTx: String?

    let devnetRPC = "https://api.devnet.solana.com"
    let explorerBase = "https://explorer.solana.com/tx/"

    // In real app: use Phantom deeplink or solana-swift SDK
    // For MVP: generate deterministic mock signature + proof hash

    func createProofHash(bookId: String, chapterId: String, wallet: String, timestamp: Date, score: Int) -> String {
        let input = "\(bookId)|\(chapterId)|\(wallet)|\(timestamp.timeIntervalSince1970)|\(score)"
        let hash = SHA256.hash(data: Data(input.utf8))
        return hash.map { String(format: "%02x", $0) }.joined().prefix(16).description
    }

    func mockSignature(for hash: String) -> String {
        // base58-ish mock 88 chars
        let chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
        var sig = ""
        var seed = hash.hashValue
        for _ in 0..<88 {
            seed = (seed &* 1103515245 &+ 12345) & 0x7fffffff
            let idx = abs(seed) % chars.count
            sig.append(chars[chars.index(chars.startIndex, offsetBy: idx)])
        }
        return sig
    }

    // Simulate reward tx
    func sendReward(to wallet: String, amount: String = "5 USDC", proofHash: String) async -> (sig: String, explorer: String) {
        // Simulate network delay
        try? await Task.sleep(nanoseconds: 900_000_000)
        let sig = mockSignature(for: proofHash)
        let explorer = "\(explorerBase)\(sig)?cluster=devnet"
        await MainActor.run { self.lastTx = sig }
        return (sig, explorer)
    }

    // Optional real devnet check (doesn't send funds, just verifies RPC reachable)
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
