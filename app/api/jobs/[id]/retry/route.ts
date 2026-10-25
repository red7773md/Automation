import { adminRoute, json, UUID_RE } from "@/lib/api";
import { getDb } from "@/lib/db";
import { logEvent } from "@/lib/logger";

type P = { id: string };

export const POST = adminRoute<P>(async (_req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);

  const sql = await getDb();
  const [job] = await sql`select state, busy, data from jobs where id = ${id}::uuid`;
  if (!job) return json({ error: "Job not found" }, 404);
  if (job.state !== "failed") return json({ error: `Job is "${job.state}", not failed` }, 409);
  // A cancelled job may still have a step running in the background. Resuming now would let two steps overlap.
  if (job.busy) return json({ error: "A step is still running. Try again when it finishes." }, 409);

  const step = (job.data?.failedStep as string | undefined) ?? "queued";
  // Clears the cancel flag and any wait, so the resumed job starts clean.
  const [ok] = await sql`
    update jobs set state = ${step}, error = null, updated_at = now(),
      data = (data - 'cancelled' - 'cancelledAt') || '{"transientTries":0,"retryAt":null}'::jsonb
    where id = ${id}::uuid and state = 'failed' and busy = false
    returning id`;
  if (!ok) return json({ error: "The job changed. Reload the page." }, 409);
  await logEvent(id, step, `Retry requested. Resuming at "${step}".`);
  return json({ ok: true, state: step });
});
