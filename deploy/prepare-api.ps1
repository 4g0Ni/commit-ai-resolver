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
    [string]$StagingDir,
    # Node runtime the App Service runs (must match web.config processPath).
    # Native modules are normalized to this runtime's ABI before packaging so a
    # local `npm rebuild` under a different Node version can't ship a mismatched
    # binary (root cause of the 2026-06-26 better-sqlite3 ABI outage).
    [string]$ServerNodeVersion = "20.20.2",
    # NODE_MODULE_VERSION (ABI tag) for $ServerNodeVersion. Node 20 = 115.
    [string]$ServerNodeAbi = "115"
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

Write-Step "Fixing import paths for flat layout..."
# In the repo, api/server.js imports ../src/. In the staging dir, server.js and src/ are siblings,
# so we rewrite '../src/' to './src/'.
$serverJs = Join-Path $StagingDir "server.js"
$content = [System.IO.File]::ReadAllText($serverJs)
$content = $content -replace '\.\./src/', './src/'
[System.IO.File]::WriteAllText($serverJs, $content)

Write-Step "Copying scripts..."
$scriptsDest = Join-Path $StagingDir "scripts"
New-Item -ItemType Directory -Path $scriptsDest -Force | Out-Null
Copy-Item -Path (Join-Path $RepoRoot "scripts\*.js") -Destination $scriptsDest -Force

Write-Step "Creating web.config for HttpPlatformHandler..."
$webConfig = @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <webSocket enabled="true" />
    <handlers>
      <add name="httpPlatformHandler" path="*" verb="*" modules="httpPlatformHandler" resourceType="Unspecified"/>
    </handlers>
    <httpPlatform processPath="%ProgramFiles%\nodejs\20.20.2\node.exe"
                  arguments="bootstrap.js"
                  startupTimeLimit="60"
                  stdoutLogEnabled="true"
                  stdoutLogFile="D:\home\LogFiles\node">
      <environmentVariables>
        <environmentVariable name="PORT" value="%HTTP_PLATFORM_PORT%" />
        <environmentVariable name="NODE_ENV" value="production" />
      </environmentVariables>
    </httpPlatform>
    <httpErrors existingResponse="PassThrough" />
  </system.webServer>
</configuration>
'@
$webConfigPath = Join-Path $StagingDir "web.config"
[System.IO.File]::WriteAllText($webConfigPath, $webConfig)

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

Write-Step "Copying install script..."
$installDest = Join-Path $StagingDir "install"
New-Item -ItemType Directory -Path $installDest -Force | Out-Null
Copy-Item -Path (Join-Path $RepoRoot "deploy\setup-commit-resolver.ps1") -Destination $installDest -Force
Write-Success "Install script included in package"

Write-Step "Copying skill bundle..."
$skillSrc = Join-Path $RepoRoot "deploy\skills"
if (Test-Path $skillSrc) {
    Copy-Item -Path $skillSrc -Destination $installDest -Recurse -Force
    Write-Success "Skill bundle included in package (install/skills/)"
} else {
    Write-Host "  [WARN] deploy/skills not found - standalone installer won't be able to fetch the skill" -ForegroundColor Yellow
}

Write-Step "Updating package.json for App Service..."
# The api/package.json was already copied. Just ensure "type": "module" and start script are set.
# The dependencies from api/package.json are preserved so npm install works correctly.
$pkgPath = Join-Path $StagingDir "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.scripts.start = "node bootstrap.js"
if (-not $pkg.type) { $pkg | Add-Member -NotePropertyName "type" -NotePropertyValue "module" -Force }
$pkgJson = $pkg | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($pkgPath, $pkgJson)

Write-Step "Installing dependencies locally (Windows x64)..."
# Kudu's build system uses 32-bit Node which can't install LanceDB (requires x64).
# Install locally and ship node_modules in the zip instead.
Push-Location $StagingDir
try {
    # Ensure .npmrc points to public registry
    "registry=https://registry.npmjs.org/" | Set-Content -Encoding ASCII -Path (Join-Path $StagingDir ".npmrc")
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    npm install --omit=dev --registry https://registry.npmjs.org/ 2>&1 | Write-Host
    $ErrorActionPreference = $prevEAP
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    Write-Success "Dependencies installed (node_modules included in package)"
} finally { Pop-Location }

Write-Step "Normalizing native modules to server Node $ServerNodeVersion (ABI $ServerNodeAbi)..."
# The App Service runs Node $ServerNodeVersion. npm install above builds/keeps
# native binaries for the LOCAL Node version, which may differ (e.g. a prior
# `npm rebuild` under Node 22). Shipping a mismatched better_sqlite3.node causes
# an ERR_DLOPEN_FAILED crash loop on startup. Re-fetch the prebuilt binary for
# the server's runtime and verify its ABI tag before packaging.
$nativeModules = @('better-sqlite3')
foreach ($mod in $nativeModules) {
    $modDir = Join-Path $StagingDir "node_modules\$mod"
    if (-not (Test-Path $modDir)) {
        Write-Host "  [skip] $mod not present" -ForegroundColor DarkGray
        continue
    }
    Push-Location $modDir
    try {
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        npx --yes prebuild-install --runtime node --target $ServerNodeVersion --arch x64 --platform win32 --verbose 2>&1 | Write-Host
        $installExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
        if ($installExit -ne 0) {
            throw "prebuild-install failed for $mod (target Node $ServerNodeVersion). Cannot guarantee server ABI compatibility."
        }
        # Verify the fetched binary advertises the expected ABI tag in the cached prebuild name.
        $cachedDir = Join-Path $env:LOCALAPPDATA "npm-cache\_prebuilds"
        $abiHit = $false
        if (Test-Path $cachedDir) {
            $abiHit = (Get-ChildItem $cachedDir -Filter "*node-v$ServerNodeAbi-win32-x64*" -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
        }
        if (-not $abiHit) {
            Write-Host "  [warn] Could not confirm ABI v$ServerNodeAbi prebuild for $mod from cache name" -ForegroundColor Yellow
        }
        Write-Success "$mod normalized to Node $ServerNodeVersion (ABI $ServerNodeAbi)"
    } finally { Pop-Location }
}

Write-Step "Smoke-checking module import paths in package..."
# After the flat-layout copy + import rewrite, verify every relative import in
# the staged JS resolves to a file that actually exists inside the package.
# This catches deploy-only ERR_MODULE_NOT_FOUND breakage (e.g. an api/agents
# file importing ../../src that points outside the flattened web root) BEFORE
# it ships and crash-loops in prod.
$smokeScript = Join-Path $ScriptDir "check-imports.mjs"
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
node $smokeScript $StagingDir 2>&1 | Write-Host
$smokeExit = $LASTEXITCODE
$ErrorActionPreference = $prevEAP
if ($smokeExit -ne 0) {
    throw "Import smoke check failed — one or more relative imports do not resolve inside the package. Aborting before a broken deploy."
}
Write-Success "All relative imports resolve inside the package"

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
