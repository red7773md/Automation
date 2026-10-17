// Instagram must download the approved image from a public URL. We give it a
// short-lived, HMAC-signed URL served by this app. The image itself stays private.
import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_SECONDS = 30 * 60;

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not set");
  return s;
}

function sign(jobId: string, attempt: number, exp: number): string {
  return createHmac("sha256", secret()).update(`${jobId}:${attempt}:${exp}`).digest("base64url");
}

export function publicMediaUrl(jobId: string, attempt: number): string {
  const base = process.env.PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  if (!base.startsWith("https://")) {
    throw new Error("PUBLIC_APP_URL must be your https:// app URL, because Instagram has to download the image");
  }
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return `${base.replace(/\/+$/, "")}/api/media/${jobId}/${attempt}?exp=${exp}&sig=${sign(jobId, attempt, exp)}`;
}

export function verifyMediaSignature(jobId: string, attempt: number, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(jobId, attempt, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
