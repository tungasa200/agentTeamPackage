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
#   session.ps1 attach <역할>           실행 중인 그 역할 백그라운드 세션에 붙는다(claude attach <id>, 원격 접속용). pm 역할도 된다
#   session.ps1 start-pm [경로]         pm 역할을 백그라운드 세션으로 띄운다(역할 파일 없음: pm-ops 스킬·인수인계 경로·ListAgents 확인을 시작 지시로).
#                                       이미 백그라운드 pm이 실행 중이면 거부한다. pm 세션 교체 중이면 -Force(새 pm을 띄운 뒤 이전 pm을 멈추라고 알려 줌)
param([Parameter(Mandatory)][ValidateSet('list','health','start','stop','prep','rotate','adopt','pm-cmd','pin','unpin','attach','start-pm')][string]$Cmd, [string]$Role, [string]$Prompt, [switch]$Force)

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
if ($Cmd -notin 'list','health','pm-cmd','start-pm' -and $Role -notin $Roles -and -not ($Cmd -eq 'attach' -and $Role -eq $PmRole)) { throw "역할 이름이 아닙니다: $Role (예: $($Roles[-1]))" }

# PowerShell 5.1의 ConvertFrom-Json은 JSON 배열을 한 덩어리로 넘기므로 괄호로 풀어서 넘긴다
function Get-Sessions { (claude agents --json --all 2>$null | ConvertFrom-Json) | ForEach-Object { $_ } }
function Get-Bg($name) {
  Get-Sessions | Where-Object { $_.kind -eq 'background' -and $_.name -eq $name } | Sort-Object startedAt -Descending | Select-Object -First 1
}
# 살아 있는 세션(프로세스가 있는 것)에만 pid·status가 붙는다. state로 보지 않는다: 턴을 마치고 쉬는 백그라운드 세션도 state=done을 낸다
function Test-Running($s) { $null -ne $s.pid }
function Get-State($s) { if (Test-Running $s) { $s.status } else { $s.state } }
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
# 백그라운드 세션은 클라이언트가 아니라 claude daemon이 띄우고, daemon의 로그온을 그대로 물려받는다(D-166, 2026-10-10 실측).
# ssh 키 로그인은 비밀번호 없는 네트워크 로그온(유형 3)이라 거기서 뜬 daemon 아래 세션은 Windows 자격 증명 관리자를 못 읽어 git push·gh가 실패한다.
# 그래서 원격 호스트는 바탕화면 로그온(유형 2)에서 daemon을 띄워 둔다: install.ps1 host가 만드는 로그온 예약 작업(아래 $DaemonTask, claude daemon run).
# 띄우기 전에 daemon을 본다: 없으면 그 작업을 먼저 시작해 ssh 쪽 claude가 네트워크 로그온 daemon을 띄우지 않게 하고, 네트워크 로그온 daemon이면 경고한다.
# WY_OPS_DAEMON_LOCK·WY_OPS_DAEMON_TASK·WY_OPS_DAEMON_NAME은 시험용(실제 daemon·작업을 건드리지 않게)
$DaemonTask = if ($env:WY_OPS_DAEMON_TASK) { $env:WY_OPS_DAEMON_TASK } else { 'wy-ops-claude-daemon' }
$DaemonLock =if ($env:WY_OPS_DAEMON_LOCK) { $env:WY_OPS_DAEMON_LOCK } else { "$env:USERPROFILE\.claude\daemon.lock" }
$DaemonName = if ($env:WY_OPS_DAEMON_NAME) { $env:WY_OPS_DAEMON_NAME } else { 'claude.exe' }
function Get-DaemonProc {
  try { $id = ([IO.File]::ReadAllText($DaemonLock) | ConvertFrom-Json).pid } catch { return $null }
  if (-not $id) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$id)" -ErrorAction SilentlyContinue
  # daemon이 죽은 뒤 같은 pid를 다른 프로그램이 받았으면 daemon 없음으로 본다
  if ($p -and $p.Name -eq $DaemonName) { $p }
}
function Test-Daemon {
  $p = Get-DaemonProc
  if (-not $p -and (Get-ScheduledTask -TaskName $DaemonTask -ErrorAction SilentlyContinue)) {
    Start-ScheduledTask -TaskName $DaemonTask -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(30)
    while (-not $p -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; $p = Get-DaemonProc }
    if (-not $p) { Write-Warning "로그온 작업 $DaemonTask 을 시작했지만 30초 안에 claude daemon이 뜨지 않았습니다. 이대로 띄우면 이 로그온에서 daemon이 뜰 수 있습니다." }
  }
  if (-not $p) { return }
  # 로그온 유형 2 대화형, 10 원격 대화형, 11 캐시 대화형이면 자격 증명 관리자를 읽는다
  $t = (Get-CimAssociatedInstance -InputObject $p -ResultClassName Win32_LogonSession -ErrorAction SilentlyContinue).LogonType
  if ($t -and $t -notin 2, 10, 11) {
    Write-Warning ("claude daemon(pid $($p.ProcessId))이 바탕화면이 아닌 로그온(유형 $t, ssh 등)에서 돌고 있습니다. 여기서 띄운 세션은 git push·gh 인증이 실패합니다. " +
      "옮기기: 세션을 모두 멈춰도 되는 때 claude daemon stop --any → Start-ScheduledTask $DaemonTask → 역할 세션 다시 띄우기(MANUAL 3-5)")
  }
}
# claude가 0이 아닌 코드로 끝나면 throw(성공 문구를 내지 않게)
function Start-Bg([string[]]$argv) {
  Test-Daemon
  Push-Location $Repo; try { claude @argv; $code = $LASTEXITCODE } finally { Pop-Location }
  if ($code -ne 0) { throw "claude 백그라운드 시작 실패(종료 코드 $code). 위 출력을 확인하세요." }
}
# 새 세션: 역할 파일(.claude/agents/<역할>.md)을 --agent로 싣는다. 인수인계 경로가 있으면 그것부터 불러온다
function Start-New($name, $handoff) {
  $first = if ($handoff) { "/ecc:resume-session $($handoff -replace '\\','/')" }
           else { "[$PmRole] 새 세션입니다. 역할 파일 지시대로 CLAUDE.md와 $($ProgressDoc)(역할별 다음 할 일의 내 줄)를 읽고, $($PmRole)에 SendMessage로 '$name 시작, 다음 할 일: …' 한 줄을 보낸 뒤 지시를 기다리세요." }
  Start-Bg @('--bg', '--agent', $name, '--name', $name, $first)
}

switch ($Cmd) {
  'list' {
    Get-Sessions | Sort-Object name | Format-Table name, kind, @{n='상태';e={ Get-State $_ }}, id -AutoSize
  }
  'health' {
    $all = Get-Sessions
    $(foreach ($r in $Roles) {
      $s = $all | Where-Object { $_.kind -eq 'background' -and $_.name -eq $r } | Sort-Object startedAt -Descending | Select-Object -First 1
      $t = Get-Transcript $s
      $mb = if ($t) { [math]::Round($t.Length / 1MB, 1) } else { 0 }
      $tok = Get-ContextTokens $t
      [pscustomobject]@{ 역할 = $r; 상태 = if ($s) { Get-State $s } else { '없음' }
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
    Start-Bg @('--bg', '--resume', $s.sessionId, '--name', $Role, $Prompt)
    $n = Get-Bg $Role
    if ($n -and $n.sessionId -ne $s.sessionId) { claude rm $s.id | Out-Null }
  }
  'attach' {
    # id는 다시 띄울 때마다 바뀌므로 이름으로 찾는다. 빠져나와도 세션은 계속 돈다
    $s = Get-Bg $Role
    if (-not $s -or -not (Test-Running $s)) { "$Role 백그라운드 세션이 실행 중이 아닙니다. 먼저: session.ps1 start $Role"; break }
    claude attach $s.id
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
    Start-Bg @('--bg', '--resume', $s.sessionId, '--name', $Role, $msg)
  }
  'rotate' {
    $s = Get-Bg $Role
    if ($s -and (Test-Running $s)) { claude stop $s.id | Out-Null }
    if ($s) { claude rm $s.id | Out-Null }   # 작업 항목만 지운다. 대화 기록 파일은 남는다
    $h = if ($Prompt -and $Prompt -ne 'none') { $Prompt } else { $null }
    try { Start-New $Role $h }
    catch {
      $back = if ($s) { " 이전 $Role 세션은 이미 멈추고 목록에서 지웠습니다(대화 기록은 남음). 이어 띄우기: claude --bg --resume $($s.sessionId) --name $Role '<지시>'" } else { '' }
      throw "$($_.Exception.Message) 새 세션을 띄우지 못했습니다.$back"
    }
    "세션을 교체했습니다. 새 세션이 '시작' 또는 인계 확인을 보내면 '멈춰 있는 동안 끝난 일'을 SendMessage로 알려 주세요."
  }
  'adopt' {
    if (-not $Prompt) { throw '세션ID가 필요합니다.' }
    # 지시 없이 이어 띄우면 빈 사본이 생기므로 한 줄 지시를 넘긴다. 끝나면 stop
    $hello = "[$PmRole] 이 세션을 $Role 이름의 백그라운드 세션으로 옮겼습니다. 답은 '옮김 확인' 한 줄만 하고 다른 작업은 하지 마세요."
    Start-Bg @('--bg', '--resume', $Prompt, '--name', $Role, $hello)
    "옮겼습니다. 답을 마치면 session.ps1 stop $Role 로 멈추세요."
  }
  'pm-cmd' {
    # 경로는 두 번째 자리($Role)로 들어온다(pm-cmd는 역할을 받지 않음)
    $h = @($Prompt, $Role) | Where-Object { $_ } | Select-Object -First 1
    if (-not $h) { $h = (Get-Handoff $PmRole).FullName }
    if (-not $h) { throw "$PmRole 인수인계 파일이 없습니다. 먼저 /ecc:save-session (short-id $PmRole)을 실행하세요." }
    $hp = $h -replace '\\','/'
    "pm 세션 교체(원격 운용: pm은 호스트의 백그라운드 세션, 노트북을 닫아도 계속 돎):"
    "  1. 인수인계 저장(끝남): $hp"
    "  2. 새 pm 띄우기: & '$PSCommandPath' start-pm '$hp' -Force"
    "  3. 이전 pm 종료: 2가 알려 주는 대로(백그라운드면 claude stop <id>, 대화형 창이면 창 닫기). 이전 pm이 2를 실행했다면 3이 마지막 동작"
    "  4. 붙기: & '$PSCommandPath' attach $PmRole"
    "호스트 앞에서 대화형으로 이어 갈 때(예전 방식): 새 터미널에서 아래 한 줄, 이전 pm 창은 닫기"
    # 기본 실행 정책에서는 npm의 claude.ps1이 막히므로 claude.cmd로 부른다
    "  cd $Repo; claude.cmd --name $PmRole `"/ecc:resume-session $hp`""
  }
  'start-pm' {
    # 경로는 두 번째 자리($Role)로 들어온다. 'none'이나 빈 값이면 인수인계 없이 시작
    $h = @($Role, $Prompt) | Where-Object { $_ -and $_ -ne 'none' } | Select-Object -First 1
    if ($h -and -not (Test-Path $h)) { throw "인수인계 파일이 없습니다: $h" }
    $live = @(Get-Sessions | Where-Object { $_.name -eq $PmRole -and (Test-Running $_) })
    $bg = @($live | Where-Object { $_.kind -eq 'background' })
    if ($bg.Count -and -not $Force) { "$PmRole 백그라운드 세션이 이미 실행 중입니다($(($bg | ForEach-Object { $_.id }) -join ', ')). 띄우지 않았습니다. pm 세션 교체 중이면 -Force"; break }
    $load = if ($h) { "먼저 /ecc:resume-session $($h -replace '\\','/') 로 인수인계를 불러오고, " } else { "먼저 CLAUDE.md와 $($ProgressDoc)를 읽고, " }
    $first = "[$PmRole 시작] 이 세션은 호스트에서 백그라운드로 도는 $PmRole(개발 총괄)입니다. 사용자는 session.ps1 attach $PmRole 로 붙어 대화합니다. pm-ops 스킬을 따르세요. " +
             $load + "ListAgents로 실행 중인 역할 세션을 확인한 뒤 이어서 일하세요."
    # PowerShell 5.1은 큰따옴표를 실행 파일 인자로 제대로 넘기지 못하므로 작은따옴표로 바꾼다
    $first = $first -replace '"', "'"
    Start-Bg @('--bg', '--name', $PmRole, $first)
    "백그라운드 $PmRole 을 띄웠습니다. 붙기: session.ps1 attach $PmRole"
    foreach ($o in $live) {
      if ($o.kind -eq 'background') { "이전 $PmRole 을 멈추세요: claude stop $($o.id)" } else { "이전 $PmRole 대화형 세션($($o.id))의 창을 닫으세요" }
    }
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
