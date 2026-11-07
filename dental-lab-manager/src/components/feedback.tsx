import { CircleAlert, CircleCheck } from 'lucide-react-native';
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { colors, radius } from '../lib/theme';
import { Button, Field } from './ui';

type PromptOpts = {
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** when set, a text input is shown and its value returned */
  input?: { label: string; required?: boolean; multiline?: boolean; keyboard?: 'default' | 'number-pad'; secure?: boolean };
  /** optional extra content (e.g. pickers) rendered above the buttons */
  render?: () => React.ReactNode;
};

type Ctx = {
  toast: (msg: string, kind?: 'success' | 'error') => void;
  confirm: (opts: PromptOpts) => Promise<boolean>;
  prompt: (opts: PromptOpts) => Promise<string | null>;
};

const FeedbackContext = createContext<Ctx | null>(null);

export function FeedbackProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [toastState, setToast] = useState<{ msg: string; kind: 'success' | 'error' } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dialog, setDialog] = useState<(PromptOpts & { resolve: (v: string | null) => void }) | null>(null);
  const [value, setValue] = useState('');

  const toast = useCallback((msg: string, kind: 'success' | 'error' = 'success') => {
    setToast({ msg, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const prompt = useCallback(
    (opts: PromptOpts) =>
      new Promise<string | null>((resolve) => {
        setValue('');
        setDialog({ ...opts, resolve });
      }),
    [],
  );
  const confirm = useCallback(async (opts: PromptOpts) => (await prompt(opts)) !== null, [prompt]);

  const close = (v: string | null) => {
    dialog?.resolve(v);
    setDialog(null);
  };
  const canSubmit = !dialog?.input?.required || value.trim().length > 0;

  return (
    <FeedbackContext.Provider value={{ toast, confirm, prompt }}>
      {children}
      {toastState ? (
        <View pointerEvents="none" style={styles.toastWrap}>
          <View style={[styles.toast, toastState.kind === 'error' && { borderColor: colors.error }]}>
            {toastState.kind === 'success' ? <CircleCheck color={colors.success} size={18} /> : <CircleAlert color={colors.error} size={18} />}
            <Text style={styles.toastText}>{toastState.msg}</Text>
          </View>
        </View>
      ) : null}
      <Modal visible={!!dialog} transparent animationType="fade" onRequestClose={() => close(null)}>
        <Pressable style={styles.backdrop} onPress={() => close(null)}>
          <Pressable style={styles.dialog} onPress={() => {}}>
            <Text style={styles.title}>{dialog?.title}</Text>
            {dialog?.message ? <Text style={styles.message}>{dialog.message}</Text> : null}
            {dialog?.render?.()}
            {dialog?.input ? (
              <Field
                label={dialog.input.label}
                value={value}
                onChangeText={setValue}
                multiline={dialog.input.multiline}
                keyboardType={dialog.input.keyboard}
                secure={dialog.input.secure}
                autoFocus
                required={dialog.input.required}
              />
            ) : null}
            <View style={styles.actions}>
              <Button title={t('c.cancel')} variant="dark" onPress={() => close(null)} style={{ flex: 1 }} small />
              <Button
                title={dialog?.confirmLabel ?? t('c.confirm')}
                variant={dialog?.danger ? 'danger' : 'gold'}
                disabled={!canSubmit}
                onPress={() => close(dialog?.input ? value.trim() : 'ok')}
                style={{ flex: 1 }}
                small
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback outside provider');
  return ctx;
}

const styles = StyleSheet.create({
  toastWrap: { position: 'absolute', top: 54, left: 0, right: 0, alignItems: 'center', zIndex: 1000 },
  toast: { flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: colors.bg2, borderColor: colors.gold, borderWidth: 1, borderRadius: radius.pill, paddingVertical: 10, paddingHorizontal: 18, maxWidth: '92%' },
  toastText: { color: colors.white, fontWeight: '600', flexShrink: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', padding: 20 },
  dialog: { backgroundColor: colors.card, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.gold, padding: 20, gap: 12, width: '100%', maxWidth: 480, alignSelf: 'center' },
  title: { color: colors.white, fontSize: 18, fontWeight: '800' },
  message: { color: colors.muted, fontSize: 15 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
});

/** Modal with arbitrary form content controlled by the parent screen. */
export function FormModal({
  visible,
  title,
  children,
  onClose,
  onSubmit,
  submitLabel,
  danger,
  busy,
  disabled,
}: {
  visible: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={busy ? undefined : onClose}>
        <Pressable style={[styles.dialog, { maxHeight: '90%' }]} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 4 }}>
            {children}
          </ScrollView>
          <View style={styles.actions}>
            <Button title={t('c.cancel')} variant="dark" onPress={onClose} disabled={busy} style={{ flex: 1 }} small />
            <Button title={submitLabel} variant={danger ? 'danger' : 'gold'} onPress={onSubmit} loading={busy} disabled={disabled} style={{ flex: 1 }} small />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
