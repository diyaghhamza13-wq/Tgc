# Phase 1 — Pre-deployment report (v3)

Checked 2026-11-14.
- **Production:** read-only aggregate queries only. No row contents, file contents or
  file names were read.
- **Testing:** done on the local Supabase stack.

**Nothing has been deployed, applied, exported, renamed or deleted in production.**

---

## 1. Rules for handling sensitive material (from your instructions)
- Patient data, PIN hashes, backup files, backup keys and passphrases are **never** sent
  through this chat, e-mail or the repository.
- **The private backup key belongs to you and stays on your phone.** No developer,
  contractor or AI assistant (including Claude) ever possesses it.
- The only key material that may appear in chat is your **public** key (`age1…`).
- Credentials for the backup destination go through the secure credential form only.
- **Legacy production photos and videos are not modified, renamed, opened, downloaded
  or deleted** on the operator side.

---

## 2. Safeguards: active today vs. ready vs. planned

| Safeguard | Status |
|---|---|
| Tenant isolation, row-level security, HTTPS, account and lab deletion, audit log | **Active in production today** |
| Phase 1 rules: no patient data in new cases, only 3D uploads, patient names hidden | **Ready** (tested locally); active only after the migration and web deploy you approve |
| Legacy non-3D files visible to administrators only | **Ready** (tested locally); same |
| Legacy file-name redaction (forward script) and its exact reversal (reverse script) | **Ready** (tested locally); runs only with your approval |
| Rollback script | **Ready** (tested locally: identical to production afterwards) |
| Encrypted backup scripts and insert-only bucket rule | **Ready** (tested locally) |
| Separate backup project, your key pair, first backup | **Planned**: not created |
| Upload to a hosted backup project | **Untested** |
| 30-day backup retention | **Planned**: a manual task for you; not operational |
| Privacy policy v3, Data Safety v3 | **Drafts**: not published or submitted |

---

## 3. What changed since v2

| Change | Files |
|---|---|
| **Reverse script** for the file-name redaction (storage objects, attachment rows, history, audit) | `scripts/reverse-legacy-file-names.mjs`; migration §8 `restore_legacy_file_records` |
| Forward script **skips photos, videos and other non-3D legacy files by default.** `INCLUDE_SENSITIVE=1` is an explicit opt-in. | `scripts/redact-legacy-files.mjs`; migration §8 (`p_include_sensitive`) |
| Round-trip test (forward default, forward opt-in, reverse from the encrypted backup) | `scripts/tests/legacy-files-local-test.mjs` |
| Privacy policy v3: key ownership, conditional backup text, option A/B for legacy names, database-only backups | `docs/phase1/privacy-policy-DRAFT.md` |
| README: status table, exclusions, reverse procedure, test results | `docs/backup/README.md` |
| Rollback updated for the new function signatures | `supabase/rollback/rollback_20261114155851_production_only_cases.sql` |

---

## 4. Test results (local, 2026-11-14)

| Test | Result |
|---|---|
| Forward + reverse round trip (`legacy-files-local-test.mjs`) | **30/30 passed** |
| — default forward leaves photo, video and PDF byte-identical (rows, objects, history, audit; no audit row added) | ✓ |
| — opt-in forward removes every original name; contents unchanged; anonymous signed URL; idempotent | ✓ |
| — reverse from the decrypted backup: objects back under their original names with identical SHA-256; attachment rows, file history and pre-existing audit rows identical; idempotent | ✓ |
| Backup drill (export → encrypt → upload → damage → guard → restore) | **29/29 tables identical**, 791 rows |
| Restore with a missing login account | Stopped on the foreign key; **nothing changed**; no trigger left disabled |
| Integration suite | **137/137** |
| Type check | clean |
| Rollback → functions and policies identical to production | ✓ |

**One bug was found and fixed during the round trip.** The restore wrote JSON `null`
instead of SQL `NULL` into `new_data` of DELETE audit rows. The function now converts
it, and the test confirms exact equality.

---

## 5. Existing patient data and old attachments after deployment

### 5.1 Legacy patient names (15 in 10 labs, name only)
- **Rows unchanged;** cases keep their link.
- **No laboratory user, administrators included, can access them through the app or
  the API.**
- **Who can still access them:**
  - you (the operator), through the Supabase dashboard or Management API (this includes
    this Claude session through its proxy credential);
  - Supabase as host;
  - the encrypted backup, once it exists, and only with your private key.
- **Deletion:**
  - automatic on lab deletion;
  - otherwise, the manual process in policy §7;
  - Phase 2 is a separate decision.

### 5.2 Original legacy file names

Read-only audit of production: 4 storage paths (and therefore download URLs), 4
attachment rows, 4 history events and 4 audit rows contain original names.

**Default plan (B), the only one compatible with your current instruction:**
- **Renamed:** the 1 legacy STL (LAB001), so its path, row, history and audit no longer
  carry its original name.
- **Not touched at all:** the 2 photos and the video. Their original names stay in their
  storage paths, download URLs, rows, history and audit rows. They are visible only to
  their labs' administrators after deployment (§5.3).

**Option A** (`INCLUDE_SENSITIVE=1`) renames them too. Choosing it would contradict your
current instruction, so it needs a separate, explicit decision.

**Reversibility:**
- Both modes are **reversible** with `scripts/reverse-legacy-file-names.mjs` and the
  backup taken immediately before (tested: exact).
- The reverse runs on your phone, because it needs your private key, and with the app
  project's service-role key, which you copy into Termux yourself.
- **Once the pre-redaction backup is deleted, the redaction can no longer be reversed.**

**What renaming cannot reach:** URLs already in someone's browser history, and
Supabase's own request logs until they expire.

### 5.3 Who can see legacy files after deployment

| File type | Before | After |
|---|---|---|
| Legacy photos, video, CBCT, PDF, other non-3D | Every employee who could view the case | **Administrators of that lab only.** Content and names untouched (plan B). |
| Legacy 3D files (STL…) | Every employee who could view the case | Unchanged access; name redacted |
| New files | — | Only 3D production files can be uploaded |

### 5.4 Legacy photos and video: handling

**Metadata only.** Not opened, downloaded, renamed, modified or deleted.

| Lab | File | Size | Uploaded | Case status | Lab employees |
|---|---|---|---|---|---|
| LAAB001 | video (MP4), category "other" | 6.2 MB | 2026-11-07 | delivered | 1 |
| LAB002 | photo (JPEG) | 0.37 MB | 2026-11-10 | waiting | 4 |
| LAB004 | photo (JPG) | 0.05 MB | 2026-11-10 | new | 6 |

**Handling:**
1. **Contain:** after deployment, only the lab's administrators can see them. This is an
   access rule, not a change to the files.
2. **The lab decides:** its administrator can review and delete them in the app.
3. **No operator-side action** without your explicit decision.
4. **Not covered by the backup:** the backup contains no file contents (§6.3). If a lab
   deletes one, it is gone.

---

## 6. Backup and rollback

### 6.1 Status
- No Supabase backup exists (API list empty, point-in-time recovery off).
- No B2 backup exists either (planned).

### 6.2 Plan (B2)
Full design, setup and procedures: `docs/backup/README.md`.

### 6.3 What the backup does NOT contain (explicit)
- **File contents:**
  - the 4 legacy files (≈ 34 MB), future 3D files, logos and profile photos;
  - only the *list* of objects is saved;
  - a lost file **cannot** be restored from this backup.
- **Supabase Auth login accounts:**
  - not saved and not restored;
  - a restore expects them to still exist. If one is missing, the restore stops and
    changes nothing (tested); accounts are then recreated manually.
- **Structure, settings, secrets, Edge Functions, the web site:** rebuilt from the
  repository or managed separately.

### 6.4 Rollback
- `supabase/rollback/rollback_20261114155851_production_only_cases.sql`: tested,
  identical to production afterwards, deletes no data.
- If the file-name redaction has been run, run the **reverse script first.** The rollback
  removes the function the reverse script needs.
- **Web:** restore Netlify deploy `6af041aed301440d56a350af`. The current web build is
  *expected* to fail after the migration; this has not been tested.

### 6.5 Deployment runbook (each step needs your explicit go-ahead)
1. You complete the backup setup (README §3).
2. B2 export → upload → manifest (B3 "before").
3. Apply the migration (one transaction) and record it in the migration history.
4. Deploy the Phase 1 web build immediately; expect 1–2 minutes of broken case lists on
   the old page.
5. Optional, separate approval: `redact-legacy-files.mjs` in **default mode** (STL
   only), dry run first. Option A only with a further explicit decision.
6. B3 "after" fingerprints.
7. Smoke test on **DEMO2026 only**.
8. Publish the privacy policy, keeping the `[[IF ACTIVE]]` blocks only for what is
   really active.
9. On failure: (reverse script if step 5 ran) → rollback SQL → restore the Netlify
   deploy → stop and report.

---

## 7. Remaining health-related data (Organization-account risk)

**Unchanged from v2:**
- tooth positions, missing teeth, implant specifications, 3D scans, restoration types and
  free text remain;
- the case is pseudonymous through the dentist;
- 15 legacy names, 2 photos and 1 video remain stored.

**Phase 1 lowers the risk but does not guarantee eligibility for a Personal developer
account.** Google's live policy pages could not be checked from this environment.

---

## 8. Migration timestamp
`20261114155851`: no conflict in production (latest `20261114000100`), in the repository
or on either remote branch.

---

## 9. Remaining risks (for your approval)

| # | Risk | Severity | Mitigation / your decision |
|---|---|---|---|
| R1 | Google may still require an Organization account for a health-related app. | High | Get the exact Google message; prepare the Organization account (D-U-N-S); or web-only distribution. |
| R2 | **No backup exists** until you create the backup project and key; until then only the schema rollback exists. | High | README §3 before any deployment. Alternative: Supabase Pro (B1). |
| R3 | **The backup excludes file contents and login accounts.** Lost files and lost accounts cannot be recovered from it. | Medium | Accept, or add an encrypted file-content backup later (separate decision). |
| R4 | Losing the private key makes every backup unreadable, and makes the redaction irreversible. A leaked key exposes the patient names and PIN hashes in the backups. | Medium | Offline copy; delete backups when no longer needed. |
| R5 | The redaction is reversible **only** while the pre-redaction backup and your key exist, and only by running the reverse on your phone. | Medium | Keep that backup until you are sure; then delete it (README §8). |
| R6 | With plan B, the photos' and video's **original names stay** in their storage paths, download URLs, rows, history and audit (administrators only). | Medium | Your instruction; option A later only by explicit decision, or the labs delete the files. |
| R7 | Labs lose app access to their own legacy patient names; requests become a manual task for you, with promises (verification, 30 days, encrypted copy). | Medium | Publish policy §7 only if you can honour it; otherwise plan Phase 2. |
| R8 | Free text can still contain patient names or clinical information. | Medium | UI warnings and the policy; lab responsibility. |
| R9 | The Data Safety answers are verified against the code, **not** Google's current definitions. | Medium | Compare the "verify" rows in Play Console. |
| R10 | The upload to a **hosted** backup project is untested. | Medium | The first real upload confirms it; failure exports nothing anywhere else. |
| R11 | **The export reads plaintext in memory in this cloud session** before encrypting it. That is the same read access the session already has. | Low–Medium | No disk copy; the session never has the private key. |
| R12 | The free backup project can pause after inactivity. | Low | Resume from the dashboard; or a paid plan. |
| R13 | A 1–2 minute broken case list on the old web page during deployment. | Low | Deploy at a quiet time; Android not yet published. |
| R14 | Supabase platform logs may keep old file paths until they expire. | Low | Provider retention. |
| R15 | You (and this session's credential) retain full database access, including the legacy patient names. | Low–Medium | Disclosed in policy §5; limit dashboard access. |
