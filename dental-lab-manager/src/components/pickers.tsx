import { Calendar, Check, ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react-native';
import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { colors, radius } from '../lib/theme';
import { fmtDate, todayISO } from '../lib/format';
import { Button } from './ui';

export type Option = { value: string; label: string; hint?: string };

/** Searchable single-select in a bottom sheet. */
export function Select({
  label,
  value,
  options,
  onChange,
  icon,
  placeholder,
  required,
  allowClear,
  footer,
}: {
  label: string;
  value: string | null | undefined;
  options: Option[];
  onChange: (v: string | null) => void;
  icon?: React.ReactNode;
  placeholder?: string;
  required?: boolean;
  allowClear?: boolean;
  footer?: (close: () => void) => React.ReactNode;
}) {
  const { t, isRTL } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const current = options.find((o) => o.value === value);
  const filtered = useMemo(
    () => options.filter((o) => !q || `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q.toLowerCase())),
    [options, q],
  );
  return (
    <>
      <Pressable style={styles.field} onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={label}>
        {icon ? <View style={{ width: 26, alignItems: 'center' }}>{icon}</View> : null}
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>
            {label}
            {required ? <Text style={{ color: colors.error }}> *</Text> : null}
          </Text>
          <Text style={[styles.value, !current && { color: colors.faint }, { textAlign: isRTL ? 'right' : 'left' }]} numberOfLines={1}>
            {current?.label ?? placeholder ?? t('c.select')}
          </Text>
        </View>
        <ChevronDown color={colors.gold} size={20} />
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>{label}</Text>
            {options.length > 7 ? (
              <View style={styles.search}>
                <Search color={colors.muted} size={18} />
                <TextInput value={q} onChangeText={setQ} placeholder={t('c.search')} placeholderTextColor={colors.faint} style={[styles.searchInput, { textAlign: isRTL ? 'right' : 'left' }]} />
              </View>
            ) : null}
            <FlatList
              data={allowClear ? [{ value: '', label: t('c.none') } as Option, ...filtered] : filtered}
              keyExtractor={(o) => o.value || '__none'}
              style={{ maxHeight: 420 }}
              renderItem={({ item }) => {
                const on = (item.value || null) === (value ?? null);
                return (
                  <Pressable
                    style={[styles.opt, on && styles.optOn]}
                    onPress={() => {
                      onChange(item.value || null);
                      setOpen(false);
                      setQ('');
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.optText, on && { color: colors.gold }]}>{item.label}</Text>
                      {item.hint ? <Text style={styles.hint}>{item.hint}</Text> : null}
                    </View>
                    {on ? <Check color={colors.gold} size={18} /> : null}
                  </Pressable>
                );
              }}
              ListEmptyComponent={<Text style={[styles.hint, { padding: 16 }]}>{t('c.noResults')}</Text>}
            />
            {footer?.(() => setOpen(false))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Calendar date picker (YYYY-MM-DD) with quick shortcuts. */
export function DateField({ label, value, onChange, required, min }: { label: string; value: string | null; onChange: (v: string) => void; required?: boolean; min?: string }) {
  const { t, locale, isRTL } = useI18n();
  const [open, setOpen] = useState(false);
  const init = value ? new Date(`${value}T00:00:00`) : new Date();
  const [month, setMonth] = useState({ y: init.getFullYear(), m: init.getMonth() });
  const first = new Date(month.y, month.m, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday first
  const days = new Date(month.y, month.m + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(startDow).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const iso = (d: number) => `${month.y}-${pad(month.m + 1)}-${pad(d)}`;
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: 'narrow' }));
  const shift = (n: number) => {
    const d = new Date(month.y, month.m + n, 1);
    setMonth({ y: d.getFullYear(), m: d.getMonth() });
  };
  const Prev = isRTL ? ChevronRight : ChevronLeft;
  const Next = isRTL ? ChevronLeft : ChevronRight;
  return (
    <>
      <Pressable style={styles.field} onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={label}>
        <View style={{ width: 26, alignItems: 'center' }}>
          <Calendar color={colors.gold} size={20} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>
            {label}
            {required ? <Text style={{ color: colors.error }}> *</Text> : null}
          </Text>
          <Text style={[styles.value, !value && { color: colors.faint }, { textAlign: isRTL ? 'right' : 'left' }]}>{value ? fmtDate(value, locale) : t('c.select')}</Text>
        </View>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={[styles.backdrop, { justifyContent: 'center' }]} onPress={() => setOpen(false)}>
          <Pressable style={[styles.sheet, { borderRadius: radius.xl }]} onPress={() => {}}>
            <View style={styles.calHead}>
              <Pressable onPress={() => shift(-1)} hitSlop={10}>
                <Prev color={colors.gold} size={22} />
              </Pressable>
              <Text style={styles.sheetTitle}>{first.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}</Text>
              <Pressable onPress={() => shift(1)} hitSlop={10}>
                <Next color={colors.gold} size={22} />
              </Pressable>
            </View>
            <View style={styles.grid}>
              {weekdays.map((w, i) => (
                <Text key={`w${i}`} style={[styles.cell, styles.dow]}>
                  {w}
                </Text>
              ))}
              {cells.map((d, i) => {
                if (!d) return <View key={`e${i}`} style={styles.cell} />;
                const v = iso(d);
                const disabled = !!min && v < min;
                const on = v === value;
                return (
                  <Pressable
                    key={v}
                    disabled={disabled}
                    onPress={() => {
                      onChange(v);
                      setOpen(false);
                    }}
                    style={[styles.cell, on && styles.cellOn, v === todayISO() && !on && styles.cellToday]}
                  >
                    <Text style={{ color: disabled ? colors.faint : on ? '#1A1206' : colors.white, fontWeight: on ? '800' : '500' }}>{d}</Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {[0, 1, 3, 5, 7].map((n) => (
                <Button
                  key={n}
                  small
                  variant="outline"
                  title={n === 0 ? t('c.today') : n === 1 ? t('c.tomorrow') : t('c.inDays', { n })}
                  onPress={() => {
                    onChange(todayISO(n));
                    setOpen(false);
                  }}
                />
              ))}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'rgba(11,23,38,0.9)', borderWidth: 1, borderColor: colors.borderHi, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 8, minHeight: 56, marginBottom: 12 },
  label: { color: colors.muted, fontSize: 12, marginBottom: 2 },
  value: { color: colors.white, fontSize: 17 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end', padding: 12 },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border, padding: 16, width: '100%', maxWidth: 560, alignSelf: 'center' },
  sheetTitle: { color: colors.white, fontSize: 18, fontWeight: '800', marginBottom: 10, textAlign: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, marginBottom: 8 },
  searchInput: { flex: 1, color: colors.white, paddingVertical: 10, fontSize: 16 },
  opt: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 12, borderRadius: radius.md },
  optOn: { backgroundColor: colors.goldDim },
  optText: { color: colors.white, fontSize: 16 },
  hint: { color: colors.muted, fontSize: 12, marginTop: 2 },
  calHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, aspectRatio: 1.15, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  dow: { color: colors.muted, textAlign: 'center', textAlignVertical: 'center', fontSize: 12 },
  cellOn: { backgroundColor: colors.gold },
  cellToday: { borderWidth: 1, borderColor: colors.gold },
});
