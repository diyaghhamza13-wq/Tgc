// Authenticated employee administration.
// POST { action: "create", employee: {full_name, code, department_id, role_id, specialty?, phone?, email?, pin} }
// POST { action: "reset_pin", employee_id, pin }
// POST { action: "change_own_pin", current_pin, new_pin }
// Authorization is checked against the caller's own session (RLS helpers),
// the privileged work is then performed with the service role.
import {
  adminClient,
  CODE_RE,
  corsHeaders,
  createEmployeeAuthUser,
  fail,
  json,
  PIN_RE,
  readJson,
  userClient,
} from "../_shared/common.ts";

type Body = {
  action?: string;
  employee?: Record<string, string | undefined>;
  employee_id?: string;
  pin?: string;
  current_pin?: string;
  new_pin?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("method_not_allowed", 405);

  const caller = userClient(req);
  const { data: meId, error: meError } = await caller.rpc("current_employee_id");
  if (meError || !meId) return fail("not_authenticated", 401);
  const { data: me, error: meRowError } = await caller
    .from("employees")
    .select("id, lab_id, code, laboratories(code)")
    .eq("id", meId)
    .single();
  if (meRowError || !me) return fail("not_authenticated", 401);

  const body = await readJson<Body>(req);
  if (!body?.action) return fail("missing_fields");
  const admin = adminClient();

  try {
    if (body.action === "change_own_pin") {
      if (!PIN_RE.test(body.new_pin ?? "")) return fail("invalid_pin");
      // deno-lint-ignore no-explicit-any
      const labCode = (me as any).laboratories?.code as string;
      const { data: check, error } = await admin.rpc("verify_employee_pin", {
        p_lab_code: labCode,
        p_employee_code: me.code,
        p_pin: body.current_pin ?? "",
      });
      if (error) throw new Error(error.message);
      if (!(check as { ok: boolean }).ok) return fail((check as { error: string }).error ?? "invalid_credentials", 403);
      const { error: setError } = await admin.rpc("set_employee_pin", { p_employee_id: me.id, p_pin: body.new_pin });
      if (setError) throw new Error(setError.message);
      return json({ ok: true });
    }

    const { data: allowed } = await caller.rpc("has_permission", { p_code: "employees.manage" });
    if (!allowed) return fail("permission_denied", 403);

    if (body.action === "create") {
      const e = body.employee ?? {};
      const code = (e.code ?? "").trim().toUpperCase();
      if (!CODE_RE.test(code)) return fail("invalid_employee_code");
      if ((e.full_name ?? "").trim().length < 2) return fail("invalid_name");
      if (!e.role_id) return fail("role_required");
      if (!PIN_RE.test(e.pin ?? "")) return fail("invalid_pin");

      // role & department must belong to the caller's lab (also enforced by FKs)
      const { data: role } = await caller.from("roles").select("id").eq("id", e.role_id).maybeSingle();
      if (!role) return fail("invalid_role");
      if (e.department_id) {
        const { data: dep } = await caller.from("departments").select("id").eq("id", e.department_id).maybeSingle();
        if (!dep) return fail("invalid_department");
      }

      const { data: newId, error } = await admin.rpc("create_employee_record", {
        p_lab_id: me.lab_id,
        p: { ...e, code },
      });
      if (error) {
        if (error.message.includes("employee_code_taken")) return fail("employee_code_taken", 409);
        throw new Error(error.message);
      }
      try {
        await createEmployeeAuthUser(admin, newId as string, me.lab_id);
      } catch (authErr) {
        await admin.from("employees").delete().eq("id", newId as string);
        throw authErr;
      }
      return json({ employee_id: newId }, 201);
    }

    if (body.action === "reset_pin") {
      if (!body.employee_id) return fail("missing_fields");
      if (!PIN_RE.test(body.pin ?? "")) return fail("invalid_pin");
      // visible through RLS only if in the same lab
      const { data: target } = await caller.from("employees").select("id").eq("id", body.employee_id).maybeSingle();
      if (!target) return fail("employee_not_found", 404);
      const { error } = await admin.rpc("set_employee_pin", { p_employee_id: body.employee_id, p_pin: body.pin });
      if (error) throw new Error(error.message);
      return json({ ok: true });
    }

    return fail("unknown_action");
  } catch (err) {
    console.error("manage-employee", err);
    return fail("server_error", 500);
  }
});
