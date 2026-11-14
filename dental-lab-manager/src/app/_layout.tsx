import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { FeedbackProvider } from '../components/feedback';
import { Loading } from '../components/ui';
import { AuthProvider } from '../lib/auth';
import { I18nProvider, useI18n } from '../lib/i18n';
import { colors } from '../lib/theme';

function Shell() {
  const { ready, isRTL } = useI18n();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <Loading />
      </View>
    );
  }
  return (
    // On web the document `dir` drives layout; this keeps nested views consistent.
    <View style={[{ flex: 1, backgroundColor: colors.bg }, Platform.OS === 'web' ? ({ direction: isRTL ? 'rtl' : 'ltr' } as object) : null]}>
      <FeedbackProvider>
        <AuthProvider>
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }} />
        </AuthProvider>
      </FeedbackProvider>
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <Shell />
      </I18nProvider>
    </SafeAreaProvider>
  );
}
