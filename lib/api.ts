import { cookies } from "next/headers";
import { errorMessage } from "./logger";
import { SESSION_COOKIE, verifySessionToken } from "./session";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

type Ctx<P> = { params: Promise<P> };

/** Wraps an API handler: rejects anyone without the admin session, and turns exceptions into JSON errors. */
export function adminRoute<P = Record<string, string>>(
  handler: (req: Request, ctx: Ctx<P>) => Promise<Response>,
) {
  return async (req: Request, ctx: Ctx<P>): Promise<Response> => {
    const jar = await cookies();
    if (!(await verifySessionToken(jar.get(SESSION_COOKIE)?.value))) {
      return json({ error: "Not logged in" }, 401);
    }
    try {
      return await handler(req, ctx);
    } catch (err) {
      console.error(err);
      return json({ error: errorMessage(err) }, 500);
    }
  };
}
