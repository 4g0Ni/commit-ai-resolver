@echo off
REM Quick Debug Launcher for AdsAppsCampaignUI
REM Opens admin command prompt and runs complete setup

echo Starting debug environment setup...
echo This will open an admin command prompt window.
echo.

powershell -Command "Start-Process cmd.exe -ArgumentList '/k', 'cd /d C:\src\AdsAppsCampaignUI && echo ======================================== && echo Complete Debug Setup for SI && echo ======================================== && echo. && echo [1/3] Running init.cmd... && init.cmd && echo. && echo ======================================== && echo [2/3] Installing dependencies... && echo ======================================== && cd private && pnpm install && echo. && echo ======================================== && echo [3/3] Starting gulp debug server... && echo ======================================== && cd ui-next && gulp debug:int --fm --rspack' -Verb RunAs"

echo.
echo Admin command prompt launched!
echo Check your taskbar for the new window.
