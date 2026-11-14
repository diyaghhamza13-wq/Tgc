#!/usr/bin/env node
/**
 * Encrypted logical backup of the Dental Lab Manager database (read-only).
 *
 * What it does
 *  - Reads the list of public tables, their columns and foreign keys.
 *  - Reads ALL rows of all public tables + migration history + storage object
 *    metadata in ONE SELECT statement (one consistent snapshot).
 *  - Keeps the data in memory only, computes a manifest (row count + SHA-256
 *    per table; no personal data) and encrypts the data with `age` to the
 *    PUBLIC key given in AGE_RECIPIENT. Only the holder of the matching private
 *    key can decrypt. No unencrypted copy is written to disk.
 *  - Optionally uploads the encrypted file to the separate backup project
 *    (insert-only bucket, see docs/backup/README.md).
 *
 * Never prints row contents, keys or passphrases.
 *
 * Source (one of):
 *   DB_URL=postgresql://…                          (psql)
 *   SUPABASE_PROJECT_REF=<ref>                     (Management API; token injected by the proxy)
 * Required:
 *   AGE_RECIPIENT=age1…                            (public key only)
 *   OUT_DIR=/path/outside/the/repository
 * Optional upload:
 *   BACKUP_STORAGE_URL=https://<backup-ref>.supabase.co   (apikey injected by the proxy, or BACKUP_APIKEY)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { DB_URL, SUPABASE_PROJECT_REF: REF, AGE_RECIPIENT, OUT_DIR, BACKUP_STORAGE_URL, BACKUP_APIKEY } = process.env;
const die = (m) => { console.error(m); process.exit(2); };
if (!DB_URL === !REF) die('set exactly one of DB_URL or SUPABASE_PROJECT_REF');
if (!/^age1[0-9a-z]{58}$/.test(AGE_RECIPIENT ?? '')) die('AGE_RECIPIENT must be an age public key (age1…)');
if (!OUT_DIR) die('OUT_DIR is required');
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
if (path.resolve(OUT_DIR).startsWith(repoRoot)) die('OUT_DIR must be outside the repository');

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
const encPath = path.join(OUT_DIR, name);
fs.writeFileSync(encPath, enc.stdout, { mode: 0o600 });
manifest.file = name;
manifest.encrypted_sha256 = crypto.createHash('sha256').update(enc.stdout).digest('hex');
manifest.encrypted_bytes = enc.stdout.length;
fs.writeFileSync(path.join(OUT_DIR, name.replace(/\.json\.age$/, '.manifest.json')), JSON.stringify(manifest, null, 2), { mode: 0o600 });
const total = Object.values(manifest.tables).reduce((s, t) => s + t.rows, 0);
console.log(`encrypted backup written: ${name} (${enc.stdout.length} bytes, ${tables.length} tables, ${total} rows)`);

// 4. optional upload (insert-only bucket in the separate backup project)
if (BACKUP_STORAGE_URL) {
  const headers = { 'Content-Type': 'application/octet-stream', apikey: BACKUP_APIKEY || 'proxy-injected' };
  const res = await fetch(`${BACKUP_STORAGE_URL}/storage/v1/object/dlm-backups/${name}`, { method: 'POST', headers, body: enc.stdout });
  if (!res.ok) die(`upload failed: ${res.status}`);
  console.log(`uploaded to backup project as ${name}`);
}
