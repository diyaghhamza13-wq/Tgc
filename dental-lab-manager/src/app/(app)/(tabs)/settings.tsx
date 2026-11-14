import { useRouter } from 'expo-router';
import {
  Bell, Box, Info, Building2, ChevronLeft, ChevronRight, GitBranch, KeyRound, Layers, LogOut, ScrollText, ShieldCheck, Stethoscope, User, Users,
} from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ImplantIcon, ToothIcon } from '../../../components/brand';
import { LanguagePicker } from '../../../components/LanguagePicker';
import { Avatar, Button, Card, Row, Screen, SectionTitle } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { colors } from '../../../lib/theme';

type Item = { label: string; href: string; icon: React.ReactNode; show: boolean };

export default function Settings() {
  const { t, isRTL } = useI18n();
  const router = useRouter();
  const { me, can, logout } = useAuth();
  if (!me) return null;
  const Chevron = isRTL ? ChevronLeft : ChevronRight;
  const ic = (I: typeof User) => <I color={colors.gold} size={22} strokeWidth={1.7} />;

  const account: Item[] = [
    { label: t('set.profile'), href: '/(app)/profile', icon: ic(User), show: true },
    { label: t('set.security'), href: '/(app)/profile', icon: ic(KeyRound), show: true },
    { label: t('n.title'), href: '/(app)/notifications', icon: ic(Bell), show: true },
    { label: t('set.privacy'), href: '/privacy', icon: ic(ShieldCheck), show: true },
    { label: t('set.aboutDev'), href: '/about', icon: ic(Info), show: true },
  ];
  const admin: Item[] = [
    { label: t('set.lab'), href: '/(app)/admin/lab', icon: ic(Building2), show: can('lab.settings') },
    { label: t('set.employees'), href: '/(app)/admin/employees', icon: ic(Users), show: can('employees.manage') },
    { label: t('set.departments'), href: '/(app)/admin/catalog?kind=departments', icon: ic(Layers), show: can('employees.manage') },
    { label: t('set.roles'), href: '/(app)/admin/roles', icon: ic(ShieldCheck), show: can('employees.manage') },
    { label: t('set.workflow'), href: '/(app)/admin/workflow', icon: ic(GitBranch), show: can('workflow.configure') },
    { label: t('set.doctors'), href: '/(app)/admin/catalog?kind=doctors', icon: ic(Stethoscope), show: can('doctors.manage') },
    { label: t('set.restorations'), href: '/(app)/admin/catalog?kind=restorations', icon: <ToothIcon size={22} />, show: can('lab.settings') },
    { label: t('set.materials'), href: '/(app)/admin/catalog?kind=materials', icon: ic(Box), show: can('lab.settings') },
    { label: t('set.implants'), href: '/(app)/admin/implants', icon: <ImplantIcon size={22} />, show: can('lab.settings') },
    { label: t('set.audit'), href: '/(app)/admin/audit', icon: ic(ScrollText), show: can('audit.view') },
  ].filter((i) => i.show);

  const List = ({ items }: { items: Item[] }) => (
    <Card style={{ paddingVertical: 4 }}>
      {items.map((i, idx) => (
        <Pressable key={i.label} onPress={() => router.push(i.href as never)} style={[styles.item, idx < items.length - 1 && styles.sep]} accessibilityRole="button">
          {i.icon}
          <Text style={styles.itemText}>{i.label}</Text>
          <Chevron color={colors.muted} size={20} />
        </Pressable>
      ))}
    </Card>
  );

  return (
    <Screen title={t('set.title')}>
      <Card onPress={() => router.push('/(app)/profile')}>
        <Row>
          <Avatar name={me.full_name} path={me.avatar_path} size={56} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{me.full_name}</Text>
            <Text style={styles.sub}>
              {me.code} · {me.role.name} · {me.lab.code}
            </Text>
          </View>
        </Row>
      </Card>
      <Card>
        <Row>
          <Text style={[styles.itemText, { marginStart: 0 }]}>{t('set.language')}</Text>
          <LanguagePicker persistToProfile />
        </Row>
      </Card>
      <List items={account} />
      {admin.length ? (
        <>
          <SectionTitle>{t('set.admin')}</SectionTitle>
          <List items={admin} />
        </>
      ) : null}
      <Button
        variant="danger"
        icon={<LogOut color={colors.white} size={18} />}
        title={t('c.logout')}
        onPress={async () => {
          await logout();
          router.replace('/(auth)/lab');
        }}
      />
      <Text style={styles.version}>Dental Lab Manager · {t('set.version')} 1.0.0</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  sep: { borderBottomWidth: 1, borderBottomColor: colors.border },
  itemText: { color: colors.white, fontSize: 16, flex: 1 },
  name: { color: colors.white, fontSize: 18, fontWeight: '800' },
  sub: { color: colors.muted, marginTop: 2 },
  version: { color: colors.faint, textAlign: 'center', fontSize: 12 },
});
