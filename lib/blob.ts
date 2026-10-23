// One PRIVATE Vercel Blob store holds everything. Nothing is ever stored as public.
import { get, put } from "@vercel/blob";

/** Where a picture is kept. A carousel keeps one picture per slide: drafts/{job}/{attempt}-{slide}. */
export function draftPath(jobId: string, attempt: number, slide?: number): string {
  return slide === undefined ? `drafts/${jobId}/${attempt}` : `drafts/${jobId}/${attempt}-${slide}`;
}

/**
 * The picture as it is reviewed and posted: a carousel slide with its text on it. It is kept apart from the
 * checked picture, which is never changed, so the check always sees a picture with no text.
 */
export function finalDraftPath(jobId: string, attempt: number, slide: number): string {
  return `drafts/${jobId}/${attempt}-${slide}-final`;
}

/** The research report, saved as Markdown. It is downloadable and is what the analysis chat reads. */
export function reportPath(jobId: string): string {
  return `reports/${jobId}.md`;
}

export async function saveDraft(path: string, bytes: Buffer, contentType: string): Promise<string> {
  const blob = await put(path, bytes, {
    access: "private",
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return blob.pathname;
}

export async function openDraft(path: string): Promise<{ stream: ReadableStream<Uint8Array>; contentType: string }> {
  const res = await get(path, { access: "private" });
  if (!res || res.statusCode !== 200) throw new Error(`Draft not found in Blob storage: ${path}`);
  return { stream: res.stream, contentType: res.blob.contentType };
}

export async function readDraft(path: string): Promise<{ bytes: Buffer; contentType: string }> {
  const { stream, contentType } = await openDraft(path);
  return { bytes: Buffer.from(await new Response(stream).arrayBuffer()), contentType };
}
