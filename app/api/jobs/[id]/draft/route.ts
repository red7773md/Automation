import { adminRoute, json, UUID_RE } from "@/lib/api";
import { draftPath, finalDraftPath, openDraft } from "@/lib/blob";
import { getDb } from "@/lib/db";

type P = { id: string };

// Admin-only preview of a private draft image. A carousel slide is asked for with ?slide=N (0-based).
export const GET = adminRoute<P>(async (req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);
  const sql = await getDb();
  const [job] = await sql`select data from jobs where id = ${id}::uuid`;
  if (!job) return json({ error: "Job not found" }, 404);

  const slideParam = new URL(req.url).searchParams.get("slide");
  let path: string | undefined;
  if (slideParam !== null) {
    const n = Number(slideParam);
    const images = (job.data?.slideImages ?? []) as Array<{ attempt: number }>;
    const img = Number.isInteger(n) ? images[n] : undefined;
    if (!img) return json({ error: "No picture for that slide yet" }, 404);
    path = draftPath(id, img.attempt, n);
  } else {
    path = job.data?.draftPath as string | undefined;
  }
  if (!path) return json({ error: "No draft yet" }, 404);

  // A carousel slide shows its final picture (with the text) once the text is drawn, and its checked picture before that.
  let draft;
  if (slideParam !== null) {
    const n = Number(slideParam);
    const img = (job.data?.slideImages ?? [])[n] as { attempt: number } | undefined;
    try {
      draft = await openDraft(finalDraftPath(id, img!.attempt, n));
    } catch {
      draft = await openDraft(path);
    }
  } else {
    draft = await openDraft(path);
  }
  return new Response(draft.stream, {
    headers: { "content-type": draft.contentType, "cache-control": "no-store" },
  });
});
