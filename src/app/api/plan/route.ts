import { runBaseline, runCrowdKit } from "@/lib/agent";
import { DEMO_BASELINE, DEMO_PLAN, DEMO_TRACE } from "@/lib/demo";
import { readCached, writeCached } from "@/lib/cache";
import { EventInputSchema, type AgentEvent, type Plan } from "@/lib/types";

interface SavedRun {
  events: AgentEvent[];
  plan: Plan;
}

// The agent makes many tool calls; give it room. (Vercel caps this by plan.)
export const maxDuration = 300;

// POST /api/plan?mode=qloo|baseline  body: EventInput
// Streams AgentEvents as Server-Sent Events.
export async function POST(request: Request) {
  const mode = new URL(request.url).searchParams.get("mode") === "baseline" ? "baseline" : "qloo";
  const parsed = EventInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: parsed.error.issues }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream({
    // If the browser goes away (refresh, closed tab), keep working and save the
    // plan, so re-submitting the same event replays it instantly.
    cancel() {
      open = false;
    },
    async start(controller) {
      const emit = (e: AgentEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };
      try {
        if (process.env.CROWDKIT_DEMO === "1") {
          // Frontend development without keys: replay canned events with small delays.
          if (mode === "qloo") {
            for (const e of DEMO_TRACE) {
              emit(e);
              await new Promise((r) => setTimeout(r, 350));
            }
          }
          emit({ type: "plan", plan: mode === "baseline" ? DEMO_BASELINE : DEMO_PLAN, mode });
          return;
        }
        // Same event submitted before? Replay the saved run: no Gemini requests, so the
        // free-tier daily limit is only spent on new events. (Server-side only, never committed.)
        // Bump the version when a change alters plans, so old saved runs aren't replayed.
        const runKey = mode === "qloo" ? "run-qloo-v2" : "run-baseline";
        const saved = await readCached<SavedRun>(runKey, parsed.data);
        if (saved) {
          emit({ type: "status", message: "Saved plan for this exact event (no new AI requests)" });
          for (const e of saved.events) {
            emit(e);
            await new Promise((r) => setTimeout(r, 120));
          }
          emit({ type: "plan", plan: saved.plan, mode });
          return;
        }

        const events: AgentEvent[] = [];
        const record = (e: AgentEvent) => {
          events.push(e);
          emit(e);
        };
        const plan = mode === "baseline" ? await runBaseline(parsed.data) : await runCrowdKit(parsed.data, record);
        // Only clean runs are replayed: if a tool failed, the next request for this event tries again.
        const failed = events.some((e) => (e.type === "tool_result" && e.status === "error") || (e.type === "status" && /failed; continuing without it/.test(e.message)));
        if (!failed) await writeCached(runKey, parsed.data, { events, plan } satisfies SavedRun);
        emit({ type: "plan", plan, mode });
      } catch (err) {
        console.error(err);
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (open) controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
