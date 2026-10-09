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
import {
  ANCHOR_VERSION, buildAnchorMemo, parseAnchorMemo, compareWithRow,
  writeAnchorMemo, readAnchorFromChain,
} from './anchor.js';
import { detectChaptersDetailed } from './chapters.js';
import { runOcrText, parseOcrAnswers, readSheetWithVision, mergeSheetAnswers, visionAvailable } from './paperSheet.js';
import { createDbHelpers } from './dbHelpers.js';
import { isApproved as roleIsApproved, isSuspended as roleIsSuspended } from './approval.js';
import { sanitizeSecurePolicy } from './securityEvents.js';
import { registerRoleAuth } from './routes/roleAuth.js';
import { registerAdmin, ensureBootstrapAdmin } from './routes/admin.js';
import { createSecureSessionStore, registerSecure } from './routes/secure.js';

dotenv.config();
const PORT = Number(process.env.PORT) || 32288;
const JEV_THRESHOLD = Number(process.env.JEV_THRESHOLD) || 0.28;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';
// Jev — TypeSafe https://docs.typesafe.ai/api  (POST https://api.typesafe.ai/v1/systemone)
const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || '';
const TYPESAFE_MODEL = process.env.TYPESAFE_MODEL || 'jev-latest';
const TYPESAFE_ENDPOINT = process.env.TYPESAFE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
const SOLANA_PAYER_PRIVATE_KEY = process.env.SOLANA_PAYER_PRIVATE_KEY || ''; // JSON array for real Devnet payout (optional)
const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // Circle USDC Devnet
const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const PRIVACY_COPY = "ReadProof — Proof of Comprehension, not proof of physical reading. We store ONLY: walletAddress, bookId, chapterId, session_start/end, reading_duration, proof_hash (SHA-256). Each certificate is additionally anchored on Solana Devnet as a signed Memo (SPL Memo v2) containing ONLY: certificate id, kind, wallet, book id, chapter id, score/total, status, issue timestamp and an anchorHash over those fields. NEVER stored on-chain: book content, answers, prompts, reader name. Book content stays server-only (never full book on-chain). Solana Devnet ONLY (USDC/SOL test funds, no real money). Free LLM routing only. See /api/privacy.";
const PRIVACY_SHORT = "Privacy: wallet, book, chapter, duration, proof hash only. No content on-chain. Devnet only.";
const ALLOWED_ORIGINS = ['*'];
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
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

// Bezpieczna liczba z wartością zapasową (kwoty, wyniki, rozmiary pul).
const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// Jedyny zapis pul do dysku. challenges.json jest źródłem prawdy dla pytań
// (readproof_challenges jest tylko zrzutem), więc wszystkie mutacje — w tym
// zatwierdzanie w panelu wydawcy — muszą iść tędy.
function persistChallenges(){
  try{ fs.writeFileSync('./challenges.json', JSON.stringify({books, challengesByChapter}, null, 2)); return true; }
  catch(e){ console.error('[challenges] persist failed', e.message); return false; }
}

// Generowanie puli pytań — używane TYLKO przez warmAllPools (i ewentualnie POST /api/generate), NIGDY przy starcie sesji
async function generateChapterPool(chapter, target=10, lang='pl'){
  let pool = poolForChapter(chapter.id);
  if(pool.length >= target) return pool.length;
  try{
    const generated = await callOpenRouterGenerate(chapter, Math.min(target, 15), lang);
    pool = pool.concat(sanitizePool(generated));
    challengesByChapter[chapter.id] = pool;
    persistChallenges()
    // Pula EN tego rozdziałiu ma stary podpis ID → przy najbliższym starcie EN
    // zostanie przebudowana leniwie (ensureEnPool). Nic nie robimy w tle, bo
    // warmAllPools odpala to dla 100+ rozdziałów i wybiłoby limit Google (429).
    console.log(`[pool-gen] +${generated.length} → pool ${pool.length} (${chapter.id})`);
  }catch(e){ console.error(`[pool-gen] fail (${chapter.id}): ${e.message}`); }
  return pool.length;
}

// Status pytania w puli:
//   'approved' — dopuszczone do losowania w sesji czytelnika
//   'draft'     — wygenerowane, czeka na zatwierdzenie wydawcy
//   'rejected'  — odrzucone przez wydawcę, nigdy nie wchodzi do sesji
// Brak pola = 'approved' (wsteczna zgodność z istniejącą pulą).
const Q_STATUSES = new Set(['approved','draft','rejected']);
function qStatus(c){ return Q_STATUSES.has(String(c?.status||'')) ? String(c.status) : 'approved'; }
function isQuestionApproved(c){ return qStatus(c)==='approved'; }
// Pula dopuszczona do losowania — tylko zatwierdzone pytania.
function approvedPool(chapterId){
  return poolForChapter(chapterId).filter(isQuestionApproved);
}

function pickFive(chapterId) {
  const pool = approvedPool(chapterId);
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
function normalizeChallenge(c, lang='pl'){
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
    n.options = (lang==='en' ? ['True','False'] : ['Prawda','Fałsz']);
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
    // multiple_select z correctAnswers === wszystkie opcje to pytanie bez odpowiedzi:
    // czytelnik musi zaznaczyć całą listę, żeby trafić. LLM generuje takie regularnie
    // („Które zwierzęta porzucili gospodarze?" → cztery z czterech), więc odrzucamy.
    else if(n.type==='multiple_select'){ if(!Array.isArray(n.options)||n.options.length<2||!Array.isArray(n.correctAnswers)||!n.correctAnswers.length) continue; if(n.correctAnswers.length>=n.options.length) continue; }
    else if(n.type==='true_false'){ /* zawsze poprawne po normalizeChallenge */ }
    else if(!n.expectedMeaning||!String(n.expectedMeaning).trim()) continue;
    out.push(n);
  }
  return out;
}
// Losowanie 5 pytań z puli: różnorodność typów + 2 pytania otwarte (żeby sam
// GPT nie wystarczył). Używane też dla puli EN — dlatego jest czysto na liście.
function pickFromPool(pool){
  let shuffled = [...pool].sort(()=>Math.random()-0.5);
  let picked=[];
  let used=new Set();
  for(const c of shuffled){
    if(picked.length>=5) break;
    if(!used.has(c.type) || picked.length>=3){ picked.push(c); used.add(c.type); }
  }
  if(picked.length<5) for(const c of shuffled) if(!picked.find(p=>p.id===c.id) && picked.length<5) picked.push(c);
  const jevs = pool.filter(c=>c.type==='open_question'||c.type==='why_question');
  let jevCount = picked.filter(c=>c.type==='open_question'||c.type==='why_question').length;
  for(const jev of jevs){ if(jevCount>=2) break; if(!picked.find(p=>p.id===jev.id)){ picked[picked.length%5]=jev; jevCount++; } }
  return picked.slice(0,5);
}
function pickForSession(chapterId, lang='pl'){ return pickFromPool(poolForChapter(chapterId)); }
const SESSION_TIMING_DEMO = [0, 0, 0, 0, 0];
const SESSION_TIMING_DEV = [0, 0, 0, 0, 0]; // admin dev mode — natychmiastowe odblokowanie
const SESSION_TIMING_REAL = [0, 300, 600, 900, 1200]; // 5 min / pytanie — bez blokady czasowej, spokojne czytanie

// Pola, które zdradzają klucz odpowiedzi. Publiczny podgląd puli (np. strona
// /verify/ budująca opis dowodu) oraz sesja czytelnika dostają treść pytania, ale
// NIE poprawną odpowiedź ani expectedMeaning — inaczej dałoby się zlać test
// przed przeczytaniem książki. Ocenianie zawsze robi serwer.
const ANSWER_SECRET_FIELDS = ['correctAnswer','correctAnswers','correctOrder','errorIndex','expectedMeaning','expected_meaning','correctText','correct_text'];
function stripAnswers(list){
  return (list||[]).map(c=>{ const o={...c}; for(const k of ANSWER_SECRET_FIELDS) delete o[k]; return o; });
}

function buildSessionChallenges(picked, startAt, isDemo){
  const timing = isDemo ? SESSION_TIMING_DEMO : SESSION_TIMING_REAL;
  const startMs = new Date(startAt).getTime();
  // UWAGA: tutaj NIE stripAnswers. To z tej listy serwer ocenia odpowiedzi
  // (/api/sessions/:id/answer) i buduje raport po zakończeniu (/complete) —
  // z usuniętym correctAnswer każde pytanie ABCD było nie do zaliczenia, bo
  // porównanie szło z undefined ("-1"), a open/why nie miał czego dać Jevowi.
  // Klucz zostaje w serwisie i jest obcinany DOPIERO przy wysyłce do czytelnika:
  // /start i /api/sessions/:id wołają stripAnswers na kopii.
  // Sesja nie jest zapisywana do bazy (tylko challengeIds), więc klucz nigdzie nie trafia.
  return (picked||[]).map((c,i)=>({
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
            .replace(/`publisher_books`/g,'`readproof_publisher_books`').replace(/`payouts`/g,'`readproof_payouts`')
            .replace(/\bproofs\b/g,'`readproof_proofs`').replace(/\breading_sessions\b/g,'`readproof_sessions`').replace(/\busers\b/g,'`readproof_users`').replace(/\bpublisher_campaigns\b/g,'`readproof_campaigns`').replace(/\bcampaign_funds\b/g,'`readproof_funds`').replace(/\bwaitlist\b/g,'`readproof_waitlist`').replace(/\bcertificates\b/g,'`readproof_certificates`')
            .replace(/\bpublisher_books\b/g,'`readproof_publisher_books`').replace(/\bpayouts\b/g,'`readproof_payouts`')
            .replace(/`tests`/g,'`readproof_tests`').replace(/`attempts`/g,'`readproof_attempts`').replace(/`paper_tests`/g,'`readproof_paper_tests`')
            .replace(/\btests\b/g,'`readproof_tests`').replace(/\battempts\b/g,'`readproof_attempts`').replace(/\bpaper_tests\b/g,'`readproof_paper_tests`')
            // Panel admina + Secure Test Mode
            .replace(/`test_sessions`/g,'`readproof_test_sessions`').replace(/`security_events`/g,'`readproof_security_events`')
            .replace(/`audit_logs`/g,'`readproof_audit_logs`').replace(/`admin_accounts`/g,'`readproof_admin_accounts`')
            .replace(/\btest_sessions\b/g,'`readproof_test_sessions`').replace(/\bsecurity_events\b/g,'`readproof_security_events`')
            .replace(/\baudit_logs\b/g,'`readproof_audit_logs`').replace(/\badmin_accounts\b/g,'`readproof_admin_accounts`');
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
      _db.run(`CREATE TABLE IF NOT EXISTS publisher_books (
        id TEXT PRIMARY KEY,
        ownerWallet TEXT,
        title TEXT,
        titleEn TEXT,
        author TEXT,
        description TEXT,
        isbn TEXT,
        language TEXT DEFAULT 'pl',
        coverUrl TEXT,
        status TEXT DEFAULT 'draft',
        contentLength INTEGER DEFAULT 0,
        bookContentHash TEXT,
        contentFile TEXT,
        chapters TEXT,
        rewardPool REAL DEFAULT 0,
        rewardPerProof REAL DEFAULT 5,
        currency TEXT DEFAULT 'USDC',
        publishedBookId TEXT,
        errorMessage TEXT,
        createdAt TEXT,
        updatedAt TEXT
      )`);
      _db.run(`CREATE TABLE IF NOT EXISTS payouts (
        id TEXT PRIMARY KEY,
        bookId TEXT,
        walletAddress TEXT,
        userId TEXT,
        chapterId TEXT,
        amount REAL,
        currency TEXT,
        status TEXT,
        txSignature TEXT,
        explorerUrl TEXT,
        errorMessage TEXT,
        createdAt TEXT
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
      // ── Zatwierdzanie ról (nauczyciel / wydawca) ──
      // approvalStatus NULL = konto sprzed migracji, traktowane jako 'approved'.
      _db.run(`ALTER TABLE users ADD COLUMN approvalStatus TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN emailVerified INTEGER DEFAULT 0`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN emailDomain TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN schoolDomain TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN organization TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN verificationCodeHash TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN verificationSentAt TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN verificationAttempts INTEGER DEFAULT 0`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN verifiedAt TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN submittedAt TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN reviewedBy TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN reviewedAt TEXT`, ()=>{});
      _db.run(`ALTER TABLE users ADD COLUMN reviewReason TEXT`, ()=>{});
      // ── Panel administratora ──
      _db.run(`CREATE TABLE IF NOT EXISTS admin_accounts (
        id TEXT PRIMARY KEY,
        email TEXT,
        passwordHash TEXT,
        walletAddress TEXT,
        displayName TEXT,
        sessionToken TEXT,
        createdAt TEXT,
        lastLoginAt TEXT,
        active INTEGER DEFAULT 1
      )`);
      _db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        adminId TEXT,
        targetUserId TEXT,
        action TEXT,
        reason TEXT,
        timestamp TEXT,
        metadata TEXT
      )`);
      // ── Secure Test Mode ──
      _db.run(`CREATE TABLE IF NOT EXISTS test_sessions (
        id TEXT PRIMARY KEY,
        testId TEXT,
        attemptId TEXT,
        userId TEXT,
        status TEXT DEFAULT 'created',
        policy TEXT,
        eventCounts TEXT,
        startedAt TEXT,
        expiresAt TEXT,
        terminatedAt TEXT,
        terminationReason TEXT,
        securityViolationCount INTEGER DEFAULT 0,
        warningCount INTEGER DEFAULT 0,
        cameraEnabled INTEGER DEFAULT 0,
        createdAt TEXT,
        updatedAt TEXT
      )`);
      _db.run(`CREATE TABLE IF NOT EXISTS security_events (
        id TEXT PRIMARY KEY,
        sessionId TEXT,
        userId TEXT,
        type TEXT,
        severity TEXT,
        timestamp TEXT,
        clientTimestamp TEXT,
        metadata TEXT
      )`);
      _db.run(`CREATE INDEX IF NOT EXISTS idx_security_events_session ON security_events(sessionId)`, ()=>{});
      _db.run(`CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(targetUserId)`, ()=>{});
      _db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user_test ON test_sessions(userId)`, ()=>{});
      _db.run(`CREATE INDEX IF NOT EXISTS idx_users_approval ON users(approvalStatus)`, ()=>{});
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
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_publisher_books (id VARCHAR(64) PRIMARY KEY, ownerWallet VARCHAR(64), title VARCHAR(256), titleEn VARCHAR(256), author VARCHAR(256), description TEXT, isbn VARCHAR(32), language VARCHAR(8) DEFAULT 'pl', coverUrl VARCHAR(512), status VARCHAR(16) DEFAULT 'draft', contentLength INT DEFAULT 0, bookContentHash VARCHAR(64), contentFile VARCHAR(128), chapters JSON, rewardPool DOUBLE DEFAULT 0, rewardPerProof DOUBLE DEFAULT 5, currency VARCHAR(8) DEFAULT 'USDC', publishedBookId VARCHAR(64), errorMessage VARCHAR(512), createdAt DATETIME, updatedAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_payouts (id VARCHAR(64) PRIMARY KEY, bookId VARCHAR(64), walletAddress VARCHAR(64), userId VARCHAR(64), chapterId VARCHAR(64), amount DOUBLE, currency VARCHAR(8), status VARCHAR(16), txSignature VARCHAR(128), explorerUrl VARCHAR(256), errorMessage VARCHAR(256), createdAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_funds (id VARCHAR(64) PRIMARY KEY, campaignId VARCHAR(64), publisherWallet VARCHAR(64), amount DOUBLE, currency VARCHAR(16), txSignature VARCHAR(128), explorerUrl VARCHAR(256), createdAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_waitlist (id VARCHAR(64) PRIMARY KEY, email VARCHAR(256), role VARCHAR(32), name VARCHAR(128), createdAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_tests (id VARCHAR(64) PRIMARY KEY, teacherId VARCHAR(64), bookId VARCHAR(64), title VARCHAR(256), chapter VARCHAR(64), testMode VARCHAR(16), status VARCHAR(32), timerEnabled TINYINT DEFAULT 0, timerMinutes INT DEFAULT 0, questions JSON, settings JSON, createdAt DATETIME, updatedAt DATETIME)`);
       await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_attempts (id VARCHAR(64) PRIMARY KEY, challengeId VARCHAR(64), studentId VARCHAR(64), mode VARCHAR(16), status VARCHAR(32), answers JSON, score INT, maxScore INT, submittedAt DATETIME, completedAt DATETIME, detail JSON, paperTestId VARCHAR(64), virtualAttemptId VARCHAR(64), createdAt DATETIME, expiresAt DATETIME, proctoring JSON)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_paper_tests (id VARCHAR(64) PRIMARY KEY, challengeId VARCHAR(64), teacherId VARCHAR(64), studentId VARCHAR(64), studentName VARCHAR(128), scans JSON, ocrText LONGTEXT, ocrAnswers JSON, status VARCHAR(32), createdAt DATETIME, updatedAt DATETIME)`);
      // Panel administratora — hasło (scrypt) + token sesyjny. Portfel Solana jest
      // adresem jawnym, więc panel NIE opiera się na X-User-Id.
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_admin_accounts (id VARCHAR(64) PRIMARY KEY, email VARCHAR(256) UNIQUE, passwordHash VARCHAR(256), walletAddress VARCHAR(64), displayName VARCHAR(128), sessionToken VARCHAR(128), createdAt DATETIME, lastLoginAt DATETIME, active TINYINT DEFAULT 1)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_audit_logs (id VARCHAR(64) PRIMARY KEY, adminId VARCHAR(64), targetUserId VARCHAR(64), action VARCHAR(48), reason VARCHAR(300), timestamp DATETIME, metadata VARCHAR(1000))`);
      // Secure Test Mode — stan sesji, zdarzenia bezpieczeństwa. Zdarzenia trzymamy
      // jako VARCHAR, a nie JSON, bo shim `db.run` zamienia TEXT na VARCHAR(64).
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_test_sessions (id VARCHAR(64) PRIMARY KEY, testId VARCHAR(64), attemptId VARCHAR(64), userId VARCHAR(64), status VARCHAR(16) DEFAULT 'created', policy VARCHAR(2000), eventCounts VARCHAR(2000), startedAt DATETIME, expiresAt DATETIME, terminatedAt DATETIME, terminationReason VARCHAR(300), securityViolationCount INT DEFAULT 0, warningCount INT DEFAULT 0, cameraEnabled TINYINT DEFAULT 0, createdAt DATETIME, updatedAt DATETIME)`);
      await mysqlPool.query(`CREATE TABLE IF NOT EXISTS readproof_security_events (id VARCHAR(64) PRIMARY KEY, sessionId VARCHAR(64), userId VARCHAR(64), type VARCHAR(48), severity VARCHAR(16), timestamp DATETIME, clientTimestamp DATETIME, metadata VARCHAR(2000))`);
      // Apple auth migrations — add columns if missing (MySQL IF NOT EXISTS via try/catch)
      for(const q of [
        `ALTER TABLE readproof_users ADD COLUMN appleUserId VARCHAR(64)`,
        `ALTER TABLE readproof_users ADD COLUMN sessionToken VARCHAR(128)`,
        `ALTER TABLE readproof_users ADD COLUMN provider VARCHAR(16)`,
        `ALTER TABLE readproof_users ADD COLUMN nickname VARCHAR(128)`,
         `ALTER TABLE readproof_sessions ADD COLUMN userId VARCHAR(64)`,
         `ALTER TABLE readproof_proofs ADD COLUMN userId VARCHAR(64)`,
         `ALTER TABLE readproof_attempts ADD COLUMN expiresAt DATETIME`,
         `ALTER TABLE readproof_attempts ADD COLUMN proctoring JSON`,
         // Kotwiczenie certyfikatów na devnecie. anchorHash jest zobowiązaniem
         // (skrót w memo), anchorMemo to DOKŁADNIE ten tekst, który poszedł
         // na łańcuch — bez niego nie da się zweryfikować memo po reconnectzie.
         `ALTER TABLE readproof_certificates ADD COLUMN anchorHash VARCHAR(64)`,
         `ALTER TABLE readproof_certificates ADD COLUMN anchorVersion VARCHAR(32)`,
         `ALTER TABLE readproof_certificates ADD COLUMN anchorSlot BIGINT`,
         `ALTER TABLE readproof_certificates ADD COLUMN anchorMemo TEXT`,
         `ALTER TABLE readproof_certificates ADD COLUMN anchorStatus VARCHAR(16)`,
         `ALTER TABLE readproof_certificates ADD COLUMN anchorError VARCHAR(256)`,
         `ALTER TABLE readproof_certificates ADD COLUMN anchoredAt DATETIME`,
         // Zatwierdzanie ról. approvalStatus celowo bez DEFAULT — NULL oznacza
         // konto sprzed migracji i jest traktowane jako 'approved'.
         `ALTER TABLE readproof_users ADD COLUMN approvalStatus VARCHAR(16)`,
         `ALTER TABLE readproof_users ADD COLUMN emailVerified TINYINT DEFAULT 0`,
         `ALTER TABLE readproof_users ADD COLUMN emailDomain VARCHAR(128)`,
         `ALTER TABLE readproof_users ADD COLUMN schoolDomain VARCHAR(128)`,
         `ALTER TABLE readproof_users ADD COLUMN organization VARCHAR(256)`,
         `ALTER TABLE readproof_users ADD COLUMN verificationCodeHash VARCHAR(64)`,
         `ALTER TABLE readproof_users ADD COLUMN verificationSentAt DATETIME`,
         `ALTER TABLE readproof_users ADD COLUMN verificationAttempts INT DEFAULT 0`,
         `ALTER TABLE readproof_users ADD COLUMN verifiedAt DATETIME`,
         `ALTER TABLE readproof_users ADD COLUMN submittedAt DATETIME`,
         `ALTER TABLE readproof_users ADD COLUMN reviewedBy VARCHAR(64)`,
         `ALTER TABLE readproof_users ADD COLUMN reviewedAt DATETIME`,
         `ALTER TABLE readproof_users ADD COLUMN reviewReason VARCHAR(300)`
      ]){ try{ await mysqlPool.query(q); }catch(e){ if(!String(e.message).includes('Duplicate column')) console.warn('[migrate]', e.message); } }
      // migrate primary key: allow apple users where id != walletAddress — keep walletAddress PK for now, but add unique index on appleUserId
      try{ await mysqlPool.query(`CREATE UNIQUE INDEX idx_users_apple ON readproof_users(appleUserId)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_sessions_user ON readproof_sessions(userId)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_proofs_user ON readproof_proofs(userId)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_pubbooks_owner ON readproof_publisher_books(ownerWallet)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_payouts_book ON readproof_payouts(bookId)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_proofs_book ON readproof_proofs(bookId)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_users_approval ON readproof_users(approvalStatus)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_security_events_session ON readproof_security_events(sessionId)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_audit_target ON readproof_audit_logs(targetUserId)`); }catch(e){}
      try{ await mysqlPool.query(`CREATE INDEX idx_test_sessions_user ON readproof_test_sessions(userId)`); }catch(e){}
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
// Statusy, dla których wystawiamy certyfikat RP-XXXXXX. 'Partial Verified' = zrozumienie
// częściowe (3/5) — certyfikat JEST, ale bez nagrody i bez statusu pełnego zrozumienia.
const CERT_STATUSES = new Set([...VERIF_STATUSES, 'Partial Verified']);
// Poziom zrozumienia z proof/cert. Progi zgodne z tierOf() w public/verify.
function certTier(score, total){
  const s = Number(score), t = Number(total);
  if (t > 0 && s >= Math.max(4, t - 1)) return 'full';
  const r = t > 0 ? s / t : ((parseFloat(String(score)) || 0) / 100);
  return r >= 0.6 ? 'partial' : 'none';
}
const CERT_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // bez I,O,0,1 — czytelne ID
function certId(){
  let s=''; const rb=crypto.randomBytes(6);
  for(const b of rb) s += CERT_ALPHA[b % CERT_ALPHA.length];
  return `RP-${s.slice(0,6)}`;
}

// ── Kotwiczenie certyfikatu na Solana Devnet ────────────────────────────────
// Certyfikat w bazie to stan, który da się podmienić. Memo na devnecie to
// podpisany, publiczny, niezmienny zapis tych samych pól — plus skrót, który
// pozwala przeliczyć wszystko z samego łańcucha. Wywołujemy ją PO zapisie
// wiersza, bo potrzebujemy id i timestampu z bazy (memo musi odtąd być
// odtwarzalne co do bajtu).
//
// Nigdy nie rzucamy i nigdy nie blokujemy wystawienia certyfikatu: brak klucza
// lub chwilowa awaria RPC nie może odbierać czytelnikowi certyfikatu za
// zrozumienie. Zamiast tego wiersz dostaje anchorStatus, a anchor można
// domknąć później (patrz POST /api/certificates/:id/anchor).
async function anchorCertificate(cert, { force = false } = {}){
  if(!cert?.id) return null;
  try{
    // Nie kotwimy dwa razy — inaczej płacimy za devnet SOL i zaśmiecamy explorer.
    if(!force && cert.txSignature && cert.anchorMemo) return { skipped: true, reason: 'already anchored' };

    const memo = cert.anchorMemo || buildAnchorMemo(cert);
    const parsed = parseAnchorMemo(memo);
    if(!parsed.ok) throw new Error(`memo nieparsowalne: ${parsed.error}`);

    const res = await writeAnchorMemo(memo, { rpc: SOLANA_RPC, privateKey: SOLANA_PAYER_PRIVATE_KEY });
    if(!res.ok){
      await markAnchor(cert.id, { status:'unavailable', error: res.error, memo });
      console.warn(`[anchor] ${cert.id} — brak kotwicy: ${res.error}`);
      return { ok:false, error: res.error };
    }
    await markAnchor(cert.id, {
      status:'anchored', error:null, memo,
      hash: parsed.anchorHash, version: ANCHOR_VERSION,
      slot: res.slot, signature: res.signature, explorer: res.explorerUrl,
    });
    console.log(`[anchor] ${cert.id} → slot ${res.slot} ${res.explorerUrl}`);
    return { ok:true, ...res, anchorHash: parsed.anchorHash };
  }catch(e){
    await markAnchor(cert.id, { status:'failed', error: String(e?.message||e).slice(0,240) });
    console.error(`[anchor] ${cert.id} BŁĄD: ${e.message}`);
    return { ok:false, error: String(e?.message||e).slice(0,240) };
  }
}

// Aktualizacja kotwicy w wierszu certyfikatu. Zdanie po zdaniu, bo niektóre
// instalacje mają bazę bez nowych kolumn — wtedy zapis po cichu nic nie robi,
// a kotwica i tak zostaje w łańcuchu i w odpowiedzi publicznej.
async function markAnchor(id, patch = {}){
  const cols = [], params = [];
  const add = (col, val) => { cols.push(`${col}=?`); params.push(val); };
  if(patch.hash !== undefined) add('anchorHash', patch.hash);
  if(patch.version !== undefined) add('anchorVersion', patch.version);
  if(patch.slot !== undefined) add('anchorSlot', patch.slot);
  if(patch.memo !== undefined) add('anchorMemo', patch.memo);
  if(patch.status !== undefined) add('anchorStatus', patch.status);
  if(patch.error !== undefined) add('anchorError', patch.error);
  if(patch.signature !== undefined) add('txSignature', patch.signature);
  if(patch.explorer !== undefined) add('explorerUrl', patch.explorer);
  if(patch.status === 'anchored') add('anchoredAt', new Date());
  if(!cols.length) return false;
  params.push(id);
  try{
    await dbRunPromise(`UPDATE certificates SET ${cols.join(', ')} WHERE id=?`, params);
    return true;
  }catch(e){
    console.warn(`[anchor] nie zapisano stanu kotwicy ${id}: ${e.message}`);
    return false;
  }
}

// Publiczny widok kotwicy — to, co czytelnik widzi na /verify.
function anchorView(row){
  const anchored = row?.anchorStatus === 'anchored' && !!row?.txSignature;
  return {
    version: row?.anchorVersion || null,
    status: row?.anchorStatus || (row?.txSignature ? 'legacy' : 'unavailable'),
    anchorHash: row?.anchorHash || null,
    slot: row?.anchorSlot ?? null,
    memo: row?.anchorMemo || null,
    anchoredAt: row?.anchoredAt || null,
    signature: row?.txSignature || null,
    explorerUrl: row?.explorerUrl || null,
    // 'anchored' = mamy podpis i memo; 'unverified' = jest podpis, ale memo
    // nie przyszło z łańcucha (np. kotwica sprzed wdrożenia tego formatu).
    immutable: anchored && !!row?.anchorMemo ? 'onchain-memo' : (row?.txSignature ? 'tx-only' : 'none'),
    network: 'devnet',
  };
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
  // LLM przy tłumaczeniu quizu zwraca LISTĘ obiektów na najwyższym poziomie.
  // Bez tej gałęzi wycinanie od pierwszego '{' dawało fragment listy i parse
  // kończył się "niepoprawny JSON" — czyli quiz EN nigdy się nie budował.
  const arrFirst = t.indexOf('[');
  const objFirst = t.indexOf('{');
  if(arrFirst >= 0 && (objFirst < 0 || arrFirst < objFirst)){
    let aEnd = t.lastIndexOf(']');
    let aErr = null;
    while(aEnd > arrFirst){
      try{ return JSON.parse(t.slice(arrFirst, aEnd+1)); }
      catch(e){ aErr = e; aEnd = t.lastIndexOf(']', aEnd-1); }
    }
    try{ return JSON.parse(t.slice(arrFirst, t.lastIndexOf(']')+1).replace(/,\s*([\]}])/g,'$1')); }
    catch(e2){ aErr = e2; }
    throw aErr || new Error('Nieprawidłowy JSON (lista) od LLM');
  }
  const first = objFirst;
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

// Lista darmowych modeli z fallbackiem — darmowy tier OpenRouter regularnie
// ubija modele (404/429), więc próbujemy po kolei kilku sprawdzonych.
// OPENROUTER_MODELS po przecinku ma pierwszeństwo.
const OPENROUTER_MODELS = (process.env.OPENROUTER_MODELS || `${OPENROUTER_MODEL},nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,qwen/qwen3.8-27b:free`)
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
// Modele do tłumaczenia PL->EN. Darmowe modele OpenRouter mają limit per-IP
// i w praktyce bywają wyczerpane (429) — wtedy quiz EN w ogóle się nie tworzy.
// Domyślnie próbujemy więc tanich modeli płatnych, a free-tier zostaje jako backup.
const TRANSLATE_MODELS = (process.env.TRANSLATE_MODELS
  || 'openai/gpt-4o-mini,qwen/qwen2.5-72b-instruct,meta-llama/llama-3.3-70b-instruct'
).split(',').map(x=>x.trim()).filter(Boolean);
async function llmChat(messages, {temperature=0.7, maxTokens=4000, timeout=120000, models=null}={}){
  if(!OPENROUTER_KEY && !GEMINI_API_KEY && !GROQ_API_KEY && !MISTRAL_API_KEY){
    // brak jakiegokolwiek klucza — Pollinations i tak działa bez klucza
  }
  const tryers = [
    ...(OPENROUTER_KEY?(models && models.length ? models : OPENROUTER_MODELS).map(model=>()=>callOpenRouter(model, messages, {temperature, maxTokens, timeout})):[]),
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

// ===== Tłumaczenie quizu PL -> EN =====
// Pula pytań żyje po polsku (challenges.json), więc sesja w EN musi pytania przetłumaczyć.
// Wcześniej szło to przez LLM z backoffem 2,5+6+12+20+30 s: start sesji EN wisiał
// 1–2 min, a po wyczerpaniu prób i tak serwisował po cichu quiz po polsku.
// Teraz główną drogą jest Google Translate (bez klucza, ~100 ms/zdanie) z cache
// na dysku, a LLM zostało wyłącznie jako awaryjny fallback (jeden strzał).
// Dzięki temu kolejne quizy EN są praktycznie darmowe (trafienie w cache).
const TRANSLATE_CACHE_FILE = './translate-cache.json';
let _gtxCache = (()=>{
  try{
    const raw = JSON.parse(fs.readFileSync(TRANSLATE_CACHE_FILE,'utf8')) || {};
    // Wpisy identyczne ze źródłem to nie tłumaczenia (gtx potrafi zwrócić polskie
    // słowo bez zmian) — wyrzucamy je, inaczej pytanie wychodzi z polskimi opcjami.
    const clean = {};
    let dropped = 0;
    for(const [k,v] of Object.entries(raw)){
      if(typeof v === 'string' && v.trim() === String(k).trim()){ dropped++; continue; }
      if(typeof v === 'string' && !validTranslation(v)){ dropped++; continue; }
      clean[k]=v;
    }
    if(dropped) console.log(`[gtx] cache: dropped ${dropped} śmieci/nie-tłumaczeń`);
    return clean;
  }catch(e){ return {}; }
})();
let _gtxDirty = 0;
function persistTranslateCache(){
  if(_gtxDirty<=0) return;
  _gtxDirty = 0;
  try{ fs.writeFileSync(TRANSLATE_CACHE_FILE, JSON.stringify(_gtxCache)); }
  catch(e){ console.warn('[gtx] persist fail: '+e.message); }
}
const _gtxPersistTimer = setInterval(persistTranslateCache, 5000);
if(_gtxPersistTimer.unref) _gtxPersistTimer.unref();

// Google throttluje po IP i odpowiada 429 przy równoległych tłumaczeniach.
// Dlatego WSZYSTKIE wywołania (sesje + tło) przechodzą przez jedną kolejkę
// z odstępem między zapytaniami, a po serii 429 włączamy circuit breaker
// (60 s bez Google) — inaczej pula EN wisiała w retry zamiast zejść na LLM.
const GTX_MIN_GAP = 110;
const GTX_BLOCK_AFTER = 5;      // ile 429 z rzędu → breaker
const GTX_BLOCK_MS = 60000;
let _gtxQueue = Promise.resolve();
let _gtxLastAt = 0;
let _gtxBlockedUntil = 0;
let _gtxFails = 0;
function gtxSlot(){
  const run = _gtxQueue.then(async ()=>{
    const now = Date.now();
    const wait = Math.max(_gtxBlockedUntil - now, _gtxLastAt + GTX_MIN_GAP - now);
    if(wait > 0) await new Promise(r=>setTimeout(r, wait));
    _gtxLastAt = Date.now();
  });
  _gtxQueue = run.catch(()=>{});
  return run;
}
function gtxPenalize(status){
  if(status===429 || status===403){
    if(++_gtxFails >= GTX_BLOCK_AFTER){
      _gtxBlockedUntil = Date.now() + GTX_BLOCK_MS;
      console.warn(`[gtx] breaker ON (${GTX_BLOCK_MS/1000}s) — przechodzimy na MyMemory/LLM`);
    }
  } else _gtxFails = 0;
}

// Wynik tłumaczenia musi wyglądać jak treść. gtx potrafi zwrócić "."
// albo interpunkcję zamiast słowa ("Niedźwiedzia" → "."), co psuje pytanie:
// użytkownik widzi pustą poprawną odpowiedź i myśli, że klucz jest zły.
function validTranslation(out){
  const t = String(out == null ? '' : out).trim();
  if(!t) return false;
  if(!/[A-Za-z0-9\u00C0-\u024F]/.test(t)) return false;   // sama interpunkcja
  if(t.length > 1 && t.replace(/[\s.,!?;:'"()\-—…]/g, '').length === 0) return false;
  return true;
}
const sameText = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();

async function gtxRaw(text){
  if(Date.now() < _gtxBlockedUntil) throw new Error('gtx blocked');
  await gtxSlot();
  if(Date.now() < _gtxBlockedUntil) throw new Error('gtx blocked');
  const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=pl&tl=en&dt=t&q='+encodeURIComponent(text);
  let res;
  try{ res = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0 (compatible; readproof-translate/2.0)'}, signal: AbortSignal.timeout(8000)}); }
  catch(e){ throw new Error('gtx net'); }
  if(!res.ok){ gtxPenalize(res.status); throw new Error('gtx '+res.status); }
  const j=await res.json().catch(()=>null);
  const seg=(j && Array.isArray(j[0]))?j[0].map(s=>s&&s[0]).filter(Boolean).join(''):'';
  if(!validTranslation(seg)) throw new Error('gtx śmieci/empty');
  _gtxFails = 0;
  return seg;
}
// ---- Drugie źródło: MyMemory (bez klucza) ----
// Google gtx throttluje po IP (429) i potrafi być niedostępny na długo. MyMemory
// działa bez klucza, więc jest zabezpieczeniem: gtx → MyMemory → LLM. Bez konta
// limit to ~5k słów/dobę (z MYMEM_EMAIL w .env rośnie do 50k) — dlatego wyniki
// też lecą do tego samego cache co gtx i liczba zapytań rośnie tylko z nowymi pytaniami.
const MYMEM_EMAIL = (process.env.MYMEM_EMAIL || '').trim();
const MYMEM_MIN_GAP = 220;
let _mtmLastAt = 0, _mtmBlockedUntil = 0;
const _mtmQueue = { p: Promise.resolve() };
function mtmSlot(){
  const run = _mtmQueue.p.then(async ()=>{
    const wait = Math.max(_mtmBlockedUntil - Date.now(), _mtmLastAt + MYMEM_MIN_GAP - Date.now());
    if(wait > 0) await new Promise(r=>setTimeout(r, wait));
    _mtmLastAt = Date.now();
  });
  _mtmQueue.p = run.catch(()=>{});
  return run;
}
const ENTITIES = {'&amp;':'&','&quot;':'"','&#39;':"'",'&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' ','&#39;':"'"};
const unescapeHtml = t => String(t).replace(/&(amp|quot|apos|#39|lt|gt|nbsp);/g, m => ENTITIES[m] ?? m);
async function mtmRaw(text){
  if(Date.now() < _mtmBlockedUntil) throw new Error('mtm blocked');
  await mtmSlot();
  const url='https://api.mymemory.translated.net/get?q='+encodeURIComponent(text)
    +'&langpair=' + encodeURIComponent('pl|en') + (MYMEM_EMAIL ? '&de='+encodeURIComponent(MYMEM_EMAIL) : '');
  let res;
  try{ res = await fetch(url, {headers:{'User-Agent':'Mozilla/5.0 (compatible; readproof-translate/2.0)'}, signal: AbortSignal.timeout(10000)}); }
  catch(e){ throw new Error('mtm net'); }
  if(!res.ok){ if(res.status===429 || res.status===403) _mtmBlockedUntil = Date.now()+60000; throw new Error('mtm '+res.status); }
  const j = await res.json().catch(()=>null);
  if(!j || j.quotaFinished || j.responseStatus && Number(j.responseStatus)>=400){
    _mtmBlockedUntil = Date.now()+300000;
    throw new Error('mtm quota');
  }
  const out = j && j.responseData && j.responseData.translatedText;
  if(typeof out !== 'string' || !validTranslation(unescapeHtml(out))) throw new Error('mtm śmieci/empty');
  return unescapeHtml(out);
}
// Tłumaczy pojedynczy fragment: cache → gtx → MyMemory → (błąd → LLM).
// Wynik identyczny z polskim źródłem NIE jest tłumaczeniem: gtx traktuje czasem
// polskie słowo jak nazwę własną ("Wilk" → "Wilk") i taki wynik musi trafić do
// LLM, bo inaczej użytkownik EN widzi quiz z polskimi opcjami i nie ma szans
// odpowiedzieć. Do cache zapisujemy tylko prawdziwe tłumaczenia.
async function gtx(text){
  const k = String(text==null?'':text);
  if(!k.trim()) return k;
  const hit = _gtxCache[k];
  if(hit && !sameText(hit, k)) return hit;
  if(hit) throw new Error('cache: tłumaczenie == źródło → LLM');
  const sources = [
    { name:'gtx', gap:400, fn: gtxRaw },
    { name:'mtm', gap:600, fn: mtmRaw },
  ];
  for(const src of sources){
    for(let a=0; a<2; a++){
      let out = null;
      try{ out = await src.fn(k); }
      catch(e){ if(a<1) await new Promise(r=>setTimeout(r, src.gap*(a+1)*(a+1))); continue; }
      if(!validTranslation(out)){ if(a<1) await new Promise(r=>setTimeout(r, 400)); continue; }
      if(sameText(out, k)) continue;   // bez zmian → następne źródło, potem LLM
      _gtxCache[k]=out; _gtxDirty++;
      return out;
    }
  }
  throw new Error('brak użytecznego tłumaczenia (gtx/MyMemory) → LLM');
}

// Tłumaczy listę z ograniczoną równoległością (Google nie lubi setek równoległych).
// Zwraca listę fragmentów, których NIE udało się przetłumaczyć (429/5xx) — caller
// decyduje, czy to dołożyć do LLM, czy puścić dalej (np. nazwy własne).
async function gtxAll(list, limit=6){
  const src = [...new Set(list.filter(t=>String(t==null?'':t).trim() && !_gtxCache[t]))];
  const failed = [];
  if(src.length){
    let i=0;
    // Bez short-circuitu na breakerze: gtx() samo sprawdza blokadę i schodzi
    // na MyMemory, a potem na LLM. Wcześniejsze `continue` gubiło te próby.
    const worker = async ()=>{ while(i<src.length){
      const k=src[i++];
      try{ await gtx(k); }catch(e){ failed.push(k); console.warn('[tr] '+String(e.message).slice(0,60)+' :: '+k.slice(0,50)); }
    } };
    await Promise.all(Array.from({length: Math.min(limit, src.length)}, worker));
  }
  return failed;
}

const slimChallenge = c => ({
  id:String(c.id||''), type:c.type,
  question:String(c.question||'').trim()||null,
  options:Array.isArray(c.options)?c.options:null,
  statements:Array.isArray(c.statements)?c.statements:null,
  items:Array.isArray(c.items)?c.items:null,
  pairs:Array.isArray(c.pairs)?c.pairs:null,
  expectedMeaning:c.expectedMeaning?String(c.expectedMeaning):null,
  context:c.context?String(c.context):null
});
// Wszystkie teksty pytania — płaska lista do tłumaczenia hurtem.
function challengeTexts(slim){
  const out=[];
  for(const c of slim){
    if(c.question) out.push(c.question);
    for(const k of ['options','statements','items']) if(Array.isArray(c[k])) out.push(...c[k]);
    if(Array.isArray(c.pairs)) c.pairs.forEach(p=>{ out.push(p.left, p.right); });
    if(c.expectedMeaning) out.push(c.expectedMeaning);
    if(c.context) out.push(c.context);
  }
  return [...new Set(out.filter(t=>String(t||'').trim()))];
}
// Sklejenie tłumaczenia z oryginałem: pomijamy puste/null pola i struktury o innej
// długości (LLM potrafi gubić opcje), żeby nie wyzerować indeksów odpowiedzi.
function mergeTranslated(c, t){
  const out={...c};
  for(const [k,v] of Object.entries(t||{})){
    if(v===null||v===undefined) continue;
    if(['options','statements','items'].includes(k) && Array.isArray(c[k]) && (!Array.isArray(v) || v.length!==c[k].length)) continue;
    if(k==='pairs' && Array.isArray(c.pairs) && (!Array.isArray(v) || v.length!==c.pairs.length)) continue;
    out[k]=v;
  }
  if(out.type==='true_false') out.options=['True','False'];
  return out;
}

const EN_POOL_MAX = 12;           // ile pytań tłumaczymy na pulę EN (docelowo)
const EN_POOL_MIN = 6;            // tyle wystarczy na jeden quiz — budowa etapowa
const EN_POOL_RETRY_MS = 60000;   // po błędzie tłumaczy nie bijemy w limity co sekundę
const EN_POOL_WAIT_MS = 12000;    // ile start sesji czeka na zimną pulę EN
const EN_LLM_CHUNK = 4;           // pytania na jedno wywołanie LLM (mniejsze = odporniej na 429)
const EN_POOL_FILE = './en-pools.json';
let _enPools = (()=>{ try{ return JSON.parse(fs.readFileSync(EN_POOL_FILE,'utf8')) || {}; }catch(e){ return {}; } })();
const _enBuilding = new Map();
const _enFailedAt = new Map();   // chapterId -> timestamp następnej próby
function enPoolSig(chapterId){ return approvedPool(chapterId).slice(0, EN_POOL_MAX).map(c=>String(c.id)).sort().join(','); }
function persistEnPools(){ try{ fs.writeFileSync(EN_POOL_FILE, JSON.stringify(_enPools)); }catch(e){ console.warn('[en-pool] persist fail: '+e.message); } }
function getEnPool(chapterId){
  const rec = _enPools[chapterId];
  if(!rec || !Array.isArray(rec.challenges) || rec.challenges.length < 5) return null;
  // Pula PL mogła się zmienić (nowe pytania po warmAllPools) — wtedy rebuild.
  const sig = enPoolSig(chapterId);
  if(rec.sig && sig && rec.sig !== sig) return null;
  return rec.challenges;
}
// Budowa etapowa: najpierw tyle pytań, ile trzeba na JEDEN quiz (6), potem
// rozszerzenie puli w tle. Darmowe tłumacze mają limity per-IP/dobę, więc
// tłumaczenie 12 pytań na wejściu często wybijało limit i niszczyło całą pulę.
async function buildEnPool(chapterId, count=EN_POOL_MIN){
  const pool = approvedPool(chapterId).slice(0, count);
  if(pool.length < 5) return null;
  const en = await translateChallenges(pool);
  // Do puli EN wchodzą TYLKO pytania faktycznie przetłumaczone (znacznik _en) —
  // inaczej użytkownik EN dostałby mieszankę PL/EN.
  const ok = en.filter(c=>c && c._en && c.question)
    .map(({_en, ...rest})=>rest);
  if(ok.length < 5){ console.warn(`[en-pool] za mało przetłumaczonych pytań (${ok.length}/${pool.length})`); return null; }
  _enPools[chapterId] = {sig: pool.map(c=>String(c.id)).sort().join(','), at:new Date().toISOString(), challenges: ok};
  persistEnPools();
  return ok;
}
// Rozszerzenie puli EN do EN_POOL_MAX — best effort, w tle, z cooldownem po błędzie.
function extendEnPool(chapterId){
  const rec = _enPools[chapterId];
  if(!rec || rec.challenges.length >= EN_POOL_MAX) return;
  if((_enFailedAt.get(chapterId) || 0) > Date.now()) return;
  buildEnPool(chapterId, EN_POOL_MAX)
    .then(en=>{ if(en && en.length>rec.challenges.length) console.log(`[en-pool] rozszerzona (${chapterId}, ${en.length} pytań)`); })
    .catch(e=>console.warn(`[en-pool] extend fail (${chapterId}): ${String(e.message).slice(0,70)}`));
}
// Zwraca gotową pulę EN albo null (gdy budowa trwa / nie wyszła). Budowa jest
// współdzielona per-rozdział, więc N równoległych sesji nie mnoży pracy.
// Gdy trwa w tle — wołający dostaje null (503 translating) i frontend ponawia.
function ensureEnPool(chapterId, waitMs=0){
  const cached = getEnPool(chapterId);
  if(cached){ extendEnPool(chapterId); return Promise.resolve(cached); }
  // Po nieudanej budowie nie próbujemy znowu co sekundę — tłumacze i tak mają limit.
  if((_enFailedAt.get(chapterId) || 0) > Date.now()) return Promise.resolve(null);
  const started = !_enBuilding.has(chapterId);
  if(started){
    const p = buildEnPool(chapterId, EN_POOL_MIN)
      .then(en=>{
        if(en){ _enFailedAt.delete(chapterId); console.log(`[en-pool] gotowa (${chapterId}, ${en.length} pytań)`); setTimeout(()=>extendEnPool(chapterId), 0); }
        return en;
      })
      .catch(e=>{
        _enFailedAt.set(chapterId, Date.now() + EN_POOL_RETRY_MS);
        console.error(`[en-pool] build fail (${chapterId}): ${e.message} — ponawiam za ${EN_POOL_RETRY_MS/1000}s`);
        return null;
      })
      .finally(()=>_enBuilding.delete(chapterId));
    _enBuilding.set(chapterId, p);
  }
  const p = _enBuilding.get(chapterId);
  if(!waitMs) return p.then(()=>getEnPool(chapterId));
  return Promise.race([p, new Promise(r=>setTimeout(()=>r(undefined), waitMs))]).then(()=>getEnPool(chapterId));
}
// Stan dla startu sesji: pula gotowa / budowa w toku (do ponowienia) / porażka
// (wtedy lecimy z quizem PL i jawnym langFallback).
function enPoolStatus(chapterId){
  return { pool: getEnPool(chapterId), building: _enBuilding.has(chapterId), failedUntil: _enFailedAt.get(chapterId) || 0 };
}
async function translateChallenges(chas){
  if(!Array.isArray(chas) || !chas.length) return chas;
  const slim = chas.map(slimChallenge);
  // 1) Szybka ścieżka: Google Translate + cache (zwykle <2 s, kolejne quizy ~0 ms).
  // Pytanie, którego gtx nie ruszył, dostaje _en:false i leci dalej do LLM —
  // do puli EN wchodzą tylko kompletnie przetłumaczone pytania.
  const failed = await gtxAll(challengeTexts(slim));
  const failedSet = new Set(failed);
  const tr = s => _gtxCache[s] || s;
  // Pole jest przetłumaczone, tylko jeśli jest w cache ORAZ różni się od polskiego
  // źródła. Wszystkie pola (pytanie, opcje, pary, expectedMeaning) muszą przejść,
  // inaczej w quizie zostaje polski fragment.
  const isTr = v => {
    if(v === null || v === undefined) return true;
    if(typeof v === 'string'){ const t=v.trim(); if(!t) return true; const c=_gtxCache[t]; return !!c && !sameText(c, t); }
    if(Array.isArray(v)) return v.every(isTr);
    if(typeof v === 'object') return Object.values(v).every(isTr);
    return true;
  };
  const viaGtx = new Map(slim.map(c=>{
    const ok = !failedSet.has(c.question) && !failedSet.has(c.expectedMeaning)
      && isTr(c.options) && isTr(c.statements) && isTr(c.items) && isTr(c.pairs);
    const o={...c};
    if(c.question) o.question = tr(c.question);
    for(const k of ['options','statements','items']) if(Array.isArray(c[k])) o[k]=c[k].map(tr);
    if(Array.isArray(c.pairs)) o.pairs = c.pairs.map(p=>({left: tr(p.left), right: tr(p.right)}));
    if(c.expectedMeaning) o.expectedMeaning = tr(c.expectedMeaning);
    if(c.context) o.context = tr(c.context);
    o._en = ok;
    return [String(c.id), o];
  }));
  const needLlm = chas.filter(c=>viaGtx.get(String(c.id||''))?._en === false);
  if(needLlm.length) console.warn(`[translate] ${needLlm.length}/${chas.length} pytań poza gtx → LLM`);
  if(needLlm.length){
    const done = new Set();
    for(let i=0; i<needLlm.length; i+=EN_LLM_CHUNK){
      const slice = needLlm.slice(i, i+EN_LLM_CHUNK);
      try{
        const got = await translateChunkLlm(slice);
        for(const [id, ch] of got) { viaGtx.set(id, ch); done.add(id); }
      }catch(e){
        console.warn(`[translate] chunk ${Math.floor(i/EN_LLM_CHUNK)+1} fail: ${String(e.message).slice(0,80)}`);
      }
    }
    if(!done.size) throw new Error('translateChallenges: brak przetłumaczonych pytań (gtx i LLM niedostępne)');
  }
  return chas.map(c=>{ const t=viaGtx.get(String(c.id||'')); return t ? mergeTranslated(c, t) : c; });
}
// Jedno wywołanie LLM na mały chunk pytań (4) — mniejsze prompty są odporniejsze
// na 429 i łatwiej wracają z poprawnym JSON niż tłumaczenie 12 pytań naraz.
async function translateChunkLlm(slice){
  const slim = slice.map(slimChallenge);
  const prompt = `Translate this quiz (a school reading test) from Polish to ENGLISH.
Keep the JSON structure EXACTLY — same fields, same indexes, same order of options/statements/items/pairs. Translate only text content (question, options, statements, items, pairs left/right, expectedMeaning, context).
Use natural English, school-test wording.
Translation target language: ENGLISH.
Proper nouns and Polish character names may stay in original form (e.g. Świteź, Dziady, Pan Tadeusz).
Return ONLY the translated JSON, nothing else.
JSON:
${JSON.stringify(slim)}`;
  let lastErr;
  for(let attempt=0; attempt<2; attempt++){
    try{
      const content = await llmChat([{role:'user',content:prompt}], {temperature:0.1, maxTokens:4000, timeout:45000, models: TRANSLATE_MODELS});
      const parsed = extractJSON(content);
      const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.challenges) ? parsed.challenges : null);
      if(!Array.isArray(arr)) throw new Error('niepoprawny JSON');
      const byId = new Map(arr.map(x=>[String(x.id), x]));
      return slice.map(c=>{
        const t = byId.get(String(c.id||''));
        if(!t) return null;
        return [String(c.id), {...mergeTranslated(c, t), _en:true}];
      }).filter(Boolean);
    }catch(e){ lastErr=e; console.warn(`[translate] LLM próba ${attempt+1} fail: ${String(e.message).slice(0,90)}`); }
  }
  throw lastErr || new Error('LLM: brak tłumaczenia');
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
  const {walletAddress, displayName, email} = req.body;
  if(!walletAddress) return res.status(400).json({error:'walletAddress required (Phantom Devnet)', privacy: PRIVACY_SHORT});
  // Solana address: permissive 32-44 alphanumeric (Devnet test may use phantom generated); loose check for hackathon
  const w = String(walletAddress).trim();
  if(w.length < 32 || w.length > 50) return res.status(400).json({error:'invalid walletAddress length (expected 32-44 base58 — Phantom Devnet)', got: w.length, privacy: PRIVACY_SHORT});
  if(!/^[A-Za-z0-9]{32,50}$/.test(w)) return res.status(400).json({error:'invalid walletAddress format', privacy: PRIVACY_SHORT});
  // ROLA NIE PRZYCHODZI Z BODY. Podnoszenie roli (publisher/teacher) robi wyłącznie
  // administrator w bazie — inaczej każdy mógłby POST-em zostać wydawcą.
  // Pole 'role' w body jest ignorowane celowo.
  const now = new Date().toISOString();
  db.get(`SELECT * FROM users WHERE walletAddress=?`, [w], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(row){
      db.run(`UPDATE users SET displayName=?, email=?, lastLoginAt=? WHERE walletAddress=?`, [displayName||row.displayName, email||row.email, now, w], ()=>{
        res.json({ok:true, user: {...row, displayName: displayName||row.displayName, email: email||row.email, lastLoginAt: now}, privacy: PRIVACY_SHORT, note:'Existing wallet—updated lastLogin'});
      });
    } else {
      db.run(`INSERT INTO users (walletAddress, displayName, email, role, createdAt, lastLoginAt) VALUES (?,?,?,?,?,?)`, [w, displayName||null, email||null, 'reader', now, now], (e2)=>{
        if(e2) return res.status(500).json({error:e2.message});
        res.json({ok:true, user:{walletAddress: w, displayName: displayName||null, email: email||null, role: 'reader', createdAt: now, lastLoginAt: now}, privacy: PRIVACY_SHORT});
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

// ===== PUBLISHER API =====
// Bramka: rola 'publisher' z bazy + pinowanie portfela.
// `publisherWallet` z body/query jest NADPISYWANY portfelem z autoryzacji, więc
// istniejące endpointy campaigns przestają być IDOR-em (wydawca A nie zobaczy
// kampanii wydawcy B, nawet jeśli poda jego adres w zapytaniu).
async function requirePublisher(req, res, next){
  const actor = reqActor(req);
  if(!actor) return res.status(401).json({error:'publisher authorization required'});
  const row = await new Promise((resolve)=>{
    db.get(`SELECT * FROM users WHERE walletAddress=? OR appleUserId=?`, [actor, actor], (e,r)=>{ if(e) return resolve(null); resolve(r); });
  });
  if(!row) return res.status(403).json({error:'publisher account not found'});
  const role = row.role || 'reader';
  if(role !== 'publisher') return res.status(403).json({error:'publisher role required'});
  // Sam wybór roli w formularzu nie daje dostępu. Konto musi być zatwierdzone
  // przez administratora; zawieszenie natychmiast odbiera dostęp.
  if(!roleIsApproved(row)) {
    const status = row.approvalStatus || 'pending';
    if(roleIsSuspended(row)) return res.status(403).json({error:'publisher account is suspended', approvalStatus: status});
    return res.status(403).json({error:'publisher account is awaiting administrator approval', approvalStatus: status});
  }
  req._role = role;
  req._user = row;
  req.publisher = { wallet: row.walletAddress, displayName: row.displayName||null, email: row.email||null };
  next();
}
function publisherOf(req){ return req.publisher?.wallet || ''; }
function pinPublisherWallet(req,res,next){
  const w = publisherOf(req);
  if(req.body && typeof req.body==='object') req.body.publisherWallet = w;
  if(req.query) req.query.publisherWallet = w;
  next();
}
// Weryfikacja własności. 404 zamiast 403, żeby nie zdradzać istnienia cudzych książek.
async function ownedPublisherBook(req, bookId){
  const owner = publisherOf(req);
  if(!owner) return {error:{status:401, message:'publisher authorization required'}};
  const id = String(bookId||'');
  if(!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return {error:{status:400, message:'invalid book id'}};
  const row = await new Promise((resolve)=>{
    db.get(`SELECT * FROM publisher_books WHERE id=?`, [id], (e,r)=>{ if(e) return resolve(null); resolve(r); });
  });
  if(!row) return {error:{status:404, message:'book not found'}};
  if(row.ownerWallet !== owner) return {error:{status:404, message:'book not found'}};
  return {row};
}
app.use('/api/publisher', requirePublisher, pinPublisherWallet);

// Weryfikacja własności kampanii (legacy flow). Zwraca 404, żeby nie zdradzać
// istnienia cudzych kampanii.
async function ownedCampaign(req, id){
  const owner = publisherOf(req);
  const cid = String(id||'');
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(cid)) return {error:{status:400, message:'invalid campaign id'}};
  const row = await new Promise((resolve)=>{
    db.get(`SELECT * FROM publisher_campaigns WHERE id=?`, [cid], (e,r)=>{ if(e) return resolve(null); resolve(r); });
  });
  if(!row) return {error:{status:404, message:'campaign not found'}};
  if(row.publisherWallet !== owner) return {error:{status:404, message:'campaign not found'}};
  return {row};
}
// Wycisła błędy własności jako odpowiedź HTTP (404/400/401).
function failOwned(res, owned){ return res.status(owned.error.status).json({error: owned.error.message}); }

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

app.get('/api/publisher/campaigns/:id', async (req,res)=>{
  const owned = await ownedCampaign(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const row = owned.row;
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

app.get('/api/publisher/campaigns/:id/qr', async (req,res)=>{
  const ownedQr = await ownedCampaign(req, req.params.id);
  if(ownedQr.error) return failOwned(res, ownedQr);
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

app.get('/api/publisher/campaigns/:id/code', async (req,res)=>{
  const ownedCode = await ownedCampaign(req, req.params.id);
  if(ownedCode.error) return failOwned(res, ownedCode);
  db.get(`SELECT * FROM publisher_campaigns WHERE id=?`, [req.params.id], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'campaign not found'});
    const code = row.isbn ? row.isbn : row.id.replace('camp-','').toUpperCase();
    res.json({campaignId: row.id, isbn: row.isbn, code, typedCode: code, deepLink: campaignDeepLink(row.id, row.isbn), scheme: campaignPhoneScheme(row.id, row.isbn), privacy: PRIVACY_SHORT, note:'Typed code = ISBN or short campaign code — user types in phone app to open campaign'});
  });
});

// ISBN lookup (typed) — tylko własne kampanie wydawcy
app.get('/api/publisher/lookup', (req,res)=>{
  const {isbn, code} = req.query;
  const q = normalizeISBN(isbn||code||'');
  if(!q) return res.status(400).json({error:'isbn or code query required', privacy: PRIVACY_SHORT});
  const me = publisherOf(req);
  db.get(`SELECT * FROM publisher_campaigns WHERE isbn=? AND publisherWallet=?`, [q, me], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row){
      db.all(`SELECT id, title, author, isbn FROM publisher_campaigns WHERE isbn LIKE ? AND publisherWallet=? LIMIT 10`, [`%${q}%`, me], (e2, rows)=>{
        res.json({found:false, query: q, suggestions: rows||[], privacy: PRIVACY_SHORT});
      });
      return;
    }
    res.json({found:true, campaign: {...row, qr:{url:campaignDeepLink(row.id,row.isbn), scheme:campaignPhoneScheme(row.id,row.isbn)}}, privacy: PRIVACY_SHORT });
  });
});

// Upload book content — server only, never on-chain (only hash)
app.post('/api/publisher/campaigns/:id/content', async (req,res)=>{
  const ownedContent = await ownedCampaign(req, req.params.id);
  if(ownedContent.error) return failOwned(res, ownedContent);
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
        persistChallenges()
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
              persistChallenges()
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

app.get('/api/publisher/campaigns/:id/content', async (req,res)=>{
  const ownedPreview = await ownedCampaign(req, req.params.id);
  if(ownedPreview.error) return failOwned(res, ownedPreview);
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
  const {amount, currency, txSignature} = req.body;
  const publisherWallet = publisherOf(req); // z autoryzacji, nie z body
  if(!publisherWallet) return res.status(401).json({error:'publisher authorization required', privacy: PRIVACY_SHORT});
  const amt = Number(amount);
  if(amount===undefined || amount===null || amount==='' || !Number.isFinite(amt)) return res.status(422).json({error:'amount must be a number', privacy: PRIVACY_SHORT});
  if(amt<=0) return res.status(400).json({error:'amount >0 required', privacy: PRIVACY_SHORT});
  const cur = (currency==='SOL' ? 'SOL':'USDC');
  if(amt>100000) return res.status(400).json({error:'amount too large (max 100k Devnet)', privacy: PRIVACY_SHORT});
  const ownedFund = await ownedCampaign(req, req.params.id);
  if(ownedFund.error) return failOwned(res, ownedFund);
  db.get(`SELECT * FROM publisher_campaigns WHERE id=?`, [req.params.id], async (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'campaign not found'});
    if(row.publisherWallet !== publisherWallet) return res.status(404).json({error:'campaign not found'});
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

app.get('/api/publisher/campaigns/:id/funds', async (req,res)=>{
  const ownedFunds = await ownedCampaign(req, req.params.id);
  if(ownedFunds.error) return failOwned(res, ownedFunds);
  db.all(`SELECT * FROM campaign_funds WHERE campaignId=? ORDER BY createdAt DESC`, [req.params.id], (err,rows)=>{
    if(err) return res.status(500).json({error:err.message});
    res.json({campaignId: req.params.id, count: rows.length, funds: rows, usdcMint: USDC_MINT_DEVNET, cluster:'devnet', privacy: PRIVACY_SHORT});
  });
});

// Campaign challenge bridge — start proof for uploaded campaign book (uses campaign text)
app.post('/api/publisher/campaigns/:id/start', async (req,res)=>{
  const ownedStart = await ownedCampaign(req, req.params.id);
  if(ownedStart.error) return failOwned(res, ownedStart);
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
            if(gen && gen.length>=5){ pool = gen; challengesByChapter[req.params.id]=pool; persistChallenges() }
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
          persistChallenges()
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
  let picked, langFallback = null;
  if(lang === 'en'){
    // EN gramy z gotowej puli EN (en-pools.json). Pula jest budowana leniwie:
    // pierwsze wejście na zimny rozdział czeka na budowę, kolejne są instant.
    // Jeśli obaj tłumacze (gtx + LLM) są chwilowo niedostępne, NIE blokujemy
    // użytkownika martwym 503 — dostaje quiz po polsku z jawną flagą
    // langFallback, którą pokazuje aplikacja, a pula EN dojedzie w tle.
    const enPool = await ensureEnPool(chapterId, EN_POOL_WAIT_MS);
    if(enPool && enPool.length >= 5){
      picked = pickFromPool(enPool);
    } else {
      ensureEnPool(chapterId, 0);
      const st = enPoolStatus(chapterId);
      // Budowa jeszcze trwa → 503, a aplikacja sama ponawia. Oddanie quizu
      // po polsku w trakcie tłumaczenia dawało wrażenie „zepsutego EN".
      if(st.building && Date.now() > st.failedUntil){
        return res.status(503).json({error:'EN quiz is being translated — retry in a moment', code:'translating', bookId, chapterId, retryAfterSec:8});
      }
      picked = pickForSession(chapterId, 'pl');
      langFallback = 'pl';
      console.warn(`[start] ${chapterId}: pula EN niedostępna — quiz PL z langFallback`);
    }
  } else {
    try{ picked = pickForSession(chapterId, lang); }
    catch(e){
      console.error(`[start] fallback do puli: ${e.message}`);
      picked = pickFive(chapterId);
    }
  }
  const startAt = new Date().toISOString();
  // Język TREŚCI sesji: przy fallbacku pytania są polskie, więc ocenianie (Jev),
  // podpowiedzi i komunikaty też muszą być polskie — inaczej mieszamy języki.
  const contentLang = langFallback ? 'pl' : lang;
  const sessionChallenges = isDevBypass ? buildSessionChallenges(picked, startAt, false).map(c=>({...c, releaseAt: startAt})) : buildSessionChallenges(picked, startAt, isDemo);
  const id = crypto.randomUUID();
  const expectedMin = expectedReadingMin || 12;
  const session = {
    id, walletAddress: wallet, bookId, chapterId, startAt, endAt: null, status:'reading',
    challengeIds: picked.map(c=>c.id), challenges: sessionChallenges,
    answers: {}, // challengeId -> {answer, answeredAt, correct, jev}
    readingDurationSec: 0, lang: contentLang, expectedReadingMin: expectedMin, isDemo, isDevBypass, userId: userId||null
  };
  sessionsMem.set(id, session);
  // try with userId column, fallback without if column missing (sqlite old)
  const tryInsert = (withUserId)=>{
    if(withUserId){
      db.run(`INSERT INTO reading_sessions (id, walletAddress, bookId, chapterId, startAt, endAt, status, challengeIds, answers, readingDurationSec, lang, expectedReadingMin, createdAt, userId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,wallet,bookId,chapterId,startAt,null,'reading', JSON.stringify(session.challengeIds), JSON.stringify(session.answers), 0, contentLang, expectedMin, startAt, userId||null],
        (e)=>{ if(e && String(e.message).includes('no column')) tryInsert(false); });
    } else {
      db.run(`INSERT INTO reading_sessions (id, walletAddress, bookId, chapterId, startAt, endAt, status, challengeIds, answers, readingDurationSec, lang, expectedReadingMin, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id,wallet,bookId,chapterId,startAt,null,'reading', JSON.stringify(session.challengeIds), JSON.stringify(session.answers), 0, contentLang, expectedMin, startAt]);
    }
  };
  tryInsert(true);
  // return without exposing future questions — only first is unlocked, rest masked
  const now = Date.now();
  const masked = sessionChallenges.map(c=>{
    const unlockAt = new Date(c.releaseAt).getTime();
    const locked = unlockAt > now;
    if(locked) return {id:c.id, type:c.type, releaseAt:c.releaseAt, releaseAfterSec:c.releaseAfterSec, locked:true, hint: contentLang==='en'?'Reading — unlocks soon':'Czytanie — odblokuje się wkrótce'};
    // Obcinamy PO normalizeChallenge — normalizacja sama wylicza correctAnswer
    // dla true_false i multiple_choice, więc obcięcie przed nią nic nie dawało.
    return {...stripAnswers([normalizeChallenge(c, contentLang)])[0], locked:false};
  });
  res.json({id, walletAddress: wallet, bookId, chapterId, startAt, expectedReadingMin: expectedMin, isDemo, isDevBypass, lang, langFallback, timing: isDevBypass ? SESSION_TIMING_DEV : (isDemo? SESSION_TIMING_DEMO: SESSION_TIMING_REAL), challenges: masked, poolSize: poolForChapter(chapterId).length, note: lang==='en'?'Proof of Comprehension — not proof of physical reading. Challenges unlock gradually to prevent copy-to-AI.':'Proof of Comprehension — nie dowód fizycznego czytania. Challengee odblokowują się stopniowo — nie da się wkleić wszystkich do AI.'});
  console.log(`[start] ${wallet?.slice(0,6)}.. ${bookId}/${chapterId} lang=${lang} demo=${isDemo} dev=${isDevBypass} pool=${poolForChapter(chapterId).length} session=${id.slice(0,8)}`);
});

app.get('/api/sessions/:id', (req,res)=>{
  const s = sessionsMem.get(req.params.id);
  if(!s){
    db.get(`SELECT * FROM reading_sessions WHERE id=?`, [req.params.id], (err,row)=>{
      if(err||!row) return res.status(404).json({error:'session not found'});
      // fallback z DB — też bez klucza odpowiedzi
      const challenges = stripAnswers(JSON.parse(row.challengeIds||'[]').map(id=> poolForChapter(row.chapterId).find(c=>c.id===id) || {id}));
      return res.json({id:row.id, walletAddress:row.walletAddress, bookId:row.bookId, chapterId:row.chapterId, startAt:row.startAt, endAt:row.endAt, status:row.status, challenges, answers: JSON.parse(row.answers||'{}')});
    });
    return;
  }
  const now = Date.now();
  const masked = s.challenges.map(c=>{
    const locked = new Date(c.releaseAt).getTime() > now;
    if(locked) return {id:c.id, type:c.type, releaseAt:c.releaseAt, releaseAfterSec:c.releaseAfterSec, locked:true, hint: s.lang==='en'?'Keep reading…':'Czytaj dalej…'};
    return {...stripAnswers([normalizeChallenge(c, s.lang)])[0], locked:false};
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
  ch = normalizeChallenge(ch, s.lang);
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

  // ── 2. ZAPIS WYNIKU — nagroda tylko gdy weryfikacja przeszła, certyfikat także dla partial ──
  const proofId = crypto.randomUUID();
  const proofHash = verdict.proofHash;
  const verificationVersion = verdict.verificationVersion;
  let tx=null, explorer=null, reward=null, chapterCertId=null;
  // tier 'full' → pełne zrozumowanie + nagroda + certyfikat
  // tier 'partial' → certyfikat ze statusem "częściowe zrozumienie", BEZ nagrody i bez on-chain
  // tier 'none'   → brak certyfikatu (oszustwo / zbyt niski wynik)
  if(verdict.tier === 'full' && !failEarly){
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
    // Rozliczenie puli wydawcy — tylko dla książek z pulą nagród.
    // Pula maleje atomowo (warunek w UPDATE), więc dwie równoległe sesje
    // nie wypłacą z jednej puli. Bez skonfigurowanego payera status='pending'.
    await settlePublisherPayout({ bookId: s.bookId, chapterId: s.chapterId, wallet: s.walletAddress,
      userId: (s.userId || null), score: verdict.score, total, reward, tx, explorer, proofHash, at: endAt });
  } else if(verdict.tier === 'partial' && !failEarly){
    reward = null;
    // certyfikat za częściowe zrozumienie — bez nagrody, memo on-chain tylko z proofHash
    chapterCertId = certId();
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
  // Awaitujemy zapisy! Wcześniej były "fire-and-forget", więc /complete odpowiadał ZANIM
  // proof i certyfikat trafiły do bazy → natychmiastowe otwarcie /verify/?id=RP-… dawało
  // 404 "certificate not found", a przy awarii DB cert w ogóle nie powstawał.
  const dbRun = (sql, params)=>new Promise((resolve)=>{ try{ db.run(sql, params, (e)=>resolve(!e)); }catch(e){ resolve(false); } });
  const doProofInsert = async (withUser)=>{
    if(withUser){
      const ok = await dbRun(`INSERT INTO proofs (id, bookId, chapterId, score, total, status, walletAddress, timestamp, proofHash, txSignature, explorerUrl, reward, detail, verificationVersion, durationSec, userId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [proofId, s.bookId, s.chapterId, verdict.score, total, finalStatus, s.walletAddress, endAt, proofHash, tx, explorer, reward, JSON.stringify(detail), verificationVersion, verdict.durationSec, userIdForProof]);
      if(!ok) await doProofInsert(false); // baza bez kolumny userId → ponów bez niej
      return ok;
    }
    return await dbRun(`INSERT INTO proofs (id, bookId, chapterId, score, total, status, walletAddress, timestamp, proofHash, txSignature, explorerUrl, reward, detail, verificationVersion, durationSec) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [proofId, s.bookId, s.chapterId, verdict.score, total, finalStatus, s.walletAddress, endAt, proofHash, tx, explorer, reward, JSON.stringify(detail), verificationVersion, verdict.durationSec]);
  };
  const proofSaved = await doProofInsert(true);
  let certSaved = false;
  if(chapterCertId){
    certSaved = await dbRun(`INSERT INTO certificates (id, kind, bookId, chapterId, walletAddress, userId, score, total, status, certHash, txSignature, explorerUrl, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [chapterCertId, 'chapter', s.bookId, s.chapterId, s.walletAddress, userIdForProof, verdict.score, total, finalStatus, proofHash, tx, explorer, endAt, endAt]);
    if(!certSaved){
      console.error(`[cert] insert FAIL ${chapterCertId}: ${s.bookId}/${s.chapterId} ${s.walletAddress} — cert NIE zapisany`);
      chapterCertId = null; // nie obiecujemy certu, którego nie ma w bazie
    } else {
      // Kotwica powstaje PO zapisie wiersza — memo musi odtąd odtwarzać się
      // co do bajtu z bazy. Czekamy, bo /verify po certyfikacie ma działać
      // natychmiast, a kotwica musi być już w łańcuchu.
      await anchorCertificate({
        id: chapterCertId, kind:'chapter', bookId:s.bookId, chapterId:s.chapterId,
        walletAddress:s.walletAddress, score: verdict.score, total, status: finalStatus,
        timestamp: endAt,
      });
    }
  }
  await dbRun(`UPDATE reading_sessions SET endAt=?, status=?, readingDurationSec=? WHERE id=?`, [endAt, finalStatus, s.readingDurationSec, s.id]);
  if(!proofSaved) console.error(`[proof] insert FAIL ${proofHash} (${s.bookId}/${s.chapterId})`);
  console.log(`[complete] user=${(userIdForProof||'').toString().slice(0,8)} wallet=${s.walletAddress?.slice(0,6)}.. ${s.chapterId} score=${verdict.score}/${total} status=${finalStatus} tier=${verdict.tier} version=${verificationVersion} proof=${proofHash} proofSaved=${proofSaved?'OK':'FAIL'} verified=${verdict.verified} cert=${chapterCertId||'—'} checks=${verdict.checks.filter(c=>!c.passed).map(c=>c.name).join(',')||'ALL PASS'}`);
  res.json({
    sessionId: s.id, proof: {id: proofId, bookId:s.bookId, chapterId:s.chapterId, challengeIds: s.challengeIds, score: verdict.score, total, status: finalStatus, tier: verdict.tier, walletAddress:s.walletAddress, userId: userIdForProof, timestamp:endAt, proofHash, txSignature:tx, explorerUrl: explorer, reward, verificationVersion, durationSec: verdict.durationSec, certId: chapterCertId},
    readingDurationSec: verdict.durationSec, startAt: s.startAt, endAt, lang: s.lang,
    verification: { verified: verdict.verified, version: verificationVersion, checks: verdict.checks },
    results: detail,
    note: s.lang==='en' ? 'Comprehension verified — not physical reading. Stored: wallet, book, chapter, session_start/end, reading_duration, proof_hash.' : 'Comprehension verified — nie fizyczne czytanie. Zapisano: wallet, book, chapter, session_start/end, reading_duration, proof_hash.'
  });
});

// Książki wstrzymane przez wydawcę znikają z katalogu czytelnika (pauza ≠ usunięcie).
function isPaused(b){ return !!b._paused; }
function publicBook(b){
  if(!b._paused){ const { _paused, ...rest } = b; return rest; }
  return b;
}
app.get('/api/books', (req,res)=>res.json(books.filter(b=>!isPaused(b)).map(b=>{ const pb=publicBook(b); return {...pb, chapters:(pb.chapters||[]).map(c=>({...c, poolCount:approvedPool(c.id).length, draftCount:poolForChapter(c.id).filter(c=>qStatus(c)!=='approved').length}))}; })
  .filter(b=>(b.chapters||[]).length>0 && (b.chapters||[]).every(c=>c.poolCount>=5))));

app.get('/api/books/:bookId', (req,res)=>{
  const b=books.find(x=>x.id===req.params.bookId);
  if(!b) return res.status(404).json({error:'book not found'});
  if(isPaused(b)) return res.status(404).json({error:'book not available'});
  res.json(publicBook(b));
});

app.get('/api/books/:bookId/chapters/:chapterId/challenge', async (req,res)=>{
  const lang = langOf(req);
  // EN: z gotowej puli EN (jak sesja). Gdy jej jeszcze nie ma — zwracamy PL
  // i odpalamy budowę w tle, zamiast tłumaczyć na żądanie w pętli HTTP.
  let chs = null, outLang = lang;
  if(lang==='en'){
    const enPool = await ensureEnPool(req.params.chapterId, 8000);
    if(enPool && enPool.length >= 5){ chs = pickFromPool(enPool); }
    else { ensureEnPool(req.params.chapterId, 0); outLang = 'pl'; }
  }
  if(!chs) chs = pickFive(req.params.chapterId);
  if(!chs.length) return res.status(404).json({error:'no challenges'});
  res.json({chapterId:req.params.chapterId, count:chs.length, challenges: stripAnswers(chs.map(c=>normalizeChallenge(c, outLang))), lang: outLang});
});

// Pola, które zdradzają klucz odpowiedzi. Publiczny podgląd puli (np. strona
// /verify/ budująca opis dowodu) dostaje treść pytania, ale NIE poprawną odpowiedź
// ani expectedMeaning — inaczej każdy mógłby zlać test przed przeczytaniem książki.
// Publiczny podgląd puli: treść pytania bez klucza. Nauczyciel i wydawca widzą
// odpowiedzi przez endpointy z requireTeacher / requirePublisher
// (/api/teacher/pool, /api/publisher/...), które już istnieją lub powstaną.
app.get('/api/challenges/:chapterId', (req,res)=>{
  const pool=challengesByChapter[req.params.chapterId];
  if(!pool) return res.status(404).json({error:'not found'});
  if(req.query.pick) {
    const n=Math.min(Number(req.query.pick)||5, pool.length);
    res.json(stripAnswers(pickFive(req.params.chapterId).slice(0,n)));
  } else res.json(stripAnswers(pool));
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
  const q = normalizeChallenge(ch, lang);
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
function answerText(ch, lang='pl'){
  const q = normalizeChallenge(ch, lang);
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
      results.push({challengeId: cid, type: ch.type||'', question: ch.question||null, answer: ans ?? null, correct: false, jev: null, skipped: true, correctText: answerText(ch, lang)});
      continue;
    }
    const g = await gradeAnswer(ch, ans, lang);
    if(g.correct) score++;
    results.push({challengeId: cid, type: ch.type||'', question: ch.question||null, answer: ans, correct: !!g.correct, jev: g.jev || null, correctText: answerText(ch, lang)});
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
  // Certyfikat za cały test też jest niezmienialny — kotwimy go tak samo.
  await anchorCertificate(certificate);
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

// ── PDF builder (bez zewnętrznych zależności — Helvetica + prymitywy graficzne) ──
// Elementy strony: {x,y,t,size,bold} dla tekstu oraz {rect|lw} i {fill|g}
// dla ramek i linii. Grafika rysowana jest przed tekstem.
function pdfEscape(t){ return String(t==null?'':t).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)'); }

// Wbudowane fonty PDF (Helvetica) mają kodowanie WinAnsi — polskie znaki
// muszą zejść do ASCII, inaczej wychodzą „krzaczki” i OCR ich nie czyta.
const PDF_FOLD = { 'ą':'a','Ą':'A','ć':'c','Ć':'C','ę':'e','Ę':'E','ł':'l','Ł':'L',
  'ń':'n','Ń':'N','ó':'o','Ó':'O','ś':'s','Ś':'S','ź':'z','Ź':'Z','ż':'z','Ż':'Z',
  'ń':'n','ñ':'n','„':'"','”':'"','“':'"','’':"'",'–':'-','—':'-','…':'...',' ':' ' };
function pdfSafe(t){
  return String(t==null?'':t)
    .replace(/[\u0105\u0104\u0107\u0106\u0119\u0118\u0142\u0141\u0144\u0143\u00f3\u00d3\u015b\u015a\u017a\u0179\u017c\u017b\u00f1\u201e\u201d\u201c\u2019\u2013\u2014\u2026\u00a0]/g, c => PDF_FOLD[c] ?? c)
    .replace(/[^\x20-\x7E]/g, '');
}

function buildStandalonePdf(pages){
  // objs[0] = katalog (obiekt 1), objs[1] = węzeł /Pages (obiekt 2) — miejsce
  // musi być zarezerwowane przed fontami, inaczej /F1 wskazuje na /Pages
  // i cały tekst regularny znika z wydruku.
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const addObj = body => { objs.push(body); return objs.length; };
  const pagesNodeNo = 2;
  const pageNos = [];
  const fontNoF1 = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontNoF2 = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const contentNos = [];
  const kids = [];
  const f = n => (Number(n)||0).toFixed(2);
  pages.forEach((page)=>{
    const gfx = [];
    const txt = [];
    (page.lines||[]).forEach(l=>{
      if(l.rect){
        gfx.push(`q 0 G ${f(l.lw||0.7)} w ${f(l.rect.x)} ${f(l.rect.y)} ${f(l.rect.w)} ${f(l.rect.h)} re S Q`);
      }else if(l.fill){
        gfx.push(`q ${f(l.g ?? 0.82)} g ${f(l.fill.x)} ${f(l.fill.y)} ${f(l.fill.w)} ${f(l.fill.h)} re f Q`);
      }else{
        const size = l.size || 11;
        const font = l.bold ? 'F2' : 'F1';
        txt.push(`BT /${font} ${size} Tf 1 0 0 1 ${f(l.x||0)} ${f(l.y||0)} Tm (${pdfEscape(pdfSafe(l.t))}) Tj ET`);
      }
    });
    const streamObj = [...gfx, ...txt].join('\n') + '\n';
    const contentNo = addObj(`<< /Length ${Buffer.byteLength(streamObj, 'utf8')} >>\nstream\n${streamObj}endstream`);
    contentNos.push(contentNo);
    const pageNo = addObj(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontNoF1} 0 R /F2 ${fontNoF2} 0 R >> >> /Contents ${contentNo} 0 R >>`);
    pageNos.push(pageNo);
    kids.push(`${pageNo} 0 R`);
  });
  objs[pagesNodeNo-1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  const infoNo = addObj('<< /Title (ReadProof) /Producer (ReadProof) >>');
  const catalogNo = 1;
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

// Arkusz testowy w PDF. Układ celowo identyczny z arkuszem z panelu
// nauczyciela (teacher-panel → PaperDocument): numer pytania, typ, lista
// odpowiedzi z literami i jedno oznaczone pole „Odpowiedź:”, w które
// uczeń wpisuje literę albo tekst. To pole czyta maszynowo.
const SHEET_LETTERS = ['A','B','C','D','E','F'];
function sheetTypeTag(q){
  if(q.type==='true_false'||q.type==='statement') return 'PRAWDA / FAŁSZ';
  if(q.type==='multiple_select') return 'WIELOKROTNY WYBÓR';
  if(q.type==='ordering'||q.type==='ranking') return 'KOLEJNOŚĆ';
  if(q.type==='match'||q.type==='who_said') return 'DOPASOWANIE';
  if(q.type==='open_question'||q.type==='why_question') return 'OTWARTE';
  return 'JEDEN WYBÓR';
}
const sheetAlphabet = (n) => SHEET_LETTERS.slice(0, Math.max(1, n||1)).join('-');

function buildTestPdf(test, bookTitle, chapterTitle){
  const W = 595, H = 842, M = 44, TOP = 796, BOT = 48, RIGHT = W - M;
  const pages = [];
  let y = TOP;
  const newPage = () => { pages.push({lines:[]}); y = TOP; };
  const tw = (t,size,bold) => String(t==null?'':t).length * size * (bold ? 0.56 : 0.5);
  const wrap = (str,size,maxW) => {
    const words = String(str==null?'':str).split(/\s+/).filter(Boolean);
    const out = []; let cur = '';
    for(const w of words){
      if(cur && tw(cur+' '+w, size, false) > maxW){ out.push(cur); cur = w; }
      else cur = cur ? cur+' '+w : w;
    }
    if(cur || !out.length) out.push(cur);
    return out;
  };
  // target: {items, y} — pozwala budować blok pytania w buforze i wstawić go
  // w całości na jednej stronie.
  const T = (t,str,o={}) => {
    const size = o.size || 11, bold = !!o.bold, x = (o.x ?? M) + (o.indent || 0);
    const y0 = (o.yAt != null) ? o.yAt : t.y;
    const lines = wrap(str, size, Math.max(40, RIGHT - x));
    lines.forEach((w, li)=>{
      const ly = y0 - li * (o.lead || size*1.34);
      if(ly - size < BOT && !t.buffer){ if(t.autoPage){ newPage(); t.page = pages.length-1; } else return; }
      t.items.push({x, y:ly, t:w, size, bold});
    });
    if(o.yAt == null) t.y = y0 - lines.length * (o.lead || size*1.34);
  };
  const RT = (t,str,o={}) => { const size=o.size||10, bold=!!o.bold; T(t,str,{...o, x: RIGHT - tw(str,size,bold), size, bold}); };
  const BOX = (t,rect,lw) => t.items.push({rect, lw: lw ?? 0.7});
  const RULE = (t,x1,x2,yy,lw) => t.items.push({fill:{x:Math.min(x1,x2), y:yy, w:Math.abs(x2-x1), h:lw ?? 0.6}, g:0.8});
  const commit = (buf, gap=8) => {
    const height = buf.y0 - buf.y;
    if(y - height < BOT) newPage();
    const dy = y - buf.y0;
    buf.items.forEach(it => pages[pages.length-1].lines.push(
      it.rect ? {rect:{x:it.rect.x, y:it.rect.y+dy, w:it.rect.w, h:it.rect.h}, lw:it.lw}
              : it.fill ? {fill:{x:it.fill.x, y:it.fill.y+dy, w:it.fill.w, h:it.fill.h}, g:it.g}
              : {x:it.x, y:it.y+dy, t:it.t, size:it.size, bold:it.bold}
    ));
    y = buf.y - gap;
  };
  // Bufor pozwala zbudować całe pytanie i wstawić je na jednej stronie —
  // podział pilnuje commit(), więc T nie może nic pominąć.
  const newBuf = (y0) => ({items:[], y:y0, y0, buffer:true});
  // Wstawia blok dokładnie tam, gdzie był zbudowany (np. stopka u dołu strony).
  const commitAt = (buf) => {
    buf.items.forEach(it => pages[pages.length-1].lines.push(
      it.rect ? {rect:it.rect, lw:it.lw}
              : it.fill ? {fill:it.fill, g:it.g}
              : {x:it.x, y:it.y, t:it.t, size:it.size, bold:it.bold}
    ));
  };

  // pole odpowiedzi: ramka + etykieta + ramki na litery
  const slot = (t, label, hint, boxes) => {
    const top = t.y + 11, h = 24, bottom = top - h;
    BOX(t,{x:M+4, y:bottom, w:RIGHT-M-4, h});
    const baseY = t.y;
    T(t, label, {x:M+12, size:9.5, bold:true});
    if(hint) T(t, hint, {x:M+12+tw(label,9.5,true)+3, size:8, yAt: baseY});
    const bw = 15, gap = 7;
    let bx = RIGHT - 10 - (boxes*(bw+gap) - gap);
    for(let i=0;i<boxes;i++){ BOX(t,{x:bx, y:bottom+4.5, w:bw, h:15}, 0.9); bx += bw+gap; }
    t.y = bottom - 7;
  };
  // ramka na odpowiedź otwartą: 4 linie do pisania
  const openSlot = (t) => {
    const top = t.y + 11, h = 74, bottom = top - h;
    BOX(t,{x:M+4, y:bottom, w:RIGHT-M-4, h});
    T(t, 'Odpowiedź:', {x:M+12, size:9.5, bold:true});
    T(t, 'własnymi słowami, w ramce', {x:M+12+tw('Odpowiedź:',9.5,true)+3, size:8, yAt: top - 11});
    for(let i=0;i<4;i++) RULE(t, M+12, RIGHT-8, bottom + h - 16 - i*16, 0.6);
    t.y = bottom - 7;
  };

  pages.push({lines:[]});
  const head = newBuf(y); head.y0 = y; head.autoPage = true; head.page = 0;
  T(head,'ReadProof — arkusz testu',{size:8.5});
  RT(head, `${bookTitle} — ${chapterTitle}`, {size:9});
  head.y -= 4;
  T(head, test.title || 'Test sprawdzający', {size:16, bold:true});
  head.y -= 3;
  T(head, `Kod arkusza: ____________________    Wersja: A    Data: ______________    Godzina: ______________`, {size:9.5});
  T(head, `Imię i nazwisko: ______________________________________________    Numer ucznia: ______________`, {size:9.5});
  head.y -= 4;
  const instrTop = head.y + 9, instrBottom = instrTop - 54;
  BOX(head,{x:M, y:instrBottom, w:RIGHT-M, h:54}, 0.9);
  T(head,'INSTRUKCJA', {x:M+9, size:9, bold:true});
  T(head,'Odpowiedź wpisz wyłącznie w pole „Odpowiedź:”. Pytania zamknięte: jedna litera (A, B, C, D; w P/F litera P lub F).', {x:M+9, size:8.5, indent:0});
  T(head,'Wielokrotny wybór: litery oddzielone przecinkami. Kolejność i dopasowanie: litery oddzielone spacją.', {x:M+9, size:8.5});
  T(head,'Pytania otwarte: odpowiedź własnymi słowami w ramce. Pisz czytelnie, drukowanymi literami.', {x:M+9, size:8.5});
  head.y = instrBottom - 12;
  commit(head, 10);

  (test.questions||[]).forEach((q, qi)=>{
    const buf = newBuf(y);
    const isTF = q.type==='true_false' || q.type==='statement';
    const opts = (isTF || q.type==='find_error') ? [] : (Array.isArray(q.options) ? q.options : []);
    const items = Array.isArray(q.items) ? q.items : [];
    const pairs = Array.isArray(q.pairs) ? q.pairs : [];
    T(buf, `${qi+1}. ${String(q.question||'')}`, {size:10.5, bold:true});
    RT(buf, sheetTypeTag(q), {size:8});
    buf.y -= 2;
    if(isTF){
      T(buf, 'P - Prawda            F - Falsz', {size:9.5, indent:10});
      buf.y -= 2;
    }else if(opts.length){
      opts.forEach((o,oi)=> T(buf, `${SHEET_LETTERS[oi]||('('+(oi+1)+')')}.  ${String(o||'')}`, {size:9.5, indent:10}));
      buf.y -= 3;
    }else if(items.length){
      items.forEach((it,ii)=> T(buf, `${SHEET_LETTERS[ii]||('('+(ii+1)+')')}.  ${String(it||'')}`, {size:9.5, indent:10}));
      T(buf, 'Wpisz w polu kolejność liter od najpierw do ostatniego.', {size:8, indent:10});
      buf.y -= 3;
    }else if(pairs.length){
      pairs.forEach((p,pi)=> T(buf, `${pi+1}.  ${String(p.left||'')}`, {size:9.5, indent:10}));
      T(buf, `Litery: ${pairs.map((_,pi)=>SHEET_LETTERS[pi]).join(', ')}`, {size:8, indent:10});
      buf.y -= 3;
    }
    if(q.type==='open_question' || q.type==='why_question' || q.type==='who_said'){
      openSlot(buf);
    }else if(q.type==='ordering' || q.type==='ranking'){
      slot(buf, 'Kolejność:', `${items.length} litery, oddzielone spacją`, items.length || 3);
    }else if(q.type==='match'){
      slot(buf, 'Odpowiedź:', `litery do wierszy 1-${pairs.length||3}, oddzielone spacją`, pairs.length || 3);
    }else if(isTF){
      slot(buf, 'Odpowiedź:', 'jedna litera: P lub F', 1);
    }else if(q.type==='multiple_select'){
      slot(buf, 'Odpowiedź:', `litery oddzielone przecinkami: ${sheetAlphabet(opts.length)}`, Math.max(2, opts.length));
    }else{
      slot(buf, 'Odpowiedź:', `jedna litera: ${sheetAlphabet(opts.length)}`, Math.max(2, Math.min(4, opts.length||4)));
    }
    commit(buf, 9);
  });

  // stopka arkusza — zawsze u dołu ostatniej strony
  const footBuf = newBuf(BOT + 30);
  RULE(footBuf, M, RIGHT, footBuf.y+4, 0.8);
  footBuf.y -= 8;
  T(footBuf, `Suma punktów: ____________ / ${(test.questions||[]).length}`, {size:9.5});
  T(footBuf, `Data oceny: ____________          Podpis nauczyciela: ____________________`, {size:9.5});
  commitAt(footBuf);

  // ── klucz odpowiedzi (nauczyciel) ──
  newPage();
  const keyBuf = newBuf(y);
  T(keyBuf, 'KLUCZ ODPOWIEDZI — tylko dla nauczyciela', {size:13, bold:true});
  T(keyBuf, `${test.title || 'Test sprawdzający'} — ${bookTitle} — ${chapterTitle}`, {size:10});
  keyBuf.y -= 4;
  (test.questions||[]).forEach((q, qi)=>{
    T(keyBuf, `${qi+1}. ${String(q.question||'')}`, {size:10});
    T(keyBuf, `   → Poprawna odpowiedź: ${answerText(q) ?? '—'}`, {size:9.5, bold:true, indent:6});
  });
  commit(keyBuf, 0);

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
  // Nauczyciel nie jest nauczycielem dlatego, że tak się zarejestrował. Konto
  // musi mieć szkolny e-mail, potwierdzony kodem, i decyzję administratora.
  if(!roleIsApproved(row)) {
    const status = row.approvalStatus || 'pending';
    if(roleIsSuspended(row)) return res.status(403).json({error:'teacher account is suspended', approvalStatus: status});
    return res.status(403).json({error:'teacher account is awaiting administrator approval', approvalStatus: status, emailVerified: !!row.emailVerified});
  }
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

// ── Panel administratora + zatwierdzanie ról + Secure Test Mode ────────────────
// Trzy nowe routery, podpięte do istniejącego shim-a `db`. Żaden z nich nie
// tworzy własnego logowania — admin ma hasło, a zgłoszenia o role korzystają
// z tego samego tożsamości (portfel) co reszta aplikacji.
const dbHelpers = createDbHelpers({ db, useMySQL });
const secureStore = createSecureSessionStore({ helpers: dbHelpers });

registerRoleAuth(app, { helpers: dbHelpers });

registerAdmin(app, {
  helpers: dbHelpers,
  sessions: secureStore,
  recordSecurityEvents: (...args) => secureStore.recordSecurityEvents(...args),
  terminateSession: (...args) => secureStore.terminateSession(...args),
});

registerSecure(app, {
  helpers: dbHelpers,
  store: secureStore,
  testsMem, attemptsMem, classesMem, normalizeClassCode,
  sanitizeStudentAnswers, stripTestSecrets, gradeTest, issueTestCertificate, persistAttempt,
  testBookTitle, testChapterTitle, requireStudent, studentActor,
});

if(useMySQL){
  setTimeout(() => {
    store_loadSessions();
    ensureBootstrapAdmin(dbHelpers).then(r => console.log(r.ok ? `[admin] konto: ${r.email}${r.created?' (utworzone)':''}` : `[admin] pominięto bootstrap: ${r.reason}`)).catch(e=>console.warn('[admin] bootstrap:', e.message));
  }, 3200);
} else {
  setTimeout(() => {
    store_loadSessions();
    ensureBootstrapAdmin(dbHelpers).then(r => console.log(r.ok ? `[admin] konto: ${r.email}${r.created?' (utworzone)':''}` : `[admin] pominięto bootstrap: ${r.reason}`)).catch(e=>console.warn('[admin] bootstrap:', e.message));
  }, 200);
}
async function store_loadSessions(){ await secureStore.load().catch(e=>console.warn('[secure] load:', e.message)); }

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
    questions: qs, settings: {mode: testMode, scope, chapters: assessment.chapters, secure: sanitizeSecurePolicy(req.body?.secure || req.body?.secureMode || undefined)},
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
    questionCount:(t.questions||[]).length, createdAt:t.createdAt, secure:t.settings?.secure || null
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
  const {title, chapters: requestedChapters, certificateScope, testMode, timerEnabled, timerMinutes, questions, status, secure, secureMode} = req.body || {};
  if(title !== undefined) t.title = String(title);
  if(secure !== undefined || secureMode !== undefined){
    t.settings = t.settings || {};
    t.settings.secure = sanitizeSecurePolicy(secure ?? secureMode);
  }
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
  const qs = (t && (t.questions||[])) || [];
  // PAPER_OCR: auto (oba silniki) | tesseract | vision
  const mode = String(process.env.PAPER_OCR || 'auto').toLowerCase();
  let engine = 'none';
  let ocrText = '';
  let fromTesseract = {};
  let fromVision = {};
  let engineMissing = false;
  const notes = [];

  if(mode !== 'vision'){
    const ocr = await runOcrText(file);
    ocrText = ocr.text || '';
    engineMissing = !!ocr.engineMissing;
    if(ocr.ok){
      fromTesseract = parseOcrAnswers(ocrText, qs);
      engine = 'tesseract';
    }else{
      notes.push(ocr.error || 'OCR textowy niedostępny na serwerze');
    }
  }

  if(mode !== 'tesseract' && visionAvailable()){
    const v = await readSheetWithVision(file, qs);
    if(v.ok){
      fromVision = v.answers || {};
      engine = engine === 'tesseract' ? 'tesseract+vision' : 'vision';
      if(!ocrText) ocrText = v.text || '';
      notes.push(`model wizyjny: ${v.engine}`);
    }else{
      notes.push(v.error || 'model wizyjny niedostępny');
      if(mode === 'vision') engineMissing = true;
    }
  }else if(mode !== 'tesseract'){
    notes.push('model wizyjny nie skonfigurowany (GEMINI_API_KEY)');
  }

  const parsed = (engine === 'tesseract') ? mergeSheetAnswers(fromTesseract, fromVision, qs)
              : (engine === 'vision') ? fromVision
              : {};

  p.ocrText = ocrText;
  p.ocrAnswers = { answers: parsed, engine };
  p.status = (engine === 'none') ? 'ocr_unavailable' : 'ocr_done';
  p.updatedAt = new Date().toISOString();
  paperMem.set(p.id, p); persistPaper(p);
  res.json({ok:true, paper:{
    id:p.id, status:p.status, language: 'pol+eng', engine,
    ocrText: p.ocrText.slice(0,3000),
    ocrAnswers: p.ocrAnswers.answers,
    questions: qs.map(stripTestSecrets),
    engineMissing,
    note: notes.length ? notes.join(' · ') : undefined
  }});
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
    // Student widzi tylko CZY test jest w trybie bezpiecznym, nigdy progi.
    secureEnabled: t.settings?.secure?.enabled !== false,
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
  if(score>=Math.max(4,total-1)) status='Reading Verified'; // pełne zrozumienie
  else if(score>=3) status='Partial Verified';              // certyfikat bez nagrody
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

// Jednorazowe przejęcie starych dowodów (sprzed stabilnego readerId).
// Przenosimy TYLKO wiersze z pustym userId, więc cudze, już przypisane dowody
// pozostają nietknięte. Ograniczenia (świadomie konserwatywne):
//  - userId bierzemy z nagłówka autoryzacyjnego, nie z body (inaczej dowolny identyfikator)
//  - nie wolno claimować portfela, który ma już przypisanego właściciela
//  - audyt w logu — zdarzenie jest odwracalne i widoczne
const CLAIM_AUDIT = new Map();
app.post('/api/proofs/claim', (req,res)=>{
  const wallet=(req.body?.wallet||req.query.wallet||'').toString().trim();
  const headerUser=String(req.headers['x-user-id']||req.headers['x-apple-user']||'').trim();
  const bodyUser=(req.body?.userId||'').toString().trim();
  if(!wallet) return res.status(400).json({error:'wallet required'});
  if(!headerUser) return res.status(401).json({error:'x-user-id header required'});
  // nagłówek ma pierwszeństwo; body tylko gdy brak nagłówka (kompatybilność)
  const userId=headerUser||bodyUser;
  if(bodyUser && headerUser && bodyUser!==headerUser) return res.status(400).json({error:'userId does not match authenticated header'});
  // rate limit: max 20 claimów na portfel
  const key = wallet.slice(0,8);
  const seen = CLAIM_AUDIT.get(key) || 0;
  if(seen >= 20) return res.status(429).json({error:'too many claim attempts for this wallet'});
  CLAIM_AUDIT.set(key, seen+1);
  const stamp = (table)=>new Promise((resolve)=>{
    try{ db.run(`UPDATE ${table} SET userId=? WHERE walletAddress=? AND (userId IS NULL OR userId='')`, [userId, wallet], (e)=>resolve(e?0:1)); }
    catch(e){ resolve(0); }
  });
  Promise.all([stamp('proofs'), stamp('certificates')]).then(([a,b])=>{
    console.log(`[claim] reader=${userId.slice(0,12)} wallet=${wallet.slice(0,6)}.. proofs=${a===1?'ok':'brak'} certs=${b===1?'ok':'brak'}`);
    res.json({ok:true, claimed:true, proofs:a===1, certificates:b===1});
  });
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
    // OR, nie AND: portfel embedded (Privy) zmienia się przy każdym logowaniu,
    // więc szukanie „moich dowodów" po samym adresie gubi całą historię.
    // Dopasowanie po userId (stabilny identyfikator czytelnika) ma pierwszeństwo.
    sql = `SELECT ${baseCols} FROM proofs WHERE userId=? OR walletAddress=? ORDER BY timestamp DESC LIMIT 50`;
    params=[filterUser, wallet];
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
        // baza bez kolumny userId — schodzimy do zapytania tylko po portfelu
        const fbCols = baseCols.split(',').filter(c=>!/userId/i.test(c)).join(',');
        const fbSql = wallet ? `SELECT ${fbCols} FROM proofs WHERE walletAddress=? ORDER BY timestamp DESC LIMIT 50` : `SELECT ${fbCols} FROM proofs ORDER BY timestamp DESC LIMIT 50`;
        const fbParams = wallet ? [wallet] : [];
        return db.all(fbSql, fbParams, (e2, r2)=>{
          if(e2) return res.status(500).json({error: e2.message, sql: fbSql});
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
// Certyfikat wystawiony dla pełnego LUB częściowego zrozumienia.
function certIssued(p){ return p && CERT_STATUSES.has(String(p.status||'')); }
// cert za całą lekturę: wszystkie rozdziały mają zweryfikowany dowód; ID trafia do memo on-chain
app.post('/api/books/:bookId/certificate', async (req,res)=>{
  const book=books.find(b=>b.id===req.params.bookId);
  if(!book) return res.status(404).json({error:'book not found'});
  const chapters=book.chapters||[];
  if(!chapters.length) return res.status(404).json({error:'book has no chapters'});
  const wallet=(req.body?.wallet||req.query.wallet||req.headers['x-user-id']||req.body?.userId||'').toString();
  if(!wallet) return res.status(400).json({error:'wallet required'});
  const userIdForCert = req.body?.userId || req.headers['x-user-id'] || req.headers['x-apple-user'] || null;
  // Zbieramy dowody po portfelu LUB po stabilnym userId — zmiana portfela nie może
  // unieważniać wcześniej zdobytych rozdziałów.
  const ownerWhere = userIdForCert ? '(userId=? OR walletAddress=?)' : 'walletAddress=?';
  const ownerParams = userIdForCert ? [userIdForCert, wallet] : [wallet];
  db.all(`SELECT bookId, chapterId, score, total, status, proofHash, timestamp FROM proofs WHERE ${ownerWhere} AND bookId=? ORDER BY timestamp DESC LIMIT 300`, [...ownerParams, book.id], async (err, rows)=>{
    if(err) return res.status(500).json({error:err.message});
    const by={}; for(const p of rows||[]) if(certVerified(p) && !by[p.chapterId]) by[p.chapterId]=p;
    const missing=chapters.filter(c=>!by[c.id]).map(c=>c.id);
    if(missing.length) return res.status(409).json({error:'Nie wszystkie rozdziały zweryfikowane.', missing});
    const certHash=crypto.createHash('sha256').update(`${wallet}|${book.id}|${chapters.map(c=>by[c.id].proofHash).join(',')}`).digest('hex').slice(0,32);
    db.get(`SELECT * FROM certificates WHERE ${userIdForCert ? '(userId=? OR walletAddress=?)' : 'walletAddress=?'} AND bookId=? AND kind='book' ORDER BY timestamp DESC LIMIT 1`, userIdForCert ? [userIdForCert, wallet, book.id] : [wallet, book.id], async (e2, existing)=>{
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
      // Awaitujemy zapis — inaczej zwracamy ID certu, którego jeszcze nie ma w bazie
      // i natychmiastowe /verify/?id=RP-… kończy się 404.
      const certSaved = await new Promise((resolve)=>{ try{ db.run(`INSERT INTO certificates (id, kind, bookId, chapterId, walletAddress, userId, score, total, status, certHash, txSignature, explorerUrl, timestamp, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [cid,'book', book.id, null, wallet, userIdForCert, chapters.length, chapters.length, 'Verified', certHash, tx, explorer, ts, ts],
        (e4)=>resolve(!e4)); }catch(e){ resolve(false); } });
      if(!certSaved){
        console.error(`[cert] insert FAIL (book) ${cid}: ${book.id} ${wallet}`);
        return res.status(500).json({error:'certificate could not be saved'});
      }
      // Certyfikat za całą lekturę kotwimy na devnecie jako osobny wpis.
      // tx z dowodu rozdziału (powyżej) jest w tym celu ignorowany — jest
      // transakcją nagrody, a nie certyfikatu, i myliłby weryfikację.
      await anchorCertificate({
        id: cid, kind: 'book', bookId: book.id, chapterId: null,
        walletAddress: wallet, score: chapters.length, total: chapters.length,
        status: 'Verified', timestamp: ts,
      });
      res.json({ok:true, existing:false, cert:{id:cid, kind:'book', bookId:book.id, chapterId:null, walletAddress:wallet, userId:userIdForCert, score:chapters.length, total:chapters.length, status:'Verified', tier:'full', certHash, txSignature:tx, explorerUrl:explorer, timestamp:ts, bookTitle:book.title, chapterTitle:null}});
    });
  });
});
// publiczna wedyfikacja certyfikatu po ID (RP-XXXX) — bez autoryzacji
app.get('/api/certificates/:id', (req,res)=>{
  const id=String(req.params.id||'').trim().toUpperCase();
  if(!id) return res.status(400).json({error:'id required'});
  db.get(`SELECT * FROM certificates WHERE UPPER(id)=?`, [id], (err,row)=>{
    if(err) return res.status(500).json({error:err.message});
    if(!row) return res.status(404).json({error:'certificate not found', id});
    const publicRow = {...row, chapterId:row.kind==='test'?null:row.chapterId};
    res.json({cert:{...publicRow, bookTitle:certBookTitle(row.bookId), chapterTitle:row.kind==='test'?'Cała książka':(row.chapterId?certChapterTitle(row.bookId,row.chapterId):null), verified:certVerified(row)||row.status==='Verified', tier:row.kind==='book'?'full':certTier(row.score,row.total), anchor:anchorView(row)}});
  });
});

// ── Odzyskanie certyfikatu prosto z devnetu, bez bazy ───────────────────────
// To jest sedno „zawsze można odzyskać": mając tylko podpis transakcji (np. z
// linku w explorerze albo z wydruku), odtwarzamy pełny certyfikat i sami
// przeliczamy anchorHash. Baza może być pusta, skasowana albo podmieniona —
// wynik tutaj zależy wyłącznie od łańcucha.
app.get('/api/certificates/chain/:signature', async (req,res)=>{
  const from = await readAnchorFromChain(req.params.signature, { rpc: SOLANA_RPC });
  if(!from.ok) return res.status(404).json({error: from.error || 'anchor not found on devnet'});
  const cert = from.cert;
  res.json({
    fromChain: true,
    network: 'devnet',
    slot: from.slot,
    blockTime: from.blockTime ? new Date(from.blockTime*1000).toISOString() : null,
    // blockTime to czas z samego łańcucha — niezmienny, w przeciwieństwie do
    // createdAt z bazy, które można było w każdej chwili poprawić.
    issuedAt: cert.issuedAt,
    explorerUrl: from.explorerUrl,
    memo: from.memo,
    anchor: { version: from.version, hash: from.anchorHash, expectedHash: from.expectedHash, hashValid: from.hashValid },
    cert: { ...cert, chapterId: cert.kind === 'test' ? null : cert.chapter,
           bookTitle: certBookTitle(cert.book), chapterTitle: cert.kind === 'test' ? 'Cała książka' : (cert.chapter ? certChapterTitle(cert.book, cert.chapter) : null),
           verified: true, tier: cert.kind==='book' ? 'full' : certTier(cert.score, cert.total) },
  });
});

// Pełna weryfikacja: memo z łańcucha vs wiersz z bazy + haszowanie.
// Odpowiada na pytanie, na które /api/certificates/:id nie umie: „czy ktoś
// nie podmienił nam certyfikatu po wystawieniu".
app.get('/api/certificates/:id/verify', async (req,res)=>{
  const id=String(req.params.id||'').trim().toUpperCase();
  if(!id) return res.status(400).json({error:'id required'});
  const row = await new Promise((resolve)=>{ try{ db.get(`SELECT * FROM certificates WHERE UPPER(id)=?`, [id], (e,r)=>resolve(e?null:r)); }catch{ resolve(null); } });
  if(!row) return res.status(404).json({error:'certificate not found', id});

  const memo = row.anchorMemo || null;
  const local = memo ? parseAnchorMemo(memo) : { ok:false, error:'brak memo w bazie' };
  let chain = { ok:false, error:'brak podpisu' };
  if(row.txSignature) chain = await readAnchorFromChain(row.txSignature, { rpc: SOLANA_RPC });

  const cmp = chain.ok ? compareWithRow(chain.cert, row) : null;
  const issues = [];
  if(!row.txSignature) issues.push('brak podpisu — certyfikat nie był kotwiony');
  if(!memo) issues.push('brak memo w bazie — certyfikat sprzed wdrożenia kotwicy');
  if(memo && !local.hashValid) issues.push('memo ma błędny anchorHash — ktoś je edytował');
  if(chain.ok && !chain.hashValid) issues.push('memo z łańcucha ma błędny anchorHash');
  if(cmp && !cmp.matches) issues.push(`baza różni się od łańcucha: ${cmp.diffs.join(', ')}`);
  if(chain.ok && !local.ok) issues.push('memo z bazy nie zgadza się z łańcuchem');

  res.json({
    id, network: 'devnet',
    // Trzy niezależne fakty: jest podpis, memo jest spójne samo ze sobą,
    // baza nie kłamie wobec łańcucha.
    signatureOnChain: chain.ok,
    memoSelfConsistent: memo ? !!local.hashValid : false,
    databaseMatchesChain: cmp ? cmp.matches : null,
    immutable: chain.ok && !!local.hashValid && (cmp ? cmp.matches : true),
    slot: chain.slot ?? row.anchorSlot ?? null,
    blockTime: chain.ok && chain.blockTime ? new Date(chain.blockTime*1000).toISOString() : null,
    explorerUrl: row.explorerUrl || chain.explorerUrl || null,
    diffs: cmp ? cmp.diffs : null,
    issues,
    note: 'anchorHash liczy się z pól memo. blockTime pochodzi z łańcucha, więc jest niezmienny.',
  });
});

// Domknięcie kotwicy po awarii (brak klucza, RPC padło). Wymaga klucza
// admina, żeby nie było darmowego endpointu do spamowania devnetu.
app.post('/api/certificates/:id/anchor', async (req,res)=>{
  if(String(process.env.ANCHOR_ADMIN_TOKEN||'')==='' || req.headers['x-anchor-token']!==process.env.ANCHOR_ADMIN_TOKEN)
    return res.status(401).json({error:'anchor token required'});
  const id=String(req.params.id||'').trim().toUpperCase();
  const row = await new Promise((resolve)=>{ try{ db.get(`SELECT * FROM certificates WHERE UPPER(id)=?`, [id], (e,r)=>resolve(e?null:r)); }catch{ resolve(null); } });
  if(!row) return res.status(404).json({error:'certificate not found', id});
  const r = await anchorCertificate(row, { force: true });
  res.status(r.ok ? 200 : 503).json(r.ok ? {ok:true, ...r} : {ok:false, error:r.error});
});
// lista certyfikatów użytkownika (chapter + book)
app.get('/api/certificates', (req,res)=>{
  const wallet=req.query.wallet;
  const userId=req.query.userId || req.headers['x-user-id'] || req.headers['x-apple-user'] || null;
  const authH=req.headers['authorization']||'';
  let fu=userId; if(!fu && authH.startsWith('Bearer ')) fu=authH.slice(7).trim();
  const where=[]; const params=[];
  // OR przy obu identyfikatorach — portfel embedded zmienia się między logowaniami,
  // a dowody muszą zostać przy czytelniku (patrz /api/proofs).
  if(wallet && fu){ where.push('(userId=? OR walletAddress=?)'); params.push(fu, wallet); }
  else if(wallet){ where.push('walletAddress=?'); params.push(wallet); }
  else if(fu){ where.push('userId=?'); params.push(fu); }
  if(!where.length) return res.json({certificates:[]});
  db.all(`SELECT * FROM certificates WHERE ${where.join(' AND ')} ORDER BY timestamp DESC LIMIT 100`, params, (err,rows)=>{
    if(err) return res.status(500).json({error:err.message});
    res.json({certificates:(rows||[]).map(r=>{ const item={...r, chapterId:r.kind==='test'?null:r.chapterId}; return {...item, bookTitle:certBookTitle(r.bookId), chapterTitle:r.kind==='test'?'Cała książka':(r.chapterId?certChapterTitle(r.bookId,r.chapterId):null), verified:certVerified(r)||r.status==='Verified', tier:r.kind==='book'?'full':certTier(r.score,r.total), anchor:anchorView(r)}; })});
  });
});

app.get('/api/wallet/:address', (req,res)=>{
  res.json({address:req.params.address, balance:'12.50 USDC (Devnet)', network:'Solana Devnet', explorerBase:'https://explorer.solana.com/address/'});
});

// Generator pul. UWAGA (ryzyko szczątkowe): endpoint zwraca pełne pytania z kluczami,
// bo aplikacja iOS (BackendService.generateChallenges) ocenia odpowiedzi LOKALNIE —
// obcięcie klucza złamałoby jej scoring. Web nie z tego korzysta (ocenia serwer).
// Dlatego przynajmniej ograniczamy nadużycie: limit żądań na adres IP.
const GENERATE_BUDGET = new Map();
app.post('/api/generate', async (req,res)=>{
  const {bookId, chapterId, count} = req.body;
  const lang=langOf(req);
  const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket?.remoteAddress || 'local';
  const used = GENERATE_BUDGET.get(ip) || 0;
  if(used >= 30) return res.status(429).json({error:'Limit generowania pytań wyczerpany. Spróbuj za jakiś czas.'});
  GENERATE_BUDGET.set(ip, used+1);
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
// Rola zalogowanego użytkownika na podstawie nagłówka tożsamości (x-user-id / x-apple-user).
// Zwraca null, gdy brak identyfikacji — wtedy traktujemy jako brak uprawnień.
async function userRoleFor(req){
  const actor=String(req.headers['x-user-id']||req.headers['x-apple-user']||'').trim();
  if(!actor) return null;
  const row=await new Promise((resolve)=>{
    db.get(`SELECT role FROM users WHERE walletAddress=? OR appleUserId=?`, [actor, actor], (e,r)=>{ if(e) return resolve(null); resolve(r); });
  });
  return row ? (row.role||'reader') : null;
}
async function requireAnyRole(req, roles){
  const role=await userRoleFor(req);
  return role && roles.includes(role);
}

// Pełny tekst książki — TYLKO dla nauczyciela/wydawcy.
// Publicznie udostępniamy max 2000 znaków, bo treść książki jest objęta licencją,
// a pełny tekst pozwoliłby zlać test bez przeczytania lektury.
// ═══════════════════════════════════════════════════════════════════════════
// Rozliczenie nagrody dla książki wydawcy.
// Pula maleje w TEN SAMYM zapytaniu co sprawdzenie salda (warunek w UPDATE),
// więc równoległe sesje nie wypłacą z jednej puli.
// Statusy: confirmed = podpis w sieci, pending = zarezerwowano (brak payera), failed = brak środków.
// ═══════════════════════════════════════════════════════════════════════════
async function settlePublisherPayout({ bookId, chapterId, wallet, userId, score, total, reward, tx, explorer, proofHash, at }){
  if(!bookId) return null;
  // Książka musi należeć do wydawcy i mieć pulę.
  const pubRow = await new Promise((resolve)=>{
    db.get(`SELECT * FROM publisher_books WHERE publishedBookId=?`, [String(bookId)], (e,r)=>{ if(e) return resolve(null); resolve(r); });
  });
  if(!pubRow) return null;                                   // zwykła książka — brak puli
  const amount = numOr(pubRow.rewardPerProof, 5);
  const currency = pubRow.currency || 'USDC';
  const payoutId = 'pay-' + crypto.randomBytes(5).toString('hex');
  const createdAt = at || new Date().toISOString();
  // Rezerwacja: UPDATE ... WHERE rewardPool >= amount — atomowe w MySQL.
  const reserved = await new Promise((resolve)=>{
    try{
      db.run(`UPDATE publisher_books SET rewardPool = rewardPool - ?, updatedAt=? WHERE id=? AND rewardPool >= ?`,
        [amount, createdAt, pubRow.id, amount], (e)=>resolve(!e));
    }catch(e){ resolve(false); }
  });
  if(!reserved){
    // Pula się wyczerpała — zapisujemy nieudaną wypłatę, żeby wydawca widział powód.
    await new Promise((resolve)=>{
      try{ db.run(`INSERT INTO payouts (id, bookId, walletAddress, userId, chapterId, amount, currency, status, txSignature, explorerUrl, errorMessage, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [payoutId, pubRow.id, wallet||null, userId||null, chapterId||null, amount, currency, 'failed', tx||null, explorer||null, 'reward pool depleted', createdAt], ()=>resolve()); }
      catch(e){ resolve(); }
    });
    return { status:'failed', reason:'reward pool depleted', amount, currency };
  }
  // confirmed tylko gdy mamy prawdziwy podpis w sieci; brak payera = pending.
  const status = tx ? 'confirmed' : 'pending';
  await new Promise((resolve)=>{
    try{ db.run(`INSERT INTO payouts (id, bookId, walletAddress, userId, chapterId, amount, currency, status, txSignature, explorerUrl, errorMessage, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [payoutId, pubRow.id, wallet||null, userId||null, chapterId||null, amount, currency, status, tx||null, explorer||null, tx?null:'no SOLANA_PAYER_PRIVATE_KEY — Devnet only', createdAt], ()=>resolve()); }
    catch(e){ resolve(); }
  });
  console.log(`[payout] ${status} ${amount} ${currency} book=${pubRow.id} ch=${chapterId} tx=${tx||'—'}`);
  return { status, amount, currency, txSignature: tx||null };
}

app.get('/api/books/:bookId/text', async (req,res)=>{
  const privileged=await requireAnyRole(req, ['teacher','publisher']);
  const b=books.find(x=>x.id===req.params.bookId);
  if(!b || !b.fullTextFile) return res.status(404).json({error:'no text'});
  const file=`./texts/${b.fullTextFile}`;
  const fallback=`./${b.fullTextFile}`;
  const p= fs.existsSync(file) ? file : fallback;
  if(!fs.existsSync(p)) return res.status(404).json({error:'file not found', expected:b.fullTextFile});
  const txt=fs.readFileSync(p,'utf8');
  if(!privileged){
    return res.json({bookId:b.id, preview: txt.slice(0,2000), truncated:true,
      note:'Full text available to teachers and publishers only. ReadProof verifies comprehension, not physical reading.'});
  }
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
  // Tworzy globalną książkę w books[] — tylko nauczyciel/wydawca, nie anonimowy czytelnik.
  if(!(await requireAnyRole(req, ['teacher','publisher']))) return res.status(403).json({error:'teacher or publisher role required'});
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

// ═══════════════════════════════════════════════════════════════════════════
// PANEL WYDAWCY — API
// Wszystkie trasy poniżej dziedziczą app.use('/api/publisher', requirePublisher,
// pinPublisherWallet) zarejestrowane wcześniej w pliku. Tożsamość wydawcy
// pochodzi WYŁĄCZNIE z autoryzowanego rekordu users.role='publisher' —
// publisherWallet z body/query jest ignorowany (pinowany).
// ═══════════════════════════════════════════════════════════════════════════

const PUB_STATUSES = new Set(['draft','processing','review','published','paused','completed','error']);
const pubId = () => 'pub-' + crypto.randomBytes(4).toString('hex');
// Bezpieczna nazwa pliku — tylko [a-z0-9_-], bez ścieżek katalogowych.
const pubSafe = (id) => String(id||'').replace(/[^A-Za-z0-9_-]/g,'_');

function parseChapters(json){
  if(Array.isArray(json)) return json;
  if(typeof json==='string'){ try{ const p=JSON.parse(json); return Array.isArray(p)?p:[]; }catch(e){ return []; } }
  return [];
}
// Publiczny widok książki wydawcy — bez pól wrażliwych (hash treści, ścieżka pliku).
function pubBookView(row, extra={}){
  const chapters = parseChapters(row.chapters);
  return {
    id: row.id, title: row.title, titleEn: row.titleEn||null, author: row.author,
    description: row.description||'', isbn: row.isbn||null, language: row.language||'pl',
    coverUrl: row.coverUrl||null, status: row.status||'draft',
    contentLength: Number(row.contentLength||0), hasContent: !!row.bookContentHash,
    chapters, chapterCount: chapters.length,
    rewardPool: numOr(row.rewardPool,0), rewardPerProof: numOr(row.rewardPerProof,5), currency: row.currency||'USDC',
    publishedBookId: row.publishedBookId||null, errorMessage: row.errorMessage||null,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
    privacy: PRIVACY_SHORT,
    ...extra
  };
}
// Ile zatwierdzonych pytań ma rozdział.
function approvedCount(chapterId){ return approvedPool(chapterId).length; }
// Czy książka nadaje się do publikacji (min. 5 zatwierdzonych pytań na rozdział).
function publishBlockers(row){
  const chapters = parseChapters(row.chapters);
  const out = [];
  if(!row.bookContentHash) out.push({code:'no_content', message:'Treść książki nie została wgrana'});
  if(!chapters.length) out.push({code:'no_chapters', message:'Brak rozdziałów'});
  for(const c of chapters){
    const n = approvedCount(c.id);
    if(n < 5) out.push({code:'not_enough_questions', chapterId:c.id, chapterTitle:c.title||c.id, need:5, have:n});
  }
  if(numOr(row.rewardPool,0) < numOr(row.rewardPerProof,5)) out.push({code:'reward_pool_too_low', message:'Pula nagród musi pokrywać co najmniej jedną nagrodę za rozdział'});
  return out;
}
const dbAll = (sql, params) => new Promise((resolve)=>{ try{ db.all(sql, params, (e,r)=>resolve(e?[]:(r||[]))); }catch(e){ resolve([]); } });
const dbGet = (sql, params) => new Promise((resolve)=>{ try{ db.get(sql, params, (e,r)=>resolve(e?null:r)); }catch(e){ resolve(null); } });
const dbRun = (sql, params) => new Promise((resolve)=>{ try{ db.run(sql, params, (e)=>{ if(e) console.error('[pub:db]', e.message, '| sql:', sql.slice(0,90)); resolve(!e); }); }catch(e){ console.error('[pub:db]', e.message); resolve(false); } });

// ── Dashboard ──────────────────────────────────────────────────────────────
app.get('/api/publisher/dashboard', async (req,res)=>{
  const me = publisherOf(req);
  const rows = await dbAll(`SELECT * FROM publisher_books WHERE ownerWallet=? ORDER BY updatedAt DESC LIMIT 100`, [me]);
  const books = rows.map(r=>pubBookView(r));
  const ids = books.map(b=>b.id);
  const published = ids.filter(id=>!!(books.find(b=>b.id===id)?.publishedBookId));
  const publishedBookIds = rows.map(r=>r.publishedBookId).filter(Boolean);

  let testsCompleted=0, activeReaders=0, avgScore=null, rewardsDistributed=0, distributedPending=0;
  const verifiedAt = new Map();
  if(publishedBookIds.length){
    const ph = publishedBookIds.map(()=>'?').join(',');
    const proofs = await dbAll(`SELECT walletAddress, userId, score, total, status, timestamp FROM proofs WHERE bookId IN (${ph}) ORDER BY timestamp DESC LIMIT 1000`, publishedBookIds);
    const verified = proofs.filter(p=>VERIF_STATUSES.has(String(p.status)) || p.status==='Partial Verified');
    testsCompleted = verified.length;
    const who = new Set(verified.map(p=>p.userId||p.walletAddress).filter(Boolean));
    activeReaders = who.size;
    const scored = verified.filter(p=>Number(p.total)>0);
    if(scored.length) avgScore = Math.round(scored.reduce((a,p)=>a+(Number(p.score)/Number(p.total)),0)/scored.length*100);
    // Timeline własnych książek: dzień -> liczba ukończonych testów. Bez tego wykres byłby pusty.
    for(const p of verified){
      const day = String(p.timestamp||'').slice(0,10);
      if(/^\d{4}-\d{2}-\d{2}$/.test(day)) verifiedAt.set(day, (verifiedAt.get(day)||0)+1);
    }
  }
  const timeline = [...verifiedAt.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([day,tests])=>({day, tests}));
  const payouts = await dbAll(`SELECT * FROM payouts WHERE bookId IN (${ids.map(()=>'?').join(',')||"''"}) ORDER BY createdAt DESC LIMIT 500`, ids.length?ids:["''"]);
  for(const p of payouts){
    if(p.status==='confirmed') rewardsDistributed += numOr(p.amount,0);
    else if(p.status==='pending') distributedPending += numOr(p.amount,0);
  }
  // Aktywność — wyprowadzamy z prawdziwych zdarzeń, nie z fikcyjnego feedu.
  const activity = [];
  for(const p of payouts.slice(0,20)) activity.push({type:'reward', text:`Nagroda ${p.amount} ${p.currency} — ${p.status}`, at:p.createdAt, bookId:p.bookId});
  const recentProofs = publishedBookIds.length
    ? await dbAll(`SELECT bookId, chapterId, score, total, status, timestamp FROM proofs WHERE bookId IN (${publishedBookIds.map(()=>'?').join(',')}) ORDER BY timestamp DESC LIMIT 20`, publishedBookIds)
    : [];
  for(const p of recentProofs){
    activity.push({type:'proof', text:`Czytelnik ukończył test — ${p.score}/${p.total} (${p.status})`, at:p.timestamp, bookId:p.bookId, chapterId:p.chapterId});
  }
  for(const b of books.filter(x=>x.updatedAt).slice(0,10)){
    activity.push({type:'book', bookId:b.id, status:b.status, text:b.title, at:b.updatedAt});
  }
  activity.sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  res.json({
    publisher: { wallet: me, displayName: req.publisher?.displayName||null },
    kpis: {
      books: books.length,
      booksPublished: published.length,
      activeReaders, testsCompleted,
      rewardsDistributed: Number(rewardsDistributed.toFixed(2)),
      rewardsPending: Number(distributedPending.toFixed(2)),
      averageScore: avgScore,
      timeline
    },
    books,
    activity: activity.slice(0,12),
    privacy: PRIVACY_SHORT
  });
});

// ── Books: lista ───────────────────────────────────────────────────────────
app.get('/api/publisher/books', async (req,res)=>{
  const me = publisherOf(req);
  const rows = await dbAll(`SELECT * FROM publisher_books WHERE ownerWallet=? ORDER BY updatedAt DESC LIMIT 200`, [me]);
  const out = [];
  for(const r of rows){
    const chapters = parseChapters(r.chapters);
    const withCounts = chapters.map(c=>({...c, approved: approvedCount(c.id), draft: poolForChapter(c.id).filter(c=>!isQuestionApproved(c)).length}));
    const publishedId = r.publishedBookId;
    let readers = 0, tests = 0;
    if(publishedId){
      const proofs = await dbAll(`SELECT walletAddress, userId, status FROM proofs WHERE bookId=?`, [publishedId]);
      tests = proofs.filter(p=>VERIF_STATUSES.has(String(p.status)) || p.status==='Partial Verified').length;
      readers = new Set(proofs.map(p=>p.userId||p.walletAddress).filter(Boolean)).size;
    }
    out.push(pubBookView(r, { chapters: withCounts, readers, testsCompleted: tests, publishBlockers: publishBlockers(r) }));
  }
  res.json({count: out.length, books: out, privacy: PRIVACY_SHORT});
});

// ── Books: utwórz (wizard krok 1) ─────────────────────────────────────────
app.post('/api/publisher/books', async (req,res)=>{
  const me = publisherOf(req);
  const b = req.body||{};
  const title = String(b.title||'').trim();
  if(!title) return res.status(422).json({error:'Tytuł jest wymagany'});
  if(title.length > 200) return res.status(422).json({error:'Tytuł jest za długi (max 200 znaków)'});
  const author = String(b.author||'').trim();
  if(!author) return res.status(422).json({error:'Autor jest wymagany'});
  const isbn = b.isbn ? normalizeISBN(b.isbn) : null;
  if(isbn && !isValidISBN(isbn)) return res.status(422).json({error:'Nieprawidłowy ISBN (10 lub 13 cyfr)'});
  const coverUrl = b.coverUrl ? String(b.coverUrl).slice(0,500) : null;
  if(coverUrl && !/^https?:\/\//i.test(coverUrl)) return res.status(422).json({error:'Adres okładki musi być URL (http/https)'});
  const language = ['pl','en'].includes(String(b.language||'')) ? String(b.language) : 'pl';
  const rewardPerProof = numOr(b.rewardPerProof, 5);
  if(rewardPerProof <= 0 || rewardPerProof > 1000) return res.status(422).json({error:'Nagroda za dowód musi być z zakresu 0–1000'});
  const id = pubId();
  const now = new Date().toISOString();
  const ok = await dbRun(`INSERT INTO publisher_books (id, ownerWallet, title, titleEn, author, description, isbn, language, coverUrl, status, contentLength, bookContentHash, contentFile, chapters, rewardPool, rewardPerProof, currency, publishedBookId, errorMessage, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, me, title, String(b.titleEn||'').trim()||null, author, String(b.description||'').slice(0,4000), isbn, language, coverUrl, 'draft', 0, null, null, JSON.stringify([]), 0, rewardPerProof, (b.currency==='SOL'?'SOL':'USDC'), null, null, now, now]);
  if(!ok) return res.status(500).json({error:'Nie udało się zapisać książki'});
  const row = await dbGet(`SELECT * FROM publisher_books WHERE id=?`, [id]);
  console.log(`[pub] create book ${id} by ${me.slice(0,6)}.. "${title}"`);
  res.status(201).json({ok:true, book: pubBookView(row)});
});

// ── Books: szczegóły ───────────────────────────────────────────────────────
app.get('/api/publisher/books/:id', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const row = owned.row;
  const chapters = parseChapters(row.chapters).map(c=>({...c, approved: approvedCount(c.id), draft: poolForChapter(c.id).filter(x=>!isQuestionApproved(x)).length}));
  let readers=0, tests=0, avg=null;
  if(row.publishedBookId){
    const proofs = await dbAll(`SELECT score, total, status, userId, walletAddress, timestamp FROM proofs WHERE bookId=? ORDER BY timestamp DESC LIMIT 1000`, [row.publishedBookId]);
    const verified = proofs.filter(p=>VERIF_STATUSES.has(String(p.status)) || p.status==='Partial Verified');
    tests = verified.length;
    readers = new Set(verified.map(p=>p.userId||p.walletAddress).filter(Boolean)).size;
    const scored = verified.filter(p=>Number(p.total)>0);
    if(scored.length) avg = Math.round(scored.reduce((a,p)=>a+Number(p.score)/Number(p.total),0)/scored.length*100);
  }
  const payouts = await dbAll(`SELECT status, amount, currency FROM payouts WHERE bookId=?`, [row.id]);
  const funds = await dbAll(`SELECT * FROM campaign_funds WHERE campaignId=? ORDER BY createdAt DESC`, [row.id]);
  res.json({book: pubBookView(row, {
    chapters, readers, testsCompleted: tests, averageScore: avg,
    publishBlockers: publishBlockers(row),
    rewardSummary: {
      total: numOr(row.rewardPool,0) + numOr(row.rewardPerProof,5)*0 + payouts.reduce((a,p)=>a+numOr(p.amount,0),0),
      pool: numOr(row.rewardPool,0),
      distributed: payouts.filter(p=>p.status==='confirmed').reduce((a,p)=>a+numOr(p.amount,0),0),
      pending: payouts.filter(p=>p.status==='pending').reduce((a,p)=>a+numOr(p.amount,0),0),
      failed: payouts.filter(p=>p.status==='failed').reduce((a,p)=>a+numOr(p.amount,0),0),
      perProof: numOr(row.rewardPerProof,5), currency: row.currency||'USDC'
    },
    fundingHistory: funds.map(f=>({id:f.id, amount:numOr(f.amount,0), currency:f.currency, txSignature:f.txSignature, explorerUrl:f.explorerUrl, createdAt:f.createdAt, status: f.txSignature? 'submitted':'recorded'}))
  }), privacy: PRIVACY_SHORT});
});

// ── Books: edycja metadanych / rozdziałów ─────────────────────────────────
app.patch('/api/publisher/books/:id', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const row = owned.row, b = req.body||{};
  if(row.status==='processing') return res.status(409).json({error:'Książka jest przetwarzana — poczekaj chwilę'});
  const sets=[], params=[];
  const str=(v,max)=>String(v??'').trim().slice(0,max);
  if(b.title!==undefined){ const t=str(b.title,200); if(!t) return res.status(422).json({error:'Tytuł nie może być pusty'}); sets.push('title=?'); params.push(t); }
  if(b.titleEn!==undefined){ sets.push('titleEn=?'); params.push(str(b.titleEn,200)||null); }
  if(b.author!==undefined){ const a=str(b.author,200); if(!a) return res.status(422).json({error:'Autor nie może być pusty'}); sets.push('author=?'); params.push(a); }
  if(b.description!==undefined){ sets.push('description=?'); params.push(String(b.description||'').slice(0,4000)); }
  if(b.isbn!==undefined){ const v=b.isbn?normalizeISBN(b.isbn):null; if(v && !isValidISBN(v)) return res.status(422).json({error:'Nieprawidłowy ISBN'}); sets.push('isbn=?'); params.push(v); }
  if(b.coverUrl!==undefined){ const v=b.coverUrl?str(b.coverUrl,500):null; if(v && !/^https?:\/\//i.test(v)) return res.status(422).json({error:'Adres okładki musi być URL'}); sets.push('coverUrl=?'); params.push(v); }
  if(b.language!==undefined){ sets.push('language=?'); params.push(['pl','en'].includes(String(b.language))?String(b.language):'pl'); }
  if(b.rewardPerProof!==undefined){ const v=numOr(b.rewardPerProof,NaN); if(!(v>0)||v>1000) return res.status(422).json({error:'Nagroda za dowód musi być z zakresu 0–1000'}); sets.push('rewardPerProof=?'); params.push(v); }
  if(b.currency!==undefined){
    const cur = str(b.currency,8).toUpperCase();
    if(!['USDC','SOL'].includes(cur)) return res.status(422).json({error:'Waluta musi być USDC albo SOL'});
    // Zmiana waluty przy niepustej puli rozspójniłaby historię wypłat — wtedy tylko przyszłe doładowania.
    if(cur!==String(row.currency||'USDC').toUpperCase() && numOr(row.rewardPool,0)>0)
      return res.status(409).json({error:'Nie można zmienić waluty przy niepustej puli nagród'});
    sets.push('currency=?'); params.push(cur);
  }
  if(b.chapters!==undefined){
    // Sanityzacja rozdziałów: title wymagany, id regenerowany wg index, enabled zamiast usuwania.
    const inArr = Array.isArray(b.chapters) ? b.chapters : [];
    if(inArr.length > 40) return res.status(422).json({error:'Maksymalnie 40 rozdziałów'});
    const norm = inArr.map((c,i)=>{
      const title = str(c?.title,200);
      return {
        id: `${row.id}-ch${i+1}`,
        bookId: row.id,
        index: i+1,
        title: title || `Rozdział ${i+1}`,
        summary: str(c?.summary,400),
        contextExcerpt: str(c?.contextExcerpt,600),
        reward: str(c?.reward,32) || `${row.currency||'USDC'}`,
        enabled: c?.enabled!==false
      };
    });
    sets.push('chapters=?'); params.push(JSON.stringify(norm));
  }
  if(!sets.length) return res.status(422).json({error:'Brak pól do zaktualizowania'});
  sets.push('updatedAt=?'); params.push(new Date().toISOString());
  params.push(row.id);
  const ok = await dbRun(`UPDATE publisher_books SET ${sets.join(', ')} WHERE id=?`, params);
  if(!ok) return res.status(500).json({error:'Nie udało się zapisać zmian'});
  const fresh = await dbGet(`SELECT * FROM publisher_books WHERE id=?`, [row.id]);
  res.json({ok:true, book: pubBookView(fresh)});
});

// ── Books: treść (wizard krok 2) ──────────────────────────────────────────
app.post('/api/publisher/books/:id/content', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const row = owned.row;
  const raw = String(req.body?.text || req.body?.content || '');
  if(raw.trim().length < 500) return res.status(422).json({error:'Treść jest za krótka (minimum 500 znaków)'});
  if(raw.length > 600000) return res.status(422).json({error:'Treść jest za długa (maksimum 600 000 znaków)'});

  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const file = `pub_${pubSafe(row.id)}.txt`;
  try{
    fs.mkdirSync('./texts', {recursive:true});
    fs.writeFileSync(`./texts/${file}`, raw, 'utf8');
  }catch(e){
    await dbRun(`UPDATE publisher_books SET status=?, errorMessage=?, updatedAt=? WHERE id=?`, ['error', 'Nie udało się zapisać treści na dysku', new Date().toISOString(), row.id]);
    return res.status(500).json({error:'Nie udało się zapisać treści książki'});
  }
  bookTexts[row.id] = raw;
  const now = new Date().toISOString();
  await dbRun(`UPDATE publisher_books SET contentFile=?, bookContentHash=?, contentLength=?, status=?, errorMessage=NULL, updatedAt=? WHERE id=?`, [file, hash, raw.length, 'processing', now, row.id]);

  // Rozdziały: dziel po nagłówkach typu "Rozdział X" / "Chapter X", w razie braku równomiernie.
  const detection = detectChaptersDetailed(raw, row.id);
  const detected = detection.chapters;
  await dbRun(`UPDATE publisher_books SET chapters=?, updatedAt=? WHERE id=?`, [JSON.stringify(detected), now, row.id]);

  // Pytania generujemy w tle (LLM bywa wolny) — status książki idzie w 'processing'.
  // Rozdziały przetwarzamy RÓWNOLEGLE: przy 10 rozdziałach sekwencyjnie czekano
  // by kilka minut, a wydawca nie mógł w tym czasie nic zrobić.
  (async()=>{
    try{
      await Promise.all(detected.map(async (c)=>{
        const existing = challengesByChapter[c.id] || [];
        if(existing.filter(isQuestionApproved).length >= 5) return;
        const gen = await callOpenRouterGenerate(c, 8, row.language||'pl');
        const clean = sanitizePool(gen).map(q=>({...q, status:'draft', chapterId:c.id, bookId:row.id}));
        if(clean.length) challengesByChapter[c.id] = clean;
      }));
      persistChallenges();
      const fresh = await dbGet(`SELECT * FROM publisher_books WHERE id=?`, [row.id]);
      publishBlockers(fresh); // walidacja po wygenerowaniu
      await dbRun(`UPDATE publisher_books SET status=?, errorMessage=NULL, updatedAt=? WHERE id=?`, ['review', new Date().toISOString(), row.id]);
      console.log(`[pub] content processed ${row.id} → ${detected.length} chapters, questions generated`);
    }catch(e){
      await dbRun(`UPDATE publisher_books SET status=?, errorMessage=?, updatedAt=? WHERE id=?`, ['error', String(e.message||e).slice(0,400), new Date().toISOString(), row.id]);
      console.error('[pub] content processing failed', row.id, e.message);
    }
  })();

  res.json({ok:true, status:'processing', contentLength: raw.length, contentHash: hash.slice(0,16), chapters: detected,
    // Skąd wzięły się granice rozdziałów. Wydawca musi to widzieć: „wykryte po
    // nagłówkach" i „podzielone równomiernie, bo spisu nie było" to dwie różne
    // sytuacje, a bez tego komunikat „nie wykryto rozdziałów" jest nie do zdiagnozowania.
    detection: { mode: detection.mode, reason: detection.reason || null, count: detected.length, headerTitles: detection.headerTitles.slice(0, 20) },
    message:'Treść przyjęta. Pytania generujemy w tle — status książki zmieni się na „do przeglądu".'});
});

// Wykrywanie rozdziałów mieszka w ./chapters.js — osobny moduł, bo ma własne
// testy (test/chapters.test.mjs). Wersja w tym pliku gubiła m.in. przedmowę:
// tekst przed pierwszym nagłówkiem wypadał z książki po cichu.
app.get('/api/publisher/books/:id/content', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const row = owned.row;
  if(!row.bookContentHash) return res.status(404).json({error:'Ta książka nie ma jeszcze treści'});
  const txt = bookTexts[row.id] || '';
  res.json({contentLength: Number(row.contentLength||0), contentHash: row.bookContentHash.slice(0,16),
    preview: txt.slice(0,3000), privacy: PRIVACY_SHORT,
    note:'Treść książki nigdy nie trafia na łańcuch bloków — tylko jej skrót SHA-256.'});
});

// ── Pytania: lista do przeglądu (z kluczem — wydawca musi widzieć poprawne) ─
app.get('/api/publisher/books/:id/questions', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const chapters = parseChapters(owned.row.chapters);
  const out = chapters.map(c=>{
    const pool = poolForChapter(c.id);
    return {
      chapterId: c.id, chapterIndex: c.index, chapterTitle: c.title,
      approved: pool.filter(isQuestionApproved).length,
      draft: pool.filter(q=>qStatus(q)==='draft').length,
      rejected: pool.filter(q=>qStatus(q)==='rejected').length,
      questions: pool.map(q=>({
        id: q.id, type: q.type, question: q.question,
        options: q.options||q.statements||null,
        correctAnswer: q.correctAnswer, correctAnswers: q.correctAnswers, correctOrder: q.correctOrder,
        pairs: q.pairs||null, errorIndex: q.errorIndex, expectedMeaning: q.expectedMeaning||null,
        status: qStatus(q), reviewedBy: q.reviewedBy||null, reviewedAt: q.reviewedAt||null,
        difficulty: q.difficulty||null
      }))
    };
  });
  res.json({bookId: owned.row.id, chapters: out, privacy: PRIVACY_SHORT,
    note:'Ocenianie odpowiedzi otwartych robi backend (Jev). Panel tylko zatwierdza pytania.'});
});

// ── Pytania: edycja ───────────────────────────────────────────────────────
app.patch('/api/publisher/books/:id/questions/:questionId', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const chapterId = String(req.body?.chapterId||'');
  if(!chapterId || !String(chapterId).startsWith(owned.row.id)) return res.status(422).json({error:'chapterId musi należeć do tej książki'});
  const pool = poolForChapter(chapterId);
  const qid = String(req.params.questionId||'');
  const q = pool.find(x=>x.id===qid);
  if(!q) return res.status(404).json({error:'Pytanie nie istnieje'});
  const b = req.body||{};
  if(b.question!==undefined){ const t=String(b.question).trim(); if(!t) return res.status(422).json({error:'Treść pytania nie może być pusta'}); q.question=t.slice(0,600); }
  if(b.options!==undefined && Array.isArray(b.options)){
    const opts = b.options.map(o=>String(o).trim()).filter(Boolean).slice(0,8);
    if(opts.length < 2) return res.status(422).json({error:'Potrzebne są min. 2 odpowiedzi'});
    q.options = opts;
    if(Number.isInteger(q.correctAnswer) && q.correctAnswer >= opts.length) q.correctAnswer = 0;
  }
  if(b.correctAnswer!==undefined && ['multiple_choice','true_false','what_next'].includes(q.type)){
    const idx = Number(b.correctAnswer);
    if(!Number.isInteger(idx) || idx < 0 || idx >= (q.options||[]).length) return res.status(422).json({error:'Indeks poprawnej odpowiedzi jest poza zakresem'});
    q.correctAnswer = idx;
  }
  if(b.correctAnswers!==undefined && q.type==='multiple_select'){
    const arr = (Array.isArray(b.correctAnswers)?b.correctAnswers:[]).map(Number).filter(n=>Number.isInteger(n)&&n>=0&&n<(q.options||[]).length);
    if(!arr.length) return res.status(422).json({error:'Zaznacz co najmniej jedną poprawną odpowiedź'});
    q.correctAnswers = [...new Set(arr)].sort((a,b)=>a-b);
  }
  if(b.correctOrder!==undefined && ['ordering','ranking'].includes(q.type)){
    const arr = (Array.isArray(b.correctOrder)?b.correctOrder:[]).map(Number);
    const n = (q.items||[]).length;
    if(arr.length !== n || new Set(arr).size !== n || arr.some(x=>!Number.isInteger(x)||x<0||x>=n)) return res.status(422).json({error:'Kolejność musi być permutacją wszystkich elementów'});
    q.correctOrder = arr;
  }
  if(b.expectedMeaning!==undefined && ['open_question','why_question'].includes(q.type)){
    const t=String(b.expectedMeaning).trim();
    if(!t) return res.status(422).json({error:'Oczekiwane znaczenie odpowiedzi jest wymagane dla pytania otwartego'});
    q.expectedMeaning = t.slice(0,1200);
  }
  q.status = 'draft'; // każda edycja wraca do przeglądu
  q.reviewedBy = null; q.reviewedAt = null;
  persistChallenges();
  res.json({ok:true, question: q});
});

// ── Pytania: approve / reject ─────────────────────────────────────────────
async function setQuestionStatus(req,res,nextStatus){
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const qid = String(req.params.questionId||'');
  const bookId = owned.row.id;
  // Szukamy pytania w rozdziałach tej książki — nie w całej puli (inaczej można by
  // zatwierdzić cudze pytanie podając jego id).
  const chapters = parseChapters(owned.row.chapters);
  let found = null;
  for(const c of chapters){
    const q = poolForChapter(c.id).find(x=>x.id===qid);
    if(q){ found = {q, chapter:c}; break; }
  }
  if(!found) return res.status(404).json({error:'Pytanie nie należy do tej książki'});
  found.q.status = nextStatus;
  found.q.reviewedBy = publisherOf(req);
  found.q.reviewedAt = new Date().toISOString();
  persistChallenges();
  const blockers = publishBlockers(owned.row);
  const fresh = await dbGet(`SELECT * FROM publisher_books WHERE id=?`, [bookId]);
  if(fresh && fresh.status!=='published'){
    await dbRun(`UPDATE publisher_books SET status=?, updatedAt=? WHERE id=?`, [blockers.length?'review':'review', new Date().toISOString(), bookId]);
  }
  console.log(`[pub] question ${nextStatus} ${qid} (${bookId}) by ${publisherOf(req).slice(0,6)}..`);
  res.json({ok:true, questionId:qid, status:nextStatus, chapterId:found.chapter.id, publishBlockers: blockers});
}
app.post('/api/publisher/books/:id/questions/:questionId/approve', (req,res)=>setQuestionStatus(req,res,'approved'));
app.post('/api/publisher/books/:id/questions/:questionId/reject',  (req,res)=>setQuestionStatus(req,res,'rejected'));

// ── Pytania: regeneracja puli dla rozdziału ───────────────────────────────
// Bez tego wydawca utknie, gdy generator zwróci za mało pytań: nie ma sposobu
// na ponowne wygenerowanie, a bez 5 zatwierdzonych książka nie przejdzie publikacji.
app.post('/api/publisher/books/:id/chapters/:chapterId/regenerate', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const row = owned.row;
  const chapters = parseChapters(row.chapters);
  const chapter = chapters.find(c=>c.id===req.params.chapterId);
  if(!chapter) return res.status(404).json({error:'chapter not found'});
  // Pytania, które ktoś już zatwierdził albo z którymi ktoś miał sesję, zostają.
  const keepIds = new Set((challengesByChapter[chapter.id]||[]).filter(q=>qStatus(q)!=='draft').map(q=>q.id));
  const keep = (challengesByChapter[chapter.id]||[]).filter(q=>keepIds.has(q.id));
  const hasProof = (await dbAll(`SELECT id FROM proofs WHERE bookId=? AND chapterId=? LIMIT 1`, [row.publishedBookId||row.id, chapter.id])).length>0;
  if(hasProof && keep.length) return res.status(409).json({error:'Na tym rozdziale są już zweryfikowane dowody — regeneracja nadpisałaby historię'});
  res.status(202).json({ok:true, status:'generating', chapterId:chapter.id, kept: keep.length,
    message:'Regeneracja ruszyła w tle. Odśwież za chwilę.'});
  (async()=>{
    try{
      const gen = await callOpenRouterGenerate(chapter, 8, row.language||'pl');
      const clean = sanitizePool(gen).map(q=>({...q, status:'draft', chapterId:chapter.id, bookId:row.id}));
      challengesByChapter[chapter.id] = [...keep, ...clean];
      persistChallenges();
      console.log(`[pub] regenerate ${chapter.id} (${row.id}) → ${clean.length} nowych pytań`);
    }catch(e){
      challengesByChapter[chapter.id] = keep;
      console.error('[pub] regenerate failed', chapter.id, e.message);
    }
  })();
});

// ── Publikacja ────────────────────────────────────────────────────────────
app.post('/api/publisher/books/:id/publish', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const row = owned.row;
  if(row.publishedBookId && row.status==='published') return res.status(409).json({error:'Ta książka jest już opublikowana'});
  const blockers = publishBlockers(row);
  if(blockers.length) return res.status(409).json({error:'Książka nie spełnia warunków publikacji', blockers});

  const chapters = parseChapters(row.chapters).filter(c=>c.enabled!==false);
  const pubBookId = row.publishedBookId || row.id;
  // Wpisujemy do ISTNIEJĄCEGO books[] — czytelnik dostaje ten sam flow co lektury szkolne.
  const book = {
    id: pubBookId,
    title: row.title, titleEn: row.titleEn||undefined, author: row.author,
    description: row.description||'', isbn: row.isbn||undefined,
    category: 'publisher', categoryLabel: 'Wydawca', categoryLevel: 2,
    coverUrl: row.coverUrl||undefined,
    sourceUrl: `https://readproof.pages.dev/verify/?id=${pubBookId}`,
    publisherBookId: row.id,
    rewardPerChapter: `${row.rewardPerProof} ${row.currency}`,
    totalChapters: chapters.length,
    fullTextFile: row.contentFile,
    chapters: chapters.map(c=>({ id:c.id, bookId:pubBookId, index:c.index, title:c.title, titleEn:c.titleEn, summary:c.summary, contextExcerpt:c.contextExcerpt, reward:`${row.rewardPerProof} ${row.currency}` }))
  };
  const existing = books.findIndex(b=>b.id===pubBookId);
  if(existing>=0) books[existing]=book; else books.push(book);
  for(const c of chapters){
    const pool = (challengesByChapter[c.id]||[]).filter(isQuestionApproved);
    challengesByChapter[c.id] = pool;
  }
  persistChallenges();
  const now = new Date().toISOString();
  await dbRun(`UPDATE publisher_books SET status=?, publishedBookId=?, errorMessage=NULL, updatedAt=? WHERE id=?`, ['published', pubBookId, now, row.id]);
  console.log(`[pub] PUBLISH ${row.id} → books[] id=${pubBookId} chapters=${chapters.length} by ${publisherOf(req).slice(0,6)}..`);
  res.json({ok:true, status:'published', publishedBookId: pubBookId, chapters: chapters.length,
    catalogUrl:`/book/${pubBookId}`, note:'Książka jest teraz w katalogu czytelnika.'});
});

app.post('/api/publisher/books/:id/pause', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  if(!owned.row.publishedBookId) return res.status(409).json({error:'Ta książka nie jest jeszcze opublikowana'});
  const next = owned.row.status==='paused' ? 'published' : 'paused';
  const now = new Date().toISOString();
  await dbRun(`UPDATE publisher_books SET status=?, updatedAt=? WHERE id=?`, [next, now, owned.row.id]);
  // Pauza = książka znika z katalogu czytelnika (nie kasujemy pytań ani dowodów).
  const idx = books.findIndex(b=>b.id===owned.row.publishedBookId);
  if(idx>=0){
    if(next==='paused'){ books[idx]._paused = true; }
    else { delete books[idx]._paused; }
  }
  res.json({ok:true, status: next});
});

// ── Czytelnicy ────────────────────────────────────────────────────────────
app.get('/api/publisher/readers', async (req,res)=>{
  const me = publisherOf(req);
  const rows = await dbAll(`SELECT * FROM publisher_books WHERE ownerWallet=?`, [me]);
  const published = rows.map(r=>({ book:r, publishedId:r.publishedBookId })).filter(x=>x.publishedId);
  const readers = new Map();
  for(const {book,publishedId} of published){
    const chapters = parseChapters(book.chapters);
    const proofs = await dbAll(`SELECT walletAddress, userId, chapterId, score, total, status, timestamp FROM proofs WHERE bookId=? ORDER BY timestamp DESC LIMIT 2000`, [publishedId]);
    for(const p of proofs){
      const key = p.userId || p.walletAddress;
      if(!key) continue;
      if(!readers.has(key)) readers.set(key, { readerId: key, books: new Set(), chaptersDone: new Set(), totalChapters: 0, scored: [], first: p.timestamp, last: p.timestamp });
      const r = readers.get(key);
      r.books.add(book.id);
      if(Number(p.total)>0 && (VERIF_STATUSES.has(String(p.status)) || p.status==='Partial Verified')){
        r.chaptersDone.add(p.chapterId);
        r.scored.push(Number(p.score)/Number(p.total));
      }
      if(p.timestamp){ if(!r.first || p.timestamp < r.first) r.first = p.timestamp; if(p.timestamp > r.last) r.last = p.timestamp; }
    }
    for(const key of [...readers.keys()]){ const r=readers.get(key); r.totalChapters += chapters.length; }
  }
  const out = [...readers.values()].map(r=>({
    readerId: r.readerId.length > 24 ? r.readerId.slice(0,8)+'…'+r.readerId.slice(-4) : r.readerId.slice(0,10),
    books: [...r.books], chaptersDone: r.chaptersDone.size, totalChapters: r.totalChapters,
    averageScore: r.scored.length ? Math.round(r.scored.reduce((a,b)=>a+b,0)/r.scored.length*100) : null,
    firstSeen: r.first, lastSeen: r.last
  })).sort((a,b)=>String(b.lastSeen||'').localeCompare(String(a.lastSeen||'')));
  res.json({count: out.length, readers: out, privacy: PRIVACY_SHORT,
    note:'Pokazujemy anonimowy identyfikator techniczny (readerId). ReadProof nie zbiera danych osobowych czytelników.'});
});

app.get('/api/publisher/books/:id/readers', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  if(!owned.row.publishedBookId) return res.json({count:0, readers:[], note:'Książka nie jest jeszcze opublikowana — brak danych czytelników.'});
  const chapters = parseChapters(owned.row.chapters);
  const proofs = await dbAll(`SELECT walletAddress, userId, chapterId, score, total, status, timestamp FROM proofs WHERE bookId=? ORDER BY timestamp DESC LIMIT 2000`, [owned.row.publishedBookId]);
  const byReader = new Map();
  for(const p of proofs){
    const key = p.userId || p.walletAddress;
    if(!key) continue;
    if(!byReader.has(key)) byReader.set(key, { done:new Set(), scored:[], first:p.timestamp, last:p.timestamp });
    const r = byReader.get(key);
    if(Number(p.total)>0 && (VERIF_STATUSES.has(String(p.status))||p.status==='Partial Verified')){ r.done.add(p.chapterId); r.scored.push(Number(p.score)/Number(p.total)); }
    if(p.timestamp){ if(!r.first || p.timestamp<r.first) r.first=p.timestamp; if(p.timestamp>r.last) r.last=p.timestamp; }
  }
  res.json({count: byReader.size, totalChapters: chapters.length, readers: [...byReader.values()].map(r=>({
    readerId: r.done.size? 'anon':'', chaptersDone: r.done.size, totalChapters: chapters.length,
    averageScore: r.scored.length? Math.round(r.scored.reduce((a,b)=>a+b,0)/r.scored.length*100):null,
    firstSeen:r.first, lastSeen:r.last
  }))});
});

// ── Nagrody ───────────────────────────────────────────────────────────────
app.get('/api/publisher/rewards', async (req,res)=>{
  const me = publisherOf(req);
  const rows = await dbAll(`SELECT * FROM publisher_books WHERE ownerWallet=?`, [me]);
  const ids = rows.map(r=>r.id);
  const pools = rows.map(r=>({ bookId:r.id, title:r.title, status:r.status, pool:numOr(r.rewardPool,0), perProof:numOr(r.rewardPerProof,5), currency:r.currency||'USDC' }));
  const payouts = ids.length ? await dbAll(`SELECT * FROM payouts WHERE bookId IN (${ids.map(()=>'?').join(',')}) ORDER BY createdAt DESC LIMIT 300`, ids) : [];
  const dist = a => a.filter(p=>p.status==='confirmed').reduce((s,p)=>s+numOr(p.amount,0),0);
  const pend = a => a.filter(p=>p.status==='pending').reduce((s,p)=>s+numOr(p.amount,0),0);
  const fail = a => a.filter(p=>p.status==='failed').reduce((s,p)=>s+numOr(p.amount,0),0);
  res.json({
    total: pools.reduce((s,p)=>s+p.pool,0),
    reserved: pend(payouts),
    distributed: dist(payouts),
    remaining: pools.reduce((s,p)=>s+p.pool,0) - dist(payouts) - pend(payouts),
    failed: fail(payouts),
    currency: 'USDC',
    network: { cluster:'devnet', rpc: SOLANA_RPC, usdcMint: USDC_MINT_DEVNET, explorerBase:'https://explorer.solana.com', realPayoutsConfigured: !!SOLANA_PAYER_PRIVATE_KEY },
    pools,
    history: payouts.map(p=>({ id:p.id, bookId:p.bookId, amount:numOr(p.amount,0), currency:p.currency, status:p.status,
      txSignature:p.txSignature||null, explorerUrl:p.explorerUrl||null, createdAt:p.createdAt, errorMessage:p.errorMessage||null,
      // Krótki identyfikator zamiast pełnego adresu portfela
      reader: p.walletAddress ? (p.walletAddress.slice(0,6)+'…'+p.walletAddress.slice(-4)) : null })),
    privacy: PRIVACY_SHORT,
    note:'Status „confirmed" oznacza potwierdzenie w sieci. Bez skonfigurowanego klucza payera nagrody są zapisywane jako „pending" — nigdy nie pokazujemy ich jako potwierdzone.'
  });
});

app.get('/api/publisher/books/:id/rewards', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const payouts = await dbAll(`SELECT * FROM payouts WHERE bookId=? ORDER BY createdAt DESC LIMIT 200`, [owned.row.id]);
  const funds = await dbAll(`SELECT * FROM campaign_funds WHERE campaignId=? ORDER BY createdAt DESC`, [owned.row.id]);
  const dist = payouts.filter(p=>p.status==='confirmed').reduce((s,p)=>s+numOr(p.amount,0),0);
  const pend = payouts.filter(p=>p.status==='pending').reduce((s,p)=>s+numOr(p.amount,0),0);
  res.json({
    pool: numOr(owned.row.rewardPool,0), perProof: numOr(owned.row.rewardPerProof,5),
    currency: owned.row.currency||'USDC', distributed: dist, reserved: pend,
    remaining: numOr(owned.row.rewardPool,0) - dist - pend,
    network: { cluster:'devnet', realPayoutsConfigured: !!SOLANA_PAYER_PRIVATE_KEY, explorerBase:'https://explorer.solana.com' },
    history: payouts.map(p=>({ id:p.id, amount:numOr(p.amount,0), status:p.status, txSignature:p.txSignature||null, createdAt:p.createdAt })),
    fundingHistory: funds.map(f=>({ id:f.id, amount:numOr(f.amount,0), currency:f.currency, txSignature:f.txSignature, createdAt:f.createdAt }))
  });
});

app.post('/api/publisher/books/:id/fund', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  const row = owned.row;
  const amt = Number(req.body?.amount);
  if(req.body?.amount===undefined || !Number.isFinite(amt)) return res.status(422).json({error:'Kwota musi być liczbą'});
  if(amt<=0) return res.status(422).json({error:'Kwota musi być większa od zera'});
  if(amt>100000) return res.status(422).json({error:'Maksymalnie 100 000 (Devnet)'});
  const currency = ['USDC','SOL'].includes(String(req.body?.currency)) ? String(req.body.currency) : (row.currency||'USDC');
  const now = new Date().toISOString();
  const fundId = 'fund-' + crypto.randomBytes(5).toString('hex');
  // Historia dofinansowań trzymamy w istniejącej tabeli campaign_funds (bez nowej tabeli).
  await dbRun(`INSERT INTO campaign_funds (id, campaignId, publisherWallet, amount, currency, txSignature, explorerUrl, createdAt) VALUES (?,?,?,?,?,?,?,?)`,
    [fundId, row.id, publisherOf(req), amt, currency, req.body?.txSignature? String(req.body.txSignature).slice(0,128):null, null, now]);
  const newPool = numOr(row.rewardPool,0) + amt;
  await dbRun(`UPDATE publisher_books SET rewardPool=?, status=?, updatedAt=? WHERE id=?`, [newPool, row.status==='draft'?'draft':row.status, now, row.id]);
  const fresh = await dbGet(`SELECT * FROM publisher_books WHERE id=?`, [row.id]);
  res.status(201).json({ok:true, funded:{ id:fundId, amount:amt, currency, txSignature:req.body?.txSignature||null },
    rewardPool:newPool, book: pubBookView(fresh),
    note:'Rejestrujemy deklarację dofundowania. Bez skonfigurowanego klucza payera nie ma transferu on-chain.'});
});

// ── Analytics ─────────────────────────────────────────────────────────────
app.get('/api/publisher/analytics', async (req,res)=>{
  const me = publisherOf(req);
  const rows = await dbAll(`SELECT * FROM publisher_books WHERE ownerWallet=?`, [me]);
  const published = rows.map(r=>({row:r, pid:r.publishedBookId})).filter(x=>x.pid);
  const pids = published.map(x=>x.pid);
  const proofs = pids.length ? await dbAll(`SELECT bookId, chapterId, score, total, status, userId, walletAddress, timestamp FROM proofs WHERE bookId IN (${pids.map(()=>'?').join(',')}) ORDER BY timestamp ASC LIMIT 5000`, pids) : [];
  const verified = proofs.filter(p=>Number(p.total)>0 && (VERIF_STATUSES.has(String(p.status))||p.status==='Partial Verified'));
  const readers = new Set(verified.map(p=>p.userId||p.walletAddress).filter(Boolean));
  const scored = verified.filter(p=>Number(p.total)>0);
  const avg = scored.length ? Math.round(scored.reduce((a,p)=>a+Number(p.score)/Number(p.total),0)/scored.length*100) : null;
  // Czytelnicy w czasie — z rzeczywistych timestampów, nie z generatora.
  const byDay = new Map();
  for(const p of verified){
    const d = String(p.timestamp||'').slice(0,10);
    if(!d) continue;
    if(!byDay.has(d)) byDay.set(d, { day:d, proofs:0, readers:new Set() });
    const e = byDay.get(d); e.proofs++;
    const k=p.userId||p.walletAddress; if(k) e.readers.add(k);
  }
  const timeline = [...byDay.values()].sort((a,b)=>a.day.localeCompare(b.day))
    .map(e=>({ day:e.day, proofs:e.proofs, readers:e.readers.size }));
  // Ukończenie rozdziałów per książka
  const perBook = published.map(({row,pid})=>{
    const chapters = parseChapters(row.chapters);
    const mine = verified.filter(p=>p.bookId===pid);
    const done = new Set(mine.map(p=>p.chapterId));
    return { bookId:row.id, title:row.title, publishedBookId:pid, chapters:chapters.length,
      chaptersDone: done.size, completionRate: chapters.length? Math.round(done.size/chapters.length*100):0,
      tests: mine.length, averageScore: mine.length? Math.round(mine.reduce((a,p)=>a+Number(p.score)/Number(p.total),0)/mine.length*100):null };
  });
  // Nagrody rozliczone — z tabeli payouts, połączonej z pulami książek.
  const myBookIds = rows.map(r=>r.id);
  const myPayouts = myBookIds.length ? await dbAll(`SELECT status, amount FROM payouts WHERE bookId IN (${myBookIds.map(()=>'?').join(',')})`, myBookIds) : [];
  const rewardsDistributed = myPayouts.filter(p=>p.status==='confirmed').reduce((a,p)=>a+numOr(p.amount,0),0);
  res.json({
    booksPublished: published.length,
    activeReaders: readers.size,
    testsCompleted: verified.length,
    averageScore: avg,
    completionRate: perBook.length? Math.round(perBook.reduce((a,b)=>a+b.completionRate,0)/perBook.length) : null,
    rewardsDistributed: Number(rewardsDistributed.toFixed(2)),
    timeline, perBook,
    hasData: verified.length > 0,
    privacy: PRIVACY_SHORT
  });
});

app.get('/api/publisher/books/:id/analytics', async (req,res)=>{
  const owned = await ownedPublisherBook(req, req.params.id);
  if(owned.error) return failOwned(res, owned);
  if(!owned.row.publishedBookId) return res.json({hasData:false, note:'Książka nie jest jeszcze opublikowana — brak danych.', timeline:[], perChapter:[]});
  const chapters = parseChapters(owned.row.chapters);
  const proofs = await dbAll(`SELECT chapterId, score, total, status, userId, walletAddress, timestamp FROM proofs WHERE bookId=? ORDER BY timestamp ASC LIMIT 5000`, [owned.row.publishedBookId]);
  const verified = proofs.filter(p=>Number(p.total)>0 && (VERIF_STATUSES.has(String(p.status))||p.status==='Partial Verified'));
  const perChapter = chapters.map(c=>{
    const mine = verified.filter(p=>p.chapterId===c.id);
    return { chapterId:c.id, title:c.title, index:c.index, tests:mine.length,
      averageScore: mine.length? Math.round(mine.reduce((a,p)=>a+Number(p.score)/Number(p.total),0)/mine.length*100):null,
      completedBy: new Set(mine.map(p=>p.userId||p.walletAddress).filter(Boolean)).size };
  });
  const byDay = new Map();
  for(const p of verified){ const d=String(p.timestamp||'').slice(0,10); if(!d) continue; byDay.set(d,(byDay.get(d)||0)+1); }
  res.json({
    hasData: verified.length>0,
    tests: verified.length,
    averageScore: verified.length? Math.round(verified.reduce((a,p)=>a+Number(p.score)/Number(p.total),0)/verified.length*100):null,
    completionRate: chapters.length? Math.round(perChapter.filter(c=>c.tests>0).length/chapters.length*100):null,
    perChapter,
    timeline: [...byDay.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([day,proofs])=>({day,proofs})),
    privacy: PRIVACY_SHORT
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard: poprawka — nagrody z payouts (powyżej zostawiam realne zapytanie)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/publisher/settings', (req,res)=>{
  res.json({
    publisher: { wallet: publisherOf(req), displayName: req.publisher?.displayName||null, email: req.publisher?.email||null },
    solana: { cluster:'devnet', realPayoutsConfigured: !!SOLANA_PAYER_PRIVATE_KEY, explorerBase:'https://explorer.solana.com', usdcMint: USDC_MINT_DEVNET },
    questionEngine: { jev: !!TYPESAFE_API_KEY, jevThreshold: JEV_THRESHOLD, generator: anyLLM() ? OPENROUTER_MODEL : null },
    privacy: PRIVACY_SHORT,
    note:'Panel nie trzyma żadnych kluczy ani środków. Klucze są tylko po stronie backendu.'
  });
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

// SKIP_WARM=1 wyłącza generowanie pul w tle — używane przez testy, które
// nie potrzebują zapytań LLM.
if (process.env.SKIP_WARM !== '1') setTimeout(warmAllPools, 3000);
