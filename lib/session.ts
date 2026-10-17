// Edge-safe: used by middleware and by Node route handlers.
import { SignJWT } from "jose/jwt/sign";
import { jwtVerify } from "jose/jwt/verify";

export const SESSION_COOKIE = "ia_session";
const SESSION_HOURS = 12;
export const SESSION_MAX_AGE = SESSION_HOURS * 60 * 60;

function key(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must be set (32+ characters)");
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(username: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(username)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key());
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    return !!process.env.ADMIN_USERNAME && payload.sub === process.env.ADMIN_USERNAME;
  } catch {
    return false;
  }
}
