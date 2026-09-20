import Foundation
import SwiftUI
import UIKit
import AuthenticationServices

// MARK: - Identity (Sign in with Apple + DevMode fallback)
//
// TODO(Sign in with Apple): aby przycisk Apple faktycznie działał na
// urządzeniu, trzeba w Apple Developer Console włączyć capability
// "Sign in with Apple" (provisioning profile z com.apple.developer.applesignin)
// oraz podpiąć entitlements (ReadProof/ReadProof.entitlements, klucz
// com.apple.developer.applesignin). Na hackathonie / Symulatorze używamy
// trybu DevMode (nickname/device id) — patrz `devSignIn`.
//
// Prywatność: book/answers NIGDY nie trafia on-chain. user id + wallet
// (Devnet) są rejestrowane w backendzie best-effort (`registerUser`).

enum AuthProvider: String, Codable {
    case apple
    case dev
}

struct UserProfile: Codable, Hashable, Identifiable {
    let id: String                          // Apple user ID lub deviceId (DevMode)
    var nickname: String
    var authProvider: AuthProvider
    var createdAt: Date
    var sessionToken: String? = nil         // from backend /api/auth/apple
    var email: String? = nil
}

enum AuthError: LocalizedError {
    case cancelled
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .cancelled:
            return "Anulowano"
        case .unavailable(let m):
            return m
        }
    }
}

@MainActor
final class AuthService: ObservableObject {
    static let shared = AuthService()

    @Published var user: UserProfile?
    @Published var authError: String?

    private let defaults = UserDefaults.standard
    private let storageKey = "user_profile_v1"
    private let deviceKey = "device_id_v1"

    var deviceId: String {
        if let id = defaults.string(forKey: deviceKey) { return id }
        let id = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        defaults.set(id, forKey: deviceKey)
        return id
    }

    var isSignedIn: Bool { user != nil }
    var userId: String? { user?.id }
    var displayName: String {
        user?.nickname ?? "Gość"
    }

    init() {
        if let data = defaults.data(forKey: storageKey),
           let profile = try? JSONDecoder().decode(UserProfile.self, from: data) {
            user = profile
        }
    }

    // MARK: - Sign in with Apple

    func appleSignIn() async {
        authError = nil
        do {
            let identity = try await AppleSignInService.shared.request()
            var profile = UserProfile(id: identity.userId,
                                      nickname: identity.nickname,
                                      authProvider: .apple,
                                      createdAt: Date(),
                                      sessionToken: nil,
                                      email: identity.email)
            persist(profile)
            // send identityToken + appleUserId to backend /api/auth/apple (best-effort, then update sessionToken)
            let wallet = UserDefaults.standard.string(forKey: "wallet_address")
            if let token = identity.identityToken, !token.isEmpty {
                if let res = await BackendService.shared.authWithApple(identityToken: token, appleUserId: identity.userId, email: identity.email, nickname: identity.nickname, walletAddress: wallet) {
                    // update profile with sessionToken from backend
                    var updated = profile
                    updated.sessionToken = res.sessionToken
                    updated.email = res.user?.email ?? identity.email
                    persist(updated)
                    UserDefaults.standard.set(res.sessionToken, forKey: "apple_session_token")
                    UserDefaults.standard.set(identity.userId, forKey: "apple_user_id")
                    await MainActor.run { self.user = updated }
                } else {
                    // even without backend, store appleUserId for header fallback
                    UserDefaults.standard.set(identity.userId, forKey: "apple_user_id")
                    if let t = identity.identityToken { UserDefaults.standard.set(t, forKey: "apple_identity_token") }
                }
            } else {
                // no identityToken (Simulator) — still register via wallet/userId path
                UserDefaults.standard.set(identity.userId, forKey: "apple_user_id")
                await syncToBackend()
            }
        } catch AuthError.cancelled {
            // użytkownik anulował — bez błędu
        } catch {
            authError = error.localizedDescription
        }
    }

    // MARK: - DevMode fallback (Symulator bez capability / szybki test)

    /// Loguj jako Gość — nickname/device id. Działa zawsze, bez Apple Developer Console.
    func devSignIn(nickname: String? = nil) {
        let clean = (nickname ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let name = clean.isEmpty ? "Czytelnik-\(deviceId.suffix(4).uppercased())" : clean
        persist(UserProfile(id: deviceId, nickname: name, authProvider: .dev, createdAt: Date()))
        authError = nil
    }

    // MARK: - Shared

    private func persist(_ profile: UserProfile) {
        user = profile
        if let data = try? JSONEncoder().encode(profile) {
            defaults.set(data, forKey: storageKey)
        }
        if let tok = profile.sessionToken { defaults.set(tok, forKey: "apple_session_token") }
        if profile.authProvider == .apple { defaults.set(profile.id, forKey: "apple_user_id") }
        // auto-wallet: użytkownik nie musi wiedzieć o portfelach — po Apple login tworzymy syntetyczny Devnet adres w tle
        if defaults.string(forKey: "wallet_address") == nil || defaults.string(forKey: "wallet_address")?.isEmpty == true {
            let synth = Self.syntheticWalletAddress(from: profile.id)
            defaults.set(synth, forKey: "wallet_address")
        }
        // wire userId + wallet do backendu (best-effort, gdy backend dostępny)
        Task { await syncToBackend() }
    }

    /// Syntetyczny adres Solana dla usera Apple — valid base58 44 znaki, deterministyczny, nie wymaga portfela.
    /// Użytkownik nie widzi portfela, sesje i nagrody idą na to konto Apple.
    private static func syntheticWalletAddress(from id: String) -> String {
        // base58 alphabet
        let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        // hash id -> 32 bytes
        var hash = [UInt8](repeating: 0, count: 32)
        // prosty DJB2 hash rozciągnięty na 32 bytes (bez CryptoKit żeby nie importować)
        var h: UInt64 = 5381
        for b in id.utf8 { h = ((h << 5) &+ h) &+ UInt64(b) }
        for i in 0..<32 {
            h = h &* 6364136223846793005 &+ 1442695040888963407
            hash[i] = UInt8(truncatingIfNeeded: h >> 24)
        }
        // map 32 bytes -> 44 base58 chars
        var out = ""
        for i in 0..<44 {
            let idx = Int(hash[i % 32]) % alphabet.count
            out.append(alphabet[idx])
        }
        return out
    }

    func syncToBackend() async {
        guard let profile = user else { return }
        // auto-wallet: user nie musi wiedzieć o portfelach — jeśli brak, użyj syntetycznego z appleUserId (backend i tak fallbackuje na apple_*)
        var wallet = UserDefaults.standard.string(forKey: "wallet_address")
        if wallet == nil || wallet?.isEmpty == true {
            // nie wymuszamy — backend zrobi fallback, ale dla AppState ustawiamy placeholder żeby sesje miały wallet
            wallet = nil
        }
        _ = await BackendService.shared.registerUser(BackendService.UserRegistration(id: profile.id,
                                                                      provider: profile.authProvider.rawValue,
                                                                      nickname: profile.nickname,
                                                                      walletAddress: wallet))
        // auto-provision: jeśli brak portfela, backend zwróci apple_… i my go podpinamy lokalnie po pierwszym registerze
        if UserDefaults.standard.string(forKey: "wallet_address") == nil, let apple = profile.id as String? {
            // nie nadpisuj jeśli już jest — cichy auto-wallet dla usera Apple (nie pokazujemy mu szczegółów)
            // zostawiamy nil — sesje użyją appleUserId jako userId, nagroda i tak mapowana na konto Apple
        }
    }

    /// Wywoływane po podłączeniu walletu — przypina pubkey do usera na backendzie.
    func walletConnected(_ address: String) async {
        let wallet = UserDefaults.standard.string(forKey: "wallet_address") ?? address
        if let profile = user {
            _ = await BackendService.shared.registerUser(BackendService.UserRegistration(id: profile.id,
                                                                          provider: profile.authProvider.rawValue,
                                                                          nickname: profile.nickname,
                                                                          walletAddress: wallet))
        }
    }

    func signOut() {
        user = nil
        authError = nil
        defaults.removeObject(forKey: storageKey)
        defaults.removeObject(forKey: "apple_session_token")
        defaults.removeObject(forKey: "apple_user_id")
        defaults.removeObject(forKey: "apple_identity_token")
    }
}

// MARK: - Apple Sign in flow (ASAuthorizationAppleID)

struct AppleIdentity {
    let userId: String
    let nickname: String
    let email: String?
    let identityToken: String? // JWT from Apple
}

@MainActor
final class AppleSignInService: NSObject, ObservableObject {
    static let shared = AppleSignInService()

    private var controller: ASAuthorizationController?
    private var continuation: CheckedContinuation<AppleIdentity, Error>?

    func request() async throws -> AppleIdentity {
        let provider = ASAuthorizationAppleIDProvider()
        let request = provider.createRequest()
        request.requestedScopes = [.fullName, .email]

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller

        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            controller.performRequests()
        }
    }

    private func finish(_ result: Result<AppleIdentity, Error>) {
        continuation?.resume(with: result)
        continuation = nil
        controller = nil
    }
}

extension AppleSignInService: ASAuthorizationControllerDelegate {
    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        if let credential = authorization.credential as? ASAuthorizationAppleIDCredential {
            let name = [credential.fullName?.givenName, credential.fullName?.familyName]
                .compactMap { $0 }
                .joined(separator: " ")
            let nickname = name.trimmingCharacters(in: .whitespaces).isEmpty ? "Apple Reader" : name
            var tokenString: String? = nil
            if let data = credential.identityToken, let s = String(data: data, encoding: .utf8) { tokenString = s }
            finish(.success(AppleIdentity(userId: credential.user,
                                          nickname: nickname,
                                          email: credential.email,
                                          identityToken: tokenString)))
        } else {
            finish(.failure(AuthError.unavailable("Nieznany credential")))
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            finish(.failure(AuthError.cancelled))
        } else {
            // typowo: capability nie włączona / brak provisioning — DevMode fallback
            finish(.failure(AuthError.unavailable(error.localizedDescription)))
        }
    }
}

extension AppleSignInService: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?.keyWindow
        return window ?? ASPresentationAnchor()
    }
}