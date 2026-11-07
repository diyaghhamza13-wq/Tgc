import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import * as Updates from 'expo-updates';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DevSettings, I18nManager, Platform } from 'react-native';
import { ar } from './locales/ar';
import { en, type TKey } from './locales/en';
import { fr } from './locales/fr';

export type Lang = 'ar' | 'en' | 'fr';
export const LANGS: { code: Lang; label: string }[] = [
  { code: 'ar', label: 'العربية' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
];
const DICTS: Record<Lang, Record<TKey, string>> = { en, ar, fr };
const STORAGE_KEY = 'dlm.language';

type Ctx = {
  lang: Lang;
  isRTL: boolean;
  t: (key: TKey, params?: Record<string, string | number>) => string;
  /** Translate a dynamic key like `status.${x}`, falling back to the raw value. */
  tx: (prefix: string, value: string | null | undefined) => string;
  setLang: (l: Lang) => Promise<void>;
  locale: string;
  ready: boolean;
};

const I18nContext = createContext<Ctx | null>(null);

function deviceLang(): Lang {
  const code = Localization.getLocales()[0]?.languageCode;
  return code === 'en' || code === 'fr' ? code : 'ar';
}

/** Apply layout direction. Native needs a reload when direction flips. */
async function applyDirection(lang: Lang) {
  const rtl = lang === 'ar';
  if (Platform.OS === 'web') {
    if (typeof document !== 'undefined') {
      document.documentElement.dir = rtl ? 'rtl' : 'ltr';
      document.documentElement.lang = lang;
    }
    return;
  }
  I18nManager.allowRTL(true);
  if (I18nManager.isRTL !== rtl) {
    I18nManager.forceRTL(rtl);
    try {
      await Updates.reloadAsync();
    } catch {
      DevSettings.reload();
    }
  }
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(deviceLang());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const stored = (await AsyncStorage.getItem(STORAGE_KEY)) as Lang | null;
      const l = stored && DICTS[stored] ? stored : deviceLang();
      setLangState(l);
      await applyDirection(l);
      setReady(true);
    })();
  }, []);

  const setLang = useCallback(async (l: Lang) => {
    await AsyncStorage.setItem(STORAGE_KEY, l);
    setLangState(l);
    await applyDirection(l);
  }, []);

  const value = useMemo<Ctx>(() => {
    const dict = DICTS[lang];
    const t = (key: TKey, params?: Record<string, string | number>) => {
      let s = dict[key] ?? en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
      return s;
    };
    const tx = (prefix: string, v: string | null | undefined) => {
      if (!v) return '';
      const k = `${prefix}.${v}` as TKey;
      return dict[k] ?? en[k] ?? v;
    };
    return {
      lang,
      isRTL: lang === 'ar',
      t,
      tx,
      setLang,
      locale: lang === 'ar' ? 'ar-MA-u-nu-latn' : lang === 'fr' ? 'fr-FR' : 'en-GB',
      ready,
    };
  }, [lang, ready, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside provider');
  return ctx;
}

export type { TKey };
