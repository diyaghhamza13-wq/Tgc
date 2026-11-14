# Encrypted database backup (B2) — destination, setup, export, restore, reverse

> **Status (2026-11-14): designed and tested on the local stack only. Nothing is
> active in production:**
> - no backup project exists;
> - no key pair exists;
> - no backup has been made;
> - no retention is running.
>
> Nothing in this procedure sends backup data, keys or passphrases through a chat, an
> e-mail or this repository.

## 0. Safeguard status

| Safeguard | Status |
|---|---|
| Export, encryption, upload and restore scripts | Written and **tested locally** |
| Insert-only bucket rule | **Tested locally** |
| Separate backup project in Supabase | **Planned**: you create it (§3) |
| Your key pair | **Planned**: you create it on your phone (§3) |
| First production backup | **Planned**: only after your approval |
| Upload to the hosted backup project | **Untested** until the first real upload |
| 30-day retention | **Planned**: a manual deletion by you; nothing automatic |
| Restore and reverse on your phone (Termux) | Same scripts as tested locally; **not yet run on your phone** |

## 1. Who holds what

- **The private key belongs to you (the operator) and stays on your phone**, plus an
  offline copy you keep.
- It is **never** given to any developer, contractor, AI assistant (including Claude),
  hosting provider, chat or repository.
- Decrypting a backup (for a restore or a reverse) therefore happens **only on your
  phone.**

| Item | Where it lives | Who has it |
|---|---|---|
| Backup files | `age`-encrypted, in the backup project's private bucket | Readable only with your private key |
| **Private key** (`AGE-SECRET-KEY-1…`) | Your phone (Termux) + your offline copy | **Only you** |
| Public key (`age1…`) | You give it to me in chat; it only allows encrypting | Anyone; not a secret |
| Upload key (backup project's anon/publishable key) | Secure credential form; the proxy injects it | Not visible to Claude, never in chat |
| App project service-role key (needed only for a reverse) | Copied by you from the dashboard into Termux on your phone | Only you |

**Being transparent about the export step:**
- The export runs in this cloud session. It reads the production data in plaintext,
  **in memory**, then encrypts it. That is the same read access this session already has
  through the Management API.
- No plaintext copy is written to disk. The session never has the private key, so it
  cannot decrypt the backup afterwards.

## 2. What the backup contains, and what it does not

**Contains** (from one consistent snapshot):
- every row of all 29 tables in the app's main database schema (`public`): laboratories,
  employees, PIN *hashes*, dentists, cases, teeth, implants, restorations, workflow,
  history, attachment *records*, notifications, QC, deliveries, audit logs, catalogs,
  **and the 15 legacy patient names**;
- the migration history;
- the *list* of storage objects (names, sizes, dates).

**Does NOT contain:**

| Excluded | What that means |
|---|---|
| **File contents** (STL scans, the legacy photos and video, logos, profile photos; ≈ 34 MB today) | If a stored file is lost or deleted, this backup **cannot bring it back**. It only knows the file existed. The migration and the renaming scripts never change file contents. |
| **Supabase Auth accounts** (the login accounts behind employees) | The backup does not save or restore logins. A restore expects those accounts to still exist. If an employee's login account is missing, the restore **stops without changing anything**: one transaction. Recovering accounts is a separate, manual step (recreate the employee or reset the PIN). |
| Database structure, functions and policies | Rebuilt from the repository's migrations. The backup records which migrations were applied, and the restore refuses to run on a different version. |
| Supabase project settings, secrets, Edge Functions, the Netlify site | Not data; managed separately. |

## 3. One-time setup (by you, on your phone; ≈ 15 minutes)

**Requires Android.** Termux does not exist on iPhone.

**A. Create the separate backup project** (phone browser)
1. Go to supabase.com/dashboard → **New project**.
2. **Name:** `dlm-backups`.
3. **Database password:** tap **Generate**, save it in your password manager, never send
   it.
4. **Region:** West EU (London).
5. **Plan:** Free → **Create new project**. Wait 1–2 minutes.

**B. Create the insert-only bucket**
1. In the new project: **SQL Editor → New query**.
2. Paste `docs/backup/backup-project-setup.sql` → **Run**. Expect "Success. No rows
   returned".
3. **Storage** should now show a private bucket `dlm-backups`.

**C. Create your key pair** (Termux from F-Droid; the Play Store build is outdated)
```
pkg update && pkg upgrade
pkg install age
age-keygen -o ~/dlm-backup-key.txt
chmod 600 ~/dlm-backup-key.txt
```
1. It prints `Public key: age1…`. That is the only line you send me.
2. **Offline copy, immediately:**
   - run `cat ~/dlm-backup-key.txt`;
   - copy the `AGE-SECRET-KEY-1…` line onto paper, or into your password manager.
   - Termux deletes its files if the app is uninstalled or its data is cleared.
3. **Check it** (prints `ok`):
   `echo ok | age -r $(age-keygen -y ~/dlm-backup-key.txt) | age -d -i ~/dlm-backup-key.txt`
4. If `pkg install age` says the package is not found, tell me. I have not verified
   Termux's package list today.

**D. Non-secret values for the chat:** your public key (`age1…`) and the backup
project's **Reference ID** (Project Settings → General).

**E. Upload key, secure form only:**
1. After your approval I open the form for `<reference-id>.supabase.co`.
2. Paste the backup project's **anon / publishable** key there (Project Settings → API
   Keys).
3. Never send the service-role key or the database password.

## 4. Export (each run only with your approval)

```
SUPABASE_PROJECT_REF=slfwakmskshkbrfqqfwl AGE_RECIPIENT=age1…your-public-key… \
OUT_DIR=<scratch directory outside the repository> \
BACKUP_STORAGE_URL=https://<backup-ref>.supabase.co \
node scripts/backup/export.mjs
```
1. One read-only `SELECT` returns everything as one consistent snapshot.
2. The data is encrypted in memory to your public key.
3. The script uploads `<UTC timestamp>-<random>.json.age` and writes a manifest with
   counts and SHA-256 checksums only, no personal data.
4. The local encrypted copy is deleted after a successful upload.

## 5. Restore (only with your approval; on your phone)

**For a migration problem, do not restore data.** Run
`supabase/rollback/rollback_20261114155851_production_only_cases.sql` and restore the
previous Netlify deploy.

**Data restore**, in Termux. The decrypted data never leaves your phone.
```
pkg install age nodejs postgresql git
git clone -b claude/dental-lab-manager-v4d2kv https://github.com/diyaghhamza13-wq/tgc && cd tgc/dental-lab-manager
# (if the repository is private, Termux asks for your GitHub login)
# download <file>.json.age from the backup project: Dashboard → Storage → dlm-backups → Download
age -d -i ~/dlm-backup-key.txt <file>.json.age > ~/backup.json
node scripts/backup/restore.mjs ~/backup.json [<file>.manifest.json] > ~/restore.sql
# app project connection string: Dashboard → Connect → Session pooler (needs the app DB password)
psql "<connection string>" -v ON_ERROR_STOP=1 -f ~/restore.sql
rm ~/backup.json ~/restore.sql
```

**What `restore.sql` does, in one transaction**
1. **Refuses to run** if the database's migration history differs from the backup's.
2. Disables user triggers on all public tables, so the restore creates no audit, history
   or notification rows.
3. Empties all public tables and re-inserts every row in foreign-key order.
4. Resets the identity sequences and re-enables the triggers.

**It is a FULL restore.** Rows created after the backup are removed.

## 6. Reversing the legacy file-name redaction (only with your approval; on your phone)

`scripts/reverse-legacy-file-names.mjs` undoes `scripts/redact-legacy-files.mjs`
**exactly**. It restores:
- the storage object names;
- `attachments.storage_path` and `attachments.file_name`;
- the file history rows;
- the attachment audit rows.

**Requirements:**
- a backup taken **before** the redaction (runbook step 2 guarantees this);
- **your private key**, so it runs on your phone;
- the app project's **service-role key**, copied by you from the dashboard into
  Termux; never into the chat.

```
age -d -i ~/dlm-backup-key.txt <pre-redaction file>.json.age > ~/backup.json
SUPABASE_URL=https://slfwakmskshkbrfqqfwl.supabase.co SUPABASE_SERVICE_ROLE_KEY=<from dashboard> \
BACKUP_JSON=~/backup.json node scripts/reverse-legacy-file-names.mjs            # dry run: counts only
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… BACKUP_JSON=~/backup.json APPLY=1 node scripts/reverse-legacy-file-names.mjs
rm ~/backup.json
```

**How it works:**
1. It moves the objects back first.
2. Then it restores the rows in one database call.
3. If that call fails, it moves the objects forward again, so no download link breaks.
4. It prints only IDs and counts.
5. Audit rows written by the redaction and by the reversal are **kept** as a record.
   After a reversal, those new audit rows contain the original names again, which is the
   purpose of a reversal.

## 7. Local test results (2026-11-14)

**Backup drill.** Data: a demo lab + a legacy patient case + legacy files; 791 rows in 29
tables.
1. Export → encrypted (no readable lab or patient name in the file) → uploaded to the
   insert-only bucket.
2. Damaged the database:
   - 2 cases deleted, the patient deleted;
   - the lab renamed;
   - a tooth number changed;
   - an audit row added.
3. Decrypted → manifest verified → restore SQL generated.
4. The guard refused a mismatched migration history and changed nothing.
5. **Restore → 29/29 tables checksum-identical** to the backup (including the audit
   log); no plaintext left.

**Missing login account.** After the backup, an employee's Auth account was deleted
and the lab was renamed; then the restore was run. It stopped on the foreign key
`employees_auth_user_id_fkey` and **changed nothing**: the lab name stayed as it was,
and no trigger was left disabled.

**Insert-only bucket.** Upload accepted. Overwrite, download, delete and other names
refused; listing returns nothing.

**Forward + reverse round trip:** `scripts/tests/legacy-files-local-test.mjs`, **30/30
checks passed.**
- **Setup:** 4 legacy files (photo, video, PDF, STL) and 2 deleted legacy files, all
  with a fictional patient name; then an encrypted backup.
- **Default forward:** only the STL is renamed. Photo, video and PDF: rows, storage
  objects (names and contents), history and audit rows are byte-identical; no audit row
  added.
- **Forward with `INCLUDE_SENSITIVE=1`:**
  - 0 occurrences of the name left;
  - contents unchanged;
  - signed URL anonymous;
  - idempotent;
  - functions not callable by app users.
- **Reverse from the decrypted backup:**
  - storage objects back under their original names with identical contents (SHA-256);
  - attachment rows identical (all columns);
  - file history identical;
  - pre-existing audit rows identical;
  - the photo downloads at its original path;
  - idempotent;
  - decrypted file removed.
  - 12 new audit rows (from the redaction and the reversal) remain as a record.

**Regression:**
- integration suite 137/137;
- type check clean;
- rollback script restores functions and policies identical to production.

## 8. Retention (planned, manual)

- Delete the pre-deployment backup from the backup project (Storage → dlm-backups →
  Delete) once Phase 1 is verified, **and at the latest after 30 days.**
- **Keep it at least as long as you may want to reverse the file-name redaction.** After
  deletion, the redaction can no longer be reversed.
- Keep your private key for as long as any backup exists.
- Nothing deletes backups automatically. Until you do it, the privacy policy must not
  claim 30-day retention as operational.
