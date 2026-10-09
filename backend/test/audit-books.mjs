// Audyt WSZYSTKICH książek w ReadProof. Odpowiada na jedno pytanie:
// czy każda książka w katalogu jest gotowa do realnego czytelnika —
// tzn. ma sensowne granice rozdziałów i wystarczającą pulę zatwierdzonych pytań.
//
//   node test/audit-books.mjs
//   node test/audit-books.mjs --verbose

import fs from 'node:fs';
import { detectChaptersDetailed, MAX_CHAPTERS, __internals } from '../chapters.js';

const MIN_CHAPTER_BODY = 300;
// Typy, które serwer uzna za poprawne (server.js: sanitizePool → CORE).
// Pytania spoza tej listy są cicho wyrzucane przy starcie.
const CORE = new Set(['multiple_choice', 'true_false', 'multiple_select', 'what_next', 'open_question', 'why_question']);

const VERBOSE = process.argv.includes('--verbose');
const TARGET_POOL = 10;

const bundled = JSON.parse(fs.readFileSync('./challenges.json', 'utf8'));
const books = bundled.books || [];
const pools = bundled.challengesByChapter || {};

const qStatus = (c) => (['approved', 'draft', 'rejected'].includes(String(c?.status)) ? String(c.status) : 'approved');
const txtFor = (b) => {
  for (const cand of [`./texts/${b.fullTextFile}`, `./${b.fullTextFile}`]) {
    if (b.fullTextFile && fs.existsSync(cand)) return fs.readFileSync(cand, 'utf8');
  }
  return null;
};

const issues = [];
const flag = (book, level, msg) => issues.push({ book: book.id || book, level, msg });

const rows = [];
for (const b of books) {
  const chapters = b.chapters || [];
  const row = { book: b.id, title: (b.title || '').slice(0, 26), ch: chapters.length, text: '', detected: '', mode: '', ok: 0, draft: 0, rej: 0, bad: [] };

  // 1. tekst źródłowy
  const txt = txtFor(b);
  if (txt) row.text = (txt.length / 1000).toFixed(0) + 'k';
  else if (b.fullTextFile) flag(b, 'warn', `brak pliku tekstu: texts/${b.fullTextFile}`);

  // 2. granice rozdziałów — czy to, co jest w katalogu, zgadza się z detektorem
  if (txt) {
    const det = detectChaptersDetailed(txt, b.id);
    row.detected = det.chapters.length;
    row.mode = det.mode;
    if (det.chapters.length !== chapters.length) {
      flag(b, 'warn', `rozdziały: katalog ${chapters.length} vs detektor ${det.chapters.length} (tryb: ${det.mode}${det.reason ? ', ' + det.reason : ''})`);
    }
    for (const c of det.chapters) {
      if (c.charCount < MIN_CHAPTER_BODY) flag(b, 'err', `rozdział ${c.index} ma tylko ${c.charCount} znaków`);
      if (!/\S{3}/.test(String(c.contextExcerpt || '').replace(/\s+/g, ' '))) flag(b, 'err', `rozdział ${c.index} pusty`);
    }
    if (det.chapters.length > MAX_CHAPTERS) flag(b, 'err', 'przekroczony limit rozdziałów');
  }

  // 3. pule pytań
  for (const c of chapters) {
    const pool = pools[c.id] || [];
    const ok = pool.filter((q) => qStatus(q) === 'approved').length;
    row.ok += ok;
    row.draft += pool.filter((q) => qStatus(q) === 'draft').length;
    row.rej += pool.filter((q) => qStatus(q) === 'rejected').length;

    if (pool.length === 0) { flag(b, 'err', `${c.id}: brak pytań w puli`); row.bad.push(c.index); continue; }
    if (ok === 0) { flag(b, 'err', `${c.id}: 0 zatwierdzonych (${row.draft} draft / ${row.rej} odrzucone)`); row.bad.push(c.index); continue; }
    if (ok < 5) { flag(b, 'warn', `${c.id}: tylko ${ok} zatwierdzonych pytań (min. 5)`); row.bad.push(c.index); }
    if (ok < TARGET_POOL) flag(b, 'info', `${c.id}: ${ok}/${TARGET_POOL} zatwierdzonych`);

    // 4. jakość pojedynczych pytań.
    //    Reguły LUSTRUJĄ server.js (sanitizePool / normalizeChallenge). Pytanie,
    //    którego serwer nie potrafi zanieczystić poprawnie, nigdy nie wejdzie do
    //    sesji czytelnika — więc dla niego liczymy tylko pool, nie jakość.
    for (const q of pool) {
      if (qStatus(q) === 'rejected') continue;
      const t = q.type;
      const id = q.id || '(bez id)';
      if (!CORE.has(t)) { flag(b, 'err', `${c.id}: pytanie ${id} typu "${t}" — wypadnie z puli przy sanitizePool`); continue; }

      const txtQ = String(q.question || '').trim();
      if (txtQ.length < 12) { flag(b, 'err', `${c.id}: pytanie ${id} bez treści ("${txtQ}")`); continue; }

      if (t === 'multiple_choice' || t === 'what_next') {
        if (!Array.isArray(q.options) || q.options.length < 2) { flag(b, 'err', `${c.id}: ${t} ${id} bez opcji`); continue; }
        const ca = Number(q.correctAnswer);
        if (!Number.isInteger(ca) || ca < 0 || ca >= q.options.length) { flag(b, 'err', `${c.id}: ${t} ${id} złego correctAnswer=${q.correctAnswer}`); continue; }
        const norm = q.options.map((o) => String(o).trim().toLowerCase());
        if (new Set(norm).size !== norm.length) flag(b, 'warn', `${c.id}: ${t} ${id} ma zduplikowane opcje`);
      } else if (t === 'multiple_select') {
        if (!Array.isArray(q.options) || q.options.length < 2) { flag(b, 'err', `${c.id}: multiple_select ${id} bez opcji`); continue; }
        const ca = q.correctAnswers;
        if (!Array.isArray(ca) || !ca.length) { flag(b, 'err', `${c.id}: multiple_select ${id} bez correctAnswers`); continue; }
        if (ca.some((i) => !Number.isInteger(i) || i < 0 || i >= q.options.length)) flag(b, 'err', `${c.id}: multiple_select ${id} ma index poza zakresem`);
        else if (ca.length === q.options.length) flag(b, 'err', `${c.id}: multiple_select ${id} — poprawne = wszystkie opcje`);
      } else if (t === 'true_false') {
        // normalizeChallenge sprowadza to do options=[Prawda,Fałsz] + correctAnswer.
        // Na dysku może zostać jeszcze `correct`/`statement` — sprawdzamy obie postacie.
        const hasBool = typeof q.correct === 'boolean';
        const hasIdx = q.correctAnswer === 0 || q.correctAnswer === 1;
        if (!hasBool && !hasIdx) flag(b, 'err', `${c.id}: true_false ${id} bez odpowiedzi (correct=${JSON.stringify(q.correct)}, correctAnswer=${JSON.stringify(q.correctAnswer)})`);
        if (!q.statement && txtQ.length < 15) flag(b, 'warn', `${c.id}: true_false ${id} bez statementu`);
      } else {
        if (!q.expectedMeaning || !String(q.expectedMeaning).trim()) flag(b, 'err', `${c.id}: ${t} ${id} bez expectedMeaning (Jev nie ma czego oceniać)`);
        else if (String(q.expectedMeaning).trim().length < 10) flag(b, 'warn', `${c.id}: ${t} ${id} ma szczątkowe expectedMeaning`);
      }
    }

    // 5. duplikaty w puli (to samo pytanie losowane dwa razy = ta sama sesja)
    const seen = new Set();
    const dup = [];
    for (const q of pool.filter((x) => qStatus(x) !== 'rejected')) {
      const k = String(q.question || q.statement || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 90);
      if (k && seen.has(k)) dup.push(k.slice(0, 50));
      seen.add(k);
    }
    if (dup.length) flag(b, 'warn', `${c.id}: ${dup.length} duplikatów w puli (np. "${dup[0]}…")`);
  }

  if (chapters.length > MAX_CHAPTERS) flag(b, 'err', `${chapters.length} rozdziałów > MAX_CHAPTERS`);
  if (!chapters.length) flag(b, 'err', 'książka bez rozdziałów');
  rows.push(row);
}

const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(`\n${pad('książka', 20)}${pad('tytuł', 28)}${pad('rozdz', 6)}${pad('tekst', 7)}${pad('wykryto', 8)}${pad('tryb', 9)}${pad('ok', 4)}${pad('draft', 6)}${pad('odrzucone', 10)}`);
console.log('-'.repeat(104));
for (const r of rows.sort((a, b) => a.book.localeCompare(b.book))) {
  console.log(pad(r.book, 20) + pad(r.title, 28) + pad(r.ch, 6) + pad(r.text, 7) + pad(r.detected, 8) + pad(r.mode, 9) + pad(r.ok, 4) + pad(r.draft, 6) + pad(r.rej, 10));
}

const uniqBooks = new Set(rows.filter((r) => !r.bad.length).map((r) => r.book)).size;
const totCh = rows.reduce((a, r) => a + r.ch, 0);
console.log(`\n${books.length} książek · ${totCh} rozdziałów · ${uniqBooks} w pełni gotowych · ${issues.filter((i) => i.level === 'err').length} błędów · ${issues.filter((i) => i.level === 'warn').length} ostrzeżeń`);

const order = { err: 0, warn: 1, info: 2 };
const show = VERBOSE ? issues : issues.filter((i) => i.level !== 'info');
if (show.length) {
  console.log('');
  for (const i of show.sort((a, b) => order[a.level] - order[b.level])) {
    console.log(`  ${i.level === 'err' ? 'BŁĄD ' : i.level === 'warn' ? 'UWAGA' : 'INFO '} [${i.book}] ${i.msg}`);
  }
}
process.exit(issues.some((i) => i.level === 'err') ? 1 : 0);