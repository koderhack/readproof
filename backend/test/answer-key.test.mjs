// Klucz odpowiedzi: musi zostać w serwisie i zniknąć na wyjściu do czytelnika.
//
// Ta para testów chroni najgroźniejszy bodziec w aplikacji — quiz ma być
// możliwy do zdania, a odpowiedź ma być nie do odgadnięcia z sieci. Wcześniej
// buildSessionChallenges kasował correctAnswer z listy, z której serwer ocenia
// odpowiedzi, więc NIKT nie mógł zaliczyć pytania ABCD (a open/why nie miał
// czego dać Jevowi). Test po jednej stronie pilnuje, żeby klucz przestał
// znikać; test po drugiej — żeby nie zaczął uciekać.
//
//   PORT=40000 node server.js &
//   node --test test/answer-key.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BASE = process.env.TEST_API || 'http://127.0.0.1:40001';
const DEV_PASSWORD = process.env.DEV_PASSWORD || 'hackathon2026@';

const SECRET_FIELDS = ['correctAnswer', 'correctAnswers', 'correctOrder', 'errorIndex', 'expectedMeaning', 'correctText'];

async function call(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-dev-mode': '1', 'x-dev-password': DEV_PASSWORD, ...(opts.headers || {}) };
  const res = await fetch(BASE + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const pools = JSON.parse(fs.readFileSync('./challenges.json', 'utf8')).challengesByChapter || {};

// Wybieramy rozdział, w którym jest na pewno pytanie ABCD z kluczem.
let target = null;
for (const [chapterId, pool] of Object.entries(pools)) {
  const mcq = pool.find((q) => (q.type === 'multiple_choice' || q.type === 'what_next') && Number.isInteger(q.correctAnswer) && q.correctAnswer >= 0);
  if (mcq) { target = { chapterId, bookId: chapterId.replace(/-ch\d+$/, ''), mcq }; break; }
}
assert.ok(target, 'challenges.json nie ma ani jednego poprawnego pytania ABCD — test nie ma czego sprawdzać');

// Losowanie jest losowe — pytanie, które chcemy sprawdzić, nie musi wypaść
// w pierwszej sesji. Powtarzamy aż wylosuje się (serwer nie limituje startów
// przy devBypass, a to jedyna droga bez ruszania puli).
async function sessionWith(wallet, challengeId) {
  for (let i = 0; i < 40; i++) {
    const started = await call('/api/sessions/start', {
      method: 'POST',
      body: { walletAddress: wallet + String(i), bookId: target.bookId, chapterId: target.chapterId, devBypass: true, devPassword: DEV_PASSWORD },
    });
    if (started.status !== 200) continue;
    const session = started.data.session || started.data;
    if (session.challenges.some((c) => c.id === challengeId)) return session;
  }
  return null;
}

test('sesja odpowiada na poprawną odpowiedź ABCD jako poprawną', async () => {
  const session = await sessionWith('KeyTest1', target.mcq.id);
  assert.ok(session, `pytanie ${target.mcq.id} nie wylosowało się w 40 sesjach`);
  const mcq = session.challenges.find((c) => c.id === target.mcq.id);
  const answered = await call(`/api/sessions/${session.id}/answer`, {
    method: 'POST',
    body: { challengeId: mcq.id, answer: target.mcq.correctAnswer },
  });
  assert.equal(answered.status, 200, JSON.stringify(answered.data));
  assert.equal(answered.data.correct, true, `poprawna odpowiedź oceniona jako błędna: ${JSON.stringify(answered.data)}`);
});

test('zła odpowiedź ABCD jest odrzucana', async () => {
  const session = await sessionWith('KeyTest2', target.mcq.id);
  assert.ok(session, `pytanie ${target.mcq.id} nie wylosowało się w 40 sesjach`);
  const mcq = session.challenges.find((c) => c.id === target.mcq.id);
  const wrong = (target.mcq.correctAnswer + 1) % (target.mcq.options?.length || 2);
  const answered = await call(`/api/sessions/${session.id}/answer`, { method: 'POST', body: { challengeId: mcq.id, answer: wrong } });
  assert.equal(answered.status, 200, JSON.stringify(answered.data));
  assert.equal(answered.data.correct, false, 'błędna odpowiedź przeszła jako poprawna');
});

test('sesja nie wysyła klucza odpowiedzi czytelnikowi', async () => {
  const started = await call('/api/sessions/start', {
    method: 'POST',
    body: { walletAddress: 'KeyTest3' + 'a'.repeat(40), bookId: target.bookId, chapterId: target.chapterId, devBypass: true, devPassword: DEV_PASSWORD },
  });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const session = started.data.session || started.data;

  for (const source of [['/start', session.challenges], ['/api/sessions/:id', null]]) {
    const challenges = source[1] || (await call(`/api/sessions/${session.id}`)).data.challenges;
    for (const c of challenges) {
      for (const f of SECRET_FIELDS) {
        assert.ok(!(f in c), `${source[0]}: pytanie ${c.id} wysyła "${f}" — klucz odpowiedzi wycieka do klienta`);
      }
    }
  }
});