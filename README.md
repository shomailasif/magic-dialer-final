# AutoDial AI — Autonomous Sales Call Platform

A multi-tenant SaaS web app where businesses deploy an AI sales agent that makes
autonomous outbound calls, with business admin and platform super admin portals,
manual subscription management, lead upload/AI generation, call orchestration /
history / reports, and email outcome notifications.

## Tech Stack

- Next.js 16 (App Router, React 19, Tailwind 4)
- Prisma 6 + SQLite
- Custom HMAC-signed cookie session auth (no NextAuth)
- bcryptjs, papaparse / xlsx (lead import), nodemailer (SMTP), zod

## Setup

1. Install dependencies:

   ```powershell
   $env:Path = "C:\Program Files\nodejs;" + $env:Path
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
   npm install
   ```

2. Configure `.env` (see `.env` for defaults). `DATABASE_URL` defaults to a
   local SQLite file. `AUTH_SECRET` is required. SMTP is optional.

3. Push the schema and seed demo data:

   ```powershell
   npm run db:push
   npm run db:seed
   ```

4. Run the app:

   ```powershell
   npm run dev        # development
   npm run build && npm start   # production
   ```

## Demo Credentials

| Role               | Email              | Password     |
|--------------------|--------------------|--------------|
| Super admin        | admin@autodial.ai  | AdminPass123!|
| Demo business      | demo@company.com   | DemoPass123! |

The demo business ships with an ACTIVE PRO subscription, an AI agent config, a
valid Twilio dialer config, and 6 pending leads — so you can launch a campaign
immediately from **Calls**.

## Key Flows

- **Business portal** (`/dashboard`, `/agent`, `/leads`, `/calls`, `/dialer`, `/account`):
  configure the AI agent, import or AI-generate leads, launch a call campaign,
  review call history + reporting, and manage the account/subscription banner.
- **Super admin portal** (`/admin`): approve/activate customers and manually set
  plans/status; review email outcome notifications.
- **Auth**: register, login, password reset are always accessible. Business
  features (dialer calls, AI lead gen, campaigns) require an `ACTIVE`
  subscription; pending/suspended accounts see a banner but keep the portal.

## Subscriptions and the Windows engine

The portal above is not how customers are licensed. Each customer PC runs the
Windows engine (`src/management`), which holds a signed licence key and reads
two small public lists from this repo: `licenses/suspended.json` (a temporary
hold for non-payment, reversible) and `licenses/revoked.json` (a cancelled
account, terminal). No hosted service is involved.

The vendor side — create, suspend, reinstate, cancel, renew — is a loopback-only
page, `node scripts/admin-server.cjs`. It refuses to start without
`licenses/license.private.key`, which is gitignored and never bundled, so no
customer installer can contain it. Full instructions: [ADMIN.md](ADMIN.md).

The engine is separate from the portal simulation below: its sales research is
live and free (the customer's own site plus Wikipedia and public search), and it
places calls through a real RingCentral softphone, not a stub.

## Notes on Simulation

Dialer calls and AI lead generation are **simulated** (no live
Twilio/RingCentral/Vonage, no live internet search). Swap-in hooks are documented
in `src/lib/dialer.ts` and `src/lib/ai-leads.ts`. SMTP delivery is optional; every
notification is persisted in the DB (QUEUED/SENT/FAILED with retries) so the super
admin can review them even without a mail server.
