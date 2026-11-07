// POST { lab_code, employee_code, pin } -> { session, employee_id }
// Verifies the PIN in the database (bcrypt, 5-attempt lockout) and issues a
// Supabase Auth session for the employee.
import {
  adminClient,
  corsHeaders,
  createEmployeeAuthUser,
  fail,
  issueSession,
  json,
  readJson,
} from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("method_not_allowed", 405);

  const body = await readJson<{ lab_code?: string; employee_code?: string; pin?: string }>(req);
  const labCode = body?.lab_code?.trim().toUpperCase() ?? "";
  const employeeCode = body?.employee_code?.trim().toUpperCase() ?? "";
  const pin = body?.pin ?? "";
  if (!labCode || !employeeCode || !pin) return fail("missing_fields");

  try {
    const admin = adminClient();
    const { data, error } = await admin.rpc("verify_employee_pin", {
      p_lab_code: labCode,
      p_employee_code: employeeCode,
      p_pin: pin,
    });
    if (error) throw new Error(error.message);
    const result = data as {
      ok: boolean;
      error?: string;
      employee_id?: string;
      auth_user_id?: string | null;
      attempts_left?: number;
      locked_until?: string;
    };
    if (!result.ok) {
      const status = result.error === "invalid_credentials" ? 401 : 403;
      return fail(result.error ?? "invalid_credentials", status, {
        attempts_left: result.attempts_left,
        locked_until: result.locked_until,
      });
    }

    // Self-heal: an employee created without an Auth user gets one now.
    if (!result.auth_user_id) {
      const { data: emp } = await admin.from("employees").select("lab_id").eq("id", result.employee_id!).single();
      await createEmployeeAuthUser(admin, result.employee_id!, emp!.lab_id);
    }

    const session = await issueSession(admin, result.employee_id!);
    return json({ session, employee_id: result.employee_id });
  } catch (e) {
    console.error("employee-login", e);
    return fail("server_error", 500);
  }
});
