import type { EventInput } from "./types";

// The event behind the /sample plan and the first evidence run (scripts/evidence-events.ts).
export const SAMPLE_EVENT: { name: string; input: EventInput } = {
  name: "Indie gig in San Francisco",
  input: { venue: "The Fillmore, San Francisco", act: "Phoebe Bridgers", date: "2026-11-21", startTime: "19:00", durationHours: 4, attendance: 1150, volunteers: 30, budget: "$8,000", foodStalls: 6 },
};

// Sample events: shown as presets in the form and used by scripts/eval-agent.ts.
export const PRESETS: { name: string; input: EventInput }[] = [
  {
    name: "Hip-hop show in San Francisco",
    input: { venue: "The Fillmore, San Francisco", act: "Eminem", date: "2026-11-21", startTime: "19:00", durationHours: 4, attendance: 1150, volunteers: 40, budget: "$8,000", foodStalls: 6 },
  },
  {
    name: "Comedy night in Chicago",
    input: { venue: "Chicago Theatre, Chicago", act: "Hasan Minhaj", date: "2026-12-05", startTime: "20:00", durationHours: 3, attendance: 3500, volunteers: 45, budget: "$12,000", foodStalls: 8 },
  },
  {
    name: "College fest in Pune",
    input: { venue: "COEP Ground, Pune", act: "Indie college fest with Prateek Kuhad", date: "2026-12-12", startTime: "16:00", durationHours: 7, attendance: 5000, volunteers: 60, budget: "₹3,00,000", foodStalls: 14 },
  },
];
