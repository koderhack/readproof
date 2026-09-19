import Foundation

final class ChallengeStore: ObservableObject {
    @Published var books: [Book] = []
    @Published var challengesByChapter: [String: [Challenge]] = [:]

    init() {
        loadBundledData()
    }

    private func loadBundledData() {
        guard let url = Bundle.main.url(forResource: "challenges", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(BundledData.self, from: data) else {
            // Brak danych — zostaną pobrane z backendu / Gutendex (public domain) live
            books = []
            challengesByChapter = [:]
            return
        }
        self.books = decoded.books
        self.challengesByChapter = decoded.challengesByChapter
    }

    func challenges(for chapterId: String) -> [Challenge] {
        challengesByChapter[chapterId] ?? []
    }

    func pickFive(for chapterId: String) -> [Challenge] {
        let pool = challenges(for: chapterId)
        guard !pool.isEmpty else { return [] }
        let shuffled = pool.shuffled()
        var picked: [Challenge] = []
        var usedTypes: Set<ChallengeType> = []
        for c in shuffled where picked.count < 5 {
            if !usedTypes.contains(c.type) || picked.count >= 3 {
                picked.append(c)
                usedTypes.insert(c.type)
            }
        }
        if picked.count < 5 {
            for c in shuffled where !picked.contains(c) && picked.count < 5 {
                picked.append(c)
            }
        }
        let hasJev = picked.contains(where: { $0.isJevType })
        if !hasJev, let jev = pool.first(where: { $0.isJevType }), !picked.contains(jev) {
            if picked.count == 5 { picked[4] = jev } else { picked.append(jev) }
        }
        return Array(picked.prefix(5))
    }
}

struct BundledData: Codable {
    let books: [Book]
    let challengesByChapter: [String: [Challenge]]
}
