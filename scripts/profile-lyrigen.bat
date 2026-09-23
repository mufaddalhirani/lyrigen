@echo off
REM ---------------------------------------------------------------
REM  Lyrigen - launch with Chrome DevTools remote debugging enabled
REM  so a profiler can attach on http://localhost:9222
REM
REM  Just double-click this file. Leave the app running, play a
REM  track, and switch visual modes so the lag can be recorded.
REM  Close the app window when you're done.
REM ---------------------------------------------------------------

setlocal
set "APP=%~dp0..\release\win-unpacked\Lyrigen.exe"

if not exist "%APP%" (
  echo.
  echo   Could not find:
  echo   %APP%
  echo.
  echo   Run "npm run build" first, or edit the APP path in this file.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting Lyrigen with remote debugging on port 9222...
echo.
echo   Leave this window open. Play a song and move around the UI
echo   so the profiler can see the lag happen.
echo.

start "" "%APP%" --remote-debugging-port=9222 --remote-allow-origins=*

timeout /t 4 /nobreak >nul

echo   Checking that the debugger port is listening...
echo.
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:9222/json/version' -TimeoutSec 5; Write-Host '   OK - debugger is live:'; Write-Host ''; ($r.Content | ConvertFrom-Json).Browser } catch { Write-Host '   Port 9222 is not responding yet. Give it a few seconds,'; Write-Host '   then open http://localhost:9222/json/version in a browser.' }"

echo.
echo   You can leave this window open or close it - the app keeps running.
echo.
pause
