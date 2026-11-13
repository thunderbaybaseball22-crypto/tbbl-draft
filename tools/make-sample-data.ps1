# Regenerates the clearly fake sample files in public\sample. Run from PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\make-sample-data.ps1
# Nothing here is real league data.
$ErrorActionPreference = 'Stop'
$here = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'public\sample'
$teams = 'BEA','BOM','CCC','COL','CYC','GOT','ISO','JER','JOT','KBB','LAH','LIL','LTR','LVB','NHH','OLS','PAN','PHS','PLU','PUR','RAV','SCA','SMC','WHC'

# --- players: 500 fake players, 5 keepers per team (120), 380 available ---
$pos = 'C','1B','2B','3B','SS','OF','OF','SP','SP','RP'
$mlb = 'FAA','FAB','FAC','FAD','FAE','FAF'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('player_id,player_name,team_code,pos,mlb_team')
for ($i = 1; $i -le 500; $i++) {
  $team = ''
  if ($i -le 120) { $team = $teams[($i - 1) % 24] }
  $lines.Add(('S{0:D4},Sample Player {1:D3},{2},{3},{4}' -f $i, $i, $team, $pos[$i % 10], $mlb[$i % 6]))
}
[IO.File]::WriteAllLines((Join-Path $here 'SAMPLE-players.csv'), $lines)

# --- draft order: 13 rounds x 24, straight order, 21 traded picks ---
$trade = @{}
for ($k = 0; $k -lt 21; $k++) {
  $o = 5 + $k * 14
  $to = ($k * 7 + 3) % 24
  if ($to -eq (($o - 1) % 24)) { $to = ($to + 1) % 24 }   # never "trade" a pick to its own owner
  $trade[$o] = $teams[$to]
}
$s = New-Object System.Collections.Generic.List[string]
$s.Add('Round,Pick in Round,Overall,Original Team,Current Team')
for ($r = 1; $r -le 13; $r++) {
  for ($p = 1; $p -le 24; $p++) {
    $o = ($r - 1) * 24 + $p
    $orig = $teams[$p - 1]
    $cur = $orig
    if ($trade.ContainsKey($o)) { $cur = $trade[$o] }
    $s.Add("$r,$p,$o,$orig,$cur")
  }
}
[IO.File]::WriteAllLines((Join-Path $here 'SAMPLE-DraftOrder.csv'), $s)

# --- owners: fake example.com addresses ---
$ow = New-Object System.Collections.Generic.List[string]
$ow.Add('email,team_code')
foreach ($t in $teams) { $ow.Add("owner-$($t.ToLower())@example.com,$t") }
[IO.File]::WriteAllLines((Join-Path $here 'SAMPLE-owners.csv'), $ow)
Write-Output 'Sample files written.'
