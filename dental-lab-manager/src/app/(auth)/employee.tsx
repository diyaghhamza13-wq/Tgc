import { Redirect, useRouter } from 'expo-router';
import { Building2, Lock, LogIn, User, Users } from 'lucide-react-native';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { DepartmentIcon } from '../../components/DepartmentIcon';
import { Button, Field, Screen } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { ApiError, errorCode } from '../../lib/supabase';
import { colors, glow, radius } from '../../lib/theme';

/** Login step 2 — employee identification. */
export default function EmployeeLogin() {
  const { t, tx } = useI18n();
  const router = useRouter();
  const { loginLab, login } = useAuth();
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loginLab) return <Redirect href="/(auth)/lab" />;

  const submit = async () => {
    if (!code || !pin) return;
    setBusy(true);
    setError(null);
    try {
      await login(loginLab.code, code, pin);
      router.replace('/(app)/(tabs)');
    } catch (e) {
      const c = errorCode(e);
      const left = e instanceof ApiError ? (e.extra.attempts_left as number | undefined) : undefined;
      setError(tx('err', c) + (c === 'invalid_credentials' && left !== undefined ? ` · ${t('auth.attemptsLeft', { n: left })}` : ''));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      back
      right={
        <View style={styles.labTag}>
          <Building2 color={colors.gold} size={30} strokeWidth={1.5} />
          <View>
            <Text style={styles.labCode}>{loginLab.code}</Text>
            <Text style={styles.labName} numberOfLines={1}>
              {loginLab.name}
            </Text>
          </View>
        </View>
      }
      contentStyle={{ maxWidth: 560 }}
    >
      <View style={styles.goldLine} />
      <View style={{ alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Users color={colors.gold} size={40} strokeWidth={1.5} />
        <Text style={styles.title}>{t('auth.employeeIdentity')}</Text>
        <Text style={styles.hint}>{t('auth.employeeHint')}</Text>
      </View>
      <Field
        label={t('auth.employeeCode')}
        icon={<User color={colors.white} size={24} strokeWidth={1.5} />}
        value={code}
        onChangeText={(v) => setCode(v.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))}
        placeholder="CAD01"
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={16}
      />
      <Field
        label={t('auth.pin')}
        icon={<Lock color={colors.white} size={24} strokeWidth={1.5} />}
        value={pin}
        onChangeText={(v) => setPin(v.replace(/\D/g, ''))}
        keyboardType="number-pad"
        maxLength={8}
        secure
        returnKeyType="go"
        onSubmitEditing={submit}
        error={error}
      />
      <Button title={t('auth.login')} icon={<LogIn color="#1A1206" size={22} />} onPress={submit} loading={busy} disabled={!code || pin.length < 4} />

      {loginLab.employees.length > 0 ? (
        <>
          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>{t('auth.orPick')}</Text>
            <View style={styles.orLine} />
          </View>
          <View style={styles.grid}>
            {loginLab.employees.map((e) => {
              const on = e.code === code;
              return (
                <Pressable key={e.code} onPress={() => setCode(e.code)} style={[styles.tile, on && styles.tileOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
                  <DepartmentIcon code={e.department_code} size={34} />
                  <Text style={styles.tileName} numberOfLines={1}>
                    {e.department_name ?? e.role_name}
                  </Text>
                  <Text style={styles.tileSub} numberOfLines={1}>
                    {e.full_name}
                  </Text>
                  <Text style={styles.tileCode}>{e.code}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  labTag: { flexDirection: 'row', alignItems: 'center', gap: 10, maxWidth: 220 },
  labCode: { color: colors.white, fontSize: 18, fontWeight: '800' },
  labName: { color: colors.gold, fontSize: 14 },
  goldLine: { height: 2, backgroundColor: colors.gold, opacity: 0.6, marginHorizontal: 40, borderRadius: 1, marginTop: -6, marginBottom: 6 },
  title: { color: colors.white, fontSize: 28, fontWeight: '800' },
  hint: { color: colors.muted, fontSize: 16, marginBottom: 10 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 8 },
  orLine: { flex: 1, height: 1, backgroundColor: colors.border },
  orText: { color: colors.muted, fontSize: 15 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' },
  tile: { width: '31%', minWidth: 104, alignItems: 'center', gap: 4, paddingVertical: 16, paddingHorizontal: 6, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(16,30,48,0.9)' },
  tileOn: { borderColor: colors.goldHi, borderWidth: 2, ...glow },
  tileName: { color: colors.white, fontWeight: '800', fontSize: 14, marginTop: 4 },
  tileSub: { color: colors.muted, fontSize: 11 },
  tileCode: { color: colors.gold, fontSize: 13, fontWeight: '600' },
});
