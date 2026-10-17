import { adminRoute, json, UUID_RE } from "@/lib/api";
import { getDb } from "@/lib/db";

type P = { id: string };

export const GET = adminRoute<P>(async (_req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);
  const sql = await getDb();
  const [job] = await sql`
    select id, topic, state, busy, attempts, data, error, scheduled_at, created_at, updated_at
    from jobs where id = ${id}::uuid`;
  if (!job) return json({ error: "Job not found" }, 404);
  const logs = await sql`
    select id, level, step, message, detail, duration_ms, created_at
    from job_logs where job_id = ${id}::uuid order by id desc limit 300`;
  return json({ job, logs: logs.reverse() });
});
