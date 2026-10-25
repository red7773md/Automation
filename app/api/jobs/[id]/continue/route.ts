import { adminRoute, json, UUID_RE } from "@/lib/api";
import { getDb } from "@/lib/db";
import { logEvent } from "@/lib/logger";
import { checkContinue } from "@/lib/jobs/pictures";
import type { JobData } from "@/lib/jobs/states";

type P = { id: string };

// Admin-only. Continue, once every picture is uploaded: the caption and the pinned comment are written, and the
// post goes out. With a time in the body ({"at": ISO time}), the job waits and posts at that time.
// The time is kept as the job's start time, so the scheduler respects it like any scheduled job.
export const POST = adminRoute<P>(async (req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);
  const body = await req.json().catch(() => null);
  const now = new Date();

  const sql = await getDb();
  const [job] = await sql`select state, data from jobs where id = ${id}::uuid`;
  if (!job) return json({ error: "Job not found" }, 404);
  if (job.state !== "generating") return json({ error: `Job is "${job.state}", not waiting for pictures` }, 409);

  const check = checkContinue(job.data as JobData, body?.at, now);
  if (!check.ok) return json({ error: check.error }, 400);

  const at = check.at ? check.at.toISOString() : null;
  const [ok] = await sql`
    update jobs set state = 'captioning', error = null, updated_at = now(),
      scheduled_at = coalesce(${at}::timestamptz, now()),
      data = data || ${JSON.stringify({ manualContinue: true, continuedAt: now.toISOString() })}::jsonb
    where id = ${id}::uuid and state = 'generating'
    returning id`;
  if (!ok) return json({ error: "The job changed. Reload the page." }, 409);
  await logEvent(
    id,
    "generating",
    at ? `Continued. The caption is written and the post goes out at ${at}.` : "Continued. The caption is written and the post goes out now.",
  );
  return json({ ok: true, state: "captioning", at });
});
