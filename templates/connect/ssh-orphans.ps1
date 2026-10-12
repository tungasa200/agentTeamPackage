# ssh-orphans.ps1: VS Code Remote-SSH가 끊긴 뒤 남은 PowerShell 묶음 판정·정리.
#   기본은 판정만(아무것도 끄지 않음). -Stop일 때만 후보를 끈다(관리자 필요: 묶음이 관리자 SSH 로그인 소유).
# 묶음 = 부모가 PowerShell이 아닌 맨 위 powershell.exe와 그 자손 전체. code-*.exe가 들어 있는 묶음만 본다.
# 남김(reason): live-ssh(살아 있는 sshd-session 아래) / parent-alive:<이름> / server(cli\servers\*\pid.txt 서버를 품음) /
#   agent-host-supervisor(code CLI 아래 code CLI가 있는 묶음 중 가장 늦게 생긴 것) /
#   has-worker(자손에 껍데기(powershell·conhost·code CLI) 말고 다른 프로세스가 있음) / too-new(MinAgeMinutes 안)
# 정리 후보: 부모 없는 묶음 중 위에 안 걸린 것.
# -Json: 표시용(doctor·세션 현황). 스키마 {admin, now, minAgeMinutes, serverPids[], chains[{verdict,reason,rootPid,pids[],created,mb}],
#   candidates{count,mb}, stopped[{pid,name,ok}]|null, stoppedChains{count,mb}|null}
#   stoppedChains: -Stop에서 다시 판정해도 후보라 실제로 끄기 시작한 묶음 수·MB(세션 현황 [정리]·자동 정리 결과 한 줄, 0.11.0)
# -FixtureJson <파일>: 시험용. 파일 {now, serverPids[], processes[{ProcessId,ParentProcessId,Name,CreationDate,WorkingSetSize}]}을
#   지금 프로세스 대신 쓴다. -Stop과 함께 주면 끄지 않고 끌 순서만 stopped에 적는다.
param(
  [int]$MinAgeMinutes = 30,
  [switch]$Json,
  [switch]$Stop,
  [string]$FixtureJson
)
$ErrorActionPreference = 'Stop'

function Read-State {
  if ($FixtureJson) {
    $f = [IO.File]::ReadAllText($FixtureJson) | ConvertFrom-Json
    $procs = @($f.processes | ForEach-Object {
      [pscustomobject]@{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; Name = [string]$_.Name
        CreationDate = [datetime]$_.CreationDate; WorkingSetSize = [long]$_.WorkingSetSize }
    })
    return @{ procs = $procs; servers = @($f.serverPids | ForEach-Object { [int]$_ }); now = [datetime]$f.now }
  }
  $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } |
    Select-Object ProcessId, ParentProcessId, Name, CreationDate, WorkingSetSize)
  $servers = @(Get-ChildItem "$HOME\.vscode-server\cli\servers\*\pid.txt" -ErrorAction SilentlyContinue |
    ForEach-Object { $t = (Get-Content $_.FullName -Raw); if ($t -match '^\s*(\d+)') { [int]$Matches[1] } })
  return @{ procs = $procs; servers = $servers; now = Get-Date }
}

function Get-Verdicts($state) {
  $all = $state.procs
  $by = @{}; foreach ($p in $all) { $by[[int]$p.ProcessId] = $p }
  # PID 재사용 방지: 부모는 자식보다 먼저 생겨야 부모로 본다
  $parentOf = { param($p) $par = $by[[int]$p.ParentProcessId]; if ($par -and $par.CreationDate -le $p.CreationDate -and $par -ne $p) { $par } }
  $kids = @{}
  foreach ($p in $all) {
    $par = & $parentOf $p
    if ($par) { $k = [int]$par.ProcessId; if (-not $kids.ContainsKey($k)) { $kids[$k] = New-Object System.Collections.ArrayList }; [void]$kids[$k].Add($p) }
  }
  $isCode = { param($p) $p.Name -like 'code-*.exe' }
  $shell = @('powershell.exe', 'conhost.exe')

  $chains = @()
  foreach ($p in $all) {
    if ($p.Name -ne 'powershell.exe') { continue }
    $par = & $parentOf $p
    if ($par -and $par.Name -eq 'powershell.exe') { continue }   # 맨 위만
    # 자손을 깊이와 함께 모은다(끌 때 깊은 것부터)
    $sub = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($p, 0))
    while ($queue.Count) {
      $item = $queue.Dequeue(); [void]$sub.Add([pscustomobject]@{ P = $item[0]; Depth = $item[1] })
      $k = [int]$item[0].ProcessId
      if ($kids.ContainsKey($k)) { foreach ($c in $kids[$k]) { $queue.Enqueue(@($c, ($item[1] + 1))) } }
    }
    if (-not ($sub | Where-Object { & $isCode $_.P })) { continue }   # VS Code 묶음 아님
    $chains += [pscustomobject]@{ Root = $p; Parent = $par; Sub = $sub; Created = $p.CreationDate
      MB = [int](($sub | ForEach-Object { $_.P.WorkingSetSize } | Measure-Object -Sum).Sum / 1MB) }
  }

  $supervisor = $chains | Where-Object {
    $_.Sub | Where-Object { (& $isCode $_.P) -and ($pp = & $parentOf $_.P) -and (& $isCode $pp) }
  } | Sort-Object Created | Select-Object -Last 1

  foreach ($c in $chains) {
    $ids = @($c.Sub | ForEach-Object { [int]$_.P.ProcessId })
    $reason = $null
    if ($c.Parent -and $c.Parent.Name -eq 'sshd-session.exe') { $reason = 'live-ssh' }
    elseif ($c.Parent) { $reason = "parent-alive:$($c.Parent.Name)" }
    elseif ($state.servers | Where-Object { $ids -contains $_ }) { $reason = 'server' }
    elseif ($supervisor -and $c.Root.ProcessId -eq $supervisor.Root.ProcessId) { $reason = 'agent-host-supervisor' }
    elseif ($c.Sub | Where-Object { ($shell -notcontains $_.P.Name) -and -not (& $isCode $_.P) }) { $reason = 'has-worker' }
    elseif (($state.now - $c.Created).TotalMinutes -lt $MinAgeMinutes) { $reason = 'too-new' }
    [pscustomobject]@{
      verdict = $(if ($reason) { 'keep' } else { 'candidate' })
      reason  = $reason
      rootPid = [int]$c.Root.ProcessId
      pids    = $ids
      created = $c.Created.ToString('s')
      mb      = $c.MB
      # 끌 순서: 깊은 것부터, 같은 깊이면 늦게 생긴 것부터
      order   = @($c.Sub | Sort-Object @{ e = { $_.Depth }; Descending = $true }, @{ e = { $_.P.CreationDate }; Descending = $true } |
        ForEach-Object { [pscustomobject]@{ pid = [int]$_.P.ProcessId; name = $_.P.Name; created = $_.P.CreationDate } })
    }
  }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$state = Read-State
$verdicts = @(Get-Verdicts $state)
$cand = @($verdicts | Where-Object verdict -eq 'candidate')
$stopped = $null
$stoppedChains = $null

if ($Stop) {
  $stopped = @()
  $stoppedChains = [pscustomobject]@{ count = 0; mb = 0 }
  if (-not $FixtureJson -and -not $admin) {
    [Console]::Error.WriteLine('정리는 관리자 권한이 필요합니다(남은 묶음이 관리자 SSH 로그인 소유). 관리자 PowerShell에서 다시 실행하세요.')
  } else {
    # 끄기 직전 다시 판정: 두 번 다 후보인 묶음만(그사이 다시 쓰이기 시작한 묶음은 건드리지 않는다)
    $again = @(Get-Verdicts (Read-State) | Where-Object verdict -eq 'candidate')
    foreach ($c in $cand) {
      if (-not ($again | Where-Object { $_.rootPid -eq $c.rootPid -and $_.created -eq $c.created })) { continue }
      $stoppedChains.count++; $stoppedChains.mb += $c.mb
      foreach ($o in $c.order) {
        $ok = $true
        if (-not $FixtureJson) {
          # PID 재사용 확인: 같은 pid·같은 생성 시각일 때만 끈다
          $now = Get-CimInstance Win32_Process -Filter "ProcessId=$($o.pid)" -ErrorAction SilentlyContinue
          if (-not $now -or $now.CreationDate -ne $o.created) { continue }
          try { Stop-Process -Id $o.pid -Force -ErrorAction Stop } catch { $ok = $false }
        }
        $stopped += [pscustomobject]@{ pid = $o.pid; name = $o.name; ok = $ok }
      }
    }
  }
}

$out = [pscustomobject]@{
  admin         = $admin
  now           = $state.now.ToString('s')
  minAgeMinutes = $MinAgeMinutes
  serverPids    = @($state.servers)
  chains        = @($verdicts | Select-Object verdict, reason, rootPid, pids, created, mb)
  candidates    = [pscustomobject]@{ count = $cand.Count; mb = [int](($cand | Measure-Object mb -Sum).Sum) }
  stopped       = $stopped
  stoppedChains = $stoppedChains
}
if ($Json) {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $out | ConvertTo-Json -Depth 5 -Compress
} else {
  $out.chains | Sort-Object verdict, created | Select-Object verdict, reason, rootPid, created, mb, @{ n = 'pids'; e = { $_.pids -join ',' } } |
    Format-Table -AutoSize | Out-String -Width 200
  "server pid.txt: $($out.serverPids -join ',')"
  "candidates: $($out.candidates.count), $($out.candidates.mb) MB"
  if ($Stop) { "stopped: $(@($stopped | Where-Object ok).Count) ok, $(@($stopped | Where-Object { -not $_.ok }).Count) failed" }
  else { '(판정만, 끄지 않음. 정리는 관리자 PowerShell에서 -Stop)' }
}
