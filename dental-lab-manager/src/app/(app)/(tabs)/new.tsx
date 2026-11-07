import React from 'react';
import { CaseWizard } from '../../../components/CaseWizard';
import { EmptyState, Screen } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';

export default function NewCase() {
  const { t } = useI18n();
  const { can } = useAuth();
  return (
    <Screen title={t('wiz.title')} subtitle="New Case">
      {can('cases.create') ? <CaseWizard /> : <EmptyState title={t('err.permission_denied')} />}
    </Screen>
  );
}
