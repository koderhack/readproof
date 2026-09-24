#!/usr/bin/env node
// Generuje backend/mysql-import.sql z backend/readproof.db (sqlite) do importu
// w phpMyAdmin na https://frog02.mikr.us/pma/ (baza db_f22287, tabele readproof_*).
// Uruchom: node generate-sql-dump.js

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import sqlite3 from 'sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, 'readproof.db');
const OUT_FILE = path.join(__dirname, 'mysql-import.sql');

const sqlEscape = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
};

const toMySQLDate = (v) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)
    ? v.replace('T', ' ').replace(/\.\d+Z?$/, '')
    : v;

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

const TABLES = {
  publisher_campaigns: 'readproof_campaigns',
  users: 'readproof_users',
  proofs: 'readproof_proofs',
  reading_sessions: 'readproof_sessions',
  campaign_funds: 'readproof_funds',
  waitlist: 'readproof_waitlist',
};
const SKIP_COLS = { reading_sessions: ['totalPausedSec', 'pausedAt'] };

const lines = [
  '-- ReadProof: import danych z backend/readproof.db (sqlite) do db_f22287 (Mikrus)',
  '-- Wygenerowano: ' + new Date().toISOString(),
  'SET NAMES utf8mb4;',
  '',
];
for (const ddl of DDL) {
  lines.push(ddl + ';');
}
lines.push('');

const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.all("SELECT name FROM sqlite_master WHERE type='table'", (e, tables) => {
    if (e) { console.error(e.message); process.exit(1); }
    const names = new Set((tables || []).map((t) => t.name));
    let todo = Object.keys(TABLES).filter((t) => names.has(t));
    let remaining = todo.length;
    for (const src of todo) {
      db.all(`SELECT * FROM ${src}`, (err, rows) => {
        if (err) { console.error('Błąd odczytu', src, err.message); }
        else {
          const dest = TABLES[src];
          const real = (rows || []).filter((r) => r);
          if (!real.length) {
            lines.push(`-- ${src}: brak wierszy, pomijam`);
          } else {
            lines.push(`-- ${src} (${real.length})`);
            for (const row of real) {
              const cols = Object.keys(row).filter((c) => !(SKIP_COLS[src] || []).includes(c));
              const vals = cols.map((c) => sqlEscape(toMySQLDate(row[c])));
              lines.push(`INSERT IGNORE INTO \`${dest}\` (\`${cols.join('`,`')}\`) VALUES (${vals.join(',')});`);
            }
          }
        }
        remaining -= 1;
        if (remaining === 0) {
          lines.push('');
          fs.writeFileSync(OUT_FILE, lines.join('\n'));
          console.log(`Zapisano: ${OUT_FILE} (${fs.statSync(OUT_FILE).size} B)`);
          console.log('Zaimportuj ten plik w https://frog02.mikr.us/pma/  → db_f22287 → Import.');
          process.exit(0);
        }
      });
    }
  });
});