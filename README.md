# Crowd Kit

**Plan your event around the crowd that's actually coming.**

Event planners tell Crowd Kit their venue, act or theme, date, expected attendance and number of volunteers. An AI agent then researches:

- **Who is coming**, using [Qloo](https://qloo.com)'s taste graph: the act's audience by age and gender, and the cuisines, brands and artists they love. This is combined with the taste of the neighbourhood around the venue.
- **Where they are going**: venue capacity, entrances, house rules, transit, parking, nearby food, past events and the weather.

It returns a ready-to-use operations plan:

- **Food and drink:** which stalls to have, and named local vendors to invite.
- **Sponsors and merch:** brands whose fans overlap the crowd, with a pitch for each.
- **Volunteers:** stations and shifts from a fixed formula based on published crowd-safety guidance (Purple Guide, Green Guide, NFPA 101), weighted in code by Qloo's age profile.
- **Vibe:** a pre-show playlist and theme ideas.

- **Site map with safety checks:** crowd density with a crush warning, the time to get everyone out through the exits (and with the widest one blocked), and an AI layout review.
- **Same venue, different crowd:** plan two acts at one venue and see exactly what changes on the night.

Every line shows its source, and every Qloo-backed claim links to a receipt for the exact Qloo call. A **"Without Qloo"** view shows the same plan from an LLM alone, so you can see what the taste data changes. Across 8 real events, **61%** of plan items came from Qloo taste data (vs 0% without it), and 91% were tied to a data source (vs 0%).

**Try it:** [live app](https://crowd-kit.onrender.com) (free hosting: the first load can take up to a minute to wake) · [finished sample plan](https://crowd-kit.onrender.com/sample) · [evidence](https://crowd-kit.onrender.com/evidence) · [same venue, different crowd](https://crowd-kit.onrender.com/crowds)

Built for the [Qloo Agentic Hackathon](https://qloo.devpost.com/) by Aditya, Ayush and Om.

How we planned, built, tested and deployed it: [docs/sdlc.md](docs/sdlc.md).

## Running locally

Requires **Node.js 22.19 or newer**.

```bash
# 1. Qloo's event harness (the supported way to reach Qloo; see qloo/qloo-hackathon-kit)
npm install --global @qloo/qloo-harness
qloo config set base-url https://hackathon.api.qloo.com   # hackathon keys are rejected by the default (production) server
qloo setup --qloo            # paste the event credential once; it stays in qloo's private config
qloo setup --status

# 2. The app
npm install
cp .env.example .env.local   # add GEMINI_API_KEY (free: https://aistudio.google.com/apikey)
npm run dev                  # http://localhost:3000
```

| Variable | Required | Notes |
|---|---|---|
| `GEMINI_API_KEY` | yes | Gemini runs the agent loop (free tier: `gemini-3.5-flash-lite` by default, web search via `gemini-2.5-flash`). Identical events are replayed from a server-side cache, so they use no requests |
| `QLOO_API_KEY` | on servers | Locally, `qloo setup --qloo` is enough. With no usable credential, or without `qloo` installed, Qloo tools return clearly labelled **mock** data. |
| `CROWDKIT_CACHE_DIR` | no | Where the response cache is written (default: the OS temp folder, `crowdkit-cache`; kept out of the project so the dev server doesn't reload). Docker image sets `/app/.cache`. |
| `QLOO_BASE_URL`, `QLOO_TRUSTED_BASE_URL` | set in the image | Hackathon keys only work on `https://hackathon.api.qloo.com`. The Dockerfile sets both. Locally, run `qloo config set base-url https://hackathon.api.qloo.com` once. |
| `QLOO_BIN` | no | Full path to `qloo` if it isn't on PATH (Windows: `where.exe qloo`) |

OpenStreetMap (Nominatim, Overpass) and Open-Meteo need no keys.

## Deploying

`qloo mcp` is a local stdio process, and Qloo's kit says serverless functions are not supported. So we deploy as **one Docker container** on Render, Railway or Fly.io:

```bash
docker build -t crowd-kit .
docker run -p 3000:3000 -e GEMINI_API_KEY=... -e QLOO_API_KEY=... crowd-kit
```

On the host, set both keys as secrets in the dashboard. Never put them in the repo or the image. `GET /api/health` returns `{ ok, demo, qloo: "live" | "mock", reason? }` (it also warms `qloo mcp`); check that `qloo` says `live`.

**Render** (`render.yaml`):
1. Push the repo, then in Render choose **New > Blueprint** and select it.
2. Enter `GEMINI_API_KEY` and `QLOO_API_KEY` when prompted (or later under Environment).
3. Deploy. The blueprint uses the free plan, which spins down after 15 idle minutes (the next visit takes about a minute). Switch to `starter` for always-on.

**Fly.io** (`fly.toml`):
```bash
fly launch --no-deploy --copy-config   # pick a unique app name
fly secrets set GEMINI_API_KEY=... QLOO_API_KEY=...
fly deploy
```
The config keeps one machine always running (no cold starts) and health-checks `/api/health`.

No keys yet? Set `CROWDKIT_DEMO=1` for a keyless deploy that replays canned data. To keep the Qloo cache across deploys, mount a disk at `/app/.cache` (or point `CROWDKIT_CACHE_DIR` elsewhere); see the commented blocks in `render.yaml` / `fly.toml`.

## How it works

```
Browser form ──POST /api/plan?mode=qloo────▶ Gemini agent (function calling)
     ▲                                          │
     │  Server-Sent Events                       ├─ qloo_* workflows via `qloo mcp` (MCP stdio) (Qloo)
     │  (live trace + final plan)                ├─ geocode_venue / nearby_osm               (OpenStreetMap)
     │                                          ├─ weather_for_date                         (Open-Meteo)
     │                                          ├─ web_search                               (Gemini 2.5 Flash + Google Search)
     │                                          ├─ plan_volunteers                          (deterministic formula)
     └──────────────────────────────────────────└─ submit_plan → Plan JSON
Browser form ──POST /api/plan?mode=baseline──▶ Gemini, no tools ("Without Qloo")
```

| Path | What it is |
|---|---|
| `src/lib/types.ts` | **Shared contracts:** `EventInput`, `Plan`, `ToolResult`, `AgentEvent`. Tell the team before you change them. |
| `src/lib/agent.ts` | Gemini agent loop, tool wiring, baseline |
| `src/lib/prompt.ts` | The agent's system prompt |
| `src/lib/tools/qloo.ts` | Starts `qloo mcp`, exposes its workflows to the agent, handles mock mode |
| `src/lib/tools/geo.ts` | Geocoding, nearby places and weather |
| `src/lib/tools/staffing.ts` | Volunteer formula. The LLM never invents headcounts. |
| `src/lib/cache.ts` | Server-side response cache (OS temp folder by default, never in the repo) |
| `src/app/api/plan/route.ts` | Streaming API route |
| `src/components/CrowdKit.tsx` | Form, live trace and plan view |

## Team

| Who | Owns |
|---|---|
| Aditya | Agent and Qloo integration, Devpost write-up |
| Ayush | Product and frontend |
| Om | Venue research tools, staffing formula, caching, deploys |

## How Qloo is used

| Qloo workflow | What Crowd Kit does with it |
|---|---|
| `qloo_describe`, `qloo_find_tags` | Resolve the act or theme to Qloo IDs. If a match is ambiguous (`needs_input`), the agent records its choice as an assumption for the planner to check. |
| `qloo_audience_demographics` | Crowd profile: age and gender mix |
| `qloo_recommend` | Brands, local places and artists that the act's fans over-index on |
| `qloo_compare_audiences` | Tonight's crowd vs the venue's usual crowd (recent acts found with web search) |
| `qloo_rank` | Rank **real** shortlists (nearby vendors, candidate sponsors) for this audience |
| `qloo_trends` | Rising artists for the pre-show playlist |

## Known limitations

- The agent runs on the Gemini API free tier. Google may use free-tier requests to improve its products, so don't enter anything private. Free-tier rate limits can slow a run; the agent waits and retries.

- Qloo results describe **aggregate audience affinities**. They are not predictions about any individual attendee, and the plan words them that way.
- Venue facts from web search can be out of date. The plan labels them `web` so the planner can check.
- The volunteer formula follows published minimums (Purple Guide, Green Guide, NFPA 101; sources in `src/lib/tools/staffing.ts`) where they exist, and rules of thumb for food, merch, the info desk and bar ID checks. It supports, and never replaces, professional safety staffing.
- Public OpenStreetMap servers are sometimes overloaded. When they fail, the plan says so instead of guessing.

## Rules we follow

- **Never commit Qloo response data or API keys.** The cache lives outside the repo (OS temp folder, or `CROWDKIT_CACHE_DIR`).
- **Never send personal data to Qloo.** Inputs are public venues, acts and themes.
- Every recommendation carries a `source` (`qloo`, `web`, `osm`, `weather`, `calc`, `llm` or `mock`).

## License

[MIT](LICENSE)
