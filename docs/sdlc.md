# Software development lifecycle

How Crowd Kit went from an idea to a deployed app in ten days, and how we keep it working. Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/) by Aditya, Ayush and Om. The rules for day-to-day work are in [CONTRIBUTING.md](../CONTRIBUTING.md); this file explains why the process looks the way it does.

## Timeline

| Dates (2026) | Phase | What happened |
|---|---|---|
| Up to Oct 19 | Planning | Read the rules, studied past winners and existing Qloo projects, picked day-of event operations as an uncrowded lane |
| Oct 20 | Design and scaffold | Next.js app, agent loop, Qloo through the hackathon harness (`qloo mcp`), mock and demo modes, frontend, deploy configs, evidence plan |
| Oct 21 | Build against live data | Adapted to real Qloo behaviour, moved the agent to the Gemini free tier, source-honesty checks, cache, site map, evidence page, receipts, "Fill the room" |
| Oct 22–23 | Measure and fix | Coverage check and 8-event with-vs-without-Qloo evaluation; fixed the lookup retry and the demographic filter; re-ran all 8 events |
| Oct 26 | Last features | "Same venue, different crowd" (`/crowds`), exit widths, time-to-get-out check and crush warning |
| Oct 27 | Feature freeze | Bug fixes, docs and submission material only |
| Oct 29 | Qloo sets staffing | Staffing weights computed from Qloo's age profile instead of chosen by the model, after the crowd comparison showed identical staffing for very different crowds |
| Oct 29 | Merge open PRs | Volunteer ratios from the Purple Guide, Green Guide and NFPA 101 (Om, PR #4); Photon fallback for nearby places (PR #2); deploy hook and keep-awake (PR #6); cache warm-up script (PR #5); web search falls back to Wikipedia |
| Oct 29–31 | Release | Final checks, redeploy, demo video, Devpost submission (deadline Oct 31, 9:15am IST) |

## 1. Planning and requirements

**Problem.** People who run gigs, comedy nights and college fests decide food stalls, sponsors, merch, volunteer numbers and site layout from gut feel or last year's notes. Mistakes cost money (empty stalls, sponsors who say no) and safety (crushes and queues).

**Who it's for.** Organisers of a booked show, from the day the act is confirmed to the night itself.

**Requirements we set before writing code:**

| # | Requirement | Where it's met |
|---|---|---|
| R1 | Turn act, venue, date, crowd size and volunteers into an operations plan | `src/lib/agent.ts`, `src/components/PlanView.tsx` |
| R2 | Qloo taste data must change the plan, and we must be able to prove it | "Without Qloo" baseline, `/evidence`, [qloo-evidence.md](qloo-evidence.md) |
| R3 | Every claim shows its source; Qloo claims link to the exact call | `source` on every plan item, receipts |
| R4 | Numbers that matter for safety and money are calculated, not written by the model | `src/lib/tools/staffing.ts`, `src/lib/layout.ts` |
| R5 | Costs nothing to run | Gemini free tier, OpenStreetMap, Open-Meteo, Render free plan |
| R6 | Works for judges without keys or waiting | `/sample`, demo mode, server-side cache |

**Constraints from the hackathon and Qloo's rules:**
- Reach Qloo only through the supported harness. Serverless hosting is not supported, so we deploy one container.
- Each team member uses their own Qloo key. Keys never go in the repo, a client bundle or a screenshot.
- Qloo response data never goes in the repo.
- No personal data is sent to Qloo. Inputs are public venues, acts and themes.

**Out of scope:** ticketing, booking acts, payments, user accounts.

## 2. Design

**Architecture.** One Next.js app. The browser posts the event to `/api/plan`, which streams the agent's live trace and the final plan back as Server-Sent Events. The diagram is in the [README](../README.md#how-it-works).

**Key decisions:**

| Decision | Why |
|---|---|
| **Code computes, the model explains** | Staffing, safety checks and promotion hot spots come from formulas, so they're repeatable and checkable. The model picks and explains. Even the staffing weights come from Qloo's age indices in code, and the final plan always carries the formula's headcounts. |
| **Typed plan contract** (`src/lib/types.ts`, Zod) | The agent must return a valid, sourced plan. `submit_plan` sends validation errors back for it to fix. |
| **Source check in code** | A plan is rejected if it labels something "Qloo" that no Qloo call returned. |
| **Qloo through `qloo mcp`** | It's the supported route, and it gives us typed workflows with clear `ok` / `empty` / `needs_input` results. |
| **Gemini free tier with fallbacks** | Free. Every call has a time limit and falls back through several models when one is overloaded. |
| **Server-side cache outside the repo** | Identical events replay instantly at no cost, and no Qloo data lands in Git. |
| **Mock and demo modes** | Teammates could build the UI before keys arrived, and judges always have something to see. |
| **Site layouts in the browser, shared by link** | No database to run or secure. |

## 3. Implementation

- **Team and ownership:** Aditya owns the agent, Qloo integration and frontend; Om owns research tools, staffing, caching and deploys; Ayush owns Qloo evidence, testing and submission material. The table in [CONTRIBUTING.md](../CONTRIBUTING.md#4-where-things-live) lists files by owner.
- **Branching:** one branch per task (`name/short-topic`), a pull request, and a review by Aditya before merging to `main`. `main` is what we deploy and demo.
- **Shared contract:** changes to `src/lib/types.ts` are announced to the team first, because the agent, API and UI all depend on it.
- **Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS 4, Zod 4, `@google/genai`, the MCP SDK, Leaflet with OpenStreetMap.

## 4. Testing and verification

There is no unit-test suite; we chose to spend the time on checks that show whether the product works. Every change must pass these before it's pushed:

```bash
npx tsc --noEmit    # types
npx eslint src      # lint
npm run build       # production build
```

Beyond that:

| Check | How | Result |
|---|---|---|
| **Qloo coverage** | `scripts/qloo-coverage.ts` resolves the demo acts and venues | Found that typed lookups miss some acts; added an untyped retry |
| **With vs without Qloo** | `scripts/eval-agent.ts` runs 8 real events (US, UK, India; music, comedy, a fest) in both modes and scores each plan | 61% vs 0% of items Qloo-backed, 91% vs 0% tied to a data source; published at `/evidence` |
| **Regression from the evaluation** | The first run showed Qloo asking for clarification 36 times | Traced to a free-text demographic filter; removed it, re-ran all 8 events, down to 2 |
| **Safety maths** | Worked examples through `src/lib/layout.ts` | The Fillmore clears in 3.5 min; 40,000 people through 24 m of exits takes 20 min (needs 61 m); 5,000 people in 1,000 m² triggers the crush warning |
| **Qloo staffing weights** | Applied to the saved Qloo age profiles of 14 acts, then one full Eminem run | An older crowd (Romesh Ranganathan) gets more at the accessibility desk; Phoebe Bridgers gets one more on merch than Eminem at the same venue; the agent passes no weights of its own |
| **Manual runs** | Each feature exercised in the browser on the dev server | |
| **Planners** | Session script in [user-testing.md](user-testing.md) | Not run yet |

## 5. Deployment

- **Build:** the `Dockerfile` builds a standalone Next.js server and installs the `qloo` harness pointed at the hackathon API.
- **Host:** Render, free plan, from `render.yaml`. A Fly.io config (`fly.toml`) is kept as a backup.
- **Secrets:** `GEMINI_API_KEY` and `QLOO_API_KEY` are set in the host dashboard only.
- **Release check:** `GET /api/health` must return `"qloo": "live"`. Then open `/sample`, `/evidence` and `/crowds`.
- **Live app:** https://crowd-kit.onrender.com

## 6. Operations and maintenance

- **Cold starts:** the free plan sleeps after 15 idle minutes, and the first visit takes up to a minute. Before judging, keep it awake with an external ping to `/api/health` and run the demo events once to fill the cache.
- **Cost control:** identical events replay from the cache with no Gemini requests. A new plan uses about 8–12 Gemini requests plus one for the baseline.
- **Known limits:** listed in the [README](../README.md#known-limitations).
- **After the hackathon:** post-event feedback to tune plans, one-click vendor and sponsor outreach, and multi-day festivals.

## Risks we managed

| Risk | What we did |
|---|---|
| Qloo returns `needs_input` or the wrong entity | Pass exact Qloo IDs and tag IDs; record any guess as an assumption the organiser can see |
| The model invents a Qloo-backed claim | Source check in code, plus receipts anyone can open |
| Free-tier Gemini hangs or runs out of quota | Time limits, model fallback chain, network retry, cache |
| OpenStreetMap servers time out | The agent finishes without them and says what's missing |
| Keys or Qloo data leak into Git | `.env*` and the cache are ignored; every push is checked for secrets |
| Judges hit a slow or broken demo | `/sample`, demo mode, the cache and a health check |
