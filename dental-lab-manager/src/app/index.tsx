import { Redirect } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { Brand } from '../components/brand';
import { Backdrop, Loading } from '../components/ui';
import { useAuth } from '../lib/auth';

/** Splash: restores the session, then routes to the app or the login flow. */
export default function Splash() {
  const { loading, session, me } = useAuth();
  if (loading) {
    return (
      <Backdrop>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 30 }}>
          <Brand />
          <Loading />
        </View>
      </Backdrop>
    );
  }
  if (session && me) return <Redirect href="/(app)/(tabs)" />;
  return <Redirect href="/(auth)/lab" />;
}
