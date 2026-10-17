import { adminRoute, json, UUID_RE } from "@/lib/api";
import { getDb } from "@/lib/db";
import { logEvent } from "@/lib/logger";

type P = { id: string };

export const POST = adminRoute<P>(async (_req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);

  const sql = await getDb();
  const [job] = await sql`select state, data from jobs where id = ${id}::uuid`;
  if (!job) return json({ error: "Job not found" }, 404);
  if (job.state !== "failed") return json({ error: `Job is "${job.state}", not failed` }, 409);

  const step = (job.data?.failedStep as string | undefined) ?? "queued";
  const [ok] = await sql`
    update jobs set state = ${step}, error = null, updated_at = now()
    where id = ${id}::uuid and state = 'failed'
    returning id`;
  if (!ok) return json({ error: "The job changed. Reload the page." }, 409);
  await logEvent(id, step, `Retry requested. Resuming at "${step}".`);
  return json({ ok: true, state: step });
});
