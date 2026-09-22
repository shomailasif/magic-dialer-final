import createMiddleware from "next-intl/middleware";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { routing, locales, defaultLocale } from "./i18n/routing";

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
  const isPublic = PUBLIC_PATHS.some(
    (p) => clean === p || clean.startsWith(`${p}/`),
  );

  // Authenticated user visiting a public-only page -> redirect to portal.
  if (hasSession && isPublic && (clean === "/login" || clean === "/register")) {
    return NextResponse.redirect(new URL(`/${locale}/dashboard`, request.url));
  }

  // Unauthenticated user hitting a protected page -> redirect to login.
  if (!isPublic && !hasSession) {
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
