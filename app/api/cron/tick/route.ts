import { json } from "@/lib/api";
import { errorMessage } from "@/lib/logger";
import { cronAuthorized, tickOnce } from "@/lib/jobs/tick";

// One step can wait on Gemini for up to about 2 minutes, so allow the same 5 minutes as advance.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Called by the scheduled workflow with "Authorization: Bearer $CRON_SECRET". No admin session. */
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json({ error: "CRON_SECRET is not set on the server" }, 503);
  if (!cronAuthorized(req.headers.get("authorization"), secret)) {
    return json({ error: "Not allowed" }, 401);
  }
  try {
    return json(await tickOnce());
  } catch (err) {
    console.error(err);
    return json({ error: errorMessage(err) }, 500);
  }
}
