import Foundation

// Jev — evaluator odpowiedzi otwartych
// WYŁĄCZNIE oficjalne API TypeSafe (POST https://api.typesafe.ai/v1/systemone, model jev-latest, typ noul) przez backend
// Frontend NIE wysyła requestów do AI. Brak mocka — jeśli Jev niedostępny, zwracany jest błąd

final class JevService: ObservableObject {
    static let shared = JevService()

    func evaluate(question: String, expectedMeaning: String, userAnswer: String, context: String) async throws -> JevVerdict {
        let trimmed = userAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else {
            throw JevError.tooShort
        }
        if let verdict = await BackendService.shared.evaluateViaBackend(question: question, expectedMeaning: expectedMeaning, userAnswer: trimmed, context: context) {
            return verdict
        }
        throw JevError.unavailable
    }

    enum JevError: LocalizedError {
        case tooShort, unavailable
        var errorDescription: String? {
            switch self {
            case .tooShort: return "Odpowiedź za krótka"
            case .unavailable: return "Jev niedostępny — sprawdź backend / TYPESAFE_API_KEY"
            }
        }
    }
}
