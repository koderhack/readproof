# ReadProof — Kolegium ReadProof

**Hasło:** *Read a real book. Prove you understood it. Get rewarded.*

Aplikacja iOS (SwiftUI) + Backend (Node + SQLite) zachęcająca do czytania **fizycznych** książek przygodowych poprzez 5-zadaniowe Reading Challenge'e weryfikujące zrozumienie treści. Nagrody testowe na **Solana Devnet** (mock USDC).

Design: **parchment / burgundy / gold** — styl akademicki jak na screenach (Kolegium, Sigillum, Paszport Literacki, Karta Archiwalna). Bez „crypto casino”.

---

## 1. Książki — 5 przygodowych, pełny tekst domena publiczna

Wszystkie teksty legalnie z **Project Gutenberg (USA public domain)**, nie są ebook readerem — pełny tekst jest w bundlu jako podgląd/źródło dla LLM/Jev, ale główną lekturą jest fizyczna książka.

| # | Tytuł | Autor | Gutenberg | Plik bundla | Rozdziały w MVP |
|---|-------|-------|-----------|-------------|-----------------|
| 1 | Alice's Adventures in Wonderland | Lewis Carroll | [#11](https://www.gutenberg.org/ebooks/11) | `alice.txt` | 3: Down the Rabbit-Hole / Pool of Tears / Caucus-Race |
| 2 | The Adventures of Sherlock Holmes | Arthur Conan Doyle | [#1661](https://www.gutenberg.org/ebooks/1661) | `sherlock.txt` | 2: A Scandal in Bohemia / Red-Headed League |
| 3 | Treasure Island | Robert Louis Stevenson | [#120](https://www.gutenberg.org/ebooks/120) | `treasure.txt` | 2: Old Sea-Dog / Black Dog |
| 4 | The Adventures of Tom Sawyer | Mark Twain | [#74](https://www.gutenberg.org/ebooks/74) | `tomsawyer.txt` | 2: The Fence / Jackson's Island |
| 5 | Around the World in Eighty Days | Jules Verne | [#103](https://www.gutenberg.org/ebooks/103) | `around.txt` | 2: Fogg Bets £20k / Detective Fix |

W UI: *Book Detail → „Pełny tekst z domeny publicznej (Gutenberg #…)" → Czytaj fragment (TextViewer, `*.txt` z bundla) + link do źródła + licencja.*  
Docelowo autor/wydawca może wgrać własny tekst — tu pokazujemy mechanizm.

---

## 2. Backend (lokalnie — na razie testujemy lokalnie)

### Stack
- **Node.js 20 + Express 4** — `backend/server.js:5`
- **SQLite (sqlite3)** — `readproof.db`, tabele `proofs`
- **CORS** otwarte dla iOS/Simulator
- **LLM**: OpenRouter — **free routing/model** (domyślnie `meta-llama/llama-3.2-3b-instruct:free`), cache'uje 8–12 challenge'y → wybiera 5 różnych typów. Fallback = bundled `challenges.json` (patrz niżej).
- **Jev**: `POST /api/evaluate` — najpierw OpenRouter free, potem mock keyword-overlap (próg **0.80**, konfigurowalny `JEV_THRESHOLD`).
- **Solana**: mock Devnet — SHA256 `proofHash` + mock base58 signature 88 znaków + `https://explorer.solana.com/tx/…?cluster=devnet` + `GET /api/wallet/:address` saldo `12.50 USDC (Devnet)`. Hook `SOLANA_RPC=https://api.devnet.solana.com` gotowy na real RPC.

### Uruchomienie lokalne
```bash
cd backend
npm install
cp .env.example .env   # uzupełnij OPENROUTER_API_KEY jeśli masz, inaczej działa mock Jev
# .env domyślnie:
# PORT=32288
# OPENROUTER_MODEL=meta-llama/llama-3.2-3b-instruct:free
# JEV_THRESHOLD=0.80
# SOLANA_RPC=https://api.devnet.solana.com

node server.js
# → ReadProof backend :32288 books=5 openrouter=false jevThresh=0.8

# test:
curl http://127.0.0.1:32288/health | jq
curl http://127.0.0.1:32288/api/books | jq '.[0].title'
curl http://127.0.0.1:32288/api/books/alice/chapters/alice-ch1/challenge | jq
curl -X POST http://127.0.0.1:32288/api/evaluate -H "Content-Type: application/json" \
  -d '{"question":"Dlaczego drzwi były problemem?","expectedMeaning":"Drzwi za małe, kluczyk nie pasował","userAnswer":"Bo były zamknięte i za małe","context":"Korytarz"}' | jq
```

Backend jest **za proxy** na Frog gdy wdrożysz: `frog02.mikr.us:32287` → `/api/subscribe` → `:8081`, reszta → `:32288`. Lokalnie wystarczy `:32288`.

### Endpointy
```
GET  /health
GET  /api/books
GET  /api/books/:bookId
GET  /api/books/:bookId/chapters/:chapterId/challenge  # 5 różnych typów, co najmniej 1 Jev
GET  /api/challenges/:chapterId?pick=5
POST /api/evaluate  {question, expectedMeaning, userAnswer, context} → {correct, confidence, reason, source}
POST /api/proofs    {bookId, chapterId, challenges, answers, walletAddress} → ReadingProof + mock Solana tx
GET  /api/proofs?wallet=0x...
GET  /api/wallet/:address
POST /api/generate  {bookId, chapterId, count} → LLM OpenRouter free generuje 8–12, waliduje JSON, zapisuje do challenges.json
GET  /api/books/:bookId/text  # pierwsze 50k znaków pełnego tekstu
```

**LLM cache:** pytania generowane **raz** ( lub `POST /api/generate` dla autora) i zapisane w `backend/challenges.json` + SQLite, nie wywoływane przy każdym `Start Challenge`. Oszczędność kosztów.

**Jev nie generuje challenge'y** — tylko ocenia `open_question` / `why_question` (whitelist typów w `ChallengeType.requiresJev`).

---

## 3. iOS App (Swift, SwiftUI, mobile-first)

### Wymagania
- Xcode 15+, iOS 17+, Simulator iPhone 16 Pro
- `xcodegen` (ma `project.yml` → generuje `ReadProof.xcodeproj`)

### Uruchomienie
```bash
xcodegen generate
open ReadProof.xcodeproj
# wybierz scheme ReadProof → iPhone 16 Pro (iOS 18.2) → Run
```

### Architektura Swift
- `Models/Models.swift:5` — `Book`, `Chapter`, `Challenge` (12 typów: `multiple_choice` … `memory`), `ReadingProof`, `Scoring.jevThreshold=0.80`
- `Services/ChallengeStore.swift:31` — `pickFive()` dywersyfikuje typy + wymusza 1× Jev
- `Services/JevService.swift:17` — `evaluate()` → Backend `/api/evaluate` → direct OpenRouter free → mock keyword-recall
- `Services/SolanaService.swift:12` — `createProofHash()` SHA256 + `mockSignature()` + `sendReward()` (900ms delay) + `checkDevnet()`
- `Services/BackendService.swift` — wrapper na `http://127.0.0.1:32288` (konfigurowalny w Paszporcie), fallback do bundla gdy offline
- `Services/LLMService.swift:12` — `generateChallenges()` OpenRouter free → walidacja JSON
- `Views/` — **Design.swift** parchment/burgundy, **HomeView** (Explore Challenges, Featured Tome, Trending Sprints, Recent Verifications), **BookDetailView** (Gutenberg source + TextViewer), **ChapterIntroView**, **ChallengeFlowView** (Questio + burgundy ABCD + reflection bonus + Submit & Verify), **ResultView** (Sigillum, Dowód Zatwierdzony!, Karta Archiwalna, Kwit +$15), **WalletView/PassportView** (Paszport Literacki, Stan Skarbca, metryki, backend URL)

### Flow demo (P0 — 24h hackathon)
1. Otwieram ReadProof na telefonie → **Explore Challenges**
2. Wybieram *Alice’s Adventures in Wonderland* → *Chapter 1 — Reward 5 USDC*
3. Ekran: „Przeczytaj rozdział w fizycznej książce” + podgląd pełnego tekstu (Gutenberg)
4. **Start Reading Challenge** → 5 różnych zadań (np. ABCD + Who Said It? + Open Question → Jev + Ordering + What Happened Next?)
5. Jedno otwarte oceniane przez Jev (backend / OpenRouter free / mock)
6. **Reading Verified** (4–5/5) lub Try Again (3/5) / Failed (<3)
7. **Proof hash + txSignature mock + Explorer link (Devnet)** → *View Proof*
8. Scenariusz błędny: <4/5 → brak reward, retry

### Scoring
- `5/5 → verified`, `4/5 → verified`, `3/5 → try again`, `<3 → failed` (`Models.swift:174`)
- `JEV_THRESHOLD=0.80` — jedno miejsce konfigurowalne (`backend/.env` + `JevService` + `Scoring`).

---

## 4. OpenRouter free — gdzie ustawić klucz

- **Backend (preferowane dla lokalnych testów):** `backend/.env` → `OPENROUTER_API_KEY=sk-or-v1-...` — backend użyje go dla `/api/evaluate` i `/api/generate`, appka i tak przejdzie przez backend.
- **Aplikacja (fallback):** Paszport → Ustawienia → *OpenRouter API Key* + model (zapis do `UserDefaults`). Jeśli brak klucza — działa **mock Jev** (keyword recall) i **bundled challenges.json** — zero kosztów.

Rekomendowany model free: `meta-llama/llama-3.2-3b-instruct:free` (routing `:free` w OpenRouter).

---

## 5. Wdrożenie na Frog (gdy przestaniesz testować lokalnie)

```bash
# z Maca:
tar czf readproof-backend.tar.gz -C backend .
scp -P 12287 readproof-backend.tar.gz frog@frog02.mikr.us:/home/frog/
ssh frog@frog02.mikr.us -p 12287 "mkdir -p readproof-backend && tar xzf readproof-backend.tar.gz -C readproof-backend && cd readproof-backend && npm install --omit=dev && cat > .env <<'ENV'
PORT=32288
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=meta-llama/llama-3.2-3b-instruct:free
JEV_THRESHOLD=0.80
SOLANA_RPC=https://api.devnet.solana.com
ENV
nohup node server.js > /tmp/readproof.log 2>&1 & echo ok; sleep 1; curl -s http://127.0.0.1:32288/health"

# app: Paszport → Backend URL = http://frog02.mikr.us:32287
```

Proxy na Frog (`/srv/newsletter/proxy.js:8`) już kieruje resztę ruchu z `:32287` na `:32288`, więc zewnętrzny URL to `frog02.mikr.us:32287`.

---

## 6. Kryterium gotowości (MVP P0)

- [x] 5 książek przygodowych, pełny tekst public domain, legalny
- [x] rozdziały + 5 challenge'y o **różnych** typach (LLM generuje 8–12, wybieramy 5)
- [x] LLM OpenRouter free (cache, walidowany JSON)
- [x] Jev/mock Jev tylko dla otwartych (próg 0.80)
- [x] wynik + Reading Verified / Try Again
- [x] wallet (demo + real address) + Solana Devnet proof/reward (mock sig + Explorer)
- [x] flow end-to-end na telefonie (Simulator)

Nie robimy w MVP: własny token `$NERD`, DAO, marketplace, setki książek, social, ebook reader, real-money.

---

## 7. Struktura

```
readproof/
├── project.yml                 # xcodegen
├── ReadProof.xcodeproj/
├── ReadProof/
│   ├── App/ReadProofApp.swift
│   ├── Models/Models.swift
│   ├── Services/{ChallengeStore,JevService,SolanaService,LLMService,BackendService,AppState}.swift
│   ├── Views/{Design,HomeView,BookDetailView,ChapterIntroView,ChallengeFlowView,ResultView,WalletView,BackendHealthView}.swift
│   ├── Resources/{challenges.json, PublicDomainTexts/*.txt, Assets.xcassets}
│   └── Info.plist
├── backend/                    # Node backend (lokalnie :32288)
│   ├── server.js
│   ├── challenges.json         # cache LLM
│   ├── texts/*.txt             # pełne teksty Gutenberg
│   ├── .env
│   └── package.json
└── README.md
```

Po zakończeniu lokalnych testów `kill $(cat /tmp/readproof-backend.pid)` lub `pkill -f "node server.js"` gdy przenosisz na Frog.
