// LOCAL TEST HELPER: serves backup-runner/supabase/functions/dlm-backup on
// DLM_TEST_PORT (0.0.0.0, so the local runner database container can call it for
// the pg_cron test). Run with an explicit Deno permission allow-list (see the
// test script): the function can read ONLY the environment variables it is given.
// Logs the x-region header of each request (the scheduling test checks it).
const port = Number(Deno.env.get("DLM_TEST_PORT") ?? "54401");
// deno-lint-ignore no-explicit-any
let handler: any;
const realServe = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (h: any) => { handler = typeof h === "function" ? h : h.handler; return {}; };
await import("../../backup-runner/supabase/functions/dlm-backup/index.ts");
// Memory sampling per request (test only): peak V8 heap + external buffers (ArrayBuffers),
// the memory an Edge Function worker is limited on.
realServe({ port, hostname: "0.0.0.0", onListen: () => console.log(`dlm-backup test server on :${port}`) }, async (req) => {
  console.log(`test-serve: request x-region=${req.headers.get("x-region") ?? "none"}`);
  // deno-lint-ignore no-explicit-any
  (globalThis as any).gc?.();
  let peakHeap = 0, peakExt = 0, peakSum = 0;
  const sample = () => { const m = Deno.memoryUsage(); peakHeap = Math.max(peakHeap, m.heapUsed); peakExt = Math.max(peakExt, m.external); peakSum = Math.max(peakSum, m.heapUsed + m.external); };
  const t = setInterval(sample, 5);
  try { return await handler(req); } finally {
    sample(); clearInterval(t);
    const mb = (b: number) => (b / 1048576).toFixed(0);
    console.log(`test-serve: memory peakHeapMB=${mb(peakHeap)} peakExternalMB=${mb(peakExt)} peakHeapPlusExternalMB=${mb(peakSum)}`);
  }
});
