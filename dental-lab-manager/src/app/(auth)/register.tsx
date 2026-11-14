import { useRouter } from 'expo-router';
import { Building2, KeyRound, Lock, MapPin, Phone, User } from 'lucide-react-native';
import React, { useState } from 'react';
import { Text } from 'react-native';
import { LanguagePicker } from '../../components/LanguagePicker';
import { Button, Card, ErrorBanner, Field, Screen } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useI18n } from '../../lib/i18n';
import { errorCode } from '../../lib/supabase';
import { colors } from '../../lib/theme';

/** Register a new laboratory and its first administrator. */
export default function RegisterLab() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const { registerLab } = useAuth();
  const [f, setF] = useState({ code: '', name: '', phone: '', city: '', country: '', adminName: '', adminCode: 'ADMIN01', pin: '', pin2: '', key: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (v: string) => setF((s) => ({ ...s, [k]: v }));

  const pinMismatch = f.pin2.length > 0 && f.pin !== f.pin2;
  const valid = /^[A-Z0-9]{3,12}$/.test(f.code) && f.name.trim().length >= 2 && f.adminName.trim().length >= 2 && /^[0-9]{4,8}$/.test(f.pin) && f.pin === f.pin2;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await registerLab({
        lab: { code: f.code, name: f.name.trim(), phone: f.phone, city: f.city, country: f.country },
        admin: { full_name: f.adminName.trim(), code: f.adminCode, pin: f.pin, preferred_language: lang },
        registration_key: f.key || undefined,
      });
      router.replace('/(app)/(tabs)');
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back title={t('auth.registerLab')} subtitle={t('auth.registerHint')} right={<LanguagePicker />} contentStyle={{ maxWidth: 560 }}>
      <ErrorBanner code={error} />
      <Card>
        <Field label={t('auth.labCode')} required icon={<Building2 color={colors.gold} size={20} />} value={f.code} onChangeText={(v) => set('code')(v.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="LAB001" maxLength={12} autoCapitalize="characters" />
        <Field label={t('auth.labName')} required value={f.name} onChangeText={set('name')} />
        <Field label={t('c.phone')} icon={<Phone color={colors.gold} size={20} />} value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
        <Field label={t('c.city')} icon={<MapPin color={colors.gold} size={20} />} value={f.city} onChangeText={set('city')} />
        <Field label={t('c.country')} value={f.country} onChangeText={set('country')} />
      </Card>
      <Card>
        <Field label={t('auth.adminName')} required icon={<User color={colors.gold} size={20} />} value={f.adminName} onChangeText={set('adminName')} />
        <Field label={t('auth.adminCode')} required value={f.adminCode} onChangeText={(v) => set('adminCode')(v.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))} maxLength={16} autoCapitalize="characters" />
        <Field label={`${t('auth.pin')} · ${t('auth.pinRule')}`} required icon={<Lock color={colors.gold} size={20} />} value={f.pin} onChangeText={(v) => set('pin')(v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={8} secure />
        <Field label={t('auth.pinConfirm')} required value={f.pin2} onChangeText={(v) => set('pin2')(v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={8} secure error={pinMismatch ? t('auth.pinMismatch') : null} />
        <Field label={`${t('auth.registrationKey')} (${t('c.optional')})`} icon={<KeyRound color={colors.gold} size={20} />} value={f.key} onChangeText={set('key')} autoCapitalize="none" />
        <Text style={{ color: colors.muted, fontSize: 12, marginBottom: 12 }}>{t('auth.pinRule')}</Text>
        <Button title={t('auth.createLab')} onPress={submit} loading={busy} disabled={!valid} />
      </Card>
    </Screen>
  );
}
