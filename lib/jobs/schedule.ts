// When a job may start. Empty means now. Past times start at once. Up to a year ahead.
export const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

export type StartParse = { at: Date | null } | { error: string };

export function parseStart(value: unknown, now: Date): StartParse {
  if (value === undefined || value === null || value === "") return { at: null };
  if (typeof value !== "string") return { error: "Start time must be a date and time" };
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return { error: "Start time is not a valid date" };
  if (at.getTime() > now.getTime() + MAX_AHEAD_MS) return { error: "Start time must be within a year" };
  return { at };
}
