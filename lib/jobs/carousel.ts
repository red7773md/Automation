// Carousel posts: the slide count and the plan the analysis returns, or the slides written by hand. Pure
// functions with no I/O, so the rules can be tested and the browser can import the limits.
import { extractJson } from "@/lib/adapters/parse";
import type { CarouselPlan, Slide } from "@/lib/adapters/types";
import type { JobFormat } from "./states";

export const CAROUSEL_MIN = 3;
export const CAROUSEL_MAX = 10; // Instagram allows at most 10 pictures in one carousel
export const CAROUSEL_DEFAULT = 8;

// Safety limits on what the analysis returns. The prompt asks for less; these only stop a long reply from overflowing the slide.
export const FIGURE_LIMIT = 16;
export const HEADLINE_LIMIT = 90;
export const BODY_LIMIT = 220;

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
    const imagePrompt = cleanSlideText(String(s.imagePrompt ?? ""));
    if (!imagePrompt) throw new Error(`Slide ${slides.length + 1} has no image prompt. Retry the analysis.`);
    const role = ROLES.includes(s.role as (typeof ROLES)[number]) ? (s.role as Slide["role"]) : "point";
    const isHook = slides.length === 0;
    const figure = isHook ? cut(cleanSlideText(String(s.figure ?? "")), FIGURE_LIMIT) : "";
    slides.push({
      role: isHook ? "hook" : role === "hook" ? "point" : role,
      ...(figure ? { figure } : {}),
      headline: cut(cleanSlideText(String(s.headline ?? "")), HEADLINE_LIMIT),
      body: cut(cleanSlideText(String(s.body ?? "")), BODY_LIMIT),
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

/**
 * Gemini sometimes leaves citation markers such as [cite: 1] or [2] in its text. They are not part of the
 * slide, and an image would draw them, so they are removed wherever slide text is used.
 */
export function cleanSlideText(text: string | undefined): string {
  return (text ?? "")
    .replace(/\[cite[^\]]*\]/gi, "")
    .replace(/\[\d+(?:[,\s]+\d+)*\]/g, "")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Shortens text to at most `max` characters, at a word boundary where possible. */
export function cut(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  return `${head.replace(/\s+\S*$/, "")}…`;
}

/** The format a request asks for. A missing format is a single post. */
export function parseFormat(raw: unknown): JobFormat {
  if (raw === undefined || raw === null || raw === "") return "post";
  if (raw === "post" || raw === "carousel") return raw;
  throw new Error('The format must be "post" or "carousel"');
}
