import React, { useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { useI18n } from '../lib/i18n';
import { colors, radius } from '../lib/theme';
import { LOWER_JAW, UPPER_JAW } from '../lib/types';
import { ImplantIcon } from './brand';

export type ToothState = { tooth_number: number; is_missing: boolean; is_implant: boolean; bridge_group: number | null };
export type ChartValue = Record<number, ToothState>;
export type ChartMode = 'select' | 'bridge' | 'missing' | 'implant';

const SHAPES = {
  molar: 'M3 7c0-3 2-5 5-5 1.6 0 2.4.8 4 .8S14.4 2 16 2c3 0 5 2 5 5 0 3.4-1.2 5.2-1.6 8-.4 2.6-.6 6.6-2.6 6.6-1.8 0-1.6-4-3-5.2-.5-.4-1.1-.4-1.6 0-1.4 1.2-1.2 5.2-3 5.2-2 0-2.2-4-2.6-6.6C4.2 12.2 3 10.4 3 7z',
  premolar: 'M6 7.5C6 4 8.4 2 12 2s6 2 6 5.5c0 3-1 4.8-1.4 7.4-.5 3.3-1.6 7.1-4.6 7.1s-4.1-3.8-4.6-7.1C7 12.3 6 10.5 6 7.5z',
  canine: 'M7 9c0-3.5 2.2-7 5-7s5 3.5 5 7c0 2.6-.9 4.6-1.4 7-.6 3-1.4 6-3.6 6s-3-3-3.6-6C7.9 13.6 7 11.6 7 9z',
  incisor: 'M7 4.5C7 3 8.2 2 12 2s5 1 5 2.5c0 3.8-.6 6.4-1.3 9.6C14.9 18 14 22 12 22s-2.9-4-3.7-7.9C7.6 10.9 7 8.3 7 4.5z',
};

function shapeFor(n: number) {
  const d = n % 10;
  if (d >= 6) return SHAPES.molar;
  if (d >= 4) return SHAPES.premolar;
  if (d === 3) return SHAPES.canine;
  return SHAPES.incisor;
}

/**
 * Re-establish bridge invariants after each change: a bridge is a run of
 * contiguous teeth in one jaw; non-contiguous parts are split into separate
 * groups and group numbers are compacted.
 */
export function normalizeBridges(value: ChartValue, keepSingletons = true): ChartValue {
  const next: ChartValue = {};
  for (const k of Object.keys(value)) next[+k] = { ...value[+k] };
  let g = 0;
  for (const jaw of [UPPER_JAW, LOWER_JAW]) {
    let run: number[] = [];
    let runGroup: number | null = null;
    const flush = () => {
      if (run.length && (run.length > 1 || keepSingletons)) {
        g += 1;
        for (const n of run) next[n].bridge_group = g;
      } else for (const n of run) next[n].bridge_group = null;
      run = [];
      runGroup = null;
    };
    for (const n of jaw) {
      const grp = next[n]?.bridge_group ?? null;
      if (grp != null && (runGroup === null || grp === runGroup)) {
        run.push(n);
        runGroup = grp;
      } else {
        flush();
        if (grp != null) {
          run = [n];
          runGroup = grp;
        }
      }
    }
    flush();
  }
  return next;
}

function neighbors(n: number): number[] {
  for (const jaw of [UPPER_JAW, LOWER_JAW]) {
    const i = jaw.indexOf(n);
    if (i >= 0) return [jaw[i - 1], jaw[i + 1]].filter((x): x is number => x !== undefined);
  }
  return [];
}

export function applyTap(value: ChartValue, n: number, mode: ChartMode): ChartValue {
  const next: ChartValue = { ...value };
  const cur = next[n];
  const base: ToothState = cur ?? { tooth_number: n, is_missing: false, is_implant: false, bridge_group: null };
  if (mode === 'select') {
    if (cur) delete next[n];
    else next[n] = base;
  } else if (mode === 'missing') {
    next[n] = { ...base, is_missing: !base.is_missing, is_implant: base.is_missing ? base.is_implant : false };
  } else if (mode === 'implant') {
    next[n] = { ...base, is_implant: !base.is_implant, is_missing: false };
  } else if (mode === 'bridge') {
    if (cur?.bridge_group != null) {
      next[n] = { ...base, bridge_group: null };
    } else {
      const groups = neighbors(n)
        .map((x) => next[x]?.bridge_group)
        .filter((x): x is number => x != null);
      const maxG = Math.max(0, ...Object.values(next).map((t) => t.bridge_group ?? 0));
      const target = groups[0] ?? maxG + 1;
      next[n] = { ...base, bridge_group: target };
      // joining two bridges merges them
      if (groups[1] != null && groups[1] !== target) {
        for (const k of Object.keys(next)) if (next[+k].bridge_group === groups[1]) next[+k] = { ...next[+k], bridge_group: target };
      }
    }
  }
  return normalizeBridges(next);
}

function Tooth({ n, state, w, onPress, disabled }: { n: number; state?: ToothState; w: number; onPress?: () => void; disabled?: boolean }) {
  const selected = !!state;
  const missing = !!state?.is_missing;
  const implant = !!state?.is_implant;
  const h = w * 1.25;
  const gid = `t${n}`;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`Tooth ${n}`}
      accessibilityState={{ selected }}
      style={{ width: w, alignItems: 'center' }}
    >
      <View style={selected && !missing ? styles.toothGlow : undefined}>
        <Svg width={w} height={h} viewBox="0 0 24 24">
          <Defs>
            <LinearGradient id={`${gid}w`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#FFFFFF" />
              <Stop offset="1" stopColor="#B8C0CB" />
            </LinearGradient>
            <LinearGradient id={`${gid}g`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#FFE7A0" />
              <Stop offset="1" stopColor="#C89A3C" />
            </LinearGradient>
          </Defs>
          <Path
            d={shapeFor(n)}
            fill={missing ? 'none' : selected ? `url(#${gid}g)` : `url(#${gid}w)`}
            stroke={missing ? (selected ? colors.gold : colors.faint) : selected ? colors.goldHi : '#8A95A5'}
            strokeWidth={missing ? 1.4 : 0.8}
            strokeDasharray={missing ? '2.2 1.6' : undefined}
          />
        </Svg>
      </View>
      <View style={{ height: 14, justifyContent: 'center' }}>{implant ? <ImplantIcon size={14} color={colors.goldHi} /> : null}</View>
      <View style={[styles.num, selected && styles.numOn]}>
        <Text style={[styles.numText, selected && { color: colors.goldHi }]} allowFontScaling={false}>
          {n}
        </Text>
      </View>
    </Pressable>
  );
}

function Jaw({ teeth, value, onTap, cellW, gap, rowDir, readOnly }: { teeth: number[]; value: ChartValue; onTap: (n: number) => void; cellW: number; gap: number; rowDir: 'row' | 'row-reverse'; readOnly?: boolean }) {
  const items: React.ReactNode[] = [];
  teeth.forEach((n, i) => {
    const s = value[n];
    const nextN = teeth[i + 1];
    const prevN = teeth[i - 1];
    const linkNext = s?.bridge_group != null && nextN !== undefined && value[nextN]?.bridge_group === s.bridge_group;
    const linkPrev = s?.bridge_group != null && prevN !== undefined && value[prevN]?.bridge_group === s.bridge_group;
    items.push(
      <View key={n} style={{ width: cellW }}>
        {/* bridge bar behind the crown */}
        <View pointerEvents="none" style={[styles.barRow, { flexDirection: rowDir, top: cellW * 0.42 }]}>
          <View style={[styles.bar, { opacity: linkPrev ? 1 : 0 }]} />
          <View style={[styles.bar, { opacity: linkNext ? 1 : 0 }]} />
        </View>
        {s?.bridge_group != null ? <View pointerEvents="none" style={[styles.dot, { top: cellW * 0.42 - 3, left: cellW / 2 - 4 }]} /> : null}
        <Tooth n={n} state={s} w={cellW} onPress={readOnly ? undefined : () => onTap(n)} disabled={readOnly} />
      </View>,
    );
    if (i < teeth.length - 1) {
      items.push(
        <View key={`c${n}`} style={{ width: gap }}>
          <View style={[styles.bar, { position: 'absolute', top: cellW * 0.42, width: gap, opacity: linkNext ? 1 : 0 }]} />
        </View>,
      );
    }
  });
  return <View style={{ flexDirection: rowDir, alignSelf: 'center' }}>{items}</View>;
}

export function ToothChart({ value, onChange, mode = 'select', readOnly = false }: { value: ChartValue; onChange?: (v: ChartValue) => void; mode?: ChartMode; readOnly?: boolean }) {
  const { t, isRTL } = useI18n();
  const [width, setWidth] = useState(340);
  const gap = width < 400 ? 1 : 3;
  const cellW = Math.min(44, Math.floor((width - 16 - gap * 15) / 16));
  // FDI charts are always drawn from the viewer's perspective (18 … 28),
  // regardless of the interface direction.
  const rowDir = isRTL ? 'row-reverse' : 'row';
  const onTap = (n: number) => onChange?.(applyTap(value, n, mode));
  return (
    <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
      <View style={styles.jawBox}>
        <View style={styles.jawLabel}>
          <Text style={styles.jawLabelText}>{t('wiz.maxilla')}</Text>
        </View>
        <Jaw teeth={UPPER_JAW} value={value} onTap={onTap} cellW={cellW} gap={gap} rowDir={rowDir} readOnly={readOnly} />
      </View>
      <View style={[styles.jawBox, { marginTop: 10 }]}>
        <View style={styles.jawLabel}>
          <Text style={styles.jawLabelText}>{t('wiz.mandible')}</Text>
        </View>
        <Jaw teeth={LOWER_JAW} value={value} onTap={onTap} cellW={cellW} gap={gap} rowDir={rowDir} readOnly={readOnly} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  jawBox: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingTop: 22, paddingBottom: 10, backgroundColor: 'rgba(5,11,21,0.55)' },
  jawLabel: { position: 'absolute', top: -12, alignSelf: 'center', backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.borderHi, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 3 },
  jawLabelText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  num: { borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingVertical: 1, minWidth: '86%', alignItems: 'center' },
  numOn: { borderColor: colors.gold, backgroundColor: 'rgba(214,173,85,0.12)' },
  numText: { color: colors.white, fontSize: 11, fontWeight: '700' },
  toothGlow: { shadowColor: colors.goldHi, shadowOpacity: 0.8, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
  barRow: { position: 'absolute', left: 0, right: 0, height: 4, zIndex: 2 },
  bar: { flex: 1, height: 4, backgroundColor: '#5B8DEF', borderRadius: 2 },
  dot: { position: 'absolute', width: 8, height: 8, borderRadius: 4, backgroundColor: '#DCE7FF', borderWidth: 1.5, borderColor: '#5B8DEF', zIndex: 3 },
});
