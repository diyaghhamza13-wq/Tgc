// POST { lab: {code, name, phone?, email?, address?, city?, country?},
//        admin: {full_name, code, pin, preferred_language?},
//        registration_key? }
// Creates a laboratory with its default configuration and first administrator,
// then returns a session for that administrator.
// If the LAB_REGISTRATION_KEY secret is set, it must be supplied (lets the
// platform operator restrict who can open new laboratories).
import {
  adminClient,
  CODE_RE,
  corsHeaders,
  createEmployeeAuthUser,
  fail,
  issueSession,
  json,
  PIN_RE,
  readJson,
} from "../_shared/common.ts";

type Body = {
  lab?: Record<string, string | undefined>;
  admin?: Record<string, string | undefined>;
  registration_key?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("method_not_allowed", 405);

  const body = await readJson<Body>(req);
  if (!body?.lab || !body?.admin) return fail("missing_fields");

  const requiredKey = Deno.env.get("LAB_REGISTRATION_KEY");
  if (requiredKey && body.registration_key !== requiredKey) return fail("registration_key_invalid", 403);

  const labCode = (body.lab.code ?? "").trim().toUpperCase();
  const labName = (body.lab.name ?? "").trim();
  const adminName = (body.admin.full_name ?? "").trim();
  const adminCode = (body.admin.code ?? "ADMIN01").trim().toUpperCase();
  const pin = body.admin.pin ?? "";

  if (!/^[A-Z0-9]{3,12}$/.test(labCode)) return fail("invalid_lab_code");
  if (labName.length < 2) return fail("invalid_lab_name");
  if (adminName.length < 2) return fail("invalid_admin_name");
  if (!CODE_RE.test(adminCode)) return fail("invalid_employee_code");
  if (!PIN_RE.test(pin)) return fail("invalid_pin");

  const admin = adminClient();
  let labId: string | undefined;
  try {
    const { data, error } = await admin.rpc("provision_laboratory", {
      p_lab: { ...body.lab, code: labCode, name: labName },
      p_admin: { ...body.admin, code: adminCode, full_name: adminName, pin },
    });
    if (error) {
      if (error.message.includes("lab_code_taken")) return fail("lab_code_taken", 409);
      if (error.message.includes("invalid_")) return fail(error.message.match(/invalid_\w+/)![0]);
      throw new Error(error.message);
    }
    const { lab_id, employee_id } = data as { lab_id: string; employee_id: string };
    labId = lab_id;
    await createEmployeeAuthUser(admin, employee_id, lab_id);
    const session = await issueSession(admin, employee_id);
    return json({ lab_id, employee_id, session }, 201);
  } catch (e) {
    console.error("register-lab", e);
    // compensate: never leave a half-created laboratory behind
    if (labId) await admin.from("laboratories").delete().eq("id", labId);
    return fail("server_error", 500);
  }
});
