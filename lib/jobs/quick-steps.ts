// Quick research: one web search, then every cited page is opened and each fact is checked against its text.
// Two steps: the search is kept on the job; the check opens the pages and keeps the verdicts. Page text is
// needed only for the check, so it is not stored. A retry after a failed check opens the pages again.
import { providers } from "@/lib/adapters";
import { reportPath, saveDraft } from "@/lib/blob";
import { fetchSource, type SourceText } from "@/lib/sources";
import type { ModelSettings } from "@/lib/settings";
import type { JobRow, SourceRecord } from "./states";
import { buildQuickReport, citedSources, keepConfirmed, QUICK_SOURCE_CHARS, sourceUrls } from "./quick";
import type { StepResult } from "./steps";

export async function quickResearch(job: JobRow, models: ModelSettings): Promise<StepResult> {
  const p = providers();
  const q = job.data.quick ?? {};

  if (!q.search) {
    const search = await p.gemini.search({ topic: job.topic, model: models.research });
    return {
      state: "researching",
      data: { quick: { ...q, search } },
      pending: true,
      note: `Web search done: ${search.points.length} facts with their pages. Opening the pages and checking each fact next.`,
    };
  }

  const search = q.search;
  const urls = sourceUrls(search.points);
  const titleOf = (url: string) => search.points.find((pt) => pt.url === url)?.title ?? url;

  // Mock mode makes no request to the cited pages: it uses fixed text, the same as the mock checks elsewhere.
  const pages: SourceText[] =
    p.mode === "mock"
      ? urls.map((url) => ({ url, title: titleOf(url), ok: true, text: `Mock page text for ${url}` }))
      : await Promise.all(urls.map((url) => fetchSource(url, titleOf(url))));
  const sources: SourceRecord[] = pages.map(({ url, title, ok, error }) => ({ url, title, ok, error }));
  const readable = new Set(pages.filter((s) => s.ok).map((s) => s.url));
  const toCheck = search.points.filter((pt) => readable.has(pt.url));
  if (!toCheck.length) {
    throw new Error(`None of the ${urls.length} cited pages could be opened, so no fact could be checked. Retry the job, or use deep research.`);
  }

  const confirmed = await p.gemini.confirm({
    topic: job.topic,
    points: toCheck,
    sources: pages
      .filter((s) => s.ok)
      .map((s) => ({ url: s.url, title: s.title, text: s.text.slice(0, QUICK_SOURCE_CHARS) })),
    model: models.analysis,
  });
  const kept = keepConfirmed(confirmed, readable);
  if (!kept.length) {
    throw new Error(`No fact could be confirmed in its source (${confirmed.length} checked). Retry the job, or use deep research.`);
  }

  // The report holds only checked facts. The analysis reads it like a deep research report.
  const report = buildQuickReport(job.topic, kept);
  const file = await saveDraft(reportPath(job.id), Buffer.from(report, "utf8"), "text/markdown; charset=utf-8");
  const unread = urls.length - readable.size;
  return {
    state: "analyzing",
    data: { report, reportPath: file, quick: { ...q, sources, confirmed, cited: citedSources(kept) } },
    note: `Checked ${confirmed.length} facts against ${readable.size} of ${urls.length} pages${
      unread ? ` (${unread} could not be opened)` : ""
    }. ${kept.length} confirmed and kept. Their sources go in the pinned comment.`,
  };
}
