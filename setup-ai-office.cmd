@echo off
title AI Office setup
cd /d C:\NEWRON_Agent_Office
echo === 1/3 Installing dependencies ===
call pnpm install
if errorlevel 1 (
  echo INSTALL FAILED. Copy the messages above and send them to Claude.
  pause
  exit /b 1
)
echo.
echo === 2/3 Installing hooks into the scratch folder C:\ai-office-test (project-local only) ===
if not exist C:\ai-office-test mkdir C:\ai-office-test
call pnpm hooks:install --project C:\ai-office-test --yes
echo.
echo === 3/3 Starting AI Office in its own window ===
start "AI Office server" cmd /k "cd /d C:\NEWRON_Agent_Office && pnpm start"
timeout /t 25 /nobreak >nul
start http://127.0.0.1:4317/integration
echo.
echo Done. Leave the "AI Office server" window open. You can close this one.
pause
