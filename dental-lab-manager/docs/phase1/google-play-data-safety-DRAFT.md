# Google Play Data Safety — DRAFT v4 answers for Phase 1

> **Status: final draft for review. Nothing has been submitted.**
> These answers describe the app **after** Phase 1 is deployed (migration
> `20261114155851` applied and an Android build containing the Phase 1 code). Submit them
> only after that, and after privacy policy v4 is published.
>
> **Changes since v3:**
> - **Backups removed:** no backup is in operation, so the backup project no longer
>   appears among the service providers.
> - **Earlier file names unchanged (your decision, option C):** no answer changes; the
>   privacy policy v4 §3 says who can still see them.
> - Corrected section references to the pre-deployment report (§5).
>
> **Verification limits — please read:**
> - Every answer below was **checked against the actual code**; the evidence column
>   gives the file.
> - I could **not** check the answers against Google's *current* definitions.
>   Network access to Google's help pages (support.google.com, play.google.com) was
>   refused earlier in this session. The definitions quoted are from my training
>   knowledge and **may be outdated.** Each row marked **"verify"** needs you to compare
>   it with the text shown in Play Console.
> - Where unsure, I chose the conservative answer (declare rather than omit).
> - Production facts come from read-only aggregate queries on 2026-11-14.
>
> **Scope:** the Data Safety form describes the **Android app**. The web version
> (Netlify) is not part of it. The Android app talks only to the Supabase project. It
> loads no remote images or fonts: the About page images are bundled. External links
> (website, WhatsApp, LinkedIn) only open the browser.

## Production facts

| Item | Production |
|---|---|
| Laboratories | 12 |
| Legacy patient records | 15 in 10 laboratories, name only |
| Cases | 15 (all linked to a legacy patient); 2 have free-text notes |
| Legacy attachments | 4: 1 MP4 (lab LAAB001), 1 JPEG (LAB002), 1 JPG (LAB004), 1 STL (LAB001) |
| Lab assets (logos, profile photos) | 0 uploaded so far |

## Section 1 — Overview

| Question | Answer | Evidence in code | Google definition (from memory — verify) |
|---|---|---|---|
| Collects or shares required user data types? | **Yes** | See section 2 | — |
| All user data encrypted in transit? | **Yes** | `eas.json`: `EXPO_PUBLIC_SUPABASE_URL=https://…`; `supabase-js` uses HTTPS. No cleartext endpoints. | Data sent over TLS/HTTPS |
| Users can request data deletion? | **Yes** | `profile.tsx` (Delete my account → `manage-employee` `delete_my_account`); lab profile (Delete this laboratory → `delete_lab`); privacy policy §7–8 | Google also asks for a **web link** where deletion can be requested. Use `https://dental-lab-manager.netlify.app/privacy`, which must contain the approved policy §7–8 (**not published yet**). **Verify** this satisfies the current account-deletion requirement. |
| Data shared with third parties? | **No** | Only Supabase (hosting: database, authentication, file storage) and Netlify (web version) receive data, as service providers | Transfers to service providers that process data on your behalf are **not** "sharing". **Verify.** |

## Section 2 — Data types

### Personal info
| Type | Answer | Req./opt. | Purposes | Evidence | Notes |
|---|---|---|---|---|---|
| Name | **Collected** | Required | App functionality, Account management | Employee name required (`admin/employee/[id].tsx`, `register.tsx`); dentist name required (`admin/catalog.tsx`) | Legacy patient names stored, not collected by this version, not shown in the app (policy §3) |
| Email address | **Collected** | Optional | App functionality, Account management | Employee email (`admin/employee/[id].tsx:82`), lab email (`admin/lab.tsx:77`), dentist email (`catalog.tsx`) | |
| User IDs | **Collected** | Required | App functionality, Account management, Fraud prevention/security/compliance | Lab code, employee code, Supabase account IDs (`employee-login`) | |
| Address | **Collected** | Optional | App functionality | Lab address/city (`admin/lab.tsx:78–79`), dentist address/city (`catalog.tsx`) | Business addresses. **Verify** whether Google expects business addresses here; declaring is the safe choice. |
| Phone number | **Collected** | Optional | App functionality | Employee (`admin/employee/[id].tsx:81`), lab (`admin/lab.tsx:76`), dentist (`catalog.tsx`) | |
| Other info | **Collected** | Required | App functionality | Role, department, specialty (`admin/employee/[id].tsx`) | |
| Race/ethnicity, political or religious beliefs, sexual orientation | Not collected | — | — | No such fields | |

### Health and fitness
| Type | Answer | Req./opt. | Purposes | Evidence | Notes |
|---|---|---|---|---|---|
| Health info | **Collected (conservative — verify)** | Required to create a case | App functionality | `CaseWizard.tsx` + `ToothChart.tsx`: tooth positions, missing teeth, implant specifications; 3D scans | Google's definition (from memory): *"information about health, such as medical records or symptoms."* This data describes a patient's teeth and implants. It is about a **third party** (the patient), not the app user, and can be linked to the patient through the dentist. **Verify** whether Google counts third-party data entered by professionals. If unsure, keep "Collected". |
| Fitness info | Not collected | — | — | — | |

### Photos and videos
| Type | Answer | Req./opt. | Purposes | Evidence | Notes |
|---|---|---|---|---|---|
| Photos | **Collected** | Optional | App functionality | `profile.tsx:41` (profile photo), `admin/lab.tsx:57` (lab logo); `expo-image-picker` gallery only, camera disabled (`app.json`); permission text corrected to "only to set your profile picture and your laboratory logo" | Case photos are rejected by this version. |
| Videos | **Not collected** by this version | — | — | Upload whitelist: STL/PLY/OBJ/3MF/DCM (`files.ts`, attachments trigger, storage policy) | 1 legacy MP4 remains stored, visible to administrators only. It is left untouched per your instruction. See report §5. |

### Audio, files, calendar, contacts
| Type | Answer | Evidence |
|---|---|---|
| Voice/sound recordings, music, other audio | Not collected | `RECORD_AUDIO` blocked (`app.json`); image picker microphone disabled |
| Files and docs | **Collected**, optional, App functionality | 3D production files (`files.ts`, `case/[id].tsx`, `CaseWizard.tsx`) |
| Calendar events | Not collected | Dates are case due dates, not calendar access |
| Contacts | Not collected | No contacts permission or API |

### App activity
| Type | Answer | Req./opt. | Purposes | Evidence |
|---|---|---|---|---|
| App interactions | **Collected** | Required | App functionality, Fraud prevention/security/compliance | `case_history` (production actions), `audit_logs` (database changes), `employees.last_login_at` |
| In-app search history | Not collected | — | — | Search filters the loaded list on the device (`queries.ts` `filterCases`); nothing is sent or stored |
| Installed apps | Not collected | — | — | — |
| Other user-generated content | **Collected** | Optional | App functionality | Case notes, manufacturing notes, QC reasons, clinic order references, dentist notes |
| Other actions | Not collected | — | — | — |

### Not collected (with evidence)
| Category | Evidence | Notes |
|---|---|---|
| Location (approximate / precise) | No location permission or API | Supabase records request IP addresses in its platform logs for security; the app never derives a location from them. **Verify** Google's current position on IP addresses. |
| Financial info | No payment features | |
| Messages (email, SMS, in-app messages) | Notifications are system-generated production events (`notifications` table), not user-to-user messages | |
| Web browsing | No in-app browser history | |
| App info and performance (crash logs, diagnostics, other) | No crash-reporting or analytics SDK in `package.json`. `expo-updates` has no update URL in `app.json`, so it makes no update checks. | |
| Device or other IDs | No advertising ID, push token or device identifier read by the app | Supabase Auth stores session metadata (IP, user agent) for login security. **Verify** whether Google counts these. |

## Section 3 — Security practices
- Encrypted in transit: **Yes** (see above).
- Deletion request: **Yes**: in the app, plus the privacy page link.
- Independent security review: **No.** Do not claim it.
- Families policy: not applicable (professional app, not for children).

## Decisions for you
1. **D1 — Health info:** recommended **Collected** (see the row above).
2. **D2 — Legacy photos and video:** see pre-deployment report §5. Their names and
   content stay unchanged (option C).
   - Per your instruction, nobody on the operator side modifies or deletes them.
   - If their laboratories delete them before you submit, the answers above are
     complete.
   - If they are kept, they are stored data but not collected by this version. Ticking
     Photos (already Yes) covers photos. For the video, the strictly conservative choice
     is to tick Videos as well.
3. **D3 — Legacy patient names:** "Name" is declared anyway because of employees and
   dentists. Nothing changes in the form, but the privacy policy §3 and §7 must be
   published.
4. **The Data Safety form does not decide whether an Organization account is required.**
   That comes from the Health apps declaration and the app's features (report §7).

## Consistency with privacy policy v4
| Data Safety answer | Policy v4 |
|---|---|
| Name, email, user IDs, address, phone, other info (role etc.) | §2 Laboratory, Employees, Dentists |
| Health info (conservative) | §2 Manufacturing specification, §6 Health-related information |
| Photos (profile photo, lab logo) | §2 Employees (profile photo), Laboratory (logo) |
| Videos / case photos not collected | §2 "What the app does not collect" |
| Files and docs (3D files) | §2 Production files |
| App interactions | §2 Technical data (audit logs) |
| Other user-generated content | §2 Cases (order reference, notes), §6 free-text reminder |
| No sharing; service providers only | §5 Supabase and Netlify |
| Encrypted in transit | §5 HTTPS |
| Deletion in the app + web link | §8 (in-app deletion), §7 (requests), published at `/privacy` |
| No ads, analytics or tracking | §4 |
