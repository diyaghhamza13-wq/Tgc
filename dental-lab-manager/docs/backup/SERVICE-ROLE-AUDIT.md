# Service-role key audit for the automated backup (before any production step)

> **Status:** the recommendation (R2 + D1 + S1) is implemented in Phase 1b. See
> [`BACKUP-RUNNER.md`](BACKUP-RUNNER.md) and [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md).
> Implementation found that the S1 policy must be limited to the download operation
> (finding B2), because a plain policy also allows signed URLs that outlive revocation.

**Date:** 2026-11-14.

**Scope:** the backup design in `AUTOMATED-BACKUP-DESIGN.md` and `SECURITY-REVIEW.md`
(commit `0886aca`), with a focus on the Supabase service-role key.

**Method:** experiments on the **local** Supabase stack (same images as hosted), with
the pending backup migration applied. Every claim marked *(tested)* is reproduced by
`scripts/tests/service-role-audit-local.sh` (**44/44 passed**).

**Supabase documentation:** read from the docs source on GitHub
(`supabase/supabase`, `apps/docs/content/guides/functions/`), because supabase.com is
not reachable from this environment. Behaviour of the hosted platform that could not be
tested locally is marked **(to confirm)**.

**Nothing was changed in production.** Nothing was deployed, created, applied,
exported or rotated.

---

## 1. What the service-role key can do

The service-role key (legacy JWT; the new "secret" keys behave the same) makes the API
gateway run every request as the Postgres role **`service_role`**.

### 1.1 Database — role `service_role` *(tested)*

| Property | Value |
|---|---|
| Superuser / can log in / `CREATEROLE` | no / no / no |
| **`BYPASSRLS`** | **yes**: row-level security does not apply |
| Public tables (all 29) | **SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER** |
| `storage.objects`, `storage.buckets` | SELECT, UPDATE, DELETE |
| `vault.decrypted_secrets` | SELECT (in SQL) |
| `cron.schedule` | EXECUTE (in SQL) |
| Schemas with USAGE | public, auth, storage, vault, net, extensions, realtime, graphql… |
| Functions in `public` | executes 76, of which 66 are `SECURITY DEFINER`, plus the backup RPCs |

**What is actually reachable with the key alone:** the key gives API access, not a SQL
console. The API exposes only the schemas `public` and `graphql_public` *(tested
locally; production's exposed-schema list to confirm in the dashboard)*. Vault, cron,
`net` and `auth` tables are therefore **not** reachable through it *(tested: 406)*.

### 1.2 Storage API *(tested)*
The service key bypasses all Storage policies:
- **list and download every file in every bucket**, including private ones (STL, PLY,
  OBJ, 3MF, DCM, legacy photos);
- **upload, overwrite and delete** files;
- **create or delete buckets**, and **switch a private bucket to public**. After that,
  anyone on the internet can download files without any key *(tested)*.

### 1.3 Auth admin API *(tested: listing)*
- list all users (e-mail addresses / identifiers, metadata);
- create, update and delete users, change passwords, and generate sign-in links
  (Supabase documentation; impersonation therefore possible).

### 1.4 Not reachable with the service-role key
- schema changes (no DDL rights);
- raw SQL;
- Vault and cron;
- project settings, the Management API, other projects, billing;
- the off-site backup bucket;
- the `age` private key.

## 2. Assumption: the backup Edge Function is fully compromised

The attacker runs arbitrary code inside the function and reads **all of its environment
variables**.

### 2.1 What the environment contains (documented by Supabase)
`guides/functions/secrets.mdx`, "Default secrets": every Edge Function receives
`SUPABASE_URL`, **`SUPABASE_DB_URL`**, `SUPABASE_SECRET_KEYS`,
`SUPABASE_SERVICE_ROLE_KEY`, the publishable/anon keys and `SUPABASE_JWKS`.
- Custom secrets cannot use the `SUPABASE_` prefix.
- **There is no documented way to remove the defaults from one function**
  (to confirm with Supabase support).
- **Secrets are per project, not per function.** The backup's S3 keys would be visible
  to the 3 existing functions as well (`employee-login`, `manage-employee`,
  `register-lab`), and theirs to it.

> **Correction to `SECURITY-REVIEW.md`:** the backup code never *reads* `SUPABASE_DB_URL`
> or uses the service key for anything except RPCs and downloads. Against a **compromised**
> function this gives **no protection**: the attacker reads the environment directly.
> The Deno allow-list test proved code discipline, not isolation.

### 2.2 Consequences (current design, function in the production project)

| Asset | Can the attacker…? | Via |
|---|---|---|
| Read all application data, including legacy patients, PIN hashes and audit log | **Yes** | service key (RLS bypassed) or `postgres` |
| Modify or delete application data, erase the audit trail | **Yes** *(tested: bulk delete of a table and of `audit_logs` over REST)* | service key |
| Download all patient-related files | **Yes** *(tested)* | service key |
| Delete files or make the bucket public | **Yes** *(tested)* | service key |
| Take over user accounts | **Yes** | service key, Auth admin API |
| **Full database control** | **Yes** | `SUPABASE_DB_URL` = the `postgres` user's password. In production `postgres` has `CREATEROLE` and `BYPASSRLS` and owns the tables, and network restrictions are open and SSL enforcement off (read-only inspection, earlier in this session). |
| Read Vault secrets (including the backup trigger secret), change cron jobs | **Yes** | `postgres` |
| Disable or falsify future backups | **Yes** | DB access + S3 write key |
| Read, overwrite or delete **existing** off-site backups | **No** | write key cannot read, list or delete; compliance lock *(tested in the simulator)* |
| Decrypt backups | **No** | the private key is not in Supabase |
| Supabase account, billing, other projects, Management API | **No** | not in the function environment |

**Conclusion:** in the current design, a compromise of the backup function equals a
compromise of the whole production project, except for the existing off-site backups.

- **This is already true today for the 3 existing functions:** each has the same
  default secrets. The backup does not create this exposure.
- **It does enlarge the attack surface that leads to it:**
  - 2 more npm dependencies;
  - one more public endpoint (`verify_jwt = false`);
  - code that handles all data;
  - storage keys shared with all functions.

## 3. Can the backup work without the service-role key?

**Yes,** but only if **the backup code also runs outside the production project**.
Not *using* the key is not enough, because it is injected anyway (§2.1).

Two pieces are needed:

### 3.1 Narrow database access — evaluated options

| Option | How | Verdict |
|---|---|---|
| **D1. Token-gated read-only RPC** *(prototyped, tested)* | A random 256-bit token sent in a request header (never in the URL). Postgres stores only its SHA-256 hash. `dlm_backup_snapshot_t()` is executable by the public `anon` role, checks the header, then returns the snapshot of the existing `NOLOGIN` reader function. The other backup RPCs (`begin`, `files_todo`, `files_done`, `finish`) are gated the same way and write only to `dlm_backup.*`. | **Recommended.** Read-only; no other table reachable; revoked instantly by deleting the hash row *(tested)*. |
| D2. Custom Postgres role via a custom JWT `role` claim | Requires minting a long-lived JWT with the project's JWT secret | Rejected: another long-lived credential, revocable only by rotating the project's JWT secret (breaks every key) |
| D3. Dedicated `LOGIN` role over the pooler | Read-only database password | Rejected earlier (R11): internet-reachable login (network restrictions open, SSL enforcement off) |
| D4. Dedicated Auth user + RLS policies | E-mail and password of a "backup" user; snapshot granted to that user ID | Viable fallback (8 s timeout instead of 3 s) but more moving parts: a password, sign-in, the user appears in Auth |

**D1 limit — the 3-second statement timeout of `anon`** *(tested)*:
- 25 MB of application tables → 28 MB snapshot in **≈ 1.0 s** locally;
- production is smaller (whole database 16 MB including system catalogs);
- when data grows past ≈ 2 s, the snapshot must be split per table, losing
  cross-table consistency, or move to D4.

### 3.2 Narrow Storage access — evaluated options

| Option | Verdict |
|---|---|
| **S1. Storage policy for `anon`: `SELECT` allowed only when the request carries the valid backup token** *(prototyped, tested)* | **Recommended.** Downloading and listing work. Upload, overwrite, delete, bucket changes, table reads and Auth admin are all refused *(tested)*. Revocation is the same hash row. Existing app policies are unaffected: policies are OR-combined and this one adds access only with the token. |
| S2. Signed URLs | Creating them needs the service key → rejected |
| S3. Supabase S3-protocol access keys | Full access to all buckets, bypassing policies (Supabase documentation, to confirm) → rejected |
| S4. S3 protocol with a user session token | Works with D4 only |

**To confirm on hosted Supabase:** the Storage service passes request headers to
policies (`request.headers`), as it does locally.

### 3.3 Where the backup code then runs

| Runner | What a compromise yields | Plaintext location | Assessment |
|---|---|---|---|
| R1. Edge Function in the production project (current) | Full project (§2.2) | Supabase; region **not pinned** (see F5) | Not recommended |
| **R2. Edge Function in a separate "backup runner" Supabase project** (same organization, London region, region pinned). Its environment holds only: production URL, production anon key (public), backup token, storage write/read keys, `age` public key. | Read-only copy of production data and files; **no** modify or delete, no Auth admin, no Vault or cron, no bucket changes, no access to existing backups. Its own `SUPABASE_DB_URL` and service key belong to the empty runner project. | Supabase (same processor), EU | **Recommended** |
| R3. GitHub Actions scheduled workflow | Same as R2, plus anyone with write access to the repository can change the workflow and read the secrets | GitHub-hosted runners: location not guaranteed in the EU → transfer of health data to a further processor | Not recommended for processing data; acceptable only as a *trigger* |
| R4. Inside Postgres (`pg_cron` + `pgsodium` sealed boxes + `pg_net` pre-signed upload) | Storage secrets in Vault, readable by `postgres`; `pgsodium` deprecated (to confirm); large bodies through `pg_net` | Supabase | Rejected |
| R5. A small EU server (VPS) you operate | Like R2 | Your server | Possible, but a server to patch and monitor |

**Any backup agent can read everything:** it must, in order to back it up. The goal
is only to remove its ability to change, delete or administer. R2 + D1 + S1 achieves
that.

## 4. Who can invoke the snapshot function *(tested)*

| Caller | Current design | With D1 |
|---|---|---|
| `anon` (public key), over the API | refused (401) | refused without the valid token (403); with it: the snapshot only |
| logged-in app users (`authenticated`) | refused | refused (not granted) |
| `service_role` (service key) | **allowed** | `dlm_backup_snapshot` stays service-role only; can be revoked |
| `postgres`, `supabase_admin` | allowed (cannot be prevented; they own the database) | same |
| Other functions | no `anon`- or `authenticated`-executable `SECURITY DEFINER` function in `public` uses dynamic SQL, so there is no indirect path | same |

**Who effectively holds `service_role` or `postgres` in production:**
- every Edge Function in the project;
- dashboard members (keys visible to developers and above; changes need Owner or
  Administrator);
- the saved Management API token, which can run SQL with full database rights.

Recommendation: revoke that token when it is no longer needed. **Not done; you asked
to keep it for now.**

## 5. `pg_net` *(tested)*

Installing `pg_net` fires Supabase's event trigger `issue_pg_net_access`, which grants
`anon`, `authenticated` and `service_role`:
- `EXECUTE` on `net.http_get` / `net.http_post`;
- **SELECT, INSERT, UPDATE and DELETE on `net.http_request_queue` and
  `net._http_response`**.

The grants are owned by `supabase_admin`; `postgres` cannot revoke them.

| Risk | Reachable today? |
|---|---|
| Server-side requests from the database to arbitrary URLs | Only for code that can run SQL as those roles. Schema `net` is **not** exposed over the API *(tested: 406)*, and no `anon`/`authenticated` `SECURITY DEFINER` function uses dynamic SQL *(tested)*. |
| Reading the trigger secret while it waits in the request queue | Same condition |
| Becomes exploitable if… | `net` is ever added to the exposed schemas; a future `SECURITY DEFINER` function has SQL injection; `pg_graphql` exposure changes (to confirm production's extension list) |

**Verdict:** not an immediate hole, but a permanent widening of what any future SQL
injection could do (outbound HTTP from inside the database).

**Production does not have `pg_net` today.** With R2, the schedule (`pg_cron` +
`pg_net`) lives in the **runner** project, so **production never needs `pg_net`**.
The daily health check is pure SQL and needs only the existing `pg_cron`.

If R1 is kept, the safer trigger is an external scheduler that sends only the trigger
secret: e.g. a GitHub Actions workflow, whose compromise only causes extra backup
runs.

## 6. Impact of each compromised secret, separately

| Compromised | Attacker can | Attacker cannot | Detection / recovery |
|---|---|---|---|
| **`age` private key** (encryption key) | Decrypt **every backup** made to that key that they can obtain: all retained runs (35 days), plus any copy they took earlier. Needs the ciphertext too, i.e. the read key or provider access. | Change or delete backups; access production | Not detectable. Generate a new key pair and update the public key; old runs expire after 35 days. Data already taken stays exposed. |
| `age` public key **replaced** (attacker can edit function secrets) | Make future backups decryptable by them only | Affect earlier backups | **New mitigation M6:** record the recipient fingerprints in the manifest and have the verify page warn when they differ from yours |
| **Storage write (upload) key** | Upload new objects: garbage, fake "newer" runs, cost or quota exhaustion | Read, list, overwrite (412 / new version only), delete, or change lock and lifecycle *(tested in the simulator)* | Restore uses the version IDs and hashes recorded in production → fakes are ignored *(tested)*. Rotate the key; set a provider spending cap (to confirm). |
| **Storage read key** | Download all retained **ciphertext**; see sizes, times and table row counts (manifest) | Decrypt, delete or overwrite | Rotate the key. Harmless without the `age` private key. |
| Trigger secret | Start extra runs (one at a time; a stale run times out after 20 min) | Read any data | Rotate in Vault (R1) or in the runner project (R2) |
| **Backup token** (R2 + D1) | **Read all production data and download all files** (plaintext) | Modify or delete anything; Auth admin; Vault; buckets; existing backups | Delete the hash row → instantly refused *(tested)*. Data already read stays exposed. |
| **Backup function, current design (R1)** | Everything in §2.2: **full production project**, including modification and deletion | Existing off-site backups; decryption | Same as compromising any existing function |
| **Backup function, recommended design (R2)** | Read-only exfiltration of data and files; stop or falsify **future** backups (it reports its own success) | Modify or delete production data or files; Auth admin; Vault or cron in production; existing backups; decryption | Revoke the token. Falsified runs are caught by the quarterly drill (you decrypt with your own key). |
| Storage provider account (your own login) | Change settings; with compliance lock, objects still cannot be deleted before expiry (to confirm, including account closure) | Decrypt | Provider 2FA |

## 7. Threat model

**Assets:**
- production data, including legacy patient records;
- stored case files;
- user accounts;
- the backups themselves;
- the private key.

**Adversaries and entry points:**
1. **Supply-chain compromise** of a function dependency (`age-encryption`,
   `aws4fetch`, the Deno standard library) or of a dependency of an existing function.
2. **Code bug** in the backup function, e.g. malformed input from Storage or the
   off-site provider.
3. **Leaked runner configuration** (dashboard member, screenshot, mistaken paste).
4. **Internet attacker** calling the public endpoint or the `anon`-callable RPC
   (brute-forcing a 256-bit token is infeasible; no rate limit, so cheap repeated calls
   are possible).
5. **Supabase or provider platform compromise:** out of scope, and outside your
   control in every option.
6. **Your own Supabase account taken over:** controls both projects in every option;
   2FA is the mitigation.

**Attack scenarios:**

| # | Scenario | R1 (current) | R2 + D1 + S1 (recommended) |
|---|---|---|---|
| A1 | Malicious update of a dependency | Excluded by pinned versions only if a lock file is committed (F6) | Same; impact limited to read-only |
| A2 | Attacker reads the environment, then deletes patient cases and the audit log | **Possible** | Impossible (no write credential) |
| A3 | Attacker makes the case-file bucket public | **Possible** | Impossible |
| A4 | Attacker exfiltrates all data and files | Possible | Possible: inherent in any backup agent; revoke the token |
| A5 | Attacker deletes off-site backups | Impossible (lock) | Impossible |
| A6 | Attacker silently stops backups | Possible | Possible; caught by the health check only if it records honestly → quarterly drill |
| A7 | Server-side request abuse through `pg_net` after a future SQL injection | Possible once `pg_net` is installed | Not applicable (no `pg_net` in production) |
| A8 | Plaintext processed outside the EU | Possible (region not pinned) | Prevented by `x-region: eu-west-2` on every invocation |

## 8. Findings

| # | Finding | Severity | Mitigation |
|---|---|---|---|
| F1 | The default secrets (`SUPABASE_DB_URL`, service and secret keys) are injected into **every** Edge Function; not reading them gives no protection against a compromised function | **High** | R2 runner + D1/S1 narrow access |
| F2 | The service key can bulk-delete tables, erase the audit log, delete files and make private buckets public *(tested)* | High (existing exposure for the 3 current functions) | Keep functions small; review the dependencies of existing functions (separate task) |
| F3 | Function secrets are per project: storage keys would be readable by all functions | Medium | R2 (keys live only in the runner project) |
| F4 | Installing `pg_net` grants `anon`/`authenticated` access to outbound HTTP and the request queue *(tested)* | Medium-Low | Do not install `pg_net` in production (R2), or use an external trigger |
| F5 | Edge Functions run in the region closest to the caller unless `x-region` is sent | Medium (GDPR: health data) | Send `x-region: eu-west-2` on every invocation |
| F6 | No `deno.lock` for the function | Low-Medium | Commit a lock file for the backup function |
| F7 | `anon` 3 s timeout limits D1 | Low today (≈ 1 s at 25 MB) | Monitor duration; split the snapshot or move to D4 when needed |
| F8 | A compromised runner can report false success | Low-Medium | Quarterly drill; manifest recipient fingerprints (M6) |
| F9 | The Management API token can run SQL with full database rights | Medium | Revoke when no longer needed (your decision) |
| F10 | Header values may appear in API gateway logs | Low (to confirm) | Rotate the token if exposed; logs stay within Supabase |

## 9. Final recommendation

1. **Do not deploy the backup function into the production project in its current
   form.** Its compromise would equal a full project compromise (F1). The existing
   off-site backups would survive, but production data could be altered or deleted.
2. **Adopt R2 + D1 + S1:**
   - a separate "backup runner" Supabase project (EU London, region pinned) runs the
     function and its own `pg_cron` / `pg_net` schedule;
   - production receives only:
     - the token-gated, read-only snapshot and bookkeeping RPCs;
     - one token-gated read policy on Storage;
     - the pure-SQL health check;
   - production gets **no `pg_net`** and **no new privileged code**;
   - the runner holds **no production service key and no production database
     password**.
3. **Repository changes needed (Phase 1b, not started; needs your approval):**
   - convert the RPCs to token-gated `anon` access and add the Storage policy;
   - drop `pg_net` and the schedule from the production migration;
   - the function uses the production anon key + token instead of the service key;
   - `x-region` pinning (F5);
   - recipient fingerprints in the manifest and a warning in the verify page (M6);
   - a committed `deno.lock` (F6);
   - re-run all tests, including §D of the audit script as permanent tests.
4. **Fallback if you do not want a second project:** keep R1 but accept F1 explicitly:
   - pin the region;
   - trigger from an external scheduler instead of `pg_net`;
   - commit the lock file.

   Risk then equals that of the existing functions.

### Costs and external dependencies (ALL UNVERIFIED)

| Item | Assumption | To confirm |
|---|---|---|
| Second Supabase project (runner) | Free tier may suffice. Free projects are paused after inactivity; whether a daily `pg_cron` run counts as activity is unknown. Otherwise one more paid project (organization compute pricing). | Supabase pricing and pausing rules |
| Edge Function invocations and duration | Within quota (1–2 runs/day, ≈ 1–2 s of database time) | Plan limits |
| Storage provider (B2 or R2, EU) | Unchanged from `SECURITY-REVIEW.md` §8 | Same |
| GitHub Actions (only for the R1 fallback trigger) | Free minutes suffice; scheduled runs can be delayed and are disabled after repository inactivity | GitHub documentation |
