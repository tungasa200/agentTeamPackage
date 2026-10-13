# 접속 PC의 호스트 제어 창(0.8.2): 깨우기·재우기·재부팅·종료, 위에 호스트 응답. 호스트(ssh 별칭) 하나를 다루는 전역 도구다.
# pm 붙기·교체는 각 프로젝트 VS Code 창의 세션 현황 pm 줄([붙기]·[pm 교체]·[멈춤])이 맡는다(HC-01).
# install.ps1 connect <별칭>이 ~\.wy-tools\connect\에 복사하고 바탕화면 '<별칭> 제어' 바로가기를 만든다.
# 추가 설치 없음(Windows PowerShell 5.1 + WinForms). ssh는 connect가 준비한 공개키 로그인만(BatchMode, 암호를 묻지 않음) 쓴다.
#   -DryRun    창은 띄우되 버튼이 명령을 실행하지 않고 아래 기록 칸에 명령 문자열만 적는다
#   -SelfTest  창 없이 각 버튼의 명령 문자열을 출력하고 끝낸다(시험용)
# 깨우기(매직 패킷, UDP 9 브로드캐스트)는 호스트와 같은 네트워크(집 안)에서만 닿는다. MAC·브로드캐스트 주소는 호스트가 깨어 있을 때
# 상태 확인이 읽어 <별칭>.json에 저장해 두고, 잠든 동안은 그 값을 쓴다.
# 폰 중계(0.9.1): <별칭>.json에 wakeRelay(호스트:포트, install.ps1 connect --wake-relay가 넣음)가 있으면 깨우기 때 함께
#   집에 둔 폰에 ssh(공개키만)로 'python wake.py'를 실행한다 — 폰이 집 안 브로드캐스트로 매직 패킷을 보내고 WAKE-SENT를 출력. 집 밖에서도 깨울 수 있다.
# ssh 명령은 모두 따로 프로세스로 돌리고 타이머로 끝을 확인한다(재우기처럼 ssh가 응답 없이 멈춰도 창이 굳지 않게, 시간 제한이 지나면 끊음).
param(
  [Parameter(Mandatory)][string]$Alias,
  [string]$Ssh = "$env:SystemRoot\System32\OpenSSH\ssh.exe",
  [string]$ConfigPath,
  [switch]$DryRun,
  [switch]$SelfTest
)
$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot "$Alias.json" }

# 호스트에서 돌릴 PowerShell은 -EncodedCommand로 넘긴다(호스트 기본 셸·따옴표에 상관없이 그대로, 한글 출력은 UTF-8)
function Get-RemotePs([string]$body) {
  $full = "`$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8`n" + $body
  'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($full))
}
function Get-SshArgs([string]$remote) { "-o BatchMode=yes -o ConnectTimeout=5 $Alias $remote" }

# 상태: 이름, 기본 경로 어댑터의 MAC·브로드캐스트 주소(잠든 동안 깨우기에 씀)
$StatusBody = @'
$ErrorActionPreference = 'SilentlyContinue'
$o = [ordered]@{ host = $env:COMPUTERNAME; mac = $null; broadcast = $null }
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
$o | ConvertTo-Json -Compress
'@

$Remote = [ordered]@{
  status   = @{ cmd = (Get-RemotePs $StatusBody); timeout = 25 }
  sleep    = @{ cmd = 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0'; timeout = 15 }
  reboot   = @{ cmd = 'shutdown /r /t 0'; timeout = 20 }
  shutdown = @{ cmd = 'shutdown /s /t 0'; timeout = 20 }
}

function Get-Cfg {
  if (Test-Path $ConfigPath) { try { return [IO.File]::ReadAllText($ConfigPath) | ConvertFrom-Json } catch { } }
  $null
}
function Save-Cfg($mac, $bc) {
  if (-not $mac -or -not $bc) { return }
  $c = Get-Cfg
  if ($c -and $c.mac -eq $mac -and $c.broadcast -eq $bc) { return }
  $n = [ordered]@{ mac = $mac; broadcast = $bc }
  if ($c -and $c.wakeRelay) { $n.wakeRelay = $c.wakeRelay }
  [void](New-Item -ItemType Directory -Force (Split-Path $ConfigPath))
  [IO.File]::WriteAllText($ConfigPath, ($n | ConvertTo-Json -Compress))
}
# 폰 중계 ssh 인수(설정 없으면 $null). 처음 한 번은 손으로 ssh -p <포트> <주소>로 들어가 호스트 키를 받아 둬야 한다(BatchMode는 묻지 않고 실패)
function Get-RelayArgs($c) {
  if (-not $c -or -not $c.wakeRelay) { return $null }
  if ($c.wakeRelay -notmatch '^([A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})$') { throw "폰 중계 주소 형식이 아닙니다(호스트:포트): $($c.wakeRelay)" }
  "-p $($Matches[2]) -o BatchMode=yes -o ConnectTimeout=10 -o PasswordAuthentication=no $($Matches[1]) python wake.py"
}
function Get-WakePacket([string]$mac) {
  $m = [byte[]]($mac -split '[-:]' | ForEach-Object { [Convert]::ToByte($_, 16) })
  if ($m.Count -ne 6) { throw "MAC 형식이 아닙니다: $mac" }
  , [byte[]]((, 0xFF * 6) + ($m * 16))
}

if ($SelfTest) {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  foreach ($k in $Remote.Keys) { "${k}: $Ssh $(Get-SshArgs $Remote[$k].cmd)" }
  $c = Get-Cfg
  if ($c -and $c.mac) { "wake: UDP $($c.broadcast):9 $((Get-WakePacket $c.mac).Length)바이트" } else { 'wake: MAC 모름' }
  try { $ra = Get-RelayArgs $c; "relay: $(if ($ra) { "$Ssh $ra" } else { '없음' })" } catch { "relay: $($_.Exception.Message)" }
  return
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form -Property @{ Text = "$Alias 제어$(if ($DryRun) { ' (시험 — 실행 안 함)' })"; ClientSize = '420,352'; FormBorderStyle = 'FixedSingle'; MaximizeBox = $false; StartPosition = 'CenterScreen'; Font = New-Object Drawing.Font('Malgun Gothic', 9) }
function New-Label($y, $text) { $l = New-Object Windows.Forms.Label -Property @{ Text = $text; Location = "12,$y"; AutoSize = $true }; $form.Controls.Add($l); $l }
function New-Button($x, $y, $text, $w = 96) { $b = New-Object Windows.Forms.Button -Property @{ Text = $text; Location = "$x,$y"; Size = "$w,36" }; $form.Controls.Add($b); $b }
$lblHost = New-Label 20 '호스트: 확인 중…'
$btnRefresh = New-Button 300 10 '새로고침' 108
$btnWake = New-Button 12 56 '① 깨우기'
$btnSleep = New-Button 112 56 '② 재우기'
$btnReboot = New-Button 212 56 '③ 재부팅'
$btnOff = New-Button 312 56 '④ 종료'
$log = New-Object Windows.Forms.TextBox -Property @{ Multiline = $true; ReadOnly = $true; ScrollBars = 'Vertical'; Location = '12,104'; Size = '396,236' }
$form.Controls.Add($log)
function Write-Log([string]$s) { $log.AppendText("[$((Get-Date).ToString('HH:mm:ss'))] $($s.Trim() -replace '\r?\n', "`r`n    ")`r`n") }

$script:Jobs = New-Object Collections.ArrayList
$script:WakeUntil = $null
$script:WakeRelay = $false
$script:NextWakeCheck = $null
$script:NextRefresh = (Get-Date).AddSeconds(60)

function Test-Busy($name) { @($script:Jobs | Where-Object { $_.name -eq $name }).Count -gt 0 }
# ssh 한 번: 프로세스를 띄우고 출력은 비동기로 모은다. 끝(또는 시간 제한)은 아래 타이머가 확인해 $done을 부른다
function Start-Ssh($name, [scriptblock]$done) {
  $r = $Remote[$name]
  $argLine = if ($r.args) { $r.args } else { Get-SshArgs $r.cmd }
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
    if ($s) {
      $lblHost.Text = "호스트: 깨어 있음 ($($s.host))"; $lblHost.ForeColor = 'DarkGreen'
      Save-Cfg $s.mac $s.broadcast
      if ($script:WakeUntil) { Write-Log '호스트가 깨어났습니다'; $script:WakeUntil = $null }
    } else {
      $lblHost.Text = "호스트: 응답 없음$(if ($DryRun) { '(시험 모드)' })"; $lblHost.ForeColor = 'DarkRed'
    }
  }
}

$btnRefresh.Add_Click({ Update-Status })
$btnWake.Add_Click({
  $c = Get-Cfg
  $relay = $null
  try { $relay = Get-RelayArgs $c } catch { Write-Log $_.Exception.Message }
  $sent = $false
  if ($c -and $c.mac) {
    try {
      $pk = Get-WakePacket $c.mac
      if ($DryRun) { Write-Log "(시험) 깨우기: UDP $($c.broadcast):9 매직 패킷 $($pk.Length)바이트(MAC $($c.mac))" }
      else { $u = New-Object Net.Sockets.UdpClient; try { $u.EnableBroadcast = $true; [void]$u.Send($pk, $pk.Length, $c.broadcast, 9) } finally { $u.Close() } }
      $sent = $true
    } catch { Write-Log "집 안 매직 패킷 실패: $($_.Exception.Message)" }
  } elseif (-not $relay) { Write-Log "MAC 주소를 아직 모릅니다. 호스트가 깨어 있을 때 새로고침을 한 번 하면 저장됩니다($ConfigPath)"; return }
  # 폰 중계: 창이 굳지 않게 ssh는 따로 프로세스로(최대 25초)
  if ($relay) {
    $Remote['relay'] = @{ args = $relay; timeout = 25 }
    Write-Log '폰에 깨우기를 부탁하는 중…'
    Start-Ssh 'relay' {
      param($code, $out, $err)
      if ($DryRun) { return }
      Write-Log $(if ($code -eq 0 -and $out -match 'WAKE-SENT') { '폰이 매직 패킷을 보냈습니다' }
        elseif ($null -eq $code) { '폰에 연결 못 함(시간 초과). 폰의 Tailscale·Termux가 켜져 있는지 확인하세요' }
        elseif ($code -eq 255) { "폰에 연결 못 함: $($err.Trim())" }
        else { "폰에 연결했지만 보내지 못했습니다: $(($out + ' ' + $err).Trim())" })
    }
  } elseif (-not $sent) { return }
  $script:WakeRelay = [bool]$relay
  Write-Log "$(if ($sent) { '집 안 매직 패킷을 보냈습니다. ' })10초마다 확인합니다(최대 90초)"
  $script:WakeUntil = (Get-Date).AddSeconds(90); $script:NextWakeCheck = (Get-Date).AddSeconds(10)
})
function Confirm-Do($text) { [Windows.Forms.MessageBox]::Show($form, $text, "$Alias 제어", 'YesNo', 'Warning') -eq 'Yes' }
$afterPower = { param($code, $out, $err) Write-Log "명령을 보냈습니다(연결이 끊기며 끝나는 것은 정상). $($err.Trim())"; $script:NextRefresh = (Get-Date).AddSeconds(15) }
$btnSleep.Add_Click({
  $hasRelay = $false; try { $hasRelay = [bool](Get-RelayArgs (Get-Cfg)) } catch { }
  $note = if ($hasRelay) { '밖에서도 폰을 거쳐 깨울 수 있습니다(① 깨우기).' } else { '외출할 때는 재우지 마세요 — 밖에서는 깨울 수 없습니다.' }
  if (Confirm-Do "호스트를 재울까요?`n`n$note") { Write-Log '재우는 중…'; Start-Ssh 'sleep' $afterPower } })
$btnReboot.Add_Click({ if (Confirm-Do "호스트를 재부팅할까요?`n`n모든 Claude 세션이 꺼집니다 — 다시 켠 뒤 각 프로젝트 VS Code 창의 세션 현황에서 pm을 다시 띄우세요.") { Write-Log '재부팅 명령…'; Start-Ssh 'reboot' $afterPower } })
$btnOff.Add_Click({ if (Confirm-Do "호스트를 끌까요?`n`n다시 켤 때는 호스트의 전원 버튼을 눌러야 합니다.") { Write-Log '종료 명령…'; Start-Ssh 'shutdown' $afterPower } })

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
      Write-Log $(if ($script:WakeRelay) { "90초 동안 깨지 않았습니다. 위 기록의 폰 결과를 보세요. '폰에 연결 못 함'이면 폰의 와이파이·Tailscale·Termux(sshd)를 확인하고, 폰이 보냈는데도 안 깨면 집에서 호스트의 전원 버튼을 누르세요" }
        else { "90초 동안 깨지 않았습니다. 이 창의 깨우기는 호스트와 같은 집 안 네트워크에서만 닿습니다(폰 중계 없음). 밖이면 집에 와서, 집 안인데도 안 되면 호스트의 전원 버튼을 누르세요" })
    } elseif ($now -ge $script:NextWakeCheck) { $script:NextWakeCheck = $now.AddSeconds(10); Update-Status }
  }
  if ($now -ge $script:NextRefresh) { Update-Status }
})
$form.Add_Shown({ $timer.Start(); Update-Status })
$form.Add_FormClosed({ $timer.Stop() })
[void]$form.ShowDialog()
