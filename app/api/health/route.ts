import { providers } from "@/lib/adapters";
import type { Health } from "@/lib/adapters/types";
import { adminRoute, json } from "@/lib/api";

const failed = (err: unknown): Health => ({ ok: false, message: err instanceof Error ? err.message : String(err) });

// Checks the servers before a job starts. Gemini: reachable with its tools matched, and its login
// still works (one short question, so this costs one Gemini request). Instagram: the login is valid.
export const POST = adminRoute(async () => {
  const p = providers();
  const [tools, session, instagram] = await Promise.all([
    p.gemini.health().catch(failed),
    p.gemini.session().catch(failed),
    p.instagram.status().catch(failed),
  ]);
  return json({ mode: p.mode, gemini: { tools, session }, instagram });
});
