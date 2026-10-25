import { adminRoute, json, UUID_RE } from "@/lib/api";
import { getDb } from "@/lib/db";
import { logEvent } from "@/lib/logger";
import { CANCELLABLE, type State } from "@/lib/jobs/states";

type P = { id: string };

/**
 * Stops a job. Nothing is posted. The job becomes failed with a cancelled flag, and Retry resumes it
 * from the step it was on. A step that is running now finishes its call, but its result is dropped
 * (see the runner).
 */
export const POST = adminRoute<P>(async (_req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);

  const sql = await getDb();
  const [job] = await sql`select state from jobs where id = ${id}::uuid`;
  if (!job) return json({ error: "Job not found" }, 404);
  const state = job.state as State;
  if (!CANCELLABLE.includes(state)) {
    const why =
      state === "publishing"
        ? "Posting has started, so the job cannot be cancelled now."
        : `Job is "${state}" and cannot be cancelled.`;
    return json({ error: why }, 409);
  }

  // The update only applies if the state is still the one read above. Otherwise the job moved on: reload.
  const cancelledAt = new Date().toISOString();
  const [ok] = await sql`
    update jobs set state = 'failed', error = 'Cancelled by you. Nothing was posted.', updated_at = now(),
      data = data || ${JSON.stringify({ cancelled: true, cancelledAt, failedStep: state, retryAt: null })}::jsonb
    where id = ${id}::uuid and state = ${state}
    returning id`;
  if (!ok) return json({ error: "The job changed. Reload the page." }, 409);

  await logEvent(id, state, `Cancelled by you at "${state}". Nothing was posted. Retry resumes it.`, { level: "warn" });
  return json({ ok: true, state: "failed", failedStep: state });
});
