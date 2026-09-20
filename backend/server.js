import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import https from 'https';
import http from 'http';
import mysql from 'mysql2/promise';
import { runVerification } from './verification.js';

dotenv.config();
const PORT = Number(process.env.PORT) || 32288;
const JEV_THRESHOLD = Number(process.env.JEV_THRESHOLD) || 0.80;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-flash-0731:free';
// Jev — TypeSafe https://docs.typesafe.ai/api  (POST https://api.typesafe.ai/v1/systemone)
const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '';
const TYPESAFE_MODEL = process.env.TYPESAFE_MODEL || 'jev-latest';
const TYPESAFE_ENDPOINT = process.env.TYPESAFE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const SOLANA_PAYER_PRIVATE_KEY = process.env.SOLANA_PAYER_PRIVATE_KEY || ''; // JSON array for real Devnet payout (optional)
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // Circle USDC Devnet
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' }));
// live request log — każde zapytanie (pomija /health)
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path !== '/health') console.log(`[http] ${req.method} ${req.path} ${res.statusCode} ${Date.now()-t0}ms`);
  });
  next();
});

// --- Load bundled challenges ---
let bundled = JSON.parse(fs.readFileSync('./challenges.json', 'utf8'));
let books = bundled.books;
let challengesByChapter = bundled.challengesByChapter;

function pickFive(chapterId) {
  const pool = challengesByChapter[chapterId] || [];
  if (!pool.length) return [];
  let shuffled = [...pool].sort(() => Math.random() - 0.5);
  let picked = [];
  let used = new Set();
  for (const c of shuffled) {
    if (picked.length >= 5) break;
    if (!used.has(c.type) || picked.length >= 3) {
      picked.push(c);
      used.add(c.type);
    }
  }
  if (picked.length < 5) {
    for (const c of shuffled) if (!picked.find(p => p.id === c.id) && picked.length < 5) picked.push(c);
  }
  const hasJev = picked.some(c => c.type === 'open_question' || c.type === 'why_question');
  if (!hasJev) {
    const jev = pool.find(c => c.type === 'open_question' || c.type === 'why_question');
    if (jev && !picked.find(p => p.id === jev.id)) picked[4] = jev;
  }
  return picked.slice(0,5);
}

async function ensurePoolAtLeast20(chapterId, lang='pl'){
  let pool = challengesByChapter[chapterId] || [];
  if(pool.length >= 30) return pool;
  // live generowanie missingów via LLM OpenRouter free w języku urządzenia
  if(OPENROUTER_KEY){
    const chapter = books.flatMap(b=>b.chapters).find(c=>c.id===chapterId);
    if(chapter){
      const generate = async ()=>{
        try{
          const need = 30 - pool.length;
          const generated = await callOpenRouterGenerate(chapter, need, lang);
          pool = pool.concat(generated);
          challengesByChapter[chapterId]=pool;
          try{ fs.writeFileSync('./challenges.json', JSON.stringify({books, challengesByChapter}, null, 2)); }catch{}
          console.log(`[pool-bg] +${generated.length} → pool ${pool.length} (${chapterId})`);
        }catch(e){ console.error(`[pool-bg] fail: ${e.message}`); }
      };
      if(pool.length >= 5){
        // wystarczająco na tę sesję — uzupełnij pulę w TLE, nie blokuj startu
        generate();
        return pool;
      }
      // zimny start — mało pytań, czekamy na generację
      await generate();
    }
  }
  if(pool.length < 5) throw new Error(`Pula pytań dla ${chapterId} za mała (${pool.length}) — wygeneruj via POST /api/generate`);
  return pool;
}
async function pickForSession(chapterId, lang='pl'){
  const pool = await ensurePoolAtLeast20(chapterId, lang);
  let shuffled = [...pool].sort(()=>Math.random()-0.5);
  let picked=[];
  let used=new Set();
  for(const c of shuffled){
    if(picked.length>=5) break;
    if(!used.has(c.type) || picked.length>=3){ picked.push(c); used.add(c.type); }
  }
  if(picked.length<5) for(const c of shuffled) if(!picked.find(p=>p.id===c.id) && picked.length<5) picked.push(c);
  // 2 otwarte na sesję — aby AI/GPT nie wystarczyło
  const jevs = pool.filter(c=>c.type==='open_question'||c.type==='why_question');
  let jevCount = picked.filter(c=>c.type==='open_question'||c.type==='why_question').length;
  for(const jev of jevs){ if(jevCount>=2) break; if(!picked.find(p=>p.id===jev.id)){ picked[picked.length%5]=jev; jevCount++; } }
  return picked.slice(0,5);
}
const SESSION_TIMING_DEMO = [0, 20, 45, 70, 90];
const SESSION_TIMING_DEV = [0, 0, 0, 0, 0]; // admin dev mode — natychmiastowe odblokowanie // seconds from start — fast demo, prevents copy-all-to-AI
const SESSION_TIMING_REAL = [0, 5*60, 8*60, 12*60, 14*60]; // ~14 min total, per spec

function buildSessionChallenges(picked, startAt, isDemo){
  const timing = isDemo ? SESSION_TIMING_DEMO : SESSION_TIMING_REAL;
  const startMs = new Date(startAt).getTime();
  return picked.map((c,i)=>({
    ...c,
    releaseAt: new Date(startMs + timing[i]*1000).toISOString(),
    releaseAfterSec: timing[i],
    locked: false // computed on fetch
  }));
}

// in-memory sessions cache (also persisted in DB)
const sessionsMem = new Map();

// --- SQLite for proofs + sessions (fallback) ---
let db = new sqlite3.Database('./readproof.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS proofs (
    id TEXT PRIMARY KEY,
    bookId TEXT, chapterId TEXT, score INTEGER, total INTEGER, status TEXT,
    walletAddress TEXT, timestamp TEXT, proofHash TEXT, txSignature TEXT, explorerUrl TEXT, reward TEXT,
    detail TEXT,
    verificationVersion TEXT,
    durationSec INTEGER
  )`);
  db.run(`ALTER TABLE proofs ADD COLUMN verificationVersion TEXT`, ()=>{});
  db.run(`ALTER TABLE proofs ADD COLUMN durationSec INTEGER`, ()=>{});
  db.run(`CREATE TABLE IF NOT EXISTS reading_sessions (
    id TEXT PRIMARY KEY,
    walletAddress TEXT, bookId TEXT, chapterId TEXT,
    startAt TEXT, endAt TEXT, status TEXT,
    challengeIds TEXT, answers TEXT,
    readingDurationSec INTEGER,
    lang TEXT, expectedReadingMin INTEGER,
    suspicious INTEGER DEFAULT 0,
    suspiciousReason TEXT,
    totalPausedSec INTEGER DEFAULT 0,
    pausedAt TEXT,
    createdAt TEXT
  )`);
  db.run(`ALTER TABLE reading_sessions ADD COLUMN suspicious INTEGER DEFAULT 0`, ()=>{});
  db.run(`ALTER TABLE reading_sessions ADD COLUMN suspiciousReason TEXT`, ()=>{});
  db.run(`ALTER TABLE reading_sessions ADD COLUMN totalPausedSec INTEGER DEFAULT 0`, ()=>{});
  db.run(`ALTER TABLE reading_sessions ADD COLUMN pausedAt TEXT`, ()=>{});
});
// MySQL mikrus (db_f22287) — jeśli MYSQL_HOST ustawiony, nadpisuje db.* na MySQL (prefix readproof_)
let useMySQL = !!(process.env.MYSQL_HOST && process.env.MYSQL_USER);
let mysqlPool = null;
if (useMySQL) {
  mysqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT||3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    timezone: 'Z', // nasze timestampy są zapisywane jako UTC-naive — bez przesunięcia serwera (CEST)
    waitForConnections: true, connectionLimit: 5
  });
  // proxy db.* na MySQL z zachowaniem callback API sqlite
  const origDb = db;
  // MySQL DATETIME nie przyjmuje ISO 'T'/'Z' — konwertuj parametry timestampów
  const M = (params) => (params||[]).map(v =>
    typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)
      ? v.replace('T',' ').replace(/\.\d+Z?$/, '')
      : v);
  db = {
    run(sql, params, cb){
      // konwersja ? -> ? dla MySQL (to samo)
      // mapuj nazwy tabel: proofs -> readproof_proofs, reading_sessions -> readproof_sessions (też bez backticków)
      let q = sql.replace(/`proofs`/g,'`readproof_proofs`').replace(/`reading_sessions`/g,'`readproof_sessions`').replace(/\bproofs\b/g,'`readproof_proofs`').replace(/\breading_sessions\b/g,'`readproof_sessions`');
      // CREATE TABLE IF NOT EXISTS — MySQL potrzebuje VARCHAR/DATETIME zamiast TEXT
      q = q.replace(/TEXT PRIMARY KEY/g,'VARCHAR(64) PRIMARY KEY').replace(/TEXT,/g,'VARCHAR(64),').replace(/TEXT\)/g,'VARCHAR(64))');
      q = q.replace(/DATETIME/g,'DATETIME').replace(/JSON/g,'JSON');
      mysqlPool.query(q, M(params)).then(()=> cb&&cb(null)).catch(e=>{ console.error('[db:run]', e.message); cb&&cb(e); });
    },
    all(sql, params, cb){
      let q = sql.replace(/`proofs`/g,'`readproof_proofs`').replace(/`reading_sessions`/g,'`readproof_sessions`').replace(/\bproofs\b/g,'`readproof_proofs`').replace(/\breading_sessions\b/g,'`readproof_sessions`');
      mysqlPool.query(q, M(params)).then(([rows])=> cb(null, rows)).catch(e=>{ console.error('[db:all]', e.message); cb(e); });
    },
    get(sql, params, cb){
      let q = sql.replace(/`proofs`/g,'`readproof_proofs`').replace(/`reading_sessions`/g,'`readproof_sessions`').replace(/\bproofs\b/g,'`readproof_proofs`').replace(/\breading_sessions\b/g,'`readproof_sessions`');
      mysqlPool.query(q, M(params)).then(([rows])=> cb(null, rows[0]||null)).catch(e=>{ console.error('[db:get]', e.message); cb(e); });
    },
    serialize(fn){ fn(); }
  };
  // init MySQL tables async
  (async()=>{
    try{
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_proofs (id VARCHAR(64) PRIMARY KEY, bookId VARCHAR(64), chapterId VARCHAR(64), score INT, total INT, status VARCHAR(32), walletAddress VARCHAR(64), timestamp DATETIME, proofHash VARCHAR(32), txSignature VARCHAR(128), explorerUrl VARCHAR(256), reward VARCHAR(32), detail JSON, verificationVersion VARCHAR(32), durationSec INT)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_sessions (id VARCHAR(64) PRIMARY KEY, walletAddress VARCHAR(64), bookId VARCHAR(64), chapterId VARCHAR(64), startAt DATETIME, endAt DATETIME, status VARCHAR(32), challengeIds JSON, answers JSON, readingDurationSec INT, lang VARCHAR(8), expectedReadingMin INT, suspicious TINYINT DEFAULT 0, suspiciousReason VARCHAR(256), createdAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_books (id VARCHAR(64) PRIMARY KEY, data JSON)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_challenges (chapterId VARCHAR(64) PRIMARY KEY, data JSON)`);
      const [rows] = await mysqlPool.query(`SELECT COUNT(*) as c FROM readproof_books`);
      if(rows[0].c===0){
        for(const b of books) await mysqlPool.query(`INSERT IGNORE INTO readproof_books (id, data) VALUES (?,?)`, [b.id, JSON.stringify(b)]);
        for(const [cid, arr] of Object.entries(challengesByChapter)) await mysqlPool.query(`INSERT IGNORE INTO readproof_challenges (chapterId, data) VALUES (?,?)`, [cid, JSON.stringify(arr)]);
      }
      console.log(`MySQL ready: ${process.env.MYSQL_DATABASE}@${process.env.MYSQL_HOST} (readproof_*) — dostępne w https://frog02.mikr.us/pma/`);
    }catch(e){ console.error('MySQL init failed, zostaje SQLite', e.message); }
  })();
}

function proofHash(bookId, chapterId, wallet, ts, score) {
  const input = `${bookId}|${chapterId}|${wallet}|${new Date(ts).getTime()}|${score}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0,16);
}
async function callJev({question, expectedMeaning, userAnswer, context, lang='pl'}) {
  // TypeSafe Jev — POST https://api.typesafe.ai/v1/systemone (docs https://docs.typesafe.ai/api)
  // state = userAnswer (+ context), questions.is_correct typu noul
  if (TYPESAFE_API_KEY) {
    try {
      const state = `Context: ${context || ''}\nQuestion: ${question}\nExpected meaning: ${expectedMeaning}\nUser answer: ${userAnswer}\nLanguage: ${lang}`;
      const instructions = lang === 'en'
        ? `Does the user's answer correctly convey the expected meaning? Consider synonyms and paraphrases. Expected: "${expectedMeaning}"`
        : `Czy odpowiedź użytkownika poprawnie oddaje oczekiwane znaczenie? Uwzględnij synonimy. Oczekiwane: "${expectedMeaning}"`;
      const res = await fetch(TYPESAFE_ENDPOINT, {
        method:'POST',
        headers:{'Authorization':`Bearer ${TYPESAFE_API_KEY}`,'Content-Type':'application/json'},
        body: JSON.stringify({
          state,
          model: TYPESAFE_MODEL,
          questions: {
            is_correct: {
              type: 'noul',
              instructions,
              criteria: {
                true: lang==='en' ? 'Answer captures expected meaning' : 'Odpowiedź oddaje sens',
                false: lang==='en' ? 'Answer misses, hallucinates or is irrelevant' : 'Odpowiedź nie oddaje sensu / halucynacja'
              }
            }
          }
        })
      });
      if (res.ok) {
        const j = await res.json();
        const ans = j.answers?.is_correct;
        if (ans && typeof ans.noul === 'number') {
          const confidence = Number(ans.noul);
          const correct = confidence >= JEV_THRESHOLD;
          const reason = lang==='en'
            ? `TypeSafe Jev noul=${confidence.toFixed(2)} threshold ${JEV_THRESHOLD}`
            : `TypeSafe Jev noul=${confidence.toFixed(2)} próg ${JEV_THRESHOLD}`;
          return {correct, confidence, reason};
        }
      }
    } catch(e){ /* fallback mock */ }
  }
  return null;
}

// --- LLM generate challenges — NA ŻYWO w języku urządzenia/nastawionym, nawet gdy tekst książki EN ---
// Solidny extractor JSON — LLM (OpenRouter free) potrafi dodać fenced code, smy poza {} i zepsuć parsowanie
function extractJSON(text){
  let t = String(text||'').replace(/```(?:json)?/gi,'').trim();
  const first = t.indexOf('{');
  if(first<0) throw new Error('Brak { w odpowiedzi LLM');
  // od ostatniego } w dół — pierwsza parsowalna sekcja wygrywa
  let end = t.lastIndexOf('}');
  let lastErr=null;
  while(end>=first){
    try{
      const parsed=JSON.parse(t.slice(first,end+1));
      return parsed;
    }catch(e){ lastErr=e; end = t.lastIndexOf('}', end-1); }
  }
  // ostateczność: napraw trailing commas
  try{ return JSON.parse(t.slice(first, t.lastIndexOf('}')+1).replace(/,\s*([\]}])/g,'$1')); }
  catch(e){ lastErr=e; }
  throw lastErr || new Error('Nieprawidłowy JSON od LLM');
}

async function callOpenRouterGenerate(chapter, count=10, lang='pl'){
  if(!OPENROUTER_KEY) throw new Error('Brak OPENROUTER_API_KEY — ustaw w .env');
  const targetLang = lang==='en' ? 'ENGLISH' : 'POLISH';
  // Mocny prompt: system ma tłumaczyć/ generować w targetLang niezależnie od języka excerptu (często EN)
  const prompt = lang==='en'
  ? `Generate ${count} Reading Challenges for a public-domain book chapter.
Book: ${chapter.bookId}, chapter ${chapter.index} — ${chapter.title}
Original excerpt language: often ENGLISH (Gutenberg). IMPORTANT: you MUST output ALL questions, options, expectedMeaning, statements, pairs in ENGLISH, regardless of source language.
Context: ${chapter.contextExcerpt}
Summary: ${chapter.summary}
Source fragment (REAL full book text on server — base your questions ONLY on it):
${chapterFragment(chapter)}
Requirements:
- Use DIVERSE types from: multiple_choice, true_false, multiple_select, open_question, why_question, ordering, who_said, match, what_next, find_error
- At least 1 open_question or why_question with expectedMeaning (in ENGLISH)
- Questions MUST be fragment-dependent: e.g. "What did White Rabbit do immediately after Alice found the corridor?" not generic "What happened in chapter?"
- To pass, model must have analyzed specific fragment, not general book knowledge.
- Optionally, last question can be adaptive follow-up referencing previous answer context.
- Return ONLY JSON: {"challenges": [ ... ]}
- Each challenge: id, type, question, difficulty, and type-specific fields
- Question language: ENGLISH only`
  : `Wygeneruj ${count} Reading Challenge dla rozdziału książki domeny publicznej.
Książka: ${chapter.bookId}, rozdział ${chapter.index} — ${chapter.title}
Język oryginalnego fragmentu: często ANGIELSKI (Gutenberg). WAŻNE: MUSISZ wygenerować WSZYSTKIE pytania, opcje, expectedMeaning, statements, pary w języku POLSKIM, niezależnie od języka źródła.
Kontekst: ${chapter.contextExcerpt}
Streszczenie: ${chapter.summary}
Fragment źródłowy (REALNY pełny tekst książki na serwerze — pytania tylko na jego podstawie):
${chapterFragment(chapter)}
Wymagania:
- Używaj RÓŻNYCH typów z: multiple_choice, true_false, multiple_select, open_question, why_question, ordering, who_said, match, what_next, find_error
- Co najmniej 1 open_question lub why_question z polem expectedMeaning (po POLSKU)
- Pytania MUSZĄ być zależne od konkretnego fragmentu: np. "Co zrobił Biały Królik bezpośrednio po tym, jak Alice znalazła się w korytarzu?" zamiast "Co się wydarzyło w rozdziale?"
- Aby odpowiedzieć, trzeba przeanalizować fragment, nie wystarczy ogólna wiedza o książce.
- Opcjonalnie ostatnie pytanie może być adaptacyjne — dopytanie zależne od poprzedniej odpowiedzi.
- Zwróć TYLKO JSON: {"challenges": [ ... ]}
- Każdy challenge: id, type, question, difficulty, oraz pola specyficzne dla typu
- Język pytań: POLSKI (tłumacz sens jeśli excerpt był po angielsku)`;
  const res=await fetch('https://openrouter.ai/api/v1/chat/completions',{
    method:'POST',
    headers:{'Authorization':`Bearer ${OPENROUTER_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://readproof.app'},
    body: JSON.stringify({model: OPENROUTER_MODEL, messages:[{role:'user',content:prompt}], temperature:0.7, max_tokens:4000}),
    signal: AbortSignal.timeout(120000) // free LLM bywa wolny (~1min) — cut 120s, potem fallback do puli
  });
  if(!res.ok) throw new Error('OpenRouter error '+res.status);
  const j=await res.json();
  const content=j.choices?.[0]?.message?.content;
  if(!content) throw new Error('Brak content od LLM');
  const parsed = extractJSON(content);
  const challenges=parsed.challenges || parsed;
  if(!Array.isArray(challenges)) throw new Error('Niepoprawny JSON challenges');
  // upewnij się, że każde ma id (LLM potrafi pominąć)
  return challenges.map(c=>({...c, id: c.id && String(c.id) ? String(c.id) : crypto.randomUUID(), chapterId: chapter.id}));
}

// --- Pełne teksty książek na serwerze — AI korzysta z realnego fragmentu (nie tylko streszczenia) ---
const bookTexts = {};
function loadTexts(){
  for(const b of books){
    if(!b.fullTextFile) continue;
    for(const cand of ['./texts/'+b.fullTextFile, './'+b.fullTextFile]){
      try{ if(fs.existsSync(cand)){ bookTexts[b.id]=fs.readFileSync(cand,'utf8'); break; } }catch(e){}
    }
  }
  console.log(`[texts] ${Object.keys(bookTexts).length} książek załadowanych (${Object.entries(bookTexts).map(([k,v])=>k+'='+Math.round(v.length/1024)+'KB').join(', ')||'—'})`);
}
loadTexts();

// fragment książki okolony excerptu rozdziału — LLM ma kontekst z pełnego tekstu
function chapterFragment(chapter){
  const text = bookTexts[chapter.bookId];
  if(!text) return '';
  const anchor = chapter.contextExcerpt ? String(chapter.contextExcerpt).replace(/\s+/g,' ').slice(0,60).trim() : '';
  let pos = anchor ? text.indexOf(anchor) : -1;
  if(pos<0 && anchor){ pos = text.toLowerCase().indexOf(anchor.toLowerCase()); }
  if(pos<0){
    // approx: równomierny podział na wykryte "'CHAPTER" albo na index
    const parts = text.split(/\bCHAPTER\b/i);
    if(parts.length>1){ const k=Math.min(chapter.index||1, parts.length-1); pos = text.indexOf(parts[k]||parts[1]); }
    if(pos<0){ const per=Math.floor(text.length/10); pos=Math.min(text.length-1,(chapter.index-1||0)*per); }
  }
  const start = Math.max(0, pos-600);
  return text.slice(start, Math.min(text.length, start+4200));
}

function langOf(req){
  const q=(req.query.lang||'').toString().toLowerCase();
  if(q==='en'||q==='pl') return q;
  const h=(req.headers['x-lang']||req.headers['accept-language']||'').toString().toLowerCase();
  if(h.startsWith('en')) return 'en';
  if(h.startsWith('pl')) return 'pl';
  return 'pl';
}

// --- Routes ---
app.get('/health', (req,res)=>res.json({status:'ok', service:'readproof-backend', port:PORT, books: books.length, chapters: books.reduce((a,b)=>a+b.chapters.length,0), openRouter: !!OPENROUTER_KEY, model: OPENROUTER_MODEL, jevThreshold:JEV_THRESHOLD, jevTypesafe: !!TYPESAFE_API_KEY, lang: langOf(req), sessions: sessionsMem.size}));

// ====== Reading Sessions — anti-ChatGPT: staged release, pool 20-30, Proof of Comprehension ======
app.post('/api/sessions/start', async (req,res)=>{
  const {walletAddress, bookId, chapterId, expectedReadingMin} = req.body;
  const lang = langOf(req);
  if(!bookId || !chapterId) return res.status(400).json({error:'bookId and chapterId required'});
  if(!walletAddress) return res.status(400).json({error:'walletAddress required — connect Phantom Devnet'});
  const wallet = walletAddress;
  const DEV_PASSWORD = process.env.DEV_PASSWORD || 'hackathon2026@';
  const isDevBypass = (req.headers['x-dev-mode'] === '1' && req.headers['x-dev-password'] === DEV_PASSWORD) || (req.body.devBypass === true && req.body.devPassword === DEV_PASSWORD);
  // 1) Jednodniowa blokada po 3 oszustwach w 24h — bez litości, weryfikowalne on-chain
  if(!isDevBypass){
    const cntRows = await new Promise((res,rej)=>{
      const sql = useMySQL ? `SELECT COUNT(*) as cnt, MAX(endAt) as lastEnd FROM readproof_sessions WHERE walletAddress=? AND (status='Failed' OR suspicious=1) AND endAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)` : `SELECT COUNT(*) as cnt, MAX(endAt) as lastEnd FROM reading_sessions WHERE walletAddress=? AND (status='Failed' OR suspicious=1) AND datetime(endAt) > datetime('now','-24 hours')`;
      const cb=(e,rows)=> e?rej(e):res(rows);
      if(useMySQL) mysqlPool.query(sql, [wallet]).then(([rows])=>cb(null,rows)).catch(e=>rej(e)); else db.get(sql, [wallet], (e,row)=> e?rej(e):res([row]));
    }).catch(()=>[]);
    const cnt = Number(cntRows?.[0]?.cnt || 0);
    if(cnt >= 3){
      const lastEnd = cntRows[0]?.lastEnd || cntRows[0]?.lastEnd;
      const last = lastEnd ? new Date(lastEnd) : new Date();
      const retryAfter = Math.ceil((last.getTime() + 24*60*60*1000 - Date.now())/1000);
      return res.status(429).json({error: 'Blokada 1 dnia po 3 oszukanych próbach', retryAfter: Math.max(retryAfter,0), blockedUntil: new Date(last.getTime()+24*60*60*1000).toISOString()});
    }
  }
  // 2) cooldown 30 min po błędnej/oszukanej sesji (pomijany w dev/test mode — do testów bez czekania)
  const cooldownRows = await new Promise((res,rej)=>{
    const sql = useMySQL ? `SELECT * FROM readproof_sessions WHERE walletAddress=? AND chapterId=? AND (status='Failed' OR suspicious=1) AND endAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE) ORDER BY endAt DESC LIMIT 1` : `SELECT * FROM reading_sessions WHERE walletAddress=? AND chapterId=? AND (status='Failed' OR suspicious=1) AND datetime(endAt) > datetime('now','-30 minutes') ORDER BY endAt DESC LIMIT 1`;
    const cb=(e,rows)=> e?rej(e):res(rows);
    if(useMySQL) mysqlPool.query(sql, [wallet, chapterId]).then(([rows])=>cb(null,rows)).catch(e=>rej(e)); else db.all(sql, [wallet, chapterId], cb);
  }).catch(()=>[]);
  if(!isDevBypass && cooldownRows && cooldownRows.length>0){
    const last = cooldownRows[0];
    const end = new Date(last.endAt || last.endAt);
    const retryAfter = Math.ceil((end.getTime() + 30*60*1000 - Date.now())/1000);
    return res.status(429).json({error: 'Blokada 30 min po błędnej/oszukanej próbie (1 sygnał = wypadnięcie)', retryAfter, blockedUntil: new Date(end.getTime()+30*60*1000).toISOString()});
  }
  const chapter = books.flatMap(b=>b.chapters).find(c=>c.id===chapterId);
  if(!chapter) return res.status(404).json({error:'chapter not found'});
  const isDemo = req.query.demo === '1' || req.body.demo === true || true;
  let picked;
  try{
    // każda sesja — zupełnie nowe 5 pytań live w języku urządzenia (pełny tekst książki na serwerze)
    const chapterForGen = books.flatMap(b=>b.chapters).find(c=>c.id===chapterId);
    if(chapterForGen && OPENROUTER_KEY){
      // FIRE-AND-FORGET: start wraca natychmiast z puli; LLM (wolny free tier, ~1min) zasila pulę
      // pytaniami z realnego tekstu na NASTĘPNE sesje. Nigdy nie blokuje startu.
      callOpenRouterGenerate(chapterForGen, 5, lang).then(async (fresh)=>{
        challengesByChapter[chapterId] = (challengesByChapter[chapterId]||[]).concat(fresh);
        try{ fs.writeFileSync('./challenges.json', JSON.stringify({books, challengesByChapter}, null, 2)); }catch{}
        console.log(`[llm-bg] +${fresh.length} nowych pytań (pełny tekst) dla ${chapterId} — następna sesja dostanie świeże`);
      }).catch(e=>console.error(`[llm-bg] fail: ${e.message}`));
    }
    picked = await pickForSession(chapterId, lang);
  }catch(e){
    // LLM padł / zły JSON → sesja WCIĄŻ startuje z puli (nigdy nie wiesza się "loading")
    console.error(`[start] fallback do puli: ${e.message}`);
    picked = await pickForSession(chapterId, lang).catch(()=>pickFive(chapterId));
  }
  const startAt = new Date().toISOString();
  const sessionChallenges = isDevBypass ? buildSessionChallenges(picked, startAt, false).map(c=>({...c, releaseAt: startAt})) : buildSessionChallenges(picked, startAt, isDemo);
  const id = crypto.randomUUID();
  const expectedMin = expectedReadingMin || 12;
  const session = {
    id, walletAddress: wallet, bookId, chapterId, startAt, endAt: null, status:'reading',
    challengeIds: picked.map(c=>c.id), challenges: sessionChallenges,
    answers: {}, // challengeId -> {answer, answeredAt, correct, jev}
    readingDurationSec: 0, lang, expectedReadingMin: expectedMin, isDemo, isDevBypass
  };
  sessionsMem.set(id, session);
  db.run(`INSERT INTO reading_sessions (id, walletAddress, bookId, chapterId, startAt, endAt, status, challengeIds, answers, readingDurationSec, lang, expectedReadingMin, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,wallet,bookId,chapterId,startAt,null,'reading', JSON.stringify(session.challengeIds), JSON.stringify(session.answers), 0, lang, expectedMin, startAt]);
  // return without exposing future questions — only first is unlocked, rest masked
  const now = Date.now();
  const masked = sessionChallenges.map(c=>{
    const unlockAt = new Date(c.releaseAt).getTime();
    const locked = unlockAt > now;
    if(locked) return {id:c.id, type:c.type, releaseAt:c.releaseAt, releaseAfterSec:c.releaseAfterSec, locked:true, hint: lang==='en'?'Reading — unlocks soon':'Czytanie — odblokuje się wkrótce'};
    return {...c, locked:false};
  });
  res.json({id, walletAddress: wallet, bookId, chapterId, startAt, expectedReadingMin: expectedMin, isDemo, isDevBypass, lang, timing: isDevBypass ? SESSION_TIMING_DEV : (isDemo? SESSION_TIMING_DEMO: SESSION_TIMING_REAL), challenges: masked, poolSize: (challengesByChapter[chapterId]||[]).length, note: lang==='en'?'Proof of Comprehension — not proof of physical reading. Challenges unlock gradually to prevent copy-to-AI.':'Proof of Comprehension — nie dowód fizycznego czytania. Challengee odblokowują się stopniowo — nie da się wkleić wszystkich do AI.'});
  console.log(`[start] ${wallet?.slice(0,6)}.. ${bookId}/${chapterId} lang=${lang} demo=${isDemo} dev=${isDevBypass} pool=${(challengesByChapter[chapterId]||[]).length} session=${id.slice(0,8)}`);
});

app.get('/api/sessions/:id', (req,res)=>{
  const s = sessionsMem.get(req.params.id);
  if(!s){
    db.get(`SELECT * FROM reading_sessions WHERE id=?`, [req.params.id], (err,row)=>{
      if(err||!row) return res.status(404).json({error:'session not found'});
      // fallback from DB
      const challenges = JSON.parse(row.challengeIds||'[]').map(id=> (challengesByChapter[row.chapterId]||[]).find(c=>c.id===id) || {id});
      return res.json({id:row.id, walletAddress:row.walletAddress, bookId:row.bookId, chapterId:row.chapterId, startAt:row.startAt, endAt:row.endAt, status:row.status, challenges, answers: JSON.parse(row.answers||'{}')});
    });
    return;
  }
  const now = Date.now();
  const masked = s.challenges.map(c=>{
    const locked = new Date(c.releaseAt).getTime() > now;
    if(locked) return {id:c.id, type:c.type, releaseAt:c.releaseAt, releaseAfterSec:c.releaseAfterSec, locked:true, hint: s.lang==='en'?'Keep reading…':'Czytaj dalej…'};
    return {...c, locked:false};
  });
  const readingDurationSec = Math.floor((now - new Date(s.startAt).getTime())/1000);
  res.json({...s, readingDurationSec, challenges: masked});
});

app.post('/api/sessions/:id/answer', async (req,res)=>{
  const s = sessionsMem.get(req.params.id);
  if(!s) return res.status(404).json({error:'session not found'});
  const {challengeId, answer} = req.body;
  const ch = s.challenges.find(c=>c.id===challengeId);
  if(!ch) return res.status(404).json({error:'challenge not in session'});
  if(new Date(ch.releaseAt).getTime() > Date.now()) return res.status(423).json({error:'challenge still locked — keep reading', releaseAt: ch.releaseAt});
  if(s.answers[challengeId]) return res.status(409).json({error:'already answered'});
  let correct=false; let jev=null;
  switch(ch.type){
    case 'multiple_choice': case 'true_false': case 'what_next': correct = answer === ch.correctAnswer; break;
    case 'multiple_select': { const exp=new Set(ch.correctAnswers||[]); const got=new Set(Array.isArray(answer)?answer:[]); correct = exp.size===got.size && [...exp].every(v=>got.has(v)); break; }
    case 'find_error': correct = answer === ch.errorIndex; break;
    case 'ordering': case 'ranking': correct = JSON.stringify(answer) === JSON.stringify(ch.correctOrder); break;
    case 'match': case 'who_said': { if(answer && typeof answer==='object'){ let ok=true; for(const [k,v] of Object.entries(answer)) if(Number(k)!==Number(v)) ok=false; correct= ok && Object.keys(answer).length===(ch.pairs||[]).length; } break; }
    case 'open_question': case 'why_question': {
      if(typeof answer==='string'){
        const j = await callJev({question:ch.question, expectedMeaning: ch.expectedMeaning, userAnswer: answer, context: ch.context||'', lang: s.lang});
        if(!j) return res.status(503).json({error: s.lang==='en'?'Jev unavailable':'Jev niedostępny — ustaw TYPESAFE_API_KEY'});
        jev = j; correct = jev.correct && jev.confidence >= JEV_THRESHOLD;
      }
      break;
    }
    default: correct=false;
  }
  const answeredAt = new Date();
  const unlockAt = new Date(ch.releaseAt).getTime();
  const elapsed = Math.floor((answeredAt.getTime() - unlockAt)/1000);
  // krótkie okno 60-90s — jeśli po czasie, oznacz jako niepoprawne (opcjonalnie)
  if(elapsed > 90){
    correct = false;
    jev = jev ? {...jev, reason: (jev.reason||"") + " | overtime (>90s)"} : jev;
  }
  // bardzo szybka odpowiedź (<3s) na trudne — sygnał suspicious (nie dotyczy dev/demo — insta-test)
  if(elapsed < 3 && (ch.type==='open_question'||ch.type==='why_question') && !s.isDevBypass){
    s.suspicious = 1;
    s.suspiciousReason = `too_fast_answer: ${ch.id} ${elapsed}s`;
  }
  s.answers[challengeId] = {answer, answeredAt: answeredAt.toISOString(), correct, jev, elapsed};
  s.readingDurationSec = Math.floor((Date.now() - new Date(s.startAt).getTime())/1000);
  db.run(`UPDATE reading_sessions SET answers=?, readingDurationSec=? WHERE id=?`, [JSON.stringify(s.answers), s.readingDurationSec, s.id]);
  res.json({challengeId, correct, jev, readingDurationSec: s.readingDurationSec});
  console.log(`[answer] ${s.walletAddress?.slice(0,6)}.. ${challengeId.slice(0,8)} correct=${correct} type=${ch.type} elapsed=${elapsed}s${jev?` jev=${jev.correct?1:0} conf=${(jev.confidence??0).toFixed(2)}`:''}`);
});

// iOS: screenshot / screenRecording → oznacz sesję jako podejrzaną
// Pauza — weryfikowana przez backend (nie tylko frontend)
app.post('/api/sessions/:id/pause', (req,res)=>{
  const s = sessionsMem.get(req.params.id);
  if(!s) return res.status(404).json({error:'session not found'});
  if(s.pausedAt) return res.json({ok:true, alreadyPaused:true});
  s.pausedAt = new Date().toISOString(); s.status='paused';
  db.run(`UPDATE reading_sessions SET pausedAt=?, status=? WHERE id=?`, [s.pausedAt, s.status, s.id]);
  res.json({ok:true, pausedAt: s.pausedAt});
});
app.post('/api/sessions/:id/resume', (req,res)=>{
  const s = sessionsMem.get(req.params.id);
  if(!s || !s.pausedAt) return res.status(400).json({error:'not paused'});
  const pausedMs = Date.now() - new Date(s.pausedAt).getTime();
  const sec = Math.floor(pausedMs/1000);
  s.totalPausedSec = (s.totalPausedSec||0)+sec;
  // przesuń przyszłe releaseAt o pauzę
  s.challenges = s.challenges.map(c=>{
    const rel = new Date(c.releaseAt).getTime();
    if(rel > Date.now() - pausedMs) return {...c, releaseAt: new Date(rel + pausedMs).toISOString()};
    return c;
  });
  s.pausedAt=null; s.status='reading';
  db.run(`UPDATE reading_sessions SET totalPausedSec=?, pausedAt=NULL, status=? WHERE id=?`, [s.totalPausedSec, s.status, s.id]);
  res.json({ok:true, totalPausedSec: s.totalPausedSec});
});

// iOS: screenshot / screenRecording → oznacz sesję jako podejrzaną (nie wypłacaj, można ponownie)
app.post('/api/sessions/:id/flag', (req,res)=>{
  const s = sessionsMem.get(req.params.id);
  if(!s) return res.status(404).json({error:'session not found'});
  const {type, reason} = req.body; // type: "screenshot" | "screenRecording"
  s.suspicious = 1;
  s.suspiciousReason = `${type||'unknown'}: ${reason||''}`.slice(0,200);
  s.status='Failed'; s.endAt=new Date().toISOString();
  db.run(`UPDATE reading_sessions SET suspicious=1, suspiciousReason=?, status='Failed', endAt=? WHERE id=?`, [s.suspiciousReason, s.endAt, s.id]);
  res.json({ok:true, suspicious:true, reason: s.suspiciousReason, ended:true});
});

app.post('/api/sessions/:id/complete', async (req,res)=>{
  const s = sessionsMem.get(req.params.id);
  if(!s) return res.status(404).json({error:'session not found'});
  // fail=1 → zakończ od razu (błędna odpowiedź / screenshot), nawet gdy nie wszystkie odpowiedziane
  const failEarly = req.query.fail === '1' || req.body?.fail === true || req.body?.endEarly === true;
  const total = s.challenges.length;
  const answered = Object.keys(s.answers).length;
  if(!failEarly && answered < total) return res.status(400).json({error:`Not all challenges answered: ${answered}/${total}`});

  // ── 1. WERYFIKACJA — Verification Engine (anti-cheat, score, czas, proofHash) ──
  const endAtDate = new Date();
  const endAt = endAtDate.toISOString();
  s.endAt = endAt;
  s.readingDurationSec = Math.floor((endAtDate.getTime() - new Date(s.startAt).getTime())/1000);
  const verdict = runVerification(s, endAtDate); // { verified, status, score, total, durationSec, verificationVersion, proofHash, checks }

  // po weryfikacji: failEarly zawsze kończy jako Failed (błędna odpowiedź / oszustwo)
  const finalStatus = failEarly ? 'Failed' : verdict.status;
  s.status = finalStatus;

  // ── 2. ZAPIS WYNIKU — deciduj nagrodę tylko gdy weryfikacja przeszła ──
  const proofId = crypto.randomUUID();
  const proofHash = verdict.proofHash;
  const verificationVersion = verdict.verificationVersion;
  let tx=null, explorer=null, reward=null;
  if(verdict.verified && !failEarly){
    const chapter = books.flatMap(b=>b.chapters).find(c=>c.id===s.chapterId);
    reward = chapter?.reward || '5 USDC';
    const real = await tryRealSolanaReward(s.walletAddress, reward);
    if(real){ tx=real.signature; explorer=real.explorer; } else { tx=null; explorer=null; }
  } else {
    reward = null;
  }
  const detail = s.challenges.map(c=>({challengeId:c.id, correct: !!s.answers[c.id]?.correct, jev: s.answers[c.id]?.jev || null}));
  db.run(`INSERT INTO proofs (id, bookId, chapterId, score, total, status, walletAddress, timestamp, proofHash, txSignature, explorerUrl, reward, detail, verificationVersion, durationSec) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [proofId, s.bookId, s.chapterId, verdict.score, total, finalStatus, s.walletAddress, endAt, proofHash, tx, explorer, reward, JSON.stringify(detail), verificationVersion, verdict.durationSec]);
  db.run(`UPDATE reading_sessions SET endAt=?, status=?, readingDurationSec=? WHERE id=?`, [endAt, finalStatus, s.readingDurationSec, s.id]);
  console.log(`[complete] ${s.walletAddress?.slice(0,6)}.. ${s.chapterId} score=${verdict.score}/${total} status=${finalStatus} version=${verificationVersion} proof=${proofHash} verified=${verdict.verified} checks=${verdict.checks.filter(c=>!c.passed).map(c=>c.name).join(',')||'ALL PASS'}`);
  res.json({
    sessionId: s.id, proof: {id: proofId, bookId:s.bookId, chapterId:s.chapterId, score: verdict.score, total, status: finalStatus, walletAddress:s.walletAddress, timestamp:endAt, proofHash, txSignature:tx, explorerUrl: explorer, reward, verificationVersion, durationSec: verdict.durationSec},
    readingDurationSec: verdict.durationSec, startAt: s.startAt, endAt, lang: s.lang,
    verification: { verified: verdict.verified, version: verificationVersion, checks: verdict.checks },
    results: detail,
    note: s.lang==='en' ? 'Comprehension verified — not physical reading. Stored: wallet, book, chapter, session_start/end, reading_duration, proof_hash.' : 'Comprehension verified — nie fizyczne czytanie. Zapisano: wallet, book, chapter, session_start/end, reading_duration, proof_hash.'
  });
});

app.get('/api/books', (req,res)=>res.json(books));

app.get('/api/books/:bookId', (req,res)=>{
  const b=books.find(x=>x.id===req.params.bookId);
  if(!b) return res.status(404).json({error:'book not found'});
  res.json(b);
});

app.get('/api/books/:bookId/chapters/:chapterId/challenge', (req,res)=>{
  const chs=pickFive(req.params.chapterId);
  if(!chs.length) return res.status(404).json({error:'no challenges'});
  res.json({chapterId:req.params.chapterId, count:chs.length, challenges: chs, lang: langOf(req)});
});

app.get('/api/challenges/:chapterId', (req,res)=>{
  const pool=challengesByChapter[req.params.chapterId];
  if(!pool) return res.status(404).json({error:'not found'});
  if(req.query.pick) {
    const n=Math.min(Number(req.query.pick)||5, pool.length);
    res.json(pickFive(req.params.chapterId).slice(0,n));
  } else res.json(pool);
});

app.post('/api/evaluate', async (req,res)=>{
  const {question, expectedMeaning, userAnswer, context} = req.body;
  const lang=langOf(req);
  if(!question || !expectedMeaning || !userAnswer) return res.status(400).json({error:'question, expectedMeaning, userAnswer required'});
  const trimmed=String(userAnswer).trim();
  if(trimmed.length<3) return res.status(400).json({error: lang==='en'?'Too short':'Za krótka odpowiedź'});
  const fromJev=await callJev({question, expectedMeaning, userAnswer:trimmed, context: context||'', lang});
  if(!fromJev) return res.status(503).json({error: lang==='en'?'Jev unavailable — set TYPESAFE_API_KEY in backend/.env':'Jev niedostępny — ustaw TYPESAFE_API_KEY w backend/.env', lang});
  res.json({...fromJev, source:'jev', lang});
});

app.post('/api/proofs', async (req,res)=>{
  const {bookId, chapterId, answers, walletAddress} = req.body; // answers: {challengeId: answer}
  if(!bookId || !chapterId || !answers) return res.status(400).json({error:'bookId, chapterId, answers required'});
  if(!walletAddress) return res.status(400).json({error:'walletAddress required — connect Phantom (Devnet)'});
  const wallet = walletAddress;
  const DEV_PASSWORD2 = process.env.DEV_PASSWORD || 'hackathon2026@';
  const isDev2 = (req.headers['x-dev-mode'] === '1' && req.headers['x-dev-password'] === DEV_PASSWORD2) || (req.body.devBypass === true && req.body.devPassword === DEV_PASSWORD2);
  if(!isDev2){
    const cntRows2 = await new Promise((res,rej)=>{
      const sql = useMySQL ? `SELECT COUNT(*) as cnt, MAX(endAt) as lastEnd FROM readproof_sessions WHERE walletAddress=? AND (status='Failed' OR suspicious=1) AND endAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 24 HOUR)` : `SELECT COUNT(*) as cnt, MAX(endAt) as lastEnd FROM reading_sessions WHERE walletAddress=? AND (status='Failed' OR suspicious=1) AND datetime(endAt) > datetime('now','-24 hours')`;
      const cb=(e,rows)=> e?rej(e):res(rows);
      if(useMySQL) mysqlPool.query(sql, [wallet]).then(([rows])=>cb(null,rows)).catch(e=>rej(e)); else db.get(sql, [wallet], (e,row)=> e?rej(e):res([row]));
    }).catch(()=>[]);
    if(Number(cntRows2?.[0]?.cnt||0) >=3){
      const lastEnd = cntRows2[0]?.lastEnd; const last = lastEnd ? new Date(lastEnd) : new Date();
      const retryAfter = Math.ceil((last.getTime()+24*60*60*1000 - Date.now())/1000);
      return res.status(429).json({error:'Blokada 1 dnia po 3 oszukanych próbach', retryAfter:Math.max(retryAfter,0), blockedUntil:new Date(last.getTime()+24*60*60*1000).toISOString()});
    }
  }
  // cooldown 30 min po błędnej/oszukanej sesji (pomijany w test mode)
  const cooldownRows = await new Promise((res,rej)=>{
    const sql = useMySQL ? `SELECT * FROM readproof_sessions WHERE walletAddress=? AND chapterId=? AND (status='Failed' OR suspicious=1) AND endAt > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 30 MINUTE) ORDER BY endAt DESC LIMIT 1` : `SELECT * FROM reading_sessions WHERE walletAddress=? AND chapterId=? AND (status='Failed' OR suspicious=1) AND datetime(endAt) > datetime('now','-30 minutes') ORDER BY endAt DESC LIMIT 1`;
    const cb=(e,rows)=> e?rej(e):res(rows);
    if(useMySQL) mysqlPool.query(sql, [wallet, chapterId]).then(([rows])=>cb(null,rows)).catch(e=>rej(e)); else db.all(sql, [wallet, chapterId], cb);
  }).catch(()=>[]);
  if(!isDev2 && cooldownRows && cooldownRows.length>0){
    const last = cooldownRows[0];
    const end = new Date(last.endAt || last.endAt);
    const retryAfter = Math.ceil((end.getTime() + 30*60*1000 - Date.now())/1000);
    return res.status(429).json({error: 'Blokada 30 min po błędnej/oszukanej próbie (1 sygnał = wypadnięcie)', retryAfter, blockedUntil: new Date(end.getTime()+30*60*1000).toISOString()});
  }
  const pool=challengesByChapter[chapterId] || [];
  // we expect answers is either map or array of {challengeId, answer}
  let results=[];
  let score=0;
  // normalize: if answers is array of 5 challenges with answers, compute directly
  // For simplicity, client sends challenges + answers, we recompute via deterministic check + Jev for open
  const challenges = req.body.challenges || pool.slice(0,5); // fallback

  for(const ch of challenges){
    let ans = answers[ch.id] ?? answers[ch.id.toString()];
    // also support map by index
    let correct=false; let jev=null;
    switch(ch.type){
      case 'multiple_choice': case 'true_false': case 'what_next': correct = ans === ch.correctAnswer; break;
      case 'multiple_select': {
        const exp=new Set(ch.correctAnswers||[]); const got=new Set(Array.isArray(ans)?ans:[]);
        correct = exp.size===got.size && [...exp].every(v=>got.has(v)); break;
      }
      case 'find_error': correct = ans === ch.errorIndex; break;
      case 'ordering': case 'ranking': correct = JSON.stringify(ans) === JSON.stringify(ch.correctOrder); break;
      case 'match': case 'who_said': {
        // expect mapping left->right identity (simplified)
        if(ans && typeof ans==='object'){
          const pairs=ch.pairs||[];
          let ok=true; for(const [k,v] of Object.entries(ans)){ if(Number(k)!==Number(v)) ok=false; }
          correct = ok && Object.keys(ans).length===pairs.length;
        }
        break;
      }
      case 'open_question': case 'why_question': {
        if(typeof ans==='string'){
          const j = await callJev({question: ch.question, expectedMeaning: ch.expectedMeaning, userAnswer: ans, context: ch.context||'', lang: langOf(req)});
          if(!j) return res.status(503).json({error:'Jev unavailable — set TYPESAFE_API_KEY'});
          jev = j; correct = jev.correct && jev.confidence>=JEV_THRESHOLD;
        }
        break;
      }
      default: correct=false;
    }
    if(correct) score++;
    results.push({challengeId: ch.id, correct, jev, answer: ans});
  }
  const total=challenges.length;
  let status='Failed';
  if(score===5) status='Reading Verified';
  else if(score>=3) status='Try Again';
  const now=new Date().toISOString();
  const hash=proofHash(bookId, chapterId, wallet, now, score);
  let tx=null, explorer=null, reward=null;
  // nagroda tylko gdy 5/5 — błędna odpowiedź = zero
  if(score===5){
    const chapter=books.flatMap(b=>b.chapters).find(c=>c.id===chapterId);
    reward=chapter?.reward || '5 USDC';
    const real = await tryRealSolanaReward(wallet, reward);
    if(real){ tx=real.signature; explorer=real.explorer; } else { tx=null; explorer=null; }
  }
  const id=crypto.randomUUID();
  const detail=JSON.stringify(results);
  db.run(`INSERT INTO proofs (id, bookId, chapterId, score, total, status, walletAddress, timestamp, proofHash, txSignature, explorerUrl, reward, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, bookId, chapterId, score, total, status, wallet, now, hash, tx, explorer, reward, detail],
    (err)=>{
      if(err) console.error('db insert', err);
    }
  );
  res.json({id, bookId, chapterId, score, total, status, walletAddress: wallet, timestamp: now, proofHash: hash, txSignature: tx, explorerUrl: explorer, reward, results});
});

app.get('/api/proofs', (req,res)=>{
  const wallet=req.query.wallet;
  const sql= wallet ? `SELECT * FROM proofs WHERE walletAddress=? ORDER BY timestamp DESC LIMIT 50` : `SELECT * FROM proofs ORDER BY timestamp DESC LIMIT 50`;
  const params= wallet ? [wallet] : [];
  db.all(sql, params, (err, rows)=>{
    if(err) return res.status(500).json({error: err.message});
    res.json(rows.map(r=>({...r, detail: r.detail ? JSON.parse(r.detail): null})));
  });
});

app.get('/api/wallet/:address', (req,res)=>{
  res.json({address:req.params.address, balance:'12.50 USDC (Devnet)', network:'Solana Devnet', explorerBase:'https://explorer.solana.com/address/'});
});

app.post('/api/generate', async (req,res)=>{
  const {bookId, chapterId, count} = req.body;
  const lang=langOf(req);
  const chapter=books.flatMap(b=>b.chapters).find(c=>c.id===chapterId);
  if(!chapter) return res.status(404).json({error:'chapter not found'});
  try{
    const challenges=await callOpenRouterGenerate(chapter, Number(count)||10, lang);
    challengesByChapter[chapterId]=challenges;
    fs.writeFileSync('./challenges.json', JSON.stringify({books, challengesByChapter}, null, 2));
    res.json({ok:true, count: challenges.length, challenges, lang});
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// Serve full text files statically if present
app.get('/api/books/:bookId/text', (req,res)=>{
  const b=books.find(x=>x.id===req.params.bookId);
  if(!b || !b.fullTextFile) return res.status(404).json({error:'no text'});
  const file=`./texts/${b.fullTextFile}`;
  const fallback=`./${b.fullTextFile}`;
  const p= fs.existsSync(file) ? file : fallback;
  if(!fs.existsSync(p)) return res.status(404).json({error:'file not found', expected:b.fullTextFile});
  const txt=fs.readFileSync(p,'utf8');
  res.type('text/plain').send(txt.slice(0,50000));
});

// --- Gutendex public-domain catalog (darmowa baza) ---
// GET /api/catalog/gutendex?search=adventure&lang=en  -> proxy do https://gutendex.com/books/
app.get('/api/catalog/gutendex', async (req,res)=>{
  const search=(req.query.search||'adventure').toString();
  const lang=(req.query.lang||'en').toString();
  const url=`https://gutendex.com/books/?search=${encodeURIComponent(search)}&languages=${lang}&copyright=false`;
  try{
    const r=await fetch(url);
    const j=await r.json();
    const mapped=(j.results||[]).slice(0,12).map(b=>({
      id:`gutendex-${b.id}`,
      title:b.title,
      author:(b.authors||[]).map(a=>a.name).join(', '),
      languages:b.languages,
      subjects:(b.subjects||[]).slice(0,4),
      coverUrl: b.formats?.['image/jpeg'] || `https://covers.openlibrary.org/b/isbn/${b.id}-L.jpg`,
      gutenbergId:b.id,
      sourceUrl:`https://www.gutenberg.org/ebooks/${b.id}`,
      license:'Public domain — Gutendex / Gutenberg',
      download: b.formats?.['text/plain; charset=utf-8'] || b.formats?.['text/plain']
    }));
    res.json({count: mapped.length, next: j.next, results: mapped});
  }catch(e){ res.status(500).json({error:e.message});}
});

// Import wybranej książki z Gutendex do lokalnego katalogu (tworzy 2 rozdziały placeholder + challenges via LLM)
app.post('/api/catalog/gutendex/import', async (req,res)=>{
  const {gutenbergId, lang} = req.body;
  if(!gutenbergId) return res.status(400).json({error:'gutenbergId required'});
  try{
    const r=await fetch(`https://gutendex.com/books/${gutenbergId}`);
    const b=await r.json();
    const bookId=`gutendex-${b.id}`;
    if(books.find(x=>x.id===bookId)) return res.json({ok:true, bookId, exists:true});
    const title=b.title||`Book ${b.id}`;
    const author=(b.authors||[]).map(a=>a.name).join(', ')||'Unknown';
    const coverUrl=b.formats?.['image/jpeg'] || null;
    const langPick=(lang||'en').toLowerCase().startsWith('pl') ? 'pl' : 'en';
    const newBook={id:bookId, title, author, coverEmoji:'📚', coverUrl, description:`Import z Gutendex (public domain) — Gutenberg #${b.id}. ${ (b.subjects||[]).slice(0,3).join('; ')}`, totalChapters:2, rewardPerChapter:'5 USDC', sourceUrl:`https://www.gutenberg.org/ebooks/${b.id}`, license:'Public domain — Gutendex / Gutenberg', fullTextFile:null, chapters:[
      {id:`${bookId}-ch1`, bookId, index:1, title: langPick==='en'?'Chapter 1':'Rozdział 1', summary: (b.summaries?.[0]||'Public domain adventure').slice(0,180), contextExcerpt: `Gutenberg #${b.id} — ${(b.subjects||[]).slice(0,2).join(', ')}`, reward:'5 USDC'},
      {id:`${bookId}-ch2`, bookId, index:2, title: langPick==='en'?'Chapter 2':'Rozdział 2', summary: (b.summaries?.[0]||'Public domain').slice(0,180), contextExcerpt: `Gutenberg #${b.id} — public domain text`, reward:'5 USDC'}
    ]};
    books.push(newBook);
    // puste pule challenge — wygeneruj na żądanie via POST /api/generate (live w języku urządzenia)
    challengesByChapter[newBook.chapters[0].id]=[];
    challengesByChapter[newBook.chapters[1].id]=[];
    fs.writeFileSync('./challenges.json', JSON.stringify({books, challengesByChapter}, null, 2));
    res.json({ok:true, book: newBook});
  }catch(e){ res.status(500).json({error:e.message});}
});

// --- Solana Devnet docs (per https://solana.com/developers) ---
// USDC Devnet mint = 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU (Circle), Mainnet = EPjFWdd5...
// ATA creation + airdrop guide: faucet.solana.com (SOL), faucet.circle.com (USDC Devnet)
app.get('/api/solana/config', (req,res)=>{
  res.json({
    cluster:'devnet',
    rpc: SOLANA_RPC,
    usdcMint: USDC_MINT_DEVNET,
    usdcMintMainnet: USDC_MINT_MAINNET,
    explorerBase:'https://explorer.solana.com',
    faucets:{
      sol:'https://faucet.solana.com  OR  solana airdrop 2 --url https://api.devnet.solana.com',
      usdc:'https://faucet.circle.com  (select Solana Devnet + paste ATA/address)  OR  spl-token-faucet.com?token-name=USDC-Dev',
      cdp:'https://docs.cdp.coinbase.com/api-reference/v2/rest-api/faucets/request-funds-on-solana-devnet'
    },
    ata:'https://spl.solana.com/associated-token-account  (+ @solana/spl-token createAssociatedTokenAccountIdempotentInstruction)',
    realPayoutReady: !!SOLANA_PAYER_PRIVATE_KEY,
    note: SOLANA_PAYER_PRIVATE_KEY ? 'Real Devnet USDC transfer via payer key' : 'Mock payout (set SOLANA_PAYER_PRIVATE_KEY JSON array to enable real transfer)'
  });
});

// Try real Devnet USDC transfer if payer configured, else mock — called inside /api/proofs
async function tryRealSolanaReward(toAddress, amountUSDC='5', meta={}){
  if(!SOLANA_PAYER_PRIVATE_KEY) return null;
  try{
    const {Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction, TransactionInstruction} = await import('@solana/web3.js');
    const {createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, createTransferInstruction} = await import('@solana/spl-token');
    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(SOLANA_PAYER_PRIVATE_KEY)));
    const connection = new Connection(SOLANA_RPC, 'confirmed');
    const mint = new PublicKey(USDC_MINT_DEVNET);
    const owner = new PublicKey(toAddress);
    const ataFrom = getAssociatedTokenAddressSync(mint, payer.publicKey);
    const ataTo = getAssociatedTokenAddressSync(mint, owner);
    // ensure ATA exists (idempotent)
    const ixAta = createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ataTo, owner, mint);
    const txAta = new Transaction().add(ixAta);
    await sendAndConfirmTransaction(connection, txAta, [payer], {commitment:'confirmed'});
    // transfer 5 USDC (6 decimals)
    const amount = BigInt(Math.round(Number(amountUSDC.replace(/[^0-9.]/g,''))*1_000_000));
    const ixTransfer = createTransferInstruction(ataFrom, ataTo, payer.publicKey, amount);
    const tx = new Transaction().add(ixTransfer);
    // ── On-chain READING PROOF (Memo) — niezmienny zapis, bez treści/odpowiedzi ──
    // readproof-v1|book|chapter|session|score/total|duration|proofHash|timestamp
    if(meta.sessionId){
      const memo = `${meta.verificationVersion||'readproof-v1'}|${meta.bookId||''}|${meta.chapterId||''}|${meta.sessionId}|${meta.score||0}/${meta.total||0}|${meta.durationSec||0}s|${meta.proofHash||''}|${new Date(meta.timestamp||Date.now()).toISOString()}`;
      const MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
      const memoIx = new TransactionInstruction({keys:[], programId:new PublicKey(MEMO_V2), data:Buffer.from(memo,'utf8')});
      tx.add(memoIx);
      console.log(`[solana-memo] ${memo}`);
    }
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], {commitment:'confirmed'});
    return {signature:sig, explorer:`https://explorer.solana.com/tx/${sig}?cluster=devnet`};
  }catch(e){ console.error('real solana reward failed, fallback mock', e.message); return null; }
}

const USE_TLS = fs.existsSync('./certs/cert.pem') && fs.existsSync('./certs/key.pem');
if (USE_TLS) {
  const opts = { cert: fs.readFileSync('./certs/cert.pem'), key: fs.readFileSync('./certs/key.pem') };
  https.createServer(opts, app).listen(PORT, '0.0.0.0', () => console.log(`✅ ReadProof backend (TLS) https://0.0.0.0:${PORT} books=${books.length} openrouter=${!!OPENROUTER_KEY} jevTypesafe=${!!TYPESAFE_API_KEY} jevThresh=${JEV_THRESHOLD} [ENCRYPTED]`));
  // fallback http na PORT+1 dla wygody lokalnej (opcjonalnie)
  http.createServer(app).listen(PORT+1, '0.0.0.0', () => console.log(`   fallback http://0.0.0.0:${PORT+1}`));
} else {
  app.listen(PORT,'0.0.0.0',()=>console.log(`ReadProof backend :${PORT} books=${books.length} openrouter=${!!OPENROUTER_KEY} jevTypesafe=${!!TYPESAFE_API_KEY} jevThresh=${JEV_THRESHOLD} [PLAIN — dodaj certs/cert.pem + key.pem aby włączyć TLS]`));
}
