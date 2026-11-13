# Setup and deploy (one time, about 30 minutes)

You need a Google account, a computer with a browser, and Node.js (only to publish the site and run the tests).

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> and click **Add project**. Name it (for example `tbbl-draft`). Turn Google Analytics off. Stay on the free **Spark** plan; do not add a billing account.
2. **Build > Authentication > Get started > Email/Password** and switch it on (just the first toggle, not "email link").
3. **Build > Firestore Database > Create database**. Choose **production mode** and a US location. The location cannot be changed later.
4. **Project settings (gear) > General > Your apps > Web (`</>`)**. Register an app (skip "Firebase Hosting" here). Copy the `firebaseConfig` values.
5. In this folder copy `public/js/firebase-config.example.js` to `public/js/firebase-config.js` and paste your values (`apiKey`, `authDomain`, `projectId`, `appId`). These identify the project; they are not passwords.

## 2. Name the commissioner

1. **Authentication > Users > Add user**: your commissioner email and a password you choose.
2. **Firestore Database > Start collection**: collection ID `config`, document ID `admin`, one field: `email` (string) = the commissioner's email in lowercase (Rob Capizzano, team JER: use the ManagerEmail on the JER row of your owners file, typed exactly the same way you will sign in). This is how the security rules know who the commissioner is. Nobody can change it from the website, only from the console.

## 3. Publish

Install Node.js LTS from <https://nodejs.org> (accept the defaults), then open PowerShell in this folder (`TBBLDraft`):

```powershell
npm install -g firebase-tools
firebase login
firebase deploy --project YOUR_PROJECT_ID
```

`YOUR_PROJECT_ID` is the `projectId` value from step 1. This publishes the security rules (`firestore.rules`) and the website (`public/`). When it finishes it prints the address, normally `https://YOUR_PROJECT_ID.web.app`. Send that link to the owners. To publish a change later, run the same `firebase deploy` command again.

## 4. Load the league data

Sign in at your site as the commissioner and open the **Commissioner** tab. Follow the [Commissioner guide](COMMISSIONER-GUIDE.md): import draft order, players, owners, then press **Create owner logins**. Each owner gets an email with a link to set their own password (check spam). You can also try everything first using the files in `public/sample/`.

## Free-plan limits (check Google's current Firebase pricing page)

Spark includes a daily quota of Firestore reads/writes, 1 GiB storage, and generous hosting and sign-in allowances. This app loads about 350 documents per person per sign-in plus small live updates, so a 24-person draft is far below the daily quota. The Firestore quota resets daily; if it is ever exceeded the site stops until it resets.

## Known limits

- **No server clock.** There is no background job. Expired picks are skipped by whichever browser has the site open (the commissioner should leave a tab open during the draft). If nobody has the site open when a clock expires, the skip is recorded at the next page load and the next pick's clock starts then.
- **Clock times** come from the Firebase server for skip permission, and from your browser's clock (corrected using the web server's time) for the countdown. A wrong PC clock is corrected automatically.
- What the security rules enforce for owners: an owner can only fill the pick on the clock or their own skipped picks, only with a real pool player (or a write-in for that pick), and only for a team listed for their email. Any signed-in browser may start the draft at the start time, skip an expired pick, or move the clock on after the on-clock pick is made, but it must set the status to live, the clock to the next open pick, and a deadline between the **floor** (now plus one full clock length, minus 2 minutes of clock skew; closed hours only add time, so a real deadline is never earlier) and the ceiling (two clock lengths plus 24 hours). The floor stops an owner from writing a 1-second deadline to chain-skip the draft. Only the commissioner can pause, resume, complete, trade, undo or edit. Owners can only add audit-log entries for their own pick or a real skip/start.
- Remaining trust gap: the rules cannot recompute the 11 AM-11 PM clock, so within the floor and ceiling a technically skilled owner could still give the next pick a clock up to about a day longer than it should be (never shorter than one full clock length). The board and audit log would show it. If the gap between the on-clock pick and the next open pick is more than 3 (only possible when you filled picks out of turn), owners' browsers cannot move the clock on; you press Resume/Undo or pick, and it continues.
- **Draft lists and auto-draft.** Each owner's list is stored at `queues/{email}`: readable only by that owner and the commissioner, writable only by the owner. Because other owners cannot read it, auto-draft is carried out by the owner's own open browser or the commissioner's. The rules do not re-check the list; they check the same things as any pick (it is that team's pick on the clock, a real pool player or well-formed write-in, taken only once). The "outside clock hours" switch (`allowPickWhenClockPaused`) is likewise enforced by the app only. All clock logic (start, auto-draft, skip, confirm, complete) is in `public/js/lib/tick.js`. This project stays on the free Spark plan: no Cloud Functions and no billing account are used.
- **Open-browser dependency.** With 312 picks over weeks, skips and auto-drafts only happen while some browser is open. A heartbeat document (`ticks/last`, written at most every 4 minutes, about 180 writes per 12 clock hours) feeds the "Clock last checked" line on screen. The commissioner's **Monitor** tab (keep it open on a spare device during clock hours; see the commissioner guide) runs the check every 30 seconds and warns when no check has been recorded. The unattended ticker (	ools/ticker.mjs, see [TICKER.md](TICKER.md)) also runs the clock with no page open, via Windows Task Scheduler or optional GitHub Actions. It needs a service-account key, which bypasses the security rules: keep it private. Publish the updated rules (they add a 
otices collection) before using it.
- **Not yet tested against Firebase.** The security rules and the live screens were written without the Firebase emulator (needs Java) or a Firebase project. See `.agents/tasks/tbbl-draft/coder-notes.md` for exactly what has and has not been run. Do the rehearsal in step 6 before the real draft.

## 5. Lock down sign-up (after the owner logins exist)

Anyone who has the site address could otherwise register a login of their own. Such a login cannot draft (it has no team), but an outsider could register an owner's email before you create it. So:

1. Create all owner logins (Commissioner tab) **before** sharing the address.
2. Firebase console > **Authentication** (newer consoles: **Security > Authentication**) **> Settings > User actions**: untick **Enable create (sign-up)** and save. Owners can still sign in and reset passwords. Tick it again temporarily if you need to add a new owner login, then untick it.
3. Check **Authentication > Users**: there should be exactly your 24 owners plus you.

## 6. Rehearsal checklist (scratch project, sample files)

Use a second Firebase project (for example `tbbl-draft-test`), the files in `public/sample/`, and two browsers (one as commissioner, one as an owner). Check each item and note any failure:

1. Commissioner imports draft order, players, owners; creates logins; the owner signs in.
2. Start the draft; the owner on the clock drafts a player (works); a different owner cannot draft that pick; the owner cannot draft a future pick early.
3. Set the clock to 1 minute; let it expire with a browser open: the pick shows Skipped and the next pick is on the clock.
4. The skipped owner makes the late pick while someone else is on the clock.
5. Trade a pick on the clock to another team; the new owner can draft it and the old owner cannot.
6. Undo a pick; the player is available again.
7. Pause and resume; change the clock length; export both CSVs.
8. The audit log lists every step above.
9. **Deadline floor:** sign in as a second owner and, from the browser developer console, try to write a short deadline (for example now plus 1 second) to config/draft while making a legitimate pick or skip. The write must be refused.
10. **Auto-draft:** as an owner, add 3 players to the list (one already drafted by someone else) and switch Auto-draft On. When your pick comes up the first available one is drafted at once. Then empty the list: your pick arrives, nothing is drafted, the red warning shows, and the clock keeps running until it is skipped.
11. **Outside hours:** make a pick at night (after 11 PM ET); the next owner can pick right away; untick the commissioner option and confirm they cannot until 11 AM.
12. **Lists are private:** a second owner cannot read the first owner's queues document (the console Rules Playground or a failed read in the browser console shows it).

## Auto-deploy from GitHub (optional)

`.github/workflows/deploy.yml` publishes the site and the security rules every time you push to the `main` branch, after the tests pass. One-time setup:

1. Make the `TBBLDraft` folder a **private** GitHub repository with branch `main` (the private league files are git-ignored; check `git status` before the first commit).
2. Google Cloud console > IAM > Service accounts (project = your Firebase project): create `github-deploy`, give it the roles **Firebase Admin** and **Service Usage Consumer**, then Keys > Add key > JSON.
3. GitHub repository > Settings > Secrets and variables > Actions:
   - Secret `FIREBASE_DEPLOY_KEY`: the whole contents of that JSON key. Never commit it.
   - Variable `FIREBASE_WEB_CONFIG`: the web-app values as JSON, for example `{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}` (the same values as in `public/js/firebase-config.js`; they are not secret).
4. Push. Watch the Actions tab. The deploy stops if a test fails, if a variable or secret is missing, or if the key belongs to a different project than the config.
5. **Once the real draft is live, add the repository variable `DEPLOY_FROZEN` = `true`** so a stray push cannot change the live site mid-draft. Delete it to resume.

## Sign-in notes

- Owners use "Forgot password / first-time setup" on the login page any time; this sends a link to their email.
- Owners can change their password from the header. If the site says they must sign in again, sign out and in first.

## 7. Upgrade notes: group emails, Owners screen, set-password
- Publish the new rules: `firebase deploy --only firestore:rules` (adds `config/email`, `groupMail/state`, `logins/{email}`). Then deploy hosting as before.
- In `tools`, run `npm install` (adds `nodemailer` 10.5.0).
- Group emails: create a Gmail app password (2-Step Verification on the sender account, then App passwords), save it in `%USERPROFILE%\.tbbl\mail.json`, run `tools\test-email.cmd you@example.com`, check the group in groups.io for held (moderated) messages, then switch **Group pick emails** ON in the Commissioner tab (default OFF). Full steps: [TICKER.md](TICKER.md).
- Re-import the owners file to store team names and managers (the Owners screen shows them).
- `tools\set-password.cmd owner@example.com` sets a temporary password for one owner (commissioner PC only; needs the service-account key).
- Security: the service-account key and the Gmail app password stay in `%USERPROFILE%\.tbbl\`, outside the repo and never under `public/`.
- **Owners screen Set password button**: publish the rules again (irebase deploy --only firestore:rules, adds pwRequests and pwStatus) and deploy hosting. The request is applied by the ticker, so the ticker must be running (see TICKER.md). Requests expire after 15 minutes.
