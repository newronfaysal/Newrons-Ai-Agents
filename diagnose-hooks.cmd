@echo off
set OUT=C:\NEWRON_Agent_Office\hook-diagnose.txt
echo === AI Office hook diagnosis === > %OUT%
echo.>> %OUT%
echo [1] node on PATH: >> %OUT%
where node >> %OUT% 2>&1
node -v >> %OUT% 2>&1
echo.>> %OUT%
echo [2] claude CLI on PATH: >> %OUT%
where claude >> %OUT% 2>&1
echo.>> %OUT%
echo [3] hook settings in C:\ai-office-test: >> %OUT%
dir /a C:\ai-office-test >> %OUT% 2>&1
dir /a C:\ai-office-test\.claude >> %OUT% 2>&1
findstr /n /c:"ai-office-hook" /c:"SessionStart" /c:"PreToolUse" C:\ai-office-test\.claude\settings.local.json >> %OUT% 2>&1
echo.>> %OUT%
echo [4] does the user-level Claude settings file disable hooks? (only matching lines are printed) >> %OUT%
findstr /i /n "disableAllHooks allowManagedHooksOnly" "%USERPROFILE%\.claude\settings.json" >> %OUT% 2>&1
if errorlevel 1 echo no match / no file >> %OUT%
echo.>> %OUT%
echo [5] sending ONE manual test event through the hook script (this is NOT Claude): >> %OUT%
> "%TEMP%\aio-diag.json" echo {"hook_event_name":"SessionStart","session_id":"manual-diagnostic-not-claude","cwd":"C:\\ai-office-test","source":"startup"}
type "%TEMP%\aio-diag.json" | node "C:\NEWRON_Agent_Office\tools\hooks\ai-office-hook.mjs" >> %OUT% 2>&1
echo hook exit code: %errorlevel% >> %OUT%
timeout /t 2 /nobreak >nul
echo.>> %OUT%
echo [6] spool folder (files here mean the server was not reachable): >> %OUT%
dir C:\NEWRON_Agent_Office\data\spool >> %OUT% 2>&1
echo.>> %OUT%
echo [7] server answers on 4317: >> %OUT%
curl -s http://127.0.0.1:4317/api/health >> %OUT% 2>&1
echo.>> %OUT%
echo === end === >> %OUT%
