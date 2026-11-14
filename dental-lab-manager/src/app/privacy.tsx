import { ShieldCheck } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';
import { LanguagePicker } from '../components/LanguagePicker';
import { Card, Screen } from '../components/ui';
import { useI18n } from '../lib/i18n';
import { PRIVACY, PRIVACY_UPDATED } from '../lib/privacy';
import { colors } from '../lib/theme';

/** Public privacy policy (store listing URL: /privacy). */
export default function Privacy() {
  const { lang, locale } = useI18n();
  const p = PRIVACY[lang];
  return (
    <Screen back title={p.title} right={<LanguagePicker />}>
      <Card>
        <View style={styles.head}>
          <ShieldCheck color={colors.gold} size={28} />
          <Text style={styles.updated}>
            {p.updated}: {new Date(`${PRIVACY_UPDATED}T00:00:00`).toLocaleDateString(locale, { day: '2-digit', month: 'long', year: 'numeric' })}
          </Text>
        </View>
        <Text style={styles.body}>{p.intro}</Text>
      </Card>
      {p.sections.map((s) => (
        <Card key={s.h}>
          <Text style={styles.h}>{s.h}</Text>
          {s.p.map((para) => (
            <Text key={para.slice(0, 24)} style={styles.body}>
              {para}
            </Text>
          ))}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  updated: { color: colors.muted, fontSize: 13 },
  h: { color: colors.gold, fontSize: 17, fontWeight: '800', marginBottom: 8 },
  body: { color: colors.text, fontSize: 15, lineHeight: 24, marginBottom: 6 },
});
