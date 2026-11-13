import React from 'react';
import { Text, View } from 'react-native';
import { Card, EmptyState, ErrorBanner, Loading, Row, Screen, Badge } from '../../../components/ui';
import { fmtDate } from '../../../lib/format';
import { useI18n } from '../../../lib/i18n';
import { fetchEmployees } from '../../../lib/queries';
import { supabase, unwrap } from '../../../lib/supabase';
import { colors } from '../../../lib/theme';
import { useAsync } from '../../../lib/useAsync';

type Log = { id: number; table_name: string; action: string; record_id: string | null; actor_employee_id: string | null; created_at: string; new_data: Record<string, unknown> | null; old_data: Record<string, unknown> | null };

/** Read-only audit trail (RLS: audit.view). */
export default function Audit() {
  const { t, locale } = useI18n();
  const { data, error, loading, reload } = useAsync(async () => {
    const [logs, employees] = await Promise.all([
      supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(300).then((r) => unwrap(r) as Log[]),
      fetchEmployees(true),
    ]);
    return { logs, names: Object.fromEntries(employees.map((e) => [e.id, e.full_name])) };
  });
  const changed = (l: Log) =>
    l.action === 'UPDATE' && l.old_data && l.new_data
      ? Object.keys(l.new_data).filter((k) => k !== 'updated_at' && JSON.stringify(l.new_data![k]) !== JSON.stringify(l.old_data![k])).join(', ')
      : '';
  return (
    <Screen back title={t('set.audit')} refreshing={loading && !!data} onRefresh={reload}>
      <ErrorBanner code={error} onRetry={reload} />
      {!data && loading ? <Loading /> : null}
      {data && !data.logs.length ? <EmptyState title={t('c.empty')} /> : null}
      {data?.logs.map((l) => (
        <Card key={l.id} style={{ padding: 12 }}>
          <Row>
            <Badge label={l.action} color={l.action === 'DELETE' ? colors.error : l.action === 'INSERT' ? colors.success : colors.gold} />
            <Text style={{ color: colors.white, fontWeight: '700', flex: 1 }}>{l.table_name}</Text>
            <Text style={{ color: colors.muted, fontSize: 12 }}>{fmtDate(l.created_at, locale, true)}</Text>
          </Row>
          <View style={{ marginTop: 4 }}>
            <Text style={{ color: colors.gold, fontSize: 13 }}>{l.actor_employee_id ? data.names[l.actor_employee_id] ?? t('c.deletedEmployee') : 'system'}</Text>
            {changed(l) ? <Text style={{ color: colors.muted, fontSize: 12 }}>{changed(l)}</Text> : null}
          </View>
        </Card>
      ))}
    </Screen>
  );
}
