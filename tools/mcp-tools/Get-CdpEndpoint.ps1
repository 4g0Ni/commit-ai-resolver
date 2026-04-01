# =================================================================
# Get CDP Endpoint Script
# Returns the CDP WebSocket URL for connecting to the test browser
# Usage: .\Get-CdpEndpoint.ps1
#        .\Get-CdpEndpoint.ps1 -Connect  # Also connects via MCP
# =================================================================

param(
    [switch]$Connect,
    [switch]$Raw
)

$globalCdpPath = Join-Path $env:TEMP "ui-next-test-cdp-endpoint.json"
$localCdpPath = "c:\src\AdsAppsCampaignUI\private\ui-next-test-entry\cdp-endpoint.json"

# Try global path first (more reliable), then local
$cdpPath = if (Test-Path $globalCdpPath) { $globalCdpPath } elseif (Test-Path $localCdpPath) { $localCdpPath } else { $null }

if (-not $cdpPath) {
    Write-Host "❌ No CDP endpoint file found. Is a test running with -PauseOnFailure?" -ForegroundColor Red
    Write-Host "   Expected locations:" -ForegroundColor Gray
    Write-Host "   - $globalCdpPath" -ForegroundColor Gray
    Write-Host "   - $localCdpPath" -ForegroundColor Gray
    exit 1
}

try {
    $cdpData = Get-Content $cdpPath -Raw | ConvertFrom-Json
    $cdpUrl = $cdpData.cdp_url

    if (-not $cdpUrl) {
        Write-Host "❌ CDP endpoint file exists but has no cdp_url" -ForegroundColor Red
        exit 1
    }

    if ($Raw) {
        # Just output the URL for piping
        Write-Output $cdpUrl
    } else {
        Write-Host ""
        Write-Host "🔗 CDP Endpoint Available" -ForegroundColor Cyan
        Write-Host "   URL: $cdpUrl" -ForegroundColor Green
        Write-Host "   Source: $cdpPath" -ForegroundColor Gray
        Write-Host ""
        Write-Host "   To connect with MCP browser tools:" -ForegroundColor Yellow
        Write-Host "   mcp_browser-tools_connect_to_existing_browser" -ForegroundColor White
        Write-Host "   cdp_url: $cdpUrl" -ForegroundColor White
        Write-Host ""

        # Output the URL for easy copy
        Write-Output $cdpUrl
    }

} catch {
    Write-Host "❌ Failed to read CDP endpoint: $_" -ForegroundColor Red
    exit 1
}
