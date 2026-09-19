import Foundation

// LLM — generowanie challenge'y przez OpenRouter FREE, ale ZAWSZE przez backend
// Frontend NIE wysyła requestów do AI. Wywołuje tylko POST /api/generate na backendzie.
// Backend: OPENROUTER_API_KEY w backend/.env, cache do challenges.json

final class LLMService: ObservableObject {
    func generateChallenges(for chapter: Chapter, count: Int = 10) async throws -> [Challenge] {
        // Preferuj backend
        let lang = LocalizationService.shared.current.rawValue
        do {
            let chs = try await BackendService.shared.generateChallenges(bookId: chapter.bookId, chapterId: chapter.id, count: count)
            if !chs.isEmpty { return chs }
        } catch { throw error }
        throw LLMError.noBackend
    }

    enum LLMError: LocalizedError {
        case noBackend, apiError, parseError
        var errorDescription: String? {
            switch self {
            case .noBackend: return "Backend offline — włącz backend (npm start) lub użyj pre-generowanych pytań."
            case .apiError: return "Błąd backendu / OpenRouter."
            case .parseError: return "Niepoprawny JSON od LLM."
            }
        }
    }
}

private struct ChallengeWrapper: Codable { let challenges: [Challenge] }
