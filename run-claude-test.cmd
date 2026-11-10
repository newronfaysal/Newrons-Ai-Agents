@echo off
title AI Office - live hook test
cd /d C:\ai-office-test
where claude >nul 2>nul
if errorlevel 1 (
  echo The "claude" command was not found on PATH. > C:\NEWRON_Agent_Office\claude-test-output.txt
  echo Claude Code CLI not found.
  pause
  exit /b 1
)
echo hello from the AI Office hook test> notes.txt
echo Running a read-only Claude Code session in C:\ai-office-test ...
claude -p "Read the file notes.txt in this folder and tell me in one short sentence what it says. Do not change anything." > C:\NEWRON_Agent_Office\claude-test-output.txt 2>&1
echo Finished. Exit code %errorlevel%. >> C:\NEWRON_Agent_Office\claude-test-output.txt
echo Finished. You can close this window.
timeout /t 5 /nobreak >nul
