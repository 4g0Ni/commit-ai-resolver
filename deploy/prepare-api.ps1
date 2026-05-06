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
                  arguments="server.js"
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

Write-Step "Updating package.json for App Service..."
# The api/package.json was already copied. Just ensure "type": "module" and start script are set.
# The dependencies from api/package.json are preserved so npm install works correctly.
$pkgPath = Join-Path $StagingDir "package.json"
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
$pkg.scripts.start = "node server.js"
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
