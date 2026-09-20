import Foundation

// BackendService — proxy do lokalnego Node backendu (Express + SQLite + OpenRouter free + Jev)
// Fallback: jeśli backend nieosiągalny, używa bundled JSON i mock Jev
// Dla lokalnych testów: https://127.0.0.1:32288 (Simulator) — TLS self-signed z backend/certs/
// Dla Frog VPS: https://frog02.mikr.us:32287 (https proxy -> :32288)
// Konfiguracja w UserDefaults "backend_url"

final class BackendService: ObservableObject {
    static let shared = BackendService()

    @Published var isReachable: Bool = false
    @Published var lastError: String?

    var baseURL: String {
        get {
            let stored = UserDefaults.standard.string(forKey: "backend_url") ?? ""
            if !stored.isEmpty {
                let s = stored.trimmingCharacters(in: .whitespacesAndNewlines)
                if s == "http://127.0.0.1:32288" {
                    UserDefaults.standard.set("https://127.0.0.1:32288", forKey: "backend_url")
                    return "https://127.0.0.1:32288"
                }
                return s
            }
            // Telefon (device) → public Frog, Simulator → localhost https (szyfrowane)
            #if targetEnvironment(simulator)
            return "https://127.0.0.1:32288"
            #else
            return "http://frog02.mikr.us:32287"
            #endif
        }
        set { UserDefaults.standard.set(newValue, forKey: "backend_url") }
    }

    private var api: String { baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL }
    var langHeader: String { LocalizationService.shared.current.rawValue }
    var devMode: Bool { UserDefaults.standard.bool(forKey: "admin_dev_mode") }
    var devPassword: String { UserDefaults.standard.string(forKey: "admin_dev_password") ?? "" }
    var appleSessionToken: String? { UserDefaults.standard.string(forKey: "apple_session_token") }
    // nonisolated — UserDefaults, nie AuthService (MainActor) żeby nie było isolation error
    var appleUserIdStored: String? {
        if let s = UserDefaults.standard.string(forKey: "apple_user_id"), !s.isEmpty { return s }
        if let data = UserDefaults.standard.data(forKey: "user_profile_v1"),
           let p = try? JSONDecoder().decode(UserProfile.self, from: data), !p.id.isEmpty { return p.id }
        return nil
    }
    private func attachAuthHeaders(to req: inout URLRequest){
        if let tok = appleSessionToken, !tok.isEmpty { req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization") }
        if let uid = appleUserIdStored, !uid.isEmpty { req.setValue(uid, forHTTPHeaderField: "X-User-Id"); req.setValue(uid, forHTTPHeaderField: "X-Apple-User") }
    }

    // szyfrowane połączenie — self-signed na localhost akceptujemy w dev (jak NSAllowsArbitraryLoads)
    private lazy var session: URLSession = {
        let delegate = InsecureTrustDelegate()
        return URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
    }()
    private var useInsecureSession: Bool {
        // self-signed na localhost + LAN IP (172.* / 192.168.* / 10.*) — tylko dev
        if baseURL.contains("127.0.0.1") || baseURL.contains("localhost") { return true }
        if baseURL.contains("172.20.") || baseURL.contains("192.168.") || baseURL.contains("10.0.") { return true }
        return false
    }

    private func data(for req: URLRequest) async throws -> (Data, URLResponse) {
        if useInsecureSession { return try await session.data(for: req) }
        return try await URLSession.shared.data(for: req)
    }
    private func data(from url: URL) async throws -> (Data, URLResponse) {
        var req = URLRequest(url: url); req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        return try await data(for: req)
    }

    // MARK: - Health — zaszyfrowane https, fallback http :32289 dla self-signed/dev
    func checkHealth() async -> Bool {
        // próba 1: aktualny baseURL (https)
        if await _checkHealth(urlString: "\(api)/health") { return true }
        // próba 2: fallback http na :32289 jeśli https nieosiągalne (dev cert mismatch)
        let fallback = api.replacingOccurrences(of: "https://127.0.0.1:32288", with: "http://127.0.0.1:32289")
        if fallback != api, await _checkHealth(urlString: "\(fallback)/health") {
            await MainActor.run { self.lastError = "Używam fallback http :32289 (szyfrowanie na :32288 chwilowo niedostępne)" }
            return true
        }
        await MainActor.run { self.isReachable = false }
        return false
    }
    private func _checkHealth(urlString: String) async -> Bool {
        guard let url = URL(string: urlString) else { return false }
        var req = URLRequest(url: url); req.timeoutInterval = 4
        req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        do {
            let (d, r) = try await data(for: req)
            let ok = (r as? HTTPURLResponse)?.statusCode == 200
            if ok, let j = try? JSONSerialization.jsonObject(with: d) as? [String:Any], j["status"] as? String == "ok" {
                await MainActor.run { self.isReachable = true; self.lastError = nil }
                return true
            }
        } catch { await MainActor.run { self.lastError = error.localizedDescription } }
        return false
    }

    // MARK: - Books
    func fetchBooks() async -> [Book]? {
        guard let url = URL(string: "\(api)/api/books") else { return nil }
        var req = URLRequest(url: url); req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        do { let (d, r) = try await data(for: req); guard (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }; return try JSONDecoder().decode([Book].self, from: d) } catch { return nil }
    }

    func fetchChallenges(chapterId: String, pick: Int = 5) async -> [Challenge]? {
        guard let url = URL(string: "\(api)/api/challenges/\(chapterId)?pick=\(pick)&lang=\(langHeader)") else { return nil }
        var req = URLRequest(url: url); req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        do { let (d, r) = try await data(for: req); guard (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }; return try JSONDecoder().decode([Challenge].self, from: d) } catch { return nil }
    }

    func fetchChallengeSet(bookId: String, chapterId: String) async -> [Challenge]? {
        guard let url = URL(string: "\(api)/api/books/\(bookId)/chapters/\(chapterId)/challenge?lang=\(langHeader)") else { return nil }
        var req = URLRequest(url: url); req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        do { let (d, r) = try await data(for: req); guard (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }; if let wrapper = try? JSONDecoder().decode(ChallengeSetWrapper.self, from: d) { return wrapper.challenges }; return try JSONDecoder().decode([Challenge].self, from: d) } catch { return nil }
    }

    struct ChallengeSetWrapper: Codable { let challenges: [Challenge]; let chapterId: String; let count: Int? }

    // MARK: - Jev via backend
    func evaluateViaBackend(question: String, expectedMeaning: String, userAnswer: String, context: String) async -> JevVerdict? {
        guard let url = URL(string: "\(api)/api/evaluate") else { return nil }
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.setValue(langHeader, forHTTPHeaderField: "X-Lang"); req.timeoutInterval = 12
        let body: [String:String] = ["question": question, "expectedMeaning": expectedMeaning, "userAnswer": userAnswer, "context": context]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (d, r) = try await data(for: req)
            guard (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(JevVerdict.self, from: d)
        } catch { return nil }
    }

    // MARK: - Proofs
    func submitProof(bookId: String, chapterId: String, challenges: [Challenge], answers: [String: UserAnswer], walletAddress: String?, userId: String? = nil) async -> ReadingProof? {
        guard let url = URL(string: "\(api)/api/proofs") else { return nil }
        var req = URLRequest(url: url); req.httpMethod="POST"; req.setValue("application/json", forHTTPHeaderField:"Content-Type"); req.setValue(langHeader, forHTTPHeaderField:"X-Lang"); req.timeoutInterval = 15
        attachAuthHeaders(to: &req)
        var ansMap:[String:Any] = [:]
        for (k,v) in answers {
            switch v {
            case .single(let i): ansMap[k]=i
            case .multiple(let s): ansMap[k]=Array(s)
            case .text(let t): ansMap[k]=t
            case .ordered(let o): ansMap[k]=o
            case .matched(let m): ansMap[k]=m.mapValues{$0}
            }
        }
        let payload:[String:Any]=["bookId":bookId,"chapterId":chapterId,"challenges": challenges.map{ try! JSONEncoder().encode($0) }.map{ try! JSONSerialization.jsonObject(with: $0) },"answers": ansMap,"walletAddress": walletAddress as Any,"userId": userId as Any]
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        do {
            let (d, r)=try await data(for:req)
            guard (r as? HTTPURLResponse)?.statusCode==200 else { return nil }
            return try JSONDecoder().decode(ReadingProof.self, from: d)
        } catch { return nil }
    }

    // MARK: - Users (wire userId + wallet)
    struct UserRegistration: Codable {
        let id: String
        let provider: String
        let nickname: String
        let walletAddress: String?
    }
    struct UserStats: Codable {
        let id: String
        let nickname: String?
        let provider: String?
        let walletAddress: String?
        let totalProofs: Int
        let verifiedProofs: Int
        let rewardsClaimed: Int
    }
    /// Upsert profilu (userId + wallet) na backendzie — best-effort, nie blokuje UI.
    @discardableResult
    func registerUser(_ r: UserRegistration) async -> UserStats? {
        guard let url = URL(string: "\(api)/api/users") else { return nil }
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(langHeader, forHTTPHeaderField: "X-Lang"); req.timeoutInterval = 6
        req.httpBody = try? JSONEncoder().encode(r)
        do {
            let (d, resp) = try await data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try? JSONDecoder().decode(UserStats.self, from: d)
        } catch { return nil }
    }
    func fetchUser(id: String) async -> UserStats? {
        guard let url = URL(string: "\(api)/api/users/\(id.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed) ?? id)") else { return nil }
        var req = URLRequest(url: url); req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        do { let (d, r) = try await data(for: req); guard (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }; return try? JSONDecoder().decode(UserStats.self, from: d) } catch { return nil }
    }
    func fetchProofs(userId: String? = nil, wallet: String? = nil) async -> [ReadingProof]? {
        var qs: [String] = []
        if let u = userId ?? appleUserIdStored, !u.isEmpty { qs.append("userId=\(u.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed) ?? u)") }
        if let w = wallet, !w.isEmpty { qs.append("wallet=\(w.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed) ?? w)") }
        let q = qs.isEmpty ? "" : "?" + qs.joined(separator: "&")
        guard let url = URL(string: "\(api)/api/proofs\(q)") else { return nil }
        var req = URLRequest(url: url); req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        attachAuthHeaders(to: &req)
        do { let (d, r) = try await data(for: req); guard (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }; return try JSONDecoder().decode([ReadingProof].self, from: d) } catch { return nil }
    }

    // MARK: - Apple Auth (Sign in with Apple -> backend)
    struct AppleAuthRequest: Codable { let identityToken: String?; let appleUserId: String; let email: String?; let nickname: String?; let walletAddress: String? }
    struct AppleAuthResponse: Codable { let ok: Bool; let user: AppleUser?; let sessionToken: String; let provider: String? }
    struct AppleUser: Codable { let id: String?; let appleUserId: String?; let nickname: String?; let email: String?; let walletAddress: String?; let provider: String?; let sessionToken: String? }
    @discardableResult
    func authWithApple(identityToken: String?, appleUserId: String, email: String?, nickname: String?, walletAddress: String?) async -> AppleAuthResponse? {
        guard let url = URL(string: "\(api)/api/auth/apple") else { return nil }
        var req = URLRequest(url: url); req.httpMethod="POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(langHeader, forHTTPHeaderField: "X-Lang"); req.timeoutInterval = 10
        let body = AppleAuthRequest(identityToken: identityToken, appleUserId: appleUserId, email: email, nickname: nickname, walletAddress: walletAddress)
        req.httpBody = try? JSONEncoder().encode(body)
        do{
            let (d,resp) = try await data(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode==200 else { print("[appleAuth] status", (resp as? HTTPURLResponse)?.statusCode ?? 0, String(data:d,encoding:.utf8) ?? ""); return nil }
            let decoded = try JSONDecoder().decode(AppleAuthResponse.self, from: d)
            if let tok = decoded.sessionToken as String? { UserDefaults.standard.set(tok, forKey: "apple_session_token") }
            return decoded
        }catch{ print("[appleAuth] error", error); return nil }
    }

    // MARK: - Reading Sessions (staged, anti-ChatGPT)
    struct SessionStartResponse: Codable {
        let id: String
        let walletAddress: String
        let bookId: String
        let chapterId: String
        let startAt: String
        let expectedReadingMin: Int
        let challenges: [SessionChallenge]
        let poolSize: Int?
    }
    struct SessionChallenge: Codable, Identifiable {
        let id: String
        let type: ChallengeType?
        let releaseAt: String?
        let releaseAfterSec: Int?
        let locked: Bool?
        let question: String?
        let context: String?
        let options: [String]?
        let correctAnswer: Int?
        let correctAnswers: [Int]?
        let expectedMeaning: String?
        let items: [String]?
        let correctOrder: [Int]?
        let pairs: [MatchPair]?
        let statements: [String]?
        let errorIndex: Int?
        let difficulty: String?
        let hint: String?
    }
    func startSession(bookId: String, chapterId: String, walletAddress: String, userId: String? = nil) async throws -> SessionStartResponse {
        guard let url = URL(string:"\(api)/api/sessions/start") else { throw GenError.badURL }
        var req = URLRequest(url:url); req.httpMethod="POST"; req.setValue("application/json", forHTTPHeaderField:"Content-Type"); req.setValue(langHeader, forHTTPHeaderField:"X-Lang")
        if devMode { req.setValue("1", forHTTPHeaderField:"X-Dev-Mode"); req.setValue(devPassword, forHTTPHeaderField:"X-Dev-Password") }
        attachAuthHeaders(to: &req)
        // prefer explicit userId param, else stored Apple id (nonisolated via UserDefaults)
        let effectiveUserId = userId ?? appleUserIdStored
        var body: [String: Any] = ["bookId":bookId,"chapterId":chapterId,"walletAddress":walletAddress, "devBypass": devMode, "devPassword": devPassword]
        if let u = effectiveUserId, !u.isEmpty { body["userId"] = u; req.setValue(u, forHTTPHeaderField: "X-User-Id") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (d,r)=try await data(for:req)
        if let http = r as? HTTPURLResponse, http.statusCode != 200 {
            // 429 = blokada po oszukanej / błędnej próbie — zwróć czas, nie goły JSON
            if http.statusCode == 429 {
                let j = (try? JSONSerialization.jsonObject(with:d) as? [String:Any]) ?? [:]
                let retryAfter = (j["retryAfter"] as? NSNumber)?.doubleValue ?? 1800
                let until: Date? = Self.isoDate(j["blockedUntil"] as? String) ?? (retryAfter > 0 ? Date().addingTimeInterval(retryAfter) : nil)
                throw GenError.cooldown(retryAfter: retryAfter, blockedUntil: until)
            }
            throw GenError.api(String(data:d, encoding:.utf8) ?? "start failed")
        }
        return try JSONDecoder().decode(SessionStartResponse.self, from:d)
    }
    static func isoDate(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        let f1 = ISO8601DateFormatter(); f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let f2 = ISO8601DateFormatter(); f2.formatOptions = [.withInternetDateTime]
        return f1.date(from: s) ?? f2.date(from: s)
    }
    func getSession(id: String) async -> SessionStartResponse? {
        guard let url = URL(string:"\(api)/api/sessions/\(id)") else { return nil }
        var req = URLRequest(url:url); req.setValue(langHeader, forHTTPHeaderField:"X-Lang")
        do{ let (d,r)=try await data(for:req); guard (r as? HTTPURLResponse)?.statusCode==200 else { return nil }; return try JSONDecoder().decode(SessionStartResponse.self, from:d)}catch{return nil}
    }
    func answerSession(sessionId: String, challengeId: String, answer: Any) async -> Bool {
        (await answerSessionDetailed(sessionId: sessionId, challengeId: challengeId, answer: answer)) != nil
    }
    struct AnswerResult: Codable { let challengeId: String; let correct: Bool; let jev: JevVerdict? }
    func answerSessionDetailed(sessionId: String, challengeId: String, answer: Any) async -> AnswerResult? {
        guard let url = URL(string:"\(api)/api/sessions/\(sessionId)/answer") else { return nil }
        var req = URLRequest(url:url); req.httpMethod="POST"; req.setValue("application/json", forHTTPHeaderField:"Content-Type"); req.setValue(langHeader, forHTTPHeaderField:"X-Lang")
        attachAuthHeaders(to: &req)
        req.httpBody = try? JSONSerialization.data(withJSONObject:["challengeId":challengeId,"answer":answer])
        do{ let (d,r)=try await data(for:req); guard (r as? HTTPURLResponse)?.statusCode==200 else { return nil }; return try JSONDecoder().decode(AnswerResult.self, from:d) }catch{return nil}
    }
    func flagSession(sessionId: String, type: String) async {
        guard let url = URL(string:"\(api)/api/sessions/\(sessionId)/flag") else { return }
        var req = URLRequest(url:url); req.httpMethod="POST"; req.setValue("application/json", forHTTPHeaderField:"Content-Type"); req.setValue(langHeader, forHTTPHeaderField:"X-Lang")
        attachAuthHeaders(to: &req)
        req.httpBody = try? JSONSerialization.data(withJSONObject:["type":type])
        _ = try? await data(for:req)
    }
    func completeSession(sessionId: String, endEarly: Bool = false) async -> ReadingProof? {
        guard let url = URL(string:"\(api)/api/sessions/\(sessionId)/complete?fail=\(endEarly ? 1 : 0)") else { return nil }
        var req = URLRequest(url:url); req.httpMethod="POST"; req.setValue(langHeader, forHTTPHeaderField:"X-Lang")
        attachAuthHeaders(to: &req)
        req.setValue("1", forHTTPHeaderField:"X-Dev-Mode"); req.setValue(devPassword, forHTTPHeaderField:"X-Dev-Password")
        do{
            let (d,r)=try await data(for:req)
            if let http = r as? HTTPURLResponse, http.statusCode != 200 {
                let msg = String(data:d, encoding:.utf8) ?? "complete failed \(http.statusCode)"
                await MainActor.run { self.lastError = msg }
                print("[complete] backend \(http.statusCode): \(msg)")
                return nil
            }
            let j = try JSONSerialization.jsonObject(with:d) as? [String:Any]
            if let p = j?["proof"] as? [String:Any]{
                let data = try JSONSerialization.data(withJSONObject:p)
                // Log raw proof przy błędzie decode — klasyczny "isn't in the correct format" to timestamp/status
                do {
                    let dec = JSONDecoder()
                    // nie ustawiamy dateDecodingStrategy — ReadingProof.init(from:) jest tolerancyjny na String ISO8601
                    return try dec.decode(ReadingProof.self, from:data)
                } catch {
                    let raw = String(data:data, encoding:.utf8) ?? "<no utf8>"
                    print("[complete] decode failed: \(error) raw=\(raw)")
                    await MainActor.run { self.lastError = "Decode: \(error.localizedDescription) raw:\(raw.prefix(300))" }
                    return nil
                }
            }
            return nil
        }catch{
            await MainActor.run { self.lastError = error.localizedDescription }
            print("[complete] error", error)
            return nil
        }
    }

    // MARK: - LLM generate
    func generateChallenges(bookId:String, chapterId:String, count:Int=10) async throws -> [Challenge] {
        guard let url=URL(string:"\(api)/api/generate") else { throw GenError.badURL }
        var req=URLRequest(url:url); req.httpMethod="POST"; req.setValue("application/json", forHTTPHeaderField:"Content-Type"); req.setValue(langHeader, forHTTPHeaderField:"X-Lang")
        req.httpBody = try JSONSerialization.data(withJSONObject:["bookId":bookId,"chapterId":chapterId,"count":count])
        let (d,r)=try await data(for:req)
        guard (r as? HTTPURLResponse)?.statusCode==200 else { let msg=String(data:d, encoding:.utf8) ?? ""; throw GenError.api(msg) }
        let j=try JSONSerialization.jsonObject(with:d) as? [String:Any]
        if let arr=j?["challenges"] as? [[String:Any]] {
            let data=try JSONSerialization.data(withJSONObject:arr)
            return try JSONDecoder().decode([Challenge].self, from:data)
        }
        throw GenError.parse
    }
    enum GenError: LocalizedError { case badURL, api(String), parse, cooldown(retryAfter: TimeInterval, blockedUntil: Date?)
        var errorDescription:String?{ switch self{
            case .badURL:return "Bad URL"
            case .api(let m):return m
            case .parse:return "Parse error"
            case .cooldown(let retryAfter, _):return "Spróbuj ponownie za \(Int(retryAfter)) s."}
        } }
}

// Trust self-signed w dev — localhost + LAN IP (172/192.168/10)
final class InsecureTrustDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let host = challenge.protectionSpace.host
        let isLocal = host.contains("127.0.0.1") || host.contains("localhost") || host.hasPrefix("172.") || host.hasPrefix("192.168.") || host.hasPrefix("10.")
        if isLocal, let trust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
            return
        }
        completionHandler(.performDefaultHandling, nil)
    }
}
