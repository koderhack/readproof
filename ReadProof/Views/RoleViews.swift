import SwiftUI

// ═══ Role selector — pierwszy ekran: szybki, elegancki, bez 10-ekranowego onboardingu ═══
struct RoleSelectorView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing:16) {
                    VStack(spacing:6) {
                        Text(loc.t("Wybierz swoją rolę", "Choose your role"))
                            .font(.system(size:30, weight:.bold, design:.rounded))
                        Text(loc.t("Cała aplikacja dostosuje się do Ciebie.", "The whole app adapts to you."))
                            .font(.subheadline).foregroundStyle(RPColor.muted)
                    }
                    .padding(.top, 12)

                    ForEach(UserRole.allCases, id: \.self) { role in
                        RoleCard(role: role) { appState.setRole(role) }
                    }

                    Text(loc.t("Możesz to zmienić później w ustawieniach.", "You can change this later in Settings."))
                        .font(.caption).foregroundStyle(RPColor.muted2)
                        .padding(.top, 4)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
            }
            .background(RPColor.bg)
            .navigationTitle("")
            .navigationBarHidden(true)
        }
    }
}

struct RoleCard: View {
    let role: UserRole
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment:.leading, spacing:0) {
                HStack {
                    ZStack {
                        Circle().fill(.white.opacity(0.22)).frame(width:64, height:64)
                        Image(systemName: role.symbol)
                            .font(.system(size:26, weight:.semibold))
                            .foregroundStyle(.white)
                    }
                    Spacer()
                    Text(role.title.uppercased())
                        .font(.system(size:11, weight:.bold, design:.monospaced))
                        .tracking(1.2).foregroundStyle(.white.opacity(0.85))
                }
                .padding(.horizontal, 20).padding(.top, 20)
                Text(role.tagline)
                    .font(.system(size:30, weight:.bold, design:.rounded))
                    .foregroundStyle(.white).lineSpacing(2)
                    .padding(.horizontal, 20).padding(.top, 10)
                HStack {
                    Text(role.cta)
                        .font(.system(size:15, weight:.semibold, design:.rounded))
                    Image(systemName: "arrow.right")
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 18).padding(.vertical, 12)
                .background(.white.opacity(0.22))
                .clipShape(RoundedRectangle(cornerRadius: 14, style:.continuous))
                .padding(20)
            }
            .frame(maxWidth:.infinity, alignment:.leading)
            .background(
                LinearGradient(colors: [role.tint, role.tint.opacity(0.78)], startPoint:.topLeading, endPoint:.bottomTrailing)
            )
            .clipShape(RoundedRectangle(cornerRadius: 26, style:.continuous))
            .shadow(color: role.tint.opacity(0.3), radius: 16, y: 8)
        }
        .buttonStyle(.plain)
    }
}

// ═══ Shared bits ═══
func setupTabBar() {
    let a = UITabBarAppearance(); a.configureWithTransparentBackground()
    a.backgroundColor = UIColor(Color(hex: "#F9FAFB")); UITabBar.appearance().standardAppearance = a; UITabBar.appearance().scrollEdgeAppearance = a
}

struct RoleSwitcherRow: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    var body: some View {
        HStack {
            Label((appState.role?.title ?? "—"), systemImage: appState.role?.symbol ?? "person")
                .foregroundStyle(RPColor.ink)
            Spacer()
            Button(loc.t("Zmień", "Change")) { appState.clearRole() }
                .font(.caption)
        }
    }
}

struct DemoTag: View {
    var body: some View {
        Text("DEMO").font(.system(size:10, weight:.bold, design:.monospaced))
            .padding(.horizontal,8).padding(.vertical,4)
            .background(RPColor.duoGray.opacity(0.5)).foregroundStyle(RPColor.muted)
            .clipShape(Capsule())
    }
}

// ═══ STUDENT home ═══
struct StudentHomeView: View {
    @EnvironmentObject var store: ChallengeStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService

    var verifiedCount: Int { appState.proofs.filter { $0.status == .verified }.count }
    var nextBook: Book? { store.books.first }

    var body: some View {
        NavigationStack {
            List {
                if let book = nextBook {
                    Section {
                        NavigationLink(destination: BookDetailView(book: book)) {
                            VStack(alignment:.leading, spacing:6) {
                                Text(loc.t("Twoje następne wyzwanie", "Your next challenge"))
                                    .font(.caption.weight(.semibold)).foregroundStyle(RPColor.muted)
                                Text(book.title).font(.headline).foregroundStyle(RPColor.ink)
                                Text(book.author).font(.subheadline).foregroundStyle(RPColor.muted)
                                ProgressBar(value: appState.progress(for: book))
                            }.padding(.vertical, 4)
                        }
                    } header: { Text(loc.t("Kontynuuj czytanie", "Continue reading")) }
                }
                Section(loc.t("Twój postęp", "Your progress")) {
                    HStack {
                        Label(loc.t("Nadchodzące wyzwania", "Upcoming challenges"), systemImage: "calendar")
                        Spacer(); Text("\(max(nextBook.map { max($0.chapters.count - verifiedCount, 0) } ?? 0, 0))").foregroundStyle(.secondary)
                    }
                    HStack {
                        Label(loc.t("Ostatnie certyfikaty", "Recent certificates"), systemImage: "checkmark.seal.fill")
                        Spacer(); Text("\(verifiedCount)").foregroundStyle(.secondary)
                    }
                }
                if !appState.proofs.isEmpty {
                    Section(loc.t("Ostatnie wyniki", "Recent results")) {
                        ForEach(appState.proofs.prefix(3)) { p in
                            HStack {
                                Image(systemName: p.status == .verified ? "checkmark.seal.fill" : "xmark.seal")
                                    .foregroundStyle(p.status == .verified ? RPColor.primary : RPColor.muted)
                                Text("\(p.bookId) • \(p.chapterId)").font(.subheadline).foregroundStyle(RPColor.ink).lineLimit(1)
                                Spacer()
                                Text("\(p.score)/\(p.total)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section(loc.t("Rola", "Role")) { RoleSwitcherRow() }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Cześć! 👋", "Hi! 👋"))
        }
    }
}

// ═══ READER home ═══
struct ReaderHomeView: View {
    @EnvironmentObject var store: ChallengeStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService

    var body: some View {
        NavigationStack {
            List {
                if let book = store.books.first {
                    Section {
                        NavigationLink(destination: BookDetailView(book: book)) {
                            VStack(alignment:.leading, spacing:6) {
                                Text(loc.t("Kontynuuj czytanie", "Continue reading"))
                                    .font(.caption.weight(.semibold)).foregroundStyle(RPColor.muted)
                                Text(book.title).font(.headline).foregroundStyle(RPColor.ink)
                                ProgressBar(value: appState.progress(for: book))
                            }.padding(.vertical, 4)
                        }
                    }
                }
                Section(loc.t("Historia czytania", "Reading history")) {
                    if appState.proofs.isEmpty {
                        Text(loc.t("Tu pojawią się Twoje książki i dowody.", "Your books and proofs will appear here."))
                            .font(.caption).foregroundStyle(RPColor.muted)
                    } else {
                        ForEach(appState.proofs.prefix(5)) { p in
                            HStack {
                                Text("\(p.bookId)").font(.subheadline).foregroundStyle(RPColor.ink).lineLimit(1)
                                Spacer()
                                Text("\(p.score)/\(p.total)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section(loc.t("Dowody", "Proofs")) {
                    NavigationLink(destination: ProofsListView()) {
                        Label(loc.t("Wszystkie dowody (\(appState.proofs.count))", "All proofs (\(appState.proofs.count))"), systemImage: "checkmark.seal")
                    }
                }
                Section(loc.t("Rola", "Role")) { RoleSwitcherRow() }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Moje czytanie", "My Reading"))
        }
    }
}

// ═══ TEACHER home + demo panels ═══
struct TeacherClass: Identifiable {
    let id: String; let students: Int; let book: String; let done: Int; let avg: Int; let deadline: String
}
let demoClasses = [
    TeacherClass(id: "2A", students: 28, book: "Dziady, Part III", done: 23, avg: 86, deadline: "Oct 4"),
    TeacherClass(id: "3B", students: 24, book: "Lalka", done: 18, avg: 79, deadline: "Oct 7"),
    TeacherClass(id: "1C", students: 34, book: "The Hobbit", done: 30, avg: 91, deadline: "Oct 12")
]

struct TeacherHomeView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    var body: some View {
        NavigationStack {
            List {
                Section { HStack { Text(loc.t("Aktywne klasy", "Active classes")); Spacer(); Text("3").foregroundStyle(.secondary) } ; HStack { Text(loc.t("Uczniowie", "Students")); Spacer(); Text("86").foregroundStyle(.secondary) } }
                    header: { HStack { Text(loc.t("Przegląd", "Overview")); Spacer(); DemoTag() } }
                Section(loc.t("Nadchodzące terminy", "Upcoming assignments")) {
                    ForEach(demoClasses) { c in
                        VStack(alignment:.leading, spacing:4) {
                            Text("\(c.book) • \(c.id)").font(.subheadline.weight(.semibold)).foregroundStyle(RPColor.ink)
                            Text("\(c.done)/\(c.students) • ⌀ \(c.avg)% • \(c.deadline)").font(.caption).foregroundStyle(RPColor.muted)
                            ProgressBar(value: Double(c.done)/Double(max(c.students,1)), tint: c.done * 100 / max(c.students,1) >= 80 ? RPColor.primary : RPColor.duoYellow)
                        }.padding(.vertical, 2)
                    }
                }
                Section(loc.t("Wymagają uwagi", "Needs attention")) {
                    Label(loc.t("5 uczniów poniżej 60% lub bez startu", "5 students below 60% or not started"), systemImage: "exclamationmark.triangle")
                        .font(.subheadline).foregroundStyle(RPColor.peach)
                }
                Section(loc.t("Rola", "Role")) { RoleSwitcherRow() }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Dzień dobry ☀️", "Good morning ☀️"))
        }
    }
}

struct TeacherClassesView: View {
    @EnvironmentObject var loc: LocalizationService
    var body: some View {
        NavigationStack {
            List(demoClasses) { c in
                VStack(alignment:.leading, spacing:6) {
                    HStack { Text("Class \(c.id)").font(.headline).foregroundStyle(RPColor.ink); Spacer(); DemoTag() }
                    Text("\(c.students) students • \(c.book)").font(.subheadline).foregroundStyle(RPColor.muted)
                    ProgressBar(value: Double(c.done)/Double(max(c.students,1)))
                    Text("\(c.done)/\(c.students) • ⌀ \(c.avg)%").font(.caption).foregroundStyle(RPColor.muted)
                }.padding(.vertical, 4)
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Klasy", "Classes"))
        }
    }
}

struct TeacherAssignmentsView: View {
    @EnvironmentObject var loc: LocalizationService
    var body: some View {
        NavigationStack {
            List(demoClasses) { c in
                HStack {
                    VStack(alignment:.leading) {
                        Text(c.book).font(.subheadline.weight(.semibold)).foregroundStyle(RPColor.ink)
                        Text("Class \(c.id) • \(c.deadline)").font(.caption).foregroundStyle(RPColor.muted)
                    }
                    Spacer()
                    Text("\(c.done)/\(c.students)").font(.caption.weight(.semibold)).foregroundStyle(RPColor.primary)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Zadania", "Assignments"))
        }
    }
}

struct TeacherStudentsView: View {
    @EnvironmentObject var loc: LocalizationService
    let rows = [("Alexandra N.", "Completed", "92%"), ("Bartosz K.", "Completed", "88%"), ("Celina W.", "In progress", "—"), ("Damian L.", "Not started", "—"), ("Ewa M.", "Completed", "81%")]
    var body: some View {
        NavigationStack {
            List(rows, id: \.0) { r in
                HStack {
                    VStack(alignment:.leading) {
                        Text(r.0).font(.subheadline.weight(.semibold)).foregroundStyle(RPColor.ink)
                        Text(r.1).font(.caption).foregroundStyle(RPColor.muted)
                    }
                    Spacer(); DemoTag()
                    Text(r.2).font(.caption).foregroundStyle(.secondary)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Uczniowie • 2A", "Students • 2A"))
        }
    }
}

// ═══ Challenges tab (publisher campaigns, live) ═══
struct ChallengesTabView: View {
    @EnvironmentObject var store: ChallengeStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @State private var campaigns: [BackendService.PublisherCampaign] = []
    var body: some View {
        NavigationStack {
            List {
                if campaigns.isEmpty {
                    Text(loc.t("Brak aktywnych wyzwań — zajrzyj do katalogu.", "No active challenges — browse the catalog."))
                        .font(.caption).foregroundStyle(RPColor.muted)
                } else {
                    ForEach(campaigns) { camp in
                        NavigationLink(destination: ChapterIntroView(
                            book: Book(id: camp.id, title: camp.title, author: camp.author ?? "Publisher", coverEmoji: "❦", coverUrl: camp.coverUrl, description: camp.description ?? "", totalChapters: 1, rewardPerChapter: camp.rewardLabel,
                                       chapters: [Chapter(id: camp.id, bookId: camp.id, index: 1, title: camp.title, summary: camp.description ?? "", contextExcerpt: "", reward: camp.rewardLabel)]),
                            chapter: Chapter(id: camp.id, bookId: camp.id, index: 1, title: camp.title, summary: camp.description ?? "", contextExcerpt: "", reward: camp.rewardLabel),
                            campaignId: camp.id)) {
                            CampaignRowClean(camp: camp)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Wyzwania", "Challenges"))
            .task { if let camps = await BackendService.shared.fetchCampaigns() { campaigns = camps } }
            .refreshable { if let camps = await BackendService.shared.fetchCampaigns() { campaigns = camps } }
        }
    }
}

// ═══ READER: My Reading (continue + history, compact) ═══
struct MyReadingView: View {
    @EnvironmentObject var store: ChallengeStore
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    var body: some View {
        NavigationStack {
            List {
                if let book = store.books.first {
                    Section {
                        NavigationLink(destination: BookDetailView(book: book)) {
                            VStack(alignment:.leading, spacing:6) {
                                Text(loc.t("Kontynuuj czytanie", "Continue reading"))
                                    .font(.caption.weight(.semibold)).foregroundStyle(RPColor.muted)
                                Text(book.title).font(.headline).foregroundStyle(RPColor.ink)
                                ProgressBar(value: appState.progress(for: book))
                            }.padding(.vertical, 4)
                        }
                    }
                }
                Section(loc.t("Historia czytania", "Reading history")) {
                    if appState.proofs.isEmpty {
                        Text(loc.t("Tu pojawią się Twoje książki i dowody.", "Your books and proofs will appear here."))
                            .font(.caption).foregroundStyle(RPColor.muted)
                    } else {
                        ForEach(appState.proofs) { p in
                            HStack {
                                VStack(alignment:.leading) {
                                    Text("\(p.bookId)").font(.subheadline.weight(.semibold)).foregroundStyle(RPColor.ink).lineLimit(1)
                                    Text("\(p.chapterId) • \(p.status.rawValue)").font(.caption).foregroundStyle(RPColor.muted)
                                }
                                Spacer()
                                Text("\(p.score)/\(p.total)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Moje czytanie", "My Reading"))
        }
    }
}

// ═══ Role-based tab roots ═══
struct StudentTabs: View {
    @EnvironmentObject var loc: LocalizationService
    @State private var tab = 0
    var body: some View {
        TabView(selection: $tab) {
            StudentHomeView().tabItem { Label(loc.t("Start", "Home"), systemImage: "house") }.tag(0)
            HomeView().tabItem { Label(loc.t("Moje książki", "My Books"), systemImage: "books.vertical") }.tag(1)
            ChallengesTabView().tabItem { Label(loc.t("Wyzwania", "Challenges"), systemImage: "target") }.tag(2)
            ProofsListView().tabItem { Label(loc.t("Certyfikaty", "Certificates"), systemImage: "checkmark.seal") }.tag(3)
            PassportView().tabItem { Label(loc.t("Profil", "Profile"), systemImage: "person") }.tag(4)
        }.tint(RPColor.primary).onAppear { setupTabBar() }
    }
}

struct ReaderTabs: View {
    @EnvironmentObject var loc: LocalizationService
    @State private var tab = 0
    var body: some View {
        TabView(selection: $tab) {
            ReaderHomeView().tabItem { Label(loc.t("Start", "Home"), systemImage: "house") }.tag(0)
            HomeView().tabItem { Label(loc.t("Odkrywaj", "Discover"), systemImage: "compass") }.tag(1)
            MyReadingView().tabItem { Label(loc.t("Moje czytanie", "My Reading"), systemImage: "book") }.tag(2)
            ProofsListView().tabItem { Label(loc.t("Dowody", "Proofs"), systemImage: "checkmark.seal") }.tag(3)
            PassportView().tabItem { Label(loc.t("Profil", "Profile"), systemImage: "person") }.tag(4)
        }.tint(RPColor.primary).onAppear { setupTabBar() }
    }
}

struct TeacherTabs: View {
    @EnvironmentObject var loc: LocalizationService
    @State private var tab = 0
    var body: some View {
        TabView(selection: $tab) {
            TeacherHomeView().tabItem { Label(loc.t("Start", "Home"), systemImage: "house") }.tag(0)
            TeacherClassesView().tabItem { Label(loc.t("Klasy", "Classes"), systemImage: "person.2") }.tag(1)
            TeacherAssignmentsView().tabItem { Label(loc.t("Zadania", "Assignments"), systemImage: "doc.text") }.tag(2)
            TeacherStudentsView().tabItem { Label(loc.t("Uczniowie", "Students"), systemImage: "person.3") }.tag(3)
            PassportView().tabItem { Label(loc.t("Profil", "Profile"), systemImage: "person") }.tag(4)
        }.tint(RPColor.primary).onAppear { setupTabBar() }
    }
}
