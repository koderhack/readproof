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
    func submitProof(bookId: String, chapterId: String, challenges: [Challenge], answers: [String: UserAnswer], walletAddress: String?) async -> ReadingProof? {
        guard let url = URL(string: "\(api)/api/proofs") else { return nil }
        var req = URLRequest(url: url); req.httpMethod="POST"; req.setValue("application/json", forHTTPHeaderField:"Content-Type"); req.setValue(langHeader, forHTTPHeaderField:"X-Lang"); req.timeoutInterval = 15
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
        let payload:[String:Any]=["bookId":bookId,"chapterId":chapterId,"challenges": challenges.map{ try! JSONEncoder().encode($0) }.map{ try! JSONSerialization.jsonObject(with: $0) },"answers": ansMap,"walletAddress": walletAddress as Any]
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        do {
            let (d, r)=try await data(for:req)
            guard (r as? HTTPURLResponse)?.statusCode==200 else { return nil }
            return try JSONDecoder().decode(ReadingProof.self, from: d)
        } catch { return nil }
    }

    func fetchProofs(wallet:String? = nil) async -> [ReadingProof]? {
        var s="\(api)/api/proofs"
        if let w=wallet, !w.isEmpty { s+="?wallet=\(w.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed) ?? w)" }
        guard let url=URL(string:s) else { return nil }
        var req = URLRequest(url:url); req.setValue(langHeader, forHTTPHeaderField:"X-Lang")
        do{ let (d,r)=try await data(for:req); guard (r as? HTTPURLResponse)?.statusCode==200 else {return nil}; return try JSONDecoder().decode([ReadingProof].self, from: d)}catch{return nil}
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
    enum GenError: LocalizedError { case badURL, api(String), parse; var errorDescription:String?{ switch self{case .badURL:return "Bad URL";case .api(let m):return m;case .parse:return "Parse error"}}}
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
