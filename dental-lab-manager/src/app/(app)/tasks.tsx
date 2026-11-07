import React from 'react';
import { CaseCard } from '../../components/cases';
import { EmptyState, ErrorBanner, Loading, Screen, SectionTitle } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { fetchCases, isMyTask } from '../../lib/queries';
import { useRealtimeRefresh } from '../../lib/realtime';
import { useAsync } from '../../lib/useAsync';

/** Cases waiting on me, then on my department's unassigned pool. */
export default function Tasks() {
  const { t } = useI18n();
  const { me } = useAuth();
  const { data, error, loading, reload } = useAsync(() => fetchCases());
  useRealtimeRefresh('tasks', ['cases', 'case_workflow_stages'], reload);
  const tasks = (data ?? []).filter((c) => me && isMyTask(c, me.id, me.department_id));
  const byDue = (a: { due_date: string }, b: { due_date: string }) => a.due_date.localeCompare(b.due_date);
  const mine = tasks.filter((c) => c.current?.assigned_employee_id === me?.id).sort(byDue);
  const pool = tasks.filter((c) => !c.current?.assigned_employee_id).sort(byDue);
  return (
    <Screen back title={t('tasks.title')} refreshing={loading && !!data} onRefresh={reload}>
      <ErrorBanner code={error} onRetry={reload} />
      {!data && loading ? <Loading /> : null}
      <SectionTitle>{`${t('tasks.mine')} (${mine.length})`}</SectionTitle>
      {data && !mine.length ? <EmptyState title={t('c.empty')} /> : mine.map((c) => <CaseCard key={c.id} c={c} />)}
      <SectionTitle>{`${t('tasks.pool')} (${pool.length})`}</SectionTitle>
      {data && !pool.length ? <EmptyState title={t('c.empty')} /> : pool.map((c) => <CaseCard key={c.id} c={c} />)}
    </Screen>
  );
}
