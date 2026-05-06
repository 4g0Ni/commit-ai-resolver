<#
.SYNOPSIS
  Reset data and refresh commits on the deployed Commit AI Resolver service (Windows App Service).

.DESCRIPTION
  Interactive menu to:
  1. Refresh only - backfill missing commits (skips existing data)
  2. Reset partial - clear daily JSON + checkpoint only (preserves vector DB and feedback)
  3. Reset ALL - clear everything (daily JSON, vector DB, feedback/metrics, checkpoint, diffs)
  4. Reset ALL + Refresh - clear everything and backfill commits
  5. Rebuild embeddings - regenerate vector DB from existing daily JSON

  All operations run via Kudu API (bearer token from Azure CLI).

.PARAMETER AppName
  App Service name. Default: commit-ai-resolver-win

.PARAMETER ResourceGroup
  Resource group name. Default: commit-ai-resolver-rg

.PARAMETER Days
  Number of days to backfill when refreshing. Default: 90

.PARAMETER Mode
  Skip the interactive menu. Values: refresh-only, reset-partial, reset-all, reset-and-refresh, rebuild-embeddings

.EXAMPLE
  .\reset-remote.ps1
  # Interactive menu

.EXAMPLE
  .\reset-remote.ps1 -Mode refresh-only -Days 90
  # Backfill 90 days, skipping commits that already exist

.EXAMPLE
  .\reset-remote.ps1 -Mode reset-and-refresh -Days 90
  # Reset everything + backfill 90 days
#>

[CmdletBinding()]
param(
    [string]$AppName = "commit-ai-resolver-win",
    [string]$ResourceGroup = "commit-ai-resolver-rg",
    [int]$Days = 90,
    [ValidateSet("", "refresh-only", "reset-partial", "reset-all", "reset-and-refresh", "rebuild-embeddings")]
    [string]$Mode = ""
)

$ErrorActionPreference = "Stop"
$AppUrl = "https://$AppName.azurewebsites.net"
$KuduUrl = "https://$AppName.scm.azurewebsites.net"

function Write-Step([string]$msg) { Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-Success([string]$msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }

# ── Kudu credentials (cached per invocation) ──

$script:KuduHeaders = $null

function Get-KuduHeaders {
    if ($script:KuduHeaders) { return $script:KuduHeaders }

    Write-Step "Getting Kudu access token..."
    $tokenJson = az account get-access-token --resource "https://management.azure.com/" -o json
    if ($LASTEXITCODE -ne 0) { throw "Failed to get Azure token. Run 'az login' first." }
    $token = ($tokenJson | ConvertFrom-Json).accessToken

    $script:KuduHeaders = @{
        "Authorization" = "Bearer $token"
        "Content-Type"  = "application/json"
    }
    Write-Success "Kudu token acquired"
    return $script:KuduHeaders
}

function Invoke-KuduCommand([string]$command, [string]$dir = "D:\home\data", [int]$timeoutSec = 300) {
    $headers = Get-KuduHeaders
    $body = @{ command = $command; dir = $dir } | ConvertTo-Json

    Write-Host "  > $command" -ForegroundColor DarkGray
    $response = Invoke-RestMethod -Uri "$KuduUrl/api/command" -Method POST -Headers $headers -Body $body -TimeoutSec $timeoutSec
    if ($response.Output) { Write-Host $response.Output }
    if ($response.Error) { Write-Warn $response.Error }
    return $response
}

# ── Interactive menu ──

if (-not $Mode) {
    Write-Host ""
    Write-Host "=== Commit AI Resolver - Remote Data Management ===" -ForegroundColor Magenta
    Write-Host ""
    Write-Host "  Target: $AppUrl" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  1) Refresh only - backfill missing commits for the past $Days days"
    Write-Host "     (skips commits that already exist, preserves all data)"
    Write-Host ""
    Write-Host "  2) Reset partial - clear daily JSON files + checkpoint only"
    Write-Host "     (preserves vector DB, feedback, and usage metrics)"
    Write-Host ""
    Write-Host "  3) Reset ALL - clear everything (daily JSON, vector DB, feedback,"
    Write-Host "     DAU/MAU metrics, diffs cache, checkpoint)"
    Write-Host ""
    Write-Host "  4) Reset ALL + Refresh - clear everything and backfill commits"
    Write-Host "     from the past $Days days (use -Days to change)"
    Write-Host ""
    Write-Host "  5) Rebuild embeddings - regenerate vector DB from existing daily JSON"
    Write-Host "     (no ADO fetch, useful after vector store corruption or deletion)"
    Write-Host ""
    Write-Host "  Q) Quit"
    Write-Host ""

    $choice = Read-Host "Select an option (1/2/3/4/5/Q)"
    switch ($choice) {
        "1" { $Mode = "refresh-only" }
        "2" { $Mode = "reset-partial" }
        "3" { $Mode = "reset-all" }
        "4" { $Mode = "reset-and-refresh" }
        "5" { $Mode = "rebuild-embeddings" }
        "Q" { Write-Host "Cancelled."; exit 0 }
        "q" { Write-Host "Cancelled."; exit 0 }
        default { Write-Host "Invalid choice." -ForegroundColor Red; exit 1 }
    }
}

# ── Confirmation ──

$modeLabel = switch ($Mode) {
    "refresh-only"      { "Refresh only - backfill missing commits for $Days days" }
    "reset-partial"     { "Reset partial (daily JSON + checkpoint)" }
    "reset-all"         { "Reset ALL data (vector DB, feedback, metrics, etc.)" }
    "reset-and-refresh" { "Reset ALL data + backfill $Days days of commits" }
    "rebuild-embeddings" { "Rebuild vector embeddings from existing daily JSON" }
}

Write-Host ""
Write-Host "  Action:  $modeLabel" -ForegroundColor Yellow
Write-Host "  Target:  $AppUrl" -ForegroundColor Yellow
if ($Mode -in @("refresh-only", "reset-and-refresh")) {
    Write-Host "  Days:    $Days" -ForegroundColor Yellow
}
Write-Host ""
$confirm = Read-Host "Are you sure? (y/N)"
if ($confirm -notin @("y", "Y", "yes")) {
    Write-Host "Cancelled."
    exit 0
}

# ── Helper: run backfill in background on server ──

function Start-RemoteBackfill([string]$flags) {
    # Write a launcher script to the server, then execute it.
    $launcherContent = @"
@echo off
cd /D D:\home\site\wwwroot
start /B node scripts/reset-and-refresh.js --days $Days $flags > D:\home\data\backfill.log 2>&1
"@

    Write-Step "Writing launcher script to server..."
    $headers = Get-KuduHeaders

    # Upload via Kudu VFS API
    $uploadHeaders = @{
        "Authorization" = $headers["Authorization"]
        "Content-Type"  = "application/octet-stream"
        "If-Match"      = "*"
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($launcherContent)
    Invoke-RestMethod -Uri "$KuduUrl/api/vfs/data/run-backfill.cmd" -Method PUT -Headers $uploadHeaders -Body $bytes | Out-Null
    Write-Success "Launcher script uploaded."

    Write-Step "Starting backfill on server (background)..."
    Invoke-KuduCommand "D:\home\data\run-backfill.cmd" -dir "D:\home\site\wwwroot"

    Write-Host ""
    Write-Success "Backfill started in background on the server."
    Write-Host ""
    Write-Host "  Monitor progress:" -ForegroundColor Gray
    Write-Host "    az webapp log tail --name $AppName --resource-group $ResourceGroup" -ForegroundColor White
    Write-Host ""
    Write-Host "  Or check the log file via Kudu:" -ForegroundColor Gray
    Write-Host "    Browse to $KuduUrl/DebugConsole" -ForegroundColor White
    Write-Host "    type D:\home\data\backfill.log" -ForegroundColor White
}

# ── Execute ──

switch ($Mode) {
    "refresh-only" {
        Start-RemoteBackfill "--refresh-only"
    }

    "reset-partial" {
        Write-Step "Clearing daily JSON files..."
        Invoke-KuduCommand "del /s /q D:\home\data\daily\*.json"

        Write-Step "Clearing refresh checkpoint..."
        Invoke-KuduCommand "del /q D:\home\data\refresh-checkpoint.json"

        Write-Step "Verifying daily dir..."
        Invoke-KuduCommand "dir D:\home\data\daily\"

        Write-Step "Restarting App Service to clear in-memory caches..."
        az webapp restart --name $AppName --resource-group $ResourceGroup
        if ($LASTEXITCODE -ne 0) { throw "Failed to restart App Service" }
        Write-Success "Partial reset complete. Vector DB and feedback preserved."
    }

    "reset-all" {
        Write-Step "Stopping App Service to release file locks..."
        az webapp stop --name $AppName --resource-group $ResourceGroup
        if ($LASTEXITCODE -ne 0) { throw "Failed to stop App Service" }
        Write-Success "App Service stopped."

        Start-Sleep -Seconds 5

        Write-Step "Clearing all data..."
        Invoke-KuduCommand "if exist D:\home\data\daily rd /s /q D:\home\data\daily"
        Invoke-KuduCommand "if exist D:\home\data\vectors.db del /q D:\home\data\vectors.db*"
        Invoke-KuduCommand "if exist D:\home\data\diffs rd /s /q D:\home\data\diffs"
        Invoke-KuduCommand "if exist D:\home\data\refresh-checkpoint.json del /q D:\home\data\refresh-checkpoint.json"
        Invoke-KuduCommand "if exist D:\home\data\feedback.db del /q D:\home\data\feedback.db*"

        Write-Step "Recreating required directories..."
        Invoke-KuduCommand "mkdir D:\home\data\daily"

        Write-Step "Verifying..."
        Invoke-KuduCommand "dir D:\home\data\"

        Write-Step "Starting App Service..."
        az webapp start --name $AppName --resource-group $ResourceGroup
        if ($LASTEXITCODE -ne 0) { throw "Failed to start App Service" }
        Write-Success "Full reset complete. All data cleared. App Service started."
    }

    "reset-and-refresh" {
        Write-Step "Stopping App Service to release file locks..."
        az webapp stop --name $AppName --resource-group $ResourceGroup
        if ($LASTEXITCODE -ne 0) { throw "Failed to stop App Service" }
        Write-Success "App Service stopped."

        Start-Sleep -Seconds 5

        Write-Step "Clearing all data..."
        Invoke-KuduCommand "if exist D:\home\data\daily rd /s /q D:\home\data\daily"
        Invoke-KuduCommand "if exist D:\home\data\vectors.db del /q D:\home\data\vectors.db*"
        Invoke-KuduCommand "if exist D:\home\data\diffs rd /s /q D:\home\data\diffs"
        Invoke-KuduCommand "if exist D:\home\data\refresh-checkpoint.json del /q D:\home\data\refresh-checkpoint.json"
        Invoke-KuduCommand "if exist D:\home\data\feedback.db del /q D:\home\data\feedback.db*"

        Write-Step "Recreating required directories..."
        Invoke-KuduCommand "mkdir D:\home\data\daily"

        Write-Step "Starting App Service..."
        az webapp start --name $AppName --resource-group $ResourceGroup
        if ($LASTEXITCODE -ne 0) { throw "Failed to start App Service" }
        Write-Success "App Service started."

        Write-Host "  Waiting 15s for server to come up..." -ForegroundColor Gray
        Start-Sleep -Seconds 15

        Start-RemoteBackfill ""
    }

    "rebuild-embeddings" {
        Start-RemoteBackfill "--rebuild-embeddings"
    }
}

Write-Host ""
Write-Success "Done."
