import Foundation

// BackendService — proxy do lokalnego Node backendu (Express + SQLite + OpenRouter free + Jev)
// Fallback: jeśli backend nieosiągalny, używa bundled JSON i mock Jev (tak jak wcześniej)
// Dla lokalnych testów: http://127.0.0.1:32288 (Simulator) lub http://localhost:32288
// Dla Frog VPS: http://frog02.mikr.us:32287 (proxy -> :32288)
// Konfiguracja w UserDefaults "backend_url"

final class BackendService: ObservableObject {
    static let shared = BackendService()

    @Published var isReachable: Bool = false
    @Published var lastError: String?

    var baseURL: String {
        get {
            let stored = UserDefaults.standard.string(forKey: "backend_url") ?? ""
            if !stored.isEmpty { return stored.trimmingCharacters(in: .whitespacesAndNewlines) }
            // default lokalny — Simulator widzi 127.0.0.1 hosta
            return "http://127.0.0.1:32288"
        }
        set { UserDefaults.standard.set(newValue, forKey: "backend_url") }
    }

    private var api: String { baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL }
    var langHeader: String { LocalizationService.shared.current.rawValue }

    // MARK: - Health
    func checkHealth() async -> Bool {
        guard let url = URL(string: "\(api)/health") else { return false }
        var req = URLRequest(url: url); req.timeoutInterval = 4
        req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        do {
            let (d, r) = try await URLSession.shared.data(for: req)
            let ok = (r as? HTTPURLResponse)?.statusCode == 200
            if ok, let j = try? JSONSerialization.jsonObject(with: d) as? [String:Any] {
                await MainActor.run { self.isReachable = true; self.lastError = nil }
                return j["status"] as? String == "ok"
            }
        } catch { await MainActor.run { self.lastError = error.localizedDescription } }
        await MainActor.run { self.isReachable = false }
        return false
    }

    // MARK: - Books
    func fetchBooks() async -> [Book]? {
        guard let url = URL(string: "\(api)/api/books") else { return nil }
        var req = URLRequest(url: url); req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        do { let (d, r) = try await URLSession.shared.data(for: req); guard (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }; return try JSONDecoder().decode([Book].self, from: d) } catch { return nil }
    }

    func fetchChallenges(chapterId: String, pick: Int = 5) async -> [Challenge]? {
        guard let url = URL(string: "\(api)/api/challenges/\(chapterId)?pick=\(pick)&lang=\(langHeader)") else { return nil }
        var req = URLRequest(url: url); req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        do { let (d, r) = try await URLSession.shared.data(for: req); guard (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }; return try JSONDecoder().decode([Challenge].self, from: d) } catch { return nil }
    }

    func fetchChallengeSet(bookId: String, chapterId: String) async -> [Challenge]? {
        guard let url = URL(string: "\(api)/api/books/\(bookId)/chapters/\(chapterId)/challenge?lang=\(langHeader)") else { return nil }
        var req = URLRequest(url: url); req.setValue(langHeader, forHTTPHeaderField: "X-Lang")
        do { let (d, r) = try await URLSession.shared.data(for: req); guard (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }; if let wrapper = try? JSONDecoder().decode(ChallengeSetWrapper.self, from: d) { return wrapper.challenges }; return try JSONDecoder().decode([Challenge].self, from: d) } catch { return nil }
    }

    struct ChallengeSetWrapper: Codable { let challenges: [Challenge]; let chapterId: String; let count: Int? }

    // MARK: - Jev via backend (korzysta z OpenRouter free na backendzie, fallback mock)
    func evaluateViaBackend(question: String, expectedMeaning: String, userAnswer: String, context: String) async -> JevVerdict? {
        guard let url = URL(string: "\(api)/api/evaluate") else { return nil }
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.setValue(langHeader, forHTTPHeaderField: "X-Lang"); req.timeoutInterval = 12
        let body: [String:String] = ["question": question, "expectedMeaning": expectedMeaning, "userAnswer": userAnswer, "context": context]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (d, r) = try await URLSession.shared.data(for: req)
            guard (r as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return try JSONDecoder().decode(JevVerdict.self, from: d)
        } catch { return nil }
    }

    // MARK: - Proofs
    func submitProof(bookId: String, chapterId: String, challenges: [Challenge], answers: [String: UserAnswer], walletAddress: String?) async -> ReadingProof? {
        guard let url = URL(string: "\(api)/api/proofs") else { return nil }
        var req = URLRequest(url: url); req.httpMethod="POST"; req.setValue("application/json", forHTTPHeaderField:"Content-Type"); req.timeoutInterval = 15
        // map UserAnswer to JSON primitive for backend
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
            let (d, r)=try await URLSession.shared.data(for:req)
            guard (r as? HTTPURLResponse)?.statusCode==200 else { return nil }
            return try JSONDecoder().decode(ReadingProof.self, from: d)
        } catch { return nil }
    }

    func fetchProofs(wallet:String? = nil) async -> [ReadingProof]? {
        var s="\(api)/api/proofs"
        if let w=wallet, !w.isEmpty { s+="?wallet=\(w.addingPercentEncoding(withAllowedCharacters:.urlQueryAllowed) ?? w)" }
        guard let url=URL(string:s) else { return nil }
        do{ let (d,r)=try await URLSession.shared.data(from:url); guard (r as? HTTPURLResponse)?.statusCode==200 else {return nil}; return try JSONDecoder().decode([ReadingProof].self, from: d)}catch{return nil}
    }

    // MARK: - LLM generate
    func generateChallenges(bookId:String, chapterId:String, count:Int=10) async throws -> [Challenge] {
        guard let url=URL(string:"\(api)/api/generate") else { throw GenError.badURL }
        var req=URLRequest(url:url); req.httpMethod="POST"; req.setValue("application/json", forHTTPHeaderField:"Content-Type"); req.setValue(langHeader, forHTTPHeaderField:"X-Lang")
        req.httpBody = try JSONSerialization.data(withJSONObject:["bookId":bookId,"chapterId":chapterId,"count":count])
        let (d,r)=try await URLSession.shared.data(for:req)
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
