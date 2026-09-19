import Foundation
import UIKit

enum PhantomService {
    static let phantomScheme = "phantom://"
    static let phantomUL = "https://phantom.app/ul/"

    /// Próbuje otworzyć Phantom (iOS). Jeśli niezainstalowany, otwiera App Store.
    static func openPhantom() {
        let appStore = URL(string: "https://apps.apple.com/app/phantom-solana-wallet/id1598432977")!
        if let url = URL(string: phantomScheme), UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        } else {
            UIApplication.shared.open(appStore)
        }
    }

    /// Phantom deeplink connect (Solana) — wymaga backendu z encryption, dla MVP otwieramy po prostu Phantom.
    /// Doc: https://docs.phantom.com/solana/connecting-to-phantom
    static func connectUrl(cluster: String = "devnet", appUrl: String = "https://readproof.app", redirect: String = "readproof://phantom-callback") -> URL? {
        // v1/connect wymaga dapp encryption keypair — dla MVP upraszczamy do otwarcia Phantom,
        // a adres wkleja user manualnie. Tu zostawiamy URL do przyszłego pełnego Connect.
        // Przykład pełny: https://phantom.app/ul/v1/connect?app_url=...&dapp_encryption_public_key=...&cluster=devnet&redirect_link=...
        return URL(string: "\(phantomUL)v1/connect?app_url=\(appUrl)&cluster=\(cluster)&redirect_link=\(redirect.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed) ?? redirect)")
    }

    /// Walidacja adresu Solana (base58, 32-44 chars)
    static func isValidSolanaAddress(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (32...44).contains(t.count) else { return false }
        let alphabet = CharacterSet(charactersIn: "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        return t.unicodeScalars.allSatisfy { alphabet.contains($0) }
    }
}
