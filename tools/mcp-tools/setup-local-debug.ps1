# =================================================================
# Debug Server Setup Script - setup-debug.ps1
# Usage: .\setup-debug.ps1 [int|onebox] [-RootPath <path>]
# Environment Variable: DEBUG_ROOT_PATH
# =================================================================

param(
    [ValidateSet('int', 'onebox')]
    [string]$DebugType = 'int',

    [string]$RootPath = $null
)

# Determine root path with priority: Parameter > Environment Variable > Current Directory
$rootPath = $RootPath
if (-not $rootPath) {
    $rootPath = (Get-Item $PSScriptRoot).Parent.Parent.FullName
}

if (-not $rootPath) {
    $rootPath = Get-Location
}

# Validate and set the root path
if (-not (Test-Path $rootPath)) {
    Write-Host "❌ Root path does not exist: $rootPath" -ForegroundColor Red
    exit 1
}

# Change to root directory
Set-Location $rootPath
$actualRootPath = Get-Location

# Set console title
$Host.UI.RawUI.WindowTitle = "Debug Server Setup - $DebugType"

Write-Host ""
Write-Host "🚀 Starting Debug Server Setup..." -ForegroundColor Green
Write-Host "Root Path: $actualRootPath" -ForegroundColor Cyan
Write-Host "Debug Type: $DebugType" -ForegroundColor Cyan
if ($env:DEBUG_ROOT_PATH) {
    Write-Host "Environment Variable DEBUG_ROOT_PATH: $env:DEBUG_ROOT_PATH" -ForegroundColor Gray
}
Write-Host ""

# Function to handle errors gracefully
function Handle-Error {
    param([string]$StepName, [string]$ErrorMessage)
    Write-Host "❌ $StepName Failed: $ErrorMessage" -ForegroundColor Red
    Write-Host "⚠️  Continuing anyway..." -ForegroundColor Yellow
}

# Step 1: Run init.ps1
Write-Host "📦 Step 1: Running init.ps1 to setup dependencies..." -ForegroundColor Yellow
if (Test-Path ".\init.ps1") {
    try {
        & ".\init.ps1"
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Step 1 Complete: init.ps1 executed successfully" -ForegroundColor Green
        } else {
            Handle-Error "Step 1" "init.ps1 execution failed with exit code $LASTEXITCODE"
        }
    } catch {
        Handle-Error "Step 1" $_.Exception.Message
    }
} else {
    Write-Host "❌ init.ps1 not found in current directory" -ForegroundColor Red
    Write-Host "Available .ps1 files:" -ForegroundColor Yellow
    Get-ChildItem -Name "*.ps1" | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    Write-Host "⚠️  Continuing anyway..." -ForegroundColor Yellow
}

Write-Host ""

# Step 2: Navigate to private folder and run pnpm install
Write-Host "📦 Step 2: Installing dependencies in private folder..." -ForegroundColor Yellow
if (Test-Path ".\private") {
    try {
        Set-Location ".\private"
        Write-Host "Changed directory to: $(Get-Location)" -ForegroundColor Cyan

        pnpm install
        if ($LASTEXITCODE -eq 0) {
            Write-Host "✅ Step 2 Complete: pnpm install executed successfully" -ForegroundColor Green
        } else {
            Handle-Error "Step 2" "pnpm install failed with exit code $LASTEXITCODE"
        }
    } catch {
        Handle-Error "Step 2" $_.Exception.Message
    }
} else {
    Write-Host "❌ Private folder not found" -ForegroundColor Red
    Write-Host "Available directories:" -ForegroundColor Yellow
    Get-ChildItem -Directory -Name | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    Write-Host "⚠️  Continuing anyway..." -ForegroundColor Yellow
}

Write-Host ""

# Step 3: Navigate to ui-next and run gulp debug
Write-Host "🔧 Step 3: Starting $DebugType debug server..." -ForegroundColor Yellow
if (Test-Path ".\ui-next") {
    try {
        Set-Location ".\ui-next"
        Write-Host "Changed directory to: $(Get-Location)" -ForegroundColor Cyan

        $gulpCommand = if ($DebugType -eq 'onebox') { 'gulp debug:onebox --fm' } else { 'gulp debug:int --fm' }
        Write-Host "Running: $gulpCommand" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "⏳ Waiting for webpack compilation to complete..." -ForegroundColor Yellow
        Write-Host "Look for 'webpack compiled' message to confirm setup is complete!" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "💡 Press Ctrl+C to stop the debug server when done." -ForegroundColor Magenta
        Write-Host ""

        # Run the gulp command
        Invoke-Expression $gulpCommand
    } catch {
        Write-Host "❌ Step 3 Error: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Try running the command manually: $gulpCommand" -ForegroundColor Yellow
    }
} else {
    Write-Host "❌ ui-next folder not found in private directory" -ForegroundColor Red
    Write-Host "Available directories:" -ForegroundColor Yellow
    Get-ChildItem -Directory -Name | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
    Write-Host ""
    Write-Host "❌ Cannot continue without ui-next folder" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "🎉 Setup process completed!" -ForegroundColor Green