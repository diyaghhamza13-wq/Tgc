# Backup Runner — architecture, setup and operation (Phase 1b)

**Status:** implemented in the repository and tested locally on 2026-11-14.

**Nothing has been created, applied, deployed or changed** in production or in any
external service. Each production step in §5 needs your separate approval.

**Related documents:**
- [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md): threat model, findings, test evidence;
- [`SERVICE-ROLE-AUDIT.md`](SERVICE-ROLE-AUDIT.md): why the runner is a separate project;
- [`AUTOMATED-BACKUP-DESIGN.md`](AUTOMATED-BACKUP-DESIGN.md): the original design and the
  alternatives considered.

## 1. Architecture

```
 PRODUCTION project (London)                       BACKUP RUNNER project (separate, London)
 ─────────────────────────────                     ─────────────────────────────────────────
 role dlm_backup_reader  NOLOGIN, read-only        pg_cron  02:17 daily  / Sun 04:27 verify
   owns dlm_backup_snapshot() (SECURITY DEFINER)      │  pg_net POST, headers:
 dlm_backup.runner_tokens: SHA-256 HASHES only        │   x-dlm-backup-trigger (Vault secret)
                                                      │   x-region: eu-west-2
 dlm_backup_runner_snapshot()   ◄── GET ──────────┐   ▼
   anon key + x-dlm-backup-token; read-only       │ Edge Function dlm-backup
 Storage policy: DOWNLOAD only, with the token ◄──┤   • refuses to run outside eu-west-2,
   (no list, info, signed URLs, writes)            │     inside production, or with a
                                                   │     service/secret key as "anon key"
 NO pg_net · NO cron jobs · NO write RPC           │   • reads production: GET only
                                                   │   • encrypts with age to YOUR public key
                                                   │   • run log + file bookkeeping in the
                                                   │     runner's OWN database (ids, hashes)
                                                   ▼
                       Off-site bucket, EU (B2 recommended): versioning + Object Lock
                       (compliance, 35 d) + lifecycle 35 d; runner key = WRITE ONLY
```

**What each side holds:**

| Holder | Credentials |
|---|---|
| Production | The **hash** of each runner token (cannot be turned back into the token). Nothing from the runner. |
| Runner project | Its own Supabase keys (useless against production); production's **public** anon key; the backup token (read-only, revocable); a write-only storage key; an optional read-only storage key; your **public** encryption key. **No** production service key, **no** production database password. |
| You only | The `age` **private** key; the **restore** storage key (read + list versions), created only when you restore; the production SQL editor (to register and revoke tokens). |

## 2. Repository layout

| Path | What |
|---|---|
| `supabase/migrations-pending/20261115090000_backup_read_access.sql` | **Production**, pending, not applied: backup role, snapshot, token store, token functions, Storage download policy |
| `supabase/migrations-pending/REMOVE_backup_read_access.sql` | Production removal |
| `backup-runner/supabase/config.toml` | Runner project configuration (local ports 54331/54332; `verify_jwt = false`) |
| `backup-runner/supabase/migrations/20261115090100_runner_state.sql` | **Runner** database: run log, file bookkeeping, RPCs (runner service role only), trigger secret, health check |
| `backup-runner/supabase/schedule.sql` | **Runner** schedule (`pg_cron` + `pg_net`, `x-region: eu-west-2`) |
| `backup-runner/supabase/functions/dlm-backup/` | The function: `index.ts`, `deno.json`, **`deno.lock`** (pinned dependencies with integrity hashes) |
| `tools/backup-tool/` → `docs/backup/tools/backup-tool.html` | Offline page: encryption key pair, **runner token**, verify a run, `restore.sql`, decrypt files |
| `scripts/backup/runner-token.mjs` | Token generator for a computer (alternative to the offline page) |
| `scripts/backup/offsite-restore.mjs` | Disaster recovery; reads the **first** version of every object |
| `scripts/tests/automated-backup-local-test.sh` | End-to-end and security test: two local stacks, recording proxy, storage simulator |

## 3. Token lifecycle

**Format:** `dlmbk1_` + 64 hex characters (256 random bits).

**What production stores:** only `sha256(token)`, plus label, expiry (at most 400 days;
default 365) and revocation time.

| Action | How |
|---|---|
| **Create** | Offline page, section 1b, or `node scripts/backup/runner-token.mjs <file>`. The token goes **only** into the runner project's function secret `DLM_PROD_BACKUP_TOKEN`. |
| **Register** | Production SQL editor: `select dlm_backup.register_token('<hash>', '<label>');`. The page and the script print this line; it contains the hash, never the token. A plaintext token is refused. |
| **Check** | `select * from dlm_backup.token_status;` shows label, a 12-character hash prefix, expiry, revoked, active. |
| **Rotate** (yearly, or after any doubt) | 1. Create a new token. 2. Register its hash (two may be active at once; a third is refused). 3. Replace the runner secret. 4. Confirm one successful run. 5. `select dlm_backup.revoke_token('<old id>');`. |
| **Revoke** | `select dlm_backup.revoke_token('<id>');` takes effect on the next request (tested: snapshot and downloads refused at once). |
| **Emergency stop** | `select dlm_backup.revoke_all_tokens();` cuts the runner off from production completely. |
| **Expiry** | An expired token is refused like a revoked one. The runner's daily health check then raises an alert after 26 hours without a successful backup. |

**Validation, in the database (`dlm_backup.token_valid()`), fails closed.** A token is
accepted only when all of these hold:
- the request headers and JWT claims are present and well-formed;
- the role is `anon` (a logged-in app user, or the service key, sending the token is
  refused);
- the token has the exact format and its hash matches an active, unexpired row.

## 4. What the runner can and cannot do in production

| Can | Cannot |
|---|---|
| Call `dlm_backup_runner_snapshot()` (read-only, all tables, all storage object metadata) | Call any other backup function; read any table directly; insert, update or delete anything |
| Download any stored file by its exact path | List files, read object details, create signed URLs, upload, overwrite, move, copy or delete files, change buckets |
| | Use the Auth admin API, Vault, cron, or anything needing the service key |

**Requests to production:** the function sends only `GET` requests, without following
redirects, carrying the anon key and the token. Tested through a recording proxy: every
request was a `GET` to the snapshot or a download, with exactly those two credentials.

## 5. Production actions (none done; each needs your approval)

| # | Action | Who | Notes |
|---|---|---|---|
| P1 | Create the off-site bucket (B2 EU Central): versioning, Object Lock compliance 35 days, lifecycle 35 days. Keys: **runner write** (write files only), **runner read** (read files only, optional), and later the **restore** key (read files + list file versions, only when restoring). | You | Check that B2 behaves as simulated (S10 in `SECURITY-REVIEW.md`) |
| P2 | Generate the encryption key pair on the offline page; private key into your password manager and on paper | You | |
| P3 | Create the **Backup Runner** Supabase project, region **eu-west-2 (London)**, with 2FA on the account | You | External account/project: separate approval |
| P4 | Apply `backup-runner/supabase/migrations/20261115090100_runner_state.sql` to the **runner** project | Runner | No production data involved |
| P5 | Set the runner function secrets: `DLM_PROD_URL`, `DLM_PROD_ANON_KEY` (production **anon** key), `DLM_BACKUP_AGE_RECIPIENTS`, `DLM_BACKUP_S3_*` | You | Never the production service key: the function refuses it |
| P6 | Deploy `dlm-backup` to the **runner** project (`verify_jwt = false`, with `deno.lock`) | Runner | Check that the Supabase bundler accepts lock file v5 |
| P7 | Apply `supabase/migrations-pending/20261115090000_backup_read_access.sql` to **production** | Production | Creates the `NOLOGIN` role, the token store, read-only functions and the download policy |
| P8 | Generate a token; register its hash in production; put the token into the runner secret `DLM_PROD_BACKUP_TOKEN` | You | |
| P9 | Run one backup by hand; verify it on the offline page (drill) | You | |
| P10 | Store the function URL in the runner's Vault, then apply `backup-runner/supabase/schedule.sql` to the **runner** | Runner | |
| P11 | Privacy policy: name the runner project and the bucket provider as processors and storage locations | Publish | After P9 |

**Removal:**
- **Production:** `REMOVE_backup_read_access.sql`, or just
  `revoke_all_tokens()`.
- **Runner:** delete the project.
- **Bucket:** objects expire after 35 days.

## 6. Restore (disaster)

1. Create the **restore** key (read + list versions) for the bucket.
2. Run
   `node scripts/backup/offsite-restore.mjs fetch runs/<id> --write-plain`.
   - Every object is read in its **first** version. Later versions, which only a
     compromised runner could have added, are reported and ignored.
   - The tool refuses to run if the key cannot list versions (`--trust-latest` overrides
     this, at your risk).
3. Run `node scripts/backup/restore.mjs backup.json manifest.json > restore.sql`, then
   `psql -X -f restore.sql`.
4. Run `offsite-restore.mjs restore-files runs/<id>`. This uploads the files with
   production's service key, **on your computer**.
5. Delete the plaintext files and the restore key.

**From a phone:** the offline page verifies a run, produces `restore.sql` and decrypts
single files.
- Download the original version of each object from the provider's web interface.
- The page warns if a run was also encrypted to someone else's key.

## 7. Costs and external dependencies: ALL UNVERIFIED until confirmed

| Item | Assumption | To confirm |
|---|---|---|
| Second Supabase project (runner), London | Free tier might suffice, but free projects are paused after a period of inactivity (does a daily cron run count?). Otherwise a paid plan or compute add-on. | Supabase pricing and pausing rules |
| Edge Function on the runner | 1–2 invocations/day, a few seconds each, within quota | Plan limits (duration, memory) |
| `x-region` / `SB_REGION` | Behave as documented (docs read from the Supabase docs source on GitHub, 2026-11-14) | Hosted behaviour |
| Storage `request.headers` and `storage.allow_only_operation()` in policies | Available as on the local Storage v1.88.0 | Hosted Storage version |
| `deno.lock` v5 accepted by the Supabase deploy bundler | Unknown | Deploy dry run |
| Backblaze B2 EU (or Cloudflare R2) | ≈ $0 within the free allowance; versioning, compliance lock, lifecycle, write-only keys, version listing | Provider pricing and docs. R2 version listing is unknown, so B2 is preferred. |
| npm `age-encryption@0.3.1` (BSD-3-Clause), `aws4fetch@1.0.20` (MIT), `esbuild@0.28.2` (MIT) | Free | Licences at the pinned versions |
