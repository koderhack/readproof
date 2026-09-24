import SwiftUI
import AuthenticationServices

struct PassportView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @StateObject private var auth = AuthService.shared
    @State private var input=""
    @State private var showCopied=false
    @State private var guestName=""

    private func roleAccent() -> Color {
        (appState.role ?? .reader).accent
    }

    var body: some View {
        NavigationStack{
            List{
                Section(loc.t("Rola", "Role")){
                    HStack{
                        Image(systemName: appState.role?.symbol ?? "person.fill")
                            .foregroundStyle(roleAccent())
                        Text(appState.role?.title ?? loc.t("Nie wybrano", "Not chosen"))
                        Spacer()
                        Button(loc.t("Zmień", "Change")){ appState.clearRole() }.font(.caption.weight(.semibold))
                    }
                }
                Section{
                    HStack(spacing:12){
                        Circle().fill(Color(hex:"#E5E7EB")).frame(width:48,height:48).overlay(Image(systemName:"person.fill").foregroundStyle(RPColor.muted))
                        VStack(alignment:.leading, spacing:2){
                            Text(appState.wallet.address ?? loc.t("Niepołączony","Not connected")).font(.headline).lineLimit(1)
                            if let a = appState.wallet.address {
                                Text(String(a.prefix(12))+"…").font(.caption.monospaced()).foregroundStyle(RPColor.muted)
                            } else {
                                Text(loc.t("Połącz Phantom (Devnet)","Connect Phantom (Devnet)")).font(.caption).foregroundStyle(RPColor.muted)
                            }
                        }
                        Spacer()
                        if appState.wallet.isConnected {
                            Button("Rozłącz", role:.destructive){ appState.disconnect() }.font(.caption)
                        }
                    }
                } header: { Text(loc.t("Portfel","Wallet")) }

                if !appState.wallet.isConnected {
                    Section(loc.t("Połącz","Connect")){
                        Text("Wybierz portfel — działa z każdym Solana wallet, nie tylko Phantom").font(.caption2).foregroundStyle(RPColor.muted)
                        ForEach([WalletProvider.phantom, .solflare, .backpack, .glow, .magicEden, .brave, .walletConnect], id:\.id) { p in
                            Button{
                                WalletService.open(p)
                            } label: {
                                Label(p.displayName, systemImage: p.icon)
                            }
                        }
                        Button{
                            if let u = URL(string: "https://solana.com/ecosystem/explore?categories=wallet") { UIApplication.shared.open(u) }
                        } label: { Label("Więcej portfeli (Solana Explorer)", systemImage:"ellipsis.circle") }
                        Divider()
                        HStack{
                            TextField("Solana address (Devnet) — wklej z dowolnego portfela", text:$input)
                                .font(.caption.monospaced()).foregroundStyle(RPColor.ink).autocorrectionDisabled().textInputAutocapitalization(.never)
                            Button(loc.t("Połącz","Connect")){
                                guard WalletService.isValidSolanaAddress(input) else { return }
                                appState.connectWallet(address: input); input=""
                            }.disabled(!WalletService.isValidSolanaAddress(input))
                        }
                        Text("Gotowy SDK: Reown AppKit (WalletConnect v2) — dodaj SPM `reown-swift` + REOWN_PROJECT_ID, a przycisk WalletConnect otworzy 300+ portfeli jednym SDK. Teraz działa deeplink + wklejenie adresu.").font(.caption2).foregroundStyle(RPColor.muted)
                        if let addr = appState.wallet.address, let url = URL(string:"https://explorer.solana.com/address/\(addr)?cluster=devnet"){
                            Link(destination: url){ Label("Explorer Devnet", systemImage:"link") }
                        }
                    }
                    Section{
                        Link(destination: URL(string:"https://faucet.solana.com")!){ Label("Faucet SOL Devnet", systemImage:"drop") }
                        Link(destination: URL(string:"https://faucet.circle.com")!){ Label("Faucet USDC Devnet", systemImage:"dollarsign.circle") }
                    } header: { Text("Test funds") } footer: { Text("USDC mint Devnet: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU") }
                } else {
                    Section{
                        HStack{ Text("Address"); Spacer(); Text(appState.wallet.address ?? "").font(.caption2.monospaced()).foregroundStyle(RPColor.muted).lineLimit(1).truncationMode(.middle) }
                        Button(showCopied ? "Skopiowano" : "Kopiuj"){
                            UIPasteboard.general.string = appState.wallet.address; showCopied=true; DispatchQueue.main.asyncAfter(deadline:.now()+1.2){ showCopied=false}
                        }
                        if let addr = appState.wallet.address, let url = URL(string:"https://explorer.solana.com/address/\(addr)?cluster=devnet"){
                            Link(destination: url){ Label("Explorer Devnet", systemImage:"link") }
                        }
                    } header: { Text("Wallet") }
                }

                Section(loc.t("Język","Language")){
                    Picker(loc.t("Język pytań","Question language"), selection: Binding(get:{loc.current}, set:{loc.current=$0})){
                        ForEach(AppLanguage.allCases, id:\.rawValue){ l in Text("\(l.flag) \(l.displayName)").tag(l) }
                    }.pickerStyle(.segmented)
                    Text(loc.t("Pytania generowane live w wybranym języku (LLM), nawet gdy tekst EN.","Questions generated live in chosen language (LLM), even if text is EN.")).font(.caption).foregroundStyle(RPColor.muted)
                }

                Section("Backend"){
                    HStack{
                        TextField("https://frog02.mikr.us:32287", text: Binding(get:{UserDefaults.standard.string(forKey:"backend_url") ?? ""}, set:{UserDefaults.standard.set($0, forKey:"backend_url")}))
                            .font(.caption.monospaced()).autocorrectionDisabled().textInputAutocapitalization(.never)
                        Button("Test"){ Task{ _=await BackendService.shared.checkHealth() } }
                    }
                    BackendHealthView()
                    SecureField("Hasło trybu testowego", text: Binding(get:{UserDefaults.standard.string(forKey:"admin_dev_password") ?? ""}, set:{UserDefaults.standard.set($0, forKey:"admin_dev_password")}))
                        .font(.caption.monospaced()).autocorrectionDisabled().textInputAutocapitalization(.never)
                    Text("Hasło: hackathon2026@ — wymagane do Admin Dev Mode (bez blokad, bez czekania).").font(.caption2).foregroundStyle(RPColor.muted)
                    Toggle(isOn: Binding(
                        get:{ UserDefaults.standard.bool(forKey:"admin_dev_mode") && (UserDefaults.standard.string(forKey:"admin_dev_password") ?? "") == "hackathon2026@" },
                        set:{ UserDefaults.standard.set($0 && (UserDefaults.standard.string(forKey:"admin_dev_password") ?? "") == "hackathon2026@", forKey:"admin_dev_mode") }
                    )) {
                        Label("Admin Dev Mode — bez czekania", systemImage:"hammer.fill")
                    }.tint(RPColor.primary)
                    if UserDefaults.standard.bool(forKey:"admin_dev_mode") && (UserDefaults.standard.string(forKey:"admin_dev_password") ?? "") == "hackathon2026@" {
                        Text("Włączone: sesje odblokowują wszystkie 5 wyzwań natychmiast (X-Dev-Mode), brak blokad. Do testów.").font(.caption2).foregroundStyle(RPColor.peach)
                    } else if UserDefaults.standard.bool(forKey:"admin_dev_mode") {
                        Text("Hasło nieprawidłowe — tryb nieaktywny.").font(.caption2).foregroundStyle(.red)
                    }
                    Toggle(isOn: Binding(get:{UserDefaults.standard.bool(forKey:"pitch_demo_mode")}, set:{UserDefaults.standard.set($0, forKey:"pitch_demo_mode")})) {
                        Label("Pitch Demo Mode — łagodniejszy anti-cheat", systemImage:"flag.fill")
                    }.tint(RPColor.primary)
                    if UserDefaults.standard.bool(forKey:"pitch_demo_mode") {
                        Text("Na scenę: wyższy próg kamery (fail ≥ 6 zamiast 3), debounce i PhoneBack 0.78. Produkcja bez tego przełącznika.").font(.caption2).foregroundStyle(RPColor.peach)
                    }
                    Text("Frontend nie wysyła AI. LLM (OpenRouter free) i Jev (TypeSafe jev-latest) tylko przez backend.").font(.caption2).foregroundStyle(RPColor.muted)
                }

                Section(header: Text("Konto"), footer: Text(auth.isSignedIn ? "Zalogowany jako \(auth.displayName) (\(auth.user?.authProvider.rawValue ?? "")) — ID używane jako X-User-Id do sesji." : "Sign in with Apple wymaga włączenia capability w Apple Developer Console. Na symulatorze użyj Gościa.").font(.caption2).foregroundStyle(RPColor.muted)) {
                    if auth.isSignedIn {
                        HStack{
                            Image(systemName: auth.user?.authProvider == .apple ? "applelogo" : "person.fill").foregroundStyle(RPColor.primary)
                            VStack(alignment:.leading, spacing:2){
                                Text(auth.displayName).font(.subheadline.weight(.semibold)).foregroundStyle(RPColor.ink)
                                Text(auth.userId ?? "").font(.caption2.monospaced()).foregroundStyle(RPColor.muted).lineLimit(1)
                                if let tok = auth.user?.sessionToken { Text("session: \(tok.prefix(8))…").font(.caption2.monospaced()).foregroundStyle(RPColor.muted) }
                            }
                            Spacer()
                            Button("Wyloguj", role:.destructive){ auth.signOut(); appState.logout() }.font(.caption.weight(.semibold))
                        }
                    } else {
                        SignInWithAppleButton(.signIn, onRequest: { r in r.requestedScopes = [.fullName, .email] }, onCompletion: { res in
                            Task { await auth.appleSignIn() }
                        })
                        .signInWithAppleButtonStyle(.black)
                        .frame(height: 44)
                        .cornerRadius(10)
                        Button{
                            Task { await auth.appleSignIn() }
                        } label: { Label("Zaloguj przez Apple", systemImage:"applelogo").font(.subheadline.weight(.semibold)) }
                        HStack{
                            TextField("Nick gościa", text:$guestName).font(.caption).autocorrectionDisabled()
                            Button("Gość"){ auth.devSignIn(nickname: guestName.isEmpty ? nil : guestName); guestName="" }.font(.caption.weight(.bold)).tint(RPColor.primary)
                        }
                        if let e = auth.authError { Text(e).font(.caption2).foregroundStyle(.red) }
                        Text("Gość = DevMode fallback bez Apple capability — działa na symulatorze.").font(.caption2).foregroundStyle(RPColor.muted)
                    }
                }

                Section{ Text("Profil minimal — portfel + konto Apple/Gość, język i backend. Statystyki z realnych proofów.").font(.caption).foregroundStyle(RPColor.muted) }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Paszport","Passport"))
        }
    }
}
typealias WalletView = PassportView
