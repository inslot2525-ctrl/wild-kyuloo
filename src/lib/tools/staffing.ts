import type { ToolResult } from "../types";

// Deterministic volunteer planner. The LLM never invents headcounts: the crowd
// weights come from Qloo's age profile (weightsFromAges) and the model explains.
// Volunteers support, never replace, licensed security, stewards and medical staff.
//
// Sources for the ratios (all are minimums a risk assessment can raise):
// - Entry: 660 people per entry point per hour, Green Guide (SGSA)
//   https://sgsa.org.uk/physical-factors/circulation/ingress/
// - Crowd flow: 1 mobile steward per 250 attendees, SGSA stewarding plan
//   https://sgsa.org.uk/safety-management/stewarding/stewarding-plan/
//   rising to 1:100 where alcohol plays a key role (Green Guide, via Lichfield DC)
//   https://www.lichfielddc.gov.uk/street-trading-licences/event-management-plan/8
// - Crowd managers: 1 trained crowd manager per 250 occupants, NFPA 101 12.7.6 / NFPA 1 20.1.5.6
//   https://www.frederickcountymd.gov/index.asp?NID=2232
// - First aid: never fewer than 2; 2 per 1,000 for the first 3,000, Purple Guide (via Lichfield DC)
//   https://www.lichfielddc.gov.uk/street-trading-licences/event-management-plan/16
//   Larger events need more "but not necessarily pro rata" (SWAST, Purple Guide ch.5), so 1 per 1,000 beyond.
//   https://northdevon.gov.uk/media/382016/swast-event-medical-guidance-document-devon.pdf
//   Paramedic/nurse-led cover above 3,000, doctor-led above 10,000 (Yorkshire Ambulance Service)
//   https://bradford.gov.uk/media/6982/yas-event-medical-assurance-form.pdf
// - Waste: ~1 volunteer per 1,000 on site at once (Zootown Festival: 18,000/day, ~50 three-hour shifts)
//   https://www.kpax.com/news/green-team-volunteers-roam-zootown-festival-to-help-divert-waste-from-landfill
// - Breaks: 20 min rest when working over 6h, UK Working Time Regulations
//   https://www.gov.uk/rest-breaks-work
// Food, merch, info desk and bar ID ratios are rules of thumb; tune with real planners.

export interface StaffingInput {
  attendance: number;
  volunteers: number;
  entrances: number;
  durationHours: number;
  startTime: string; // "18:00"
  foodStalls: number;
  merchWeight: number; // 0.5 (crowd rarely buys merch) .. 2 (merch-heavy fanbase)
  accessibilityWeight: number; // 0.5 .. 2 (older crowd, families, mobility needs)
  alcohol: boolean;
  merchNote?: string; // why merchWeight is what it is, e.g. the Qloo index it came from
  accessibilityNote?: string;
}

// Staffing weights from Qloo's audience_demographics age indices (-1 fewer than a
// typical audience .. +1 more). Rules of thumb: fans under 30 buy more merch, and
// fans over 45 use the info and accessibility desk more. A young crowd never cuts
// the desk below the base: disability isn't only about age.
export function weightsFromAges(age: Record<string, number>) {
  const mean = (bands: string[]) => {
    const v = bands.map((b) => age[b]).filter((x): x is number => typeof x === "number");
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
  };
  const weight = (x: number) => Math.round(Math.min(2, Math.max(0.5, 1 + x)) * 100) / 100;
  const under30 = mean(["24_and_younger", "25_to_29"]);
  const over45 = mean(["45_to_54", "55_and_older"]);
  return { merchWeight: weight(under30), accessibilityWeight: weight(Math.max(0, over45)), under30, over45 };
}

interface Station { station: string; count: number; notes: string; floor: number }

const ENTRY_RATE = 660; // people per entry lane per hour (Green Guide)
const MAX_SHIFT_HOURS = 6; // longer volunteer shifts need a legal break
const BREAK_RELIEF = 1.1; // 10% extra to cover breaks on shifts over 4h

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));

// "18:00", "18", "6pm", "6:30 pm" -> minutes after midnight, or null.
function parseTime(s: string): number | null {
  const t = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(s ?? "");
  if (!t) return null;
  let h = Number(t[1]);
  const m = Number(t[2] ?? 0);
  const ap = t[3]?.toLowerCase();
  if (ap && (h < 1 || h > 12)) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h < 24 && m < 60 ? h * 60 + m : null;
}

const fmt = (mins: number) => {
  const d = ((Math.round(mins) % 1440) + 1440) % 1440; // wraps across midnight
  return `${String(Math.floor(d / 60)).padStart(2, "0")}:${String(d % 60).padStart(2, "0")}`;
};

export function planStaffing(input: StaffingInput): ToolResult {
  const warnings: string[] = [];
  const att = Math.round(clamp(input.attendance, 0, 1e6));
  const vols = Math.floor(clamp(input.volunteers, 0, 1e5));
  const entrances = Math.round(clamp(input.entrances, 1, 100));
  const hours = clamp(input.durationHours, 0.5, 72);
  const merchW = clamp(input.merchWeight, 0.5, 2);
  const accessW = clamp(input.accessibilityWeight, 0.5, 2);
  const per = (n: number, ratio: number, min: number) => Math.max(min, Math.ceil(n / ratio));

  // Entry: assume 60% arrive in the peak hour (35% for all-day events), split across entrances.
  const peakPerEntrance = (att * (hours > 6 ? 0.35 : 0.6)) / entrances;
  const lanes = Math.max(1, Math.ceil(peakPerEntrance / ENTRY_RATE));
  const entryEach = peakPerEntrance < 200 ? 1 : lanes * 2; // scanner + queue/bag marshal per lane
  const crowdRatio = input.alcohol ? 100 : 250;
  const firstAid = Math.max(2, Math.ceil((Math.min(att, 3000) * 2) / 1000) + Math.ceil(Math.max(0, att - 3000) / 1000));
  const crowdManagers = per(att, 250, 1);

  // floor = safety minimum we protect when short on volunteers (0 = not safety-critical).
  const ideal: Station[] = [
    { station: "First aid support", count: firstAid, floor: firstAid, notes: "Purple Guide: never fewer than 2, 2 per 1,000 up to 3,000. Supports, never replaces, licensed medical staff" },
    { station: "Entry & ticket check", count: entrances * entryEach, floor: entrances, notes: `${entrances} entrance(s), ~${Math.round(peakPerEntrance)}/h peak each, ${lanes} lane(s) at 660/h (Green Guide)` },
    { station: "Crowd flow & stage barrier", count: per(att, crowdRatio, 1), floor: Math.min(2, per(att, crowdRatio, 1)), notes: `1 per ${crowdRatio}${input.alcohol ? " (alcohol)" : ""}: pinch points, exits, barrier line. NFPA 101 wants ${crowdManagers} trained crowd manager(s)` },
    { station: "Food & drink support", count: input.foodStalls > 0 ? Math.ceil(input.foodStalls * 0.5) + per(att, 1000, 0) : 0, floor: 0, notes: "Queue marshals and runners; vendors staff their own stalls" },
    { station: "Merch", count: Math.round(per(att, 600, 1) * merchW), floor: 0, notes: input.merchNote ?? "Scaled by how merch-heavy this fanbase is" },
    { station: "Info & accessibility desk", count: Math.max(1, Math.round(per(att, 1000, 1) * accessW)), floor: 0, notes: input.accessibilityNote ?? "Scaled by accessibility needs of the crowd" },
    { station: "Waste & recycling", count: per(att, 1000, 1), floor: 0, notes: "Bin stations near food (about 4 bins per 100 people where food is sold)" },
  ];
  if (input.alcohol) ideal.push({ station: "ID check at bars", count: per(att, 1000, 1), floor: 0, notes: "Alcohol service present; supports licensed bar staff" });

  // Shifts: volunteers arrive 1h early and stay 30 min after; split into shifts of at most 6h with 30 min handover.
  let startMin = parseTime(input.startTime);
  if (startMin === null) {
    warnings.push(`Couldn't read start time "${input.startTime}"; assumed 18:00.`);
    startMin = 18 * 60;
  }
  const spanStart = startMin - 60;
  const span = hours * 60 + 90;
  const nShifts = Math.ceil(span / (MAX_SHIFT_HOURS * 60));
  const len = span / nShifts;
  const shifts = nShifts === 1
    ? [{ label: "Full event", start: fmt(spanStart), end: fmt(spanStart + span) }]
    : Array.from({ length: nShifts }, (_, k) => ({
        label: `Shift ${String.fromCharCode(65 + k)}`,
        start: fmt(Math.round((spanStart + k * len) / 15) * 15 - (k ? 30 : 0)),
        end: fmt(k === nShifts - 1 ? spanStart + span : Math.round((spanStart + (k + 1) * len) / 15) * 15),
      }));
  const relief = len > 240 ? BREAK_RELIEF : 1;
  const crew = nShifts * relief; // people needed per on-site position

  const perShift = ideal.reduce((s, x) => s + x.count, 0);
  const recommended = Math.ceil(perShift * crew);
  const available = Math.floor(vols / crew); // on site at any one time

  let stations = ideal;
  if (available < perShift) {
    const floorSum = ideal.reduce((s, x) => s + x.floor, 0);
    if (available >= floorSum) {
      // Safety floors first, then share the rest proportionally. Never exceeds `available`.
      const extra = ideal.reduce((s, x) => s + x.count - x.floor, 0);
      const r = extra ? (available - floorSum) / extra : 0;
      const share = ideal.map((s) => (s.count - s.floor) * r);
      stations = ideal.map((s, k) => ({ ...s, count: s.floor + Math.floor(share[k]) }));
      let left = available - stations.reduce((n, s) => n + s.count, 0); // hand leftovers to the largest remainders
      for (const k of share.map((_, k) => k).sort((a, b) => (share[b] % 1) - (share[a] % 1))) {
        if (left <= 0) break;
        if (stations[k].count < ideal[k].count) { stations[k].count++; left--; }
      }
      warnings.push(`You have ${vols} volunteers; this event needs about ${recommended}. Safety-critical stations were protected first.`);
    } else {
      let left = available; // fill safety floors in priority order (first aid, entry, crowd flow)
      stations = ideal.map((s) => { const c = Math.min(s.floor, left); left -= c; return { ...s, count: c }; });
      warnings.push(`You have ${vols} volunteers, below the safety minimum of ${Math.ceil(floorSum * crew)} for first aid, entry and crowd flow. Hire professional staff or recruit more before opening; non-safety stations are unstaffed.`);
    }
  }

  const flow = stations.filter((s) => /Entry|Crowd/.test(s.station)).reduce((n, s) => n + s.count, 0);
  if (flow < crowdManagers) warnings.push(`NFPA 101 calls for ${crowdManagers} trained crowd manager(s) at ${att} attendees; volunteers cover ${flow}. Make up the gap with trained or professional staff.`);
  if (att > 3000) warnings.push(`Over 3,000 attendees: medical cover should be paramedic or nurse-led (above 10,000, doctor-led). First aid volunteers only support it.`);
  if (nShifts > 1) warnings.push(`${nShifts} shifts of about ${Math.round(len / 60)}h with 30 min handovers; each on-site role needs ${nShifts} people.`);

  return {
    data: { available: vols, recommended, perShift, shifts, stations: stations.map(({ station, count, notes }) => ({ station, count, notes })), warnings },
    source: "calc",
    cached: false,
  };
}
