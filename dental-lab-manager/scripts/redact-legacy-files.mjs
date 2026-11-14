#!/usr/bin/env node
/**
 * One-time maintenance after migration 20261114155851 (production-only cases):
 * removes ORIGINAL legacy file names from storage paths, attachment rows, case
 * history and audit logs. File contents are not changed and nothing is deleted.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
 *   [APPLY=1] node scripts/redact-legacy-files.mjs
 *
 * Without APPLY=1 it is a dry run: it only counts what would change.
 * It never prints file names, paths or keys — only attachment ids and counts.
 *
 * For each legacy attachment whose storage object still carries its original
 * name (<lab>/<case>/<uuid>-<name>):
 *   1. Storage API "move" to <lab>/<case>/<new uuid>.<ext>
 *   2. RPC redact_legacy_attachment(id, new_path) — updates the row and scrubs
 *      history/audit. If this fails, the object is moved back (no broken links).
 * Finally RPC redact_legacy_file_names() (idempotent) for history/audit rows of
 * files that were already deleted.
 */
import crypto from 'node:crypto';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APPLY = process.env.APPLY === '1';
if (!URL || !KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(2);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const ANON_PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

async function call(method, path, body) {
  const res = await fetch(`${URL}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status}`); // no body: it may echo names
  return text ? JSON.parse(text) : null;
}
const move = (from, to) => call('POST', '/storage/v1/object/move', { bucketId: 'case-files', sourceKey: from, destinationKey: to });

const rows = await call('GET', '/rest/v1/attachments?select=id,lab_id,case_id,storage_path&order=created_at');
const legacy = rows.filter((r) => !ANON_PATH.test(r.storage_path));
console.log(`attachments: ${rows.length}, with original names in storage path: ${legacy.length}${APPLY ? '' : ' (dry run)'}`);

let moved = 0;
let failed = 0;
for (const r of legacy) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(r.storage_path);
  const ext = m ? m[1].toLowerCase() : 'bin';
  const to = `${r.lab_id}/${r.case_id}/${crypto.randomUUID()}.${ext}`;
  if (!APPLY) continue;
  try {
    await move(r.storage_path, to);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${r.id}: move failed (${e.message})`);
    continue;
  }
  try {
    await call('POST', '/rest/v1/rpc/redact_legacy_attachment', { p_attachment_id: r.id, p_new_path: to });
    moved++;
    console.log(`  ✓ ${r.id}: renamed`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${r.id}: database update failed (${e.message}); moving the object back`);
    await move(to, r.storage_path).catch(() => console.log(`  !! ${r.id}: could not move back — check manually`));
  }
}
if (APPLY) {
  const res = await call('POST', '/rest/v1/rpc/redact_legacy_file_names', {});
  console.log(`renamed objects: ${moved}, failures: ${failed}, scrub: ${JSON.stringify(res)}`);
}
process.exit(failed ? 1 : 0);
