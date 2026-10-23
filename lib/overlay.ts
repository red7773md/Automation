// Writes a carousel slide's text onto its checked picture: the figure and headline, the body, the
// "Swipe for more" arrow on the hook, and the bottom bar with the account name and the footer. The text is
// drawn as vector outlines from the bundled Poppins fonts, so the result does not depend on any font
// installed on the server, and the picture underneath is changed only by this text.
import { readFileSync } from "node:fs";
import path from "node:path";
import opentype, { type Font } from "opentype.js";
import sharp from "sharp";
import { sizeOf, type SlideDesign } from "@/lib/jobs/design";

export type SlideText = {
  role: "hook" | "point" | "cta";
  figure?: string; // hook only: a short number or figure, drawn large
  headline: string;
  body: string;
};

export type OverlayOptions = SlideText & { design: SlideDesign; index: number; total: number };

export const MARGIN = 72;
export const BAR = 96; // the bottom bar: account name on the left, footer on the right
export const SWIPE_TEXT = "Swipe for more";

const FIGURE_SIZE = 150;
const HEADLINE_SIZES = [96, 88, 80, 72, 64, 56, 48];
const BODY_SIZES = [44, 40, 36, 32];
const LABEL_SIZE = 34;
const FOOTER_SIZE = 30;
const HEADLINE_LEADING = 1.12;
const BODY_LEADING = 1.38;
const FIGURE_LEADING = 1.0;
const GAP_FIGURE = 12;
const GAP_HEAD_BODY = 28;
const WHITE = "#ffffff";
const SOFT = "#dedede";
const ACCENT = "#ffd23f";

// Poppins: ascent 1.05 em, descent 0.35 em. Returns where the baseline sits in a line box of `leading` em.
const baselineIn = (leading: number) => (leading - 1.4) / 2 + 1.05;

export type Run = { text: string; font: Font; size: number; x: number; y: number; fill: string };
export type Fonts = { bold: Font; regular: Font };

let cache: Fonts | null = null;

/** The two bundled fonts, read once. They are in assets/fonts and traced into the server bundle. */
export function loadFonts(): Fonts {
  if (cache) return cache;
  const read = (file: string): Font => {
    const bytes = readFileSync(path.join(process.cwd(), "assets", "fonts", file));
    return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };
  cache = { bold: read("Poppins-Bold.ttf"), regular: read("Poppins-Regular.ttf") };
  return cache;
}

/** Shortens text to whole words that fit, then adds an ellipsis. A single word too long to fit is cut by letters. */
function ellipsis(font: Font, text: string, size: number, maxWidth: number): string {
  const words = text.trim().split(/\s+/);
  while (words.length > 1 && font.getAdvanceWidth(`${words.join(" ")}…`, size) > maxWidth) words.pop();
  let t = words.join(" ");
  while (t.length > 1 && font.getAdvanceWidth(`${t}…`, size) > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

/** Word-wraps text to maxWidth. Words past the last allowed line are cut off with an ellipsis. */
export function wrap(font: Font, text: string, size: number, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (!current || font.getAdvanceWidth(next, size) <= maxWidth) {
      current = next;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsis(font, `${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`, size, maxWidth);
  return kept;
}

/**
 * Places the text block above the bottom bar. The sizes come down step by step until the block fits its
 * share of the picture, so a long headline gets smaller rather than running off the slide.
 */
export function layoutText(text: SlideText, width: number, height: number, fonts: Fonts): Run[] {
  const maxWidth = width - 2 * MARGIN;
  const budget = height * 0.5;
  const swipe = text.role === "hook";
  const figure = text.role === "hook" && text.figure ? text.figure : "";
  let figureSize = FIGURE_SIZE;
  if (figure) {
    const natural = fonts.bold.getAdvanceWidth(figure, FIGURE_SIZE);
    if (natural > maxWidth) figureSize = Math.floor((FIGURE_SIZE * maxWidth) / natural);
  }
  const figureHeight = figure ? figureSize * FIGURE_LEADING + GAP_FIGURE : 0;
  const headFor = (size: number) => (text.headline ? wrap(fonts.bold, text.headline, size, maxWidth, swipe ? 3 : 4) : []);
  const bodyFor = (size: number) => (text.body ? wrap(fonts.regular, text.body, size, maxWidth, 4) : []);
  const heightOf = (head: string[], hs: number, body: string[], bs: number) =>
    head.length * hs * HEADLINE_LEADING + (head.length && body.length ? GAP_HEAD_BODY : 0) + body.length * bs * BODY_LEADING;

  let chosen = { hs: HEADLINE_SIZES[HEADLINE_SIZES.length - 1], bs: BODY_SIZES[BODY_SIZES.length - 1] };
  let headLines = headFor(chosen.hs);
  let bodyLines = bodyFor(chosen.bs);
  search: for (const hs of HEADLINE_SIZES) {
    for (const bs of BODY_SIZES) {
      const head = headFor(hs);
      const body = bodyFor(bs);
      if (figureHeight + heightOf(head, hs, body, bs) <= budget) {
        chosen = { hs, bs };
        headLines = head;
        bodyLines = body;
        break search;
      }
    }
  }

  const total = figureHeight + heightOf(headLines, chosen.hs, bodyLines, chosen.bs);
  const bottom = height - BAR - 56 - (swipe ? 64 : 0);
  let y = bottom - total;
  const runs: Run[] = [];
  if (figure) {
    runs.push({ text: figure, font: fonts.bold, size: figureSize, x: MARGIN, y: y + figureSize * baselineIn(FIGURE_LEADING), fill: ACCENT });
    y += figureHeight;
  }
  for (const line of headLines) {
    runs.push({ text: line, font: fonts.bold, size: chosen.hs, x: MARGIN, y: y + chosen.hs * baselineIn(HEADLINE_LEADING), fill: WHITE });
    y += chosen.hs * HEADLINE_LEADING;
  }
  if (headLines.length && bodyLines.length) y += GAP_HEAD_BODY;
  for (const line of bodyLines) {
    runs.push({ text: line, font: fonts.regular, size: chosen.bs, x: MARGIN, y: y + chosen.bs * baselineIn(BODY_LEADING), fill: SOFT });
    y += chosen.bs * BODY_LEADING;
  }
  return runs;
}

/** The bottom bar's text: the account name on the left, the footer on the right. Empty parts are left out. */
export function barRuns(design: SlideDesign, width: number, height: number, fonts: Fonts): Run[] {
  const center = height - BAR / 2;
  const runs: Run[] = [];
  const handle = design.handle.replace(/^@+/, "");
  if (handle) {
    runs.push({ text: `@${handle}`, font: fonts.bold, size: LABEL_SIZE, x: MARGIN, y: center + LABEL_SIZE * 0.36, fill: WHITE });
  }
  if (design.footer) {
    const w = fonts.regular.getAdvanceWidth(design.footer, FOOTER_SIZE);
    runs.push({ text: design.footer, font: fonts.regular, size: FOOTER_SIZE, x: width - MARGIN - w, y: center + FOOTER_SIZE * 0.36, fill: SOFT });
  }
  return runs;
}

/** The whole overlay as one SVG of the frame's size. Pure except for reading the fonts, so it can be tested. */
export function slideSvg(opts: OverlayOptions, fonts: Fonts = loadFonts()): string {
  const { width, height } = sizeOf(opts.design.shape);
  const runs = layoutText(opts, width, height, fonts);
  const parts: string[] = [];
  const hasText = runs.length > 0 || opts.role === "hook";
  parts.push(
    `<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0.42" stop-color="#000" stop-opacity="0"/>` +
      `<stop offset="0.8" stop-color="#000" stop-opacity="0.62"/>` +
      `<stop offset="1" stop-color="#000" stop-opacity="0.88"/></linearGradient></defs>`,
  );
  // A soft shade under the text keeps it readable on a bright picture. It is not drawn on a slide without text.
  if (hasText) parts.push(`<rect width="${width}" height="${height}" fill="url(#fade)"/>`);
  for (const r of runs) parts.push(`<path d="${r.font.getPath(r.text, r.x, r.y, r.size).toPathData(2)}" fill="${r.fill}"/>`);

  if (opts.role === "hook") {
    const y = height - BAR - 34;
    parts.push(`<path d="${fonts.bold.getPath(SWIPE_TEXT, MARGIN, y, LABEL_SIZE).toPathData(2)}" fill="${WHITE}"/>`);
    const cx = MARGIN + fonts.bold.getAdvanceWidth(SWIPE_TEXT, LABEL_SIZE) + 18;
    const cy = y - LABEL_SIZE * 0.35;
    parts.push(
      `<path d="M ${cx} ${cy - 11} L ${cx + 10} ${cy} L ${cx} ${cy + 11}" fill="none" stroke="${WHITE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  parts.push(`<rect x="0" y="${height - BAR}" width="${width}" height="${BAR}" fill="#0a0a0a" fill-opacity="0.9"/>`);
  for (const r of barRuns(opts.design, width, height, fonts)) {
    parts.push(`<path d="${r.font.getPath(r.text, r.x, r.y, r.size).toPathData(2)}" fill="${r.fill}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}

/** The slide as a picture of the frame's size: the checked picture with its text on top. Returns PNG. */
export async function composeSlide(picture: Buffer, opts: OverlayOptions): Promise<Buffer> {
  const { width, height } = sizeOf(opts.design.shape);
  return sharp(picture, { failOn: "error" })
    .resize({ width, height, fit: "cover", position: "centre" })
    .composite([{ input: Buffer.from(slideSvg(opts)), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
