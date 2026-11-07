$ErrorActionPreference = 'Stop'
$bat = Join-Path $PSScriptRoot 'start-desktop.bat'
if (-not (Test-Path -LiteralPath $bat)) { throw "Missing launcher: $bat" }
$quoted = '"' + $bat.Replace('"', '""') + '"'
Start-Process -FilePath $env:ComSpec -ArgumentList @('/c', $quoted) -Verb RunAs
