# Phase 1 — Pre-deployment report

Checked 2026-11-14.
- **Production:** read-only queries only, aggregate counts only, no row contents read.
- **Testing:** done on the local Supabase stack.

**Nothing has been deployed or applied.**

---

## 3. What happens to existing patient data and old attachments

### 3.1 Legacy patient records (`public.patients`: 15 rows in 10 labs, name only)

| | After deployment |
|---|---|
| Rows | **Kept unchanged.** Not deleted, not modified, not anonymized. Verified locally: before/after fingerprints identical. |
| Link from cases | `cases.patient_id` of the 15 existing cases is kept. New cases have no patient. |
| Laboratory users (all roles, including administrators) | **Cannot read, search, export or edit them.** All privileges were revoked from `anon` and `authenticated` and the row-level policies dropped. No app screen, report or export shows them. An old app version asking for them gets "permission denied". |
| Who can still access them | (1) **The developer**: whoever holds the Supabase dashboard login or the service-role key / Management API access. This includes this Claude session through the proxy credential. (2) **Supabase** as the hosting provider. (3) Database functions running with owner rights: after Phase 1 the only one that touches `patients` is the cascade in laboratory deletion. |
| Deletion | Deleted automatically when the laboratory deletes itself (foreign key cascade). Otherwise kept until a separate Phase 2 decision. |
| ⚠ Consequence | The laboratory, which is the data controller, can no longer see its own patient names. A patient's request for access or deletion would have to be handled manually by the developer. The draft privacy policy says so; see D3 in the Data Safety draft. |

### 3.2 Legacy attachments (4 files ≈ 34 MB: 2 photos, 1 MP4 video, 1 STL)

| | After deployment |
|---|---|
| Rows and storage objects | **Kept unchanged** (verified locally). |
| Who can see / download | **Unchanged from today:** any employee of the same lab who can view the case. All default roles have `cases.view_all`, so in practice every employee of that lab. Downloads use temporary signed links (10 minutes). |
| Who can delete | Unchanged: the uploader, or employees with `attachments.delete_any` (administrators). The deletion history entry now records a neutral label (for example `photo.jpg`), not the original name. |
| Name shown in the app | Masked: `photo.jpg`, `other.mp4`, `scan_<technical words>.stl`. The stored row is not changed. |
| ⚠ What masking does **not** cover | (a) **The file content is unchanged.** A photo is still a photo; DICOM headers or PDF text would still contain identities. (b) **The original file name is still stored** in `attachments.file_name`, in the storage object path (4 of 4 legacy objects), in 4 older history events and in 4 audit-log rows. A lab member who calls the API directly, rather than using the app, can read the name from `attachments` and `case_history`. Administrators with `audit.view` can read it from the audit log. **On the web version, the signed download link contains the original file name in its URL.** |
| Other labs | No access (tenant isolation unchanged and re-tested). |

### 3.3 Other legacy content
- **2 cases have free-text notes.** I did not read them, so their content is unknown.
  Notes stay visible to lab members as before.
- **Database backups and logs** kept by Supabase, if any, contain the same data until they
  expire (see section 5).

---

## 4. Remaining health-related data (Organization-account risk)

I could not open Google's live policy pages from this environment, so check the following
against the current Health apps policy and the rejection message you received.

**Still collected by the Phase 1 app:**
1. **Tooth positions** (FDI numbers), **missing teeth** and **bridge layout** for a case.
2. **Implant specifications.** They reveal that a person has implants, where, and of
   what type.
3. **3D intraoral scans** (STL/PLY/OBJ/3MF/DCM): a model of part of a patient's mouth.
4. **Restoration type, material and shade.** Some types are dentures, splints and night
   guards, which point to a condition.
5. **Free text:** case notes, manufacturing notes, QC rejection reasons and clinic order
   references can contain clinical or identifying information. The app warns but cannot
   enforce.
6. **Dentist + dates + case number.** Pseudonymous: the ordering dentist can always link
   the case to the patient.

**Still stored from before Phase 1:** 15 patient names, 2 photos, 1 video. Also the
original file names, which may contain names.

**How this relates to Google Play:**
- **Functionally, the app is still a tool used by and for healthcare providers.** It
  manages custom-made medical devices (dental restorations) ordered by dentists. That
  fits Google's "Healthcare services and management" type of feature even without
  patient names.
- **It has no diagnosis, treatment, clinical decision support, sensors or medical-device
  function.** These are the categories most clearly tied to the strictest requirements,
  and they lower the risk.
- **My assessment is unchanged.** Phase 1 reduces the risk; it does **not** make the app
  clearly non-health. There is a real chance Google still requires the health
  declaration and an Organization account. **Phase 1 does not guarantee eligibility for a
  Personal developer account.**
- The decisive evidence is the exact text of Google's rejection or requirement message
  and the declaration options you are shown.

---

## 5. Production backup and rollback plan

### 5.1 Backup status (verified read-only)
- Management API `GET /database/backups` returned **an empty list.** Point-in-time
  recovery is **disabled.**
- The project is on a plan that does not keep downloadable backups. **There is currently
  no Supabase backup to restore from.**
- Database size: 16 MB. Storage: 4 case files (≈ 34 MB), 0 lab assets.

### 5.2 Why the risk is limited, and what is still missing
- The migration **does not delete or modify any existing rows.** The single exception is
  the text description of the `cases.create` permission. Verified locally on a copy of the
  production schema (58 functions and all policies byte-identical to production):
  fingerprints of patients, cases, attachments, storage objects and history were identical
  before and after.
- Its changes are schema, permissions and function definitions, which the rollback script
  reverses.
- **But there is no independent safety net.** I recommend creating one **before**
  deployment. Options (each needs your approval). **Chosen: B2, together with the B3
  fingerprints.** The export itself is not done yet; see 5.4 for the plan.
  - **B1 — Upgrade the Supabase project to a paid plan** (daily backups, optional
    point-in-time recovery), then wait for the first backup.
  - **B2 — Read-only logical export through the Management API** of all `public` tables
    (≈ 16 MB) to a private location you choose. Note: this copies personal data,
    including 15 patient names, out of Supabase. It should not stay in this temporary
    container.
  - **B3 — Minimum:** read-only per-table fingerprints (counts + checksums) just before
    and just after deployment, as we did for LAAB001 before. This proves nothing was
    lost, but it is not a restore source.
- Storage files are not touched by the migration. No storage backup is needed for this
  change.

### 5.3 Rollback plan

**Script:** `supabase/rollback/rollback_20261114155851_production_only_cases.sql`. It sits
outside `migrations/`, so it is never applied automatically. It runs in one transaction.

**What it restores:**
- the upload trigger, storage insert policy, `create_case`, `lab_report`, the history
  trigger, `patients` policies and grants, column grants and the permission text;
- it removes the migration-history row.

**What it deliberately keeps:**
- the `clinic_order_ref` column and its values;
- `patient_id` stays nullable. Cases created while Phase 1 was live have no patient, and
  inventing patient rows for them would be wrong.
- files uploaded under Phase 1 keep their anonymous names.

**It deletes no data.**

**Tested locally:**
1. Apply the migration.
2. Create a Phase 1 case.
3. Run the rollback.

Results:
- functions and policies are byte-identical to production;
- the migration-history row is removed;
- the legacy data fingerprint is unchanged and the Phase 1 case is kept;
- **the previous integration suite passes 114/114** on the rolled-back database.

**Web rollback:**
- The live Netlify deploy today is `6af041aed301440d56a350af` (2026-11-08).
- The Phase 1 web build only works **after** the migration, and the current build is expected to fail
  after it (its case lists join `patients`, which app users can no longer read; this
  has not been tested against the old web build).
- Rolling back means: run the rollback SQL, then restore Netlify deploy
  `6af041aed301440d56a350af` (Netlify keeps old deploys; one click or one API call).

**Android:** no build has been published, so no Android rollback is needed.

### 5.4 B2 — encrypted logical export (plan; not executed)

**Scope (what goes in the export)**
- **Every row of every table in schema `public`** (28 tables, ≈ 16 MB database):
  laboratories, employees, `employee_credentials` (bcrypt PIN hashes only), doctors,
  **patients (15 names)**, cases, teeth, implants, restorations, workflow, history,
  attachments metadata, notifications, QC, deliveries, audit logs, catalogs.
- `supabase_migrations.schema_migrations` (the 7 version rows).
- **Storage metadata** for buckets `case-files` and `lab-assets`: object names, sizes,
  timestamps. Not the file contents.
- A **manifest**: per-table row counts and SHA-256 checksums. It contains no personal
  data and doubles as the B3 "before" fingerprint.

**Not included, and why**
- **File contents** (4 files, ≈ 34 MB): the migration never touches storage. They can be
  added as an option (B2+), encrypted the same way.
- **`auth` schema** (login accounts): managed by Supabase Auth and untouched by the
  migration. Restoring it through SQL is not a supported operation. If ever needed,
  administrators re-link accounts by resetting PINs.
- **Database schema:** not needed. Production is byte-identical to migrations 1–7 in the
  repository (verified); the export records which versions were applied.

**How it is produced (read-only)**
- **One single `SELECT` statement** through the Management API returns all tables as one
  JSON document. A single statement reads one consistent snapshot, so the tables cannot
  drift apart during the export. Nothing is written to production.
- The JSON is held **in memory only.** A Python process computes the manifest, then pipes
  the JSON straight into the encryption tool. **No unencrypted copy is ever written to
  disk.**

**Encryption**
- **GnuPG symmetric encryption:** AES-256, OpenPGP with integrity protection (MDC),
  key derived from the passphrase with the strongest iterated S2K setting
  (`--s2k-mode 3 --s2k-count 65011712 --s2k-digest-algo SHA512`).
- **Passphrase:** randomly generated (≈ 160 bits), never printed in logs and never
  committed. It is written to a private scratch file and shown to you **once**, only when
  you ask, the same way as the DEMO2026 PIN.

**Destination**
- **This container is temporary, and the GitHub repository may be publicly visible.**
  The backup must **never** go into the repository, even encrypted.
- I send you the **encrypted file** (`dlm-backup-<timestamp>.json.gpg`) as a file
  attachment in this conversation. You save it to a private place you control, for
  example your Google Drive.
- Keep the **passphrase separately**: a password manager or on paper, **not** in the
  same folder or message as the file.
- After you confirm both are saved, I delete the encrypted file and the passphrase file
  from this container.
- The manifest (no personal data) can stay in the repository's docs for the
  before/after comparison.

**Restore procedure (each step only with your approval)**
1. **Normal case (migration problem):** no data restore. Run the rollback script
   (section 5.3) and restore the previous Netlify deploy.
2. **Data case (rows lost or damaged), done in a new working session:**
   1. Upload the encrypted file and run
      `gpg --decrypt dlm-backup-….json.gpg > backup.json` with the passphrase.
   2. Check every table against the manifest (row counts and SHA-256).
   3. Compare the backup with production read-only, and decide **which tables** to
      restore. Never restore everything blindly: data created after the export would be
      lost.
   4. Restore in **one transaction:** for each chosen table, triggers off (no audit or
      notification side effects), then
      `delete from public.<t>` and
      `insert … select * from jsonb_populate_recordset(null::public.<t>, <backup rows>)`,
      in parent → child order, triggers back on.
   5. Recompute the fingerprints and compare them with the manifest. Then delete the
      decrypted `backup.json`.
3. **Caveat to settle before relying on it:** turning triggers off on Supabase depends on
   the privileges of the `postgres` role. I will **rehearse the whole restore on the local
   stack** first: export the local database with the same script, damage it, restore it,
   compare fingerprints. If triggers cannot be disabled there, the fallback is to restore
   in foreign-key order with triggers active, then delete the audit rows that the restore
   itself created.

### 5.5 Proposed deployment runbook (for later — each step needs your go-ahead)
1. Backup: B2 encrypted export (section 5.4), plus B3 "before" fingerprints.
2. Apply the migration in one transaction and record it in the migration history.
3. Immediately deploy the Phase 1 web build to Netlify. Expect a short window of 1–2
   minutes where the old web page cannot load case lists.
4. B3 "after" fingerprints. Smoke test on **DEMO2026 only**: create a case with an order
   reference, upload an STL, check that a JPG is rejected, and check that the legacy cases
   open.
5. Publish the approved privacy policy text in the same release.
6. If anything fails: rollback SQL, then restore Netlify deploy
   `6af041aed301440d56a350af`, then stop and report.

---

## 6. Migration timestamp — renamed to `20261114155851`

- **Before:** `20261115000100_production_only_cases.sql` was dated tomorrow (today is
  2026-11-14 UTC). That would record a future date in the migration history. Any
  migration created later with a real timestamp before 2026-11-15 would sort before it
  although applied after it, and the Supabase CLI then refuses to push without
  `--include-all`.
- **Conflict check** (read-only, 2026-11-14 15:58 UTC):
  - Production `supabase_migrations.schema_migrations` holds 7 versions, the latest
    being `20261114000100`.
  - The repository and both remote branches (`origin/main`: no migrations;
    `origin/claude/dental-lab-manager-v4d2kv`: the same 7 plus this one) have **no other
    migration** at or after `20261114155851`.
- **Now:** `supabase/migrations/20261114155851_production_only_cases.sql`. It is the
  creation time (UTC), it sorts after `20261114000100`, and it is not in the future. The
  file contents are unchanged.
- **Rollback script renamed to match:**
  `supabase/rollback/rollback_20261114155851_production_only_cases.sql`. It deletes
  version `20261114155851` from the history.
- Earlier commit messages still mention the old number; that is history only.
