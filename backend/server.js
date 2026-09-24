import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { execFile } from 'child_process';
import mysql from 'mysql2/promise';
import { runVerification } from './verification.js';
import { detectAIWriting, AI_DETECTOR_INFO } from './aiDetector.js';

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
const ALLOWED_ORIGINS = ['*'];
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Lang', 'X-User-Id', 'X-Apple-User', 'X-Dev-Mode', 'X-Dev-Password'],
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
// Wyczyść istniejące pule ze śmieciowych pytań LLM (placeholdery, tekstowe odpowiedzi, złe true_false)
for(const k of Object.keys(challengesByChapter||{})) challengesByChapter[k] = sanitizePool(challengesByChapter[k]);

function poolForChapter(chapterId){ return challengesByChapter[chapterId] || []; }

// Generowanie puli pytań — używane TYLKO przez warmAllPools (i ewentualnie POST /api/generate), NIGDY przy starcie sesji
async function generateChapterPool(chapter, target=10, lang='pl'){
  let pool = poolForChapter(chapter.id);
  if(pool.length >= target) return pool.length;
  try{
    const generated = await callOpenRouterGenerate(chapter, Math.min(target, 15), lang);
    pool = pool.concat(sanitizePool(generated));
    challengesByChapter[chapter.id] = pool;
    try{ fs.writeFileSync('./challenges.json', JSON.stringify({books, challengesByChapter}, null, 2)); }catch{}
    console.log(`[pool-gen] +${generated.length} → pool ${pool.length} (${chapter.id})`);
  }catch(e){ console.error(`[pool-gen] fail (${chapter.id}): ${e.message}`); }
  return pool.length;
}

function pickFive(chapterId) {
  const pool = poolForChapter(chapterId);
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
// --- Sanizytacja wygenerowanych pytań (LLM potrafi zwrócić options jako obiekty,
// correctAnswer jako tekst/literę/boolean, or puste opcje) ---
function normLow(s){ return String(s==null?'':s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''); }
function textOpt(o){
  if(o && typeof o==='object'){ o = (o.text!=null ? o.text : (o.content!=null ? o.content : (o.label!=null ? o.label : (o.name!=null ? o.name : '')))); }
  return String(o==null?'':o).trim();
}
function cleanOpt(o){
  let s = textOpt(o);
  s = s.replace(/^\s*\(\s*[a-e]\)\s*/,'').replace(/^\s*[a-e][\)\.\:]\s*/,'').replace(/^\s*\d+[\)\.\:]\s*/,'').trim();
  return s;
}
// Indeks poprawnej odpowiedzi: zwraca index lub -1 (niepoprawne/naprawialne)
function optIndex(v, opts){
  if(Array.isArray(v)){ const out=[]; for(const x of v){ const i=optIndex(x,opts); if(Number.isInteger(i)&&i>=0) out.push(i); } return out; }
  const n=Number(v);
  if(Number.isInteger(n)&&n>=0&&n<opts.length) return n;
  if(v===true) return opts.length>1?1:-1; if(v===false) return 0;
  const sv=normLow(v); if(!sv) return -1;
  const m=sv.match(/^\(?([a-e])\)?$/); if(m) return (opts.length>1&&'abcde'.indexOf(m[1])>=0)?'abcde'.indexOf(m[1]):-1;
  const ex=opts.findIndex(o=>normLow(textOpt(o))===sv); if(ex>=0) return ex;
  if(sv.length>=3){
    const ci=opts.findIndex(o=>{ const ot=normLow(textOpt(o)); return ot.length>=3 && (ot.includes(sv)||sv.includes(ot)); });
    if(ci>=0) return ci;
  }
  return -1;
}
function normalizeChallenge(c){
  if(!c||typeof c!=='object') return c;
  const n={...c};
  if(n.correct_answer!==undefined && n.correctAnswer===undefined){ n.correctAnswer=n.correct_answer; delete n.correct_answer; }
  if(n.correct_answers!==undefined && n.correctAnswers===undefined){ n.correctAnswers=n.correct_answers; delete n.correct_answers; }
  if(n.correct_order!==undefined && n.correctOrder===undefined){ n.correctOrder=n.correct_order; delete n.correct_order; }
  if(n.error_index!==undefined && n.errorIndex===undefined){ n.errorIndex=n.error_index; delete n.error_index; }
  if(n.expected_meaning!==undefined && n.expectedMeaning===undefined){ n.expectedMeaning=n.expected_meaning; delete n.expected_meaning; }
  // options/items/pairs — obiekty -> tekst + czyście przedrostki "a)", "1)"
  if(Array.isArray(n.options)) n.options=n.options.map(cleanOpt).filter(s=>s.length>0);
  if(Array.isArray(n.statements)) n.statements=n.statements.map(cleanOpt).filter(s=>s.length>0);
  if(Array.isArray(n.items)) n.items=n.items.map(cleanOpt).filter(s=>s.length>0);
  if(Array.isArray(n.pairs)) n.pairs=n.pairs.map(p=>({left:cleanOpt(p&&p.left), right:cleanOpt(p&&p.right)}));
  // true_false -> kanoniczne options ["Prawda","Fałsz"], correctAnswer=0(Prawda)/1(Fałsz)
  if(n.type==='true_false'){
    let b;
    if(typeof n.correctAnswer==='boolean') b=n.correctAnswer;
    else {
      const sv=normLow(n.correctAnswer);
      if(sv==='0'||sv==='1') b = (sv==='0'); // indeks: 0=Prawda, 1=Fałsz
      else if(['true','tak','prawda','yes','t','prawdziwe','prawdziwy','zgodne','zgodny','taki','ta','jest'].includes(sv)) b=true;
      else if(['false','nie','falsz','fałsz','no','f','n','nieprawda','nieprawdziwe','nieprawdziwy','bledne','błędne','następuje'].includes(sv)) b=false;
      else b = (Number(n.correctAnswer) !== 1); // brak dopasowania — traktuj wg indeksu (0=Prawda, 1=Fałsz)
    }
    n.options=['Prawda','Fałsz'];
    n.correctAnswer = b?0:1;
    if(!n.question || !String(n.question).trim()) n.question = 'Czy poniższe zdanie jest prawdziwe?';
  } else if(n.type==='multiple_choice'||n.type==='what_next'){
    n.correctAnswer = optIndex(n.correctAnswer, n.options||[]);
  } else if(n.type==='multiple_select'){
    n.correctAnswers = Array.isArray(n.correctAnswers) ? optIndex(n.correctAnswers, n.options||[]) : (n.correctAnswer!==undefined ? optIndex(n.correctAnswer, n.options||[]) : []);
    delete n.correctAnswer;
  } else if(n.type==='find_error'){
    n.errorIndex = n.errorIndex!==undefined ? Number(n.errorIndex) : optIndex(n.correctAnswer, n.options||[]);
  }
  if((n.type==='ordering'||n.type==='ranking') && (!n.question || !String(n.question).trim())){
    n.question='Uporządkuj w kolejności chronologicznej:';
  }
  return n;
}
// Filtrowanie puli: zostawiamy tylko poprawne, naprawialne pytania; usuwa garbage z LLM
function sanitizePool(list){
  if(!Array.isArray(list)) return [];
  const CORE=new Set(['multiple_choice','true_false','multiple_select','what_next','open_question','why_question']);
  const out=[];
  for(const raw of list){
    const n=normalizeChallenge(raw);
    if(!n||!CORE.has(n.type)||!n.question||!String(n.question).trim()) continue;
    if(n.type==='multiple_choice'||n.type==='what_next'){ if(!Array.isArray(n.options)||n.options.length<2||!Number.isInteger(n.correctAnswer)||n.correctAnswer<0||n.correctAnswer>=n.options.length) continue; }
    else if(n.type==='multiple_select'){ if(!Array.isArray(n.options)||n.options.length<2||!Array.isArray(n.correctAnswers)||!n.correctAnswers.length) continue; }
    else if(n.type==='true_false'){ /* zawsze poprawne po normalizeChallenge */ }
    else if(!n.expectedMeaning||!String(n.expectedMeaning).trim()) continue;
    out.push(n);
  }
  return out;
}
function pickForSession(chapterId, lang='pl'){
  const pool = poolForChapter(chapterId);
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
const SESSION_TIMING_DEMO = [0, 0, 0, 0, 0];
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
  const mem = { proofs: new Map(), sessions: new Map(), users: new Map(), campaigns: new Map(), funds: new Map(), waitlist: new Map() };
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
        } else if(sql.includes('FROM users') && sql.includes('sessionToken=?')){
          const row = Array.from(mem.users.values()).find(u => u.sessionToken===params[0]) || null;
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
        else if(sql.includes('FROM waitlist')) cb(null, Array.from(mem.waitlist.values()));
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
    return q.replace(/`proofs`/g,'`readproof_proofs`').replace(/`reading_sessions`/g,'`readproof_sessions`').replace(/`users`/g,'`readproof_users`').replace(/`publisher_campaigns`/g,'`readproof_campaigns`').replace(/`campaign_funds`/g,'`readproof_funds`').replace(/`waitlist`/g,'`readproof_waitlist`').replace(/`certificates`/g,'`readproof_certificates`')
            .replace(/\bproofs\b/g,'`readproof_proofs`').replace(/\breading_sessions\b/g,'`readproof_sessions`').replace(/\busers\b/g,'`readproof_users`').replace(/\bpublisher_campaigns\b/g,'`readproof_campaigns`').replace(/\bcampaign_funds\b/g,'`readproof_funds`').replace(/\bwaitlist\b/g,'`readproof_waitlist`').replace(/\bcertificates\b/g,'`readproof_certificates`')
            .replace(/`tests`/g,'`readproof_tests`').replace(/`attempts`/g,'`readproof_attempts`').replace(/`paper_tests`/g,'`readproof_paper_tests`')
            .replace(/\btests\b/g,'`readproof_tests`').replace(/\battempts\b/g,'`readproof_attempts`').replace(/\bpaper_tests\b/g,'`readproof_paper_tests`');
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
       _db.run(`CREATE TABLE IF NOT EXISTS readproof_classes (
         id TEXT PRIMARY KEY, name TEXT, bookId TEXT, chapters TEXT, teacher TEXT, students TEXT, code TEXT, createdAt TEXT, updatedAt TEXT
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
      _db.run(`CREATE TABLE IF NOT EXISTS certificates (
        id TEXT PRIMARY KEY,
        kind TEXT,
        bookId TEXT,
        chapterId TEXT,
        walletAddress TEXT,
        userId TEXT,
        score INTEGER,
        total INTEGER,
        status TEXT,
        certHash TEXT,
        txSignature TEXT,
        explorerUrl TEXT,
        timestamp TEXT,
        createdAt TEXT
      )`);
      _db.run(`CREATE TABLE IF NOT EXISTS waitlist (
        id TEXT PRIMARY KEY,
        email TEXT,
        role TEXT,
        name TEXT,
        createdAt TEXT
      )`);
      _db.run(`CREATE TABLE IF NOT EXISTS tests (
        id TEXT PRIMARY KEY,
        teacherId TEXT, bookId TEXT, title TEXT, chapter TEXT,
        testMode TEXT, status TEXT,
        timerEnabled INTEGER DEFAULT 0, timerMinutes INTEGER DEFAULT 0,
        questions TEXT, settings TEXT,
        createdAt TEXT, updatedAt TEXT
      )`);
      _db.run(`CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        challengeId TEXT, studentId TEXT, mode TEXT, status TEXT,
        answers TEXT, score INTEGER, maxScore INTEGER,
        submittedAt TEXT, completedAt TEXT, detail TEXT,
        paperTestId TEXT, virtualAttemptId TEXT,
        createdAt TEXT, expiresAt TEXT, proctoring TEXT
      )`);
      _db.run(`CREATE TABLE IF NOT EXISTS paper_tests (
        id TEXT PRIMARY KEY,
        challengeId TEXT, teacherId TEXT, studentId TEXT, studentName TEXT,
        scans TEXT, ocrText TEXT, ocrAnswers TEXT, status TEXT,
        createdAt TEXT, updatedAt TEXT
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
       _db.run(`ALTER TABLE attempts ADD COLUMN expiresAt TEXT`, ()=>{});
       _db.run(`ALTER TABLE attempts ADD COLUMN proctoring TEXT`, ()=>{});
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
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_certificates (id VARCHAR(64) PRIMARY KEY, kind VARCHAR(16), bookId VARCHAR(64), chapterId VARCHAR(64), walletAddress VARCHAR(64), userId VARCHAR(64), score INT, total INT, status VARCHAR(32), certHash VARCHAR(64), txSignature VARCHAR(128), explorerUrl VARCHAR(256), timestamp DATETIME, createdAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_sessions (id VARCHAR(64) PRIMARY KEY, walletAddress VARCHAR(64), bookId VARCHAR(64), chapterId VARCHAR(64), startAt DATETIME, endAt DATETIME, status VARCHAR(32), challengeIds JSON, answers JSON, readingDurationSec INT, lang VARCHAR(8), expectedReadingMin INT, suspicious TINYINT DEFAULT 0, suspiciousReason VARCHAR(256), createdAt DATETIME, userId VARCHAR(64))`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_books (id VARCHAR(64) PRIMARY KEY, data JSON)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_challenges (chapterId VARCHAR(64) PRIMARY KEY, data JSON)`);
await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_users (walletAddress VARCHAR(64) PRIMARY KEY, displayName VARCHAR(128), email VARCHAR(128), role VARCHAR(32) DEFAULT 'reader', createdAt DATETIME, lastLoginAt DATETIME, appleUserId VARCHAR(64), sessionToken VARCHAR(128), provider VARCHAR(16), nickname VARCHAR(128))`);
       await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_classes (id VARCHAR(64) PRIMARY KEY, name VARCHAR(256), bookId VARCHAR(64), chapters JSON, teacher VARCHAR(64), students JSON, code VARCHAR(10), createdAt DATETIME, updatedAt DATETIME)`);
       await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_campaigns (id VARCHAR(64) PRIMARY KEY, publisherWallet VARCHAR(64), title VARCHAR(256), author VARCHAR(256), isbn VARCHAR(32), description TEXT, rewardPool DOUBLE DEFAULT 0, rewardPerProof DOUBLE DEFAULT 5, currency VARCHAR(16) DEFAULT 'USDC', status VARCHAR(32) DEFAULT 'draft', bookContentHash VARCHAR(64), contentLength INT DEFAULT 0, coverUrl VARCHAR(512), createdAt DATETIME, updatedAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_funds (id VARCHAR(64) PRIMARY KEY, campaignId VARCHAR(64), publisherWallet VARCHAR(64), amount DOUBLE, currency VARCHAR(16), txSignature VARCHAR(128), explorerUrl VARCHAR(256), createdAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_waitlist (id VARCHAR(64) PRIMARY KEY, email VARCHAR(256), role VARCHAR(32), name VARCHAR(128), createdAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_tests (id VARCHAR(64) PRIMARY KEY, teacherId VARCHAR(64), bookId VARCHAR(64), title VARCHAR(256), chapter VARCHAR(64), testMode VARCHAR(16), status VARCHAR(32), timerEnabled TINYINT DEFAULT 0, timerMinutes INT DEFAULT 0, questions JSON, settings JSON, createdAt DATETIME, updatedAt DATETIME)`);
       await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_attempts (id VARCHAR(64) PRIMARY KEY, challengeId VARCHAR(64), studentId VARCHAR(64), mode VARCHAR(16), status VARCHAR(32), answers JSON, score INT, maxScore INT, submittedAt DATETIME, completedAt DATETIME, detail JSON, paperTestId VARCHAR(64), virtualAttemptId VARCHAR(64), createdAt DATETIME, expiresAt DATETIME, proctoring JSON)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_paper_tests (id VARCHAR(64) PRIMARY KEY, challengeId VARCHAR(64), teacherId VARCHAR(64), studentId VARCHAR(64), studentName VARCHAR(128), scans JSON, ocrText LONGTEXT, ocrAnswers JSON, status VARCHAR(32), createdAt DATETIME, updatedAt DATETIME)`);
      // Apple auth migrations — add columns if missing (MySQL IF NOT EXISTS via try/catch)
      for(const q of [
        `ALTER TABLE readproof_users ADD COLUMN appleUserId VARCHAR(64)`,
        `ALTER TABLE readproof_users ADD COLUMN sessionToken VARCHAR(128)`,
        `ALTER TABLE readproof_users ADD COLUMN provider VARCHAR(16)`,
        `ALTER TABLE readproof_users ADD COLUMN nickname VARCHAR(128)`,
        `ALTER TABLE readproof_sessions ADD COLUMN userId VARCHAR(64)`,
        `ALTER TABLE readproof_proofs ADD COLUMN userId VARCHAR(64)`,
        `ALTER TABLE readproof_attempts ADD COLUMN expiresAt DATETIME`,
        `ALTER TABLE readproof_attempts ADD COLUMN proctoring JSON`
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
const VERIF_STATUSES = new Set(['Reading Verified','Comprehension Verified','Verified','verified']);
const CERT_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez I,O,0,1 — czytelne ID
function certId(){
  let s=''; const rb=crypto.randomBytes(6);
  for(const b of rb) s += CERT_ALPHA[b % CERT_ALPHA.length];
  return `RP-${s.slice(0,6)}`;
}
function bookCertsForWallet(db, wallet, cb){
  db.all(`SELECT * FROM certificates WHERE walletAddress=? AND kind='book' ORDER BY timestamp DESC`, [wallet], (e,rows)=>cb(e, rows||[]));
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

// Lista darmowych modeli z fallbackiem (free tier bywa 429/404) — OPENROUTER_MODELS przez przecinek
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS || `${OPENROUTER_MODEL},openrouter/free,inclusionai/ling-3.0-flash-vl:free,nex-agi/nex-n2.5-mini:free`)
  .split(',').map(s=>s.trim()).filter(Boolean);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || '';
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';
const anyLLM = ()=> !!(OPENROUTER_KEY||GEMINI_API_KEY||GROQ_API_KEY||MISTRAL_API_KEY);

async function callOpenRouter(model, messages, {temperature, maxTokens, timeout}){
  const res=await fetch('https://openrouter.ai/api/v1/chat/completions',{
    method:'POST',
    headers:{'Authorization':`Bearer ${OPENROUTER_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://readproof.app'},
    body: JSON.stringify({model, messages, temperature, max_tokens:maxTokens}),
    signal: AbortSignal.timeout(timeout)
  });
  if(!res.ok) throw new Error(`OpenRouter ${model} error ${res.status}`);
  const j=await res.json();
  const content=j.choices?.[0]?.message?.content;
  if(!content) throw new Error(`Brak content od LLM (${model})`);
  return content;
}
async function callGemini(messages, {temperature, maxTokens, timeout}){
  const text = messages.map(m=>`${m.role==='user'?'Użytkownik':'System'}:\n${m.content}`).join('\n\n');
  const res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({contents:[{role:'user', parts:[{text}]}], generationConfig:{temperature, maxOutputTokens:maxTokens}}),
    signal: AbortSignal.timeout(timeout)
  });
  const raw=await res.text().catch(()=>'');
  if(!res.ok) throw new Error(`Gemini ${res.status}: ${String(raw).slice(0,160)}`);
  const j=JSON.parse(raw||'{}');
  const content=(j.candidates?.[0]?.content?.parts||[]).map(p=>p.text||'').join('');
  if(!content) throw new Error('Gemini: brak content');
  return content;
}
async function callOpenAiCompat({base, apiKey, model}, messages, {temperature, maxTokens, timeout}){
  const res=await fetch(base,{
    method:'POST',
    headers: apiKey ? {'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'} : {'Content-Type':'application/json'},
    body: JSON.stringify({model, messages, temperature, max_tokens:maxTokens, referrer:'https://readproof.app'}),
    signal: AbortSignal.timeout(timeout)
  });
  const raw=await res.text().catch(()=>'');
  if(!res.ok) throw new Error(`LLM ${res.status}: ${String(raw).slice(0,160)}`);
  const j=JSON.parse(raw||'{}');
  const content=j.choices?.[0]?.message?.content;
  if(!content){
    if(!apiKey) console.log(`[poll] 200 bez content (raw ${raw.length}B): ${String(raw).slice(0,220)}`);
    throw new Error('LLM: brak content');
  }
  if(!apiKey) console.log(`[poll] OK content ${String(content).length}B (raw ${raw.length}B)`);
  return content;
}

// Multi-provider LLM: OpenRouter (free) → Gemini → Groq → Mistral → Pollinations (bez klucza)
async function llmChat(messages, {temperature=0.7, maxTokens=4000, timeout=120000}={}){
  if(!OPENROUTER_KEY && !GEMINI_API_KEY && !GROQ_API_KEY && !MISTRAL_API_KEY){
    // brak jakiegokolwiek klucza — Pollinations i tak działa bez klucza
  }
  const tryers = [
    ...(OPENROUTER_KEY?OPENROUTER_MODELS.map(model=>()=>callOpenRouter(model, messages, {temperature, maxTokens, timeout})):[]),
    ...(GEMINI_API_KEY?[()=>callGemini(messages,{temperature, maxTokens, timeout})]:[]),
    ...(GROQ_API_KEY?[()=>callOpenAiCompat({base:'https://api.groq.com/openai/v1/chat/completions', apiKey:GROQ_API_KEY, model:GROQ_MODEL}, messages,{temperature, maxTokens, timeout})]:[]),
    ...(MISTRAL_API_KEY?[()=>callOpenAiCompat({base:'https://api.mistral.ai/v1/chat/completions', apiKey:MISTRAL_API_KEY, model:MISTRAL_MODEL}, messages,{temperature, maxTokens, timeout})]:[]),
    ()=>callOpenAiCompat({base:'https://text.pollinations.ai/openai', apiKey:'', model:'openai'}, messages,{temperature, maxTokens, timeout:Math.min(timeout,60000)})
  ];
  let lastErr=null;
  for(const fn of tryers){
    try{ const content=await fn(); if(content) return content; lastErr=new Error('pusty content'); }
    catch(e){ lastErr=e; console.warn('[llm] fail:', String(e.message).slice(0,110)); }
  }
  throw lastErr || new Error('LLM: brak wyników');
}

async function callOpenRouterGenerate(chapter, count=10, lang='pl'){
  const targetLang = lang==='en' ? 'ENGLISH' : 'POLISH';
  let frag = chapterFragment(chapter);
  if(frag.length < 1500){
    const book = books.find(b=>b.id===chapter.bookId);
    const sib = book && (book.chapters||[]).find(c=>c.id!==chapter.id && Math.abs((c.index||0)-(chapter.index||0))===1);
    if(sib){
      const frag2 = chapterFragment(sib);
      if(frag2.length > 200){ frag = frag + '\n\n--- ' + (sib.title||sib.id) + ' ---\n' + frag2; }
    }
  }
  // Mocny prompt: system ma tłumaczyć/ generować w targetLang niezależnie od języka excerptu (często EN)
  const STRICT = 'IMPORTANT: Do NOT show or run long internal reasoning. Output ONLY the final JSON response, immediately, with no commentary, no markdown fences, no explanation.';
  const SCHEMA = `ALLOWED TYPES (ONLY): multiple_choice, what_next, true_false, multiple_select, open_question, why_question. FORBIDDEN: ordering, ranking, who_said, match, matching, find_error.
EXACT JSON SCHEMA (one object per challenge):
- multiple_choice: {"type":"multiple_choice","question":"Question?","options":["option A","option B","option C","option D"],"correctAnswer":0,"context":"1 sentence of background"}
- what_next: same shape as multiple_choice (what happens next in the chapter).
- true_false: {"type":"true_false","question":"STATEMENT to judge, e.g. \\"Rózia cooked dinner for the family.\\"","options":["Prawda","Fałsz"],"correctAnswer":0} — correctAnswer: 0 = statement TRUE, 1 = FALSE. options MUST always be exactly ["Prawda","Fałsz"].
- multiple_select: {"type":"multiple_select","question":"Question?","options":["x","y","z","w"],"correctAnswers":[0,2]} — correctAnswers = array of INDEX NUMBERS.
- open_question / why_question: {"type":"open_question","question":"Question?","expectedMeaning":"the key words of the correct answer","context":"1 sentence of background"}
STRICT RULES:
1. correctAnswer / correctAnswers MUST be NUMBERS (option indexes). NEVER text, NEVER letters like "b" or "c".
2. options MUST be plain strings — NO "a)" / "A." / "1." prefixes, NO objects {id,text}, NO letter prefixes.
3. question MUST always be a non-empty string (for true_false too — it is the statement to judge).
4. No meaningless placeholder options (never "Opcja1" or gibberish).
5. Ask ONLY about STORY CONTENT of this chapter (who did what, where, why in the plot). NOT tiny details (colors, exact hours, texts on bottles). NEVER ask about the moral or what the tale teaches.
6. School-test level: easy-medium, fair for a student who read the chapter once carefully.
7. At least 1 open_question or why_question with expectedMeaning.
Return ONLY JSON: {"challenges":[ ... ]}`;
  const prompt = lang==='en'
  ? `${STRICT}
Generate ${count} Reading Challenges for a public-domain book chapter — like a SCHOOL READING TEST (not too detailed).
Book: ${chapter.bookId}, chapter ${chapter.index} — ${chapter.title}
Original excerpt language: often ENGLISH (Gutenberg). IMPORTANT: you MUST output ALL questions, options, expectedMeaning, statements, pairs in ENGLISH.
Context: ${chapter.contextExcerpt}
Summary: ${chapter.summary}
Source fragment (REAL full book text — base questions on it, but school-test style):
${frag}
Follow THIS strict JSON schema:
${SCHEMA}
- Question language: ENGLISH only`
  : `${STRICT}
Wygeneruj ${count} Reading Challenge dla rozdziału książki domeny publicznej — jak SZKOLNY TEST Z LEKTURY (nie za trudny, nie za szczegółowy).
Książka: ${chapter.bookId}, rozdział ${chapter.index} — ${chapter.title}
Język oryginalnego fragmentu: często ANGIELSKI (Gutenberg). WAŻNE: MUSISZ wygenerować WSZYSTKIE pytania, opcje, expectedMeaning, statements, pary w języku POLSKIM.
Kontekst: ${chapter.contextExcerpt}
Streszczenie: ${chapter.summary}
Fragment źródłowy (REALNY pełny tekst — pytania na jego podstawie, ale jak test z lektury):
${frag}
Przestrzegaj TEGO ścisłego schematu JSON:
${SCHEMA}
- Język pytań: POLSKI`;
  let lastErr=null, lastRaw='';
  const MAX_TRY = 5;
  for(let attempt=0; attempt<MAX_TRY; attempt++){
    let msg = prompt;
    if(attempt===1 && lastRaw){
      msg = `Poniżej jest próba odpowiedzi (mogła być ucięta lub zawierać błędy składni JSON). Napraw ją i zwróć TYLKO kompletny, poprawny JSON: {"challenges":[...]} z tymi samymi polami — bez komentarzy, bez wyjaśnień, bez markdowna.\n\nSTARA ODPOWIEDŹ:\n${lastRaw}`;
    }
    try{
      lastRaw = await llmChat([{role:'user',content:msg}], {temperature:0.7, maxTokens:20000, timeout:120000});
      const parsed = extractJSON(lastRaw);
      const challenges=parsed.challenges || parsed;
      if(!Array.isArray(challenges)) throw new Error('Niepoprawny JSON challenges');
      // upewnij się, że każde ma id (LLM potrafi pominąć)
      return challenges.map(c=>({...c, id: c.id && String(c.id) ? String(c.id) : crypto.randomUUID(), chapterId: chapter.id}));
    }catch(e){ lastErr=e; console.warn(`[gen] próba ${attempt+1}/${MAX_TRY} fail: ${String(e.message).slice(0,90)}`); }
  }
  throw lastErr || new Error('OpenRouter: brak modeli');
}

// Tłumaczenie wybranych pytań sesji na EN (wywoływane przy starcie sesji, gdy lang==='en').
// Struktura JSON zachowana 1:1 — indeksy/odpowiedzi bez zmian, tłumaczone tylko teksty.
const _gtxCache = new Map();
async function gtx(text){
  const k = String(text==null?'':text);
  if(!k.trim()) return k;
  if(_gtxCache.has(k)) return _gtxCache.get(k);
  await new Promise(r=>setTimeout(r, 120)); // uniknij rate-limit blokady
  const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=pl&tl=en&dt=t&q='+encodeURIComponent(k);
  const res=await fetch(url, {headers:{'User-Agent':'Mozilla/5.0 (compatible; readproof-translate/1.0)'}, signal: AbortSignal.timeout(15000)});
  if(!res.ok) throw new Error('gtx '+res.status);
  const j=await res.json();
  const seg=(Array.isArray(j)&&Array.isArray(j[0]))?j[0].map(s=>s&&s[0]).filter(Boolean).join(''):'';
  if(!seg) throw new Error('gtx empty');
  _gtxCache.set(k, seg);
  return seg;
}

async function translateChallenges(chas){
  const slim = chas.map(c=>({
    id:String(c.id||''), type:c.type,
    question:String(c.question||'').trim()||null,
    options:Array.isArray(c.options)?c.options:null,
    statements:Array.isArray(c.statements)?c.statements:null,
    items:Array.isArray(c.items)?c.items:null,
    pairs:Array.isArray(c.pairs)?c.pairs:null,
    expectedMeaning:c.expectedMeaning?String(c.expectedMeaning):null,
    context:c.context?String(c.context):null
  }));
  const tfEn = list => list.map(c=> c.type==='true_false' ? {...c, options:['True','False']} : c);
  const prompt = `Translate this quiz (a school reading test) from Polish to ENGLISH.
Keep the JSON structure EXACTLY — same fields, same indexes, same order of options/statements/items/pairs. Translate only text content (question, options, statements, items, pairs left/right, expectedMeaning, context).
Use natural English, school-test wording.
Translation target language: ENGLISH.
Proper nouns and Polish character names may stay in original form (e.g. Świteź, Dziady, Pan Tadeusz).
JSON:
${JSON.stringify(slim)}
Return ONLY the translated JSON.`;
  // Free tier bywa 429 / pełna kolejka per-IP (Pollinations max 1 queued) — długi backoff, kilka prób zamiast od razu PL
  let lastErr;
  const backs = [2500, 6000, 12000, 20000, 30000];
  for(let attempt=0; attempt<=backs.length; attempt++){
    try{
      const content = await llmChat([{role:'user',content:prompt}], {temperature:0.1, maxTokens:4000, timeout:90000});
      const parsed = extractJSON(content);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.challenges) ? parsed.challenges : null);
      if(!Array.isArray(arr)) throw new Error('Tłumaczenie: niepoprawny JSON');
      const byId = new Map(arr.map(x=>[String(x.id), x]));
      return tfEn(chas.map(c=>{ const tr = byId.get(String(c.id||'')); return tr ? {...c, ...tr} : c; }));
    }catch(e){ lastErr=e; if(attempt<backs.length){ console.warn(`[translateChallenges] próba ${attempt+1}: ${e.message} — retry za ${backs[attempt]/1000}s`); await new Promise(r=>setTimeout(r, backs[attempt])); } }
  }
  // LLM niedostępny (quota free-tier / 429) — deterministyczne tłumaczenie przez Google Translate, żeby EN zawsze działało
  try{
    const translated = [];
    for(const c of slim){
      const out = {...c, question: c.question ? await gtx(c.question) : null};
      if(Array.isArray(c.options)) out.options = await Promise.all(c.options.map(o=>gtx(o)));
      if(Array.isArray(c.statements)) out.statements = await Promise.all(c.statements.map(o=>gtx(o)));
      if(Array.isArray(c.items)) out.items = await Promise.all(c.items.map(o=>gtx(o)));
      if(Array.isArray(c.pairs)) out.pairs = await Promise.all(c.pairs.map(p=>({left: p.left?gtx(p.left):'', right: p.right?gtx(p.right):''})));
      out.expectedMeaning = c.expectedMeaning ? await gtx(c.expectedMeaning) : null;
      out.context = c.context ? await gtx(c.context) : null;
      translated.push(out);
    }
    console.log('[translateChallenges] fallback Google Translate OK');
    const byId2 = new Map(translated.map(x=>[String(x.id), x]));
    return tfEn(chas.map(c=>{ const tr = byId2.get(String(c.id||'')); return tr ? {...c, ...tr} : c; }));
  }catch(e2){ console.warn('[translateChallenges] Google fallback fail: '+e2.message); }
  throw lastErr || new Error('translateChallenges: brak prób');
}

async function verifyChallenges(challenges, chapter, lang='pl'){
  if(!Array.isArray(challenges) || challenges.length < 5) return challenges;
  try{
    const frag = chapterFragment(chapter).slice(0, 3000);
    const prompt = lang==='en'
      ? `Verify these ${challenges.length} reading comprehension questions for chapter "${chapter.title}" (book ${chapter.bookId}). Context fragment:\n${frag}\n\nChallenges JSON:\n${JSON.stringify(challenges).slice(0, 8000)}\n\nReturn ONLY JSON: {"validIds": ["id1", "id2", ...]} — include only IDs where question, options (if any) and correct answer/expectedMeaning are factually correct in context of the story and ask about plot content (not moral), are answerable from the fragment/context, and have no hallucinations. Be lenient but filter obvious hallucinations.`
      : `Zweryfikuj ${challenges.length} pytań ze zrozumienia dla rozdziału "${chapter.title}" (książka ${chapter.bookId}). Fragment:\n${frag}\n\nPytania JSON:\n${JSON.stringify(challenges).slice(0, 8000)}\n\nZwróć TYLKO JSON: {"validIds": ["id1", "id2", ...]} — uwzględnij tylko ID gdzie pytanie, opcje (jeśli są) i poprawna odpowiedź/expectedMeaning są faktycznie poprawne w kontekście historii, pytają o treść fabuły (nie morał), są odpowiedzalne z fragmentu/kontekstu i nie mają halucynacji. Bądź łagodny, filtruj tylko oczywiste halucynacje.`;
    const content = await llmChat([{role:'user', content: prompt}], {temperature:0.2, maxTokens:2000, timeout:60000});
    const parsed = extractJSON(content);
    const validIds = new Set((parsed.validIds || parsed.valid || []).map(String));
    if(validIds.size < 5) return challenges; // too strict — fallback to all
    const filtered = challenges.filter(c=> validIds.has(String(c.id)));
    return filtered.length >= 5 ? filtered : challenges;
  }catch(e){
    console.warn(`[verifyChallenges] skip: ${e.message}`);
    return challenges;
  }
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
app.get('/health', (req,res)=>res.json({status:'ok', service:'readproof-backend', port:PORT, books: books.length, chapters: books.reduce((a,b)=>a+b.chapters.length,0), openRouter: anyLLM(), llm: {openrouter: !!OPENROUTER_KEY, gemini: !!GEMINI_API_KEY, groq: !!GROQ_API_KEY, mistral: !!MISTRAL_API_KEY}, model: OPENROUTER_MODEL, jevThreshold:JEV_THRESHOLD, jevTypesafe: !!TYPESAFE_API_KEY, lang: langOf(req), sessions: sessionsMem.size, privacy: PRIVACY_SHORT, cors: ALLOWED_ORIGINS, cluster:'devnet', publisher: { campaigns: 'GET /api/publisher/campaigns', users: 'GET /api/users' }}));
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

// ===== CLASSES API =====
const classesMem = new Map();

function normalizeClassCode(value){ return String(value||'').trim().toUpperCase().replace(/^KLA-/, ''); }
function persistClass(cls){
  const values = [cls.id, cls.name, cls.bookId, JSON.stringify(cls.chapters||[]), cls.teacher, JSON.stringify(cls.students||[]), cls.id, cls.createdAt, cls.updatedAt||cls.createdAt];
  if(useMySQL) db.run(`INSERT INTO readproof_classes (id, name, bookId, chapters, teacher, students, code, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name), bookId=VALUES(bookId), chapters=VALUES(chapters), teacher=VALUES(teacher), students=VALUES(students), code=VALUES(code), updatedAt=VALUES(updatedAt)`, values, ()=>{});
  else db.run(`INSERT OR REPLACE INTO readproof_classes (id, name, bookId, chapters, teacher, students, code, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)`, values, ()=>{});
}
function loadClassesFromDb(){
  db.all(`SELECT * FROM readproof_classes`, [], (err,rows)=>{
    if(err) return;
    for(const r of rows){
      try{
        const c = { ...r, students: JSON.parse(r.students||'[]'), chapters: JSON.parse(r.chapters||'[]') };
        classesMem.set(c.id, c);
      }catch(e){}
    }
    console.log(`[classes] loaded ${classesMem.size} classes`);
  });
}
setTimeout(loadClassesFromDb, useMySQL ? 2500 : 0);

app.post('/api/classes', (req,res)=>{
  const {name, bookId, chapters, teacher} = req.body;
  if(!teacher || !name) return res.status(400).json({error:'name and teacher required'});
  const code = crypto.randomUUID?.() ? crypto.randomUUID().slice(0,6).toUpperCase() : Math.random().toString(36).slice(2,8).toUpperCase();
  const cls = {id: code, code, name, bookId, chapters: chapters||[], teacher, students: [], createdAt: new Date().toISOString()};
  classesMem.set(code, cls);
  persistClass(cls);
  res.json({ok:true, class: cls});
});

app.get('/api/classes', (req,res)=>{
  const teacher = req.query.teacher;
  if(!teacher) return res.status(400).json({error:'teacher walletAddress required'});
  const classes = Array.from(classesMem.values()).filter(c => c.teacher === teacher);
  res.json({ok:true, classes});
});

app.post('/api/classes/:code/join', (req,res)=>{
  const code = normalizeClassCode(req.params.code);
  const cls = classesMem.get(code);
  if(!cls) return res.status(404).json({error:'class not found'});
  const {walletAddress, displayName} = req.body;
  if(!walletAddress) return res.status(400).json({error:'walletAddress required'});
  const existing = cls.students.find(s => s.walletAddress === walletAddress);
  if(existing) return res.json({ok:true, student: existing, note:'already joined'});
  const student = {walletAddress, displayName: displayName||'', joined: new Date().toISOString(), name: displayName||''};
  if(!cls.students) cls.students = [];
  cls.students.push(student);
  cls.updatedAt = new Date().toISOString();
  persistClass(cls);
  res.json({ok:true, student});
});

app.get('/api/classes/:code/students', (req,res)=>{
  const code = normalizeClassCode(req.params.code);
  const cls = classesMem.get(code);
  if(!cls) return res.status(404).json({error:'class not found'});
  res.json({ok:true, students: cls.students||[]});
});

app.get('/api/classes/:code', (req,res)=>{
  const code = normalizeClassCode(req.params.code);
  const cls = classesMem.get(code);
  if(!cls) return res.status(404).json({error:'class not found'});
  res.json({ok:true, class: cls});
});

app.delete('/api/classes/:code', (req,res)=>{
  const {teacher} = req.query;
  const code = normalizeClassCode(req.params.code);
  const cls = classesMem.get(code);
  if(!cls) return res.status(404).json({error:'class not found'});
  if(cls.teacher !== teacher) return res.status(403).json({error:'not your class'});
  classesMem.delete(code);
  try{ db.run(`DELETE FROM readproof_classes WHERE id=?`, [code], ()=>{}); }catch(e){}
  res.json({ok:true, deleted:code});
});

app.post('/api/classes/:code/leave', (req,res)=>{
  const code = normalizeClassCode(req.params.code);
  const cls = classesMem.get(code);
  if(!cls) return res.status(404).json({error:'class not found'});
  const {walletAddress} = req.body;
  if(!walletAddress) return res.status(400).json({error:'walletAddress required'});
  cls.students = (cls.students||[]).filter(s => s.walletAddress !== walletAddress);
  cls.updatedAt = new Date().toISOString();
  persistClass(cls);
  res.json({ok:true});
});

// ===== WAITLIST API — teachers & students coming soon =====
const waitlistMem = new Map(); // email(lower) -> row
const waitlistIp = new Map();  // ip|yyyy-mm-dd -> count
const WAITLIST_MAX_PER_IP = 10;
const WAITLIST_ROLES = ['teacher','student'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// load existing entries at boot (best effort — memory is source of truth for dedup)
db.all(`SELECT * FROM waitlist ORDER BY createdAt ASC`, [], (err, rows)=>{
  if(!err && Array.isArray(rows)){
    for(const r of rows){
      if(r && r.email) waitlistMem.set(String(r.email).toLowerCase(), r);
    }
    console.log(`[waitlist] loaded ${waitlistMem.size} entries`);
  }
});

function saveWaitlistEntry(row, cb){
  db.run(`INSERT INTO waitlist (id, email, role, name, createdAt) VALUES (?,?,?,?,?)`,
    [row.id, row.email, row.role, row.name||null, row.createdAt],
    (e)=>{ if(e) console.warn('[waitlist] persist failed (memory keeps it):', e.message); if(cb) cb(); });
}

function waitlistIpKey(req){
  const fwd = String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
  const ip = fwd || req.ip || req.socket?.remoteAddress || 'unknown';
  const day = new Date().toISOString().slice(0,10);
  return ip + '|' + day;
}

function waitlistCounts(){
  const counts = { total: waitlistMem.size, teacher: 0, student: 0 };
  for(const r of waitlistMem.values()){ if(counts[r.role] != null) counts[r.role]++; }
  return counts;
}

app.post('/api/waitlist', (req,res)=>{
  const {email, role, name} = req.body || {};
  // honeypot — bots fill hidden fields; silently accept but never store
  if(req.body && req.body.website) return res.json({ok:true, skip:true});
  const normalized = String(email||'').trim().toLowerCase();
  if(!EMAIL_RE.test(normalized)) return res.status(400).json({error:'valid email required'});
  if(!WAITLIST_ROLES.includes(role)) return res.status(400).json({error:'role must be teacher or student'});
  const cleanName = String(name||'').trim().slice(0,120);
  // rate limit per IP+day
  const key = waitlistIpKey(req);
  const n = (waitlistIp.get(key)||0) + 1;
  waitlistIp.set(key, n);
  if(n > WAITLIST_MAX_PER_IP) return res.status(429).json({error:'too many requests — try again tomorrow'});
  // dedup: already on list -> update role/name, still ok
  const existing = waitlistMem.get(normalized);
  if(existing){
    if(existing.role !== role || (cleanName && existing.name !== cleanName)){
      existing.role = role;
      if(cleanName) existing.name = cleanName;
      saveWaitlistEntry(existing);
    }
    const idx = Array.from(waitlistMem.keys()).indexOf(normalized);
    return res.json({ok:true, already:true, onWaitlist:true, position: idx+1, count: waitlistMem.size, role});
  }
  const row = {
    id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)+Date.now().toString(36),
    email: normalized, role, name: cleanName, createdAt: new Date().toISOString()
  };
  waitlistMem.set(normalized, row);
  saveWaitlistEntry(row);
  const idx = Array.from(waitlistMem.keys()).indexOf(normalized);
  res.json({ok:true, onWaitlist:true, position: idx+1, count: waitlistMem.size, role});
});

app.get('/api/waitlist/status', (req,res)=>{
  const email = String(req.query.email||'').trim().toLowerCase();
  if(!EMAIL_RE.test(email)) return res.status(400).json({error:'valid email required'});
  const row = waitlistMem.get(email);
  const idx = row ? Array.from(waitlistMem.keys()).indexOf(email) : -1;
  res.json({onWaitlist: !!row, role: row?.role||null, position: row ? idx+1 : null});
});

app.get('/api/waitlist', (req,res)=>{
  res.json({ok:true, counts: waitlistCounts()});
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

app.get('/api/me', (req,res)=>{
  const actor = reqActor(req);
  if(!actor) return res.status(401).json({error:'authorization required'});
  db.get(`SELECT walletAddress, displayName, email, role, provider FROM users WHERE walletAddress=? OR appleUserId=?`, [actor, actor], (e,r)=>{
    if(e||!r) return res.status(404).json({error:'user not found'});
    res.json({walletAddress: r.walletAddress, displayName: r.displayName, email: r.email, role: r.role || 'reader', provider: r.provider || 'unknown'});
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
      if(anyLLM()){
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
        if(anyLLM()){
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
  const lang = ['en','pl'].includes(String((req.body&&req.body.lang)||'').toLowerCase()) ? String(req.body.lang).toLowerCase() : langOf(req);
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
  const poolSzStart = poolForChapter(chapterId).length;
  if(poolSzStart < 5){
    // pula niegotowa — NIGDY nie blokuj starcia sesji generowaniem; apka pokaże „Oczekiwanie na pulę pytań"
    return res.status(503).json({error:'Oczekiwanie na pulę pytań — generowanie pytań w tle, spróbuj za chwilę', code:'pool_generating', poolCount: poolSzStart, bookId, chapterId});
  }
  let picked;
  try{ picked = pickForSession(chapterId, lang); }
  catch(e){
    console.error(`[start] fallback do puli: ${e.message}`);
    picked = pickFive(chapterId);
  }
  if(lang === 'en' && Array.isArray(picked) && picked.length){
    try{ picked = await translateChallenges(picked); }
    catch(e){ console.warn(`[start] translate (en) fail — sesja w PL: ${e.message}`); }
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
    return {...normalizeChallenge(c), locked:false};
  });
  res.json({id, walletAddress: wallet, bookId, chapterId, startAt, expectedReadingMin: expectedMin, isDemo, isDevBypass, lang, timing: isDevBypass ? SESSION_TIMING_DEV : (isDemo? SESSION_TIMING_DEMO: SESSION_TIMING_REAL), challenges: masked, poolSize: poolForChapter(chapterId).length, note: lang==='en'?'Proof of Comprehension — not proof of physical reading. Challenges unlock gradually to prevent copy-to-AI.':'Proof of Comprehension — nie dowód fizycznego czytania. Challengee odblokowują się stopniowo — nie da się wkleić wszystkich do AI.'});
  console.log(`[start] ${wallet?.slice(0,6)}.. ${bookId}/${chapterId} lang=${lang} demo=${isDemo} dev=${isDevBypass} pool=${poolForChapter(chapterId).length} session=${id.slice(0,8)}`);
});

app.get('/api/sessions/:id', (req,res)=>{
  const s = sessionsMem.get(req.params.id);
  if(!s){
    db.get(`SELECT * FROM reading_sessions WHERE id=?`, [req.params.id], (err,row)=>{
      if(err||!row) return res.status(404).json({error:'session not found'});
      // fallback from DB
      const challenges = JSON.parse(row.challengeIds||'[]').map(id=> poolForChapter(row.chapterId).find(c=>c.id===id) || {id});
      return res.json({id:row.id, walletAddress:row.walletAddress, bookId:row.bookId, chapterId:row.chapterId, startAt:row.startAt, endAt:row.endAt, status:row.status, challenges, answers: JSON.parse(row.answers||'{}')});
    });
    return;
  }
  const now = Date.now();
  const masked = s.challenges.map(c=>{
    const locked = new Date(c.releaseAt).getTime() > now;
    if(locked) return {id:c.id, type:c.type, releaseAt:c.releaseAt, releaseAfterSec:c.releaseAfterSec, locked:true, hint: s.lang==='en'?'Keep reading…':'Czytaj dalej…'};
    return {...normalizeChallenge(c), locked:false};
  });
  const readingDurationSec = Math.floor((now - new Date(s.startAt).getTime())/1000);
  res.json({...s, readingDurationSec, challenges: masked});
});

app.post('/api/sessions/:id/answer', async (req,res)=>{
  const s = sessionsMem.get(req.params.id);
  if(!s) return res.status(404).json({error:'session not found'});
  const {challengeId, answer} = req.body;
  let ch = s.challenges.find(c=>c.id===challengeId);
  if(!ch) return res.status(404).json({error:'challenge not in session'});
  ch = normalizeChallenge(ch);
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
        // Fallback: gdy odpowiedź zachowuje sens, akceptuj — nie być restrykcyjnie, ma działać w każdej książce
        if(!correct && typeof answer==='string' && ch.expectedMeaning){
          const norm = s=> s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').split(/\s+/).filter(w=>w.length>2);
          const exp = new Set(norm(ch.expectedMeaning));
          const got = new Set(norm(answer));
          let inter=0; for(const w of got) if(exp.has(w)) inter++;
          const overlap = exp.size ? inter/exp.size : 0;
          // Synonimy — miłość/kocha, wróżka/wiedźma, magia — po normalizacji
          const magicSyns = new Set(["wrozka","wiedzma","czarownica","magia","zaczarowane","zaczarowany","czary","czarodziejka","babajaga","dobra","zla","dobre","zle","kochala","kochal","kocham","kocha","kochac","kochaja","zakochana","zakochany","milosc","milosci","ukochanego","ukochanym"]);
          let magicHit = false;
          for(const w of got) if(magicSyns.has(w)) for(const e of exp) if(magicSyns.has(e)) magicHit=true;
          if(overlap >= 0.10 || magicHit){ correct = true; jev.reason = (jev.reason||'') + ` | keyword-fallback overlap ${(overlap*100).toFixed(0)}%${magicHit?' magic':''} (lenient)` }
          if(!correct && answer.trim().length>5){
            const ctxWords = new Set(norm(ch.context||''));
            let ctxInter=0; for(const w of got) if(ctxWords.has(w) || exp.has(w)) ctxInter++;
            if(ctxInter>=1 && jev.confidence>=0.05){ correct=true; jev.reason=(jev.reason||'')+` | lenient-context-fallback` }
            if(!correct && jev.confidence>=0.10 && overlap>0 && answer.trim().length>8){ correct=true; jev.reason=(jev.reason||'')+` | ultra-lenient` }
            // why-pytania: "bo ..." jako motyw — jeśli obie odpowiedzi zaczynają się od "bo" i mają >5 znaków, uznaj (bardzo łagodnie)
            const aLow = answer.trim().toLowerCase(), eLow = String(ch.expectedMeaning||'').trim().toLowerCase();
            if(!correct && ch.type==='why_question' && aLow.startsWith('bo') && eLow.startsWith('bo') && answer.trim().length>5){ correct=true; jev.reason=(jev.reason||'')+` | why-bo-fallback` }
            if(!correct && aLow.includes('koch') && eLow.includes('koch')){ correct=true; jev.reason=(jev.reason||'')+` | love-fallback` }
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
  // AI-writing sight: heurystyka lokalna (aiDetector.js, bez płatnego API, bez latencji) —
  // odpowiedź wklejona z ChatGPT/LLM blokuje sesję jak cheatowanie (screenshot/too_fast)
  let aiDetected = false;
  if((ch.type==='open_question'||ch.type==='why_question') && typeof answer==='string' && !s.isDevBypass){
    const det = detectAIWriting(answer, {context: ch.context || '', threshold: Number(process.env.AI_DETECT_THRESHOLD || 0.55)});
    if(det.suspected){
      aiDetected = true;
      correct = false;
      s.suspicious = 1;
      s.suspiciousReason = `ai_generated_answer: ${ch.id} score=${det.score} [${det.signals.slice(0,3).join(',')}]`;
      jev = jev ? {...jev, reason: (jev.reason||'') + ` | AI-sight score=${det.score}`} : jev;
      console.log(`[ai-detect] ${s.walletAddress?.slice(0,6)}.. ${ch.id.slice(0,8)} BLOCKED score=${det.score} signals=${det.signals.slice(0,3).join(',')}`);
    }
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
      if(ch.type==='open_question'||ch.type==='why_question') return ch.expectedMeaning ?? null;
    }catch(e){ return null; }
    return null;
  })();
  res.json({challengeId, correct, jev, aiDetected, readingDurationSec: s.readingDurationSec, correctAnswer: ch.correctAnswer, correctAnswers: ch.correctAnswers, correctText, expectedMeaning: ch.expectedMeaning});
  console.log(`[answer] ${s.walletAddress?.slice(0,6)}.. ${challengeId.slice(0,8)} correct=${correct} type=${ch.type} elapsed=${elapsed}s${jev?` jev=${jev.correct?1:0} conf=${(jev.confidence??0).toFixed(2)}`:''}${aiDetected?' AI-BLOCKED':''}`);
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
  const minToFinish = 1; // złagodzone: wczoraj 3/5 blokowało zakończenie gdy pytania zepsute (ordering) — teraz 1 wystarczy, weryfikacja i tak oceni
  if(!failEarly && answered < minToFinish) return res.status(400).json({error:`Odpowiedz na co najmniej ${minToFinish}/${total} aby zakończyć (masz ${answered})`});

  // ── 1. WERYFIKACJA — Verification Engine (anti-cheat, score, czas, proofHash) ──
  const endAtDate = new Date();
  const endAt = endAtDate.toISOString();
  s.endAt = endAt;
  s.readingDurationSec = Math.floor((endAtDate.getTime() - new Date(s.startAt).getTime())/1000);
  // proctoring z frontendu (liczniki zachowań) — zawyżone = oszustwo, jak w Testportal
  const prog = req.body?.proctoring || {};
  const tabSwitches = Number(prog.tabSwitches||0);
  const pastes = Number(prog.pastes||0);
  const fullscreenExits = Number(prog.fullscreenExits||0);
  const copies = Number(prog.copies||0);
  if(!s.isDevBypass && (tabSwitches >= 3 || pastes > 0 || fullscreenExits >= 3 || copies >= 8)){
    s.suspicious = 1;
    s.suspiciousReason = `proctoring: tabs=${tabSwitches} paste=${pastes} full=${fullscreenExits} copies=${copies}`;
    console.log(`[proctor] ${s.walletAddress?.slice(0,6)}.. BLOCKED ${s.suspiciousReason}`);
  }
  const verdict = runVerification(s, endAtDate); // { verified, status, score, total, durationSec, verificationVersion, proofHash, checks }

  // po weryfikacji: failEarly zawsze kończy jako Failed (błędna odpowiedź / oszustwo)
  const finalStatus = failEarly ? 'Failed' : verdict.status;
  s.status = finalStatus;

  // ── 2. ZAPIS WYNIKU — deciduj nagrodę tylko gdy weryfikacja przeszła ──
  const proofId = crypto.randomUUID();
  const proofHash = verdict.proofHash;
  const verificationVersion = verdict.verificationVersion;
  let tx=null, explorer=null, reward=null, chapterCertId=null;
  if(verdict.verified && !failEarly){
    const chapter = books.flatMap(b=>b.chapters).find(c=>c.id===s.chapterId);
    reward = chapter?.reward || '5 USDC';
    // certyfikat rozdziału (RP-XXXXXX) — ID trafia też do memo on-chain
    chapterCertId = certId();
    const real = await tryRealSolanaReward(s.walletAddress, reward, {
      sessionId: s.id, bookId: s.bookId, chapterId: s.chapterId,
      score: verdict.score, total, durationSec: verdict.durationSec,
      proofHash, timestamp: endAt, verificationVersion, certId: chapterCertId
    });
    if(real){ tx=real.signature; explorer=real.explorer; } else { tx=null; explorer=null; }
  } else {
    reward = null;
  }
  const detail = s.challenges.map(c=>{
    const ans = s.answers[c.id] || {};
    const options = Array.isArray(c.options) ? c.options : (Array.isArray(c.pairs) ? c.pairs.map(p=>p.right) : null);
    let correctAnswer = null;
    if(c.type==='multiple_select') correctAnswer = c.correctAnswers || null;
    else if(c.type==='find_error') correctAnswer = (typeof c.errorIndex==='number') ? c.errorIndex : null;
    else if(c.type==='ordering'||c.type==='ranking') correctAnswer = c.correctOrder || null;
    else if(c.type==='who_said'||c.type==='match') correctAnswer = Array.isArray(c.pairs) ? c.pairs.map(p=>Object.keys(p).map(k=>p[k]).join(' → ')).join(' | ') : null;
    else correctAnswer = (typeof c.correctAnswer==='number') ? c.correctAnswer : null;
    return {challengeId:c.id, type:c.type||'', question:c.question||null, options, yourAnswer: ans.answer ?? null, correct: !!ans.correct, correctAnswer, correctAnswers: (c.correctAnswers||null), expectedMeaning: c.expectedMeaning||null, correctText: (c.type==='open_question'||c.type==='why_question') ? (c.expectedMeaning||null) : null, jev: ans.jev || null};
  });
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
  if(chapterCertId){
    db.run(`INSERT INTO certificates (id, kind, bookId, chapterId, walletAddress, userId, score, total, status, certHash, txSignature, explorerUrl, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [chapterCertId, 'chapter', s.bookId, s.chapterId, s.walletAddress, userIdForProof, verdict.score, total, finalStatus, proofHash, tx, explorer, endAt, endAt],
      (e)=>{ if(e) console.warn(`[cert] insert fail ${chapterCertId}: ${e.message}`); });
  }
  db.run(`UPDATE reading_sessions SET endAt=?, status=?, readingDurationSec=? WHERE id=?`, [endAt, finalStatus, s.readingDurationSec, s.id]);
  console.log(`[complete] user=${(userIdForProof||'').toString().slice(0,8)} wallet=${s.walletAddress?.slice(0,6)}.. ${s.chapterId} score=${verdict.score}/${total} status=${finalStatus} version=${verificationVersion} proof=${proofHash} verified=${verdict.verified} cert=${chapterCertId||'—'} checks=${verdict.checks.filter(c=>!c.passed).map(c=>c.name).join(',')||'ALL PASS'}`);
  res.json({
    sessionId: s.id, proof: {id: proofId, bookId:s.bookId, chapterId:s.chapterId, challengeIds: s.challengeIds, score: verdict.score, total, status: finalStatus, walletAddress:s.walletAddress, userId: userIdForProof, timestamp:endAt, proofHash, txSignature:tx, explorerUrl: explorer, reward, verificationVersion, durationSec: verdict.durationSec, certId: chapterCertId},
    readingDurationSec: verdict.durationSec, startAt: s.startAt, endAt, lang: s.lang,
    verification: { verified: verdict.verified, version: verificationVersion, checks: verdict.checks },
    results: detail,
    note: s.lang==='en' ? 'Comprehension verified — not physical reading. Stored: wallet, book, chapter, session_start/end, reading_duration, proof_hash.' : 'Comprehension verified — nie fizyczne czytanie. Zapisano: wallet, book, chapter, session_start/end, reading_duration, proof_hash.'
  });
});

app.get('/api/books', (req,res)=>res.json(books.map(b=>({...b, chapters:(b.chapters||[]).map(c=>({...c, poolCount:(challengesByChapter[c.id]||[]).length}))}))
  .filter(b=>(b.chapters||[]).length>0 && (b.chapters||[]).every(c=>c.poolCount>=5))));

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
  const {question, expectedMeaning, userAnswer, context, type='open_question'} = req.body;
  const lang=langOf(req);
  if(!question || !expectedMeaning || !userAnswer) return res.status(400).json({error:'question, expectedMeaning, userAnswer required'});
  const trimmed=String(userAnswer).trim();
  if(trimmed.length<3) return res.status(400).json({error: lang==='en'?'Too short':'Za krótka odpowiedź'});
  const fromJev=await callJev({question, expectedMeaning, userAnswer:trimmed, context: context||'', lang});
  if(!fromJev) return res.status(503).json({error: lang==='en'?'Jev unavailable — set TYPESAFE_API_KEY in backend/.env':'Jev niedostępny — ustaw TYPESAFE_API_KEY w backend/.env', lang});
  // Fallbacky takie same jak w /api/proofs — nie być restrykcyjnie
  let correct = fromJev.correct && fromJev.confidence >= JEV_THRESHOLD;
  const ch = {type, question, expectedMeaning, context: context||''};
  if(!correct && typeof userAnswer==='string' && expectedMeaning){
    const norm = s=> s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').split(/\s+/).filter(w=>w.length>2);
    const exp = new Set(norm(expectedMeaning));
    const got = new Set(norm(userAnswer));
    let inter=0; for(const w of got) if(exp.has(w)) inter++;
    const overlap = exp.size ? inter/exp.size : 0;
    const magicSyns = new Set(["wrozka","wiedzma","czarownica","magia","zaczarowane","zaczarowany","czary","czarodziejka","babajaga","dobra","zla","dobre","zle","kochala","kochal","kocham","kocha","kochac","kochaja","zakochana","zakochany","milosc","milosci","ukochanego","ukochanym"]);
    let magicHit = false;
    for(const w of got) if(magicSyns.has(w)) for(const e of exp) if(magicSyns.has(e)) magicHit=true;
    if(overlap >= 0.10 || magicHit){ correct = true; fromJev.reason = (fromJev.reason||'') + ` | keyword-fallback overlap ${(overlap*100).toFixed(0)}%${magicHit?' magic':''} (lenient)` }
    if(!correct && userAnswer.trim().length>5){
      const ctxWords = new Set(norm(context||''));
      let ctxInter=0; for(const w of got) if(ctxWords.has(w) || exp.has(w)) ctxInter++;
      if(ctxInter>=1 && fromJev.confidence>=0.05){ correct=true; fromJev.reason=(fromJev.reason||'')+` | lenient-context-fallback` }
      if(!correct && fromJev.confidence>=0.10 && overlap>0 && userAnswer.trim().length>8){ correct=true; fromJev.reason=(fromJev.reason||'')+` | ultra-lenient` }
      const aLow = userAnswer.trim().toLowerCase(), eLow = String(expectedMeaning||'').trim().toLowerCase();
      if(!correct && ch.type==='why_question' && aLow.startsWith('bo') && eLow.startsWith('bo') && userAnswer.trim().length>5){ correct=true; fromJev.reason=(fromJev.reason||'')+` | why-bo-fallback` }
      if(!correct && aLow.includes('koch') && eLow.includes('koch')){ correct=true; fromJev.reason=(fromJev.reason||'')+` | love-fallback` }
    }
  }
  res.json({...fromJev, correct, source:'jev', lang});
});

// ════════════════════════════════════════════════════════════════════════
//  TEST DELIVERY MODES — VIRTUAL / PAPER / BOTH (jedno wspólne ocenianie)
//    jeden Challenge (test) + dwa sposoby rozwiązania + jeden grading pipeline
//    Answer → Grade → JEW (open) → Final Score
// ════════════════════════════════════════════════════════════════════════

const TEST_MODES = new Set(['VIRTUAL','PAPER','BOTH']);
const SECRET_KEYS_TEST = ['correctAnswer','correctAnswers','correctOrder','errorIndex','expectedMeaning','correctText'];

// ── Wspólny gating service ─────────────────────────────────────────────
// gradeAnswer(ch, answer, lang) → {correct, jev} — deterministyczny dla pytań
// zamkniętych, Jev + keyword-fallback dla otwartych. Używany przez OBA tryby.
async function gradeAnswer(ch, answer, lang='pl'){
  const q = normalizeChallenge(ch);
  let correct = false;
  let jev = null;
  switch(q.type){
    case 'multiple_choice': case 'true_false': case 'what_next':
      correct = answer === q.correctAnswer; break;
    case 'multiple_select': {
      const exp = new Set(q.correctAnswers||[]);
      const got = new Set(Array.isArray(answer) ? answer : []);
      correct = exp.size === got.size && [...exp].every(v=>got.has(v)); break;
    }
    case 'find_error': correct = answer === q.errorIndex; break;
    case 'ordering': case 'ranking':
      correct = JSON.stringify(answer) === JSON.stringify(q.correctOrder); break;
    case 'match': case 'who_said': {
      if(typeof answer === 'string'){
        const expected = (q.pairs && q.pairs[0] && q.pairs[0].right) ? String(q.pairs[0].right).toLowerCase() : '';
        const got = String(answer).toLowerCase().trim();
        correct = expected.length>0 && (got.includes(expected) || expected.includes(got) || got.split(/\s+/).some(w=> expected.includes(w) && w.length>=3));
      } else if(answer && typeof answer==='object'){
        let ok = true;
        for(const [k,v] of Object.entries(answer)) if(Number(k)!==Number(v)) ok = false;
        correct = ok && Object.keys(answer).length === (q.pairs||[]).length;
      }
      break;
    }
    case 'open_question': case 'why_question': {
      if(typeof answer === 'string' && String(answer).trim().length >= 3){
        const j = await callJev({question:q.question, expectedMeaning:q.expectedMeaning, userAnswer:String(answer), context:q.context||'', lang});
        if(j){ jev = j; correct = j.correct && j.confidence >= JEV_THRESHOLD; }
        // leniency — te same fallbacki co /api/evaluate: nie być restrykcyjnie
        if(!correct && q.expectedMeaning){
          const norm = s=> s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'').split(/\s+/).filter(w=>w.length>2);
          const exp = new Set(norm(q.expectedMeaning)); const got = new Set(norm(answer));
          let inter = 0; for(const w of got) if(exp.has(w)) inter++;
          const overlap = exp.size ? inter/exp.size : 0;
          const magicSyns = new Set(["wrozka","wiedzma","czarownica","magia","zaczarowane","zaczarowany","czary","czarodziejka","babajaga","dobra","zla","dobre","zle","kochala","kochal","kocham","kocha","kochac","kochaja","zakochana","zakochany","milosc","milosci","ukochanego","ukochanym"]);
          let magicHit = false;
          for(const w of got) if(magicSyns.has(w)) for(const e of exp) if(magicSyns.has(e)) magicHit = true;
          if(overlap >= 0.10 || magicHit){ correct = true; jev = jev ? {...jev, reason:(jev.reason||'')+` | keyword-fallback overlap ${(overlap*100).toFixed(0)}%${magicHit?' magic':''} (lenient)`} : {correct:true, confidence: overlap, reason:'keyword-fallback (lenient)'}; }
          if(!correct && String(answer).trim().length > 5){
            const ctxWords = new Set(norm(q.context||'')); let ctxInter = 0;
            for(const w of got) if(ctxWords.has(w) || exp.has(w)) ctxInter++;
            if(ctxInter>=1 && (jev?.confidence ?? 0) >= 0.05){ correct = true; jev = jev ? {...jev, reason:(jev.reason||'')+' | lenient-context-fallback'} : {correct:true, confidence:0.05, reason:'lenient-context-fallback'}; }
            if(!correct && (jev?.confidence ?? 0) >= 0.10 && overlap>0 && String(answer).trim().length > 8){ correct = true; jev = jev ? {...jev, reason:(jev.reason||'')+' | ultra-lenient'} : {correct:true, confidence:0.1, reason:'ultra-lenient'}; }
            const aLow = String(answer).trim().toLowerCase(), eLow = String(q.expectedMeaning||'').trim().toLowerCase();
            if(!correct && q.type==='why_question' && aLow.startsWith('bo') && eLow.startsWith('bo') && String(answer).trim().length > 5){ correct = true; jev = jev ? {...jev, reason:(jev.reason||'')+' | why-bo-fallback'} : {correct:true, confidence:0.1, reason:'why-bo-fallback'}; }
            if(!correct && aLow.includes('koch') && eLow.includes('koch')){ correct = true; jev = jev ? {...jev, reason:(jev.reason||'')+' | love-fallback'} : {correct:true, confidence:0.1, reason:'love-fallback'}; }
          }
        }
      }
      break;
    }
    default: correct = false;
  }
  return {correct, jev};
}

// Poprawna odpowiedź (tekstowo) — do raportu / nauczyciel review
function answerText(ch){
  const q = normalizeChallenge(ch);
  try{
    if(q.type==='multiple_choice'||q.type==='true_false'||q.type==='what_next') return q.options?.[q.correctAnswer] ?? null;
    if(q.type==='multiple_select') return (q.correctAnswers||[]).map(i=>q.options?.[i]).filter(Boolean).join(', ') || null;
    if(q.type==='find_error') return q.statements?.[q.errorIndex] ?? q.options?.[q.errorIndex] ?? null;
    if(q.type==='ordering'||q.type==='ranking') return (q.correctOrder||[]).map(i=>q.items?.[i] ?? '').join(' → ') || null;
    if(q.type==='who_said'||q.type==='match') return q.pairs?.map(p=>`${p.left} → ${p.right}`).join(' | ') || null;
    if(q.type==='open_question'||q.type==='why_question') return q.expectedMeaning ?? null;
  }catch(e){ return null; }
  return null;
}

// gradeTest(questions, answers, lang) → {score, maxScore, status, results} — wspólny pipeline
// dla ONLINE (WIRTUAL) i PAPER. Niezależnie od źródła odpowiedzi kończy tu samo.
async function gradeTest(questions, answers, lang='pl'){
  const qs = Array.isArray(questions) ? questions : [];
  const results = [];
  let score = 0;
  for(const ch of qs){
    const cid = String(ch.id||'');
    const ans = (answers && answers[cid] !== undefined) ? answers[cid] : (answers && answers[ch.id] !== undefined ? answers[ch.id] : null);
    if(ans === null || ans === undefined || (typeof ans === 'string' && !String(ans).trim())){
      results.push({challengeId: cid, type: ch.type||'', question: ch.question||null, answer: ans ?? null, correct: false, jev: null, skipped: true, correctText: answerText(ch)});
      continue;
    }
    const g = await gradeAnswer(ch, ans, lang);
    if(g.correct) score++;
    results.push({challengeId: cid, type: ch.type||'', question: ch.question||null, answer: ans, correct: !!g.correct, jev: g.jev || null, correctText: answerText(ch)});
  }
  const maxScore = qs.length;
  const pct = maxScore ? Math.round((score/maxScore)*100) : 0;
  return { score, maxScore, pct, passed: score >= Math.max(1, Math.ceil(maxScore*0.6)), status: (score >= Math.max(1, Math.ceil(maxScore*0.6))) ? 'Passed' : 'Failed', results };
}

// ── Weryfikacja pytań nauczyciela (zawsze ten sam zestaw pytań dla VIRTUAL i PAPER) ──
const TEST_TYPES = new Set(['multiple_choice','true_false','multiple_select','what_next','open_question','why_question','ordering','who_said','match','find_error']);
function sanitizeTeacherQuestion(c){
  const n = normalizeChallenge(c);
  if(!n || !TEST_TYPES.has(n.type) || !n.question || !String(n.question).trim()) return null;
  if(!n.id || !String(n.id).trim()) n.id = crypto.randomUUID();
  if(n.type==='multiple_choice'||n.type==='what_next'){ if(!Array.isArray(n.options)||n.options.length<2||!Number.isInteger(n.correctAnswer)||n.correctAnswer<0||n.correctAnswer>=n.options.length) return null; }
  else if(n.type==='multiple_select'){ if(!Array.isArray(n.options)||n.options.length<2||!Array.isArray(n.correctAnswers)||!n.correctAnswers.length) return null; }
  else if(n.type==='true_false'){ /* kanoniczne po normalizeChallenge */ }
  else if(n.type==='ordering'){ if(!Array.isArray(n.items)||n.items.length<2||!Array.isArray(n.correctOrder)||n.correctOrder.length!==n.items.length) return null; }
  else if(n.type==='who_said'||n.type==='match'){ if(!Array.isArray(n.pairs)||!n.pairs.length) return null; }
  else if(n.type==='find_error'){ if(!Number.isInteger(n.errorIndex)) return null; }
  else if(!n.expectedMeaning || !String(n.expectedMeaning).trim()) return null;
  return n;
}
function stripTestSecrets(ch){ const c = Object.assign({}, ch); SECRET_KEYS_TEST.forEach(k=>delete c[k]); return c; }

function teacherAssessmentData(bookId, requestedChapters, questions, scope){
  const book = books.find((item)=>String(item.id)===String(bookId));
  if(!book) return {error:'book not found'};
  const ids = [...new Set((questions||[]).map((question)=>String(question.chapterId||'')).filter(Boolean))];
  const chapters = Array.isArray(requestedChapters) && requestedChapters.length ? requestedChapters.map(String) : ids;
  if(scope!=='book') return {book, chapters, chapter:String(chapters[0]||''), questions};
  const expected = (book.chapters||[]).map((chapter)=>String(chapter.id));
  const missing = expected.filter((id)=>!chapters.includes(id));
  const unknown = chapters.filter((id)=>!expected.includes(id));
  if(missing.length) return {error:`missing chapters: ${missing.join(', ')}`};
  if(unknown.length) return {error:`unknown chapters: ${unknown.join(', ')}`};
  const counts = Object.fromEntries(expected.map((id)=>[id, (questions||[]).filter((question)=>String(question.chapterId||'')===id).length]));
  const invalid = expected.filter((id)=>counts[id]!==5);
  if(invalid.length) return {error:`each chapter needs exactly 5 questions: ${invalid.map((id)=>`${id} (${counts[id]})`).join(', ')}`};
  const questionIds = (questions||[]).map((question)=>String(question.id||''));
  if(questionIds.some((id)=>!id) || new Set(questionIds).size!==questionIds.length) return {error:'question ids must be unique'};
  return {book, chapters:expected, chapter:'', questions};
}

// ── Stan: tests / attempts / paper (pamięć + zapis do DB jak sessions/proofs) ──
const testsMem = new Map();
const attemptsMem = new Map();
const paperMem = new Map();
function testBookTitle(id){ const b = books.find(x=>String(x.id)===String(id)); return b ? b.title : String(id||''); }
function testChapterTitle(bookId, chapterId){ const b = books.find(x=>String(x.id)===String(bookId)); const c = b && (b.chapters||[]).find(x=>String(x.id)===String(chapterId)); return (c && (c.title||c.id)) || String(chapterId||''); }

function persistTest(t){
  const values = [t.id, t.teacherId, t.bookId, t.title, t.chapter||'', t.testMode, t.status, t.timerEnabled?1:0, t.timerMinutes||0, JSON.stringify(t.questions||[]), JSON.stringify(t.settings||{}), t.createdAt, t.updatedAt||t.createdAt];
  if(useMySQL){
    db.run(`INSERT INTO readproof_tests (id, teacherId, bookId, title, chapter, testMode, status, timerEnabled, timerMinutes, questions, settings, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE teacherId=VALUES(teacherId), bookId=VALUES(bookId), title=VALUES(title), chapter=VALUES(chapter), testMode=VALUES(testMode), status=VALUES(status), timerEnabled=VALUES(timerEnabled), timerMinutes=VALUES(timerMinutes), questions=VALUES(questions), settings=VALUES(settings), updatedAt=VALUES(updatedAt)`, values, ()=>{});
  } else {
    db.run(`INSERT OR REPLACE INTO tests (id, teacherId, bookId, title, chapter, testMode, status, timerEnabled, timerMinutes, questions, settings, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, values, ()=>{});
  }
}
function persistAttempt(a){
  const values = [a.id, a.challengeId, a.studentId, a.mode, a.status, JSON.stringify(a.answers||{}), a.score ?? null, a.maxScore ?? null, a.submittedAt||null, a.completedAt||null, JSON.stringify(a.detail||null), a.paperTestId||null, a.virtualAttemptId||null, a.createdAt, a.expiresAt||null, JSON.stringify(a.proctoring||null)];
  if(useMySQL){
    db.run(`INSERT INTO readproof_attempts (id, challengeId, studentId, mode, status, answers, score, maxScore, submittedAt, completedAt, detail, paperTestId, virtualAttemptId, createdAt, expiresAt, proctoring) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status), answers=VALUES(answers), score=VALUES(score), maxScore=VALUES(maxScore), submittedAt=VALUES(submittedAt), completedAt=VALUES(completedAt), detail=VALUES(detail), expiresAt=VALUES(expiresAt), proctoring=VALUES(proctoring)`, values, ()=>{});
  } else {
    db.run(`INSERT OR REPLACE INTO attempts (id, challengeId, studentId, mode, status, answers, score, maxScore, submittedAt, completedAt, detail, paperTestId, virtualAttemptId, createdAt, expiresAt, proctoring) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, values, ()=>{});
  }
}

function studentAttemptExpired(attempt){
  return !!(attempt?.expiresAt && Date.now() > new Date(attempt.expiresAt).getTime());
}
function studentProctoringViolation(proctoring){
  const p = proctoring || {};
  return Number(p.tabSwitches||0) >= 3 || Number(p.pastes||0) > 0 || Number(p.fullscreenExits||0) >= 3 || Number(p.copies||0) >= 8;
}
function sanitizeStudentProctoring(proctoring){
  const p = proctoring && typeof proctoring === 'object' ? proctoring : {};
  return {
    tabSwitches: Math.max(0, Math.min(100, Number(p.tabSwitches)||0)),
    pastes: Math.max(0, Math.min(100, Number(p.pastes)||0)),
    fullscreenExits: Math.max(0, Math.min(100, Number(p.fullscreenExits)||0)),
    copies: Math.max(0, Math.min(100, Number(p.copies)||0)),
    webdriver: !!p.webdriver
  };
}
function sanitizeStudentAnswers(test, answers){
  if(!answers || typeof answers !== 'object' || Array.isArray(answers)) return {error:'answers object required'};
  const questions = new Map((test.questions||[]).map(q=>[String(q.id), q]));
  const clean = {};
  for(const [rawId, rawValue] of Object.entries(answers)){
    const id = String(rawId), q = questions.get(id);
    if(!q) return {error:`answer for unknown question: ${id}`};
    const type = String(q.type||'');
    if(['multiple_choice','true_false','what_next','find_error'].includes(type)){
      const n = Number(rawValue);
      const max = Array.isArray(q.options) ? q.options.length : 4;
      if(!Number.isInteger(n) || n < 0 || n >= max) return {error:`invalid answer for ${id}`};
      clean[id] = n;
    }else if(type === 'multiple_select'){
      if(!Array.isArray(rawValue) || rawValue.some(n=>!Number.isInteger(Number(n)) || Number(n)<0 || Number(n)>=(q.options||[]).length)) return {error:`invalid answer for ${id}`};
      clean[id] = [...new Set(rawValue.map(Number))].sort((a,b)=>a-b);
    }else if(type === 'ordering' || type === 'ranking'){
      const length = (q.items||[]).length;
      if(!Array.isArray(rawValue) || rawValue.length !== length || rawValue.some(n=>!Number.isInteger(Number(n)) || Number(n)<0 || Number(n)>=length)) return {error:`invalid answer for ${id}`};
      clean[id] = rawValue.map(Number);
    }else if(type === 'open_question' || type === 'why_question' || type === 'who_said' || type === 'match'){
      if(typeof rawValue !== 'string' && (!rawValue || typeof rawValue !== 'object')) return {error:`invalid answer for ${id}`};
      if(typeof rawValue === 'string' && rawValue.length > 4000) return {error:`answer too long for ${id}`};
      clean[id] = rawValue;
    }else return {error:`unsupported question type for ${id}`};
  }
  return {answers:clean};
}

function persistPaper(p){
  const values = [p.id, p.challengeId, p.teacherId, p.studentId||null, p.studentName||'', JSON.stringify(p.scans||[]), p.ocrText||'', JSON.stringify(p.ocrAnswers||{}), p.status, p.createdAt, p.updatedAt||p.createdAt];
  if(useMySQL){
    db.run(`INSERT INTO readproof_paper_tests (id, challengeId, teacherId, studentId, studentName, scans, ocrText, ocrAnswers, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE studentId=VALUES(studentId), studentName=VALUES(studentName), scans=VALUES(scans), ocrText=VALUES(ocrText), ocrAnswers=VALUES(ocrAnswers), status=VALUES(status), updatedAt=VALUES(updatedAt)`, values, ()=>{});
  } else {
    db.run(`INSERT OR REPLACE INTO paper_tests (id, challengeId, teacherId, studentId, studentName, scans, ocrText, ocrAnswers, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, values, ()=>{});
  }
}

function dbGetPromise(sql, params=[]){ return new Promise((resolve,reject)=>db.get(sql, params, (error,row)=>error?reject(error):resolve(row))); }
function dbRunPromise(sql, params=[]){ return new Promise((resolve,reject)=>db.run(sql, params, (error)=>error?reject(error):resolve())); }
async function issueTestCertificate(attempt, test){
  if(!test || test.settings?.scope!=='book' || !attempt || attempt.status!=='graded' || !attempt.detail?.passed) return null;
  const marker = `test:${crypto.createHash('sha256').update(`${test.id}|${attempt.studentId}`).digest('hex').slice(0,32)}`;
  const existing = await dbGetPromise(`SELECT * FROM certificates WHERE kind='test' AND chapterId=? LIMIT 1`, [marker]);
  if(existing) return existing;
  const now = new Date().toISOString();
  const certHash = crypto.createHash('sha256').update(`${test.id}|${attempt.studentId}|${attempt.score}|${attempt.maxScore}|${now}`).digest('hex');
  const certificate = {
    id:`RP-${certHash.slice(0,10).toUpperCase()}`, kind:'test', bookId:test.bookId, chapterId:marker,
    walletAddress:attempt.studentId, userId:attempt.studentId, score:attempt.score, total:attempt.maxScore,
    status:'Verified', certHash, timestamp:now, createdAt:now
  };
  const values = [certificate.id, certificate.kind, certificate.bookId, certificate.chapterId, certificate.walletAddress, certificate.userId, certificate.score, certificate.total, certificate.status, certificate.certHash, certificate.timestamp, certificate.createdAt];
  if(useMySQL) await dbRunPromise(`INSERT INTO readproof_certificates (id, kind, bookId, chapterId, walletAddress, userId, score, total, status, certHash, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, values);
  else await dbRunPromise(`INSERT OR REPLACE INTO certificates (id, kind, bookId, chapterId, walletAddress, userId, score, total, status, certHash, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, values);
  return certificate;
}
function missingTable(err){ return err && /(no such table|doesn't exist|Unknown table)/i.test(String(err.message||'')); }
function loadTestsFromDb(){
  db.all(`SELECT * FROM tests`, [], (err, rows)=>{
    if(missingTable(err) && useMySQL){ return setTimeout(loadTestsFromDb, 1500); }
    if(err || !Array.isArray(rows)) return;
    for(const r of rows){
      try{
        const t = { ...r, questions: JSON.parse(r.questions||'[]')||[], settings: JSON.parse(r.settings||'{}')||{}, timerEnabled: !!r.timerEnabled };
        testsMem.set(t.id, t);
      }catch(e){}
    }
    console.log(`[tests] loaded ${testsMem.size} teacher challenges`);
  });
  db.all(`SELECT * FROM attempts`, [], (err, rows)=>{
    if(missingTable(err) && useMySQL){ return; }
    if(err || !Array.isArray(rows)) return;
    for(const r of rows){
      try{
        const a = { ...r, answers: JSON.parse(r.answers||'{}')||{}, detail: JSON.parse(r.detail||'null')||null, proctoring: JSON.parse(r.proctoring||'null')||null };
        attemptsMem.set(a.id, a);
      }catch(e){}
    }
    console.log(`[attempts] loaded ${attemptsMem.size}`);
  });
  db.all(`SELECT * FROM paper_tests`, [], (err, rows)=>{
    if(missingTable(err) && useMySQL){ return; }
    if(err || !Array.isArray(rows)) return;
    for(const r of rows){
      try{
        const p = { ...r, scans: JSON.parse(r.scans||'[]')||[], ocrAnswers: JSON.parse(r.ocrAnswers||'{}')||{} };
        paperMem.set(p.id, p);
      }catch(e){}
    }
    console.log(`[paper] loaded ${paperMem.size}`);
  });
}
setTimeout(loadTestsFromDb, useMySQL ? 2500 : 0);

// ── OCR (tesseract CLIT, gdy dostępna; inaczej graceful manual fallback) ──
let OCR_LANG = 'pol+eng';
function ensureOcrLang(){ return Promise.resolve(OCR_LANG); }
async function runOcrText(filePath){
  try{
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker(OCR_LANG);
    try{
      const result = await worker.recognize(filePath);
      return {ok:true, text:String(result?.data?.text||''), lang:OCR_LANG};
    }finally{ await worker.terminate(); }
  }catch(error){
    return {ok:false, error:String(error?.message||error).slice(0,200), text:'', engineMissing:true};
  }
}

// OCR → szkic odpowiedzi (heurystyka; teacher poprawia w OCR Review przed zatwierdzeniem)
function parseOcrAnswers(text, questions){
  const out = {};
  const clean = String(text||'').replace(/\r/g,'').replace(/[•▪●○◯]/g,'');
  const lines = clean.split('\n').map(l=>l.trim()).filter(l=>l.length>0);
  const nextQIdx = (fromI) => {
    for(let i=fromI+1;i<lines.length;i++){
      if(/^(?:Pytanie|Q|Zadanie|Task|Question)\s*\d+[/.:\s]/i.test(lines[i])) return i;
    }
    return lines.length;
  };
  for(let i=0;i<questions.length;i++){
    const q = questions[i];
    const cid = String(q.id||'');
    const startStub = String(q.question||'').replace(/\s+/g,' ').slice(0, 26);
    let regionStart = -1;
    for(let li=0; li<lines.length; li++){
      const low = lines[li].toLowerCase();
      if(startStub.length>=7 && (low.includes(startStub.toLowerCase()) || (startStub.length>=12 && lines[li+1] && lines[li+1].toLowerCase().includes(startStub.toLowerCase()) && false))){
        regionStart = li; break;
      }
    }
    if(regionStart < 0){ out[cid] = {answer: null, source:'ocr', raw:''}; continue; }
    const regionEnd = nextQIdx(regionStart);
    const region = lines.slice(regionStart, regionEnd).join('\n');
    let ans = null;
    if(q.type==='multiple_choice'||q.type==='true_false'||q.type==='what_next'){
      const m = region.match(/(?:^|\s)([A-D])(?=$|\s|[.,;:!?])/i);
      const stars = region.match(/(?:^|\s)X\s*[:=\-]?\s*([A-D])(?=$|\s|[.,;:!?])/i);
      const letter = (stars && stars[1]) || (m && m[1]);
      if(letter){
        const idx = 'ABCD'.indexOf(String(letter).toUpperCase());
        if(idx>=0 && q.options && idx < q.options.length) ans = idx;
      }
    } else if(q.type==='multiple_select'){
      const all = region.match(/([A-D])(?=$|\s|[.,;:!?])/gi) || [];
      ans = all.map(l=>'ABCD'.indexOf(l.toUpperCase())).filter(i=>i>=0 && q.options && i<q.options.length);
      if(!ans.length){ ans = null; }
    } else if(q.type==='ordering'||q.type==='ranking'){
      const pairs = [...region.matchAll(/(\d)\s*[\.\):]?\s*([A-D])/gi)].map(m=>({pos:Number(m[1])-1, idx:'ABCD'.indexOf(m[2].toUpperCase())}));
      if(pairs.length===q.items?.length && pairs.every(p=>p.idx>=0)){
        const arr = new Array(q.items.length).fill(null);
        pairs.forEach(p=>{ if(p.pos>=0 && p.pos<arr.length) arr[p.pos]=p.idx; });
        if(arr.every(v=>v!==null)) ans = arr;
      }
    } else {
      // open / who_said — tekst z regionu, po wierszu pytania (bez liter A-D)
      const drained = lines.slice(regionStart+1, regionEnd).filter(l=>!l.toLowerCase().startsWith(startStub.toLowerCase())).join(' ');
      const cleaned = String(drained||'').trim().replace(/\s+/g,' ').slice(0, 220);
      if(cleaned.length) ans = cleaned;
    }
    out[cid] = {answer: ans, source:'ocr', raw: region};
  }
  return out;
}

// ── PDF builder (bez zewnętrznych zależności — czysty tekst, wbudowana Helvetica) ──
function pdfEscape(t){ return String(t==null?'':t).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)'); }

function buildStandalonePdf(pages){
  // pages: [{lines:[{x,y,t,size,bold}]}]
  const fontFamily = {
    F1: '/Helvetica',
    F2: '/Helvetica-Bold'
  };
  const objs = [];
  const addObj = body => { objs.push(body); return objs.length; };
  const catalogNo = addObj('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesNodeNo = 2;
  const offsetOf = o => o + 1; // (dummy, real offsets computed below)
  const pageNos = [];
  const fontNoF1 = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontNoF2 = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const fontRef = { F1: fontNoF1, F2: fontNoF2 };
  const contentNos = [];
  const kids = [];
  pages.forEach((page,pi)=>{
    const stream = page.lines.map(l=>{
      const size = l.size || 11;
      const font = l.bold ? 'F2' : 'F1';
      return `BT /${font} ${size} Tf 1 0 0 1 ${(l.x||0).toFixed(2)} ${(l.y||0).toFixed(2)} Tm (${pdfEscape(l.t)}) Tj ET`;
    }).join('\n');
    const streamObj = `${stream}\n`;
    const contentNo = addObj(`<< /Length ${Buffer.byteLength(streamObj, 'utf8')} >>\nstream\n${streamObj}endstream`);
    contentNos.push(contentNo);
    const pageNo = addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontNoF1} 0 R /F2 ${fontNoF2} 0 R >> >> /Contents ${contentNo} 0 R >>`);
    pageNos.push(pageNo);
    kids.push(`${pageNo} 0 R`);
  });
  objs[pagesNodeNo-1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  const infoNo = addObj('<< /Title (ReadProof) /Producer (ReadProof) >>');
  // ── serialize with real xref offsets ──
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((body, i)=>{
    offsets.push(Buffer.byteLength(out, 'utf8'));
    out += `${i+1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(out, 'utf8');
  out += `xref\n0 ${objs.length+1}\n0000000000 65535 f \n`;
  for(let i=1;i<=objs.length;i++) out += String(offsets[i]).padStart(10,'0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length+1} /Root ${catalogNo} 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, 'utf8');
}

function buildTestPdf(test, bookTitle, chapterTitle){
  const W = 595, H = 842, M = 52, TOP = 800, BOT = 44;
  const usable = W - 2*M;
  const pages = [];
  let y = 0;
  const line = (s, opts={}) => {
    const size = opts.size || 11;
    const maxChars = Math.floor(usable / (size * 0.53));
    const words = String(s==null?'':s).split(/\s+/).filter(Boolean);
    const wrapped = [];
    let cur = '';
    for(const w of words){
      if(cur && ((cur+' '+w).trim().length > maxChars)){ wrapped.push(cur); cur = w; }
      else cur = (cur ? cur+' ' : '') + w;
    }
    if(cur || !wrapped.length) wrapped.push(cur || '');
    for(const w of wrapped){
      if(!pages.length || (y - size*1.30) < BOT){ pages.push({lines:[]}); y = TOP; }
      pages[pages.length-1].lines.push({ x: M, y, t: w, size, bold: !!opts.bold });
      y -= size*1.25;
    }
    if(opts.after) y -= opts.after;
  };
  const letters = ['A','B','C','D','E','F'];
  // ── strona 1: arkusz testu ──
  line(`${bookTitle} — ${chapterTitle}`, {size:13, bold:true});
  line(test.title || 'Test sprawdzający', {size:17, bold:true, after:8});
  line('Imię i nazwisko ucznia: ______________________________________', {size:11, after:8});
  line('Instrukcja: zaznacz poprawną odpowiedź kółkiem (A, B, C lub D). W pytaniach otwartych wpisz odpowiedź czytelnie w wyznaczonych liniach.', {size:9, after:12});
  (test.questions||[]).forEach((qRaw, qi)=>{
    const q = qRaw;
    line(`Pytanie ${qi+1}. ${String(q.question||'')}`, {size:11, bold:true, after:2});
    if(Array.isArray(q.options) && q.options.length){
      (q.options||[]).forEach((o,oi)=> line(`   ${letters[oi]||(oi+1)}.  ${String(o||'')}`, {size:10.5}));
    } else if(q.type==='ordering' && Array.isArray(q.items)){
      (q.items||[]).forEach((o,oi)=> line(`   ${oi+1}.  ${String(o||'')}`, {size:10.5}));
    } else if(Array.isArray(q.pairs) && q.pairs.length){
      (q.pairs||[]).forEach(p=> line(`   ${String(p.left||'')}  →  ${String(p.right||'')}`, {size:10.5}));
    }
    if(q.type==='open_question'||q.type==='why_question'||q.type==='who_said'){
      for(let l=0;l<4;l++) line('   ______________________________', {size:10});
    } else {
      line('   ○ A   ○ B   ○ C   ○ D', {size:10.5});
    }
    line('', {size:4, after:4});
  });
  // ── strona 2: klucz odpowiedzi (nauczyciel) ──
  pages.push({lines:[]}); y = TOP;
  line('KLUCZ ODPOWIEDZI — tylko dla nauczyciela', {size:13, bold:true, after:8});
  line(`${test.title || 'Test sprawdzający'} — ${bookTitle} — ${chapterTitle}`, {size:11, after:8});
  (test.questions||[]).forEach((qRaw, qi)=>{
    const q = qRaw;
    const correct = answerText(qRaw);
    line(`${qi+1}. ${String(q.question||'')}`, {size:11, after:1});
    line(`   → Poprawna odpowiedź: ${correct ?? '—'}`, {size:10.5, bold:true, after:4});
  });
  return buildStandalonePdf(pages);
}

// ════════════════════════════════════════════════════════════════════════
//  ENDPOINTY TESTÓW — NAUCZYCIEL (challenge / papier / wyniki)
// ════════════════════════════════════════════════════════════════════════
try{ fs.mkdirSync('./uploads', {recursive:true}); }catch(e){}

// autoryzacja jak w /api/classes: wallet w body/query/headers
function reqActor(req){ return (req.body?.teacher || req.body?.wallet || req.query.wallet || req.query.teacher || req.headers['x-user-id'] || req.headers['x-apple-user'] || req.body?.studentId || req.query.studentId || '').toString(); }

// Middleware: require teacher role
async function requireTeacher(req, res, next){
  const actor = reqActor(req);
  if(!actor) return res.status(401).json({error:'authorization required'});
  const row = await new Promise((resolve)=>{
    db.get(`SELECT * FROM users WHERE walletAddress=? OR appleUserId=?`, [actor, actor], (e,r)=>{ if(e) return resolve(null); resolve(r); });
  });
  if(!row) return res.status(403).json({error:'user not found'});
  const role = row.role || 'reader';
  if(role !== 'teacher' && role !== 'publisher') return res.status(403).json({error:'teacher access required'});
  req._role = role;
  req._user = row;
  next();
}

// Middleware: require student role
function studentActor(req){ return req._user?.walletAddress || req._user?.appleUserId || reqActor(req); }
async function requireStudent(req, res, next){
  const actor = reqActor(req);
  if(!actor) return res.status(401).json({error:'authorization required'});
  const row = await new Promise((resolve)=>{
    db.get(`SELECT * FROM users WHERE walletAddress=? OR appleUserId=?`, [actor, actor], (e,r)=>{ if(e) return resolve(null); resolve(r); });
  });
  if(!row) return res.status(403).json({error:'user not found'});
  const role = row.role || 'reader';
  if(role !== 'student' && role !== 'reader') return res.status(403).json({error:'student access required'});
  req._role = role;
  req._user = row;
  next();
}

app.use('/api/teacher', requireTeacher);
app.use('/api/student', requireStudent);

// ── Nauczyciel: tworzenie / lista / edycja / aktywacja ──
app.post('/api/teacher/challenges', (req,res)=>{
  const teacher = reqActor(req);
  const {bookId, title, chapter, chapters: requestedChapters, certificateScope='chapter', testMode, timerEnabled, timerMinutes, questions} = req.body || {};
  if(!teacher) return res.status(400).json({error:'teacher walletAddress required'});
  if(!bookId) return res.status(400).json({error:'bookId required'});
  if(!TEST_MODES.has(testMode)) return res.status(400).json({error:'testMode must be VIRTUAL, PAPER or BOTH'});
  const qs = (Array.isArray(questions) ? questions : []).map(sanitizeTeacherQuestion).filter(Boolean);
  if(!qs.length) return res.status(400).json({error:'test needs at least one question (wspólna pula: wybierz pytania z rozdziału)'});
  const scope = certificateScope === 'book' ? 'book' : 'chapter';
  const assessment = teacherAssessmentData(bookId, requestedChapters, qs, scope);
  if(assessment.error) return res.status(400).json({error:assessment.error});
  const now = new Date().toISOString();
  const t = {
    id: `t-${crypto.randomUUID().slice(0,12)}`, teacherId: teacher, bookId,
    title: String(title||'Test'), chapter: scope === 'book' ? '' : String(chapter||assessment.chapter||''), chapters: assessment.chapters, testMode,
    status: 'draft',
    timerEnabled: !!timerEnabled, timerMinutes: Math.max(0, Number(timerMinutes)||0),
    questions: qs, settings: {mode: testMode, scope, chapters: assessment.chapters},
    createdAt: now, updatedAt: now
  };
  testsMem.set(t.id, t); persistTest(t);
  res.json({ok:true, challenge: {...t, questions: undefined, questionCount: qs.length}});
});

app.get('/api/teacher/challenges', (req,res)=>{
  const teacher = reqActor(req);
  if(!teacher) return res.status(400).json({error:'teacher walletAddress required'});
  const list = Array.from(testsMem.values()).filter(t=>t.teacherId===teacher).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(t=>({
    id:t.id, teacherId:t.teacherId, bookId:t.bookId, bookTitle:testBookTitle(t.bookId),
    title:t.title, chapter:t.chapter, chapterTitle:testChapterTitle(t.bookId, t.chapter),
    chapters:t.chapters || t.settings?.chapters || (t.chapter ? [t.chapter] : []), scope:t.settings?.scope || 'chapter',
    testMode:t.testMode, status:t.status, timerEnabled:t.timerEnabled, timerMinutes:t.timerMinutes,
    questionCount:(t.questions||[]).length, createdAt:t.createdAt
  }));
  res.json({ok:true, challenges: list});
});

app.delete('/api/teacher/challenges/:id', (req,res)=>{
  const teacher = reqActor(req);
  const t = testsMem.get(req.params.id);
  if(!t) return res.status(404).json({error:'challenge not found'});
  if(t.teacherId !== teacher) return res.status(403).json({error:'not your challenge'});
  testsMem.delete(t.id);
  try{ db.run(`DELETE FROM tests WHERE id=?`, [t.id], function(){ res.json({ok:true, deleted:t.id}); }); }
  catch(e){ res.json({ok:true, deleted:t.id}); }
});

app.get('/api/teacher/challenges/:id', (req,res)=>{
  const teacher = reqActor(req);
  const t = testsMem.get(req.params.id);
  if(!t) return res.status(404).json({error:'challenge not found'});
  if(t.teacherId !== teacher) return res.status(403).json({error:'not your challenge'});
  res.json({ok:true, challenge:{...t, chapters:t.chapters || t.settings?.chapters || (t.chapter ? [t.chapter] : []), scope:t.settings?.scope || 'chapter', bookTitle:testBookTitle(t.bookId), chapterTitle:testChapterTitle(t.bookId, t.chapter)}});
});

app.patch('/api/teacher/challenges/:id', (req,res)=>{
  const teacher = reqActor(req);
  const t = testsMem.get(req.params.id);
  if(!t) return res.status(404).json({error:'challenge not found'});
  if(t.teacherId !== teacher) return res.status(403).json({error:'not your challenge'});
  const {title, chapters: requestedChapters, certificateScope, testMode, timerEnabled, timerMinutes, questions, status} = req.body || {};
  if(title !== undefined) t.title = String(title);
  if(testMode !== undefined){
    if(!TEST_MODES.has(testMode)) return res.status(400).json({error:'testMode must be VIRTUAL, PAPER or BOTH'});
    t.testMode = testMode; t.settings = t.settings||{}; t.settings.mode = testMode;
  }
  if(timerEnabled !== undefined) t.timerEnabled = !!timerEnabled;
  if(timerMinutes !== undefined) t.timerMinutes = Math.max(0, Number(timerMinutes)||0);
  if(questions !== undefined){
    const hasAttempts = Array.from(attemptsMem.values()).some((attempt)=>attempt.challengeId===t.id);
    if(t.status!=='draft' || hasAttempts) return res.status(409).json({error:'published test questions are immutable'});
    const qs = (Array.isArray(questions)?questions:[]).map(sanitizeTeacherQuestion).filter(Boolean);
    if(!qs.length) return res.status(400).json({error:'test needs at least one question'});
    const scope = certificateScope === 'book' ? 'book' : (t.settings?.scope || 'chapter');
    const assessment = teacherAssessmentData(t.bookId, requestedChapters, qs, scope);
    if(assessment.error) return res.status(400).json({error:assessment.error});
    t.questions = qs;
    t.chapters = assessment.chapters;
    t.chapter = assessment.chapter;
    t.settings = {...(t.settings||{}), scope, chapters:assessment.chapters};
  }
  if(status !== undefined && ['draft','active','closed'].includes(status)) t.status = status;
  t.updatedAt = new Date().toISOString();
  testsMem.set(t.id, t); persistTest(t);
  res.json({ok:true, challenge: {...t, questionCount:(t.questions||[]).length}});
});

app.post('/api/teacher/challenges/:id/activate', (req,res)=>{
  const teacher = reqActor(req);
  const t = testsMem.get(req.params.id);
  if(!t) return res.status(404).json({error:'challenge not found'});
  if(t.teacherId !== teacher) return res.status(403).json({error:'not your challenge'});
  if(!(t.questions||[]).length) return res.status(400).json({error:'challenge has no questions'});
  const assessment = teacherAssessmentData(t.bookId, t.chapters, t.questions, t.settings?.scope || 'chapter');
  if(assessment.error) return res.status(400).json({error:assessment.error});
  t.chapters = assessment.chapters;
  t.chapter = assessment.chapter;
  t.status = 'active'; t.updatedAt = new Date().toISOString();
  testsMem.set(t.id, t); persistTest(t);
  res.json({ok:true, challenge:{...t, questionCount:(t.questions||[]).length}});
});

// ── Nauczyciel: wyniki (Student | Mode | Score | Status) ──
function studentDisplayName(walletOrApple){
  return new Promise(resolve=>{
    if(!walletOrApple) return resolve(null);
    db.get(`SELECT * FROM users WHERE walletAddress=? OR appleUserId=?`, [walletOrApple, walletOrApple], (err,row)=>{
      if(!err && row) return resolve(row.displayName || row.name || walletOrApple);
      resolve(null);
    });
  });
}

app.get('/api/teacher/challenges/:id/results', async (req,res)=>{
  const teacher = reqActor(req);
  const t = testsMem.get(req.params.id);
  if(!t) return res.status(404).json({error:'challenge not found'});
  if(t.teacherId !== teacher) return res.status(403).json({error:'not your challenge'});
  const atts = Array.from(attemptsMem.values()).filter(a=>a.challengeId===t.id).sort((a,b)=>new Date(b.submittedAt||b.createdAt)-new Date(a.submittedAt||a.createdAt));
  const rows = [];
  for(const a of atts){
    let name = a.studentId || '';
    if(a.mode==='PAPER' && a.paperTestId && paperMem.has(a.paperTestId)) name = paperMem.get(a.paperTestId).studentName || name;
    else {
      const dn = await studentDisplayName(a.studentId);
      if(dn) name = dn;
    }
    rows.push({
      attemptId:a.id, studentId:a.studentId, studentName:name,
      mode:a.mode, modeLabel: a.mode==='VIRTUAL' ? 'Wirtualny' : 'Papierowy',
      score:a.score ?? 0, maxScore:a.maxScore ?? 0,
      pct: a.maxScore ? Math.round(((a.score||0)/a.maxScore)*100) : 0,
      status:(a.score!=null && a.maxScore!=null) ? ((a.score >= Math.max(1, Math.ceil(a.maxScore*0.6))) ? 'Passed' : 'Failed') : 'pending',
      paperStatus: (a.mode==='PAPER' && a.paperTestId && paperMem.has(a.paperTestId)) ? paperMem.get(a.paperTestId).status : null,
      submittedAt:a.submittedAt||null, completedAt:a.completedAt||null, createdAt:a.createdAt
    });
  }
  res.json({ok:true, challenge:{id:t.id, title:t.title, testMode:t.testMode, status:t.status, bookTitle:testBookTitle(t.bookId), chapterTitle:testChapterTitle(t.bookId,t.chapter)}, results: rows});
});

app.get('/api/teacher/attempts/:id', async (req,res)=>{
  const teacher = reqActor(req);
  const a = attemptsMem.get(req.params.id);
  if(!a) return res.status(404).json({error:'attempt not found'});
  const t = testsMem.get(a.challengeId);
  if(!t) return res.status(404).json({error:'challenge not found'});
  if(t.teacherId !== teacher) return res.status(403).json({error:'not your attempt'});
  let name = a.studentId || '';
  if(a.mode==='PAPER' && a.paperTestId && paperMem.has(a.paperTestId)) name = paperMem.get(a.paperTestId).studentName || name;
  else { const dn = await studentDisplayName(a.studentId); if(dn) name = dn; }
  res.json({ok:true, attempt:{...a, studentName:name, challengeTitle:t.title, testMode:t.testMode}});
});

// ── Papier: generowanie PDF, upload skanu, OCR, review, potwierdzenie ──
app.get('/api/teacher/challenges/:id/pdf', (req,res)=>{
  const teacher = reqActor(req);
  const t = testsMem.get(req.params.id);
  if(!t) return res.status(404).json({error:'challenge not found'});
  if(t.teacherId !== teacher) return res.status(403).json({error:'not your challenge'});
  if(!(t.testMode==='PAPER'||t.testMode==='BOTH')) return res.status(400).json({error:'test has no paper mode'});
  const buf = buildTestPdf(t, testBookTitle(t.bookId), testChapterTitle(t.bookId, t.chapter));
  const fname = (String(t.title||'test').toLowerCase().replace(/[^a-z0-9]+/gi,'-')+'.pdf').replace(/-+/g,'-');
  res.setHeader('Content-Type','application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(buf);
});

app.post('/api/teacher/challenges/:id/paper', (req,res)=>{
  const teacher = reqActor(req);
  const t = testsMem.get(req.params.id);
  if(!t) return res.status(404).json({error:'challenge not found'});
  if(t.teacherId !== teacher) return res.status(403).json({error:'not your challenge'});
  if(!(t.testMode==='PAPER'||t.testMode==='BOTH')) return res.status(400).json({error:'test has no paper mode'});
  const {studentId, studentName, image, mime} = req.body || {};
  if(!image || !/^data:image\//.test(String(image)) && !String(image).startsWith('data:image')) return res.status(400).json({error:'image (base64 data URL) required'});
  const m = String(image).match(/^data:([^;]+);base64,(.*)$/s);
  const ext = m ? (m[1].split('/')[1]||'jpg').replace('jpeg','jpg') : 'jpg';
  const now = new Date().toISOString();
  const pid = `p-${crypto.randomUUID().slice(0,12)}`;
  const fname = `uploads/${pid}.${ext}`;
  try{
    const b64 = m ? m[2] : String(image).split(',')[1]||'';
    fs.writeFileSync(fname, Buffer.from(b64, 'base64'));
  }catch(e){ return res.status(500).json({error:'scan save failed: '+e.message}); }
  const p = {
    id: pid, challengeId: t.id, teacherId: teacher, studentId: studentId||null, studentName: studentName||'',
    scans:[{file:fname, uploadedAt: now}], ocrText:'', ocrAnswers:{}, status:'scan_received',
    createdAt: now, updatedAt: now
  };
  paperMem.set(pid, p); persistPaper(p);
  res.json({ok:true, paper:{id:pid, studentId:p.studentId, studentName:p.studentName, status:p.status, scans:p.scans}});
});

app.post('/api/teacher/paper/:id/ocr', async (req,res)=>{
  const teacher = reqActor(req);
  const p = paperMem.get(req.params.id);
  if(!p) return res.status(404).json({error:'paper test not found'});
  if(p.teacherId !== teacher) return res.status(403).json({error:'not your paper'});
  const t = testsMem.get(p.challengeId);
  const file = (p.scans||[]).slice(-1)[0]?.file;
  if(!file || !fs.existsSync(file)) return res.status(400).json({error:'no scan image stored'});
  const ocr = await runOcrText(file);
  const qs = (t && (t.questions||[])) || [];
  const parsed = parseOcrAnswers(ocr.text, qs);
  p.ocrText = ocr.text || '';
  p.ocrAnswers = { answers: parsed };
  p.status = ocr.engineMissing ? 'ocr_unavailable' : 'ocr_done';
  p.updatedAt = new Date().toISOString();
  paperMem.set(p.id, p); persistPaper(p);
  res.json({ok:true, paper:{id:p.id, status:p.status, language: ocr.lang, ocrText: p.ocrText.slice(0,3000), ocrAnswers: p.ocrAnswers.answers, questions: qs.map(stripTestSecrets), engineMissing: ocr.engineMissing, note: ocr.engineMissing ? 'OCR niedostępny na serwerze — wpisz odpowiedzi ręcznie w review.' : undefined}});
});

// Potwierdzenie papieru → wspólny pipeline → TestAttempt(mode=PAPER) → gradeTest
app.post('/api/teacher/paper/:id/confirm', async (req,res)=>{
  const teacher = reqActor(req);
  const p = paperMem.get(req.params.id);
  if(!p) return res.status(404).json({error:'paper test not found'});
  if(p.teacherId !== teacher) return res.status(403).json({error:'not your paper'});
  const t = testsMem.get(p.challengeId);
  if(!t) return res.status(404).json({error:'challenge not found'});
  const {studentName, answers} = req.body || {};
  if(studentName !== undefined) p.studentName = String(studentName);
  if(answers) p.ocrAnswers.answers = answers;
  p.status = 'confirmed'; p.updatedAt = new Date().toISOString();
  paperMem.set(p.id, p); persistPaper(p);
  // NIE duplikuj — jeden attempt PAPER na ucznia na challenge
  const existing = Array.from(attemptsMem.values()).find(a=>a.challengeId===t.id && a.mode==='PAPER' && a.paperTestId===p.id);
  if(existing){
    if(existing.status==='graded') return res.json({ok:true, alreadyGraded:true, attempt:existing, challenge:{id:t.id, title:t.title}});
    const g2 = await gradeTest(t.questions, existing.answers||p.ocrAnswers.answers||{}, 'pl');
    existing.score=g2.score; existing.maxScore=g2.maxScore; existing.detail=g2; existing.status='graded'; existing.completedAt=new Date().toISOString();
    attemptsMem.set(existing.id, existing); persistAttempt(existing);
    return res.json({ok:true, attempt:existing, challenge:{id:t.id, title:t.title}});
  }
  const now = new Date().toISOString();
  const attempt = {
    id: `a-${crypto.randomUUID().slice(0,12)}`, challengeId: t.id, studentId: p.studentId||`paper:${p.id}`,
    mode: 'PAPER', status: 'graded', answers: p.ocrAnswers.answers||{}, score:0, maxScore:0,
    submittedAt: now, completedAt: now, detail:null, paperTestId: p.id, virtualAttemptId: null, createdAt: now
  };
  const g = await gradeTest(t.questions, attempt.answers, 'pl');
  attempt.score=g.score; attempt.maxScore=g.maxScore; attempt.detail=g;
  attemptsMem.set(attempt.id, attempt); persistAttempt(attempt);
  let certificate = null;
  try{ certificate = await issueTestCertificate(attempt, t); }catch(error){ console.error('[certificate] issue failed:', error.message); }
  res.json({ok:true, attempt, certificate, challenge:{id:t.id, title:t.title}, grading:{score:g.score, maxScore:g.maxScore, pct:g.pct, status:g.status}});
});

// ── Studenci: aktywne testy + podejście wirtualne ──
app.get('/api/student/challenges', requireStudent, (req,res)=>{
  const student = studentActor(req);
  if(!student) return res.status(400).json({error:'student walletAddress required'});
  const requestedClass = normalizeClassCode(req.query.classCode || req.headers['x-class-code']);
  if(!requestedClass) return res.status(403).json({error:'class membership required'});
  const cls = classesMem.get(requestedClass);
  if(!cls) return res.status(404).json({error:'class not found'});
  const isMember = (cls.students || []).some(s => s.walletAddress === student || s.id === student);
  if(!isMember) return res.status(403).json({error:'join the class before viewing tests'});
  const classChapters = new Set(cls.chapters || []);
  const list = Array.from(testsMem.values()).filter(t=>t.status==='active' && t.bookId===cls.bookId && (!classChapters.size || (t.chapters || []).some(chapter=>classChapters.has(chapter)))).map(t=>({
    id:t.id, bookId:t.bookId, bookTitle:testBookTitle(t.bookId),
    title:t.title, chapter:t.chapter, chapterTitle:testChapterTitle(t.bookId, t.chapter),
    chapters:t.chapters || t.settings?.chapters || [], scope:t.settings?.scope || 'chapter',
    testMode:t.testMode, timerEnabled:t.timerEnabled, timerMinutes:t.timerMinutes,
    questionCount:(t.questions||[]).length, createdAt:t.createdAt,
    canVirtual: t.testMode==='VIRTUAL'||t.testMode==='BOTH'
  })).sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));
  res.json({ok:true, challenges: list});
});

app.post('/api/student/challenges/:id/attempt', requireStudent, (req,res)=>{
  const student = studentActor(req);
  if(!student) return res.status(400).json({error:'student walletAddress required'});
  const requestedClass = normalizeClassCode(req.query.classCode || req.headers['x-class-code']);
  if(!requestedClass) return res.status(403).json({error:'class membership required'});
  const cls = classesMem.get(requestedClass);
  if(!cls || !(cls.students || []).some(s => s.walletAddress === student || s.id === student)) return res.status(403).json({error:'join the class before starting the test'});
  const t = testsMem.get(req.params.id);
  if(!t) return res.status(404).json({error:'challenge not found'});
  if(t.status!=='active') return res.status(403).json({error:'challenge is not active'});
  if(!(t.testMode==='VIRTUAL'||t.testMode==='BOTH')) return res.status(400).json({error:'challenge has no virtual mode'});
  const existing = Array.from(attemptsMem.values()).find(a=>a.challengeId===t.id && a.studentId===student && a.mode==='VIRTUAL');
  if(existing){
    if(existing.status==='graded') return res.status(409).json({error:'Już rozwiązałeś ten test (a we submitted).', attemptId: existing.id});
    return res.json({ok:true, resumed:true, attempt:{id:existing.id, mode:'VIRTUAL', status:existing.status, expiresAt:existing.expiresAt||null}});
  }
  const now = new Date().toISOString();
  const attempt = {
    id: `a-${crypto.randomUUID().slice(0,12)}`, challengeId: t.id, studentId: student,
    mode: 'VIRTUAL', status: 'started', answers:{}, score:0, maxScore:0,
    submittedAt:null, completedAt:null, detail:null, paperTestId:null, virtualAttemptId: null, createdAt: now,
    expiresAt: t.timerEnabled && t.timerMinutes>0 ? new Date(Date.now() + t.timerMinutes*60000).toISOString() : null,
    proctoring: null
  };
  attemptsMem.set(attempt.id, attempt); persistAttempt(attempt);
  res.json({ok:true, attempt:{id:attempt.id, mode:'VIRTUAL', status:attempt.status, expiresAt:attempt.expiresAt}});
});

// student-friendly widok pytania (bez sekretów — correctAnswer itd.)
app.get('/api/student/attempts/:id', requireStudent, (req,res)=>{
  const student = studentActor(req);
  const a = attemptsMem.get(req.params.id);
  if(!a) return res.status(404).json({error:'attempt not found'});
  if(a.studentId !== student) return res.status(403).json({error:'not your attempt'});
  const t = testsMem.get(a.challengeId);
  if(!t) return res.status(404).json({error:'challenge not found'});
  const qs = (t.questions||[]).map((question)=>({...stripTestSecrets(question), chapterTitle:testChapterTitle(t.bookId, question.chapterId || t.chapter)}));
  res.json({ok:true, attempt:{id:a.id, challengeId:a.challengeId, mode:a.mode, status:a.status,
    submittedAt:a.submittedAt, completedAt:a.completedAt, expiresAt:a.expiresAt||null, score:a.score, maxScore:a.maxScore, detail:a.detail, answers:a.answers},
    challenge:{id:t.id, title:t.title, bookTitle:testBookTitle(t.bookId), chapter:t.chapter, chapterTitle:testChapterTitle(t.bookId,t.chapter), chapters:t.chapters || t.settings?.chapters || [], scope:t.settings?.scope || 'chapter', testMode:t.testMode, timerEnabled:t.timerEnabled, timerMinutes:t.timerMinutes, createdAt:t.createdAt},
    questions: qs});
});

app.post('/api/student/attempts/:id/answers', requireStudent, (req,res)=>{
  const student = studentActor(req);
  const a = attemptsMem.get(req.params.id);
  if(!a) return res.status(404).json({error:'attempt not found'});
  if(a.studentId !== student) return res.status(403).json({error:'not your attempt'});
  if(a.status === 'graded') return res.status(409).json({error:'test już przesłany — nie można zmieniać odpowiedzi.'});
  if(studentAttemptExpired(a)) return res.status(410).json({error:'Czas na test minął.', expired:true});
  const t = testsMem.get(a.challengeId);
  if(!t) return res.status(404).json({error:'challenge not found'});
  const {answers} = req.body || {};
  const sanitized = sanitizeStudentAnswers(t, answers);
  if(sanitized.error) return res.status(400).json({error:sanitized.error});
  a.answers = sanitized.answers;
  a.proctoring = sanitizeStudentProctoring(req.body?.proctoring);
  a.updatedAt = new Date().toISOString();
  attemptsMem.set(a.id, a); persistAttempt(a);
  res.json({ok:true, saved:true});
});

let submittingGuard = new Map();
app.post('/api/student/attempts/:id/submit', requireStudent, async (req,res)=>{
  const student = studentActor(req);
  const a = attemptsMem.get(req.params.id);
  if(!a) return res.status(404).json({error:'attempt not found'});
  if(a.studentId !== student) return res.status(403).json({error:'not your attempt'});
  if(a.status === 'graded') return res.json({ok:true, errorMsg:null, message:'Test został przesłany.', already:true, attempt:{id:a.id, status:a.status, score:a.score, maxScore:a.maxScore, detail:a.detail}});
  if(submittingGuard.has(a.id)) return res.status(429).json({error:'still processing — spróbuj za chwilę'});
  submittingGuard.set(a.id, true);
  try{
    const t = testsMem.get(a.challengeId);
    if(!t) return res.status(404).json({error:'challenge not found'});
    const proctoring = sanitizeStudentProctoring(req.body?.proctoring);
    const forcedFailure = req.body?.fail === true || studentProctoringViolation(proctoring);
    if(studentAttemptExpired(a) && !forcedFailure) return res.status(410).json({error:'Czas na test minął.', expired:true});
    if(!forcedFailure && Object.keys(a.answers||{}).length < 1) return res.status(400).json({error:'Odpowiedz na co najmniej jedno pytanie przed wysłaniem.'});
    const now = new Date().toISOString();
    a.submittedAt = a.submittedAt || now;
    const g = await gradeTest(t.questions, a.answers||{}, 'pl');
    if(forcedFailure){ g.passed = false; g.status = 'Failed'; g.suspicious = true; g.proctoring = proctoring; }
    a.proctoring = proctoring;
    a.score = g.score; a.maxScore = g.maxScore; a.detail = g; a.status = 'graded'; a.completedAt = now;
    attemptsMem.set(a.id, a); persistAttempt(a);
    let certificate = null;
    if(!forcedFailure) try{ certificate = await issueTestCertificate(a, t); }catch(error){ console.error('[certificate] issue failed:', error.message); }
    res.json({ok:true, message:'Test został przesłany.', certificate, attempt:{id:a.id, challengeId:a.challengeId, mode:a.mode, status:a.status, score:a.score, maxScore:a.maxScore, pct:g.pct, gradedStatus:g.status, detail:a.detail, submittedAt:a.submittedAt, completedAt:a.completedAt}});
  } finally {
    submittingGuard.delete(a.id);
  }
});

app.get('/api/student/results', requireStudent, (req,res)=>{
  const student = studentActor(req);
  if(!student) return res.status(400).json({error:'student walletAddress required'});
  const list = Array.from(attemptsMem.values())
    .filter(a=>a.studentId===student && a.status==='graded')
    .sort((a,b)=>new Date(b.completedAt||b.createdAt)-new Date(a.completedAt||a.createdAt))
    .map(a=>{
      const t = testsMem.get(a.challengeId);
      return {
        attemptId:a.id, challengeId:a.challengeId, title:t?.title||'', bookTitle:t?testBookTitle(t.bookId):'',
        chapterTitle:t?testChapterTitle(t.bookId,t.chapter):'', testMode:t?.testMode||'', mode:a.mode,
        modeLabel:a.mode==='VIRTUAL'?'Wirtualny':'Papierowy',
        score:a.score ?? 0, maxScore:a.maxScore ?? 0,
        pct: a.maxScore? Math.round(((a.score||0)/a.maxScore)*100):0,
        status: a.score!=null && a.maxScore!=null ? ((a.score >= Math.max(1,Math.ceil(a.maxScore*0.6)))?'Passed':'Failed') : 'pending',
        completedAt:a.completedAt, submittedAt:a.submittedAt
      };
    });
  res.json({ok:true, results: list});
});

// pule pytań rozdziału dla nauczyciela (pełne dane — z poprawnymi odpowiedziami)
app.get('/api/teacher/pool', (req,res)=>{
  const teacher = reqActor(req);
  if(!teacher) return res.status(400).json({error:'teacher wallet required'});
  const {chapter} = req.query || {};
  if(!chapter) return res.status(400).json({error:'chapterId required'});
  const pool = poolForChapter(chapter);
  res.json({ok:true, chapter, pool, count: pool.length});
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
  if(score>=4) status='Reading Verified'; // pełne zrozumienie od 4/5
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
  const proofId=req.query.proof || req.query.hash || req.query.id;
  const userId=req.query.userId || req.headers['x-user-id'] || req.headers['x-apple-user'] || null;
  const authH = req.headers['authorization']||'';
  // if Authorization Bearer, treat as userId filter as well (sessionToken)
  let filterUser = userId;
  if(!filterUser && authH.startsWith('Bearer ')) filterUser = authH.slice(7).trim();
  let sql, params;
  const baseCols = `id, bookId, chapterId, score, total, status, walletAddress, timestamp, proofHash, txSignature, explorerUrl, reward, CAST(detail AS CHAR) as detail, verificationVersion, durationSec, userId`;
  if(proofId){
    sql = `SELECT ${baseCols} FROM proofs WHERE proofHash=? OR CAST(id AS CHAR)=? OR UPPER(proofHash) LIKE ? ORDER BY timestamp DESC LIMIT 20`;
    params=[String(proofId||''), String(proofId||''), `%${String(proofId||'').toUpperCase()}%`];
  } else if(wallet && filterUser){
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

// ── Certyfikaty: rozdział (tworzony w /complete) + cała lektura + weryfikacja publiczna ──
function certBookTitle(id){ const b=books.find(x=>x.id===id); return (b&&b.title)||String(id||''); }
function certChapterTitle(bookId, chapterId){ const b=books.find(x=>x.id===bookId); const c=b&&(b.chapters||[]).find(x=>x.id===chapterId); return (c&&(c.title||c.id))||String(chapterId||''); }
function certVerified(p){ return p && VERIF_STATUSES.has(String(p.status||'')); }
// cert za całą lekturę: wszystkie rozdziały mają zweryfikowany dowód; ID trafia do memo on-chain
app.post('/api/books/:bookId/certificate', async (req,res)=>{
  const book=books.find(b=>b.id===req.params.bookId);
  if(!book) return res.status(404).json({error:'book not found'});
  const chapters=book.chapters||[];
  if(!chapters.length) return res.status(404).json({error:'book has no chapters'});
  const wallet=(req.body?.wallet||req.query.wallet||req.headers['x-user-id']||req.body?.userId||'').toString();
  if(!wallet) return res.status(400).json({error:'wallet required'});
  const userIdForCert = req.body?.userId || req.headers['x-user-id'] || req.headers['x-apple-user'] || null;
  db.all(`SELECT bookId, chapterId, score, total, status, proofHash, timestamp FROM proofs WHERE walletAddress=? AND bookId=? ORDER BY timestamp DESC LIMIT 300`, [wallet, book.id], async (err, rows)=>{
    if(err) return res.status(500).json({error:err.message});
    const by={}; for(const p of rows||[]) if(certVerified(p) && !by[p.chapterId]) by[p.chapterId]=p;
    const missing=chapters.filter(c=>!by[c.id]).map(c=>c.id);
    if(missing.length) return res.status(409).json({error:'Nie wszystkie rozdziały zweryfikowane.', missing});
    const certHash=crypto.createHash('sha256').update(`${wallet}|${book.id}|${chapters.map(c=>by[c.id].proofHash).join(',')}`).digest('hex').slice(0,32);
    db.get(`SELECT * FROM certificates WHERE walletAddress=? AND bookId=? AND kind='book' ORDER BY timestamp DESC LIMIT 1`, [wallet, book.id], async (e2, existing)=>{
      if(existing){
        return res.json({ok:true, existing:true, cert:{...existing, bookTitle:book.title, chapterTitle:null}});
      }
      const cid=certId();
      const ts=new Date().toISOString();
      let tx=null, explorer=null;
      try{
        const real=await tryRealSolanaReward(wallet, '0', {memoOnly:true, sessionId:`book:${book.id}`, bookId:book.id, chapterId:book.id, score:chapters.length, total:chapters.length, durationSec:0, proofHash:certHash, timestamp:ts, verificationVersion:'readproof-v1', certId:cid});
        if(real){ tx=real.signature; explorer=real.explorer; }
      }catch(e3){ /* offline — cert zapisywany bez tx */ }
      db.run(`INSERT INTO certificates (id, kind, bookId, chapterId, walletAddress, userId, score, total, status, certHash, txSignature, explorerUrl, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid,'book', book.id, null, wallet, userIdForCert, chapters.length, chapters.length, 'Verified', certHash, tx, explorer, ts, ts],
        (e4)=>{ if(e4) return res.status(500).json({error:e4.message}); });
      res.json({ok:true, existing:false, cert:{id:cid, kind:'book', bookId:book.id, chapterId:null, walletAddress:wallet, userId:userIdForCert, score:chapters.length, total:chapters.length, status:'Verified', certHash, txSignature:tx, explorerUrl:explorer, timestamp:ts, bookTitle:book.title, chapterTitle:null}});
    });
  });
});
// publiczna weryfikacja certyfikatu po ID (RP-XXXX) — bez autoryzacji
app.get('/api/certificates/:id', (req,res)=>{
  const id=String(req.params.id||'').trim().toUpperCase();
  if(!id) return res.status(400).json({error:'id required'});
  db.get(`SELECT * FROM certificates WHERE UPPER(id)=?`, [id], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'certificate not found', id});
    const publicRow = {...row, chapterId:row.kind==='test'?null:row.chapterId};
    res.json({cert:{...publicRow, bookTitle:certBookTitle(row.bookId), chapterTitle:row.kind==='test'?'Cała książka':(row.chapterId?certChapterTitle(row.bookId,row.chapterId):null), verified:certVerified(row)||row.status==='Verified'}});
  });
});
// lista certyfikatów użytkownika (chapter + book)
app.get('/api/certificates', (req,res)=>{
  const wallet=req.query.wallet;
  const userId=req.query.userId || req.headers['x-user-id'] || req.headers['x-apple-user'] || null;
  const authH=req.headers['authorization']||'';
  let fu=userId; if(!fu && authH.startsWith('Bearer ')) fu=authH.slice(7).trim();
  const where=[]; const params=[];
  if(wallet){ where.push('walletAddress=?'); params.push(wallet); }
  if(fu){ where.push('userId=?'); params.push(fu); }
  if(!where.length) return res.json({certificates:[]});
  db.all(`SELECT * FROM certificates WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT 100`, params, (err,rows)=>{
    if(err) return res.status(500).json({error:err.message});
    res.json({certificates:(rows||[]).map(r=>{ const item={...r, chapterId:r.kind==='test'?null:r.chapterId}; return {...item, bookTitle:certBookTitle(r.bookId), chapterTitle:r.kind==='test'?'Cała książka':(r.chapterId?certChapterTitle(r.bookId,r.chapterId):null), verified:certVerified(r)||r.status==='Verified'}; })});
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
    const n = await generateChapterPool(chapter, Number(count)||10, lang);
    res.json({ok:true, count:n, challenges: poolForChapter(chapterId), lang});
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
    // ensure ATA exists (idempotent) — tylko przy prawdziwym przelewie
    if(!meta.memoOnly){
      const ixAta = createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ataTo, owner, mint);
      const txAta = new Transaction().add(ixAta);
      await sendAndConfirmTransaction(connection, txAta, [payer], {commitment:'confirmed'});
    }
    // transfer 5 USDC (6 decimals) — pomijane przy memoOnly (np. certyfikat całej lektury)
    const tx = new Transaction();
    if(!meta.memoOnly){
      const amount = BigInt(Math.round(Number(amountUSDC.replace(/[^0-9.]/g,''))*1_000_000));
      const ixTransfer = createTransferInstruction(ataFrom, ataTo, payer.publicKey, amount);
      tx.add(ixTransfer);
    }
    // ── On-chain READING PROOF (Memo) — niezmienny zapis, bez treści/odpowiedzi ──
    // readproof-v1|book|chapter|session|score/total|duration|proofHash|timestamp|certId
    if(meta.sessionId){
      const memo = `${meta.verificationVersion||'readproof-v1'}|${meta.bookId||''}|${meta.chapterId||''}|${meta.sessionId}|${meta.score||0}/${meta.total||0}|${meta.durationSec||0}s|${meta.proofHash||''}|${new Date(meta.timestamp||Date.now()).toISOString()}|${meta.certId||''}`;
      const MEMO_V2 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
      const memoIx = new TransactionInstruction({keys:[], programId:new PublicKey(MEMO_V2), data:Buffer.from(memo,'utf8')});
      tx.add(memoIx);
      console.log(`[solana-memo] ${memo}`);
    }
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], {commitment:'confirmed'});
    return {signature:sig, explorer:`https://explorer.solana.com/tx/${sig}?cluster=devnet`};
  }catch(e){ console.error('real solana reward failed, fallback mock', e.message); return null; }
}

// ── Boot warmer: pre-generowanie pul pytań (per rozdział, RAZ, bez regeneracji co sesję) ──
async function warmAllPools(){
  console.log('[warm] start pre-generowania pul pytań (10/rozdział)…');
  const chapters = books.flatMap(b=>b.chapters);
  const queue = chapters.filter(c=>poolForChapter(c.id).length < 5);
  const total = chapters.length;
  let done = total - queue.length;
  const worker = async ()=>{
    while(true){
      const c = queue.shift();
      if(!c) return;
      try{
        const n = await generateChapterPool(c, 10, 'pl');
        console.log(`[warm] ✓ (${done+1}/${total}) ${c.id} → pool ${n}`);
      }catch(e){ console.warn(`[warm] ${c.id} fail: ${e.message}`); }
      done++;
      await new Promise(r=>setTimeout(r, 6000)); // Pollinations: 1 req/IP - szeregowo, z luzem dla sesji użytkowników
    }
  };
  await worker(); // Pollinations: max 1 równoczesne żądanie na IP
  console.log(`[warm] koniec — gotowe: ${chapters.filter(c=>poolForChapter(c.id).length>=5).length}/${total} rozdziałów`);
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

setTimeout(warmAllPools, 3000);
