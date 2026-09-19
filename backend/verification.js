// Verification Engine — oddziela WERYFIKACJĘ od ZAPISU wyniku.
//
// AI (OpenRouter/Jev) → rozumie książkę
// backend → prowadzi sesję + anti-cheat
// Verification Engine → orzeka czy sesja przeszła reguły → proofHash
// Solana → niezmienny dowód (hash) + reward
//
// On-chain NIGDY nie trafia: treść książki, odpowiedzi użytkownika, prompt.
// On-chain trafia: wallet, bookId, chapterId, sessionId, score, duration,
//                  verificationVersion, proofHash, timestamp.

import { createHash } from 'crypto';

const VERIFICATION_VERSION = 'readproof-v1';

// Reguły weryfikacji (anti-cheat).
function runChecks(s, now) {
  const checks = [];
  const fail = (name, detail) => checks.push({ name, passed: false, detail });

  const allAnswered = Object.keys(s.answers || {}).length >= s.challenges.length;
  if (!allAnswered) fail(checks, 'all_answered', 'nie wszystkie odpowiedzi');

  const score = Object.values(s.answers || {}).filter((a) => a && a.correct).length;

  if (s.suspicious) fail(checks, 'not_suspicious', s.suspiciousReason || 'suspicious');
  else checks.push({ name: 'not_suspicious', passed: true });

  const dur = Math.floor((now - new Date(s.startAt).getTime()) / 1000);
  const minimalSec = s.isDemo ? 60 : Math.floor((s.expectedReadingMin || 12) * 60 * 0.66);
  checks.push({ name: 'min_duration', passed: dur >= minimalSec, detail: `${dur}s >= ${minimalSec}s` });

  return {
    checks,
    score,
    durationSec: dur,
    correctFlags: s.challenges.map((c) => !!s.answers[c.id]?.correct),
  };
}

function hashSession(s, correctFlags, now) {
  // proof = hash(wallet + bookId + chapterId + sessionId + challengeIds + results + timestamp + verificationVersion)
  const payload = [
    s.walletAddress,
    s.bookId,
    s.chapterId,
    s.sessionId,
    s.challengeIds.join(','),
    correctFlags.join(''),
    now.getTime(),
    VERIFICATION_VERSION,
  ].join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function runVerification(s, now = new Date()) {
  const { checks, score, durationSec, correctFlags } = runChecks(s, now);
  const allPassed = checks.filter((c) => !c.passed).length === 0;
  const verified = allPassed && score === s.challenges.length;

  let status;
  if (s.suspicious) status = 'Try Again';
  else if (verified) status = 'Reading Verified';
  else if (score >= 3) status = 'Try Again';
  else status = 'Failed';

  const proofHash = hashSession(s, correctFlags, now);

  return {
    verified,
    status,
    score,
    total: s.challenges.length,
    durationSec,
    verificationVersion: VERIFICATION_VERSION,
    proofHash,
    checks,
  };
}

function failErr(reason) {
  const err = new Error(reason);
  err.code = 'VERIFICATION_BLOCKED';
  return err;
}

export { runVerification, VERIFICATION_VERSION, failErr };