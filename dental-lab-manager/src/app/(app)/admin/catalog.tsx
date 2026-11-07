import { useLocalSearchParams } from 'expo-router';
import { Pencil, Plus, Trash2 } from 'lucide-react-native';
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FormModal, useFeedback } from '../../../components/feedback';
import { Badge, Button, Card, EmptyState, ErrorBanner, Field, Loading, Row, Screen, Toggle } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { type TKey, useI18n } from '../../../lib/i18n';
import { errorCode, supabase, unwrap } from '../../../lib/supabase';
import { colors } from '../../../lib/theme';
import { useAsync } from '../../../lib/useAsync';

type FieldDef = { key: string; label: TKey; type?: 'text' | 'number' | 'bool' | 'code'; required?: boolean };
type Kind = {
  table: string;
  title: TKey;
  order: string;
  activeKey: string;
  fields: FieldDef[];
  subtitle: (r: Record<string, unknown>) => string;
};

/** Generic editor for laboratory catalogs. Permissions are enforced by RLS. */
const KINDS: Record<string, Kind> = {
  departments: {
    table: 'departments', title: 'set.departments', order: 'sort_order', activeKey: 'is_active',
    fields: [{ key: 'name', label: 'c.name', required: true }, { key: 'code', label: 'c.code', type: 'code', required: true }, { key: 'sort_order', label: 'set.sortOrder', type: 'number' }, { key: 'is_active', label: 'c.active', type: 'bool' }],
    subtitle: (r) => String(r.code),
  },
  restorations: {
    table: 'restoration_types', title: 'set.restorations', order: 'sort_order', activeKey: 'is_active',
    fields: [{ key: 'name', label: 'c.name', required: true }, { key: 'code', label: 'c.code', type: 'code', required: true }, { key: 'sort_order', label: 'set.sortOrder', type: 'number' }, { key: 'is_implant_related', label: 'det.implant', type: 'bool' }, { key: 'is_active', label: 'c.active', type: 'bool' }],
    subtitle: (r) => String(r.code),
  },
  materials: {
    table: 'materials', title: 'set.materials', order: 'sort_order', activeKey: 'is_active',
    fields: [{ key: 'name', label: 'c.name', required: true }, { key: 'code', label: 'c.code', type: 'code', required: true }, { key: 'category', label: 'set.category' }, { key: 'default_brand', label: 'wiz.materialBrand' }, { key: 'sort_order', label: 'set.sortOrder', type: 'number' }, { key: 'is_active', label: 'c.active', type: 'bool' }],
    subtitle: (r) => [r.code, r.category, r.default_brand].filter(Boolean).join(' · '),
  },
  doctors: {
    table: 'doctors', title: 'set.doctors', order: 'full_name', activeKey: 'is_active',
    fields: [{ key: 'full_name', label: 'c.name', required: true }, { key: 'clinic_name', label: 'set.clinic' }, { key: 'phone', label: 'c.phone' }, { key: 'email', label: 'c.email' }, { key: 'address', label: 'c.address' }, { key: 'city', label: 'c.city' }, { key: 'notes', label: 'c.notes' }, { key: 'is_active', label: 'c.active', type: 'bool' }],
    subtitle: (r) => [r.clinic_name, r.phone, r.city].filter(Boolean).join(' · '),
  },
};

export default function Catalog() {
  const { kind = 'departments' } = useLocalSearchParams<{ kind: string }>();
  const cfg = KINDS[kind] ?? KINDS.departments;
  const { t, tx } = useI18n();
  const { me } = useAuth();
  const fb = useFeedback();
  const { data, error, loading, reload } = useAsync(
    async () => unwrap(await supabase.from(cfg.table).select('*').order(cfg.order)) as Record<string, unknown>[],
    [cfg.table],
  );
  const [edit, setEdit] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const titleKey = cfg.fields[0].key;

  const save = async () => {
    if (!edit || !me) return;
    for (const f of cfg.fields) if (f.required && !String(edit[f.key] ?? '').trim()) return fb.toast(t('err.missing_fields'), 'error');
    setBusy(true);
    try {
      const row: Record<string, unknown> = {};
      for (const f of cfg.fields) {
        const v = edit[f.key];
        row[f.key] = f.type === 'number' ? Number(v) || 0 : f.type === 'bool' ? v !== false : typeof v === 'string' ? v.trim() || null : v;
      }
      if (edit.id) unwrap(await supabase.from(cfg.table).update(row).eq('id', edit.id as string).select('id'));
      else unwrap(await supabase.from(cfg.table).insert({ ...row, lab_id: me.lab_id }).select('id'));
      setEdit(null);
      fb.toast(t('c.saved'));
      reload();
    } catch (e) {
      fb.toast(tx('err', errorCode(e)), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: Record<string, unknown>) => {
    if (!(await fb.confirm({ title: t('c.areYouSure'), message: String(r[titleKey]), danger: true, confirmLabel: t('c.delete') }))) return;
    const res = await supabase.from(cfg.table).delete().eq('id', r.id as string).select('id');
    if (res.error) fb.toast(tx('err', errorCode(res.error)), 'error');
    else if (!res.data?.length) fb.toast(t('err.permission_denied'), 'error');
    else fb.toast(t('c.saved'));
    reload();
  };

  return (
    <Screen
      back
      title={t(cfg.title)}
      refreshing={loading && !!data}
      onRefresh={reload}
      right={
        <Pressable onPress={() => setEdit({ is_active: true, is_implant_related: false, sort_order: (data?.length ?? 0) + 1 })} hitSlop={8} accessibilityLabel={t('c.add')}>
          <Plus color={colors.gold} size={26} />
        </Pressable>
      }
    >
      <ErrorBanner code={error} onRetry={reload} />
      {!data && loading ? <Loading /> : null}
      {data && !data.length ? <EmptyState title={t('c.empty')} /> : null}
      {data?.map((r) => (
        <Card key={r.id as string}>
          <Row>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>{String(r[titleKey])}</Text>
              <Text style={styles.sub}>{cfg.subtitle(r)}</Text>
            </View>
            {r[cfg.activeKey] === false ? <Badge label={t('c.inactive')} color={colors.muted} /> : null}
            <Pressable onPress={() => setEdit({ ...r })} hitSlop={8} accessibilityLabel={t('c.edit')}>
              <Pencil color={colors.gold} size={20} />
            </Pressable>
            <Pressable onPress={() => remove(r)} hitSlop={8} accessibilityLabel={t('c.delete')}>
              <Trash2 color={colors.error} size={20} />
            </Pressable>
          </Row>
        </Card>
      ))}
      <Button variant="outline" icon={<Plus color={colors.gold} size={18} />} title={t('c.add')} onPress={() => setEdit({ is_active: true, is_implant_related: false, sort_order: (data?.length ?? 0) + 1 })} />

      <FormModal visible={!!edit} title={edit?.id ? t('c.edit') : t('c.add')} submitLabel={t('c.save')} busy={busy} onClose={() => setEdit(null)} onSubmit={save}>
        {cfg.fields.map((f) =>
          f.type === 'bool' ? (
            <Toggle key={f.key} label={t(f.label)} value={edit?.[f.key] !== false} onChange={(v) => setEdit((e) => ({ ...e, [f.key]: v }))} />
          ) : (
            <Field
              key={f.key}
              label={t(f.label)}
              required={f.required}
              value={edit?.[f.key] == null ? '' : String(edit[f.key])}
              keyboardType={f.type === 'number' ? 'number-pad' : 'default'}
              autoCapitalize={f.type === 'code' ? 'characters' : 'sentences'}
              onChangeText={(v) => setEdit((e) => ({ ...e, [f.key]: f.type === 'code' ? v.toUpperCase().replace(/[^A-Z0-9_]/g, '') : v }))}
            />
          ),
        )}
      </FormModal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.white, fontSize: 16, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 12, marginTop: 2 },
});
