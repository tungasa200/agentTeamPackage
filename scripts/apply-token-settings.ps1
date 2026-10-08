# Token saving, round 2 (user decision 2026-10-07). Run from the repository root AFTER the commit that adds
# vscode/hooks/wy-context-size.js (deploy copies HEAD, not the working tree). Safe to run more than once.
#   powershell -ExecutionPolicy Bypass -File tools\wy-ops\scripts\apply-token-settings.ps1          (show, then apply)
#   ... apply-token-settings.ps1 -Plan                                                              (show only)
# 1) install.ps1 deploy  2) .claude/settings.json env CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000
# 3) .claude/settings.local.json Stop hook wy-context-size.js. Existing keys are kept; a .bak-<time> copy is written.
# This file is ASCII only on purpose: PowerShell 5.1 reads BOM-less .ps1 files in the ANSI code page.
param([switch]$Plan)
$ErrorActionPreference = 'Stop'
$Pkg = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Repo = (Resolve-Path (Join-Path $Pkg '..\..')).Path
if (-not $Plan) {
  & node (Join-Path $Pkg 'lib\install.js') deploy
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$mode = if ($Plan) { 'plan' } else { 'apply' }
& node (Join-Path $Pkg 'lib\tokenSettings.js') $mode $Repo
exit $LASTEXITCODE
