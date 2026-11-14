// LOCAL TEST main service for the real Supabase Edge Runtime (docker image
// supabase/edge-runtime): runs backup-runner/supabase/functions/dlm-backup (mounted at
// /fn) as a USER WORKER with the hosted Edge Function limits — 256 MB memory, 2 s CPU
// time (hard), 150 s wall clock — one worker per request (--policy per_request).
// Passes through only the DLM_* and SUPABASE_* variables the function may read.
const allowed = (k: string) => k.startsWith("DLM_") || k.startsWith("SUPABASE_");
Deno.serve(async (req: Request) => {
  try {
    // deno-lint-ignore no-explicit-any
    const worker = await (globalThis as any).EdgeRuntime.userWorkers.create({
      servicePath: "/fn",
      memoryLimitMb: 256,
      workerTimeoutMs: 150_000,
      cpuTimeSoftLimitMs: 2_000,
      cpuTimeHardLimitMs: 2_000,
      noModuleCache: false,
      envVars: Object.entries(Deno.env.toObject()).filter(([k]) => allowed(k)),
      forceCreate: true,
    });
    return await worker.fetch(req);
  } catch (e) {
    console.error(`main: worker error: ${e}`);
    return new Response(JSON.stringify({ error: "worker_error", detail: String(e).slice(0, 300) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
