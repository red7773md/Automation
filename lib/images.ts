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

export function isSendable(bytes: Buffer, contentType: string): boolean {
  return contentType === "image/jpeg" && bytes.length <= SEND_LIMIT;
}
