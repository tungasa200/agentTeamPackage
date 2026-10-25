@echo off
rem WY Ops quickstart: double-click to run install.ps1 quickstart in this folder (clone or installed copy).
rem The window stays open at the end so you can read the result.
set "WYPS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%WYPS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" quickstart
echo.
echo quickstart exit code: %ERRORLEVEL%
pause
