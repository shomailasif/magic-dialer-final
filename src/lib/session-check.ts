/* Edge-safe session token check: HMAC signature plus expiry, no database and no
 * Node-only APIs, so the middleware can use it.
 *
 * The middleware used to decide "is this person signed in" from whether the
 * cookie merely EXISTED. A cookie left behind by an expired or signed-out
 * session therefore looked valid, so /login bounced the visitor to /dashboard,
 * the dashboard rejected the dead session and sent them back to /login, and the
 * browser spun until it gave up with ERR_TOO_MANY_REDIRECTS. A real
 * subscription customer hit that on a stale cookie and could not reach the site
 * at all. */
import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string {
  const configured = process.env.AUTH_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is required in production");
  }
  return "dev-secret";
}

/** True only when the cookie is a properly signed, unexpired session token. */
export function sessionCookieIsValid(tokenValue: unknown): boolean {
  const token = String(tokenValue || "");
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 4) return false;
  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const sig = parts[3];
  const expected = createHmac("sha256", secret()).update(payload).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let ok = false;
  try { ok = timingSafeEqual(a, b); } catch { ok = false; }
  if (!ok) return false;
  const ts = Number(parts[1]);
  if (Number.isNaN(ts)) return false;
  const now = Date.now();
  if (now - ts > SESSION_TTL_MS) return false;
  if (ts - now > 60_000) return false;
  return true;
}
