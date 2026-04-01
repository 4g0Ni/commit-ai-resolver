# =================================================================
# UI Next Test Runner Script
# Usage: .\run-ui-next-test.ps1 -TestGrep "TestSuiteName" -Env si
# =================================================================

param(
    [Parameter(Mandatory=$true)]
    [string]$TestGrep,

    [ValidateSet('si', 'onebox', 'betaproduction', 'local')]
    [string]$Env = 'si',

    [switch]$Headless,
    [switch]$DebugMode,

    [ValidateSet('always', 'never', 'default')]
    [string]$EnablePlaywright = 'always',

    [switch]$LlmDebug,
    [switch]$PauseOnFailure,
    [string]$ExposeBrowser,
    [switch]$NoProxy,

    # Quiet mode - filter output to show only key information (test start/pass/fail, errors, CDP info)
    [switch]$Quiet,

    # Repeat the test multiple times to check for flakiness
    [int]$Repeat = 1,

    [string]$RootPath = $null
)

# Determine root path
if (-not $RootPath) {
    $RootPath = (Get-Item $PSScriptRoot).Parent.Parent.FullName
}

$testEntryPath = Join-Path $RootPath "private\ui-next-test-entry"
$uiNextNodeModules = Join-Path $RootPath "private\ui-next\node_modules"

# Well-known CDP endpoint location (in temp folder for easy access from any terminal)
$globalCdpPath = Join-Path $env:TEMP "ui-next-test-cdp-endpoint.json"

# Validate paths
if (-not (Test-Path $testEntryPath)) {
    Write-Host "❌ Test entry path not found: $testEntryPath" -ForegroundColor Red
    exit 1
}

# Set up environment variables
$env:NODE_PATH = $uiNextNodeModules
$env:CHROME_BIN = "$env:NUGET_PACKAGES\Chromium-Win_x64\1250081.0.0\tools\chromium\chrome.exe"
$env:Path_UserCreation = "$env:NUGET_PACKAGES\BingAds.Test.UserCreation\2.2.4"
$env:Path = "$env:NUGET_PACKAGES\Chromium-Win_x64\1250081.0.0\tools\chromedriver;$env:NUGET_PACKAGES\Node.js.with.uv.pipe.name.fixed\22.12.0\;$env:Path"
$env:EnablePlaywright = $EnablePlaywright

# Change to test entry directory
Set-Location $testEntryPath

# Build command arguments
$nodeArgs = @(
    "node_modules\@bingads-webui-tool\mocha-selenium-runner\bin\mocha-selenium-runner.js",
    "--config", "package.json",
    "--env", $Env,
    "--enable-annotation-filters",
    "--test-grep", $TestGrep,
    "--screenshot-output", ".",
    "--browser", "chrome"
)

if (-not $Headless) {
    $nodeArgs += "--no-headless"
}

if ($DebugMode) {
    $nodeArgs += "--debug"
}

# LLM Debug flags
if ($LlmDebug) {
    $nodeArgs += "--llm-debug"
}

if ($PauseOnFailure) {
    $nodeArgs += "--pause-on-failure"
}

if ($NoProxy) {
    $nodeArgs += "--no-proxy"
}

if ($ExposeBrowser) {
    $nodeArgs += @("--expose-browser", $ExposeBrowser)
} elseif ($PauseOnFailure) {
    # Default expose-browser path if pause-on-failure is enabled
    $nodeArgs += @("--expose-browser", ".\cdp-endpoint.json")
}

# Add repeat flag if specified
if ($Repeat -gt 1) {
    $nodeArgs += @("--repeat", $Repeat.ToString())
}

# Display run info
Write-Host ""
Write-Host "🧪 Running UI Next Test" -ForegroundColor Cyan
Write-Host "   Test: $TestGrep" -ForegroundColor White
Write-Host "   Env:  $Env" -ForegroundColor White
Write-Host "   Playwright: $EnablePlaywright" -ForegroundColor White
if ($LlmDebug) {
    Write-Host "   LLM Debug: Enabled" -ForegroundColor Yellow
}
if ($PauseOnFailure) {
    Write-Host "   Pause on Failure: Enabled" -ForegroundColor Yellow
}
if ($ExposeBrowser -or $PauseOnFailure) {
    $cdpPath = if ($ExposeBrowser) { $ExposeBrowser } else { ".\cdp-endpoint.json" }
    Write-Host "   CDP Endpoint: $cdpPath" -ForegroundColor Yellow
    Write-Host "   Global CDP:   $globalCdpPath" -ForegroundColor Yellow
    Write-Host "   💡 To connect: Get-CdpEndpoint (from any terminal)" -ForegroundColor Magenta
}
if ($Quiet) {
    Write-Host "   Quiet Mode: Enabled (filtered output)" -ForegroundColor Yellow
}
if ($Repeat -gt 1) {
    Write-Host "   Repeat: $Repeat times" -ForegroundColor Yellow
}
Write-Host ""

# Set up a background job to monitor and copy CDP endpoint to global location
$localCdpPath = Join-Path $testEntryPath $(if ($ExposeBrowser) { $ExposeBrowser } else { "cdp-endpoint.json" })
$monitorJob = Start-Job -ScriptBlock {
    param($localPath, $globalPath)
    $lastHash = ""
    while ($true) {
        if (Test-Path $localPath) {
            $content = Get-Content $localPath -Raw -ErrorAction SilentlyContinue
            if ($content) {
                $currentHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($content)))
                if ($currentHash -ne $lastHash) {
                    $content | Set-Content $globalPath -Force
                    $lastHash = $currentHash
                }
            }
        }
        Start-Sleep -Milliseconds 500
    }
} -ArgumentList $localCdpPath, $globalCdpPath

# Run the test
if ($Quiet) {
    # Quiet mode: filter output to show only key information
    # Patterns to include:
    # - Test starting/finished: [SuiteName.testName] starting/finished
    # - Pass/fail indicators: ✓, ✗, passing, failing
    # - Errors and exceptions
    # - CDP/LLM debug info
    # - Summary info

    $includePatterns = @(
        '^\s*✓',                          # Passing tests
        '^\s*✗',                          # Failing tests
        '^\s*\d+ passing',                # Summary: X passing
        '^\s*\d+ failing',                # Summary: X failing
        '^\s*\d+ pending',                # Summary: X pending
        '\[LLM-DEBUG\]',                  # LLM debug output
        '\[CDP\]',                        # CDP endpoint info
        '^Error:',                        # Error messages
        'Error:.*failed',                 # Assertion errors
        'Expected State:',                # State comparison (in error output)
        'Actual State:',                  # State comparison (in error output)
        'ErrorMessage:',                  # Error details
        'ErrorType:',                     # Error type
        'Element:.*Error',                # Element info in errors
        'Test failed',                    # Failure notification
        'Create file with .continue',     # CDP continue instruction
        'press Ctrl\+C',                  # Abort instruction
        '===+',                           # Separator lines
        'Browser paused',                 # Browser paused notification
        'CDP endpoint written',           # CDP file written
        'WebSocket URL:',                 # WebSocket info
        'Unknown pilots:',                # Pilot mapping errors
        'User creation failed'            # User creation errors
    )

    # Patterns to exclude (takes precedence over include)
    $excludePatterns = @(
        '\[tapi\.',                       # TAPI verbose logging
        '\[INFO\]',                       # Info level logs
        '\[FINER\]',                      # Finer level logs
        '\[FINE\]',                       # Fine level logs
        'Driver navigating'               # Navigation logs
    )

    $combinedIncludePattern = ($includePatterns -join '|')
    $combinedExcludePattern = ($excludePatterns -join '|')

    # Special patterns that should always be shown (lifecycle hooks)
    $lifecyclePattern = '\[[\w\.]+\.(before|after|beforeEach|afterEach|should[\w\s]+)\] (starting|finished)'

    & node $nodeArgs 2>&1 | ForEach-Object {
        $line = $_.ToString()

        # Check if this is a lifecycle message (suite/test start/finish)
        if ($line -match $lifecyclePattern) {
            Write-Host $line
        }
        # Check if line matches include patterns and NOT exclude patterns
        elseif ($line -match $combinedIncludePattern -and $line -notmatch $combinedExcludePattern) {
            Write-Host $line
        }
    }

    $exitCode = $LASTEXITCODE
} else {
    # Normal mode: show all output
    & node $nodeArgs
    $exitCode = $LASTEXITCODE
}

# Clean up monitor job
if ($monitorJob) {
    Stop-Job -Job $monitorJob -ErrorAction SilentlyContinue
    Remove-Job -Job $monitorJob -Force -ErrorAction SilentlyContinue
}

if ($exitCode -eq 0) {
    Write-Host ""
    Write-Host "✅ Test completed successfully" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "❌ Test failed with exit code: $exitCode" -ForegroundColor Red
}

exit $exitCode
