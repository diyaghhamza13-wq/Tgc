// dlm-backup — automated, encrypted, off-site backup of Dental Lab Manager.
// Runs in the SEPARATE "Backup Runner" Supabase project (EU London), never in the
// production project. See docs/backup/BACKUP-RUNNER.md and SECURITY-REVIEW.md.
//
// Triggered by pg_cron in the runner project (pg_net POST, header
// x-dlm-backup-trigger, header x-region: eu-west-2). Deployed with
// verify_jwt = false: the trigger secret (checked in the runner database
// against Vault) is the only way in.
//
// Works in BOUNDED STEPS so that every invocation stays far inside the hosted Edge
// Function limits (2 s CPU, 256 MB memory): "backup" starts a run, "continue"
// (every 3 minutes) resumes it, "verify" starts the weekly check. One step does
// the snapshot, or at most ~32 MB of stored files in 16 MB encrypted segments
// (large files are read with HTTP range requests), or ~128 MB of re-reads.
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
async function prodGet(c: Cfg, p: string, extra: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(`${c.prodUrl}${p}`, {
    method: "GET", redirect: "error",
    headers: { ...extra, apikey: c.prodAnon, Authorization: `Bearer ${c.prodAnon}`, "x-dlm-backup-token": c.token, Accept: "application/json" },
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

/** Upload with a signed payload hash (the provider verifies the body). Every key is unique
 *  (timestamp + random suffix), so nothing is overwritten. If-None-Match is NOT sent:
 *  Backblaze B2 does not document conditional writes. Protection against a later rogue
 *  write does not depend on it: versioning + compliance lock keep the original, and
 *  restore reads the FIRST version of every key. */
async function put(c: Cfg, key: string, body: Uint8Array): Promise<{ sha256: string; bytes: number; versionId: string | null }> {
  const hash = await sha256(body);
  const res = await s3(c, "write").fetch(objUrl(c, key), {
    method: "PUT", redirect: "error",
    body: body as Uint8Array<ArrayBuffer>,
    headers: { "X-Amz-Content-Sha256": hash, "Content-Type": "application/octet-stream" },
  });
  await res.arrayBuffer().catch(() => undefined);
  if (!res.ok) throw new Code(`upload_failed_${res.status}`);
  const etag = (res.headers.get("etag") ?? "").replace(/"/g, "");
  if (/^[0-9a-f]{32}$/.test(etag) && etag !== md5(body)) throw new Code("upload_integrity_mismatch");
  const v = res.headers.get("x-amz-version-id");
  return { sha256: hash, bytes: body.length, versionId: v && /^[A-Za-z0-9._+=-]{1,200}$/.test(v) ? v : null };
}

const MB = 1048576;
const SEGMENT = 16 * MB;               // plaintext per encrypted segment
const STEP_BUDGET = 32 * MB;           // plaintext processed per step (≈0.5 s CPU)
const VERIFY_BUDGET = 128 * MB;        // ciphertext re-read per verify step (hashing only)
const MAX_SNAPSHOT = 20 * MB;          // larger snapshots are refused cleanly (≈170 MB peak at 20 MB; alert from 15 MB)
const FATAL = new Set(["production_access_denied", "snapshot_too_large", "bad_snapshot", "verify_not_configured"]);

type Begin = { action: "idle" } | { action: "work"; run: string; mode: "backup" | "verify" | "selftest"; phase: string | null; run_prefix: string | null };
type Seg = { seq: number; backup_key: string; plain_sha256: string; cipher_sha256: string; bytes: number; version_id: string | null };

/** Reads a response body up to max bytes (refuses larger bodies without buffering them). */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body!.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { await reader.cancel(); throw new Code("snapshot_too_large"); }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Step 1 of a run: database snapshot + encrypted object list (names) → off-site. */
async function snapshotStep(c: Cfg, run: string): Promise<{ prefix: string; bytes: number }> {
  const res = await prodGet(c, "/rest/v1/rpc/dlm_backup_runner_snapshot");
  if (!res.ok) { await res.arrayBuffer().catch(() => undefined); throw new Code(`snapshot_failed_${res.status}`); }
  const plain = await readCapped(res, MAX_SNAPSHOT);
  let meta: { exported_at: string; migrations: unknown; tables: Record<string, { rows: number }>; objects: Record<string, unknown>[] };
  {
    const snap = JSON.parse(new TextDecoder().decode(plain));
    if (snap.format !== "dlm-backup-v1" || !Array.isArray(snap.tables_in_snapshot) || !Array.isArray(snap.storage_objects)) throw new Code("bad_snapshot");
    const tables: Record<string, { rows: number }> = {};
    for (const t of snap.tables_in_snapshot) tables[t] = { rows: snap.data[t].length };
    meta = { exported_at: snap.exported_at, migrations: snap.migrations, tables, objects: snap.storage_objects };
  } // the parsed snapshot is released here, before encryption
  const prefix = `runs/${stamp()}-${rand(4)}`;
  // deno-lint-ignore no-explicit-any
  const objects = meta.objects.map((o: any) => ({
    id: String(o.id), bucket: String(o.bucket), name: String(o.name), size: o.size == null ? 0 : Number(o.size),
    mimetype: o.mimetype ?? null, version: String(o.updated_at ?? o.created_at),
  }));
  const objUp = await put(c, `${prefix}/objects.json.age`, await encrypt(c, enc.encode(JSON.stringify({ format: "dlm-objects-v1", objects }))));
  const plainSha = await sha256(plain);
  const dbCipher = await encrypt(c, plain);
  const plainBytes = plain.length;
  plain.fill(0);
  const dbUp = await put(c, `${prefix}/db.json.age`, dbCipher);
  const manifest = {
    format: "dlm-backup-manifest-v2",
    exported_at: meta.exported_at,
    migrations: meta.migrations,
    tables: meta.tables,
    storage_objects: objects.length,
    db: { key: `${prefix}/db.json.age`, cipher_sha256: dbUp.sha256, plain_sha256: plainSha, plain_bytes: plainBytes, bytes: dbUp.bytes, version_id: dbUp.versionId },
    objects: { key: `${prefix}/objects.json.age`, cipher_sha256: objUp.sha256, bytes: objUp.bytes, version_id: objUp.versionId },
    recipients: c.recipients,
  };
  await rpc(c, "dlm_runner_snapshot_done", { p_run: run, p_prefix: prefix, p_manifest: manifest, p_objects: objects.map((o) => ({ id: o.id, version: o.version, size: o.size })) });
  return { prefix, bytes: plainBytes };
}

/** Step 2..n: copy stored files (16 MB encrypted segments) until the step budget is used. */
async function filesStep(c: Cfg, run: string, budget: number): Promise<{ done: boolean; segments: number; bytes: number }> {
  const todo: { id: string; version: string; size: number; progress_version: string | null; next_seq: number }[] =
    JSON.parse(await rpc(c, "dlm_runner_todo", { p_run: run, p_reupload_days: 28 }));
  if (!todo.length) return { done: true, segments: 0, bytes: 0 };
  const listRes = await prodGet(c, "/rest/v1/rpc/dlm_backup_runner_objects");
  if (!listRes.ok) { await listRes.arrayBuffer().catch(() => undefined); throw new Code(`object_list_failed_${listRes.status}`); }
  const current = new Map<string, { bucket: string; name: string; size: string | null; version: string }>(
    // deno-lint-ignore no-explicit-any
    (await listRes.json()).map((o: any) => [o.id, o]));
  let segments = 0;
  let bytes = 0;
  for (const t of todo) {
    const o = current.get(t.id);
    if (!o) { await rpc(c, "dlm_runner_object_gone", { p_run: run, p_object: t.id }); continue; }
    const size = Number(o.size ?? 0);
    const total = Math.max(1, Math.ceil(size / SEGMENT));
    // resume an unfinished copy only if the file has not changed since
    let seq = t.progress_version && Date.parse(t.progress_version) === Date.parse(o.version) ? t.next_seq : 0;
    for (; seq < total; seq++) {
      const from = seq * SEGMENT;
      const to = Math.min(size, from + SEGMENT) - 1;
      const res = await prodGet(c, `/storage/v1/object/authenticated/${encodeURIComponent(o.bucket)}/${path(o.name)}`,
        total > 1 ? { Range: `bytes=${from}-${to}` } : {});
      if (res.status === 400 || res.status === 404) {
        // Storage answers "not found" both for a deleted file and for a refused (e.g. just revoked)
        // token: only a file missing from the token-checked list is recorded as gone.
        await res.arrayBuffer().catch(() => undefined);
        const again = await prodGet(c, "/rest/v1/rpc/dlm_backup_runner_objects");
        if (!again.ok) { await again.arrayBuffer().catch(() => undefined); throw new Code(`object_list_failed_${again.status}`); }
        // deno-lint-ignore no-explicit-any
        if ((await again.json()).some((x: any) => x.id === t.id)) throw new Code(`file_download_failed_${res.status}`);
        await rpc(c, "dlm_runner_object_gone", { p_run: run, p_object: t.id });
        break;
      }
      if (!res.ok) { await res.arrayBuffer().catch(() => undefined); throw new Code(`file_download_failed_${res.status}`); }
      const plain = new Uint8Array(await res.arrayBuffer());
      if (plain.length !== (size === 0 ? 0 : to - from + 1)) throw new Code("file_changed_during_copy");
      const plainSha = await sha256(plain);
      const cipher = await encrypt(c, plain);
      plain.fill(0);
      const key = `files/${t.id}/${stamp()}-${rand(4)}.${String(seq).padStart(4, "0")}.age`;
      const up = await put(c, key, cipher);
      const seg: Seg = { seq, backup_key: key, plain_sha256: plainSha, cipher_sha256: up.sha256, bytes: to - from + 1, version_id: up.versionId };
      await rpc(c, "dlm_runner_segment_done", { p_run: run, p_object: t.id, p_version: o.version, p_size: size, p_segments: total, p_seg: seg });
      segments++; bytes += seg.bytes;
      if (bytes >= budget) return { done: false, segments, bytes };
    }
  }
  const left = JSON.parse(await rpc(c, "dlm_runner_todo", { p_run: run, p_reupload_days: 28 }));
  return { done: left.length === 0, segments, bytes };
}

/** Last step: encrypted file map (ids → segments; names are in objects.json.age) + plaintext manifest. */
async function finalize(c: Cfg, run: string, prefix: string) {
  const fm = JSON.parse(await rpc(c, "dlm_runner_file_map", { p_run: run }));
  // deno-lint-ignore no-explicit-any
  const files: any[] = fm.files;
  if (files.some((f) => f.state === "pending" || (f.state === "done" && !f.segments.length))) throw new Code("file_not_backed_up");
  const mapUp = await put(c, `${prefix}/files.json.age`, await encrypt(c, enc.encode(JSON.stringify({ format: "dlm-filemap-v2", files }))));
  const manifest = {
    ...fm.manifest,
    filemap: { key: `${prefix}/files.json.age`, cipher_sha256: mapUp.sha256, bytes: mapUp.bytes, version_id: mapUp.versionId },
    files_copied: files.filter((f) => f.state === "done").length,
    files_gone: files.filter((f) => f.state === "gone").length,
    files_uploaded_this_run: files.filter((f) => f.copied_in_this_run).length,
  };
  const manUp = await put(c, `${prefix}/manifest.json`, enc.encode(JSON.stringify(manifest, null, 2)));
  await rpc(c, "dlm_runner_finish", { p_run: run, p_status: "succeeded", p_payload: { manifest } });
  console.log(`dlm-backup: run ${run} succeeded (${files.length} stored files, manifest ${manUp.bytes} bytes)`);
}

async function backupStep(c: Cfg, b: Extract<Begin, { action: "work" }>) {
  let budget = STEP_BUDGET;
  let prefix = b.run_prefix;
  let segments = 0;
  let bytes = 0;
  if (b.phase === "snapshot") {
    const s = await snapshotStep(c, b.run);
    prefix = s.prefix; budget -= s.bytes; segments += 2; bytes += s.bytes;
  }
  if (budget > 0) {
    const f = await filesStep(c, b.run, budget);
    segments += f.segments; bytes += f.bytes;
    if (f.done) { await finalize(c, b.run, prefix!); return; }
  }
  await rpc(c, "dlm_runner_release", { p_run: b.run, p_segments: segments, p_bytes: bytes });
}

/** Weekly check, in steps: re-read recent runs' objects and every stored segment (pinned versions) with
 *  the READ key and compare SHA-256 (cannot decrypt). Damaged copies are forgotten → copied again. */
async function verifyStep(c: Cfg, run: string) {
  if (!c.readId || !c.readSecret) throw new Code("verify_not_configured");
  let used = 0;
  for (;;) {
    const todo = JSON.parse(await rpc(c, "dlm_runner_verify_todo", { p_run: run, p_limit: 200 }));
    if (!todo.runs.length && !todo.segments.length) {
      const bad = todo.bad, checked = todo.checked;
      await rpc(c, "dlm_runner_finish", { p_run: run, p_status: bad ? "failed" : "succeeded", p_payload: { error: bad ? `integrity_failed ${bad} of ${checked}` : null } });
      console.log(`dlm-backup: verify ${run}: ${checked - bad}/${checked} intact`);
      return;
    }
    const ok: string[] = [], badKeys: string[] = [], badObjects: string[] = [];
    const check = async (key: string, sha: string, version: string | null) => {
      const url = objUrl(c, key) + (version ? `?versionId=${encodeURIComponent(version)}` : "");
      const res = await s3(c, "read").fetch(url, { method: "GET", redirect: "error", headers: { "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
      const body = new Uint8Array(await res.arrayBuffer());
      used += body.length;
      return res.ok && (await sha256(body)) === sha;
    };
    // deno-lint-ignore no-explicit-any
    for (const objs of todo.runs as any[][]) for (const o of objs) if (o) (await check(o.key, o.cipher_sha256, o.version_id ?? null)) ? ok.push(o.key) : badKeys.push(o.key);
    for (const s of todo.segments) {
      if (await check(s.key, s.cipher_sha256, s.version_id ?? null)) ok.push(s.key); else { badKeys.push(s.key); badObjects.push(s.object_id); }
      if (used >= VERIFY_BUDGET) break;
    }
    await rpc(c, "dlm_runner_verified", { p_run: run, p_runs_checked: todo.runs.length > 0, p_ok: ok, p_bad_keys: badKeys, p_bad_objects: [...new Set(badObjects)] });
    if (used >= VERIFY_BUDGET) { await rpc(c, "dlm_runner_release", { p_run: run, p_segments: 0, p_bytes: 0 }); return; }
  }
}

/** Activation acceptance test (mode "selftest"): checks, against the REAL bucket and production,
 *  every property the security design relies on, and records pass/fail per check (no names, no data).
 *  Production is only read (GET). The test object (1 KiB of random bytes) stays locked like any backup. */
async function selftest(c: Cfg, run: string) {
  const r: Record<string, boolean> = {};
  const t = async (name: string, f: () => Promise<boolean>) => { try { r[name] = await f(); } catch { r[name] = false; } };
  const s3req = (which: "write" | "read", url: string, method: string) =>
    s3(c, which).fetch(url, { method, redirect: "error", headers: { "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD" } });
  const drain = async (res: Response) => { await res.arrayBuffer().catch(() => undefined); return res; };
  await t("production_token_read_access", async () => (await drain(await prodGet(c, "/rest/v1/rpc/dlm_backup_runner_objects"))).ok);
  const body = crypto.getRandomValues(new Uint8Array(1024));
  const key = `selftest/${stamp()}-${rand(4)}.bin`;
  let vid: string | null = null;
  await t("write_key_uploads_with_version_id", async () => { vid = (await put(c, key, body)).versionId; return !!vid; });
  const bucketUrl = `${c.endpoint}/${c.bucket}`;
  const pinned = () => objUrl(c, key) + (vid ? `?versionId=${encodeURIComponent(vid)}` : "");
  await t("write_key_cannot_read", async () => (await drain(await s3req("write", objUrl(c, key), "GET"))).status === 403);
  await t("write_key_cannot_list", async () => (await drain(await s3req("write", `${bucketUrl}?list-type=2`, "GET"))).status === 403);
  await t("write_key_cannot_list_versions", async () => (await drain(await s3req("write", `${bucketUrl}?versions=`, "GET"))).status === 403);
  await t("write_key_cannot_delete_version", async () => !(await drain(await s3req("write", pinned(), "DELETE"))).ok);
  if (c.readId && c.readSecret) {
    await t("read_key_reads_pinned_version", async () => { const res = await s3req("read", pinned(), "GET"); const b = new Uint8Array(await res.arrayBuffer()); return res.ok && (await sha256(b)) === (await sha256(body)); });
    await t("object_lock_compliance_at_least_34_days", async () => {
      const res = await drain(await s3req("read", pinned(), "HEAD"));
      const until = Date.parse(res.headers.get("x-amz-object-lock-retain-until-date") ?? "");
      return res.ok && (res.headers.get("x-amz-object-lock-mode") ?? "").toUpperCase() === "COMPLIANCE" && until - Date.now() >= 34 * 86400000;
    });
    await t("read_key_cannot_list", async () => (await drain(await s3req("read", `${bucketUrl}?list-type=2`, "GET"))).status === 403);
    await t("read_key_cannot_delete_version", async () => !(await drain(await s3req("read", pinned(), "DELETE"))).ok);
    await t("hiding_keeps_the_locked_version", async () => {
      await drain(await s3req("write", objUrl(c, key), "DELETE"));     // allowed on B2 (writeFiles): hide marker only
      return (await drain(await s3req("read", pinned(), "GET"))).ok;
    });
  } else {
    r.read_key_configured = false;
  }
  const failed = Object.entries(r).filter(([, ok]) => !ok).map(([k]) => k);
  await rpc(c, "dlm_runner_finish", { p_run: run, p_status: failed.length ? "failed" : "succeeded",
    p_payload: { manifest: { selftest: r }, error: failed.length ? `selftest_failed: ${failed.join(" ")}`.slice(0, 300) : null } });
  console.log(`dlm-backup: selftest ${run}: ${failed.length ? `FAILED (${failed.join(", ")})` : "all checks passed"}`);
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
  try { const b = await req.json(); if (["verify", "continue", "selftest"].includes(b?.mode)) mode = b.mode; } catch { /* default */ }
  let b: Begin;
  try {
    b = JSON.parse(await rpc(c, "dlm_runner_begin", { p_secret: secret, p_mode: mode }));
  } catch (e) {
    const code = safe(e);
    return json(code.endsWith("invalid_trigger") ? 401 : code.endsWith("already_running") ? 409 : 500, { error: code.endsWith("invalid_trigger") ? "unauthorized" : code });
  }
  if (b.action === "idle") return json(200, { idle: true });
  const work = (b.mode === "selftest" ? selftest(c, b.run) : b.mode === "verify" ? verifyStep(c, b.run) : backupStep(c, b)).catch(async (e) => {
    const code = safe(e);
    const status = await rpc(c, "dlm_runner_step_failed", { p_run: b.run, p_error: code, p_fatal: FATAL.has(code) })
      .then((s) => JSON.parse(s)).catch(() => "unknown");
    console.log(`dlm-backup: run ${b.run} step failed (${code}); run is now ${status}`);
  });
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) { rt.waitUntil(work); return json(202, { run: b.run }); }
  await work;
  return json(200, { run: b.run });
});
