"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import type { ActLookup, ActMatch } from "@/lib/act";
import { streamPlan } from "@/lib/planStream";
import { PRESETS } from "@/lib/presets";
import type { AgentEvent, EventInput, Plan } from "@/lib/types";
import { AgentTrace } from "./AgentTrace";
import { Compare } from "./Compare";
import { EventForm } from "./EventForm";
import { PlanView } from "./PlanView";
import { Callout, Icon, SourceLegend } from "./ui";

type Mode = "qloo" | "baseline";
type View = "plan" | "compare" | "baseline";

// Posts the event, reads AgentEvents over SSE, and lays out hero -> trace -> dashboard.
export function CrowdKit() {
  const [form, setForm] = useState<EventInput>(PRESETS[0].input);
  const [act, setAct] = useState<ActMatch | null>(null);
  // Snapshot of what was submitted, so editing the form doesn't change the dashboard header.
  const [submitted, setSubmitted] = useState<{ event: EventInput; act: ActMatch | null } | null>(null);
  const [trace, setTrace] = useState<AgentEvent[]>([]);
  const [plans, setPlans] = useState<Partial<Record<Mode, Plan>>>({});
  const [view, setView] = useState<View>("plan");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  async function run(mode: Mode) {
    await streamPlan(form, mode, (event) => {
      if (event.type === "plan") setPlans((p) => ({ ...p, [event.mode]: event.plan }));
      else if (event.type === "error") setError(event.message);
      else if (mode === "qloo") setTrace((t) => [...t, event]);
    });
  }

  // A photo that arrives after submitting (the lookup was still running on a slow
  // server) still belongs on the plan's header.
  function changeAct(a: ActMatch | null) {
    setAct(a);
    setSubmitted((s) => (s && !s.act && a?.image && sameAct(s.event.act, a.name) ? { ...s, act: a } : s));
  }

  async function findPhoto(name: string) {
    try {
      const res = await fetch(`/api/act?q=${encodeURIComponent(name)}&type=artist`);
      const data = (await res.json()) as ActLookup;
      if (data.match?.image) changeAct(data.match);
    } catch {
      // no photo: the initials fallback is fine
    }
  }

  async function submit() {
    setRunning(true);
    setError(null);
    setTrace([]);
    setPlans({});
    setView("plan");
    setSubmitted({ event: form, act });
    if (!act) findPhoto(form.act);
    requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    try {
      // Both at once: the comparison is the point.
      await Promise.all([run("qloo"), run("baseline")]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const started = running || trace.length > 0 || plans.qloo || plans.baseline || error;
  const shownPlan = view === "plan" ? plans.qloo : view === "baseline" ? plans.baseline : undefined;

  return (
    <>
      {/* Hero: the act's photo becomes the backdrop once found */}
      <div className="no-print relative isolate overflow-hidden">
        <div aria-hidden="true" className="absolute inset-0 -z-10">
          {act?.image ? (
            // Soft colour wash from the photo; the sharp version is the poster card below.
            <div className="absolute inset-0 scale-105 bg-cover bg-[center_25%] opacity-50 blur-xl transition-opacity duration-700" style={{ backgroundImage: `url("${act.image}")` }} />
          ) : (
            <div className="absolute inset-0 bg-[radial-gradient(60%_50%_at_10%_0%,var(--qloo-wash),transparent),radial-gradient(40%_40%_at_90%_10%,color-mix(in_oklab,var(--volt)_25%,transparent),transparent)]" />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-page/40 via-page/70 to-page" />
        </div>

        <header className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6">
          <span className="flex items-center gap-2 font-display text-lg font-bold tracking-tight text-ink">
            <span className="grid size-8 place-items-center rounded-xl bg-volt text-sm font-black text-volt-ink">CK</span>
            Crowd Kit
          </span>
          <nav className="flex items-center gap-4 text-sm">
            <Link href="/crowds" className="text-ink-2 hover:text-ink">Compare crowds</Link>
            <Link href="/sample" className="text-ink-2 hover:text-ink">Sample plan</Link>
            <Link href="/evidence" className="text-ink-2 hover:text-ink">Evidence</Link>
            <a href="https://github.com/inslot2525-ctrl/wild-kyuloo" target="_blank" rel="noreferrer" className="text-ink-2 hover:text-ink">GitHub</a>
          </nav>
        </header>

        <section className="mx-auto grid w-full max-w-7xl items-start gap-10 px-4 pb-16 pt-8 sm:px-6 lg:grid-cols-[1fr_1.1fr] lg:pt-14">
          <div className="lg:sticky lg:top-10">
            <p className="inline-flex items-center gap-1.5 rounded-full border border-qloo/30 bg-qloo-wash px-3 py-1 text-xs font-semibold text-qloo">
              <Icon name="spark" className="size-3.5" /> Powered by Qloo taste data
            </p>
            <h1 className="mt-5 font-display text-5xl font-bold leading-[1.02] tracking-tight text-ink sm:text-6xl">
              Plan the night around the crowd that&apos;s{" "}
              {/* Dark text on lime reads in both themes */}
              <span className="inline-block -rotate-1 whitespace-nowrap rounded-2xl bg-volt px-3 pb-1 text-volt-ink">actually</span>{" "}
              coming.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-2">
              Drop in the act, the venue and your volunteer count. Crowd Kit reads the room with Qloo, then hands you food,
              sponsors, merch, staffing and a to-do list built around your crowd.
            </p>
            <div className={`mt-8 ${act?.image ? "flex flex-col gap-6 sm:flex-row sm:items-center" : ""}`}>
            {act?.image && (
              // Sharp "gig poster" of the act, so the face is actually visible.
              <figure key={act.image} className="animate-row-in relative w-44 shrink-0 rotate-2 sm:w-52">
                {/* eslint-disable-next-line @next/next/no-img-element -- remote photo from Qloo/Wikipedia */}
                <img src={act.image} alt={act.name} className="aspect-[4/5] w-full rounded-3xl object-cover object-[center_20%] shadow-2xl shadow-black/40 ring-4 ring-surface" />
                <figcaption className="absolute -bottom-3 left-3 right-3 rounded-2xl bg-volt px-3 py-1.5 text-center font-display text-sm font-bold text-volt-ink shadow-lg">
                  Now planning: {act.name}
                </figcaption>
              </figure>
            )}
            <ul className={`grid gap-3 text-[15px] text-ink ${act?.image ? "" : "sm:grid-cols-2"}`}>
              {[
                ["users", "Who's coming and what they love"],
                ["food", "Stalls and real local vendors"],
                ["star", "Sponsors with ready-to-send pitches"],
                ["list", "A to-do list your team can tick off"],
              ].map(([icon, text]) => (
                <li key={text} className="flex items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-xl border border-hair bg-glass text-ink-2 backdrop-blur">
                    <Icon name={icon} className="size-4" />
                  </span>
                  {text}
                </li>
              ))}
            </ul>
            </div>
          </div>
          <EventForm value={form} onChange={setForm} onSubmit={submit} running={running} act={act} onActChange={changeAct} />
        </section>
      </div>

      {/* Results */}
      <main ref={resultsRef} className="mx-auto w-full max-w-7xl scroll-mt-4 px-4 sm:px-6">
        {started && (
          <div className="grid gap-6 pb-10">
            {error && <Callout tone="critical">{error}</Callout>}

            {/* While the agent works, the live trace is the main event */}
            {!plans.qloo && (
              <div className="grid items-start gap-6 lg:grid-cols-[24rem_1fr]">
                <AgentTrace events={trace} running={running} />
                {!error && <PlanSkeleton />}
              </div>
            )}

            {(plans.qloo || plans.baseline) && (
              <>
                <div className="no-print flex flex-wrap items-center justify-between gap-3">
                  <div role="tablist" className="inline-flex flex-wrap rounded-2xl border border-hair bg-surface p-1">
                    <Tab active={view === "plan"} onClick={() => setView("plan")} ready={!!plans.qloo}>
                      <Icon name="spark" className="size-3.5" /> Your plan
                    </Tab>
                    <Tab active={view === "compare"} onClick={() => setView("compare")} ready={!!plans.qloo && !!plans.baseline}>
                      With vs without Qloo
                    </Tab>
                    <Tab active={view === "baseline"} onClick={() => setView("baseline")} ready={!!plans.baseline}>
                      Generic AI plan
                    </Tab>
                  </div>
                  {plans.qloo && submitted && (
                    <Link
                      href={crowdsLink(submitted.event)}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-hair bg-surface px-3 py-2 text-sm font-medium text-ink-2 hover:border-ink hover:text-ink"
                    >
                      <Icon name="users" /> Try another crowd at this venue
                    </Link>
                  )}
                  {plans.qloo && (
                    <button
                      onClick={() => window.print()}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-hair bg-surface px-3 py-2 text-sm font-medium text-ink-2 hover:border-ink hover:text-ink"
                    >
                      <Icon name="print" /> Save as PDF
                    </button>
                  )}
                </div>

                {view === "compare" ? (
                  <Compare withQloo={plans.qloo} without={plans.baseline} />
                ) : shownPlan ? (
                  <>
                    {view === "baseline" && (
                      <Callout tone="info">This is what a general-purpose AI suggests with no audience data. Compare it with your plan.</Callout>
                    )}
                    <PlanView plan={shownPlan} event={submitted?.event} act={submitted?.act} showNav={view === "plan"} />
                  </>
                ) : (
                  <PlanSkeleton />
                )}

                {trace.length > 0 && (
                  <details className="no-print group rounded-3xl border border-hair bg-surface">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-5 font-display text-base font-semibold text-ink">
                      How Crowd Kit built this plan
                      <span className="text-sm font-normal text-muted group-open:hidden">Show the agent&apos;s steps</span>
                    </summary>
                    <div className="px-2 pb-2">
                      <AgentTrace events={trace} running={running} />
                    </div>
                  </details>
                )}
                <SourceLegend />
              </>
            )}
          </div>
        )}
      </main>
    </>
  );
}

// Opens /crowds with this event's venue and numbers (public event details only, no personal data).
function crowdsLink(e: EventInput) {
  const q = new URLSearchParams({ act: e.act, venue: e.venue, date: e.date, startTime: e.startTime, durationHours: String(e.durationHours), attendance: String(e.attendance), volunteers: String(e.volunteers) });
  if (e.budget) q.set("budget", e.budget);
  if (e.foodStalls !== undefined) q.set("foodStalls", String(e.foodStalls));
  return `/crowds?${q}`;
}

function Tab({ active, ready, onClick, children }: { active: boolean; ready: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold transition ${active ? "bg-ink text-page" : "text-ink-2 hover:text-ink"}`}
    >
      {children}
      {!ready && <span className="size-1.5 animate-pulse rounded-full bg-current opacity-60" />}
    </button>
  );
}

function PlanSkeleton() {
  return (
    <div className="grid gap-5" aria-hidden="true">
      <div className="h-40 animate-pulse rounded-[2rem] bg-surface-2" />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="h-56 animate-pulse rounded-3xl bg-surface-2 lg:col-span-2" />
        <div className="h-56 animate-pulse rounded-3xl bg-surface-2" />
      </div>
      <div className="h-64 animate-pulse rounded-3xl bg-surface-2" />
    </div>
  );
}

const sameAct = (typed: string, found: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return norm(typed).includes(norm(found)) || norm(found).includes(norm(typed));
};
