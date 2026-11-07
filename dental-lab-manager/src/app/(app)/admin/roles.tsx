import { Plus, ShieldCheck } from 'lucide-react-native';
import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { FormModal, useFeedback } from '../../../components/feedback';
import { Badge, Button, Card, Chip, ErrorBanner, Field, Loading, Screen, SectionTitle, Toggle } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { fetchRoles } from '../../../lib/queries';
import { errorCode, supabase, unwrap } from '../../../lib/supabase';
import { colors } from '../../../lib/theme';
import { useAsync } from '../../../lib/useAsync';

type Perm = { code: string; category: string; description: string };

/** Roles and their permissions (saved atomically by save_role_permissions). */
export default function Roles() {
  const { t, tx } = useI18n();
  const { me, reloadMe } = useAuth();
  const fb = useFeedback();
  const { data, error, reload } = useAsync(async () => {
    const [roles, perms, rp] = await Promise.all([
      fetchRoles(),
      supabase.from('permissions').select('*').order('category').then((r) => unwrap(r) as Perm[]),
      supabase.from('role_permissions').select('role_id, permission_code').then((r) => unwrap(r) as { role_id: string; permission_code: string }[]),
    ]);
    return { roles, perms, rp };
  });
  const [roleId, setRoleId] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [newRole, setNewRole] = useState<{ name: string; code: string } | null>(null);
  useEffect(() => {
    if (data && !roleId && data.roles.length) setRoleId(data.roles[0].id);
  }, [data, roleId]);
  useEffect(() => {
    if (data && roleId) setSel(new Set(data.rp.filter((x) => x.role_id === roleId).map((x) => x.permission_code)));
  }, [data, roleId]);
  if (!data) return <Screen back title={t('set.roles')}>{error ? <ErrorBanner code={error} onRetry={reload} /> : <Loading />}</Screen>;
  const role = data.roles.find((r) => r.id === roleId);
  const categories = Array.from(new Set(data.perms.map((p) => p.category)));

  const save = async () => {
    setBusy(true);
    try {
      unwrap(await supabase.rpc('save_role_permissions', { p_role_id: roleId, p_permissions: Array.from(sel) }));
      fb.toast(t('c.saved'));
      await reload();
      if (me?.role_id === roleId) await reloadMe();
    } catch (e) {
      fb.toast(tx('err', errorCode(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen back title={t('set.roles')} right={<Pressable onPress={() => setNewRole({ name: '', code: '' })} hitSlop={8} accessibilityLabel={t('set.newRole')}><Plus color={colors.gold} size={26} /></Pressable>}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {data.roles.map((r) => (
          <Chip key={r.id} label={r.name} selected={r.id === roleId} onPress={() => setRoleId(r.id)} />
        ))}
      </View>
      {role ? (
        <Card>
          <SectionTitle icon={<ShieldCheck color={colors.gold} size={20} />} right={role.is_system ? <Badge label={t('set.systemRole')} /> : null}>
            {role.name}
          </SectionTitle>
          {categories.map((cat) => (
            <View key={cat} style={{ marginBottom: 8 }}>
              <Text style={{ color: colors.gold, fontWeight: '700', textTransform: 'uppercase', fontSize: 12, marginTop: 6 }}>{cat}</Text>
              {data.perms.filter((p) => p.category === cat).map((p) => (
                <Toggle
                  key={p.code}
                  label={tx('perm', p.code) === p.code ? p.description : tx('perm', p.code)}
                  value={sel.has(p.code)}
                  onChange={(v) => setSel((s) => { const n = new Set(s); if (v) n.add(p.code); else n.delete(p.code); return n; })}
                />
              ))}
            </View>
          ))}
          <Button title={t('c.save')} loading={busy} onPress={save} />
        </Card>
      ) : null}
      <FormModal
        visible={!!newRole}
        title={t('set.newRole')}
        submitLabel={t('c.save')}
        disabled={!newRole?.name.trim() || !/^[A-Z0-9_]{2,20}$/.test(newRole?.code ?? '')}
        onClose={() => setNewRole(null)}
        onSubmit={async () => {
          const { data: r, error: e } = await supabase.from('roles').insert({ lab_id: me!.lab_id, name: newRole!.name.trim(), code: newRole!.code }).select().single();
          if (e) return fb.toast(tx('err', errorCode(e)), 'error');
          setNewRole(null);
          await reload();
          setRoleId(r.id);
        }}
      >
        <Field label={t('c.name')} required value={newRole?.name ?? ''} onChangeText={(v) => setNewRole((x) => ({ ...x!, name: v }))} />
        <Field label={t('c.code')} required value={newRole?.code ?? ''} onChangeText={(v) => setNewRole((x) => ({ ...x!, code: v.toUpperCase().replace(/[^A-Z0-9_]/g, '') }))} autoCapitalize="characters" />
      </FormModal>
    </Screen>
  );
}
