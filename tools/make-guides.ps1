# Builds the owner and commissioner guides as PDF and Word (.docx) files in TBBLDraft\guides (git-ignored).
# Needs Node and Microsoft Edge (Windows has it). Run:  powershell -ExecutionPolicy Bypass -File tools\make-guides.ps1
# PDF: Edge prints the styled HTML. Word: a .docx that carries the same HTML (Word converts it when you open it;
# use File > Save As in Word if you want to edit and keep it as a normal Word document).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'guides'
$node = if (Get-Command node -ErrorAction SilentlyContinue) { 'node' } else { 'C:\Program Files\nodejs\node.exe' }
& $node (Join-Path $PSScriptRoot 'make-guides.mjs') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'make-guides.mjs failed' }

$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found (needed for the PDF)' }
$profileDir = Join-Path $env:TEMP 'tbbl-guides-edge'

Add-Type -AssemblyName System.IO.Compression
function New-Docx($htmlPath, $docxPath) {
  $parts = [ordered]@{
    '[Content_Types].xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="html" ContentType="text/html"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    '_rels/.rels' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    'word/_rels/document.xml.rels' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="guide" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="guide.html"/></Relationships>'
    'word/document.xml' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:altChunk r:id="guide"/><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>'
  }
  $fs = [System.IO.File]::Open($docxPath, 'CreateNew')   # fails rather than overwrite
  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    foreach ($k in $parts.Keys) {
      $w = New-Object System.IO.StreamWriter($zip.CreateEntry($k).Open(), $utf8); $w.Write($parts[$k]); $w.Close()
    }
    $e = $zip.CreateEntry('word/guide.html').Open(); $bytes = [System.IO.File]::ReadAllBytes($htmlPath); $e.Write($bytes, 0, $bytes.Length); $e.Close()
  } finally { $zip.Dispose(); $fs.Dispose() }
}

# Never overwrite a file that already exists (you may have edited it in Word, e.g. added screenshots):
# a new build goes to "<name> (built <date time>).<ext>" instead.
$stamp = Get-Date -Format 'yyyy-MM-dd HHmm'
function Free-Name($name, $ext) {
  $p = Join-Path $out "$name.$ext"
  if (Test-Path -LiteralPath $p) { $p = Join-Path $out "$name (built $stamp).$ext" }
  if (Test-Path -LiteralPath $p) { throw "$p already exists; wait a minute and run again" }
  return $p
}

foreach ($name in 'TBBL-Draft-Owner-Guide', 'TBBL-Draft-Commissioner-Guide') {
  $html = Join-Path $out "$name.html"
  $pdf = Free-Name $name 'pdf'
  $docx = Free-Name $name 'docx'
  $url = ([System.Uri]$html).AbsoluteUri
  $p = Start-Process -FilePath $edge -PassThru -WindowStyle Hidden -ArgumentList @('--headless=new', '--disable-gpu', '--no-first-run', "--user-data-dir=`"$profileDir`"", '--no-pdf-header-footer', "--print-to-pdf=`"$pdf`"", $url)
  if (-not $p.WaitForExit(60000)) { $p.Kill(); throw "Edge did not finish the PDF for $name" }
  if (-not (Test-Path $pdf)) { throw "No PDF was written for $name" }
  New-Docx $html $docx
  Remove-Item $html
  "$(Split-Path -Leaf $pdf) and $(Split-Path -Leaf $docx)"
}
