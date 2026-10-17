import { adminRoute, json, UUID_RE } from "@/lib/api";
import { advanceJob } from "@/lib/jobs/runner";

// Upper bound for one step. Each Gemini call waits up to about 2 minutes.
export const maxDuration = 300;

type P = { id: string };

export const POST = adminRoute<P>(async (req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);
  const body = await req.json().catch(() => null);
  const result = await advanceJob(id, { force: body?.force === true });
  if (!result) return json({ error: "Job not found" }, 404);
  return json(result);
});
