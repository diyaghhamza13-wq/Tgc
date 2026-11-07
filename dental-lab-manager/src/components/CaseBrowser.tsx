import { Search } from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { CASE_FILTERS, type CaseFilter, filterCases } from '../lib/queries';
import { isDelayed } from '../lib/format';
import { colors, radius } from '../lib/theme';
import type { CaseListItem } from '../lib/types';
import { CaseCard } from './cases';
import { Chip, EmptyState } from './ui';

/** Search bar + status filter chips + case cards. */
export function CaseBrowser({ cases, limit, initialFilter = 'all' }: { cases: CaseListItem[]; limit?: number; initialFilter?: CaseFilter }) {
  const { t, tx, isRTL } = useI18n();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<CaseFilter>(initialFilter);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of CASE_FILTERS) m[f] = 0;
    for (const c of cases) {
      if (c.status !== 'cancelled') m.all++;
      if (m[c.status] !== undefined) m[c.status]++;
      if (isDelayed(c)) m.delayed++;
    }
    return m;
  }, [cases]);
  const list = useMemo(() => filterCases(cases, filter, q), [cases, filter, q]);
  const shown = limit ? list.slice(0, limit) : list;
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.searchRow}>
        <View style={styles.search}>
          <Search color={colors.white} size={20} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('dash.search')}
            placeholderTextColor={colors.faint}
            style={[styles.input, { textAlign: isRTL ? 'right' : 'left' }]}
            autoCorrect={false}
            accessibilityLabel={t('c.search')}
          />
        </View>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {CASE_FILTERS.map((f) => (
          <Chip
            key={f}
            label={`${f === 'all' ? t('c.all') : tx('status', f)} (${counts[f]})`}
            selected={filter === f}
            onPress={() => setFilter(f)}
            color={f === 'delayed' && counts.delayed ? colors.error : undefined}
            style={{ borderRadius: radius.pill, paddingVertical: 8 }}
          />
        ))}
      </ScrollView>
      {shown.length === 0 ? <EmptyState title={t('c.noResults')} /> : shown.map((c) => <CaseCard key={c.id} c={c} />)}
      {limit && list.length > limit ? <Text style={{ color: colors.muted, textAlign: 'center' }}>+{list.length - limit}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', gap: 10 },
  search: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: colors.borderHi, borderRadius: radius.pill, paddingHorizontal: 16, backgroundColor: 'rgba(11,23,38,0.9)' },
  input: { flex: 1, color: colors.white, fontSize: 15, paddingVertical: 12 },
});
