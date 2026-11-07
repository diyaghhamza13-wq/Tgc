import { LinearGradient } from 'expo-linear-gradient';
import * as Linking from 'expo-linking';
import { Award, Globe, GraduationCap, Mail, MessageCircle, Monitor, Sparkles, UserRound } from 'lucide-react-native';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { ToothIcon } from '../components/brand';
import { useFeedback } from '../components/feedback';
import { LanguagePicker } from '../components/LanguagePicker';
import { Card, Screen, SectionTitle } from '../components/ui';
import { DEV_TEXT, DEVELOPER } from '../lib/developer';
import { useI18n } from '../lib/i18n';
import { colors, glow, goldGradient, radius } from '../lib/theme';

const photo = require('../../assets/developer/hamza.jpg');
const banner = require('../../assets/developer/banner.jpg');

/** Public page about the app's creator (reachable before and after login). */
export default function AboutDeveloper() {
  const { lang } = useI18n();
  const fb = useFeedback();
  const tx = DEV_TEXT[lang];
  const open = (url: string) => Linking.openURL(url).catch(() => fb.toast(url, 'error'));
  const ic = { color: colors.gold, size: 20, strokeWidth: 1.7 };

  const contacts = [
    { key: 'wa', label: 'WhatsApp', value: DEVELOPER.whatsapp, icon: <MessageCircle {...ic} />, url: DEVELOPER.whatsappUrl },
    { key: 'mail', label: 'Email', value: DEVELOPER.email, icon: <Mail {...ic} />, url: `mailto:${DEVELOPER.email}` },
    { key: 'in', label: 'LinkedIn', value: 'hamza-diyagh', icon: <UserRound {...ic} />, url: DEVELOPER.linkedin },
    { key: 'web', label: tx.website, value: 'hamzadiyagh.com', icon: <Globe {...ic} />, url: DEVELOPER.website },
  ];

  return (
    <Screen back title={tx.pageTitle} right={<LanguagePicker />}>
      {/* Hero */}
      <View style={styles.hero}>
        <Image source={banner} style={styles.banner} resizeMode="cover" accessibilityIgnoresInvertColors />
        <LinearGradient colors={['rgba(5,11,21,0.1)', 'rgba(5,11,21,0.75)', colors.bg]} style={StyleSheet.absoluteFill} />
        <View style={styles.heroContent}>
          <View style={[styles.photoRing, glow]}>
            <Image source={photo} style={styles.photo} accessibilityLabel={DEVELOPER.name} />
          </View>
          <Text style={styles.madeBy}>{tx.madeBy}</Text>
          <Text style={styles.name}>{DEVELOPER.name}</Text>
          <View style={styles.goldLine} />
          {tx.titles.map((t, i) => (
            <Text key={t} style={[styles.title, i === 0 && { color: colors.goldHi, fontWeight: '800' }]}>
              {t}
            </Text>
          ))}
          <View style={styles.tagline}>
            <Sparkles color={colors.gold} size={14} />
            <Text style={styles.taglineText}>{tx.tagline}</Text>
          </View>
        </View>
      </View>

      <Card>
        <SectionTitle icon={<UserRound {...ic} />}>{tx.aboutTitle}</SectionTitle>
        {tx.about.map((p) => (
          <Text key={p.slice(0, 20)} style={styles.body}>
            {p}
          </Text>
        ))}
      </Card>

      <Card>
        <SectionTitle icon={<ToothIcon size={20} />}>{tx.expertiseTitle}</SectionTitle>
        <View style={styles.grid}>
          {tx.expertise.map((e, i) => (
            <View key={e.title} style={styles.tile}>
              <Text style={styles.tileNum}>{String(i + 1).padStart(2, '0')}</Text>
              <Text style={styles.tileTitle}>{e.title}</Text>
              <Text style={styles.tileText}>{e.text}</Text>
            </View>
          ))}
        </View>
      </Card>

      <Card>
        <SectionTitle icon={<Monitor {...ic} />}>{tx.toolsTitle}</SectionTitle>
        <Text style={styles.sub}>{tx.software}</Text>
        <View style={styles.chips}>
          {DEVELOPER.software.map((s) => (
            <Text key={s} style={styles.chip}>
              {s}
            </Text>
          ))}
        </View>
        <Text style={[styles.sub, { marginTop: 12 }]}>{tx.machines}</Text>
        <View style={styles.chips}>
          {DEVELOPER.machines.map((s) => (
            <Text key={s} style={styles.chip}>
              {s}
            </Text>
          ))}
        </View>
      </Card>

      <Card>
        <SectionTitle icon={<GraduationCap {...ic} />}>{tx.educationTitle}</SectionTitle>
        {DEVELOPER.education.map((e) => (
          <View key={e.school} style={styles.row}>
            <View style={styles.dot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{e.school}</Text>
              <Text style={styles.rowSub}>{e.field}</Text>
            </View>
          </View>
        ))}
      </Card>

      <Card>
        <SectionTitle icon={<Award {...ic} />}>{tx.certTitle}</SectionTitle>
        {DEVELOPER.certifications.map((c) => (
          <View key={c.title} style={styles.row}>
            <View style={styles.dot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{c.title}</Text>
              <Text style={styles.rowSub}>
                {c.org}
                {c.date ? ` · ${c.date}` : ''}
              </Text>
            </View>
          </View>
        ))}
      </Card>

      <Card glowing>
        <SectionTitle icon={<Sparkles {...ic} />}>{tx.contactTitle}</SectionTitle>
        <Text style={[styles.body, { marginBottom: 12 }]}>{tx.contactText}</Text>
        {contacts.map((c) => (
          <Pressable key={c.key} onPress={() => open(c.url)} style={({ pressed }) => [styles.contact, pressed && { opacity: 0.8 }]} accessibilityRole="link" accessibilityLabel={c.label}>
            {c.icon}
            <View style={{ flex: 1 }}>
              <Text style={styles.contactLabel}>{c.label}</Text>
              <Text style={styles.contactValue}>{c.value}</Text>
            </View>
          </Pressable>
        ))}
        <Pressable onPress={() => open(DEVELOPER.whatsappUrl)} accessibilityRole="button" style={{ marginTop: 6 }}>
          <LinearGradient colors={goldGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.cta}>
            <MessageCircle color="#1A1206" size={20} />
            <Text style={styles.ctaText}>WhatsApp</Text>
          </LinearGradient>
        </Pressable>
      </Card>

      <Text style={styles.footer}>{tx.footer}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: radius.xl, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, minHeight: 440 },
  banner: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', opacity: 0.85 },
  heroContent: { alignItems: 'center', paddingTop: 56, paddingBottom: 24, paddingHorizontal: 16, gap: 4 },
  photoRing: { width: 150, height: 150, borderRadius: 75, borderWidth: 3, borderColor: colors.goldHi, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg, marginBottom: 14 },
  photo: { width: 140, height: 140, borderRadius: 70 },
  madeBy: { color: colors.muted, fontSize: 13, letterSpacing: 1 },
  name: { color: colors.white, fontSize: 32, fontWeight: '800', letterSpacing: 0.5, writingDirection: 'ltr' },
  goldLine: { width: 120, height: 2, backgroundColor: colors.gold, marginVertical: 8, borderRadius: 1 },
  title: { color: colors.text, fontSize: 14, textAlign: 'center' },
  tagline: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, borderWidth: 1, borderColor: colors.gold, borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 5, backgroundColor: 'rgba(5,11,21,0.6)' },
  taglineText: { color: colors.gold, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  body: { color: colors.text, fontSize: 15, lineHeight: 24, marginBottom: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { flexBasis: '47%', flexGrow: 1, backgroundColor: colors.bg2, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 12 },
  tileNum: { color: colors.gold, fontWeight: '800', fontSize: 13 },
  tileTitle: { color: colors.white, fontWeight: '800', fontSize: 15, marginTop: 4 },
  tileText: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  sub: { color: colors.gold, fontWeight: '700', marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { color: colors.text, fontSize: 12, borderWidth: 1, borderColor: colors.borderHi, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, overflow: 'hidden' },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.gold, marginTop: 5 },
  rowTitle: { color: colors.white, fontWeight: '700', fontSize: 14 },
  rowSub: { color: colors.muted, fontSize: 12, marginTop: 2 },
  contact: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg2, marginBottom: 8 },
  contactLabel: { color: colors.muted, fontSize: 12 },
  contactValue: { color: colors.white, fontSize: 15, fontWeight: '600', writingDirection: 'ltr', textAlign: 'auto' },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 14, borderRadius: radius.lg },
  ctaText: { color: '#1A1206', fontWeight: '800', fontSize: 16 },
  footer: { color: colors.faint, textAlign: 'center', fontSize: 12 },
});
