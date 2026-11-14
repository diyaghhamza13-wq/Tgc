# Automated backup — security review (Phase 1, repository and local only)

**Scope:**
- `supabase/functions/dlm-backup/`
- `supabase/migrations-pending/20261114190000_automated_backup.sql`,
  `…190100_automated_backup_schedule.sql`, `REMOVE_automated_backup.sql`
- `scripts/backup/offsite-restore.mjs`, `restore-core.mjs`, `restore.mjs`
- `tools/backup-tool/` → `docs/backup/tools/backup-tool.html`
- the simulator and tests

> **Superseded in part by [`SERVICE-ROLE-AUDIT.md`](SERVICE-ROLE-AUDIT.md) (2026-11-14):**
> - Supabase documents that every Edge Function receives `SUPABASE_DB_URL` and the
>   service and secret keys. Not *reading* them gives no protection against a
>   **compromised** function (§2 and S3 below).
> - Functions run in the region closest to the caller unless `x-region` is sent
>   (S6 "same region" is not guaranteed).
> - The audit recommends a separate runner project with token-gated, read-only
>   access before any production step.

**Nothing here has been applied, deployed or created in production.** Statements about
Supabase, Backblaze or Cloudflare behaviour are **unverified** until checked against
their current documentation (see §8).

---

## 1. How the NOLOGIN backup role is used: `SET ROLE` and `SECURITY DEFINER`

**What `NOLOGIN` means.** `dlm_backup_reader` has no login right and no password.
PostgreSQL refuses any connection as this role. Tested locally: even with a password
set, the refusal is "role … is not permitted to log in". Its rights can only be used
**from inside a session that already exists**, in one of two ways.

**1. `SET ROLE dlm_backup_reader`**
- A session switches its *current user* to the role. From then on, every privilege
  check uses the role's rights.
- This needs membership with the `SET` option, e.g.
  `GRANT dlm_backup_reader TO postgres WITH INHERIT FALSE, SET TRUE`.
  - `INHERIT FALSE`: `postgres` does *not* silently gain the role's rights.
  - `SET TRUE`: `postgres` may *switch* to it explicitly.
- A role's own settings, such as `default_transaction_read_only`, apply only at
  *login*. They do not apply after `SET ROLE`, so read-only must be enforced per
  transaction.
- **Why we do not use it at run time:** to run `SET ROLE`, the backup function would
  have to connect to Postgres directly, which means holding the `postgres` password
  (`SUPABASE_DB_URL`). That contradicts the requirement not to expose it.

**2. `SECURITY DEFINER` function owned by the role** (what we use)
- When a `SECURITY DEFINER` function runs, PostgreSQL switches the current user to the
  **function's owner** for the duration of the call. It is the same "current user"
  switch as `SET ROLE`, but limited to the function's **fixed code**.
- `public.dlm_backup_snapshot()` is owned by `dlm_backup_reader`. So whoever is allowed
  to execute it (only `service_role`) gets a snapshot read with **exactly the backup
  role's rights**, and nothing else.
- **`ALTER FUNCTION … OWNER TO dlm_backup_reader`** has two conditions:
  1. the current role (`postgres`) must be able to `SET ROLE` to the new owner;
  2. the new owner must have `CREATE` on the schema.

  The migration grants both **for that single statement and revokes both right after**:
  - `grant create on schema public to dlm_backup_reader;`
  - `grant dlm_backup_reader to postgres with inherit false, set true;`
  - `alter function public.dlm_backup_snapshot() owner to dlm_backup_reader;`
  - `revoke dlm_backup_reader from postgres;`
  - `revoke create on schema public from dlm_backup_reader;`
- **Tested afterwards:** the owner is `dlm_backup_reader`, the function is
  `SECURITY DEFINER`, `postgres` has **no** `SET` on the role, and the role has **no**
  `CREATE`. Nobody can switch into the role any more; its rights are reachable only
  through the snapshot function's fixed code.
  - As the creator, `postgres` keeps the PostgreSQL 16+ `ADMIN` option, so it could
    re-grant itself membership. `postgres` already has full control of the database,
    so this adds nothing.

**At run time:**
1. The Edge Function calls `GET /rest/v1/rpc/dlm_backup_snapshot` with the service-role
   key.
2. PostgREST runs it, as `service_role`, in a **read-only transaction**.
3. The body runs as `dlm_backup_reader`, and first checks itself:
   - `current_user` is the backup role;
   - the transaction is read-only;
   - `BYPASSRLS` is set and `LOGIN` and superuser are not;
   - it cannot write, truncate or add triggers on any relation in any reachable schema;
   - it can run no other `SECURITY DEFINER` function;
   - it has no `auth` or `vault` access.

   Any failure stops the backup.
4. It then returns one consistent snapshot. A `STABLE` function reads the snapshot of
   its calling statement (PostgreSQL documentation; not concurrency-tested here).

## 2. Credentials: what the function has and uses

| Credential | Present in the function? | Used for | Exposure decision |
|---|---|---|---|
| `postgres` password (`SUPABASE_DB_URL`) | Supabase injects it into every function **(to confirm)** | **Never.** The function does not read it. | Local test: the function ran under a Deno `--allow-env` list **without** it (the variable existed in the process environment), so the code *could not* read it, and every backup still succeeded. On hosted Supabase this is enforced by code review only. |
| Service-role key | Injected by Supabase in every function (already true for the 3 existing functions) | (a) the `dlm_backup_*` RPCs; (b) downloading stored files from Storage | **Necessary:** Storage downloads need it, and no narrower key exists without the JWT secret. It never leaves the function, is never logged, and is used for no other API. |
| Off-site **write** key | Function secret | `PUT` new objects | Can add objects only (tested; §3) |
| Off-site **read** key (optional) | Function secret | Weekly integrity check | Can read **ciphertext** only; cannot list or delete (tested), cannot decrypt |
| `age` public key(s) | Function secret | Encrypting | Not secret |
| `age` **private** key | **No** | — | Only the operator (password manager + paper) |
| Trigger secret | Vault (generated in SQL, never displayed); compared in the database | Authenticating `pg_cron` → function | The function receives it in a header and passes it to `dlm_backup_begin`; it never stores it |

## 3. A compromised backup function cannot read, overwrite or delete existing backups

This was tested against the local S3-compatible simulator, which enforces SigV4, key
permissions, versioning, compliance lock and lifecycle.

**With the write key:**
- refused (403): `GET`, `HEAD`, `LIST`, `DELETE`, `DELETE ?versionId=`, changing
  lifecycle or lock configuration;
- refused (412): overwrite with `If-None-Match: *`;
- overwrite without that header: the store only adds a **new version**. The original
  version stays byte-identical and readable, and **even the admin key cannot delete
  it** while locked.

**Version pinning:**
- every upload records the provider's version ID: in the manifest for the snapshot and
  file map, in `dlm_backup.files` for stored files;
- the integrity check and the restore read **that exact version**, so a later rogue
  version cannot replace what is restored (tested).

**Integrity of uploads:**
- the function signs the SHA-256 of every body. The store rejects a body that doesn't
  match (tested: 400). The returned ETag is also compared with the MD5 when it has MD5
  form.

**Retention and lock together:**
- lock 35 days (compliance) + lifecycle 35 days:
  - day 34: nothing deleted, and admin deletion refused;
  - day 36: everything expired is removed automatically.
- misconfiguration (lifecycle 30 days < lock 35 days): on day 31 the **lock wins**
  (nothing deleted, 1 blocked); on day 36 it is deleted.
- **stored files stay restorable:** each file is copied again every 28 days (< 35), so
  the newest run's file map always points to live copies (tested: a 29-day-old copy is
  re-uploaded).

**What a compromised function *can* still do:**
- with the service-role key it could read or change the live database and storage.
  That is the existing risk of every Supabase function holding this key, not new with
  the backup;
- it could upload garbage *new* runs or versions, or fake its own run records. That is
  detected by the drills: restoring needs the pinned, hash-verified objects;
- it cannot decrypt anything (no private key), and cannot destroy existing backups
  (lock).

## 4. Findings

| # | Finding | Severity | Status / mitigation |
|---|---|---|---|
| S1 | **Installing `pg_net` gives every database role (PUBLIC) usage on schema `net` and write access to its request queue.** The grant is owned by `supabase_admin`; `postgres` cannot revoke it. Seen locally with the same Supabase images; to confirm in production. | Medium-Low | App users cannot run SQL (only exposed RPCs; `net` is not exposed); the backup role cannot log in. The write checks exclude `net` (documented in the code). **Alternative without `pg_net`:** an external HTTPS scheduler sending only the trigger secret, e.g. a scheduled GitHub Actions workflow (one more external dependency). |
| S2 | The service-role key exists in every function's environment, including this one | Medium (pre-existing) | Used only for RPCs and Storage downloads; no logging; 2 pinned dependencies; trigger secret required |
| S3 | `SUPABASE_DB_URL` is present but unused in the hosted environment | Low | Code never reads it (test + review); cannot be removed on hosted Supabase (to confirm) |
| S4 | Trigger secret transits `pg_net`'s queue table briefly; responses are stored in `net._http_response` | Low | Only `postgres` and roles with `net` access can read the queue; the response holds only the run ID |
| S5 | The plaintext manifest reveals table row counts, sizes and times | Low | No personal data; needed to verify without the private key |
| S6 | The function sees plaintext (including patient and file names) in memory | Inherent | Same provider and region as the live data; nothing logged (tested: no names, paths or row data in the function log) |
| S7 | Supply chain: `age-encryption@0.3.1` (BSD-3-Clause, by the `age` author) and `aws4fetch@1.0.20` (MIT) via `npm:` | Low-Medium | Versions pinned. Recommendation at deployment: commit a `deno.lock` for this function (the project currently deletes lock files). |
| S8 | The offline page must be obtained intact | Low | Built reproducibly from `tools/backup-tool` (pinned, `package-lock.json`); strict CSP with a script hash and `connect-src 'none'` (tested: no request possible). Its SHA-256 is printed by the build. |
| S9 | Restore SQL and decrypted files are plaintext | Inherent | The tools say so and delete them; the restore test deletes them |
| S10 | **Provider semantics are simulated, not verified:** B2/R2 support for `If-None-Match`, ETag = MD5, version IDs, compliance lock + lifecycle interplay, key scopes (`GetObjectVersion` separate from `GetObject` in AWS terms) | Medium | Verify before step P2; R2 may not return version IDs (pinning then falls back to the latest version, still hash-checked) |
| S11 | Snapshot consistency relies on `STABLE` function semantics | Low | PostgreSQL documented behaviour; not concurrency-tested |
| S12 | Edge runtime `EdgeRuntime.waitUntil`, time and memory limits, response size | Low-Medium | Unverified. Current data ≈ 16 MB database + 32 MB files; files are processed one at a time. |

## 5. Test evidence (local, 2026-11-14)

**`scripts/tests/automated-backup-local-test.sh`: 68/68 end to end + 13/13 browser page.**

| Area | Results |
|---|---|
| Trigger | wrong or missing secret → 401, nothing recorded or uploaded; `GET` → 405 |
| Backup | All 7 stored files copied: STL, PLY, OBJ, 3MF, 3Shape DCM, a legacy photo, a lab logo. Object keys contain no names. **No plaintext marker** (patient, lab, file names, file contents) in any stored object. Everything except the manifest is `age`-encrypted. The snapshot decrypts and matches its manifest (29 tables), including the legacy patient (row-level security bypassed). Every file decrypts to its exact original bytes. The function log holds no names, paths or row data. |
| Incremental | The second run copies 0 files; a 29-day-old copy and a changed file are copied again |
| Compromised function | §3 (11 checks) |
| Integrity check | Passes with pinned versions; detects a corrupted object; the next backup self-heals; the check passes again |
| Health | An alert after 26 hours without success; no alert flood |
| Access | `anon` and a logged-in lab administrator cannot call any backup RPC; schema `dlm_backup` is not exposed by the API; owner, `SECURITY DEFINER`, `NOLOGIN`, no `SET`, no `auth`/`vault` |
| Keys | The source never reads `SUPABASE_DB_URL`; the function ran under an allow-list without it; a misconfigured remote `http://` endpoint is refused |
| Full restoration | Off-site fetch (hashes, decryption, 29 tables) → damage → restore SQL → **all 29 tables identical**, and **every file byte-identical at its original path** |
| Scheduling | The repository's schedule SQL creates the 3 jobs; a `pg_cron` job calling `dlm_backup.invoke()` triggered a successful backup through `pg_net` |
| Retention + lock | §3 |
| Browser page | Strict CSP, no network possible or attempted; the generated key pair is verified with the `age` command-line tool; a wrong key is refused; the real run verifies; the browser's `restore.sql` is **identical** to `restore.mjs`'s; single-file decryption is exact; "Forget" and "Clear" work |

## 6. Production actions still required (none done; separate approval each)

P1–P12 as listed in `AUTOMATED-BACKUP-DESIGN.md` §8, now concretely:
- **P4–P6:** move `supabase/migrations-pending/20261114190000_automated_backup.sql` into
  `supabase/migrations/` and apply it. It contains the role, schema, RPCs, `pg_net` and
  the Vault trigger secret.
- **P7:** set the function secrets in the dashboard: `DLM_BACKUP_AGE_RECIPIENTS`,
  `DLM_BACKUP_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_WRITE_KEY_ID`, `_WRITE_SECRET`,
  and optionally `_READ_KEY_ID` and `_READ_SECRET`.
- **P8:** deploy `supabase/functions/dlm-backup` with `verify_jwt = false`.
- **P10:** create the Vault secret `dlm_backup_function_url`, then apply
  `…190100_automated_backup_schedule.sql`.
- **Removal:** `REMOVE_automated_backup.sql` and delete the function.

## 7. Restore paths (tested locally)
- **Computer:** `offsite-restore.mjs fetch`, then `restore.mjs`, then `psql -X`, then
  `offsite-restore.mjs restore-files`.
- **Phone, no Termux:** the offline page verifies a run and downloads `restore.sql` (for
  the SQL editor). It also decrypts single files.

## 8. Costs and external dependencies: ALL UNVERIFIED until confirmed

| Item | Assumption (unverified) | To confirm |
|---|---|---|
| Supabase Pro plan (optional, managed daily backups) | ≈ $25/month, ≈ 7-day retention, files not included | Pricing page, backups documentation |
| Supabase Edge Functions on the current plan | Free quota covers 1–2 runs per day | Limits page (duration, memory, invocations) |
| `pg_cron`, `pg_net`, Vault | Included | Extensions documentation |
| Backblaze B2 (EU Central) **or** Cloudflare R2 (EU) | ≈ $0 within ≈ 10 GB free; Object Lock or bucket lock and lifecycle available; write-only key scopes available | Provider pricing and documentation; EU region availability |
| npm packages `age-encryption`, `aws4fetch`, `esbuild` | Free, open source (BSD-3-Clause / MIT / MIT) | Licences at the pinned versions |
| Optional email alerts | Not designed (alerts are rows in `dlm_backup.runs`) | — |
