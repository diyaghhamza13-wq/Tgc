#!/usr/bin/env node
/**
 * Generates a Backup Runner token on THIS computer (alternative to the offline page).
 *   node scripts/backup/runner-token.mjs <output-file> [label]
 * Writes the TOKEN to <output-file> (mode 600) — it goes into the runner project's
 * function secret DLM_PROD_BACKUP_TOKEN, then delete the file. Prints only the
 * SHA-256 HASH and the SQL line for production: production never sees the token.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const [out, label = `runner ${new Date().toISOString().slice(0, 10)}`] = process.argv.slice(2);
if (!out) { console.error('usage: runner-token.mjs <output-file> [label]'); process.exit(2); }
if (!/^[A-Za-z0-9 _.:-]{1,60}$/.test(label)) { console.error('label: 1-60 of A-Z a-z 0-9 space _ . : -'); process.exit(2); }
if (fs.existsSync(out)) { console.error('output file exists; refusing to overwrite'); process.exit(2); }
const token = `dlmbk1_${crypto.randomBytes(32).toString('hex')}`;
const hash = crypto.createHash('sha256').update(token).digest('hex');
fs.writeFileSync(out, token + '\n', { mode: 0o600, flag: 'wx' });
console.log(`token written to ${out} (mode 600)`);
console.log(`hash: ${hash}`);
console.log(`SQL (production, SQL editor): select dlm_backup.register_token('${hash}', '${label}');`);
