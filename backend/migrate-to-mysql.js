#!/usr/bin/env node
// Migracja danych z lokalnego SQLite (readproof.db) do MySQL Mikrus (db_f22287).
//
// SKĄD: backend/readproof.db  (kampanie dodane lokalnie przez panel wydawcy)
// DO:   MySQL 192.168.1.1 / db_f22287  → tabele readproof_*
//
// DLA KOGO: ma być uruchamiany NA MICROUSĘ (node migrate-to-mysql.js), gdzie
// MySQL (192.168.1.1) jest osiągalny. Na tym Macu 192.168.1.1 jest poza siecią
// — spróbuje, ale wypisze błąd połączenia (bez konsekwencji).
//
// Uruchomienie na Mikrusie:
//   MYSQL_HOST=192.168.1.1 MYSQL_USER=f22287 MYSQL_PASSWORD=iphHexGgV5 MYSQL_DATABASE=db_f22287 node migrate-to-mysql.js
//   (albo z .env — odkomentuj tam blok MySQL i po prostu: node migrate-to-mysql.js)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import sqlite3 from 'sqlite3';
import mysql from 'mysql2/promise';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'readproof.db');

if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_PASSWORD || !process.env.MYSQL_DATABASE) {
  console.error('Brak zmiennych MYSQL_HOST/USER/PASSWORD/DATABASE — ustaw je (patrz backend/.env) i spróbuj ponownie.');
  process.exit(1);
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  timezone: 'Z',
  dateStrings: true,
  connectionLimit: 3,
});

const toMySQLDate = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)
    ? v.replace('T', ' ').replace(/\.\d+Z?$/, '')
    : v;

const toMySQL = (row) => {
  const o = {};
  for (const [k, v] of Object.entries(row)) o[k] = toMySQLDate(v);
  return o;
};

const SCHEMAS = {
  publisher_campaigns: 'readproof_campaigns',
  users: 'readproof_users',
  proofs: 'readproof_proofs',
  reading_sessions: 'readproof_sessions',
  campaign_funds: 'readproof_funds',
  waitlist: 'readproof_waitlist',
};

// Kolumny z SQLite, których NIE ma w schematach MySQL (pomijamy przy INSERT)
const SKIP_COLS = {
  reading_sessions: ['totalPausedSec', 'pausedAt'],
};

function dump(db) {
  return new Promise((resolve, reject) => {
    db.all("SELECT name FROM sqlite_master WHERE type='table'", async (e, tables) => {
      if (e) return reject(e);
      const names = new Set((tables || []).map((t) => t.name));
      const out = {};
      for (const [src, dest] of Object.entries(SCHEMAS)) {
        if (!names.has(src)) { out[src] = []; continue; }
        const rows = await new Promise((res, rej) =>
          db.all(`SELECT * FROM ${src}`, (err, r) => (err ? rej(err) : res(r || [])))
        );
        out[src] = rows.map(toMySQL);
      }
      resolve(out);
    });
  });
}

async function main() {
  const sdb = new sqlite3.Database(DB_FILE);
  const data = await dump(sdb);
  sdb.close();

  // upewnij się, że tabele readproof_* istnieją z pełnym schematem (identycznie jak w server.js)
  const DDL = [
    `CREATE TABLE IF NOT EXISTS readproof_proofs (id VARCHAR(64) PRIMARY KEY, bookId VARCHAR(64), chapterId VARCHAR(64), score INT, total INT, status VARCHAR(32), walletAddress VARCHAR(64), timestamp DATETIME, proofHash VARCHAR(32), txSignature VARCHAR(128), explorerUrl VARCHAR(256), reward VARCHAR(32), detail JSON, verificationVersion VARCHAR(32), durationSec INT, userId VARCHAR(64))`,
    `CREATE TABLE IF NOT EXISTS readproof_sessions (id VARCHAR(64) PRIMARY KEY, walletAddress VARCHAR(64), bookId VARCHAR(64), chapterId VARCHAR(64), startAt DATETIME, endAt DATETIME, status VARCHAR(32), challengeIds JSON, answers JSON, readingDurationSec INT, lang VARCHAR(8), expectedReadingMin INT, suspicious TINYINT DEFAULT 0, suspiciousReason VARCHAR(256), createdAt DATETIME, userId VARCHAR(64))`,
    `CREATE TABLE IF NOT EXISTS readproof_books (id VARCHAR(64) PRIMARY KEY, data JSON)`,
    `CREATE TABLE IF NOT EXISTS readproof_challenges (chapterId VARCHAR(64) PRIMARY KEY, data JSON)`,
    `CREATE TABLE IF NOT EXISTS readproof_users (walletAddress VARCHAR(64) PRIMARY KEY, displayName VARCHAR(128), email VARCHAR(128), role VARCHAR(32) DEFAULT 'reader', createdAt DATETIME, lastLoginAt DATETIME, appleUserId VARCHAR(64), sessionToken VARCHAR(128), provider VARCHAR(16), nickname VARCHAR(128))`,
    `CREATE TABLE IF NOT EXISTS readproof_campaigns (id VARCHAR(64) PRIMARY KEY, publisherWallet VARCHAR(64), title VARCHAR(256), author VARCHAR(256), isbn VARCHAR(32), description TEXT, rewardPool DOUBLE DEFAULT 0, rewardPerProof DOUBLE DEFAULT 5, currency VARCHAR(16) DEFAULT 'USDC', status VARCHAR(32) DEFAULT 'draft', bookContentHash VARCHAR(64), contentLength INT DEFAULT 0, coverUrl VARCHAR(512), createdAt DATETIME, updatedAt DATETIME)`,
    `CREATE TABLE IF NOT EXISTS readproof_funds (id VARCHAR(64) PRIMARY KEY, campaignId VARCHAR(64), publisherWallet VARCHAR(64), amount DOUBLE, currency VARCHAR(16), txSignature VARCHAR(128), explorerUrl VARCHAR(256), createdAt DATETIME)`,
    `CREATE TABLE IF NOT EXISTS readproof_waitlist (id VARCHAR(64) PRIMARY KEY, email VARCHAR(256), role VARCHAR(32), name VARCHAR(128), createdAt DATETIME)`,
  ];
  for (const ddl of DDL) await pool.query(ddl);

  let totalImported = 0;
  for (const [src, dest] of Object.entries(SCHEMAS)) {
    const rows = data[src];
    if (!rows.length) { console.log(`• ${src} → \`${dest}\` — 0 wierszy (puste)`); continue; }
    const cols = Object.keys(rows[0]).filter((c) => !(SKIP_COLS[src] || []).includes(c));
    if (!cols.length) continue;
    const colList = cols.map((c) => `\`${c}\``).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    let imported = 0, skipped = 0;
    for (const row of rows) {
      try {
        await pool.query(
          `INSERT IGNORE INTO \`${dest}\` (${colList}) VALUES (${placeholders})`,
          cols.map((c) => row[c] ?? null)
        );
        imported++;
      } catch (err) {
        console.error(`  ⚠ ${src}:${row.id || row.walletAddress || '?'}: ${err.message}`);
        skipped++;
      }
    }
    totalImported += imported;
    console.log(`• ${src} → \`${dest}\` — zaimportowano ${imported}, pominięto ${skipped}`);
  }

  const [[{ c: wc }], [{ c: cc }], [{ c: uc }]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS c FROM readproof_waitlist`),
    pool.query(`SELECT COUNT(*) AS c FROM readproof_campaigns`),
    pool.query(`SELECT COUNT(*) AS c FROM readproof_users`),
  ]);
  console.log(`\nStan w bazie ${process.env.MYSQL_DATABASE}:`);
  console.log(`  waitlist: ${wc}, kampanie: ${cc}, użytkownicy: ${uc}`);
  console.log('Gotowe — sprawdź w https://frog02.mikr.us/pma/ (db_f22287).');
  await pool.end();
}

main().catch((err) => {
  console.error('Migracja nieudana:', err.code || err.message);
  if (String(err.message || '').includes('ECONNREFUSED') || String(err.code || '').startsWith('ER_ACCESS')) {
    console.error('→ MySQL 192.168.1.1 jest nieosiągalny z tego komputera. Uruchom ten skrypt NA serwerze Mikrus (ssh).');
  }
  process.exit(1);
});