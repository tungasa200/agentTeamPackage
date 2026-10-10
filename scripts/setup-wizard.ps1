# WY Ops 설치 마법사(0.9.0, D-170·D-171). setup.cmd가 창 없이 띄운다. Windows PowerShell 5.1 + WinForms, 추가 설치 없음.
# 화면·문구 원본: design/install-wizard/mockup.html(7단계). 설치 로직은 install.ps1·lib/install.js에 있고 여기는 명령 인자로 부르는 앞단이다:
#   3 설치      install.ps1 quickstart --project <폴더> --name <이름> --yes --progress --no-finish [--prefix] [--stack] [--count]
#               (진행 줄 '@@tool …'·'@@step …'·'@@claudemd …'을 읽어 줄 상태를 바꾼다)
#   4 Claude    claude auth login(창 없이, 브라우저가 열림) + 2초마다 claude auth status --json
#   5 GitHub    gh auth login --web(창 없이, 출력의 확인 코드를 보여 주고 브라우저는 마법사가 연다) + 2초마다 gh auth status, 끝나면 gh auth setup-git
#   6 폴더 허락 node lib/install.js trust --project <폴더>(~/.claude.json에 기록) → 실패하면 Claude 창(사람이 Yes) + 2초마다 trust --check
#   7 마침      node lib/install.js doctor --json --todos --project <폴더>(남은 일은 승인 센터 할 일 카드로도)
# 외부 명령은 모두 창 없는 프로세스로 돌리고 타이머로 출력을 읽는다(창이 굳지 않게). 출력 전체는 기록 파일에만 남고 화면에는 쉬운 말만.
#   -Demo        명령 대신 가짜 출력으로 흐름만 돈다(설치·로그인·기록을 하지 않음)
#   -Shots <폴더> 화면 상태를 차례로 그려 PNG로 저장하고 끝낸다(목업 대조용, -Demo 포함)
#   -Scale <배율> 화면 배율 흉내(1.25·1.5, 시험용). 없으면 실제 화면 배율
# 이 파일은 UTF-8(BOM 포함)로 저장한다(PowerShell 5.1 한글).
param([switch]$Demo, [string]$Shots, [double]$Scale = 0)
$ErrorActionPreference = 'Stop'
if ($Shots) { $Demo = $true }
$Pkg = Split-Path -Parent $PSScriptRoot

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# 고해상도: 시스템 배율을 아는 프로세스로(흐림 방지). 배치는 아래 Px()로 배율만큼 키우고, 글꼴은 포인트라 Windows가 키운다
Add-Type -Namespace WyOps -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, string l);
'@
[void][WyOps.Native]::SetProcessDPIAware()
[Windows.Forms.Application]::EnableVisualStyles()
try { [Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false) } catch { }
$g = [Drawing.Graphics]::FromHwnd([IntPtr]::Zero); $RealScale = $g.DpiX / 96; $g.Dispose()
$DpiScale = if ($Scale -gt 0) { $Scale } else { $RealScale }
$FontK = $DpiScale / $RealScale  # -Scale로 흉내 낼 때만 1이 아님
function Px([double]$n) { [int][Math]::Round($n * $DpiScale) }
function New-Font([double]$pt, [Drawing.FontStyle]$style = 'Regular', [string]$face = 'Malgun Gothic') { New-Object Drawing.Font($face, ($pt * $FontK), $style) }
$F = @{ Body = New-Font 10; Bold = New-Font 10 'Bold'; Title = New-Font 14 'Bold'; Small = New-Font 9; Big = New-Font 13 'Bold'; Code = New-Font 20 'Bold' 'Consolas'; Sym = New-Font 10 'Bold' 'Segoe UI Symbol' }
$C = @{ Accent = [Drawing.Color]::FromArgb(0, 103, 192); Line = [Drawing.Color]::FromArgb(225, 225, 225); Muted = [Drawing.Color]::FromArgb(109, 109, 109)
  Ok = [Drawing.Color]::FromArgb(16, 124, 16); Warn = [Drawing.Color]::FromArgb(157, 93, 0); Bad = [Drawing.Color]::FromArgb(196, 43, 28); Wait = [Drawing.Color]::FromArgb(154, 154, 154)
  Side = [Drawing.Color]::FromArgb(243, 243, 243); Cur = [Drawing.Color]::FromArgb(227, 236, 247); Foot = [Drawing.Color]::FromArgb(247, 247, 247)
  Help = [Drawing.Color]::FromArgb(242, 246, 251); HelpLine = [Drawing.Color]::FromArgb(198, 212, 229); FailBg = [Drawing.Color]::FromArgb(253, 243, 242); Text = [Drawing.Color]::FromArgb(26, 26, 26) }

# ── 기록(로그) ──
$LogPath = Join-Path $env:TEMP ('wy-ops-setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
function Write-Log([string]$s) { try { [IO.File]::AppendAllText($LogPath, ((Get-Date -Format 'HH:mm:ss') + ' ' + $s + "`r`n"), [Text.Encoding]::UTF8) } catch { } }
Write-Log "WY Ops 설치 마법사 시작: 패키지 $Pkg, 배율 $DpiScale$(if ($Demo) { ', 시험(Demo)' })"

function Update-PathFromRegistry {
  # 방금 설치한 도구가 이 창에서 바로 보이게(install.ps1과 같은 방식)
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}
if (-not $Demo) { Update-PathFromRegistry }

# ── 창 없는 프로세스: 출력은 줄 단위로 타이머에서 읽는다(ReadLineAsync, 다른 스레드에서 스크립트를 돌리지 않음) ──
function Start-Hidden([string]$cmdLine, [string]$cwd = $env:USERPROFILE, [switch]$KeepInput) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /s /c "' + $cmdLine + ' 2>&1"'
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardInput = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $psi.WorkingDirectory = $cwd
  Write-Log "실행: $cmdLine"
  $p = [Diagnostics.Process]::Start($psi)
  if (-not $KeepInput) { $p.StandardInput.Close() }  # claude auth login은 붙여 넣은 코드를 stdin으로 받으므로 열어 둔다
  return @{ P = $p; Task = $p.StandardOutput.ReadLineAsync(); Lines = New-Object Collections.Generic.List[string]; Eof = $false; Exit = $null; Cmd = $cmdLine }
}
# 새 줄을 돌려준다. 끝나면 $r.Exit가 채워진다
function Read-Hidden($r) {
  $new = @()
  while (-not $r.Eof -and $r.Task.IsCompleted) {
    $line = $r.Task.Result
    if ($null -eq $line) { $r.Eof = $true; break }
    $r.Lines.Add($line); $new += $line; Write-Log "  | $line"
    $r.Task = $r.P.StandardOutput.ReadLineAsync()
  }
  if ($r.Eof -and $null -eq $r.Exit -and $r.P.HasExited) { $r.Exit = $r.P.ExitCode; Write-Log "  끝(종료 코드 $($r.Exit)): $($r.Cmd)" }
  return $new
}
function Stop-Hidden($r) {
  if ($r -and $r.P -and -not $r.P.HasExited) { try { & taskkill.exe /PID $r.P.Id /T /F 2>$null | Out-Null } catch { } }
}
function Q([string]$s) { '"' + $s + '"' }
$Node = 'node ' + (Q (Join-Path $Pkg 'lib\install.js'))

# 시험(Demo): 명령 대신 가짜 출력. 줄 사이 쉬는 시간으로 진행이 보이게
function Get-DemoCmd([string[]]$lines, [double]$sec = 0.4, [int]$exit = 0) {
  $body = ($lines | ForEach-Object { "echo $_& ping -n 1 -w $([int]($sec * 1000)) 10.255.255.1 >nul" }) -join '& '
  "($body& exit /b $exit)"
}

# ── 상태 ──
$St = @{
  Step = 1; Done = @{}; Project = 'C:\projects\my-app'; Name = 'my-app'; NameTouched = $false; Existing = $null
  Prefix = 'MY-'; PrefixTouched = $false; Stack = ''; Counts = [ordered]@{ planner = 1; backend = 2; frontend = 2; qa = 1; design = 1 }
  AdvOpen = $false; Installed = $false; Rows = $null; Run = $null; FailMsg = $null; CancelPending = $false
  ClaudeOk = $false; ClaudeWasOk = $false; ClaudeUrl = $null; PasteOpen = $false; PasteText = ''; PasteBusy = $false; PasteBad = $false; GhOk = $false; GhWasOk = $false; GhSkipped = $false; GhCode = $null
  TrustOk = $false; TrustWasOk = $false; TrustFail = $false; TrustWindow = $false; ClaudeMd = $null
  Poll = $null; PollAt = [DateTime]::MinValue; Waiting = $null; WaitSince = $null; Doctor = $null; Final = $null; ReturnTo7 = $false
}
$DefaultCounts = @{ planner = 1; backend = 2; frontend = 2; qa = 1; design = 1 }
$StepNames = @('시작', '프로젝트 폴더', '설치', 'Claude 로그인', 'GitHub 로그인', '폴더 사용 허락', '마침')

# ── 창 뼈대 ──
$form = New-Object Windows.Forms.Form
$form.Text = 'WY Ops 설치'; $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'; $form.BackColor = [Drawing.Color]::White; $form.Font = $F.Body
$form.ClientSize = New-Object Drawing.Size((Px 720), (Px 490)); $form.AutoScaleMode = 'None'
$form.ShowInTaskbar = $true; $form.MinimizeBox = $false

$side = New-Object Windows.Forms.Panel; $side.Dock = 'Left'; $side.Width = Px 176; $side.BackColor = $C.Side; $side.Padding = New-Object Windows.Forms.Padding(0, (Px 18), 0, 0)
$sideLine = New-Object Windows.Forms.Panel; $sideLine.Dock = 'Left'; $sideLine.Width = 1; $sideLine.BackColor = $C.Line
$foot = New-Object Windows.Forms.Panel; $foot.Dock = 'Bottom'; $foot.Height = Px 50; $foot.BackColor = $C.Foot
$footLine = New-Object Windows.Forms.Panel; $footLine.Dock = 'Top'; $footLine.Height = 1; $footLine.BackColor = $C.Line; $foot.Controls.Add($footLine)
$body = New-Object Windows.Forms.Panel; $body.Dock = 'Fill'; $body.Padding = New-Object Windows.Forms.Padding((Px 26), (Px 22), (Px 14), (Px 6))
$flow = New-Object Windows.Forms.FlowLayoutPanel; $flow.Dock = 'Fill'; $flow.FlowDirection = 'TopDown'; $flow.WrapContents = $false; $flow.AutoScroll = $true
$body.Controls.Add($flow)
# 가로 스크롤은 쓰지 않는다(세로만)
$flow.AutoScroll = $false; $flow.HorizontalScroll.Maximum = 0; $flow.HorizontalScroll.Visible = $false; $flow.HorizontalScroll.Enabled = $false; $flow.AutoScroll = $true
$form.Controls.Add($body); $form.Controls.Add($sideLine); $form.Controls.Add($side); $form.Controls.Add($foot)
$ContentW = (Px 720) - (Px 176) - 1 - (Px 26) - (Px 14) - [Windows.Forms.SystemInformation]::VerticalScrollBarWidth - (Px 4)

# 왼쪽 단계 표시
$SideRows = @()
for ($i = 6; $i -ge 0; $i--) {
  $row = New-Object Windows.Forms.Panel; $row.Dock = 'Top'; $row.Height = Px 34
  $bar = New-Object Windows.Forms.Panel; $bar.Dock = 'Left'; $bar.Width = Px 3
  $num = New-Object Windows.Forms.Label; $num.Dock = 'Left'; $num.Width = Px 30; $num.TextAlign = 'MiddleCenter'; $num.Font = $F.Sym
  $lab = New-Object Windows.Forms.Label; $lab.Dock = 'Fill'; $lab.TextAlign = 'MiddleLeft'; $lab.Text = $StepNames[$i]
  $row.Controls.Add($lab); $row.Controls.Add($num); $row.Controls.Add($bar)
  $side.Controls.Add($row)
  $SideRows = , @{ Row = $row; Bar = $bar; Num = $num; Lab = $lab } + $SideRows
}
function Update-Side {
  for ($i = 0; $i -lt 7; $i++) {
    $r = $SideRows[$i]; $n = $i + 1
    $warn = ($n -eq 5 -and $St.GhSkipped -and -not $St.GhOk)
    $r.Row.BackColor = $C.Side; $r.Bar.BackColor = $C.Side; $r.Lab.Font = $F.Body
    if ($n -eq $St.Step) { $r.Row.BackColor = $C.Cur; $r.Bar.BackColor = $C.Accent; $r.Lab.ForeColor = $C.Accent; $r.Lab.Font = $F.Bold; $r.Num.ForeColor = $C.Accent; $r.Num.Text = "$n" }
    elseif ($warn -and $St.Done[$n]) { $r.Lab.ForeColor = [Drawing.Color]::FromArgb(51, 51, 51); $r.Num.ForeColor = $C.Warn; $r.Num.Text = '!' }
    elseif ($St.Done[$n]) { $r.Lab.ForeColor = [Drawing.Color]::FromArgb(51, 51, 51); $r.Num.ForeColor = $C.Ok; $r.Num.Text = [string][char]0x2713 }
    else { $r.Lab.ForeColor = $C.Muted; $r.Num.ForeColor = $C.Muted; $r.Num.Text = "$n" }
  }
}

# 아래 버튼
function New-Btn([string]$text, [bool]$primary = $false, [int]$w = 86, [int]$h = 28) {
  $b = New-Object Windows.Forms.Button; $b.Text = $text; $b.AutoSize = $true; $b.AutoSizeMode = 'GrowOnly'
  $b.MinimumSize = New-Object Drawing.Size((Px $w), (Px $h)); $b.Padding = New-Object Windows.Forms.Padding((Px 6), 0, (Px 6), 0)
  if ($primary) { $b.FlatStyle = 'Flat'; $b.BackColor = $C.Accent; $b.ForeColor = [Drawing.Color]::White; $b.FlatAppearance.BorderColor = $C.Accent }
  return $b
}
function Set-Primary($b, [bool]$on) {
  if ($on) { $b.FlatStyle = 'Flat'; $b.BackColor = $C.Accent; $b.ForeColor = [Drawing.Color]::White; $b.FlatAppearance.BorderColor = $C.Accent }
  else { $b.FlatStyle = 'Standard'; $b.UseVisualStyleBackColor = $true; $b.ForeColor = [Drawing.SystemColors]::ControlText }
}
$btnBar = New-Object Windows.Forms.FlowLayoutPanel; $btnBar.FlowDirection = 'RightToLeft'; $btnBar.Dock = 'Right'; $btnBar.AutoSize = $true; $btnBar.WrapContents = $false
$btnBar.Padding = New-Object Windows.Forms.Padding(0, (Px 10), (Px 8), 0)
$btnCancel = New-Btn '취소'; $btnNext = New-Btn '다음 >' $true; $btnPrev = New-Btn '< 이전'
$btnBar.Controls.AddRange(@($btnCancel, $btnNext, $btnPrev)); $foot.Controls.Add($btnBar)
$lnkLater = New-Object Windows.Forms.LinkLabel; $lnkLater.Text = '나중에 하기'; $lnkLater.AutoSize = $true; $lnkLater.Font = $F.Small; $lnkLater.Location = New-Object Drawing.Point((Px 14), (Px 18)); $lnkLater.LinkColor = $C.Accent
$foot.Controls.Add($lnkLater)
$form.AcceptButton = $btnNext
# 다음 버튼은 쓸 수 있을 때만 파란색(쓸 수 없으면 회색)
$btnNext.Add_EnabledChanged({ Set-Primary $btnNext ($btnNext.Enabled -and $btnNext.Text -ne '마침') })

# ── 본문 만들기 도우미 ──
function Clear-Body { $script:FocusCtl = $null; $flow.SuspendLayout(); foreach ($ctl in @($flow.Controls)) { $ctl.Dispose() }; $flow.Controls.Clear() }
function Add-Ctl($ctl, [int]$top = 0) { $ctl.Margin = New-Object Windows.Forms.Padding(0, (Px $top), 0, 0); $flow.Controls.Add($ctl); return $ctl }
# 한국어는 Windows 기본 줄바꿈이 글자 단위라 어절 중간에서 끊긴다('두었|습니다') → 띄어쓰기 자리에서 미리 줄을 나눈다.
# 공백을 줄바꿈 한 글자로 바꾸므로 글자 수(LinkArea 위치)는 그대로다. 한 어절이 폭보다 길면 그대로 둔다(Windows가 끊음)
function Format-Wrap([string]$text, $font, [int]$w) {
  if (-not $text -or $w -le 0 -or $text -notmatch '[가-힣]') { return $text }
  $flags = [Windows.Forms.TextFormatFlags]::NoPadding -bor [Windows.Forms.TextFormatFlags]::SingleLine
  $max = $w - (Px 6)  # Label 안쪽 여백·글꼴 오차
  $out = foreach ($para in ($text -split "`n")) {
    $line = ''
    $lines = foreach ($word in ($para -split ' ')) {
      $try = if ($line) { "$line $word" } else { $word }
      if ($line -and [Windows.Forms.TextRenderer]::MeasureText($try, $font, (New-Object Drawing.Size(0, 0)), $flags).Width -gt $max) { $line; $line = $word } else { $line = $try }
    }
    (@($lines) + $line) -join "`n"
  }
  return (@($out) -join "`n")
}
function New-Label([string]$text, $font = $F.Body, $color = $C.Text, [int]$w = 0) {
  $l = New-Object Windows.Forms.Label; $l.Text = Format-Wrap $text $font $(if ($w) { $w } else { $ContentW }); $l.Font = $font; $l.ForeColor = $color; $l.AutoSize = $true
  $l.MaximumSize = New-Object Drawing.Size($(if ($w) { $w } else { $ContentW }), 0); $l.UseMnemonic = $false
  return $l
}
function Add-Title([string]$t) { [void](Add-Ctl (New-Label $t $F.Title)) }
function Add-Lead([string]$t, [int]$top = 8) { [void](Add-Ctl (New-Label $t) $top) }
# 도움말: 용어 옆 '?' 버튼 → 아래 칸 보이기/숨기기(기본 닫힘)
function New-HelpButton([string]$term, $panel) {
  $q = New-Object Windows.Forms.Button; $q.Text = '?'; $q.Size = New-Object Drawing.Size((Px 22), (Px 22)); $q.FlatStyle = 'Flat'
  $q.Font = New-Font 8 'Bold' 'Segoe UI'; $q.FlatAppearance.BorderColor = [Drawing.Color]::FromArgb(138, 138, 138); $q.BackColor = [Drawing.Color]::White
  $q.AccessibleName = "$term 도움말"; $q.Tag = $panel; $q.Margin = New-Object Windows.Forms.Padding((Px 8), 0, 0, 0); $q.TabStop = $true
  $q.Add_Click({ param($s) $p = $s.Tag; $p.Visible = -not $p.Visible
      if ($p.Visible) { $s.BackColor = $C.Accent; $s.ForeColor = [Drawing.Color]::White } else { $s.BackColor = [Drawing.Color]::White; $s.ForeColor = $C.Text } })
  return $q
}
function New-HelpPanel([string]$text) {
  $p = New-Object Windows.Forms.Panel; $p.BackColor = $C.HelpLine; $p.Padding = New-Object Windows.Forms.Padding(1); $p.AutoSize = $true; $p.Visible = $false
  $in = New-Object Windows.Forms.Label; $in.BackColor = $C.Help; $in.AutoSize = $true; $in.Font = $F.Small; $in.Text = Format-Wrap $text $F.Small ($ContentW - 2 - (Px 20)); $in.UseMnemonic = $false
  $in.Padding = New-Object Windows.Forms.Padding((Px 10), (Px 7), (Px 10), (Px 7)); $in.MaximumSize = New-Object Drawing.Size(($ContentW - 2), 0); $in.MinimumSize = New-Object Drawing.Size(($ContentW - 2), 0)
  $p.Controls.Add($in); $p.Margin = New-Object Windows.Forms.Padding(0, (Px 6), 0, (Px 4))
  return $p
}
# 글과 '?' 한 줄 + 도움말 칸(줄 바로 아래)
function Add-TextWithHelp([string]$text, [string]$term, [string]$help, $font = $F.Body, [int]$top = 8) {
  $row = New-Object Windows.Forms.FlowLayoutPanel; $row.AutoSize = $true; $row.WrapContents = $false; $row.Margin = New-Object Windows.Forms.Padding(0, (Px $top), 0, 0)
  $l = New-Label $text $font $C.Text ($ContentW - (Px 30)); $l.Margin = New-Object Windows.Forms.Padding(0, (Px 2), 0, 0)
  $hp = New-HelpPanel $help
  $row.Controls.Add($l); $row.Controls.Add((New-HelpButton $term $hp))
  $flow.Controls.Add($row); $flow.Controls.Add($hp)
  return $row
}
function New-Row([int]$top = 0) { $r = New-Object Windows.Forms.FlowLayoutPanel; $r.AutoSize = $true; $r.WrapContents = $false; $r.Margin = New-Object Windows.Forms.Padding(0, (Px $top), 0, 0); return $r }
# 상태 상자(⟳ 기다림 / ✓ 됨): 굵은 첫 줄 + 작은 둘째 줄(링크 가능)
function Add-Status([string]$kind, [string]$main, [string]$sub, [string]$link = $null, [scriptblock]$onLink = $null) {
  $p = New-Object Windows.Forms.Panel; $p.BackColor = $C.Line; $p.Padding = New-Object Windows.Forms.Padding(1); $p.AutoSize = $true
  $in = New-Object Windows.Forms.FlowLayoutPanel; $in.BackColor = [Drawing.Color]::FromArgb(250, 250, 250); $in.AutoSize = $true; $in.WrapContents = $false
  $in.Padding = New-Object Windows.Forms.Padding((Px 10), (Px 9), (Px 10), (Px 9)); $in.MinimumSize = New-Object Drawing.Size(($ContentW - 2), 0); $in.MaximumSize = New-Object Drawing.Size(($ContentW - 2), 0)
  $sym = New-Label $(switch ($kind) { 'ok' { [string][char]0x2713 } 'run' { [string][char]0x27F3 } default { '!' } }) (New-Font 15 'Bold' 'Segoe UI Symbol') $(switch ($kind) { 'ok' { $C.Ok } 'run' { $C.Accent } default { $C.Warn } })
  $sym.Margin = New-Object Windows.Forms.Padding(0, 0, (Px 8), 0)
  $col = New-Object Windows.Forms.FlowLayoutPanel; $col.FlowDirection = 'TopDown'; $col.WrapContents = $false; $col.AutoSize = $true; $col.Margin = New-Object Windows.Forms.Padding(0)
  $tw = $ContentW - (Px 64)
  $col.Controls.Add((New-Label $main $F.Bold $C.Text $tw))
  if ($link) {
    $ll = New-Object Windows.Forms.LinkLabel; $ll.AutoSize = $true; $ll.Font = $F.Small; $ll.LinkColor = $C.Accent; $ll.ForeColor = $C.Muted; $ll.MaximumSize = New-Object Drawing.Size($tw, 0)
    $t = Format-Wrap ($sub + ' ' + $link).TrimStart() $F.Small ($tw - (Px 24));  # LinkLabel은 링크 위치를 GDI+로 재서 글이 더 넓게 잡히므로 여유를 둔다
    $ll.Text = $t; $ll.LinkArea = New-Object Windows.Forms.LinkArea(($t.Length - $link.Length), $link.Length); $ll.Add_LinkClicked($onLink)
    $col.Controls.Add($ll)
  } elseif ($sub) { $col.Controls.Add((New-Label $sub $F.Small $C.Muted $tw)) }
  $in.Controls.Add($sym); $in.Controls.Add($col)
  $p.Controls.Add($in)
  [void](Add-Ctl $p 16)
}
# 실패 상자: 굵은 첫 줄 + 할 일 + 버튼들
function Add-Fail([string]$main, [string]$todo, [string]$small, $buttons) {
  $p = New-Object Windows.Forms.Panel; $p.BackColor = [Drawing.Color]::FromArgb(233, 179, 173); $p.Padding = New-Object Windows.Forms.Padding(1); $p.AutoSize = $true
  $in = New-Object Windows.Forms.FlowLayoutPanel; $in.FlowDirection = 'TopDown'; $in.WrapContents = $false; $in.AutoSize = $true; $in.BackColor = $C.FailBg
  $in.Padding = New-Object Windows.Forms.Padding((Px 11), (Px 9), (Px 11), (Px 9)); $in.MinimumSize = New-Object Drawing.Size(($ContentW - 2), 0)
  $in.Controls.Add((New-Label $main $F.Bold $C.Text ($ContentW - (Px 30))))
  if ($todo) { $in.Controls.Add((New-Label $todo $F.Body $C.Text ($ContentW - (Px 30)))) }
  if ($small) { $in.Controls.Add((New-Label $small $F.Small $C.Muted ($ContentW - (Px 30)))) }
  $r = New-Row 8; foreach ($b in $buttons) { $b.Margin = New-Object Windows.Forms.Padding(0, 0, (Px 8), 0); $r.Controls.Add($b) }; $in.Controls.Add($r)
  $p.Controls.Add($in)
  [void](Add-Ctl $p 12)
}
function New-BigBtn([string]$t) { New-Btn $t $true 150 34 }
function Open-Url([string]$u) { Write-Log "브라우저: $u"; if (-not $Demo) { try { Start-Process $u } catch { Write-Log "  열지 못함: $($_.Exception.Message)" } } }

function Save-Log {
  $d = New-Object Windows.Forms.SaveFileDialog
  $d.InitialDirectory = [Environment]::GetFolderPath('Desktop'); $d.FileName = 'wy-ops-설치기록-' + (Get-Date -Format 'yyyyMMdd') + '.txt'; $d.Filter = '텍스트 파일|*.txt'
  if ($d.ShowDialog($form) -eq 'OK') {
    try { Copy-Item -LiteralPath $LogPath -Destination $d.FileName -Force; [void][Windows.Forms.MessageBox]::Show($form, "기록을 저장했습니다: $([IO.Path]::GetFileName($d.FileName))", 'WY Ops 설치') }
    catch { [void][Windows.Forms.MessageBox]::Show($form, '기록을 저장하지 못했습니다. 다른 폴더를 골라 주세요.', 'WY Ops 설치') }
  }
}
function New-SaveLogBtn { $b = New-Btn '로그 저장…'; $b.Add_Click({ Save-Log }); return $b }

# ── 2단계 값 ──
function Get-DefaultName([string]$dir) {
  # lib/quickstart.js defaultName과 같은 규칙(영문·숫자·._- 아닌 글자는 '-', 앞의 기호·끝의 '-' 제거)
  $n = ([IO.Path]::GetFileName($dir.TrimEnd('\', '/')) -replace '[^A-Za-z0-9._-]+', '-') -replace '^[^A-Za-z0-9]+', '' -replace '-+$', ''
  if ($n.Length -gt 64) { $n = $n.Substring(0, 64) }
  return $n
}
function Test-Name([string]$n) { $n -cmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' }  # lib/install.js quickstart의 이름 규칙
function Get-PrefixFor([string]$n) { $p = ($n -replace '[^A-Za-z0-9]', ''); if ($p.Length -gt 2) { $p = $p.Substring(0, 2) }; if (-not $p) { $p = 'WY' }; return $p.ToUpper() + '-' }
function Test-InsidePkg([string]$dir) {
  try { $a = [IO.Path]::GetFullPath($dir).TrimEnd('\').ToLower(); $b = [IO.Path]::GetFullPath($Pkg).TrimEnd('\').ToLower(); return ($a -eq $b -or $a.StartsWith($b + '\')) } catch { return $true }
}
function Read-Existing([string]$dir) {
  $file = Join-Path $dir '.claude\wy-ops.json'
  if (-not (Test-Path -LiteralPath $file)) { return $null }
  try { return ([IO.File]::ReadAllText($file, [Text.Encoding]::UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json) } catch { return $null }
}
function Set-ProjectFolder([string]$dir) {
  $St.Project = $dir
  $St.Existing = Read-Existing $dir
  if ($St.Existing) {
    if ($St.Existing.project) { $St.Name = [string]$St.Existing.project; $St.NameTouched = $true }
    if ($St.Existing.rolePrefix) { $St.Prefix = [string]$St.Existing.rolePrefix; $St.PrefixTouched = $true }
    if ($St.Existing.stack) { $St.Stack = [string]$St.Existing.stack }
  } elseif (-not $St.NameTouched) { $St.Name = Get-DefaultName $dir }
  if (-not $St.PrefixTouched) { $St.Prefix = Get-PrefixFor $St.Name }
}

# ── 단계 화면 ──
$Stacks = @(@('', '자동으로 알아내기'), @('node', 'Node.js'), @('python', 'Python'), @('java-gradle', 'Java(Gradle)'), @('csharp', 'C#'), @('cpp', 'C++'), @('custom', '기타'))
$CountLabels = [ordered]@{ planner = @('기획', 1); backend = @('서버', 4); frontend = @('화면', 4); qa = @('테스트', 4); design = @('디자인', 1) }  # 최대값: 나눌 수 없는 역할은 1(templates/roles.json multi)

function Show-Step1 {
  Add-Title 'WY Ops 설치를 시작합니다'
  Add-Lead 'AI 도우미 여러 명이 한 프로젝트에서 나눠 일하도록 이 PC를 준비합니다. 화면의 안내대로 [다음]만 누르면 됩니다.'
  [void](Add-Ctl (New-Label '준비할 것' $F.Bold) 16)
  foreach ($t in '인터넷 연결', 'Claude 계정(유료 요금제)', 'GitHub 계정(없으면 중간에 만들 수 있습니다)') { [void](Add-Ctl (New-Label ([string][char]0x00B7 + '  ' + $t)) 6) }
  [void](Add-Ctl (New-Label '보통 10~20분 걸립니다. 중간에 멈춰도 다시 실행하면 이어서 합니다.' $F.Small $C.Muted) 16)
  $btnPrev.Enabled = $false; $btnNext.Enabled = $true
}

function Update-Step2Valid {
  $ok = $true; $msg = ''
  if (-not $St.Project -or -not [IO.Path]::IsPathRooted($St.Project)) { $ok = $false; $msg = '폴더를 골라 주세요.' }
  elseif (Test-InsidePkg $St.Project) { $ok = $false; $msg = '이 폴더에는 설치할 수 없습니다. 다른 폴더를 고르세요.' }
  $nameOk = Test-Name $St.Name
  $script:ui.FolderErr.Text = $msg; $script:ui.FolderErr.Visible = [bool]$msg
  $script:ui.NameErr.Visible = -not $nameOk; $script:ui.NameHint.Visible = $nameOk  # 오류 줄만 보이게
  $script:ui.NameBox.BackColor = [Drawing.Color]::White
  $btnNext.Enabled = $ok -and $nameOk
}
function Show-Step2 {
  Add-Title '프로젝트 폴더를 고르세요'
  if (-not $St.AdvOpen) { Add-Lead 'AI 도우미들이 일할 폴더입니다. 없는 폴더면 새로 만듭니다.' }
  $script:ui = @{}
  [void](Add-Ctl (New-Label '폴더' $F.Bold) 14)
  $r = New-Row 5
  $tb = New-Object Windows.Forms.TextBox; $tb.Width = $ContentW - (Px 104); $tb.Text = $St.Project; $tb.AccessibleName = '폴더'
  $br = New-Btn '찾아보기…'; $br.Margin = New-Object Windows.Forms.Padding((Px 8), 0, 0, 0)
  $r.Controls.Add($tb); $r.Controls.Add($br); $flow.Controls.Add($r)
  $script:ui.FolderErr = Add-Ctl (New-Label '' $F.Small $C.Bad) 4
  [void](Add-Ctl (New-Label '프로젝트 이름' $F.Bold) 12)
  $nb = New-Object Windows.Forms.TextBox; $nb.Width = Px 240; $nb.Text = $St.Name; $nb.AccessibleName = '프로젝트 이름'
  [void](Add-Ctl $nb 5)
  $script:ui.NameErr = Add-Ctl (New-Label '이름은 영문·숫자로 적어 주세요. 예: my-app' $F.Small $C.Bad) 4
  $script:ui.NameHint = Add-Ctl (New-Label '영문·숫자로 적습니다. 폴더 이름으로 채워 두었습니다.' $F.Small $C.Muted) 4
  if ($St.Existing) { [void](Add-Ctl (New-Label '이미 설정이 있어 빠진 것만 채웁니다.' $F.Small $C.Accent) 6) }
  $script:ui.NameBox = $nb
  # 고급(접힘)
  $line = New-Object Windows.Forms.Panel; $line.Height = 1; $line.Width = $ContentW; $line.BackColor = $C.Line; [void](Add-Ctl $line 16)
  $ar = New-Row 8
  $adv = New-Object Windows.Forms.LinkLabel; $adv.AutoSize = $true; $adv.LinkColor = $C.Accent
  $changed = ($St.Stack -or $St.PrefixTouched -or @($St.Counts.Keys | Where-Object { $St.Counts[$_] -ne $DefaultCounts[$_] }).Count)
  $adv.Text = if ($St.AdvOpen) { "고급 설정 $([char]0x25BE)" } else { "고급 설정 $([char]0x25B8)" }
  $ar.Controls.Add($adv); $ar.Controls.Add((New-Label $(if ($changed -and -not $St.AdvOpen) { '(바꿈)' } else { '(바꾸지 않아도 됩니다)' }) $F.Small $C.Muted))
  $flow.Controls.Add($ar)
  $adv.Add_LinkClicked({ $St.AdvOpen = -not $St.AdvOpen; Show-Step })
  if ($St.AdvOpen) {
    $pr = New-Row 8
    $pl = New-Label '역할 이름 앞글자' $F.Body $C.Text (Px 140); $pl.MinimumSize = New-Object Drawing.Size((Px 120), 0); $pl.Margin = New-Object Windows.Forms.Padding(0, (Px 3), 0, 0)
    $hp1 = New-HelpPanel 'AI 도우미마다 붙는 이름의 앞부분입니다. 예: MY-pm, MY-qa. 여러 프로젝트를 함께 쓸 때 구별하는 데 씁니다. 그대로 두어도 됩니다.'
    $pq = New-HelpButton '역할 이름 앞글자' $hp1
    $pb = New-Object Windows.Forms.TextBox; $pb.Width = Px 80; $pb.Text = $St.Prefix; $pb.AccessibleName = '역할 이름 앞글자'; $pb.Margin = New-Object Windows.Forms.Padding((Px 10), 0, 0, 0)
    $pr.Controls.AddRange(@($pl, $pq, $pb)); $flow.Controls.Add($pr); $flow.Controls.Add($hp1)
    $pb.Add_TextChanged({ param($s) $St.Prefix = $s.Text; $St.PrefixTouched = $true })
    $sr = New-Row 6
    $sl = New-Label '프로젝트 종류' $F.Body $C.Text (Px 140); $sl.MinimumSize = New-Object Drawing.Size((Px 120), 0); $sl.Margin = New-Object Windows.Forms.Padding(0, (Px 3), 0, 0)
    $hp2 = New-HelpPanel '만들려는 프로그램의 언어입니다. 폴더 안의 파일을 보고 알아서 고릅니다. 새 폴더면 ‘‘기타’’로 두어도 됩니다.'
    $sq = New-HelpButton '프로젝트 종류' $hp2
    $cb = New-Object Windows.Forms.ComboBox; $cb.DropDownStyle = 'DropDownList'; $cb.Width = Px 200; $cb.AccessibleName = '프로젝트 종류'; $cb.Margin = New-Object Windows.Forms.Padding((Px 10), 0, 0, 0)
    foreach ($s in $Stacks) { [void]$cb.Items.Add($s[1]) }
    $cb.SelectedIndex = [Math]::Max(0, [array]::IndexOf(@($Stacks | ForEach-Object { $_[0] }), $St.Stack))
    $cb.Add_SelectedIndexChanged({ param($s) $St.Stack = $Stacks[$s.SelectedIndex][0] })
    $sr.Controls.AddRange(@($sl, $sq, $cb)); $flow.Controls.Add($sr); $flow.Controls.Add($hp2)
    $cr = New-Object Windows.Forms.FlowLayoutPanel; $cr.AutoSize = $true; $cr.WrapContents = $true; $cr.MaximumSize = New-Object Drawing.Size($ContentW, 0); $cr.Margin = New-Object Windows.Forms.Padding(0, (Px 8), 0, (Px 14))  # 바닥에 붙지 않게
    $cl = New-Label '역할 수' $F.Body $C.Text (Px 140); $cl.MinimumSize = New-Object Drawing.Size((Px 150), 0); $cl.Margin = New-Object Windows.Forms.Padding(0, (Px 3), 0, 0); $cr.Controls.Add($cl)
    foreach ($k in $CountLabels.Keys) {
      $l = New-Label $CountLabels[$k][0] $F.Small; $l.Margin = New-Object Windows.Forms.Padding(0, (Px 4), (Px 3), 0)
      $n = New-Object Windows.Forms.NumericUpDown; $n.Minimum = 0; $n.Maximum = $CountLabels[$k][1]; $n.Value = $St.Counts[$k]; $n.Width = Px 44; $n.Tag = $k; $n.AccessibleName = "$($CountLabels[$k][0]) 역할 수"
      $n.Margin = New-Object Windows.Forms.Padding(0, 0, (Px 10), (Px 4))
      $n.Add_ValueChanged({ param($s) $St.Counts[$s.Tag] = [int]$s.Value })
      $pair = New-Object Windows.Forms.FlowLayoutPanel; $pair.AutoSize = $true; $pair.WrapContents = $false; $pair.Margin = New-Object Windows.Forms.Padding(0)
      $pair.Controls.Add($l); $pair.Controls.Add($n); $cr.Controls.Add($pair)  # 이름과 칸이 함께 줄바꿈되게
    }
    $flow.Controls.Add($cr)
  }
  $tb.Add_TextChanged({ param($s) Set-ProjectFolder $s.Text.Trim().Trim('"'); if (-not $St.NameTouched) { $script:ui.NameBox.Text = $St.Name }; Update-Step2Valid })
  $nb.Add_TextChanged({ param($s) if ($s.Focused) { $St.NameTouched = $true }; $St.Name = $s.Text.Trim(); if (-not $St.PrefixTouched) { $St.Prefix = Get-PrefixFor $St.Name }; Update-Step2Valid })
  $br.Add_Click({
      $d = New-Object Windows.Forms.FolderBrowserDialog; $d.Description = 'AI 도우미들이 일할 폴더를 고르세요'; $d.ShowNewFolderButton = $true
      if (Test-Path -LiteralPath $St.Project) { $d.SelectedPath = $St.Project }
      if ($d.ShowDialog($form) -eq 'OK') { $St.NameTouched = $false; $tb.Text = $d.SelectedPath }
    }.GetNewClosure())
  $btnPrev.Enabled = $true
  Update-Step2Valid
}

# 3단계 줄: 키, 이름, 도움말
$BaseRows = @(
  @{ Key = 'node'; Name = 'Node.js'; Help = 'WY Ops 도구가 돌아가는 데 필요한 프로그램입니다. 직접 실행할 일은 없습니다.' },
  @{ Key = 'gh'; Name = 'GitHub 연결 도구'; Help = '이 PC를 GitHub 계정에 연결해 주는 작은 프로그램입니다(이름: GitHub CLI). 직접 실행할 일은 없습니다.' },
  @{ Key = 'code'; Name = 'VS Code' }, @{ Key = 'claude'; Name = 'Claude Code' },
  @{ Key = 'ops'; Name = 'WY Ops 도구' }, @{ Key = 'folder'; Name = '프로젝트 폴더 준비' }
)
function Initialize-Rows {
  $St.Rows = New-Object Collections.ArrayList
  foreach ($r in $BaseRows) { [void]$St.Rows.Add(@{ Key = $r.Key; Name = $r.Name; Help = $r.Help; State = 'wait'; Ui = $null }) }
}
function Find-Row([string]$k) { foreach ($r in $St.Rows) { if ($r.Key -eq $k) { return $r } }; return $null }
$RowText = @{ wait = '기다림'; run = '설치 중…'; have = '이미 있음'; installed = '설치함'; done = '마침'; fail = '설치하지 못함' }
function Update-RowUi($r) {
  if (-not $r.Ui) { return }
  $sym = switch ($r.State) { 'run' { [char]0x27F3 } 'fail' { [char]0x2715 } 'wait' { [char]0x00B7 } default { [char]0x2713 } }
  $col = switch ($r.State) { 'run' { $C.Accent } 'fail' { $C.Bad } 'wait' { $C.Wait } default { $C.Ok } }
  $r.Ui.Sym.Text = [string]$sym; $r.Ui.Sym.ForeColor = $col
  $r.Ui.St.Text = $(if ($r.Key -eq 'folder' -and $r.State -eq 'run') { '준비 중…' } else { $RowText[$r.State] })
  $r.Ui.St.ForeColor = $(if ($r.State -eq 'run') { $C.Accent } elseif ($r.State -eq 'fail') { $C.Bad } else { $C.Muted })
}
function Update-Progress {
  $n = @($St.Rows | Where-Object { $_.State -in 'have', 'installed', 'done' }).Count
  $script:ui.Bar.Maximum = $St.Rows.Count; $script:ui.Bar.Value = [Math]::Min($n, $St.Rows.Count)
  $script:ui.Count.Text = $(if ($St.Installed) { '설치를 마쳤습니다.' } else { "$($St.Rows.Count)개 중 $($n)개 끝남" })
}
function Show-Step3 {
  Add-Title '필요한 프로그램을 설치합니다'
  $script:ui = @{}
  if (-not $St.FailMsg) { Add-Lead '“변경을 허용할까요?” 창이 뜨면 [예]를 누르세요.' }
  $first = $true
  foreach ($r in $St.Rows) {
    $row = New-Object Windows.Forms.TableLayoutPanel; $row.ColumnCount = 3; $row.RowCount = 1; $row.Height = Px 28; $row.Width = $ContentW
    [void]$row.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Absolute', (Px 26)))); [void]$row.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Percent', 100))); [void]$row.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Absolute', (Px 118))))
    $sym = New-Label '' (New-Font 10 'Bold' 'Segoe UI Symbol'); $sym.Anchor = 'Left'; $sym.Margin = New-Object Windows.Forms.Padding((Px 2), 0, 0, 0)
    $nm = New-Object Windows.Forms.FlowLayoutPanel; $nm.AutoSize = $true; $nm.WrapContents = $false; $nm.Anchor = 'Left'; $nm.Margin = New-Object Windows.Forms.Padding(0)
    $nl = New-Label $r.Name; $nl.Margin = New-Object Windows.Forms.Padding(0, (Px 3), 0, 0); $nm.Controls.Add($nl)
    $hp = $null
    if ($r.Help) { $hp = New-HelpPanel $r.Help; $nm.Controls.Add((New-HelpButton $r.Name $hp)) }
    $stl = New-Label '' $F.Small $C.Muted; $stl.Anchor = 'Left'
    $row.Controls.Add($sym, 0, 0); $row.Controls.Add($nm, 1, 0); $row.Controls.Add($stl, 2, 0)
    $row.Margin = New-Object Windows.Forms.Padding(0, $(if ($first) { Px 12 } else { 0 }), 0, 0); $first = $false
    $sep = New-Object Windows.Forms.Panel; $sep.Height = 1; $sep.Width = $ContentW; $sep.BackColor = [Drawing.Color]::FromArgb(240, 240, 240); $sep.Margin = New-Object Windows.Forms.Padding(0)
    $flow.Controls.Add($row); $flow.Controls.Add($sep); if ($hp) { $flow.Controls.Add($hp) }
    $r.Ui = @{ Sym = $sym; St = $stl }
    Update-RowUi $r
  }
  if ($St.FailMsg) {
    $retry = New-Btn '다시 시도' $true; $retry.Add_Click({ Start-Install })
    $btns = @($retry, (New-SaveLogBtn))
    if ($St.FailMsg.Help) { $hp = New-HelpPanel $St.FailMsg.Help; $q = New-HelpButton '작업 기록 공간' $hp; $btns += $q }
    Add-Fail $St.FailMsg.Main $St.FailMsg.Todo '계속 안 되면 [로그 저장]으로 기록을 저장해 도움을 요청하세요.' $btns
    if ($St.FailMsg.Help) { $flow.Controls.Add($hp) }
  } else {
    $bar = New-Object Windows.Forms.ProgressBar; $bar.Width = $ContentW; $bar.Height = Px 16; $bar.Style = 'Continuous'
    $script:ui.Bar = Add-Ctl $bar 14
    $script:ui.Count = Add-Ctl (New-Label '' $F.Small $C.Muted) 4
    Update-Progress
  }
  $btnPrev.Enabled = [bool]($St.FailMsg -and $St.FailMsg.Prev)
  $btnNext.Enabled = $St.Installed
}

function Get-FailMsg($row, [string]$code, [string]$text) {
  $nm = $row.Name
  if ($code -eq 'nowinget') { return @{ Main = '이 PC에서 프로그램을 자동으로 설치할 수 없습니다.'; Todo = 'Microsoft Store에서 ‘‘앱 설치 관리자’’를 업데이트한 뒤 [다시 시도]를 누르세요.' } }
  if ($text -match '(?i)\b(1602|1223)\b|0x800704c7|cancel') { return @{ Main = "$nm 설치가 허용되지 않았습니다."; Todo = '[다시 시도]를 누르고, 창이 뜨면 [예]를 누르세요.' } }
  if ($row.Key -eq 'folder') {
    if ($text -match 'git init') { return @{ Main = '폴더에 작업 기록 공간을 만들지 못했습니다.'; Todo = '[다시 시도]를 누르세요.'; Help = '폴더 안에 바뀐 기록을 모아 두는 공간입니다. 영어로 repository라고 합니다.' } }
    if ($text -match '(?i)EPERM|EACCES|ENOENT|EBUSY|mkdir') { return @{ Main = '이 폴더를 만들 수 없습니다.'; Todo = '[이전]을 눌러 다른 폴더를 고르세요.'; Prev = $true } }
  }
  if ($text -match '(?i)download|0x8a15000[0-9a-f]|0x80072ee|0x80190|network|internet|timed out|ETIMEDOUT|ENOTFOUND|ECONNRESET') { return @{ Main = "$($nm)를 받지 못했습니다."; Todo = '인터넷 연결을 확인하고 [다시 시도]를 누르세요.' } }
  return @{ Main = "$nm 중에 문제가 생겼습니다."; Todo = '[다시 시도]를 누르세요.' }
}

function Get-InstallCmd {
  $a = @('quickstart', '--project', (Q $St.Project), '--name', $St.Name, '--yes', '--progress', '--no-finish')
  if ($St.PrefixTouched -and $St.Prefix) { $a += @('--prefix', $St.Prefix) }
  if ($St.Stack) { $a += @('--stack', $St.Stack) }
  $diff = @($St.Counts.Keys | Where-Object { $St.Counts[$_] -ne $DefaultCounts[$_] } | ForEach-Object { "$_=$($St.Counts[$_])" })
  if ($diff.Count) { $a += @('--count', ($diff -join ',')) }
  return 'powershell -NoProfile -ExecutionPolicy Bypass -File ' + (Q (Join-Path $Pkg 'install.ps1')) + ' ' + ($a -join ' ')
}
function Start-Install {
  $St.FailMsg = $null; $St.Installed = $false
  foreach ($r in $St.Rows) { if ($r.State -in 'run', 'fail') { $r.State = 'wait' } }
  $cmd = if ($Demo) {
    Get-DemoCmd @('@@tool node have', '@@tool git have', '@@tool gh installing', '설치: GitHub CLI', '@@tool gh installed', '@@tool code have', '@@tool claude installing', '@@tool claude installed', '@@step global start', '@@step global done', '@@step folder start', '@@claudemd create', '@@step folder done') 0.5
  } else { Get-InstallCmd }
  $St.Run = Start-Hidden $cmd
  $St.RunSeg = New-Object Text.StringBuilder
  Show-Step
}
function Read-Install {
  $run = $St.Run
  foreach ($line in (Read-Hidden $run)) {
    [void]$St.RunSeg.AppendLine($line)
    if ($line -match '^@@tool (\S+) (\S+)\s*(\S*)\s*(.*)$') {
      $k = $Matches[1]; $state = $Matches[2]; $code = $Matches[3]; $label = $Matches[4]
      $r = Find-Row $k
      if (-not $r) {
        if ($state -eq 'have') { continue }  # Git 등 목록에 없는 도구는 이미 있으면 보이지 않음
        $nm = if ($label) { $label } elseif ($k -eq 'git') { 'Git' } else { $k }
        $r = @{ Key = $k; Name = $nm; State = 'wait'; Ui = $null }
        $at = $(if ($k -like 'stack-*') { $St.Rows.IndexOf((Find-Row 'folder')) } else { $St.Rows.IndexOf((Find-Row 'ops')) })
        $St.Rows.Insert($at, $r); Show-Step
      }
      switch ($state) {
        'have' { $r.State = 'have' }
        'installing' { $r.State = 'run'; $St.RunSeg = New-Object Text.StringBuilder }
        'installed' { $r.State = 'installed' }
        'failed' { $r.State = 'fail'; $St.FailMsg = Get-FailMsg $r $code $St.RunSeg.ToString() }
      }
      Update-RowUi $r
      if ($state -ne 'installing' -and $St.CancelPending) { Stop-Hidden $run; Close-Wizard; return }
    } elseif ($line -match '^@@fail nowinget') {
      $r = @($St.Rows | Where-Object { $_.State -eq 'wait' })[0]; if ($r) { $r.State = 'fail'; $St.FailMsg = Get-FailMsg $r 'nowinget' '' }
    } elseif ($line -match '^@@step (global|folder) (start|done)') {
      $r = Find-Row $(if ($Matches[1] -eq 'global') { 'ops' } else { 'folder' })
      if ($Matches[2] -eq 'start') { $r.State = 'run'; $St.RunSeg = New-Object Text.StringBuilder } else { $r.State = $(if ($r.Key -eq 'folder') { 'done' } else { 'installed' }) }
      Update-RowUi $r
      if ($St.CancelPending) { Stop-Hidden $run; Close-Wizard; return }
    } elseif ($line -match '^@@claudemd (\S+)') { $St.ClaudeMd = $Matches[1] }
    if ($script:ui.Bar) { Update-Progress }
  }
  if ($null -ne $run.Exit) {
    $St.Run = $null
    if ($St.CancelPending) { Close-Wizard; return }
    if ($run.Exit -eq 0 -and (Find-Row 'folder').State -eq 'done') {
      $St.Installed = $true; $St.Done[3] = $true
      if (-not $Demo) { Update-PathFromRegistry }
      Show-Step; $btnNext.Focus()
    } else {
      if (-not $St.FailMsg) {
        $r = @($St.Rows | Where-Object { $_.State -eq 'run' })[0]
        if (-not $r) { $r = @($St.Rows | Where-Object { $_.State -eq 'wait' })[0] }
        if (-not $r) { $r = $St.Rows[$St.Rows.Count - 1] }
        $r.State = 'fail'; $St.FailMsg = Get-FailMsg $r '' $St.RunSeg.ToString()
      }
      Show-Step
    }
  }
}

# 2초마다 확인하는 명령(한 번에 하나): 끝나면 $onDone(종료 코드, 출력)
function Start-Poll([string]$cmd, [scriptblock]$onDone) { $St.Poll = @{ R = (Start-Hidden $cmd); Done = $onDone } }
function Read-Poll {
  if (-not $St.Poll) { return }
  [void](Read-Hidden $St.Poll.R)
  if ($null -ne $St.Poll.R.Exit) { $p = $St.Poll; $St.Poll = $null; $St.PollAt = Get-Date; & $p.Done $p.R.Exit ($p.R.Lines -join "`n") }
}
$PollEvery = [TimeSpan]::FromSeconds(2)
$DemoTick = @{ claude = 0; gh = 0; trust = 0 }
function Get-StatusCmd([string]$what) {
  if ($Demo) {
    $DemoTick[$what]++
    switch ($what) {
      'claude' { if ($env:WY_SETUP_DEMO_PASTE -and -not $St.DemoPasted) { return Get-DemoCmd @('{"loggedIn": false}') 0.1 }; if ($DemoTick.claude -gt 3) { return Get-DemoCmd @('{"loggedIn": true}') 0.1 } else { return Get-DemoCmd @('{"loggedIn": false}') 0.1 } }
      'gh' { if ($DemoTick.gh -gt 3) { return Get-DemoCmd @('Logged in') 0.1 0 } else { return Get-DemoCmd @('not logged in') 0.1 1 } }
      'trust' { if ($DemoTick.trust -gt 3) { return Get-DemoCmd @('{"ok":true}') 0.1 0 } else { return Get-DemoCmd @('{"ok":false}') 0.1 1 } }
    }
  }
  switch ($what) {
    'claude' { return 'claude auth status --json' }
    'gh' { return 'gh auth status' }
    'trust' { return $Node + ' trust --check --project ' + (Q $St.Project) }
  }
}
function Test-ClaudeOut([string]$out) { try { return [bool](($out | ConvertFrom-Json).loggedIn) } catch { return ($out -match '"loggedIn"\s*:\s*true') } }

function Show-Step4 {
  Add-Title 'Claude에 로그인하세요'
  Add-Lead '브라우저에서 로그인하면 이 창이 알아서 확인합니다.'
  if ($St.ClaudeOk) {
    Add-Status 'ok' $(if ($St.ClaudeWasOk) { '이미 로그인되어 있습니다.' } else { '로그인되었습니다.' }) '[다음]을 누르세요.'
  } else {
    [void](Add-TextWithHelp 'Claude 계정(유료 요금제)이 필요합니다' '유료 요금제' 'AI 도우미는 Claude Code라는 프로그램으로 일하고, 이 프로그램은 Claude Pro 이상 요금제에서 쓸 수 있습니다. 요금제는 claude.ai의 설정에서 고릅니다.' $F.Body 12)
    if ($St.Waiting -eq 'claude') {
      $late = ((Get-Date) - $St.WaitSince).TotalMinutes -ge 5
      Add-Status 'run' $(if ($late) { '아직 로그인이 확인되지 않았습니다. 브라우저에서 로그인을 마쳤나요?' } else { '브라우저에서 로그인을 기다리는 중입니다.' }) $(if ($late) { '' } else { '로그인을 마치면 자동으로 다음으로 넘어갈 수 있습니다. 브라우저가 안 열렸으면' }) '다시 열기' { Start-ClaudeLogin }
      # W4-d~f: 브라우저가 결과를 이 창에 못 돌려주고 코드를 보여 주는 경우(카드 20261011-0430). 1분 뒤 또는 '아직 확인 안 됨'
      if ($St.PasteOpen) { Add-PasteBox }
      elseif ($late -or ((Get-Date) - $St.WaitSince) -ge $CodeLinkAfter) {
        $pl = New-Object Windows.Forms.LinkLabel; $pl.AutoSize = $true; $pl.Font = $F.Small; $pl.LinkColor = $C.Accent; $pl.Text = '브라우저에 코드가 보이나요?'
        $pl.Add_LinkClicked({ $St.PasteOpen = $true; Show-Step }); [void](Add-Ctl $pl 10)
      }
    } else {
      $b = New-BigBtn '브라우저 열기'; $b.Add_Click({ Start-ClaudeLogin }); [void](Add-Ctl $b 18)
      $ll = New-Object Windows.Forms.LinkLabel; $ll.AutoSize = $true; $ll.Font = $F.Small; $ll.ForeColor = $C.Muted; $ll.LinkColor = $C.Accent; $ll.Text = '계정이 없나요? 계정 만들기'; $ll.LinkArea = New-Object Windows.Forms.LinkArea(9, 6)
      $ll.Add_LinkClicked({ Open-Url 'https://claude.ai/signup' }); [void](Add-Ctl $ll 10)
    }
  }
  $btnPrev.Enabled = $true; $btnNext.Enabled = $St.ClaudeOk
}
$CodeLinkAfter = [TimeSpan]::FromSeconds($(if ($Demo -and $env:WY_SETUP_DEMO_PASTE) { 3 } else { 60 }))  # 시험에서 붙여넣기 흐름을 볼 때만 3초
# 코드 입력 칸(W4-e), 틀리면 빨간 테두리·값 유지·오류 한 줄 + [다시 열기](W4-f)
function Add-PasteBox {
  [void](Add-Ctl (New-Label '브라우저에 보이는 코드를 붙여 넣으세요' $F.Bold) 14)
  $r = New-Row 6
  $box = New-Object Windows.Forms.Panel; $box.AutoSize = $true; $pad = $(if ($St.PasteBad) { 2 } else { 0 }); $box.Padding = New-Object Windows.Forms.Padding($pad); $box.BackColor = $C.Bad; $box.Margin = New-Object Windows.Forms.Padding(0)
  $tb = New-Object Windows.Forms.TextBox; $tb.Width = $ContentW - (Px 110); $tb.Text = $St.PasteText; $tb.AccessibleName = '로그인 코드'; $tb.Margin = New-Object Windows.Forms.Padding(0); $tb.Location = New-Object Drawing.Point($pad, $pad)  # Panel은 Padding으로 자식을 옮기지 않으므로 직접(빨간 테두리가 네 변에)
  $box.Controls.Add($tb)
  $tb.Add_HandleCreated({ param($s) [void][WyOps.Native]::SendMessage($s.Handle, 0x1501, [IntPtr]1, '코드 붙여 넣기') })  # 자리표시 글(창에 붙기 전에 걸어야 함)
  $ok = New-Btn $(if ($St.PasteBusy) { '확인 중…' } else { '확인' }) $true; $ok.Margin = New-Object Windows.Forms.Padding((Px 8), 0, 0, 0)
  if ($St.PasteBusy) { $ok.Enabled = $false; Set-Primary $ok $false; $tb.ReadOnly = $true }
  $r.Controls.AddRange(@($box, $ok)); $flow.Controls.Add($r)
  $tb.Add_TextChanged({ param($s) $St.PasteText = $s.Text })
  $tb.Add_KeyDown({ param($s, $e) if ($e.KeyCode -eq 'Enter') { $e.SuppressKeyPress = $true; Submit-ClaudeCode } })
  $ok.Add_Click({ Submit-ClaudeCode })
  if ($St.PasteBad) {
    [void](Add-Ctl (New-Label '코드가 맞지 않습니다. [다시 열기]를 눌러 새 코드를 받으세요.' $F.Small $C.Bad) 6)
    $again = New-Btn '다시 열기'; $again.Add_Click({ $St.PasteText = ''; Start-ClaudeLogin }); [void](Add-Ctl $again 8)
  } else {
    $ll = New-Object Windows.Forms.LinkLabel; $ll.AutoSize = $true; $ll.Font = $F.Small; $ll.ForeColor = $C.Muted; $ll.LinkColor = $C.Accent
    $t = '코드가 안 보이면 코드 받는 주소 열기'; $ll.Text = $t; $ll.LinkArea = New-Object Windows.Forms.LinkArea(10, ($t.Length - 10))
    $ll.Add_LinkClicked({ Open-ClaudeUrl }); [void](Add-Ctl $ll 8)
  }
  $script:FocusCtl = $(if ($St.PasteBusy) { $null } else { $tb })
}
# 같은 로그인 과정의 주소를 다시 연다(과정이 끝났으면 처음부터)
function Open-ClaudeUrl {
  if ($St.ClaudeUrl -and $St.LoginRun -and $null -eq $St.LoginRun.Exit) { Open-Url $St.ClaudeUrl } else { Start-ClaudeLogin }
}
# 붙여 넣은 코드를 claude auth login의 stdin으로. 결과는 타이머가 출력('Login failed')·종료 코드로 본다
function Submit-ClaudeCode {
  $code = $St.PasteText.Trim()
  if (-not $code -or $St.PasteBusy) { return }
  if (-not $St.LoginRun -or $null -ne $St.LoginRun.Exit) { $St.PasteBad = $true; Show-Step; return }  # 과정이 이미 끝나 옛 코드는 못 씀
  Write-Log '로그인 코드를 넘김(값은 적지 않음)'
  if ($Demo) {
    # 시험: 'x9Z'로 끝나면 틀린 코드, 아니면 맞는 코드
    Stop-Hidden $St.LoginRun
    $St.LoginRun = Start-Hidden $(if ($code -match 'x9Z$') { Get-DemoCmd @('Login failed: Request failed with status code 400') 0.8 1 } else { $St.DemoPasted = $true; Get-DemoCmd @('Login successful') 0.8 0 })
  } else {
    try { $St.LoginRun.P.StandardInput.WriteLine($code); $St.LoginRun.P.StandardInput.Flush() } catch { Write-Log "  넘기지 못함: $($_.Exception.Message)"; $St.PasteBad = $true; Show-Step; return }
  }
  $St.PasteBusy = $true; $St.PasteBad = $false; Show-Step
}
function Start-ClaudeLogin {
  Stop-Hidden $St.LoginRun
  $St.ClaudeUrl = $null; $St.PasteBusy = $false; $St.PasteBad = $false
  $St.LoginRun = Start-Hidden $(if ($Demo) { '(echo Opening browser to sign in...& echo If the browser did not open, visit: https://claude.com/cai/oauth/authorize?demo=1& ping -n 1 -w 600000 10.255.255.1 >nul& exit /b 0)' } else { 'claude auth login' }) -KeepInput
  if ($St.Waiting -ne 'claude') { $St.WaitSince = Get-Date }
  $St.Waiting = 'claude'; Show-Step
}

function Show-Step5 {
  Add-Title 'GitHub에 로그인하세요'
  if ($St.GhOk) {
    Add-Lead '만든 작업을 GitHub에 안전하게 보관합니다.'
    Add-Status 'ok' $(if ($St.GhWasOk) { '이미 로그인되어 있습니다.' } else { 'GitHub에 로그인되었습니다.' }) '[다음]을 누르세요.'
  } elseif ($St.Waiting -eq 'gh' -and $St.GhCode) {
    [void](Add-TextWithHelp '열린 브라우저에 아래 코드를 넣으세요.' '확인 코드' '이 PC와 브라우저의 로그인을 짝지어 주는 일회용 코드입니다. 몇 분 뒤 만료되면 [새 코드 받기]를 누르세요.')
    $r = New-Row 10
    $code = New-Object Windows.Forms.Label; $code.AutoSize = $true; $code.Font = $F.Code; $code.Text = $St.GhCode; $code.BorderStyle = 'FixedSingle'; $code.BackColor = [Drawing.Color]::White
    $code.Padding = New-Object Windows.Forms.Padding((Px 12), (Px 8), (Px 12), (Px 8)); $code.AccessibleName = '확인 코드'
    $cp = New-Btn '코드 복사'; $cp.Margin = New-Object Windows.Forms.Padding((Px 12), (Px 12), 0, 0)
    $cp.Add_Click({ param($s) try { [Windows.Forms.Clipboard]::SetText($St.GhCode) } catch { }; $s.Text = '복사함'; $script:CopyReset = (Get-Date).AddSeconds(2); $script:CopyBtn = $s })
    $r.Controls.AddRange(@($code, $cp))
    # 코드가 만료(gh가 실패로 끝남)된 뒤에만 [새 코드 받기]
    if ($St.GhExpired) { $nc = New-Btn '새 코드 받기' $true; $nc.Margin = New-Object Windows.Forms.Padding((Px 8), (Px 12), 0, 0); $nc.Add_Click({ Start-GhLogin }); $r.Controls.Add($nc) }
    $flow.Controls.Add($r)
    if ($St.GhExpired) { Add-Status 'warn' '코드가 만료되었습니다.' '[새 코드 받기]를 눌러 새 코드를 받으세요.' }
    else { Add-Status 'run' '브라우저에서 로그인을 기다리는 중입니다.' '브라우저가 안 열렸으면' '다시 열기' { Open-Url 'https://github.com/login/device' } }
  } else {
    [void](Add-TextWithHelp '만든 작업을 GitHub에 안전하게 보관합니다.' 'GitHub' 'GitHub는 프로젝트 파일과 바뀐 기록을 인터넷에 보관하는 서비스입니다. PC가 고장 나도 작업이 남고, 다른 PC에서 이어서 할 수 있습니다. 무료 계정으로 충분합니다.')
    if ($St.Waiting -eq 'gh') { Add-Status 'run' '확인 코드를 받는 중입니다.' '잠시 기다려 주세요.' }
    elseif ($St.GhFail) { Add-Fail '확인 코드를 받지 못했습니다.' '인터넷 연결을 확인하고 [브라우저 열기]를 다시 누르세요.' $null @((New-SaveLogBtn)) }
    $b = New-BigBtn '브라우저 열기'; $b.Add_Click({ Start-GhLogin }); [void](Add-Ctl $b 14)
    $ll = New-Object Windows.Forms.LinkLabel; $ll.AutoSize = $true; $ll.Font = $F.Small; $ll.ForeColor = $C.Muted; $ll.LinkColor = $C.Accent; $ll.Text = '계정이 없나요? 가입하기'; $ll.LinkArea = New-Object Windows.Forms.LinkArea(9, 4)
    $ll.Add_LinkClicked({ Open-Url 'https://github.com/signup' }); [void](Add-Ctl $ll 10)
  }
  $lnkLater.Visible = -not $St.GhOk
  $btnPrev.Enabled = $true; $btnNext.Enabled = $St.GhOk
}
function Start-GhLogin {
  Stop-Hidden $St.LoginRun
  $St.GhCode = $null; $St.GhFail = $false; $St.GhOpened = $false; $St.GhExpired = $false
  $St.LoginRun = Start-Hidden $(if ($Demo) { Get-DemoCmd @('! First copy your one-time code: 4F2A-9C1B', 'Open this URL to continue in your web browser: https://github.com/login/device') 6 } else { 'gh auth login --web --git-protocol https --hostname github.com' })
  $St.Waiting = 'gh'; $St.WaitSince = Get-Date; Show-Step
}

function Show-Step6 {
  Add-Title '이 폴더를 Claude에게 허락하세요'
  [void](Add-TextWithHelp 'Claude가 이 폴더의 파일을 읽고 고칠 수 있게 됩니다.' '폴더 사용 허락' 'Claude는 처음 여는 폴더마다 “이 폴더를 믿을까요?”(영어로 “trust this folder”)를 묻습니다. 여기서 한 번 허락하면 다시 묻지 않습니다. 다른 폴더에는 영향이 없습니다.')
  $tb = New-Object Windows.Forms.TextBox; $tb.ReadOnly = $true; $tb.Text = $St.Project; $tb.Width = $ContentW; $tb.BackColor = $C.Foot; $tb.AccessibleName = '허락할 폴더'; $tb.TabStop = $false
  [void](Add-Ctl $tb 10)
  if ($St.TrustOk) { Add-Status 'ok' $(if ($St.TrustWasOk) { '이미 허락되어 있습니다.' } else { '허락했습니다.' }) '[다음]을 누르세요.' }
  elseif ($St.TrustFail) {
    $open = New-Btn 'Claude 창 열기' $true; $open.Add_Click({ Open-ClaudeWindow })
    Add-Fail '허락을 자동으로 기록하지 못했습니다.' 'Claude 창에서 직접 허락해 주세요.' '창에서 “Yes, I trust this folder”를 고르고(Enter) 창을 닫으세요.' @($open, (New-SaveLogBtn))
    if ($St.TrustWindow) { Add-Status 'run' 'Claude 창에서 허락을 기다리는 중입니다.' '허락하면 자동으로 다음으로 넘어갈 수 있습니다.' }
  } else {
    $b = New-BigBtn '허락하기'; $b.Add_Click({ Start-Trust }); [void](Add-Ctl $b 18)
    if ($St.Waiting -eq 'trust-write') { $b.Enabled = $false }
  }
  $btnPrev.Enabled = $true; $btnNext.Enabled = $St.TrustOk
}
function Start-Trust {
  $St.Waiting = 'trust-write'; Show-Step
  $cmd = if ($Demo) { Get-DemoCmd @('{"ok":false,"error":"demo"}') 0.3 1 } else { $Node + ' trust --project ' + (Q $St.Project) }
  Start-Poll $cmd { param($code, $out)
    $St.Waiting = $null
    if ($code -eq 0) { $St.TrustOk = $true; $St.Done[6] = $true } else { $St.TrustFail = $true; Write-Log "폴더 허락 기록 실패: $out" }
    Show-Step; if ($St.TrustOk) { $btnNext.Focus() }
  }
}
function Open-ClaudeWindow {
  Write-Log "Claude 창 열기: $($St.Project)"
  if (-not $Demo) {
    if (-not (Test-Path -LiteralPath $St.Project)) { New-Item -ItemType Directory -Path $St.Project -Force | Out-Null }
    Start-Process -FilePath $env:ComSpec -ArgumentList '/k', 'claude' -WorkingDirectory $St.Project
  }
  $St.TrustWindow = $true; $St.Waiting = 'trust'; Show-Step
}

# 7단계: 점검 결과를 거친 단계 이름으로 묶는다(점검 항목 이름은 숨김)
$Groups = [ordered]@{ install = '프로그램 설치'; folder = '프로젝트 폴더 준비'; claude = 'Claude 로그인'; gh = 'GitHub 로그인'; trust = '폴더 사용 허락' }
function Get-GroupOf([string]$id) {
  switch ($id) { 'tools' { 'install' } 'stack-tools' { 'install' } 'login-github' { 'gh' } 'host' { $null } default { 'folder' } }
}
function Start-Doctor {
  $St.Doctor = $null; $St.Waiting = 'doctor'
  $cmd = if ($Demo) {
    $j = if ($St.GhSkipped -and -not $St.GhOk) { '[{"id":"tools","level":"ok"},{"id":"login-github","level":"warn","title":"GitHub 로그인"}]' } else { '[{"id":"tools","level":"ok"},{"id":"login-github","level":"ok"}]' }
    Get-DemoCmd @($j) 0.2
  } else { $Node + ' doctor --json --todos --project ' + (Q $St.Project) }
  Start-Poll $cmd { param($code, $out)
    $St.Waiting = $null
    $json = ($out -split "`n" | Where-Object { $_ -notmatch '^할 일 카드' }) -join "`n"
    try { $St.Doctor = @($json | ConvertFrom-Json) } catch { $St.Doctor = @(); Write-Log "점검 결과를 읽지 못함: $($_.Exception.Message)" }
    Show-Step
  }
}
function Get-Final {
  $lv = @{ install = 'ok'; folder = 'ok'; claude = $(if ($St.ClaudeOk) { 'ok' } else { 'warn' }); gh = 'ok'; trust = $(if ($St.TrustOk) { 'ok' } else { 'warn' }) }
  $detail = @{}
  foreach ($r in @($St.Doctor)) {
    $gname = Get-GroupOf $r.id; if (-not $gname) { continue }
    if ($r.level -eq 'fail' -or ($r.level -eq 'warn' -and $lv[$gname] -eq 'ok')) { $lv[$gname] = $r.level }
    if ($r.level -ne 'ok') { if (-not $detail[$gname]) { $detail[$gname] = @() }; $detail[$gname] += ("$($r.title)$(if ($r.detail) { ': ' + $r.detail })$(if ($r.fix) { "`n  할 일: " + $r.fix })") }
  }
  if (-not $St.Installed) { $lv.install = 'fail' }
  if ($St.GhSkipped -and -not $St.GhOk) { $lv.gh = 'warn' }
  return @{ Lv = $lv; Detail = $detail }
}
function Show-Step7 {
  if ($null -eq $St.Doctor) {
    Add-Title '설치를 마무리하고 있습니다'
    Add-Status 'run' '마지막 점검 중입니다.' '잠시 기다려 주세요.'
    $btnPrev.Enabled = $false; $btnNext.Enabled = $false
    if ($St.Waiting -ne 'doctor') { Start-Doctor }
    return
  }
  $fin = Get-Final; $lv = $fin.Lv
  $bad = @($Groups.Keys | Where-Object { $lv[$_] -eq 'fail' })
  $left = New-Object Collections.ArrayList
  if ($lv.gh -eq 'warn') { [void]$left.Add(@{ Text = 'GitHub 로그인을 건너뛰었습니다'; Btn = '지금 하기'; Go = 5 }) }
  if ($lv.claude -eq 'warn') { [void]$left.Add(@{ Text = 'Claude 로그인이 확인되지 않았습니다'; Btn = '지금 하기'; Go = 4 }) }
  if ($lv.trust -eq 'warn') { [void]$left.Add(@{ Text = '폴더 사용 허락이 확인되지 않았습니다'; Btn = '지금 하기'; Go = 6 }) }
  if ($St.ClaudeMd -eq 'append') { [void]$left.Add(@{ Text = '프로젝트 규칙 파일이 이미 있어 그대로 두었습니다'; Btn = '붙일 내용 보기'; Note = $true; Help = 'AI 도우미가 읽는 규칙 파일(CLAUDE.md)입니다. 이미 있던 파일은 고치지 않았습니다. [붙일 내용 보기]로 연 내용을 그 파일 끝에 붙여 넣으세요.' }) }
  foreach ($k in 'install', 'folder') { if ($lv[$k] -eq 'warn') { [void]$left.Add(@{ Text = "$($Groups[$k])에 확인할 것이 있습니다"; Btn = '자세히'; Detail = ($fin.Detail[$k] -join "`n`n") }) } }
  if ($bad.Count) { Add-Title '설치를 끝내지 못했습니다' }
  elseif ($left.Count) { Add-Title "설치를 마쳤습니다 (남은 일 $($left.Count)개)" }
  else { Add-Title '설치를 마쳤습니다' }
  if ($left.Count -and -not $bad.Count) { Add-Lead '지금 해도 되고, 나중에 VS Code의 WY Ops 화면에서 해도 됩니다.' }
  elseif (-not $bad.Count) { [void](Add-TextWithHelp 'VS Code를 열고 왼쪽 막대의 WY Ops 아이콘을 누르세요.' 'WY Ops 아이콘' 'VS Code 왼쪽 세로 막대에 있는 WY 모양 아이콘입니다. 누르면 AI 도우미들의 상태와 승인할 일이 보입니다. 안 보이면 VS Code를 닫았다가 다시 여세요.') }
  $first = $true
  function Add-ResultRow([string]$kind, [string]$text, $btn, [string]$help) {
    $row = New-Object Windows.Forms.TableLayoutPanel; $row.ColumnCount = 3; $row.RowCount = 1; $row.Width = $ContentW; $row.AutoSize = $true; $row.MinimumSize = New-Object Drawing.Size($ContentW, (Px 30))
    [void]$row.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Absolute', (Px 26)))); [void]$row.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Percent', 100))); [void]$row.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('AutoSize')))
    $sym = New-Label $(switch ($kind) { 'ok' { [string][char]0x2713 } 'fail' { [string][char]0x2715 } default { '!' } }) (New-Font 10 'Bold' 'Segoe UI Symbol') $(switch ($kind) { 'ok' { $C.Ok } 'fail' { $C.Bad } default { $C.Warn } })
    $sym.Anchor = 'Left'
    $nm = New-Object Windows.Forms.FlowLayoutPanel; $nm.AutoSize = $true; $nm.WrapContents = $false; $nm.Anchor = 'Left'
    $nl = New-Label $text $F.Body $C.Text ($ContentW - (Px 190)); $nl.Margin = New-Object Windows.Forms.Padding(0, (Px 3), 0, 0); $nm.Controls.Add($nl)
    $hp = $null; if ($help) { $hp = New-HelpPanel $help; $nm.Controls.Add((New-HelpButton '프로젝트 규칙 파일' $hp)) }
    $row.Controls.Add($sym, 0, 0); $row.Controls.Add($nm, 1, 0)
    if ($btn) { $btn.Anchor = 'Right'; $btn.Margin = New-Object Windows.Forms.Padding(0, (Px 2), 0, (Px 2)); $row.Controls.Add($btn, 2, 0) }
    $row.Margin = New-Object Windows.Forms.Padding(0, $(if ($script:firstRow) { Px 10 } else { 0 }), 0, 0); $script:firstRow = $false
    $sep = New-Object Windows.Forms.Panel; $sep.Height = 1; $sep.Width = $ContentW; $sep.BackColor = [Drawing.Color]::FromArgb(240, 240, 240); $sep.Margin = New-Object Windows.Forms.Padding(0)
    $flow.Controls.Add($row); $flow.Controls.Add($sep); if ($hp) { $flow.Controls.Add($hp) }
  }
  $script:firstRow = $true
  foreach ($k in $bad) {
    $b = New-Btn '다시 시도' $true; $b.Add_Click({ Go-Step 3; if (-not $St.Run) { Start-Install } })
    Add-ResultRow 'fail' "$($Groups[$k])를 끝내지 못했습니다" $b $null
  }
  foreach ($x in $left) {
    $b = New-Btn $x.Btn; $b.Tag = $x
    $b.Add_Click({ param($s) $x = $s.Tag
        if ($x.Go) { $St.ReturnTo7 = $true; Go-Step $x.Go }
        elseif ($x.Note) { $file = Join-Path $St.Project '.claude\ops\CLAUDE.part.md'; if (-not $Demo) { Start-Process notepad.exe -ArgumentList (Q $file) } }
        elseif ($x.Detail) { [void][Windows.Forms.MessageBox]::Show($form, $x.Detail, 'WY Ops 설치') } })
    Add-ResultRow 'warn' $x.Text $b $x.Help
  }
  if ($left.Count -or $bad.Count) {
    $okN = @($Groups.Keys | Where-Object { $lv[$_] -eq 'ok' }).Count
    if ($okN) { Add-ResultRow 'ok' "나머지 $($okN)개는 됐습니다" $null $null }
  } else { foreach ($k in $Groups.Keys) { Add-ResultRow 'ok' $Groups[$k] $null $null } }
  $r = New-Row 16
  $vs = New-BigBtn 'VS Code 열기'; $vs.Add_Click({ Write-Log "VS Code 열기: $($St.Project)"; if (-not $Demo) { $null = Start-Hidden ('code ' + (Q $St.Project)) } })
  $r.Controls.Add($vs)
  if ($bad.Count) { $sl = New-SaveLogBtn; $sl.Margin = New-Object Windows.Forms.Padding((Px 8), (Px 3), 0, 0); $r.Controls.Add($sl) }
  $flow.Controls.Add($r)
  $St.Done[7] = $true
  $btnPrev.Enabled = $false; $btnNext.Enabled = $true
}

# LinkLabel은 글꼴이 커지면(150% 이상) 밑줄을 엉뚱한 줄·자리에 긋거나 아예 빼먹는다(.NET Framework, 실제 창에서도 같음).
# 그때는 밑줄을 끄고 파란 글자·손 모양 커서로만 링크를 보인다
$NoLinkUnderline = $DpiScale -ge 1.4  # 글꼴의 실제 배율(-Scale 흉내도 같음)
function Set-NoUnderline($root) { foreach ($x in $root.Controls) { if ($x -is [Windows.Forms.LinkLabel]) { $x.LinkBehavior = 'NeverUnderline' }; Set-NoUnderline $x } }
if ($NoLinkUnderline) { $lnkLater.LinkBehavior = 'NeverUnderline' }

# ── 단계 이동 ──
function Show-Step {
  Clear-Body
  $lnkLater.Visible = $false
  $btnNext.Text = '다음 >'; $btnCancel.Visible = $true
  switch ($St.Step) { 1 { Show-Step1 } 2 { Show-Step2 } 3 { Show-Step3 } 4 { Show-Step4 } 5 { Show-Step5 } 6 { Show-Step6 } 7 { Show-Step7 } }
  if ($St.Step -eq 7) { $btnNext.Text = '마침'; $btnCancel.Visible = $false }
  Set-Primary $btnNext ($btnNext.Enabled -and $St.Step -ne 7)
  if ($St.ReturnTo7 -and $St.Step -in 4, 5, 6) { $btnNext.Text = '마침으로 >' }
  Update-Side
  if ($NoLinkUnderline) { Set-NoUnderline $flow }
  $flow.ResumeLayout()
  if ($script:FocusCtl) { $fc = $script:FocusCtl; $script:FocusCtl = $null; if ($form.Visible) { [void]$fc.Focus() } }
}
function Go-Step([int]$n) {
  Stop-Hidden $St.LoginRun; $St.LoginRun = $null
  if ($St.Step -ne 3 -and $St.Poll) { Stop-Hidden $St.Poll.R; $St.Poll = $null }
  $St.Waiting = $null; $St.TrustWindow = $false
  $St.Step = $n
  if ($n -eq 3) { if (-not $St.Rows) { Initialize-Rows }; if (-not $St.Installed -and -not $St.Run -and -not $St.FailMsg) { Start-Install; return } }
  if ($n -eq 4 -and -not $St.ClaudeOk) { $St.Checking = 'claude' }
  if ($n -eq 5 -and -not $St.GhOk) { $St.Checking = 'gh' }
  if ($n -eq 6 -and -not $St.TrustOk) { $St.Checking = 'trust' }
  if ($n -eq 7) { $St.Doctor = $null }
  Show-Step
}
$btnNext.Add_Click({
    switch ($St.Step) {
      1 { $St.Done[1] = $true; if (-not $St.FolderRead) { $St.FolderRead = $true; Set-ProjectFolder $St.Project }; Go-Step 2 }
      2 {
        $St.Done[2] = $true
        # 설치한 뒤 폴더·이름을 바꿨으면 설치 단계를 다시(있는 것은 건너뛰므로 금방 끝난다)
        $key = "$($St.Project)|$($St.Name)|$($St.Prefix)|$($St.Stack)|$(($St.Counts.Values) -join ',')"
        if ($St.Installed -and $St.InstalledFor -ne $key) { $St.Installed = $false; $St.Rows = $null; $St.Done[3] = $false }
        $St.InstalledFor = $key
        if ($St.Installed) { Go-Step 4 } else { Go-Step 3 }
      }
      7 { $script:Closing = $true; $form.Close() }
      default {
        $St.Done[$St.Step] = $true
        if ($St.ReturnTo7) { $St.ReturnTo7 = $false; Go-Step 7 } else { Go-Step ($St.Step + 1) }
      }
    }
  })
$btnPrev.Add_Click({
    if ($St.Step -eq 3) { $St.FailMsg = $null; foreach ($r in $St.Rows) { if ($r.State -eq 'fail') { $r.State = 'wait' } }; Go-Step 2 }
    elseif ($St.Step -eq 4) { Go-Step 2 }  # 설치는 되돌릴 것이 없다
    else { Go-Step ($St.Step - 1) }
  })
$lnkLater.Add_LinkClicked({ $St.GhSkipped = $true; $St.Done[5] = $true; if ($St.ReturnTo7) { $St.ReturnTo7 = $false; Go-Step 7 } else { Go-Step 6 } })

# 취소 확인(버튼 글자를 바꿔야 해서 작은 창)
function New-CancelDialog {
  $d = New-Object Windows.Forms.Form; $d.Text = 'WY Ops 설치'; $d.FormBorderStyle = 'FixedDialog'; $d.MaximizeBox = $false; $d.MinimizeBox = $false; $d.ShowInTaskbar = $false
  $d.StartPosition = 'CenterParent'; $d.ClientSize = New-Object Drawing.Size((Px 420), (Px 150)); $d.Font = $F.Body; $d.BackColor = [Drawing.Color]::White; $d.AutoScaleMode = 'None'
  $qi = New-Object Windows.Forms.Label; $qi.Text = '?'; $qi.Font = New-Font 12 'Bold' 'Segoe UI'; $qi.ForeColor = [Drawing.Color]::White; $qi.BackColor = $C.Accent; $qi.TextAlign = 'MiddleCenter'
  $qi.SetBounds((Px 20), (Px 20), (Px 32), (Px 32))
  $t1 = New-Label '설치를 멈출까요?' $F.Body $C.Text (Px 330); $t1.Location = New-Object Drawing.Point((Px 66), (Px 20))
  $t2 = New-Label '이미 설치한 프로그램은 그대로 남습니다. setup을 다시 실행하면 이어서 합니다.' $F.Small $C.Muted (Px 330); $t2.Location = New-Object Drawing.Point((Px 66), (Px 46))
  $ft = New-Object Windows.Forms.Panel; $ft.Dock = 'Bottom'; $ft.Height = Px 50; $ft.BackColor = $C.Foot
  $go = New-Btn '계속 설치' $true; $go.DialogResult = 'Cancel'; $stop = New-Btn '멈추기'; $stop.DialogResult = 'OK'
  $x1 = (Px 420) - (Px 100); $x2 = (Px 420) - (Px 194); $y = Px 11
  $go.Location = New-Object Drawing.Point($x1, $y); $stop.Location = New-Object Drawing.Point($x2, $y)  # 인자 안에서 빼기를 하면 배열로 넘어가 실패
  $ft.Controls.AddRange(@($go, $stop)); $d.Controls.AddRange(@($qi, $t1, $t2, $ft)); $d.AcceptButton = $go; $d.CancelButton = $go
  $d.Add_Shown({ $go.Focus() }.GetNewClosure())
  return $d
}
function Confirm-Cancel {
  $d = New-CancelDialog
  $r = $d.ShowDialog($form); $d.Dispose()
  return $r -eq 'OK'
}
function Close-Wizard { $script:Closing = $true; Stop-Hidden $St.LoginRun; if ($St.Poll) { Stop-Hidden $St.Poll.R }; $tick.Stop(); $form.Close() }
$btnCancel.Add_Click({ $form.Close() })
$form.Add_FormClosing({ param($s, $e)
    if ($script:Closing -or $Shots) { return }
    if ($St.Step -eq 7) { Close-Wizard; return }
    $e.Cancel = $true
    if (Confirm-Cancel) {
      if ($St.Run) { $St.CancelPending = $true; $btnCancel.Enabled = $false; $script:ui.Count.Text = '지금 설치하던 프로그램이 끝나면 닫습니다.' }  # 설치 중이면 지금 것만 끝내고 닫는다
      else { Close-Wizard }
    }
  })

# ── 타이머: 설치 출력·로그인 확인·로그인 출력 ──
$tick = New-Object Windows.Forms.Timer; $tick.Interval = 200
$tick.Add_Tick({
    try {
      if ($St.Run) { Read-Install }
      if ($script:CopyBtn -and (Get-Date) -gt $script:CopyReset) { try { $script:CopyBtn.Text = '코드 복사' } catch { }; $script:CopyBtn = $null }
      # 로그인 명령 출력(gh 확인 코드)
      if ($St.LoginRun) {
        foreach ($line in (Read-Hidden $St.LoginRun)) {
          if ($St.Step -eq 4 -and $line -match 'visit:\s*(https://\S+)') { $St.ClaudeUrl = $Matches[1] }
          if ($St.Step -eq 4 -and $St.PasteBusy -and $line -match 'Login failed') { $St.PasteBusy = $false; $St.PasteBad = $true; Show-Step }
          if ($St.Step -eq 5 -and $line -match 'one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})') { $St.GhCode = $Matches[1]; Show-Step; if (-not $St.GhOpened) { $St.GhOpened = $true; Open-Url 'https://github.com/login/device' } }
        }
        if ($St.LoginRun -and $null -ne $St.LoginRun.Exit -and $St.Step -eq 4 -and $St.PasteBusy) {
          # 코드를 넘긴 뒤 끝남: 0이면 바로 로그인 확인, 아니면 틀린 코드
          if ($St.LoginRun.Exit -eq 0) { $St.Checking = 'claude'; $St.LoginRun = $null; $St.PasteBusy = $false } else { $St.PasteBusy = $false; $St.PasteBad = $true; Show-Step }
        }
        if ($St.LoginRun -and $null -ne $St.LoginRun.Exit -and $St.Step -eq 5 -and -not $St.GhCode -and -not $St.GhOk) { $St.LoginRun = $null; $St.Waiting = $null; $St.GhFail = $true; Show-Step }
        elseif ($null -ne $St.LoginRun.Exit -and $St.Step -eq 5 -and $St.GhCode -and -not $St.GhOk -and $St.LoginRun.Exit -ne 0) { $St.LoginRun = $null; $St.GhExpired = $true; Show-Step }  # 코드 만료
      }
      Read-Poll
      # 2초마다: 들어온 순간 한 번(이미 됐는지), 기다리는 중이면 계속
      if (-not $St.Poll -and ((Get-Date) - $St.PollAt) -gt $PollEvery) {
        $what = $null
        if ($St.Checking) { $what = $St.Checking }
        elseif ($St.Step -eq 4 -and $St.Waiting -eq 'claude' -and -not $St.ClaudeOk) { $what = 'claude' }
        elseif ($St.Step -eq 5 -and $St.Waiting -eq 'gh' -and $St.GhCode -and -not $St.GhOk) { $what = 'gh' }
        elseif ($St.Step -eq 6 -and $St.Waiting -eq 'trust' -and -not $St.TrustOk) { $what = 'trust' }
        if ($what) {
          $first = [bool]$St.Checking; $St.Checking = $null
          $cb = switch ($what) {
            'claude' { { param($code, $out) if ($St.Step -ne 4) { return }; if (Test-ClaudeOut $out) { $St.ClaudeOk = $true; $St.ClaudeWasOk = ($St.Waiting -ne 'claude'); $St.Done[4] = $true; Stop-Hidden $St.LoginRun; $St.LoginRun = $null; $St.Waiting = $null; Show-Step; $btnNext.Focus() } elseif ($St.Waiting -eq 'claude' -and ((Get-Date) - $St.WaitSince).TotalMinutes -ge 5 -and -not $St.LateShown) { $St.LateShown = $true; if (-not $St.PasteOpen) { Show-Step } } elseif ($St.Waiting -eq 'claude' -and ((Get-Date) - $St.WaitSince) -ge $CodeLinkAfter -and -not $St.CodeLinkShown) { $St.CodeLinkShown = $true; if (-not $St.PasteOpen) { Show-Step } } } }
            'gh' { { param($code, $out) if ($St.Step -ne 5) { return }; if ($code -eq 0) { $St.GhOk = $true; $St.GhWasOk = ($St.Waiting -ne 'gh'); $St.GhSkipped = $false; $St.Done[5] = $true; Stop-Hidden $St.LoginRun; $St.LoginRun = $null; $St.Waiting = $null; if (-not $Demo -and -not $St.GhWasOk) { $null = Start-Hidden 'gh auth setup-git' }; Show-Step; $btnNext.Focus() } } }
            'trust' { { param($code, $out) if ($St.Step -ne 6) { return }; if ($code -eq 0) { $St.TrustOk = $true; $St.TrustWasOk = ($St.Waiting -ne 'trust'); $St.Done[6] = $true; $St.Waiting = $null; Show-Step; $btnNext.Focus() } } }
          }
          Start-Poll (Get-StatusCmd $what) $cb
        }
      }
    } catch { Write-Log "타이머 오류: $($_.Exception.Message) $($_.InvocationInfo.PositionMessage)" }
  })

# ── 화면 캡처(-Shots): 목업의 화면 상태를 차례로 그려 저장 ──
function Save-Shot([string]$name) {
  $form.Refresh(); [Windows.Forms.Application]::DoEvents()
  $bmp = New-Object Drawing.Bitmap($form.Width, $form.Height)
  $form.DrawToBitmap($bmp, (New-Object Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
  $file = Join-Path $Shots ("$name-" + [int]($DpiScale * 100) + '.png'); $bmp.Save($file, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output "캡처: $file"
}
function Open-Help([int]$idx = 0) { $qs = @(); $stack = New-Object Collections.Stack; $stack.Push($flow); while ($stack.Count) { $ctl = $stack.Pop(); foreach ($x in $ctl.Controls) { if ($x -is [Windows.Forms.Button] -and $x.Text -eq '?') { $qs += $x }; $stack.Push($x) } }; $qs = @($qs | Sort-Object { $_.PointToScreen([Drawing.Point]::Empty).Y }); if ($qs.Count -gt $idx) { $qs[$idx].PerformClick() } }
function Invoke-Shots {
  New-Item -ItemType Directory -Force -Path $Shots | Out-Null
  $form.Show(); [Windows.Forms.Application]::DoEvents()
  $St.Step = 1; Show-Step; Save-Shot 'W1'
  $d = New-CancelDialog; $d.StartPosition = 'Manual'; $d.Location = $form.Location; $d.Show($form); $d.Refresh(); [Windows.Forms.Application]::DoEvents()
  $bmp = New-Object Drawing.Bitmap($d.Width, $d.Height); $d.DrawToBitmap($bmp, (New-Object Drawing.Rectangle(0, 0, $d.Width, $d.Height)))
  $cf = Join-Path $Shots ('C-cancel-' + [int]($DpiScale * 100) + '.png'); $bmp.Save($cf, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); $d.Close(); $d.Dispose(); Write-Output "캡처: $cf"  # 글꼴 표(F)와 이름이 겹치지 않게
  $St.Done[1] = $true; $St.Step = 2; Show-Step; Save-Shot 'W2-a'
  $St.AdvOpen = $true; $St.Project = 'C:\projects\내 앱'; $St.Name = ''; $St.NameTouched = $true; Show-Step; Open-Help 0; Save-Shot 'W2-b'
  $St.Project = 'C:\projects\my-app'; $St.Name = 'my-app'; $St.AdvOpen = $false; $St.Done[2] = $true
  Initialize-Rows; $St.Step = 3
  (Find-Row 'node').State = 'installed'; (Find-Row 'gh').State = 'run'; Show-Step; Save-Shot 'W3-a'
  foreach ($r in $St.Rows) { $r.State = 'installed' }; (Find-Row 'folder').State = 'done'; $St.Installed = $true; Show-Step; Open-Help 1; Save-Shot 'W3-b'
  $St.Installed = $false; foreach ($r in $St.Rows) { $r.State = 'wait' }; (Find-Row 'node').State = 'installed'; (Find-Row 'gh').State = 'installed'; (Find-Row 'code').State = 'fail'
  $St.FailMsg = Get-FailMsg (Find-Row 'code') '1' 'download failed 0x80072ee7'; Show-Step; Save-Shot 'W3-c'
  $St.FailMsg = Get-FailMsg (Find-Row 'folder') '' 'git init 실패: fatal'; (Find-Row 'code').State = 'installed'; (Find-Row 'claude').State = 'installed'; (Find-Row 'ops').State = 'installed'; (Find-Row 'folder').State = 'fail'; Show-Step; Save-Shot 'W3-d-gitinit'
  $St.FailMsg = $null; foreach ($r in $St.Rows) { $r.State = 'installed' }; $St.Installed = $true; $St.Done[3] = $true
  $St.Step = 4; Show-Step; Save-Shot 'W4-a'
  $St.Waiting = 'claude'; $St.WaitSince = Get-Date; Show-Step; Open-Help 0; Save-Shot 'W4-b'
  $St.WaitSince = (Get-Date).AddMinutes(-2); Show-Step; Save-Shot 'W4-d'
  $St.PasteOpen = $true; Show-Step; Save-Shot 'W4-e'
  $St.PasteText = 'a1B2c3' + [char]0x2026 + 'x9Z'; $St.PasteBusy = $true; Show-Step; Save-Shot 'W4-e-busy'  # [확인] 뒤 '확인 중…'
  $St.PasteBusy = $false; $St.PasteBad = $true; Show-Step; Save-Shot 'W4-f'
  $St.PasteOpen = $false; $St.PasteBad = $false; $St.PasteText = ''
  $St.ClaudeOk = $true; $St.Waiting = $null; Show-Step; Save-Shot 'W4-c'
  $St.Done[4] = $true; $St.Step = 5; Show-Step; Open-Help 0; Save-Shot 'W5-a'
  $St.Waiting = 'gh'; $St.GhCode = '4F2A-9C1B'; Show-Step; Save-Shot 'W5-b'
  $St.GhOk = $true; $St.Waiting = $null; Show-Step; Save-Shot 'W5-c'
  $St.GhOk = $false; $St.GhSkipped = $true; $St.Done[5] = $true; $St.GhCode = $null
  $St.Step = 6; Show-Step; Save-Shot 'W6-a'
  $St.TrustOk = $true; Show-Step; Open-Help 0; Save-Shot 'W6-b'
  $St.TrustOk = $false; $St.TrustFail = $true; $St.TrustWindow = $true; Show-Step; Save-Shot 'W6-c'
  $St.TrustFail = $false; $St.TrustWindow = $false; $St.TrustOk = $true; $St.Done[6] = $true
  $St.Step = 7; $St.GhSkipped = $false; $St.GhOk = $true; $St.Doctor = @(@{ id = 'tools'; level = 'ok' }); Show-Step7Shot; Save-Shot 'W7-a'
  $St.GhSkipped = $true; $St.GhOk = $false; $St.ClaudeMd = 'append'; Show-Step7Shot; Open-Help 0; Save-Shot 'W7-b'
  $St.Installed = $false; $St.ClaudeMd = $null; Show-Step7Shot; Save-Shot 'W7-c-fail'
  $script:Closing = $true; $form.Close()
}
function Show-Step7Shot { Clear-Body; $btnNext.Text = '마침'; $btnCancel.Visible = $false; $btnNext.Enabled = $true; Set-Primary $btnNext $false; $lnkLater.Visible = $false; Show-Step7; Update-Side; $flow.ResumeLayout() }

if ($Shots) { Invoke-Shots; return }
Show-Step
$tick.Start()
[void]$form.ShowDialog()
$tick.Stop()
Stop-Hidden $St.LoginRun
Write-Log '마법사 끝'
