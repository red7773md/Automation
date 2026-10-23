import { UUID_RE } from "@/lib/api";
import { draftPath, finalDraftPath, openDraft } from "@/lib/blob";
import { verifyMediaSignature } from "@/lib/media";

type P = { jobId: string; attempt: string };

// Public on purpose: Instagram fetches the image from here. Access is granted only
// by a valid, unexpired HMAC signature created at publish time.
export async function GET(req: Request, { params }: { params: Promise<P> }) {
  const { jobId, attempt } = await params;
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";

  // A carousel picture names its slide (0 to 9). A single post names none. Anything else is refused.
  const slideParam = url.searchParams.get("slide");
  const slide = slideParam === null ? undefined : /^\d$/.test(slideParam) ? Number(slideParam) : null;

  if (
    !UUID_RE.test(jobId) ||
    !/^\d{1,4}$/.test(attempt) ||
    slide === null ||
    !verifyMediaSignature(jobId, Number(attempt), exp, sig, slide)
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    // A carousel slide is posted with its text on it, so its link serves the final picture.
    const path = slide === undefined ? draftPath(jobId, Number(attempt)) : finalDraftPath(jobId, Number(attempt), slide);
    const draft = await openDraft(path);
    return new Response(draft.stream, {
      headers: { "content-type": draft.contentType, "cache-control": "public, max-age=300" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
