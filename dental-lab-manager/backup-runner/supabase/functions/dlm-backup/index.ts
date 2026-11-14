// dlm-backup — automated, encrypted, off-site backup of Dental Lab Manager.
// Runs in the SEPARATE "Backup Runner" Supabase project (EU London), never in the
// production project. See docs/backup/BACKUP-RUNNER.md and SECURITY-REVIEW.md.
//
// Triggered by pg_cron in the runner project (pg_net POST, header
// x-dlm-backup-trigger, header x-region: eu-west-2). Deployed with
// verify_jwt = false: the trigger secret (checked in the runner database
// against Vault) is the only way in.
//
// Credentials:
//   Runner project (its own, injected by Supabase):
//     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — ONLY for the dlm_runner_* RPCs
//     (run log + file bookkeeping in the runner database).
//   Production (read-only):
//     DLM_PROD_URL            https://<production-ref>.supabase.co
//     DLM_PROD_ANON_KEY       production's PUBLIC anon / publishable key
//                             (refused if it is a service-role or secret key)
//     DLM_PROD_BACKUP_TOKEN   dlmbk1_<64 hex>; production stores only its SHA-256
//   Off-site storage:
//     DLM_BACKUP_AGE_RECIPIENTS   public key(s) age1… (not secret)
//     DLM_BACKUP_S3_ENDPOINT / _REGION / _BUCKET
//     DLM_BACKUP_S3_WRITE_KEY_ID / _WRITE_SECRET   write-only key (put objects only)
//     DLM_BACKUP_S3_READ_KEY_ID / _READ_SECRET     optional, verify mode only (get/head)
// Production is only ever sent GET requests carrying the anon key and the token.
// The function never logs file names, row data or credentials.
import * as age from "age-encryption";
import { AwsClient } from "aws4fetch";
import { createHash } from "node:crypto";

const REQUIRED_REGION = "eu-west-2"; // London
const env = (n: string) => Deno.env.get(n) ?? "";
const enc = new TextEncoder();

type Cfg = {
  url: string; srk: string;
  prodUrl: string; prodAnon: string; token: string;
  recipients: string[];
  endpoint: string; region: string; bucket: string;
  writeId: string; writeSecret: string; readId: string; readSecret: string;
};

const isLoopback = (u: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
const httpsOrLoopback = (s: string): URL | null => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || (u.protocol === "http:" && isLoopback(u)) ? u : null;
  } catch { return null; }
};

/** Production key must be the PUBLIC anon/publishable key: never a service-role or secret key. */
function isAnonKey(k: string): boolean {
  if (k.startsWith("sb_publishable_")) return /^sb_publishable_[A-Za-z0-9_-]{10,200}$/.test(k);
  if (k.startsWith("sb_")) return false; // sb_secret_… and anything else
  const parts = k.split(".");
  if (parts.length !== 3) return false;
  try {
    const p = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
    return p?.role === "anon";
  } catch { return false; }
}

/** Returns the configuration, or a short reason code (no values). */
function config(): Cfg | string {
  const c: Cfg = {
    url: env("SUPABASE_URL").replace(/\/$/, ""),
    srk: env("SUPABASE_SERVICE_ROLE_KEY"),
    prodUrl: env("DLM_PROD_URL").replace(/\/$/, ""),
    prodAnon: env("DLM_PROD_ANON_KEY"),
    token: env("DLM_PROD_BACKUP_TOKEN"),
    recipients: env("DLM_BACKUP_AGE_RECIPIENTS").split(/[\s,]+/).filter(Boolean),
    endpoint: env("DLM_BACKUP_S3_ENDPOINT").replace(/\/$/, ""),
    region: env("DLM_BACKUP_S3_REGION") || "auto",
    bucket: env("DLM_BACKUP_S3_BUCKET"),
    writeId: env("DLM_BACKUP_S3_WRITE_KEY_ID"), writeSecret: env("DLM_BACKUP_S3_WRITE_SECRET"),
    readId: env("DLM_BACKUP_S3_READ_KEY_ID"), readSecret: env("DLM_BACKUP_S3_READ_SECRET"),
  };
  const prod = httpsOrLoopback(c.prodUrl);
  const runner = httpsOrLoopback(c.url);
  if (!prod || !runner) return "bad_url";
  // Never run inside the production project (its environment holds production's service key).
  if (prod.origin === runner.origin) return "runner_is_production";
  // London only. Hosted Supabase always sets SB_REGION; it is absent only in local tests,
  // which also use a loopback production URL (impossible when hosted).
  const sbRegion = env("SB_REGION");
  if (sbRegion ? sbRegion !== REQUIRED_REGION : !isLoopback(prod)) return "wrong_region";
  if (!isAnonKey(c.prodAnon)) return "prod_key_not_anon";
  if (!/^dlmbk1_[0-9a-f]{64}$/.test(c.token)) return "bad_token_format";
  if (!c.recipients.length || !c.recipients.every((r) => /^age1[0-9a-z]{58}$/.test(r))) return "bad_recipients";
  const e = httpsOrLoopback(c.endpoint);
  if (!e || !c.writeId || !c.writeSecret) return "bad_storage";
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket)) return "bad_bucket";
  return c;
}

/** Error text safe to store/log: our own codes only, never upstream text (may contain names). */
class Code extends Error {}
const safe = (e: unknown) => (e instanceof Code ? e.message : "internal_error");

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (b: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
const rand = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)).buffer);
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const path = (s: string) => s.split("/").map(encodeURIComponent).join("/");

/** Runner project's own bookkeeping RPCs (its own service key; never sent to production). */
async function rpc(c: { url: string; srk: string }, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${c.url}/rest/v1/rpc/${name}`, {
    method: "POST", redirect: "error",
    headers: { apikey: c.srk, Authorization: `Bearer ${c.srk}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    let code = "database_error";
    try { const m = JSON.parse(text).message; if (/^[a-z_]{3,60}$/.test(m)) code = m; } catch { /* keep generic */ }
    throw new Code(`${name}:${code}`);
  }
  return text;
}

/** Production: GET only, public anon key + backup token, no redirects (the token never leaves production's origin). */
async function prodGet(c: Cfg, p: string): Promise<Response> {
  const res = await fetch(`${c.prodUrl}${p}`, {
    method: "GET", redirect: "error",
    headers: { apikey: c.prodAnon, Authorization: `Bearer ${c.prodAnon}`, "x-dlm-backup-token": c.token, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) { await res.arrayBuffer().catch(() => undefined); throw new Code("production_access_denied"); }
  return res;
}

async function encrypt(c: Cfg, plain: Uint8Array): Promise<Uint8Array> {
  const e = new age.Encrypter();
  for (const r of c.recipients) e.addRecipient(r);
  return await e.encrypt(plain);
}

function s3(c: Cfg, which: "write" | "read") {
  const [id, secret] = which === "write" ? [c.writeId, c.writeSecret] : [c.readId, c.readSecret];
  return new AwsClient({ accessKeyId: id, secretAccessKey: secret, service: "s3", region: c.region });
}
const objUrl = (c: Cfg, key: string) => `${c.endpoint}/${c.bucket}/${path(key)}`;

/** Upload with a signed payload hash (the provider verifies the body) and no overwrite. */
async function put(c: Cfg, key: string, body: Uint8Array): Promise<{ sha256: string; bytes: number; versionId: string | null }> {
  const hash = await sha256(body);
  const res = await s3(c, "write").fetch(objUrl(c, key), {
    method: "PUT", redirect: "error",
    body: body as Uint8Array<ArrayBuffer>,
    headers: { "X-Amz-Content-Sha256": hash, "Content-Type": "application/octet-stream", "If-None-Match": "*" },
  });
  await res.arrayBuffer().catch(() => undefined);
  if (!res.ok) throw new Code(`upload_failed_${res.status}`);
  const etag = (res.headers.get("etag") ?? "").replace(/"/g, "");
  if (/^[0-9a-f]{32}$/.test(etag) && etag !== md5(body)) throw new Code("upload_integrity_mismatch");
  const v = res.headers.get("x-amz-version-id");
  return { sha256: hash, bytes: body.length, versionId: v && /^[A-Za-z0-9._+=-]{1,200}$/.test(v) ? v : null };
}

type Obj = { id: string; bucket: string; name: string; size: number | null; mimetype: string | null; version: string };

async function backup(c: Cfg, runId: string) {
  const prefix = `runs/${stamp()}-${rand(4)}`;
  let uploaded = 0;
  let bytes = 0;

  // 1. database snapshot: read-only, token-checked, read by production's NOLOGIN backup role
  const snapRes = await prodGet(c, "/rest/v1/rpc/dlm_backup_runner_snapshot");
  const snapText = await snapRes.text();
  if (!snapRes.ok) throw new Code(`snapshot_failed_${snapRes.status}`);
  const snap = JSON.parse(snapText);
  if (snap.format !== "dlm-backup-v1" || !Array.isArray(snap.tables_in_snapshot) || !Array.isArray(snap.storage_objects)) throw new Code("bad_snapshot");
  const tables: Record<string, { rows: number; sha256: string }> = {};
  for (const t of snap.tables_in_snapshot) {
    tables[t] = { rows: snap.data[t].length, sha256: await sha256(enc.encode(JSON.stringify(snap.data[t]))) };
  }

  // 2. stored files (every bucket) listed in the SAME snapshot; only ids + versions go to the runner database
  // deno-lint-ignore no-explicit-any
  const objects: Obj[] = snap.storage_objects.map((o: any) => ({
    id: o.id, bucket: o.bucket, name: o.name, size: o.size == null ? null : Number(o.size), mimetype: o.mimetype ?? null,
    version: o.updated_at ?? o.created_at,
  }));
  const ids = objects.map((o) => ({ id: o.id, version: o.version }));
  const byId = new Map(objects.map((o) => [o.id, o]));
  const todo: string[] = JSON.parse(await rpc(c, "dlm_runner_files_todo", { p_objects: ids, p_reupload_days: 28 }));
  const done = [];
  for (const id of todo) {
    const o = byId.get(id);
    if (!o) throw new Code("bad_todo");
    const res = await prodGet(c, `/storage/v1/object/authenticated/${encodeURIComponent(o.bucket)}/${path(o.name)}`);
    if (!res.ok) { await res.arrayBuffer().catch(() => undefined); throw new Code(`file_download_failed_${res.status}`); }
    const plain = new Uint8Array(await res.arrayBuffer());
    const plainSha = await sha256(plain);
    const cipher = await encrypt(c, plain);
    plain.fill(0);
    const key = `files/${o.id}/${stamp()}-${rand(4)}.age`;
    const up = await put(c, key, cipher);
    uploaded++; bytes += up.bytes;
    done.push({ object_id: o.id, version: o.version, sha256: plainSha, cipher_sha256: up.sha256, backup_key: key, version_id: up.versionId });
  }
  if (done.length) await rpc(c, "dlm_runner_files_done", { p_run: runId, p_files: done });

  // 3. encrypted map: every stored file -> its encrypted copy (holds original names; names never reach the runner DB)
  const copies: { id: string; sha256: string | null; cipher_sha256: string | null; backup_key: string | null; version_id: string | null }[] =
    JSON.parse(await rpc(c, "dlm_runner_file_map", { p_objects: ids }));
  if (copies.length !== objects.length || copies.some((f) => !f.backup_key)) throw new Code("file_not_backed_up");
  const files = copies.map((f) => {
    const o = byId.get(f.id)!;
    return { id: o.id, bucket: o.bucket, name: o.name, size: o.size, mimetype: o.mimetype, version: o.version,
             sha256: f.sha256, cipher_sha256: f.cipher_sha256, backup_key: f.backup_key, version_id: f.version_id };
  });
  const mapCipher = await encrypt(c, enc.encode(JSON.stringify({ format: "dlm-filemap-v1", files })));
  const mapUp = await put(c, `${prefix}/files.json.age`, mapCipher);

  // 4. encrypted database snapshot
  const dbCipher = await encrypt(c, enc.encode(snapText));
  const dbUp = await put(c, `${prefix}/db.json.age`, dbCipher);
  bytes += mapUp.bytes + dbUp.bytes; uploaded += 2;

  // 5. plaintext manifest: counts, hashes and the PUBLIC keys used (no names, no row data)
  const manifest = {
    format: "dlm-backup-manifest-v1",
    exported_at: snap.exported_at,
    migrations: snap.migrations,
    tables,
    storage_objects: files.length,
    db: { key: `${prefix}/db.json.age`, cipher_sha256: dbUp.sha256, bytes: dbUp.bytes, version_id: dbUp.versionId },
    filemap: { key: `${prefix}/files.json.age`, cipher_sha256: mapUp.sha256, bytes: mapUp.bytes, version_id: mapUp.versionId },
    files_uploaded_this_run: done.length,
    recipients: c.recipients,
  };
  const manUp = await put(c, `${prefix}/manifest.json`, enc.encode(JSON.stringify(manifest, null, 2)));
  bytes += manUp.bytes; uploaded++;

  await rpc(c, "dlm_runner_finish", {
    p_run: runId, p_status: "succeeded",
    p_payload: { run_prefix: prefix, manifest, files_uploaded: uploaded, files_total: files.length, bytes_uploaded: bytes },
  });
  console.log(`dlm-backup: run ${runId} succeeded (${uploaded} objects, ${bytes} bytes)`);
}

/** Weekly: re-read recent objects (pinned versions) with the READ key and compare SHA-256 (cannot decrypt). */
async function verify(c: Cfg, runId: string) {
  if (!c.readId || !c.readSecret) throw new Code("verify_not_configured");
  const recent = JSON.parse(await rpc(c, "dlm_runner_recent", { p_limit: 7 }));
  const checks: { key: string; sha: string; version: string | null; file: boolean }[] = [];
  for (const r of recent.runs) {
    checks.push({ key: r.manifest.db.key, sha: r.manifest.db.cipher_sha256, version: r.manifest.db.version_id ?? null, file: false });
    checks.push({ key: r.manifest.filemap.key, sha: r.manifest.filemap.cipher_sha256, version: r.manifest.filemap.version_id ?? null, file: false });
  }
  for (const f of recent.files) checks.push({ key: f.backup_key, sha: f.cipher_sha256, version: f.version_id ?? null, file: true });
  let bad = 0;
  const damagedFiles: string[] = [];
  for (const ch of checks) {
    const url = objUrl(c, ch.key) + (ch.version ? `?versionId=${encodeURIComponent(ch.version)}` : "");
    const res = await s3(c, "read").fetch(url, { method: "GET", redirect: "error", headers: { "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
    const body = new Uint8Array(await res.arrayBuffer());
    if (!res.ok || (await sha256(body)) !== ch.sha) { bad++; if (ch.file) damagedFiles.push(ch.key); }
  }
  // damaged file copies are forgotten: the next backup run copies those files again
  if (damagedFiles.length) await rpc(c, "dlm_runner_files_invalidate", { p_run: runId, p_keys: damagedFiles });
  await rpc(c, "dlm_runner_finish", {
    p_run: runId, p_status: bad ? "failed" : "succeeded",
    p_payload: { files_total: checks.length, files_uploaded: 0, bytes_uploaded: 0, error: bad ? `integrity_failed ${bad} of ${checks.length}` : null },
  });
  console.log(`dlm-backup: verify ${runId}: ${checks.length - bad}/${checks.length} intact`);
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  // Configuration (runner vs production, region, production key type, endpoints) is checked
  // BEFORE any network request: a misconfigured runner contacts nothing at all.
  const c = config();
  if (typeof c === "string") {
    console.log(`dlm-backup: refused to run (not_configured: ${c})`);
    return json(500, { error: "not_configured", reason: c });
  }
  const secret = req.headers.get("x-dlm-backup-trigger") ?? "";
  let mode = "backup";
  try { const b = await req.json(); if (b?.mode === "verify") mode = "verify"; } catch { /* default */ }
  let runId: string;
  try {
    runId = JSON.parse(await rpc(c, "dlm_runner_begin", { p_secret: secret, p_mode: mode }));
  } catch (e) {
    const code = safe(e);
    return json(code.endsWith("invalid_trigger") ? 401 : code.endsWith("already_running") ? 409 : 500, { error: code.endsWith("invalid_trigger") ? "unauthorized" : code });
  }
  const work = (mode === "verify" ? verify(c, runId) : backup(c, runId)).catch(async (e) => {
    const code = safe(e);
    console.log(`dlm-backup: run ${runId} failed (${code})`);
    await rpc(c, "dlm_runner_finish", { p_run: runId, p_status: "failed", p_payload: { error: code } }).catch(() => undefined);
  });
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) { rt.waitUntil(work); return json(202, { run: runId }); }
  await work;
  return json(200, { run: runId });
});
