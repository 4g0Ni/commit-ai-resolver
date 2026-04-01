param(
    [ValidateSet('int', 'onebox')]
    [string]$Env = "int",

    [switch]$SkipInstall,

    [switch]$SkipInit,

    [int]$WebpackPort = 3000,

    [int]$ProxyPort = 12000,

    [string]$RepoRoot,

    [string]$MainRepo
)

# Auto-detect RepoRoot from this script's location (script is at <repo>\tools\mcp-tools\launch-debug.ps1)
if (-not $RepoRoot) {
    $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}

# Auto-detect MainRepo using git (handles worktrees automatically)
if (-not $MainRepo) {
    try {
        # git worktree detection: .git file (not folder) means it's a worktree
        $dotGit = Join-Path $RepoRoot ".git"
        if (Test-Path $dotGit -PathType Leaf) {
            # It's a worktree - .git file contains "gitdir: <path>"
            # Use git to find the main working tree
            $MainRepo = (git -C $RepoRoot rev-parse --path-format=absolute --git-common-dir 2>$null) | Split-Path
        } else {
            # Not a worktree - main repo is the same as repo root
            $MainRepo = $RepoRoot
        }
    } catch {
        # Fallback: assume main repo is the same as repo root
        $MainRepo = $RepoRoot
    }
}

$gulpCmd = "gulp debug:$Env --fm --rspack --webpack-port $WebpackPort --proxy-port $ProxyPort"
$envDisplay = if ($Env -eq 'int') { "SI (int)" } else { "Onebox" }

# If RepoRoot is different from MainRepo, it's a worktree - run init in main repo first
$isWorktree = $RepoRoot -ne $MainRepo

$initCmd = if ($SkipInit) {
    "echo Skipping init.cmd..."
} elseif ($isWorktree) {
    # For worktrees: run init in main repo, then cd to worktree
    "echo [1/3] Running init.cmd in main repo... && cd /d $MainRepo && init.cmd && cd /d $RepoRoot"
} else {
    "echo [1/3] Running init.cmd... && init.cmd"
}

$installCmd = if ($SkipInstall) {
    "echo Skipping pnpm install..."
} else {
    "echo ======================================== && echo [2/3] Installing dependencies... && echo ======================================== && cd private && pnpm install && cd .."
}

$cmdScript = @"
cd /d $RepoRoot && echo ======================================== && echo Complete Debug Setup for $envDisplay && echo ======================================== && echo. && $initCmd && echo. && $installCmd && echo ======================================== && echo [3/3] Starting gulp debug server... && echo ======================================== && cd private\ui-next && $gulpCmd
"@

Write-Host "Launching debug environment for $envDisplay..." -ForegroundColor Cyan
Write-Host "This will open an admin command prompt window." -ForegroundColor Yellow
Write-Host ""

Start-Process cmd.exe -ArgumentList '/k', $cmdScript -Verb RunAs

Write-Host "Admin command prompt launched!" -ForegroundColor Green
Write-Host "Check your taskbar for the new window." -ForegroundColor Yellow
