<#
.SYNOPSIS
  Commit AI Resolver installer for Claude Code, Claude Desktop, and VS Code.

.DESCRIPTION
  Wires up the deployed Commit AI Resolver MCP server in:
    1. Claude Desktop  (%APPDATA%\Claude\claude_desktop_config.json)
    2. Claude Code CLI (%USERPROFILE%\.claude\mcp.json — global)
    3. Claude Code CLI (%USERPROFILE%\.claude.json projects.* — per-project overrides)
    4. VS Code         (%APPDATA%\Code\User\mcp.json, plus Insiders if present)
  Bundles the commit-resolver skill into %USERPROFILE%\.claude\skills\commit-resolver\.
  When run from the repo's deploy/ directory, the skill is copied from disk;
  when run as a standalone download, the skill is fetched from the MCP server.

  The deployed /mcp endpoint requires Microsoft Entra ID sign-in (OAuth 2.1, per MCP auth spec).
  On first connect, your MCP client opens a browser for corporate sign-in and caches the token.
  For local dev without OAuth, run `node api/server.js --no-auth` and pass -McpUrl http://localhost:4399/mcp.

  All file modifications are backed up under %USERPROFILE%\.commit-resolver-setup-state\.
  Run with -Uninstall to restore everything.

.PARAMETER McpUrl
  MCP server URL. Default: deployed Azure App Service.

.PARAMETER McpName
  MCP entry name used in client configs. Default: CommitResolver.

.PARAMETER Timeout
  Request timeout in seconds (Claude Desktop / Code CLI). Default: 600.

.PARAMETER SkipSkill
  Skip installing the skill bundle.

.PARAMETER SkipMcp
  Skip wiring up MCP configs.

.PARAMETER Uninstall
  Restore backed-up files and remove the skill directory.

.EXAMPLE
  .\setup-commit-resolver.ps1
  # Default install: deployed endpoint + skill into all three clients

.EXAMPLE
  .\setup-commit-resolver.ps1 -McpUrl "http://localhost:4399/mcp"
  # Point at a local dev API server instead

.EXAMPLE
  .\setup-commit-resolver.ps1 -Uninstall
  # Restore everything to pre-install state
#>

[CmdletBinding()]
param(
    [string]$McpUrl = "https://commit-ai-resolver-win.azurewebsites.net/mcp",
    [string]$McpName = "CommitResolver",
    [int]$Timeout = 600,
    [switch]$SkipSkill = $false,
    [switch]$SkipMcp = $false,
    [switch]$Uninstall = $false
)

$ErrorActionPreference = "Stop"
$script:ExitCode = 0
$script:Warnings = @()
$script:ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

$Version = "1.0.0"
$SkillSourceDir = Join-Path $script:ScriptDir "skills\commit-resolver"
$SkillsDir = Join-Path $env:USERPROFILE ".claude\skills"
$SkillDestDir = Join-Path $SkillsDir "commit-resolver"

$StateRoot = Join-Path $env:USERPROFILE ".commit-resolver-setup-state"
$BackupsRoot = Join-Path $StateRoot "backups"
$ManifestPath = Join-Path $StateRoot "manifest.json"

# ===============================
# Logging
# ===============================

function Write-Step([string]$msg)    { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Success([string]$msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg)    { Write-Host "  [WARN] $msg" -ForegroundColor Yellow; $script:Warnings += $msg }
function Write-Err([string]$msg)     { Write-Host "  [ERR] $msg" -ForegroundColor Red }
function Write-Info([string]$msg)    { Write-Host "  $msg" -ForegroundColor Gray }

function Show-Banner {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "       Commit AI Resolver Installer v$Version                    " -ForegroundColor Cyan
    Write-Host "       MCP + Skill for Claude Desktop / Code / VS Code          " -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""
}

# ===============================
# Helpers
# ===============================

function Ensure-Dir([string]$p) {
    if (-not [string]::IsNullOrWhiteSpace($p) -and -not (Test-Path $p)) {
        New-Item -ItemType Directory -Path $p -Force | Out-Null
    }
}

function Read-JsonFile([string]$path) {
    if (-not (Test-Path $path)) { return $null }
    $raw = Get-Content $path -Raw -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    try { return ($raw | ConvertFrom-Json -ErrorAction Stop) }
    catch { throw "Invalid JSON in $path : $($_.Exception.Message)" }
}

function Ensure-Hashtable($obj) {
    if ($null -eq $obj) { return @{} }
    if ($obj -is [hashtable]) { return $obj }
    $ht = @{}
    $obj.PSObject.Properties | ForEach-Object {
        $name = $_.Name
        $val = $_.Value
        if ($val -is [System.Management.Automation.PSCustomObject]) {
            $ht[$name] = Ensure-Hashtable $val
        } elseif ($val -is [System.Object[]]) {
            $arr = @()
            foreach ($i in $val) {
                if ($i -is [System.Management.Automation.PSCustomObject]) { $arr += , (Ensure-Hashtable $i) }
                else { $arr += , $i }
            }
            $ht[$name] = $arr
        } else {
            $ht[$name] = $val
        }
    }
    return $ht
}

function Write-JsonFile([string]$path, $obj) {
    Ensure-Dir (Split-Path -Parent $path)
    $json = $obj | ConvertTo-Json -Depth 100
    $json = $json -replace "`r?`n", "`r`n"
    $json | Set-Content -Encoding UTF8 -Path $path
}

function Get-PathHash([string]$path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($path.ToLowerInvariant())
        $hashBytes = $sha.ComputeHash($bytes)
        return ([BitConverter]::ToString($hashBytes) -replace "-", "").ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Get-SkillBaseUrl([string]$mcpUrl) {
    # The skill files live at <origin>/install/skills/commit-resolver on the
    # same server that hosts the MCP endpoint. Derive the origin from $McpUrl.
    try {
        $u = [Uri]$mcpUrl
        $origin = "$($u.Scheme)://$($u.Authority)"
    } catch {
        throw "Invalid MCP URL: $mcpUrl"
    }
    return "$origin/install/skills/commit-resolver"
}

# ===============================
# Manifest (backup/restore state)
# ===============================

function New-EmptyManifest {
    return @{
        version              = 1
        createdAtUtc         = [DateTime]::UtcNow.ToString("o")
        installedComponents  = @()
        files                = @{}
        skillDirExistedBefore = $false
        skillDirBackupPath    = $null
    }
}

function Load-Manifest {
    $obj = Read-JsonFile $ManifestPath
    if ($null -eq $obj) { return (New-EmptyManifest) }
    return (Ensure-Hashtable $obj)
}

function Save-Manifest($manifest) {
    Ensure-Dir $StateRoot
    Ensure-Dir $BackupsRoot
    Write-JsonFile $ManifestPath $manifest
}

function Backup-FileIfNeeded([string]$path) {
    $manifest = Load-Manifest
    if (-not $manifest.ContainsKey("files") -or $null -eq $manifest["files"]) { $manifest["files"] = @{} }
    $files = Ensure-Hashtable $manifest["files"]
    $key = Get-PathHash $path
    if ($files.ContainsKey($key)) { return }

    Ensure-Dir $BackupsRoot
    $record = @{ path = $path; existedBefore = (Test-Path $path); backupPath = $null }
    if (Test-Path $path) {
        $backupPath = Join-Path $BackupsRoot ($key + ".bak")
        Copy-Item $path $backupPath -Force
        $record["backupPath"] = $backupPath
    }
    $files[$key] = $record
    $manifest["files"] = $files
    Save-Manifest $manifest
}

function Backup-SkillDirIfNeeded {
    $manifest = Load-Manifest
    if (-not $manifest.ContainsKey("skillDirExistedBefore")) {
        $manifest["skillDirExistedBefore"] = (Test-Path $SkillDestDir)
    }
    if ($manifest["skillDirExistedBefore"] -and (-not $manifest["skillDirBackupPath"])) {
        Ensure-Dir $BackupsRoot
        $backupDir = Join-Path $BackupsRoot "skill_dir_backup"
        if (Test-Path $backupDir) { Remove-Item -Path $backupDir -Recurse -Force -ErrorAction SilentlyContinue }
        Copy-Item -Path $SkillDestDir -Destination $backupDir -Recurse -Force
        $manifest["skillDirBackupPath"] = $backupDir
    }
    Save-Manifest $manifest
}

# ===============================
# MCP Configuration
# ===============================

function Upsert-McpServersRoot([string]$path) {
    Backup-FileIfNeeded $path
    $obj = Read-JsonFile $path
    if ($null -eq $obj) { $obj = @{} }
    $ht = Ensure-Hashtable $obj

    if (-not $ht.ContainsKey("mcpServers") -or $null -eq $ht["mcpServers"]) { $ht["mcpServers"] = @{} }
    $servers = Ensure-Hashtable $ht["mcpServers"]
    $existing = @{}
    if ($servers.ContainsKey($McpName)) { $existing = Ensure-Hashtable $servers[$McpName] }

    $existing["url"] = $McpUrl
    $existing["timeout"] = $Timeout
    $existing["autoStart"] = $true

    $servers[$McpName] = $existing
    $ht["mcpServers"] = $servers
    Write-JsonFile $path $ht
    Write-Success "Configured MCP: $path"
}

function Upsert-ClaudeJsonProjects([string]$path) {
    # Claude Code CLI stores per-project MCP server configs in ~/.claude.json under
    # projects.<absolute-path>.mcpServers.<name>. Per-project entries OVERRIDE the
    # global ~/.claude/mcp.json when working inside that directory, so projects
    # listed there must also receive the CommitResolver entry to keep behavior
    # consistent across `cd` boundaries.
    if (-not (Test-Path $path)) { return 0 }
    Backup-FileIfNeeded $path
    $obj = Read-JsonFile $path
    if ($null -eq $obj) { return 0 }
    $ht = Ensure-Hashtable $obj

    if (-not $ht.ContainsKey("projects") -or $null -eq $ht["projects"]) { return 0 }
    $projects = Ensure-Hashtable $ht["projects"]
    if ($projects.Count -eq 0) { return 0 }

    $updated = 0
    foreach ($projKey in @($projects.Keys)) {
        $project = Ensure-Hashtable $projects[$projKey]
        if (-not $project.ContainsKey("mcpServers") -or $null -eq $project["mcpServers"]) {
            $project["mcpServers"] = @{}
        }
        $servers = Ensure-Hashtable $project["mcpServers"]
        $existing = @{}
        if ($servers.ContainsKey($McpName)) { $existing = Ensure-Hashtable $servers[$McpName] }
        $existing["type"] = "http"
        $existing["url"] = $McpUrl
        $servers[$McpName] = $existing
        $project["mcpServers"] = $servers
        $projects[$projKey] = $project
        $updated++
    }
    $ht["projects"] = $projects
    Write-JsonFile $path $ht
    return $updated
}

function Upsert-VSCodeMcpServers([string]$path) {
    Backup-FileIfNeeded $path
    $obj = Read-JsonFile $path
    if ($null -eq $obj) { $obj = @{} }
    $ht = Ensure-Hashtable $obj

    if (-not $ht.ContainsKey("servers") -or $null -eq $ht["servers"]) { $ht["servers"] = @{} }
    $servers = Ensure-Hashtable $ht["servers"]
    $existing = @{}
    if ($servers.ContainsKey($McpName)) { $existing = Ensure-Hashtable $servers[$McpName] }

    $existing["type"] = "http"
    $existing["url"] = $McpUrl
    $existing["autoStart"] = $true
    if ($existing.ContainsKey("timeout")) { $null = $existing.Remove("timeout") }

    $servers[$McpName] = $existing
    $ht["servers"] = $servers
    Write-JsonFile $path $ht
    Write-Success "Configured VS Code MCP: $path"
}

# ===============================
# Components
# ===============================

function Install-Skill {
    Write-Step "Installing commit-resolver skill..."

    Backup-SkillDirIfNeeded
    Ensure-Dir $SkillsDir

    if (Test-Path $SkillDestDir) {
        Remove-Item -Path $SkillDestDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path $SkillSourceDir) {
        Copy-Item -Path $SkillSourceDir -Destination $SkillDestDir -Recurse -Force
        Write-Success "Skill installed from local source: $SkillDestDir"
    } else {
        # Standalone install path: the script was downloaded from /install/, so
        # the skill files aren't on disk. Pull them down from the same server
        # that hosts $McpUrl.
        $skillBase = Get-SkillBaseUrl $McpUrl
        Write-Info "Skill source not on disk. Downloading from: $skillBase"
        try {
            $manifestUrl = "$skillBase/manifest.json"
            $manifestResp = Invoke-WebRequest -Uri $manifestUrl -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
            $manifest = $manifestResp.Content | ConvertFrom-Json
            $files = @($manifest.files)
            if ($files.Count -eq 0) { throw "Manifest had no files." }

            Ensure-Dir $SkillDestDir
            foreach ($f in $files) {
                $fileUrl = "$skillBase/$f"
                $destPath = Join-Path $SkillDestDir $f
                Ensure-Dir (Split-Path -Parent $destPath)
                Invoke-WebRequest -Uri $fileUrl -UseBasicParsing -TimeoutSec 60 -OutFile $destPath -ErrorAction Stop
            }
            Write-Success "Skill installed from server: $SkillDestDir ($($files.Count) file(s))"
        } catch {
            Write-Err "Could not download skill from $skillBase : $($_.Exception.Message)"
            Write-Err "If you cloned the repo, run this script from deploy/ instead."
            return $false
        }
    }

    $manifest = Load-Manifest
    if ($manifest["installedComponents"] -notcontains "Skill") { $manifest["installedComponents"] += "Skill" }
    Save-Manifest $manifest
    return $true
}

function Install-McpConfigs {
    Write-Step "Configuring MCP clients..."

    $allOk = $true

    # Claude Desktop
    $claudeDesktopPath = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
    try {
        if (-not (Test-Path $claudeDesktopPath)) {
            Ensure-Dir (Split-Path -Parent $claudeDesktopPath)
            Write-JsonFile $claudeDesktopPath @{ mcpServers = @{} }
        }
        Upsert-McpServersRoot $claudeDesktopPath
    } catch {
        Write-Warn "Claude Desktop config: $($_.Exception.Message)"
        $allOk = $false
    }

    # Claude Code CLI
    $claudeCliMcpPath = Join-Path $env:USERPROFILE ".claude\mcp.json"
    try {
        if (-not (Test-Path $claudeCliMcpPath)) {
            Ensure-Dir (Split-Path -Parent $claudeCliMcpPath)
            Write-JsonFile $claudeCliMcpPath @{ mcpServers = @{} }
        }
        Upsert-McpServersRoot $claudeCliMcpPath
    } catch {
        Write-Warn "Claude Code CLI config: $($_.Exception.Message)"
        $allOk = $false
    }

    # Claude Code CLI per-project overrides (~/.claude.json projects map)
    $claudeJsonPath = Join-Path $env:USERPROFILE ".claude.json"
    try {
        $count = Upsert-ClaudeJsonProjects $claudeJsonPath
        if ($count -gt 0) { Write-Success "Updated $count per-project entries in $claudeJsonPath" }
    } catch {
        Write-Warn "Claude Code per-project config: $($_.Exception.Message)"
        $allOk = $false
    }

    # VS Code (stable + Insiders if present)
    $vsCodeUserPaths = @(
        (Join-Path $env:APPDATA "Code\User\mcp.json"),
        (Join-Path $env:APPDATA "Code - Insiders\User\mcp.json")
    ) | Sort-Object -Unique
    foreach ($p in $vsCodeUserPaths) {
        try {
            Ensure-Dir (Split-Path -Parent $p)
            if (-not (Test-Path $p)) { Write-JsonFile $p @{ servers = @{} } }
            Upsert-VSCodeMcpServers $p
        } catch {
            Write-Warn "VS Code config $p : $($_.Exception.Message)"
            $allOk = $false
        }
    }

    if ($allOk) {
        $manifest = Load-Manifest
        if ($manifest["installedComponents"] -notcontains "MCP") { $manifest["installedComponents"] += "MCP" }
        Save-Manifest $manifest
    }
    return $allOk
}

# ===============================
# Connectivity check
# ===============================

function Test-McpReachable {
    Write-Step "Testing MCP endpoint reachability..."
    Write-Info "URL: $McpUrl"
    try {
        $body = @{
            jsonrpc = "2.0"
            id = 1
            method = "initialize"
            params = @{
                protocolVersion = "2024-11-05"
                capabilities = @{}
                clientInfo = @{ name = "setup-commit-resolver"; version = $Version }
            }
        } | ConvertTo-Json -Compress -Depth 10

        $headers = @{
            "Content-Type" = "application/json"
            "Accept"       = "application/json, text/event-stream"
        }
        try {
            $resp = Invoke-WebRequest -Uri $McpUrl -Method POST -Headers $headers -Body $body -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop

            if ($resp.StatusCode -eq 200 -and $resp.Content -match '"serverInfo"') {
                Write-Success "MCP endpoint reachable (no-auth mode); initialize returned serverInfo"
                return $true
            } else {
                Write-Warn "MCP endpoint returned HTTP $($resp.StatusCode); response did not include serverInfo"
                return $false
            }
        } catch [System.Net.WebException] {
            $resp = $_.Exception.Response
            if ($null -ne $resp -and [int]$resp.StatusCode -eq 401) {
                $wwwAuth = $resp.Headers["WWW-Authenticate"]
                if ($wwwAuth -and $wwwAuth -match 'resource_metadata="([^"]+)"') {
                    Write-Success "MCP endpoint reachable (auth mode); discovery URL: $($matches[1])"
                    Write-Info "Sign-in will happen on first use from your MCP client."
                    return $true
                }
                Write-Warn "MCP endpoint returned 401 without a discovery (resource_metadata) header"
                return $false
            }
            throw
        }
    } catch {
        Write-Warn "MCP endpoint unreachable from this machine: $($_.Exception.Message)"
        Write-Info "The skill will still install. Check VPN / network and try again later."
        return $false
    }
}

# ===============================
# Uninstall
# ===============================

function Restore-BackedUpFiles {
    $manifest = Load-Manifest
    if (-not $manifest.ContainsKey("files") -or $null -eq $manifest["files"]) { return }
    $files = Ensure-Hashtable $manifest["files"]
    foreach ($entry in $files.GetEnumerator()) {
        $record = Ensure-Hashtable $entry.Value
        $path = $record["path"]
        $existedBefore = [bool]$record["existedBefore"]
        $backupPath = $record["backupPath"]
        try {
            if ($existedBefore) {
                if ($backupPath -and (Test-Path $backupPath)) {
                    Ensure-Dir (Split-Path -Parent $path)
                    Copy-Item $backupPath $path -Force
                    Write-Success "Restored: $path"
                } else {
                    Write-Warn "Backup missing for: $path"
                }
            } else {
                if (Test-Path $path) {
                    Remove-Item $path -Force -ErrorAction SilentlyContinue
                    Write-Success "Removed: $path"
                }
            }
        } catch {
            Write-Warn "Failed to restore $path : $($_.Exception.Message)"
        }
    }
}

function Restore-SkillDir {
    $manifest = Load-Manifest
    $existedBefore = [bool]$manifest["skillDirExistedBefore"]
    $backupPath = $manifest["skillDirBackupPath"]

    if (Test-Path $SkillDestDir) {
        Remove-Item -Path $SkillDestDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($existedBefore -and $backupPath -and (Test-Path $backupPath)) {
        Copy-Item -Path $backupPath -Destination $SkillDestDir -Recurse -Force
        Write-Success "Restored skill directory"
    } else {
        Write-Success "Removed skill directory"
    }
}

function Cleanup-State {
    if (Test-Path $StateRoot) {
        Remove-Item -Path $StateRoot -Recurse -Force -ErrorAction SilentlyContinue
        Write-Success "Removed setup state"
    }
}

function Invoke-Uninstall {
    Write-Step "Uninstalling Commit AI Resolver..."
    Write-Host ""
    if (-not (Test-Path $ManifestPath)) {
        Write-Warn "No manifest found at $ManifestPath. Nothing to restore."
        return
    }
    Restore-BackedUpFiles
    Restore-SkillDir
    Cleanup-State
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host "                     Uninstall Complete                         " -ForegroundColor Green
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Warn "Restart Claude Desktop, VS Code, and any running Claude Code sessions."
}

# ===============================
# Main
# ===============================

function Main {
    Show-Banner

    if ($Uninstall) {
        Invoke-Uninstall
        return
    }

    Write-Info "MCP URL:    $McpUrl"
    Write-Info "MCP name:   $McpName"
    Write-Info "Skill src:  $SkillSourceDir"
    Write-Info "Skill dest: $SkillDestDir"
    Write-Host ""

    Ensure-Dir $StateRoot
    Save-Manifest (Load-Manifest)

    $results = @{ Skill = $true; Mcp = $true; Reachable = $true }

    if (-not $SkipSkill) {
        $results.Skill = Install-Skill
        Write-Host ""
    }

    if (-not $SkipMcp) {
        $results.Mcp = Install-McpConfigs
        Write-Host ""
    }

    $results.Reachable = Test-McpReachable
    Write-Host ""

    Write-Host "================================================================" -ForegroundColor Green
    Write-Host "                    Installation Summary                        " -ForegroundColor Green
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host ""

    if (-not $SkipSkill) {
        $status = if ($results.Skill) { "[OK]" } else { "[FAIL]" }
        $color  = if ($results.Skill) { "Green" } else { "Red" }
        Write-Host "  $status Skill:           $SkillDestDir" -ForegroundColor $color
    }
    if (-not $SkipMcp) {
        $status = if ($results.Mcp) { "[OK]" } else { "[WARN]" }
        $color  = if ($results.Mcp) { "Green" } else { "Yellow" }
        Write-Host "  $status MCP wiring:      Claude Desktop / Code CLI / VS Code" -ForegroundColor $color
    }
    $rstatus = if ($results.Reachable) { "[OK]" } else { "[WARN]" }
    $rcolor  = if ($results.Reachable) { "Green" } else { "Yellow" }
    Write-Host "  $rstatus Reachability:    $McpUrl" -ForegroundColor $rcolor
    Write-Host ""

    if ($script:Warnings.Count -gt 0) {
        Write-Host "Warnings:" -ForegroundColor Yellow
        foreach ($w in $script:Warnings) { Write-Host "  [!] $w" -ForegroundColor Yellow }
        Write-Host ""
    }

    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Restart Claude Desktop, VS Code, and any open Claude Code sessions." -ForegroundColor Gray
    Write-Host "  2. In Claude Code, invoke the skill with /commit-resolver" -ForegroundColor Gray
    Write-Host "  3. Or just ask: 'what changed in CMUI yesterday?'" -ForegroundColor Gray
    Write-Host ""

    if ((-not $SkipSkill -and -not $results.Skill) -or (-not $SkipMcp -and -not $results.Mcp)) {
        $script:ExitCode = 1
    }
}

try {
    Main
} catch {
    Write-Host ""
    Write-Err "Setup failed: $($_.Exception.Message)"
    Write-Host ""
    $script:ExitCode = 1
}

exit $script:ExitCode
