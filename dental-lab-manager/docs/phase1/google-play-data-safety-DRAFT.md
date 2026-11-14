# Google Play Data Safety — DRAFT answers for Phase 1

> **Status: draft for review. Nothing has been submitted.**
>
> **Limitations:**
> - I could not open Google's live Play Console help pages from this environment, so
>   the category names below follow the Data Safety form as I know it. Check them
>   against the form you see in Play Console.
> - Where the classification is uncertain I chose the **more conservative answer** (declare
>   rather than omit).
> - Production facts below come from read-only queries on 2026-11-14.

## Production facts this draft is based on

Read-only aggregate counts. No row contents were read.

| Item | Production |
|---|---|
| Laboratories | 12 |
| Legacy patient records (`patients`) | 15, in 10 laboratories; 0 with birth year, gender, notes or reference (name only) |
| Cases | 15 (all linked to a legacy patient); 2 have free-text notes |
| Tooth records / implant records | 50 / 7 |
| Attachments | 4: 2 photos (JPG/JPEG), 1 video (MP4, category "other"), 1 STL scan, ≈ 34 MB total |
| Storage objects keeping the original file name in their path | 4 of 4 |
| Lab assets (logos, avatars) | 0 |

## Section 1 — Overview questions

| Question | Draft answer | Why |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | Names, contact details, IDs, files, case data |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | HTTPS only (Supabase, Netlify) |
| Do you provide a way for users to request that their data is deleted? | **Yes** | In-app: Profile → Delete my account; Lab profile → Delete this laboratory; email contact in the policy |
| Data shared with third parties? | **No** | Supabase and Netlify act as service providers that process data on the developer's behalf. Under Google's definitions that is not "sharing". No other recipients. |

## Section 2 — Data types

Columns: **Collected?** / **Required or optional** / **Purposes** / *notes*.
"Collected" = sent off the device to the service. No data type is processed only on the
device ("ephemeral").

### Personal info
| Type | Collected? | Required/optional | Purposes | Notes |
|---|---|---|---|---|
| Name | **Yes** | Required | App functionality, Account management | Employee full names (required); dentist names. **Legacy patient names are still stored.** The new version does not collect them. |
| Email address | **Yes** | Optional | App functionality, Account management | Optional employee and dentist email |
| User IDs | **Yes** | Required | App functionality, Account management, Fraud prevention/security/compliance | Lab code, employee code, internal account IDs |
| Address | **Yes** | Optional | App functionality | Laboratory and clinic address (business addresses) |
| Phone number | **Yes** | Optional | App functionality | Optional employee and dentist phone |
| Race/ethnicity, political/religious beliefs, sexual orientation | No | — | — | — |
| Other info | **Yes** | Required | App functionality | Role, department, specialty |

### Health and fitness
| Type | Collected? | Required/optional | Purposes | Notes |
|---|---|---|---|---|
| Health info | **Yes (conservative)** | Required for a case | App functionality | Tooth positions, missing teeth, implant specifications and 3D intraoral scans relate to an identifiable patient, through the ordering dentist. Legacy cases are also still linked to patient names. Declaring "No" would be hard to defend. |
| Fitness info | No | — | — | — |

### Photos and videos
| Type | Collected? | Required/optional | Purposes | Notes |
|---|---|---|---|---|
| Photos | **Yes** | Optional | App functionality, Account management | Employee profile photo and lab logo. The new version does **not** accept case photos; 2 legacy case photos remain stored. |
| Videos | **No** for the new version | — | — | The new version cannot upload videos. **1 legacy MP4 remains stored and downloadable.** See decision D2 below. |

### Files and docs
| Type | Collected? | Required/optional | Purposes | Notes |
|---|---|---|---|---|
| Files and docs | **Yes** | Optional | App functionality | 3D production files (STL/PLY/OBJ/3MF/DCM) |

### App activity
| Type | Collected? | Required/optional | Purposes | Notes |
|---|---|---|---|---|
| App interactions | **Yes** | Required | App functionality, Fraud prevention/security/compliance | Production history and audit log (who did what, when) |
| Other user-generated content | **Yes** | Optional | App functionality | Case notes, manufacturing notes, QC reasons, clinic order references |
| In-app search history, Installed apps, Other actions | No | — | — | Search runs on the device and is not stored |

### Not collected
| Category | Answer | Notes |
|---|---|---|
| Location (approximate / precise) | No | Not requested. Supabase's server logs record IP addresses for security, but the app never derives location from them. |
| Financial info | No | |
| Messages (emails, SMS, other in-app messages) | No | In-app notifications are system events, not user messages |
| Audio files, voice recordings, music | No | Microphone permission is blocked in `app.json` |
| Contacts, Calendar | No | |
| Web browsing | No | |
| App info and performance (crash logs, diagnostics) | No | No crash-reporting or analytics SDK |
| Device or other IDs | No | No advertising ID, no push token, no device identifiers read by the app |

## Section 3 — Security practices
- Data encrypted in transit: **Yes**.
- Deletion: **Yes**. Account deletion and laboratory deletion are in the app; the
  privacy policy URL documents both.
- Independent security review: **No** (do not claim it).
- Committed to Play Families policy: not applicable (not for children).

## Decisions for you before submitting

1. **D1 — Health info.** I recommend declaring **Yes**. Declaring No is defensible only if
   you are confident tooth, implant and scan data is not "health info". Google may
   disagree, and a mismatch between the form and the app's behaviour is a policy
   violation in itself.
2. **D2 — Legacy photos and video.** The form describes what the app collects. The new
   version collects neither, but legacy files remain downloadable. The cleanest options
   are:
   - (a) ask the 1–2 labs concerned to review, export or delete them; or
   - (b) keep them and also tick Videos (and case photos) conservatively.

   Leaving them stored and undeclared is the weakest position.
3. **D3 — Legacy patient names.** They are no longer collected and are hidden from users,
   but they remain stored in 10 labs (15 names). Same choice as D2: plan their export or
   deletion (Phase 2, separate approval), or keep "Name" declared, which is already the
   case because of employee names.
4. **The Data Safety form does not decide whether you need an Organization account.** That
   comes from the Health apps declaration and the app's features. See the pre-deployment
   report, section 4.
