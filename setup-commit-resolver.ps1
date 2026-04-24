<#
.SYNOPSIS
  Commit AI Resolver Setup — MCP + Skill Configuration for Claude Code

.DESCRIPTION
  This script installs:
  1. MCP server configuration for Claude Code, Claude Desktop, and VS Code
  2. Commit Resolver skill for Claude Code

  No Azure auth or binary downloads required — this only configures JSON files
  and copies the skill definition.

.PARAMETER McpUrl
  URL of the Commit AI Resolver MCP endpoint. Default: http://localhost:4399/mcp

.PARAMETER ProjectPath
  Project directory path (forward slashes, e.g. "C:/Users/you/my-project").
  Used for Claude Code project-level MCP config in ~/.claude.json.
  Default: auto-detected from script location.

.PARAMETER Timeout
  MCP request timeout in seconds. Default: 120

.PARAMETER Uninstall
  Remove all Commit Resolver configuration. Default: false

.EXAMPLE
  .\setup-commit-resolver.ps1
  # Configures MCP + installs skill (localhost)

.EXAMPLE
  .\setup-commit-resolver.ps1 -McpUrl "https://my-deployed-host.com/mcp"
  # Configures with a deployed endpoint

.EXAMPLE
  .\setup-commit-resolver.ps1 -Uninstall
  # Removes all configuration

.NOTES
  Version: 1.0.0
  Requires: PowerShell 5.1+
#>

[CmdletBinding()]
param(
    [string]$McpUrl = "http://localhost:4399/mcp",
    [int]$Timeout = 120,
    [string]$ProjectPath,
    [switch]$Uninstall = $false
)

$ErrorActionPreference = "Stop"
$McpName = "CommitResolver"
$SkillName = "commit-resolver"
$Version = "1.0.0"

# Capture script directory
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot }
elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path }
else { Get-Location }

# ===============================
# Helpers
# ===============================

function Write-Step([string]$msg) { Write-Host "[*] $msg" -ForegroundColor Cyan }
function Write-Success([string]$msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Err([string]$msg) { Write-Host "  [ERR] $msg" -ForegroundColor Red }

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
        }
        elseif ($val -is [System.Object[]]) {
            $arr = @()
            foreach ($i in $val) {
                if ($i -is [System.Management.Automation.PSCustomObject]) { $arr += , (Ensure-Hashtable $i) }
                else { $arr += , $i }
            }
            $ht[$name] = $arr
        }
        else { $ht[$name] = $val }
    }
    return $ht
}

function Write-JsonFile([string]$path, $obj) {
    Ensure-Dir (Split-Path -Parent $path)
    $json = $obj | ConvertTo-Json -Depth 100
    $json = $json -replace "`r?`n", "`r`n"
    $json | Set-Content -Encoding UTF8 -Path $path
}

# ===============================
# MCP Config
# ===============================

function Upsert-ClaudeMcp([string]$path) {
    $obj = Read-JsonFile $path
    if ($null -eq $obj) { $obj = @{} }
    $ht = Ensure-Hashtable $obj

    if (-not $ht.ContainsKey("mcpServers") -or $null -eq $ht["mcpServers"]) {
        $ht["mcpServers"] = @{}
    }
    $servers = Ensure-Hashtable $ht["mcpServers"]
    $servers[$McpName] = @{
        url     = $McpUrl
        timeout = $Timeout
    }
    $ht["mcpServers"] = $servers
    Write-JsonFile $path $ht
    Write-Success "Configured MCP: $path"
}

function Upsert-ClaudeCodeProjectMcp([string]$path, [string]$projectPath) {
    $obj = Read-JsonFile $path
    if ($null -eq $obj) { $obj = @{} }
    $ht = Ensure-Hashtable $obj

    if (-not $ht.ContainsKey("projects") -or $null -eq $ht["projects"]) {
        $ht["projects"] = @{}
    }
    $projects = Ensure-Hashtable $ht["projects"]

    if (-not $projects.ContainsKey($projectPath) -or $null -eq $projects[$projectPath]) {
        $projects[$projectPath] = @{}
    }
    $proj = Ensure-Hashtable $projects[$projectPath]

    if (-not $proj.ContainsKey("mcpServers") -or $null -eq $proj["mcpServers"]) {
        $proj["mcpServers"] = @{}
    }
    $servers = Ensure-Hashtable $proj["mcpServers"]
    $servers[$McpName] = @{
        type = "http"
        url  = $McpUrl
    }
    $proj["mcpServers"] = $servers
    $projects[$projectPath] = $proj
    $ht["projects"] = $projects
    Write-JsonFile $path $ht
    Write-Success "Configured Claude Code project MCP: $path (project: $projectPath)"
}

function Remove-ClaudeCodeProjectMcp([string]$path, [string]$projectPath, [string]$serverKey) {
    if (-not (Test-Path $path)) { return }
    $obj = Read-JsonFile $path
    if ($null -eq $obj) { return }
    $ht = Ensure-Hashtable $obj

    if (-not $ht.ContainsKey("projects")) { return }
    $projects = Ensure-Hashtable $ht["projects"]
    if (-not $projects.ContainsKey($projectPath)) { return }
    $proj = Ensure-Hashtable $projects[$projectPath]
    if (-not $proj.ContainsKey("mcpServers")) { return }
    $servers = Ensure-Hashtable $proj["mcpServers"]
    if ($servers.ContainsKey($serverKey)) {
        $servers.Remove($serverKey)
        $proj["mcpServers"] = $servers
        $projects[$projectPath] = $proj
        $ht["projects"] = $projects
        Write-JsonFile $path $ht
        Write-Success "Removed $serverKey from $path (project: $projectPath)"
    }
}

function Upsert-VSCodeMcp([string]$path) {
    $obj = Read-JsonFile $path
    if ($null -eq $obj) { $obj = @{} }
    $ht = Ensure-Hashtable $obj

    if (-not $ht.ContainsKey("servers") -or $null -eq $ht["servers"]) {
        $ht["servers"] = @{}
    }
    $servers = Ensure-Hashtable $ht["servers"]
    $servers[$McpName] = @{
        type = "http"
        url  = $McpUrl
    }
    $ht["servers"] = $servers
    Write-JsonFile $path $ht
    Write-Success "Configured VS Code MCP: $path"
}

function Remove-McpEntry([string]$path, [string]$serverKey) {
    if (-not (Test-Path $path)) { return }
    $obj = Read-JsonFile $path
    if ($null -eq $obj) { return }
    $ht = Ensure-Hashtable $obj

    foreach ($key in @("mcpServers", "servers")) {
        if ($ht.ContainsKey($key) -and $null -ne $ht[$key]) {
            $servers = Ensure-Hashtable $ht[$key]
            if ($servers.ContainsKey($serverKey)) {
                $servers.Remove($serverKey)
                $ht[$key] = $servers
                Write-JsonFile $path $ht
                Write-Success "Removed $serverKey from $path"
                return
            }
        }
    }
}

# ===============================
# Skill Install
# ===============================

function Install-Skill {
    $skillSource = Join-Path $ScriptDir "skills\$SkillName"
    $skillDest = Join-Path $env:USERPROFILE ".claude\skills\$SkillName"

    if (-not (Test-Path (Join-Path $skillSource "SKILL.md"))) {
        Write-Err "Skill source not found: $skillSource"
        return $false
    }

    # Remove existing and copy fresh
    if (Test-Path $skillDest) {
        Remove-Item -Path $skillDest -Recurse -Force -ErrorAction SilentlyContinue
    }
    Ensure-Dir (Split-Path -Parent $skillDest)
    Copy-Item -Path $skillSource -Destination $skillDest -Recurse -Force
    Write-Success "Installed skill: $skillDest"
    return $true
}

function Remove-Skill {
    $skillDest = Join-Path $env:USERPROFILE ".claude\skills\$SkillName"
    if (Test-Path $skillDest) {
        Remove-Item -Path $skillDest -Recurse -Force -ErrorAction SilentlyContinue
        Write-Success "Removed skill: $skillDest"
    }
}

# ===============================
# Uninstall
# ===============================

function Invoke-Uninstall {
    Write-Step "Uninstalling Commit AI Resolver..."

    # Remove MCP entries
    $claudeCodeJson = Join-Path $env:USERPROFILE ".claude.json"
    $resolvedProject = if ($ProjectPath) { $ProjectPath }
                       else { $ScriptDir -replace '\\', '/' }
    Remove-ClaudeCodeProjectMcp $claudeCodeJson $resolvedProject $McpName

    $claudeDesktop = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
    Remove-McpEntry $claudeDesktop $McpName

    @(
        (Join-Path $env:APPDATA "Code\User\mcp.json"),
        (Join-Path $env:APPDATA "Code - Insiders\User\mcp.json")
    ) | Sort-Object -Unique | ForEach-Object { Remove-McpEntry $_ $McpName }

    # Remove skill
    Remove-Skill

    Write-Host ""
    Write-Host "Uninstall complete. Restart Claude Code / VS Code to apply." -ForegroundColor Green
}

# ===============================
# Main
# ===============================

function Main {
    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host "    Commit AI Resolver Setup v$Version                          " -ForegroundColor Cyan
    Write-Host "    MCP + Skill Configuration                                   " -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host ""

    if ($Uninstall) {
        Invoke-Uninstall
        return
    }

    Write-Host "  MCP URL: $McpUrl" -ForegroundColor Gray
    Write-Host "  Timeout: ${Timeout}s" -ForegroundColor Gray
    Write-Host ""

    # 1. MCP Configuration
    Write-Step "Configuring MCP servers..."

    # Claude Code CLI — project-level in ~/.claude.json
    $claudeCodeJson = Join-Path $env:USERPROFILE ".claude.json"
    # Resolve project path: use parameter, or auto-detect from script location
    $resolvedProject = if ($ProjectPath) { $ProjectPath }
                       else { $ScriptDir -replace '\\', '/' }
    Upsert-ClaudeCodeProjectMcp $claudeCodeJson $resolvedProject

    # Claude Desktop
    $claudeDesktop = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
    if (-not (Test-Path $claudeDesktop)) {
        Ensure-Dir (Split-Path -Parent $claudeDesktop)
        Write-JsonFile $claudeDesktop @{ mcpServers = @{} }
    }
    Upsert-ClaudeMcp $claudeDesktop

    # VS Code
    $vsCodePaths = @(
        (Join-Path $env:APPDATA "Code\User\mcp.json"),
        (Join-Path $env:APPDATA "Code - Insiders\User\mcp.json")
    ) | Sort-Object -Unique

    foreach ($p in $vsCodePaths) {
        Ensure-Dir (Split-Path -Parent $p)
        if (-not (Test-Path $p)) {
            Write-JsonFile $p @{ servers = @{} }
        }
        Upsert-VSCodeMcp $p
    }

    Write-Host ""

    # 2. Skill Installation
    Write-Step "Installing Claude Code skill..."
    $skillOk = Install-Skill
    Write-Host ""

    # Summary
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host "                    Setup Complete                              " -ForegroundColor Green
    Write-Host "================================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  [OK] MCP configured for Claude Code, Claude Desktop, VS Code" -ForegroundColor Green
    if ($skillOk) {
        Write-Host "  [OK] Skill installed: commit-resolver" -ForegroundColor Green
    }
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Start the API server: node api/server.js" -ForegroundColor Gray
    Write-Host "  2. Restart Claude Code / VS Code" -ForegroundColor Gray
    Write-Host "  3. Use: /commit-resolver or ask about recent commits" -ForegroundColor Gray
    Write-Host ""
    Write-Host "To uninstall: .\setup-commit-resolver.ps1 -Uninstall" -ForegroundColor Gray
    Write-Host ""
}

try { Main }
catch {
    Write-Host ""
    Write-Err "Setup failed: $($_.Exception.Message)"
    Write-Host ""
    exit 1
}
