// Sanity check for the volunteer formula. No keys, no network.
//
//   npx tsx scripts/check-staffing.ts

import { planStaffing, type StaffingInput } from "../src/lib/tools/staffing";

const base = { entrances: 1, foodStalls: 0, merchWeight: 1, accessibilityWeight: 1, alcohol: false };
const scenarios: [string, StaffingInput][] = [
  ["300-person club gig", { ...base, attendance: 300, volunteers: 8, durationHours: 4, startTime: "20:00", foodStalls: 1, merchWeight: 1.5, alcohol: true }],
  ["2,000 college fest with alcohol", { ...base, attendance: 2000, volunteers: 40, entrances: 2, durationHours: 6, startTime: "5pm", foodStalls: 8, alcohol: true }],
  ["15,000 festival, 10h", { ...base, attendance: 15000, volunteers: 250, entrances: 4, durationHours: 10, startTime: "12:00", foodStalls: 30, merchWeight: 1.2, accessibilityWeight: 1.3, alcohol: true }],
  ["0 volunteers", { ...base, attendance: 1000, volunteers: 0, durationHours: 3, startTime: "19:30" }],
  ["tiny 50-person event", { ...base, attendance: 50, volunteers: 6, durationHours: 2, startTime: "23:30", foodStalls: 2 }],
];

let failed = false;
for (const [name, input] of scenarios) {
  const d = planStaffing(input).data as {
    available: number; recommended: number; perShift: number;
    shifts: { label: string; start: string; end: string }[];
    stations: { station: string; count: number }[]; warnings: string[];
  };
  const assigned = d.stations.reduce((s, x) => s + x.count, 0);
  console.log(`\n## ${name}`);
  console.log(`available ${d.available} · recommended ${d.recommended} · per shift ${d.perShift} · assigned on site ${assigned}`);
  console.log("shifts:", d.shifts.map((s) => `${s.label} ${s.start}-${s.end}`).join(", "));
  for (const s of d.stations) console.log(`  ${String(s.count).padStart(4)}  ${s.station}`);
  for (const w of d.warnings) console.log(`  ! ${w}`);
  const bad = d.stations.some((s) => !Number.isInteger(s.count) || s.count < 0) || (d.available < d.recommended && assigned * (d.recommended / d.perShift) > d.available + 1);
  if (bad) { failed = true; console.log("  FAIL: counts invalid or assigned more than available"); }
}
process.exit(failed ? 1 : 0);
