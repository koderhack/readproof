# ReadProof — przeczytaj prawdziwą książkę, udowodnij zrozumienie, zgarnij nagrodę

**EN tagline:** *Read a real book. Prove you understood it. Get rewarded.*

Aplikacja **iOS (SwiftUI)** + **backend (Node + Solana Devnet)**. Czytelnik czyta **fizyczną książkę**,
a apka weryfikuje zrozumienie przez 5 zadań na rozdział. Zweryfikowany dowód (`5/5`) trafia na
**Solana Devnet** jako `proofHash` — nagroda **5 USDC (Devnet)** z puli wydawcy.

Design: **parchment / burgundy / gold** — Kolegium, Sigillum, Paszport Literacki. Bez „crypto casino”.

---

## 🔗 Linki (hackathon)

| Co | Link |
|----|------|
| 🌐 Strona publiczna | https://kacpersikora.pages.dev/books |
| 💊 Health backendu | https://frog02.mikr.us:32287/health |
| 🏪 Panel wydawcy | https://koderhack.github.io/books/publisher/ |
| 📜 Zasady wydawców | [PUBLISHER_RULES.md](PUBLISHER_RULES.md) |
| 🎬 Scenariusz demo (60 s) | [docs/DEMO.md](docs/DEMO.md) |
| 📦 To repo | https://github.com/koderhack/readproof |

---

## 🎬 Demo w 60 sekund

1. **Paszport** → *Sign in with Apple* (na symulatorze: *Gość*) — portfel podpina się sam.
2. **Katalog** → *Alice in Wonderland* → rozdział 1 → *Akceptuję zasady — rozpocznij test*.
3. Odpowiedz na pytania (ABCD, *Kto to powiedział?*, otwarte z AI-Jev, układanie kolejności ↑/↓).
4. Masz **3 ❤️** — po błędzie apka pokazuje **poprawną odpowiedź**.
5. **ZAKOŃCZ I ZWERYFIKUJ** → *Reading Verified* → hash + link do Solana Explorera (Devnet).

Pełny scenariusz z timingiem: [docs/DEMO.md](docs/DEMO.md).

---

## 🧩 Jak to działa

- **Pytania z pełnego tekstu na serwerze** — LLM (OpenRouter `deepseek-v4-flash`, free) losuje 5 z ~30
  na sesję, w języku urządzenia. Pełna treść **nigdy** nie trafia on-chain (tylko hash SHA-256).
- **Jev (TypeSafe `jev-latest`)** ocenia pytania otwarte + łagodny keyword-fallback
  (rozumie np. *wiedźma ≈ dobra wróżka*).
- **Anti-cheat bez blokad czasowych** — 5 min na pytanie, brak cooldownu 30 min.
  Kamera front wykrywa drugi telefon (tylko wskaźnik *aktywna/wyłączona*),
  screenshot/screen-recording kończy sesję. Fałszywe alarmy złagodzone.
- **Konto = Apple, nie portfel** — po *Sign in with Apple* syntetyczny adres Devnet podpina się sam.
  Kto chce, podepnie Phantom / Solflare / Backpack / Glow / Brave / WalletConnect (lista w Paszporcie).
- **Wydawcy** dodają książki przez API (`POST /api/publisher/campaigns` → treść → fundusz → `active`),
  fundują pulę nagród, drukują QR na okładkę. Szczegóły: [PUBLISHER_RULES.md](PUBLISHER_RULES.md).

### Książki w MVP

5 klasyków z **Project Gutenberg (USA public domain)**: Alice, Sherlock Holmes, Treasure Island,
Tom Sawyer, Around the World — pełne teksty w `ReadProof/Resources/PublicDomainTexts/` i `backend/texts/`.
Główną lekturą jest fizyczna książka; tekst w bundlu to źródło pytań + podgląd.

---

## 🚀 Quickstart

### Backend

```bash
cd backend
npm install
cp .env.example .env   # uzupełnij klucze (nigdy nie commituj .env!)
node server.js         # → https://0.0.0.0:32288 (health: /health)
```

### iOS

```bash
xcodegen generate
open ReadProof.xcodeproj
# scheme ReadProof → iPhone 16 Pro → Run
```

Wymagania: Xcode 15+, iOS 17+. Backend URL zmienisz w apce: **Paszport → Backend**.

### Deploy backendu (mikrus)

```bash
tar czf readproof-backend.tar.gz -C backend .
scp -P 12287 readproof-backend.tar.gz frog@frog02.mikr.us:/home/frog/
ssh frog@frog02.mikr.us -p 12287 "cd readproof-backend && tar xzf ../readproof-backend.tar.gz && npm rebuild sqlite3 && (nohup node server.js > /tmp/readproof.log 2>&1 &)"
```

Uwaga: wysyłaj **pliki źródłowe** (`server.js`, `verification.js`), nie cały `node_modules`
(natywne moduły budowane na mikrusie przez `npm rebuild sqlite3`).

---

## 🗂 Struktura repo

```
readproof/
├── README.md                 # ten plik
├── PUBLISHER_RULES.md        # zasady dla wydawców (v1.0)
├── docs/DEMO.md              # scenariusz demo 60 s
├── LICENSE                   # MIT
├── project.yml               # xcodegen → ReadProof.xcodeproj
├── ReadProof/                # apka iOS (App, Models, Services, Views, Resources)
├── ReadProofLiveActivity/    # widget / Live Activity
├── backend/                  # Node backend (server.js, verification.js, texts/)
│   └── .env.example          # wzór sekretów (prawdziwy .env tylko lokalnie!)
└── public/books/             # strona statyczna → kacpersikora.pages.dev/books
```

---

## 🔒 Sekrety

Prawdziwe klucze są **tylko** w `backend/.env` (lokalnie / na mikrusie) i **nigdy** w repo.
W repo jest wyłącznie `backend/.env.example` z placeholderami.
Klucze prywatne Solana trzymaj poza repo (np. `pitch/.secrets/` — ignorowane przez git).

---

## 📄 Licencja

MIT — zob. [LICENSE](LICENSE).
