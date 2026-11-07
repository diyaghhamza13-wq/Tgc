import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Session } from '@supabase/supabase-js';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { callFunction, supabase, unwrap } from './supabase';
import type { Department, Employee, Lab, Role } from './types';

export type LoginLab = {
  id: string;
  code: string;
  name: string;
  logo_path: string | null;
  employees: {
    code: string;
    full_name: string;
    avatar_path: string | null;
    department_code: string | null;
    department_name: string | null;
    role_name: string;
  }[];
};

export type Me = Employee & { lab: Lab; department: Department | null; role: Role; permissions: string[] };

type Ctx = {
  session: Session | null;
  me: Me | null;
  loading: boolean;
  loginLab: LoginLab | null;
  lastLabCode: string | null;
  lookupLab: (code: string) => Promise<LoginLab | null>;
  login: (labCode: string, employeeCode: string, pin: string) => Promise<void>;
  registerLab: (body: Record<string, unknown>) => Promise<void>;
  logout: () => Promise<void>;
  reloadMe: () => Promise<void>;
  can: (perm: string) => boolean;
  unread: number;
  refreshUnread: () => Promise<void>;
};

const AuthContext = createContext<Ctx | null>(null);
const LAST_LAB = 'dlm.lastLab';

async function loadMe(): Promise<Me | null> {
  const id = unwrap(await supabase.rpc('current_employee_id')) as string | null;
  if (!id) return null;
  const emp = unwrap(
    await supabase
      .from('employees')
      .select('*, lab:laboratories(*), department:departments(*), role:roles(*)')
      .eq('id', id)
      .single(),
  ) as unknown as Me;
  const permissions = (unwrap(await supabase.rpc('my_permissions')) as string[]) ?? [];
  return { ...emp, permissions };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginLab, setLoginLab] = useState<LoginLab | null>(null);
  const [lastLabCode, setLastLabCode] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const meRef = useRef<Me | null>(null);
  meRef.current = me;

  const refreshUnread = useCallback(async () => {
    const { count } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null);
    setUnread(count ?? 0);
  }, []);

  const reloadMe = useCallback(async () => {
    try {
      const m = await loadMe();
      setMe(m);
      if (!m) await supabase.auth.signOut();
    } catch {
      // network problem: keep the current profile, the UI shows errors per screen
    }
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(LAST_LAB).then(setLastLabCode);
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      if (data.session) await reloadMe();
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_OUT') setMe(null);
    });
    return () => sub.subscription.unsubscribe();
  }, [reloadMe]);

  // Realtime unread badge
  useEffect(() => {
    if (!me) return;
    refreshUnread();
    const ch = supabase
      .channel(`notif-${me.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${me.id}` },
        () => refreshUnread(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [me, refreshUnread]);

  const lookupLab = useCallback(async (code: string) => {
    const data = unwrap(await supabase.rpc('get_lab_login_info', { p_code: code.trim().toUpperCase() })) as LoginLab | null;
    setLoginLab(data);
    if (data) {
      await AsyncStorage.setItem(LAST_LAB, data.code);
      setLastLabCode(data.code);
    }
    return data;
  }, []);

  const establish = useCallback(async (s: { access_token: string; refresh_token: string }) => {
    const { error } = await supabase.auth.setSession(s);
    if (error) throw error;
    const m = await loadMe();
    setMe(m);
  }, []);

  const login = useCallback(
    async (labCode: string, employeeCode: string, pin: string) => {
      const res = await callFunction<{ session: { access_token: string; refresh_token: string } }>('employee-login', {
        lab_code: labCode,
        employee_code: employeeCode,
        pin,
      });
      await establish(res.session);
    },
    [establish],
  );

  const registerLab = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await callFunction<{ session: { access_token: string; refresh_token: string } }>('register-lab', body);
      const code = (body.lab as { code: string }).code.toUpperCase();
      await AsyncStorage.setItem(LAST_LAB, code);
      setLastLabCode(code);
      await establish(res.session);
    },
    [establish],
  );

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    setMe(null);
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      session,
      me,
      loading,
      loginLab,
      lastLabCode,
      lookupLab,
      login,
      registerLab,
      logout,
      reloadMe,
      can: (p: string) => !!me?.permissions.includes(p),
      unread,
      refreshUnread,
    }),
    [session, me, loading, loginLab, lastLabCode, lookupLab, login, registerLab, logout, reloadMe, unread, refreshUnread],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside provider');
  return ctx;
}
