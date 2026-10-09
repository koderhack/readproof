// E2E każdej książki przez żywy backend: katalog → start sesji na KAŻDYM
// rozdziale → 5 pytań → odpowiedzi → complete.
//
// To jest test, którego nie da się napisać na sucho. Pula pytań może wyglądać
// dobrze w JSON-ie i nadal wybuchnąć przy starcie sesji (puste pytanie, zły
// indeks odpowiedzi, chapter bez puli). Tutaj sprawdzamy realną drogę czytelnika.
//
//   TEST_API=http://127.0.0.1:32289 node test/audit-books-e2e.mjs
//
// Każdy rozdział dostaje świeżego portfela (1 lektura = 1 dowód, więc ten sam
// wallet od razu dostanie 409 na drugim rozdziale).

const BASE = process.env.TEST_API || 'http://127.0.0.1:32289';
const DEV_PASSWORD = process.env.DEV_PASSWORD || 'hackathon2026@';
import fs from 'node:fs';

let walletSeq = 0;
const wallet = () => {
  walletSeq++;
  const seed = String(walletSeq).padStart(4, '0');
  return `E2EAudit${seed}`.padEnd(44, 'x').slice(0, 44);
};

const call = async (path, opts = {}) => {
  const h = { 'Content-Type': 'application/json', 'x-dev-mode': '1', 'x-dev-password': DEV_PASSWORD, ...(opts.headers || {}) };
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// Sesja wysyła pytania ZAMASKOWANE — bez correctAnswer/expectedMeaning
// (inaczej dałoby się zlać test). Klucz bierzemy z challenges.json na dysku,
// czyli z tego samego źródła, z którego serwer buduje pulę.
const keys = (() => {
  try { return JSON.parse(fs.readFileSync('./challenges.json', 'utf8')).challengesByChapter || {}; }
  catch { return {}; }
})();

// Prawidłowa odpowiedź wg ksztaltu pytania — chcemy sprawdzić, że mechanika
// zalicza, a nie tylko że odpowiedź się przyjmuje.
// `answers` to pula rozdziału z challenges.json (serwer stripuje klucz z sesji).
function correctAnswer(ch, answers) {
  const src = (answers || []).find((q) => q.id === ch.id) || {};
  const ca = src.correctAnswer;
  switch (ch.type) {
    case 'multiple_choice': case 'what_next': return ca;
    case 'true_false': return ca;
    case 'multiple_select': return src.correctAnswers;
    case 'open_question': case 'why_question': return src.expectedMeaning;
    default: return ca ?? true;
  }
}

const booksRes = await call('/api/books');
if (booksRes.status !== 200) {
  console.error(`Nie mogę pobrać /api/books (${booksRes.status}): ${JSON.stringify(booksRes.data)}`);
  process.exit(2);
}
const books = booksRes.data;
console.log(`Backend ${BASE} — ${books.length} książek\n`);

const problems = [];
const rows = [];

for (const b of books) {
  const chapters = b.chapters || [];
  let okSessions = 0;
  let questionsSeen = 0;
  let gradedOk = 0;
  const types = new Set();

  for (const c of chapters) {
    const w = wallet();
    const start = await call('/api/sessions/start', {
      method: 'POST',
      body: { walletAddress: w, bookId: b.id, chapterId: c.id, devBypass: true, devPassword: DEV_PASSWORD, expectedReadingMin: 5 },
    });
    if (start.status !== 200) {
      problems.push(`${b.id}/${c.id}: start sesji ${start.status} — ${JSON.stringify(start.data)}`);
      continue;
    }
    const s = start.data.session || start.data;
    const sid = s.id || s.sessionId;
    const challenges = s.challenges || s.questions || [];
    if (!challenges.length) {
      problems.push(`${b.id}/${c.id}: sesja wystartowała bez pytań`);
      continue;
    }
    if (challenges.length !== 5) problems.push(`${b.id}/${c.id}: ${challenges.length} pytań zamiast 5`);
    questionsSeen += challenges.length;

    // Pytania zablokowane czasowo (releaseAt) — dev-mode powinien je odblokować,
    // ale jeśli nie, odpowiedź nie zostanie policzona i test tego nie zauważy.
    const key = keys[c.id] || [];
    let allGraded = true;
    for (const ch of challenges) {
      types.add(ch.type);
      if (new Date(ch.releaseAt || 0).getTime() > Date.now()) {
        allGraded = false;
        problems.push(`${b.id}/${c.id}: pytanie ${ch.type} nadal zablokowane (releaseAt ${ch.releaseAt}) mimo dev-mode`);
      }
      const ans = await call(`/api/sessions/${sid}/answer`, {
        method: 'POST',
        body: { challengeId: ch.id, answer: correctAnswer(ch, key), devBypass: true, devPassword: DEV_PASSWORD, elapsedSec: 30 },
      });
      if (ans.status !== 200) {
        allGraded = false;
        problems.push(`${b.id}/${c.id}/${ch.type}: answer ${ans.status} — ${JSON.stringify(ans.data).slice(0, 160)}`);
        continue;
      }
      const judged = ans.data.result || ans.data;
      if (allGraded && judged && judged.correct === true) gradedOk++;
      else if (allGraded) {
        allGraded = false;
        problems.push(`${b.id}/${c.id}/${ch.type}: poprawna odpowiedź oceniona jako błędna (${JSON.stringify(judged).slice(0, 200)})`);
      }
    }

    const done = await call(`/api/sessions/${sid}/complete`, {
      method: 'POST',
      body: { devBypass: true, devPassword: DEV_PASSWORD },
    });
    if (done.status !== 200 && done.status !== 201) {
      problems.push(`${b.id}/${c.id}: complete ${done.status} — ${JSON.stringify(done.data).slice(0, 160)}`);
    } else {
      okSessions++;
      const score = done.data.score ?? done.data.result?.score ?? done.data.correctCount;
      if (score != null && Number(score) < 5 && challenges.length === 5) {
        problems.push(`${b.id}/${c.id}: ukończono z wynikiem ${score}/5 mimo 5 poprawnych odpowiedzi`);
      }
    }
  }

  rows.push({ book: b.id, rozdz: chapters.length, sesje: okSessions, pytań: questionsSeen, zaliczonych: gradedOk, typy: [...types].sort().join(',') });
}

const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(pad('książka', 22) + pad('rozdz', 7) + pad('sesje', 7) + pad('pytań', 7) + pad('poprawne', 10) + 'typy');
console.log('-'.repeat(120));
for (const r of rows) console.log(pad(r.book, 22) + pad(r.rozdz, 7) + pad(r.sesje, 7) + pad(r.pytań, 7) + pad(r.zaliczonych, 10) + r.typy);

const totalCh = rows.reduce((a, r) => a + r.rozdz, 0);
const totalQ = rows.reduce((a, r) => a + r.pytań, 0);
console.log(`\n${books.length} książek · ${totalCh} rozdziałów · ${totalQ} pytań odpowiedzianych · ${rows.filter((r) => r.sesje === r.rozdz).length} książek przeszło w całości`);

if (problems.length) {
  console.log(`\n${problems.length} problemów:`);
  for (const p of problems) console.log('  - ' + p);
}
process.exit(problems.length ? 1 : 0);