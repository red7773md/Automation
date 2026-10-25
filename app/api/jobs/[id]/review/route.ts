import { adminRoute, json, UUID_RE } from "@/lib/api";
import { getDb } from "@/lib/db";
import { logEvent } from "@/lib/logger";

type P = { id: string };

export const POST = adminRoute<P>(async (req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);

  const body = await req.json().catch(() => null);
  const action = body?.action;
  const feedback = typeof body?.feedback === "string" ? body.feedback.trim().slice(0, 500) : "";

  const sql = await getDb();
  const [job] = await sql`select state, data from jobs where id = ${id}::uuid`;
  if (!job) return json({ error: "Job not found" }, 404);
  if (job.state !== "awaiting_review") {
    return json({ error: `Job is "${job.state}", not waiting for review` }, 409);
  }

  if (action === "approve") {
    const [ok] = await sql`
      update jobs set state = 'publishing', error = null, updated_at = now(),
        data = data || ${JSON.stringify({ approvedAt: new Date().toISOString() })}::jsonb
      where id = ${id}::uuid and state = 'awaiting_review'
      returning id`;
    if (!ok) return json({ error: "The job changed. Reload the page." }, 409);
    await logEvent(id, "awaiting_review", "Approved by admin. Publishing next.");
    return json({ ok: true, state: "publishing" });
  }

  if (action === "reject" && job.data.format === "carousel") {
    // A carousel is made again from its first slide: every picture is made anew, with the reviewer's notes.
    const [ok] = await sql`
      update jobs set state = 'generating', error = null, updated_at = now(),
        data = data || ${JSON.stringify({ reviewFeedback: feedback, slideImages: [], verdict: null, nextPrompt: null })}::jsonb
      where id = ${id}::uuid and state = 'awaiting_review'
      returning id`;
    if (!ok) return json({ error: "The job changed. Reload the page." }, 409);
    const slides = job.data.slideCount ? `all ${job.data.slideCount} slides` : "all the slides";
    await logEvent(id, "awaiting_review", `Rejected. Making ${slides} again${feedback ? `: "${feedback}"` : "."}`);
    return json({ ok: true, state: "generating" });
  }

  if (action === "reject") {
    const basePrompt = job.data.imagePrompt ?? job.data.plan?.imagePrompt ?? "";
    const nextPrompt = `${basePrompt}\n\nReviewer notes: ${feedback || "fix the problems visible in the previous image"}`;
    const [ok] = await sql`
      update jobs set state = 'generating', error = null, updated_at = now(),
        data = data || ${JSON.stringify({ nextPrompt, reviewFeedback: feedback })}::jsonb
      where id = ${id}::uuid and state = 'awaiting_review'
      returning id`;
    if (!ok) return json({ error: "The job changed. Reload the page." }, 409);
    await logEvent(id, "awaiting_review", `Rejected. Regenerating${feedback ? `: "${feedback}"` : "."}`);
    return json({ ok: true, state: "generating" });
  }

  return json({ error: 'action must be "approve" or "reject"' }, 400);
});
