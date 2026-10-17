import { adminRoute, json, UUID_RE } from "@/lib/api";
import { openDraft } from "@/lib/blob";
import { getDb } from "@/lib/db";

type P = { id: string };

// Admin-only preview of the private draft image.
export const GET = adminRoute<P>(async (_req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);
  const sql = await getDb();
  const [job] = await sql`select data from jobs where id = ${id}::uuid`;
  const path = job?.data?.draftPath as string | undefined;
  if (!path) return json({ error: "No draft yet" }, 404);
  const draft = await openDraft(path);
  return new Response(draft.stream, {
    headers: { "content-type": draft.contentType, "cache-control": "no-store" },
  });
});
