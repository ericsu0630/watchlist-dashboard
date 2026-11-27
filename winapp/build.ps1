# Builds the Windows version (tray app + Node + the dashboard) as a zip in dist\, on Windows.
# It does what winapp/build.sh does on a Mac.
# Usage: powershell -ExecutionPolicy Bypass -File winapp\build.ps1             (x64)
#        powershell -ExecutionPolicy Bypass -File winapp\build.ps1 -Arch arm64
# Needs Go 1.26+, Node 20.19+ on PATH and node_modules from `npm install`. Downloads the Windows Node.js zip of the
# same version as the local node (or WD_WIN_NODE_VERSION) from nodejs.org once, checks it against SHASUMS256.txt and
# keeps it in dist\cache. The icon is winapp\icon.ico as committed (build.sh redraws it from icon.swift on a Mac).
param([string]$Arch = $(if ($env:WD_ARCH) { $env:WD_ARCH } else { 'x64' }))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Fail([string]$Message) { Write-Host $Message; exit 1 }
# Runs a program and stops on a non-zero exit. Windows PowerShell would treat its stderr as an error, so it's shown as text.
function Run([string]$Exe, [string[]]$Arguments) {
  $ErrorActionPreference = 'Continue'
  & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { Fail "$Exe $($Arguments -join ' ') failed (exit $LASTEXITCODE)" }
}

switch ($Arch) {
  'x64' { $goArch = 'amd64'; $machine = 0x8664 }
  'arm64' { $goArch = 'arm64'; $machine = 0xAA64 }
  default { Fail 'Arch must be x64 or arm64' }
}

$here = $PSScriptRoot
$root = Split-Path $here -Parent
$out = Join-Path $root 'dist'

foreach ($tool in 'go', 'node', 'npm.cmd', 'tar') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "$tool not found" }
}
if (-not (Test-Path (Join-Path $root 'node_modules'))) { Fail 'Run npm install first' }
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$nodeVersion = if ($env:WD_WIN_NODE_VERSION) { $env:WD_WIN_NODE_VERSION } else { (& node -v).Trim() }
$nodeVersion = 'v' + $nodeVersion.TrimStart('v')
$parts = $nodeVersion.Substring(1).Split('.') | ForEach-Object { [int]$_ }
if (-not ($parts[0] -gt 20 -or ($parts[0] -eq 20 -and $parts[1] -ge 19))) { Fail "Node 20.19 or newer is needed (got $nodeVersion)" }

# Windows Node.js, verified against the release's checksums.
$nodeName = "node-$nodeVersion-win-$Arch"
$nodeZip = "$nodeName.zip"
$cache = Join-Path $out 'cache'
New-Item -ItemType Directory -Force $cache | Out-Null
$sumsFile = Join-Path $cache "SHASUMS256-$nodeVersion.txt"
Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/SHASUMS256.txt" -OutFile $sumsFile -UseBasicParsing
$expected = $null
foreach ($line in Get-Content $sumsFile) {
  $f = $line -split '\s+'
  if ($f.Count -ge 2 -and $f[1] -eq $nodeZip) { $expected = $f[0].ToLower() }
}
if (-not $expected) { Fail "$nodeZip isn't listed in SHASUMS256.txt" }
$zipPath = Join-Path $cache $nodeZip
if (-not (Test-Path $zipPath) -or (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower() -ne $expected) {
  Write-Host "Downloading $nodeZip..."
  Invoke-WebRequest "https://nodejs.org/dist/$nodeVersion/$nodeZip" -OutFile "$zipPath.part" -UseBasicParsing
  Move-Item -Force "$zipPath.part" $zipPath
}
if ((Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower() -ne $expected) {
  Remove-Item -Force $zipPath
  Fail "$nodeZip doesn't match its SHA-256 in SHASUMS256.txt"
}

Write-Host "Building Watchlist $version for Windows $Arch with Node $nodeVersion..."
$stage = Join-Path $out 'build-win'
$app = Join-Path $stage 'Watchlist'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force "$app\node", "$app\app", "$stage\unzip" | Out-Null

Run tar @('-xf', $zipPath, '-C', "$stage\unzip", "$nodeName/node.exe", "$nodeName/LICENSE")
Move-Item "$stage\unzip\$nodeName\node.exe", "$stage\unzip\$nodeName\LICENSE" "$app\node\"
Remove-Item -Recurse -Force "$stage\unzip"

# Only what the server needs: this leaves out .env, data\, .claude-tests\, .git, docs and the Mac tools.
foreach ($f in 'server.js', 'package.json', 'package-lock.json') { Copy-Item (Join-Path $root $f) "$app\app\" }
foreach ($d in 'lib', 'public', 'node_modules') { Copy-Item -Recurse (Join-Path $root $d) "$app\app\$d" }
Get-ChildItem "$app\app" -Recurse -Force -Filter .DS_Store | Remove-Item -Force
# Drop any dev-only packages (offline; nothing is fetched), and the .bin folders, which the app doesn't use.
Push-Location "$app\app"
try { Run npm.cmd @('prune', '--omit=dev', '--offline', '--no-audit', '--no-fund', '--silent') } finally { Pop-Location }
Get-ChildItem "$app\app\node_modules" -Recurse -Force -Directory -Filter .bin | Remove-Item -Recurse -Force
$links = @(Get-ChildItem $app -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
if ($links.Count) { Fail "Links left in the app folder:`n$($links.FullName -join "`n")" }
# Native add-ons only run on the CPU they were built for, so node_modules must not have any (as in build.sh).
$native = @(Get-ChildItem "$app\app\node_modules" -Recurse -Force -Filter *.node)
if ($native.Count) { Fail "node_modules has native add-ons:`n$($native.FullName -join "`n")" }

# Tray app: icon and version info go in a .syso resource that go build picks up.
$saved = @{}
foreach ($k in 'GOOS', 'GOARCH', 'CGO_ENABLED') { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process') }
Push-Location $here
try {
  Remove-Item rsrc_windows_*.syso -ErrorAction SilentlyContinue
  Run go @('tool', 'go-winres', 'simply', '--arch', $goArch, '--out', 'rsrc', '--manifest', 'gui', '--icon', 'icon.ico',
    '--product-name', 'Watchlist', '--file-description', 'Watchlist', '--original-filename', 'Watchlist.exe',
    '--product-version', $version, '--file-version', $version)
  $env:GOOS = 'windows'; $env:GOARCH = $goArch; $env:CGO_ENABLED = '0'
  Run go @('vet', './...')
  Run go @('build', '-trimpath', '-ldflags', '-H windowsgui', '-o', "$app\Watchlist.exe", '.')
} finally {
  Remove-Item rsrc_windows_*.syso -ErrorAction SilentlyContinue
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
  Pop-Location
}

# Watchlist.exe must be a 64-bit Windows GUI program for $Arch (PE32+, subsystem 2).
$bytes = [IO.File]::ReadAllBytes("$app\Watchlist.exe")
$pe = [BitConverter]::ToInt32($bytes, 0x3C)
$ok = [BitConverter]::ToUInt16($bytes, $pe + 4) -eq $machine -and
  [BitConverter]::ToUInt16($bytes, $pe + 24) -eq 0x20B -and
  [BitConverter]::ToUInt16($bytes, $pe + 24 + 68) -eq 2
if (-not $ok) { Fail "Watchlist.exe isn't a $Arch Windows GUI program" }

Write-Host 'Making zip...'
$zip = Join-Path $out "Watchlist-$version-win-$Arch.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Run tar @('-a', '-cf', $zip, '-C', $stage, 'Watchlist')
Remove-Item -Recurse -Force $stage

Write-Host 'Done:'
Write-Host ('  {0} ({1:N0} MB)' -f $zip, ((Get-Item $zip).Length / 1MB))
