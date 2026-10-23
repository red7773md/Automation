// Quick research: a web search whose facts are checked against the pages they cite before anything is
// written. Pure functions with no network access, so the rules can be tested.
import { extractJson } from "@/lib/adapters/parse";
import type { ConfirmedPoint, QuickSearch, SearchPoint } from "@/lib/adapters/types";
import type { ResearchStyle } from "./states";
import { COMMENT_TOTAL_LIMIT } from "./comments";

export const QUICK_MAX_POINTS = 8;
export const QUICK_MAX_SOURCES = 6; // pages opened per job
export const QUICK_SOURCE_CHARS = 8000; // text of each page sent to the checker
const PINNED_LIMIT = COMMENT_TOTAL_LIMIT; // the most text a description may hold: its numbered comments together

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

const CLAIM_KEYS = ["claim", "fact", "statement", "text", "point"];
const URL_KEYS = ["url", "link", "href", "source_url", "sourceUrl", "source"];
const LIST_KEYS = ["points", "facts", "findings", "items", "results"];
const URL_IN_TEXT = /https?:\/\/[^\s)\]"'<>]+/g;

function firstText(r: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** A web address from the item's own keys, or from a list of sources. Anything else is not an address. */
function firstWebUrl(r: Record<string, unknown>): string {
  for (const k of URL_KEYS) {
    const v = r[k];
    if (typeof v === "string" && isWebAddress(v.trim())) return v.trim();
  }
  if (Array.isArray(r.sources)) {
    for (const s of r.sources) {
      const u = typeof s === "string" ? s.trim() : s && typeof s === "object" ? firstText(s as Record<string, unknown>, URL_KEYS) : "";
      if (isWebAddress(u)) return u;
    }
  }
  return "";
}

function pointsFromJson(d: Record<string, any>): SearchPoint[] {
  const list = LIST_KEYS.map((k) => d[k]).find(Array.isArray) ?? [];
  const out: SearchPoint[] = [];
  for (const item of list as unknown[]) {
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const claim = firstText(r, CLAIM_KEYS);
    const url = firstWebUrl(r);
    if (claim && url) out.push({ claim, url, title: firstText(r, ["title", "name", "source_title"]) || url });
  }
  return out;
}

/** When the reply is prose: a line with a web address gives a fact, its address is the source. */
function pointsFromText(text: string): SearchPoint[] {
  const out: SearchPoint[] = [];
  for (const line of text.split("\n")) {
    const urls = line.match(URL_IN_TEXT);
    if (!urls) continue;
    const claim = line
      .replace(URL_IN_TEXT, " ")
      .replace(/[*_`#>|[\]()"{}]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[-•\d.)\s]+/, "")
      .trim();
    if (claim.length < 15) continue;
    const url = urls[0].replace(/[.,;:]+$/, "");
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* keep the address as the title */
    }
    out.push({ claim: claim.slice(0, 300), url, title: host });
  }
  return out;
}

/** Reads the search reply. A fact without a web address is dropped: it could not be checked. */
export function parseSearchReply(text: string): QuickSearch {
  let d: Record<string, any> = {};
  try {
    d = extractJson(text) as Record<string, any>;
  } catch {
    d = {}; // not JSON: the facts may still be in the text
  }
  let points = pointsFromJson(d);
  if (!points.length) points = pointsFromText(text);
  points = points.slice(0, QUICK_MAX_POINTS);
  if (!points.length) {
    // The start of the reply is shown, so the cause can be seen without a log.
    const sample = text.replace(/\s+/g, " ").trim().slice(0, 300) || "(empty reply)";
    throw new Error(
      `The search gave no facts with web addresses. Gemini replied: "${sample}". Retry the job, or use deep research.`,
    );
  }
  return { summary: String(d.summary ?? "").trim().slice(0, 600), points };
}

const YES = new Set(["true", "yes", "supported", "y", "1"]);

/**
 * Reads the checker's reply. Only a yes counts as supported. The claim, address and title come from the search:
 * a check that gives the address in another form is matched by its claim, or else by its place in the list.
 */
export function parseConfirmReply(text: string, points: SearchPoint[]): ConfirmedPoint[] {
  const d = extractJson(text);
  const items: unknown[] = Array.isArray(d.checks) ? d.checks : [];
  const byUrl = new Map(points.map((p) => [p.url, p]));
  const byClaim = new Map(points.map((p) => [p.claim.trim().toLowerCase(), p]));
  const out: ConfirmedPoint[] = [];
  items.forEach((item, i) => {
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const point =
      byUrl.get(String(r.url ?? "").trim()) ??
      byClaim.get(String(r.claim ?? "").trim().toLowerCase()) ??
      points[i];
    if (!point) return;
    out.push({
      claim: point.claim,
      url: point.url,
      title: point.title,
      supported: r.supported === true || YES.has(String(r.supported).trim().toLowerCase()),
      reason: String(r.reason ?? "").trim().slice(0, 200) || undefined,
    });
  });
  return out;
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
