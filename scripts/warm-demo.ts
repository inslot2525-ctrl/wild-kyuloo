// Warm a running Crowd Kit server so judges never wait on a cold start.
//
//   npx tsx scripts/warm-demo.ts                              # http://localhost:3000
//   npx tsx scripts/warm-demo.ts https://crowd-kit.fly.dev    # a deployed server
//   npx tsx scripts/warm-demo.ts <url> --baseline             # also warm "Without Qloo"
//
// It checks /api/health (which also starts `qloo mcp`), then runs each sample
// event in src/lib/presets.ts through /api/plan. Tool results land in that
// server's cache, so the next run of a sample skips Qloo, OSM and weather calls.
// Run it after every deploy. EACH RUN COSTS REAL MONEY unless the server is in demo mode.

import { PRESETS } from "../src/lib/presets";
import type { AgentEvent } from "../src/lib/types";

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:3000").replace(/\/$/, "");
const modes = args.includes("--baseline") ? (["qloo", "baseline"] as const) : (["qloo"] as const);

async function run(input: unknown, mode: string) {
  const started = Date.now();
  const res = await fetch(`${base}/api/plan?mode=${mode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  let calls = 0, cachedHits = 0, failed = 0, buffer = "";
  let outcome: string | null = null;
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    buffer += decoder.decode(r.value, { stream: true });
    const messages = buffer.split("\n\n");
    buffer = messages.pop() ?? "";
    for (const m of messages) {
      if (!m.startsWith("data: ")) continue;
      const e = JSON.parse(m.slice(6)) as AgentEvent;
      if (e.type === "tool_result") {
        calls++;
        if (e.cached) cachedHits++;
        if (e.status === "error") failed++;
      } else if (e.type === "plan") outcome = "plan";
      else if (e.type === "error") outcome = `error: ${e.message}`;
    }
  }
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  return { ok: outcome === "plan", line: `${outcome ?? "stream ended without a plan"} · ${secs}s · ${calls} tool results (${cachedHits} cached, ${failed} failed)` };
}

(async () => {
  // /api/health is optional (older builds lack it); a server that doesn't answer at all is fatal.
  const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(60_000) }).catch((e) => {
    console.error(`${base} is not reachable: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
  const health = res.ok ? await res.json() : null;
  console.log(`${base}/api/health`, health ? JSON.stringify(health) : `HTTP ${res.status} (no health endpoint; continuing)`);
  if (health?.qloo === "mock" && !health.demo) console.warn("! Qloo is in mock mode: this warms mock results, not real ones.");

  let allOk = true;
  for (const p of PRESETS) {
    for (const mode of modes) {
      try {
        const r = await run(p.input, mode);
        allOk &&= r.ok;
        console.log(`${r.ok ? "ok  " : "FAIL"} ${p.name} [${mode}] ${r.line}`);
      } catch (err) {
        allOk = false;
        console.log(`FAIL ${p.name} [${mode}] ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  process.exit(allOk ? 0 : 1);
})();
