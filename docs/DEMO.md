# ReadProof — scenariusz demo (60 s)

Cel: w minutę pokazać pełną pętlę **czytaj → udowodnij → nagroda**.
Zapasowy plan na końcu, gdyby coś padło na scenie.

## Przygotowanie (przed wejściem na scenę)

- [ ] iPhone z buildem z `main`, zalogowany (Paszport → Konto).
- [ ] Backend żyje: https://frog02.mikr.us:32287/health → `"status":"ok"`.
- [ ] W apce: Paszport → Backend → URL na `https://frog02.mikr.us:32287`, *Test* → zielono.
- [ ] Admin Dev Mode **WYŁĄCZONY** (chyba że chcesz instant — wtedy włącz + hasło).
- [ ] Ciemny ekran / tryb samolotowy WYŁĄCZONY, kamera odblokowana (wskaźnik *aktywna*).

## Scenariusz (60 s)

| Czas | Co robisz | Co mówisz |
|------|------------|-----------|
| 0:00–0:10 | Katalog → *Alice in Wonderland* → rozdział 1. | „Czytam fizyczną książkę. Apka nie jest czytnikiem — tylko weryfikuje zrozumienie." |
| 0:10–0:20 | *Akceptuję zasady — rozpocznij test*. Pokaż 3 ❤️ i wskaźnik kamery. | „Pięć pytań z pełnego tekstu na serwerze. Kamera pilnuje, czy nikt nie robi zdjęcia drugim telefonem." |
| 0:20–0:40 | Odpowiedz na 2–3 pytania (ABCD + otwarte). Po błędzie pokaż poprawną odpowiedź. | „Błąd? Dostajesz poprawną odpowiedź. Trzy serca, zero blokady czasowej." |
| 0:40–0:55 | *ZAKOŃCZ I ZWERYFIKUJ* → *Reading Verified* → hash + Explorer. | „Dowód to hash na Solanie — treść i odpowiedzi nigdy nie trafiają on-chain." |
| 0:55–1:00 | Pokaż stronę https://kacpersikora.pages.dev/books + panel wydawcy. | „Wydawcy dodają książki i fundują nagrody — 5 USDC za zweryfikowany dowód." |

## Plan B (gdy coś nie działa)

- **Backend nie odpowiada** → Paszport → Backend → *Test*; fallback: lokalny `https://127.0.0.1:32288`
  (uruchom `node server.js` w `backend/`).
- **Jev niedostępny** → pytania otwarte oceni keyword-fallback; pokaż ABCD/zamknięte.
- **Kamera na scenie** → Pitch Demo Mode łagodzi progi (Paszport → Backend → przełącznik).
- **Brak czasu** → pokaż tylko: start → 1 odpowiedź → poprawna odpowiedź → *Reading Verified* z poprzedniej sesji (Dowody).
