import { adminRoute, json } from "@/lib/api";
import { getDb } from "@/lib/db";
import { errorMessage, logEvent } from "@/lib/logger";
import { parseStart } from "@/lib/jobs/schedule";
import { activeSkips, missingManual, normalizeManual, normalizeWorkflow, type ManualInputs, type Workflow } from "@/lib/jobs/workflow";
import { loadWorkflow } from "@/lib/settings";

export const GET = adminRoute(async () => {
  const sql = await getDb();
  const jobs = await sql`
    select id, topic, state, busy, attempts, error, scheduled_at, created_at, updated_at
    from jobs order by created_at desc limit 50`;
  return json({ jobs });
});

export const POST = adminRoute(async (req) => {
  const body = await req.json().catch(() => null);
  const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
  if (topic.length < 3 || topic.length > 500) return json({ error: "Topic must be 3 to 500 characters" }, 400);

  const start = parseStart(body?.scheduledAt, new Date());
  if ("error" in start) return json({ error: start.error }, 400);

  let workflow: Workflow;
  let manual: ManualInputs;
  try {
    // Without a workflow in the request, the saved defaults apply.
    workflow = body?.workflow === undefined ? await loadWorkflow() : normalizeWorkflow(body.workflow);
    manual = normalizeManual(body?.manual);
  } catch (err) {
    return json({ error: errorMessage(err) }, 400);
  }
  const missing = missingManual(workflow, manual);
  if (missing) return json({ error: missing }, 400);

  const sql = await getDb();
  const [row] = await sql`
    insert into jobs (topic, scheduled_at, data)
    values (${topic}, coalesce(${start.at?.toISOString() ?? null}::timestamptz, now()), ${JSON.stringify({ workflow, manual })}::jsonb)
    returning id, scheduled_at`;
  const when = start.at && start.at.getTime() > Date.now() ? `, starts ${start.at.toISOString()}` : "";
  const skips = activeSkips(workflow);
  const switched = skips.length ? `. Switched off: ${skips.join(", ")}` : "";
  await logEvent(row.id, "queued", `Job created: "${topic}"${when}${switched}`);
  return json({ id: row.id, scheduled_at: row.scheduled_at }, 201);
});
