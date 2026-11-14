# Encrypted database backup (B2) — phone-based export, restore and reverse

> **Status (2026-11-14): designed and tested on the local stack only. Nothing is
> active in production:**
> - no read-only backup login exists;
> - no backup project exists;
> - no key pair exists;
> - no backup has been made.
>
> **Principle:** production data is exported and encrypted **on the operator's own
> phone**. No cloud session or AI assistant ever handles backup data, backup files,
> keys or passwords. Nothing in this procedure goes through a chat, an e-mail or this
> repository.

## 0. Status of each part

| Part | Status |
|---|---|
| Scripts: `lib.mjs`, `termux-check.sh`, `check-connection.mjs`, `export.mjs`, `verify.mjs`, `upload.mjs`, `restore.mjs`, `reverse-legacy-file-names.mjs` | Written and **tested locally** (§9) |
| Read-only backup login `dlm_backup_reader` (§4) | **Proposal**, tested locally; **not created in production** (needs your approval) |
| Your key pair (§5) | **Planned**: you create it on your phone |
| Running the scripts in Termux on your phone | **Not yet done**; check with §5 first |
| Connection from your phone to Supabase (direct or pooler) | **Untested** until §5.6 |
| Separate backup project (§7) | **Optional**, not created |
| 30-day retention | **Planned**: manual deletion by you; nothing automatic |

## 1. Architecture

```
Your Android phone (Termux)
  check-connection.mjs ── metadata only ──┐
  export.mjs ── read-only login, TLS ─────┼──► Supabase Postgres (app project)
        │  one read-only SELECT; data held in the phone's memory only
        ▼
  encrypted to YOUR PUBLIC key  →  ~/dlm-backups/<stamp>-<id>.json.age  (+ .manifest.json)
        │
        ├─ verify.mjs (decrypts into a pipe, never to disk)
        ├─ keep it locally; copy the encrypted file to your Google Drive (manual)
        └─ OPTIONAL: upload.mjs → separate backup project, insert-only bucket

Claude's cloud session: not involved. It never receives the data, the file, the key or any password.
```

**The cloud-session (Management API) export has been removed from `export.mjs`.**
Exports run only on your device, over a connection with verified TLS (§5.6).

## 2. Who holds what

| Item | Where it lives | Who has it |
|---|---|---|
| **Private key** (`AGE-SECRET-KEY-1…`) | Your phone (Termux) + your offline copy | **Only you.** Never given to any developer, contractor, AI assistant (including Claude), hosting provider, chat or repository |
| Public key (`age1…`) | Your phone; may be shared; it only allows encrypting | Anyone; not a secret |
| Read-only backup login password | Typed by you when exporting (`read -rs PGPASSWORD`); never stored in a file | Only you |
| Encrypted backup files | `~/dlm-backups` on your phone; optional copies in your Google Drive or backup project | Readable only with your private key |
| Backup project upload key (optional) | Typed by you when uploading (`read -rs BACKUP_APIKEY`) | Only you |
| App project service-role key (only for a reverse, §8) | Typed by you in Termux when needed | Only you |

## 3. What the backup contains, and what it does not

**Contains** (one consistent snapshot):
- every row of all 29 tables in the app's main schema (`public`): laboratories,
  employees, PIN *hashes*, dentists, cases, teeth, implants, restorations, workflow,
  history, attachment *records*, notifications, QC, deliveries, audit logs, catalogs,
  **and the 15 legacy patient names**;
- the migration history;
- the *list* of stored files (names, sizes, dates).

**Does NOT contain:**

| Excluded | Consequence |
|---|---|
| **File contents** (STL scans, legacy photos and video, logos, profile photos) | A lost or deleted stored file **cannot be recovered** from this backup |
| **Supabase Auth login accounts** | Not saved or restored. A restore expects them to still exist; if one is missing, the restore **stops and changes nothing** (tested). Accounts are then recreated manually. |
| Database structure, functions, policies | Rebuilt from the repository's migrations. The restore refuses a different migration version. |
| Project settings, secrets, Edge Functions, the Netlify site | Not data; managed separately |

## 4. The read-only backup login (`dlm_backup_reader`)

**Proposal:** `docs/backup/readonly-role-setup.sql`. It is **not a migration** and
**not applied in production.**

**Exact permissions**

| Object | Privilege | Why |
|---|---|---|
| Login attribute `BYPASSRLS` | Bypasses row-level security | Without it, row-level security would hide every row: the backup would be empty |
| Schema `public`, all tables | `USAGE`, `SELECT` (and `SELECT` on future tables via default privileges) | Read every row |
| `supabase_migrations.schema_migrations` | `SELECT` | Record which schema version the backup belongs to |
| `storage.objects` | `SELECT` | The list of stored files (names, sizes), not their contents |
| Setting `default_transaction_read_only = on` | — | Extra guard: every session starts read-only |
| `statement_timeout = 5min`, `connection limit 2` | — | Limit runaway or parallel use |
| Login attributes | `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`, member of no role | Declared explicitly; no inherited rights |
| Everything else | **None** | No INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER, no sequence changes, no CREATE in the database or any schema, no SECURITY DEFINER function, no `auth` or `vault` schema |

**Permission review across every schema the login can reach** (local stack with the full
app schema, `check-connection.mjs` + inventory, 2026-11-14):

| Schema | What the login can do |
|---|---|
| `public` | `SELECT` on all 29 tables; **no** write, `REFERENCES` or `TRIGGER` privilege; **no** executable function (all app functions are granted to app users only) |
| `storage` | `SELECT` on `storage.objects` only; 20 executable helper functions, **none** `SECURITY DEFINER` (they run with this login's own read-only rights) |
| `supabase_migrations` | `SELECT` on `schema_migrations` only |
| `pg_catalog`, `information_schema` (system) | Standard PostgreSQL defaults for every login: read catalog views, change its own session settings (`pg_settings`); **no** `SECURITY DEFINER` function |
| `auth`, `vault`, `cron`, `net`, `extensions`, `realtime`, `graphql`, others | **No access** (no `USAGE`) |
| Database | `CONNECT` and `TEMP` (temporary tables for its own session, a PostgreSQL default); **no** `CREATE` |
| Built-in roles | Not a member of `pg_read_all_stats`, `pg_read_server_files`, `pg_monitor` or any other role |

`check-connection.mjs` and `export.mjs` re-check all of this on every run, so a later
mistaken `GRANT` is detected before any data is read.

**Security limitations (read before approving)**
- **It can read everything in the backup**, including the legacy patient names and the
  PIN hashes. Anyone who obtains its password can read the whole database. It cannot
  change anything.
- **Its read-only setting can be switched off by the login itself.** Protection against
  writes comes from the **missing write privileges**, which the login cannot grant
  itself. Tested: every write attempt is refused even with the setting switched off.
- `BYPASSRLS` means tenant isolation does **not** apply to this login. That is
  necessary for a backup, but it makes it more sensitive than any app user.
- **The password protects it; nothing else does.** Supabase accepts this login from any
  network. Use a long random password, type it only when needed, and rotate it after
  use if you like.
- Like every PostgreSQL login, it can create **temporary** tables for its own session
  and change its own session settings. Neither can change stored data.
- **Not yet verified in production:**
  - that the Supabase `postgres` role may create a login with `BYPASSRLS` (it can
    locally, and its attributes match production);
  - that the Session pooler accepts this custom login.
- **Removal:** the bottom of the SQL file removes all privileges and the role.

**Setup, only after your approval:**
1. Run the SQL file in the app project's SQL editor (Supabase dashboard). It contains
   **no password**.
2. **Set the password from Termux with `\password`, never in the SQL editor.** The
   editor may keep statement text in its history, and a statement containing a plain
   password can reach the server logs. That was shown in the local test: with full
   statement logging, a plain `PASSWORD '…'` appears in the log, while `\password`
   leaves only a SCRAM verifier.
   ```
   read -rs PGPASSWORD; export PGPASSWORD       # the MAIN database password, typed once
   psql -X 'postgresql://postgres@<host>:5432/postgres?sslmode=verify-full&sslrootcert=/data/data/com.termux/files/home/supabase-ca.crt'
   postgres=> \password dlm_backup_reader     -- type the new password twice; nothing is echoed
   postgres=> \q
   unset PGPASSWORD
   ```
   `psql` turns the new password into a SCRAM-SHA-256 verifier **on the phone** and
   sends only that. To rotate the password, repeat this step.
   - With the Session pooler, the admin user is `postgres.<project-ref>`.

## 5. Preparing the phone (no production data is touched)

**5.1 Install Termux** from F-Droid (f-droid.org). The Play Store version is outdated.
iPhone is not supported.

**5.2 Packages and scripts**
```
pkg update && pkg upgrade
pkg install postgresql nodejs age git
git clone -b claude/dental-lab-manager-v4d2kv https://github.com/diyaghhamza13-wq/tgc
cd tgc/dental-lab-manager
```
If the repository is private, git asks for your GitHub login. If `pkg install` cannot
find a package, stop and tell me. Termux's package list has not been verified.

**5.3 Create your key pair**
```
mkdir -p ~/dlm-backups && chmod 700 ~/dlm-backups
age-keygen -o ~/dlm-backup-key.txt && chmod 600 ~/dlm-backup-key.txt
```
**Make an offline copy right away:** copy the `AGE-SECRET-KEY-1…` line from
`cat ~/dlm-backup-key.txt` onto paper or into a password manager. Termux deletes its
files if the app is uninstalled or its data is cleared.

**5.4 Get the Supabase CA certificate**
1. In the app project's dashboard, go to **Database settings → SSL configuration** and
   download the CA certificate.
2. Copy it into Termux, for example as `~/supabase-ca.crt`: run `termux-setup-storage`,
   then `cp ~/storage/downloads/<file>.crt ~/supabase-ca.crt`.

It is a public certificate, not a secret. It lets `psql` verify that it really talks to
your Supabase database (`sslmode=verify-full`).

**5.5 Check the tools (no database involved)**
```
bash scripts/backup/termux-check.sh ~/dlm-backup-key.txt ~/supabase-ca.crt
```
It checks:
- `psql`, `node` (18+), `age`, `age-keygen`, `git`;
- the key file's permissions and an encrypt/decrypt round trip with your key;
- that the scripts are intact;
- that the CA file is a certificate.

It ends with `ALL CHECKS PASSED`.

**5.6 Test the connection (metadata only; exports nothing)**
1. Find the connection details in the app project's dashboard → **Connect**.
   - **Direct connection:** host `db.<project-ref>.supabase.co`, port 5432, user
     `dlm_backup_reader`. Free projects give this host an **IPv6 address only.**
   - **Session pooler** (for networks without IPv6): the pooler host shown there, port
     5432, user `dlm_backup_reader.<project-ref>`.
2. Run:
   ```
   read -rs PGPASSWORD; export PGPASSWORD      # type the password; nothing is shown or saved
   export DB_URL="postgresql://<user>@<host>:5432/postgres?sslmode=verify-full&sslrootcert=$HOME/supabase-ca.crt"
   node scripts/backup/check-connection.mjs
   ```
   **Rules for `DB_URL`:**
   - exactly one host;
   - only `sslmode`, `sslrootcert`, `connect_timeout` and `application_name` are
     accepted, each at most once;
   - remote hosts **must** use `sslmode=verify-full` with a readable `sslrootcert`.

   `host`/`hostaddr` overrides, duplicates and libpq environment variables
   (`PGHOST`, `PGHOSTADDR`, `PGSSLMODE`, …) are refused or ignored.
3. It reads only metadata from the **established** connection, plus one yes/no answer
   (are rows visible). It checks:
   - the real TLS state and version;
   - that certificate verification was required;
   - the login's attributes and memberships;
   - that it cannot create anything, write or add triggers to any table, change any
     sequence, or run any `SECURITY DEFINER` function, in **every** schema it can reach;
   - no `auth`/`vault` access;
   - row-level-security bypass;
   - all 29 tables, the migration history and the file list are readable.

   It must end with `READY`. It never prints the password or the connection string.
4. If it reports anything else (for example "cannot write" fails because you used the
   `postgres` login), do not export.

## 6. Export, saved locally first (each production export only with your approval)

```
read -rs PGPASSWORD; export PGPASSWORD
DB_URL="postgresql://<user>@<host>:5432/postgres?sslmode=verify-full&sslrootcert=$HOME/supabase-ca.crt" \
AGE_RECIPIENT=$(age-keygen -y ~/dlm-backup-key.txt) OUT_DIR=~/dlm-backups \
node scripts/backup/export.mjs
unset PGPASSWORD
```

**What it does:**
1. Runs every check of §5.6 first and refuses on any failure. Its own data connection
   then re-checks TLS and the login name inside the snapshot. It also refuses an
   `OUT_DIR` inside the repository. No file is written when anything fails.
2. Reads everything in **one read-only SELECT**, holding it only in memory.
3. Encrypts it to your public key and saves `~/dlm-backups/<stamp>-<id>.json.age`, plus
   a manifest with counts and SHA-256 checksums only (no personal data).
4. Uploads nothing.

**Verify it, without writing plaintext anywhere:**
```
age -d -i ~/dlm-backup-key.txt ~/dlm-backups/<file>.json.age | node scripts/backup/verify.mjs ~/dlm-backups/<file>.manifest.json
```
It ends with `OK: 29 tables, … rows`.

**Keep a second copy** of the **encrypted** file:
1. Run `termux-setup-storage` once.
2. `cp ~/dlm-backups/<file>.json.age ~/storage/downloads/`
3. Upload it to your Google Drive from the Drive app.

Never copy `dlm-backup-key.txt` next to it.

## 7. Optional: the separate backup project

Use it only if you want a copy in a separate Supabase project in addition to the local
and Drive copies.

**Setup:**
1. Create the project `dlm-backups` in Supabase: region West EU (London), Free plan,
   generated database password stored in your password manager.
2. In its SQL editor, run `docs/backup/backup-project-setup.sql`. This creates a private
   bucket whose public key can only **add** backup files: it cannot list, read,
   overwrite or delete them.

**Upload** (from Termux):
```
read -rs BACKUP_APIKEY; export BACKUP_APIKEY        # the backup project's anon/publishable key
BACKUP_STORAGE_URL=https://<backup-ref>.supabase.co node scripts/backup/upload.mjs ~/dlm-backups/<file>.json.age
unset BACKUP_APIKEY
```

- It refuses anything that is not an `age`-encrypted backup file, and it never
  overwrites.
- **Limits:**
  - the upload over Supabase's hosted gateway was tested locally only;
  - free projects pause after inactivity.

## 8. Restore and reverse (only with your approval; on your phone)

**For a migration problem, do not restore data.** Run
`supabase/rollback/rollback_20261114155851_production_only_cases.sql` and restore the
previous Netlify deploy.

**Restore.** Writing needs the app's main database password, because the read-only login
cannot restore.
```
age -d -i ~/dlm-backup-key.txt <file>.json.age > ~/backup.json
node scripts/backup/restore.mjs ~/backup.json <file>.manifest.json > ~/restore.sql
read -rs PGPASSWORD; export PGPASSWORD               # main database password (postgres login)
psql -X "postgresql://postgres@<host>:5432/postgres?sslmode=verify-full&sslrootcert=$HOME/supabase-ca.crt" -v ON_ERROR_STOP=1 -f ~/restore.sql
rm ~/backup.json ~/restore.sql; unset PGPASSWORD
```

What `restore.sql` does, in one transaction:
- refuses a different migration history;
- disables user triggers (so no audit or history side effects);
- empties and re-inserts all public tables in foreign-key order;
- resets the sequences;
- re-enables the triggers.

**It is a FULL restore.** Rows created after the backup are removed.

**Reverse the legacy file-name redaction.** This needs a backup taken **before** the
redaction and the app project's service-role key, typed in Termux.
```
age -d -i ~/dlm-backup-key.txt <pre-redaction file>.json.age > ~/backup.json
read -rs SUPABASE_SERVICE_ROLE_KEY; export SUPABASE_SERVICE_ROLE_KEY
SUPABASE_URL=https://<app-ref>.supabase.co BACKUP_JSON=~/backup.json node scripts/reverse-legacy-file-names.mjs          # dry run
SUPABASE_URL=https://<app-ref>.supabase.co BACKUP_JSON=~/backup.json APPLY=1 node scripts/reverse-legacy-file-names.mjs
rm ~/backup.json; unset SUPABASE_SERVICE_ROLE_KEY
```

## 9. Local test results (2026-11-14)

**Security regression suite** (`scripts/tests/backup-security-local-test.sh`): **49/49
passed.** It runs against a **temporary local PostgreSQL with real TLS** (test CA,
server certificate for 127.0.0.2) and against the local Supabase stack.
- **F1, redirect or weaken:** `?host=`, `?hostaddr=`, duplicate `sslmode`
  (require then disable) and multiple hosts are refused, both by the connection check
  and by the export. `PGHOSTADDR`, `PGSSLMODE` and `PGOPTIONS` in the environment are
  ignored. The removed cloud mode and a privileged login on a non-local host are
  refused.
- **F2, verified TLS:**
  - READY over `verify-full` with the right CA, and the session reports its TLS version;
  - refused: `sslmode=require`, no `sslmode`, `verify-full` without or with a missing
    `sslrootcert`;
  - **no connection** with a certificate from another CA, or with a host name that is
    not in the certificate.
- **F3, password:** `\password` through a terminal session stores a SCRAM-SHA-256
  verifier. With `log_statement=all`, the plain password **never** appeared in the
  server log, only the verifier. In contrast, a plain `PASSWORD '…'` statement did
  appear in the log.
- **F4, redaction:** no password, connection string or upload key appeared in any error,
  whether from a wrong password in the URL or in `PGPASSWORD`, an unreachable server, an
  invalid URL or a failed upload.
- **F5, completeness and privileges:**
  - export over verified TLS works; the manifest records the login and the TLS version;
    the backup verifies;
  - a login **without** row-level-security bypass is reported incomplete, and the export
    refuses it and writes no file;
  - also detected: an extra `INSERT`, a `TRIGGER` privilege, an executable
    `SECURITY DEFINER` function, `vault` access and membership in another role;
  - after reverting each one: READY again.
- **F6:** `~/.psqlrc` and `PSQLRC` are ignored; every `psql` call uses `-X`. Uploads
  refuse `http://` for remote hosts, and refuse credentials or paths in the URL.
- **Schema hygiene:** with all migrations applied, no `SECURITY DEFINER` function in
  `public` is executable by everyone, and the Phase 1 internal helpers are not executable
  by app users.
- **F7:** a role created from the SQL file has all four attributes false, plus no
  inherit, bypass RLS and a connection limit of 2. The file declares them explicitly and
  contains no password. On the full app schema it is READY, and its accessible schemas
  are exactly `public`, `storage`, `supabase_migrations`.

**Phone-based flow** (`scripts/tests/backup-phone-flow-local-test.sh`, run against the
local stack exactly as in Termux): **21/21 passed** (re-run after the security fixes).
- **Tool check** passes (tools, key round trip, scripts).
- **Read-only login**, created from `readonly-role-setup.sql` with the password set
  separately:
  - connection check READY;
  - the check refuses the full `postgres` login;
  - a wrong password fails cleanly.
- **Export with the read-only login:**
  - an encrypted file and a manifest are saved locally;
  - no plaintext file is written;
  - the manifest contains no row data.
- **The export refuses:**
  - the full `postgres` login;
  - the removed Management API mode;
  - a remote URL without `sslmode`;
  - an `OUT_DIR` inside the repository.
- **Verify:**
  - OK with the right key;
  - fails with a wrong key;
  - detects a manifest mismatch.
- **Optional upload:**
  - accepted;
  - a second upload of the same file is refused;
  - a non-encrypted file is refused;
  - the upload key cannot download;
  - uploaded bytes are identical.
- **Cleanup:** the role is removed.

**Write protection of the read-only login** (separate local test): update, delete,
insert, create table and disable triggers were all refused **even after switching its
read-only setting off**. Nothing changed. Reading login accounts was refused.

**Restore drill:** export → upload → damage the database → version guard refuses →
restore → **29/29 tables checksum-identical**, 791 rows; no plaintext left.
**Missing login account:** the restore stops on the foreign key and changes nothing.

**Legacy-file round trip** (`scripts/tests/legacy-files-local-test.mjs`): **29/29
passed.**
- default renaming leaves photos, video and PDF byte-identical;
- the opt-in renaming removes every original name;
- the reverse from the encrypted backup restores storage objects, rows, history and
  audit exactly.

**Regression:**
- integration suite 137/137;
- type check clean;
- after the rollback, functions and policies are identical to production. (The local
  test bucket's policy was removed first; it is not part of the app.)

## 10. Retention (planned, manual)

- Keep the pre-deployment backup until Phase 1 is verified, and **at least as long as
  you may want to reverse the file-name redaction.** Delete it at the latest after 30
  days, from `~/dlm-backups`, your Drive and the optional backup project.
- Keep your private key for as long as any backup exists.
- Nothing deletes backups automatically. Until you do it, the privacy policy must not
  claim 30-day retention as operational.
