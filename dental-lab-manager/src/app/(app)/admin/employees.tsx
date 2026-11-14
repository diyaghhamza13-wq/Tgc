import { useRouter } from 'expo-router';
import { Plus } from 'lucide-react-native';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { DepartmentIcon } from '../../../components/DepartmentIcon';
import { Avatar, Badge, Card, Chip, EmptyState, ErrorBanner, Loading, Row, Screen } from '../../../components/ui';
import { fmtDate } from '../../../lib/format';
import { useI18n } from '../../../lib/i18n';
import { fetchDepartments, fetchEmployees, fetchRoles } from '../../../lib/queries';
import { colors } from '../../../lib/theme';
import { useAsync } from '../../../lib/useAsync';

export default function Employees() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [showInactive, setShowInactive] = useState(false);
  const { data, error, loading, reload } = useAsync(async () => {
    const [employees, departments, roles] = await Promise.all([fetchEmployees(true), fetchDepartments(), fetchRoles()]);
    return { employees, departments, roles };
  });
  const list = (data?.employees ?? []).filter((e) => showInactive || e.status === 'active');
  return (
    <Screen
      back
      title={t('set.employees')}
      refreshing={loading && !!data}
      onRefresh={reload}
      right={
        <Pressable onPress={() => router.push('/(app)/admin/employee/new')} hitSlop={8} accessibilityLabel={t('set.newEmployee')}>
          <Plus color={colors.gold} size={26} />
        </Pressable>
      }
    >
      <ErrorBanner code={error} onRetry={reload} />
      {!data && loading ? <Loading /> : null}
      <Row>
        <Chip label={t('c.active')} selected={!showInactive} onPress={() => setShowInactive(false)} style={{ flex: 1 }} />
        <Chip label={t('c.all')} selected={showInactive} onPress={() => setShowInactive(true)} style={{ flex: 1 }} />
      </Row>
      {data && !list.length ? <EmptyState title={t('c.empty')} /> : null}
      {list.map((e) => {
        const dep = data!.departments.find((d) => d.id === e.department_id);
        const role = data!.roles.find((r) => r.id === e.role_id);
        return (
          <Card key={e.id} onPress={() => router.push(`/(app)/admin/employee/${e.id}`)}>
            <Row>
              <Avatar name={e.full_name} path={e.avatar_path} size={48} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.white, fontSize: 16, fontWeight: '700' }}>{e.full_name}</Text>
                <Text style={{ color: colors.gold }}>
                  {e.code} · {role?.name}
                </Text>
                <Text style={{ color: colors.muted, fontSize: 12 }}>
                  {t('set.lastLogin')}: {fmtDate(e.last_login_at, locale, true)}
                </Text>
              </View>
              <View style={{ alignItems: 'center', gap: 4 }}>
                <DepartmentIcon code={dep?.code} size={24} />
                {e.status !== 'active' ? <Badge label={t('c.inactive')} color={colors.muted} /> : null}
              </View>
            </Row>
          </Card>
        );
      })}
    </Screen>
  );
}
