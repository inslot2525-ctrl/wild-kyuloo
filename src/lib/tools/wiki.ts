import { cached } from "../cache";

// Free fallback for web research when Gemini's Google Search grounding isn't
// available (newer free-tier keys can't use gemini-2.5-flash, the only model with
// free search). Wikipedia covers venue capacity, history and notable events.

const UA = "CrowdKit/0.1 (Qloo Agentic Hackathon; github.com/inslot2525-ctrl/wild-kyuloo)";
const API = "https://en.wikipedia.org/w/api.php";

interface WikiResponse {
  query?: { search?: { title: string }[]; pages?: { title: string; extract?: string }[] };
}

async function wikiJson(params: Record<string, string>): Promise<WikiResponse> {
  const res = await fetch(`${API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  return res.json();
}

// Top matching articles' plain-text intros. Null when nothing matches.
export async function wikipediaSearch(query: string): Promise<{ answer: string; sources: { title: string; url: string }[] } | null> {
  const { value } = await cached("wiki-search", query.toLowerCase(), async () => {
    const found = await wikiJson({ action: "query", list: "search", srsearch: query, srlimit: "3" });
    const titles = (found.query?.search ?? []).map((r) => r.title);
    if (!titles.length) return null;
    const pages = await wikiJson({ action: "query", prop: "extracts", exintro: "1", explaintext: "1", exchars: "1500", titles: titles.join("|") });
    const byTitle = new Map((pages.query?.pages ?? []).map((p) => [p.title, p.extract ?? ""]));
    const hits = titles.filter((t) => byTitle.get(t)?.trim());
    if (!hits.length) return null;
    return {
      answer: hits.map((t) => `${t}: ${byTitle.get(t)}`).join("\n\n"),
      sources: hits.map((t) => ({ title: `${t} (Wikipedia)`, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}` })),
    };
  });
  return value;
}
