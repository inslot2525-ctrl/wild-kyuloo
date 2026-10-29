import { ApiError, GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import type { AgentEvent } from "./types";

// Gemini free tier, shared by the agent, the baseline and the layout review.
// Free models are often overloaded (503), out of quota (429) or simply hang, and
// which ones work changes hour to hour. So every call has a time limit and falls
// back through a chain of free models.
// Note: on the free tier Google may use requests to improve its products.

const unique = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

export const MODELS = unique([
  process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite",
  ...(process.env.GEMINI_FALLBACK_MODELS?.split(",") ?? ["gemini-3-flash-preview", "gemini-2.5-flash", "gemini-3.8-flash"]),
]);
export const MODEL = MODELS[0];
// Google Search grounding is only free on 2.5 Flash, which newer keys can no longer
// use; web_search then falls back to Wikipedia (src/lib/tools/wiki.ts).
export const SEARCH_MODEL = process.env.GEMINI_SEARCH_MODEL ?? "gemini-2.5-flash";

const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 75_000);

// Created on first use so demo mode works without GEMINI_API_KEY.
let client: GoogleGenAI | null = null;
export function gemini(): GoogleGenAI {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey and add it to .env.local.");
  return (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
}

type Emit = ((e: AgentEvent) => void) | null | undefined;

// Busy, out of quota, timed out, or not available to this key: try another model.
function whyUnavailable(err: unknown): string | null {
  if (err instanceof ApiError) {
    if (err.status === 429) return "out of free quota";
    if (err.status === 503 || err.status === 500 || err.status === 504) return "overloaded";
    if (err.status === 404) return "not available";
    return null;
  }
  const name = (err as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError") return "not responding";
  // A dropped connection ("fetch failed", resets, DNS hiccups) is worth waiting out too.
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? "";
  if ((err instanceof TypeError && /fetch failed/i.test(err.message)) || /ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR/.test(code)) return "unreachable (network)";
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Models that just failed go to the back of the line for a while, so the next
// request doesn't wait out the same hang again.
const COOLDOWN_MS = 5 * 60_000;
const coolingUntil = new Map<string, number>();
const isCooling = (m: string) => (coolingUntil.get(m) ?? 0) > Date.now();

// Generate with a time limit and model fallback. `build` gets the model name so
// callers can adapt the request (the agent strips model-bound thought data).
export async function generate(
  build: (model: string) => Omit<GenerateContentParameters, "model">,
  opts: { emit?: Emit; prefer?: string } = {},
): Promise<{ res: GenerateContentResponse; model: string }> {
  const preferred = opts.prefer ? unique([opts.prefer, ...MODELS]) : MODELS;
  const order = [...preferred.filter((m) => !isCooling(m)), ...preferred.filter(isCooling)];
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < order.length; i++) {
      const model = order[i];
      const params = build(model);
      try {
        const res = await gemini().models.generateContent({
          ...params,
          model,
          config: { ...params.config, abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
        });
        coolingUntil.delete(model);
        return { res, model };
      } catch (err) {
        const why = whyUnavailable(err);
        if (!why) throw err;
        coolingUntil.set(model, Date.now() + COOLDOWN_MS);
        const next = order[i + 1];
        opts.emit?.({ type: "status", message: next ? `${model} is ${why}; switching to ${next}` : `${model} is ${why}` });
      }
    }
    if (round === 0) {
      opts.emit?.({ type: "status", message: "All Gemini models are busy; waiting 20s before trying again" });
      await sleep(20_000);
    }
  }
  throw new Error("Every free Gemini model is busy or out of quota right now. Please try again in a few minutes.");
}

// Single-model calls (web search grounding only works on SEARCH_MODEL): time limit + retries.
export async function withRetry<T>(emit: Emit, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(AbortSignal.timeout(TIMEOUT_MS));
    } catch (err) {
      const why = whyUnavailable(err);
      if (!why || why === "not available" || attempt >= 3) throw err;
      const seconds = 5 * 2 ** attempt;
      emit?.({ type: "status", message: `Gemini search is ${why}; retrying in ${seconds}s` });
      await sleep(seconds * 1000);
    }
  }
}
