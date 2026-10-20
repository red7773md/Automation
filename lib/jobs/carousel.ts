// Carousel posts: the slide count, the plan the analysis returns, the prompt for each slide and the
// overall check. Pure functions with no I/O, so the rules can be tested and the browser can import the limits.
import { extractJson } from "@/lib/adapters/parse";
import type { CarouselPlan, Slide, Verdict } from "@/lib/adapters/types";
import type { JobFormat, SlideImage } from "./states";
import type { Workflow } from "./workflow";
import { cutTo, MAX_IMAGE_PROMPT } from "@/lib/prompt-length";

export const CAROUSEL_MIN = 3;
export const CAROUSEL_MAX = 10; // Instagram allows at most 10 pictures in one carousel
export const CAROUSEL_DEFAULT = 8;
export const CAROUSEL_TRIES = 2; // a slide is made at most twice: the first try and one correction

export function clampSlideCount(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < CAROUSEL_MIN || n > CAROUSEL_MAX) {
    throw new Error(`The number of slides must be a whole number from ${CAROUSEL_MIN} to ${CAROUSEL_MAX}`);
  }
  return n;
}

const ROLES = ["hook", "point", "cta"] as const;

/** Reads the analysis reply and keeps at most `requested` slides. The first slide is always the hook. */
export function parseCarouselPlan(text: string, requested: number): CarouselPlan {
  const data = extractJson(text);
  const list: unknown[] = Array.isArray(data.slides) ? data.slides : [];
  const slides: Slide[] = [];
  for (const item of list.slice(0, requested)) {
    const s = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const imagePrompt = String(s.imagePrompt ?? "").trim();
    if (!imagePrompt) throw new Error(`Slide ${slides.length + 1} has no image prompt. Retry the analysis.`);
    const role = ROLES.includes(s.role as (typeof ROLES)[number]) ? (s.role as Slide["role"]) : "point";
    slides.push({
      role: slides.length === 0 ? "hook" : role === "hook" ? "point" : role,
      headline: String(s.headline ?? "").trim().slice(0, 200),
      body: String(s.body ?? "").trim().slice(0, 300),
      imagePrompt,
    });
  }
  if (slides.length < 2) {
    throw new Error(`The analysis gave ${slides.length} slide(s). A carousel needs at least 2. Retry the analysis.`);
  }
  return {
    analysis: String(data.analysis ?? "").trim(),
    styleGuide: String(data.styleGuide ?? "").trim(),
    slides,
  };
}

/** Slides written by hand: one image prompt per line, the first line is the hook. Blank lines are ignored. */
export function slidesFromLines(text: string, max: number): Slide[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("Write one image prompt per line, at least two lines.");
  if (lines.length > max) {
    throw new Error(`You wrote ${lines.length} image prompts, but this carousel has ${max} slides. Remove some, or raise the number of slides.`);
  }
  return lines.map((imagePrompt, i): Slide => ({ role: i === 0 ? "hook" : "point", headline: "", body: "", imagePrompt }));
}

type SlideParts = { style: string; fixed: string; idea: string; notes: string };

function joinParts(p: SlideParts): string {
  return [p.style, p.fixed, p.idea, p.notes].filter(Boolean).join("\n");
}

/**
 * The prompt for one slide. Every slide gets the same style, so the set reads as one post.
 * The image tool takes at most MAX_IMAGE_PROMPT characters. The text the picture must show is
 * never cut; the picture idea and the notes are shortened first, then the style.
 */
export function slidePrompt(style: string, slide: Slide, position: { index: number; total: number }, notes: string[] = []): string {
  const p: SlideParts = {
    style: style ? `Style for every slide of this carousel: ${style}` : "",
    fixed: [
      `Slide ${position.index + 1} of ${position.total}.`,
      slide.headline ? `Show this text exactly as written, large and easy to read: "${slide.headline}".` : "",
      slide.body ? `Under it, a smaller line of text, exactly as written: "${slide.body}".` : "",
      slide.role === "hook" ? `Also show the words "Swipe for more" with a small arrow in the bottom-right corner.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    idea: slide.imagePrompt,
    notes: notes.length ? `Fix these problems: ${notes.join(" ")}` : "",
  };
  let over = joinParts(p).length - MAX_IMAGE_PROMPT;
  if (over > 0) {
    p.notes = cutTo(p.notes, p.notes.length - over);
    over = joinParts(p).length - MAX_IMAGE_PROMPT;
  }
  if (over > 0) {
    p.idea = cutTo(p.idea, p.idea.length - over);
    over = joinParts(p).length - MAX_IMAGE_PROMPT;
  }
  if (over > 0) p.style = cutTo(p.style, p.style.length - over);
  return cutTo(joinParts(p), MAX_IMAGE_PROMPT); // last resort, only if the fixed text alone is too long
}

/** The headline the picture must show, for the check. Slides written by hand have none. */
export function expectedText(slide: Slide): string | undefined {
  return slide.headline || undefined;
}

/** One verdict for the whole carousel. Any slide that did not pass makes the set fail, and each issue names its slide. */
export function carouselVerdict(images: SlideImage[], total: number, skipped: boolean): Verdict {
  if (skipped) return { pass: true, issues: [], skipped: true };
  const issues: string[] = [];
  for (let i = 0; i < total; i++) {
    const img = images[i];
    if (!img) {
      issues.push(`Slide ${i + 1}: not made yet`);
      continue;
    }
    if (img.pass === true) continue;
    const reasons = img.issues?.length ? img.issues : [img.pass === false ? "failed the check" : "not checked"];
    for (const reason of reasons) issues.push(`Slide ${i + 1}: ${reason}`);
  }
  return { pass: issues.length === 0, issues };
}

/** The format a request asks for. A missing format is a single post. */
export function parseFormat(raw: unknown): JobFormat {
  if (raw === undefined || raw === null || raw === "") return "post";
  if (raw === "post" || raw === "carousel") return raw;
  throw new Error('The format must be "post" or "carousel"');
}

/** A carousel makes one picture per slide, so there is nothing to upload in one go. Returns the problem, or null. */
export function carouselProblem(format: JobFormat, workflow: Workflow): string | null {
  if (format === "carousel" && workflow.skipImage) {
    return "A carousel makes one picture per slide, so image generation cannot be skipped. Choose another step to skip.";
  }
  return null;
}
