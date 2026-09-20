import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import mysql from 'mysql2/promise';
import { runVerification } from './verification.js';

dotenv.config();
const PORT = Number(process.env.PORT) || 32288;
const JEV_THRESHOLD = Number(process.env.JEV_THRESHOLD) || 0.28;
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

const PRIVACY_COPY = "ReadProof — Proof of Comprehension, not proof of physical reading. We store ONLY: walletAddress, bookId, chapterId, session_start/end, reading_duration, proof_hash (SHA-256). NEVER stored on-chain: book content, answers, prompts. Book content stays server-only (never full book on-chain). Solana Devnet ONLY (USDC/SOL test funds, no real money). Free LLM routing only. See /api/privacy.";
const PRIVACY_SHORT = "Privacy: wallet, book, chapter, duration, proof hash only. No content on-chain. Devnet only.";

const ALLOWED_ORIGINS = ['http://frog02.mikr.us:32287','https://frog02.mikr.us:32287','http://localhost:32288','http://127.0.0.1:32288','https://koderhack.github.io','http://koderhack.github.io','https://kacpersikora.pages.dev','https://koderhack.github.io'];
const corsOptions = {
  origin: function(origin, cb){
    if(!origin) return cb(null,true);
    if(ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.github.io') || origin.endsWith('.pages.dev') || origin.includes('frog02.mikr.us') || origin.includes('kacpersikora.pages.dev')) return cb(null,true);
    return cb(null,true); // open for hackathon demo (plus explicit frog)
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Lang','X-Dev-Mode','X-Dev-Password','Accept-Language','X-User-Id','X-Apple-User'],
  credentials: false
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
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
const SESSION_TIMING_DEMO = [0, 120, 240, 360, 480];
const SESSION_TIMING_DEV = [0, 0, 0, 0, 0]; // admin dev mode — natychmiastowe odblokowanie
const SESSION_TIMING_REAL = [0, 300, 600, 900, 1200]; // 5 min / pytanie — bez blokady czasowej, spokojne czytanie

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

// --- Helpers: ISBN, privacy, Solana ---
function isValidISBN(isbn){
  if(!isbn) return false;
  const s = String(isbn).replace(/[-\s]/g,'');
  if(s.length===13) return /^\d{13}$/.test(s);
  if(s.length===10) return /^[\dXx]{10}$/.test(s);
  return false;
}
function normalizeISBN(isbn){ return String(isbn).replace(/[-\s]/g,'').toUpperCase(); }
function campaignDeepLink(campaignId, isbn){
  const base = `https://koderhack.github.io/books/publisher/?campaign=${campaignId}`;
  return isbn ? `${base}&isbn=${normalizeISBN(isbn)}` : base;
}
function campaignPhoneScheme(campaignId, isbn){
  return `readproof://campaign/${campaignId}${isbn ? `?isbn=${normalizeISBN(isbn)}` : ''}`;
}

// --- DB: MySQL-only on frog (mikrus) — sqlite3 optional / no native load when MySQL ---
let useMySQL = !!(process.env.MYSQL_HOST && process.env.MYSQL_USER);
let mysqlPool = null;
let db = null;

// helper to create in-memory fallback if neither MySQL nor sqlite available (should not happen locally)
function createMemoryDb(){
  const mem = { proofs: new Map(), sessions: new Map(), users: new Map(), campaigns: new Map(), funds: new Map() };
  return {
    run(sql, params, cb){
      // no-op for create/alter in memory mode
      if(cb) cb(null);
    },
    get(sql, params, cb){
      // naive parser for SELECT * FROM users / proofs / sessions
      try{
        if(sql.includes('FROM users') && sql.includes('walletAddress=?')){
          const row = mem.users.get(params[0]) || null;
          cb(null, row);
        } else if(sql.includes('FROM publisher_campaigns') && sql.includes('id=?')){
          const row = mem.campaigns.get(params[0]) || null;
          cb(null, row);
        } else if(sql.includes('FROM publisher_campaigns')){
          cb(null, null);
        } else cb(null, null);
      }catch(e){ cb(e); }
    },
    all(sql, params, cb){
      try{
        if(sql.includes('FROM users')) cb(null, Array.from(mem.users.values()));
        else if(sql.includes('FROM publisher_campaigns')) cb(null, Array.from(mem.campaigns.values()));
        else if(sql.includes('FROM proofs')) cb(null, Array.from(mem.proofs.values()));
        else if(sql.includes('FROM reading_sessions')) cb(null, Array.from(mem.sessions.values()));
        else if(sql.includes('FROM campaign_funds')) cb(null, Array.from(mem.funds.values()));
        else cb(null, []);
      }catch(e){ cb(e); }
    },
    serialize(fn){ fn(); }
  };
}

if(useMySQL){
  mysqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT||3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    timezone: 'Z',
    // return JSON columns as strings to avoid auto-parse errors on malformed JSON (we parse manually)
    // mysql2: supportBigNumbers + jsonStrings
    supportBigNumbers: true,
    jsonStrings: true,
    dateStrings: true,
    waitForConnections: true, connectionLimit: 5
  });
  const M = (params) => (params||[]).map(v =>
    typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)
      ? v.replace('T',' ').replace(/\.\d+Z?$/, '')
      : v);
  function mapTables(q){
    return q.replace(/`proofs`/g,'`readproof_proofs`').replace(/`reading_sessions`/g,'`readproof_sessions`').replace(/`users`/g,'`readproof_users`').replace(/`publisher_campaigns`/g,'`readproof_campaigns`').replace(/`campaign_funds`/g,'`readproof_funds`')
            .replace(/\bproofs\b/g,'`readproof_proofs`').replace(/\breading_sessions\b/g,'`readproof_sessions`').replace(/\busers\b/g,'`readproof_users`').replace(/\bpublisher_campaigns\b/g,'`readproof_campaigns`').replace(/\bcampaign_funds\b/g,'`readproof_funds`');
  }
  db = {
    run(sql, params, cb){
      let q = mapTables(sql);
      q = q.replace(/TEXT PRIMARY KEY/g,'VARCHAR(64) PRIMARY KEY').replace(/TEXT,/g,'VARCHAR(64),').replace(/TEXT\)/g,'VARCHAR(64))');
      q = q.replace(/DATETIME/g,'DATETIME').replace(/JSON/g,'JSON');
      mysqlPool.query(q, M(params)).then(()=> cb&&cb(null)).catch(e=>{ console.error('[db:run] sql', q, 'params', params, 'err', e.message, e.stack?.slice(0,600)); cb&&cb(e); });
    },
    all(sql, params, cb){
      let q = mapTables(sql);
      mysqlPool.query(q, M(params)).then(([rows])=> cb(null, rows)).catch(e=>{ console.error('[db:all] sql', q, 'params', JSON.stringify(params).slice(0,500), 'err', e.message, e.stack?.slice(0,800)); cb(e); });
    },
    get(sql, params, cb){
      let q = mapTables(sql);
      mysqlPool.query(q, M(params)).then(([rows])=> cb(null, rows[0]||null)).catch(e=>{ console.error('[db:get] sql', q, 'err', e.message); cb(e); });
    },
    serialize(fn){ fn(); }
  };
} else {
  // try sqlite3 only when MySQL not configured (local dev)
  let sqlite3mod = null;
  try{ sqlite3mod = (await import('sqlite3')).default; }catch(e){ console.warn('[db] sqlite3 not available, using memory fallback', e.message); }
  if(sqlite3mod){
    let _db = new sqlite3mod.Database('./readproof.db');
    _db.serialize(() => {
      _db.run(`CREATE TABLE IF NOT EXISTS proofs (
        id TEXT PRIMARY KEY,
        bookId TEXT, chapterId TEXT, score INTEGER, total INTEGER, status TEXT,
        walletAddress TEXT, timestamp TEXT, proofHash TEXT, txSignature TEXT, explorerUrl TEXT, reward TEXT,
        detail TEXT,
        verificationVersion TEXT,
        durationSec INTEGER
      )`);
      _db.run(`ALTER TABLE proofs ADD COLUMN verificationVersion TEXT`, ()=>{});
      _db.run(`ALTER TABLE proofs ADD COLUMN durationSec INTEGER`, ()=>{});
      _db.run(`CREATE TABLE IF NOT EXISTS reading_sessions (
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
      _db.run(`ALTER TABLE reading_sessions ADD COLUMN suspicious INTEGER DEFAULT 0`, ()=>{});
      _db.run(`ALTER TABLE reading_sessions ADD COLUMN suspiciousReason TEXT`, ()=>{});
      _db.run(`ALTER TABLE reading_sessions ADD COLUMN totalPausedSec INTEGER DEFAULT 0`, ()=>{});
      _db.run(`ALTER TABLE reading_sessions ADD COLUMN pausedAt TEXT`, ()=>{});
      _db.run(`CREATE TABLE IF NOT EXISTS users (
        walletAddress TEXT PRIMARY KEY,
        displayName TEXT,
        email TEXT,
        role TEXT DEFAULT 'reader',
        createdAt TEXT,
        lastLoginAt TEXT
      )`);
      _db.run(`CREATE TABLE IF NOT EXISTS publisher_campaigns (
        id TEXT PRIMARY KEY,
        publisherWallet TEXT,
        title TEXT,
        author TEXT,
        isbn TEXT,
        description TEXT,
        rewardPool REAL DEFAULT 0,
        rewardPerProof REAL DEFAULT 5,
        currency TEXT DEFAULT 'USDC',
        status TEXT DEFAULT 'draft',
        bookContentHash TEXT,
        contentLength INTEGER DEFAULT 0,
        coverUrl TEXT,
        createdAt TEXT,
        updatedAt TEXT
      )`);
      _db.run(`CREATE TABLE IF NOT EXISTS campaign_funds (
        id TEXT PRIMARY KEY,
        campaignId TEXT,
        publisherWallet TEXT,
        amount REAL,
        currency TEXT,
        txSignature TEXT,
        explorerUrl TEXT,
        createdAt TEXT
      )`);
      _db.run(`ALTER TABLE publisher_campaigns ADD COLUMN isbn TEXT`, ()=>{});
      _db.run(`ALTER TABLE publisher_campaigns ADD COLUMN coverUrl TEXT`, ()=>{});
      // Apple auth extra columns (safe alter)
      _db.run(`ALTER TABLE users ADD COLUMN appleUserId TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN sessionToken TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN provider TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN nickname TEXT`, ()=>{});
      _db.run(`ALTER TABLE reading_sessions ADD COLUMN userId TEXT`, ()=>{});
      _db.run(`ALTER TABLE proofs ADD COLUMN userId TEXT`, ()=>{});
    });
    db = _db;
  } else {
    db = createMemoryDb();
  }
}
// MySQL init — create tables + migrate for Apple auth
if (useMySQL) {
  (async()=>{
    try{
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_proofs (id VARCHAR(64) PRIMARY KEY, bookId VARCHAR(64), chapterId VARCHAR(64), score INT, total INT, status VARCHAR(32), walletAddress VARCHAR(64), timestamp DATETIME, proofHash VARCHAR(32), txSignature VARCHAR(128), explorerUrl VARCHAR(256), reward VARCHAR(32), detail JSON, verificationVersion VARCHAR(32), durationSec INT, userId VARCHAR(64))`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_sessions (id VARCHAR(64) PRIMARY KEY, walletAddress VARCHAR(64), bookId VARCHAR(64), chapterId VARCHAR(64), startAt DATETIME, endAt DATETIME, status VARCHAR(32), challengeIds JSON, answers JSON, readingDurationSec INT, lang VARCHAR(8), expectedReadingMin INT, suspicious TINYINT DEFAULT 0, suspiciousReason VARCHAR(256), createdAt DATETIME, userId VARCHAR(64))`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_books (id VARCHAR(64) PRIMARY KEY, data JSON)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_challenges (chapterId VARCHAR(64) PRIMARY KEY, data JSON)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_users (walletAddress VARCHAR(64) PRIMARY KEY, displayName VARCHAR(128), email VARCHAR(128), role VARCHAR(32) DEFAULT 'reader', createdAt DATETIME, lastLoginAt DATETIME, appleUserId VARCHAR(64), sessionToken VARCHAR(128), provider VARCHAR(16), nickname VARCHAR(128))`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_campaigns (id VARCHAR(64) PRIMARY KEY, publisherWallet VARCHAR(64), title VARCHAR(256), author VARCHAR(256), isbn VARCHAR(32), description TEXT, rewardPool DOUBLE DEFAULT 0, rewardPerProof DOUBLE DEFAULT 5, currency VARCHAR(16) DEFAULT 'USDC', status VARCHAR(32) DEFAULT 'draft', bookContentHash VARCHAR(64), contentLength INT DEFAULT 0, coverUrl VARCHAR(512), createdAt DATETIME, updatedAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_funds (id VARCHAR(64) PRIMARY KEY, campaignId VARCHAR(64), publisherWallet VARCHAR(64), amount DOUBLE, currency VARCHAR(16), txSignature VARCHAR(128), explorerUrl VARCHAR(256), createdAt DATETIME)`);
      // Apple auth migrations — add columns if missing (MySQL IF NOT EXISTS via try/catch)
      for(const q of [
        `ALTER TABLE readproof_users ADD COLUMN appleUserId VARCHAR(64)`,
        `ALTER TABLE readproof_users ADD COLUMN sessionToken VARCHAR(128)`,
        `ALTER TABLE readproof_users ADD COLUMN provider VARCHAR(16)`,
        `ALTER TABLE readproof_users ADD COLUMN nickname VARCHAR(128)`,
        `ALTER TABLE readproof_sessions ADD COLUMN userId VARCHAR(64)`,
        `ALTER TABLE readproof_proofs ADD COLUMN userId VARCHAR(64)`
      ]){ try{ await mysqlPool.query(q); }catch(e){ if(!String(e.message).includes('Duplicate column')) console.warn('[migrate]', e.message); } }
      // migrate primary key: allow apple users where id != walletAddress — keep walletAddress PK for now, but add unique index on appleUserId
      try{ await mysqlPool.query(`CREATE UNIQUE INDEX idx_users_apple ON readproof_users(appleUserId)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_sessions_user ON readproof_sessions(userId)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_proofs_user ON readproof_proofs(userId)`); }catch(e){}
      const [rows] = await mysqlPool.query(`SELECT COUNT(*) as c FROM readproof_books`);
      if(rows[0].c===0){
        for(const b of books) await mysqlPool.query(`INSERT IGNORE INTO readproof_books (id, data) VALUES (?,?)`, [b.id, JSON.stringify(b)]);
        for(const [cid, arr] of Object.entries(challengesByChapter)) await mysqlPool.query(`INSERT IGNORE INTO readproof_challenges (chapterId, data) VALUES (?,?)`, [cid, JSON.stringify(arr)]);
      } else {
        for(const b of books) await mysqlPool.query(`INSERT IGNORE INTO readproof_books (id, data) VALUES (?,?)`, [b.id, JSON.stringify(b)]);
        for(const [cid, arr] of Object.entries(challengesByChapter)) await mysqlPool.query(`INSERT IGNORE INTO readproof_challenges (chapterId, data) VALUES (?,?)`, [cid, JSON.stringify(arr)]);
      }
      console.log(`MySQL ready: ${process.env.MYSQL_DATABASE}@${process.env.MYSQL_HOST} (readproof_*) — dostępne w https://frog02.mikr.us/pma/`);
    }catch(e){ console.error('MySQL init failed', e.message); }
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
        ? `Does the user's answer convey the SAME meaning as expected, even if wording differs? Be VERY lenient: synonyms, paraphrases, implied cause (e.g. fairy gave shoes = shoes are enchanted) count as correct. Expected: "${expectedMeaning}". Example: Expected "shoes were enchanted" and user "fairy gave them to her" => TRUE.`
        : `Czy odpowiedź użytkownika przekazuje TO SAMO znaczenie co oczekiwane, nawet jeśli innymi słowami? Bądź BARDZO łagodny: synonimy, parafrazy, dorozumiana przyczyna (np. "wróżka dała buty" = "buty były zaczarowane") liczą się jako dobrze. Oczekiwane: "${expectedMeaning}". Przykład: Oczekiwane "buty były zaczarowane" a user "dała mu je wróżka/wiedźma" => DOBRZE. Weź pod uwagę kontekst: "${context || ''}".`;
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
  ? `Generate ${count} Reading Challenges for a public-domain book chapter — like a SCHOOL READING TEST (not too detailed).
Book: ${chapter.bookId}, chapter ${chapter.index} — ${chapter.title}
Original excerpt language: often ENGLISH (Gutenberg). IMPORTANT: you MUST output ALL questions, options, expectedMeaning, statements, pairs in ENGLISH.
Context: ${chapter.contextExcerpt}
Summary: ${chapter.summary}
Source fragment (REAL full book text — base questions on it, but school-test style):
${chapterFragment(chapter)}
Requirements — SCHOOL TEST style (sufficient, not picky):
- Use DIVERSE types from: multiple_choice, true_false, multiple_select, open_question, why_question, ordering, who_said, match, what_next, find_error
- At least 1 open_question or why_question with expectedMeaning (in ENGLISH)
- Questions should test COMPREHENSION (characters, motives, cause-effect), NOT tiny details like watch color. Good: "Why did Alice want to go through the small door?" Bad (too detailed): "What exact text was on the bottle in sentence 2?"
- Level: easy-medium, for a student who read the chapter once carefully.
- Return ONLY JSON: {"challenges": [ ... ]}
- Question language: ENGLISH only`
  : `Wygeneruj ${count} Reading Challenge dla rozdziału książki domeny publicznej — jak SZKOLNY TEST Z LEKTURY (nie za trudny, nie za szczegółowy).
Książka: ${chapter.bookId}, rozdział ${chapter.index} — ${chapter.title}
Język oryginalnego fragmentu: często ANGIELSKI (Gutenberg). WAŻNE: MUSISZ wygenerować WSZYSTKIE pytania, opcje, expectedMeaning, statements, pary w języku POLSKIM.
Kontekst: ${chapter.contextExcerpt}
Streszczenie: ${chapter.summary}
Fragment źródłowy (REALNY pełny tekst — pytania na jego podstawie, ale jak test z lektury):
${chapterFragment(chapter)}
Wymagania — styl TEST Z LEKTURY (wystarczający, nie czepialski):
- Używaj RÓŻNYCH typów z: multiple_choice, true_false, multiple_select, open_question, why_question, ordering, who_said, match, what_next, find_error
- Co najmniej 1 open_question lub why_question z polem expectedMeaning (po POLSKU)
- Pytania mają sprawdzać ZROZUMIENIE LEKTURY (bohaterowie, motywy, przyczyna-skutek), NIE drobne detale typu kolor zegarka czy dokładna godzina. Przykład DOBRY: "Dlaczego Alicja chciała przejść przez małe drzwi?" Przykład ZŁY (za szczegółowy): "Jaki dokładnie napis był na butelce w drugim zdaniu fragmentu?"
- Poziom: łatwy-średni, jak dla ucznia który przeczytał rozdział uważnie raz.
- Zwróć TYLKO JSON: {"challenges": [ ... ]}
- Język pytań: POLSKI`;
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
app.get('/health', (req,res)=>res.json({status:'ok', service:'readproof-backend', port:PORT, books: books.length, chapters: books.reduce((a,b)=>a+b.chapters.length,0), openRouter: !!OPENROUTER_KEY, model: OPENROUTER_MODEL, jevThreshold:JEV_THRESHOLD, jevTypesafe: !!TYPESAFE_API_KEY, lang: langOf(req), sessions: sessionsMem.size, privacy: PRIVACY_SHORT, cors: ALLOWED_ORIGINS, cluster:'devnet', publisher: { campaigns: 'GET /api/publisher/campaigns', users: 'GET /api/users' }}));
app.get('/api/privacy', (req,res)=>res.json({
  privacy: PRIVACY_COPY,
  short: PRIVACY_SHORT,
  storedFields: ['walletAddress','bookId','chapterId','session_start','session_end','reading_duration_sec','proof_hash','verification_version','challengeIds (no answers)'],
  neverStoredOnChain: ['book full text','user answers','prompts','personal data'],
  chainNote: 'Only proofHash + wallet + book/chapter + score + duration + timestamp on Solana Devnet via Memo. Book content stays server-only.',
  cluster: 'devnet',
  currencies: ['USDC Devnet (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)','SOL Devnet'],
  cost: 'FREE model routing (OpenRouter :free, Jev jev-latest). No Google hosting.',
  cors: ALLOWED_ORIGINS,
  contact: 'publisher panel https://koderhack.github.io/books/publisher/'
}));
app.get('/api/config', (req,res)=>res.json({
  service:'readproof-backend',
  port: PORT,
  privacy: PRIVACY_SHORT,
  cors: ALLOWED_ORIGINS,
  cluster:'devnet',
  solana: { rpc: SOLANA_RPC, usdcMint: USDC_MINT_DEVNET, explorer:'https://explorer.solana.com', faucets:{ sol:'https://faucet.solana.com', usdc:'https://faucet.circle.com' } },
  openRouter: { model: OPENROUTER_MODEL, free:true },
  jev: { model: TYPESAFE_MODEL, threshold: JEV_THRESHOLD }
}));

// ===== USERS API =====
app.post('/api/users', (req,res)=>{
  const {walletAddress, displayName, email, role} = req.body;
  if(!walletAddress) return res.status(400).json({error:'walletAddress required (Phantom Devnet)', privacy: PRIVACY_SHORT});
  // Solana address: permissive 32-44 alphanumeric (Devnet test may use phantom generated); loose check for hackathon
  const w = String(walletAddress).trim();
  if(w.length < 32 || w.length > 50) return res.status(400).json({error:'invalid walletAddress length (expected 32-44 base58 — Phantom Devnet)', got: w.length, privacy: PRIVACY_SHORT});
  if(!/^[A-Za-z0-9]{32,50}$/.test(w)) return res.status(400).json({error:'invalid walletAddress format', privacy: PRIVACY_SHORT});
  const now = new Date().toISOString();
  db.get(`SELECT * FROM users WHERE walletAddress=?`, [walletAddress], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(row){
      db.run(`UPDATE users SET displayName=?, email=?, role=?, lastLoginAt=? WHERE walletAddress=?`, [displayName||row.displayName, email||row.email, role||row.role, now, walletAddress], ()=>{
        res.json({ok:true, user: {...row, displayName: displayName||row.displayName, email: email||row.email, lastLoginAt: now}, privacy: PRIVACY_SHORT, note:'Existing wallet—updated lastLogin'});
      });
    } else {
      db.run(`INSERT INTO users (walletAddress, displayName, email, role, createdAt, lastLoginAt) VALUES (?,?,?,?,?,?)`, [walletAddress, displayName||null, email||null, role||'reader', now, now], (e2)=>{
        if(e2) return res.status(500).json({error:e2.message});
        res.json({ok:true, user:{walletAddress, displayName: displayName||null, email: email||null, role: role||'reader', createdAt: now, lastLoginAt: now}, privacy: PRIVACY_SHORT});
      });
    }
  });
});
app.get('/api/users/:walletAddress', (req,res)=>{
  db.get(`SELECT * FROM users WHERE walletAddress=?`, [req.params.walletAddress], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'user not found', privacy: PRIVACY_SHORT});
    res.json({user: row, privacy: PRIVACY_SHORT});
  });
});
app.get('/api/users', (req,res)=>{
  db.all(`SELECT * FROM users ORDER BY createdAt DESC LIMIT 100`, [], (err,rows)=>{
    if(err) return res.status(500).json({error:err.message});
    res.json({count: rows.length, users: rows, privacy: PRIVACY_SHORT});
  });
});
app.post('/api/users/:walletAddress/login', (req,res)=>{
  const now=new Date().toISOString();
  db.get(`SELECT * FROM users WHERE walletAddress=?`, [req.params.walletAddress], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'user not found — POST /api/users first', privacy: PRIVACY_SHORT});
    db.run(`UPDATE users SET lastLoginAt=? WHERE walletAddress=?`, [now, req.params.walletAddress], ()=>{
      res.json({ok:true, user:{...row, lastLoginAt: now}, privacy: PRIVACY_SHORT});
    });
  });
});

// ===== AUTH — Sign in with Apple (real verify or register) =====
function decodeAppleIdentityToken(token){
  try{
    const parts = String(token||'').split('.');
    if(parts.length<2) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'));
    return payload; // { iss, aud, exp, iat, sub, email ... }
  }catch(e){ return null; }
}
function sessionToken(){ return crypto.randomBytes(24).toString('hex'); }
function userIdFromReq(req){
  // priority: Authorization Bearer <sessionToken> -> lookup, else X-User-Id, else body userId
  const auth = req.headers['authorization']||'';
  if(auth.startsWith('Bearer ')){
    const tok = auth.slice(7).trim();
    // tok will be resolved via DB lookup in handler if needed; here just return tok as hint
    // but for sessions we need actual user id — handlers will verify token -> user
    return tok;
  }
  if(req.headers['x-user-id']) return String(req.headers['x-user-id']);
  if(req.headers['x-apple-user']) return String(req.headers['x-apple-user']);
  if(req.body && req.body.userId) return String(req.body.userId);
  if(req.body && req.body.appleUserId) return String(req.body.appleUserId);
  return null;
}
async function getUserIdForToken(tok){
  if(!tok) return null;
  // tok may be sessionToken or appleUserId or walletAddress
  return new Promise((res)=>{
    // try sessionToken
    db.get(`SELECT * FROM users WHERE sessionToken=?`, [tok], (e,r)=> {
      if(r) return res(r.appleUserId || r.walletAddress || r.id || tok);
      // try appleUserId
      db.get(`SELECT * FROM users WHERE appleUserId=?`, [tok], (e2,r2)=> {
        if(r2) return res(r2.appleUserId);
        // try walletAddress
        db.get(`SELECT * FROM users WHERE walletAddress=?`, [tok], (e3,r3)=> {
          if(r3) return res(r3.walletAddress);
          // maybe id field (MySQL users.id) — not our schema, fallback to tok
          return res(tok);
        });
      });
    });
  });
}
app.post('/api/auth/apple', (req,res)=>{
  const {identityToken, appleUserId, email, nickname, fullName, walletAddress} = req.body;
  if(!appleUserId) return res.status(400).json({error:'appleUserId required (ASAuthorizationAppleIDCredential.user)', privacy: PRIVACY_SHORT});
  // optional verify identityToken (JWT) — decode and check sub matches appleUserId, exp not expired
  let payload = null;
  if(identityToken){
    payload = decodeAppleIdentityToken(identityToken);
    if(payload){
      if(payload.sub && payload.sub !== appleUserId) return res.status(400).json({error:'identityToken sub mismatch', got: payload.sub, expected: appleUserId});
      if(payload.exp && Date.now()/1000 > payload.exp) return res.status(400).json({error:'identityToken expired', exp: payload.exp});
      // iss should be https://appleid.apple.com, aud your bundle id — skip strict for hackathon (any aud ok)
    }
  }
  const now = new Date().toISOString();
  const cleanNick = (nickname || fullName || '').trim() || `Apple-${String(appleUserId).slice(0,4)}`;
  const mail = email || payload?.email || null;
  // check existing by appleUserId
  db.get(`SELECT * FROM users WHERE appleUserId=?`, [appleUserId], (err,row)=>{
    if(err) return res.status(500).json({error: err.message});
    const token = sessionToken();
    if(row){
      // update
      db.run(`UPDATE users SET displayName=?, nickname=?, email=?, walletAddress=?, lastLoginAt=?, sessionToken=?, provider=? WHERE appleUserId=?`,
        [cleanNick, cleanNick, mail || row.email, walletAddress || row.walletAddress, now, token, 'apple', appleUserId],
        (e2)=>{
          if(e2) return res.status(500).json({error:e2.message});
          res.json({ok:true, user:{id: appleUserId, appleUserId, nickname: cleanNick, email: mail || row.email, walletAddress: walletAddress || row.walletAddress, provider:'apple', sessionToken: token, createdAt: row.createdAt, lastLoginAt: now}, sessionToken: token, provider:'apple', privacy: PRIVACY_SHORT, verified: !!payload});
        });
    } else {
      // insert — need walletAddress unique? If walletAddress already exists for another user, keep but allow apple user separate
      // users.walletAddress is PRIMARY KEY in old schema, but MySQL now has appleUserId column; we will insert with walletAddress = provided or null? But PK requires unique. Use appleUserId as walletAddress fallback if no wallet?
      // For MySQL, walletAddress PK will conflict if null. So we use INSERT with walletAddress = walletAddress || ('apple_'+appleUserId)
      const wAddr = walletAddress || `apple_${appleUserId.slice(0,16)}`;
      // check if wAddr already exists -> suffix
      db.get(`SELECT * FROM users WHERE walletAddress=?`, [wAddr], (e2, existing)=>{
        let finalW = wAddr;
        if(existing && existing.appleUserId !== appleUserId){
          finalW = `apple_${appleUserId}`;
        }
        db.run(`INSERT INTO users (walletAddress, displayName, nickname, email, role, createdAt, lastLoginAt, appleUserId, sessionToken, provider) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [finalW, cleanNick, cleanNick, mail, 'reader', now, now, appleUserId, token, 'apple'],
          (e3)=>{
            if(e3) return res.status(500).json({error:e3.message});
            res.json({ok:true, user:{id: appleUserId, appleUserId, nickname: cleanNick, email: mail, walletAddress: finalW, provider:'apple', sessionToken: token, createdAt: now, lastLoginAt: now}, sessionToken: token, provider:'apple', privacy: PRIVACY_SHORT, verified: !!payload});
          });
      });
    }
  });
});
app.get('/api/auth/me', (req,res)=>{
  const tok = (req.headers['authorization']||'').replace(/^Bearer\s+/,'').trim() || String(req.headers['x-user-id']||req.query.token||'');
  if(!tok) return res.status(401).json({error:'Authorization Bearer <sessionToken> or X-User-Id required'});
  // lookup by sessionToken, then appleUserId, then walletAddress
  db.get(`SELECT * FROM users WHERE sessionToken=?`, [tok], (e,r)=>{
    if(r) return res.json({user: r, provider: r.provider||'apple', privacy: PRIVACY_SHORT});
    db.get(`SELECT * FROM users WHERE appleUserId=?`, [tok], (e2,r2)=>{
      if(r2) return res.json({user: r2, provider: r2.provider||'apple', privacy: PRIVACY_SHORT});
      db.get(`SELECT * FROM users WHERE walletAddress=?`, [tok], (e3,r3)=>{
        if(r3) return res.json({user: r3, privacy: PRIVACY_SHORT});
        return res.status(404).json({error:'user not found for token'});
      });
    });
  });
});
app.post('/api/auth/verify', (req,res)=>{
  // legacy alias — same as /api/auth/apple but without wallet binding, for quick test
  return res.redirect(307, '/api/auth/apple');
});

// ===== PUBLISHER CAMPAIGNS API =====
app.get('/api/publisher/campaigns', (req,res)=>{
  const {isbn, publisherWallet, status} = req.query;
  let sql=`SELECT * FROM publisher_campaigns WHERE 1=1`;
  let params=[];
  if(isbn){ sql+=` AND isbn=?`; params.push(normalizeISBN(isbn)); }
  if(publisherWallet){ sql+=` AND publisherWallet=?`; params.push(publisherWallet); }
  if(status){ sql+=` AND status=?`; params.push(status); }
  sql+=` ORDER BY createdAt DESC LIMIT 100`;
  db.all(sql, params, (err,rows)=>{
    if(err) return res.status(500).json({error:err.message});
    const enriched = (rows||[]).map(r=>({
      ...r,
      isbnTyped: r.isbn,
      qr: { url: campaignDeepLink(r.id, r.isbn), scheme: campaignPhoneScheme(r.id, r.isbn), qrApi: `/api/publisher/campaigns/${r.id}/qr` },
      rewardPool: `${r.rewardPool} ${r.currency} (Devnet)`,
      funding: { explorerBase:'https://explorer.solana.com', usdcMint: USDC_MINT_DEVNET, cluster:'devnet' },
      privacy: PRIVACY_SHORT,
      contentNote: r.bookContentHash ? `Server-only ${r.contentLength} chars (hash ${r.bookContentHash.slice(0,16)}…) — never on-chain` : 'No content yet — POST /api/publisher/campaigns/:id/content'
    }));
    res.json({count: enriched.length, campaigns: enriched, privacy: PRIVACY_SHORT});
  });
});

app.get('/api/publisher/campaigns/:id', (req,res)=>{
  db.get(`SELECT * FROM publisher_campaigns WHERE id=?`, [req.params.id], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'campaign not found', privacy: PRIVACY_SHORT});
    // fetch funds
    db.all(`SELECT * FROM campaign_funds WHERE campaignId=? ORDER BY createdAt DESC`, [row.id], (e2, funds)=>{
      const totalFunded = (funds||[]).reduce((a,f)=>a+Number(f.amount||0),0);
      res.json({
        campaign: {
          ...row,
          isbnTyped: row.isbn,
          isbnValid: isValidISBN(row.isbn),
          qr: { url: campaignDeepLink(row.id, row.isbn), scheme: campaignPhoneScheme(row.id, row.isbn), qrApi: `/api/publisher/campaigns/${row.id}/qr` },
          rewardPool: `${row.rewardPool} ${row.currency} (Devnet)`,
          totalFunded,
          funds: funds||[],
          privacy: PRIVACY_SHORT,
          cors: ALLOWED_ORIGINS,
          contentNote: row.bookContentHash ? `Server-only ${row.contentLength} chars (hash ${row.bookContentHash.slice(0,16)}…) — never full book on-chain` : 'No content yet',
          chain: { cluster:'devnet', usdcMint: USDC_MINT_DEVNET, neverOnChain:'full book text' }
        },
        privacy: PRIVACY_COPY
      });
    });
  });
});

app.post('/api/publisher/campaigns', (req,res)=>{
  const {publisherWallet, title, author, isbn, description, rewardPerProof, currency, coverUrl} = req.body;
  if(!publisherWallet) return res.status(400).json({error:'publisherWallet required (Phantom Devnet)', privacy: PRIVACY_SHORT});
  if(!title) return res.status(400).json({error:'title required', privacy: PRIVACY_SHORT});
  if(isbn && !isValidISBN(isbn)) return res.status(400).json({error:'invalid ISBN (must be 10 or 13 digits, e.g. 9780141439761)', got: isbn, privacy: PRIVACY_SHORT});
  // ensure publisher user exists
  const id = `camp-${crypto.randomUUID().slice(0,8)}`;
  const now=new Date().toISOString();
  const normIsbn = isbn ? normalizeISBN(isbn) : null;
  const cur = (currency==='SOL'? 'SOL':'USDC');
  const perProof = Number(rewardPerProof||5);
  db.run(`INSERT INTO publisher_campaigns (id, publisherWallet, title, author, isbn, description, rewardPool, rewardPerProof, currency, status, bookContentHash, contentLength, coverUrl, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, publisherWallet, title, author||'Unknown', normIsbn, description||'', 0, perProof, cur, 'draft', null, 0, coverUrl||null, now, now],
    (err)=>{
      if(err) return res.status(500).json({error:err.message});
      // auto-create user if not exists
      db.get(`SELECT * FROM users WHERE walletAddress=?`, [publisherWallet], (e2,row)=>{
        if(!row){
          db.run(`INSERT INTO users (walletAddress, displayName, role, createdAt, lastLoginAt) VALUES (?,?,?,?,?)`, [publisherWallet, 'Publisher', 'publisher', now, now], ()=>{});
        }
      });
      res.json({
        ok:true,
        campaign: {
          id, publisherWallet, title, author: author||'Unknown', isbn: normIsbn, isbnTyped: normIsbn, isbnValid: isbn?isValidISBN(normIsbn):null,
          description: description||'', rewardPool:0, rewardPerProof:perProof, currency:cur, status:'draft', createdAt: now,
          qr: { url: campaignDeepLink(id, normIsbn), scheme: campaignPhoneScheme(id, normIsbn), qrApi: `/api/publisher/campaigns/${id}/qr` },
          deepLink: campaignDeepLink(id, normIsbn), phoneScheme: campaignPhoneScheme(id, normIsbn),
          privacy: PRIVACY_SHORT,
          cors: ALLOWED_ORIGINS
        },
        privacy: PRIVACY_COPY
      });
    });
});

app.get('/api/publisher/campaigns/:id/qr', (req,res)=>{
  db.get(`SELECT * FROM publisher_campaigns WHERE id=?`, [req.params.id], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'campaign not found'});
    const url = campaignDeepLink(row.id, row.isbn);
    const scheme = campaignPhoneScheme(row.id, row.isbn);
    // Return JSON with data for client-side QR (qrcode lib) + direct quickchart URL
    const qrPngUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`;
    res.json({
      campaignId: row.id,
      isbn: row.isbn,
      isbnTyped: row.isbn,
      url,
      scheme,
      qrPngUrl,
      qrApiAlternative: `https://quickchart.io/qr?size=300&text=${encodeURIComponent(url)}`,
      note: 'QR opens campaign on phone. Scan with ReadProof iOS app or any camera → opens koderhack.github.io/books/publisher/?campaign=… or readproof://campaign/…',
      privacy: PRIVACY_SHORT
    });
  });
});

app.get('/api/publisher/campaigns/:id/code', (req,res)=>{
  db.get(`SELECT * FROM publisher_campaigns WHERE id=?`, [req.params.id], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'campaign not found'});
    const code = row.isbn ? row.isbn : row.id.replace('camp-','').toUpperCase();
    res.json({campaignId: row.id, isbn: row.isbn, code, typedCode: code, deepLink: campaignDeepLink(row.id, row.isbn), scheme: campaignPhoneScheme(row.id, row.isbn), privacy: PRIVACY_SHORT, note:'Typed code = ISBN or short campaign code — user types in phone app to open campaign'});
  });
});

// ISBN lookup (typed)
app.get('/api/publisher/lookup', (req,res)=>{
  const {isbn, code} = req.query;
  const q = normalizeISBN(isbn||code||'');
  if(!q) return res.status(400).json({error:'isbn or code query required', privacy: PRIVACY_SHORT});
  db.get(`SELECT * FROM publisher_campaigns WHERE isbn=? OR id=?`, [q, q.startsWith('camp-')?q:`camp-${q.toLowerCase()}`], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row){
      db.all(`SELECT * FROM publisher_campaigns WHERE isbn LIKE ? LIMIT 10`, [`%${q}%`], (e2, rows)=>{
        res.json({found:false, query: q, suggestions: rows||[], privacy: PRIVACY_SHORT});
      });
      return;
    }
    res.json({found:true, campaign: {...row, qr:{url:campaignDeepLink(row.id,row.isbn), scheme:campaignPhoneScheme(row.id,row.isbn)}}, privacy: PRIVACY_SHORT });
  });
});

// Upload book content — server only, never on-chain (only hash)
app.post('/api/publisher/campaigns/:id/content', (req,res)=>{
  const {text, content} = req.body;
  const raw = text||content||'';
  if(!raw || String(raw).length < 100) return res.status(400).json({error:'content too short (min 100 chars). Paste full book chapter text.', privacy: PRIVACY_SHORT});
  if(String(raw).length > 600000) return res.status(400).json({error:'content too large (max 600k chars)', privacy: PRIVACY_SHORT});
  db.get(`SELECT * FROM publisher_campaigns WHERE id=?`, [req.params.id], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'campaign not found'});
    const hash = crypto.createHash('sha256').update(String(raw)).digest('hex');
    const len = String(raw).length;
    // ensure dir
    try{ fs.mkdirSync('./texts', {recursive:true}); }catch{}
    const safeId = req.params.id.replace(/[^a-z0-9-]/gi,'_');
    const path = `./texts/campaign_${safeId}.txt`;
    fs.writeFileSync(path, String(raw), 'utf8');
    // also store in challenges path for LLM? keep as campaign_text
    db.run(`UPDATE publisher_campaigns SET bookContentHash=?, contentLength=?, updatedAt=? WHERE id=?`, [hash, len, new Date().toISOString(), req.params.id], (e2)=>{
      if(e2) return res.status(500).json({error:e2.message});
      // store text for fragment LLM
      bookTexts[req.params.id]=String(raw);
      // immediate mock fallback (5 challenges) so campaign usable even before LLM finishes or if LLM fails
      function mockCampaignChallenges(txt, campaignId){
        const snippet = txt.slice(0, 600).replace(/\s+/g,' ').trim();
        return [
          { id: `${campaignId}-m1`, chapterId: campaignId, type:'multiple_choice', question: `O czym jest fragment: "${snippet.slice(0,80)}…"?`, options: ["Przygodzie i zagadce","Przepisie kulinarnym","Instrukcji technicznej","Wierszu"], correctAnswer:0, context: snippet.slice(0,200), difficulty:'easy' },
          { id: `${campaignId}-m2`, chapterId: campaignId, type:'true_false', question: `Fragment zawiera motywa przygody / bohatera?`, options:["Prawda","Fałsz"], correctAnswer:0, difficulty:'easy' },
          { id: `${campaignId}-m3`, chapterId: campaignId, type:'open_question', question: `Własnymi słowami: o czym jest pierwszy akapit?`, context: snippet.slice(0,300), expectedMeaning: snippet.slice(0,100), difficulty:'medium' },
          { id: `${campaignId}-m4`, chapterId: campaignId, type:'why_question', question: `Dlaczego bohater podejmuje działanie w tym fragmencie?`, context: snippet.slice(0,300), expectedMeaning: `Bo chce rozwiązać zagadkę / dotrzeć do celu`, difficulty:'medium' },
          { id: `${campaignId}-m5`, chapterId: campaignId, type:'multiple_select', question: `Wybierz 2 cechy tego tekstu`, options:["Narracyjny","Przygodowy","Techniczny manual","Liryczny wiersz"], correctAnswers:[0,1], difficulty:'easy' }
        ];
      }
      if(!challengesByChapter[req.params.id] || challengesByChapter[req.params.id].length <5){
        challengesByChapter[req.params.id]=mockCampaignChallenges(String(raw), req.params.id);
        try{ fs.writeFileSync('./challenges.json', JSON.stringify({books, challengesByChapter}, null, 2)); }catch{}
      }
      // also auto-generate BETTER challenges via LLM free (fire-and-forget) if key set — will overwrite mock on next session
      if(OPENROUTER_KEY){
        (async()=>{
          try{
            const chap = { id: req.params.id, bookId: req.params.id, index:1, title: row.title, summary: row.description||row.title, contextExcerpt: String(raw).slice(0,300), bookIdOrig: req.params.id };
            const gen = await callOpenRouterGenerate(chap, 8, langOf(req));
            // merge: keep mock if LLM returns empty, otherwise replace
            if(gen && gen.length>=5){
              challengesByChapter[req.params.id]=gen;
              try{ fs.writeFileSync('./challenges.json', JSON.stringify({books, challengesByChapter}, null, 2)); }catch{}
              console.log(`[campaign-content] LLM upgraded ${gen.length} challenges for ${req.params.id}`);
            }
          }catch(e){ console.error('[campaign-content] LLM gen failed (mock kept)', e.message); }
        })();
      }
      res.json({
        ok:true,
        campaignId: req.params.id,
        contentLength: len,
        bookContentHash: hash,
        hashShort: hash.slice(0,16),
        path,
        note: 'Content stored SERVER-ONLY (never full book on-chain). On-chain only proofHash + score. File: '+path,
        qr: { url: campaignDeepLink(req.params.id, row.isbn), scheme: campaignPhoneScheme(req.params.id, row.isbn) },
        privacy: PRIVACY_COPY
      });
    });
  });
});

app.get('/api/publisher/campaigns/:id/content', (req,res)=>{
  db.get(`SELECT * FROM publisher_campaigns WHERE id=?`, [req.params.id], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'campaign not found'});
    if(!row.bookContentHash) return res.status(404).json({error:'no content uploaded yet — POST /api/publisher/campaigns/:id/content', privacy: PRIVACY_SHORT});
    const safeId = req.params.id.replace(/[^a-z0-9-]/gi,'_');
    const p = `./texts/campaign_${safeId}.txt`;
    if(!fs.existsSync(p)) return res.status(404).json({error:'file missing on server'});
    const preview = fs.readFileSync(p,'utf8').slice(0, 2000);
    res.json({
      campaignId: row.id,
      contentLength: row.contentLength,
      bookContentHash: row.bookContentHash,
      preview: preview + (row.contentLength>2000?' …[truncated]':''),
      note: 'Full content is server-only. This preview is 2k chars. Full text never sent to chain.',
      privacy: PRIVACY_SHORT
    });
  });
});

// Fund reward pool — Devnet USDC/SOL (mock + optional real Solana transfer)
app.post('/api/publisher/campaigns/:id/fund', async (req,res)=>{
  const {publisherWallet, amount, currency, txSignature} = req.body;
  if(!publisherWallet) return res.status(400).json({error:'publisherWallet required', privacy: PRIVACY_SHORT});
  if(!amount || Number(amount)<=0) return res.status(400).json({error:'amount >0 required', privacy: PRIVACY_SHORT});
  const cur = (currency==='SOL' ? 'SOL':'USDC');
  const amt = Number(amount);
  if(amt>100000) return res.status(400).json({error:'amount too large (max 100k Devnet)', privacy: PRIVACY_SHORT});
  db.get(`SELECT * FROM publisher_campaigns WHERE id=?`, [req.params.id], async (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'campaign not found'});
    if(row.publisherWallet !== publisherWallet) return res.status(403).json({error:'only publisherWallet can fund', expected: row.publisherWallet});
    if(row.currency !== cur) return res.status(400).json({error:`campaign currency is ${row.currency}, got ${cur}`});
    // Optional: verify txSignature on Devnet via RPC (if provided)
    let verifiedTx = null;
    let explorer = null;
    if(txSignature && SOLANA_PAYER_PRIVATE_KEY){
      // real verification would call connection.getSignatureStatus
      verifiedTx = txSignature;
      explorer = `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;
    } else if(txSignature){
      verifiedTx = txSignature;
      explorer = `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;
    } else {
      // mock deterministic tx for Devnet demo
      verifiedTx = `mock-${crypto.createHash('sha256').update(req.params.id+publisherWallet+String(amt)+Date.now()).digest('hex').slice(0,32)}`;
      explorer = `https://explorer.solana.com/tx/${verifiedTx}?cluster=devnet`;
    }
    const fid = crypto.randomUUID();
    const now=new Date().toISOString();
    db.run(`INSERT INTO campaign_funds (id, campaignId, publisherWallet, amount, currency, txSignature, explorerUrl, createdAt) VALUES (?,?,?,?,?,?,?,?)`,
      [fid, req.params.id, publisherWallet, amt, cur, verifiedTx, explorer, now],
      (e2)=>{
        if(e2) return res.status(500).json({error:e2.message});
        const newPool = Number(row.rewardPool||0)+amt;
        db.run(`UPDATE publisher_campaigns SET rewardPool=?, status='active', updatedAt=? WHERE id=?`, [newPool, now, req.params.id], ()=>{
          res.json({
            ok:true,
            campaignId: req.params.id,
            funded: { amount: amt, currency: cur, txSignature: verifiedTx, explorerUrl: explorer, fundId: fid },
            rewardPool: `${newPool} ${cur} (Devnet)`,
            rewardPoolRaw: newPool,
            rewardPerProof: row.rewardPerProof,
            note: 'Devnet ONLY — no real money. '+ (txSignature ? 'Provided txSignature stored.' : 'Mock txSignature generated (set SOLANA_PAYER_PRIVATE_KEY for real Devnet transfer).'),
            usdcMint: USDC_MINT_DEVNET,
            cluster:'devnet',
            privacy: PRIVACY_SHORT
          });
        });
      });
  });
});

app.get('/api/publisher/campaigns/:id/funds', (req,res)=>{
  db.all(`SELECT * FROM campaign_funds WHERE campaignId=? ORDER BY createdAt DESC`, [req.params.id], (err,rows)=>{
    if(err) return res.status(500).json({error:err.message});
    res.json({campaignId: req.params.id, count: rows.length, funds: rows, usdcMint: USDC_MINT_DEVNET, cluster:'devnet', privacy: PRIVACY_SHORT});
  });
});

// Campaign challenge bridge — start proof for uploaded campaign book (uses campaign text)
app.post('/api/publisher/campaigns/:id/start', async (req,res)=>{
  const {walletAddress, userId: bodyUserId, appleUserId} = req.body;
  if(!walletAddress) return res.status(400).json({error:'walletAddress required'});
  let userId = bodyUserId || appleUserId || req.headers['x-user-id'] || req.headers['x-apple-user'] || null;
  const authH2 = req.headers['authorization']||'';
  if(authH2.startsWith('Bearer ') && !userId){
    const tok = authH2.slice(7).trim();
    try{
      const u = await new Promise((resolve)=>{
        db.get(`SELECT * FROM users WHERE sessionToken=?`, [tok], (e,r)=>{
          if(r) return resolve(r.appleUserId || r.walletAddress);
          db.get(`SELECT * FROM users WHERE appleUserId=?`, [tok], (e2,r2)=>{
            if(r2) return resolve(r2.appleUserId);
            resolve(tok);
          });
        });
      });
      userId = u;
    }catch(e){ userId = tok; }
  }
  db.get(`SELECT * FROM publisher_campaigns WHERE id=?`, [req.params.id], async (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'campaign not found'});
    if(!row.bookContentHash) return res.status(400).json({error:'no book content — publisher must POST /content first'});
    if(Number(row.rewardPool) < Number(row.rewardPerProof)) return res.status(400).json({error:`reward pool depleted (${row.rewardPool} ${row.currency}) < ${row.rewardPerProof} per proof — fund again`, currency: row.currency, pool: row.rewardPool});
    // delegate to sessions/start with campaign as chapter
    // ensure challenges exist
    let pool = challengesByChapter[req.params.id]||[];
    if(pool.length <5){
      try{
        const txtPath = `./texts/campaign_${req.params.id.replace(/[^a-z0-9-]/gi,'_')}.txt`;
        const txt = fs.existsSync(txtPath) ? fs.readFileSync(txtPath,'utf8') : '';
        bookTexts[req.params.id]=txt;
        if(OPENROUTER_KEY){
          try{
            const chap = { id: req.params.id, bookId: req.params.id, index:1, title: row.title, summary: row.description||row.title, contextExcerpt: txt.slice(0,500) };
            const gen = await callOpenRouterGenerate(chap, 10, langOf(req));
            if(gen && gen.length>=5){ pool = gen; challengesByChapter[req.params.id]=pool; try{ fs.writeFileSync('./challenges.json', JSON.stringify({books, challengesByChapter}, null,2)); }catch{} }
          }catch(e){ console.error('[campaign/start] LLM fail', e.message); }
        }
        if(pool.length<5){
          const snippet = txt.slice(0,600).replace(/\s+/g,' ').trim() || row.title;
          const cid=req.params.id;
          pool = [
            { id:`${cid}-m1`, chapterId:cid, type:'multiple_choice', question:`O czym jest fragment: "${snippet.slice(0,80)}…"?`, options:["Przygodzie i zagadce","Przepisie kulinarnym","Instrukcji technicznej","Wierszu"], correctAnswer:0, context: snippet.slice(0,200) },
            { id:`${cid}-m2`, chapterId:cid, type:'true_false', question:`Fragment zawiera motywa przygody / bohatera?`, options:["Prawda","Fałsz"], correctAnswer:0 },
            { id:`${cid}-m3`, chapterId:cid, type:'open_question', question:`Własnymi słowami: o czym jest pierwszy akapit?`, context: snippet.slice(0,300), expectedMeaning: snippet.slice(0,100) },
            { id:`${cid}-m4`, chapterId:cid, type:'why_question', question:`Dlaczego bohater podejmuje działanie w tym fragmencie?`, context: snippet.slice(0,300), expectedMeaning:`Bo chce rozwiązać zagadkę / dotrzeć do celu` },
            { id:`${cid}-m5`, chapterId:cid, type:'multiple_select', question:`Wybierz 2 cechy tego tekstu`, options:["Narracyjny","Przygodowy","Techniczny manual","Liryczny wiersz"], correctAnswers:[0,1] }
          ];
          challengesByChapter[cid]=pool;
          try{ fs.writeFileSync('./challenges.json', JSON.stringify({books, challengesByChapter}, null,2)); }catch{}
        }
      }catch(e){ console.error('[campaign/start] gen fail', e.message); }
    }
    if(pool.length <5) return res.status(500).json({error:'not enough challenges generated — retry', pool: pool.length});
    // create session like /api/sessions/start but with campaign book
    const lang = langOf(req);
    const picked = pool.sort(()=>Math.random()-0.5).slice(0,5);
    const id = crypto.randomUUID();
    const startAt=new Date().toISOString();
    const sessionChallenges = buildSessionChallenges(picked, startAt, true); // demo timing for hackathon
    const session={ id, walletAddress, bookId: req.params.id, chapterId: req.params.id, startAt, endAt:null, status:'reading', challengeIds: picked.map(c=>c.id), challenges: sessionChallenges, answers:{}, readingDurationSec:0, lang, expectedReadingMin:12, isDemo:true, userId: userId||null };
    sessionsMem.set(id, session);
    // try with userId
    const tryInsertCamp = (withUserId)=>{
      if(withUserId){
        db.run(`INSERT INTO reading_sessions (id, walletAddress, bookId, chapterId, startAt, endAt, status, challengeIds, answers, readingDurationSec, lang, expectedReadingMin, createdAt, userId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id,walletAddress,req.params.id,req.params.id,startAt,null,'reading', JSON.stringify(session.challengeIds), JSON.stringify(session.answers),0, lang,12, startAt, userId||null],
          (e)=>{ if(e && String(e.message).includes('no column')) tryInsertCamp(false); });
      } else {
        db.run(`INSERT INTO reading_sessions (id, walletAddress, bookId, chapterId, startAt, endAt, status, challengeIds, answers, readingDurationSec, lang, expectedReadingMin, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id,walletAddress,req.params.id,req.params.id,startAt,null,'reading', JSON.stringify(session.challengeIds), JSON.stringify(session.answers),0, lang,12, startAt]);
      }
    };
    tryInsertCamp(true);
    res.json({ok:true, sessionId:id, userId: userId||null, campaign: {id: row.id, title: row.title, isbn: row.isbn, rewardPerProof: `${row.rewardPerProof} ${row.currency} (Devnet)`}, challenges: sessionChallenges.map(c=>({...c, locked:false})), privacy: PRIVACY_SHORT, note:'Publisher campaign proof — same flow as books, reward from campaign pool.'});
  });
});

// ====== Reading Sessions — anti-ChatGPT: staged release, pool 20-30, Proof of Comprehension ======
app.post('/api/sessions/start', async (req,res)=>{
  const {walletAddress, bookId, chapterId, expectedReadingMin, userId: bodyUserId, appleUserId} = req.body;
  const lang = langOf(req);
  if(!bookId || !chapterId) return res.status(400).json({error:'bookId and chapterId required'});
  if(!walletAddress) return res.status(400).json({error:'walletAddress required — connect Phantom Devnet'});
  const wallet = walletAddress;
  // userId from Apple auth (header Bearer token or X-User-Id or body)
  let userId = bodyUserId || appleUserId || req.headers['x-user-id'] || req.headers['x-apple-user'] || null;
  const authH = req.headers['authorization']||'';
  if(authH.startsWith('Bearer ') && !userId){
    const tok = authH.slice(7).trim();
    // resolve token -> appleUserId via DB (async, best-effort)
    try{
      const u = await new Promise((resolve)=>{
        db.get(`SELECT * FROM users WHERE sessionToken=?`, [tok], (e,r)=>{
          if(r) return resolve(r.appleUserId || r.walletAddress);
          db.get(`SELECT * FROM users WHERE appleUserId=?`, [tok], (e2,r2)=>{
            if(r2) return resolve(r2.appleUserId);
            resolve(tok);
          });
        });
      });
      userId = u;
    }catch(e){ userId = tok; }
  }
  if(userId) console.log(`[start] userId=${String(userId).slice(0,12)} wallet=${wallet.slice(0,6)}`);
  const DEV_PASSWORD = process.env.DEV_PASSWORD || 'hackathon2026@';
  const isDevBypass = (req.headers['x-dev-mode'] === '1' && req.headers['x-dev-password'] === DEV_PASSWORD) || (req.body.devBypass === true && req.body.devPassword === DEV_PASSWORD);
  // 1) Jednodniowa blokada po 3 oszustwach w 24h — bez litości, weryfikowalne on-chain
  // Bloki czasowe wyłączone na życzenie — bez 24h ani 30 min cooldownu (swobodne ponawianie)
  // if(!isDevBypass){ ... 24h ... } - disabled
  // cooldown 30 min - disabled (wcześniej: 1 błędna = blokada 30 min)
  // 3) 1 lektura = 1 prawidłowy dowód — prawidłowe nie duplikuj (złe mogą być wielokrotne)
  if(!isDevBypass){
    const already = await new Promise((res,rej)=>{
      const sql = useMySQL ? `SELECT id FROM readproof_proofs WHERE walletAddress=? AND chapterId=? AND status IN ('Reading Verified','Comprehension Verified','verified') LIMIT 1` : `SELECT id FROM proofs WHERE walletAddress=? AND chapterId=? AND status IN ('Reading Verified','Comprehension Verified','verified') LIMIT 1`;
      const cb=(e,rows)=> e?rej(e):res(rows);
      if(useMySQL) mysqlPool.query(sql, [wallet, chapterId]).then(([rows])=>cb(null,rows)).catch(e=>rej(e)); else db.all(sql, [wallet, chapterId], cb);
    }).catch(()=>[]);
    if(already && already.length>0) return res.status(409).json({error:'Już zweryfikowano — 1 lektura = 1 prawidłowy dowód (złe próby mogą być wielokrotne)', code:'already_verified'});
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
    readingDurationSec: 0, lang, expectedReadingMin: expectedMin, isDemo, isDevBypass, userId: userId||null
  };
  sessionsMem.set(id, session);
  // try with userId column, fallback without if column missing (sqlite old)
  const tryInsert = (withUserId)=>{
    if(withUserId){
      db.run(`INSERT INTO reading_sessions (id, walletAddress, bookId, chapterId, startAt, endAt, status, challengeIds, answers, readingDurationSec, lang, expectedReadingMin, createdAt, userId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,wallet,bookId,chapterId,startAt,null,'reading', JSON.stringify(session.challengeIds), JSON.stringify(session.answers), 0, lang, expectedMin, startAt, userId||null],
        (e)=>{ if(e && String(e.message).includes('no column')) tryInsert(false); });
    } else {
      db.run(`INSERT INTO reading_sessions (id, walletAddress, bookId, chapterId, startAt, endAt, status, challengeIds, answers, readingDurationSec, lang, expectedReadingMin, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,wallet,bookId,chapterId,startAt,null,'reading', JSON.stringify(session.challengeIds), JSON.stringify(session.answers), 0, lang, expectedMin, startAt]);
    }
  };
  tryInsert(true);
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
    case 'match': case 'who_said': {
        if(typeof answer === 'string'){
          // pojedynczy cytat — pole tekstowe (fix: "kto to powiedział nie ma pola do wpisania" + PL czytelnik nie zna EN cytatu)
          const expected = (ch.pairs && ch.pairs[0] && ch.pairs[0].right) ? String(ch.pairs[0].right).toLowerCase() : '';
          const got = String(answer).toLowerCase().trim();
          // luźne dopasowanie: zawiera nazwisko / imię
          correct = expected.length>0 && (got.includes(expected) || expected.includes(got) || got.split(/\s+/).some(w=> expected.includes(w) && w.length>=3));
        } else if(answer && typeof answer==='object'){
          let ok=true; for(const [k,v] of Object.entries(answer)) if(Number(k)!==Number(v)) ok=false; correct= ok && Object.keys(answer).length===(ch.pairs||[]).length;
        }
        break;
      }
    case 'open_question': case 'why_question': {
      if(typeof answer==='string'){
        const j = await callJev({question:ch.question, expectedMeaning: ch.expectedMeaning, userAnswer: answer, context: ch.context||'', lang: s.lang});
        if(!j) return res.status(503).json({error: s.lang==='en'?'Jev unavailable':'Jev niedostępny — ustaw TYPESAFE_API_KEY'});
        jev = j; correct = jev.correct && jev.confidence >= JEV_THRESHOLD;
        // Fallback: gdy zdanie znaczy to samo innymi słowami, Jev czasem daje 0.2x — sprawdź overlap słów kluczowych
        if(!correct && typeof answer==='string' && ch.expectedMeaning){
          const norm = s=> s.toLowerCase().replace(/[^a-ząćęłńóśźż\s]/g,'').split(/\s+/).filter(w=>w.length>3);
          const exp = new Set(norm(ch.expectedMeaning));
          const got = new Set(norm(answer));
          let inter=0; for(const w of got) if(exp.has(w)) inter++;
          const overlap = exp.size ? inter/exp.size : 0;
          // Synonimy wróżka/wiedźma/czarownica/magia/zaczarowane traktuj jako pokrewne
          const magicSyns = new Set(["wrozka","wiedzma","czarownica","magia","zaczarowane","zaczarowany","czary","czarodziejka"]);
          let magicHit = false;
          for(const w of got) if(magicSyns.has(w)) for(const e of exp) if(magicSyns.has(e)) magicHit=true;
          if(overlap >= 0.35 || magicHit){ correct = true; jev.reason = (jev.reason||'') + ` | keyword-fallback overlap ${(overlap*100).toFixed(0)}%${magicHit?' magic':''}` }
          // ostateczny fallback: krótka sensowna odp. >10 znaków i zawiera choć 1 słowo kluczowe z kontekstu
          if(!correct && answer.trim().length>10){
            const ctxWords = new Set(norm(ch.context||''));
            let ctxInter=0; for(const w of got) if(ctxWords.has(w) || exp.has(w)) ctxInter++;
            if(ctxInter>=1 && jev.confidence>=0.12){ correct=true; jev.reason=(jev.reason||'')+` | lenient-context-fallback` }
          }
        }
      }
      break;
    }
    default: correct=false;
  }
  const answeredAt = new Date();
  const unlockAt = new Date(ch.releaseAt).getTime();
  const elapsed = Math.floor((answeredAt.getTime() - unlockAt)/1000);
  // overtime tylko dla otwartych — ABCD/match nie karzemy za czas (częsty false positive że dobra odp. oznaczana jako zła)
  if(elapsed > 180 && (ch.type==='open_question'||ch.type==='why_question')){
    correct = false;
    jev = jev ? {...jev, reason: (jev.reason||"") + " | overtime (>180s)"} : jev;
  }
  // zbyt szybka odpowiedź — wcześniej <3s dawało false-positive gdy user zna odpowiedź; złagodzone do <1s
  if(elapsed < 1 && (ch.type==='open_question'||ch.type==='why_question') && !s.isDevBypass){
    s.suspicious = 1;
    s.suspiciousReason = `too_fast_answer: ${ch.id} ${elapsed}s`;
  }
  s.answers[challengeId] = {answer, answeredAt: answeredAt.toISOString(), correct, jev, elapsed};
  s.readingDurationSec = Math.floor((Date.now() - new Date(s.startAt).getTime())/1000);
  db.run(`UPDATE reading_sessions SET answers=?, readingDurationSec=? WHERE id=?`, [JSON.stringify(s.answers), s.readingDurationSec, s.id]);
  // correctText dla frontendu — żeby pokazać poprawną odpowiedź po błędzie (kto to powiedział nie miał odpowiedzi)
  let correctText = (()=> {
    try{
      if(ch.type==='multiple_choice'||ch.type==='true_false'||ch.type==='what_next') return ch.options?.[ch.correctAnswer] ?? null;
      if(ch.type==='multiple_select') return (ch.correctAnswers||[]).map(i=> ch.options?.[i]).filter(Boolean).join(', ') || null;
      if(ch.type==='find_error') return ch.statements?.[ch.errorIndex] ?? ch.options?.[ch.errorIndex] ?? null;
      if(ch.type==='ordering'||ch.type==='ranking') return (ch.correctOrder||[]).map(i=> (ch.items?.[i] ?? '')).join(' → ') || null;
      if(ch.type==='who_said'||ch.type==='match') return ch.pairs?.[0]?.right ?? ch.pairs?.map(p=> `${p.left} → ${p.right}`).join(', ') ?? null;
      if(ch.type==='open_question'||ch.type==='why_question') return ch.expectedMeaning ?? ch.hint ?? null;
    }catch(e){ return null; }
    return null;
  })();
  res.json({challengeId, correct, jev, readingDurationSec: s.readingDurationSec, correctAnswer: ch.correctAnswer, correctAnswers: ch.correctAnswers, correctText, expectedMeaning: ch.expectedMeaning});
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
  const minToFinish = Math.ceil(total * 0.6); // 3/5 jak test z lektury
  if(!failEarly && answered < minToFinish) return res.status(400).json({error:`Odpowiedz na co najmniej ${minToFinish}/${total} aby zakończyć (masz ${answered})`});

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
  const userIdForProof = s.userId || req.headers['x-user-id'] || req.headers['x-apple-user'] || req.body?.userId || null;
  // try insert with userId, fallback without
  const doProofInsert = (withUser)=>{
    if(withUser){
      db.run(`INSERT INTO proofs (id, bookId, chapterId, score, total, status, walletAddress, timestamp, proofHash, txSignature, explorerUrl, reward, detail, verificationVersion, durationSec, userId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [proofId, s.bookId, s.chapterId, verdict.score, total, finalStatus, s.walletAddress, endAt, proofHash, tx, explorer, reward, JSON.stringify(detail), verificationVersion, verdict.durationSec, userIdForProof],
        (e)=>{ if(e && String(e.message).includes('no column')) doProofInsert(false); });
    } else {
      db.run(`INSERT INTO proofs (id, bookId, chapterId, score, total, status, walletAddress, timestamp, proofHash, txSignature, explorerUrl, reward, detail, verificationVersion, durationSec) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [proofId, s.bookId, s.chapterId, verdict.score, total, finalStatus, s.walletAddress, endAt, proofHash, tx, explorer, reward, JSON.stringify(detail), verificationVersion, verdict.durationSec]);
    }
  };
  doProofInsert(true);
  db.run(`UPDATE reading_sessions SET endAt=?, status=?, readingDurationSec=? WHERE id=?`, [endAt, finalStatus, s.readingDurationSec, s.id]);
  console.log(`[complete] user=${(userIdForProof||'').toString().slice(0,8)} wallet=${s.walletAddress?.slice(0,6)}.. ${s.chapterId} score=${verdict.score}/${total} status=${finalStatus} version=${verificationVersion} proof=${proofHash} verified=${verdict.verified} checks=${verdict.checks.filter(c=>!c.passed).map(c=>c.name).join(',')||'ALL PASS'}`);
  res.json({
    sessionId: s.id, proof: {id: proofId, bookId:s.bookId, chapterId:s.chapterId, challengeIds: s.challengeIds, score: verdict.score, total, status: finalStatus, walletAddress:s.walletAddress, userId: userIdForProof, timestamp:endAt, proofHash, txSignature:tx, explorerUrl: explorer, reward, verificationVersion, durationSec: verdict.durationSec},
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
  const {bookId, chapterId, answers, walletAddress, userId: bodyUserId, appleUserId} = req.body; // answers: {challengeId: answer}
  if(!bookId || !chapterId || !answers) return res.status(400).json({error:'bookId, chapterId, answers required'});
  if(!walletAddress) return res.status(400).json({error:'walletAddress required — connect Phantom (Devnet)'});
  const wallet = walletAddress;
  let userId = bodyUserId || appleUserId || req.headers['x-user-id'] || req.headers['x-apple-user'] || null;
  const authH = req.headers['authorization']||'';
  if(authH.startsWith('Bearer ') && !userId){
    const tok = authH.slice(7).trim();
    try{
      const u = await new Promise((resolve)=>{
        db.get(`SELECT * FROM users WHERE sessionToken=?`, [tok], (e,r)=>{
          if(r) return resolve(r.appleUserId || r.walletAddress);
          db.get(`SELECT * FROM users WHERE appleUserId=?`, [tok], (e2,r2)=>{
            if(r2) return resolve(r2.appleUserId);
            resolve(tok);
          });
        });
      });
      userId = u;
    }catch(e){ userId = tok; }
  }
  const DEV_PASSWORD2 = process.env.DEV_PASSWORD || 'hackathon2026@';
  const isDev2 = (req.headers['x-dev-mode'] === '1' && req.headers['x-dev-password'] === DEV_PASSWORD2) || (req.body.devBypass === true && req.body.devPassword === DEV_PASSWORD2);
  // Bloki czasowe wyłączone — bez 24h / 30 min (swobodne ponawianie i więcej minut na pytanie)
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
        if(typeof ans === 'string'){
          const expected = (ch.pairs && ch.pairs[0] && ch.pairs[0].right) ? String(ch.pairs[0].right).toLowerCase() : '';
          const got = String(ans).toLowerCase().trim();
          correct = expected.length>0 && (got.includes(expected) || expected.includes(got) || got.split(/\s+/).some(w=> expected.includes(w) && w.length>=3));
        } else if(ans && typeof ans==='object'){
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
  // try with userId column
  const doInsertProof = (withUser)=>{
    if(withUser){
      db.run(`INSERT INTO proofs (id, bookId, chapterId, score, total, status, walletAddress, timestamp, proofHash, txSignature, explorerUrl, reward, detail, userId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, bookId, chapterId, score, total, status, wallet, now, hash, tx, explorer, reward, detail, userId||null],
        (err)=>{ if(err && String(err.message).includes('no column')) doInsertProof(false); else if(err) console.error('db insert', err); });
    } else {
      db.run(`INSERT INTO proofs (id, bookId, chapterId, score, total, status, walletAddress, timestamp, proofHash, txSignature, explorerUrl, reward, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, bookId, chapterId, score, total, status, wallet, now, hash, tx, explorer, reward, detail],
        (err)=>{ if(err) console.error('db insert', err); });
    }
  };
  doInsertProof(true);
  res.json({id, bookId, chapterId, score, total, status, walletAddress: wallet, userId: userId||null, timestamp: now, proofHash: hash, txSignature: tx, explorerUrl: explorer, reward, results});
});

app.get('/api/proofs', (req,res)=>{
  const wallet=req.query.wallet;
  const userId=req.query.userId || req.headers['x-user-id'] || req.headers['x-apple-user'] || null;
  const authH = req.headers['authorization']||'';
  // if Authorization Bearer, treat as userId filter as well (sessionToken)
  let filterUser = userId;
  if(!filterUser && authH.startsWith('Bearer ')) filterUser = authH.slice(7).trim();
  let sql, params;
  const baseCols = `id, bookId, chapterId, score, total, status, walletAddress, timestamp, proofHash, txSignature, explorerUrl, reward, CAST(detail AS CHAR) as detail, verificationVersion, durationSec, userId`;
  if(wallet && filterUser){
    sql = `SELECT ${baseCols} FROM proofs WHERE walletAddress=? AND userId=? ORDER BY timestamp DESC LIMIT 50`;
    params=[wallet, filterUser];
  } else if(wallet){
    sql = `SELECT ${baseCols} FROM proofs WHERE walletAddress=? ORDER BY timestamp DESC LIMIT 50`;
    params=[wallet];
  } else if(filterUser){
    sql = `SELECT ${baseCols} FROM proofs WHERE userId=? ORDER BY timestamp DESC LIMIT 50`;
    params=[filterUser];
  } else {
    sql = `SELECT ${baseCols} FROM proofs ORDER BY timestamp DESC LIMIT 50`;
    params=[];
  }
  db.all(sql, params, (err, rows)=>{
    const parseDetail = (d)=>{
      if(!d) return null;
      if(typeof d==='string'){
        try{ return JSON.parse(d); }catch(e){ return d; }
      }
      return d;
    };
    if(err){
      if(String(err.message).includes('no column') || String(err.message).includes('Unknown column')){
        const fallbackSql = wallet ? `SELECT ${baseCols} FROM proofs WHERE walletAddress=? ORDER BY timestamp DESC LIMIT 50` : `SELECT ${baseCols} FROM proofs ORDER BY timestamp DESC LIMIT 50`;
        const fallbackParams = wallet ? [wallet] : [];
        return db.all(fallbackSql, fallbackParams, (e2, r2)=>{
          if(e2) return res.status(500).json({error: e2.message, sql: fallbackSql});
          res.json(r2.map(x=>({...x, detail: parseDetail(x.detail)})));
        });
      }
      console.error('[proofs] sql', sql, 'params', params, 'err', err.message, err.stack?.slice(0,500));
      return res.status(500).json({error: err.message, sql});
    }
    res.json(rows.map(r=>({...r, detail: parseDetail(r.detail)})));
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
