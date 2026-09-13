@echo off
REM ContextBox Pet launcher.
REM ASCII only on purpose: cmd.exe reads this with the console codepage,
REM so non-ASCII characters turn into mojibake on many machines.

cd /d "%~dp0..\.."

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js not found. Install Node 24 or newer:
  echo   winget install OpenJS.NodeJS
  echo.
  pause
  exit /b 2
)

node cli.mjs pet
set RC=%errorlevel%

REM Do not let the window vanish on failure - the user would have no idea why.
if not "%RC%"=="0" (
  echo.
  echo ContextBox exited with code %RC%.
  pause
)
exit /b %RC%
