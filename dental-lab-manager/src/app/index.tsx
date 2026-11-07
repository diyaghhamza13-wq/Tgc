import { Redirect } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Intro } from '../components/Intro';
import { Backdrop, Loading } from '../components/ui';
import { useAuth } from '../lib/auth';

// The intro plays once per app launch, not on every return to "/".
let introPlayed = false;

/** Splash: animated intro while the session is restored, then route on. */
export default function Splash() {
  const { loading, session, me } = useAuth();
  const [introDone, setIntroDone] = useState(introPlayed);

  if (!introDone) {
    return (
      <Intro
        onDone={() => {
          introPlayed = true;
          setIntroDone(true);
        }}
      />
    );
  }
  if (loading) {
    return (
      <Backdrop>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Loading />
        </View>
      </Backdrop>
    );
  }
  if (session && me) return <Redirect href="/(app)/(tabs)" />;
  return <Redirect href="/(auth)/lab" />;
}
