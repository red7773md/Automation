import { adminRoute, json } from "@/lib/api";
import { clearCookie, cookieMeta, isProvider, normalizeCookie, saveCookie } from "@/lib/secrets";

type P = { provider: string };

export const GET = adminRoute<P>(async (_req, { params }) => {
  const { provider } = await params;
  if (!isProvider(provider)) return json({ error: "Unknown provider" }, 404);
  return json(await cookieMeta(provider));
});

export const PUT = adminRoute<P>(async (req, { params }) => {
  const { provider } = await params;
  if (!isProvider(provider)) return json({ error: "Unknown provider" }, 404);
  const body = await req.json().catch(() => null);
  if (typeof body?.cookie !== "string") return json({ error: "Send { cookie: string }" }, 400);
  let cookie: string;
  try {
    cookie = normalizeCookie(body.cookie);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Invalid cookie" }, 400);
  }
  await saveCookie(provider, cookie);
  return json({ ok: true, ...(await cookieMeta(provider)) });
});

export const DELETE = adminRoute<P>(async (_req, { params }) => {
  const { provider } = await params;
  if (!isProvider(provider)) return json({ error: "Unknown provider" }, 404);
  await clearCookie(provider);
  return json({ ok: true });
});
