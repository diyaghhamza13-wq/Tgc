import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { CaseWizard } from '../../../../components/CaseWizard';
import { ErrorBanner, Loading, Screen } from '../../../../components/ui';
import { useI18n } from '../../../../lib/i18n';
import { fetchCaseDetail } from '../../../../lib/queries';
import { useAsync } from '../../../../lib/useAsync';

export default function EditCase() {
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, error, reload } = useAsync(() => fetchCaseDetail(id), [id]);
  return (
    <Screen back title={t('wiz.editTitle')} subtitle={data?.case.case_number}>
      <ErrorBanner code={error} onRetry={reload} />
      {data ? <CaseWizard key={data.case.id} existing={data} /> : !error ? <Loading /> : null}
    </Screen>
  );
}
