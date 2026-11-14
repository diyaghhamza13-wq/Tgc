# Automated backup — architecture and implementation plan (proposal)

> **Status: design only.** Nothing described here has been created, deployed or
> changed. Every production action listed in §8 needs your explicit approval.
>
> **This supersedes the phone-based procedure:** no Termux, no routine phone
> operations. The phone-based scripts stay in the repository but are no longer the
> recommended path.
>
> **Verification limit:** Supabase's documentation and pricing pages could not be
> opened from this environment (supabase.com is not in the session's network
> allowlist). Points marked **(to confirm)** come from general knowledge and must be
> checked against the current Supabase, Backblaze or Cloudflare pages before approval.

## 1. Production facts this design is based on (read-only, 2026-11-14)

| Item | Production |
|---|---|
| Plan | No Supabase-managed backups available (backup list empty, PITR off). Consistent with the Free plan. |
| Size | Database 16 MB; stored files 32 MB in 4 objects (buckets `case-files` private, `lab-assets` public) |
| Scheduler | `pg_cron` active (job `dlm-deadline-scan`, hourly) |
| HTTP from the database | `pg_net` 0.20.4 available, **not installed** |
| Secret store | `supabase_vault` installed, 0 secrets |
| Edge Functions | `employee-login`, `register-lab`, `manage-employee` (all active) |
| Statement logging | `log_statement = ddl` (plain passwords in DDL would be logged) |
| TLS | Server TLS ≥ 1.2; **SSL enforcement off** (unencrypted client connections are accepted) |
| `postgres` role | `CREATEROLE`, `BYPASSRLS` (can create the backup role); not a superuser |

## 2. Alternatives investigated

| # | Option | How it works | Encryption before storage | Manual work | Main weakness |
|---|---|---|---|---|---|
| O1 | **Supabase-managed daily backups** (paid plan) | Supabase snapshots the whole database daily | By Supabase at rest; **not** encrypted with your key | None; restore by dashboard click | Same provider and account as the live data; short retention (to confirm: 7 days on Pro); **stored files not included** (to confirm) |
| O2 | O1 + Point-in-Time Recovery | Continuous WAL archiving; restore to any second | Same as O1 | None | Expensive add-on (to confirm: ≈ $100/month and up) for a 16 MB database |
| O3 | **Scheduled Edge Function → encrypted off-site copy** | `pg_cron` triggers a Supabase Edge Function daily. It reads the database **as a read-only role**, encrypts in memory to **your public key**, and uploads to an independent, write-only, immutable bucket. | **Yes, before storage, with your key** | None routinely; one-time key creation in a browser (§4) | Code we maintain; restore and decrypt need your private key |
| O4 | GitHub Actions scheduled workflow (`pg_dump` + `age` + upload) | GitHub runner connects to the database with a stored DB credential | Yes | None | Plaintext on GitHub's runners; a database credential stored at GitHub; runners lack IPv6 (pooler needed); the repository may be public |
| O5 | Phone-based (Termux) | — | Yes | Routine manual work | **Rejected by you** |
| O6 | This cloud AI session runs the export | — | Yes | — | **Rejected:** an AI session would handle plaintext |

**Recommendation: O1 + O3 together.**
- **O1** is the fast, zero-maintenance restore for everyday accidents. It also covers the full database, including Auth accounts.
- **O3** is the independent, client-side-encrypted, immutable off-site copy. It also covers file contents. It protects against loss of the Supabase project or account, ransomware, and mistakes that O1's short retention would miss.

**Budget alternative: O3 alone.** It runs on the Free plan (to confirm: Edge Functions and `pg_cron` are available on Free), but then there is no one-click restore.

## 3. Recommended architecture (O1 + O3)

```
                ┌─────────────── Supabase (app project, London) ────────────────┐
 daily 02:17 →  │ pg_cron ──pg_net HTTP POST (+ trigger secret from Vault)──┐    │
                │                                                            ▼    │
                │  Edge Function "dlm-backup"  (no JWT; checks trigger secret)   │
                │   1. connect to Postgres, SET ROLE dlm_backup_reader (NOLOGIN, │
                │      read-only); verify privileges, TLS, RLS bypass            │
                │   2. one read-only SELECT snapshot → JSON in memory            │
                │   3. new/changed stored files → read via Storage API           │
                │   4. encrypt in memory: age (X25519) to YOUR public key(s)     │
                │   5. upload ciphertext only → off-site bucket (write-only key) │
                │   6. re-download, compare SHA-256; write a run record          │
                │      (counts and hashes only) into public.backup_runs          │
                │  Daily managed backups (O1, paid plan) ── Supabase storage     │
                └────────────────────────────────────────────────────────────────┘
                                                │ ciphertext only
                                                ▼
           Off-site object storage, EU region (Backblaze B2 EU Central, or Cloudflare R2 EU)
           • Object Lock / bucket lock (compliance mode, 35 days): nobody can delete or overwrite
           • Lifecycle: objects deleted automatically after 35 days → retention is operational
           • Application key: write-only (no list, read or delete)

 Your private key: only in your password manager (+ a paper copy). Never in Supabase,
 never in the off-site storage, never in this chat or in Claude.
```

### 3.1 Data read path — least privilege, no new login
- **Role `dlm_backup_reader` is created `NOLOGIN`.** It has the same read-only grants as
  the previous proposal, but **no password at all**, so it **cannot be used from the
  internet**. This removes the earlier risk of an internet-reachable read-everything
  login (R11).
- **The function connects with the database URL** that Supabase provides to Edge
  Functions (`SUPABASE_DB_URL`, to confirm). It immediately runs
  `SET ROLE dlm_backup_reader` inside a `READ ONLY` transaction.
  - `postgres` is granted membership with `SET` but without `INHERIT`
    (`grant dlm_backup_reader to postgres with inherit false, set true`), so nothing
    changes for normal `postgres` sessions.
- **Before reading**, the function runs the existing checks (`lib.mjs`
  `LOGIN_CHECK_SQL`, adapted to Deno) as `dlm_backup_reader`: no write, `CREATE`,
  `SECURITY DEFINER`, `auth` or `vault` access, plus row-level-security bypass. If any
  check fails, it stops and stores nothing.
- **Tested locally (2026-11-14),** with a `NOLOGIN` copy of the role and the `SET`-only
  membership:
  - a login attempt is refused even with a password set ("role … is not permitted to
    log in");
  - after `SET ROLE`, `current_user` is `dlm_backup_reader`, row-level-security bypass
    applies, and every privilege check passes;
  - update, delete, insert and create table are all refused at the privilege level, even
    with read-only mode switched off;
  - `postgres` does **not** inherit the role's rights (`USAGE` false, `SET` true).
  - **One adaptation:** a role's own `default_transaction_read_only` applies only at
    *login*, not after `SET ROLE`. The function therefore opens an explicit
    `READ ONLY` transaction, and the check tests `transaction_read_only` instead.
- **Honest limit:** the function *environment* still holds Supabase's default secrets
  (the database URL, the service-role key). That is already true for the three existing
  functions today. Read-only behaviour therefore rests on the **reviewed function
  code** (`SET ROLE` + read-only transaction + checks), not on the credential alone.

### 3.2 Encryption
- **Algorithm:** `age` X25519 (the JavaScript implementation `age-encryption` by the
  `age` author; to confirm package and version at implementation time). It is the same
  format as the existing scripts, so `verify.mjs` and `restore.mjs` stay usable.
- **Only the public key(s)** are stored in Supabase, as the function secret
  `DLM_BACKUP_AGE_RECIPIENTS`. A second public key, for example a printed backup key
  kept in a safe, can be added so that losing one key is not fatal.
- **What is encrypted:**
  - the database snapshot, as one object per run;
  - each stored file, as one object, content-addressed by SHA-256, uploaded only when
    new;
  - an encrypted file map (it holds the original paths, which may contain names).
- **What stays unencrypted:** only object names (timestamps or hashes) and a plaintext
  manifest per run with counts, sizes and SHA-256 values. Both contain no personal data.

### 3.3 Trigger and secrets — nothing for you to copy except two values
- **Trigger secret:** a random value generated **inside the database**
  (`gen_random_bytes`) and stored in Vault. `pg_cron` sends it in a header. The function
  compares it in constant time against Vault, which it reads through its database
  connection. Nobody ever sees it.
- **Off-site storage key:**
  - created by you in the Backblaze or Cloudflare dashboard as a **write-only key
    limited to one bucket**;
  - pasted by you into the Supabase dashboard (Edge Functions → Secrets), never into
    this chat;
  - even if stolen, it cannot read, list or delete backups, and Object Lock prevents
    overwriting.
- **Public key:** pasted by you into the same Supabase secrets page. It is not secret.

### 3.4 Off-site storage (to confirm current offers)

| | Backblaze B2 (EU Central, Amsterdam) | Cloudflare R2 (EU jurisdiction) |
|---|---|---|
| Immutability | Object Lock (compliance mode) | Bucket locks (retention rules) |
| Write-only key | Application key with `writeFiles` only, one bucket | API token "Object Write" scoped to one bucket |
| Automatic deletion | Lifecycle rules | Lifecycle rules |
| Free tier | ≈ 10 GB | ≈ 10 GB |
| API | S3-compatible (signed by the function; no proxy needed) | S3-compatible |

Expected volume: about 1 MB per daily database snapshot, 35 days of retention, plus
about 32 MB of files stored once. Well under 1 GB, so **≈ $0/month** on either free tier.

**Not chosen:** a second Supabase project. It is the same provider, has no
immutability, and free projects pause after inactivity.

### 3.5 Monitoring and verification — automatic
- **Every run:**
  - re-download the uploaded ciphertext and compare SHA-256;
  - write a row into `public.backup_runs`: time, status, duration, per-table row counts
    and SHA-256, ciphertext size and hash, error text without personal data;
  - the table has row-level security on and **no access for app users**.
- **Daily health check** (`pg_cron`, SQL only): if no successful run in 26 hours, mark
  an alert.
  - **Delivery options:** (a) a red banner on the platform-admin screen (a small app
    change), or (b) an email through a transactional email service (a new service,
    optional).
- **Weekly integrity check:** the function re-reads the last 7 run manifests and
  confirms that the ciphertexts still exist with the recorded hashes (read rights are
  needed for this; see §6).
- **What cannot be automated without weakening encryption:** decrypting. Only the
  private-key holder can prove a backup decrypts. Hence the quarterly drill (§5.2). The
  managed backups (O1) can be restore-tested without any key (§5.1).

## 4. One-time key creation — no Termux
- **Tool:** a **single self-contained HTML file** (`docs/backup/tools/age-keytool.html`, to
  be written). You open it in your phone's browser once, **offline**. It contains the
  `age` library inline: no network, no server.
- **It generates the key pair in the browser:**
  - shows the **public key** to copy into Supabase secrets;
  - shows the **private key** once, to store in your password manager and on paper.
- **The same file can later:**
  - decrypt a backup you downloaded, verify it against its manifest, and produce the
    restore SQL for download;
  - all **inside the browser**: the private key and the plaintext never leave the
    phone's browser.
- **Honest note:** this is a browser task a few minutes long (once for the key, then a
  quarterly drill). It is not Termux, but it cannot be zero: **someone must hold a
  private key.** Otherwise the backups are not truly encrypted against everyone else.

## 5. Restore paths

### 5.1 Everyday problem (bad migration, mass deletion), within the managed retention
- **Supabase dashboard → Backups → Restore** (O1). It restores the whole database,
  including Auth.
  - Brief downtime; changes after the backup are lost (to confirm the exact behaviour).
- **Or**, for a migration problem: the existing rollback script
  (`supabase/rollback/…`). No data restore is needed.

### 5.2 Disaster (project, account or provider lost; corruption older than the managed retention)
1. Create a new Supabase project (or reuse the existing one) and apply the repository
   migrations.
2. Download the wanted `.json.age` snapshot and the file objects from the off-site
   bucket. Downloading needs a separate **read** key, which you create only at that
   moment.
3. In the HTML tool: decrypt, verify, generate the restore SQL.
4. Run it in the SQL editor. It is about 1 MB of SQL; whether the editor accepts that
   size is to confirm. Otherwise, a one-time restore Edge Function that receives the
   decrypted snapshot.
5. Re-upload the files with the decrypted file map (a one-time restore function).
6. Auth accounts: recreated, or restored from O1 if still available.

**Quarterly drill** (about 10 minutes, phone browser): download the latest snapshot,
decrypt it in the HTML tool, check `OK` against the manifest, then discard. The full
restore SQL path is already tested locally (`restore.mjs`, 29/29 tables identical).

## 6. Exposure summary

| Asset | Where it can exist | Who can read it |
|---|---|---|
| Plaintext patient names and data | Production database; the Edge Function's memory during a run (same provider, same region) | Supabase (already the host); the function code |
| Encrypted backups | Off-site bucket (immutable 35 days) | Nobody without your private key |
| Private key | Your password manager + paper | Only you |
| Off-site write key | Supabase function secrets | Can only add objects; cannot read, list, delete or overwrite |
| Off-site read key | Not created until needed | — |
| Database credential | None new: role `NOLOGIN`; the function uses Supabase's built-in connection | — |
| Trigger secret | Vault | Database internals only |
| This AI session | **Never** receives plaintext, keys or backup files. It writes and reviews the code. | — |

**Weekly integrity check:** a write-only key cannot re-read objects. Either (a) use a
separate read-only key for hashes only, which still cannot decrypt anything, or (b) rely
on the per-run re-download check, done with the upload response or a read permission
scoped to just-written objects. **Decision at implementation; default (b).**

## 7. Comparison

| Criterion | O1 Managed | O1+PITR | **O3 Function → off-site** | O4 GitHub Actions | **O1 + O3 (recommended)** |
|---|---|---|---|---|---|
| Encryption with your key | No | No | **Yes** | Yes | **Yes** (O3 part) |
| Independent of Supabase account | No | No | **Yes** | Yes | **Yes** |
| Immutable (ransomware, mistakes) | Provider-managed | Provider-managed | **Yes** (Object Lock) | Yes | **Yes** |
| Includes stored files | No (to confirm) | No (to confirm) | **Yes** | Possible | **Yes** |
| Includes Auth accounts | Yes | Yes | No | Possible (more exposure) | **Yes** (O1 part) |
| Restore effort | Click | Click, to the second | Browser tool + SQL | Same as O3 | Click (O1) or tool (O3) |
| Plaintext outside Supabase | No | No | **No** | **Yes** (GitHub runner) | **No** |
| New credentials to protect | None | None | 1 write-only key | DB credential at GitHub | 1 write-only key |
| Monthly cost (to confirm) | ≈ $25 (Pro) | ≈ $125+ | ≈ $0 | ≈ $0 | ≈ $25 |
| Reliability | High (managed) | High | Good (our code, monitored) | Good | High + independent copy |
| Your maintenance | None | None | Quarterly drill; yearly key review | Same + GitHub secrets | Quarterly drill |
| Our maintenance | None | None | Library updates, monitoring | Same | Same as O3 |

## 8. Production actions that would eventually be required (none done)

Each step is a separate approval point. Steps done by you are marked **[you]**.

| # | Action | Type | Notes |
|---|---|---|---|
| P1 | **[you]** Decide on the paid plan for O1 | Billing | Optional. With O3 alone, skip it. |
| P2 | **[you]** Create the off-site bucket (B2 or R2, EU), with Object Lock 35 days, lifecycle 35 days, and a write-only key for that bucket | External service | Values go into P7, never into the chat |
| P3 | **[you]** Generate the key pair with the offline HTML tool; save the private key in your password manager and on paper | One-time, browser | Optional second recipient key for redundancy |
| P4 | Migration: create role `dlm_backup_reader` **NOLOGIN** + read-only grants + `grant … to postgres with inherit false, set true` | Database DDL | No password anywhere |
| P5 | Migration: table `public.backup_runs` (RLS on, no app access) | Database DDL | Run records hold no personal data |
| P6 | Migration: `create extension pg_net`; Vault trigger secret generated in SQL | Database DDL | `pg_net` is already available |
| P7 | **[you]** In the Supabase dashboard → Edge Functions → Secrets: public key(s), bucket endpoint and name, write-only key id and secret | Secrets | Entered by you; Claude never sees them |
| P8 | Deploy Edge Function `dlm-backup` (`verify_jwt` off; trigger-secret check) | Deploy | Code reviewed and tested locally first |
| P9 | First manual run, then you verify one backup in the HTML tool (drill) | Run | Proves end-to-end decrypt |
| P10 | `pg_cron` jobs: daily backup (e.g. 02:17 UTC), daily health check, weekly integrity check | Database DDL | Disable with `cron.unschedule` |
| P11 | Optional: enable SSL enforcement | Setting | Independent hardening; check restart behaviour first |
| P12 | Privacy policy: backup block filled in (where, encryption, retention 35 days) | Publish | Only after P9 succeeds |

**Removal plan:** unschedule the cron jobs, delete the function, drop the role and the
table (SQL provided with the migration). Off-site objects expire automatically after
35 days.

## 9. Implementation plan (repository and local only, before any production step)
1. **Edge Function `supabase/functions/dlm-backup/`** (Deno):
   - port `lib.mjs` checks and the `export.mjs` snapshot logic;
   - `SET ROLE`;
   - `age` encryption;
   - S3 signing for B2/R2;
   - incremental file copy;
   - re-download hash check;
   - run record.
2. **Migrations (not applied):** P4, P5, P6, and the P10 cron SQL as a separate file.
3. **Offline HTML tool:** key generation, decrypt, verify, restore-SQL generation.
4. **Local tests:**
   - against the local Supabase stack and a local S3-compatible server (MinIO in Docker):
     a full run, the encrypted objects, the immutability simulation, the run record;
   - security checks: a wrong trigger secret is refused; a non-read-only role is
     refused; no plaintext is uploaded; the write-only key cannot read; the file map is
     encrypted;
   - a restore drill from the uploaded objects (29/29 tables identical);
   - the HTML tool tested headless in Chromium (key generation, decrypt, verify).
5. **Security review** of the diff, then your approval for P1–P12 in order.

## 10. Open points to confirm before approval
- Supabase:
  - current plan prices and the daily-backup retention per plan;
  - whether managed backups include Storage files and Auth;
  - Edge Function limits (duration, memory) on your plan;
  - that `SUPABASE_DB_URL` is provided to functions;
  - the recommended `pg_cron` + `pg_net` + Vault scheduling pattern;
  - whether enabling SSL enforcement restarts the database.
- B2/R2: free-tier limits, Object Lock/bucket-lock availability in the EU region, and
  write-only key scopes.
- `age-encryption` JavaScript library: version, licence (BSD-3-Clause expected) and
  Deno compatibility.

The quickest way to settle these is to let this session read supabase.com and the
storage providers' documentation. That is your decision; no network change has been
requested.
