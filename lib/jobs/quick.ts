// Quick research: a web search whose facts are checked against the pages they cite before anything is
// written. Pure functions with no network access, so the rules can be tested.
import { extractJson } from "@/lib/adapters/parse";
import type { ConfirmedPoint, QuickSearch, SearchPoint } from "@/lib/adapters/types";
import type { ResearchStyle } from "./states";

export const QUICK_MAX_POINTS = 8;
export const QUICK_MAX_SOURCES = 5; // pages opened per job
export const QUICK_SOURCE_CHARS = 8000; // text of each page sent to the checker
const PINNED_LIMIT = 2200; // Instagram comment limit

/** Missing means deep research, which is what jobs did before this option existed. */
export function parseResearchStyle(raw: unknown): ResearchStyle {
  if (raw === undefined || raw === null || raw === "") return "deep";
  if (raw === "deep" || raw === "quick") return raw;
  throw new Error('The research style must be "deep" or "quick"');
}

function isWebAddress(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Reads the search reply. A fact without a web address is dropped: it could not be checked. */
export function parseSearchReply(text: string): QuickSearch {
  const d = extractJson(text);
  const items: unknown[] = Array.isArray(d.points) ? d.points : [];
  const points: SearchPoint[] = [];
  for (const item of items) {
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const claim = String(r.claim ?? "").trim();
    const url = String(r.url ?? "").trim();
    if (!claim || !isWebAddress(url)) continue;
    points.push({ claim: claim.slice(0, 300), url, title: String(r.title ?? "").trim().slice(0, 160) || url });
    if (points.length === QUICK_MAX_POINTS) break;
  }
  if (!points.length) throw new Error("The search gave no facts with web addresses. Retry the research, or use deep research.");
  return { summary: String(d.summary ?? "").trim().slice(0, 600), points };
}

/** Reads the checker's reply. Only a yes counts as supported. The title comes from the search. */
export function parseConfirmReply(text: string, points: SearchPoint[]): ConfirmedPoint[] {
  const d = extractJson(text);
  const items: unknown[] = Array.isArray(d.checks) ? d.checks : [];
  const titles = new Map(points.map((p) => [p.url, p.title]));
  return items
    .map((item): ConfirmedPoint => {
      const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const url = String(r.url ?? "");
      return {
        claim: String(r.claim ?? "").trim(),
        url,
        title: titles.get(url) ?? url,
        supported: r.supported === true || String(r.supported).toLowerCase() === "true",
        reason: String(r.reason ?? "").trim().slice(0, 200) || undefined,
      };
    })
    .filter((c) => c.claim && c.url);
}

/** The pages to open: each address once, in the order the search gave them. */
export function sourceUrls(points: SearchPoint[], max = QUICK_MAX_SOURCES): string[] {
  return [...new Set(points.map((p) => p.url))].slice(0, max);
}

/** A fact counts only when the checker supports it and its page could be read. */
export function keepConfirmed(confirmed: ConfirmedPoint[], readable: Set<string>): ConfirmedPoint[] {
  return confirmed.filter((c) => c.supported && readable.has(c.url));
}

/** The pages the kept facts cite, each once. */
export function citedSources(kept: ConfirmedPoint[]): { url: string; title: string }[] {
  const seen = new Map<string, string>();
  for (const k of kept) if (!seen.has(k.url)) seen.set(k.url, k.title);
  return [...seen].map(([url, title]) => ({ url, title }));
}

/** The report the analysis reads. It holds only checked facts. */
export function buildQuickReport(topic: string, kept: ConfirmedPoint[]): string {
  const lines = kept.map((k) => `- ${k.claim} ([${k.title.replace(/[[\]]/g, "")}](${k.url}))`);
  return [
    `# Checked facts: ${topic}`,
    "",
    "Each point below was found by a web search and checked against the page it cites before use.",
    "",
    ...lines,
    "",
  ].join("\n");
}

/** The pinned comment, with the sources added at the end. The whole comment stays within the limit. */
export function withSources(commentBody: string, cited: { url: string; title: string }[] | undefined): string {
  const body = commentBody.trim();
  if (!cited?.length) return body.slice(0, PINNED_LIMIT);
  const block = [
    "Sources, checked before posting:",
    ...cited.slice(0, 5).map((c, i) => `${i + 1}. ${c.title.slice(0, 90)}\n   ${c.url}`),
  ].join("\n");
  const room = PINNED_LIMIT - block.length - 2;
  return `${body.slice(0, Math.max(0, room))}\n\n${block}`;
}
