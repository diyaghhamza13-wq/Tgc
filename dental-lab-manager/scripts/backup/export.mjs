#!/usr/bin/env node
/**
 * Encrypted logical backup of the Dental Lab Manager database (read-only).
 * RECOMMENDED USE: on the operator's own phone (Termux), connected directly to
 * Postgres with the read-only backup login — see docs/backup/README.md.
 *
 *   read -rs PGPASSWORD; export PGPASSWORD           # typed, never stored
 *   DB_URL='postgresql://dlm_backup_reader@<host>:5432/postgres?sslmode=require' \
 *   AGE_RECIPIENT=age1… OUT_DIR=~/dlm-backups node scripts/backup/export.mjs
 *
 * What it does
 *  - Checks the login first: it must be read-only (no INSERT/UPDATE/DELETE/
 *    TRUNCATE privilege on any public table, no auth schema access), unless
 *    ALLOW_PRIVILEGED_LOGIN=1 (local tests only).
 *  - Reads ALL rows of all public tables + migration history + storage object
 *    metadata in ONE read-only SELECT (one consistent snapshot).
 *  - Keeps the data in memory only, computes a manifest (row count + SHA-256
 *    per table; no personal data) and encrypts the data with `age` to the
 *    PUBLIC key in AGE_RECIPIENT. No unencrypted copy is written to disk.
 *  - Saves <stamp>-<random>.json.age and <…>.manifest.json in OUT_DIR. Nothing
 *    is uploaded: use scripts/backup/upload.mjs afterwards (optional).
 *
 * Never prints row contents, keys or passwords.
 *
 * Not recommended (plaintext passes through whoever runs it): the Management
 * API source SUPABASE_PROJECT_REF=<ref>, accepted only with ALLOW_CLOUD_EXPORT=1.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { DB_URL, SUPABASE_PROJECT_REF: REF, AGE_RECIPIENT, OUT_DIR, ALLOW_CLOUD_EXPORT, ALLOW_PRIVILEGED_LOGIN } = process.env;
const die = (m) => { console.error(m); process.exit(2); };
if (!DB_URL === !REF) die('set exactly one of DB_URL (recommended) or SUPABASE_PROJECT_REF');
if (REF && ALLOW_CLOUD_EXPORT !== '1') die('Management API export is disabled: run the export on your own device with DB_URL (see docs/backup/README.md)');
if (!/^age1[0-9a-z]{58}$/.test(AGE_RECIPIENT ?? '')) die('AGE_RECIPIENT must be an age public key (age1…)');
if (!OUT_DIR) die('OUT_DIR is required');
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
if (path.resolve(OUT_DIR).startsWith(repoRoot)) die('OUT_DIR must be outside the repository');

if (DB_URL) {
  let u;
  try { u = new URL(DB_URL); } catch { die('DB_URL is not a valid postgresql:// URL'); }
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  const ssl = u.searchParams.get('sslmode');
  if (!local && !['require', 'verify-ca', 'verify-full'].includes(ssl ?? '')) die('remote DB_URL must use ?sslmode=require (or verify-full)');
  if (u.password) console.error('note: the password is in DB_URL; prefer PGPASSWORD typed with `read -rs` (not saved in shell history)');
}

/** Run one read-only SQL statement and return its single JSON value. */
async function query(sql) {
  const ro = `begin transaction read only; ${sql}; commit;`;
  if (DB_URL) {
    const out = execFileSync('psql', [DB_URL, '-At', '-q', '-v', 'ON_ERROR_STOP=1'], { input: ro, maxBuffer: 1 << 30 }).toString().trim();
    return JSON.parse(out);
  }
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: 'Bearer proxy-injected', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }), // a single SELECT: read-only by construction
  });
  if (!res.ok) die(`Management API query failed: ${res.status}`);
  const rows = await res.json();
  return Object.values(rows[0])[0];
}

// 0. the login must be read-only
const who = await query(`select json_build_object(
  'user', current_user,
  'write_privileges', (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
      and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE')
        or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE'))),
  'auth_access', has_schema_privilege('auth', 'USAGE'))`);
if ((who.write_privileges > 0 || who.auth_access) && ALLOW_PRIVILEGED_LOGIN !== '1') {
  die(`login "${who.user}" is not the read-only backup login (write privileges on ${who.write_privileges} tables, auth access: ${who.auth_access}). Use dlm_backup_reader.`);
}

// 1. structure
const schema = await query(`select json_build_object(
  'tables', (select json_agg(tablename order by tablename) from pg_tables where schemaname = 'public'),
  'columns', (select json_object_agg(table_name, cols) from (
      select table_name, json_agg(json_build_object('name', column_name, 'nullable', is_nullable = 'YES', 'identity', is_identity = 'YES') order by ordinal_position) cols
      from information_schema.columns where table_schema = 'public' group by table_name) c),
  'fks', (select json_agg(json_build_object('child', c.conrelid::regclass::text, 'parent', c.confrelid::regclass::text,
      'columns', (select json_agg(a.attname) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey))))
    from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace))`);
const tables = schema.tables;
if (!tables?.length) die('no tables found');

// 2. data: one statement = one snapshot
const parts = tables.map((t) => `'${t}', (select coalesce(json_agg(x order by x::text), '[]'::json) from public."${t}" x)`);
const data = await query(`select json_build_object(
  'exported_at', now(),
  'server_version', current_setting('server_version'),
  'migrations', (select json_agg(version order by version) from supabase_migrations.schema_migrations),
  'tables_in_snapshot', (select json_agg(tablename order by tablename) from pg_tables where schemaname = 'public'),
  'storage_objects', (select coalesce(json_agg(json_build_object('bucket', bucket_id, 'name', name, 'size', metadata->>'size', 'created_at', created_at) order by bucket_id, name), '[]'::json) from storage.objects),
  'data', json_build_object(${parts.join(', ')}))`);
if (JSON.stringify(data.tables_in_snapshot) !== JSON.stringify(tables)) die('table list changed during export; run again');

const backup = { format: 'dlm-backup-v1', ...data, schema };
const manifest = {
  format: 'dlm-backup-manifest-v1',
  exported_at: data.exported_at,
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
