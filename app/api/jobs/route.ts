import { adminRoute, json } from "@/lib/api";
import { getDb } from "@/lib/db";
import { logEvent } from "@/lib/logger";

export const GET = adminRoute(async () => {
  const sql = await getDb();
  const jobs = await sql`
    select id, topic, state, busy, attempts, error, created_at, updated_at
    from jobs order by created_at desc limit 50`;
  return json({ jobs });
});

export const POST = adminRoute(async (req) => {
  const body = await req.json().catch(() => null);
  const topic = typeof body?.topic === "string" ? body.topic.trim() : "";
  if (topic.length < 3 || topic.length > 500) return json({ error: "Topic must be 3 to 500 characters" }, 400);
  const sql = await getDb();
  const [row] = await sql`insert into jobs (topic) values (${topic}) returning id`;
  await logEvent(row.id, "queued", `Job created: "${topic}"`);
  return json({ id: row.id }, 201);
});
