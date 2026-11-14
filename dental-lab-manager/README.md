# Dental Lab Manager — Laboratory Management System

A multi-laboratory management platform for dental prosthetics labs. It covers the
whole life of a case: reception and digital prescription (interactive FDI chart,
restorations, materials, implants, files), production stage by stage, quality
control, delivery, notifications, and reports.

- **App:** React Native + Expo SDK 58 (Expo Router, TypeScript). Runs on iOS, Android and web.
- **Backend:** Supabase (PostgreSQL, Auth, Storage, Realtime, Edge Functions).
- **Languages:** Arabic (RTL, default), English, French.

> نظام متكامل لإدارة مختبرات الأسنان: استلام الطلب والوصفة الرقمية (مخطط الأسنان FDI،
> التعويضات، المواد، الزرعات، الملفات)، ثم الإنتاج مرحلة بمرحلة، ومراقبة الجودة،
> والتسليم، والإشعارات، والتقارير. يدعم العربية والإنجليزية والفرنسية.

---

## 1. Project structure

```
dental-lab-manager/
├── src/
│   ├── app/                    Expo Router screens (every file is a route)
│   │   ├── index.tsx           splash / session restore
│   │   ├── (auth)/             lab code → employee + PIN, lab registration
│   │   └── (app)/              signed-in area
│   │       ├── (tabs)/         dashboard, cases, new case, reports, settings
│   │       ├── case/[id].tsx   case details + workflow actions
│   │       ├── case/edit/[id]  edit prescription
│   │       ├── tasks, notifications, board, qc, delivery, profile
│   │       └── admin/          lab, employees, roles, workflow, catalogs, implants, audit
│   ├── components/             design system, tooth chart, case wizard, charts…
│   └── lib/                    supabase client, auth, i18n, queries, files, export
├── supabase/
│   ├── migrations/             the full database (schema, RLS, workflow engine, reports, storage)
│   ├── functions/              edge functions: employee-login, register-lab, manage-employee
│   └── config.toml
└── scripts/
    ├── integration-test.mjs    85 end-to-end backend checks (workflow, permissions, isolation)
    └── seed-demo.mjs           demo lab LAB001 with the employees from the mockups
```

## 2. Run it locally

Requirements: Node 20+, Docker, the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).

```bash
cd dental-lab-manager
npm install

# 1. start Supabase locally and apply all migrations
npx supabase start
npx supabase db reset                 # applies supabase/migrations/*

# 2. serve the edge functions (keep this terminal open)
npx supabase functions serve

# 3. configure the app
cp .env.example .env                  # then paste the anon key printed by `supabase status`

# 4. (optional) demo data: lab LAB001, employees CAD01, CAM01, CER01, FIN01, QC01, REC01, ADMIN01 — PIN 1234
SUPABASE_ANON_KEY=<anon key> node scripts/seed-demo.mjs

# 5. start the app
npx expo start                        # press w for web, or scan the QR code with a dev build
```

Native modules used (document picker, file system, image picker, print, sharing,
updates) are part of the Expo SDK. For a device build use EAS:
`npx eas-cli@latest build --profile development`.

## 3. Deploy to Supabase (production)

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push                                   # apply migrations
npx supabase functions deploy employee-login
npx supabase functions deploy register-lab
npx supabase functions deploy manage-employee
# optional: only people who know this key can open a new laboratory
npx supabase secrets set LAB_REGISTRATION_KEY=<a long random value>
```

Then, in the Supabase dashboard:

1. **Authentication → Providers → Email:** keep it enabled, and **disable "Allow new users to sign up"**.
   Accounts are only created by the edge functions.
2. **Database → Extensions:** `pg_cron` is enabled by the migration when available; it runs the
   deadline scan every hour. If your plan doesn't have it, the dashboard also triggers the scan.
3. Put the project URL and **anon** key in the app's environment
   (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`). **Never put the service-role key in the app.**

## 4. How it works

### Login (two steps, as in the design)
1. The lab code (e.g. `LAB001`) is looked up with the public `get_lab_login_info` function, which returns
   only the lab's name and the active employees' display data (the list can be hidden in the lab settings).
2. The employee enters their code + PIN. The `employee-login` edge function checks the PIN against a
   **bcrypt hash** in `employee_credentials` (a table no client can read), locks the account for 15 minutes
   after 5 failures, and issues a normal Supabase Auth session.

### Data isolation between laboratories
- Every table has `lab_id`, and foreign keys are **composite** `(lab_id, x_id) → (lab_id, id)`. A case can't
  reference another lab's doctor, employee, or stage — the database refuses it.
- **Row Level Security** is on for every table. Deactivating an employee removes their access immediately.
- Files go in a private Storage bucket under `<lab_id>/<case_id>/…`, with storage policies tied to case visibility.

### Roles & permissions
16 permissions (e.g. `cases.create`, `qc.perform`, `workflow.assign`, `employees.manage`) grouped into roles
that each lab can edit. Default roles: Administrator, Reception, CAD Designer, Milling/CAM, Ceramist,
Finishing, Quality Control, Delivery. Labs can add their own departments and roles.
The database enforces every permission; the app only hides buttons you can't use.

### Production workflow
- Each lab has a configurable workflow template (default: Reception → CAD Design → Milling/CAM → Ceramics →
  Finishing → Quality Control → Ready for Delivery → Delivered). Every case gets its own copy.
- **The responsible employee moves the case forward themselves** — no admin needed:
  *Start → (Pause/Resume) → Complete & Transfer*, optionally handing it to a specific colleague. The next
  person (or the whole next department) gets a real-time notification.
- Only the assigned employee, or their department when the stage is unassigned, can act on a stage
  (`workflow.transfer_any` gives supervisors an override).
- **QC rejection** sends the case back to an earlier stage with a required reason; the stages in between are
  reset, the revision is counted, and the history keeps everything.
- Every transition writes `case_history` (who, when, from/to department, notes) and `audit_logs`.
  Time is tracked per stage, and pauses are excluded.

### Main tables
`laboratories, departments, roles, permissions, role_permissions, employees, employee_credentials, doctors,
patients, restoration_types, materials, implant_brands, implant_systems, workflow_templates, workflow_stages,
cases, case_restorations, case_teeth, case_implants, case_workflow_stages, case_assignments, case_history,
attachments, notifications, quality_control, deliveries, audit_logs`.
Employee profiles are stored in `employees` (it serves as the profiles table).

## 5. Tests

```bash
# backend: 85 checks against a running local Supabase (workflow, QC loop, permissions,
# cross-lab attacks, PIN lockout, deactivation, storage access, reports)
SUPABASE_ANON_KEY=<anon key> node scripts/integration-test.mjs

npm run typecheck
```

During development the web build was also driven end to end in a browser: login, the 4-step wizard with a
bridge, a missing tooth, an implant and an STL upload, then CAD → Milling → Ceramics → Finishing →
QC reject → rework → QC pass → delivery, as the matching employees, with no console errors.

## 6. Known limitations

- **Tested on web, not on a physical iOS/Android device yet.** The native-only paths (file download/share,
  PDF sharing, switching between RTL and LTR, which reloads the app) still need a check on a device build.
- **Case search runs on the device**, over the 1,000 most recent cases the user can see. That's fine for one
  lab; very large archives would need server-side search.
- **Excel export is an `.xls` spreadsheet file** (SpreadsheetML), not `.xlsx`. Excel, LibreOffice and
  Numbers open it. On web, "PDF" opens the browser's print dialog.
- **Files open through a temporary download link.** There is no 3D STL viewer inside the app yet.
- **No offline mode.** Without a connection the app shows a network error and does not save, so nothing is
  silently lost.
- 4-digit PINs are allowed. The lockout limits guessing, but 6 digits are recommended.
