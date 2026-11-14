import { isDelayed } from './format';
import { supabase, unwrap } from './supabase';
import {
  CASE_LIST_SELECT,
  type Attachment,
  type CaseImplant,
  type CaseListItem,
  type CaseRestoration,
  type CaseRow,
  type CaseTooth,
  type Department,
  type Doctor,
  type Employee,
  type HistoryEvent,
  type ImplantBrand,
  type ImplantSystem,
  type Material,
  type RestorationType,
  type Role,
  type Stage,
} from './types';

export type Stats = {
  all: number; new: number; in_progress: number; waiting: number; in_production: number; ready_for_qc: number;
  completed: number; delivered: number; cancelled: number; delayed: number; my_tasks: number;
};

export async function fetchStats(): Promise<Stats> {
  return unwrap(await supabase.rpc('dashboard_stats')) as Stats;
}

export async function fetchCases(limit = 1000): Promise<CaseListItem[]> {
  return unwrap(
    await supabase.from('cases').select(CASE_LIST_SELECT).order('received_at', { ascending: false }).limit(limit),
  ) as unknown as CaseListItem[];
}

export type CaseFilter = 'all' | 'new' | 'in_progress' | 'waiting' | 'ready_for_qc' | 'completed' | 'delivered' | 'delayed';
export const CASE_FILTERS: CaseFilter[] = ['all', 'new', 'in_progress', 'waiting', 'ready_for_qc', 'completed', 'delivered', 'delayed'];

export function filterCases(list: CaseListItem[], filter: CaseFilter, q: string): CaseListItem[] {
  const query = q.trim().toLowerCase();
  return list.filter((c) => {
    if (filter === 'delayed' ? !isDelayed(c) : filter !== 'all' && c.status !== filter) return false;
    if (filter === 'all' && c.status === 'cancelled' && !query) return false;
    if (!query) return true;
    return [c.case_number, c.clinic_order_ref, c.doctor?.full_name, c.current?.assignee?.full_name, c.id]
      .filter(Boolean)
      .some((s) => String(s).toLowerCase().includes(query));
  });
}

export async function fetchEmployees(includeInactive = false): Promise<Employee[]> {
  let q = supabase.from('employees').select('*').order('full_name');
  if (!includeInactive) q = q.eq('status', 'active');
  return unwrap(await q) as Employee[];
}

export async function fetchDepartments(): Promise<Department[]> {
  return unwrap(await supabase.from('departments').select('*').order('sort_order')) as Department[];
}
export async function fetchRoles(): Promise<Role[]> {
  return unwrap(await supabase.from('roles').select('*').order('name')) as Role[];
}
export async function fetchDoctors(includeInactive = false): Promise<Doctor[]> {
  let q = supabase.from('doctors').select('*').order('full_name');
  if (!includeInactive) q = q.eq('is_active', true);
  return unwrap(await q) as Doctor[];
}

export type Catalogs = {
  types: RestorationType[];
  materials: Material[];
  brands: ImplantBrand[];
  systems: ImplantSystem[];
};
export async function fetchCatalogs(): Promise<Catalogs> {
  const [types, materials, brands, systems] = await Promise.all([
    supabase.from('restoration_types').select('*').order('sort_order'),
    supabase.from('materials').select('*').order('sort_order'),
    supabase.from('implant_brands').select('*').order('sort_order'),
    supabase.from('implant_systems').select('*').order('name'),
  ]);
  return {
    types: unwrap(types) as RestorationType[],
    materials: unwrap(materials) as Material[],
    brands: unwrap(brands) as ImplantBrand[],
    systems: unwrap(systems) as ImplantSystem[],
  };
}

export type CaseDetail = {
  case: CaseRow & { doctor: { full_name: string; clinic_name: string | null; phone: string | null } | null };
  stages: Stage[];
  teeth: CaseTooth[];
  restorations: (CaseRestoration & { restoration_type: { name: string } | null; material: { name: string } | null })[];
  implants: CaseImplant[];
  attachments: Attachment[];
  history: HistoryEvent[];
  qc: { id: string; result: string; reason: string | null; checklist: Record<string, boolean>; created_at: string; inspector_id: string | null }[];
  delivery: { delivered_at: string; recipient_name: string | null; method: string; tracking_reference: string | null; notes: string | null; delivered_by: string | null } | null;
};

export async function fetchCaseDetail(id: string): Promise<CaseDetail> {
  const [c, stages, teeth, restorations, implants, attachments, history, qc, delivery] = await Promise.all([
    supabase.from('cases').select('*, doctor:doctors(full_name, clinic_name, phone)').eq('id', id).single(),
    supabase.from('case_workflow_stages').select('*').eq('case_id', id).order('position'),
    supabase.from('case_teeth').select('*').eq('case_id', id).order('tooth_number'),
    supabase.from('case_restorations').select('*, restoration_type:restoration_types(name), material:materials(name)').eq('case_id', id).order('position'),
    supabase.from('case_implants').select('*').eq('case_id', id).order('tooth_number'),
    supabase.from('attachments').select('*').eq('case_id', id).order('created_at', { ascending: false }),
    supabase.from('case_history').select('*').eq('case_id', id).order('created_at', { ascending: true }),
    supabase.from('quality_control').select('*').eq('case_id', id).order('created_at', { ascending: false }),
    supabase.from('deliveries').select('*').eq('case_id', id).maybeSingle(),
  ]);
  return {
    case: unwrap(c) as CaseDetail['case'],
    stages: unwrap(stages) as Stage[],
    teeth: unwrap(teeth) as CaseTooth[],
    restorations: unwrap(restorations) as CaseDetail['restorations'],
    implants: unwrap(implants) as CaseImplant[],
    attachments: unwrap(attachments) as Attachment[],
    history: unwrap(history) as HistoryEvent[],
    qc: unwrap(qc) as CaseDetail['qc'],
    delivery: unwrap(delivery) as CaseDetail['delivery'],
  };
}

/** Cases whose current stage is mine or my department's unassigned pool. */
export function isMyTask(c: CaseListItem, meId: string, depId: string | null): boolean {
  if (!c.current || c.status === 'delivered' || c.status === 'cancelled') return false;
  return c.current.assigned_employee_id === meId || (!c.current.assigned_employee_id && !!depId && c.current.department_id === depId);
}
