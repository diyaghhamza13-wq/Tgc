// LOCAL TEST HELPER: loads the runner function, sends ONE POST with the trigger
// secret from DLM_TEST_TRIGGER, prints {status, body} and exits. Used to test
// configuration refusals (region, key type, endpoints) without a server.
// deno-lint-ignore no-explicit-any
let handler: any;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: any) => { handler = typeof h === "function" ? h : h.handler; return {}; };
await import("../../backup-runner/supabase/functions/dlm-backup/index.ts");
const res = await handler(new Request("http://local/", {
  method: "POST", headers: { "x-dlm-backup-trigger": Deno.env.get("DLM_TEST_TRIGGER") ?? "", "Content-Type": "application/json" }, body: "{}",
}));
console.log(JSON.stringify({ status: res.status, body: await res.json() }));
