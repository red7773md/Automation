import { adminRoute, json, UUID_RE } from "@/lib/api";
import { advanceJob } from "@/lib/jobs/runner";

// Upper bound for one step (the image step can wait up to 4 minutes for ChatGPT).
export const maxDuration = 300;

type P = { id: string };

export const POST = adminRoute<P>(async (_req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);
  const result = await advanceJob(id);
  if (!result) return json({ error: "Job not found" }, 404);
  return json(result);
});
