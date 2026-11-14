import { Pencil, Plus, Trash2 } from 'lucide-react-native';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ImplantIcon } from '../../../components/brand';
import { FormModal, useFeedback } from '../../../components/feedback';
import { Badge, Button, Card, ErrorBanner, Field, Loading, Row, Screen, Toggle } from '../../../components/ui';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { fetchCatalogs } from '../../../lib/queries';
import { errorCode, supabase, unwrap } from '../../../lib/supabase';
import { colors } from '../../../lib/theme';
import { useAsync } from '../../../lib/useAsync';

type Edit =
  | { type: 'brand'; id?: string; name: string; is_active: boolean }
  | { type: 'system'; id?: string; brand_id: string; name: string; connections: string; platforms: string; is_active: boolean };

/** Editable implant library: manufacturers and their systems. */
export default function Implants() {
  const { t, tx } = useI18n();
  const { me } = useAuth();
  const fb = useFeedback();
  const { data, error, reload } = useAsync(fetchCatalogs);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return <Screen back title={t('set.implants')}>{error ? <ErrorBanner code={error} onRetry={reload} /> : <Loading />}</Screen>;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setEdit(null);
      fb.toast(t('c.saved'));
      reload();
    } catch (e) {
      fb.toast(tx('err', errorCode(e)), 'error');
    } finally {
      setBusy(false);
    }
  };
  const split = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const save = () =>
    run(async () => {
      if (!edit || !me) return;
      if (edit.type === 'brand') {
        const row = { name: edit.name.trim(), is_active: edit.is_active };
        unwrap(edit.id ? await supabase.from('implant_brands').update(row).eq('id', edit.id).select('id') : await supabase.from('implant_brands').insert({ ...row, lab_id: me.lab_id, sort_order: data.brands.length + 1 }).select('id'));
      } else {
        const row = { name: edit.name.trim(), brand_id: edit.brand_id, connection_types: split(edit.connections), platforms: split(edit.platforms), is_active: edit.is_active };
        unwrap(edit.id ? await supabase.from('implant_systems').update(row).eq('id', edit.id).select('id') : await supabase.from('implant_systems').insert({ ...row, lab_id: me.lab_id }).select('id'));
      }
    });
  const remove = async (table: string, id: string, label: string) => {
    if (await fb.confirm({ title: t('c.areYouSure'), message: label, danger: true, confirmLabel: t('c.delete') })) run(async () => unwrap(await supabase.from(table).delete().eq('id', id).select('id')));
  };

  return (
    <Screen back title={t('set.implants')} right={<Pressable onPress={() => setEdit({ type: 'brand', name: '', is_active: true })} hitSlop={8} accessibilityLabel={t('c.add')}><Plus color={colors.gold} size={26} /></Pressable>}>
      {data.brands.map((b) => (
        <Card key={b.id}>
          <Row>
            <ImplantIcon size={22} />
            <Text style={{ color: colors.white, fontSize: 17, fontWeight: '800', flex: 1 }}>{b.name}</Text>
            {!b.is_active ? <Badge label={t('c.inactive')} color={colors.muted} /> : null}
            <Pressable onPress={() => setEdit({ type: 'brand', id: b.id, name: b.name, is_active: b.is_active })} hitSlop={8}><Pencil color={colors.gold} size={18} /></Pressable>
            <Pressable onPress={() => remove('implant_brands', b.id, b.name)} hitSlop={8}><Trash2 color={colors.error} size={18} /></Pressable>
          </Row>
          {data.systems.filter((s) => s.brand_id === b.id).map((s) => (
            <Row key={s.id} style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border, marginTop: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>{s.name}</Text>
                <Text style={{ color: colors.muted, fontSize: 12 }}>{[...s.connection_types, ...s.platforms].join(' · ')}</Text>
              </View>
              <Pressable onPress={() => setEdit({ type: 'system', id: s.id, brand_id: b.id, name: s.name, connections: s.connection_types.join(', '), platforms: s.platforms.join(', '), is_active: s.is_active })} hitSlop={8}><Pencil color={colors.gold} size={16} /></Pressable>
              <Pressable onPress={() => remove('implant_systems', s.id, s.name)} hitSlop={8}><Trash2 color={colors.error} size={16} /></Pressable>
            </Row>
          ))}
          <Button small variant="dark" title={`+ ${t('set.newSystem')}`} style={{ marginTop: 10 }} onPress={() => setEdit({ type: 'system', brand_id: b.id, name: '', connections: '', platforms: '', is_active: true })} />
        </Card>
      ))}
      <Button variant="outline" icon={<Plus color={colors.gold} size={18} />} title={`${t('c.add')} — ${t('set.brand')}`} onPress={() => setEdit({ type: 'brand', name: '', is_active: true })} />
      <FormModal visible={!!edit} title={edit?.type === 'system' ? t('set.systems') : t('set.brand')} submitLabel={t('c.save')} busy={busy} disabled={!edit?.name.trim()} onClose={() => setEdit(null)} onSubmit={save}>
        <Field label={t('c.name')} required value={edit?.name ?? ''} onChangeText={(v) => setEdit((e) => (e ? { ...e, name: v } : e))} />
        {edit?.type === 'system' ? (
          <>
            <Field label={t('set.connections')} value={edit.connections} onChangeText={(v) => setEdit((e) => (e && e.type === 'system' ? { ...e, connections: v } : e))} />
            <Field label={t('set.platforms')} value={edit.platforms} onChangeText={(v) => setEdit((e) => (e && e.type === 'system' ? { ...e, platforms: v } : e))} />
          </>
        ) : null}
        <Toggle label={t('c.active')} value={edit?.is_active ?? true} onChange={(v) => setEdit((e) => (e ? { ...e, is_active: v } : e))} />
      </FormModal>
    </Screen>
  );
}
