#!/usr/bin/env node
/**
 * Builds the restore SQL for a DECRYPTED Dental Lab Manager backup.
 *
 *   age -d -i <private-key-file> <backup>.json.age > backup.json
 *   node scripts/backup/restore.mjs backup.json [manifest.json] > restore.sql
 *   psql -X "$DB_URL" -v ON_ERROR_STOP=1 -f restore.sql
 *   (then delete backup.json and restore.sql)
 *
 * The SQL (scripts/backup/restore-core.mjs) runs in ONE transaction and:
 *   1. refuses to run unless the target's migration history equals the
 *      backup's (restore into the same schema version);
 *   2. disables user triggers on all public tables (no audit / history /
 *      notification side effects), empties them and re-inserts every row in
 *      foreign-key order (identity values kept); the cases <-> stages cycle is
 *      broken by inserting cases.current_stage_id afterwards;
 *   3. resets identity sequences and re-enables the triggers.
 * It touches only schema `public`. Stored files are restored separately
 * (scripts/backup/offsite-restore.mjs restore-files); Auth accounts are not in
 * the backup and must still exist.
 *
 * WARNING: this is a FULL restore: rows created after the backup are removed.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildRestoreSql, verifyAgainstManifest } from './restore-core.mjs';

const [file, manifestFile] = process.argv.slice(2);
if (!file) {
  console.error('usage: restore.mjs backup.json [manifest.json] > restore.sql');
  process.exit(2);
}
const raw = fs.readFileSync(file);
const b = JSON.parse(raw.toString('utf8'));
if (manifestFile) {
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const r = await verifyAgainstManifest(b, m, async (bytes) => crypto.createHash('sha256').update(bytes).digest('hex'), raw);
  if (!r.ok) throw new Error(`checksum mismatch for: ${r.problems.join(', ')}`);
  console.error(`manifest verified: ${r.tables} tables`);
}
const { sql, order, deferred } = buildRestoreSql(b, () => crypto.randomBytes(2).toString('hex'));
process.stdout.write(sql);
console.error(`restore SQL generated: ${order.length} tables, deferred columns: ${JSON.stringify(deferred)}`);
