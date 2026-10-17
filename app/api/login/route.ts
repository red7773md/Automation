import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/session";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const adminUser = process.env.ADMIN_USERNAME ?? "";
  const hash = process.env.ADMIN_PASSWORD_HASH ?? "";

  const userOk = adminUser.length > 0 && username === adminUser;
  const passOk = hash.length > 0 && password.length > 0 && (await bcrypt.compare(password, hash));

  if (!userOk || !passOk) {
    await new Promise((r) => setTimeout(r, 800)); // slows down guessing
    return NextResponse.json({ error: "Wrong username or password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionToken(adminUser), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
