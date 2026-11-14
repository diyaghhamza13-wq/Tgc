#!/usr/bin/env node
/**
 * OPTIONAL: uploads an already encrypted backup file (.json.age) to the
 * separate backup project's insert-only bucket. Only encrypted files are
 * accepted; the upload key can add files but cannot list, read, overwrite or
 * delete them.
 *
 *   read -rs BACKUP_APIKEY; export BACKUP_APIKEY     # backup project's anon/publishable key
 *   BACKUP_STORAGE_URL=https://<backup-ref>.supabase.co node scripts/backup/upload.mjs ~/dlm-backups/<file>.json.age
 */
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2];
const { BACKUP_STORAGE_URL, BACKUP_APIKEY } = process.env;
const die = (m) => { console.error(m); process.exit(2); };
if (!file || !BACKUP_STORAGE_URL || !BACKUP_APIKEY) die('usage: BACKUP_STORAGE_URL=… BACKUP_APIKEY=… node upload.mjs FILE.json.age');
const name = path.basename(file);
if (!/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\.json\.age$/.test(name)) die('only backup files produced by export.mjs (<stamp>-<id>.json.age) can be uploaded');
const body = fs.readFileSync(file);
if (!body.subarray(0, 22).toString('latin1').startsWith('age-encryption.org/v1')) die('refusing: the file is not age-encrypted');
const res = await fetch(`${BACKUP_STORAGE_URL.replace(/\/$/, '')}/storage/v1/object/dlm-backups/${name}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', apikey: BACKUP_APIKEY },
  body,
});
if (!res.ok) die(`upload failed: HTTP ${res.status}${res.status === 400 || res.status === 409 ? ' (already uploaded, or not allowed)' : ''}`);
console.log(`uploaded: ${name} (${body.length} bytes). Keep your local copy until you have checked it in the dashboard.`);
