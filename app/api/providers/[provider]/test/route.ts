import { providers } from "@/lib/adapters";
import { adminRoute, json } from "@/lib/api";
import { isProvider } from "@/lib/secrets";

type P = { provider: string };

export const POST = adminRoute<P>(async (_req, { params }) => {
  const { provider } = await params;
  const p = providers();
  if (provider === "instagram") return json({ ok: true, tools: await p.instagram.listTools() });
  if (!isProvider(provider)) return json({ error: "Unknown provider" }, 404);
  return json(provider === "gemini" ? await p.gemini.health() : await p.chatgpt.health());
});
