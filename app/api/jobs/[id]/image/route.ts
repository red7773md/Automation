import { adminRoute, json, UUID_RE } from "@/lib/api";
import { draftPath, saveDraft } from "@/lib/blob";
import { getDb } from "@/lib/db";
import { shrinkForSending, sniffImage } from "@/lib/images";

type P = { id: string };

const MAX_UPLOAD = 20 * 1024 * 1024;

// Admin-only. Gives a picture to a job that waits at the image step (Skip image generation).
// The body is the picture itself. It is resized like a generated one, then the job goes on to the check.
export const POST = adminRoute<P>(async (req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);

  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length === 0) return json({ error: "The upload is empty" }, 400);
  if (bytes.length > MAX_UPLOAD) return json({ error: "The picture is larger than 20 MB" }, 413);
  if (!sniffImage(bytes)) return json({ error: "Upload a PNG, JPEG, WEBP or GIF picture" }, 415);

  const sql = await getDb();
  const [job] = await sql`select state, attempts, data from jobs where id = ${id}::uuid`;
  if (!job) return json({ error: "Job not found" }, 404);
  if (job.state !== "generating" || job.data?.workflow?.skipImage !== true) {
    return json({ error: "This job is not waiting for an image upload" }, 409);
  }

  const shrunk = await shrinkForSending(bytes);
  // The attempt number is the one the step will use, so the draft and the post find the same file.
  const path = draftPath(id, job.attempts + 1);
  await saveDraft(path, shrunk.bytes, shrunk.contentType);
  await sql`
    update jobs set data = data || ${JSON.stringify({ uploadedDraftPath: path })}::jsonb, updated_at = now()
    where id = ${id}::uuid and state = 'generating'`;
  return json({ ok: true, path, bytes: shrunk.bytes.length, width: shrunk.width, height: shrunk.height });
});
