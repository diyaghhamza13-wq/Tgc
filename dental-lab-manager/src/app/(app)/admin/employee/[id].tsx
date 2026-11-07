import { useLocalSearchParams, useRouter } from 'expo-router';
import { KeyRound } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useFeedback } from '../../../../components/feedback';
import { Select } from '../../../../components/pickers';
import { Button, Card, ErrorBanner, Field, Loading, Screen, SectionTitle, Toggle } from '../../../../components/ui';
import { useAuth } from '../../../../lib/auth';
import { useI18n } from '../../../../lib/i18n';
import { fetchDepartments, fetchRoles } from '../../../../lib/queries';
import { callFunction, errorCode, supabase, unwrap } from '../../../../lib/supabase';
import { colors } from '../../../../lib/theme';
import type { Employee } from '../../../../lib/types';
import { useAsync } from '../../../../lib/useAsync';

/** Create an employee (edge function, sets the PIN) or edit one. */
export default function EmployeeEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const { t, tx } = useI18n();
  const router = useRouter();
  const { me, reloadMe } = useAuth();
  const fb = useFeedback();
  const { data, error, reload } = useAsync(async () => {
    const [departments, roles, emp] = await Promise.all([
      fetchDepartments(),
      fetchRoles(),
      isNew ? Promise.resolve(null) : supabase.from('employees').select('*').eq('id', id).single().then((r) => unwrap(r) as Employee),
    ]);
    return { departments, roles, emp };
  }, [id]);
  const [f, setF] = useState({ full_name: '', code: '', department_id: null as string | null, role_id: null as string | null, specialty: '', phone: '', email: '', status: 'active', pin: '' });
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const e = data?.emp;
    if (e) setF({ full_name: e.full_name, code: e.code, department_id: e.department_id, role_id: e.role_id, specialty: e.specialty ?? '', phone: e.phone ?? '', email: e.email ?? '', status: e.status, pin: '' });
  }, [data?.emp]);
  if (!data) return <Screen back title={t('set.employees')}>{error ? <ErrorBanner code={error} onRetry={reload} /> : <Loading />}</Screen>;

  const guard = async (key: string, fn: () => Promise<unknown>, msg = t('c.saved')) => {
    setBusy(key);
    try {
      await fn();
      fb.toast(msg);
      return true;
    } catch (e) {
      fb.toast(tx('err', errorCode(e)), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const ok = await guard('save', async () => {
      if (isNew) {
        await callFunction('manage-employee', { action: 'create', employee: { ...f, specialty: f.specialty || null } }, true);
      } else {
        unwrap(
          await supabase
            .from('employees')
            .update({ full_name: f.full_name.trim(), department_id: f.department_id, role_id: f.role_id, specialty: f.specialty || null, phone: f.phone || null, email: f.email || null, status: f.status })
            .eq('id', id)
            .select('id'),
        );
        if (id === me?.id) await reloadMe();
      }
    });
    if (ok) router.back();
  };

  const valid = f.full_name.trim().length >= 2 && /^[A-Z0-9_-]{2,16}$/.test(f.code) && !!f.role_id && (!isNew || /^[0-9]{4,8}$/.test(f.pin));
  return (
    <Screen back title={isNew ? t('set.newEmployee') : f.full_name} subtitle={isNew ? undefined : f.code}>
      <Card>
        <Field label={t('c.name')} required value={f.full_name} onChangeText={(v) => setF((x) => ({ ...x, full_name: v }))} />
        <Field label={t('auth.employeeCode')} required value={f.code} editable={isNew} onChangeText={(v) => setF((x) => ({ ...x, code: v.toUpperCase().replace(/[^A-Z0-9_-]/g, '') }))} maxLength={16} autoCapitalize="characters" />
        <Select label={t('set.department')} value={f.department_id} allowClear onChange={(v) => setF((x) => ({ ...x, department_id: v }))} options={data.departments.filter((d) => d.is_active || d.id === f.department_id).map((d) => ({ value: d.id, label: d.name }))} />
        <Select label={t('set.role')} required value={f.role_id} onChange={(v) => setF((x) => ({ ...x, role_id: v }))} options={data.roles.map((r) => ({ value: r.id, label: r.name, hint: r.description ?? undefined }))} />
        <Field label={t('set.specialty')} value={f.specialty} onChangeText={(v) => setF((x) => ({ ...x, specialty: v }))} />
        <Field label={t('c.phone')} value={f.phone} onChangeText={(v) => setF((x) => ({ ...x, phone: v }))} keyboardType="phone-pad" />
        <Field label={t('c.email')} value={f.email} onChangeText={(v) => setF((x) => ({ ...x, email: v }))} keyboardType="email-address" autoCapitalize="none" />
        {isNew ? (
          <Field label={`${t('auth.pin')} · ${t('auth.pinRule')}`} required value={f.pin} onChangeText={(v) => setF((x) => ({ ...x, pin: v.replace(/\D/g, '') }))} keyboardType="number-pad" maxLength={8} secure />
        ) : (
          <Toggle label={t('c.active')} value={f.status === 'active'} onChange={(v) => setF((x) => ({ ...x, status: v ? 'active' : 'inactive' }))} />
        )}
        <Button title={t('c.save')} loading={busy === 'save'} disabled={!valid} onPress={save} />
      </Card>
      {!isNew ? (
        <Card>
          <SectionTitle icon={<KeyRound color={colors.gold} size={20} />}>{t('set.resetPin')}</SectionTitle>
          <Text style={{ color: colors.muted, marginBottom: 10 }}>{t('auth.pinRule')}</Text>
          <Button
            variant="outline"
            title={t('set.resetPin')}
            loading={busy === 'pin'}
            onPress={async () => {
              const pin = await fb.prompt({ title: t('set.resetPin'), message: f.full_name, input: { label: t('set.newPin'), required: true, keyboard: 'number-pad', secure: true } });
              if (!pin) return;
              if (!/^[0-9]{4,8}$/.test(pin)) return fb.toast(t('err.invalid_pin'), 'error');
              guard('pin', () => callFunction('manage-employee', { action: 'reset_pin', employee_id: id, pin }, true), t('set.pinReset'));
            }}
          />
        </Card>
      ) : null}
    </Screen>
  );
}
