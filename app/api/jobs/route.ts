import { adminRoute, json } from "@/lib/api";
import { getDb } from "@/lib/db";
import { errorMessage, logEvent } from "@/lib/logger";
import { parseStart } from "@/lib/jobs/schedule";
import { carouselProblem, clampSlideCount, parseFormat, slidesFromLines } from "@/lib/jobs/carousel";
import type { JobFormat, ResearchStyle } from "@/lib/jobs/states";
import { parseResearchStyle } from "@/lib/jobs/quick";
import { activeSkips, missingManual, normalizeManual, normalizeWorkflow, type ManualInputs, type Workflow } from "@/lib/jobs/workflow";
import { loadCarousel, loadWorkflow } from "@/lib/settings";

export const GET = adminRoute(async () => {
  const sql = await getDb();
  const jobs = await sql`
    select id, topic, state, busy, attempts, error, scheduled_at, created_at, updated_at, data->>'format' as format, data->>'research' as research
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
  let format: JobFormat;
  let slideCount = 0; // set only for a carousel
  let research: ResearchStyle;
  try {
    // Without a workflow in the request, the saved defaults apply.
    workflow = body?.workflow === undefined ? await loadWorkflow() : normalizeWorkflow(body.workflow);
    manual = normalizeManual(body?.manual);
    format = parseFormat(body?.format);
    research = parseResearchStyle(body?.research); // missing means deep research, as before
    if (format === "carousel") {
      // Without a count in the request, the number saved in Settings applies.
      slideCount = body?.slideCount === undefined ? (await loadCarousel()).slideCount : clampSlideCount(body.slideCount);
    }
  } catch (err) {
    return json({ error: errorMessage(err) }, 400);
  }
  const problem = carouselProblem(format, workflow);
  if (problem) return json({ error: problem }, 400);
  const missing = missingManual(workflow, manual, format);
  if (missing) return json({ error: missing }, 400);
  if (format === "carousel" && workflow.skipAnalysis) {
    try {
      slidesFromLines(manual.slides ?? "", slideCount); // checked now, so a bad list fails here and not mid-job
    } catch (err) {
      return json({ error: errorMessage(err) }, 400);
    }
  }

  const data = format === "carousel" ? { workflow, manual, format, slideCount, research } : { workflow, manual, format, research };
  const sql = await getDb();
  const [row] = await sql`
    insert into jobs (topic, scheduled_at, data)
    values (${topic}, coalesce(${start.at?.toISOString() ?? null}::timestamptz, now()), ${JSON.stringify(data)}::jsonb)
    returning id, scheduled_at`;
  const when = start.at && start.at.getTime() > Date.now() ? `, starts ${start.at.toISOString()}` : "";
  const skips = activeSkips(workflow);
  const switched = skips.length ? `. Switched off: ${skips.join(", ")}` : "";
  const shape = format === "carousel" ? `carousel, up to ${slideCount} slides` : "single post";
  const kind = research === "quick" ? `${shape}, quick search and check` : shape;
  await logEvent(row.id, "queued", `Job created: "${topic}" (${kind})${when}${switched}`);
  return json({ id: row.id, scheduled_at: row.scheduled_at }, 201);
});
