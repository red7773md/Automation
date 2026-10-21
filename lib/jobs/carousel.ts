// Carousel posts: the slide count, the plan the analysis returns, the prompt for each slide and the
// overall check. Pure functions with no I/O, so the rules can be tested and the browser can import the limits.
import { extractJson } from "@/lib/adapters/parse";
import type { CarouselPlan, Slide, Verdict } from "@/lib/adapters/types";
import type { JobFormat, SlideImage } from "./states";
import type { Workflow } from "./workflow";

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

/** The Gemini image tool refuses a longer prompt ("Prompt is longer than 1000 characters"). */
export const IMAGE_PROMPT_LIMIT = 1000;

/**
 * Sent with every slide's picture request, so each request is complete on its own: the generator keeps nothing
 * from the slide before. Kept short, because the whole prompt must fit IMAGE_PROMPT_LIMIT.
 */
export const IMAGE_RULES = [
  "FORMAT: one square picture, exactly 1:1, 1080 by 1080 px, edge to edge, no border or margin. Never landscape or portrait.",
  "NO LOGO: no logo, brand mark, watermark, badge, signature, handle or website anywhere, corners included.",
  "Keep the subject and text 10% away from every edge. Only the words given for this slide may appear as text.",
].join("\n");

/** Shortens text to at most `max` characters, at a word boundary where possible. */
function cut(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  return `${head.replace(/\s+\S*$/, "")}…`;
}

/**
 * The prompt for one slide. Every slide gets the same rules and style, so the set reads as one post.
 * The rules, the headline and the slide's text are always kept. When the prompt would be too long, the
 * scene description is shortened first, then the style, then the fixes.
 */
export function slidePrompt(style: string, slide: Slide, position: { index: number; total: number }, notes: string[] = []): string {
  const mandatory = [
    IMAGE_RULES,
    `Slide ${position.index + 1} of ${position.total}.`,
    slide.headline ? `Show this text exactly as written, large and easy to read: "${cut(slide.headline, 200)}".` : "",
    slide.body ? `Under it, a smaller line of text, exactly as written: "${cut(slide.body, 200)}".` : "",
    slide.role === "hook" ? `Also show the words "Swipe for more" with a small arrow in the bottom-right corner.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  let room = IMAGE_PROMPT_LIMIT - mandatory.length - 1;
  const parts: string[] = [];
  // Each optional part takes what is left, in order of importance.
  const scene = cut(slide.imagePrompt, Math.min(room, 600));
  if (scene) {
    parts.push(scene);
    room -= scene.length + 1;
  }
  const styleText = style ? cut(`Style for every slide of this carousel: ${style}`, Math.min(room, 200)) : "";
  if (styleText) {
    parts.push(styleText);
    room -= styleText.length + 1;
  }
  const fixText = notes.length ? cut(`Fix these problems: ${notes.join(" ")}`, Math.min(room, 200)) : "";
  if (fixText) parts.push(fixText);
  return [mandatory, ...parts].join("\n");
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
