# Admin console (vendor PC only)

The engine sells by subscription and can be stopped without hosting anything.
This is the page that runs that side of the business. It exists **only on the
vendor's PC**: it refuses to start unless the private signing key is present,
and the key is gitignored, absent from the installer and absent from the
customer bundle.

Nothing here adds a paid service. Licences are offline signatures; suspension
and cancellation are two small public lists the engine already reads from
GitHub, and the console publishes them with `git push`.

## Start it

```powershell
cd C:\Users\USER\Documents\Default Project\autodial-ai
node scripts\admin-server.cjs
```

It prints a URL such as:

```text
http://127.0.0.1:48772/?t=<random token>
```

Open that URL. The token is new every run, the server is bound to `127.0.0.1`
only, and every API call needs the token, so a random web page cannot drive it.
Press `Ctrl+C` in that window to shut it down.

If the signing key is missing, it prints `ADMIN CONSOLE NOT STARTED` and exits.
That is the correct behaviour on a customer PC.

## What each action does

| Action | Customer sees | Reversible |
|---|---|---|
| **Create** | key to paste into their dashboard | — |
| **Suspend** (late payment) | `SUSPENDED` – "payment is outstanding" | yes, **Reinstate** |
| **Reinstate** | `ONLINE` again on the next check (minutes) | — |
| **Cancel** | `CANCELLED` – calls stop permanently | no un-cancel in the console |
| **Renew** | a new key with a later expiry | hold stays until reinstated |

Rules worth knowing:

- **Activation code** is the `machineId` shown on the customer's own dashboard.
  A key only works on that PC.
- **Suspend is for money.** It writes `licenses/suspended.json`. Deleting the id
  from that file — what **Reinstate** does — puts the PC back to work.
- **Cancel is terminal.** It writes `licenses/revoked.json` and removes any
  suspension. The console offers no un-cancel on purpose; fixing a mistake means
  editing the file deliberately (or using the CLI) and pushing.
- **Renew keeps the same licence id.** That is deliberate: a suspended account
  stays suspended after a renewal, so "received payment" and "switched back on"
  remain two separate acts. The key is printed once — send it to the customer.
- **Publishing.** Suspend/reinstate/cancel commit and push only
  `licenses/revoked.json` and `licenses/suspended.json` (`final HEAD:main`). If
  the push fails the page says so; the local file is changed but the customer's
  PC will not see it until it is pushed.
- **Grace.** A PC that cannot read the lists keeps working for 72 hours from its
  last good check, then pauses. A failed read never lifts a stop the PC has
  already seen.

## The same actions from the command line

```powershell
node scripts\license-grant.cjs grant --machine <CODE> --days 30 --name "Customer"
node scripts\license-grant.cjs suspend --name "Customer"      # late payment
node scripts\license-grant.cjs reinstate --name "Customer"
node scripts\license-grant.cjs cancel --id <LICENCE_ID>
node scripts\license-grant.cjs renew --id <LICENCE_ID> --days 30
node scripts\license-grant.cjs list
```

Both the console and the CLI call `scripts/license-lib.cjs`, so they cannot
disagree about what a suspension or a cancellation means.

## Files

| File | Visibility | Purpose |
|---|---|---|
| `licenses/license.private.key` | **yours only** (gitignored) | signs licences; the admin gate |
| `licenses/grants.local.json` | **yours only** (gitignored) | who holds which key |
| `licenses/revoked.json` | public | cancelled licence ids |
| `licenses/suspended.json` | public | held licence ids |

Only the two public lists contain customer-visible data, and they contain
nothing but random licence ids and dates.

## Keeping it off customer PCs

`build/bundle.js` starts at `agent/agent.js`; `scripts/` is not reachable from
there and is not included in `installer.iss`. The regression suite
`src/management/agent/license-suspension.behavior.test.js` asserts both, so a
future packaging change cannot quietly ship the console.
