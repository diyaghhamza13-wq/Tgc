import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { colors } from '../lib/theme';
import { LogoMark } from './brand';
import { Backdrop } from './ui';

const native = Platform.OS !== 'web';
export const INTRO_MS = 2600;

/**
 * Animated brand intro shown when the app opens: the gold tooth logo scales in
 * with a pulsing glow ring, a light sweep crosses it, then the name and
 * subtitle rise in. Tapping anywhere skips it.
 */
export function Intro({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const logo = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;
  const title = useRef(new Animated.Value(0)).current;
  const sub = useRef(new Animated.Value(0)).current;
  const fadeOut = useRef(new Animated.Value(1)).current;
  const done = useRef(false);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    Animated.timing(fadeOut, { toValue: 0, duration: 280, useNativeDriver: native }).start(() => onDone());
  };

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.spring(logo, { toValue: 1, friction: 6, tension: 40, useNativeDriver: native }),
        Animated.timing(ring, { toValue: 1, duration: 1100, easing: Easing.out(Easing.cubic), useNativeDriver: native }),
      ]),
      Animated.parallel([
        Animated.timing(sweep, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
        Animated.timing(title, { toValue: 1, duration: 520, easing: Easing.out(Easing.cubic), useNativeDriver: native }),
        Animated.timing(sub, { toValue: 1, duration: 520, delay: 220, easing: Easing.out(Easing.cubic), useNativeDriver: native }),
      ]),
    ]).start();
    const timer = setTimeout(finish, INTRO_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rise = (v: Animated.Value) => ({
    opacity: v,
    transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }],
  });

  return (
    <Animated.View style={{ flex: 1, opacity: fadeOut }}>
      <Backdrop>
        <Pressable style={styles.center} onPress={finish} accessibilityRole="button" accessibilityLabel={t('app.name')}>
          <View style={styles.logoBox}>
            {/* expanding glow ring */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.ring,
                {
                  opacity: ring.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0, 0.8, 0] }),
                  transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.9] }) }],
                },
              ]}
            />
            <Animated.View pointerEvents="none" style={[styles.halo, { opacity: logo.interpolate({ inputRange: [0, 1], outputRange: [0, 0.55] }) }]} />
            <Animated.View
              style={{
                opacity: logo,
                transform: [
                  { scale: logo.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) },
                  { rotate: logo.interpolate({ inputRange: [0, 1], outputRange: ['-12deg', '0deg'] }) },
                ],
              }}
            >
              <LogoMark size={132} />
            </Animated.View>
            {/* light sweep across the logo */}
            <View pointerEvents="none" style={styles.sweepClip}>
              <Animated.View
                style={[
                  styles.sweep,
                  {
                    opacity: sweep.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0.7, 0] }),
                    transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-110, 110] }) }, { rotate: '20deg' }],
                  },
                ]}
              />
            </View>
          </View>

          <Animated.Text style={[styles.title, rise(title)]}>
            <Text style={{ color: colors.gold }}>Dental Lab </Text>
            <Text style={{ color: colors.white }}>Manager</Text>
          </Animated.Text>
          <Animated.View style={[styles.line, { opacity: sub, transform: [{ scaleX: sub }] }]} />
          <Animated.Text style={[styles.sub, rise(sub)]}>{t('app.subtitle')}</Animated.Text>
        </Pressable>
      </Backdrop>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  logoBox: { width: 220, height: 220, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  ring: { position: 'absolute', width: 160, height: 160, borderRadius: 80, borderWidth: 2, borderColor: colors.goldHi },
  halo: {
    position: 'absolute', width: 150, height: 150, borderRadius: 75, backgroundColor: 'rgba(214,173,85,0.10)',
    shadowColor: colors.goldHi, shadowOpacity: 0.9, shadowRadius: 40, shadowOffset: { width: 0, height: 0 },
  },
  sweepClip: { position: 'absolute', width: 140, height: 160, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  sweep: { width: 26, height: 220, backgroundColor: 'rgba(255,240,200,0.55)' },
  title: { fontSize: 32, fontWeight: '800', letterSpacing: 0.4, writingDirection: 'ltr', textAlign: 'center' },
  line: { width: 160, height: 2, backgroundColor: colors.gold, borderRadius: 1 },
  sub: { color: colors.muted, fontSize: 15, letterSpacing: 0.6, textAlign: 'center' },
});
