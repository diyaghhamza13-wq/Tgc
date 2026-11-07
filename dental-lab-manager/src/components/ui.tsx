import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { ArrowLeft, ArrowRight, CircleAlert, Eye, EyeOff, Inbox } from 'lucide-react-native';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type TextInputProps,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '../lib/i18n';
import { publicAssetUrl } from '../lib/supabase';
import { colors, glow, goldGradient, radius } from '../lib/theme';
import { initials } from '../lib/format';
import { Image } from 'react-native';

type Children = { children?: React.ReactNode };

/** Root background with subtle gradient + golden wave accents. */
export function Backdrop({ children }: Children) {
  return (
    <LinearGradient colors={['#0C1A2B', '#050B15', '#03070E']} style={{ flex: 1, overflow: 'hidden' }}>
      <View pointerEvents="none" style={styles.waveA} />
      <View pointerEvents="none" style={styles.waveB} />
      {children}
    </LinearGradient>
  );
}

export function Screen({
  children,
  title,
  subtitle,
  back = false,
  right,
  scroll = true,
  refreshing,
  onRefresh,
  contentStyle,
  edges = ['top'],
}: Children & {
  title?: string;
  subtitle?: string;
  back?: boolean;
  right?: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: ViewStyle;
  edges?: ('top' | 'bottom')[];
}) {
  const router = useRouter();
  const { isRTL } = useI18n();
  const Arrow = isRTL ? ArrowRight : ArrowLeft;
  const header =
    title || back || right ? (
      <View style={styles.header}>
        {back ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
            style={styles.roundBtn}
            hitSlop={8}
          >
            <Arrow color={colors.gold} size={20} />
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }}>
          {title ? (
            <Text style={styles.headerTitle} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
          {subtitle ? <Text style={styles.headerSub}>{subtitle}</Text> : null}
        </View>
        {right}
      </View>
    ) : null;

  return (
    <Backdrop>
      <SafeAreaView style={{ flex: 1 }} edges={edges}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {header}
          {scroll ? (
            <ScrollView
              contentContainerStyle={[styles.content, contentStyle]}
              keyboardShouldPersistTaps="handled"
              refreshControl={
                onRefresh ? <RefreshControl tintColor={colors.gold} refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined
              }
            >
              {children}
            </ScrollView>
          ) : (
            <View style={[{ flex: 1 }, contentStyle]}>{children}</View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Backdrop>
  );
}

export function Card({ children, style, glowing = false, onPress }: Children & { style?: ViewStyle | ViewStyle[]; glowing?: boolean; onPress?: () => void }) {
  const inner = <View style={[styles.card, glowing && styles.cardGlow, style as ViewStyle]}>{children}</View>;
  if (!onPress) return inner;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })} accessibilityRole="button">
      {inner}
    </Pressable>
  );
}

export function SectionTitle({ children, right, icon }: Children & { right?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      {icon}
      <Text style={styles.sectionTitle}>{children}</Text>
      <View style={{ flex: 1 }} />
      {right}
    </View>
  );
}

type BtnVariant = 'gold' | 'outline' | 'ghost' | 'danger' | 'dark';
export function Button({
  title,
  onPress,
  variant = 'gold',
  icon,
  loading,
  disabled,
  style,
  small,
}: {
  title: string;
  onPress?: () => void;
  variant?: BtnVariant;
  icon?: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  small?: boolean;
}) {
  const isDisabled = disabled || loading;
  const textColor = variant === 'gold' ? '#1A1206' : variant === 'danger' ? colors.white : colors.gold;
  const content = (
    <View style={[styles.btnInner, small && { paddingVertical: 9, paddingHorizontal: 14 }]}>
      {loading ? <ActivityIndicator color={textColor} /> : icon}
      <Text style={[styles.btnText, { color: textColor }, small && { fontSize: 14 }]}>{title}</Text>
    </View>
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled }}
      onPress={isDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.btn,
        variant === 'outline' && styles.btnOutline,
        variant === 'ghost' && styles.btnGhost,
        variant === 'danger' && styles.btnDanger,
        variant === 'dark' && styles.btnDark,
        variant === 'gold' && !isDisabled && glow,
        { opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {variant === 'gold' ? (
        <LinearGradient colors={goldGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: radius.lg }}>
          {content}
        </LinearGradient>
      ) : (
        content
      )}
    </Pressable>
  );
}

export function Field({
  label,
  icon,
  error,
  secure,
  style,
  inputStyle,
  required,
  ...props
}: TextInputProps & { label?: string; icon?: React.ReactNode; error?: string | null; secure?: boolean; style?: ViewStyle; inputStyle?: TextStyle; required?: boolean }) {
  const [hidden, setHidden] = useState(true);
  const [focus, setFocus] = useState(false);
  const { isRTL } = useI18n();
  return (
    <View style={[{ marginBottom: 12 }, style]}>
      <View style={[styles.field, focus && styles.fieldFocus, !!error && { borderColor: colors.error }, props.multiline && { alignItems: 'flex-start' }]}>
        {icon ? <View style={styles.fieldIcon}>{icon}</View> : null}
        <View style={{ flex: 1 }}>
          {label ? (
            <Text style={styles.fieldLabel}>
              {label}
              {required ? <Text style={{ color: colors.error }}> *</Text> : null}
            </Text>
          ) : null}
          <TextInput
            placeholderTextColor={colors.faint}
            accessibilityLabel={label}
            {...props}
            secureTextEntry={secure ? hidden : props.secureTextEntry}
            onFocus={(e) => {
              setFocus(true);
              props.onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocus(false);
              props.onBlur?.(e);
            }}
            style={[styles.input, { textAlign: isRTL ? 'right' : 'left' }, props.multiline && { minHeight: 70, textAlignVertical: 'top' }, inputStyle]}
          />
        </View>
        {secure ? (
          <Pressable onPress={() => setHidden((h) => !h)} hitSlop={10} accessibilityRole="button">
            {hidden ? <EyeOff color={colors.muted} size={20} /> : <Eye color={colors.muted} size={20} />}
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

export function Chip({ label, selected, onPress, icon, color, style }: { label: string; selected?: boolean; onPress?: () => void; icon?: React.ReactNode; color?: string; style?: ViewStyle }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => [styles.chip, selected && styles.chipOn, selected && glow, { opacity: pressed ? 0.8 : 1 }, style]}
    >
      {icon}
      <Text style={[styles.chipText, selected && { color: '#1A1206' }, color && !selected ? { color } : null]} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

export function Badge({ label, color = colors.gold, solid = false }: { label: string; color?: string; solid?: boolean }) {
  return (
    <View style={[styles.badge, { borderColor: color, backgroundColor: solid ? color : `${color}22` }]}>
      <Text style={[styles.badgeText, { color: solid ? '#0B1726' : color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.gold} size="large" />
      {label ? <Text style={styles.muted}>{label}</Text> : null}
    </View>
  );
}

export function EmptyState({ title, icon }: { title: string; icon?: React.ReactNode }) {
  return (
    <View style={[styles.center, { paddingVertical: 36 }]}>
      {icon ?? <Inbox color={colors.faint} size={36} />}
      <Text style={[styles.muted, { marginTop: 10, textAlign: 'center' }]}>{title}</Text>
    </View>
  );
}

/** Inline error with translated message and optional retry. */
export function ErrorBanner({ code, onRetry }: { code: string | null | undefined; onRetry?: () => void }) {
  const { t, tx } = useI18n();
  if (!code) return null;
  return (
    <View style={styles.errorBanner}>
      <CircleAlert color={colors.error} size={18} />
      <Text style={{ color: colors.white, flex: 1 }}>{tx('err', code)}</Text>
      {onRetry ? (
        <Pressable onPress={onRetry} hitSlop={8}>
          <Text style={{ color: colors.gold, fontWeight: '700' }}>{t('c.retry')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Toggle({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <View style={styles.toggleRow}>
      <Text style={{ color: colors.text, flex: 1 }}>{label}</Text>
      {/* react-native-web positions the thumb physically; keep the control LTR */}
      <View style={Platform.OS === 'web' ? ({ direction: 'ltr' } as ViewStyle) : undefined}>
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          accessibilityLabel={label}
          trackColor={{ true: colors.gold, false: colors.border }}
          thumbColor={value ? colors.goldHi : colors.muted}
        />
      </View>
    </View>
  );
}

export function Avatar({ name, path, size = 44 }: { name?: string | null; path?: string | null; size?: number }) {
  const url = publicAssetUrl(path);
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      {url ? (
        <Image source={{ uri: url }} style={{ width: size - 4, height: size - 4, borderRadius: size / 2 }} />
      ) : (
        <Text style={{ color: colors.gold, fontWeight: '800', fontSize: size * 0.36 }}>{initials(name)}</Text>
      )}
    </View>
  );
}

export function KV({ label, value, icon }: { label: string; value?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <View style={styles.kv}>
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={styles.kvLabel}>{label}</Text>
        {typeof value === 'string' || typeof value === 'number' || value == null ? (
          <Text style={styles.kvValue}>{value ?? '—'}</Text>
        ) : (
          value
        )}
      </View>
    </View>
  );
}

export function Divider() {
  return <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 12 }} />;
}

export function Row({ children, style, gap = 10 }: Children & { style?: ViewStyle; gap?: number }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export const T = {
  h1: { color: colors.white, fontSize: 24, fontWeight: '800' } as TextStyle,
  h2: { color: colors.white, fontSize: 18, fontWeight: '700' } as TextStyle,
  body: { color: colors.text, fontSize: 15 } as TextStyle,
  muted: { color: colors.muted, fontSize: 13 } as TextStyle,
  gold: { color: colors.gold, fontWeight: '700' } as TextStyle,
};

const styles = StyleSheet.create({
  waveA: { position: 'absolute', width: 600, height: 600, borderRadius: 300, borderWidth: 1, borderColor: 'rgba(214,173,85,0.10)', bottom: -420, left: -160 },
  waveB: { position: 'absolute', width: 420, height: 420, borderRadius: 210, borderWidth: 1, borderColor: 'rgba(214,173,85,0.07)', top: -260, right: -140 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
  headerTitle: { color: colors.white, fontSize: 20, fontWeight: '800', textAlign: 'center' },
  headerSub: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 2 },
  roundBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: colors.gold, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, paddingBottom: 120, gap: 14, width: '100%', maxWidth: 820, alignSelf: 'center' },
  card: { backgroundColor: 'rgba(16,30,48,0.92)', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: 16 },
  cardGlow: { borderColor: colors.gold, ...glow },
  sectionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  sectionTitle: { color: colors.gold, fontSize: 17, fontWeight: '800' },
  btn: { borderRadius: radius.lg, overflow: Platform.OS === 'web' ? 'visible' : 'hidden' },
  btnInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 14, paddingHorizontal: 20 },
  btnText: { fontSize: 16, fontWeight: '800' },
  btnOutline: { borderWidth: 1, borderColor: colors.gold, backgroundColor: 'rgba(214,173,85,0.06)' },
  btnGhost: { backgroundColor: 'transparent' },
  btnDanger: { backgroundColor: '#7F1D1D', borderWidth: 1, borderColor: colors.error },
  btnDark: { backgroundColor: colors.bg2, borderWidth: 1, borderColor: colors.border },
  field: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'rgba(11,23,38,0.9)', borderWidth: 1, borderColor: colors.borderHi, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 8, minHeight: 56 },
  fieldFocus: { borderColor: colors.gold },
  fieldIcon: { width: 26, alignItems: 'center' },
  fieldLabel: { color: colors.muted, fontSize: 12, marginBottom: 2 },
  input: { color: colors.white, fontSize: 17, paddingVertical: Platform.OS === 'web' ? 4 : 2, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) },
  errorText: { color: colors.error, fontSize: 12, marginTop: 4, marginHorizontal: 4 },
  chip: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderHi, backgroundColor: 'rgba(11,23,38,0.85)' },
  chipOn: { backgroundColor: colors.gold, borderColor: colors.goldHi },
  chipText: { color: colors.text, fontWeight: '600', fontSize: 14, textAlign: 'center' },
  badge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' },
  badgeText: { fontSize: 12, fontWeight: '700' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 },
  muted: { color: colors.muted },
  errorBanner: { flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderRadius: radius.md, backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.5)' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 },
  avatar: { borderWidth: 2, borderColor: colors.gold, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg2 },
  kv: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 8 },
  kvLabel: { color: colors.muted, fontSize: 12 },
  kvValue: { color: colors.white, fontSize: 16, fontWeight: '600', marginTop: 2 },
});
