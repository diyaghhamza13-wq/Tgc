import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
export const FUNCTIONS_URL =
  process.env.EXPO_PUBLIC_FUNCTIONS_URL || (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : '');

export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = createClient(SUPABASE_URL || 'http://invalid.local', SUPABASE_ANON_KEY || 'missing', {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

// Refresh tokens only while the app is in the foreground (native).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

export class ApiError extends Error {
  code: string;
  extra: Record<string, unknown>;
  constructor(code: string, extra: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

/** Call an edge function. Throws ApiError with the server's error code. */
export async function callFunction<T>(name: string, body: unknown, withAuth = false): Promise<T> {
  if (!isConfigured) throw new ApiError('not_configured');
  let token = SUPABASE_ANON_KEY;
  if (withAuth) {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new ApiError('not_authenticated');
    token = data.session.access_token;
  }
  let res: Response;
  try {
    res = await fetch(`${FUNCTIONS_URL}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('network_error');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { error, ...extra } = json ?? {};
    throw new ApiError(typeof error === 'string' ? error : 'server_error', extra);
  }
  return json as T;
}

/** Normalise a PostgREST / RPC error into a stable code for translation. */
export function errorCode(e: unknown): string {
  if (!e) return 'unknown_error';
  if (e instanceof ApiError) return e.code;
  const msg = (e as { message?: string }).message ?? String(e);
  const known = msg.match(/\b([a-z]+(?:_[a-z]+)+)\b/);
  if (/at least one active administrator/.test(msg)) return 'last_admin';
  if (/duplicate key/.test(msg)) return 'duplicate';
  if (/violates foreign key/.test(msg)) return 'in_use';
  if (/Failed to fetch|Network request failed/i.test(msg)) return 'network_error';
  return known?.[1] ?? msg;
}

/** Throw if a Supabase response has an error; return its data. */
export function unwrap<T>(res: { data: T | null; error: unknown }): T {
  if (res.error) throw res.error;
  return res.data as T;
}

export function publicAssetUrl(path?: string | null): string | null {
  if (!path) return null;
  return supabase.storage.from('lab-assets').getPublicUrl(path).data.publicUrl;
}
