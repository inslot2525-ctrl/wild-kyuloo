/* eslint-disable @typescript-eslint/no-explicit-any -- parses untyped third-party JSON */
import { cached } from "../cache";
import type { ToolResult } from "../types";

// Free, keyless data sources: Nominatim (geocoding), Overpass (OpenStreetMap
// features around the venue) and Open-Meteo (weather). Photon, which indexes the
// same OpenStreetMap data, is the fallback when Nominatim or Overpass is down. Be polite: Nominatim
// asks for a real User-Agent and at most 1 request per second.

const UA = "CrowdKit/0.1 (Qloo Agentic Hackathon; github.com/inslot2525-ctrl/wild-kyuloo)";

async function geocodeNominatim(query: string) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "3");
  url.searchParams.set("addressdetails", "1");
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const rows = (await res.json()) as any[];
  return rows.map((r) => ({
    name: r.name,
    displayName: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
    kind: `${r.category}/${r.type}`,
    countryCode: r.address?.country_code,
    city: r.address?.city ?? r.address?.town ?? r.address?.village,
    region: r.address?.state ?? r.address?.county,
    country: r.address?.country,
  }));
}

async function geocodePhoton(query: string) {
  const url = new URL("https://photon.komoot.io/api");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "3");
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const features = ((await res.json()) as any).features as any[];
  return features.map(({ properties: p, geometry }) => ({
    name: p.name,
    displayName: [p.name, p.street && [p.housenumber, p.street].filter(Boolean).join(" "), p.city, p.state, p.country].filter(Boolean).join(", "),
    lat: Number(geometry.coordinates[1]),
    lon: Number(geometry.coordinates[0]),
    kind: `${p.osm_key}/${p.osm_value}`,
    countryCode: p.countrycode?.toLowerCase(),
    city: p.city ?? p.locality,
    region: p.state ?? p.county,
    country: p.country,
  }));
}

export async function geocode(query: string): Promise<ToolResult> {
  const { value, hit } = await cached("geocode-v2", query, async () => {
    try {
      const rows = await geocodeNominatim(query);
      if (rows.length) return rows;
    } catch {
      // fall through to Photon
    }
    return geocodePhoton(query);
  });
  return { data: value, source: "osm", cached: hit };
}

// Each group is a set of OSM tag values. Overpass and Photon queries are both built from it.
const GROUPS: Record<string, Record<string, string[]>> = {
  food: { amenity: ["restaurant", "cafe", "fast_food", "bar", "pub", "food_court", "ice_cream"] },
  transit: { public_transport: ["station"], railway: ["station", "subway_entrance", "tram_stop"], highway: ["bus_stop"] },
  parking: { amenity: ["parking", "bicycle_parking"] },
  safety: { amenity: ["hospital", "clinic", "police", "fire_station", "pharmacy", "toilets"] },
};

const inGroup = (g: string, tags: Record<string, string>) => Object.entries(GROUPS[g]).some(([k, vs]) => vs.includes(tags[k]));

interface Place { name?: string; kind: string }

function summarize(places: Place[], extra: Record<string, unknown> = {}) {
  const byKind: Record<string, number> = {};
  for (const p of places) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  return {
    total: places.length,
    byKind,
    examples: places.filter((p) => p.name).slice(0, 15).map((p) => ({ name: p.name, kind: p.kind })),
    ...extra,
  };
}

// Public Overpass instances are often overloaded (429/502/504) or hang. Ask all
// mirrors at once and take the first good answer, so a bad day costs one timeout, not four.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

async function overpass(query: string): Promise<{ elements: any[] }> {
  const done = new AbortController();
  const attempts = OVERPASS_MIRRORS.map(async (url) => {
    const host = new URL(url).host;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.any([done.signal, AbortSignal.timeout(12_000)]),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = (await res.json()) as { elements?: any[] };
      if (!Array.isArray(json.elements)) throw new Error("bad response");
      return json as { elements: any[] };
    } catch (err) {
      throw new Error(`${host} ${err instanceof Error ? err.message : err}`);
    }
  });
  try {
    return await Promise.any(attempts);
  } catch (err) {
    const reasons = err instanceof AggregateError ? err.errors.map((e) => (e as Error).message) : [String(err)];
    throw new Error(`Overpass unavailable (${reasons.join("; ")})`);
  } finally {
    done.abort();
  }
}

async function nearbyOverpass(lat: number, lon: number, radiusM: number, wanted: string[]) {
  // One combined query (fewer round-trips to overloaded servers), split afterwards.
  const parts = wanted
    .flatMap((g) => Object.entries(GROUPS[g]).map(([k, vs]) => `nwr["${k}"~"^(${vs.join("|")})$"](around:${radiusM},${lat},${lon});`))
    .join("");
  const json = await overpass(`[out:json][timeout:25];(${parts});out center 300;`);
  const out: Record<string, unknown> = {};
  for (const g of wanted) {
    const els = json.elements.filter((e) => e.tags && inGroup(g, e.tags));
    out[g] = summarize(
      els.map((e) => ({ name: e.tags.name, kind: e.tags.cuisine ?? e.tags.amenity ?? e.tags.railway ?? e.tags.highway ?? e.tags.public_transport ?? "other" })),
    );
  }
  return out;
}

// Fallback: Photon (komoot's search index over the same OpenStreetMap data).
// Its reverse endpoint filters by tag within a radius; results are nearest first.
const PHOTON_LIMIT = 50;

async function nearbyPhoton(lat: number, lon: number, radiusM: number, wanted: string[]) {
  const entries = await Promise.all(
    wanted.map(async (g) => {
      const url = new URL("https://photon.komoot.io/reverse");
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lon", String(lon));
      url.searchParams.set("radius", String(radiusM / 1000));
      url.searchParams.set("limit", String(PHOTON_LIMIT));
      for (const [k, vs] of Object.entries(GROUPS[g])) for (const v of vs) url.searchParams.append("osm_tag", `${k}:${v}`);
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`Photon ${res.status}`);
      const features = ((await res.json()) as any).features as any[];
      const places = features.map((f) => ({ name: f.properties?.name, kind: f.properties?.osm_value ?? "other" }));
      // Photon caps results, so a full page means "at least this many".
      return [g, summarize(places, places.length >= PHOTON_LIMIT ? { totalIsLowerBound: true } : {})] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function nearby(lat: number, lon: number, radiusM: number, groups: string[]): Promise<ToolResult> {
  const wanted = groups.filter((g) => g in GROUPS);
  const { value, hit } = await cached("overpass", { lat: lat.toFixed(4), lon: lon.toFixed(4), radiusM, wanted }, async () => {
    try {
      return await nearbyOverpass(lat, lon, radiusM, wanted);
    } catch (overpassErr) {
      try {
        return { ...(await nearbyPhoton(lat, lon, radiusM, wanted)), via: "photon.komoot.io (Overpass was unavailable)" };
      } catch (photonErr) {
        // Both failed: tell the agent how to carry on rather than leaving it stuck.
        const why = [overpassErr, photonErr].map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
        throw new Error(
          `OpenStreetMap lookup unavailable right now (${why}). Continue without it: for food, use qloo_recommend with target_type place near the venue; note the gap in limitations.`,
        );
      }
    }
  });
  return { data: value, source: "osm", cached: hit };
}

export async function weather(lat: number, lon: number, date: string): Promise<ToolResult> {
  const daysAhead = (new Date(date).getTime() - Date.now()) / 86_400_000;
  const { value, hit } = await cached("weather", { lat: lat.toFixed(2), lon: lon.toFixed(2), date }, async () => {
    if (daysAhead > 15 || daysAhead < -1) {
      // Beyond forecast range: use the same date last year as a climate hint.
      const d = new Date(date);
      d.setFullYear(d.getFullYear() - 1);
      const last = d.toISOString().slice(0, 10);
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${last}&end_date=${last}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Open-Meteo archive ${res.status}`);
      return { kind: "same-day-last-year (date is beyond the 16-day forecast)", ...(await res.json()).daily };
    }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&start_date=${date}&end_date=${date}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&timezone=auto`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    return { kind: "forecast", ...(await res.json()).daily };
  });
  return { data: value, source: "weather", cached: hit };
}

// Name the area around a point (neighbourhood or suburb), for promo hot spots.
export async function areaName(lat: number, lon: number): Promise<string | null> {
  const { value } = await cached("reverse", { lat: lat.toFixed(4), lon: lon.toFixed(4) }, async () => {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("lon", String(lon));
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("zoom", "15");
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const a = ((await res.json()) as { address?: Record<string, string> }).address ?? {};
    return a.neighbourhood ?? a.suburb ?? a.quarter ?? a.city_district ?? a.road ?? null;
  });
  return value;
}
