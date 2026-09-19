import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';

dotenv.config();
const PORT = Number(process.env.PORT) || 32288;
const JEV_THRESHOLD = Number(process.env.JEV_THRESHOLD) || 0.80;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.2-3b-instruct:free';
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

// --- SQLite for proofs ---
const db = new sqlite3.Database('./readproof.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS proofs (
    id TEXT PRIMARY KEY,
    bookId TEXT, chapterId TEXT, score INTEGER, total INTEGER, status TEXT,
    walletAddress TEXT, timestamp TEXT, proofHash TEXT, txSignature TEXT, explorerUrl TEXT, reward TEXT,
    detail TEXT
  )`);
});

function proofHash(bookId, chapterId, wallet, ts, score) {
  const input = `${bookId}|${chapterId}|${wallet}|${new Date(ts).getTime()}|${score}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0,16);
}
function mockSignature(hash) {
  const chars='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let sig=''; let seed=hash.split('').reduce((a,c)=>a+c.charCodeAt(0),0);
  for(let i=0;i<88;i++){ seed=(seed*1103515245+12345)&0x7fffffff; sig+=chars[seed % chars.length]; }
  return sig;
}

// --- Jev ---
function keywords(text) {
  const stop=new Set(["i","w","z","na","do","że","to","się","jest","by","być","nie","tak","jak","co","dla","ale","oraz","przez","po","o","a","u","za","od","te","ten","ta","the","a","an","is","are","was","be","to","of","in","it","you","and"]);
  return new Set(text.toLowerCase().split(/[^a-z0-9ąćęłńóśźż]+/).filter(w=>w.length>2 && !stop.has(w)));
}
function mockJev(expected, answer) {
  const exp=keywords(expected); const ans=keywords(answer);
  if(!exp.size) return {correct: answer.length>10, confidence:0.55, reason:"Mock: brak słów kluczowych"};
  const inter=[...exp].filter(w=>ans.has(w)).length;
  const recall=inter/exp.size;
  let conf, ok;
  if(recall>=0.5){ conf=Math.min(0.95,0.7+recall*0.3+Math.min(answer.length,100)/400); ok=conf>=JEV_THRESHOLD; }
  else if(recall>=0.3){ conf=0.55+recall*0.3; ok=false; }
  else { conf=0.25+recall; ok=false; }
  return {correct:ok, confidence:conf, reason: ok? `Mock: zgodność recall ${Math.round(recall*100)}%`:`Mock: za mało zgodności recall ${Math.round(recall*100)}% próg ${Math.round(JEV_THRESHOLD*100)}%`};
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
Requirements:
- Use DIVERSE types from: multiple_choice, true_false, multiple_select, open_question, why_question, ordering, who_said, match, what_next, find_error
- At least 1 open_question or why_question with expectedMeaning (in ENGLISH)
- Return ONLY JSON: {"challenges": [ ... ]}
- Each challenge: id, type, question, difficulty, and type-specific fields
- Question language: ENGLISH only`
  : `Wygeneruj ${count} Reading Challenge dla rozdziału książki domeny publicznej.
Książka: ${chapter.bookId}, rozdział ${chapter.index} — ${chapter.title}
Język oryginalnego fragmentu: często ANGIELSKI (Gutenberg). WAŻNE: MUSISZ wygenerować WSZYSTKIE pytania, opcje, expectedMeaning, statements, pary w języku POLSKIM, niezależnie od języka źródła.
Kontekst: ${chapter.contextExcerpt}
Streszczenie: ${chapter.summary}
Wymagania:
- Używaj RÓŻNYCH typów z: multiple_choice, true_false, multiple_select, open_question, why_question, ordering, who_said, match, what_next, find_error
- Co najmniej 1 open_question lub why_question z polem expectedMeaning (po POLSKU)
- Zwróć TYLKO JSON: {"challenges": [ ... ]}
- Każdy challenge: id, type, question, difficulty, oraz pola specyficzne dla typu
- Język pytań: POLSKI (tłumacz sens jeśli excerpt był po angielsku)`;
  const res=await fetch('https://openrouter.ai/api/v1/chat/completions',{
    method:'POST',
    headers:{'Authorization':`Bearer ${OPENROUTER_KEY}`,'Content-Type':'application/json','HTTP-Referer':'https://readproof.app'},
    body: JSON.stringify({model: OPENROUTER_MODEL, messages:[{role:'user',content:prompt}], temperature:0.7, max_tokens:2500})
  });
  if(!res.ok) throw new Error('OpenRouter error '+res.status);
  const j=await res.json();
  const content=j.choices?.[0]?.message?.content;
  if(!content) throw new Error('Brak content od LLM');
  // extract JSON
  const start=content.indexOf('{'); const end=content.lastIndexOf('}');
  const slice=content.slice(start, end+1);
  const parsed=JSON.parse(slice);
  const challenges=parsed.challenges || parsed;
  if(!Array.isArray(challenges)) throw new Error('Niepoprawny JSON challenges');
  return challenges;
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
app.get('/health', (req,res)=>res.json({status:'ok', service:'readproof-backend', port:PORT, books: books.length, chapters: books.reduce((a,b)=>a+b.chapters.length,0), openRouter: !!OPENROUTER_KEY, model: OPENROUTER_MODEL, jevThreshold:JEV_THRESHOLD, lang: langOf(req)}));

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
  if(trimmed.length<3) return res.json({correct:false, confidence:0.15, reason: lang==='en'?'Too short':'Za krótka odpowiedź', source:'mock', lang});
  // Oficjalne Jev API (nie OpenRouter) — LLM NIE jest używany do oceny
  const fromJev=await callJev({question, expectedMeaning, userAnswer:trimmed, context: context||'', lang});
  if(fromJev) return res.json({...fromJev, source:'jev', lang});
  const mock=mockJev(expectedMeaning, trimmed);
  res.json({...mock, source:'mock', lang});
});

app.post('/api/proofs', async (req,res)=>{
  const {bookId, chapterId, answers, walletAddress} = req.body; // answers: {challengeId: answer}
  if(!bookId || !chapterId || !answers) return res.status(400).json({error:'bookId, chapterId, answers required'});
  const wallet = walletAddress || `DemoWallet-${crypto.randomBytes(3).toString('hex')}`;
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
          jev = j || mockJev(ch.expectedMeaning||'', ans);
          if (!jev.source) jev.source = j ? 'jev' : 'mock';
          correct = jev.correct && jev.confidence>=JEV_THRESHOLD;
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
  if(score>=4) status='Reading Verified';
  else if(score===3) status='Try Again';
  const now=new Date().toISOString();
  const hash=proofHash(bookId, chapterId, wallet, now, score);
  let tx=null, explorer=null, reward=null;
  if(score>=4){
    const chapter=books.flatMap(b=>b.chapters).find(c=>c.id===chapterId);
    reward=chapter?.reward || '5 USDC';
    // per Solana docs: real Devnet USDC transfer via ATA if payer key set, else mock (deterministyczny)
    const real = await tryRealSolanaReward(wallet, reward);
    if(real){ tx=real.signature; explorer=real.explorer; }
    else { const sig=mockSignature(hash); tx=sig; explorer=`https://explorer.solana.com/tx/${sig}?cluster=devnet`; }
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
async function tryRealSolanaReward(toAddress, amountUSDC='5'){
  if(!SOLANA_PAYER_PRIVATE_KEY) return null;
  try{
    const {Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction} = await import('@solana/web3.js');
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
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], {commitment:'confirmed'});
    return {signature:sig, explorer:`https://explorer.solana.com/tx/${sig}?cluster=devnet`};
  }catch(e){ console.error('real solana reward failed, fallback mock', e.message); return null; }
}

app.listen(PORT,'0.0.0.0',()=>console.log(`ReadProof backend :${PORT} books=${books.length} openrouter=${!!OPENROUTER_KEY} jevTypesafe=${!!TYPESAFE_API_KEY} jevThresh=${JEV_THRESHOLD}`));
