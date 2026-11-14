#!/usr/bin/env node
/**
 * Tests the database connection for the backup WITHOUT exporting data.
 * Reads only metadata from the ESTABLISHED connection (TLS state, login
 * attributes, privileges in every accessible schema) plus one yes/no answer
 * ("are rows visible"). No row contents. Never prints the connection string.
 *
 *   read -rs PGPASSWORD; export PGPASSWORD
 *   DB_URL='postgresql://dlm_backup_reader@<host>:5432/postgres?sslmode=verify-full&sslrootcert=/path/supabase-ca.crt' \
 *   node scripts/backup/check-connection.mjs
 */
import { evaluateLogin, LOGIN_CHECK_SQL, parseDbUrl, psqlJson, redact } from './lib.mjs';

const { DB_URL } = process.env;
let db;
try { db = parseDbUrl(DB_URL); } catch (e) { console.error(`✗ ${redact(e.message, [DB_URL])}`); process.exit(2); }
if (db.hasPassword) console.error('note: the password is in DB_URL; prefer PGPASSWORD typed with `read -rs`');

let r;
try {
  r = psqlJson(db, LOGIN_CHECK_SQL);
} catch (e) {
  console.error(`✗ could not connect or query: ${redact(e.message, [DB_URL])}`);
  process.exit(1);
}
console.log(`connected as ${r.user}, PostgreSQL ${r.server_version}`);
console.log(`accessible schemas: ${r.schemas.join(', ')}`);
const checks = evaluateLogin(r, db);
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.info ? ` (${c.info})` : ''}`);
const bad = checks.filter((c) => !c.ok).length;
console.log(bad ? `\n${bad} CHECK(S) FAILED — do not export with this login` : '\nREADY: this login is suitable for the backup export');
process.exit(bad ? 1 : 0);
