// The pictures you make by hand and upload on the job page. Pure functions with no I/O, so the rules can be
// tested and the browser can show what is still missing.
import { parseStart } from "./schedule";
import type { JobData } from "./states";

/** Continue needs the start time at least this far ahead. A time nearer than this would be missed. */
export const MIN_LEAD_MS = 60_000;

/**
 * The slots (0-based) that still have no picture. A single post has one slot; a carousel has one per slide.
 * A job with no plan has no slots to fill.
 */
export function missingPictures(d: Partial<JobData>): number[] {
  if ((d.format ?? "post") !== "carousel") return d.draftPath ? [] : [0];
  const total = d.carousel?.slides.length ?? 0;
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!d.slideImages?.[i]?.path) out.push(i);
  }
  return out;
}

export type ContinueCheck = { ok: true; at: Date | null } | { ok: false; error: string };

/**
 * Whether Continue may start the caption and the post. Every picture must be uploaded. An empty time posts now;
 * a time must be at least a minute ahead and within a year.
 */
export function checkContinue(d: Partial<JobData>, at: unknown, now: Date): ContinueCheck {
  const start = parseStart(at, now);
  if ("error" in start) return { ok: false, error: start.error };
  if (start.at && start.at.getTime() < now.getTime() + MIN_LEAD_MS) {
    return { ok: false, error: "Pick a time at least a minute from now, or post now." };
  }
  const missing = missingPictures(d);
  if (missing.length) {
    return { ok: false, error: `Upload every picture first. Still missing: ${missing.map((i) => i + 1).join(", ")}.` };
  }
  return { ok: true, at: start.at };
}
