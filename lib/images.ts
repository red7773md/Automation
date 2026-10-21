// Drafts are stored, checked and posted as JPEG at most MAX_SIDE pixels wide. The
// generator returns large PNGs (about 9 MB seen in practice), which the Gemini MCP
// rejects with HTTP 413 when they are sent back as base64, and which Instagram
// does not accept above 8 MB.
import sharp, { type OutputInfo, type Sharp } from "sharp";

export const MAX_SIDE = 1080; // Instagram square posts are 1080 px
export const SEND_LIMIT = 900 * 1024; // what we send to the MCP servers, after base64 it stays under 1.3 MB

export type Shrunk = { bytes: Buffer; contentType: "image/jpeg"; width: number; height: number };

/** Resizes to fit MAX_SIDE and encodes as JPEG, lowering the quality until the file is under SEND_LIMIT. */
export async function shrinkForSending(input: Buffer): Promise<Shrunk> {
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
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    quality -= 8;
  } while (out.data.length > SEND_LIMIT && quality >= 50);
  return { bytes: out.data, contentType: "image/jpeg", width: out.info.width, height: out.info.height };
}

/**
 * Makes a carousel slide square, exactly MAX_SIDE by MAX_SIDE. The generator can return landscape or portrait
 * pictures. This keeps the middle square and trims 7% from each side, which also cuts off a mark in a corner.
 */
export async function squareForInstagram(input: Buffer): Promise<Buffer> {
  let meta;
  try {
    meta = await sharp(input, { failOn: "error" }).metadata();
  } catch (err) {
    throw new Error(`The generated image could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w < 2 || h < 2) throw new Error("The generated image has no usable size");
  const side = Math.floor(Math.min(w, h) * 0.86);
  return sharp(input, { failOn: "error" })
    .extract({ left: Math.floor((w - side) / 2), top: Math.floor((h - side) / 2), width: side, height: side })
    .resize({ width: MAX_SIDE, height: MAX_SIDE })
    .png()
    .toBuffer();
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
