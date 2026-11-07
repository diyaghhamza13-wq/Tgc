import { ChevronDown, Globe } from 'lucide-react-native';
import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { LANGS, useI18n, type Lang } from '../lib/i18n';
import { supabase } from '../lib/supabase';
import { colors, radius } from '../lib/theme';

/** "🌐 AR ▾" pill. When signed in, also saves the preference on the profile. */
export function LanguagePicker({ persistToProfile = false }: { persistToProfile?: boolean }) {
  const { lang, setLang } = useI18n();
  const [open, setOpen] = useState(false);
  const choose = async (l: Lang) => {
    setOpen(false);
    if (persistToProfile) await supabase.rpc('update_my_profile', { p: { preferred_language: l } });
    await setLang(l);
  };
  return (
    <>
      <Pressable style={styles.pill} onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Language">
        <Globe color={colors.gold} size={18} />
        <Text style={styles.text}>{lang.toUpperCase()}</Text>
        <ChevronDown color={colors.gold} size={16} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.menu}>
            {LANGS.map((l) => (
              <Pressable key={l.code} style={[styles.item, l.code === lang && styles.itemOn]} onPress={() => choose(l.code)}>
                <Text style={[styles.itemText, l.code === lang && { color: colors.gold }]}>{l.label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.gold, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: 'rgba(5,11,21,0.6)' },
  text: { color: colors.white, fontWeight: '800' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  menu: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.gold, padding: 8, minWidth: 220 },
  item: { padding: 14, borderRadius: radius.md },
  itemOn: { backgroundColor: colors.goldDim },
  itemText: { color: colors.white, fontSize: 17, textAlign: 'center' },
});
