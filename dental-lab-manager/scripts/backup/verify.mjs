#!/usr/bin/env node
/**
 * Verifies an encrypted backup WITHOUT writing plaintext to disk: the
 * decrypted JSON is read from stdin (piped from `age -d`) and checked against
 * the manifest written by export.mjs. Prints only table names and counts.
 *
 *   age -d -i ~/dlm-backup-key.txt <file>.json.age | node scripts/backup/verify.mjs <file>.manifest.json
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const manifestFile = process.argv[2];
if (!manifestFile) {
  console.error('usage: age -d -i KEY FILE.json.age | node verify.mjs FILE.manifest.json');
  process.exit(2);
}
const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const buf = Buffer.concat(chunks);
let b;
try {
  b = JSON.parse(buf.toString('utf8'));
} catch {
  console.error('FAILED: input is not a decrypted dlm backup (wrong key or wrong file?)');
  process.exit(1);
} finally {
  buf.fill(0);
}
if (b.format !== 'dlm-backup-v1') {
  console.error('FAILED: not a dlm-backup-v1 file');
  process.exit(1);
}
let bad = 0;
for (const [t, want] of Object.entries(m.tables)) {
  const rows = b.data[t];
  const sha = rows ? crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex') : null;
  if (!rows || rows.length !== want.rows || sha !== want.sha256) {
    bad++;
    console.error(`  mismatch: ${t}`);
  }
}
if (JSON.stringify(b.migrations) !== JSON.stringify(m.migrations)) { bad++; console.error('  mismatch: migrations'); }
const total = Object.values(m.tables).reduce((s, t) => s + t.rows, 0);
if (bad) {
  console.error(`FAILED: ${bad} mismatch(es)`);
  process.exit(1);
}
console.log(`OK: ${Object.keys(m.tables).length} tables, ${total} rows, ${m.migrations.length} migrations, exported ${m.exported_at}`);
