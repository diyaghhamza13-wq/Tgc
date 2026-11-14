#!/usr/bin/env node
/**
 * Encrypted logical backup of the Dental Lab Manager database (read-only).
 * Runs on the operator's own phone (Termux) with the read-only backup login —
 * see docs/backup/README.md. There is no cloud / Management API mode.
 *
 *   read -rs PGPASSWORD; export PGPASSWORD           # typed, never stored
 *   DB_URL='postgresql://dlm_backup_reader@<host>:5432/postgres?sslmode=verify-full&sslrootcert=/path/supabase-ca.crt' \
 *   AGE_RECIPIENT=age1… OUT_DIR=~/dlm-backups node scripts/backup/export.mjs
 *
 * Before reading any data it checks, on the established connection
 * (scripts/backup/lib.mjs): TLS with certificate + host-name verification,
 * no write / create / SECURITY DEFINER / auth / vault access in any accessible
 * schema, read-only default, and row-level-security bypass (complete backup).
 * The data snapshot itself re-checks TLS and the login name.
 *
 * Output: <stamp>-<random>.json.age (+ .manifest.json with counts and SHA-256
 * only) in OUT_DIR. No plaintext is written to disk; nothing is uploaded.
 * Never prints row contents, keys, passwords or the connection string.
 *
 * ALLOW_PRIVILEGED_LOGIN=1 is accepted ONLY for loopback hosts (local tests).
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateLogin, LOGIN_CHECK_SQL, parseDbUrl, psqlJson, redact } from './lib.mjs';

const { DB_URL, AGE_RECIPIENT, OUT_DIR, ALLOW_PRIVILEGED_LOGIN, SUPABASE_PROJECT_REF } = process.env;
const die = (m) => { console.error(redact(m, [DB_URL])); process.exit(2); };

if (SUPABASE_PROJECT_REF) die('the Management API (cloud) export mode has been removed: run the export on your own device with DB_URL');
let db;
try { db = parseDbUrl(DB_URL); } catch (e) { die(e.message); }
if (!/^age1[0-9a-z]{58}$/.test(AGE_RECIPIENT ?? '')) die('AGE_RECIPIENT must be an age public key (age1…)');
if (!OUT_DIR) die('OUT_DIR is required');
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
if (path.resolve(OUT_DIR).startsWith(repoRoot)) die('OUT_DIR must be outside the repository');
if (db.hasPassword) console.error('note: the password is in DB_URL; prefer PGPASSWORD typed with `read -rs` (not saved in shell history)');
const allowPrivileged = ALLOW_PRIVILEGED_LOGIN === '1';
if (allowPrivileged && !db.local) die('ALLOW_PRIVILEGED_LOGIN is only accepted for local test databases');

const q = (sql) => { try { return psqlJson(db, sql); } catch (e) { die(`database error: ${e.message}`); } };

// 0. the login and the connection must be safe and complete
const facts = q(LOGIN_CHECK_SQL);
const failed = evaluateLogin(facts, db, { allowPrivileged }).filter((c) => !c.ok);
if (failed.length) die(`refusing to export with login "${facts.user}":\n${failed.map((c) => `  ✗ ${c.name}${c.info ? ` (${c.info})` : ''}`).join('\n')}`);

// 1. structure
const schema = q(`begin transaction read only;
select json_build_object(
  'tables', (select json_agg(tablename order by tablename) from pg_tables where schemaname = 'public'),
  'columns', (select json_object_agg(table_name, cols) from (
      select table_name, json_agg(json_build_object('name', column_name, 'nullable', is_nullable = 'YES', 'identity', is_identity = 'YES') order by ordinal_position) cols
      from information_schema.columns where table_schema = 'public' group by table_name) c),
  'fks', (select json_agg(json_build_object('child', c.conrelid::regclass::text, 'parent', c.confrelid::regclass::text,
      'columns', (select json_agg(a.attname) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey))))
    from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace));
commit;`);
const tables = schema.tables;
if (!tables?.length) die('no tables found');
if (tables.some((t) => !/^[a-z_][a-z0-9_]*$/.test(t))) die('unexpected table name in schema public');

// 2. data: one statement = one snapshot (re-checks TLS and the login inside it)
const parts = tables.map((t) => `'${t}', (select coalesce(json_agg(x order by x::text), '[]'::json) from public."${t}" x)`);
const data = q(`begin transaction read only;
select json_build_object(
  'exported_at', now(),
  'server_version', current_setting('server_version'),
  'session_user', current_user,
  'session_tls', coalesce((select ssl from pg_stat_ssl where pid = pg_backend_pid()), false),
  'migrations', (select json_agg(version order by version) from supabase_migrations.schema_migrations),
  'tables_in_snapshot', (select json_agg(tablename order by tablename) from pg_tables where schemaname = 'public'),
  'storage_objects', (select coalesce(json_agg(json_build_object('bucket', bucket_id, 'name', name, 'size', metadata->>'size', 'created_at', created_at) order by bucket_id, name), '[]'::json) from storage.objects),
  'data', json_build_object(${parts.join(', ')}));
commit;`);
if (!db.local && !data.session_tls) die('the data connection was not encrypted: nothing saved');
if (data.session_user !== facts.user) die('the data connection used a different login: nothing saved');
if (JSON.stringify(data.tables_in_snapshot) !== JSON.stringify(tables)) die('table list changed during export; run again');
delete data.session_tls;
delete data.session_user;

const backup = { format: 'dlm-backup-v1', ...data, schema };
const manifest = {
  format: 'dlm-backup-manifest-v1',
  exported_at: data.exported_at,
  login: facts.user,
  tls: facts.tls ? facts.tls_version : 'local',
  migrations: data.migrations,
  tables: Object.fromEntries(tables.map((t) => [t, { rows: data.data[t].length, sha256: crypto.createHash('sha256').update(JSON.stringify(data.data[t])).digest('hex') }])),
  storage_objects: data.storage_objects.length,
};

// 3. encrypt in memory -> file
const stamp = new Date(data.exported_at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const name = `${stamp}-${crypto.randomBytes(4).toString('hex')}.json.age`;
const plaintext = Buffer.from(JSON.stringify(backup));
const enc = spawnSync('age', ['-r', AGE_RECIPIENT], { input: plaintext, maxBuffer: 1 << 30 });
plaintext.fill(0);
if (enc.status !== 0) die('age encryption failed');
fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(OUT_DIR, name), enc.stdout, { mode: 0o600 });
manifest.file = name;
manifest.encrypted_sha256 = crypto.createHash('sha256').update(enc.stdout).digest('hex');
manifest.encrypted_bytes = enc.stdout.length;
fs.writeFileSync(path.join(OUT_DIR, name.replace(/\.json\.age$/, '.manifest.json')), JSON.stringify(manifest, null, 2), { mode: 0o600 });
const total = Object.values(manifest.tables).reduce((s, t) => s + t.rows, 0);
console.log(`saved locally: ${path.join(OUT_DIR, name)}`);
console.log(`  ${enc.stdout.length} bytes, ${tables.length} tables, ${total} rows, sha256 ${manifest.encrypted_sha256}`);
console.log('next: verify it (scripts/backup/verify.mjs); upload is optional (scripts/backup/upload.mjs)');
