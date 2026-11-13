# Unattended ticker (works when nobody has the site open)

The ticker is a small Node script (`tools/ticker.mjs`) that does one pass of the same clock logic the website uses (`public/js/lib/tick.js`) and exits: start the draft when the start time arrives, auto-draft for owners whose pick is on the clock, skip a pick whose clock ran out, close the draft when every pick is made. Run it on a schedule and skips and auto-drafts happen even if every browser is closed. It is free: Firebase Spark plan only, no Cloud Functions, no billing account.

Three things can run the clock, and they are safe together: the ticker, the commissioner's **Monitor** tab, and owners' open pages. Every change is one all-or-nothing transaction that first checks the draft is exactly as the step expected. If another runner already made that pick or skip, the second one writes nothing and re-reads. A pick or skip cannot happen twice and a player cannot be drafted twice.

## What it enforces (in code, because it bypasses the security rules)

- The draft is `live` and the pick is the one on the clock.
- Auto-draft is On for the owner of that pick's team, and the pick is open.
- It takes the first still-usable entry on the owner's list: a pool player who is still available, or a write-in that passes the duplicate checks (pool id, Baseball-Reference id, name, link) right now. Write-ins are made as "pending verification".
- If nothing on the list is usable, it does not pick. The clock keeps running, and it writes a notice for the owner (`notices/{email}`). The normal skip applies later.
- Auto-draft never picks best-available.

The 11:00 AM to 11:00 PM Eastern clock window is handled by the shared clock code, not by when you schedule the job. Auto-draft is allowed outside those hours unless you turned off "Let owners pick outside clock hours" in the Commissioner tab.

## SECURITY: read this

The service-account key is a master key to your Firebase project. It **bypasses the security rules** and can **read every owner's private draft list** and change anything. Keep it private:
- Keep it outside the project folder (for example `C:\Users\<you>\.tbbl\serviceAccount.json`). Never commit it, email it or paste it into chat. `.gitignore` also blocks `serviceAccount*.json` and `*firebase-adminsdk*.json`.
- Use it only on machines you control, as the commissioner.
- If it leaks: Firebase console > Project settings > Service accounts (or Google Cloud console > IAM > Service accounts > Keys) and delete the key, then create a new one.

## One-time setup

1. Firebase console > Project settings > **Service accounts** > **Generate new private key**. Save the file as `C:\Users\<you>\.tbbl\serviceAccount.json` (create the `.tbbl` folder).
2. Install the library once (this needs Node, which you already have for tests). In PowerShell:
   ```
   cd C:\MLB\TBBLDraft\tools
   npm install
   ```
   This installs `firebase-admin` (pinned in `tools/package.json`) into `tools\node_modules`, which is git-ignored.
3. Test one pass by hand:
   ```
   cd C:\MLB\TBBLDraft
   node tools\ticker.mjs
   ```
   It prints one line such as `ticker ok: nothing due; steps=none; conflicts=0; notices=0`. A key problem prints `ticker FAILED: ...`.
4. Publish the updated `firestore.rules` (it adds read access to `notices` for the owner): `firebase deploy --only firestore:rules`.

## (a) Windows Task Scheduler (a PC you leave on)

Pick a PC that stays on, awake and online through the draft (set Sleep to Never in Windows power settings). Its clock must be correct (Settings > Time & language > Date & time > "Set time automatically" On), because deadlines are compared with that PC's clock.

1. Do the one-time setup above on that PC (key in `C:\Users\<you>\.tbbl\`, `npm install` in `tools`).
2. Open PowerShell and run (change the folder if the project is elsewhere):
   ```
   schtasks /Create /TN "TBBL Draft Ticker" /SC MINUTE /MO 1 /TR "C:\MLB\TBBLDraft\tools\run-ticker.cmd"
   ```
   This runs it every minute, all day, as you, while you are logged in. (Task Scheduler app alternative: Create Basic Task > Daily > Start a program `C:\MLB\TBBLDraft\tools\run-ticker.cmd`, then open its Properties > Triggers > Edit > tick "Repeat task every 1 minute" for "Indefinitely".)
3. Check it: `schtasks /Run /TN "TBBL Draft Ticker"`, then read the last lines of `C:\Users\<you>\.tbbl\ticker.log`.
4. To stop it after the draft: `schtasks /Delete /TN "TBBL Draft Ticker" /F`.

**11 AM to 11 PM Eastern note:** you do not need to schedule around the window. The job can run all day, and when the window is closed it simply finds nothing due, except that auto-draft can still fire for a pick that arrives at night. If you want it to run only during the day, change the trigger to start at 11:00 AM Eastern (convert to your PC's time zone) and repeat for a duration of 12 hours. Skips are only ever due inside the window, so that is enough unless you want night-time auto-drafts.

## (b) Optional: GitHub Actions (free, about every 5 minutes)

Use this only if you do not have a PC to leave on.
1. The repository root must be the `TBBLDraft` folder (the workflow file is `TBBLDraft/.github/workflows/ticker.yml`). Do **not** reuse `C:\MLB` for this. Create a new **private** GitHub repository from the TBBLDraft folder. Make sure the real CSV files and any key are not included (see `.gitignore`).
2. Repository > Settings > Secrets and variables > Actions > **New repository secret**. Name: `TBBL_SERVICE_ACCOUNT_JSON`. Value: the entire contents of the key file.
3. Same screen, Variables tab: add `TICKER_ENABLED` = `true` (the workflow does nothing without it). Then Actions tab > "TBBL draft ticker" > Enable, then "Run workflow" once to test.
4. To stop it: disable the workflow or delete the secret.

Cautions: GitHub's scheduled runs are best-effort and often run late (sometimes several minutes) or get skipped under load, and the shortest schedule is 5 minutes. Free-plan limits (private-repo Actions minutes, scheduled workflows being switched off after a long period without repository activity) change over time: **verify the current GitHub limits yourself** before relying on it. Each run takes about a minute. This option is a backup to Monitor Mode, not a guarantee.

## Free-plan cost of the ticker

A "nothing due" pass reads about 8 documents and writes a heartbeat at most every 2 minutes. Running it every minute all day is roughly 12,000 reads and 700 writes a day, well inside the Spark daily limits as I know them (50,000 reads, 20,000 writes). Verify the current limits on Google's Firebase pricing page. A pass that has work to do reads the whole draft once (about 350 reads) and then writes only what changed. If an owner's list is exhausted the ticker remembers (in `notices`) and does not re-read everything every minute until that owner changes the list or the pick moves.

## If something goes wrong

- `ticker FAILED: No service-account key found`: the key path is wrong. See "Key location" at the top of `tools/ticker.mjs`.
- `Missing or insufficient permissions` or `PERMISSION_DENIED`: the key is from a different project.
- `14 UNAVAILABLE: No connection established. Last error: Protocol error` (after a long wait): the network (corporate TLS inspection or proxy) breaks the gRPC/HTTP/2 connection that Firestore uses by default. Fixed: the tools (`ticker`, `set-password`) now use Firestore's REST transport (plain HTTPS, `preferRest: true` in `tools/firestore-rest.mjs`), and give up with a clear message after about 45-60 seconds instead of hanging. On a network like this also set `NODE_OPTIONS=--use-system-ca` so Node trusts the company certificate.
- `Firestore did not answer within ...s`: the connection is blocked. Check the network/proxy and `NODE_OPTIONS=--use-system-ca`.
- `Cannot find package 'firebase-admin'`: run `npm install` inside `tools`.
- `conflicts=1` in the log is normal: another runner did the step first.
- Not tested yet against a real Firebase project (see the setup guide rehearsal). The shared logic and its concurrency behaviour are unit tested (`tests/runner.test.js`) with an in-memory database that models the transaction.

## Group pick emails (TBBL@groups.io)

The ticker can email the league group once for every 5 picks made, plus one final email when the draft completes (even if fewer than 5 are left). Each email lists the picks since the last email (pick number such as 1.11, team, player; write-ins are marked "write-in, pending verification"; late picks that fill a skipped slot are marked "late pick"), lists skipped picks separately ("Skipped: PAN (pick 1.3)"; skips do not count toward the 5), then the next 5 teams up with the team on the clock first and its deadline in Eastern time, and a link to the draft site. Trades and undos are not emailed (they stay in the audit log). If the draft ends with exactly 0 picks unsent, no extra email is sent.

Emails are sent by the ticker on the commissioner's PC because the free Firebase plan cannot send email. The mail package is `nodemailer` (pinned in `tools/package.json`).

### 1. Make a Gmail app password (sender: thunderbaybaseball22@gmail.com)
1. Sign in to that Google account at https://myaccount.google.com.
2. Security > **2-Step Verification** > turn it on (phone number or authenticator app). App passwords are not offered until this is on.
3. Go to https://myaccount.google.com/apppasswords (or search "App passwords" in the account page).
4. Type the name `TBBL draft`, press **Create**. Google shows a 16-letter password (shown in groups of four). Copy it now; Google will not show it again.
5. In `%USERPROFILE%\.tbbl\` (the same folder as the service-account key) create `mail.json` containing:
```
{ "appPassword": "abcd efgh ijkl mnop" }
```
Optional keys: `user`, `from`, `to` (default TBBL@groups.io) and `siteUrl` (default https://YOUR-PROJECT-ID.web.app taken from `public/js/firebase-config.js`). On GitHub Actions use the secret `TBBL_GMAIL_APP_PASSWORD` instead (see the workflow file).
6. Run `npm install` once in `tools` (it installs nodemailer).

### 2. Send ONE test email
`tools\test-email.cmd you@example.com` sends a test only to that address (try it first). `tools\test-email.cmd` with no address sends the test to the group. It does not touch the draft data and is separate from the real batches.

### 3. groups.io check
In groups.io open the TBBL group > **Settings > Moderation** (or Members) and confirm thunderbaybaseball22@gmail.com is a member whose posting is not moderated. If the test email does not appear in the group, look under **Pending / Moderation messages** and approve it, then change that member's setting to "Not moderated" and run the test again.

### 4. The ON/OFF switch (default OFF)
Commissioner tab > **3b. Group pick emails**. It is OFF until you turn it on; only the commissioner can change it (enforced in `firestore.rules`). While OFF the ticker sends nothing. **When you turn it ON, counting starts from that moment: picks already made while it was OFF are never emailed.** Turn it OFF and ON again and counting restarts again. Publish the updated rules after upgrading (`firebase deploy --only firestore:rules`).

### How it avoids duplicates and failures
Each batch is first claimed in a Firestore transaction (`groupMail/state`), then sent, then marked sent. The ticker, Monitor Mode and several tickers at once cannot send the same batch twice. If sending fails the same picks are retried on later runs (waiting 1 to 5 minutes) and nothing is lost; the Commissioner tab shows the last problem. In the very rare case that the PC dies after Gmail accepted a message but before it was marked, the claim expires after 10 minutes and that batch is sent once more. A pick undone after it was emailed stays counted as emailed. Cost: about 3 to 8 Firestore reads per ticker minute while ON, plus about 350 reads each time an email is sent (to look up player names).

## Set an owner's password (commissioner only)
For an owner who cannot use the "Forgot password" email: run `tools\set-password.cmd owner@example.com` on the commissioner's PC. It asks for the temporary password twice (typed hidden), refuses passwords shorter than 8 characters or obviously weak ones, uses the same service-account key as the ticker, and prints only a confirmation (the password is never printed, logged or stored). It also signs the owner out of old sessions. The login must already exist. **Tell the owner to sign in and press "Change password" right away**, and give them the temporary password privately (not in the group email).

## Set-password requests from the Owners screen
The commissioner's **Set password** button (Commissioner tab, section 1b) writes a request to Firestore (pwRequests/{email}: the typed password and the time; plus a password-free pwStatus/{email} = pending). Each ticker run (own step, after the clock and group email steps; it also runs if the clock step failed) does this per request:
1. Claim it with a 2-minute lease in one transaction (several runners, or repeated runs, never apply it twice). A request leased by another live run is left alone.
2. Reject without touching the account if it is malformed, dated in the future, fails the same strength check as 	ools\set-password.cmd, or is **older than 15 minutes (the expiry)**: it is deleted and the status says *expired* or the reason.
3. Look the login up by email, set the password, mark the request `applied` (so a crash never applies it twice), then revoke the owner's old sessions (same admin calls as set-password.mjs).
4. Delete the request and write the final status (*done*, or a failure reason such as *login does not exist*) in one transaction. A temporary error (network) keeps the request and retries each minute until it expires.
The password is never logged (the log only shows the email and the outcome), never put in the status, and never written to the audit log; the status record cannot hold one (see `firestore.rules`: only the commissioner can create/read/delete `pwRequests`, no one can update them, and `pwStatus` allows only state/time fields). The request is only handled while the ticker is running. Publish the rules for this feature: `firebase deploy --only firestore:rules` (adds `pwRequests` and `pwStatus`), then deploy hosting. Cost: one small extra read per run when nothing is pending.

## Secrets: what to protect
- The service-account key and the Gmail app password both live in `%USERPROFILE%\.tbbl\`, outside the repository, which is git-ignored (`.tbbl/`). Never put either under `public/` (everything there is published), never email or paste them anywhere, never commit them.
- If the app password leaks, delete it at https://myaccount.google.com/apppasswords and make a new one. If the key leaks, delete it in Firebase console > Project settings > Service accounts and generate a new one.
