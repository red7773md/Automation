// Carousel posts: the slide count and the plan the analysis returns, or the slides written by hand. Pure
// functions with no I/O, so the rules can be tested and the browser can import the limits.
import { extractJson } from "@/lib/adapters/parse";
import type { CarouselPlan, Slide } from "@/lib/adapters/types";
import type { Shape } from "./design";
import { cleanSlideText, composePicturePrompt, cut, parseParts, partsFromText, STYLE_LIMIT } from "./picture-prompt";
import type { JobFormat } from "./states";

export { cleanSlideText, cut };

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

/**
 * Reads the analysis reply and keeps at most `requested` slides. The first slide is always the hook. Each slide's
 * picture is read in parts and joined into its prompt with the shared look and the picture rules for `shape`.
 * A reply that describes a picture in plain text (imagePrompt) is still accepted.
 */
export function parseCarouselPlan(text: string, requested: number, shape: Shape = "square"): CarouselPlan {
  const data = extractJson(text);
  const styleGuide = cut(cleanSlideText(String(data.styleGuide ?? "")), STYLE_LIMIT);
  const list: unknown[] = Array.isArray(data.slides) ? data.slides : [];
  const slides: Slide[] = [];
  for (const item of list.slice(0, requested)) {
    const s = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const plainText = typeof s.imagePrompt === "string" && s.imagePrompt.trim() ? partsFromText(s.imagePrompt) : null;
    const parts = parseParts(s.picture) ?? plainText;
    if (!parts) throw new Error(`Slide ${slides.length + 1} has no image prompt. Retry the analysis.`);
    const role = ROLES.includes(s.role as (typeof ROLES)[number]) ? (s.role as Slide["role"]) : "point";
    const isHook = slides.length === 0;
    const figure = isHook ? cut(cleanSlideText(String(s.figure ?? "")), FIGURE_LIMIT) : "";
    slides.push({
      role: isHook ? "hook" : role === "hook" ? "point" : role,
      ...(figure ? { figure } : {}),
      headline: cut(cleanSlideText(String(s.headline ?? "")), HEADLINE_LIMIT),
      body: cut(cleanSlideText(String(s.body ?? "")), BODY_LIMIT),
      imagePrompt: composePicturePrompt(parts, shape, styleGuide),
      parts,
    });
  }
  if (slides.length < 2) {
    throw new Error(`The analysis gave ${slides.length} slide(s). A carousel needs at least 2. Retry the analysis.`);
  }
  return {
    analysis: String(data.analysis ?? "").trim(),
    styleGuide,
    slides,
  };
}

/**
 * Slides written by hand: one picture description per line, the first line is the hook. Each line becomes the scene
 * of its picture, and the picture rules for `shape` are added. Blank lines are ignored.
 */
export function slidesFromLines(text: string, max: number, shape: Shape = "square"): Slide[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("Write one image prompt per line, at least two lines.");
  if (lines.length > max) {
    throw new Error(`You wrote ${lines.length} image prompts, but this carousel has ${max} slides. Remove some, or raise the number of slides.`);
  }
  return lines.map((line, i): Slide => {
    const parts = partsFromText(line);
    return { role: i === 0 ? "hook" : "point", headline: "", body: "", imagePrompt: composePicturePrompt(parts, shape), parts };
  });
}

/** The format a request asks for. A missing format is a single post. */
export function parseFormat(raw: unknown): JobFormat {
  if (raw === undefined || raw === null || raw === "") return "post";
  if (raw === "post" || raw === "carousel") return raw;
  throw new Error('The format must be "post" or "carousel"');
}
