import { useRouter } from 'expo-router';
import { Bell, Calendar, ChartColumn, CircleAlert, CirclePlus, ClipboardList, Factory, ListChecks, ShieldCheck, Truck, UserRound } from 'lucide-react-native';
import React, { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Brand } from '../../../components/brand';
import { CaseBrowser } from '../../../components/CaseBrowser';
import { Avatar, Card, ErrorBanner, Loading, Screen, SectionTitle } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { fetchCases, fetchStats } from '../../../lib/queries';
import { useRealtimeRefresh } from '../../../lib/realtime';
import { supabase } from '../../../lib/supabase';
import { colors, glow, radius, statusColor } from '../../../lib/theme';
import { useAsync } from '../../../lib/useAsync';

export default function Dashboard() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { me, unread, can } = useAuth();
  const { data, error, loading, reload } = useAsync(async () => {
    const [stats, cases] = await Promise.all([fetchStats(), fetchCases(300)]);
    return { stats, cases };
  });
  useRealtimeRefresh('dash', ['cases', 'case_workflow_stages'], reload);

  // Fallback deadline scan (pg_cron does it hourly too); idempotent server-side.
  const scanned = useRef(false);
  useEffect(() => {
    if (scanned.current) return;
    scanned.current = true;
    supabase.rpc('check_deadlines').then(() => undefined);
  }, []);

  if (!me) return null;
  const s = data?.stats;
  const now = new Date();

  const tiles = [
    { key: 'all', label: t('dash.allCases'), value: s?.all, icon: ClipboardList, onPress: () => router.push('/(app)/(tabs)/cases'), highlight: true },
    ...(can('cases.create') ? [{ key: 'new', label: t('dash.newCase'), icon: CirclePlus, onPress: () => router.push('/(app)/(tabs)/new') }] : []),
    { key: 'tasks', label: t('dash.myTasks'), value: s?.my_tasks, icon: UserRound, onPress: () => router.push('/(app)/tasks') },
    { key: 'stats', label: t('dash.stats'), icon: ChartColumn, onPress: () => router.push('/(app)/(tabs)/reports') },
  ];
  const stats = [
    { label: t('dash.newCases'), value: s?.new, color: statusColor.new },
    { label: t('dash.inProduction'), value: s?.in_production, color: colors.gold },
    { label: t('dash.myTasks'), value: s?.my_tasks, color: colors.goldHi },
    { label: t('dash.completed'), value: (s?.completed ?? 0) + (s?.delivered ?? 0), color: colors.success },
    { label: t('status.ready_for_qc'), value: s?.ready_for_qc, color: statusColor.ready_for_qc },
    { label: t('dash.delayed'), value: s?.delayed, color: colors.error },
  ];
  const quick = [
    { label: t('dash.board'), icon: Factory, href: '/(app)/board', show: true },
    { label: t('dash.qc'), icon: ShieldCheck, href: '/(app)/qc', show: can('qc.perform') || can('cases.view_all') },
    { label: t('dash.delivery'), icon: Truck, href: '/(app)/delivery', show: can('delivery.manage') || can('cases.view_all') },
    { label: t('tasks.title'), icon: ListChecks, href: '/(app)/tasks', show: true },
  ].filter((q) => q.show);

  return (
    <Screen refreshing={loading && !!data} onRefresh={reload}>
      <View style={styles.top}>
        <Pressable onPress={() => router.push('/(app)/profile')} accessibilityRole="button" accessibilityLabel={t('set.profile')}>
          <Avatar name={me.full_name} path={me.avatar_path} size={40} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Brand compact />
        </View>
        <Pressable onPress={() => router.push('/(app)/notifications')} style={styles.bell} accessibilityRole="button" accessibilityLabel={t('n.title')}>
          <Bell color={colors.gold} size={26} />
          {unread > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      <Card style={styles.welcome}>
        <Avatar name={me.full_name} path={me.avatar_path} size={64} />
        <View style={{ flex: 1 }}>
          <Text style={styles.hello} numberOfLines={2}>
            {t('dash.welcome', { name: me.full_name })}
          </Text>
          <Text style={styles.dep}>{me.department?.name ?? me.role.name}</Text>
          <Text style={styles.lab} numberOfLines={1}>
            {me.lab.name} · {me.lab.code}
          </Text>
        </View>
        <View style={styles.dateBox}>
          <Calendar color={colors.gold} size={20} />
          <View>
            <Text style={styles.dateDay}>{now.toLocaleDateString(locale, { weekday: 'long' })}</Text>
            <Text style={styles.dateText}>{now.toLocaleDateString(locale, { day: '2-digit', month: 'long', year: 'numeric' })}</Text>
          </View>
        </View>
      </Card>

      <View style={styles.tiles}>
        {tiles.map((tile) => (
          <Pressable key={tile.key} onPress={tile.onPress} style={[styles.tile, tile.highlight && styles.tileGold]} accessibilityRole="button">
            <tile.icon color={tile.highlight ? '#1A1206' : colors.gold} size={30} strokeWidth={1.6} />
            <Text style={[styles.tileText, tile.highlight && { color: '#1A1206' }]} numberOfLines={2}>
              {tile.label}
            </Text>
            {tile.value !== undefined ? <Text style={[styles.tileValue, tile.highlight && { color: '#1A1206' }]}>({tile.value ?? '…'})</Text> : null}
          </Pressable>
        ))}
      </View>

      <ErrorBanner code={error} onRetry={reload} />
      {!data && loading ? <Loading /> : null}

      {s ? (
        <View style={styles.statsGrid}>
          {stats.map((x) => (
            <View key={x.label} style={styles.stat}>
              <Text style={[styles.statValue, { color: x.color }]}>{x.value ?? 0}</Text>
              <Text style={styles.statLabel} numberOfLines={1}>
                {x.label}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {s && s.delayed > 0 ? (
        <Pressable onPress={() => router.push({ pathname: '/(app)/(tabs)/cases', params: { filter: 'delayed' } })} style={styles.alert}>
          <CircleAlert color={colors.error} size={18} />
          <Text style={{ color: colors.white, flex: 1 }}>
            {t('dash.delayed')}: {s.delayed}
          </Text>
        </Pressable>
      ) : null}

      <SectionTitle>{t('dash.quick')}</SectionTitle>
      <View style={styles.quick}>
        {quick.map((q) => (
          <Pressable key={q.href} onPress={() => router.push(q.href as never)} style={styles.quickItem} accessibilityRole="button">
            <q.icon color={colors.gold} size={22} />
            <Text style={styles.quickText} numberOfLines={1}>
              {q.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <SectionTitle>{t('dash.recent')}</SectionTitle>
      {data ? <CaseBrowser cases={data.cases} limit={25} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bell: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: 2, end: 0, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.error, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: colors.white, fontSize: 10, fontWeight: '800' },
  welcome: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  hello: { color: colors.white, fontSize: 18, fontWeight: '800' },
  dep: { color: colors.text, fontSize: 15, marginTop: 2 },
  lab: { color: colors.muted, fontSize: 12, marginTop: 2 },
  dateBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: colors.borderHi, borderRadius: radius.md, padding: 10 },
  dateDay: { color: colors.white, fontSize: 13, fontWeight: '700' },
  dateText: { color: colors.text, fontSize: 12 },
  tiles: { flexDirection: 'row', gap: 10 },
  tile: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 16, paddingHorizontal: 4, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(16,30,48,0.9)', minHeight: 112 },
  tileGold: { backgroundColor: colors.gold, borderColor: colors.goldHi, ...glow },
  tileText: { color: colors.white, fontWeight: '700', fontSize: 13, textAlign: 'center' },
  tileValue: { color: colors.gold, fontWeight: '800', fontSize: 15 },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: { width: '31.5%', flexGrow: 1, backgroundColor: 'rgba(16,30,48,0.9)', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, alignItems: 'center' },
  statValue: { fontSize: 26, fontWeight: '800' },
  statLabel: { color: colors.muted, fontSize: 12, marginTop: 2 },
  alert: { flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(239,68,68,0.5)', backgroundColor: 'rgba(239,68,68,0.10)' },
  quick: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  quickItem: { flexGrow: 1, flexBasis: '45%', flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(16,30,48,0.9)' },
  quickText: { color: colors.white, fontWeight: '600', flexShrink: 1 },
});
