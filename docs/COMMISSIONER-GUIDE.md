# Commissioner guide

Sign in with the commissioner email. You get an extra **Commissioner** tab.

## CSV formats

Column names are matched loosely (case, spaces and punctuation ignored). Quoted values are fine.

**Draft order** (e.g. `public/sample/SAMPLE-DraftOrder.csv`)

| Column | Accepted names |
| --- | --- |
| round | `Round`, `Rd` |
| pick in round | `Pick in Round`, `Slot` |
| overall pick | `Overall`, `Overall Pick Number` |
| original owner | `Original Team`, `Orig Team` |
| current owner | `Current Team`, `Drafting Team` |

Rules checked on import: exactly 24 distinct teams, overall picks run 1..N with no gaps or duplicates, no blank owners. If a `Traded Team` column is present it must match the current owner. The order is used exactly as written.

**Players** (e.g. `public/sample/SAMPLE-players.csv`, or the league's `PUID, FullName, TeamID, AAA, DOB` layout): 

| Column | Accepted names |
| --- | --- |
| player ID | `player_id`, `PUID`, `ID` |
| name | `player_name`, `FullName`, `Name` |
| team | `team_code`, `TeamID`, `Team` (a code = that team already owns the player; blank or `AVAILABLE` = draftable) |
| optional | `AAA` (any non-blank value = flagged), `DOB`, `pos`, `mlb_team` |

League conventions the importer follows:

- A PUID above 9,999 is an MLB player ("MLB" in the pool filter). A PUID of **-1 with the AAA flag** is valid: a player who never played in MLB, created by hand in the league database ("Non-MLB"). Each gets a stable internal key built from name + DOB; the original `-1` and AAA flag are kept for the exports. A -1 without the AAA flag imports but shows a warning.
- **Merge rule:** if a -1/AAA row and a real-ID row have the same name and DOB, the real-ID record is kept, it takes the team from the -1/AAA row, and the -1 row is dropped. Every merge is listed as a "MERGED:" notice when you check or import. (Example from the sample file: Anthony Kay and Foster Griffin on RAV.) Your source CSV is never modified.
- Same name + DOB on any other pair of rows is a warning only; nothing is dropped.
- Blank IDs, duplicate real IDs, and team codes that are not in the draft order are errors and stop the import.
- IDs/keys may only contain letters, numbers, `-` and `_`.

**Players with stats: the hitters and pitchers rating files.** Instead of the single players file you can import two files, `TBBLPlayerRatings_HittersOnlineDraft.csv` and `TBBLPlayerRatings_PitchersOnlineDraft.csv` (choose both on the Commissioner tab, then Check and Import). They replace the single file; the Players tab then shows each player's stats and a Hitters / Pitchers switch, and every stat column sorts.

- Hitters columns: `PUID, Name, Team, P, Age, AVG, OBP, SPC, AB, H, 2B, 3B, HR, R, RBI, HBP, BB, K, SB, CS`. Pitchers columns: `Name, Team, P, Age, ERA, W, L, S, G, GS, CG, SHO, INN, H, R, ER, HR, HBP, BB, IW, K, GDP, PUID`. Column order does not matter. `P` is the position. `Team` is the owning TBBL team code; blank = draftable.
- Every stat cell must be a number. A blank or non-numeric cell (for example a stray label or a split number such as `11  1`) is an error that names the file, line, player and column, and nothing is imported.
- One row per player in each file. If a player has several stat lines (for example after a trade), keep only his season-total row, or the import stops with "Player ID ... is used by N rows".
- PUID -1 marks a player who never played in MLB. These files have no AAA column, so no AAA warning is shown, and the key comes from the name alone (two -1 players with the same name would collide and be reported as an error).
- A two-way player in both files (same PUID) becomes one player with hitting and pitching stats and appears in both views. It is listed as a "MERGED:" notice.
- Names are used exactly as written, including the `aaa` marker.

**Owners** (e.g. `public/sample/SAMPLE-owners.csv`, or the league's `Abb, TeamName, ManagerName, ManagerEmail` layout): `email` (or `ManagerEmail`) and `team_code` (or `Abb`). One email may own several teams (separate codes with a space or `;`).

## Inviting owners (invites that never expire)

Firebase's own password-setup links expire after about an hour, and Firebase does not let you change that. So use the invite instead:

1. Commissioner tab, section 1: **Send invite emails to all owners**, or **Send invite** on one row of the Owners table (1b). Changing an owner's email also offers to send one.
2. The ticker on your PC sends each invite on its next run (about a minute), from the league Gmail account (the same `mail.json` as the group emails). It creates the owner's login first if there is none. The **Invite** column shows *Waiting for the ticker*, then *Sent* with the time, or *Not sent* with the reason.
3. The invite links to `https://<your site>/#setup?email=...`. That screen has the owner's email filled in and one button, **Email me a link to set my password**. Firebase then sends its 1-hour link at that moment. If the owner is too slow, they open the invite link again and press the button again. The invite itself never expires.

Notes: the ticker must be running (Task Scheduler, see TICKER.md) and `mail.json` must exist; otherwise invites wait and the column keeps saying so. An invite that has not gone out within 7 days is marked *Not sent* rather than going out by surprise later; press **Invite again**. Sending again to an owner who already set a password does no harm: the email tells them to just sign in. The old buttons (Firebase setup links that expire) are still there under "Older way".

## Online now (who has the site open)

Every signed-in owner's page, while it is in front, writes `presence/{login id}` with its team codes and the time every 5 minutes; the **Online now** line under the banner shows teams seen in the last 12 minutes (team codes only, never emails). A login with no team, such as a commissioner-only login, is not listed. The rules only let a login write its own entry with exactly the teams it owns. Free-plan cost: about N x N / 5 reads a minute with N teams online (10 online all day is about 14,000 reads in 12 hours), so watch the Firestore usage page during busy days. Publish the rules for this feature (auto-deploy does it on push).

## Editing an owner (any time, including while live)

Commissioner tab, section 1b (Owners): press **Edit** on a row, change the team code(s), team name, manager or email, then **Save** (or Cancel). The table stops updating while you edit, so nothing you type is lost.

- Several teams for one owner: codes separated by a space (`RAV COL`), names in the same order separated by ` / `.
- The same checks as the owners file: a valid email, at least one team, only teams in the draft order, and a team can belong to only one email (take it off the other owner first).
- **Changing an email** moves the team(s) and the owner's draft list (with the Auto-draft switch) to the new address. The old address can no longer draft. You are then offered to create the new login and send its password-setup email. The old login is left in Firebase Authentication; delete it there if you like.
- Every save is written to the audit log (type `owner-edit`). An owner who is signed in while you change their teams or email should reload the page (or sign out and in).
- Re-importing the owners file later replaces these edits with the file, so update your CSV too.

## Removing a player who is listed by mistake (any time, including while live)

Players tab, signed in as commissioner: every row that is not already drafted has a **Remove** button. Confirm, give a reason (saved in the audit log) and he is out:

- Nobody can draft him: the buttons disappear, and the security rules refuse the pick even from a modified browser.
- He disappears from the Players tab, every owner's draft list, and the rosters. Auto-draft skips him and takes the next entry on the list.
- Nothing is deleted. Players tab > **Show > Removed from list** lists everyone you removed, with a **Restore** button.
- If he was already drafted, undo that pick first (Commissioner tab), then remove him.
- It works while the real-draft lock is ON. Re-importing the player file keeps the removed list (the Check summary tells you how many are on it), and Restart does not clear it.
- Publish the updated rules (`firebase deploy --only firestore:rules`) and the site before using it. The ticker needs no change beyond the new code in `tools/ticker.mjs` (it reads the removed list).

## Replacing a file later (re-import)

The real player file arrives in January 2027; the draft order and owner emails may also change. No code change or redeploy is needed: sign in, Commissioner tab, section 1.

1. Choose the new file and press **Check**. Nothing is written. You see errors (must fix), warnings, "MERGED:" notices, and a summary versus the previous import: new/removed players, team changes, renames (or owner changes for the other two files).
2. When it is valid, press **Import**. You are asked to confirm.
3. Limits: the **player pool is locked once any pick has been made**, and the **draft order is locked once the draft has started** (re-importing the order resets all picks to open, so do that first). Owner emails can be re-imported at any time; press **Create owner logins** afterward for any new email.
4. Order if everything changes: draft order, then players, then owners. Re-importing the draft order keeps the start time and clock length.

## Write-in picks (a player who is not in the pool)

The pool will not contain every drafted player. An owner on the clock (or you, picking for them) can open "Player not in the list? Write him in" on the Players tab and enter:

- the **name**, and
- a **link** (any well-formed http/https address; baseball-reference.com preferred) **or a note** that identifies him. One of the two is required.

Rules:

- The pick **counts immediately** and the clock advances. It is shown as "[write-in, pending verification]" on the board, rosters and history.
- If the link is a baseball-reference.com page (`/players/x/idhere.shtml` or `/register/player.fcgi?id=...`), the Baseball-Reference id is extracted. A write-in is blocked as a duplicate if an earlier write-in has the same Baseball-Reference id, the same link, or the same normalized name (case, accents, punctuation and Jr/Sr ignored).
- If the typed name matches a player already in the pool, the owner is told to pick that player from the list. Only you can override this (tick the box, then press the button).
- Commissioner tab, section 6: **Confirm**, **Edit** (name, link, note; still duplicate-checked) or **Reject**. Reject works like an undo: the pick reopens for the owner (with a fresh clock if it is now the earliest open pick), the write-in is removed, and the audit log records it.
- Exports: the **Results CSV** lists write-ins as PUID `-1`, AAA, name, drafting team, round, pick in round, overall, link and Baseball-Reference id. **New players to create** lists just the write-ins, for entering them by hand in the league database.

**Open decision for you:** high-school players may have no baseball-reference.com page. The site currently lets the owner give a free-text note (for example "HS SS, Tulsa OK, class of 2027") or any other link instead. You decide whether that is acceptable, or whether you will reject such write-ins until a link exists (use Reject).

## Before the draft

1. **Import** in this order: draft order, players, owners (use Check first; see re-import below).
2. **Create owner logins**: sends every owner an email to set their password. Use **Re-send** if someone lost it. Do this **before** you share the site address. If the site says an owner's email is already in use and you did not create it, delete that user under Firebase console > Authentication > Users and create it again. Then turn off self sign-up (see SETUP-DEPLOY, step 5).
3. Set the **start time** (Eastern) and the **clock length** (default 60 minutes).
4. **Rehearse** with the sample files in a separate (scratch) Firebase project before the real draft. The security rules have not been run against Firebase yet, so this rehearsal is the test. Use the checklist in SETUP-DEPLOY, step 6.

## Running the draft

- At the start time any open browser starts the draft automatically. You can also press **Start now**.
- **Clock**: runs only 11:00 AM to 11:00 PM Eastern each day. A pick started at 10:30 PM with a 1-hour clock has 30 minutes tonight and 30 minutes from 11:00 AM tomorrow.
- **Skips**: when time runs out the pick is marked skipped and the next open pick goes on the clock. The skipped owner can fill it any time, in any order, without a clock. Leave a browser tab open during the draft so skips and auto-drafts are recorded promptly (see below).
- **Outside clock hours**: a pick goes on the clock the moment the pick before it is made, at any hour. By default (section 2, tick box) the owner can pick right then even though the countdown only starts at 11:00 AM ET. Untick it to allow owner picks only inside the window. This switch is enforced by the app, not by the server rules.
- **Auto-draft**: each owner has a private draft list with an On/Off switch. When their pick comes on the clock and it is On, the first available entry is drafted at once, at any hour (entries that were taken, or write-ins that are now duplicates, are skipped). It never picks best-available. If the list is exhausted, nothing happens, the owner sees a red warning, the full clock keeps running and the usual skip applies. Auto-draft is carried out by an open browser: the owner's own or **yours**. Yours is the only one that can read every owner's list, so **keep the commissioner tab open all day during the draft** (the draft can run for weeks: 312 picks, 12 clock hours a day). A banner line "Clock last checked" shows when any browser last ran the clock and warns if it is over 10 minutes old during clock hours. Nothing is lost if every tab is closed: the next browser that opens does the skips and auto-drafts (a pick whose list can fill it is drafted before it is skipped), but the following clocks then start at that moment. Auto-draft also works with the owner's browser closed as long as Monitor Mode or the unattended ticker is running.
- **Write-ins waiting in lists** (section 6b): you can see every write-in in owners' lists ahead of time and tick **Verified**. When auto-draft makes that pick, your open tab confirms it automatically.
- **Monitor Mode (keep this open during clock hours)**: sign in as commissioner and open the **Monitor** tab on a spare phone, tablet or PC and leave it plugged in. It runs the clock check (skips, auto-drafts, confirming verified write-ins) about every 30 seconds, shows the last recorded check and the next deadline, and shows a red warning if no browser has recorded a check for over 6 minutes while the 11 AM-11 PM ET window is open. It asks the browser to keep the screen awake (Screen Wake Lock). If the browser can't, the page says so: turn off screen sleep in the device settings and keep the page in the foreground. The draft stays on the free Firebase plan; nothing here needs a paid plan or a Cloud Function.
- **If no page is open**: nothing is lost. The skip or auto-pick is recorded the next time any signed-in page loads (a pick whose list can fill it is auto-drafted before it is skipped), but the next clock starts at that moment, so the draft runs later than planned.
- **Unattended ticker (recommended for auto-draft)**: `tools/ticker.mjs` runs the same clock logic with no page open, so skips and auto-drafts happen even when every browser is closed. Run it every minute from Windows Task Scheduler on a PC you leave on, or about every 5 minutes from an optional GitHub Actions workflow. Step-by-step setup, the security warning (the service-account key can read private lists and bypass the rules; keep it private, commissioner only) and the free-plan numbers are in [TICKER.md](TICKER.md). The ticker, Monitor Mode and owners' pages can all run at once; each step is a checked transaction, so no pick or skip is ever done twice.
- **"Let owners pick outside clock hours" is advisory**: the app enforces it, but the server rules cannot compute the 11 AM-11 PM ET window, so a technically skilled owner could still pick an on-clock pick off-hours even with it unticked.
- **Pause / Resume** (section 3, the buttons next to Start now): pause stores the time left; resume continues with it. This is your pause for the real draft: it works at any time and stays available while the real-draft lock is on.
- **Clock length change**: the pick on the clock keeps the same fraction of time remaining (half used stays half used); every later pick gets the full new length.
- **Who can pick what**: an owner can fill only the pick on the clock (if their team owns it) and their own skipped picks. Future picks unlock when they come on the clock. You can fill any pick at any time.
- **Pick for an owner**: Players tab, choose the pick under "Drafting for" (you see every open pick), press Draft.
- **End of the draft**: when an owner makes the very last pick, the board says "All picks are made" and your browser marks the draft complete the next time you have the site open (owners cannot close the draft).
- **Trade a pick**: Commissioner tab, section 4. Pick, new owner, optional note. The original owner stays on record ("via NHH"), the clock on that pick is not reset, and the old owner can no longer pick it. A made pick must be undone before it can be traded.
- **Undo**: section 5. The player becomes available again and the pick reopens. If that pick is now the earliest open pick it goes back on the clock with a fresh full clock. A pick that had been skipped goes back to skipped.
- **Replace the player** on a made pick: section 5, enter the new player's ID.
- **Audit log**: section 8 lists starts, pauses, picks (including who made them and whether late or on behalf), write-ins and their confirm/edit/reject, skips, trades, undos and clock changes.

## Export

History tab or Commissioner tab section 7: **Results CSV** (one row per pick with player, owner, original owner, time and who picked) and **Draft-order CSV** (same columns as the input, with `Player Drafted` filled as `Name (PUID)` or `Name (WRITE-IN)`), and **New players to create** (write-ins only).

## If something goes wrong

- "The draft just changed. Please try again." means someone else's action landed first. Retry.
- A wrong pick: Undo it, then pick again (or use Replace).
- The banner says the clock is paused until 11:00 AM ET: that is the overnight pause working as designed.

## Group pick emails, Owners screen, set-password (new)
- **Group pick emails** (Commissioner tab, section 3b): one switch, default OFF, only you can change it. When ON, the ticker emails TBBL@groups.io after every 5 picks and when the draft completes. Turning it ON starts counting from the picks made after that moment; picks made while OFF are never emailed. Setup (Gmail app password, groups.io check, test email) is in [TICKER.md](TICKER.md). Nothing is sent unless the ticker is running.
- **Owners** (Commissioner tab, section 1b): every team with team code, team name and manager (when the owners file has them), email, and sign-in status, plus **Send set-password email** per row. Passwords are never shown or stored. The site cannot list Firebase logins on the free plan, so it cannot know whether an account exists or has a password; "Last signed in" appears once an owner signs in with this version of the site, and "No sign-in recorded" does not prove they never did.
- **Owners file formats**: both `email,team_code` and `Abb,TeamName,ManagerName,ManagerEmail` are accepted.
- **Owner can't reset their password**: run `tools\set-password.cmd owner@example.com` on your PC (see [TICKER.md](TICKER.md)), then ask them to change it after signing in.
- **Board**: the draft board now has pick slots 1-24 down the side and rounds across, with no vertical scrolling.
- **Set password (Owners screen, section 1b)**: for an owner who cannot use the email, press **Set password** on their row, type a temporary password (the same strength rules as the command-line tool are shown and checked before **Send request** enables), and send. The site cannot change another person's password itself (free plan, no server), so the request goes to the **ticker on your PC**: it sets the password within about a minute, signs the owner out of old sessions, deletes the request at once, and the row's **Password request** column changes from *pending* to *Password set* with the time, or to a clear reason (*login does not exist*, *weak password*, *expired*). **It only goes through while the ticker is running.** A request not applied within **15 minutes** is never applied: it is deleted the next time the ticker runs and shown as *expired*; use **Cancel request** to remove a pending one (and its stored password) yourself. You type the temporary password each time. It is never generated, never shown again after you send it, never logged, never written to the audit log, and no owner can read it. Then **give the password to the owner privately (phone or text, not the group email) and ask them to sign in and press Change password right away.** The command-line tool 	ools\set-password.cmd still works as a fallback.

## Real-draft lock and Restart draft (for test runs)

**Restart draft** (Commissioner tab, section 9) lets you run the draft again from the beginning for testing. Type RESTART in capital letters and press the button; a warning says it erases every pick.

It resets:
- every pick back to open, skips cleared, write-ins removed, every drafted player available again;
- the draft back to not-started (start time and clock length stay as they were; press Start now to begin again);
- all trades back to the draft order as imported (a trade that was already in the imported file stays);
- group pick emails: the switch goes OFF and the batch counting is reset (a restart never sends email; turn the switch on again yourself when you want it);
- the audit log is cleared, then one entry records the restart and its time;
- pending Set-password requests and owners' "list exhausted" notices are cleared.

It keeps the players, the draft order, owners and logins, and each owner's draft list and Auto-draft setting. If the start time has already passed, the draft starts again by itself within about a minute, so change the start time first if you want to press Start now yourself.

It writes in several steps (about 4 to 6 batches). If your connection drops part way, the page says the restart did not finish; the draft stays not-started and the clock stands still until you press Restart again, which is safe to repeat.

**Real draft lock** (section 3, "Real draft: unlocked/LOCKED"): turn it ON before the real draft. While locked, Restart and the re-imports that reset picks (draft order, players) are refused, both by the page and by the server rules, until you turn the lock off again (it asks you to confirm). It starts unlocked. Pause and Resume are not affected: use them (section 3) to stop and restart the clock during the real draft. Undo, trades and write-in handling also keep working.

Before this goes live, publish the updated irestore.rules (the lock and Restart need them; the ticker also needs the new code) as in SETUP-DEPLOY.md.

## Voiding or adding a pick

### Before the draft starts: use the draft-order CSV
Edit the CSV and re-import it (Commissioner tab, section 1). To void a pick, delete its row or give the pick to the team you want; to add a pick, add a row. **The Overall column must stay 1..N with no gaps** (the import refuses gaps and duplicates), so after adding or deleting a row renumber Overall (and the pick-in-round if you want clean labels). Re-importing resets every pick to open, which is fine before the start. Once the draft has started the order is locked and a re-import would wipe picks, so use the in-app actions below.

### During the draft: Commissioner tab, section 5b
- **Void pick.** Pick any pick that has not been drafted (open or skipped), add an optional note, press Void pick. It stays on the board marked VOID (grey, struck through), shows in History, the audit log and both CSV exports, and can never be drafted, skipped, traded or put on the clock. If it was on the clock, the clock moves to the next open pick with a fresh full clock. A pick that was already drafted cannot be voided: use **Undo** (section 5) first, then void it.
- **Un-void pick.** Reverses a void. The pick returns to its place as open (or skipped, if it had been skipped before). If it is now the earliest open pick it goes on the clock with a fresh full clock.
- **Add pick.** Choose the pick it goes after and the team that owns it. It gets a letter: added after 5.12 it becomes **5.12a**, the next one **5.12b**. No existing label or overall number changes. Its overall is shown as the base number plus the letter (60a).
- Void, Un-void and Add work while the draft is live or paused, and also while the **real-draft lock is ON**. Every one is written to the audit log (types `void`, `unvoid`, `addpick`). Only the commissioner can do them (enforced in the server rules, owners cannot).

### How the details were decided
- **Owner of an added pick:** the team you choose. It is stored as both the current owner and the original team (so it does not show as "via"). It can be traded like any pick; the original team then stays as chosen.
- **Order of letters:** a new pick is always put at the end of the lettered run of the pick it follows: adding after 5.12 or after 5.12a gives 5.12b, placed after 5.12a. You cannot slot one between 5.12 and 5.12a, because that would relabel an existing pick.
- **Added pick placed before the clock:** if you add a pick after a pick that is already behind the clock, the new pick is the earliest open pick, so it goes on the clock with a fresh full clock (same as an Undo). Add it after the on-clock pick or later if you do not want that.
- **Skipped picks** can be voided (they stop being fillable as late picks). Void is not available before the draft starts (use the CSV) or after it is complete.
- **Restart draft** wipes all of this: added picks are deleted, voids cleared, trades reverted, exactly as imported.
- **Board:** an added pick shares the cell of the pick it follows (one extra line, "1.2a CODE ..."), so the board keeps its 24 rows and its columns; only that row gets taller. A voided pick's cell reads VOID. Traded picks (the ones showing "via XXX") have a light blue background, the pick on the clock stays yellow (a traded pick on the clock shows yellow with a blue left edge). A legend sits above the board.
- **Exports:** the draft-order CSV shows `1.2a` in Round/Slot, `2a` in Overall and `VOID` in Player Drafted. The Results CSV shows status `VOID`, the label in `overall`, and three new last columns `pick_label`, `added_pick`, `void_note`.
- **Group pick emails:** a voided pick is listed once in the next email as "Pick 5.3 (PAN): pick voided"; it does not count toward the 5 made picks. Un-void is not emailed. A drafted added pick is emailed like any pick with its letter (5.12a). (A pick that was voided, un-voided and voided again is only reported the first time.)
- **Deploy note:** this change needs firestore.rules, hosting and the ticker code deployed. The rules now follow a `next` pointer to walk the order (needed for added picks); old data without it works as before.
