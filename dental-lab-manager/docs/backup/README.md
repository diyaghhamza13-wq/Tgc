# Encrypted database backup (B2) — destination, setup, export and restore

> **Status: tested on the local stack only. No production export has been made.**
> Nothing in this procedure sends backup data, keys or passphrases through a
> chat, an e-mail or this repository.

## 1. Design in one picture

```
production DB ──(1 read-only SELECT)──► export.mjs (memory only)
                                         │ manifest (counts + SHA-256, no personal data)
                                         ▼
                        age encryption to YOUR PUBLIC key (age1…)
                                         ▼
          separate Supabase project "dlm-backups" — private bucket, INSERT-ONLY
                                         ▼
     you download it from the dashboard ─► decrypt with YOUR PRIVATE key (on your phone)
                                         ▼
                         restore.mjs ─► restore.sql ─► psql (one transaction)
```

| Secret | Where it lives | Who sees it |
|---|---|---|
| Backup content (incl. 15 legacy patient names, PIN hashes) | Only as an `age`-encrypted file in the backup bucket | Nobody without your private key |
| Your **private** key (`AGE-SECRET-KEY-1…`) | Your phone (Termux) + an offline copy (paper / USB / password manager) | **Only you.** Never pasted anywhere |
| Your **public** key (`age1…`) | Can be shared; it only allows encrypting | Anyone (it is not a secret) |
| Upload key of the backup project | Saved through the secure credential form; the proxy injects it | Not visible to Claude, not in chat |

## 2. Destination: a separate Supabase project with an insert-only bucket

**Why this destination**
- **Outside this repository and outside this conversation.**
- **Separate project:** a mistake or an incident in the app project does not touch it.
- **Same provider and region as the app (Supabase, EU-West-2).** It adds no new
  subprocessor or country. That keeps the privacy policy simple.
- **Write-only for the uploader.** The upload key can only **add** new files with the
  backup name pattern. It cannot list, download, overwrite or delete. Tested locally:
  upload 200; overwrite, download, delete and other names refused; listing returns
  nothing.
- **Double protection.** Even if someone obtained a file, it is `age`-encrypted. Only
  your private key opens it.

**Not chosen**
- **This repository:** possibly public, and history is permanent.
- **Chat attachments:** you excluded these.
- **Object stores using AWS-style request signing** (S3, R2, Backblaze S3): the
  credential proxy cannot sign those requests without the secret entering the session.
- **Supabase Pro on the app project (B1):** a good alternative, but it lives in the same
  project, and you chose B2.

**Known limits**
- Free Supabase projects **pause after a period of inactivity.** Paused projects can be
  resumed from the dashboard. Check the current free-plan rules in Supabase's docs.
- The upload over Supabase's hosted gateway with only an `apikey` header was tested
  **locally**, not on a hosted project. The first real upload will confirm it.

## 3. One-time setup (by you, on your phone; ≈ 15 minutes)

1. **Create the backup project:**
   - in supabase.com, create a new project named `dlm-backups`;
   - choose region **West EU (London)**, the same as the app;
   - choose a strong database password and keep it.
2. **Create the bucket and the insert-only rule:** open the backup project's SQL editor
   and run `docs/backup/backup-project-setup.sql` from this repository.
3. **Create your key pair** (Android, with the free Termux app from F-Droid):
   ```
   pkg install age
   age-keygen -o dlm-backup-key.txt
   ```
   - The command prints `Public key: age1…`. That public key is the only thing you
     give me. It is safe to paste.
   - **Keep `dlm-backup-key.txt` private.** Make an offline copy (paper, or a USB stick
     at home).
   - **If you lose it, the backups can never be opened.**
4. **Give me the upload key securely:**
   - When you approve, I open the secure credential form for host
     `<backup-ref>.supabase.co`, with header `apikey`.
   - You paste the backup project's **anon (publishable) key** there, **not in the
     chat**. I never see it; the proxy adds it to upload requests.
   - Never give the backup project's service-role key or database password.

## 4. Export (each run only with your approval)

```
SUPABASE_PROJECT_REF=slfwakmskshkbrfqqfwl \
AGE_RECIPIENT=age1…your-public-key… \
OUT_DIR=/tmp/…/scratchpad/backup \
BACKUP_STORAGE_URL=https://<backup-ref>.supabase.co \
node scripts/backup/export.mjs
```

1. One read-only `SELECT` returns all 29 public tables, the migration history and the
   storage metadata as one consistent snapshot.
2. The data is encrypted in memory. No unencrypted copy is written.
3. The script uploads `<UTC timestamp>-<random>.json.age` and writes a manifest with
   counts and checksums only.
4. The local copies are deleted right after the upload succeeds. The manifest (no
   personal data) is the B3 "before" fingerprint.

## 5. Restore (tested locally; each step only with your approval)

**First choice for a migration problem:** do **not** restore data. Run
`supabase/rollback/rollback_20261114155851_production_only_cases.sql` and restore the
previous Netlify deploy.

**Data restore**, done on your phone in Termux. The private key never leaves your phone.

```
pkg install age nodejs postgresql git
git clone -b claude/dental-lab-manager-v4d2kv https://github.com/diyaghhamza13-wq/tgc && cd tgc/dental-lab-manager
# (if the repository is private, Termux asks for your GitHub login)
# download <file>.json.age (and its .manifest.json if kept) from the backup project:
#   Dashboard → Storage → dlm-backups → Download
age -d -i ~/dlm-backup-key.txt <file>.json.age > ~/backup.json
node scripts/backup/restore.mjs ~/backup.json [<file>.manifest.json] > ~/restore.sql
# the app project's connection string: Dashboard → Connect → Session pooler (needs the DB password)
psql "<connection string>" -v ON_ERROR_STOP=1 -f ~/restore.sql
rm ~/backup.json ~/restore.sql
```

**What `restore.sql` does, in one transaction**
1. **Refuses to run** if the database's migration history differs from the backup's.
   If Phase 1 is applied and the backup was taken before it, run the rollback script
   first.
2. Disables user triggers on all public tables, so the restore creates no audit,
   history or notification rows.
3. Empties all public tables and re-inserts every row in foreign-key order, keeping
   identity values. The `cases.current_stage_id` ↔ workflow-stage cycle is filled in
   afterwards.
4. Resets the identity sequences and re-enables the triggers.

**It is a full restore.** Rows created after the backup are removed, so compare first
when in doubt. Login accounts and stored files are not part of it.

**Local drill results** (2026-11-14):
- Data: a demo lab with 5 cases, a legacy patient case and legacy files (783 rows).
- Exported, encrypted, uploaded to the insert-only bucket. The encrypted file contained
  no readable lab or patient names.
- Then damaged:
  - 2 cases deleted, the patient deleted;
  - the laboratory renamed;
  - a tooth number changed;
  - an audit row added.
- Decrypted, manifest verified, restore SQL generated.
- **The guard refused** a database with a different migration history and changed
  nothing.
- **After restore:**
  - all **29/29 tables were checksum-identical** to the backup, including the audit log
    (no extra rows);
  - the restored lab could log in;
  - the full integration suite passed 137/137;
  - no plaintext file was left.

## 6. Retention and deletion of backups

Backups contain the legacy patient names and the PIN hashes.

**Proposal:**
- Keep the pre-deployment backup **until Phase 1 has been verified in production, and
  at most 30 days.** After that, you delete it in the backup project dashboard
  (Storage → dlm-backups → Delete).
- Keep your private key for as long as any backup exists.
- The privacy policy states this retention period.
