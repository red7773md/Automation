// The prompt for one picture. The analysis describes each picture in parts (subject, scene, composition, and so
// on); this module joins them into one prompt and always adds the picture rules for the shape, so the shape and
// the no-text rule are never left out. Pure functions with no I/O, so the rules can be tested.
import type { PictureParts } from "@/lib/adapters/types";
import { imageRules, type Shape } from "./design";

/** The parts in the order they are written into the prompt. */
export const PART_KEYS: readonly (keyof PictureParts)[] = [
  "subject",
  "scene",
  "composition",
  "lighting",
  "palette",
  "style",
  "mood",
  "avoid",
];

const LABEL: Record<keyof PictureParts, string> = {
  subject: "Subject",
  scene: "Scene",
  composition: "Composition",
  lighting: "Lighting",
  palette: "Colours",
  style: "Style",
  mood: "Mood",
  avoid: "Avoid",
};

// The most characters each part keeps when it is read from the analysis reply.
export const PART_LIMITS: Record<keyof PictureParts, number> = {
  subject: 160,
  scene: 400,
  composition: 200,
  lighting: 160,
  palette: 120,
  style: 200,
  mood: 120,
  avoid: 160,
};
export const STYLE_LIMIT = 200; // the look shared by every picture of a carousel
export const PROMPT_LIMIT = 2000; // the most characters in one picture prompt, the picture rules included

/**
 * Shortens text to at most `max` characters, at a word boundary where possible. Used on the reply's text, and on
 * a prompt that would run past PROMPT_LIMIT.
 */
export function cut(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  return `${head.replace(/\s+\S*$/, "")}…`;
}

/**
 * Gemini sometimes leaves citation markers such as [cite: 1] or [2] in its text. They are not part of the
 * picture or the slide, and an image would draw them, so they are removed wherever the text is used.
 */
export function cleanSlideText(text: string | undefined): string {
  return (text ?? "")
    .replace(/\[cite[^\]]*\]/gi, "")
    .replace(/\[\d+(?:[,\s]+\d+)*\]/g, "")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function emptyParts(): PictureParts {
  return { subject: "", scene: "", composition: "", lighting: "", palette: "", style: "", mood: "", avoid: "" };
}

/**
 * Reads one picture's parts from the analysis reply. Each part is cleaned and cut to its limit. Returns null when
 * the reply gives neither a subject nor a scene, because such a picture cannot be made.
 */
export function parseParts(raw: unknown): PictureParts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const parts = emptyParts();
  for (const key of PART_KEYS) {
    const value = typeof o[key] === "string" ? (o[key] as string) : "";
    parts[key] = cut(cleanSlideText(value), PART_LIMITS[key]);
  }
  return parts.subject || parts.scene ? parts : null;
}

/** A picture written as plain text, such as a prompt typed by hand or an older reply. The text becomes the scene. */
export function partsFromText(text: string): PictureParts {
  return { ...emptyParts(), scene: cleanSlideText(text) };
}

/**
 * The whole prompt for one picture: the parts in order, the shared look of the set if there is one, then the
 * picture rules for the shape. The rules are kept and go last. If the text is too long, the parts are cut from
 * the end, never the rules.
 */
export function composePicturePrompt(parts: PictureParts, shape: Shape = "square", sharedStyle = ""): string {
  const lines: string[] = [];
  for (const key of PART_KEYS) {
    if (parts[key]) lines.push(`${LABEL[key]}: ${parts[key]}`);
    if (key === "style" && sharedStyle) lines.push(`Look shared by every picture in this set: ${sharedStyle}`);
  }
  const rules = imageRules(shape);
  const body = cut(lines.join("\n"), PROMPT_LIMIT - rules.length - 1);
  return body ? `${body}\n${rules}` : rules;
}
