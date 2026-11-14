import { FileDown, FileSpreadsheet } from 'lucide-react-native';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { BarList, PairBars, StatTile } from '../../../components/charts';
import { useFeedback } from '../../../components/feedback';
import { DateField, Select } from '../../../components/pickers';
import { Button, Card, EmptyState, ErrorBanner, Loading, Row, Screen, SectionTitle } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { exportExcel, exportPdf, type Sheet, toHtmlReport } from '../../../lib/export';
import { fmtDate, todayISO } from '../../../lib/format';
import { useI18n } from '../../../lib/i18n';
import { fetchCatalogs, fetchDepartments, fetchDoctors, fetchEmployees } from '../../../lib/queries';
import { errorCode, supabase, unwrap } from '../../../lib/supabase';
import { colors } from '../../../lib/theme';
import { useAsync } from '../../../lib/useAsync';

type Report = {
  scope: 'lab' | 'own';
  totals: { total: number; completed: number; in_production: number; delayed: number; delivered: number; delivered_late: number; cancelled: number; avg_production_hours: number | null };
  departments: { name: string; stages_completed: number; avg_hours: number | null; revisions: number }[];
  employees: { name: string; code: string; stages_completed: number; cases: number; avg_hours: number | null }[];
  monthly: { month: string; received: number; delivered: number }[];
  materials: { name: string; count: number; units: number }[];
  restoration_types: { name: string; count: number }[];
  doctors: { name: string; count: number }[];
  cases: { case_number: string; clinic_order_ref: string | null; doctor: string; received_at: string; due_date: string; status: string; priority: string; delivered_at: string | null }[];
};

/** Analytics with filters and PDF / Excel export. Scope is enforced by the server. */
export default function Reports() {
  const { t, tx, locale, isRTL } = useI18n();
  const { me, can } = useAuth();
  const fb = useFeedback();
  const [filters, setFilters] = useState({ from: todayISO(-90), to: todayISO(), employee: null as string | null, department: null as string | null, doctor: null as string | null, type: null as string | null });
  const [applied, setApplied] = useState(filters);
  const lists = useAsync(async () => {
    const [employees, departments, doctors, catalogs] = await Promise.all([fetchEmployees(true), fetchDepartments(), fetchDoctors(true), fetchCatalogs()]);
    return { employees, departments, doctors, types: catalogs.types };
  });
  const rep = useAsync(
    async () =>
      unwrap(
        await supabase.rpc('lab_report', {
          p_from: applied.from, p_to: applied.to, p_employee_id: applied.employee, p_department_id: applied.department,
          p_doctor_id: applied.doctor, p_restoration_type_id: applied.type,
        }),
      ) as Report,
    [applied],
  );
  const r = rep.data;
  const hours = (h: number | null) => (h == null ? '—' : h >= 48 ? `${(h / 24).toFixed(1)} ${t('c.days')}` : `${h} ${t('c.hours')}`);

  const sheets = (): Sheet[] =>
    !r
      ? []
      : [
          { name: t('rep.total'), headers: [t('c.name'), t('rep.count')], rows: [
            [t('rep.total'), r.totals.total], [t('dash.completed'), r.totals.completed], [t('dash.inProduction'), r.totals.in_production],
            [t('dash.delayed'), r.totals.delayed], [t('status.delivered'), r.totals.delivered], [t('rep.deliveredLate'), r.totals.delivered_late],
            [`${t('rep.avg')} (h)`, r.totals.avg_production_hours ?? 0],
          ] },
          { name: t('rep.monthly'), headers: ['Month', t('rep.received'), t('status.delivered')], rows: r.monthly.map((m) => [m.month, m.received, m.delivered]) },
          { name: t('rep.departments'), headers: [t('set.department'), t('rep.stages'), t('rep.avgHours'), t('det.revisions', { n: '' }).trim()], rows: r.departments.map((d) => [d.name, d.stages_completed, d.avg_hours ?? 0, d.revisions]) },
          { name: t('rep.employees'), headers: [t('rep.employee'), t('c.code'), t('rep.stages'), t('tab.cases'), t('rep.avgHours')], rows: r.employees.map((e) => [e.name, e.code, e.stages_completed, e.cases, e.avg_hours ?? 0]) },
          { name: t('rep.materials'), headers: [t('wiz.material'), t('rep.count'), t('rep.units')], rows: r.materials.map((m) => [m.name, m.count, m.units]) },
          { name: t('rep.types'), headers: [t('wiz.restorationType'), t('rep.count')], rows: r.restoration_types.map((x) => [x.name, x.count]) },
          { name: t('rep.doctors'), headers: [t('case.doctor'), t('rep.count')], rows: r.doctors.map((x) => [x.name, x.count]) },
          { name: t('rep.caseList'), headers: [t('case.number'), t('case.orderRef'), t('case.doctor'), t('case.receivedAt'), t('case.dueDate'), t('c.status'), t('case.priority')],
            rows: r.cases.map((c) => [c.case_number, c.clinic_order_ref ?? '', c.doctor, fmtDate(c.received_at, locale), fmtDate(c.due_date, locale), tx('status', c.status), tx('prio', c.priority)]) },
        ];
  const fileBase = `report-${me?.lab.code}-${applied.from}_${applied.to}`;
  const doExport = async (kind: 'pdf' | 'xls') => {
    try {
      if (kind === 'xls') await exportExcel(fileBase, sheets());
      else await exportPdf(fileBase, toHtmlReport(`${t('rep.title')} — ${me?.lab.name}`, `${fmtDate(applied.from, locale)} → ${fmtDate(applied.to, locale)}`, sheets(), isRTL));
    } catch (e) {
      fb.toast(tx('err', errorCode(e)), 'error');
    }
  };

  const L = lists.data;
  return (
    <Screen title={t('rep.title')} refreshing={rep.loading && !!r} onRefresh={rep.reload}>
      <Card>
        <SectionTitle>{t('rep.filters')}</SectionTitle>
        <Row>
          <View style={{ flex: 1 }}>
            <DateField label={t('rep.from')} value={filters.from} onChange={(v) => setFilters((f) => ({ ...f, from: v }))} />
          </View>
          <View style={{ flex: 1 }}>
            <DateField label={t('rep.to')} value={filters.to} onChange={(v) => setFilters((f) => ({ ...f, to: v }))} min={filters.from} />
          </View>
        </Row>
        {L ? (
          <>
            {can('reports.view') ? (
              <Select label={t('rep.employee')} value={filters.employee} allowClear onChange={(v) => setFilters((f) => ({ ...f, employee: v }))} options={L.employees.map((e) => ({ value: e.id, label: `${e.full_name} (${e.code})` }))} />
            ) : null}
            <Select label={t('set.department')} value={filters.department} allowClear onChange={(v) => setFilters((f) => ({ ...f, department: v }))} options={L.departments.map((d) => ({ value: d.id, label: d.name }))} />
            <Select label={t('case.doctor')} value={filters.doctor} allowClear onChange={(v) => setFilters((f) => ({ ...f, doctor: v }))} options={L.doctors.map((d) => ({ value: d.id, label: d.full_name }))} />
            <Select label={t('rep.caseType')} value={filters.type} allowClear onChange={(v) => setFilters((f) => ({ ...f, type: v }))} options={L.types.map((x) => ({ value: x.id, label: x.name }))} />
          </>
        ) : null}
        <Button title={t('rep.apply')} onPress={() => setApplied(filters)} />
      </Card>

      <ErrorBanner code={rep.error} onRetry={rep.reload} />
      {!r && rep.loading ? <Loading /> : null}
      {r ? (
        <>
          {r.scope === 'own' ? <Text style={{ color: colors.warning, textAlign: 'center' }}>{t('rep.scopeOwn')}</Text> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            <StatTile label={t('rep.total')} value={r.totals.total} />
            <StatTile label={t('dash.completed')} value={r.totals.completed} />
            <StatTile label={t('dash.inProduction')} value={r.totals.in_production} />
            <StatTile label={t('dash.delayed')} value={r.totals.delayed} accent={r.totals.delayed ? colors.error : undefined} />
            <StatTile label={t('status.delivered')} value={r.totals.delivered} />
            <StatTile label={t('rep.avg')} value={hours(r.totals.avg_production_hours)} />
          </View>
          <Row>
            <Button style={{ flex: 1 }} variant="outline" icon={<FileDown color={colors.gold} size={18} />} title={t('rep.pdf')} onPress={() => doExport('pdf')} />
            <Button style={{ flex: 1 }} variant="outline" icon={<FileSpreadsheet color={colors.gold} size={18} />} title={t('rep.excel')} onPress={() => doExport('xls')} />
          </Row>
          <Card>
            <SectionTitle>{t('rep.monthly')}</SectionTitle>
            {r.monthly.length ? <PairBars labels={[t('rep.received'), t('status.delivered')]} rows={r.monthly.map((m) => ({ label: m.month, a: m.received, b: m.delivered }))} /> : <EmptyState title={t('c.empty')} />}
          </Card>
          <Card>
            <SectionTitle>{t('rep.departments')}</SectionTitle>
            {r.departments.length ? (
              <BarList items={r.departments.map((d) => ({ label: d.name, value: d.stages_completed, sub: `${t('rep.avgHours')}: ${d.avg_hours ?? '—'} · ${t('det.revisions', { n: d.revisions })}` }))} />
            ) : <EmptyState title={t('c.empty')} />}
          </Card>
          <Card>
            <SectionTitle>{t('rep.employees')}</SectionTitle>
            {r.employees.length ? (
              <BarList items={r.employees.map((e) => ({ label: `${e.name} (${e.code})`, value: e.stages_completed, sub: `${t('tab.cases')}: ${e.cases} · ${t('rep.avgHours')}: ${e.avg_hours ?? '—'}` }))} />
            ) : <EmptyState title={t('c.empty')} />}
          </Card>
          <Card>
            <SectionTitle>{t('rep.materials')}</SectionTitle>
            {r.materials.length ? <BarList items={r.materials.map((m) => ({ label: m.name, value: m.units, sub: `${t('wiz.restorations')}: ${m.count}` }))} /> : <EmptyState title={t('c.empty')} />}
          </Card>
          <Card>
            <SectionTitle>{t('rep.types')}</SectionTitle>
            {r.restoration_types.length ? <BarList items={r.restoration_types.map((x) => ({ label: x.name, value: x.count }))} /> : <EmptyState title={t('c.empty')} />}
          </Card>
          <Card>
            <SectionTitle>{t('rep.doctors')}</SectionTitle>
            {r.doctors.length ? <BarList items={r.doctors.map((x) => ({ label: x.name, value: x.count }))} /> : <EmptyState title={t('c.empty')} />}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
