import { useRouter } from 'expo-router';
import { Bell, CheckCheck, Trash2 } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFeedback } from '../../components/feedback';
import { Button, Card, EmptyState, ErrorBanner, Loading, Row, Screen } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { fmtDate } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { useRealtimeRefresh } from '../../lib/realtime';
import { errorCode, supabase, unwrap } from '../../lib/supabase';
import { colors } from '../../lib/theme';
import type { Notification } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';

const TONE: Record<string, string> = {
  qc_rejected: colors.error, revision_requested: colors.error, case_delayed: colors.error,
  deadline_approaching: colors.warning, ready_for_delivery: colors.success, case_delivered: colors.success,
};

export default function Notifications() {
  const { t, tx, locale } = useI18n();
  const router = useRouter();
  const { refreshUnread } = useAuth();
  const fb = useFeedback();
  const { data, error, loading, reload } = useAsync(
    async () => unwrap(await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(200)) as Notification[],
  );
  useRealtimeRefresh('notif', ['notifications'], reload);

  const act = async (fn: () => PromiseLike<{ error: unknown }>) => {
    const { error: e } = await fn();
    if (e) fb.toast(tx('err', errorCode(e)), 'error');
    await reload();
    refreshUnread();
  };

  return (
    <Screen
      back
      title={t('n.title')}
      refreshing={loading && !!data}
      onRefresh={reload}
      right={
        data?.some((n) => !n.read_at) ? (
          <Pressable onPress={() => act(() => supabase.rpc('mark_all_notifications_read'))} hitSlop={8} accessibilityLabel={t('n.markAll')}>
            <CheckCheck color={colors.gold} size={24} />
          </Pressable>
        ) : undefined
      }
    >
      <ErrorBanner code={error} onRetry={reload} />
      {!data && loading ? <Loading /> : null}
      {data && !data.length ? <EmptyState title={t('c.empty')} icon={<Bell color={colors.faint} size={36} />} /> : null}
      {data?.some((n) => !n.read_at) ? <Button small variant="outline" title={t('n.markAll')} onPress={() => act(() => supabase.rpc('mark_all_notifications_read'))} /> : null}
      {data?.map((n) => (
        <Card
          key={n.id}
          style={!n.read_at ? { borderColor: colors.gold } : undefined}
          onPress={async () => {
            if (!n.read_at) await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id);
            refreshUnread();
            if (n.case_id) router.push(`/case/${n.case_id}`);
            else reload();
          }}
        >
          <Row style={{ alignItems: 'flex-start' }}>
            <View style={[styles.dot, { backgroundColor: n.read_at ? colors.faint : TONE[n.type] ?? colors.gold }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{tx('n', n.type)}</Text>
              <Text style={styles.body}>
                {[n.data.case_number, n.data.stage_name].filter(Boolean).join(' · ')}
              </Text>
              {n.data.notes || (n.type === 'qc_rejected' && n.body) ? <Text style={styles.note}>{String(n.data.notes ?? n.body)}</Text> : null}
              <Text style={styles.time}>{fmtDate(n.created_at, locale, true)}</Text>
            </View>
            <Pressable hitSlop={10} onPress={() => act(() => supabase.from('notifications').delete().eq('id', n.id))} accessibilityLabel={t('c.delete')}>
              <Trash2 color={colors.muted} size={18} />
            </Pressable>
          </Row>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
  title: { color: colors.white, fontWeight: '800', fontSize: 15 },
  body: { color: colors.gold, marginTop: 2, writingDirection: 'ltr' },
  note: { color: colors.text, marginTop: 4, fontSize: 13 },
  time: { color: colors.muted, fontSize: 12, marginTop: 4 },
});
