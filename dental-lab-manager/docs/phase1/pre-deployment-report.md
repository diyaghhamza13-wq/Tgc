# Phase 1 — Pre-deployment report (v2)

Checked 2026-11-14.
- **Production:** read-only aggregate queries only. No row contents, file contents or
  file names were read.
- **Testing:** done on the local Supabase stack.

**Nothing has been deployed, applied or exported.**

---

## 1. Rules for handling sensitive material (from your instructions)
- Patient data, PIN hashes, backup files, backup keys and passphrases are **never** sent
  through this chat, e-mail or the repository.
- The only key material that may appear in chat is your backup **public** key
  (`age1…`). It can only encrypt, not decrypt.
- Credentials for the backup destination go through the secure credential form only.

---

## 2. What changed since v1

| Change | Files |
|---|---|
| Earlier non-3D files (photos, video, CBCT, PDFs, …) visible to **administrators only** | Migration §7 (`attachments_select`, `case_files_read`, `is_legacy_sensitive_file`, `can_read_case_object`); `case/[id].tsx` "legacy file" hint; locales |
| Removal of original legacy file names from storage paths, signed URLs, attachment rows, history and audit logs | Migration §8 (`redact_legacy_attachment`, `redact_legacy_file_names`, `_redacted_path`); `scripts/redact-legacy-files.mjs`; test `scripts/tests/legacy-files-local-test.mjs` |
| Encrypted backup, insert-only destination, tested restore | `scripts/backup/export.mjs`, `scripts/backup/restore.mjs`, `docs/backup/README.md`, `docs/backup/backup-project-setup.sql` |
| Rollback extended to the new policies and functions | `supabase/rollback/rollback_20261114155851_production_only_cases.sql` |
| Photo-permission text and store listing no longer mention case photos, DICOM or PDF | `app.json`, `store/listing.md` |
| Privacy policy v2, Data Safety v2 | `docs/phase1/*.md` |

**Tests** (local):
- integration suite 137/137;
- legacy-file test 18/18;
- backup drill passed (29/29 tables identical after restore);
- type check passes;
- after the rollback, functions and policies are again identical to production.

---

## 3. Existing patient data and old attachments after deployment

### 3.1 Legacy patient names (15 in 10 labs, name only)
- **Rows are kept unchanged** (fingerprint-verified locally). Cases keep their link.
- **No laboratory user can access them through the app or the API, including
  administrators.**
- **Who can still access them:**
  - the developer, through the Supabase dashboard or Management API (this includes this
    Claude session through its proxy credential);
  - Supabase as host;
  - the encrypted backup, readable only with your private key.
- **Deletion:**
  - automatic if the lab deletes itself;
  - otherwise, the manual request process in privacy policy §7;
  - Phase 2 is a separate decision.

### 3.2 Exposure of original legacy file names: investigated and fixed

Read-only audit of production:
- 4 storage objects whose path contains the original name;
- 4 attachment rows;
- 4 `file_uploaded` history events;
- 4 audit rows (INSERT);
- 0 notifications;
- 0 pending cleanups.

Where the name was exposed, and the fix:

| Where | Exposed to | Fix |
|---|---|---|
| Storage object path, and therefore every **signed download URL** | Anyone who saw the URL (browser history, shared link) | The script **moves** each object to `<lab>/<case>/<new uuid>.<ext>` with the Storage API. The signed URL then contains only IDs. |
| `attachments.file_name` | Lab members who could see the case, through the API | Replaced by a technical label (`photo.jpg`, `other.mp4`, `scan_upper.stl`) |
| `case_history.data.file_name` | Lab members, through the API | Same label |
| `audit_logs` old/new data (`file_name`, `storage_path`) | Lab administrators with `audit.view` | Same label and the new (or `redacted`) path. This includes the audit row created by the redaction itself. |
| New uploads and deletions | — | Already anonymous since Phase 1 (random name, technical label) |

- **Tested locally**, with real storage objects named after a fictional patient:
  - 0 occurrences left in attachments, history, audit and storage;
  - the signed URL contains no name;
  - the content is unchanged and still downloadable;
  - the script is idempotent and prints no names;
  - the redaction functions cannot be called by app users.
- **Irreversible:** after redaction, the original names exist only in the encrypted
  backup.
- **What the fix cannot reach:**
  - URLs already in someone's browser history: they pointed to objects that no longer
    exist under that name;
  - Supabase's own request logs, kept for the provider's retention period.
- **When:** at deployment, after the migration and the backup, with your approval. It
  changes 4 attachment rows, 4 history rows, the related audit rows and 4 storage object
  names. It deletes nothing.

### 3.3 Who can see legacy files after deployment

| File type | Before | After |
|---|---|---|
| Legacy photos, video, CBCT, PDF, other non-3D | Every employee who could view the case (all default roles) | **Administrators of that lab only** (permission `attachments.delete_any`). Others neither see nor download them. |
| Legacy 3D files (STL…) | Every employee who could view the case | Unchanged (production files) |
| New files | — | Only 3D production files can be uploaded |

### 3.4 Review of the legacy photos and video, and the safest handling

**Metadata only.** I did **not** open or download the files, and I recommend that nobody
except the laboratory concerned does.

| Lab | File | Size | Uploaded | Case status | Lab employees |
|---|---|---|---|---|---|
| LAAB001 | video (MP4), category "other" | 6.2 MB | 2026-11-07 | delivered | 1 |
| LAB002 | photo (JPEG) | 0.37 MB | 2026-11-10 | waiting | 4 |
| LAB004 | photo (JPG) | 0.05 MB | 2026-11-10 | new | 6 |
| LAB001 | STL scan, a production file, not sensitive by type | 25.7 MB | 2026-11-08 | cancelled | 1 |

**Safest handling, in order:**
1. **Contain:** after deployment, only the lab's administrators can see them, and their
   names are removed (3.2–3.3).
2. **Let the data controller decide:**
   - Ask the administrator of LAAB001, LAB002 and LAB004 to review the file in the app
     and delete it if it is not needed. Deleting is supported: administrators have
     "delete any file", and the deletion is logged with the neutral label.
   - **If any of these labs is your own test laboratory,** you can do this yourself as
     its administrator.
3. **Do not delete them on the developer side without the lab's instruction.** They
   belong to the lab, and there is no backup of file contents.
4. **If a lab cannot be reached:** propose a dated deletion as part of Phase 2, with
   your separate approval.
5. **Never** move them to another service, preview them, or send them anywhere for
   review.

---

## 4. Remaining health-related data (Organization-account risk)

I could not open Google's live policy pages, so check the following against the current
Health apps policy and the exact message you received.

**Still collected:**
- tooth positions, missing teeth, bridge layout;
- implant specifications;
- 3D intraoral scans;
- restoration types (some point to conditions, for example dentures or night guards);
- free text (notes, QC reasons, order references);
- the dentist + dates + case number, which is pseudonymous: the dentist can re-identify
  the patient.

**Still stored from before:** 15 patient names, 2 photos, 1 video (contained as above).

**Assessment unchanged:**
- The app is still a tool for healthcare providers that manages custom-made dental
  devices. That fits "Healthcare services and management" even without names.
- It has no diagnosis, treatment, clinical decision support, sensors or medical-device
  function.
- **Phase 1 lowers the risk but does not guarantee eligibility for a Personal developer
  account.**

---

## 5. Backup and rollback

### 5.1 Status
- No Supabase backup exists today (API list empty, point-in-time recovery off).
- Database 16 MB; 4 case files ≈ 34 MB.

### 5.2 Chosen: B2, an encrypted export to a separate, insert-only Supabase project
Full design, setup, export and the **tested** restore procedure:
`docs/backup/README.md`. Summary:

- **Scope:**
  - all 29 public tables, including the 15 patient names and the PIN hashes;
  - migration history;
  - storage metadata;
  - **not** included: file contents and Auth accounts.
- **Snapshot:** one read-only `SELECT`.
- **Encryption:** in memory with `age`, to **your public key**. Your private key never
  leaves your phone.
- **Destination:** a separate Supabase project in the same region.
  - Its bucket is **insert-only** for the upload key: no list, download, overwrite or
    delete (tested locally).
  - The upload key is given only through the secure credential form.
- **Restore** (on your phone, Termux):
  1. download the file from the backup project's dashboard;
  2. decrypt it;
  3. `restore.mjs` generates one transaction, guarded by the migration history;
  4. run it with `psql`.
- **Drill passed locally.** After damaging the database: 29/29 tables identical after
  restore, no audit side effects, the guard refused a mismatched schema, the app worked
  (suite 137/137), and no plaintext was left behind.
- **Retention:** at most 30 days; you delete it from the backup project's dashboard.

### 5.3 Rollback
- **Script:** `supabase/rollback/rollback_20261114155851_production_only_cases.sql`. It
  restores all functions and policies to the production state (tested: identical) and
  deletes no data.
- **What it does not undo:**
  - file names already redacted. Only the backup holds the originals; restoring them
    would also require moving the 4 objects back.
  - It keeps `clinic_order_ref` and the nullable `patient_id`.
- **Web:** restore Netlify deploy `6af041aed301440d56a350af` (live since 2026-11-08).
  The current web build is *expected* to fail after the migration (it reads `patients`);
  this has not been tested.

### 5.4 Deployment runbook (each step needs your go-ahead)
1. You complete the backup setup (README §3).
2. Run the B2 export, upload it, record the manifest (B3 "before").
3. Apply the migration (one transaction) and record it in the migration history.
4. Deploy the Phase 1 web build immediately; expect 1–2 minutes of broken case lists
   on the old page.
5. Run `redact-legacy-files.mjs`, dry run first, then apply.
6. Take the B3 "after" fingerprints. Expected differences: only the 4 attachments, 4
   history rows, the audit rows and the permission text.
7. Smoke test on **DEMO2026 only**.
8. Publish the approved privacy policy (in-app, all 3 languages).
9. On failure: rollback SQL, restore the Netlify deploy, stop and report.

---

## 6. Migration timestamp
- Renamed to `20261114155851`.
- No conflict in production (latest `20261114000100`), in the repository or on either
  remote branch.

---

## 7. Remaining risks (for your approval)

| # | Risk | Severity | Mitigation / your decision |
|---|---|---|---|
| R1 | **Google may still treat the app as a health app needing an Organization account.** Phase 1 does not change what the app fundamentally is. | High | Get the exact Google message; prepare the Organization account (D-U-N-S) in parallel; or web-only distribution. |
| R2 | **No backup exists until you set up the backup project and key.** Until then the only safety net is the rollback script (schema only). | High | Do README §3 before deployment. Alternative: Supabase Pro (B1). |
| R3 | The backup upload over the **hosted** gateway with only an `apikey` header was tested locally only. | Medium | The first real upload confirms it. If it fails, nothing is exported anywhere else. |
| R4 | **Losing the private key = losing the backups.** Leaking it exposes the patient names and PIN hashes in them. | Medium | Offline copy; delete backups after ≤ 30 days. |
| R5 | **File-name redaction is irreversible.** It also modifies 4 audit rows (privacy redaction of the audit trail). | Medium | Your explicit approval at deployment; originals remain only in the encrypted backup. |
| R6 | 2 legacy photos and 1 video remain until their labs act. File **contents** (images, possible embedded metadata) are unchanged. | Medium | Administrators only after deployment; ask the 3 labs (§3.4). |
| R7 | Labs (data controllers) lose app access to their own legacy patient names; requests become a manual developer task with promises (verification, 30 days, encrypted copy). | Medium | Publish policy §7 only if you can honour it; otherwise plan Phase 2. |
| R8 | **Free text** (notes, order references) can still contain patient names or clinical information. The app only warns. | Medium | Warnings in the UI and policy; lab responsibility. |
| R9 | The Data Safety answers are verified against the code, **not** against Google's current definitions (network refused). | Medium | Compare the rows marked "verify" in Play Console. |
| R10 | The free backup project can pause after inactivity. | Low | Resume from the dashboard; or use a paid plan. |
| R11 | A 1–2 minute window during deployment where the old web page cannot list cases. | Low | Deploy at a quiet time; Android not yet published. |
| R12 | Supabase platform request logs may still contain old file paths until they expire. | Low | Provider retention; outside the app's control. |
| R13 | The developer (and this session's credential) retains full database access, including legacy patient names. | Low–Medium | Disclosed in the policy (§5); limit dashboard access to you. |
