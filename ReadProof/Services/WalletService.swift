import Foundation
import UIKit

// Unified wallet — jeden interfejs na wszystkie Solana portfele + gotowy SDK hook (WalletConnect/Reown).
// Zamiast tylko Phantom, wspieramy: Phantom, Solflare, Backpack, Glow, Brave, MagicEden + WalletConnect + wklejenie adresu.
// Każdy portfel otwierany deeplinkiem / universal link; adres i tak wklejany lub zwracany via redirect_link (MVP).
// Dla pełnego Connect (szyfrowanie dApp) podmień `connectUrl` na flow z dapp keypair jak w docs Phantom/Solflare.

enum WalletProvider: String, CaseIterable, Identifiable {
    case phantom
    case solflare
    case backpack
    case glow
    case brave
    case magicEden
    case walletConnect
    case other // wklej adres ręcznie

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .phantom: return "Phantom"
        case .solflare: return "Solflare"
        case .backpack: return "Backpack"
        case .glow: return "Glow"
        case .brave: return "Brave Wallet"
        case .magicEden: return "Magic Eden"
        case .walletConnect: return "WalletConnect (300+ portfeli)"
        case .other: return "Inny — wklej adres"
        }
    }

    var icon: String {
        switch self {
        case .phantom: return "wallet.pass.fill"
        case .solflare: return "flame.fill"
        case .backpack: return "backpack.fill"
        case .glow: return "sparkles"
        case .brave: return "shield.lefthalf.fill"
        case .magicEden: return "sparkle"
        case .walletConnect: return "link"
        case .other: return "keyboard"
        }
    }

    var scheme: String? {
        switch self {
        case .phantom: return "phantom://"
        case .solflare: return "solflare://"
        case .backpack: return "backpack://"
        case .glow: return "glow://"
        case .brave: return "brave://"
        case .magicEden: return "magiceden://"
        case .walletConnect: return "wc://"
        case .other: return nil
        }
    }

    var appStoreURL: URL {
        switch self {
        case .phantom: return URL(string: "https://apps.apple.com/app/phantom-solana-wallet/id1598432977")!
        case .solflare: return URL(string: "https://apps.apple.com/app/solflare/id1580902717")!
        case .backpack: return URL(string: "https://apps.apple.com/app/backpack-wallet/id6445964121")!
        case .glow: return URL(string: "https://apps.apple.com/app/glow-solana-wallet/id1635711099")!
        case .brave: return URL(string: "https://apps.apple.com/app/brave-private-web-browser/id1052879175")!
        case .magicEden: return URL(string: "https://apps.apple.com/app/magic-eden-wallet/id6445840143")!
        case .walletConnect: return URL(string: "https://apps.apple.com/app/walletconnect/id1234567890")! // placeholder, WC to protokół nie app
        case .other: return URL(string: "https://solana.com/ecosystem/explore?categories=wallet")!
        }
    }

    // Universal link do v1/connect (Solana) — MVP: sam redirect, bez szyfrowania dapp keypair
    func connectURL(appUrl: String = "https://readproof.app", redirect: String = "readproof://wallet-callback") -> URL? {
        let encRedirect = redirect.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? redirect
        switch self {
        case .phantom:
            return URL(string: "https://phantom.app/ul/v1/connect?app_url=\(appUrl)&cluster=devnet&redirect_link=\(encRedirect)")
        case .solflare:
            return URL(string: "https://solflare.com/ul/v1/connect?app_url=\(appUrl)&cluster=devnet&redirect_link=\(encRedirect)")
        case .backpack:
            return URL(string: "https://backpack.app/ul/v1/connect?app_url=\(appUrl)&cluster=devnet&redirect_link=\(encRedirect)")
        case .glow:
            return URL(string: "https://glow.app/ul/v1/connect?app_url=\(appUrl)&cluster=devnet&redirect_link=\(encRedirect)")
        case .walletConnect:
            // Reown AppKit / WalletConnect v2 — wymaga projectId z https://cloud.reown.com
            // Zostawiamy hook: jeśli w Info.plist jest REOWN_PROJECT_ID, SDK go użyje; tu otwieramy wc deep link
            return URL(string: "wc://")
        default:
            return nil
        }
    }
}

enum WalletService {
    // Gdzie Reown/WalletConnect SDK wepniesz pełny flow:
    // 1. Dodaj SPM: https://github.com/reown-com/reown-swift (ReownAppKit)
    // 2. W AppDelegate: NetworkingService.projectId = "YOUR_REOWN_PROJECT_ID"
    // 3. Zamień open(_:) dla .walletConnect na AppKit.present()
    // Bez SDK ten fallback działa jako deeplink + wklejenie adresu.

    static func canOpen(_ provider: WalletProvider) -> Bool {
        guard let s = provider.scheme, let u = URL(string: s) else { return false }
        return UIApplication.shared.canOpenURL(u)
    }

    static func open(_ provider: WalletProvider) {
        if provider == .other { return }
        if provider == .walletConnect {
            // TODO: jeśli dodasz ReownAppKit, tu: AppKit.instance.present()
            // Na razie otwieramy WC playground / informację
            if let url = URL(string: "https://walletconnect.com/explorer?type=wallet&chains=solana%3AEt9A2oy8yGrD95w2Jw4Q7D2h2y3") {
                UIApplication.shared.open(url)
            }
            return
        }
        if let scheme = provider.scheme, let url = URL(string: scheme), UIApplication.shared.canOpenURL(url) {
            UIApplication.shared.open(url)
        } else if let connect = provider.connectURL() {
            UIApplication.shared.open(connect)
        } else {
            UIApplication.shared.open(provider.appStoreURL)
        }
    }

    static func isValidSolanaAddress(_ s: String) -> Bool {
        PhantomService.isValidSolanaAddress(s) // re-use tego samego sprawdzenia
    }
}

// backwards compat — stare wywołania PhantomService nadal działają
extension PhantomService {
    static func open(_ provider: WalletProvider = .phantom) { WalletService.open(provider) }
}
