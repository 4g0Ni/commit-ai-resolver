@echo off
:: MCP Tools Initialization Wrapper
:: Calls the full initialization script in tools/mcp-tools

echo Starting MCP Tools initialization...
:: Get the directory where this script is located
set "SCRIPT_DIR=%~dp0"

:: Call the full initialization script in the tools/mcp-tools subdirectory
call "%SCRIPT_DIR%tools\mcp-tools\init.cmd"
echo ✅ MCP Tools initialization completed successfully!