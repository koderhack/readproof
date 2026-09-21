import SwiftUI

// MARK: - Role accent

extension UserRole {
    var accent: Color {
        switch self {
        case .student: return RPColor.duoGreen
        case .reader: return RPColor.duoBlue
        case .teacher: return RPColor.duoYellow
        }
    }

    var accentDark: Color {
        switch self {
        case .student: return RPColor.duoGreenDark
        case .reader: return Color(hex: "#0A85C2")
        case .teacher: return Color(hex: "#8A6D00")
        }
    }

    var soft: Color {
        switch self {
        case .student: return RPColor.duoGreenLight
        case .reader: return Color(hex: "#E6F7FF")
        case .teacher: return Color(hex: "#FFF6D6")
        }
    }

    var symbol: String {
        switch self {
        case .student: return "graduationcap.fill"
        case .reader: return "book.fill"
        case .teacher: return "person.2.fill"
        }
    }

    /// Jedna karta roli: pełnoekranowy układ, natywny styl, kolor tylko jako akcent.
    var title: String {
        switch self {
        case .student: return "Student"
        case .reader: return "Reader"
        case .teacher: return "Teacher"
        }
    }
}

// MARK: - Choose your role (pierwsze uruchomienie)

struct ChooseRoleView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                VStack(spacing: 6) {
                    Text(loc.t("Wybierz swoją rolę", "Choose your role"))
                        .font(.largeTitle.weight(.bold))
                        .foregroundStyle(RPColor.ink)
                }
                .padding(.top, 28)

                ForEach(UserRole.allCases, id: \.self) { role in
                    RoleCard(role: role) { appState.setRole(role) }
                }

                Text(loc.t("Możesz to zmienić później w Ustawieniach.", "You can change this later in Settings."))
                    .font(.footnote)
                    .foregroundStyle(RPColor.muted)
                    .padding(.bottom, 24)
            }
            .padding(.horizontal, 20)
        }
        .background(RPColor.bg.ignoresSafeArea())
    }
}

private struct RoleCard: View {
    @EnvironmentObject var loc: LocalizationService
    let role: UserRole
    let action: () -> Void

    private var motto: [String] {
        switch role {
        case .student: return [
            loc.t("Czytaj.", "Read."),
            loc.t("Ucz się.", "Learn."),
            loc.t("Udowodnij.", "Prove it.")
        ]
        case .reader: return [
            loc.t("Czytaj.", "Read."),
            loc.t("Rozumiej.", "Understand."),
            loc.t("Śledź lektury.", "Track your reading.")
        ]
        case .teacher: return [
            loc.t("Zadawaj.", "Assign."),
            loc.t("Śledź.", "Track."),
            loc.t("Rozumiej swoją klasę.", "Understand your class.")
        ]
        }
    }

    private var cta: String {
        switch role {
        case .student: return loc.t("Kontynuuj jako Uczeń", "Continue as Student")
        case .reader: return loc.t("Kontynuuj jako Czytelnik", "Continue as Reader")
        case .teacher: return loc.t("Kontynuuj jako Nauczyciel", "Continue as Teacher")
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Ilustracja: duży symbol SF w miękkim polu roli (spójny styl, bez stocku)
            ZStack {
                role.soft
                Image(systemName: role.symbol)
                    .font(.system(size: 72, weight: .semibold))
                    .foregroundStyle(role.accentDark)
            }
            .frame(height: 170)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))

            VStack(alignment: .leading, spacing: 6) {
                Text(role.title)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(RPColor.ink)
                ForEach(motto, id: \.self) { line in
                    Text(line)
                        .font(.body)
                        .foregroundStyle(RPColor.muted)
                }
                Button(action: action) {
                    Text(cta)
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .background(role.accent)
                        .foregroundStyle(role == .teacher ? Color(hex: "#3A2E00") : .white)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                }
                .padding(.top, 10)
            }
            .padding(18)
        }
        .background(RPColor.card)
        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .stroke(RPColor.line, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.06), radius: 12, y: 6)
    }
}

// MARK: - Taby per rola (jeden system, różna nawigacja i stan)

struct RoleTabsView: View {
    @EnvironmentObject var loc: LocalizationService
    let role: UserRole
    @State private var selected = 0

    var body: some View {
        TabView(selection: $selected) {
            switch role {
            case .student:
                HomeView()
                    .tabItem { Label(loc.t("Start", "Home"), systemImage: "house") }.tag(0)
                ChallengeFlowView()
                    .tabItem { Label(loc.t("Wyzwania", "Challenges"), systemImage: "list.bullet.rectangle") }.tag(1)
                ProofsListView()
                    .tabItem { Label(loc.t("Certyfikaty", "Certificates"), systemImage: "checkmark.seal") }.tag(2)
                PassportView()
                    .tabItem { Label(loc.t("Profil", "Profile"), systemImage: "person.text.rectangle") }.tag(3)
            case .reader:
                HomeView()
                    .tabItem { Label(loc.t("Start", "Home"), systemImage: "house") }.tag(0)
                ProofsListView()
                    .tabItem { Label(loc.t("Dowody", "Proofs"), systemImage: "checkmark.seal") }.tag(1)
                PassportView()
                    .tabItem { Label(loc.t("Profil", "Profile"), systemImage: "person.text.rectangle") }.tag(2)
            case .teacher:
                HomeView()
                    .tabItem { Label(loc.t("Klasy", "Classes"), systemImage: "person.2") }.tag(0)
                ChallengeFlowView()
                    .tabItem { Label(loc.t("Zadania", "Assignments"), systemImage: "list.bullet.rectangle") }.tag(1)
                ProofsListView()
                    .tabItem { Label(loc.t("Uczniowie", "Students"), systemImage: "checkmark.seal") }.tag(2)
                PassportView()
                    .tabItem { Label(loc.t("Profil", "Profile"), systemImage: "person.text.rectangle") }.tag(3)
            }
        }
        .tint(role == .teacher ? Color(hex: "#8A6D00") : role.accent)
        .onAppear { setupTabBar() }
    }

    private func setupTabBar() {
        let a = UITabBarAppearance(); a.configureWithTransparentBackground()
        a.backgroundColor = UIColor(Color(hex: "#F9FAFB"))
        UITabBar.appearance().standardAppearance = a
        UITabBar.appearance().scrollEdgeAppearance = a
    }
}
