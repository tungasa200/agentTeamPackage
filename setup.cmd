@echo off
rem WY Ops setup wizard (D-171): double-click after git clone.
rem Opens scripts\setup-wizard.ps1 with no console window. The wizard runs install.ps1 quickstart for you.
set "WYPS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
start "" "%WYPS%" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\setup-wizard.ps1"
