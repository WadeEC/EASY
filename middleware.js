import { NextResponse } from "next/server";

// App-wide auth gate. Anything that isn't the login page, an auth API, or a
// static / Next internal asset gets bounced to /login when no session cookie
// is present. We don't VALIDATE the cookie here (middleware runs on the Edge
// runtime and we can't hit better-sqlite3 from there) — final validation
// happens in the route handlers via setActorFromReq. The middleware just
// stops fully-anonymous users from reaching the app shell.
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth/",
  "/_next/",
  "/favicon",
  "/print/", // print views are opened by an already-signed-in admin in a new tab; they read data via authenticated session cookies that come along for the ride
];

export function middleware(req) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  const cookie = req.headers.get("cookie") || "";
  if (/(?:^|;\s*)ff_session=/.test(cookie)) return NextResponse.next();
  // No session — bounce to login, preserving where we wanted to go.
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname + (req.nextUrl.search || ""));
  return NextResponse.redirect(url);
}

export const config = {
  // Match everything except Next internals and static files.
  matcher: ["/((?!_next/|favicon|.*\\.\\w+$).*)"],
};
