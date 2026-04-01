@echo off
setlocal enabledelayedexpansion

:: Enhanced MCP Tools Initialization Script
:: Automatically installs Python 3.12 if needed, checks version requirements
:: Simplified Node.js/npm setup for debug server MCP

echo.
echo ========================================
echo    MCP Tools Project Initialization
echo    (with Python Auto-Installation)
echo ========================================
echo.

:: Configuration
set "PROJECT_DIR=%~dp0..\..\tools\mcp-tools"
set "MIN_PYTHON_VERSION=3.11"
set "RECOMMENDED_PYTHON_VERSION=3.12.7"
set "PYTHON_INSTALLER_URL=https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe"

:: step 0: Npm Auth
echo [0/9] Update the credential for private NPM registry
rem Update the credential for private NPM registry
CALL "%~dp0..\..\tools\cmdlet\update-npm-credential.cmd"

:: Step 1: Navigate to project directory
echo [1/9] Navigating to project directory...
if not exist "%PROJECT_DIR%" (
    echo ❌ Error: Project directory does not exist: %PROJECT_DIR%
    echo Please update the PROJECT_DIR variable in this script.
    pause
    exit /b 1
)
cd /d "%PROJECT_DIR%"
echo ✅ Changed to directory: %CD%

:: Step 2: Check Python installation and version
echo.
echo [2/9] Checking Python installation...
python --version >nul 2>&1
if errorlevel 1 (
    echo ⚠️  Python is not installed or not in PATH
    goto :install_python
)

for /f "tokens=2" %%i in ('python --version 2^>^&1') do set "PYTHON_VERSION=%%i"
echo Found Python !PYTHON_VERSION!

call :compare_versions "!PYTHON_VERSION!" "%MIN_PYTHON_VERSION%"
if !version_comparison! LSS 0 (
    echo ⚠️  Python !PYTHON_VERSION! is below recommended version %MIN_PYTHON_VERSION%
    echo Continuing with existing Python installation...
) else (
    echo ✅ Python !PYTHON_VERSION! meets requirements
)
goto :npm_install

:install_python
echo.
echo [Auto-Install] Installing Python %RECOMMENDED_PYTHON_VERSION%...
net session >nul 2>&1
if errorlevel 1 (
    echo ⚠️  Administrator privileges recommended for Python installation
    choice /c YN /m "Continue anyway? (Y/N)"
    if errorlevel 2 (
        echo Installation cancelled
        pause
        exit /b 1
    )
)
set "TEMP_DIR=%TEMP%\python_installer"
if not exist "%TEMP_DIR%" mkdir "%TEMP_DIR%"
echo Downloading Python installer...
powershell -Command "try { Invoke-WebRequest -Uri '%PYTHON_INSTALLER_URL%' -OutFile '%TEMP_DIR%\python_installer.exe' -UseBasicParsing; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    curl --version >nul 2>&1
    if errorlevel 1 (
        echo ❌ Cannot download Python installer (no PowerShell or curl)
        goto :manual_python_install
    )
    echo Using curl to download...
    curl -L -o "%TEMP_DIR%\python_installer.exe" "%PYTHON_INSTALLER_URL%"
    if errorlevel 1 (
        echo ❌ Failed to download Python installer
        goto :manual_python_install
    )
)
if not exist "%TEMP_DIR%\python_installer.exe" (
    echo ❌ Python installer download failed
    goto :manual_python_install
)
echo ✅ Python installer downloaded

"%TEMP_DIR%\python_installer.exe" /quiet InstallAllUsers=1 PrependPath=1 Include_test=0 Include_pip=1 Include_launcher=1
timeout /t 10 /nobreak >nul
del "%TEMP_DIR%\python_installer.exe" 2>nul
rmdir "%TEMP_DIR%" 2>nul
call :refresh_path
python --version >nul 2>&1
if errorlevel 1 (
    echo ❌ Python installation verification failed
    goto :manual_python_install
)
for /f "tokens=2" %%i in ('python --version 2^>^&1') do set "PYTHON_VERSION=%%i"
echo ✅ Python !PYTHON_VERSION! installed successfully
goto :npm_install

:manual_python_install
echo.
echo ❌ Automatic Python installation failed
echo.
echo Please install Python manually:
echo - Download Python %RECOMMENDED_PYTHON_VERSION% or newer from https://python.org/downloads/
echo - Check "Add Python to PATH"
echo - Run this script again
pause
exit /b 1

:npm_install
echo.
echo [3/9] Installing npm dependencies...
if not exist "package.json" (
    echo ⚠️  No package.json found - skipping npm install
    set "SKIP_NPM=true"
    goto :check_uv
)
echo Installing npm dependencies...
call npm install
if errorlevel 1 (
    echo ❌ Failed to install npm dependencies
    set "NPM_FAILED=true"
) else (
    echo ✅ npm dependencies installed successfully
)
goto :check_uv

:check_uv
echo.
echo [4/9] Checking UV installation...
uv --version >nul 2>&1
if errorlevel 1 (
    echo ⚠️  UV is not installed. Installing UV...
    python -m pip install uv
    if errorlevel 1 (
        echo ❌ Failed to install UV
        pause
        exit /b 1
    )
    call :refresh_path
)
:: Always ensure Python Scripts folder is in PATH for MCP servers
call :add_python_scripts_to_path
for /f "tokens=2" %%i in ('uv --version 2^>^&1') do set "UV_VERSION=%%i"
echo ✅ UV !UV_VERSION! is installed


echo.
echo [5/9] Checking for pyproject.toml...
if not exist "pyproject.toml" (
    echo ❌ pyproject.toml not found
    pause
    exit /b 1
)
echo ✅ Found pyproject.toml

echo.
echo [6/9] Checking Python version requirements...
findstr /c:"requires-python" pyproject.toml >nul 2>&1
if errorlevel 1 (
    echo ⚠️  No explicit Python version requirement
) else (
    echo ✅ Python version requirements found
)

echo.
echo [7/9] Checking for uv.lock...
if exist "uv.lock" (
    echo ✅ Found uv.lock file
) else (
    echo ⚠️  uv.lock not found (will be created during sync)
)

echo.
echo [8/9] Setting up virtual environment...
if exist ".venv" (
    echo ✅ Virtual environment already exists
) else (
    echo Creating new virtual environment...
)
uv sync
if errorlevel 1 (
    echo ❌ Failed to sync virtual environment
    pause
    exit /b 1
)
echo ✅ Virtual environment setup complete

echo.
echo [9/9] Verifying installation...
.venv\Scripts\python.exe --version
uv pip list

rem Activate virtual environment
call .venv\Scripts\activate.bat

rem Install Playwright Chromium browser
playwright install chromium

rem Deactivate virtual environment
call .venv\Scripts\deactivate.bat

echo.
echo Setting up environment configuration...
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo ✅ Created .env file from template
    ) else (
        echo ⚠️  No .env.example found
    )
) else (
    echo ✅ .env file already exists
)

echo.
echo ========================================
echo           Setup Complete! 🎉
echo ========================================
echo Python Version: !PYTHON_VERSION!
echo UV Version: !UV_VERSION!
echo Project Directory: %PROJECT_DIR%
if not "%NPM_FAILED%"=="true" if not "%SKIP_NPM%"=="true" echo npm dependencies: Installed
echo.

tasklist /FI "IMAGENAME eq Code.exe" | find /I "Code.exe" >nul
if errorlevel 0 (
    echo MCP Server setup complete
)
goto :eof

:compare_versions
set "version1=%~1"
set "version2=%~2"
for /f "tokens=1,2 delims=." %%a in ("!version1!") do (
    set /a v1_major=%%a
    set /a v1_minor=%%b
)
for /f "tokens=1,2 delims=." %%a in ("!version2!") do (
    set /a v2_major=%%a
    set /a v2_minor=%%b
)
if !v1_major! GTR !v2_major! (set "version_comparison=1" & goto :eof)
if !v1_major! LSS !v2_major! (set "version_comparison=-1" & goto :eof)
if !v1_minor! GTR !v2_minor! (set "version_comparison=1" & goto :eof)
if !v1_minor! LSS !v2_minor! (set "version_comparison=-1" & goto :eof)
set "version_comparison=0"
goto :eof

:refresh_path
for /f "tokens=2*" %%a in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "SYS_PATH=%%b"
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "USER_PATH=%%b"
set "PATH=%SYS_PATH%;%USER_PATH%"
goto :eof

:add_python_scripts_to_path
:: Get the Python Scripts folder path
for /f "delims=" %%i in ('python -c "import sys; print(sys.prefix + '\\Scripts')"') do set "PYTHON_SCRIPTS=%%i"
if not defined PYTHON_SCRIPTS (
    echo ⚠️  Could not determine Python Scripts folder
    goto :eof
)
:: Check if already in user PATH
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v PATH 2^>nul') do set "CURRENT_USER_PATH=%%b"
echo !CURRENT_USER_PATH! | find /i "!PYTHON_SCRIPTS!" >nul
if errorlevel 1 (
    echo Adding Python Scripts folder to user PATH: !PYTHON_SCRIPTS!
    if defined CURRENT_USER_PATH (
        setx PATH "!CURRENT_USER_PATH!;!PYTHON_SCRIPTS!"
    ) else (
        setx PATH "!PYTHON_SCRIPTS!"
    )
    echo ✅ Added Python Scripts folder to PATH
    echo ⚠️  Note: You may need to restart VS Code for PATH changes to take effect
) else (
    echo ✅ Python Scripts folder already in PATH
)
goto :eof
