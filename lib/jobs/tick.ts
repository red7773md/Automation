// The background driver. A scheduled workflow calls /api/cron/tick every few minutes;
// each call runs exactly one step of the oldest job that is due. One step per call
// means jobs run one at a time, and a run that takes hours keeps moving with no page open.
import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { advanceJob, type AdvanceResult } from "./runner";

/**
 * States the driver never touches: they wait for a person or are finished. Keep in step with RUNNABLE, and with
 * the literal list in tickOnce (a test checks that they agree). A job left out of this list would be picked on
 * every tick and block the jobs behind it.
 */
export const NOT_TICKED = ["generating", "awaiting_review", "done", "failed"] as const;

export type TickResult =
  | { ran: false; reason: string }
  | { ran: true; jobId: string; result: AdvanceResult | null };

/** True only for "Bearer <secret>" with the exact secret. Compared in constant time. */
export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Runs the next step of the oldest due job. Returns what happened, or that nothing was due. */
export async function tickOnce(): Promise<TickResult> {
  const sql = await getDb();
  const due = await sql`
    select id from jobs
    where busy = false
      and state not in ('generating', 'awaiting_review', 'done', 'failed')
      and scheduled_at <= now()
      and coalesce((data->>'retryAt')::timestamptz, now()) <= now()
    order by scheduled_at asc, created_at asc
    limit 1`;
  if (due.length === 0) return { ran: false, reason: "No job is due" };

  const jobId = String(due[0].id);
  const result = await advanceJob(jobId);
  return { ran: true, jobId, result };
}
