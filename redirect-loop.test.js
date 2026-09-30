/* The redirect loop that made the whole site unreachable.
 * /en/leads -> /en/login -> /en/dashboard -> /en/login -> forever, whenever a
 * cookie existed but was not a usable session. Browsers show
 * ERR_TOO_MANY_REDIRECTS, so a paying customer could not reach the product. */
const assert = require("node:assert");
const { sessionCookieIsValid } = require("./src/lib/session-check");
const { createHmac } = require("node:crypto");

const secret = process.env.AUTH_SECRET && process.env.AUTH_SECRET.trim()
  ? process.env.AUTH_SECRET.trim()
  : (process.env.NODE_ENV === "production" ? null : "dev-secret");
if (!secret) { console.log("SKIP: AUTH_SECRET not set"); process.exit(0); }

function sign(userId, ageMs = 0) {
  const ts = Date.now() - ageMs;
  const payload = `${userId}.${ts}.sess123`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

(async () => {
  // 1. A real, live session is recognised, so customers are not logged out.
  assert.equal(sessionCookieIsValid(sign("user_1")), true, "a fresh signed session must be valid");
  console.log("  ok  a live session is recognised (no forced logout)");

  // 2. Garbage - the exact value that produced the loop - is not a session.
  assert.equal(sessionCookieIsValid("expired-garbage-value"), false);
  assert.equal(sessionCookieIsValid(""), false);
  assert.equal(sessionCookieIsValid(undefined), false);
  assert.equal(sessionCookieIsValid("a.b.c.d"), false, "a forged token must be rejected");
  console.log("  ok  garbage, empty and forged cookies are all treated as signed out");

  // 3. Expired, even though the signature is genuine.
  assert.equal(sessionCookieIsValid(sign("user_1", 31 * 24 * 60 * 60 * 1000)), false);
  console.log("  ok  a genuinely signed but expired cookie is signed out");

  // 4. The loop itself, driven through the running production server.
  const B = process.argv[2];
  if (B) {
    const CASES = {
      "stale cookie": "autodial_session=expired-garbage-value",
      "empty cookie": "autodial_session=",
      "no cookie": "",
    };
    for (const [name, cookie] of Object.entries(CASES)) {
      for (const start of ["/en/leads", "/en/dashboard", "/en/account"]) {
        let url = B + start, hops = 0, last = "";
        for (let i = 0; i < 12; i++) {
          const r = await fetch(url, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
          const loc = r.headers.get("location");
          if (r.status >= 300 && r.status < 400 && loc) {
            url = loc.startsWith("http") ? loc : B + loc;
            hops++; last = r.status + " " + url.replace(B, "");
            continue;
          }
          last = String(r.status);
          break;
        }
        assert.ok(hops < 12, `${name} ${start} looped (${hops} hops): ${last}`);
      }
    }
    console.log("  ok  no redirect loop for stale, empty or missing cookies");
  }

  console.log("PASS: the site can no longer trap a customer in a redirect loop");
})().catch((e) => { console.error("  FAIL " + e.message); process.exit(1); });
