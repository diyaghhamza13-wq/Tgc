import { useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBadge } from '../../components/cases';
import { DepartmentIcon } from '../../components/DepartmentIcon';
import { Card, EmptyState, ErrorBanner, Loading, Screen } from '../../components/ui';
import { fmtDate } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { fetchCases, fetchDepartments } from '../../lib/queries';
import { useRealtimeRefresh } from '../../lib/realtime';
import { colors, radius } from '../../lib/theme';
import { useAsync } from '../../lib/useAsync';

const loadBoard = async () => {
  const [cases, departments] = await Promise.all([fetchCases(), fetchDepartments()]);
  return { cases, departments };
};

/** Production board: active cases grouped by the department of their current stage. */
export default function Board() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { data, error, loading, reload } = useAsync(loadBoard);
  useRealtimeRefresh('board', ['cases', 'case_workflow_stages'], reload);
  const columns = useMemo(() => {
    if (!data) return [];
    const active = data.cases.filter((c) => c.status !== 'delivered' && c.status !== 'cancelled');
    return data.departments
      .map((d) => ({ dep: d, cases: active.filter((c) => c.current?.department_id === d.id) }))
      .filter((col) => col.cases.length > 0 || !['ADMIN'].includes(col.dep.code));
  }, [data]);
  return (
    <Screen back title={t('board.title')} refreshing={loading && !!data} onRefresh={reload} contentStyle={{ maxWidth: 1400 }}>
      <ErrorBanner code={error} onRetry={reload} />
      {!data && loading ? <Loading /> : null}
      <ScrollView horizontal contentContainerStyle={{ gap: 12 }} showsHorizontalScrollIndicator>
        {columns.map(({ dep, cases }) => (
          <View key={dep.id} style={styles.col}>
            <View style={styles.colHead}>
              <DepartmentIcon code={dep.code} size={22} />
              <Text style={styles.colTitle}>{dep.name}</Text>
              <Text style={styles.count}>{cases.length}</Text>
            </View>
            {cases.length === 0 ? <EmptyState title={t('c.empty')} /> : null}
            {cases.map((c) => (
              <Card key={c.id} onPress={() => router.push(`/case/${c.id}`)} style={{ padding: 12, marginBottom: 8 }}>
                <Text style={styles.no}>{c.case_number}</Text>
                <Text style={styles.patient} numberOfLines={1}>{c.patient?.full_name}</Text>
                <Text style={styles.small} numberOfLines={1}>{c.current?.name} · {c.current?.assignee?.full_name ?? t('case.unassigned')}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                  <StatusBadge status={c.status} due={c.due_date} />
                  <Text style={styles.small}>{fmtDate(c.due_date, locale)}</Text>
                </View>
              </Card>
            ))}
          </View>
        ))}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  col: { width: 260, backgroundColor: 'rgba(11,23,38,0.7)', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 10 },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  colTitle: { color: colors.white, fontWeight: '800', flex: 1 },
  count: { color: colors.gold, fontWeight: '800' },
  no: { color: colors.gold, fontWeight: '800', writingDirection: 'ltr' },
  patient: { color: colors.white, fontWeight: '700', fontSize: 15 },
  small: { color: colors.muted, fontSize: 12 },
});
