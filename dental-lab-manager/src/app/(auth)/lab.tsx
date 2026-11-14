import { useRouter } from 'expo-router';
import { Building2, LogIn } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Brand } from '../../components/brand';
import { LanguagePicker } from '../../components/LanguagePicker';
import { Button, Card, ErrorBanner, Field, Screen } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { errorCode, isConfigured } from '../../lib/supabase';
import { colors } from '../../lib/theme';

/** Login step 1 — laboratory access. */
export default function LabAccess() {
  const { t, tx } = useI18n();
  const router = useRouter();
  const { lookupLab, lastLabCode } = useAuth();
  const [code, setCode] = useState(lastLabCode ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (lastLabCode) setCode((c) => c || lastLabCode);
  }, [lastLabCode]);

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const lab = await lookupLab(code);
      if (!lab) setError('lab_not_found');
      else router.push('/(auth)/employee');
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen contentStyle={{ paddingTop: 8, maxWidth: 520 }}>
      <View style={{ alignItems: 'flex-end' }}>
        <LanguagePicker />
      </View>
      <View style={{ alignItems: 'center', marginVertical: 26 }}>
        <Brand />
      </View>
      {!isConfigured ? <ErrorBanner code="not_configured" /> : null}
      <Card glowing style={{ padding: 22 }}>
        <Text style={styles.title}>{t('auth.labAccess')}</Text>
        <Text style={styles.hint}>{t('auth.labAccessHint')}</Text>
        <Field
          label={t('auth.labCode')}
          icon={<Building2 color={colors.gold} size={22} />}
          value={code}
          onChangeText={(v) => setCode(v.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          placeholder="LAB001"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={12}
          returnKeyType="go"
          onSubmitEditing={submit}
          error={error === 'lab_not_found' ? t('auth.labNotFound') : error ? tx('err', error) : null}
        />
        <Button title={t('c.continue')} icon={<LogIn color="#1A1206" size={20} />} onPress={submit} loading={busy} disabled={!code.trim()} />
      </Card>
      <Pressable onPress={() => router.push('/(auth)/register')} style={{ alignSelf: 'center', padding: 12 }} accessibilityRole="link">
        <Text style={{ color: colors.gold, fontWeight: '700' }}>{t('auth.registerLab')}</Text>
      </Pressable>
      <Pressable onPress={() => router.push('/about')} style={{ alignSelf: 'center', padding: 8 }} accessibilityRole="link">
        <Text style={{ color: colors.muted, fontSize: 13 }}>{t('set.aboutDev')}</Text>
      </Pressable>
      <Pressable onPress={() => router.push('/privacy')} style={{ alignSelf: 'center', padding: 4 }} accessibilityRole="link">
        <Text style={{ color: colors.faint, fontSize: 12 }}>{t('set.privacy')}</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.white, fontSize: 26, fontWeight: '800', textAlign: 'center' },
  hint: { color: colors.muted, fontSize: 15, textAlign: 'center', marginTop: 6, marginBottom: 20 },
});
