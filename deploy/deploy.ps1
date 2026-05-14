<#
.SYNOPSIS
  Deploy Commit AI Resolver to Azure App Service.

.DESCRIPTION
  Provisions and deploys:
  - Azure App Service (Windows, Node 20) for Express API + React UI
  - Managed Identity + RBAC for Azure OpenAI access
  The UI is served as static files from the same App Service (no SWA needed).

.PARAMETER ResourceGroup
  Azure resource group name. Default: commit-ai-resolver-rg

.PARAMETER AppName
  Base name for resources. Default: commit-ai-resolver-win

.PARAMETER Location
  Azure region. Default: westus2

.PARAMETER OpenAIResourceGroup
  Resource group containing the Azure OpenAI resource. Default: same as ResourceGroup

.PARAMETER OpenAIResourceName
  Name of the Azure OpenAI resource for RBAC. Default: yizha-maz2xf24-swedencentral

.PARAMETER SkipBuild
  Skip npm build steps (use existing build artifacts). Default: false

.PARAMETER SkipProvision
  Skip resource provisioning (deploy only). Default: false

.PARAMETER AriaIngestionToken
  1DS telemetry ingestion token. Optional — set later via app settings if omitted.

.PARAMETER AriaProjectId
  1DS telemetry project ID. Optional.

.EXAMPLE
  .\deploy.ps1
  # Full provisioning + deployment with defaults

.EXAMPLE
  .\deploy.ps1 -SkipProvision -SkipBuild
  # Redeploy code only (resources already exist)
#>

[CmdletBinding()]
param(
    [string]$ResourceGroup = "commit-ai-resolver-rg",
    [string]$AppName = "commit-ai-resolver-win",
    [string]$Location = "westus2",
    [string]$OpenAIResourceGroup,
    [string]$OpenAIResourceName = "yizha-maz2xf24-swedencentral",
    [switch]$SkipBuild = $false,
    [switch]$SkipProvision = $false,
    [string]$AriaIngestionToken,
    [string]$AriaProjectId
)

$ErrorActionPreference = "Stop"
$ScriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Get-Location }
$RepoRoot = Split-Path -Parent $ScriptDir

if (-not $OpenAIResourceGroup) { $OpenAIResourceGroup = $ResourceGroup }

$AppServiceName = $AppName
$AppServicePlan = "$AppName-plan"

function Write-Step([string]$msg) { Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-Success([string]$msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }

# ===============================
# Prerequisites check
# ===============================

Write-Step "Checking prerequisites..."

# Azure CLI
$azVersion = az version 2>$null | ConvertFrom-Json
if (-not $azVersion) {
    throw "Azure CLI (az) is not installed. Install from https://aka.ms/installazurecli"
}
Write-Success "Azure CLI: $($azVersion.'azure-cli')"

# Check login
$account = az account show 2>$null | ConvertFrom-Json
if (-not $account) {
    throw "Not logged in to Azure. Run: az login"
}
Write-Success "Logged in as: $($account.user.name) (subscription: $($account.name))"

# Node.js
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) { throw "Node.js is not installed" }
Write-Success "Node.js: $nodeVersion"

Write-Host ""
Write-Host "  Resource Group:    $ResourceGroup" -ForegroundColor Gray
Write-Host "  App Service:       $AppServiceName" -ForegroundColor Gray
Write-Host "  App Service Plan:  $AppServicePlan" -ForegroundColor Gray
Write-Host "  Location:          $Location" -ForegroundColor Gray
Write-Host "  OS:                Windows" -ForegroundColor Gray

# ===============================
# Provision Azure Resources
# ===============================

if (-not $SkipProvision) {

    Write-Step "Creating resource group: $ResourceGroup..."
    az group create --name $ResourceGroup --location $Location --output none
    Write-Success "Resource group ready"

    # --- App Service ---
    Write-Step "Creating App Service Plan: $AppServicePlan (Windows B1)..."
    az appservice plan create `
        --name $AppServicePlan `
        --resource-group $ResourceGroup `
        --sku B1 `
        --output none
    Write-Success "App Service Plan ready"

    Write-Step "Creating App Service: $AppServiceName..."
    az webapp create `
        --name $AppServiceName `
        --resource-group $ResourceGroup `
        --plan $AppServicePlan `
        --runtime "NODE:20LTS" `
        --output none
    Write-Success "App Service ready"

    Write-Step "Configuring App Service settings..."
    $appSettings = @(
        "WEBSITE_NODE_DEFAULT_VERSION=~20",
        "DATA_DIR=D:\home\data",
        "SCM_DO_BUILD_DURING_DEPLOYMENT=false"
    )
    if ($AriaIngestionToken) { $appSettings += "ARIA_INGESTION_TOKEN=$AriaIngestionToken" }
    if ($AriaProjectId) { $appSettings += "ARIA_PROJECT_ID=$AriaProjectId" }

    az webapp config appsettings set `
        --name $AppServiceName `
        --resource-group $ResourceGroup `
        --settings @appSettings `
        --output none

    # Set startup command (no startup.sh on Windows — just the node command)
    az webapp config set `
        --name $AppServiceName `
        --resource-group $ResourceGroup `
        --startup-file "node server.js" `
        --output none

    # Enable websockets (needed for SSE) and 64-bit platform (needed for LanceDB native binary)
    az webapp config set `
        --name $AppServiceName `
        --resource-group $ResourceGroup `
        --web-sockets-enabled true `
        --use-32bit-worker-process false `
        --output none

    Write-Success "App settings configured"

    # --- Managed Identity ---
    Write-Step "Enabling Managed Identity..."
    $identity = az webapp identity assign `
        --name $AppServiceName `
        --resource-group $ResourceGroup `
        --output json | ConvertFrom-Json
    $principalId = $identity.principalId
    Write-Success "Managed Identity enabled (principal: $principalId)"

    # Grant Cognitive Services OpenAI User role
    Write-Step "Granting Azure OpenAI access to Managed Identity..."
    $openaiResource = az cognitiveservices account show `
        --name $OpenAIResourceName `
        --resource-group $OpenAIResourceGroup `
        --output json 2>$null | ConvertFrom-Json

    if ($openaiResource) {
        $rbacOk = $false
        for ($i = 1; $i -le 3; $i++) {
            $rbacResult = az role assignment create `
                --assignee $principalId `
                --role "Cognitive Services OpenAI User" `
                --scope $openaiResource.id `
                --output none 2>&1
            if ($LASTEXITCODE -eq 0) {
                $rbacOk = $true
                break
            }
            Write-Warn "RBAC attempt $i failed (identity propagation). Waiting 15s..."
            Start-Sleep -Seconds 15
        }
        if ($rbacOk) { Write-Success "RBAC role assigned" }
        else { Write-Warn "RBAC assignment failed after retries. Assign 'Cognitive Services OpenAI User' manually." }
    } else {
        Write-Warn "Azure OpenAI resource '$OpenAIResourceName' not found in '$OpenAIResourceGroup'. Skipping RBAC."
        Write-Warn "You'll need to grant 'Cognitive Services OpenAI User' role manually."
    }
}

# ===============================
# Build
# ===============================

if (-not $SkipBuild) {
    # Build UI
    Write-Step "Building UI..."
    Push-Location (Join-Path $RepoRoot "ui")
    try {
        npm install --legacy-peer-deps --registry https://registry.npmjs.org/ 2>&1 | Out-Null
        $ErrorActionPreference = "Continue"
        npm run build 2>&1 | Write-Host
        $ErrorActionPreference = "Stop"
        if ($LASTEXITCODE -ne 0) { throw "UI build failed" }
        Write-Success "UI built: ui/dist/"
    } finally { Pop-Location }

    # Package API + UI
    Write-Step "Packaging API + UI..."
    & (Join-Path $ScriptDir "prepare-api.ps1")
    if ($LASTEXITCODE -ne 0) { throw "API packaging failed" }
}

# ===============================
# Deploy
# ===============================

Write-Step "Deploying to App Service..."
$apiZip = Join-Path $ScriptDir "api-package.zip"
if (-not (Test-Path $apiZip)) {
    throw "Package not found: $apiZip. Run without -SkipBuild or run prepare-api.ps1 first."
}

az webapp deploy `
    --name $AppServiceName `
    --resource-group $ResourceGroup `
    --src-path $apiZip `
    --type zip `
    --clean true `
    --output none

Write-Success "Deployed to https://$AppServiceName.azurewebsites.net"

# ===============================
# Summary
# ===============================

$appUrl = "https://$AppServiceName.azurewebsites.net"

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "                  Deployment Complete                           " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  App:  $appUrl" -ForegroundColor Gray
Write-Host "  API:  $appUrl/api" -ForegroundColor Gray
Write-Host "  MCP:  $appUrl/mcp" -ForegroundColor Gray
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Register redirect URI in Azure AD app registration:" -ForegroundColor Gray
Write-Host "     $appUrl (Single-page application platform)" -ForegroundColor Gray
Write-Host "  2. Point MCP clients to the deployed endpoint:" -ForegroundColor Gray
Write-Host "     .\setup-commit-resolver.ps1 -McpUrl '$appUrl/mcp'" -ForegroundColor Gray
Write-Host ""
