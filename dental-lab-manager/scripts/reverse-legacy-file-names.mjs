#!/usr/bin/env node
/**
 * REVERSE of scripts/redact-legacy-files.mjs: puts back the original legacy
 * file names in storage, attachment rows, case history and audit logs, using a
 * DECRYPTED backup (scripts/backup/export.mjs) taken BEFORE the redaction.
 *
 * Because it needs the decrypted backup, it runs where the private backup key
 * is: on the key owner's device (see docs/backup/README.md §6). It never
 * prints names, paths or keys — only attachment ids and counts.
 *
 *   SUPABASE_URL=https://<app-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
 *   BACKUP_JSON=~/backup.json [APPLY=1] node scripts/reverse-legacy-file-names.mjs
 *
 * Without APPLY=1: dry run (counts only).
 * Steps:
 *   1. For every attachment that exists now AND in the backup, whose current
 *      storage path differs from the backup's: Storage API "move" back to the
 *      original object name (skipped if already there).
 *   2. RPC restore_legacy_file_records(): restores the exact backup values of
 *      attachments.storage_path/file_name, file history rows and attachment
 *      audit rows (only rows that still exist; nothing is deleted).
 *   If step 2 fails, the objects moved in step 1 are moved forward again, so
 *   files never point to missing objects.
 * Audit rows written AFTER the backup (by the redaction and by this reversal)
 * are kept: they document what happened.
 */
import fs from 'node:fs';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FILE = process.env.BACKUP_JSON;
const APPLY = process.env.APPLY === '1';
if (!URL || !KEY || !FILE) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and BACKUP_JSON are required');
  process.exit(2);
}
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function call(method, path, body) {
  const res = await fetch(`${URL}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path.split('?')[0]} -> ${res.status}`); // no body: it may echo names
  return text ? JSON.parse(text) : null;
}
const move = (from, to) => call('POST', '/storage/v1/object/move', { bucketId: 'case-files', sourceKey: from, destinationKey: to });

const backup = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if (backup.format !== 'dlm-backup-v1') throw new Error('not a dlm-backup-v1 file');
const bAtt = new Map(backup.data.attachments.map((a) => [a.id, a]));
const bHistory = backup.data.case_history.filter((h) => h.event_type === 'file_uploaded' || h.event_type === 'file_deleted').map((h) => ({ id: h.id, data: h.data }));
const bAudit = backup.data.audit_logs.filter((l) => l.table_name === 'attachments').map((l) => ({ id: l.id, old_data: l.old_data, new_data: l.new_data }));

const current = await call('GET', '/rest/v1/attachments?select=id,storage_path,file_name&order=created_at');
const plan = current.filter((c) => bAtt.has(c.id) && bAtt.get(c.id).storage_path !== c.storage_path);
const relabel = current.filter((c) => bAtt.has(c.id) && bAtt.get(c.id).file_name !== c.file_name);
console.log(`attachments now: ${current.length}, in backup: ${bAtt.size}, objects to move back: ${plan.length}, rows to relabel: ${relabel.length}${APPLY ? '' : ' (dry run)'}`);
if (!APPLY) process.exit(0);

const moved = [];
for (const c of plan) {
  try {
    await move(c.storage_path, bAtt.get(c.id).storage_path);
    moved.push(c);
    console.log(`  ✓ ${c.id}: object moved back`);
  } catch (e) {
    console.log(`  ✗ ${c.id}: move failed (${e.message}); undoing ${moved.length} move(s) and stopping`);
    for (const m of moved) await move(bAtt.get(m.id).storage_path, m.storage_path).catch(() => console.log(`  !! ${m.id}: could not undo — check manually`));
    process.exit(1);
  }
}
const ids = new Set(current.map((c) => c.id));
const attachments = [...bAtt.values()].filter((a) => ids.has(a.id)).map((a) => ({ id: a.id, storage_path: a.storage_path, file_name: a.file_name }));
try {
  const res = await call('POST', '/rest/v1/rpc/restore_legacy_file_records', { p_attachments: attachments, p_history: bHistory, p_audit: bAudit });
  console.log(`moved back: ${moved.length}, restored: ${JSON.stringify(res)}`);
} catch (e) {
  console.log(`  ✗ database restore failed (${e.message}); moving ${moved.length} object(s) forward again`);
  for (const m of moved) await move(bAtt.get(m.id).storage_path, m.storage_path).catch(() => console.log(`  !! ${m.id}: could not undo — check manually`));
  process.exit(1);
}
