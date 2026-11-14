import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { Camera, KeyRound, LogOut, Trash2 } from 'lucide-react-native';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useFeedback } from '../../components/feedback';
import { LanguagePicker } from '../../components/LanguagePicker';
import { Avatar, Button, Card, Field, KV, Row, Screen, SectionTitle } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { uploadLabAsset } from '../../lib/files';
import { fmtDate } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { callFunction, errorCode, supabase, unwrap } from '../../lib/supabase';
import { colors } from '../../lib/theme';

/** Employee profile: photo, contact details, language, PIN change, logout. */
export default function Profile() {
  const { t, tx, locale } = useI18n();
  const router = useRouter();
  const { me, reloadMe, logout } = useAuth();
  const fb = useFeedback();
  const [phone, setPhone] = useState(me?.phone ?? '');
  const [email, setEmail] = useState(me?.email ?? '');
  const [pins, setPins] = useState({ current: '', next: '', confirm: '' });
  const [busy, setBusy] = useState<string | null>(null);
  if (!me) return null;

  const guard = async (key: string, fn: () => Promise<void>, ok = t('c.saved')) => {
    setBusy(key);
    try {
      await fn();
      fb.toast(ok);
    } catch (e) {
      fb.toast(tx('err', errorCode(e)), 'error');
    } finally {
      setBusy(null);
    }
  };

  const changePhoto = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.7 });
    if (res.canceled) return;
    const a = res.assets[0];
    await guard('photo', async () => {
      const path = await uploadLabAsset(me.lab_id, `avatars/${me.id}`, a.uri, a.mimeType ?? 'image/jpeg', a.file);
      unwrap(await supabase.rpc('update_my_profile', { p: { avatar_path: path } }));
      await reloadMe();
    });
  };

  return (
    <Screen back title={t('set.profile')}>
      <Card style={{ alignItems: 'center', gap: 8 }}>
        <Pressable onPress={changePhoto} accessibilityRole="button" accessibilityLabel={t('set.changePhoto')}>
          <Avatar name={me.full_name} path={me.avatar_path} size={96} />
          <View style={{ position: 'absolute', bottom: 0, end: 0, backgroundColor: colors.gold, borderRadius: 14, padding: 5 }}>
            <Camera color="#1A1206" size={16} />
          </View>
        </Pressable>
        <Text style={{ color: colors.white, fontSize: 22, fontWeight: '800' }}>{me.full_name}</Text>
        <Text style={{ color: colors.gold }}>
          {me.code} · {me.role.name}
        </Text>
        <Text style={{ color: colors.muted }}>{me.department?.name}</Text>
      </Card>
      <Card>
        <KV label={t('set.lab.code')} value={`${me.lab.name} (${me.lab.code})`} />
        <KV label={t('set.specialty')} value={me.specialty} />
        <KV label={t('set.lastLogin')} value={fmtDate(me.last_login_at, locale, true)} />
      </Card>
      <Card>
        <Field label={t('c.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <Field label={t('c.email')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
        <Button
          title={t('c.save')}
          loading={busy === 'info'}
          onPress={() => guard('info', async () => { unwrap(await supabase.rpc('update_my_profile', { p: { phone, email } })); await reloadMe(); })}
        />
      </Card>
      <Card>
        <Row>
          <Text style={{ color: colors.white, flex: 1, fontSize: 16 }}>{t('set.language')}</Text>
          <LanguagePicker persistToProfile />
        </Row>
      </Card>
      <Card>
        <SectionTitle icon={<KeyRound color={colors.gold} size={20} />}>{t('set.changePin')}</SectionTitle>
        <Field label={t('set.currentPin')} value={pins.current} onChangeText={(v) => setPins((p) => ({ ...p, current: v.replace(/\D/g, '') }))} keyboardType="number-pad" maxLength={8} secure />
        <Field label={`${t('set.newPin')} · ${t('auth.pinRule')}`} value={pins.next} onChangeText={(v) => setPins((p) => ({ ...p, next: v.replace(/\D/g, '') }))} keyboardType="number-pad" maxLength={8} secure />
        <Field
          label={t('auth.pinConfirm')}
          value={pins.confirm}
          onChangeText={(v) => setPins((p) => ({ ...p, confirm: v.replace(/\D/g, '') }))}
          keyboardType="number-pad"
          maxLength={8}
          secure
          error={pins.confirm && pins.confirm !== pins.next ? t('auth.pinMismatch') : null}
        />
        <Button
          variant="outline"
          title={t('set.changePin')}
          loading={busy === 'pin'}
          disabled={pins.current.length < 4 || pins.next.length < 4 || pins.next !== pins.confirm}
          onPress={() =>
            guard('pin', async () => {
              await callFunction('manage-employee', { action: 'change_own_pin', current_pin: pins.current, new_pin: pins.next }, true);
              setPins({ current: '', next: '', confirm: '' });
            }, t('set.pinChanged'))
          }
        />
      </Card>
      <Card style={{ borderColor: colors.error }}>
        <SectionTitle icon={<Trash2 color={colors.error} size={20} />}>{t('set.dangerZone')}</SectionTitle>
        <Text style={{ color: colors.muted, marginBottom: 12 }}>{t('set.deleteAccountHint')}</Text>
        <Button
          variant="danger"
          title={t('set.deleteAccount')}
          loading={busy === 'delete'}
          onPress={async () => {
            const pin = await fb.prompt({ title: t('set.deleteAccount'), message: t('set.deleteAccountHint'), danger: true, confirmLabel: t('c.delete'), input: { label: t('auth.pin'), required: true, keyboard: 'number-pad', secure: true } });
            if (!pin) return;
            setBusy('delete');
            try {
              await callFunction('manage-employee', { action: 'delete_my_account', pin }, true);
              fb.toast(t('set.accountDeleted'));
              await logout();
              router.replace('/(auth)/lab');
            } catch (e) {
              fb.toast(tx('err', errorCode(e)), 'error');
            } finally {
              setBusy(null);
            }
          }}
        />
      </Card>
      <Button
        variant="danger"
        icon={<LogOut color={colors.white} size={18} />}
        title={t('c.logout')}
        onPress={async () => {
          await logout();
          router.replace('/(auth)/lab');
        }}
      />
    </Screen>
  );
}
