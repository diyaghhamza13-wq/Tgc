# Automated backup — complete security review (Phase 1b: separate Backup Runner)

**Date:** 2026-11-14. **Repository and local only.** Nothing was created, applied,
deployed, exported or changed in production or in any external service.

This review supersedes the Phase 1 review. Earlier findings that still apply are
carried over below.

**Scope:**
- **Production, pending:** `supabase/migrations-pending/20261115090000_backup_read_access.sql`
  and `REMOVE_backup_read_access.sql`.
- **Runner:** `backup-runner/` (config, migration, schedule, function with `deno.lock`).
- **Tooling:**
  - `scripts/backup/offsite-restore.mjs`, `restore-core.mjs`, `restore.mjs`,
    `runner-token.mjs`;
  - `tools/backup-tool/` → `docs/backup/tools/backup-tool.html`;
  - the storage simulator;
  - the tests.

**Architecture and operation:** [`BACKUP-RUNNER.md`](BACKUP-RUNNER.md).

**Why a separate project:** [`SERVICE-ROLE-AUDIT.md`](SERVICE-ROLE-AUDIT.md). Every Edge
Function receives its project's service key and database password, so a backup function
inside production would put the whole production project at risk if compromised.

---

## 1. Threat model

**Assets:**
- production data, including legacy patient records;
- stored dental files (STL, PLY, OBJ, 3MF, DCM, photos, logos);
- user accounts;
- the backups;
- the encryption private key.

| Adversary / entry point | Examples |
|---|---|
| A1. Compromised runner code | A malicious dependency update; a bug exploited through crafted data; a malicious deploy |
| A2. Leaked runner secrets | Dashboard member, screenshot, mistaken paste |
| A3. Internet attacker | Calls to the public runner endpoint, to production's anon-callable snapshot, or to Storage, with or without a guessed token |
| A4. Logged-in app user | Tries to use the backup paths to reach data beyond their lab |
| A5. Stolen or old token | After rotation or revocation |
| A6. Write-key holder | Tries to replace or delete existing backups, or plant fake ones |
| Out of scope | Compromise of Supabase, Backblaze or Cloudflare themselves; takeover of your own Supabase or provider account (mitigation: 2FA) |

## 2. Credentials and where they live

| Credential | Lives in | Grants | Revocation |
|---|---|---|---|
| Production service key / DB password | Production only (the existing functions) | Everything in production | — |
| **Backup token** `dlmbk1_…` | Runner function secret. Production stores only its SHA-256. | Production: read-only snapshot + downloads by exact path | `revoke_token` / `revoke_all_tokens` (instant), or expiry (≤ 400 days) |
| Production anon key | Runner secret (it is public anyway) | What any visitor has | — |
| Runner service key / DB password | Runner project only | The runner's own bookkeeping (no personal data) | Rotate in the runner project |
| Trigger secret | Runner Vault (generated in SQL) | Start a backup run | Rotate in the runner Vault |
| Storage write key | Runner function secret | Add objects only | Provider console |
| Storage read key (optional) | Runner function secret | Read ciphertext only; cannot list | Provider console |
| Storage restore key | You, created only when restoring | Read ciphertext + list versions | Delete after use |
| `age` private key | You (password manager + paper) | Decrypt backups | Generate a new pair; old runs expire after 35 days |

**The production database never receives a runner credential:**
- tokens are registered by **hash**;
- the runner's keys, trigger secret and storage keys appear nowhere in production
  *(tested by dumping the local production database)*;
- PostgREST passes the token as a bound parameter, so it never appears in
  `pg_stat_statements` *(tested)*.

## 3. Production access mechanism: careful review

### 3.1 Database
- `public.dlm_backup_runner_snapshot()` and `public.dlm_backup_runner_objects()` (the
  stored-object list for later steps) are the **only** backup functions callable over
  the API. They are callable **only by `anon`** with a valid token, and are `STABLE`, so
  PostgREST runs them in a read-only transaction.
- The snapshot wrapper calls `public.dlm_backup_snapshot()`, which is owned by the `NOLOGIN` role
  `dlm_backup_reader` (`SECURITY DEFINER`) and checks itself before reading:
  - read-only transaction;
  - `BYPASSRLS`, no login, not superuser;
  - **no write/`TRIGGER` right on any relation in any schema it can reach;**
  - no foreign `SECURITY DEFINER` function it can execute;
  - no `auth` or `vault` access.
- The `net` exemption from Phase 1 is **removed**. If `pg_net` were ever installed in
  production, the backup would stop with `backup_role_can_write`. This is a deliberate
  tripwire *(tested)*.
- `service_role` can no longer execute either snapshot function *(tested)*.

**How `SET ROLE` relates to the `NOLOGIN` role:** unchanged from Phase 1.
- The role cannot connect.
- The migration grants `postgres` a temporary `SET` membership only for the ownership
  hand-over and for granting `postgres` `EXECUTE` (needed by the wrapper), then revokes
  it.
- At run time the `SECURITY DEFINER` switch applies to the fixed function code only.
- **Tested:** owner `dlm_backup_reader`; `postgres` has no `SET`.

### 3.2 Storage: do not assume a header enforces anything
A custom header has **no effect** by itself. Storage enforces only row-level-security
policies on `storage.objects`, evaluated in Postgres. The design was therefore verified
step by step on the local Storage service (v1.88.0) *(tested)*:

1. **Storage exposes the request to policies:** `request.headers`, the JWT claims, and
   `storage.operation()`. A policy can therefore read the header.
2. **A plain `SELECT` policy with a header check is NOT safe.** It also allowed the token
   holder to:
   - **create signed URLs:** a one-year URL was issued, and **signed URLs remain valid
     after the token is revoked**;
   - read object details;
   - list.
3. **The policy is therefore restricted** to `storage.allow_only_operation('object.get_authenticated')`
   (download by exact path) **and** `dlm_backup.token_valid()`.

   Tested with the token:
   - download allowed;
   - **refused or nothing returned:** single and bulk signed URLs, signed upload URLs,
     info, list, upload, overwrite (PUT and upsert), move, copy, delete, bucket
     create/update/delete.
   - Nothing changed.
4. **Fails closed:**
   - no header, wrong or malformed token, the hash instead of the token, a revoked or
     expired token → refused;
   - a token sent by a **logged-in app user** or with the **service key** → not
     accepted, because the role must be `anon` *(tested)*. App users keep exactly their
     normal access;
   - if hosted Storage did not report the operation, the policy grants nothing, so
     backups fail visibly instead of over-granting.
5. **Policies are OR-combined.** This policy only adds download access for valid token
   requests and does not change any existing app policy. The app regression tests
   passed (137/137).

**To confirm on hosted Supabase before P7:** the Storage version supports
`storage.allow_only_operation()`. If not, the migration fails, which is safe.

## 4. What a compromised runner can read, copy or disrupt

The attacker is assumed to run arbitrary code in the runner function and to read all
of its secrets.

| | Possible? | Detail |
|---|---|---|
| **Read / copy** all production table data | **Yes** | Inherent to any backup agent: the snapshot covers every table, including legacy patients and PIN hashes |
| **Read / copy** stored files | **Yes, by exact path** | Paths come from the snapshot. Listing is refused, but the snapshot already names every object. |
| Read Auth users (e-mails, password hashes), Vault, cron, other projects | No | Not in the snapshot; no service key |
| **Modify, delete or insert** production data or files; change buckets; create signed URLs; impersonate users | **No** | Tested: every write path refused; only `GET` requests reached production |
| Keep access after **revocation** | **No** | Tested: refused immediately; no signed URLs could be created beforehand |
| Read existing backups | No | The write key cannot read or list (the read key reads ciphertext only) |
| **Overwrite or delete** existing backups | **No** | An overwrite only adds a version (no conditional write is relied on: B2 does not document `If-None-Match`). Hiding a key (B2 `writeFiles` allows delete markers) keeps every locked version. Compliance lock blocks deletion, even by the admin key. Restore uses the **first** version. Tested with a fake snapshot + fake manifest + a hidden file map and file copy: ignored, reported, and the genuine data restored. |
| Decrypt anything | No | No private key |
| **Disrupt future backups** | **Yes** | Stop running; upload garbage; falsify its own run log; mark runs successful |
| Replace the encryption public key for future runs | Yes, if it can edit runner secrets | Manifests list the public keys; restore tooling and the offline page warn if a run is encrypted to any key other than yours *(tested)* |
| Cost / quota exhaustion | Yes | Many uploads with the write key; provider spending caps to confirm |
| Reach production with the **runner's** own keys | No | Rejected by production *(tested: REST, Storage, even with the token)* |

**Detection of disruption:**
- the runner's own health alert (after 26 hours without success) cannot be trusted if
  the runner itself is compromised;
- the **quarterly drill** (decrypt a recent run with your own key) is the independent
  check;
- revocation in production is the kill switch.

## 5. Other separate compromise impacts

| Compromised | Impact | Response |
|---|---|---|
| `age` private key | All retained runs (35 days) decryptable by whoever also gets the ciphertext | New key pair; old runs expire |
| Storage write key | Garbage or fake new objects; cannot touch originals | Rotate; fakes are ignored by restore |
| Storage read key | Ciphertext and manifest metadata | Rotate |
| Restore key | Same as the read key, plus listing | Delete after each use |
| Trigger secret | Extra runs (one at a time) | Rotate in the runner Vault |
| Backup token alone | Read-only copy of data and files (= §4 read/copy) | `revoke_token`, instant |

## 6. Region (London)
- The schedule sends `x-region: eu-west-2` with every call *(tested)*.
- The function refuses to run when `SB_REGION` is set and is not `eu-west-2`. When
  `SB_REGION` is absent (local runs only), it refuses unless production is on a
  loopback address *(tested: `us-east-1` refused; unknown region with a remote URL
  refused; London accepted)*.
- Off-site bucket: B2 EU Central (Amsterdam) or R2 EU jurisdiction. The bucket is in
  the EU, not in London: say so in the privacy policy.

## 7. Supply chain and lock files
- **Runner function:** `deno.lock` (lock file v5) pins `age-encryption@0.3.1`,
  `aws4fetch@1.0.20` and their dependencies (`@noble/*`, `@scure/base`) with integrity
  hashes. The tests run with `--frozen`.
- **Offline page:** `tools/backup-tool/package-lock.json`; reproducible build; strict CSP
  (`connect-src 'none'`, script hash).
- The runner function sends production nothing but `GET`s with no request body, and
  follows no redirects (`redirect: "error"`) for any request: production, its own
  bookkeeping, storage. The token therefore cannot be forwarded to another origin by a
  redirect.

## 8. Findings

| # | Finding | Severity | Status |
|---|---|---|---|
| B1 | Default secrets (service key, DB password) are injected into every Edge Function | High | **Resolved:** the runner is a separate project and holds only the anon key + a revocable read-only token |
| B2 | A header-checked Storage `SELECT` policy would allow signed URLs that **outlive revocation**, plus list and info | High | **Resolved:** policy restricted to the download operation *(tested)* |
| B3 | Restore read the **latest** object version, so a compromised runner could have substituted a fake manifest + snapshot | High | **Resolved:** restore reads the first version, reports extra versions, and refuses without version-listing permission *(tested)* |
| B4 | `pg_net` grants `anon`/`authenticated` outbound HTTP and queue access | Medium | **Resolved for production:** no `pg_net` there (it is only in the runner project, which holds no production data); tripwire if installed |
| B5 | A runner deployed into production by mistake would hold production's service key | High | **Mitigated:** the function refuses when its own URL equals production's, and refuses a service/secret key as the "anon key" *(tested)* |
| B6 | Plaintext processed outside London | Medium | **Mitigated:** `x-region` + `SB_REGION` check *(tested locally; documented by Supabase: functions run near the caller unless `x-region` is sent; `SB_REGION` is set on hosted functions)* |
| B7 | A compromised runner can read and copy all data and files | Inherent | Accepted. Read-only, revocable, expiring token; runner project with 2FA; quarterly drill. |
| B8 | A compromised runner can disrupt or falsify future backups | Medium | Drill + revocation; detection needs you |
| B9 | Token in a request header may appear in API gateway logs | Low (to confirm) | Logs stay within Supabase; rotate if exposed |
| B10 | No rate limit on the anon-callable snapshot | Low | A wrong token costs one hash lookup; brute force of 256 bits is infeasible |
| B11 | `anon` statement timeout 3 s | Low | ≈ 1 s for 25 MB of app tables *(tested)*; split per table if data grows |
| B12 | Provider semantics (versioning, compliance lock, lifecycle, version listing, key scopes) | Medium → **mostly verified** | Backblaze documentation confirms compliance lock, default retention, "lifecycle cannot delete locked files", version ids, version listing and per-bucket key capabilities (`BACKUP-RUNNER.md` §2). What depends on the real account is checked by the **activation self-test** (11 checks). |
| B12a | B2 does not document `If-None-Match` | Low | **Resolved:** no longer sent; unique keys + first-version restore |
| B12b | B2 `writeFiles` can hide files (delete markers) | Low | **Accepted:** data versions stay locked; restore reads versions *(tested as an attack)* |
| B16 | Hosted Edge Function limits (2 s CPU, 256 MB) would be exceeded by one long run (files up to 500 MB) | High | **Resolved:** bounded resumable steps (≤ ~1 s CPU, ≤ ~150 MB measured; real-runtime test with limits enforced; negative control) |
| B17 | Storage answers "not found" also for a refused token | Medium | **Resolved:** a file is recorded as gone only if missing from the token-checked object list |
| B18 | Snapshot size bounded by memory | Low | 20 MB guard (fails cleanly) + health alert from 15 MB; production today far below |
| B19 | Free runner project may pause after 7 days of low activity | Low | A database API call every 3 minutes; Supabase emails a warning a week before pausing; quarterly drill | Verify on B2 before P1. R2 version listing is unknown. |
| B13 | Lock file v5 support by the Supabase deploy bundler | Low | **Resolved:** the Supabase bundler (edge-runtime v1.77.9) accepts it and rejects a tampered integrity hash |
| B14 | `REMOVE_backup_read_access.sql` leaves an explicit, privilege-identical ACL on `supabase_migrations.schema_migrations` | Cosmetic | Grants are identical to the default owner rights |
| B15 | Production's Management API token can run SQL with full rights | Medium (pre-existing) | Revoke when no longer needed (your decision) |

## 9. Test evidence (local, 2026-11-14)

| Suite | Result |
|---|---|
| `scripts/tests/automated-backup-local-test.sh`: two local stacks, recording proxy, storage simulator | **161/161** end-to-end + **18/18** offline page + **7/7** in the real Supabase Edge Runtime (256 MB / 2 s / 150 s enforced) + **7/7** performance per step + migration pre-check |
| Deploy bundle (Supabase bundler) | 3.9 MB; `deno.lock` enforced |
| `scripts/tests/service-role-audit-local.sh`, updated for Phase 1b, incl. the `pg_net` tripwire | **45/45** |
| Earlier suites after a fresh reset | legacy round trip 29/29 · phone flow 21/21 · security 49/49 · restore drill 29/29 tables identical · integration 137/137 · `tsc` 0 · `deno check --frozen` 0 · rollback == production (functions and policies) |
| Production migration → removal | Identical except B14 |

**End-to-end sections:**

0. Fixture covers STL, PLY, OBJ, 3MF, DCM, a legacy photo, a logo, another lab's file
   and a legacy patient.
1. **Production access control:**
   - no `pg_net`, no cron job, only the read-only wrapper callable;
   - token stored as a hash;
   - snapshot and download checked for every caller (anon, app user, service key; with
     and without a valid, wrong or malformed token, or the hash);
   - 19 write and escalation attempts by a token holder, all refused.
2. **Runner endpoint and RPCs refuse:**
   - a wrong or missing trigger secret;
   - the production anon key, an app user's JWT, the production service key, the runner
     anon key;
   - nothing is recorded and nothing reaches production.
3. **First backup:**
   - all 8 files and 29 tables;
   - no plaintext;
   - exact decryption;
   - manifest lists your public key;
   - **production saw only `GET`s with the anon key + token**;
   - no names in the runner database or the logs.
4. Incremental copies, re-upload after 29 days, a changed file copied again.
5. Write key cannot read, list, list versions, delete or reconfigure; 412 / new version
   only; lock holds; signed payload enforced.
6. Weekly verify; corruption detected; self-healing.
7. Health alert without alert floods.
8. **Unsafe configurations refused before any network call:**
   - region;
   - running inside production;
   - service or secret key given as the anon key;
   - malformed token;
   - non-HTTPS endpoints.
9. **Key separation:**
   - runner keys rejected by production;
   - runner process environment holds no production secret;
   - neither database holds the other's credentials;
   - token absent from query statistics.
10. **Tampering:** fake snapshot + fake manifest planted under a real run → restore
    refuses without version listing, uses the first versions, reports the tampering and
    restores the genuine data. Full restore: 29/29 tables identical, every file
    byte-identical.
11. Runner `pg_cron` + `pg_net` schedule triggers a successful backup with
    `x-region: eu-west-2`; production still has no `pg_net`.
12. **Token lifecycle:**
    - rotation overlap; third token refused; plaintext registration refused;
    - **revoked token: snapshot and downloads refused immediately; its runner uploads
      nothing**;
    - the new token works;
    - expiry refused;
    - emergency `revoke_all_tokens()`;
    - no token in query statistics.
13. Retention + lock: day 34 nothing deleted, admin refused; day 36 all removed,
    including the attacker's extra versions; a lifecycle shorter than the lock → the
    lock wins.

**Added in the activation round:**

| Section | What it shows |
|---|---|
| 11a | Activation self-test: 11/11 pass with correct keys; fails, naming the checks, with an over-powerful key |
| 11b | 20 MB file in 2 segments over several steps; lease refuses a concurrent step; a dead step's lease is resumed; a file deleted mid-run is recorded as gone; segmented restore is byte-identical |
| 7 | Snapshot-size early warning |
| Performance | Per step ≤ 1,010 ms CPU and ≤ 151 MB; a 100 MB file in 4 steps; the 20 MB guard fails cleanly at 67 MB |

## 10. Production steps
Exact steps in [`BACKUP-RUNNER.md`](BACKUP-RUNNER.md) §6: Y1–Y7 by you, A1–A6 by me after
your approval. **None has been performed.**

Costs: [`BACKUP-RUNNER.md`](BACKUP-RUNNER.md) §8, verified on the providers' pages on
2026-11-14. Still unverified: Backblaze's data-processing addendum.
