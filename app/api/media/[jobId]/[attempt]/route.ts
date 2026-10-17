import { UUID_RE } from "@/lib/api";
import { openDraft } from "@/lib/blob";
import { verifyMediaSignature } from "@/lib/media";

type P = { jobId: string; attempt: string };

// Public on purpose: Instagram fetches the image from here. Access is granted only
// by a valid, unexpired HMAC signature created at publish time.
export async function GET(req: Request, { params }: { params: Promise<P> }) {
  const { jobId, attempt } = await params;
  const url = new URL(req.url);
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";

  if (!UUID_RE.test(jobId) || !/^\d{1,4}$/.test(attempt) || !verifyMediaSignature(jobId, Number(attempt), exp, sig)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const draft = await openDraft(`drafts/${jobId}/${attempt}`);
    return new Response(draft.stream, {
      headers: { "content-type": draft.contentType, "cache-control": "public, max-age=300" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
