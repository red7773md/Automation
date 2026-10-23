// Drafts are stored, checked and posted as JPEG at most MAX_SIDE pixels wide. The
// generator returns large PNGs (about 9 MB seen in practice), which the Gemini MCP
// rejects with HTTP 413 when they are sent back as base64, and which Instagram
// does not accept above 8 MB.
import sharp, { type OutputInfo, type Sharp } from "sharp";
import { sizeOf, type Shape } from "@/lib/jobs/design";

export const MAX_SIDE = 1080; // Instagram square posts are 1080 px
export const SEND_LIMIT = 900 * 1024; // what we send to the MCP servers, after base64 it stays under 1.3 MB

export type Shrunk = { bytes: Buffer; contentType: "image/jpeg"; width: number; height: number };

/**
 * Resizes to fit the box (MAX_SIDE square by default, or a carousel frame such as 1080 by 1350) and encodes as
 * JPEG, lowering the quality until the file is under SEND_LIMIT.
 */
export async function shrinkForSending(input: Buffer, box: { width: number; height: number } = { width: MAX_SIDE, height: MAX_SIDE }): Promise<Shrunk> {
  let image: Sharp;
  try {
    image = sharp(input, { failOn: "error" }).rotate();
  } catch (err) {
    throw new Error(`The generated image could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  let quality = 84;
  let out: { data: Buffer; info: OutputInfo };
  do {
    out = await image
      .clone()
      .resize({ width: box.width, height: box.height, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    quality -= 8;
  } while (out.data.length > SEND_LIMIT && quality >= 50);
  return { bytes: out.data, contentType: "image/jpeg", width: out.info.width, height: out.info.height };
}

/**
 * The part of a w by h picture kept for a frame of the target's shape. The edges are trimmed first by `inset`
 * of the shorter side, which also cuts off a mark in a corner, then the middle is taken at the frame's ratio.
 */
export function coverBox(w: number, h: number, target: { width: number; height: number }, inset = 0.07) {
  if (w < 2 || h < 2) throw new Error("The generated image has no usable size");
  const trim = Math.floor(Math.min(w, h) * inset);
  const cw = Math.max(1, w - 2 * trim);
  const ch = Math.max(1, h - 2 * trim);
  const ratio = target.width / target.height;
  const width = cw / ch > ratio ? Math.max(1, Math.floor(ch * ratio)) : cw;
  const height = cw / ch > ratio ? ch : Math.max(1, Math.floor(cw / ratio));
  return {
    left: trim + Math.floor((cw - width) / 2),
    top: trim + Math.floor((ch - height) / 2),
    width,
    height,
  };
}

/**
 * Makes a carousel picture exactly the frame of its shape: 1080 by 1080 for a square, 1080 by 1350 for a portrait.
 * The generator can return other shapes, so the middle is kept and resized. Returns PNG.
 */
export async function shapeForInstagram(input: Buffer, shape: Shape): Promise<Buffer> {
  let meta;
  try {
    meta = await sharp(input, { failOn: "error" }).metadata();
  } catch (err) {
    throw new Error(`The generated image could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const frame = sizeOf(shape);
  const box = coverBox(meta.width ?? 0, meta.height ?? 0, frame);
  return sharp(input, { failOn: "error" }).extract(box).resize({ width: frame.width, height: frame.height }).png().toBuffer();
}

/** The picture type from its first bytes: PNG, JPEG, WEBP or GIF. Null for anything else. */
export function sniffImage(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  return null;
}

export function isSendable(bytes: Buffer, contentType: string): boolean {
  return contentType === "image/jpeg" && bytes.length <= SEND_LIMIT;
}
