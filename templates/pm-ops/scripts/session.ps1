# 역할 세션을 백그라운드 Claude 세션으로 실행·멈춤·세션 교체(rotate)한다. pm 역할(wy-ops.json의 pmRole)이 실행한다.
#   session.ps1 list                    역할 세션 목록(VS Code 세션 포함)
#   session.ps1 health                  역할별 컨텍스트(토큰·MB)·마지막 활동, 세션 교체 권장 표시
#   session.ps1 start <역할> [지시]     멈춘 세션이 있으면 대화를 이어서, 없으면 역할 파일로 새로 시작한다
#                                       멈춘 세션의 컨텍스트가 세션 교체 기준(토큰) 이상이면 재시작하지 않고 rotate를 권한다(-Force로 강행)
#   session.ps1 stop <역할>             멈춘다. 대화는 남아 start로 이어진다
#   session.ps1 prep <역할>             세션 교체 준비: 진행 중인 것만 save-session으로 저장하라고 지시한다
#   session.ps1 rotate <역할> [경로]    세션 교체: 이전 세션을 멈추고 역할 파일(+인수인계 경로)로 새 세션을 시작한다
#   session.ps1 adopt <역할> <세션ID>   닫은 VS Code 세션의 대화를 백그라운드로 옮긴다
#   session.ps1 pm-cmd [경로]           pm 세션 교체용: 사용자가 새 터미널에 붙여 넣을 명령을 출력한다
#   session.ps1 pin <역할>              실행 중인 그 역할 세션을 고정 목록(~/.claude/jobs/pins.json)에 넣는다. 메모리 부족 정리에서 빠진다
#   session.ps1 unpin <역할>            고정 목록에서 뺀다. pin·unpin 모두 멈춘·없는 세션의 id를 목록에서 정리한다
#                                       start·rotate는 고정하지 않는다. 허용 규칙 한 줄로 이 명령만 열기 위해 pm이 따로 부른다
param([Parameter(Mandatory)][ValidateSet('list','health','start','stop','prep','rotate','adopt','pm-cmd','pin','unpin')][string]$Cmd, [string]$Role, [string]$Prompt, [switch]$Force)

# claude.exe가 stderr로 진행 문구를 내면 PowerShell 5.1이 'Stop'에서 오류로 끊어 버려 백그라운드 시작이 실패한다
$ErrorActionPreference = 'Continue'
# 저장소 = 이 스크립트(.claude/skills/pm-ops/scripts/)에서 네 단계 위
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path

# 역할 이름은 프로젝트 설정(.claude/wy-ops.json, PC별 덮어쓰기 .claude/wy-ops.local.json)에서만 온다. 아래는 설정에 없는 값의 기본값이다
$Roles = @()
$PmRole = $null
# 역할 이름을 바꾼 프로젝트의 옛 이름(handoff.oldNames). 옛 인수인계 파일을 찾을 때만 쓴다
$OldNames = @{}
# 세션 교체 권장 기준: 현재 대화 토큰(마지막 응답의 input+cache_read+cache_creation). MB는 토큰을 못 읽을 때만 쓰는 호환 기준
$RotateTokens = 150000
$RotateMB = 5
$ProgressDoc = 'docs/진행현황.md'

# Get-Content는 PowerShell 5.1에서 BOM 없는 UTF-8을 ANSI로 읽으므로 .NET으로 읽는다
function Read-OpsJson($path) {
  if (-not (Test-Path $path)) { return $null }
  try { [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
  catch { Write-Warning "설정을 읽지 못해 기본값을 씁니다: $path"; $null }
}
# 객체는 키별로 합치고 값·배열은 덮어쓴다
function Merge-Ops($base, $over) {
  if (-not $over) { return $base }
  foreach ($p in $over.PSObject.Properties) {
    $cur = $base.PSObject.Properties[$p.Name]
    if ($cur -and $cur.Value -is [pscustomobject] -and $p.Value -is [pscustomobject]) { $null = Merge-Ops $cur.Value $p.Value }
    else { $base | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value -Force }
  }
  $base
}
$Ops = Read-OpsJson "$Repo\.claude\wy-ops.json"
if ($Ops) {
  $Ops = Merge-Ops $Ops (Read-OpsJson "$Repo\.claude\wy-ops.local.json")
  if ($Ops.roles) { $Roles = @($Ops.roles | Where-Object { $_.agent -ne $false } | ForEach-Object { $_.name }) }
  if ($Ops.pmRole) { $PmRole = $Ops.pmRole }
  if ($Ops.handoff.oldNames) { $OldNames = @{}; foreach ($p in $Ops.handoff.oldNames.PSObject.Properties) { $OldNames[$p.Name] = $p.Value } }
  if ($Ops.rotation.transcriptMB) { $RotateMB = $Ops.rotation.transcriptMB }
  if ($Ops.rotation.contextTokens) { $RotateTokens = $Ops.rotation.contextTokens }
  if ($Ops.docs.progress) { $ProgressDoc = $Ops.docs.progress }
}
if (-not $Roles.Count -or -not $PmRole) { throw "프로젝트 설정 $Repo\.claude\wy-ops.json에 roles·pmRole이 없습니다(install.ps1 init으로 만듭니다)" }
# Claude Code는 대화 기록 폴더 이름을 저장소 경로의 영문·숫자 외 문자를 '-'로 바꿔 만든다(Windows는 대소문자 무시)
$Transcripts = "$env:USERPROFILE\.claude\projects\" + ($Repo -replace '[^A-Za-z0-9]', '-')
if ($Cmd -notin 'list','health','pm-cmd' -and $Role -notin $Roles) { throw "역할 이름이 아닙니다: $Role (예: $($Roles[-1]))" }

# PowerShell 5.1의 ConvertFrom-Json은 JSON 배열을 한 덩어리로 넘기므로 괄호로 풀어서 넘긴다
function Get-Sessions { (claude agents --json --all 2>$null | ConvertFrom-Json) | ForEach-Object { $_ } }
function Get-Bg($name) {
  Get-Sessions | Where-Object { $_.kind -eq 'background' -and $_.name -eq $name } | Sort-Object startedAt -Descending | Select-Object -First 1
}
# 멈춘 세션은 state가 stopped·done·failed로 나온다
function Test-Running($s) { $s.state -notin 'stopped','done','failed' }
function Get-Transcript($s) { if ($s) { Get-Item "$Transcripts\$($s.sessionId).jsonl" -ErrorAction SilentlyContinue } }
# 현재 대화 토큰: 기록 끝 1MB에서 마지막 assistant 응답의 usage를 더한다(대시보드·대화 크기 훅과 같은 기준). 못 읽으면 $null
function Get-ContextTokens($t) {
  if (-not $t) { return $null }
  try {
    $fs = [IO.File]::Open($t.FullName, 'Open', 'Read', 'ReadWrite')
    try {
      $len = [math]::Min($fs.Length, 1MB); $buf = New-Object byte[] $len
      $null = $fs.Seek(-$len, 'End'); $null = $fs.Read($buf, 0, $len)
    } finally { $fs.Close() }
    $lines = [Text.Encoding]::UTF8.GetString($buf) -split "`n"
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
      $l = $lines[$i]
      if ($l -notmatch '"type":"assistant"' -or $l -match '"isSidechain":true') { continue }
      $n = 0
      foreach ($k in 'input_tokens','cache_read_input_tokens','cache_creation_input_tokens') { if ($l -match ('"' + $k + '":(\d+)')) { $n += [int64]$Matches[1] } }
      if ($n -gt 0) { return $n }
    }
  } catch { }
  $null
}
function Test-Rotate($tok, $mb) { if ($tok) { $tok -ge $RotateTokens } else { $mb -ge $RotateMB } }
function Get-Handoff($name) {
  foreach ($n in @($name, $OldNames[$name]) | Where-Object { $_ }) {
    $f = Get-ChildItem "$env:USERPROFILE\.claude\session-data" -Filter "*-$n*-session.tmp" -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^\d{4}-\d{2}-\d{2}-$n(-\d+)?-session\.tmp$" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f) { return $f }
  }
}
# 새 세션: 역할 파일(.claude/agents/<역할>.md)을 --agent로 싣는다. 인수인계 경로가 있으면 그것부터 불러온다
function Start-New($name, $handoff) {
  $first = if ($handoff) { "/ecc:resume-session $($handoff -replace '\\','/')" }
           else { "[$PmRole] 새 세션입니다. 역할 파일 지시대로 CLAUDE.md와 $($ProgressDoc)(역할별 다음 할 일의 내 줄)를 읽고, $($PmRole)에 SendMessage로 '$name 시작, 다음 할 일: …' 한 줄을 보낸 뒤 지시를 기다리세요." }
  Push-Location $Repo; try { claude --bg --agent $name --name $name $first } finally { Pop-Location }
}

switch ($Cmd) {
  'list' {
    Get-Sessions | Sort-Object name | Format-Table name, kind, @{n='상태';e={ if ($_.status) { $_.status } else { $_.state } }}, id -AutoSize
  }
  'health' {
    $all = Get-Sessions
    $(foreach ($r in $Roles) {
      $s = $all | Where-Object { $_.kind -eq 'background' -and $_.name -eq $r } | Sort-Object startedAt -Descending | Select-Object -First 1
      $t = Get-Transcript $s
      $mb = if ($t) { [math]::Round($t.Length / 1MB, 1) } else { 0 }
      $tok = Get-ContextTokens $t
      [pscustomobject]@{ 역할 = $r; 상태 = if ($s) { $s.state } else { '없음' }
        '대화(k토큰)' = if ($tok) { [math]::Round($tok / 1000) } else { '-' }; '대화(MB)' = $mb
        '마지막 활동' = if ($t) { $t.LastWriteTime.ToString('MM-dd HH:mm') } else { '-' }
        권장 = if (Test-Rotate $tok $mb) { '세션 교체' } else { '' } }
    }) | Format-Table -AutoSize
    "세션 교체 기준: 컨텍스트 $([math]::Round($RotateTokens / 1000))k 토큰(토큰을 못 읽으면 $($RotateMB)MB). 기준 미만 대기 세션은 다음 작업에 이어 쓰고, 이상이면 rotate."
  }
  'start' {
    $s = Get-Bg $Role
    if ($s -and (Test-Running $s)) { "$Role 은 이미 실행 중입니다($($s.id))."; break }
    # 대화 기록이 없는 항목은 이어 띄울 수 없다("source session not found"). 역할 파일로 새로 띄운다
    if (-not $s -or -not (Get-Transcript $s)) {
      if ($s) { claude rm $s.id | Out-Null }
      Start-New $Role (Get-Handoff $Role).FullName
      if ($Prompt) { "새 세션으로 띄웠습니다. 지시는 '시작' 회신을 받은 뒤 SendMessage로 보내세요." }
      break
    }
    # 멈춘 큰 세션을 이어 띄우면 캐시가 만료돼 대화 전체를 다시 쓴다(새로 띄우는 것보다 비쌈). 기준 이상이면 rotate를 권한다
    $t = Get-Transcript $s; $tok = Get-ContextTokens $t
    if (-not $Force -and (Test-Rotate $tok ([math]::Round($t.Length / 1MB, 1)))) {
      $size = if ($tok) { "$([math]::Round($tok / 1000))k 토큰" } else { "$([math]::Round($t.Length / 1MB, 1))MB" }
      "$Role 의 멈춘 세션 컨텍스트가 세션 교체 기준 이상입니다($size). 재시작하지 않았습니다."
      "새로 시작하세요: session.ps1 rotate $Role none (진행 중인 일이 있으면 인수인계 경로). 그래도 재시작하려면 -Force."
      break
    }
    if (-not $Prompt) { $Prompt = "[$PmRole] 세션을 다시 띄웠습니다. CLAUDE.md·$($ProgressDoc)에서 바뀐 점을 확인하고 지시를 기다리세요." }
    # 지시를 넘겨 이어 띄운다. 지시 없이 띄우면 빈 사본이 생겨 다음에 실패한다
    # PowerShell 5.1은 큰따옴표를 실행 파일 인자로 제대로 넘기지 못하므로 작은따옴표로 바꾼다
    $Prompt = $Prompt -replace '"', "'"
    Push-Location $Repo; try { claude --bg --resume $s.sessionId --name $Role $Prompt } finally { Pop-Location }
    $n = Get-Bg $Role
    if ($n -and $n.sessionId -ne $s.sessionId) { claude rm $s.id | Out-Null }
  }
  'stop' {
    $s = Get-Bg $Role
    if (-not $s -or -not (Test-Running $s)) { "$Role 백그라운드 세션이 실행 중이 아닙니다."; break }
    claude stop $s.id
  }
  'prep' {
    $msg = "[$PmRole 세션 교체 준비] 컨텍스트가 길어져 새 세션으로 교체합니다. 지금 하던 일을 멈출 수 있는 지점까지만 마무리하고, 진행 중인 것(미커밋 파일, 반쯤 한 작업, 막힌 이유)만 /ecc:save-session 으로 저장하세요. short-id는 $Role (같은 날 두 번째면 $Role-2). 역할 설명과 끝난 일은 적지 마세요. 진행 중인 것이 하나도 없으면 저장하지 말고 '진행 중 없음'이라고만 알리세요. 끝나면 $($PmRole)에 SendMessage로 저장 경로 또는 '진행 중 없음' 한 줄."
    $s = Get-Bg $Role
    if ($s -and (Test-Running $s)) { "실행 중인 세션입니다. 이 문구를 SendMessage로 보내세요:"; $msg; break }
    if (-not $s) { "$Role 세션이 없습니다. 세션 교체 없이 start 하세요."; break }
    Push-Location $Repo; try { claude --bg --resume $s.sessionId --name $Role $msg } finally { Pop-Location }
  }
  'rotate' {
    $s = Get-Bg $Role
    if ($s -and (Test-Running $s)) { claude stop $s.id | Out-Null }
    if ($s) { claude rm $s.id | Out-Null }   # 작업 항목만 지운다. 대화 기록 파일은 남는다
    $h = if ($Prompt -and $Prompt -ne 'none') { $Prompt } else { $null }
    Start-New $Role $h
    "세션을 교체했습니다. 새 세션이 '시작' 또는 인계 확인을 보내면 '멈춰 있는 동안 끝난 일'을 SendMessage로 알려 주세요."
  }
  'adopt' {
    if (-not $Prompt) { throw '세션ID가 필요합니다.' }
    # 지시 없이 이어 띄우면 빈 사본이 생기므로 한 줄 지시를 넘긴다. 끝나면 stop
    $hello = "[$PmRole] 이 세션을 $Role 이름의 백그라운드 세션으로 옮겼습니다. 답은 '옮김 확인' 한 줄만 하고 다른 작업은 하지 마세요."
    Push-Location $Repo; try { claude --bg --resume $Prompt --name $Role $hello } finally { Pop-Location }
    "옮겼습니다. 답을 마치면 session.ps1 stop $Role 로 멈추세요."
  }
  'pm-cmd' {
    $h = if ($Prompt) { $Prompt } else { (Get-Handoff $PmRole).FullName }
    if (-not $h) { throw "$PmRole 인수인계 파일이 없습니다. 먼저 /ecc:save-session (short-id $PmRole)을 실행하세요." }
    "아래 한 줄을 새 터미널(또는 VS Code 새 Claude 패널)에서 실행하면 $($PmRole)이 이어집니다. 이전 pm 창은 닫으세요."
    # 기본 실행 정책에서는 npm의 claude.ps1이 막히므로 claude.cmd로 부른다
    "cd $Repo; claude.cmd --name $PmRole `"/ecc:resume-session $($h -replace '\\','/')`""
  }
  { $_ -in 'pin','unpin' } {
    $pinFile = "$env:USERPROFILE\.claude\jobs\pins.json"
    $all = @(Get-Sessions)
    $pins = @()
    if (Test-Path $pinFile) {
      try { $pins = @([IO.File]::ReadAllText($pinFile, [Text.Encoding]::UTF8) | ConvertFrom-Json | ForEach-Object { $_ }) }
      catch { throw "고정 목록을 읽지 못했습니다: $pinFile" }
    }
    # 멈춘 세션·없는 세션의 id는 정리한다
    $live = @($all | Where-Object { Test-Running $_ } | ForEach-Object { $_.id })
    $kept = @($pins | Where-Object { $_ -in $live })
    $s = $all | Where-Object { $_.kind -eq 'background' -and $_.name -eq $Role } | Sort-Object startedAt -Descending | Select-Object -First 1
    if ($Cmd -eq 'pin') {
      if (-not $s -or -not (Test-Running $s)) { throw "$Role 백그라운드 세션이 실행 중이 아닙니다. start 뒤에 pin 하세요." }
      if ($s.id -notin $kept) { $kept += $s.id }
    } elseif ($s) { $kept = @($kept | Where-Object { $_ -ne $s.id }) }
    # PowerShell 5.1의 ConvertTo-Json은 원소 하나짜리 배열을 문자열로 내보내므로 직접 만든다. BOM 없는 UTF-8
    $json = '[' + (($kept | ForEach-Object { '"' + $_ + '"' }) -join ',') + ']'
    [IO.File]::WriteAllText($pinFile, $json, (New-Object Text.UTF8Encoding $false))
    $gone = @($pins | Where-Object { $_ -notin $kept -and (-not $s -or $_ -ne $s.id) })
    "$Cmd $Role 완료. 고정 목록: $json" + $(if ($gone.Count) { " (멈춘 세션 정리: $($gone -join ', '))" } else { '' })
  }
}
