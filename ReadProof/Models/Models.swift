import Foundation

// MARK: - Book

struct Book: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let author: String
    let coverEmoji: String // fallback
    var coverUrl: String? = nil // remote cover (Open Library / Gutenberg)
    let description: String
    let totalChapters: Int
    let rewardPerChapter: String // e.g. "5 USDC"
    var sourceUrl: String? = nil
    var license: String? = nil
    var fullTextFile: String? = nil
    let chapters: [Chapter]
}

struct Chapter: Identifiable, Codable, Hashable {
    let id: String
    let bookId: String
    let index: Int
    let title: String
    let summary: String
    let contextExcerpt: String
    let reward: String
    var gutenbergStart: String? = nil
}

// MARK: - Challenge Types

enum ChallengeType: String, Codable, CaseIterable {
    case multipleChoice = "multiple_choice"
    case trueFalse = "true_false"
    case multipleSelect = "multiple_select"
    case openQuestion = "open_question"
    case whyQuestion = "why_question"
    case ordering = "ordering"
    case whoSaid = "who_said"
    case match = "match"
    case whatNext = "what_next"
    case findError = "find_error"
    case ranking = "ranking"
    case memory = "memory"

    var displayName: String {
        let loc = LocalizationService.shared.current
        switch self {
        case .multipleChoice: return "ABCD"
        case .trueFalse: return loc == .pl ? "Prawda / Fałsz" : "True / False"
        case .multipleSelect: return loc == .pl ? "Wybierz wiele" : "Multiple choice"
        case .openQuestion: return loc == .pl ? "Pytanie otwarte" : "Open question"
        case .whyQuestion: return loc == .pl ? "Dlaczego?" : "Why?"
        case .ordering: return loc == .pl ? "Uporządkuj" : "Order"
        case .whoSaid: return loc == .pl ? "Kto to powiedział?" : "Who said it?"
        case .match: return loc == .pl ? "Dopasuj" : "Match"
        case .whatNext: return loc == .pl ? "Co dalej?" : "What next?"
        case .findError: return loc == .pl ? "Znajdź błąd" : "Find error"
        case .ranking: return "Ranking"
        case .memory: return loc == .pl ? "Pamięć" : "Memory"
        }
    }

    var requiresJev: Bool {
        self == .openQuestion || self == .whyQuestion
    }
}

// Generic challenge — enum with associated values would be complex for JSON.
// We store flexible fields and interpret by type.
struct Challenge: Identifiable, Codable, Hashable {
    let id: String
    let type: ChallengeType
    let question: String
    let context: String?
    let options: [String]?          // ABCD / trueFalse / multipleSelect / findError / whatNext
    let correctAnswer: Int?         // single index for ABCD, trueFalse(0=false 1=true), whatNext
    let correctAnswers: [Int]?      // multipleSelect
    let expectedMeaning: String?    // open / why — for Jev
    let items: [String]?            // ordering / ranking
    let correctOrder: [Int]?        // ordering / ranking
    let pairs: [MatchPair]?         // match / who_said
    let statements: [String]?       // findError — list, one is wrong
    let errorIndex: Int?            // findError
    let difficulty: String // easy/medium/hard

    // Validation helper
    var isJevType: Bool { type.requiresJev }
}

struct MatchPair: Codable, Hashable {
    let left: String
    let right: String
}

// MARK: - User Answer

enum UserAnswer: Hashable, Codable {
    case single(Int)
    case multiple(Set<Int>)
    case text(String)
    case ordered([Int]) // indices in current order
    case matched([Int:Int]) // leftIndex -> rightIndex

    // For persistence as string
    var summary: String {
        switch self {
        case .single(let i): return "single:\(i)"
        case .multiple(let s): return "multiple:\(s.sorted())"
        case .text(let t): return "text:\(t.prefix(40))"
        case .ordered(let o): return "ordered:\(o)"
        case .matched(let m): return "matched:\(m)"
        }
    }
}

// MARK: - Scoring

struct ChallengeResult: Identifiable, Hashable {
    let id: String // challenge id
    let challenge: Challenge
    let userAnswer: UserAnswer?
    let isCorrect: Bool
    let jevConfidence: Double? // nil if not Jev
    let jevRaw: JevVerdict?
}

struct JevVerdict: Codable, Hashable {
    let correct: Bool
    let confidence: Double
    let reason: String?
}

enum ProofStatus: String, Codable {
    case verified = "Reading Verified"
    case comprehensionVerified = "Comprehension Verified"
    case tryAgain = "Try Again"
    case failed = "Failed"
}

struct ReadingProof: Identifiable, Codable, Hashable {
    let id: String
    let bookId: String
    let chapterId: String
    let challengeIds: [String]
    let score: Int // 0...5
    let total: Int
    let status: ProofStatus
    let walletAddress: String
    let timestamp: Date
    let proofHash: String
    let txSignature: String?
    let explorerUrl: String?
    let reward: String?
}

// MARK: - Wallet

struct WalletState: Codable, Hashable {
    var address: String? // e.g. "7xKX...abc"
    var isConnected: Bool { address != nil }
    var balance: String // "12.50 USDC (Devnet)"
    var history: [ReadingProof]
}

// MARK: - App State

enum AppRoute: Hashable {
    case home
    case bookDetail(Book)
    case chapterIntro(Book, Chapter)
    case challenge(Book, Chapter, [Challenge])
    case result(Book, Chapter, [ChallengeResult], ReadingProof?)
    case proofDetail(ReadingProof)
    case wallet
}

// Scoring logic — nagroda tylko gdy 5/5 (błędna = zero), Proof of Comprehension
enum Scoring {
    static let jevThreshold: Double = 0.80

    static func status(for score: Int, total: Int = 5) -> ProofStatus {
        switch score {
        case 5: return .verified
        case 4, 3: return .tryAgain
        default: return .failed
        }
    }

    static func isPassing(score: Int) -> Bool { score == 5 }
}
