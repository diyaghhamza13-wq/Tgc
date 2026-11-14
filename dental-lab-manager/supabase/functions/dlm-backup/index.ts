// dlm-backup — automated, encrypted, off-site backup (docs/backup/AUTOMATED-BACKUP-DESIGN.md).
//
// Triggered by pg_cron (pg_net POST) with the secret header x-dlm-backup-trigger.
// Deployed with verify_jwt = false: the trigger secret (checked in the database
// against Vault) is the only way in.
//
// Credentials it uses — and only these:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (provided by Supabase) — ONLY to call
//     the dlm_backup_* RPCs and to download stored files from Storage.
//   DLM_BACKUP_AGE_RECIPIENTS   public key(s) age1… (not secret)
//   DLM_BACKUP_S3_ENDPOINT / _REGION / _BUCKET
//   DLM_BACKUP_S3_WRITE_KEY_ID / _WRITE_SECRET   write-only key (put objects only)
//   DLM_BACKUP_S3_READ_KEY_ID / _READ_SECRET     optional, verify mode only (get/head)
// It never reads SUPABASE_DB_URL (the postgres password) and never connects to
// Postgres directly. It never logs file names, row data or credentials.
import * as age from "age-encryption";
import { AwsClient } from "aws4fetch";
import { createHash } from "node:crypto";

const env = (n: string) => Deno.env.get(n) ?? "";
const enc = new TextEncoder();

type Cfg = {
  url: string; srk: string; recipients: string[];
  endpoint: string; region: string; bucket: string;
  writeId: string; writeSecret: string; readId: string; readSecret: string;
};

function config(): Cfg | null {
  const c: Cfg = {
    url: env("SUPABASE_URL").replace(/\/$/, ""),
    srk: env("SUPABASE_SERVICE_ROLE_KEY"),
    recipients: env("DLM_BACKUP_AGE_RECIPIENTS").split(/[\s,]+/).filter(Boolean),
    endpoint: env("DLM_BACKUP_S3_ENDPOINT").replace(/\/$/, ""),
    region: env("DLM_BACKUP_S3_REGION") || "auto",
    bucket: env("DLM_BACKUP_S3_BUCKET"),
    writeId: env("DLM_BACKUP_S3_WRITE_KEY_ID"), writeSecret: env("DLM_BACKUP_S3_WRITE_SECRET"),
    readId: env("DLM_BACKUP_S3_READ_KEY_ID"), readSecret: env("DLM_BACKUP_S3_READ_SECRET"),
  };
  if (!c.url || !c.srk || !c.endpoint || !c.bucket || !c.writeId || !c.writeSecret) return null;
  if (!c.recipients.length || !c.recipients.every((r) => /^age1[0-9a-z]{58}$/.test(r))) return null;
  let e: URL;
  try { e = new URL(c.endpoint); } catch { return null; }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(e.hostname);
  if (e.protocol !== "https:" && !(loopback && e.protocol === "http:")) return null;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket)) return null;
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

async function rpc(c: Cfg, name: string, args: Record<string, unknown> | null, method: "GET" | "POST" = "POST"): Promise<string> {
  const res = await fetch(`${c.url}/rest/v1/rpc/${name}`, {
    method,
    headers: { apikey: c.srk, Authorization: `Bearer ${c.srk}`, "Content-Type": "application/json", Accept: "application/json" },
    body: method === "POST" ? JSON.stringify(args ?? {}) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let code = "database_error";
    try { const m = JSON.parse(text).message; if (/^[a-z_]{3,60}$/.test(m)) code = m; } catch { /* keep generic */ }
    throw new Code(`${name}:${code}`);
  }
  return text;
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
const objUrl = (c: Cfg, key: string) => `${c.endpoint}/${c.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

/** Upload with a signed payload hash (the provider verifies the body) and no overwrite. */
async function put(c: Cfg, key: string, body: Uint8Array): Promise<{ sha256: string; bytes: number; versionId: string | null }> {
  const hash = await sha256(body);
  const res = await s3(c, "write").fetch(objUrl(c, key), {
    method: "PUT",
    body: body as Uint8Array<ArrayBuffer>,
    headers: { "X-Amz-Content-Sha256": hash, "Content-Type": "application/octet-stream", "If-None-Match": "*" },
  });
  await res.arrayBuffer().catch(() => undefined);
  if (!res.ok) throw new Code(`upload_failed_${res.status}`);
  const etag = (res.headers.get("etag") ?? "").replace(/"/g, "");
  if (/^[0-9a-f]{32}$/.test(etag) && etag !== md5(body)) throw new Code("upload_integrity_mismatch");
  // pin the exact stored version (versioned buckets): later writes cannot replace what we restore
  const v = res.headers.get("x-amz-version-id");
  return { sha256: hash, bytes: body.length, versionId: v && /^[A-Za-z0-9._+=-]{1,200}$/.test(v) ? v : null };
}

async function backup(c: Cfg, runId: string) {
  const prefix = `runs/${stamp()}-${rand(4)}`;
  let uploaded = 0;
  let bytes = 0;

  // 1. database snapshot, read by the NOLOGIN backup role (SECURITY DEFINER, read-only)
  const snapText = await rpc(c, "dlm_backup_snapshot", null, "GET");
  const snap = JSON.parse(snapText);
  if (snap.format !== "dlm-backup-v1" || !Array.isArray(snap.tables_in_snapshot)) throw new Code("bad_snapshot");
  const tables: Record<string, { rows: number; sha256: string }> = {};
  for (const t of snap.tables_in_snapshot) {
    tables[t] = { rows: snap.data[t].length, sha256: await sha256(enc.encode(JSON.stringify(snap.data[t]))) };
  }

  // 2. stored files that are new, changed, or due for re-upload (every 28 days < 35-day lifecycle)
  const todo = JSON.parse(await rpc(c, "dlm_backup_files_todo", { p_reupload_days: 28 }));
  const done = [];
  for (const f of todo) {
    const res = await fetch(`${c.url}/storage/v1/object/${encodeURIComponent(f.bucket)}/${String(f.name).split("/").map(encodeURIComponent).join("/")}`, {
      headers: { apikey: c.srk, Authorization: `Bearer ${c.srk}` },
    });
    if (!res.ok) { await res.arrayBuffer().catch(() => undefined); throw new Code(`file_download_failed_${res.status}`); }
    const plain = new Uint8Array(await res.arrayBuffer());
    const plainSha = await sha256(plain);
    const cipher = await encrypt(c, plain);
    plain.fill(0);
    const key = `files/${f.id}/${stamp()}-${rand(4)}.age`;
    const up = await put(c, key, cipher);
    uploaded++; bytes += up.bytes;
    done.push({ object_id: f.id, version: f.version, sha256: plainSha, cipher_sha256: up.sha256, backup_key: key, version_id: up.versionId });
  }
  if (done.length) await rpc(c, "dlm_backup_files_done", { p_run: runId, p_files: done });

  // 3. encrypted map: every stored file -> its encrypted copy (holds original names)
  const files = JSON.parse(await rpc(c, "dlm_backup_file_map", {}));
  if (files.some((f: { backup_key: string | null }) => !f.backup_key)) throw new Code("file_not_backed_up");
  const mapCipher = await encrypt(c, enc.encode(JSON.stringify({ format: "dlm-filemap-v1", files })));
  const mapUp = await put(c, `${prefix}/files.json.age`, mapCipher);

  // 4. encrypted database snapshot
  const dbCipher = await encrypt(c, enc.encode(snapText));
  const dbUp = await put(c, `${prefix}/db.json.age`, dbCipher);
  bytes += mapUp.bytes + dbUp.bytes; uploaded += 2;

  // 5. plaintext manifest: counts and hashes only (no names, no row data)
  const manifest = {
    format: "dlm-backup-manifest-v1",
    exported_at: snap.exported_at,
    migrations: snap.migrations,
    tables,
    storage_objects: files.length,
    db: { key: `${prefix}/db.json.age`, cipher_sha256: dbUp.sha256, bytes: dbUp.bytes, version_id: dbUp.versionId },
    filemap: { key: `${prefix}/files.json.age`, cipher_sha256: mapUp.sha256, bytes: mapUp.bytes, version_id: mapUp.versionId },
    files_uploaded_this_run: done.length,
    recipients: c.recipients.length,
  };
  const manUp = await put(c, `${prefix}/manifest.json`, enc.encode(JSON.stringify(manifest, null, 2)));
  bytes += manUp.bytes; uploaded++;

  await rpc(c, "dlm_backup_finish", {
    p_run: runId, p_status: "succeeded",
    p_payload: { run_prefix: prefix, manifest, files_uploaded: uploaded, files_total: files.length, bytes_uploaded: bytes },
  });
  console.log(`dlm-backup: run ${runId} succeeded (${uploaded} objects, ${bytes} bytes)`);
}

/** Weekly: re-read recent objects with the READ key and compare SHA-256 (cannot decrypt). */
async function verify(c: Cfg, runId: string) {
  if (!c.readId || !c.readSecret) throw new Code("verify_not_configured");
  const recent = JSON.parse(await rpc(c, "dlm_backup_recent", { p_limit: 7 }));
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
    const res = await s3(c, "read").fetch(url, { method: "GET", headers: { "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
    const body = new Uint8Array(await res.arrayBuffer());
    if (!res.ok || (await sha256(body)) !== ch.sha) { bad++; if (ch.file) damagedFiles.push(ch.key); }
  }
  // damaged file copies are forgotten: the next backup run copies those files again
  if (damagedFiles.length) await rpc(c, "dlm_backup_files_invalidate", { p_run: runId, p_keys: damagedFiles });
  await rpc(c, "dlm_backup_finish", {
    p_run: runId, p_status: bad ? "failed" : "succeeded",
    p_payload: { files_total: checks.length, files_uploaded: 0, bytes_uploaded: 0, error: bad ? `integrity_failed ${bad} of ${checks.length}` : null },
  });
  console.log(`dlm-backup: verify ${runId}: ${checks.length - bad}/${checks.length} intact`);
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const c = config();
  if (!c) return json(500, { error: "not_configured" });
  const secret = req.headers.get("x-dlm-backup-trigger") ?? "";
  let mode = "backup";
  try { const b = await req.json(); if (b?.mode === "verify") mode = "verify"; } catch { /* default */ }
  let runId: string;
  try {
    runId = JSON.parse(await rpc(c, "dlm_backup_begin", { p_secret: secret, p_mode: mode }));
  } catch (e) {
    const code = safe(e);
    return json(code.endsWith("invalid_trigger") ? 401 : code.endsWith("already_running") ? 409 : 500, { error: code.endsWith("invalid_trigger") ? "unauthorized" : code });
  }
  const work = (mode === "verify" ? verify(c, runId) : backup(c, runId)).catch(async (e) => {
    const code = safe(e);
    console.log(`dlm-backup: run ${runId} failed (${code})`);
    await rpc(c, "dlm_backup_finish", { p_run: runId, p_status: "failed", p_payload: { error: code } }).catch(() => undefined);
  });
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) { rt.waitUntil(work); return json(202, { run: runId }); }
  await work;
  return json(200, { run: runId });
});
