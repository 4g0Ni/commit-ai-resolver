# MCP Tools for AdsAppsCampaignUI

This directory contains Model Context Protocol (MCP) tools for the AdsAppsCampaignUI project, providing various automation and development utilities.

## 🚀 Quick Start
Before running the ``` init.cmd ``` script, please fetch your creator id from azure devops and create a ``` .env ``` file based on the ``` .env-example ``` .

We use this Creator ID to set as a baseline for the MCP tool to fetch PRs based on your changes. Without this Creator ID will search all the PRs in Campaign UI which might not be very useful to you.

Run the initialization script to set up the environment:

```cmd
init.cmd
```
## 🔄 Running After Setup

After running `init.cmd`, you can find the tools auto configured in the vscode github copilot agent.

You can also manuall restart your MCP servers with these commands.
1. Ctrl + Shift + P
2. Search MCP: List Servers
3. Restart the specific MCP servers, look at it output and also configuration.


## 📋 Prerequisites

The initialization script will automatically handle most requirements, but you should be aware of:

- **Python**: 3.11+ (3.12.7 recommended) - will be auto-installed if missing
- **Node.js & npm**: Required for debug server functionality
- **Windows**: This setup is designed for Windows environments

## 🛠️ Available MCP Tools

This project includes several MCP tools:

- **Azure DevOps Integration** (`azure-devops-basic.py`): Tools for Azure DevOps operations
- **Browser Automation** (`browser-use-mcp.py`): Web browser automation capabilities
- **Diff Parser** (`diff-parser.py`): Git diff parsing and processing utilities
- **Debug Server Setup** (`setup-debug-server.js`): Development server configuration- **Iframe Migration Toolkit** (`iframe-migration/`): Scripts for migrating iframe tests to Selenium

## 📦 Iframe Migration Toolkit

The `iframe-migration/` folder contains PowerShell scripts and documentation for migrating iframe-driver tests to Selenium WebDriver.

### Scripts

| Script | Purpose |
|--------|---------|
| `Analyze-IframePackages.ps1` | Scan all packages, calculate complexity scores, prioritize migration |
| `Find-PackagesToMigrate.ps1` | Quick list of packages needing migration vs already migrated |
| `Migrate-SinglePackage.ps1` | Auto-generate Selenium test file for a single package |
| `Test-MigratedPackages.ps1` | Run Selenium tests for specified or discovered packages |

### Quick Usage

```powershell
cd C:\src\AdsAppsCampaignUI\tools\mcp-tools\iframe-migration

# 1. Find packages that need migration
.\Find-PackagesToMigrate.ps1

# 2. Analyze complexity and prioritize
.\Analyze-IframePackages.ps1 -MaxComplexity 5

# 3. Migrate a package (generates starting point)
.\Migrate-SinglePackage.ps1 -PackagePath "advisor\packages\recommendation-inline-action"

# 4. Test migrated packages
.\Test-MigratedPackages.ps1 -Packages @("advisor\packages\recommendation-inline-action") -SkipInit -SkipInstall
```

### Documentation

See `iframe-migration/MIGRATION-GUIDE.md` for:
- Complete migration workflow
- Browser debugging techniques (most valuable!)
- Common fix patterns for Selenium
- Known limitations and workarounds
- ESLint error fixes