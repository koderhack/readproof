// AI-writing detector — heurystyka "sight on AI writing" (bez płatnego API).
// Cel: wykryć odpowiedzi wklejone z ChatGPT/Gemini/Claude i zablokować sesję jak przy cheatowaniu.
// Sygnały (PL + EN):
//  1. frazy typowe dla LLM ("moreover", "furthermore", "in conclusion", "as an AI",
//     "ponadto", "podsumowując", "jako model językowy", "kluczowe jest", "delve"...)
//  2. nadużywanie myślników em-dash / list z "•"/"1." / nagłówków markdown
//  3. niska burstiness: zdania równej długości, perfekcyjna interpunkcja, zero literówek
//  4. ogólnikowość: brak nazw własnych z kontekstu, dużo słów-wypełniaczy
//  5. długość: LLM zwykle pisze długo (3+ zdania, 60+ słów) na pytanie 1-zdaniowe
// Zwraca { score 0..1, suspected bool, signals[] }.

const AI_PHRASES = [
  // EN — klasyczne markery LLM
  'moreover', 'furthermore', 'in conclusion', 'in summary', 'as an ai',
  'as a language model', 'it is important to note', 'it\'s important to note',
  'delve', 'crucial', 'pivotal', 'tapestry', 'landscape of', 'in today\'s fast-paced',
  'in today’s fast-paced', 'overall,', 'firstly,', 'secondly,', 'lastly,',
  'in essence', 'at its core', 'multifaceted', 'underscores', 'testament to',
  'plays a vital role', 'it is worth noting', 'not only... but also',
  // PL — markery LLM
  'ponadto', 'podsumowując', 'reassuming', 'jako model językowy', 'jako sztuczna inteligencja',
  'kluczowe jest', 'istotne jest', 'warto zauważyć', 'warto podkreślić',
  'w dzisiejszym dynamicznym', 'w dzisiejszym świecie', 'ogólnie rzecz biorąc',
  'podsumowanie:', 'wnioski:', 'po pierwsze,', 'po drugie,', 'po trzecie,',
  'nie tylko... ale także', 'odgrywa kluczową rolę', 'świadczy o tym',
  'wielowymiarowy', 'złożony i wieloaspektowy', 'w kontekście powyższego',
];

const FILLER_WORDS = new Set([
  'bardzo', 'jednak', 'również', 'także', 'ponieważ', 'dlatego', 'zatem', 'więc',
  'very', 'however', 'also', 'therefore', 'thus', 'hence', 'moreover', 'furthermore',
]);

export function detectAIWriting(text, opts = {}) {
  const raw = String(text || '');
  const t = raw.trim();
  const lower = t.toLowerCase();
  const signals = [];
  let score = 0;

  if (t.length < 3) return { score: 0, suspected: false, signals: ['too_short'] };

  // 1. frazy LLM (mocny sygnał: +0.35 za frazę, max 0.7)
  let phraseHits = 0;
  for (const p of AI_PHRASES) {
    if (lower.includes(p)) { phraseHits++; signals.push(`ai_phrase:${p.slice(0, 24)}`); }
  }
  if (phraseHits > 0) score += Math.min(0.7, 0.35 + 0.15 * (phraseHits - 1));

  // 2. markdown / listy / em-dash (LLM formatuje odpowiedzi)
  const emDash = (t.match(/—|–/g) || []).length;
  const bullets = (t.match(/(^|\n)\s*(•|-|\*|\d+\.)\s/g) || []).length;
  const headers = (t.match(/#{1,3}\s|:\n|\*\*.+\*\*/g) || []).length;
  if (emDash >= 2) { score += 0.12; signals.push(`em_dash:${emDash}`); }
  if (bullets >= 2) { score += 0.18; signals.push(`list:${bullets}`); }
  if (headers >= 1) { score += 0.15; signals.push('markdown_fmt'); }

  // 3. burstiness: zdania równej długości + perfekcja
  const sentences = t.split(/[.!?…]+/).map(s => s.trim()).filter(Boolean);
  const words = t.split(/\s+/).filter(Boolean);
  if (sentences.length >= 3 && words.length >= 40) {
    const lens = sentences.map(s => s.split(/\s+/).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
    if (cv < 0.35) { score += 0.15; signals.push(`uniform_sentences:cv=${cv.toFixed(2)}`); }
    // zero literówek + długa perfekcyjna odpowiedź
    const typoish = (t.match(/(.)\1\1|…{2,}|,{2,}|\s{2,}/g) || []).length;
    if (typoish === 0 && words.length >= 60) { score += 0.08; signals.push('too_perfect'); }
  }

  // 4. wypełniacze
  let filler = 0;
  for (const w of lower.split(/[^a-ząćęłńóśźż]+/)) if (FILLER_WORDS.has(w)) filler++;
  if (words.length >= 30 && filler / words.length > 0.06) {
    score += 0.1; signals.push(`filler:${((filler / words.length) * 100).toFixed(0)}%`);
  }

  // 5. długość vs pytanie o 1 zdanie + ogólnikowość (brak cytatu/nazwy)
  const context = String(opts.context || '').toLowerCase();
  const ctxNames = context.split(/[^a-ząćęłńóśźż]+/).filter(w => w.length > 4 && /^[A-ZĄĆĘŁŃÓŚŹŻ]/.test(w));
  if (words.length >= 60 && sentences.length >= 3) {
    score += 0.1; signals.push(`long_llm:${words.length}w`);
    if (ctxNames.length === 0) { score += 0.05; signals.push('generic_no_names'); }
  }

  // 6. wyznanie AI wprost
  if (/as an ai|as a language model|jako model|jestem chatgpt|jestem gemini|jestem claude/i.test(t)) {
    score += 0.5; signals.push('self_declared_ai');
  }

  score = Math.min(1, Math.round(score * 100) / 100);
  const threshold = Number(opts.threshold ?? process.env.AI_DETECT_THRESHOLD ?? 0.55);
  const suspected = score >= threshold && words.length >= 12;
  return { score, suspected, threshold, signals };
}

export const AI_DETECTOR_INFO = {
  name: 'readproof-ai-sight-v1',
  threshold: Number(process.env.AI_DETECT_THRESHOLD || 0.55),
  method: 'heuristic sight on AI writing (no paid API): AI phrases PL/EN + markdown/list/emdash formatting + uniform sentence burstiness + filler ratio + length/genericity + self-declaration',
  action: 'suspected → correct=false, session suspicious=1 (ai_suspected), status Failed — tak jak przy cheatowaniu (screenshot/screenRecording/too_fast). Można od razu ponowić.',
  signals: ['ai_phrase', 'em_dash', 'list', 'markdown_fmt', 'uniform_sentences', 'too_perfect', 'filler', 'long_llm', 'generic_no_names', 'self_declared_ai'],
};
