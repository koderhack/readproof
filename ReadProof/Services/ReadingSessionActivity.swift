import Foundation
import ActivityKit

struct ReadingSessionAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        var bookTitle: String
        var chapterTitle: String
        var progress: Double // 0...1
        var completed: Int
        var total: Int
        var nextUnlockIn: Int // sekundy
        var status: String // reading / challenge / verifying
        var hearts: Int
    }
    var sessionId: String
    var bookId: String
    var chapterId: String
}

@MainActor
final class ReadingSessionActivityManager: ObservableObject {
    static let shared = ReadingSessionActivityManager()
    private var activity: Activity<ReadingSessionAttributes>?

    func start(bookId: String, bookTitle: String, chapterId: String, chapterTitle: String, total: Int = 5) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let attrs = ReadingSessionAttributes(sessionId: UUID().uuidString, bookId: bookId, chapterId: chapterId)
        let state = ReadingSessionAttributes.ContentState(
            bookTitle: bookTitle,
            chapterTitle: chapterTitle,
            progress: 0,
            completed: 0,
            total: total,
            nextUnlockIn: 20,
            status: "reading",
            hearts: 5
        )
        do {
            activity = try Activity.request(attributes: attrs, content: .init(state: state, staleDate: nil))
        } catch { print("LiveActivity start error", error) }
    }

    func update(completed: Int, total: Int, nextUnlockIn: Int, status: String) {
        let state = ReadingSessionAttributes.ContentState(
            bookTitle: activity?.attributes.bookId ?? "",
            chapterTitle: activity?.attributes.chapterId ?? "",
            progress: Double(completed)/Double(max(total,1)),
            completed: completed,
            total: total,
            nextUnlockIn: nextUnlockIn,
            status: status,
            hearts: 5
        )
        Task { await activity?.update(.init(state: state, staleDate: nil)) }
    }

    func end(status: String = "verified") {
        let finalState = ReadingSessionAttributes.ContentState(
            bookTitle: activity?.attributes.bookId ?? "",
            chapterTitle: activity?.attributes.chapterId ?? "",
            progress: 1,
            completed: activity?.content.state.completed ?? 0,
            total: activity?.content.state.total ?? 5,
            nextUnlockIn: 0,
            status: status,
            hearts: 5
        )
        Task { await activity?.end(.init(state: finalState, staleDate: nil), dismissalPolicy: .default) }
        activity = nil
    }
}
