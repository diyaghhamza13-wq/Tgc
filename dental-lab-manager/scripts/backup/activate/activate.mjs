#!/usr/bin/env node
/**
 * Activation of the automated backup (docs/backup/BACKUP-RUNNER.md §6).
 *
 * Credentials are NEVER typed, printed or stored here:
 *  - Supabase Management API (api.supabase.com) and the Backblaze account key
 *    (api.backblazeb2.com) are injected by the environment's credential proxy; this
 *    script sends placeholder values that the proxy replaces.
 *  - Secrets created during activation (Backblaze runner keys, the backup token) go
 *    straight from the API response into the runner project's encrypted function secrets.
 *    Production receives only the token's SHA-256 hash.
 *  - Production's PUBLIC anon key is read from the app configuration and checked to be
 *    role "anon". The production service-role key is never requested.
 *
 *   node scripts/backup/activate/activate.mjs <command> [args]
 *     check <runner-ref>                    runner project: region, organization, status
 *     b2-setup <runner-ref>                 B2 bucket (Object Lock compliance 35 d, lifecycle) + 2 runner keys → runner secrets
 *     runner-setup <runner-ref> <age1…>     runner database + production URL / anon key / public key → runner secrets
 *     deploy <runner-ref>                   deploy dlm-backup (deno.lock, verify_jwt off)
 *     prod-migration                        PRODUCTION: apply 20261115090000_backup_read_access.sql   (approval!)
 *     token <runner-ref>                    PRODUCTION: register a new token hash; runner gets the token (approval!)
 *     schedule <runner-ref>                 function URL in the runner's Vault + pg_cron jobs
 *     invoke <runner-ref> <mode>            selftest | backup | continue | verify  (through the runner's own pg_net)
 *     status <runner-ref> [n]               last runs (no names, no data)
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const PROD_REF = 'slfwakmskshkbrfqqfwl';
const PLACEHOLDER_PAT = 'sbp_' + '0'.repeat(40);              // replaced by the credential proxy
const PLACEHOLDER_BASIC = 'Basic ' + Buffer.from('proxy:replaced').toString('base64');
const die = (m) => { console.error(`FAILED: ${m}`); process.exit(2); };
const [cmd, ...args] = process.argv.slice(2);
const refOk = (r) => /^[a-z]{20}$/.test(r ?? '') && r !== PROD_REF;

async function mgmt(method, p, body) {
  const res = await fetch(`https://api.supabase.com${p}`, {
    method, redirect: 'error',
    headers: { Authorization: `Bearer ${PLACEHOLDER_PAT}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) die(`Management API ${method} ${p.replace(/[a-z]{20}/g, '<ref>')}: HTTP ${res.status} ${text.slice(0, 200).replace(/sbp_[A-Za-z0-9]+|eyJ[A-Za-z0-9._-]+/g, '<redacted>')}`);
  return text ? JSON.parse(text) : null;
}
const query = (ref, sql) => mgmt('POST', `/v1/projects/${ref}/database/query`, { query: sql });
const setSecrets = (ref, pairs) => mgmt('POST', `/v1/projects/${ref}/secrets`, Object.entries(pairs).map(([name, value]) => ({ name, value })));

async function runnerProject(ref) {
  if (!refOk(ref)) die('give the runner project ref (20 lowercase letters), not production');
  const all = await mgmt('GET', '/v1/projects');
  const p = all.find((x) => x.id === ref);
  const prod = all.find((x) => x.id === PROD_REF);
  if (!p) die('runner project not found for this account');
  return { p, prod };
}

async function check(ref) {
  const { p, prod } = await runnerProject(ref);
  const ok = { region_london: p.region === 'eu-west-2', separate_organization: p.organization_id !== prod?.organization_id, active: /ACTIVE/.test(p.status ?? '') };
  console.log(JSON.stringify({ runner: p.name, region: p.region, status: p.status, ...ok }));
  if (!ok.region_london) die('the runner project must be in eu-west-2 (London)');
  if (!ok.active) die('the runner project is not active yet');
  return p;
}

/** production's PUBLIC anon key from the app configuration (never the service key) */
function prodAnonKey() {
  const candidates = [path.join(ROOT, 'eas.json'), path.join(ROOT, '.env')].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8'));
  for (const t of candidates) {
    for (const k of t.match(/eyJhbGciOi[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []) {
      try {
        const p = JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString());
        if (p.role === 'anon' && p.ref === PROD_REF) return k;
      } catch { /* next */ }
    }
  }
  die('production anon key not found in eas.json/.env');
}

async function b2Setup(ref) {
  await check(ref);
  // 1. account authorization: the proxy injects the account key (Basic auth) for api.backblazeb2.com
  const authRes = await fetch('https://api.backblazeb2.com/b2api/v4/b2_authorize_account', { headers: { Authorization: PLACEHOLDER_BASIC }, redirect: 'error' });
  if (!authRes.ok) die(`b2_authorize_account: HTTP ${authRes.status} (is the Backblaze key saved in the environment?)`);
  const auth = await authRes.json();
  const api = auth.apiInfo.storageApi;
  const s3 = new URL(api.s3ApiUrl);
  const region = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(s3.hostname)?.[1];
  if (!region?.startsWith('eu-')) die(`the Backblaze account is not in an EU region (${region}); create it with region EU Central`);
  const b2 = async (op, body) => {
    const r = await fetch(`${api.apiUrl}/b2api/v4/${op}`, { method: 'POST', redirect: 'error', headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) die(`${op}: HTTP ${r.status} ${j.code ?? ''} ${(j.message ?? '').slice(0, 160)}`);
    return j;
  };
  // 2. bucket: private, Object Lock (compliance, 35 days by default), lifecycle 35 + 1 days
  const lifecycleRules = [{ fileNamePrefix: '', daysFromUploadingToHiding: 35, daysFromHidingToDeleting: 1 }];
  const existing = (await b2('b2_list_buckets', { accountId: auth.accountId })).buckets.find((b) => b.bucketName.startsWith('dlm-backups-'));
  let bucket = existing;
  if (!bucket) bucket = await b2('b2_create_bucket', { accountId: auth.accountId, bucketName: `dlm-backups-${crypto.randomBytes(5).toString('hex')}`, bucketType: 'allPrivate', fileLockEnabled: true, lifecycleRules });
  if (!bucket.fileLockConfiguration?.value?.isFileLockEnabled) die('the bucket does not have Object Lock enabled (it must be enabled at creation)');
  bucket = await b2('b2_update_bucket', { accountId: auth.accountId, bucketId: bucket.bucketId, bucketType: 'allPrivate', lifecycleRules,
    defaultRetention: { mode: 'compliance', period: { duration: 35, unit: 'days' } } });
  const dr = bucket.fileLockConfiguration?.value?.defaultRetention;
  if (dr?.mode !== 'compliance' || dr?.period?.duration !== 35 || dr?.period?.unit !== 'days') die('default retention could not be set to compliance / 35 days');
  // 3. runner keys, restricted to this bucket (replace earlier ones with the same names)
  const keys = (await b2('b2_list_keys', { accountId: auth.accountId, maxKeyCount: 1000 })).keys ?? [];
  for (const k of keys.filter((k) => ['dlm-runner-write', 'dlm-runner-read'].includes(k.keyName))) await b2('b2_delete_key', { applicationKeyId: k.applicationKeyId });
  const w = await b2('b2_create_key', { accountId: auth.accountId, keyName: 'dlm-runner-write', capabilities: ['writeFiles'], bucketIds: [bucket.bucketId] });
  const r = await b2('b2_create_key', { accountId: auth.accountId, keyName: 'dlm-runner-read', capabilities: ['readFiles', 'readFileRetentions'], bucketIds: [bucket.bucketId] });
  // 4. straight into the runner's encrypted function secrets (never printed)
  await setSecrets(ref, {
    DLM_BACKUP_S3_ENDPOINT: s3.origin, DLM_BACKUP_S3_REGION: region, DLM_BACKUP_S3_BUCKET: bucket.bucketName,
    DLM_BACKUP_S3_WRITE_KEY_ID: w.applicationKeyId, DLM_BACKUP_S3_WRITE_SECRET: w.applicationKey,
    DLM_BACKUP_S3_READ_KEY_ID: r.applicationKeyId, DLM_BACKUP_S3_READ_SECRET: r.applicationKey,
  });
  console.log(JSON.stringify({ bucket: bucket.bucketName, region, endpoint: s3.origin, object_lock: 'compliance 35 days (default)', lifecycle: 'hide after 35 d, delete 1 d later',
    keys: { 'dlm-runner-write': w.capabilities, 'dlm-runner-read': r.capabilities }, runner_secrets_set: 7 }));
}

async function runnerSetup(ref, recipients) {
  await check(ref);
  const pubs = (recipients ?? '').split(/[\s,]+/).filter(Boolean);
  if (!pubs.length || !pubs.every((k) => /^age1[0-9a-z]{58}$/.test(k))) die('give the PUBLIC key(s) age1… (never the private key)');
  const migration = fs.readFileSync(path.join(ROOT, 'backup-runner/supabase/migrations/20261115090100_runner_state.sql'), 'utf8');
  const done = await query(ref, "select to_regclass('dlm_runner.runs') is not null as present");
  if (!done[0].present) await query(ref, `begin;\nset local role postgres;\n${migration}\ncommit;`);
  await setSecrets(ref, { DLM_PROD_URL: `https://${PROD_REF}.supabase.co`, DLM_PROD_ANON_KEY: prodAnonKey(), DLM_BACKUP_AGE_RECIPIENTS: pubs.join(' ') });
  const t = await query(ref, "select (select count(*) from pg_proc where proname like 'dlm_runner_%')::int as rpcs, (select count(*) from vault.secrets where name = 'dlm_backup_trigger')::int as trigger_secret, (select string_agg(extname, ',' order by extname) from pg_extension where extname in ('pg_cron','pg_net')) as ext");
  console.log(JSON.stringify({ runner_database: t[0], runner_secrets_set: 3 }));
}

function deploy(ref) {
  // bundled by the Supabase CLI with the function's deno.json + deno.lock; verify_jwt from backup-runner/supabase/config.toml
  execFileSync(process.env.SUPABASE_CLI ?? 'supabase', ['functions', 'deploy', 'dlm-backup', '--project-ref', ref, '--no-verify-jwt'],
    { cwd: path.join(ROOT, 'backup-runner'), stdio: 'inherit', env: { ...process.env, SUPABASE_ACCESS_TOKEN: PLACEHOLDER_PAT } });
}

async function prodMigration() {
  const f = path.join(ROOT, 'supabase/migrations-pending/20261115090000_backup_read_access.sql');
  const present = await query(PROD_REF, "select to_regclass('dlm_backup.runner_tokens') is not null as present");
  if (present[0].present) { console.log(JSON.stringify({ production_migration: 'already applied' })); return; }
  // as postgres, in one transaction (the pre-check aborts everything if Storage lacks the helper).
  // Not recorded in the CLI migration history: the file stays in migrations-pending (removal: REMOVE_backup_read_access.sql).
  await query(PROD_REF, `begin;\nset local role postgres;\n${fs.readFileSync(f, 'utf8')}\ncommit;`);
  const v = await query(PROD_REF, `select pg_get_userbyid(p.proowner) as snapshot_owner, (select rolcanlogin from pg_roles where rolname='dlm_backup_reader') as reader_can_login,
    (select count(*) from pg_policies where policyname='dlm_backup_runner_download')::int as download_policy,
    (select count(*) from pg_extension where extname='pg_net')::int as pg_net,
    has_function_privilege('service_role','public.dlm_backup_runner_snapshot()','EXECUTE') as service_role_can_snapshot,
    (select string_agg(distinct pg_get_userbyid(proowner), ',') from pg_proc where proname in ('dlm_backup_runner_snapshot','dlm_backup_runner_objects','token_valid','register_token')) as other_owners,
    pg_has_role('postgres','dlm_backup_reader','SET') as postgres_can_set_role
    from pg_proc p where p.proname = 'dlm_backup_snapshot'`);
  console.log(JSON.stringify({ production_migration: 'applied', checks: v[0] }));
}

async function token(ref) {
  await check(ref);
  const tok = `dlmbk1_${crypto.randomBytes(32).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(tok).digest('hex');
  await setSecrets(ref, { DLM_PROD_BACKUP_TOKEN: tok });                       // runner gets the token
  const label = `runner ${new Date().toISOString().slice(0, 10)}`;
  const id = await query(PROD_REF, `select dlm_backup.register_token('${hash}', '${label}') as id`);   // production gets the hash
  const st = await query(PROD_REF, 'select label, hash_prefix, expires_at::date as expires, active from dlm_backup.token_status order by created_at');
  console.log(JSON.stringify({ token_registered: id[0].id, production_tokens: st }));
}

async function schedule(ref) {
  await check(ref);
  const url = `https://${ref}.supabase.co/functions/v1/dlm-backup`;
  await query(ref, `select vault.create_secret('${url}', 'dlm_backup_function_url', 'dlm-backup function URL') where not exists (select 1 from vault.secrets where name = 'dlm_backup_function_url');
                    select vault.update_secret(id, '${url}') from vault.secrets where name = 'dlm_backup_function_url';`);
  const have = await query(ref, "select count(*)::int as n from cron.job where jobname like 'dlm-backup-%'");
  if (have[0].n === 0) await query(ref, `begin;\nset local role postgres;\n${fs.readFileSync(path.join(ROOT, 'backup-runner/supabase/schedule.sql'), 'utf8')}\ncommit;`);
  console.log(JSON.stringify({ jobs: await query(ref, "select jobname, schedule, active from cron.job where jobname like 'dlm-backup-%' order by jobname") }));
}

async function invoke(ref, mode) {
  if (!['selftest', 'backup', 'continue', 'verify'].includes(mode)) die('mode: selftest | backup | continue | verify');
  await check(ref);
  await query(ref, `select dlm_runner.invoke('${mode}')`);
  console.log(JSON.stringify({ invoked: mode }));
}

async function status(ref, n = 5) {
  if (!refOk(ref)) die('runner ref');
  const rows = await query(ref, `select mode, status, phase, steps, failures, started_at, finished_at, error, files_total, files_uploaded, bytes_uploaded,
      manifest->'selftest' as selftest, manifest->>'storage_objects' as storage_objects, manifest->>'files_copied' as files_copied,
      manifest->>'files_gone' as files_gone, (manifest->'db'->>'plain_bytes')::bigint as snapshot_bytes, run_prefix
    from dlm_runner.runs order by started_at desc limit ${Math.max(1, Math.min(Number(n) || 5, 50))}`);
  console.log(JSON.stringify(rows, null, 1));
}

const cmds = { check: () => check(args[0]), 'b2-setup': () => b2Setup(args[0]), 'runner-setup': () => runnerSetup(args[0], args.slice(1).join(' ')),
  deploy: () => deploy(args[0]), 'prod-migration': () => prodMigration(), token: () => token(args[0]), schedule: () => schedule(args[0]),
  invoke: () => invoke(args[0], args[1]), status: () => status(args[0], args[1]) };
if (!cmds[cmd]) die(`commands: ${Object.keys(cmds).join(', ')}`);
await cmds[cmd]();
