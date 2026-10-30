import { cached } from "../cache";

// Free fallback for web research when Gemini's Google Search grounding isn't
// available (newer free-tier keys can't use gemini-2.5-flash, the only model with
// free search). Wikipedia covers venue capacity, history and notable events.
//
// Wikipedia asks API clients to make requests one at a time and to back off when
// told to. Parallel searches from a shared cloud IP were getting 429s, so requests
// queue up with a small gap, a 429 waits for Retry-After, and one search is one request.

const UA = "CrowdKit/0.1 (Qloo Agentic Hackathon; github.com/inslot2525-ctrl/wild-kyuloo)";
const API = "https://en.wikipedia.org/w/api.php";
const GAP_MS = 300;
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let last: Promise<unknown> = Promise.resolve();
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = last.then(fn, fn);
  last = run.then(() => sleep(GAP_MS), () => sleep(GAP_MS));
  return run;
}

interface WikiPage { title: string; index?: number; extract?: string }
interface WikiResponse { query?: { pages?: WikiPage[] } }

async function wikiJson(params: Record<string, string>): Promise<WikiResponse> {
  const url = `${API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  for (let attempt = 0; ; attempt++) {
    const res = await inTurn(() => fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) }));
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const after = Number(res.headers.get("retry-after"));
      await sleep(Math.min(8, after > 0 ? after : 2 ** attempt) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
    return res.json();
  }
}

// Top matching articles with their plain-text intros, best match first.
async function search(q: string): Promise<WikiPage[]> {
  const data = await wikiJson({
    action: "query", generator: "search", gsrsearch: q, gsrlimit: "3",
    prop: "extracts", exintro: "1", explaintext: "1", exchars: "1500", exlimit: "3",
  });
  return (data.query?.pages ?? []).filter((p) => p.extract?.trim()).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

// Words that say what we want to know about a place, not what the place is called.
const ASPECTS = /\b(capacity|entrances?|exits?|house|rules?|polic(y|ies)|bags?|alcohol|parking|transit|transport|recent|upcoming|past|events?|concerts?|shows?|lineup|history|address|accessibility|age|restrictions?|tour|audience|crowd|fans?|venue|nearby|food|weather|\d{4})\b/gi;
const FILLER = /\b(at|in|of|for|and|on|near|with|about|what|which|who|is|are|latest|the)\b/gi;

// "recent concerts at The Fillmore San Francisco" -> "The Fillmore San Francisco"
// (a capitalised "The" that starts a name is kept).
function nameOf(query: string): string {
  return query
    .replace(ASPECTS, " ")
    .replace(FILLER, (w: string, _m: string, i: number, all: string) => (w === "The" && /^\s+[A-Z]/.test(all.slice(i + 3)) ? w : " "))
    .replace(/[^\p{L}\p{N}&'.-]+/gu, " ")
    .trim();
}

// Null when nothing matches.
export async function wikipediaSearch(query: string): Promise<{ answer: string; sources: { title: string; url: string }[] } | null> {
  const { value } = await cached("wiki-search-v2", query.toLowerCase(), async () => {
    // Wikipedia matches pages containing every word, so a long question finds odd pages.
    // Search for the place or name itself first, then the question as asked.
    const name = nameOf(query);
    let pages = name && name.toLowerCase() !== query.toLowerCase() ? await search(name) : [];
    if (!pages.length) pages = await search(query);
    if (!pages.length) return null;
    return {
      answer: pages.map((p) => `${p.title}: ${p.extract}`).join("\n\n"),
      sources: pages.map((p) => ({ title: `${p.title} (Wikipedia)`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}` })),
    };
  });
  return value;
}
