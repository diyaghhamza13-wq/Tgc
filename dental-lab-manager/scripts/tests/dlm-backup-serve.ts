// LOCAL TEST HELPER: serves supabase/functions/dlm-backup on DLM_TEST_PORT
// (0.0.0.0, so the local database container can call it for the pg_cron test).
// Run with an explicit Deno permission allow-list (see the test script): the
// function can read ONLY the environment variables it is given.
const port = Number(Deno.env.get("DLM_TEST_PORT") ?? "54401");
// deno-lint-ignore no-explicit-any
let handler: any;
const realServe = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: any) => { handler = typeof h === "function" ? h : h.handler; return {}; };
await import("../../supabase/functions/dlm-backup/index.ts");
realServe({ port, hostname: "0.0.0.0", onListen: () => console.log(`dlm-backup test server on :${port}`) }, (req) => handler(req));
