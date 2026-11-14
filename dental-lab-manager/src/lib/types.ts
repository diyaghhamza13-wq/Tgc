export type CaseStatus = 'new' | 'in_progress' | 'waiting' | 'ready_for_qc' | 'completed' | 'delivered' | 'cancelled';
export type StageStatus = 'pending' | 'in_progress' | 'waiting' | 'completed' | 'rejected' | 'needs_revision' | 'skipped';
export type StageKind = 'reception' | 'production' | 'qc' | 'ready' | 'delivered';
export type Priority = 'normal' | 'urgent' | 'very_urgent';

export interface Lab {
  id: string;
  code: string;
  name: string;
  logo_path: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  status: string;
  settings: { show_employee_list?: boolean; auto_complete_reception?: boolean; deadline_warning_hours?: number };
}

export interface Department { id: string; lab_id: string; code: string; name: string; icon: string; color: string; sort_order: number; is_active: boolean }
export interface Role { id: string; lab_id: string; code: string; name: string; description: string | null; is_system: boolean }

export interface Employee {
  id: string;
  lab_id: string;
  code: string;
  full_name: string;
  avatar_path: string | null;
  department_id: string | null;
  role_id: string;
  specialty: string | null;
  phone: string | null;
  email: string | null;
  status: 'active' | 'inactive';
  preferred_language: string;
  last_login_at: string | null;
}

export interface Doctor { id: string; lab_id: string; full_name: string; clinic_name: string | null; phone: string | null; email: string | null; address: string | null; city: string | null; notes: string | null; is_active: boolean }
export interface RestorationType { id: string; code: string; name: string; icon: string; is_implant_related: boolean; is_active: boolean; sort_order: number }
export interface Material { id: string; code: string; name: string; category: string | null; default_brand: string | null; is_active: boolean; sort_order: number }
export interface ImplantBrand { id: string; name: string; is_active: boolean; sort_order: number }
export interface ImplantSystem { id: string; brand_id: string; name: string; connection_types: string[]; platforms: string[]; is_active: boolean }

export interface Stage {
  id: string;
  case_id: string;
  position: number;
  name: string;
  kind: StageKind;
  department_id: string | null;
  assigned_employee_id: string | null;
  status: StageStatus;
  started_at: string | null;
  active_since: string | null;
  completed_at: string | null;
  completed_by: string | null;
  time_spent_seconds: number;
  revision_count: number;
  notes: string | null;
}

export interface CaseRow {
  id: string;
  lab_id: string;
  case_number: string;
  /** legacy link to a patient record (cases created before production-only mode); never shown */
  patient_id: string | null;
  clinic_order_ref: string | null;
  doctor_id: string;
  assigned_technician_id: string | null;
  current_stage_id: string | null;
  received_at: string;
  due_date: string;
  priority: Priority;
  status: CaseStatus;
  shade: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  delivered_at: string | null;
}

/** Case with the joins used by lists */
export interface CaseListItem extends CaseRow {
  doctor: { full_name: string } | null;
  current: (Pick<Stage, 'id' | 'name' | 'kind' | 'status' | 'department_id' | 'assigned_employee_id' | 'started_at'> & {
    assignee: { full_name: string } | null;
  }) | null;
  stages: Pick<Stage, 'id' | 'position' | 'status' | 'kind'>[];
  restorations: { restoration_type: { name: string } | null }[];
}

export interface CaseTooth { id: string; tooth_number: number; is_missing: boolean; is_implant: boolean; bridge_group: number | null; restoration_id: string | null; notes: string | null }
export interface CaseRestoration {
  id: string; position: number; restoration_type_id: string; material_id: string | null; material_brand: string | null; material_type: string | null;
  shade: string | null; thickness: string | null; translucency: string | null; block_reference: string | null; lot_number: string | null;
  manufacturing_notes: string | null; notes: string | null;
}
export interface CaseImplant {
  id: string; tooth_number: number; brand_id: string | null; brand_name: string | null; system_name: string | null; connection: string | null;
  platform: string | null; diameter_mm: number | null; length_mm: number | null; scanbody_manufacturer: string | null; scanbody_reference: string | null;
  tibase_type: string | null; screw_channel: 'straight' | 'angulated' | null; angulation_degrees: number | null; library_reference: string | null; notes: string | null;
}
export interface Attachment { id: string; case_id: string; stage_id: string | null; category: string; file_name: string; mime_type: string | null; size_bytes: number; storage_path: string; uploaded_by: string | null; created_at: string }
export interface HistoryEvent { id: string; event_type: string; stage_id: string | null; from_stage_id: string | null; to_stage_id: string | null; actor_id: string | null; status: string | null; notes: string | null; data: Record<string, unknown>; created_at: string }
export interface Notification { id: string; case_id: string | null; type: string; title: string; body: string | null; data: Record<string, unknown>; read_at: string | null; created_at: string }

export const UPPER_JAW = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
export const LOWER_JAW = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

export const CASE_LIST_SELECT =
  'id, lab_id, case_number, clinic_order_ref, doctor_id, assigned_technician_id, current_stage_id, received_at, due_date, priority, status, shade, notes, created_by, created_at, delivered_at,' +
  ' doctor:doctors(full_name),' +
  ' current:case_workflow_stages!cases_current_stage_fk(id, name, kind, status, department_id, assigned_employee_id, started_at, assignee:employees!case_workflow_stages_lab_id_assigned_employee_id_fkey(full_name)),' +
  ' stages:case_workflow_stages!case_workflow_stages_lab_id_case_id_fkey(id, position, status, kind),' +
  ' restorations:case_restorations(restoration_type:restoration_types(name))';
