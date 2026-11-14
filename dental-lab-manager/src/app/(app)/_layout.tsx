import { Redirect, Stack } from 'expo-router';
import React from 'react';
import { useAuth } from '../../lib/auth';
import { colors } from '../../lib/theme';

/** Everything below requires an authenticated, active employee. */
export default function AppLayout() {
  const { session, me, loading } = useAuth();
  if (loading) return null;
  if (!session || !me) return <Redirect href="/(auth)/lab" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
