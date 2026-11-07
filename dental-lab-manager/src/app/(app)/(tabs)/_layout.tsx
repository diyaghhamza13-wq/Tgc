import { LinearGradient } from 'expo-linear-gradient';
import { Tabs } from 'expo-router';
import { ChartColumn, ClipboardList, House, Plus, Settings } from 'lucide-react-native';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { colors, glow, goldGradient } from '../../../lib/theme';

const ICONS = { index: House, cases: ClipboardList, new: Plus, reports: ChartColumn, settings: Settings } as const;

export default function TabsLayout() {
  const { t } = useI18n();
  const { can } = useAuth();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
      tabBar={({ state, navigateToTab }) => (
        <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          {state.routes.map((route, i) => {
            const name = route.name as keyof typeof ICONS;
            const Icon = ICONS[name];
            if (!Icon) return null;
            if (name === 'new' && !can('cases.create')) return null;
            const focused = state.index === i;
            const label = t(name === 'index' ? 'tab.home' : (`tab.${name}` as 'tab.cases'));
            const go = () => {
              if (!focused) navigateToTab(route.key);
            };
            if (name === 'new') {
              return (
                <Pressable key={route.key} onPress={go} style={styles.item} accessibilityRole="button" accessibilityLabel={label}>
                  <LinearGradient colors={goldGradient} style={[styles.fab, glow]}>
                    <Plus color="#1A1206" size={30} strokeWidth={2.4} />
                  </LinearGradient>
                  <Text style={[styles.label, { color: colors.white }]}>{label}</Text>
                </Pressable>
              );
            }
            return (
              <Pressable key={route.key} onPress={go} style={styles.item} accessibilityRole="tab" accessibilityState={{ selected: focused }} accessibilityLabel={label}>
                <Icon color={focused ? colors.gold : colors.white} size={24} strokeWidth={1.7} />
                <Text style={[styles.label, focused && { color: colors.gold }]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="cases" />
      <Tabs.Screen name="new" />
      <Tabs.Screen name="reports" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', backgroundColor: 'rgba(11,23,38,0.98)', borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, alignItems: 'flex-end' },
  item: { flex: 1, alignItems: 'center', gap: 4 },
  label: { color: colors.white, fontSize: 11 },
  fab: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', marginTop: -30, borderWidth: 3, borderColor: colors.bg },
});
