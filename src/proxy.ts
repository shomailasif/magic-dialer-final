import createMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing, locales, defaultLocale } from "./i18n/routing";
import { sessionCookieIsValid } from "@/lib/session-check";

const SESSION_COOKIE = "autodial_session";

const PUBLIC_PATHS = [
  "/",
  "/pricing",
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/admin",
];

const handleI18nRouting = createMiddleware(routing);

/** Extract the leading locale segment if present, else the default. */
function localeFromPath(pathname: string): string {
  const parts = pathname.split("/");
  if (parts.length > 1 && (locales as readonly string[]).includes(parts[1])) {
    return parts[1];
  }
  return defaultLocale;
}

/** Pathname without the leading locale prefix. */
function stripLocale(pathname: string): string {
  const parts = pathname.split("/");
  if (parts.length > 1 && (locales as readonly string[]).includes(parts[1])) {
    return "/" + parts.slice(2).join("/");
  }
  return pathname;
}

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const clean = stripLocale(pathname);
  const locale = localeFromPath(pathname);

  // /admin/* routes bypass auth and i18n — handled by embedded admin portal
  if (pathname.startsWith("/admin") || clean.startsWith("/admin")) {
    return NextResponse.next();
  }

  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  /* Whether the cookie merely EXISTS is not whether the session is usable. A
   * cookie left behind by an expired or signed-out session made /login bounce
   * the visitor to /dashboard, the dashboard rejected the dead session and sent
   * them back, and the browser looped until it gave up with
   * ERR_TOO_MANY_REDIRECTS - the whole site unreachable on a stale cookie. The
   * token is checked properly now: signed and unexpired, or treated as signed
   * out. */
  const signedIn = sessionCookieIsValid(request.cookies.get(SESSION_COOKIE)?.value);
  const isPublic = PUBLIC_PATHS.some(
    (p) => clean === p || clean.startsWith(`${p}/`),
  );

/* Signed-in visitors reaching /login are left there on purpose. The login form
 * navigates to the dashboard itself once it has verified a password, so this
 * bounce bought nothing - and it was the other half of the redirect loop: a
 * cookie that was signed but no longer had a live database session looked valid
 * here, bounced /login to /dashboard, and the dashboard sent it straight back. */

// Unauthenticated user hitting a protected page -> redirect to login.
if (!isPublic && !signedIn) {
    const loginUrl = new URL(`/${locale}/login`, request.url);
    loginUrl.searchParams.set("next", clean);
    return NextResponse.redirect(loginUrl);
  }

  // Let next-intl negotiate the locale and apply rewrites/redirects.
  return handleI18nRouting(request);
}

// Matcher: everything except API, admin portal, and static/manifest assets.
export const config = {
  matcher:
    "/((?!api|admin|_next/static|_next/image|favicon.ico|manifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
};
