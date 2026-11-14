#!/usr/bin/env node
/**
 * Disaster recovery from the off-site encrypted backups (any computer; also
 * used by the local tests). Needs the PRIVATE key and a RESTORE key for the
 * bucket that can READ objects and LIST OBJECT VERSIONS (create it only when
 * needed; it is never given to the backup runner).
 *
 * Tamper resistance: every object is read in its FIRST (oldest) version. The
 * runner writes each key exactly once; a compromised runner (write-only key) can
 * only ADD versions, which are reported and ignored. The pinned version ids in
 * the manifest and file map must equal those first versions. Without
 * version-listing permission the tool refuses, unless --trust-latest is given.
 *
 *   S3_ENDPOINT=https://… S3_REGION=… S3_BUCKET=… S3_READ_KEY_ID=… S3_READ_SECRET=… \
 *   AGE_IDENTITY=~/dlm-backup-key.txt OUT_DIR=~/restore \
 *   node scripts/backup/offsite-restore.mjs fetch runs/20261114T021700Z-ab12cd34 [--write-plain]
 *       downloads manifest + encrypted snapshot + encrypted file map, checks every
 *       ciphertext SHA-256 against the manifest, decrypts IN MEMORY and verifies all
 *       tables. With --write-plain it also writes OUT_DIR/backup.json for restore.mjs
 *       (delete it afterwards).
 *
 *   … SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *   node scripts/backup/offsite-restore.mjs restore-files runs/…
 *       decrypts the file map, downloads every encrypted file, checks both hashes and
 *       uploads the original file to Supabase Storage (same bucket and path, upsert).
 *
 * Never prints file names, row data or keys (only counts and hashes).
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { verifyAgainstManifest } from './restore-core.mjs';

const E = process.env;
const die = (m) => { console.error(m); process.exit(2); };
const args = process.argv.slice(2);
const trustLatest = args.includes('--trust-latest');
const [cmd, prefix, flag] = args.filter((a) => a !== '--trust-latest');
const warnings = [];
const warn = (m) => { warnings.push(m); console.error(`WARNING: ${m}`); };
if (!['fetch', 'restore-files'].includes(cmd) || !/^runs\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(prefix ?? '')) {
  die('usage: offsite-restore.mjs fetch|restore-files runs/<stamp>-<id> [--write-plain] [--trust-latest]');
}
for (const v of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_READ_KEY_ID', 'S3_READ_SECRET', 'AGE_IDENTITY', 'OUT_DIR']) if (!E[v]) die(`${v} is required`);
const region = E.S3_REGION || 'auto';
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Minimal AWS SigV4 GET (header auth, unsigned payload). key null = bucket-level request. */
async function s3req(key, params = {}) {
  const u = new URL(`${E.S3_ENDPOINT.replace(/\/$/, '')}/${E.S3_BUCKET}${key === null ? '' : '/' + key.split('/').map(rfc3986).join('/')}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const date = amzDate.slice(0, 8);
  const headers = { host: u.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const query = [...u.searchParams.entries()].map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).sort().join('&');
  const canonical = ['GET', u.pathname, query, signed.map((h) => `${h}:${headers[h]}\n`).join(''), signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const k = hmac(hmac(hmac(hmac('AWS4' + E.S3_READ_SECRET, date), region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', k).update(toSign).digest('hex');
  return fetch(u, { redirect: 'error', headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${E.S3_READ_KEY_ID}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${sig}` } });
}
async function s3get(key, versionId = null) {
  const res = await s3req(key, versionId ? { versionId } : {});
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
/** Data versions of exactly this key, oldest first (null if listing is not permitted/supported). */
async function versionsOf(key) {
  const res = await s3req(null, { versions: '', prefix: key });
  const xml = await res.text();
  if (!res.ok) return null;
  const out = [];
  for (const m of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
    const k = /<Key>([\s\S]*?)<\/Key>/.exec(m[2])?.[1];
    const id = /<VersionId>([\s\S]*?)<\/VersionId>/.exec(m[2])?.[1];
    const at = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(m[2])?.[1];
    if (k === key && m[1] === 'Version') out.push({ id, at });
  }
  // listed newest first; stable sort by time keeps that order for equal times, so reverse first
  return out.reverse().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
/** Reads the FIRST version written under key; checks it against the pinned version id if any. */
async function getOriginal(key, pinned, what) {
  const vs = await versionsOf(key);
  if (vs === null) {
    if (!trustLatest) die('FAILED: the restore key cannot list object versions, so tampering cannot be ruled out (give it that permission, or pass --trust-latest to accept the risk)');
    warn(`${what}: version history not checked (--trust-latest)`);
    return s3get(key, pinned);
  }
  if (!vs.length) die(`FAILED: ${what} not found`);
  if (vs.length > 1) warn(`${what} was written ${vs.length} times; using the FIRST version (later versions ignored: possible tampering)`);
  if (pinned && pinned !== vs[0].id) die(`FAILED: ${what}: recorded version is not the first version written (possible tampering)`);
  return s3get(key, vs[0].id);
}
const decrypt = (cipher) => {
  const r = spawnSync('age', ['-d', '-i', E.AGE_IDENTITY], { input: cipher, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('decryption failed (wrong key?)');
  return r.stdout;
};

fs.mkdirSync(E.OUT_DIR, { recursive: true, mode: 0o700 });
const manifestBuf = await getOriginal(`${prefix}/manifest.json`, null, 'manifest');
const m = JSON.parse(manifestBuf);
fs.writeFileSync(path.join(E.OUT_DIR, 'manifest.json'), manifestBuf, { mode: 0o600 });
// whom was this run encrypted to? (public keys are in the manifest)
const mine = spawnSync('age-keygen', ['-y', E.AGE_IDENTITY]).stdout?.toString().trim();
if (Array.isArray(m.recipients)) {
  if (!m.recipients.includes(mine)) warn('this run is NOT encrypted to your key');
  const others = m.recipients.filter((r) => r !== mine).length;
  if (others) warn(`this run is also encrypted to ${others} other key(s): check they are yours`);
}

if (cmd === 'fetch') {
  const db = await getOriginal(m.db.key, m.db.version_id, 'snapshot');
  if (sha256(db) !== m.db.cipher_sha256) die('FAILED: encrypted snapshot hash differs from the manifest');
  const map = await getOriginal(m.filemap.key, m.filemap.version_id, 'file map');
  if (sha256(map) !== m.filemap.cipher_sha256) die('FAILED: encrypted file map hash differs from the manifest');
  fs.writeFileSync(path.join(E.OUT_DIR, 'db.json.age'), db, { mode: 0o600 });
  fs.writeFileSync(path.join(E.OUT_DIR, 'files.json.age'), map, { mode: 0o600 });
  const plain = decrypt(db);
  const b = JSON.parse(plain.toString('utf8'));
  const r = await verifyAgainstManifest(b, m, async (x) => sha256(x));
  if (!r.ok) die(`FAILED: ${r.problems.join(', ')}`);
  const files = JSON.parse(decrypt(map).toString('utf8')).files;
  if (files.length !== m.storage_objects) die('FAILED: file map size differs from the manifest');
  if (flag === '--write-plain') fs.writeFileSync(path.join(E.OUT_DIR, 'backup.json'), plain, { mode: 0o600 });
  plain.fill(0);
  console.log(`OK: ${r.tables} tables, ${r.rows} rows, ${files.length} stored files listed, exported ${m.exported_at}${flag === '--write-plain' ? ' (backup.json written: delete it after restoring)' : ''}${warnings.length ? ` — ${warnings.length} warning(s)` : ''}`);
} else {
  if (!E.SUPABASE_URL || !E.SUPABASE_SERVICE_ROLE_KEY) die('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const map = await getOriginal(m.filemap.key, m.filemap.version_id, 'file map');
  if (sha256(map) !== m.filemap.cipher_sha256) die('FAILED: encrypted file map hash differs from the manifest');
  const files = JSON.parse(decrypt(map).toString('utf8')).files;
  let ok = 0;
  for (const f of files) {
    const cipher = await getOriginal(f.backup_key, f.version_id, `file ${f.id}`);
    if (sha256(cipher) !== f.cipher_sha256) die(`FAILED: ciphertext hash mismatch for object ${f.id}`);
    const plain = decrypt(cipher);
    if (sha256(plain) !== f.sha256) die(`FAILED: plaintext hash mismatch for object ${f.id}`);
    const res = await fetch(`${E.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/${encodeURIComponent(f.bucket)}/${f.name.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST',
      headers: { apikey: E.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${E.SUPABASE_SERVICE_ROLE_KEY}`, 'x-upsert': 'true', 'Content-Type': f.mimetype || 'application/octet-stream' },
      body: plain,
    });
    if (!res.ok) die(`FAILED: storage upload for object ${f.id}: HTTP ${res.status}`);
    plain.fill(0);
    ok++;
  }
  console.log(`OK: ${ok}/${files.length} stored files restored (both hashes verified)${warnings.length ? ` — ${warnings.length} warning(s)` : ''}`);
}
