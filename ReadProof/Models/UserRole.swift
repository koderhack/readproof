import Foundation
import SwiftUI

// Rola użytkownika — jeden system, różne nawigacje i ekrany startowe.
// Zmiana roli w dowolnym momencie (Home → Change), bez utraty dowodów i portfela.
enum UserRole: String, CaseIterable, Codable {
    case student
    case reader
    case teacher

    var title: String {
        switch self {
        case .student: return "Student"
        case .reader: return "Reader"
        case .teacher: return "Teacher"
        }
    }

    var tagline: String {
        switch self {
        case .student: return "Read.\nLearn.\nProve it."
        case .reader: return "Read.\nUnderstand.\nTrack your reading."
        case .teacher: return "Assign.\nTrack.\nUnderstand your class."
        }
    }

    var cta: String {
        switch self {
        case .student: return "Continue as Student"
        case .reader: return "Continue as Reader"
        case .teacher: return "Continue as Teacher"
        }
    }

    var symbol: String {
        switch self {
        case .student: return "graduationcap.fill"
        case .reader: return "book.fill"
        case .teacher: return "person.2.fill"
        }
    }

    // Role cards są kolorowe, reszta aplikacji spokojna.
    var tint: Color {
        switch self {
        case .student: return Color(hex: "#1E7A4C")
        case .reader: return Color(hex: "#2456C8")
        case .teacher: return Color(hex: "#C08A1A")
        }
    }

    var tintSoft: Color {
        switch self {
        case .student: return Color(hex: "#E7F2EB")
        case .reader: return Color(hex: "#E8EFFC")
        case .teacher: return Color(hex: "#F8F0DA")
        }
    }
}
