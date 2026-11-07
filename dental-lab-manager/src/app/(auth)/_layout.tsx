import { Redirect, Stack } from 'expo-router';
import React from 'react';
import { useAuth } from '../../lib/auth';
import { colors } from '../../lib/theme';

export default function AuthLayout() {
  const { session, me, loading } = useAuth();
  if (!loading && session && me) return <Redirect href="/(app)/(tabs)" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
