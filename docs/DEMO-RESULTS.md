# Demo results

Produced by `node tools/make-demo-results.mjs` (the same script is asserted by `tests/demo-scenario.test.js`).
Data: the fake files in `public/sample/`. The clock is simulated; Monday 7 June 2027 starts at 11:00 AM Eastern.
The same walkthrough runs in a browser at `demo.html` (open it through the deployed site).

## Step log

```
[Mon 11:00 AM ET] Commissioner starts the draft
[Mon 11:00 AM ET] pick 1 (BEA) on the clock, deadline Mon 12:00 PM ET
[Mon 11:20 AM ET] BEA drafts Sample Player 121 at pick 1: OK
[Mon 11:20 AM ET] pick 2 (BOM) on the clock, deadline Mon 12:20 PM ET
[Mon 12:21 PM ET] Clock expired: pick 2 is skipped. pick 3 (CCC) on the clock, deadline Mon 1:21 PM ET
[Mon 12:31 PM ET] BOM makes its late pick 2 (Sample Player 122): OK
[Mon 12:31 PM ET] Pick 2 is made; pick 3 (CCC) on the clock, deadline Mon 1:21 PM ET
[Mon 12:31 PM ET] Commissioner trades pick 3 CCC -> COL: OK
[Mon 12:31 PM ET] Pick 3 original=CCC, owner=COL
[Mon 12:31 PM ET] CCC (old owner) tries to draft pick 3: REJECTED (Pick 3 belongs to COL, not to you)
[Mon 12:36 PM ET] COL (new owner) drafts Sample Player 123 at pick 3: OK
[Mon 12:36 PM ET] pick 4 (COL) on the clock, deadline Mon 1:36 PM ET
[Mon 12:41 PM ET] Commissioner undoes pick 1: OK
[Mon 12:41 PM ET] Pick 1 is open, Sample Player 121 is available again. pick 1 (BEA) on the clock, deadline Mon 1:41 PM ET
[Mon 12:46 PM ET] BEA writes in a player who is not in the pool at pick 1: OK
[Mon 12:46 PM ET] Pick 1 is made (write-in pending); pick 4 (COL) on the clock, deadline Mon 1:46 PM ET
[Mon 12:46 PM ET] A second write-in of the same player at pick 4 is blocked: REJECTED (That player was already written in at pick #1.)
[Mon 12:51 PM ET] Commissioner rejects the write-in: OK
[Mon 12:51 PM ET] Pick 1 is open again; pick 1 (BEA) on the clock, deadline Mon 1:51 PM ET
```

## Audit log

```
{"type":"start","by":"commissioner@example.com","at":1812380400000}
{"type":"pick","by":"owner-bea@example.com","at":1812381600000,"overall":1,"team":"BEA","playerId":"S0121","player":"Sample Player 121","late":false,"onBehalf":false}
{"type":"skip","by":"system","at":1812385260000,"overall":2,"team":"BOM"}
{"type":"pick","by":"owner-bom@example.com","at":1812385860000,"overall":2,"team":"BOM","playerId":"S0122","player":"Sample Player 122","late":true,"onBehalf":false}
{"type":"trade","by":"commissioner@example.com","at":1812385860000,"overall":3,"from":"CCC","to":"COL","orig":"CCC","note":"demo trade"}
{"type":"pick","by":"owner-col@example.com","at":1812386160000,"overall":3,"team":"COL","playerId":"S0123","player":"Sample Player 123","late":false,"onBehalf":false}
{"type":"undo","by":"commissioner@example.com","at":1812386460000,"overall":1,"team":"BEA","playerId":"S0121","player":"Sample Player 121","writeIn":false}
{"type":"writein","by":"owner-bea@example.com","at":1812386760000,"overall":1,"team":"BEA","playerId":"WI-1","player":"Sample Draftee Nine","url":"https://baseball-reference.com/register/player.fcgi?id=sample01","note":"","late":false,"onBehalf":false,"override":false}
{"type":"writein-reject","by":"commissioner@example.com","at":1812387060000,"overall":1,"team":"BEA","player":"Sample Draftee Nine","url":"https://baseball-reference.com/register/player.fcgi?id=sample01"}
```
