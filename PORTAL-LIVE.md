# Magic Dialer — Live Portal Status

## LIVE CLOUD PORTAL (permanent, free, always-on)
**URL:** https://0nrl0r6g7wyn-production-4w2zqfnq.europe-west1.suga.run

**Admin login password:** NeonPortal2026!

Hosted on **Suga** (free tier, no card) — rebuilds automatically from GitHub, data stored in **Neon** cloud Postgres. Fully independent of this PC.

## Product name: Magic Dialer
- Portal UI rebranded "Magic Dialer" with a violet→cyan logo (inline SVG, no external image).
- High-tech but user-friendly dashboard: stat tiles, "New user" button, customer cards, live ONLINE/OFFLINE/VOIP badges.
- Customer PC installer: **MagicDialer-Setup.exe** (`src\management\build\dist\MagicDialer-Setup.exe`).

## What the user does when returning (exact steps)
### 1. Create a customer from the admin portal (web browser)
1. Open the portal URL above.
2. Sign in with the admin password.
3. Click **"+ New user"**.
4. Fill in what they sell, lead info needed, and email. Click **Create customer**.
5. The page shows them the **Access key** (and portal URL) — copy/paste this to the customer.

### 2. Set up the customer PC (the EXE)
1. Run **MagicDialer-Setup.exe** on the customer's PC.
2. It runs a one-time setup form asking:
   - the **portal URL** (copy from step 1),
   - the **access token** (copy from step 1),
   - what they sell / lead info / lead email,
   - their VOIP/phone line (press Enter to skip for now).
3. The agent starts and the dashboard shows the PC **ONLINE** (verified working end-to-end).

### 3. Try a "real" AI voice call
- The agent can run a **live spoken sales call now, for free**, using the PC's **microphone + speakers** (neural voice speaks, Windows speech recognition hears, the brain scores the lead). Start it with: `MagicDialer.exe --call`
- **Honest limit — real phone numbers:** calling an actual phone number (a distant phone / PSTN) requires a telephony provider (Twilio, Telnyx, IPComms, etc.). The industry charges per minute (pennies) and for a phone number (~$1–1.50/mo); there is **no $0 way** to call a real phone number — the phone networks themselves charge termination fees. The VOIP fields are already captured in the setup form, so plugging a provider in later only means swapping the audio transport in the code (see `src\management\agent\call.js`); the conversation logic is unchanged.

## Verified working (Sep 4 2026)
- [x] Portal `/` shows the Magic Dialer sign-in page (branded, with logo)
- [x] Admin login works (NeonPortal2026!)
- [x] **Create-customer flow works in the cloud** — created a real customer in Neon via the dashboard flow, then the agent logged in with the returned key
- [x] **Compiled MagicDialer.exe heartbeats to the live portal and shows ONLINE** — full admin→EXE→dashboard round trip
- [x] /api/calls returns 401 without login (secure)
- [x] Data persists in Neon across restarts

Test data left in dashboard: **"TEST Customer Alpha"** (you can ignore/rename/remove).

## How to update the portal later
Push code to GitHub to auto-redeploy:
`https://github.com/shomailasif/autodial-portal`
Local git repo: `C:\Users\USER\Documents\Default Project\autodial-ai\deploy`

## Under the hood (for reference)
- Container: `portal` (port 8787), 0.1 CPU / 256Mi, repo `shomailasif/autodial-portal` branch `master`
- Env vars: `DATABASE_URL` (Neon), `ADM_PASSWORD`, `ADM_SECRET`
- Data lives in Neon: `neondb` (ep-raspy-brook-ayuyik4a / purple-base-58311980)
- MCP helpers + token: `C:\Users\USER\Documents\Default Project\autodial-ai\sugamcp\`

## PC power settings note
While away, this PC was set to NOT sleep / not turn off display / not hibernate (AC + DC).
**Restore these to normal when done** (see restore steps in session).
