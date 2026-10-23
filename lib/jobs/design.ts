// The look of a carousel: the picture shape, the account name on the bottom bar, and the footer text.
// Pure functions with no I/O, so the rules can be tested and the browser can show the same limits.

export type Shape = "square" | "portrait";
export type SlideDesign = { shape: Shape; handle: string; footer: string };

export const DESIGN_DEFAULT: SlideDesign = { shape: "square", handle: "", footer: "Follow for more" };
export const HANDLE_LIMIT = 40;

export function sizeOf(shape: Shape): { width: number; height: number } {
  return shape === "portrait" ? { width: 1080, height: 1350 } : { width: 1080, height: 1080 };
}

export function parseShape(raw: unknown): Shape {
  if (raw === undefined || raw === null || raw === "") return "square";
  if (raw === "square" || raw === "portrait") return raw;
  throw new Error('The picture shape must be "square" or "portrait"');
}

/** Missing values use the defaults. Text longer than HANDLE_LIMIT is refused, so the bottom bar stays readable. */
export function normalizeDesign(input: unknown): SlideDesign {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const text = (value: unknown, label: string, fallback: string): string => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string") throw new Error(`${label} must be text`);
    const t = value.trim();
    if (t.length > HANDLE_LIMIT) throw new Error(`${label} is longer than ${HANDLE_LIMIT} characters`);
    return t;
  };
  return {
    shape: parseShape(o.shape),
    handle: text(o.handle, "The account name", DESIGN_DEFAULT.handle),
    footer: text(o.footer, "The footer text", DESIGN_DEFAULT.footer),
  };
}

/** The rules for every slide's picture. The app draws all the text, so the picture itself must have none. */
export function imageRules(shape: Shape): string {
  const frame =
    shape === "portrait" ? "one portrait picture, exactly 4:5 (1080 by 1350 px)" : "one square picture, exactly 1:1 (1080 by 1080 px)";
  const never = shape === "portrait" ? "landscape or square" : "landscape or portrait";
  return [
    `FORMAT: ${frame}, edge to edge, no border or margin. Never ${never}.`,
    "NO TEXT: no letters, words, numbers, logos, brand marks, watermarks, signatures or handles anywhere. The app adds all text.",
    "Keep the main subject in the middle third. Keep the top and bottom fifth calm and simple, so text can sit there.",
  ].join("\n");
}
