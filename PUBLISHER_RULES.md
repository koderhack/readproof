# ReadProof — Zasady dla Wydawców

**Wersja:** 1.0 — 20.09.2026  
**Kontakt:** publisher@readproof.app • panel: `https://koderhack.github.io/books/publisher/` • API: `https://frog02.mikr.us:32287/api/publisher/*`

---

## 1. Kim jest wydawca w ReadProof

Wydawca (publisher) to podmiot, który dodaje książkę/treść do ekosystemu ReadProof i funduje pulę nagród (USDC/SOL Devnet, docelowo Mainnet) za udowodnione zrozumienie lektury przez czytelników (Proof of Comprehension, nie proof-of-physical-reading).

Wydawca **nie** musi być właścicielem druku — wystarczy prawo do dystrybucji treści cyfrowej w ramach kampanii. Pełna treść książki **nigdy** nie trafia on-chain, zostaje server-only (hash SHA-256).

---

## 2. Wymagania przy dodaniu książki

### 2.1 Dane obowiązkowe (POST /api/publisher/campaigns)

| Pole | Wymagane | Format | Opis |
|------|----------|--------|------|
| `publisherWallet` | tak | Solana address 32-44 base58 (Devnet) | Portfel wydawcy — właściciel kampanii, tylko on może fund/start |
| `title` | tak | string 3-256 znaków | Tytuł kampanii/książki |
| `author` | nie | string | Autor — domyślnie `Unknown` |
| `isbn` | zalecane | 10 lub 13 cyfr (np. `9780140448955`) | Walidacja `isValidISBN`, normalizacja bez myślników. Duplikaty ISBN są dozwolone między kampaniami (różne pule nagród) |
| `description` | nie | string | Krótki opis, widoczny w kampanii |
| `rewardPerProof` | nie | number, domyślnie `5` | Nagroda za 1 zweryfikowany dowód (np. 5 USDC) |
| `currency` | nie | `USDC` / `SOL`, domyślnie `USDC` | Waluta nagród |
| `coverUrl` | nie | URL | Okładka (Open Library lub własna) |

**Przykład curl:**
```bash
curl -X POST https://frog02.mikr.us:32287/api/publisher/campaigns \
  -H "Content-Type: application/json" \
  -d '{
    "publisherWallet": "9W3k6Vuhq...",
    "title": "Boska Komedia — Piekło",
    "author": "Dante Alighieri",
    "isbn": "9780140448955",
    "description": "Wędrówka przez las...",
    "rewardPerProof": 5,
    "currency": "USDC",
    "coverUrl": "https://covers.openlibrary.org/b/isbn/9780140448955-L.jpg"
  }'
```

Odpowiedź: `{ok:true, campaign:{id:"camp-xxxx", qr:{url, scheme, qrApi}, ...}}`

### 2.2 Treść książki (POST /api/publisher/campaigns/:id/content)

- **Wymagane** przed `fund` i `start` — bez treści kampania jest `draft` i nie wystartuje.
- Wysyłasz **pełny tekst** (plain text) — backend liczy `SHA-256` i `contentLength`, nie zapisuje pełnego tekstu on-chain.
- Limit: do kilku MB, plain text (bez PDF/EPUB — konwertuj wcześniej).
- **Prawo autorskie:** wydawca oświadcza, że ma prawo do użycia treści. Dla Gutenberg (`alice.txt` itd.) to public domain — wklej tekst legalnie. Dla własnych tytułów — tylko własne prawa.
- Endpoint:
```bash
curl -X POST https://frog02.mikr.us:32287/api/publisher/campaigns/camp-xxxx/content \
  -H "Content-Type: application/json" \
  -d '{"content": "Pełny tekst książki..."}'
```

### 2.3 Okładka i metadane

- `coverUrl` opcjonalnie — jeśli brak, używamy Open Library po ISBN.
- `contentLength` i `bookContentHash` widoczne w `GET /api/publisher/campaigns/:id`.

---

## 3. Fundowanie i statusy kampanii

| Status | Znaczenie |
|--------|-----------|
| `draft` | Utworzona, brak treści lub funduszy |
| `active` | Ma treść + `rewardPool > 0` — można startować sesje |
| `paused` / `ended` | Ręcznie (przyszłość) |

### Fund (POST /api/publisher/campaigns/:id/fund)

- Tylko `publisherWallet` (właściciel) może fundować.
- `amount` (number) + `currency` + opcjonalnie `txSignature` (real Devnet USDC) — bez `txSignature` tworzymy mock `mock-...`.
- Po fund `rewardPool` rośnie, `status` → `active`, zapis w `readproof_funds`.
- Explorer: `https://explorer.solana.com/tx/<sig>?cluster=devnet`

**Bez funduszy sesje nie wystartują** — `POST /start` sprawdzi `rewardPool`.

---

## 4. Jak to działa po dodaniu

1. Wydawca dodaje kampanię (`draft`) → dodaje treść → funduje pulę (`active`).
2. Czytelnik w iOS (ReadProof) wybiera kampanię po ISBN/QR (`readproof://campaign/:id` lub `https://koderhack.github.io/books/publisher/?campaign=…`).
3. Start sesji: `POST /api/publisher/campaigns/:id/start` — losuje 5 z 30 pytań (LLM z pełnego tekstu server-only), timing `5 min/pytanie` (real) / `2 min` (demo), bez blokady 30 min.
4. Pytania: `multiple_choice`, `true_false`, `who_said`, `ordering`, `open_question` (Jev TypeSafe) itd. — każde sprawdzane server-side, Jev dla otwartych (próg `0.28` Typesafe + keyword fallback wiedźma/wróżka).
5. Po 5 odpowiedziach `POST /complete` → `runVerification` (suspicious, min_duration 35% + perfect score, proofHash SHA-256) → `Reading Verified` → nagroda `rewardPerProof` z puli, `proofHash` na Solana Devnet (hash tylko, nie treść).

---

## 5. Zasady jakości i moderacji

- **Brak plagiatu / nielegalnej treści** — kampanie z naruszeniem praw będą dezaktywowane.
- **Język:** treść może być PL lub EN — LLM generuje pytania w języku urządzenia czytelnika (`X-Lang`).
- **Weryfikacja treści:** treść nie jest publiczna — hash wystarczy do weryfikacji.
- **Prywatność:** na chain trafia tylko `wallet, bookId, chapterId, sessionId, score, duration, proofHash, timestamp`. Nigdy: treść, odpowiedzi, prompt.
- **Devnet only** w MVP — prawdziwe USDC dopiero po audycie.

---

## 6. Rozliczenia

- Każda zweryfikowana sesja (5/5) pobiera `rewardPerProof` z `rewardPool`. Gdy pula = 0, sesje nie startują — doładuj.
- `GET /api/publisher/campaigns/:id/funds` — historia wpłat.
- `GET /api/publisher/campaigns?publisherWallet=…` — wszystkie Twoje kampanie.

---

## 7. Panel i narzędzia

- **Web panel:** `https://koderhack.github.io/books/publisher/` — dodawanie, QR, głęboki link `readproof://`.
- **QR:** `GET /api/publisher/campaigns/:id/qr` → `{qrPngUrl, url, scheme}` — wydrukuj na okładce.
- **Lookup:** `GET /api/publisher/lookup?q=978014...` — znajdź kampanię po ISBN/id.

---

## 8. Kontakt i wsparcie

Zgłoszenia: GitHub Issues `koderhack/readproof` • mail `publisher@readproof.app` • Telegram (wkrótce).

> Dołącz jako pierwszy wydawca — 5 miejsc pilotażowych z pełnym wsparciem integracji i promocją w apce.

