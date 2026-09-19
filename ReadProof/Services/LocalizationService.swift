import Foundation
import SwiftUI

enum AppLanguage: String, CaseIterable, Codable {
    case pl = "pl"
    case en = "en"

    var displayName: String {
        switch self {
        case .pl: return "Polski"
        case .en: return "English"
        }
    }

    var flag: String { self == .pl ? "🇵🇱" : "🇬🇧" }

    static var device: AppLanguage {
        let code = Locale.current.language.languageCode?.identifier ?? "pl"
        return code.hasPrefix("pl") ? .pl : .en
    }
}

final class LocalizationService: ObservableObject {
    static let shared = LocalizationService()

    @Published var current: AppLanguage {
        didSet {
            UserDefaults.standard.set(current.rawValue, forKey: "app_language")
            // propagate to backend header
            objectWillChange.send()
        }
    }

    init() {
        if let raw = UserDefaults.standard.string(forKey: "app_language"), let l = AppLanguage(rawValue: raw) {
            current = l
        } else {
            current = AppLanguage.device
        }
    }

    func t(_ pl: String, _ en: String) -> String { current == .pl ? pl : en }
}

// Convenience extension
extension View {
    func localizedEnv() -> some View {
        self.environmentObject(LocalizationService.shared)
    }
}
