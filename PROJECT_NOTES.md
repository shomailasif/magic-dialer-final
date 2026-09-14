# Magic Dialer — Project Requirements & Notes

## Client: RingCentral Test Credentials
- Client ID: `2c28dvx7cnueCB1vQ3Lg90`
- Client Secret: `Yi8Wt2U3K94dokmUaPAcyq8EkjUvbF4rHfit0JMWkTHE`
- Phone Number: `4807166685`
- Mode: RingOut REST API (not SIP softphone)
- This is the CLIENT's personal line for testing only — NOT for customers. Each customer uses their own VOIP.

## Architecture Requirements

### 1. Two Admin Panels (One Portal, Isolated Views)
- Single portal deployment, both admins share it
- Each admin logs in with their own password
- Each admin sees ONLY their customers — never the other admin's
- `admin_id` column on customers table enforces isolation
- Admin identities stored in `admins.json`

### 2. Each User = Customer
- Every registered user is a paying customer
- Each customer gets their own VOIP credentials (RingCentral, Twilio, Vonage, etc.)
- Each customer's PC acts as a learning node
- The customer enters their own VOIP details during setup

### 3. Customer PC = The Real Engine
- Each customer's PC runs the AI sales agent locally
- Local database (SQLite) stores leads, calls, learning
- Works OFFLINE — internet/power outage resilience
- Emails qualified leads DIRECTLY from the customer's PC (not via cloud)
- Syncs results to cloud when back online

### 4. Cloud = Lightweight Health Monitor Only
- Portal stores ONLY live health status of each customer PC
- Admin dashboard shows: online/offline, last seen, product, basic stats
- No heavy data storage on cloud (leads, transcripts stay on PC)
- Real-time heartbeat monitoring

### 5. RingCentral Isolation
- Client's RingCentral is ONLY for testing on their own PC
- Customers must NOT see or use client's RingCentral
- Each customer enters their own VOIP provider details
- System supports: Twilio, RingCentral, Vonage, Plivo, ThinQ, Flowroute, MyExotel, Asterisk, FreePBX, Generic SIP

## Offline Resilience (Critical)
- Internet and power outages are COMMON for this client
- Agent MUST work independently of cloud
- When cloud goes down: agent keeps calling, learning, emailing
- When cloud comes back: agent syncs accumulated data
- Heartbeat carries summary data back to portal on reconnect

## Tech Stack
- Management Portal: Node.js, no npm deps (built-ins only), SQLite/Postgres
- Agent: Node.js, bundled with esbuild, Windows only
- Voice: Edge-TTS (free, neural), HeadTTS/Kokoro (offline fallback), Windows TTS (last resort)
- Speech Recognition: Windows SAPI via PowerShell
- Database: SQLite (local on agent + portal), Postgres (optional cloud DB via Neon)

## Files & Structure
- `src/management/portal/` — Admin cloud portal
- `src/management/agent/` — Customer PC program
- `src/management/shared/` — Shared constants (HOSTED_VOIP_SERVERS, heartbeat)
- `autodial-ai/` — Next.js SaaS app (separate product, simulated)
- Customers should NEVER see the Next.js app code or the portal source

## Known Issues (from previous 20-day session)
- Client lost 6 customers due to bugs in previous model
- Previous model kept failing/bugging out
- Need working, tested, deployed ASAP
- Previous model did not communicate these requirements properly

## RingCentral Status (2026-09-14)
- Auth WORKS: JWT + Client ID/Secret → access token obtained
- RingOut API FAILS: "InsufficientPermissions" despite RingOut scope appearing enabled
- Root cause: JWT was generated BEFORE permissions were updated. Need to REGENERATE JWT.
- OR: Permissions may be on the wrong app (Dialer 2 vs Magic Dialer)
- JWT jti: PoM7S79oRGimBizetSHs_A (same every time = not regenerating)
- Fix steps saved below
