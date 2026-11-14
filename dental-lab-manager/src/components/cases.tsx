import { useRouter } from 'expo-router';
import { Calendar, Check, ChevronLeft, ChevronRight, Clock, Star } from 'lucide-react-native';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { displayFileName } from '../lib/files';
import { fmtDate, fmtDuration, isDelayed } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { colors, priorityColor, radius, statusColor } from '../lib/theme';
import type { CaseListItem, HistoryEvent, Stage } from '../lib/types';
import { ToothIcon } from './brand';
import { Badge, Card } from './ui';

export function StatusBadge({ status, due }: { status: string; due?: string }) {
  const { tx } = useI18n();
  if (due && isDelayed({ status, due_date: due })) return <Badge label={tx('status', 'delayed')} color={colors.error} />;
  return <Badge label={tx('status', status)} color={statusColor[status] ?? colors.gold} />;
}

/** Row of stage dots like the mockup: gold check = done, ring = current. */
export function ProgressDots({ stages, currentId }: { stages: { id: string; position: number; status: string; kind: string }[]; currentId: string | null }) {
  const { isRTL } = useI18n();
  const list = [...stages].filter((s) => s.kind !== 'delivered').sort((a, b) => a.position - b.position);
  return (
    <View style={[styles.dotsRow, { flexDirection: isRTL ? 'row-reverse' : 'row' }]}>
      {list.map((s, i) => {
        const done = s.status === 'completed';
        const current = s.id === currentId;
        const bad = s.status === 'needs_revision' || s.status === 'rejected';
        return (
          <React.Fragment key={s.id}>
            {i > 0 ? <View style={[styles.line, (done || current) && { backgroundColor: colors.gold }]} /> : null}
            <View style={[styles.dot, done && styles.dotDone, current && styles.dotCurrent, bad && { borderColor: colors.error }]}>
              {done ? <Check size={11} color="#1A1206" strokeWidth={3.5} /> : null}
            </View>
          </React.Fragment>
        );
      })}
    </View>
  );
}

export function CaseCard({ c }: { c: CaseListItem }) {
  const router = useRouter();
  const { t, tx, locale, isRTL } = useI18n();
  const Chevron = isRTL ? ChevronLeft : ChevronRight;
  const types = Array.from(new Set(c.restorations.map((r) => r.restoration_type?.name).filter(Boolean))).join(' · ');
  const stageLabel = c.status === 'delivered' || c.status === 'cancelled' ? tx('status', c.status) : c.current?.name ?? '';
  return (
    <Card onPress={() => router.push(`/case/${c.id}`)} style={{ padding: 14 }}>
      <View style={styles.cardRow}>
        <View style={styles.thumb}>
          <ToothIcon size={34} color={statusColor[c.status] ?? colors.gold} />
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={styles.cardRow}>
            <Text style={styles.caseNo} numberOfLines={1}>
              {c.case_number}
            </Text>
            {c.priority !== 'normal' ? <Star size={15} color={priorityColor[c.priority]} fill={priorityColor[c.priority]} /> : null}
            <View style={{ flex: 1, minWidth: 4 }} />
            <View style={{ flexShrink: 1 }}>
              <Badge label={stageLabel} color={statusColor[c.status] ?? colors.gold} />
            </View>
          </View>
          <Text style={styles.title} numberOfLines={1}>
            {c.doctor?.full_name}
            {c.clinic_order_ref ? <Text style={styles.ref}>{`  · ${c.clinic_order_ref}`}</Text> : null}
          </Text>
          {types ? (
            <Text style={styles.small} numberOfLines={1}>
              {types}
            </Text>
          ) : null}
          <View style={[styles.cardRow, { flexWrap: 'wrap', gap: 10 }]}>
            <View style={styles.meta}>
              <Calendar size={13} color={isDelayed(c) ? colors.error : colors.muted} />
              <Text style={[styles.small, isDelayed(c) && { color: colors.error }]}>{fmtDate(c.due_date, locale)}</Text>
            </View>
            {c.current && c.status !== 'delivered' ? (
              <Text style={[styles.small, { color: colors.text }]} numberOfLines={1}>
                {t('case.responsible')}: {c.current.assignee?.full_name ?? t('case.unassigned')}
              </Text>
            ) : null}
          </View>
        </View>
        <Chevron color={colors.gold} size={22} />
      </View>
      <ProgressDots stages={c.stages} currentId={c.current_stage_id} />
    </Card>
  );
}

export function StageTimeline({ stages, currentId }: { stages: Stage[]; currentId: string | null }) {
  const { tx, isRTL } = useI18n();
  const list = [...stages].filter((s) => s.kind !== 'delivered').sort((a, b) => a.position - b.position);
  return (
    <View style={{ flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'flex-start' }}>
      {list.map((s, i) => {
        const done = s.status === 'completed';
        const current = s.id === currentId;
        const bad = s.status === 'needs_revision' || s.status === 'rejected';
        return (
          <View key={s.id} style={{ flex: 1, alignItems: 'center' }}>
            <View style={{ flexDirection: isRTL ? 'row-reverse' : 'row', alignItems: 'center', width: '100%' }}>
              <View style={[styles.tlLine, { opacity: i === 0 ? 0 : 1 }, (done || current) && { backgroundColor: colors.gold }]} />
              <View style={[styles.tlNode, done && styles.dotDone, current && styles.tlCurrent, bad && { borderColor: colors.error }]}>
                {done ? <Check size={14} color="#1A1206" strokeWidth={3} /> : current ? <ToothIcon size={16} color={colors.goldHi} /> : null}
              </View>
              <View style={[styles.tlLine, { opacity: i === list.length - 1 ? 0 : 1 }, done && { backgroundColor: colors.gold }]} />
            </View>
            <Text style={[styles.tlText, current && { color: colors.gold, fontWeight: '800' }]} numberOfLines={2}>
              {s.name}
            </Text>
            {current || bad ? <Text style={[styles.tlStatus, bad && { color: colors.error }]}>({tx('stage', s.status)})</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

export function HistoryList({ events, employees, stages }: { events: HistoryEvent[]; employees: Record<string, string>; stages: Record<string, string> }) {
  const { t, tx, locale } = useI18n();
  // employees who deleted their account: the link is cleared (actor_id null) and
  // stored names are replaced by "Deleted Employee" in the database
  const deleted = t('c.deletedEmployee');
  const nameOf = (stored: unknown) => (stored === 'Deleted Employee' ? deleted : (stored as string) ?? '—');
  return (
    <View>
      {events.map((e, i) => {
        const tone =
          e.event_type === 'qc_failed' || e.event_type === 'cancelled'
            ? colors.error
            : e.event_type === 'note' || e.event_type.startsWith('file')
              ? colors.info
              : colors.success;
        const title =
          e.event_type === 'transferred' && e.to_stage_id
            ? `${tx('ev', 'transferred')} → ${stages[e.to_stage_id] ?? ''}`
            : e.event_type === 'stage_started' || e.event_type === 'stage_status'
              ? `${tx('ev', e.event_type)} · ${(e.data.stage_name as string) ?? ''}${e.status ? ` (${tx('stage', e.status)})` : ''}`
              : e.event_type.startsWith('file')
                ? `${tx('ev', e.event_type)} · ${displayFileName({ file_name: (e.data.file_name as string) ?? '', category: (e.data.category as string) ?? 'other' })}`
                : e.event_type === 'assigned'
                  ? `${tx('ev', 'assigned')} · ${(e.data.stage_name as string) ?? ''} → ${nameOf(e.data.employee_name)}`
                  : tx('ev', e.event_type);
        return (
          <View key={e.id} style={styles.hRow}>
            <View style={{ alignItems: 'center' }}>
              <View style={[styles.hDot, { borderColor: tone }]}>
                <View style={[styles.hDotIn, { backgroundColor: tone }]} />
              </View>
              {i < events.length - 1 ? <View style={styles.hLine} /> : null}
            </View>
            <View style={{ flex: 1, paddingBottom: 14 }}>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Text style={styles.hTitle}>{title}</Text>
                <View style={{ flex: 1 }} />
                <Text style={styles.hActor}>{e.actor_id ? employees[e.actor_id] ?? deleted : deleted}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                <Clock size={11} color={colors.muted} />
                <Text style={styles.small}>{fmtDate(e.created_at, locale, true)}</Text>
              </View>
              {e.notes ? <Text style={styles.hNote}>{e.notes}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function StageDuration({ s }: { s: Stage }) {
  const { t } = useI18n();
  const running = s.active_since ? Math.floor((Date.now() - new Date(s.active_since).getTime()) / 1000) : 0;
  return <Text style={styles.small}>{fmtDuration(s.time_spent_seconds + running, { h: t('c.hours'), m: t('c.minutes') })}</Text>;
}

const styles = StyleSheet.create({
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  thumb: { width: 62, height: 62, borderRadius: radius.md, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  caseNo: { color: colors.white, fontSize: 16, fontWeight: '800', writingDirection: 'ltr', flexShrink: 0 },
  title: { color: colors.white, fontSize: 17, fontWeight: '700' },
  ref: { color: colors.gold, fontSize: 14, fontWeight: '600', writingDirection: 'ltr' },
  small: { color: colors.muted, fontSize: 12 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 160 },
  dotsRow: { alignItems: 'center', marginTop: 12, paddingHorizontal: 6 },
  dot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.faint, backgroundColor: colors.bg2, alignItems: 'center', justifyContent: 'center' },
  dotDone: { backgroundColor: colors.gold, borderColor: colors.goldHi },
  dotCurrent: { borderColor: colors.goldHi, borderWidth: 3, backgroundColor: 'rgba(255,211,107,0.25)' },
  line: { flex: 1, height: 2, backgroundColor: colors.faint },
  tlLine: { flex: 1, height: 3, backgroundColor: colors.faint },
  tlNode: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: colors.faint, backgroundColor: colors.bg2, alignItems: 'center', justifyContent: 'center' },
  tlCurrent: { width: 40, height: 40, borderRadius: 20, borderColor: colors.goldHi, borderWidth: 3, backgroundColor: 'rgba(214,173,85,0.18)', shadowColor: colors.goldHi, shadowOpacity: 0.8, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
  tlText: { color: colors.white, fontSize: 10, textAlign: 'center', marginTop: 6 },
  tlStatus: { color: colors.gold, fontSize: 10, textAlign: 'center' },
  hRow: { flexDirection: 'row', gap: 12 },
  hDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  hDotIn: { width: 8, height: 8, borderRadius: 4 },
  hLine: { width: 2, flex: 1, backgroundColor: colors.border, marginVertical: 2 },
  hTitle: { color: colors.white, fontWeight: '700', fontSize: 14, flexShrink: 1 },
  hActor: { color: colors.gold, fontSize: 13, fontWeight: '600' },
  hNote: { color: colors.text, fontSize: 13, marginTop: 4, backgroundColor: colors.bg2, padding: 8, borderRadius: radius.sm },
});
