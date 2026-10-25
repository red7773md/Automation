import { adminRoute, json, UUID_RE } from "@/lib/api";
import { draftPath, saveDraft } from "@/lib/blob";
import { getDb } from "@/lib/db";
import { shapeForInstagram, shrinkForSending, sniffImage } from "@/lib/images";
import { sizeOf } from "@/lib/jobs/design";
import type { JobData, SlideImage } from "@/lib/jobs/states";

type P = { id: string };

const MAX_UPLOAD = 20 * 1024 * 1024;

/** The slot a picture goes to: 0 for a single post; for a carousel, the slide named by ?slot=N (0-based). */
function slotOf(raw: string | null, total: number, isCarousel: boolean): number | null {
  if (!isCarousel) return raw === null || raw === "0" ? 0 : null;
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n < total ? n : null;
}

// Admin-only. Gives one picture to a job that waits for its pictures. A single post has one picture; a carousel
// has one per slide. The picture is cut to the carousel's frame where needed, resized, and kept privately.
// Uploading again to the same slot replaces the picture.
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
  if (job.state !== "generating") return json({ error: "This job is not waiting for pictures" }, 409);

  const d = job.data as JobData;
  const isCarousel = (d.format ?? "post") === "carousel";
  const total = isCarousel ? (d.carousel?.slides.length ?? 0) : 1;
  const slot = slotOf(new URL(req.url).searchParams.get("slot"), total, isCarousel);
  if (slot === null) return json({ error: `Choose a picture from 1 to ${total}` }, 400);

  // A carousel picture is cut to the carousel's shape first, so every slide has the same frame.
  const shape = d.design?.shape ?? "square";
  const cut = isCarousel ? await shapeForInstagram(bytes, shape) : bytes;
  const shrunk = await shrinkForSending(cut, isCarousel ? sizeOf(shape) : undefined);
  // The attempt is the job's current attempt, so the picture and its link find the same file when the post goes out.
  const attempt = job.attempts;
  const path = draftPath(id, attempt, isCarousel ? slot : undefined);
  await saveDraft(path, shrunk.bytes, shrunk.contentType);

  if (isCarousel) {
    // The job's pictures are kept as one list. The whole list is written back, so the slots must not be sent at once.
    const images: (SlideImage | null)[] = Array.from({ length: total }, (_, i) => d.slideImages?.[i] ?? null);
    images[slot] = { attempt, path, tries: 1 };
    await sql`
      update jobs set data = data || ${JSON.stringify({ slideImages: images })}::jsonb, updated_at = now()
      where id = ${id}::uuid and state = 'generating'`;
  } else {
    await sql`
      update jobs set data = data || ${JSON.stringify({ draftPath: path })}::jsonb, updated_at = now()
      where id = ${id}::uuid and state = 'generating'`;
  }
  return json({ ok: true, slot, path, bytes: shrunk.bytes.length, width: shrunk.width, height: shrunk.height });
});
