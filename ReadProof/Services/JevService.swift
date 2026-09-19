import Foundation

// Jev — evaluator odpowiedzi otwartych
// ARCHITEKTURA: frontend NIE wysyła requestów do AI. Wszystko przez backend /api/evaluate
// Backend decyduje: oficjalne Jev API (nie OpenRouter) -> mock fallback
// OpenRouter FREE jest tylko dla LLM generującego challenge'e (backend/server.js)

final class JevService: ObservableObject {
    static let shared = JevService()
    private let threshold: Double = Scoring.jevThreshold

    func evaluate(question: String, expectedMeaning: String, userAnswer: String, context: String) async -> JevVerdict {
        let trimmed = userAnswer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else {
            return JevVerdict(correct: false, confidence: 0.15, reason: trimmed.isEmpty ? "Brak odpowiedzi" : "Za krótka odpowiedź.")
        }
        // 1) Backend -> oficjalne Jev API (nie OpenRouter) -> mock w backendzie
        if let backendVerdict = await BackendService.shared.evaluateViaBackend(question: question, expectedMeaning: expectedMeaning, userAnswer: trimmed, context: context) {
            return backendVerdict
        }
        // 2) Fallback lokalny mock — aby apka działała bez backendu / bez Jev (offline, hackathon)
        return mockEvaluate(expected: expectedMeaning, answer: trimmed)
    }

    // MARK: - Mock (offline)
    func mockEvaluate(expected: String, answer: String) -> JevVerdict {
        let expWords = keywords(expected)
        let ansWords = keywords(answer)
        guard !expWords.isEmpty else {
            return JevVerdict(correct: answer.count > 10, confidence: 0.55, reason: "Mock: brak słów kluczowych.")
        }
        let intersect = expWords.intersection(ansWords)
        let recall = Double(intersect.count) / Double(expWords.count)
        let confidence: Double
        let correct: Bool
        if recall >= 0.5 {
            confidence = min(0.95, 0.70 + recall * 0.3 + Double(min(answer.count,100))/400.0)
            correct = confidence >= threshold
        } else if recall >= 0.3 {
            confidence = 0.55 + recall * 0.3
            correct = false
        } else {
            let lowerAns = answer.lowercased()
            let lowerExp = expected.lowercased()
            if lowerExp.split(separator: " ").contains(where: { lowerAns.contains($0) }) {
                confidence = 0.60
                correct = false
            } else {
                confidence = 0.25 + recall
                correct = false
            }
        }
        let reason = correct ? "Mock: zgodność \(Int(recall*100))% (offline)" : "Mock: za mało zgodności \(Int(recall*100))%, próg \(Int(threshold*100))% (offline)"
        return JevVerdict(correct: correct, confidence: confidence, reason: reason)
    }

    private func keywords(_ text: String) -> Set<String> {
        let stop: Set<String> = ["i","w","z","na","do","że","to","się","jest","by","być","nie","tak","jak","co","dla","ale","oraz","przez","po","o","a","u","za","od","te","ten","ta","the","a","an","is","are","was","be","to","of","in","it","you","and"]
        let words = text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { $0.count > 2 && !stop.contains($0) }
        return Set(words)
    }
}
