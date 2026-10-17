import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// Every page and API route requires the admin session, except login/logout
// and the media route, which Instagram must fetch without a session (it is
// protected by a signed, expiring URL instead).
export async function middleware(req: NextRequest) {
  const ok = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (ok) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: ["/((?!login|api/login|api/logout|api/media/|_next/static|_next/image|favicon.ico).*)"],
};
