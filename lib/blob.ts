// One PRIVATE Vercel Blob store holds everything. Nothing is ever stored as public.
import { get, put } from "@vercel/blob";

export function draftPath(jobId: string, attempt: number): string {
  return `drafts/${jobId}/${attempt}`;
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
