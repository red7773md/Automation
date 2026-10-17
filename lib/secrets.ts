// Provider cookies live encrypted in Postgres and are edited from the web UI.
import { decrypt, encrypt } from "./crypto";
import { getDb } from "./db";

export const PROVIDERS = ["gemini", "chatgpt"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const LABEL: Record<Provider, string> = { gemini: "Gemini", chatgpt: "ChatGPT" };
export type CookieMeta = { configured: boolean; updatedAt: string | null; cookieNames: string[] };

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Accepts a raw Cookie header ("a=1; b=2") or a DevTools "cookie: ..." line and returns a clean header value. */
export function normalizeCookie(raw: string): string {
  const pairs = raw
    .replace(/^\s*cookie:\s*/i, "")
    .split(/[;\r\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (pairs.length === 0 || pairs.some((p) => !p.includes("="))) {
    throw new Error(
      "Paste the Cookie header as name=value; name2=value2 (DevTools → Network → any request → Request Headers → cookie)",
    );
  }
  return pairs.join("; ");
}

const namesOf = (cookie: string) => cookie.split(";").map((p) => p.split("=")[0].trim());

export async function saveCookie(provider: Provider, raw: string): Promise<void> {
  const cookie = normalizeCookie(raw);
  const sql = await getDb();
  await sql`
    insert into provider_secrets (provider, ciphertext, cookie_names, updated_at)
    values (${provider}, ${encrypt(cookie)}, ${namesOf(cookie).join(", ")}, now())
    on conflict (provider) do update
      set ciphertext = excluded.ciphertext, cookie_names = excluded.cookie_names, updated_at = now()`;
}

export async function loadCookie(provider: Provider): Promise<string | null> {
  const sql = await getDb();
  const rows = await sql`select ciphertext from provider_secrets where provider = ${provider}`;
  return rows[0] ? decrypt(rows[0].ciphertext as string) : null;
}

/** Metadata only. Cookie values are never returned to the browser. */
export async function cookieMeta(provider: Provider): Promise<CookieMeta> {
  const sql = await getDb();
  const rows = await sql`select cookie_names, updated_at from provider_secrets where provider = ${provider}`;
  const row = rows[0];
  if (!row) return { configured: false, updatedAt: null, cookieNames: [] };
  return {
    configured: true,
    updatedAt: new Date(row.updated_at).toISOString(),
    cookieNames: String(row.cookie_names).split(", "),
  };
}

export async function clearCookie(provider: Provider): Promise<void> {
  const sql = await getDb();
  await sql`delete from provider_secrets where provider = ${provider}`;
}
