# Phase 1 — Pre-deployment report (v4)

Checked 2026-11-14.
- **Production:** read-only aggregate queries only. No row contents, file contents or
  file names were read.
- **Testing:** done on the local Supabase stack.

**Nothing has been deployed, applied, exported, renamed or deleted in production. No
database role or permission has been created or changed. No backup project exists.**

---

## 1. Rules for handling sensitive material (from your instructions)
- Patient data, PIN hashes, backup files, backup keys and passwords are **never** sent
  through this chat, e-mail or the repository.
- **Backups are exported and encrypted on your phone.** No cloud session or AI
  assistant handles backup data.
- **The private backup key belongs to you and stays on your phone** (plus your offline
  copy). No developer, contractor or AI assistant ever possesses it.
- **Legacy production photos and videos are not modified, renamed, opened, downloaded
  or deleted** on the operator side.
- The privacy policy and the Data Safety form are **not published or submitted** until
  you approve them explicitly.

---

## 2. Safeguards: active today vs. ready vs. planned

| Safeguard | Status |
|---|---|
| Tenant isolation, row-level security, HTTPS, account and lab deletion, audit log | **Active in production today** |
| Phase 1 rules (no patient data in new cases, only 3D uploads, patient names hidden) | **Ready** (tested locally); active only after the migration and web deploy you approve |
| Legacy non-3D files visible to administrators only | **Ready**; same |
| Legacy file-name redaction (default: 3D files only) and its exact reversal | **Ready** (tested locally); runs only with your approval, on your phone |
| Rollback script | **Ready** (tested: identical to production afterwards) |
| **Phone-based backup** scripts (tool check, connection check, export, verify, optional upload, restore) | **Ready** (tested locally as in Termux) |
| Read-only backup login `dlm_backup_reader` | **Proposal** (`docs/backup/readonly-role-setup.sql`); **not created in production** |
| Your key pair; Termux set up on your phone | **Planned** |
| Phone → Supabase connection (direct IPv6 or pooler) | **Untested** until you run the connection check |
| Separate backup project | **Optional**, not created |
| 30-day backup retention | **Planned**: a manual task for you |
| Cloud-session (Management API) export | **Disabled by default** in `export.mjs`; no longer a supported method |
| Privacy policy v3+, Data Safety v3 | **Drafts**, not published or submitted |

---

## 3. What changed since v3 (repository only)

| Change | Files |
|---|---|
| Export is **phone-first:** saves locally only; refuses logins that can write or read `auth`, refuses remote URLs without TLS, refuses Management API mode unless `ALLOW_CLOUD_EXPORT=1` | `scripts/backup/export.mjs` |
| New: tool check for Termux (no database) | `scripts/backup/termux-check.sh` |
| New: connection check, metadata only (no export) | `scripts/backup/check-connection.mjs` |
| New: verify a backup without writing plaintext (decrypt into a pipe) | `scripts/backup/verify.mjs` |
| New: **optional** upload of an already encrypted file | `scripts/backup/upload.mjs` |
| New: read-only login proposal with exact permissions and a removal script | `docs/backup/readonly-role-setup.sql` |
| New: local test of the whole phone flow | `scripts/tests/backup-phone-flow-local-test.sh` |
| README rewritten for the phone-based flow; privacy draft's backup block updated (still conditional, still unpublished) | `docs/backup/README.md`, `docs/phase1/privacy-policy-DRAFT.md` |
| **Correction:** the legacy-file round trip has **29** checks; v3 wrongly said 30 | this report, README |

---

## 4. Test results (local, 2026-11-14)

| Test | Result |
|---|---|
| Phone-based backup flow (`backup-phone-flow-local-test.sh`) | **21/21 passed** |
| — read-only login: connection check READY; full `postgres` login and wrong password rejected | ✓ |
| — export saves only an encrypted file and a manifest without row data; refuses the full login, cloud mode, non-TLS remote URL, `OUT_DIR` in the repository | ✓ |
| — verify: OK with the right key; fails with a wrong key; detects a manifest mismatch | ✓ |
| — optional upload: accepted once; no overwrite; non-encrypted file refused; the upload key cannot download | ✓ |
| Read-only login write protection (separate test) | All writes, DDL and trigger changes refused even with its read-only setting switched off |
| Restore drill (export → damage → guard → restore) | **29/29 tables identical**, 791 rows |
| Restore with a missing login account | Stopped, nothing changed |
| Legacy-file round trip (`legacy-files-local-test.mjs`) | **29/29 passed** |
| Integration suite | **137/137** |
| Type check; syntax of all scripts | clean |
| Rollback → functions and policies identical to production | ✓ (after removing the local test bucket's policy, which is not part of the app) |

**Bug found and fixed:** both connection checks used `has_table_privilege` with table
*names*. PostgreSQL could evaluate it on tables of other schemas before the `public`
filter, causing the error `relation "public.instances" does not exist`. They now use
table OIDs.

---

## 5. Existing patient data and old attachments after deployment

Unchanged from v3:
- **Legacy patient names** (15 in 10 labs) are kept unchanged and hidden from every app
  user, administrators included. Access remains for you via the dashboard and
  Management API, for Supabase as host, and, once it exists, through your encrypted
  backup.
- **Legacy photos and video** (LAAB001 video, LAB002 and LAB004 photos) are visible only
  to their labs' administrators after deployment. **Not touched by default:** the
  renaming script skips them unless `INCLUDE_SENSITIVE=1`.
- **The legacy STL** (LAB001) is renamed in default mode. This is reversible with the
  reverse script and a backup taken before.
- **Where the reverse runs:** both the reverse script and the renaming script read
  original file names, so run them **on your phone** to keep those names out of any
  cloud session.

---

## 6. Backup and rollback

### 6.1 Status
- No Supabase-managed backup exists (API list empty, point-in-time recovery off).
- No phone backup exists yet.

### 6.2 Plan
Phone-based export with the read-only login, saved locally first, verified, copied
(encrypted only) to Drive and/or the optional backup project. Full procedure:
`docs/backup/README.md`.

### 6.3 What the backup does NOT contain
- **File contents** (a lost file cannot be restored from it).
- **Supabase Auth login accounts** (a restore stops if one is missing; accounts are
  recreated manually).
- Structure, settings, secrets, Edge Functions and the web site (rebuilt from the
  repository or managed separately).

### 6.4 Rollback
Unchanged:
- run the reverse script first if the renaming ran;
- then `rollback_20261114155851_production_only_cases.sql`;
- then restore Netlify deploy `6af041aed301440d56a350af`.

### 6.5 Deployment runbook (each step needs your explicit go-ahead)
1. **Phone preparation:** Termux, packages, key pair and offline copy, `termux-check.sh`
   (README §5.1–5.4). No production access involved.
2. **Approval A:** create the read-only login in production (README §4); you set its
   password yourself.
3. You run `check-connection.mjs` on your phone; it must report READY.
4. You run the export on your phone, verify it, and keep encrypted copies (locally plus
   Drive and/or the backup project). The manifest is the "before" fingerprint.
5. **Approval B:** apply the migration (one transaction) and record it in the migration
   history.
6. Deploy the Phase 1 web build immediately; expect 1–2 minutes of broken case lists on
   the old page.
7. **Optional, Approval C:** the renaming script in default mode (STL only), dry run
   first, run **on your phone**.
8. "After" fingerprints: counts and checksums only.
9. Smoke test on **DEMO2026 only**.
10. **Approval D:** publish the privacy policy (only the parts that are active) and
    submit the Data Safety form.
11. On failure: reverse (if step 7 ran) → rollback SQL → restore the Netlify deploy →
    stop and report.

---

## 7. Remaining health-related data (Organization-account risk)
Unchanged: Phase 1 lowers the risk but **does not guarantee eligibility for a Personal
developer account.** Google's live policy pages could not be checked from this
environment.

## 8. Migration timestamp
`20261114155851`: no conflict (latest in production `20261114000100`).

---

## 9. Remaining risks (for your approval)

| # | Risk | Severity | Mitigation / your decision |
|---|---|---|---|
| R1 | Google may still require an Organization account. | High | Get the exact Google message; prepare the Organization account; or web-only distribution. |
| R2 | **No backup exists** until the phone setup, the read-only login and the first export are done. | High | Runbook steps 1–4 before any deployment. |
| R3 | The backup excludes file contents and login accounts. | Medium | Accept, or decide later on an encrypted file backup. |
| R4 | Losing the private key makes all backups unreadable and the renaming irreversible; leaking it exposes the patient names and PIN hashes in them. | Medium | Offline copy; delete old backups. |
| R5 | The renaming is reversible only while the pre-renaming backup and your key exist. | Medium | Keep that backup until you are sure. |
| R6 | With the default, photo and video names stay (administrators only). | Medium | Your instruction; option A only by explicit decision. |
| R7 | Legacy patient-name requests become a manual task for you. | Medium | Publish policy §7 only if you can honour it. |
| R8 | Free text can contain patient information. | Medium | UI warnings and policy. |
| R9 | The Data Safety answers are not verified against Google's current definitions. | Medium | Compare the "verify" rows in Play Console. |
| R10 | **Your phone becomes the most sensitive point.** It holds the private key and is where you type the read-only password. Malware or an unlocked stolen phone could expose both. | Medium | Screen lock, updated Android, Termux only from F-Droid, no unknown apps; passwords typed with `read -rs`, never stored; rotate the read-only password after use. |
| R11 | **The read-only login can read everything** (`BYPASSRLS`), including patient names and PIN hashes, from any network. It is protected only by its password. | Medium | Long random password; rotate it; remove the login if unused (removal SQL provided). |
| R12 | Phone → Supabase connection (IPv6-only direct host, or a custom login through the pooler) and the Termux packages are unverified. | Low–Medium | The connection check reveals it without exporting. |
| R13 | An encrypted copy in Google Drive places encrypted personal data with Google. | Low | Encrypted with your key only. Choose Drive and/or the backup project in the policy's `[[CHOOSE]]`. |
| R14 | Free backup project pauses after inactivity (if used). | Low | Optional; resume from the dashboard. |
| R15 | **This session keeps full Management API access** (and a Netlify deploy token) until you remove them; see §10. | Medium | Your decision after reading §10. |
| R16 | 1–2 minutes of broken case lists on the old web page during deployment; Supabase logs may keep old paths. | Low | Deploy at a quiet time. |

---

## 10. The saved tokens: what removing them changes (nothing removed yet)

This environment ("Tgc (Supabase deploy)") stores **two** credentials. The proxy injects
them for every session that uses this environment, including future ones:

| Credential | What it allows today |
|---|---|
| **Supabase Management API token** (`api.supabase.com`) | **Full control of the project:** run any SQL as `postgres` (read and change all data, apply migrations), deploy or delete Edge Functions, read API keys including the service-role key, read and set secrets, change Auth settings, read the backup status. A Supabase personal access token usually covers **every project** your Supabase account can access, not only this one. |
| **Netlify token** (`api.netlify.com`) | Deploy, roll back or change the web site. The web app itself only has the public anon key, limited by row-level security. **But a modified web build could capture the data of employees who use it.** This token is therefore also sensitive. |

**If you remove the Supabase token**
- **I can no longer:**
  - apply migrations;
  - run read-only checks (counts, fingerprints, backup status);
  - deploy Edge Functions or read keys and secrets;
  - change Supabase settings;
  - see any production data.
- **What stays:**
  - GitHub access to `diyaghhamza13-wq/tgc`: code only, and pushing does not deploy
    anything, because there is no CI;
  - the Netlify token, unless you remove it too;
  - network access to the public app endpoint `slfwakmskshkbrfqqfwl.supabase.co`. Without
    a key, it gives no data beyond what any visitor with the public anon key gets.
  - the local test stack.
- **Future maintenance would work like this:**

  | Task | Without the token |
  |---|---|
  | Apply a migration (including Phase 1) | You paste the prepared SQL into the dashboard's SQL editor; or you add a **new, temporary** token for that task and remove it afterwards |
  | Deploy or update Edge Functions | Dashboard function editor, or a temporary token |
  | Read-only checks, fingerprints, troubleshooting | You run the prepared queries in the SQL editor and share only counts and checksums; or a temporary token |
  | Backups | Unaffected: they run on your phone with the read-only login |
  | Web deploys | Unaffected while the Netlify token remains |

**How to remove it** (later, when you decide). Do both steps:
1. In this environment's settings (cloud environment menu → Edit → Network secrets),
   delete the `api.supabase.com` entry. Then sessions no longer send it.
2. **Revoke the token itself** in the Supabase dashboard (Account → Access Tokens).
   Deleting it from the environment alone does not invalidate it.

The same two steps apply to the Netlify token (Netlify → User settings → Applications →
Personal access tokens).

**Suggested timing:**
- If you approve the Phase 1 deployment, keep the Supabase token until the migration is
  applied and verified, then remove and revoke it.
- If you prefer to apply the migration yourself through the SQL editor, you can remove
  it now. Nothing in the phone-based backup depends on it.
