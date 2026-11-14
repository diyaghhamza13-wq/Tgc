# Backup Runner — architecture, verification and activation

**Status (2026-11-14): ready for activation.** Everything that can be built and
verified without your accounts is done and tested:
- 161 end-to-end checks;
- 18 offline-page checks;
- 7 checks in the real Supabase Edge Runtime with the hosted limits enforced;
- 7 performance checks;
- 45 audit checks;
- all earlier suites.

What remains needs **your accounts and your approval** (§6).

**Nothing has been created, applied, deployed or changed** in production or in any
external service.

**Related documents:**
- [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md): threat model, findings, evidence;
- [`SERVICE-ROLE-AUDIT.md`](SERVICE-ROLE-AUDIT.md): why the runner is a separate project.

## 1. Architecture

```
 PRODUCTION project (London)                         BACKUP RUNNER project (own free org, London)
 ───────────────────────────                         ─────────────────────────────────────────────
 dlm_backup_reader  NOLOGIN, read-only               pg_cron (+ pg_net), every call x-region: eu-west-2:
   owns dlm_backup_snapshot() (SECURITY DEFINER)        02:17 daily "backup"  · every 3 min "continue"
 dlm_backup.runner_tokens: SHA-256 hashes only          Sun 04:27 "verify"    · 03:47 health (SQL)
                                                       │
 dlm_backup_runner_snapshot() ◄─ GET ─┐                ▼
 dlm_backup_runner_objects()  ◄─ GET ─┤   Edge Function dlm-backup, in BOUNDED STEPS:
   anon key + x-dlm-backup-token        │     step 1: snapshot (≤ 20 MB) + encrypted object list
 Storage: DOWNLOAD only with the token ◄┘     next steps: files, 16 MB encrypted segments, ≤ 32 MB per step
   (incl. HTTP range requests)                 last step: encrypted file map + manifest
                                               each step ≤ ~1 s CPU, ≤ ~150 MB (limits: 2 s, 256 MB)
 NO pg_net · NO cron · NO write RPC            lease: one step at a time; a dead step is resumed
                                                       │ ciphertext only
                                                       ▼
          Backblaze B2, EU Central: Object Lock (compliance, default 35 days), lifecycle
          (hide after 35 d, delete 1 d later; locked versions cannot be deleted)
          runner keys: WRITE (writeFiles only) · READ (readFiles, readFileRetentions)
```

**Run layout in the bucket:**

| Key | Content |
|---|---|
| `runs/<stamp>-<id>/db.json.age` | Database snapshot |
| `runs/<stamp>-<id>/objects.json.age` | Stored-file list, including names |
| `runs/<stamp>-<id>/files.json.age` | Encrypted copies per file, by id |
| `runs/<stamp>-<id>/manifest.json` | Plaintext: counts, SHA-256 values, version ids, public keys |
| `files/<object-id>/<stamp>-<id>.<seq>.age` | One per 16 MB segment of a stored file; re-copied every 28 days, inside the 35-day lock |

Everything is `age`-encrypted to your public key(s) except the manifest. Names never
appear in object keys or in the runner database.

## 2. What was verified, and how

| Question | Result | Source / evidence |
|---|---|---|
| Hosted Edge Function limits | 2 s CPU per request; 256 MB memory; wall clock 150 s (free) / 400 s (paid); bundle ≤ 20 MB (CLI) or 5 MB (server-side) | supabase.com/docs/guides/functions/limits (updated 29 Oct 2026) |
| Does the runner fit? | **Yes**, per step: max **1,010 ms CPU**, **≤ 151 MB** heap + buffers. Measured with 15 MB of app tables, 4 × 8 MB files, a 100 MB file (4 steps), and the daily run. | `backup-runner-perf-local.mjs` |
| …in the real Supabase runtime? | **Yes.** Run inside `supabase/edge-runtime:v1.77.9` as a user worker with 256 MB / 2 s / 150 s enforced. Backup with a 40 MB file (3 segments), weekly check and self-test all completed with no limit event. Negative control: a 100 ms CPU limit gives "CPU time limit reached". | `backup-runner-edge-runtime-local.mjs` |
| Bundle and lock file | The Supabase bundler (edge-runtime v1.77.9) bundles the function to **3.9 MB** and **enforces `deno.lock`** (lock format v5): a tampered integrity hash is rejected. | Local bundle test |
| Hosted Storage: download-only policy | `storage.allow_only_operation()` exists since Storage tenant migration **0058** (storage-api v1.77.x, Sept 2026); hosted projects receive Storage migrations automatically. The production migration **aborts with no change** if the helper is missing *(tested)*. | github.com/supabase/storage `migrations/tenant/0058-operation-ergonomics.sql` |
| Storage passes the header to policies; range downloads allowed | Yes (Storage v1.88.0 locally): token header and JWT role are visible to the policy; operation `object.get_authenticated` covers full and range downloads; signed URLs are refused *(tested)* | e2e §1, §11b |
| B2 Object Lock | Compliance mode; **default bucket retention** locks every upload automatically (must be set up when the bucket is created); compliance retention can't be removed by anyone; **lifecycle cannot delete locked files**; no extra cost | backblaze.com/docs/cloud-storage-object-lock |
| B2 versioning / S3 API | PutObject returns `x-amz-version-id`; GetObject by `versionId`; ListObjectVersions (`?versions`); SigV4 only; HTTPS only; one region per account | backblaze.com/apidocs (s3-put-object, s3-get-object, s3-list-object-versions, introduction) |
| B2 conditional writes (`If-None-Match`) | **Not documented**, so the design no longer uses them. Keys are unique, and restore reads the first version of every key. | backblaze.com/apidocs/s3-put-object |
| B2 key scopes | Keys can be restricted to one bucket with chosen capabilities (`writeFiles`, `readFiles`, `listFiles`, `deleteFiles`, `readFileRetentions`…). `writeFiles` can also *hide* files (delete markers); locked versions remain. **Tested as an attack:** a hidden file map and file copy are still restored. | backblaze.com/docs/cloud-storage-application-keys; e2e §5, §10 |
| B2 lifecycle | `daysFromUploadingToHiding` + `daysFromHidingToDeleting` per prefix | backblaze.com/docs/cloud-storage-lifecycle-rules |
| Remaining B2 behaviour (exact key capabilities on a lock-enabled bucket, retention headers) | Checked **automatically at activation** by the runner's self-test: 11 checks, pass/fail recorded *(tested here against the simulator and in the real runtime)* | §5 |

## 3. Decisions taken

1. **Storage provider:** Backblaze B2, **EU Central** region (chosen when the account is
   created). Cloudflare R2 was not chosen: no documented version listing.
2. **Runner project:** its own **free Supabase organization**, London region.
   - Free and paid projects can't share an organization, and free projects are limited
     to 2 active per owner/admin.
   - A separate organization also keeps production's members away from the runner.
   - Free projects pause after 7 days of low database activity. The 3-minute
     "continue" call makes a database API call every time, and Supabase emails a
     warning a week before any pause.
3. **Bounded steps** (§1) instead of one long run, so the 2 s CPU and 256 MB limits hold
   for any file up to the app's 500 MB maximum.
4. **Snapshot limit of 20 MB** (≈ 170 MB peak), with a health alert from 15 MB onward.
   Production today: 16 MB for the whole database including system catalogs. Above
   20 MB, the snapshot must be split per table (future work, flagged by the alert).
5. **No conditional writes.** Tamper resistance comes from versioning + compliance lock
   + "first version wins" in restore.
6. **Activation self-test** instead of a manual checklist.

## 4. Token lifecycle (production access)

- **Format:** `dlmbk1_` + 64 hex characters (256 random bits).
- **What production stores:** only `sha256(token)`, plus label, expiry (≤ 400 days;
  default 365) and revocation time.

| Action | How |
|---|---|
| Create | Offline page section 1b, or `node scripts/backup/runner-token.mjs <file>`. The token goes **only** into the runner secret `DLM_PROD_BACKUP_TOKEN`. |
| Register | Production: `select dlm_backup.register_token('<hash>', '<label>');` (the page prints this line; it contains only the hash) |
| Check | `select * from dlm_backup.token_status;` |
| Rotate (yearly) | New token → register (two may be active) → replace the runner secret → one successful run → `select dlm_backup.revoke_token('<old id>');` |
| Revoke / emergency stop | `revoke_token(id)` / `revoke_all_tokens()` take effect on the next request *(tested)* |

## 5. Activation self-test (mode `selftest`)

**What it checks:** run once after deployment against the **real** bucket and production.
It records each check as pass/fail in the runner database, with no names and no data:
1. production read access with the token;
2. write key uploads and gets a version id;
3. write key cannot read;
4. write key cannot list;
5. write key cannot list versions;
6. write key cannot delete a version;
7. read key reads the pinned version (hash compared);
8. **compliance lock ≥ 34 days** on the new object (B2 retention headers);
9. read key cannot list;
10. read key cannot delete a version;
11. hiding a key keeps its locked version.

**Expected outcome:**
- Any failure stops activation, with the failed checks named.
- Tested: an over-powerful storage key makes it fail with `write_key_cannot_read`,
  `write_key_cannot_list`.

## 6. Exact production steps (none done)

**Steps only you can do** (accounts, payment details, secrets; no data leaves production):

| # | Step |
|---|---|
| Y1 | **Backblaze:** create an account with region **EU Central**, then enable two-factor authentication. |
| Y2 | **Bucket:** private; name e.g. `dlm-backups-<random>`; **Object Lock: enabled**; **default retention: Compliance, 35 days** (must be set when the bucket is created); lifecycle rule `fileNamePrefix ""`, `daysFromUploadingToHiding 35`, `daysFromHidingToDeleting 1`. |
| Y3 | **Two application keys, restricted to that bucket:** **runner-write** with only `writeFiles`; **runner-read** with only `readFiles` + `readFileRetentions`. Do not create a key with `deleteFiles` or `listFiles`; the restore key is created only when restoring. |
| Y4 | **Offline page** (`docs/backup/tools/backup-tool.html`): create the encryption key pair and save the private key in your password manager and on paper; then create a runner token and keep its SQL line. |
| Y5 | **Supabase:** create a new **free organization** "DLM Backup Runner", then a project in **London (eu-west-2)**, with 2FA on your account. |
| Y6 | **Runner project → Edge Functions → Secrets**, set exactly these: `DLM_PROD_URL` = `https://slfwakmskshkbrfqqfwl.supabase.co`, `DLM_PROD_ANON_KEY` = production's **anon / publishable** key (never the service key: the function refuses it), `DLM_PROD_BACKUP_TOKEN` = the token, `DLM_BACKUP_AGE_RECIPIENTS` = your public key, `DLM_BACKUP_S3_ENDPOINT` = `https://s3.eu-central-003.backblazeb2.com` (as shown on your bucket), `DLM_BACKUP_S3_REGION` = `eu-central-003`, `DLM_BACKUP_S3_BUCKET`, `DLM_BACKUP_S3_WRITE_KEY_ID` / `_WRITE_SECRET`, `DLM_BACKUP_S3_READ_KEY_ID` / `_READ_SECRET`. |

**Steps I can do after your explicit approval** (through the Supabase Management API
access this environment already has; the runner project's hostname must be added to
the network allowlist):

| # | Step | Reversible by |
|---|---|---|
| A1 | **Production:** apply `supabase/migrations-pending/20261115090000_backup_read_access.sql` (moved to `supabase/migrations/`). Its pre-check stops it without changes if hosted Storage lacks the helper. | `REMOVE_backup_read_access.sql` |
| A2 | **Production:** run your `select dlm_backup.register_token('<hash>', …)` line (hash only) | `revoke_token` |
| A3 | **Runner:** apply `backup-runner/supabase/migrations/20261115090100_runner_state.sql`; deploy `dlm-backup` with `verify_jwt = false` (bundle with `deno.lock`) | Delete the project |
| A4 | **Runner:** store the function URL in Vault; apply `backup-runner/supabase/schedule.sql` | `cron.unschedule` |
| A5 | **Runner:** invoke `selftest`; all 11 checks must pass | — |
| A6 | **Runner:** invoke the first `backup`; follow it to `succeeded` (the 3-minute job continues it) | — |

**After activation:**

| # | Step |
|---|---|
| Y7 | **Drill:** download that run's `manifest.json` and `db.json.age` from the B2 web interface; verify them on the offline page ("OK — … Encrypted to your key only."). Repeat quarterly. |
| P | Privacy policy: name Backblaze (EU Central) and the runner project as storage location / processor. Separate approval to publish. |

## 7. Restore (disaster)

1. **Create a restore key:** bucket only, `readFiles` + `listFiles` (+ `readFileRetentions`).
2. **Fetch and verify:** `node scripts/backup/offsite-restore.mjs fetch runs/<id> --write-plain`.
   - Reads the **first version** of every object and reports later ones.
   - Verifies the snapshot's SHA-256 and the row counts.
   - Warns about files deleted mid-run, or extra encryption keys.
3. **Restore the database:** `node scripts/backup/restore.mjs backup.json manifest.json > restore.sql`,
   then `psql -X -f restore.sql`.
4. **Restore the files:** `offsite-restore.mjs restore-files runs/<id>`. It reassembles
   segmented files and checks every hash (production service key, on your computer).
5. **Clean up:** delete the plaintext files and the restore key.

**Phone (offline page):** verify a run, generate `restore.sql`, decrypt single files.

## 8. Costs (verified 2026-11-14 on the providers' pages)

| Item | Price | Expected |
|---|---|---|
| Runner Supabase project, free organization | $0 (Free plan: 2 active projects per owner/admin; 500,000 Edge Function invocations/month) | ~15,000 invocations/month (every 3 min + daily) → **$0** |
| Production plan | Unchanged. (Pro, if ever wanted: from $25/month per organization incl. $10 compute credits; daily managed backups, 7 days.) | — |
| Backblaze B2 | First **10 GB free**; then $6.95/TB/month; Class A/B/C API calls free; egress free up to 3× stored; no minimum duration; Object Lock free | ≈ 1–3 GB → **$0** |
| npm `age-encryption@0.3.1`, `aws4fetch@1.0.20`, `esbuild@0.28.2` | Open source (BSD-3-Clause / MIT / MIT) | $0 |

**Not verified:** Backblaze's data-processing addendum (GDPR). Check it when creating the
account (Y1).
