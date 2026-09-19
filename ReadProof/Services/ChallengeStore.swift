import Foundation

final class ChallengeStore: ObservableObject {
    @Published var books: [Book] = []
    @Published var challengesByChapter: [String: [Challenge]] = [:] // chapterId -> [Challenge] (pooled 8-12)

    init() {
        loadBundledData()
    }

    private func loadBundledData() {
        // Prefer bundled JSON
        if let url = Bundle.main.url(forResource: "challenges", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode(BundledData.self, from: data) {
            self.books = decoded.books
            self.challengesByChapter = decoded.challengesByChapter
            return
        }
        // Fallback: generate in-memory Alice
        let alice = MockData.aliceBook
        books = [alice.book]
        challengesByChapter = alice.challenges
    }

    func challenges(for chapterId: String) -> [Challenge] {
        challengesByChapter[chapterId] ?? []
    }

    // Select 5 diverse types for a run
    func pickFive(for chapterId: String) -> [Challenge] {
        let pool = challenges(for: chapterId)
        guard !pool.isEmpty else { return [] }
        // Shuffle and try to diversify types
        var shuffled = pool.shuffled()
        var picked: [Challenge] = []
        var usedTypes: Set<ChallengeType> = []
        // First pass — unique types
        for c in shuffled where picked.count < 5 {
            if !usedTypes.contains(c.type) || picked.count >= 3 {
                picked.append(c)
                usedTypes.insert(c.type)
            }
        }
        // If still <5 (due to skipping), fill
        if picked.count < 5 {
            for c in shuffled where !picked.contains(c) && picked.count < 5 {
                picked.append(c)
            }
        }
        // Ensure at least one Jev type if available in pool
        let hasJev = picked.contains(where: { $0.isJevType })
        if !hasJev, let jev = pool.first(where: { $0.isJevType }), !picked.contains(jev) {
            picked[4] = jev
        }
        return Array(picked.prefix(5))
    }
}

// MARK: - Bundled JSON structure

struct BundledData: Codable {
    let books: [Book]
    let challengesByChapter: [String: [Challenge]]
}

// MARK: - Mock Alice (fallback if no JSON)

enum MockData {
    static var aliceBook: (book: Book, challenges: [String:[Challenge]]) {
        let chapters = [
            Chapter(id: "alice-ch1", bookId: "alice", index: 1, title: "Down the Rabbit-Hole", summary: "Alicja goni Białego Królika i wpada do króliczej nory. Spotyka drzwi, klucz i napój 'Drink Me'.", contextExcerpt: "Alice was beginning to get very tired of sitting by her sister... suddenly a White Rabbit with pink eyes ran close by her. 'Oh dear! Oh dear! I shall be too late!' — excerpt Alice's Adventures in Wonderland, Ch.1 (public domain).", reward: "5 USDC"),
            Chapter(id: "alice-ch2", bookId: "alice", index: 2, title: "The Pool of Tears", summary: "Alicja rośnie i maleje po wypiciu napojów, zalewa łzami pokój.", contextExcerpt: "Curiouser and curiouser! ... She ate a little bit, and said anxiously 'Which way? Which way?' — Alice Ch.2", reward: "5 USDC"),
            Chapter(id: "alice-ch3", bookId: "alice", index: 3, title: "A Caucus-Race and a Long Tale", summary: "Ptaki i mysz organizują wyścig bez zasad aby się wysuszyć.", contextExcerpt: "They were indeed a queer-looking party... The Dodo said 'Everybody has won, and all must have prizes.' — Alice Ch.3", reward: "5 USDC"),
        ]
        let book = Book(id: "alice", title: "Alice's Adventures in Wonderland", author: "Lewis Carroll", coverEmoji: "🐰", description: "Domena publiczna. Klasyka literatury. Idealna do Reading Proof — absurdalne dialogi, szczegóły i logika snu sprawdzają zrozumienie.", totalChapters: 3, rewardPerChapter: "5 USDC", chapters: chapters)
        var map: [String:[Challenge]] = [:]
        // Minimal but will be augmented by bundled JSON if present
        map["alice-ch1"] = ChallengesSeed.ch1
        map["alice-ch2"] = ChallengesSeed.ch2
        map["alice-ch3"] = ChallengesSeed.ch3
        return (book, map)
    }
}

enum ChallengesSeed {
    // Chapter 1 — 10 challenges
    static var ch1: [Challenge] {
        [
            Challenge(id: "c1-1", type: .multipleChoice, question: "Dlaczego Alicja ruszyła za Białym Królikiem?", context: "Ch.1 Down the Rabbit-Hole", options: ["Bo miała mapę", "Bo Królik mówił że się spóźni i wyjął zegarek", "Bo zgubiła siostrę", "Bo szukała herbaty"], correctAnswer: 1, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "easy"),
            Challenge(id: "c1-2", type: .trueFalse, question: "Alicja w rozdziale 1 wypija napój z etykietą 'Drink Me' i zaczyna się zmieniać.", context: nil, options: ["Prawda","Fałsz"], correctAnswer: 1, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "easy"),
            Challenge(id: "c1-3", type: .openQuestion, question: "Własnymi słowami: dlaczego drzwi w korytarzu były problemem dla Alicji?", context: "Korytarz pełen drzwi, złoty kluczyk, za małe drzwi", options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: "Drzwi były zamknięte lub za małe; kluczyk nie pasował / Alicja była za duża lub za mała", items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c1-4", type: .ordering, question: "Ułóż wydarzenia w kolejności (Ch.1)", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: ["Alicja widzi Królika z zegarkiem","Wpada do króliczej nory","Znajduje szklany stolik ze złotym kluczykiem","Pije z butelki 'Drink Me'"], correctOrder: [0,1,2,3], pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c1-5", type: .whoSaid, question: "Kto powiedział: 'Oh dear! Oh dear! I shall be too late!'?", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: [MatchPair(left: "Oh dear! Oh dear! I shall be too late!", right: "Biały Królik"), MatchPair(left: "Curiouser and curiouser!", right: "Alicja"), MatchPair(left: "Drink Me", right: "Etykieta na butelce")], statements: nil, errorIndex: nil, difficulty: "easy"),
            Challenge(id: "c1-6", type: .multipleSelect, question: "Wybierz 2 prawdziwe zdania o rozdziale 1", context: nil, options: ["Alicja spada bardzo długo i rozmyśla", "Alicja od razu znajduje wyjście z korytarza", "Królik nosi kamizelkę i zegarek", "Alicja spotyka Królową Kier"], correctAnswer: nil, correctAnswers: [0,2], expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c1-7", type: .whatNext, question: "Co dzieje się tuż po tym gdy Alicja rośnie za bardzo?", context: "Po wypiciu napoju", options: ["Zaczyna płakać bo nie mieści się", "Natychmiast wraca do domu", "Spotyka Kota z Cheshire", "Zasypia"], correctAnswer: 0, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c1-8", type: .findError, question: "Znajdź zdanie NIEZGODNE z rozdziałem 1", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: ["Biały Królik ma różowe oczy i zegarek","Korytarz ma wiele drzwi i szklany stolik","Alicja zjada ciastko 'Eat Me' i maleje (to jest w Ch.1)","Alicja gra w krykieta z Królową"], errorIndex: 3, difficulty: "medium"),
            Challenge(id: "c1-9", type: .whyQuestion, question: "Dlaczego Alicja decyduje się napić z butelki mimo że nie wie co to jest?", context: "Butelka 'Drink Me', Alicja rozważa czy jest trująca", options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: "Sprawdziła że nie ma oznaczenia 'poison', jest ciekawa, liczy że pomoże jej przejść przez drzwi, nie widzi niebezpieczeństwa", items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "hard"),
            Challenge(id: "c1-10", type: .match, question: "Dopasuj obiekt do jego roli", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: [MatchPair(left: "Złoty kluczyk", right: "Otwiera małe drzwiczki"), MatchPair(left: "Butelka 'Drink Me'", right: "Zmienia rozmiar Alicji"), MatchPair(left: "Królicza nora", right: "Wejście do podziemnego korytarza")], statements: nil, errorIndex: nil, difficulty: "easy"),
        ]
    }
    static var ch2: [Challenge] {
        [
            Challenge(id: "c2-1", type: .multipleChoice, question: "Co Alicja robi gdy jest zbyt duża i zalewa pokój łzami?", context: "Ch.2 Pool of Tears", options: ["Śmieje się", "Płacze i tworzy kałużę łez", "Ucieka przez okno", "Woła siostrę"], correctAnswer: 1, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "easy"),
            Challenge(id: "c2-2", type: .trueFalse, question: "Alicja w Ch.2 spotyka ponownie Białego Królika który bierze ją za swoją służącą.", context: nil, options: ["Prawda","Fałsz"], correctAnswer: 0, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c2-3", type: .openQuestion, question: "Dlaczego Alicja mówi 'Curiouser and curiouser!'?", context: "Ch.2 zmiany rozmiaru", options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: "Bo rzeczy stają się coraz dziwniejsze — jej ciało rośnie/maleje w nieprzewidywalny sposób", items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c2-4", type: .ordering, question: "Kolejność zdarzeń w Ch.2", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: ["Alicja próbuje Wachlarz Królika i maleje","Wpada do kałuży łez","Spotyka Myszę","Mysz próbuje wysuszyć towarzystwo"], correctOrder: [0,1,2,3], pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c2-5", type: .multipleSelect, question: "Które 2 zwierzęta pojawiają się w Ch.2-3?", context: nil, options: ["Mysz","Dodo","Smok","Jednorożec"], correctAnswer: nil, correctAnswers: [0,1], expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "easy"),
            Challenge(id: "c2-6", type: .whyQuestion, question: "Dlaczego Mysz się obraża na Alicję?", context: "Alicja mówi o kotach, Mysz nie lubi kotów", options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: "Alicja wspomina kota Dinah i koty w ogóle, a Mysz boi się / nienawidzi kotów", items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c2-7", type: .whatNext, question: "Co dzieje się po tym jak Alicja i zwierzęta są mokre?", context: nil, options: ["Organizują Caucus-Race", "Idą na herbatkę", "Wracają do domu", "Zasypiają"], correctAnswer: 0, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "easy"),
            Challenge(id: "c2-8", type: .findError, question: "Znajdź błąd o Ch.2", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: ["Alicja maleje po wachlarzu","Alicja płynie we własnych łzach","Biały Królik gubi rękawiczki","Alicja zostaje Królową"], errorIndex: 3, difficulty: "easy"),
            Challenge(id: "c2-9", type: .match, question: "Dopasuj postać do zachowania", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: [MatchPair(left: "Alicja", right: "Płacze i tworzy kałużę"), MatchPair(left: "Biały Królik", right: "Gubi wachlarz i rękawiczki"), MatchPair(left: "Mysz", right: "Ucieka gdy mowa o kotach")], statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c2-10", type: .whoSaid, question: "Kto mówi o 'curiouser and curiouser'?", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: [MatchPair(left: "Curiouser and curiouser!", right: "Alicja"), MatchPair(left: "Oh my ears and whiskers!", right: "Biały Królik")], statements: nil, errorIndex: nil, difficulty: "easy"),
        ]
    }
    static var ch3: [Challenge] {
        [
            Challenge(id: "c3-1", type: .multipleChoice, question: "Czym jest Caucus-Race według Dodo?", context: "Ch.3", options: ["Wyścig z nagrodami dla wszystkich","Wyścig tylko dla ptaków","Wyścig bez mety","Wyścig z przeszkodami"], correctAnswer: 0, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "easy"),
            Challenge(id: "c3-2", type: .trueFalse, question: "W Caucus-Race każdy wygrywa i każdy dostaje nagrodę.", context: nil, options: ["Prawda","Fałsz"], correctAnswer: 0, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "easy"),
            Challenge(id: "c3-3", type: .openQuestion, question: "Jak Dodo rozwiązuje problem wysuszenia towarzystwa?", context: "Mokra grupa po kałuży łez", options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: "Organizuje Caucus-Race — bieganie w kółko bez zasad, potem nagrody", items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c3-4", type: .ordering, question: "Kolejność Caucus-Race", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: ["Dodo ogłasza wyścig","Wszyscy biegają bez początku/końca","Dodo ogłasza że wszyscy wygrali","Alicja wręcza cukierki jako nagrody"], correctOrder: [0,1,2,3], pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c3-5", type: .whyQuestion, question: "Dlaczego Alicja musi dać własną nagrodę?", context: "Brak nagród, Alicja ma cukierki", options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: "Nie ma przygotowanych nagród, Dodo każe Alicji dać coś z kieszeni, potem ona dostaje własny pierścionek", items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "hard"),
            Challenge(id: "c3-6", type: .multipleSelect, question: "Wybierz 2 cechy Caucus-Race", context: nil, options: ["Brak zasad startu/mety","Sędziuje Dodo","Wygrywa najszybszy","Trwa 5 minut dokładnie"], correctAnswer: nil, correctAnswers: [0,1], expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c3-7", type: .whatNext, question: "Co robi Mysz po wyścigu?", context: nil, options: ["Opowiada długą smutną historię","Idzie spać","Zjada nagrody","Uciekają wszyscy"], correctAnswer: 0, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: nil, errorIndex: nil, difficulty: "medium"),
            Challenge(id: "c3-8", type: .findError, question: "Znajdź błąd o Ch.3", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: nil, statements: ["Dodo organizuje wyścig","Wszyscy dostają cukierki od Alicji","Mysz opowiada o kocie i psie","Alicja spotyka Królową Kier"], errorIndex: 3, difficulty: "easy"),
            Challenge(id: "c3-9", type: .match, question: "Dopasuj", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: [MatchPair(left: "Dodo", right: "Sędzia wyścigu"), MatchPair(left: "Mysz", right: "Opowiada Long Tale"), MatchPair(left: "Alicja", right: "Daje nagrody")], statements: nil, errorIndex: nil, difficulty: "easy"),
            Challenge(id: "c3-10", type: .whoSaid, question: "Kto mówi 'Everybody has won, and all must have prizes'?", context: nil, options: nil, correctAnswer: nil, correctAnswers: nil, expectedMeaning: nil, items: nil, correctOrder: nil, pairs: [MatchPair(left: "Everybody has won, and all must have prizes", right: "Dodo"), MatchPair(left: "I am so tired of swimming", right: "Alicja")], statements: nil, errorIndex: nil, difficulty: "easy"),
        ]
    }
}
