import React from 'react';
import { CaseCard } from '../../components/cases';
import { EmptyState, ErrorBanner, Loading, Screen, SectionTitle } from '../../components/ui';
import { useI18n } from '../../lib/i18n';
import { fetchCases } from '../../lib/queries';
import { useRealtimeRefresh } from '../../lib/realtime';
import { useAsync } from '../../lib/useAsync';

/** Quality-control queue: cases whose current stage is a QC stage. */
export default function QualityControl() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useAsync(() => fetchCases());
  useRealtimeRefresh('qc', ['cases', 'case_workflow_stages'], reload);
  const queue = (data ?? []).filter((c) => c.status === 'ready_for_qc').sort((a, b) => a.due_date.localeCompare(b.due_date));
  const returned = (data ?? []).filter((c) => c.current?.status === 'needs_revision');
  return (
    <Screen back title={t('qc.title')} refreshing={loading && !!data} onRefresh={reload}>
      <ErrorBanner code={error} onRetry={reload} />
      {!data && loading ? <Loading /> : null}
      <SectionTitle>{`${t('status.ready_for_qc')} (${queue.length})`}</SectionTitle>
      {data && !queue.length ? <EmptyState title={t('qc.empty')} /> : queue.map((c) => <CaseCard key={c.id} c={c} />)}
      {returned.length ? <SectionTitle>{`${t('stage.needs_revision')} (${returned.length})`}</SectionTitle> : null}
      {returned.map((c) => <CaseCard key={c.id} c={c} />)}
    </Screen>
  );
}
