@echo off
REM Quick Debug Launcher for Onebox
REM Opens admin command prompt and runs complete setup

echo Starting debug environment setup for Onebox...
echo This will open an admin command prompt window.
echo.

REM Use %~dp0 to resolve the repo root dynamically (script is at tools\mcp-tools\)
for %%I in ("%~dp0..\..") do set "REPO_ROOT=%%~fI"

powershell -Command "Start-Process cmd.exe -ArgumentList '/k', ('cd /d %REPO_ROOT% && echo ======================================== && echo Complete Debug Setup for Onebox && echo ======================================== && echo. && echo [1/3] Running init.cmd... && init.cmd && echo. && echo ======================================== && echo [2/3] Installing dependencies... && echo ======================================== && cd private && pnpm install && echo. && echo ======================================== && echo [3/3] Starting gulp debug server... && echo ======================================== && cd ui-next && gulp debug:onebox --fm --rspack') -Verb RunAs"

echo.
echo Admin command prompt launched!
echo Check your taskbar for the new window.
