<#
.SYNOPSIS
  Packages the API for Azure App Service zip deployment.

.DESCRIPTION
  Copies api/, src/services/, src/config/, data/ into a staging directory,
  runs npm install --production, and creates a zip file for deployment.

.PARAMETER OutputPath
  Path for the output zip file. Default: deploy/api-package.zip

.PARAMETER StagingDir
  Temporary staging directory. Default: deploy/.staging
#>

[CmdletBinding()]
param(
    [string]$OutputPath,
    [string]$StagingDir
)

$ErrorActionPreference = "Stop"
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Get-Location }
$RepoRoot = Split-Path -Parent $ScriptDir

if (-not $OutputPath) { $OutputPath = Join-Path $ScriptDir "api-package.zip" }
if (-not $StagingDir) { $StagingDir = Join-Path $ScriptDir ".staging" }

function Write-Step([string]$msg) { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Success([string]$msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }

# Clean previous staging
if (Test-Path $StagingDir) {
    Remove-Item -Path $StagingDir -Recurse -Force
}
New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null

Write-Step "Copying API files..."
Copy-Item -Path (Join-Path $RepoRoot "api\*") -Destination $StagingDir -Recurse -Force

Write-Step "Copying src/services..."
$srcDest = Join-Path $StagingDir "src"
New-Item -ItemType Directory -Path $srcDest -Force | Out-Null
Copy-Item -Path (Join-Path $RepoRoot "src\services") -Destination (Join-Path $srcDest "services") -Recurse -Force
Copy-Item -Path (Join-Path $RepoRoot "src\config") -Destination (Join-Path $srcDest "config") -Recurse -Force

Write-Step "Skipping data directory (uploaded separately)..."
# Data is uploaded separately to /home/data via Kudu API to avoid bloating the zip.
# The startup script (startup.sh) creates a symlink: /home/site/wwwroot/data -> /home/data

Write-Step "Copying UI dist..."
$uiDist = Join-Path $RepoRoot "ui\dist"
if (Test-Path $uiDist) {
    $uiDest = Join-Path $StagingDir "ui\dist"
    New-Item -ItemType Directory -Path $uiDest -Force | Out-Null
    Copy-Item -Path (Join-Path $uiDist "*") -Destination $uiDest -Recurse -Force
    Write-Success "UI dist included in package"
} else {
    Write-Host "  [WARN] ui/dist not found - run 'npm run build' in ui/ first" -ForegroundColor Yellow
}

Write-Step "Creating startup script..."
# Startup script symlinks persistent /home/data to the deployment's expected ../data path,
# seeds initial data on first deploy, then starts the server.
$startup = @'
#!/bin/bash
set -e

DEPLOY_DIR="/home/site/wwwroot"
PERSISTENT_DATA="/home/data"

# Persistent data at /home/data (survives redeployments)
mkdir -p "$PERSISTENT_DATA/daily" "$PERSISTENT_DATA/lancedb"

# Symlink so relative paths (../data/) resolve to persistent storage
# db.js uses join(__dirname, '..', 'data') which resolves to /home/site/data
ln -sfn "$PERSISTENT_DATA" /home/site/data

# server.js imports ../src/ — symlink so it resolves outside wwwroot
ln -sfn "$DEPLOY_DIR/src" /home/site/src

echo "[startup] Data dir: $PERSISTENT_DATA (symlinked)"
echo "[startup] Starting server..."
cd "$DEPLOY_DIR"
exec node server.js
'@
# Use ASCII to avoid BOM (UTF-8 BOM breaks the shebang on Linux)
$startup | Set-Content -Encoding ASCII -NoNewline -Path (Join-Path $StagingDir "startup.sh")

Write-Step "Updating package.json for App Service..."
# The api/package.json was already copied. Just ensure "type": "module" and start script are set.
# The dependencies from api/package.json are preserved so npm install works correctly.
$pkgPath = Join-Path $StagingDir "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.scripts.start = "node server.js"
if (-not $pkg.type) { $pkg | Add-Member -NotePropertyName "type" -NotePropertyValue "module" -Force }
$pkg | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -Path $pkgPath

Write-Step "Preparing dependencies..."
# Skip local npm install -- let Oryx build on App Service handle this.
# This avoids platform-specific native module issues (e.g., better-sqlite3).
$lockFile = Join-Path $ScriptDir ".staging-lock\package-lock.json"
if (-not (Test-Path $lockFile)) { $lockFile = Join-Path $RepoRoot "api\package-lock.json" }
if (Test-Path $lockFile) {
    Copy-Item -Path $lockFile -Destination (Join-Path $StagingDir "package-lock.json") -Force
    Write-Success "package-lock.json included for Oryx build"
}

# Remove all node_modules -- Oryx will install on the server
Get-ChildItem -Path $StagingDir -Recurse -Directory -Filter "node_modules" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
Write-Success "Stripped node_modules from package"

# Ensure .npmrc points to public registry (corporate .npmrc on server may have stale tokens)
"registry=https://registry.npmjs.org/" | Set-Content -Encoding UTF8 -Path (Join-Path $StagingDir ".npmrc")

Write-Step "Creating zip package..."
if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }
# Use .NET ZipFile instead of Compress-Archive to ensure forward-slash paths (Linux-compatible).
# Compress-Archive preserves Windows backslashes which break rsync on Linux App Service.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$resolvedStaging = [System.IO.Path]::GetFullPath($StagingDir)
$zip = [System.IO.Compression.ZipFile]::Open($resolvedOutput, 'Create')
try {
    Get-ChildItem -Path $resolvedStaging -Recurse -File | ForEach-Object {
        $relativePath = $_.FullName.Substring($resolvedStaging.Length + 1).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $relativePath) | Out-Null
    }
} finally {
    $zip.Dispose()
}

# Clean up staging
Remove-Item -Path $StagingDir -Recurse -Force -ErrorAction SilentlyContinue

$sizeMB = [math]::Round((Get-Item $OutputPath).Length / 1MB, 2)
Write-Host "[OK] Package created: $OutputPath ($sizeMB MB)" -ForegroundColor Green
