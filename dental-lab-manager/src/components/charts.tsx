import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../lib/theme';

// Validated chart palette (dark surface #101E30, OKLCH L within 0.48–0.67, CVD ΔE ≥ 26).
// The brighter UI golds are reserved for chrome, not data marks.
export const SERIES = ['#B08A3A', '#5B8DEF'] as const;

export type BarItem = { label: string; value: number; sub?: string };

/** Single-series horizontal bars; tapping a row reveals its detail line. */
export function BarList({ items, unit = '', max }: { items: BarItem[]; unit?: string; max?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <View style={{ gap: 10 }}>
      {items.map((it, i) => (
        <Pressable key={`${it.label}${i}`} onPress={() => setActive(active === i ? null : i)} accessibilityLabel={`${it.label}: ${it.value}${unit}`}>
          <View style={styles.row}>
            <Text style={styles.label} numberOfLines={1}>
              {it.label}
            </Text>
            <Text style={styles.value}>
              {it.value}
              {unit}
            </Text>
          </View>
          <View style={styles.track}>
            <View style={[styles.bar, { width: `${Math.max(2, (it.value / top) * 100)}%`, backgroundColor: SERIES[0] }]} />
          </View>
          {active === i && it.sub ? <Text style={styles.sub}>{it.sub}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
}

/** Two-series grouped bars (e.g. received vs delivered) with legend + direct values. */
export function PairBars({ rows, labels }: { rows: { label: string; a: number; b: number }[]; labels: [string, string] }) {
  const top = Math.max(1, ...rows.flatMap((r) => [r.a, r.b]));
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.legend}>
        {labels.map((l, i) => (
          <View key={l} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: SERIES[i] }]} />
            <Text style={styles.legendText}>{l}</Text>
          </View>
        ))}
      </View>
      {rows.map((r) => (
        <View key={r.label} style={{ gap: 4 }}>
          <Text style={styles.label}>{r.label}</Text>
          {[r.a, r.b].map((v, i) => (
            <View key={i} style={styles.pairRow}>
              <View style={[styles.track, { flex: 1 }]}>
                <View style={[styles.bar, { width: `${Math.max(2, (v / top) * 100)}%`, backgroundColor: SERIES[i] }]} />
              </View>
              <Text style={[styles.value, { width: 36 }]}>{v}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

export function StatTile({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
  return (
    <View style={styles.tile}>
      <Text style={[styles.tileValue, accent ? { color: accent } : null]}>{value}</Text>
      <Text style={styles.tileLabel} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4, gap: 8 },
  label: { color: colors.text, fontSize: 13, flexShrink: 1 },
  value: { color: colors.white, fontSize: 13, fontWeight: '700', textAlign: 'right' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 4 },
  track: { height: 10, backgroundColor: 'rgba(155,168,184,0.12)', borderRadius: 4, overflow: 'hidden' },
  bar: { height: 10, borderRadius: 4 },
  pairRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legend: { flexDirection: 'row', gap: 16 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 12, height: 12, borderRadius: 3 },
  legendText: { color: colors.text, fontSize: 12 },
  tile: { flexGrow: 1, flexBasis: '30%', backgroundColor: 'rgba(16,30,48,0.92)', borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12, alignItems: 'center' },
  tileValue: { color: colors.white, fontSize: 24, fontWeight: '800' },
  tileLabel: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 2 },
});
