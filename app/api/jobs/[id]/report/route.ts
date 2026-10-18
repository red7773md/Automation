import { adminRoute, json, UUID_RE } from "@/lib/api";
import { openDraft } from "@/lib/blob";
import { getDb } from "@/lib/db";

type P = { id: string };

// Admin-only download of the research report as a Markdown file.
export const GET = adminRoute<P>(async (_req, { params }) => {
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "Invalid job id" }, 400);
  const sql = await getDb();
  const [job] = await sql`select data from jobs where id = ${id}::uuid`;
  if (!job) return json({ error: "Job not found" }, 404);
  const path = job.data?.reportPath as string | undefined;
  if (!path) return json({ error: "No report yet" }, 404);
  let report;
  try {
    report = await openDraft(path);
  } catch {
    return json({ error: "The report file is missing from storage" }, 404);
  }
  return new Response(report.stream, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="research-report-${id.slice(0, 8)}.md"`,
      "cache-control": "no-store",
    },
  });
});
