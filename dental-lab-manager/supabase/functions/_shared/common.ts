// Shared helpers for Dental Lab Manager edge functions.
// The service-role key is only ever available here, on the server.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function fail(code: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return json({ error: code, ...extra }, status);
}

function env(...names: string[]): string {
  for (const n of names) {
    const v = Deno.env.get(n);
    if (v) return v;
  }
  throw new Error(`Missing environment variable: ${names.join(" / ")}`);
}

export const SUPABASE_URL = () => env("SUPABASE_URL");
const ANON_KEY = () => env("SUPABASE_ANON_KEY");
const SERVICE_KEY = () => env("SUPABASE_SERVICE_ROLE_KEY");

const noPersist = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL(), SERVICE_KEY(), noPersist);
}

export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL(), ANON_KEY(), noPersist);
}

/** Client acting as the caller (RLS applies). */
export function userClient(req: Request): SupabaseClient {
  const authorization = req.headers.get("Authorization") ?? "";
  return createClient(SUPABASE_URL(), ANON_KEY(), {
    ...noPersist,
    global: { headers: { Authorization: authorization } },
  });
}

/** Deterministic, non-routable login identifier for an employee's Auth user. */
export function employeeAuthEmail(employeeId: string): string {
  return `${employeeId}@employees.dentallabmanager.app`;
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Create the Supabase Auth user backing an employee and link it.
 * The Auth password is random and never disclosed: employees authenticate
 * with their PIN, which is verified (bcrypt + lockout) in the database.
 */
export async function createEmployeeAuthUser(admin: SupabaseClient, employeeId: string, labId: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email: employeeAuthEmail(employeeId),
    password: randomSecret(),
    email_confirm: true,
    app_metadata: { lab_id: labId, employee_id: employeeId },
  });
  if (error || !data.user) throw new Error(error?.message ?? "auth_user_creation_failed");
  const { error: linkError } = await admin.rpc("link_employee_auth_user", {
    p_employee_id: employeeId,
    p_auth_user_id: data.user.id,
  });
  if (linkError) {
    await admin.auth.admin.deleteUser(data.user.id);
    throw new Error(linkError.message);
  }
  return data.user.id;
}

/** Issue a session for an already-verified employee without exposing a password. */
export async function issueSession(admin: SupabaseClient, employeeId: string) {
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: employeeAuthEmail(employeeId),
  });
  if (error || !link?.properties?.hashed_token) throw new Error(error?.message ?? "link_generation_failed");
  const { data, error: verifyError } = await anonClient().auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (verifyError || !data.session) throw new Error(verifyError?.message ?? "session_creation_failed");
  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
  };
}

export async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export const PIN_RE = /^[0-9]{4,8}$/;
export const CODE_RE = /^[A-Z0-9_-]{2,16}$/;
