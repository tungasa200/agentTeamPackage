# WY Ops 설치 진입점(Windows PowerShell 5.1). 본체는 lib/install.js다.
# 사용(패키지 저장소 clone 폴더나 설치본에서):
#   powershell -ExecutionPolicy Bypass -File install.ps1 global | setup | init … | doctor | update | deploy [--dev] | rollback [버전] | export | import <zip> | restore <zip>
# 시작할 때 필수 환경(Node LTS, Git, GitHub CLI, Claude Code, VS Code)을 확인한다. 빠진 것은 목록을 보여 주고
# 한 번 확인받은 뒤 winget(Claude Code는 npm)으로 설치한다. Node가 없으면 lib/*.js를 돌릴 수 없어서 이 단계는 PowerShell에서 한다.
#   --yes            확인 없이 설치
#   --skip-install   확인만 하고 설치하지 않음(빠진 것이 있으면 멈춤)
# 이 파일은 UTF-8(BOM 포함)로 저장한다. PowerShell 5.1은 BOM 없는 .ps1을 ANSI 코드 페이지로 읽어 한글이 깨진다.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$yes = $args -contains '--yes'
$skipInstall = $args -contains '--skip-install'

function Update-PathFromRegistry {
  # 방금 설치한 도구가 이 창에서 바로 보이게 PATH를 레지스트리에서 다시 읽는다
  if ($env:WY_OPS_KEEP_PATH) { return }  # 시험용: 가짜 도구 PATH를 유지
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

function Test-Tool([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Test-NodeOk {
  if (-not (Test-Tool 'node')) { return $false }
  $v = (& node -v 2>$null) -replace '^v', ''
  $major = 0
  [void][int]::TryParse(($v -split '\.')[0], [ref]$major)
  return $major -ge 18
}

# 이름, 있는지 확인, 설치 방법(winget id 또는 npm 패키지)
$tools = @(
  @{ Name = 'Node.js LTS(18 이상)'; Ok = { Test-NodeOk }; Winget = 'OpenJS.NodeJS.LTS' },
  @{ Name = 'Git'; Ok = { Test-Tool 'git' }; Winget = 'Git.Git' },
  @{ Name = 'GitHub CLI(gh)'; Ok = { Test-Tool 'gh' }; Winget = 'GitHub.cli' },
  @{ Name = 'VS Code(code)'; Ok = { Test-Tool 'code' }; Winget = 'Microsoft.VisualStudioCode' },
  @{ Name = 'Claude Code(claude)'; Ok = { Test-Tool 'claude' }; Npm = '@anthropic-ai/claude-code' }
)

$missing = @($tools | Where-Object { -not (& $_.Ok) })
if ($missing.Count -gt 0) {
  Write-Output '필수 환경 중 없는 것:'
  foreach ($t in $missing) {
    $how = if ($t.Winget) { "winget install -e --id $($t.Winget)" } else { "npm install -g $($t.Npm)" }
    Write-Output "  - $($t.Name)  ($how)"
  }
  if ($skipInstall) {
    Write-Output '설치를 건너뜁니다(--skip-install). 위 도구를 설치한 뒤 다시 실행하세요.'
    exit 1
  }
  if (-not (Test-Tool 'winget')) {
    Write-Output 'winget이 없습니다. Microsoft Store에서 "앱 설치 관리자"를 설치하거나 위 도구를 직접 설치한 뒤 다시 실행하세요.'
    exit 1
  }
  if (-not $yes) {
    $a = Read-Host '위 도구를 설치할까요? [y/N]'
    if ($a -notmatch '^\s*y') {
      Write-Output '설치하지 않았습니다. 위 도구를 설치한 뒤 다시 실행하세요.'
      exit 1
    }
  }
  # winget 먼저(Node가 있어야 npm으로 Claude Code를 깐다)
  foreach ($t in ($missing | Where-Object { $_.Winget })) {
    Write-Output "설치: $($t.Name)"
    & winget install -e --id $t.Winget --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Output "  설치 실패($LASTEXITCODE): $($t.Name)" }
  }
  Update-PathFromRegistry
  foreach ($t in ($missing | Where-Object { $_.Npm })) {
    if (-not (Test-Tool 'npm')) { Write-Output "  npm이 없어 $($t.Name)을 설치하지 못했습니다(Node.js 설치 확인)"; continue }
    Write-Output "설치: $($t.Name)"
    & npm install -g $t.Npm
    if ($LASTEXITCODE -ne 0) { Write-Output "  설치 실패($LASTEXITCODE): $($t.Name)" }
  }
  Update-PathFromRegistry
  $still = @($tools | Where-Object { -not (& $_.Ok) })
  if ($still.Count -gt 0) {
    Write-Output "아직 없는 것: $(($still | ForEach-Object { $_.Name }) -join ', '). 새 터미널을 열어 다시 실행하거나 직접 설치하세요."
    exit 1
  }
  Write-Output '필수 환경을 모두 설치했습니다.'
}

$fwd = @($args | Where-Object { $_ -ne '--skip-install' })
& node (Join-Path $PSScriptRoot 'lib\install.js') @fwd
exit $LASTEXITCODE
