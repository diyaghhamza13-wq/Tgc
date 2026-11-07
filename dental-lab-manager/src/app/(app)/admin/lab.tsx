import * as ImagePicker from 'expo-image-picker';
import { Building2, Camera } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';
import { useFeedback } from '../../../components/feedback';
import { Button, Card, Field, KV, Screen, SectionTitle, Toggle } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { uploadLabAsset } from '../../../lib/files';
import { useI18n } from '../../../lib/i18n';
import { errorCode, publicAssetUrl, supabase, unwrap } from '../../../lib/supabase';
import { colors, radius } from '../../../lib/theme';

/** Laboratory profile + notification / workflow settings. */
export default function LabSettings() {
  const { t, tx } = useI18n();
  const { me, reloadMe, can } = useAuth();
  const fb = useFeedback();
  const lab = me?.lab;
  const [f, setF] = useState({ name: '', phone: '', email: '', address: '', city: '', country: '' });
  const [s, setS] = useState({ show_employee_list: true, auto_complete_reception: true, deadline_warning_hours: '24' });
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!lab) return;
    setF({ name: lab.name, phone: lab.phone ?? '', email: lab.email ?? '', address: lab.address ?? '', city: lab.city ?? '', country: lab.country ?? '' });
    setS({
      show_employee_list: lab.settings.show_employee_list !== false,
      auto_complete_reception: lab.settings.auto_complete_reception !== false,
      deadline_warning_hours: String(lab.settings.deadline_warning_hours ?? 24),
    });
  }, [lab]);
  if (!me || !lab) return null;

  const guard = async (key: string, fn: () => Promise<unknown>, msg = t('c.saved')) => {
    setBusy(key);
    try {
      await fn();
      fb.toast(msg);
      await reloadMe();
    } catch (e) {
      fb.toast(tx('err', errorCode(e)), 'error');
    } finally {
      setBusy(null);
    }
  };
  const update = (patch: Record<string, unknown>) => async () => unwrap(await supabase.from('laboratories').update(patch).eq('id', lab.id).select('id'));
  const logo = publicAssetUrl(lab.logo_path);

  return (
    <Screen back title={t('set.lab')}>
      <Card style={{ alignItems: 'center', gap: 10 }}>
        <Pressable
          disabled={!can('lab.settings')}
          accessibilityLabel={t('set.logo')}
          onPress={async () => {
            const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
            if (res.canceled) return;
            const a = res.assets[0];
            guard('logo', async () => {
              const path = await uploadLabAsset(lab.id, 'logo', a.uri, a.mimeType ?? 'image/png', a.file);
              await update({ logo_path: path })();
            });
          }}
          style={{ width: 96, height: 96, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.gold, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
        >
          {logo ? <Image source={{ uri: logo }} style={{ width: 94, height: 94 }} resizeMode="contain" /> : <Building2 color={colors.gold} size={44} strokeWidth={1.4} />}
          <View style={{ position: 'absolute', bottom: 4, end: 4, backgroundColor: colors.gold, borderRadius: 12, padding: 4 }}>
            <Camera color="#1A1206" size={14} />
          </View>
        </Pressable>
        <KV label={t('set.lab.code')} value={lab.code} />
      </Card>
      <Card>
        <Field label={t('auth.labName')} required value={f.name} onChangeText={(v) => setF((x) => ({ ...x, name: v }))} />
        <Field label={t('c.phone')} value={f.phone} onChangeText={(v) => setF((x) => ({ ...x, phone: v }))} keyboardType="phone-pad" />
        <Field label={t('c.email')} value={f.email} onChangeText={(v) => setF((x) => ({ ...x, email: v }))} keyboardType="email-address" autoCapitalize="none" />
        <Field label={t('c.address')} value={f.address} onChangeText={(v) => setF((x) => ({ ...x, address: v }))} />
        <Field label={t('c.city')} value={f.city} onChangeText={(v) => setF((x) => ({ ...x, city: v }))} />
        <Field label={t('c.country')} value={f.country} onChangeText={(v) => setF((x) => ({ ...x, country: v }))} />
        <Button title={t('c.save')} loading={busy === 'info'} disabled={f.name.trim().length < 2} onPress={() => guard('info', update({ ...f, name: f.name.trim() }))} />
      </Card>
      <Card>
        <SectionTitle>{t('set.notifications')}</SectionTitle>
        <Toggle label={t('set.showEmployeeList')} value={s.show_employee_list} onChange={(v) => setS((x) => ({ ...x, show_employee_list: v }))} />
        <Toggle label={t('set.autoReception')} value={s.auto_complete_reception} onChange={(v) => setS((x) => ({ ...x, auto_complete_reception: v }))} />
        <Field label={t('set.deadlineHours')} value={s.deadline_warning_hours} onChangeText={(v) => setS((x) => ({ ...x, deadline_warning_hours: v.replace(/\D/g, '') }))} keyboardType="number-pad" maxLength={3} />
        <Button
          title={t('c.save')}
          loading={busy === 'settings'}
          onPress={() =>
            guard('settings', update({ settings: { ...lab.settings, show_employee_list: s.show_employee_list, auto_complete_reception: s.auto_complete_reception, deadline_warning_hours: Number(s.deadline_warning_hours) || 24 } }))
          }
        />
        <Button
          style={{ marginTop: 10 }}
          variant="outline"
          title={t('set.deadlineScan')}
          loading={busy === 'scan'}
          onPress={async () => {
            setBusy('scan');
            const { data, error } = await supabase.rpc('check_deadlines');
            setBusy(null);
            if (error) fb.toast(tx('err', errorCode(error)), 'error');
            else fb.toast(t('set.scanDone', { n: Number(data) }));
          }}
        />
        <Text style={{ color: colors.muted, fontSize: 12, marginTop: 8 }}>pg_cron · hourly</Text>
      </Card>
    </Screen>
  );
}
