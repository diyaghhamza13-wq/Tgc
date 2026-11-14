import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop, G, Circle } from 'react-native-svg';
import { useI18n } from '../lib/i18n';
import { colors } from '../lib/theme';

const TOOTH_PATH =
  'M12 2.6c-1.5-.9-3.3-1.2-4.8-.7C4.6 2.7 3.2 5.2 3.4 8c.2 2.2 1 3.7 1.6 5.4.6 1.8.8 3.6 1.2 5.4.3 1.4.7 3.1 2 3.1 1.5 0 1.6-2.2 1.8-3.4.2-1.3.5-3.2 2-3.2s1.8 1.9 2 3.2c.2 1.2.3 3.4 1.8 3.4 1.3 0 1.7-1.7 2-3.1.4-1.8.6-3.6 1.2-5.4.6-1.7 1.4-3.2 1.6-5.4.2-2.8-1.2-5.3-3.8-6.1-1.5-.5-3.3-.2-4.8.7z';

/** Outline tooth icon matching lucide's stroke style. */
export function ToothIcon({ size = 22, color = colors.gold, strokeWidth = 1.8, filled = false }: { size?: number; color?: string; strokeWidth?: number; filled?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={TOOTH_PATH} stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" fill={filled ? color : 'none'} />
    </Svg>
  );
}

/** Implant fixture icon (used for implant positions on the chart). */
export function ImplantIcon({ size = 16, color = colors.gold }: { size?: number; color?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M7 3h10v3H7zM9 6h6v2H9z" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
      <Path d="M8 9h8l-1 2H9zM8.5 12h7l-1 2h-5zM9 15h6l-1 2h-4zM10 18h4l-2 3z" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </Svg>
  );
}

/** Gold gradient tooth logo. */
export function LogoMark({ size = 64 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Defs>
        <LinearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#FFE7A8" />
          <Stop offset="0.5" stopColor="#D6AD55" />
          <Stop offset="1" stopColor="#9C7228" />
        </LinearGradient>
      </Defs>
      <G>
        <Path d={TOOTH_PATH} fill="rgba(214,173,85,0.10)" stroke="url(#g)" strokeWidth={1.3} strokeLinejoin="round" />
        <Path d="M8 6.2c1.2-.6 2.6-.5 4 .5 1.4-1 2.8-1.1 4-.5" stroke="url(#g)" strokeWidth={0.9} fill="none" strokeLinecap="round" />
        <Circle cx="12" cy="11.5" r="0.9" fill="url(#g)" />
      </G>
    </Svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <View style={[styles.row, compact && { gap: 8 }]}>
      <LogoMark size={compact ? 34 : 72} />
      <View style={compact ? undefined : { alignItems: 'center' }}>
        <Text style={[styles.title, compact && { fontSize: 17 }]}>
          <Text style={{ color: colors.gold }}>Dental Lab </Text>
          <Text style={{ color: colors.white }}>Manager</Text>
        </Text>
        <Text style={[styles.sub, compact && { fontSize: 10 }]}>{t('app.subtitle')}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { alignItems: 'center', gap: 10 },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: 0.3, writingDirection: 'ltr' },
  sub: { color: colors.muted, fontSize: 14, marginTop: 2, letterSpacing: 0.4 },
});
