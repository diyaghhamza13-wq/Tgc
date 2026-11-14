import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { CaseBrowser } from '../../../components/CaseBrowser';
import { ErrorBanner, Loading, Screen } from '../../../components/ui';
import { useI18n } from '../../../lib/i18n';
import { CASE_FILTERS, type CaseFilter, fetchCases } from '../../../lib/queries';
import { useRealtimeRefresh } from '../../../lib/realtime';
import { useAsync } from '../../../lib/useAsync';

/** All cases with search and status filters. */
export default function Cases() {
  const { t } = useI18n();
  const params = useLocalSearchParams<{ filter?: string }>();
  const initial = CASE_FILTERS.includes(params.filter as CaseFilter) ? (params.filter as CaseFilter) : 'all';
  const { data, error, loading, reload } = useAsync(() => fetchCases());
  useRealtimeRefresh('cases', ['cases'], reload);
  return (
    <Screen title={t('dash.allCases')} refreshing={loading && !!data} onRefresh={reload}>
      <ErrorBanner code={error} onRetry={reload} />
      {!data && loading ? <Loading /> : null}
      {data ? <CaseBrowser key={initial} cases={data} initialFilter={initial} /> : null}
    </Screen>
  );
}
