import SwiftUI

struct PassportView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var loc: LocalizationService
    @State private var input=""
    @State private var showCopied=false

    var body: some View {
        NavigationStack{
            List{
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
                        Button{
                            PhantomService.openPhantom()
                        } label: {
                            Label(loc.t("Otwórz Phantom","Open Phantom"), systemImage:"wallet.pass.fill")
                        }
                        HStack{
                            TextField("Solana address (Devnet)", text:$input)
                                .font(.caption.monospaced()).foregroundStyle(RPColor.ink).autocorrectionDisabled().textInputAutocapitalization(.never)
                            Button(loc.t("Połącz","Connect")){
                                guard PhantomService.isValidSolanaAddress(input) else { return }
                                appState.connectWallet(address: input); input=""
                            }.disabled(!PhantomService.isValidSolanaAddress(input))
                        }
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

                Section{ Text("Profil minimal — tylko portfel, język i backend. Statystyki z realnych proofów.").font(.caption).foregroundStyle(RPColor.muted) }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(loc.t("Paszport","Passport"))
        }
    }
}
typealias WalletView = PassportView
