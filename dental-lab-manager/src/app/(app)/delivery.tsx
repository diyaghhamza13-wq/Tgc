import React from 'react';
import { CaseCard } from '../../components/cases';
import { EmptyState, ErrorBanner, Loading, Screen, SectionTitle } from '../../components/ui';
import { useI18n } from '../../lib/i18n';
import { fetchCases } from '../../lib/queries';
import { useRealtimeRefresh } from '../../lib/realtime';
import { useAsync } from '../../lib/useAsync';

/** Delivery management: ready cases (deliver from the case page) and recent deliveries. */
export default function Delivery() {
  const { t } = useI18n();
  const { data, error, loading, reload } = useAsync(() => fetchCases());
  useRealtimeRefresh('delivery', ['cases'], reload);
  const ready = (data ?? []).filter((c) => c.status === 'completed').sort((a, b) => a.due_date.localeCompare(b.due_date));
  const done = (data ?? [])
    .filter((c) => c.status === 'delivered')
    .sort((a, b) => (b.delivered_at ?? '').localeCompare(a.delivered_at ?? ''))
    .slice(0, 30);
  return (
    <Screen back title={t('delivery.title')} refreshing={loading && !!data} onRefresh={reload}>
      <ErrorBanner code={error} onRetry={reload} />
      {!data && loading ? <Loading /> : null}
      <SectionTitle>{`${t('delivery.ready')} (${ready.length})`}</SectionTitle>
      {data && !ready.length ? <EmptyState title={t('c.empty')} /> : ready.map((c) => <CaseCard key={c.id} c={c} />)}
      <SectionTitle>{t('delivery.done')}</SectionTitle>
      {data && !done.length ? <EmptyState title={t('c.empty')} /> : done.map((c) => <CaseCard key={c.id} c={c} />)}
    </Screen>
  );
}
