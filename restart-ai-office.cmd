@echo off
title AI Office restart
echo Looking for an old AI Office server on port 4317...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "127.0.0.1:4317" ^| findstr LISTENING') do (
  tasklist /FI "PID eq %%p" | findstr /I "node.exe" >nul && (
    echo Stopping old AI Office server, PID %%p
    taskkill /PID %%p /F
  ) || echo PID %%p is not node.exe, leaving it alone
)
timeout /t 3 /nobreak >nul
echo Starting the updated server in its own window...
start "AI Office server" cmd /k "cd /d C:\NEWRON_Agent_Office && pnpm start"
timeout /t 20 /nobreak >nul
echo Done. You can close this window.
