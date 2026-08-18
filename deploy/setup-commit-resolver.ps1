<#
.SYNOPSIS
  Commit AI Resolver installer for GitHub Copilot CLI, Claude Code, Claude Desktop, and VS Code.

.DESCRIPTION
  Wires up the deployed Commit AI Resolver MCP server in:
    1. GitHub Copilot CLI (%USERPROFILE%\.copilot\mcp-config.json — primary)
    2. Claude Desktop  (%APPDATA%\Claude\claude_desktop_config.json)
    3. Claude Code CLI (%USERPROFILE%\.claude\mcp.json — global)
    4. Claude Code CLI (%USERPROFILE%\.claude.json projects.* — per-project overrides)
    4. VS Code         (%APPDATA%\Code\User\mcp.json, plus Insiders if present)
  Bundles the commit-resolver skill into both:
    - %USERPROFILE%\.copilot\skills\commit-resolver\  (Copilot CLI — primary)
    - %USERPROFILE%\.claude\skills\commit-resolver\   (Claude Code — transitional)
  When run from the repo's deploy/ directory, the skill is copied from disk;
  when run as a standalone download, the skill is fetched from the MCP server.

    The local /mcp endpoint is anonymous and binds to localhost by default.
    Start it with `node api/server.js` before running this installer.

  All file modifications are backed up under %USERPROFILE%\.commit-resolver-setup-state\.
  Run with -Uninstall to restore everything.

.PARAMETER McpUrl
    MCP server URL. Default: local API server.

.PARAMETER McpName
  MCP entry name used in client configs. Default: CommitResolver.

.PARAMETER Timeout
  Request timeout in seconds (Copilot CLI / Claude Desktop / Code CLI). Default: 600.

.PARAMETER SkipSkill
  Skip installing the skill bundle.

.PARAMETER SkipMcp
  Skip wiring up MCP configs.

.PARAMETER Uninstall
  Restore backed-up files and remove the skill directory.

.EXAMPLE
  .\setup-commit-resolver.ps1
    # Default install: local endpoint + skill into all supported clients

.EXAMPLE
  .\setup-commit-resolver.ps1 -McpUrl "http://localhost:4399/mcp"
  # Point at a local dev API server instead

.EXAMPLE
  .\setup-commit-resolver.ps1 -Uninstall
  # Restore everything to pre-install state
#>

[CmdletBinding()]
param(
    [string]$McpUrl = "http://127.0.0.1:4399/mcp",
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

# Skill is installed to BOTH Copilot CLI (primary) and Claude Code (transitional)
# locations so the same skill works regardless of which client the user is on.
# COPILOT_HOME env var, if set, overrides ~/.copilot per Copilot CLI docs.
$CopilotHome = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE ".copilot" }
$CopilotSkillsDir = Join-Path $CopilotHome "skills"
$CopilotSkillDestDir = Join-Path $CopilotSkillsDir "commit-resolver"
$CopilotMcpConfigPath = Join-Path $CopilotHome "mcp-config.json"

$SkillsDir = Join-Path $env:USERPROFILE ".claude\skills"
$SkillDestDir = Join-Path $SkillsDir "commit-resolver"

# All skill install destinations (Copilot CLI primary, Claude transitional).
$AllSkillDestDirs = @($CopilotSkillDestDir, $SkillDestDir)

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
    Write-Host "       MCP + Skill for Copilot CLI / Claude / VS Code           " -ForegroundColor Cyan
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

function Backup-SkillDirIfNeeded([string]$skillDestDir = $null) {
    # If no specific dir is provided, back up all known skill destinations.
    $targets = if ($skillDestDir) { @($skillDestDir) } else { $AllSkillDestDirs }

    $manifest = Load-Manifest
    if (-not $manifest.ContainsKey("skillDirs") -or $null -eq $manifest["skillDirs"]) {
        $manifest["skillDirs"] = @{}
    }
    $skillDirs = Ensure-Hashtable $manifest["skillDirs"]

    # Legacy: single-dir fields used by older installs; migrate into the map so
    # uninstall still finds the original Claude skill backup.
    if ($manifest.ContainsKey("skillDirExistedBefore") -and -not $skillDirs.ContainsKey((Get-PathHash $SkillDestDir))) {
        $legacyKey = Get-PathHash $SkillDestDir
        $skillDirs[$legacyKey] = @{
            path           = $SkillDestDir
            existedBefore  = [bool]$manifest["skillDirExistedBefore"]
            backupPath     = $manifest["skillDirBackupPath"]
        }
    }

    foreach ($dir in $targets) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        $key = Get-PathHash $dir
        if (-not $skillDirs.ContainsKey($key)) {
            $skillDirs[$key] = @{ path = $dir; existedBefore = (Test-Path $dir); backupPath = $null }
        }
        $rec = Ensure-Hashtable $skillDirs[$key]
        if ($rec["existedBefore"] -and (-not $rec["backupPath"])) {
            Ensure-Dir $BackupsRoot
            $backupDir = Join-Path $BackupsRoot ("skill_dir_" + $key)
            if (Test-Path $backupDir) { Remove-Item -Path $backupDir -Recurse -Force -ErrorAction SilentlyContinue }
            Copy-Item -Path $dir -Destination $backupDir -Recurse -Force
            $rec["backupPath"] = $backupDir
        }
        $skillDirs[$key] = $rec
    }

    $manifest["skillDirs"] = $skillDirs
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

    # Determine source: local skills/ dir, or pulled from server in standalone mode.
    $tempSource = $null
    $effectiveSource = $SkillSourceDir
    if (-not (Test-Path $SkillSourceDir)) {
        $skillBase = Get-SkillBaseUrl $McpUrl
        Write-Info "Skill source not on disk. Downloading from: $skillBase"
        try {
            $manifestUrl = "$skillBase/manifest.json"
            $manifestResp = Invoke-WebRequest -Uri $manifestUrl -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
            $manifest = $manifestResp.Content | ConvertFrom-Json
            $files = @($manifest.files)
            if ($files.Count -eq 0) { throw "Manifest had no files." }

            $tempSource = Join-Path ([System.IO.Path]::GetTempPath()) ("commit-resolver-skill-" + [Guid]::NewGuid().ToString("N"))
            Ensure-Dir $tempSource
            foreach ($f in $files) {
                $fileUrl = "$skillBase/$f"
                $destPath = Join-Path $tempSource $f
                Ensure-Dir (Split-Path -Parent $destPath)
                Invoke-WebRequest -Uri $fileUrl -UseBasicParsing -TimeoutSec 60 -OutFile $destPath -ErrorAction Stop
            }
            $effectiveSource = $tempSource
            Write-Info "Downloaded $($files.Count) file(s) to temp source."
        } catch {
            Write-Err "Could not download skill from $skillBase : $($_.Exception.Message)"
            Write-Err "If you cloned the repo, run this script from deploy/ instead."
            return $false
        }
    }

    try {
        $okCount = 0
        foreach ($dest in $AllSkillDestDirs) {
            try {
                Ensure-Dir (Split-Path -Parent $dest)
                if (Test-Path $dest) {
                    Remove-Item -Path $dest -Recurse -Force -ErrorAction SilentlyContinue
                }
                Copy-Item -Path $effectiveSource -Destination $dest -Recurse -Force
                Write-Success "Skill installed: $dest"
                $okCount++
            } catch {
                Write-Warn "Skill install to $dest failed: $($_.Exception.Message)"
            }
        }
        if ($okCount -eq 0) { return $false }
    } finally {
        if ($tempSource -and (Test-Path $tempSource)) {
            Remove-Item -Path $tempSource -Recurse -Force -ErrorAction SilentlyContinue
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

    # GitHub Copilot CLI (primary). Per Copilot CLI docs, config lives at
    # ~/.copilot/mcp-config.json (overridable via COPILOT_HOME). The on-disk
    # format uses the standard MCP `mcpServers` map shape.
    try {
        if (-not (Test-Path $CopilotMcpConfigPath)) {
            Ensure-Dir (Split-Path -Parent $CopilotMcpConfigPath)
            Write-JsonFile $CopilotMcpConfigPath @{ mcpServers = @{} }
        }
        Upsert-McpServersRoot $CopilotMcpConfigPath
    } catch {
        Write-Warn "Copilot CLI config: $($_.Exception.Message)"
        $allOk = $false
    }

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
                Write-Success "MCP endpoint reachable; initialize returned serverInfo"
                return $true
            } else {
                Write-Warn "MCP endpoint returned HTTP $($resp.StatusCode); response did not include serverInfo"
                return $false
            }
        } catch [System.Net.WebException] { throw }
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

    # New format: a map of skill dirs.
    if ($manifest.ContainsKey("skillDirs") -and $null -ne $manifest["skillDirs"]) {
        $skillDirs = Ensure-Hashtable $manifest["skillDirs"]
        foreach ($entry in $skillDirs.GetEnumerator()) {
            $rec = Ensure-Hashtable $entry.Value
            $path = $rec["path"]
            if ([string]::IsNullOrWhiteSpace($path)) { continue }
            $existedBefore = [bool]$rec["existedBefore"]
            $backupPath = $rec["backupPath"]
            if (Test-Path $path) {
                Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
            }
            if ($existedBefore -and $backupPath -and (Test-Path $backupPath)) {
                Copy-Item -Path $backupPath -Destination $path -Recurse -Force
                Write-Success "Restored skill directory: $path"
            } else {
                Write-Success "Removed skill directory: $path"
            }
        }
        return
    }

    # Legacy format: single Claude dir.
    $existedBefore = [bool]$manifest["skillDirExistedBefore"]
    $backupPath = $manifest["skillDirBackupPath"]
    if (Test-Path $SkillDestDir) {
        Remove-Item -Path $SkillDestDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($existedBefore -and $backupPath -and (Test-Path $backupPath)) {
        Copy-Item -Path $backupPath -Destination $SkillDestDir -Recurse -Force
        Write-Success "Restored skill directory: $SkillDestDir"
    } else {
        Write-Success "Removed skill directory: $SkillDestDir"
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
    Write-Warn "Restart Copilot CLI, Claude Desktop, VS Code, and any running Claude Code sessions."
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
    Write-Info "Skill dest: $CopilotSkillDestDir (Copilot CLI)"
    Write-Info "            $SkillDestDir (Claude - transitional)"
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
        Write-Host "  $status Skill:           $CopilotSkillDestDir" -ForegroundColor $color
        Write-Host "                       + $SkillDestDir" -ForegroundColor $color
    }
    if (-not $SkipMcp) {
        $status = if ($results.Mcp) { "[OK]" } else { "[WARN]" }
        $color  = if ($results.Mcp) { "Green" } else { "Yellow" }
        Write-Host "  $status MCP wiring:      Copilot CLI / Claude Desktop / Code CLI / VS Code" -ForegroundColor $color
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
    Write-Host "  1. Restart Copilot CLI, Claude Desktop, VS Code, and any open Claude Code sessions." -ForegroundColor Gray
    Write-Host "  2. In Copilot CLI run /skills reload then /skills info commit-resolver to verify." -ForegroundColor Gray
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
