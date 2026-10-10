# 접속 PC의 호스트 제어 창(0.8.2): 깨우기·재우기·재부팅·종료·pm 새로 띄우기·pm에 붙기, 위에 호스트 응답·pm 상태.
# install.ps1 connect <별칭> --folder <호스트 폴더> --attach <pm 역할>이 ~\.wy-tools\connect\에 복사하고 바탕화면 '<별칭> 제어' 바로가기를 만든다.
# 추가 설치 없음(Windows PowerShell 5.1 + WinForms). ssh는 connect가 준비한 공개키 로그인만(BatchMode, 암호를 묻지 않음) 쓴다.
#   -DryRun    창은 띄우되 버튼이 명령을 실행하지 않고 아래 기록 칸에 명령 문자열만 적는다
#   -SelfTest  창 없이 각 버튼의 명령 문자열을 출력하고 끝낸다(시험용)
#   -AttachOnly 창 없이 '⑥ pm에 붙기'만 하고 끝낸다('<별칭> <역할>' 바로가기, 0.8.5). 실패하면 메시지 상자
#   -Code      VS Code 실행 파일(기본: code.cmd 옆 Code.exe)
# 깨우기(매직 패킷, UDP 9 브로드캐스트)는 호스트와 같은 네트워크(집 안)에서만 닿는다. MAC·브로드캐스트 주소는 호스트가 깨어 있을 때
# 상태 확인이 읽어 <별칭>.json에 저장해 두고, 잠든 동안은 그 값을 쓴다.
# ssh 명령은 모두 따로 프로세스로 돌리고 타이머로 끝을 확인한다(재우기처럼 ssh가 응답 없이 멈춰도 창이 굳지 않게, 시간 제한이 지나면 끊음).
param(
  [Parameter(Mandatory)][string]$Alias,
  [Parameter(Mandatory)][string]$Folder,
  [Parameter(Mandatory)][string]$Role,
  [string]$Ssh = "$env:SystemRoot\System32\OpenSSH\ssh.exe",
  [string]$ConfigPath,
  [string]$Code,
  [switch]$AttachOnly,
  [switch]$DryRun,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot "$Alias.json" }
$Repo = $Folder.TrimEnd('\', '/') -replace '/', '\'
$SessionPs1 = $Repo + '\.claude\skills\pm-ops\scripts\session.ps1'
# ⑦ pm 교체(반자동): 붙은 창에 이 문구를 입력하면 pm이 pm-ops 절차(저장 → start-pm -Force → 이전 자신 stop)를 스스로 한다
$RotateText = 'pm 세션 교체 — 진행 중인 것을 저장하고 start-pm -Force로 새 pm을 띄운 뒤 이전 pm을 멈춰 줘'

# 호스트에서 돌릴 PowerShell은 -EncodedCommand로 넘긴다(호스트 기본 셸·따옴표에 상관없이 그대로, 한글 출력은 UTF-8)
function Get-RemotePs([string]$body) {
  $full = "`$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8`n" + $body
  'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($full))
}
function Get-SshArgs([string]$remote) { "-o BatchMode=yes -o ConnectTimeout=5 $Alias $remote" }

# 상태: 이름, 기본 경로 어댑터의 MAC·브로드캐스트 주소, pm 세션 실행 여부(claude agents — session.ps1 list와 같은 원본, pid가 있으면 실행 중)
# pm 상태: 실행 중인 수, 가장 최근 pm의 컨텍스트 토큰(session.ps1 health와 같은 계산: 기록 끝 1MB의 마지막 assistant usage 합)·마지막 활동,
#   교체 권장 기준은 프로젝트 설정 rotation.contextTokens(wy-ops.json, PC별 wy-ops.local.json이 덮어씀, 기본 150000)
$StatusBody = @'
$ErrorActionPreference = 'SilentlyContinue'
$repo = '__REPO__'
$o = [ordered]@{ host = $env:COMPUTERNAME; mac = $null; broadcast = $null; pm = '모름'; pmCount = $null; pmId = $null; tokens = $null; limit = 150000; last = $null }
foreach ($n in 'wy-ops.json', 'wy-ops.local.json') {
  try { $c = [IO.File]::ReadAllText((Join-Path $repo ".claude\$n"), [Text.Encoding]::UTF8) | ConvertFrom-Json; if ($c.rotation.contextTokens) { $o.limit = [int64]$c.rotation.contextTokens } } catch { }
}
$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1
if ($r) {
  $o.mac = (Get-NetAdapter -InterfaceIndex $r.ifIndex).MacAddress
  $ip = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $r.ifIndex | Select-Object -First 1
  if ($ip) {
    $b = [Net.IPAddress]::Parse($ip.IPAddress).GetAddressBytes()
    for ($i = 0; $i -lt 4; $i++) { $k = [Math]::Max(0, [Math]::Min(8, $ip.PrefixLength - 8 * $i)); $b[$i] = $b[$i] -bor (0xFF -shr $k) }
    $o.broadcast = $b -join '.'
  }
}
$j = claude agents --json --all 2>$null
if ($LASTEXITCODE -eq 0 -and $j) {
  $live = @(($j | Out-String | ConvertFrom-Json) | ForEach-Object { $_ } | Where-Object { $_.name -eq '__ROLE__' -and $null -ne $_.pid })
  $o.pm = if ($live.Count) { '실행 중' } else { '없음' }
  $o.pmCount = $live.Count
  $s = @($live | Sort-Object { $_.kind -ne 'background' }, { - [double]$_.startedAt })[0]
  if ($s) {
    $o.pmId = $s.sessionId
    $t = Get-Item (Join-Path $env:USERPROFILE ('.claude\projects\' + ($repo -replace '[^A-Za-z0-9]', '-') + "\$($s.sessionId).jsonl"))
    if ($t) {
      $o.last = $t.LastWriteTime.ToString('MM-dd HH:mm')
      try {
        $fs = [IO.File]::Open($t.FullName, 'Open', 'Read', 'ReadWrite')
        try { $len = [Math]::Min($fs.Length, 1MB); $buf = New-Object byte[] $len; [void]$fs.Seek(-$len, 'End'); [void]$fs.Read($buf, 0, $len) } finally { $fs.Close() }
        $lines = [Text.Encoding]::UTF8.GetString($buf) -split "`n"
        for ($i = $lines.Count - 1; $i -ge 0 -and -not $o.tokens; $i--) {
          $l = $lines[$i]
          if ($l -notmatch '"type":"assistant"' -or $l -match '"isSidechain":true') { continue }
          $k = 0
          foreach ($f in 'input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens') { if ($l -match ('"' + $f + '":(\d+)')) { $k += [int64]$Matches[1] } }
          if ($k -gt 0) { $o.tokens = $k }
        }
      } catch { }
    }
  }
}
$o | ConvertTo-Json -Compress
'@ -replace '__ROLE__', $Role -replace '__REPO__', $Repo.Replace("'", "''").Replace('$', '$$')

# pm 새로 띄우기: 가장 최근 인수인계 파일(<날짜>-<역할>[-n]-session.tmp)로, 없으면 none. 이미 실행 중이면 start-pm이 거부한다
$StartPmBody = @'
$f = Get-ChildItem (Join-Path $env:USERPROFILE '.claude\session-data') -Filter '*-__ROLE__*-session.tmp' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}-__RX__(-\d+)?-session\.tmp$' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$h = if ($f) { $f.FullName } else { 'none' }
"인수인계: $h"
try { & '__SCRIPT__' start-pm $h 2>&1 | Out-String -Width 200 } catch { "실패: $($_.Exception.Message)" }
'@ -replace '__ROLE__', $Role -replace '__RX__', [regex]::Escape($Role).Replace('$', '$$') -replace '__SCRIPT__', $SessionPs1.Replace("'", "''").Replace('$', '$$')

# pm에 붙기(0.8.5): 새 콘솔 창 대신 VS Code 원격 창 통합 터미널에서. 호스트에 붙기 요청 파일을 쓰고(이 단계) 원격 창을 연다(Open-VsCode).
# 원격 창의 wy-ops 확장(vscode/attachRequest.js)이 요청을 가져가 '<역할> 붙기' 터미널을 띄우거나, 살아 있으면 그 터미널을 보여 준다. 시각은 호스트 시계(UTC)
$AttachReqBody = @'
$base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
$d = Join-Path $base 'wy-ops'
[void](New-Item -ItemType Directory -Force $d)
$j = [ordered]@{ folder = '__REPO__'; role = '__ROLE__'; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $d 'attach-request.json'), $j)
'붙기 요청을 남겼습니다'
'@.Replace('__ROLE__', $Role.Replace("'", "''")).Replace('__REPO__', $Repo.Replace("'", "''"))
$Parts = ($Repo -replace '\\', '/').Split('/')
$FolderUri = "vscode-remote://ssh-remote+$Alias/" + $Parts[0].ToLower() + '/' + (($Parts | Select-Object -Skip 1 | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/')
# 바로가기와 같은 Code.exe(code.cmd 옆, 콘솔 창이 뜨지 않음). 못 찾으면 code.cmd
function Get-CodeExe {
  if ($Code) { return $Code }
  $c = Get-Command code.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return $null }
  $exe = Join-Path (Split-Path (Split-Path $c.Source)) 'Code.exe'
  if (Test-Path $exe) { $exe } else { $c.Source }
}

$Remote = [ordered]@{
  status   = @{ cmd = (Get-RemotePs $StatusBody); timeout = 25 }
  sleep    = @{ cmd = 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0'; timeout = 15 }
  reboot   = @{ cmd = 'shutdown /r /t 0'; timeout = 20 }
  shutdown = @{ cmd = 'shutdown /s /t 0'; timeout = 20 }
  startpm  = @{ cmd = (Get-RemotePs $StartPmBody); timeout = 240 }
  attach   = @{ cmd = (Get-RemotePs $AttachReqBody); timeout = 20 }
}

function Get-Cfg {
  if (Test-Path $ConfigPath) { try { return [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json } catch { } }
  $null
}
function Save-Cfg($mac, $bc) {
  if (-not $mac -or -not $bc) { return }
  $c = Get-Cfg
  if ($c -and $c.mac -eq $mac -and $c.broadcast -eq $bc) { return }
  [void](New-Item -ItemType Directory -Force (Split-Path $ConfigPath))
  [IO.File]::WriteAllText($ConfigPath, (@{ mac = $mac; broadcast = $bc } | ConvertTo-Json -Compress))
}
function Get-WakePacket([string]$mac) {
  $m = [byte[]]($mac -split '[-:]' | ForEach-Object { [Convert]::ToByte($_, 16) })
  if ($m.Count -ne 6) { throw "MAC 형식이 아닙니다: $mac" }
  , [byte[]]((, 0xFF * 6) + ($m * 16))
}

if ($SelfTest) {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  foreach ($k in $Remote.Keys) { "${k}: $Ssh $(Get-SshArgs $Remote[$k].cmd)" }
  "open: $(Get-CodeExe) --folder-uri $FolderUri"
  "rotate: $RotateText"
  $c = Get-Cfg
  if ($c) { "wake: UDP $($c.broadcast):9 $((Get-WakePacket $c.mac).Length)바이트" } else { 'wake: MAC 모름' }
  return
}

# 원격 창 열기: 같은 폴더 창이 이미 열려 있으면 VS Code가 그 창을 앞으로 가져온다. 실패하면 오류 문구, 되면 $null
function Open-VsCode {
  $exe = Get-CodeExe
  if (-not $exe) { return 'VS Code(code 명령)를 찾지 못했습니다' }
  try { Start-Process -FilePath $exe -ArgumentList '--folder-uri', $FolderUri; $null } catch { "VS Code 열기 실패: $($_.Exception.Message)" }
}

if ($AttachOnly) {
  Add-Type -AssemblyName System.Windows.Forms
  $p = Start-Process -FilePath $Ssh -ArgumentList (Get-SshArgs $Remote.attach.cmd) -Wait -PassThru -WindowStyle Hidden
  $err = if ($p.ExitCode -ne 0) { "호스트에 붙기 요청을 보내지 못했습니다(ssh 종료 코드 $($p.ExitCode)). 호스트가 깨어 있는지 '$Alias 제어' 창에서 확인하세요" } else { Open-VsCode }
  if ($err) { [void][Windows.Forms.MessageBox]::Show($err, "$Alias $Role", 'OK', 'Warning') }
  return
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form -Property @{ Text = "$Alias 제어$(if ($DryRun) { ' (시험 — 실행 안 함)' })"; ClientSize = '420,484'; FormBorderStyle = 'FixedSingle'; MaximizeBox = $false; StartPosition = 'CenterScreen'; Font = New-Object Drawing.Font('Malgun Gothic', 9) }
function New-Label($y, $text) { $l = New-Object Windows.Forms.Label -Property @{ Text = $text; Location = "12,$y"; AutoSize = $true }; $form.Controls.Add($l); $l }
function New-Button($x, $y, $text, $w = 128) { $b = New-Object Windows.Forms.Button -Property @{ Text = $text; Location = "$x,$y"; Size = "$w,36" }; $form.Controls.Add($b); $b }
$lblHost = New-Label 12 '호스트: 확인 중…'
$lblPm = New-Label 36 "pm($Role): -"
$lblCtx = New-Label 60 '컨텍스트: -'
$btnRefresh = New-Button 300 10 '새로고침' 108
$btnWake = New-Button 12 88 '① 깨우기'
$btnSleep = New-Button 146 88 '② 재우기'
$btnReboot = New-Button 280 88 '③ 재부팅'
$btnOff = New-Button 12 132 '④ 종료'
$btnStartPm = New-Button 146 132 '⑤ pm 새로 띄우기'
$btnAttach = New-Button 280 132 '⑥ pm에 붙기'
$btnRotate = New-Button 12 176 '⑦ pm 교체'
$log = New-Object Windows.Forms.TextBox -Property @{ Multiline = $true; ReadOnly = $true; ScrollBars = 'Vertical'; Location = '12,224'; Size = '396,248' }
$form.Controls.Add($log)
function Write-Log([string]$s) { $log.AppendText("[$((Get-Date).ToString('HH:mm:ss'))] $($s.Trim() -replace '\r?\n', "`r`n    ")`r`n") }

$script:Jobs = New-Object Collections.ArrayList
$script:WakeUntil = $null
$script:NextWakeCheck = $null
$script:NextRefresh = (Get-Date).AddSeconds(60)
$script:Status = $null
$script:RotateUntil = $null
$script:RotateFrom = $null

function Test-Busy($name) { @($script:Jobs | Where-Object { $_.name -eq $name }).Count -gt 0 }
# ssh 한 번: 프로세스를 띄우고 출력은 비동기로 모은다. 끝(또는 시간 제한)은 아래 타이머가 확인해 $done을 부른다
function Start-Ssh($name, [scriptblock]$done) {
  $r = $Remote[$name]
  $argLine = Get-SshArgs $r.cmd
  if ($DryRun) { Write-Log "(시험) $name`: ssh $argLine"; & $done $null '' '(시험 모드)'; return }
  if (Test-Busy $name) { Write-Log "$name 진행 중입니다"; return }
  $psi = New-Object Diagnostics.ProcessStartInfo $Ssh, $argLine
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  try { $p = [Diagnostics.Process]::Start($psi) } catch { Write-Log "ssh를 실행하지 못했습니다: $($_.Exception.Message)"; return }
  $p.StandardInput.Close()
  [void]$script:Jobs.Add(@{ name = $name; p = $p; out = $p.StandardOutput.ReadToEndAsync(); err = $p.StandardError.ReadToEndAsync(); until = (Get-Date).AddSeconds($r.timeout); done = $done })
}

function Update-Status {
  if (Test-Busy 'status') { return }
  $script:NextRefresh = (Get-Date).AddSeconds(60)
  Start-Ssh 'status' {
    param($code, $out, $err)
    $line = @($out -split '\r?\n' | Where-Object { $_.StartsWith('{') })[-1]
    $s = $null
    if ($code -eq 0 -and $line) { try { $s = $line | ConvertFrom-Json } catch { } }
    $script:Status = $s
    if ($s) {
      $lblHost.Text = "호스트: 깨어 있음 ($($s.host))"; $lblHost.ForeColor = 'DarkGreen'
      $lblPm.Text = "pm($Role): $($s.pm)$(if ($s.pmCount -gt 1) { " $($s.pmCount)개 — 이전 pm이 아직 멈추지 않았습니다" })"
      $lblPm.ForeColor = if ($s.pmCount -gt 1) { 'DarkRed' } else { 'Black' }
      $rot = $s.tokens -and $s.tokens -ge $s.limit
      $lblCtx.Text = if ($s.pmId) { "컨텍스트: $(if ($s.tokens) { "$([Math]::Round($s.tokens / 1000))k" } else { '-' }) / 기준 $([Math]::Round($s.limit / 1000))k$(if ($rot) { ' — 교체 권장' }) · 마지막 활동 $(if ($s.last) { $s.last } else { '-' })" } else { '컨텍스트: -' }
      $lblCtx.ForeColor = if ($rot) { 'DarkOrange' } else { 'Black' }
      Save-Cfg $s.mac $s.broadcast
      if ($script:WakeUntil) { Write-Log '호스트가 깨어났습니다'; $script:WakeUntil = $null }
      if ($script:RotateUntil -and $s.pmId -and $s.pmId -ne $script:RotateFrom -and $s.pmCount -eq 1) {
        $script:RotateUntil = $null
        Write-Log "새 pm이 떴고 이전 pm은 멈췄습니다. '⑥ pm에 붙기'를 누르세요(끊긴 붙기 터미널은 닫혀 새로 열림)"
      }
    } else {
      $lblHost.Text = "호스트: 응답 없음$(if ($DryRun) { '(시험 모드)' })"; $lblHost.ForeColor = 'DarkRed'
      $lblPm.Text = "pm($Role): -"; $lblPm.ForeColor = 'Black'
      $lblCtx.Text = '컨텍스트: -'; $lblCtx.ForeColor = 'Black'
    }
  }
}

$btnRefresh.Add_Click({ Update-Status })
$btnWake.Add_Click({
  $c = Get-Cfg
  if (-not $c -or -not $c.mac) { Write-Log "MAC 주소를 아직 모릅니다. 호스트가 깨어 있을 때 새로고침을 한 번 하면 저장됩니다($ConfigPath)"; return }
  try {
    $pk = Get-WakePacket $c.mac
    if ($DryRun) { Write-Log "(시험) 깨우기: UDP $($c.broadcast):9 매직 패킷 $($pk.Length)바이트(MAC $($c.mac))" }
    else { $u = New-Object Net.Sockets.UdpClient; try { $u.EnableBroadcast = $true; [void]$u.Send($pk, $pk.Length, $c.broadcast, 9) } finally { $u.Close() } }
  } catch { Write-Log "깨우기 실패: $($_.Exception.Message)"; return }
  Write-Log '매직 패킷을 보냈습니다. 10초마다 확인합니다(최대 90초)'
  $script:WakeUntil = (Get-Date).AddSeconds(90); $script:NextWakeCheck = (Get-Date).AddSeconds(10)
})
function Confirm-Do($text) { [Windows.Forms.MessageBox]::Show($form, $text, "$Alias 제어", 'YesNo', 'Warning') -eq 'Yes' }
$afterPower = { param($code, $out, $err) Write-Log "명령을 보냈습니다(연결이 끊기며 끝나는 것은 정상). $($err.Trim())"; $script:NextRefresh = (Get-Date).AddSeconds(15) }
$btnSleep.Add_Click({ if (Confirm-Do "호스트를 재울까요?`n`n외출할 때는 재우지 마세요 — 밖에서는 깨울 수 없습니다.") { Write-Log '재우는 중…'; Start-Ssh 'sleep' $afterPower } })
$btnReboot.Add_Click({ if (Confirm-Do "호스트를 재부팅할까요?`n`n모든 Claude 세션이 꺼집니다 — 다시 켠 뒤 '⑤ pm 새로 띄우기'.") { Write-Log '재부팅 명령…'; Start-Ssh 'reboot' $afterPower } })
$btnOff.Add_Click({ if (Confirm-Do "호스트를 끌까요?`n`n다시 켤 때는 호스트의 전원 버튼을 눌러야 합니다.") { Write-Log '종료 명령…'; Start-Ssh 'shutdown' $afterPower } })
$btnStartPm.Add_Click({
  Write-Log 'pm을 띄우는 중…(최대 4분)'
  Start-Ssh 'startpm' {
    param($code, $out, $err)
    Write-Log $(if ($null -eq $code -and -not $DryRun) { "시간 제한으로 끊었습니다. $out" } else { "$out $err" })
    if ($out -match '이미 실행 중') { Write-Log "pm이 이미 돌고 있어 새로 띄우지 않았습니다. '⑥ pm에 붙기'를 누르세요" }
    $script:NextRefresh = (Get-Date).AddSeconds(5)
  }
})
function Open-Attach {
  Write-Log '붙기 요청을 보내는 중…'
  Start-Ssh 'attach' {
    param($code, $out, $err)
    if ($DryRun) { Write-Log "(시험) VS Code: $(Get-CodeExe) --folder-uri $FolderUri"; return }
    if ($code -ne 0) { Write-Log "붙기 요청 실패: $($err.Trim()) $($out.Trim())"; return }
    $e = Open-VsCode
    Write-Log $(if ($e) { $e } else { "VS Code 원격 창의 통합 터미널 '$Role 붙기'에서 붙습니다(이미 있으면 그 터미널)" })
  }
  $true
}
$btnAttach.Add_Click({ [void](Open-Attach) })
# ⑦ pm 교체(반자동): 붙기 터미널을 열고 입력할 문구를 클립보드에 넣는다. pm이 작업 중이면 그 일을 마친 뒤 처리한다.
# 새 pm이 뜨고 이전 pm이 멈추면(실행 중 pm의 id가 바뀌고 1개) 상태 갱신이 알린다(10분까지 15초마다 확인)
$btnRotate.Add_Click({
  $s = $script:Status
  if (-not $DryRun -and (-not $s -or -not $s.pmId)) { Write-Log "실행 중인 pm이 없습니다(새로고침으로 확인). pm이 없으면 '⑤ pm 새로 띄우기'를 쓰세요"; return }
  if (-not (Confirm-Do "pm 세션을 교체할까요?`n`nVS Code 원격 창의 붙기 터미널이 열립니다. 아래 문구가 클립보드에 들어 있으니 붙여 넣고 Enter:`n$RotateText`n`npm이 작업 중이면 그 일을 마친 뒤 교체합니다. 교체가 끝나면 붙기 터미널이 끊기고 이 창이 알려 줍니다.")) { return }
  try { if ($DryRun) { Write-Log '(시험) 클립보드에 넣을 문구' } else { [Windows.Forms.Clipboard]::SetText($RotateText) } } catch { Write-Log "클립보드에 넣지 못했습니다. 직접 입력하세요: $RotateText" }
  if (-not (Open-Attach)) { return }
  Write-Log "붙기 터미널에 붙여 넣고 Enter: $RotateText"
  $script:RotateFrom = if ($s) { $s.pmId } else { $null }
  $script:RotateUntil = (Get-Date).AddMinutes(10); $script:NextRefresh = (Get-Date).AddSeconds(15)
})

$timer = New-Object Windows.Forms.Timer -Property @{ Interval = 500 }
$timer.Add_Tick({
  foreach ($j in @($script:Jobs)) {
    $late = -not $j.p.HasExited -and (Get-Date) -gt $j.until
    if ($late) { try { $j.p.Kill() } catch { } }
    if ($late -or ($j.p.HasExited -and $j.out.IsCompleted -and $j.err.IsCompleted)) {
      $script:Jobs.Remove($j)
      $code = if ($late) { $null } else { $j.p.ExitCode }
      $o = if ($j.out.IsCompleted) { $j.out.Result } else { '' }
      $e = if ($j.err.IsCompleted) { $j.err.Result } else { '' }
      try { & $j.done $code $o $e } catch { Write-Log "오류: $($_.Exception.Message)" }
    }
  }
  $now = Get-Date
  if ($script:WakeUntil) {
    if ($now -gt $script:WakeUntil -and -not (Test-Busy 'status')) {
      $script:WakeUntil = $null
      Write-Log '90초 동안 깨지 않았습니다. 깨우기는 호스트와 같은 집 안 네트워크에서만 됩니다. 밖이면 집에 와서, 집 안인데도 안 되면 호스트의 전원 버튼을 누르세요'
    } elseif ($now -ge $script:NextWakeCheck) { $script:NextWakeCheck = $now.AddSeconds(10); Update-Status }
  }
  if ($script:RotateUntil -and $now -gt $script:RotateUntil) {
    $script:RotateUntil = $null
    Write-Log "10분 안에 pm이 바뀌지 않았습니다. 붙기 터미널에서 pm의 답을 확인하세요(pm이 둘이면 위에 표시됩니다)"
  }
  if ($now -ge $script:NextRefresh) { Update-Status; if ($script:RotateUntil) { $script:NextRefresh = $now.AddSeconds(15) } }
})
$form.Add_Shown({ $timer.Start(); Update-Status })
$form.Add_FormClosed({ $timer.Stop() })
[void]$form.ShowDialog()
