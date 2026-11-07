-- =============================================================================
-- Dental Lab Manager — core relational schema
-- Multi-laboratory (multi-tenant). Every tenant-owned row carries lab_id and
-- composite foreign keys (lab_id, <fk>) -> (lab_id, id) make cross-laboratory
-- references impossible at the database level.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.lab_status as enum ('active', 'trial', 'suspended', 'cancelled');
create type public.employee_status as enum ('active', 'inactive');
create type public.case_priority as enum ('normal', 'urgent', 'very_urgent');
create type public.case_status as enum (
  'new', 'in_progress', 'waiting', 'ready_for_qc', 'completed', 'delivered', 'cancelled'
);
create type public.stage_status as enum (
  'pending', 'in_progress', 'waiting', 'completed', 'rejected', 'needs_revision', 'skipped'
);
-- reception: registration; production: technical work; qc: quality control;
-- ready: ready for delivery; delivered: final hand-over.
create type public.stage_kind as enum ('reception', 'production', 'qc', 'ready', 'delivered');

-- ---------------------------------------------------------------------------
-- Laboratories
-- ---------------------------------------------------------------------------
create table public.laboratories (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^[A-Z0-9]{3,12}$'),
  name          text not null check (length(btrim(name)) between 2 and 120),
  logo_path     text,
  phone         text,
  email         text,
  address       text,
  city          text,
  country       text,
  status        public.lab_status not null default 'active',
  subscription_plan text not null default 'standard',
  -- e.g. {"show_employee_list": true, "auto_complete_reception": true,
  --       "deadline_warning_hours": 24, "notify": {...}}
  settings      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.lab_counters (
  lab_id   uuid primary key references public.laboratories(id) on delete cascade,
  case_seq integer not null default 0
);

-- ---------------------------------------------------------------------------
-- Departments, roles, permissions
-- ---------------------------------------------------------------------------
create table public.departments (
  id          uuid primary key default gen_random_uuid(),
  lab_id      uuid not null references public.laboratories(id) on delete cascade,
  code        text not null check (code ~ '^[A-Z0-9_]{2,20}$'),
  name        text not null check (length(btrim(name)) between 1 and 80),
  icon        text not null default 'building',
  color       text not null default '#D6AD55',
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (lab_id, code),
  unique (lab_id, id)
);

create table public.permissions (
  code        text primary key,
  category    text not null,
  description text not null
);

create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  lab_id      uuid not null references public.laboratories(id) on delete cascade,
  code        text not null check (code ~ '^[A-Z0-9_]{2,20}$'),
  name        text not null check (length(btrim(name)) between 1 and 80),
  description text,
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (lab_id, code),
  unique (lab_id, id)
);

create table public.role_permissions (
  lab_id          uuid not null,
  role_id         uuid not null,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role_id, permission_code),
  foreign key (lab_id, role_id) references public.roles(lab_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Employees (the employee row is the user profile of an authenticated user)
-- ---------------------------------------------------------------------------
create table public.employees (
  id            uuid primary key default gen_random_uuid(),
  lab_id        uuid not null references public.laboratories(id) on delete cascade,
  auth_user_id  uuid unique references auth.users(id) on delete set null,
  code          text not null check (code ~ '^[A-Z0-9_-]{2,16}$'),
  full_name     text not null check (length(btrim(full_name)) between 2 and 120),
  avatar_path   text,
  department_id uuid,
  role_id       uuid not null,
  specialty     text,
  phone         text,
  email         text,
  status        public.employee_status not null default 'active',
  preferred_language text not null default 'ar' check (preferred_language in ('ar', 'en', 'fr')),
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (lab_id, code),
  unique (lab_id, id),
  foreign key (lab_id, department_id) references public.departments(lab_id, id) on delete set null (department_id),
  foreign key (lab_id, role_id) references public.roles(lab_id, id) on delete restrict
);
create index employees_department_idx on public.employees (department_id);
create index employees_role_idx on public.employees (role_id);

-- Secret material lives in its own table that no client role can read.
create table public.employee_credentials (
  employee_id      uuid primary key references public.employees(id) on delete cascade,
  pin_hash         text not null,
  failed_attempts  integer not null default 0,
  locked_until     timestamptz,
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Doctors / clients and patients
-- ---------------------------------------------------------------------------
create table public.doctors (
  id          uuid primary key default gen_random_uuid(),
  lab_id      uuid not null references public.laboratories(id) on delete cascade,
  full_name   text not null check (length(btrim(full_name)) between 2 and 120),
  clinic_name text,
  phone       text,
  email       text,
  address     text,
  city        text,
  notes       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (lab_id, id)
);
create index doctors_lab_name_idx on public.doctors (lab_id, full_name);

create table public.patients (
  id          uuid primary key default gen_random_uuid(),
  lab_id      uuid not null references public.laboratories(id) on delete cascade,
  full_name   text not null check (length(btrim(full_name)) between 2 and 120),
  reference   text,
  birth_year  integer check (birth_year between 1900 and 2100),
  gender      text check (gender in ('male', 'female', 'other')),
  notes       text,
  created_at  timestamptz not null default now(),
  unique (lab_id, id)
);
create index patients_lab_name_idx on public.patients (lab_id, full_name);

-- ---------------------------------------------------------------------------
-- Configurable catalogs: restoration types, materials, implant library
-- ---------------------------------------------------------------------------
create table public.restoration_types (
  id          uuid primary key default gen_random_uuid(),
  lab_id      uuid not null references public.laboratories(id) on delete cascade,
  code        text not null check (code ~ '^[A-Z0-9_]{2,30}$'),
  name        text not null,
  icon        text not null default 'tooth',
  is_implant_related boolean not null default false,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  unique (lab_id, code),
  unique (lab_id, id)
);

create table public.materials (
  id            uuid primary key default gen_random_uuid(),
  lab_id        uuid not null references public.laboratories(id) on delete cascade,
  code          text not null check (code ~ '^[A-Z0-9_]{2,30}$'),
  name          text not null,
  category      text,
  default_brand text,
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  unique (lab_id, code),
  unique (lab_id, id)
);

create table public.implant_brands (
  id         uuid primary key default gen_random_uuid(),
  lab_id     uuid not null references public.laboratories(id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 80),
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  unique (lab_id, name),
  unique (lab_id, id)
);

create table public.implant_systems (
  id               uuid primary key default gen_random_uuid(),
  lab_id           uuid not null,
  brand_id         uuid not null,
  name             text not null check (length(btrim(name)) between 1 and 80),
  connection_types text[] not null default '{}',
  platforms        text[] not null default '{}',
  notes            text,
  is_active        boolean not null default true,
  unique (brand_id, name),
  unique (lab_id, id),
  foreign key (lab_id, brand_id) references public.implant_brands(lab_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Workflow templates
-- ---------------------------------------------------------------------------
create table public.workflow_templates (
  id          uuid primary key default gen_random_uuid(),
  lab_id      uuid not null references public.laboratories(id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (lab_id, id)
);
create unique index workflow_templates_one_default
  on public.workflow_templates (lab_id) where is_default;

create table public.workflow_stages (
  id                  uuid primary key default gen_random_uuid(),
  lab_id              uuid not null,
  template_id         uuid not null,
  position            integer not null check (position >= 1),
  name                text not null check (length(btrim(name)) between 1 and 80),
  kind                public.stage_kind not null default 'production',
  department_id       uuid,
  default_assignee_id uuid,
  expected_hours      numeric(6,2) check (expected_hours is null or expected_hours >= 0),
  unique (template_id, position) deferrable initially immediate,
  unique (lab_id, id),
  foreign key (lab_id, template_id) references public.workflow_templates(lab_id, id) on delete cascade,
  foreign key (lab_id, department_id) references public.departments(lab_id, id) on delete set null (department_id),
  foreign key (lab_id, default_assignee_id) references public.employees(lab_id, id) on delete set null (default_assignee_id)
);

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------
create table public.cases (
  id                     uuid primary key default gen_random_uuid(),
  lab_id                 uuid not null references public.laboratories(id) on delete cascade,
  case_number            text not null,
  patient_id             uuid not null,
  doctor_id              uuid not null,
  assigned_technician_id uuid,
  workflow_template_id   uuid,
  current_stage_id       uuid,
  received_at            timestamptz not null default now(),
  due_date               date not null,
  priority               public.case_priority not null default 'normal',
  status                 public.case_status not null default 'new',
  shade                  text,
  notes                  text,
  created_by             uuid,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  completed_at           timestamptz,
  delivered_at           timestamptz,
  cancelled_at           timestamptz,
  unique (lab_id, case_number),
  unique (lab_id, id),
  foreign key (lab_id, patient_id) references public.patients(lab_id, id) on delete restrict,
  foreign key (lab_id, doctor_id) references public.doctors(lab_id, id) on delete restrict,
  foreign key (lab_id, assigned_technician_id) references public.employees(lab_id, id) on delete set null (assigned_technician_id),
  foreign key (lab_id, workflow_template_id) references public.workflow_templates(lab_id, id) on delete set null (workflow_template_id),
  foreign key (lab_id, created_by) references public.employees(lab_id, id) on delete set null (created_by)
);
create index cases_lab_status_idx on public.cases (lab_id, status);
create index cases_lab_due_idx on public.cases (lab_id, due_date);
create index cases_patient_idx on public.cases (patient_id);
create index cases_doctor_idx on public.cases (doctor_id);
create index cases_received_idx on public.cases (lab_id, received_at desc);

-- Restorations prescribed in a case (a tooth or group of teeth share one)
create table public.case_restorations (
  id                  uuid primary key default gen_random_uuid(),
  lab_id              uuid not null,
  case_id             uuid not null,
  position            integer not null default 1,
  restoration_type_id uuid not null,
  material_id         uuid,
  material_brand      text,
  material_type       text,
  shade               text,
  thickness           text,
  translucency        text,
  block_reference     text,
  lot_number          text,
  manufacturing_notes text,
  notes               text,
  unique (case_id, id),
  foreign key (lab_id, case_id) references public.cases(lab_id, id) on delete cascade,
  foreign key (lab_id, restoration_type_id) references public.restoration_types(lab_id, id) on delete restrict,
  foreign key (lab_id, material_id) references public.materials(lab_id, id) on delete set null (material_id)
);
create index case_restorations_case_idx on public.case_restorations (case_id);
create index case_restorations_material_idx on public.case_restorations (material_id);
create index case_restorations_type_idx on public.case_restorations (restoration_type_id);

-- FDI notation helper
create or replace function public.is_valid_fdi_tooth(n integer)
returns boolean language sql immutable as $$
  select n is not null and (n / 10) between 1 and 4 and (n % 10) between 1 and 8;
$$;

create table public.case_teeth (
  id             uuid primary key default gen_random_uuid(),
  lab_id         uuid not null,
  case_id        uuid not null,
  tooth_number   smallint not null check (public.is_valid_fdi_tooth(tooth_number)),
  is_missing     boolean not null default false,
  is_implant     boolean not null default false,
  -- teeth sharing the same bridge_group within a case are connected (bridge)
  bridge_group   smallint check (bridge_group is null or bridge_group > 0),
  restoration_id uuid,
  notes          text,
  unique (case_id, tooth_number),
  foreign key (lab_id, case_id) references public.cases(lab_id, id) on delete cascade,
  foreign key (case_id, restoration_id) references public.case_restorations(case_id, id) on delete set null (restoration_id)
);
create index case_teeth_case_idx on public.case_teeth (case_id);

create table public.case_implants (
  id                    uuid primary key default gen_random_uuid(),
  lab_id                uuid not null,
  case_id               uuid not null,
  tooth_number          smallint not null check (public.is_valid_fdi_tooth(tooth_number)),
  brand_id              uuid,
  brand_name            text,
  system_name           text,
  connection            text,
  platform              text,
  diameter_mm           numeric(4,2) check (diameter_mm is null or diameter_mm between 1 and 15),
  length_mm             numeric(4,1) check (length_mm is null or length_mm between 1 and 30),
  scanbody_manufacturer text,
  scanbody_reference    text,
  tibase_type           text,
  screw_channel         text check (screw_channel is null or screw_channel in ('straight', 'angulated')),
  angulation_degrees    numeric(4,1) check (angulation_degrees is null or angulation_degrees between 0 and 45),
  library_reference     text,
  notes                 text,
  unique (case_id, tooth_number),
  foreign key (lab_id, case_id) references public.cases(lab_id, id) on delete cascade,
  foreign key (lab_id, brand_id) references public.implant_brands(lab_id, id) on delete set null (brand_id)
);
create index case_implants_case_idx on public.case_implants (case_id);

-- ---------------------------------------------------------------------------
-- Production workflow instances
-- ---------------------------------------------------------------------------
create table public.case_workflow_stages (
  id                   uuid primary key default gen_random_uuid(),
  lab_id               uuid not null,
  case_id              uuid not null,
  position             integer not null check (position >= 1),
  name                 text not null,
  kind                 public.stage_kind not null default 'production',
  department_id        uuid,
  assigned_employee_id uuid,
  status               public.stage_status not null default 'pending',
  started_at           timestamptz,
  -- set while work is actively running; cleared on pause/completion and the
  -- elapsed time is accumulated into time_spent_seconds
  active_since         timestamptz,
  completed_at         timestamptz,
  completed_by         uuid,
  time_spent_seconds   integer not null default 0 check (time_spent_seconds >= 0),
  revision_count       integer not null default 0,
  notes                text,
  created_at           timestamptz not null default now(),
  unique (case_id, position),
  unique (case_id, id),
  unique (lab_id, id),
  foreign key (lab_id, case_id) references public.cases(lab_id, id) on delete cascade,
  foreign key (lab_id, department_id) references public.departments(lab_id, id) on delete set null (department_id),
  foreign key (lab_id, assigned_employee_id) references public.employees(lab_id, id) on delete set null (assigned_employee_id),
  foreign key (lab_id, completed_by) references public.employees(lab_id, id) on delete set null (completed_by)
);
create index cws_assignee_idx on public.case_workflow_stages (assigned_employee_id, status);
create index cws_department_idx on public.case_workflow_stages (department_id, status);

alter table public.cases
  add constraint cases_current_stage_fk
  foreign key (id, current_stage_id) references public.case_workflow_stages(case_id, id)
  on delete set null (current_stage_id);
create index cases_current_stage_idx on public.cases (current_stage_id);

create table public.case_assignments (
  id            uuid primary key default gen_random_uuid(),
  lab_id        uuid not null,
  case_id       uuid not null,
  stage_id      uuid not null,
  employee_id   uuid not null,
  assigned_by   uuid,
  assigned_at   timestamptz not null default now(),
  unassigned_at timestamptz,
  foreign key (lab_id, case_id) references public.cases(lab_id, id) on delete cascade,
  foreign key (case_id, stage_id) references public.case_workflow_stages(case_id, id) on delete cascade,
  foreign key (lab_id, employee_id) references public.employees(lab_id, id) on delete cascade,
  foreign key (lab_id, assigned_by) references public.employees(lab_id, id) on delete set null (assigned_by)
);
create index case_assignments_case_idx on public.case_assignments (case_id);
create index case_assignments_employee_idx on public.case_assignments (employee_id);

-- Immutable chronological history of everything that happens to a case
create table public.case_history (
  id                 uuid primary key default gen_random_uuid(),
  lab_id             uuid not null,
  case_id            uuid not null,
  event_type         text not null check (event_type in (
                       'created', 'updated', 'assigned', 'stage_started', 'stage_status',
                       'transferred', 'note', 'file_uploaded', 'file_deleted',
                       'qc_passed', 'qc_failed', 'delivered', 'cancelled')),
  stage_id           uuid,
  from_stage_id      uuid,
  to_stage_id        uuid,
  from_department_id uuid,
  to_department_id   uuid,
  actor_id           uuid,
  status             text,
  notes              text,
  data               jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  foreign key (lab_id, case_id) references public.cases(lab_id, id) on delete cascade,
  foreign key (case_id, stage_id) references public.case_workflow_stages(case_id, id) on delete set null (stage_id),
  foreign key (case_id, from_stage_id) references public.case_workflow_stages(case_id, id) on delete set null (from_stage_id),
  foreign key (case_id, to_stage_id) references public.case_workflow_stages(case_id, id) on delete set null (to_stage_id),
  foreign key (lab_id, from_department_id) references public.departments(lab_id, id) on delete set null (from_department_id),
  foreign key (lab_id, to_department_id) references public.departments(lab_id, id) on delete set null (to_department_id),
  foreign key (lab_id, actor_id) references public.employees(lab_id, id) on delete set null (actor_id)
);
create index case_history_case_idx on public.case_history (case_id, created_at);

-- ---------------------------------------------------------------------------
-- Attachments (binary content lives in Supabase Storage, not in Postgres)
-- ---------------------------------------------------------------------------
create table public.attachments (
  id           uuid primary key default gen_random_uuid(),
  lab_id       uuid not null,
  case_id      uuid not null,
  stage_id     uuid,
  category     text not null default 'other' check (category in (
                 'scan', 'cad_design', 'cbct', 'prescription', 'photo', 'production', 'qc', 'other')),
  file_name    text not null check (length(file_name) between 1 and 255),
  mime_type    text,
  size_bytes   bigint not null default 0 check (size_bytes >= 0),
  storage_path text not null unique,
  uploaded_by  uuid,
  created_at   timestamptz not null default now(),
  foreign key (lab_id, case_id) references public.cases(lab_id, id) on delete cascade,
  foreign key (case_id, stage_id) references public.case_workflow_stages(case_id, id) on delete set null (stage_id),
  foreign key (lab_id, uploaded_by) references public.employees(lab_id, id) on delete set null (uploaded_by),
  -- storage layout: <lab_id>/<case_id>/<file>
  check (storage_path like lab_id::text || '/' || case_id::text || '/%')
);
create index attachments_case_idx on public.attachments (case_id, created_at);

-- ---------------------------------------------------------------------------
-- Notifications, QC, deliveries, audit
-- ---------------------------------------------------------------------------
create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  lab_id       uuid not null,
  recipient_id uuid not null,
  case_id      uuid,
  type         text not null check (type in (
                 'case_assigned', 'case_arrived', 'deadline_approaching', 'case_delayed',
                 'qc_rejected', 'revision_requested', 'ready_for_delivery', 'case_delivered', 'general')),
  title        text not null,
  body         text,
  data         jsonb not null default '{}'::jsonb,
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (lab_id, recipient_id) references public.employees(lab_id, id) on delete cascade,
  foreign key (lab_id, case_id) references public.cases(lab_id, id) on delete cascade
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create unique index notifications_dedupe_idx on public.notifications (recipient_id, dedupe_key)
  where dedupe_key is not null;

create table public.quality_control (
  id                 uuid primary key default gen_random_uuid(),
  lab_id             uuid not null,
  case_id            uuid not null,
  stage_id           uuid not null,
  inspector_id       uuid,
  result             text not null check (result in ('passed', 'failed')),
  checklist          jsonb not null default '{}'::jsonb,
  reason             text,
  return_to_stage_id uuid,
  created_at         timestamptz not null default now(),
  foreign key (lab_id, case_id) references public.cases(lab_id, id) on delete cascade,
  foreign key (case_id, stage_id) references public.case_workflow_stages(case_id, id) on delete cascade,
  foreign key (case_id, return_to_stage_id) references public.case_workflow_stages(case_id, id) on delete set null (return_to_stage_id),
  foreign key (lab_id, inspector_id) references public.employees(lab_id, id) on delete set null (inspector_id),
  check (result = 'passed' or (reason is not null and length(btrim(reason)) > 0))
);
create index quality_control_case_idx on public.quality_control (case_id);

create table public.deliveries (
  id             uuid primary key default gen_random_uuid(),
  lab_id         uuid not null,
  case_id        uuid not null unique,
  delivered_by   uuid,
  delivered_at   timestamptz not null default now(),
  recipient_name text,
  method         text not null default 'pickup' check (method in ('pickup', 'courier', 'lab_driver', 'digital', 'other')),
  tracking_reference text,
  notes          text,
  foreign key (lab_id, case_id) references public.cases(lab_id, id) on delete cascade,
  foreign key (lab_id, delivered_by) references public.employees(lab_id, id) on delete set null (delivered_by)
);

create table public.audit_logs (
  id                bigint generated always as identity primary key,
  lab_id            uuid, -- intentionally no FK: audit history outlives deleted rows
  actor_employee_id uuid,
  actor_user_id     uuid,
  table_name        text not null,
  record_id         text,
  action            text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data          jsonb,
  new_data          jsonb,
  created_at        timestamptz not null default now()
);
create index audit_logs_lab_idx on public.audit_logs (lab_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger laboratories_touch before update on public.laboratories
  for each row execute function public.touch_updated_at();
create trigger employees_touch before update on public.employees
  for each row execute function public.touch_updated_at();
create trigger cases_touch before update on public.cases
  for each row execute function public.touch_updated_at();
