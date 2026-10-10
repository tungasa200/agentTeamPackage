// 원격 호스트 준비(install.ps1 host, 원격 호스트 계획 4.1 H3~H6·P3)와 점검(doctor '호스트' 줄, P5).
//   이 PC를 다른 PC에서 Tailscale + OpenSSH + VS Code Remote-SSH로 쓰는 작업 호스트로 만든다.
//   자동으로 하는 것: OpenSSH 서버(Win32-OpenSSH, winget. 낮은 버전·실행 안 되는 선택적 기능판은 제거 후 교체) 설치·자동 시작·기본 셸 PowerShell, sshd_config 공개키 로그인만,
//     administrators_authorized_keys 권한 정리, 방화벽 OpenSSH 규칙을 Tailscale 대역만, 전원(AC 대기·최대 절전 끔, 화면 끄기는 그대로)
//     claude daemon 로그온 작업(D-167: 바탕화면 로그온에서 daemon을 띄워 세션이 자격 증명 관리자를 읽게. 등록만 하고 시작·정지는 하지 않는다)
//   손으로 하는 것(할 일 카드·안내): Tailscale 설치·Run unattended·키 만료 끔, 자동 로그인(Sysinternals Autologon), 업데이트 사용 시간
//   공개 저장소에 들어가므로 호스트 이름·IP·계정·키를 코드에 두지 않는다(키는 --add-key 인수로만 받는다).
// 시스템을 바꾸는 명령은 모두 run(cmd, args) → { status, stdout, stderr }로 부른다(시험에서 가짜로 바꿔 끼운다).
const fs = require('fs');
const path = require('path');

const TAILNET = '100.64.0.0/10';
const FW_RULE = 'OpenSSH-Server-In-TCP'; // 선택적 기능판이 만드는 규칙 이름. MSI판은 이 규칙이 없을 수 있어 없으면 이 이름으로 만든다
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SSHD_EXE = 'C:\\Windows\\System32\\OpenSSH\\sshd.exe'; // 선택적 기능판 sshd. Program Files\OpenSSH가 없을 때만 -t 검사에 쓴다(findSshd)
// 이름 대신 SID: 한국어 Windows에서는 그룹 이름이 달라 icacls가 못 찾는다
const SID_ADMINS = 'S-1-5-32-544';
const SID_SYSTEM = 'S-1-5-18';
const SSHD_SETTINGS = [
  ['PubkeyAuthentication', 'yes'],
  ['PasswordAuthentication', 'no'],
  ['KbdInteractiveAuthentication', 'no'],
  ['PermitEmptyPasswords', 'no'],
];
// claude daemon 로그온 작업(D-167). session.ps1의 $DaemonTask와 같은 이름이어야 한다(session.ps1은 이 작업을 Start-ScheduledTask로만 부른다)
const DAEMON_TASK = 'wy-ops-claude-daemon';
// 자격 증명 관리자를 읽는 로그온 유형: 2 대화형(바탕화면), 10 원격 대화형, 11 캐시 대화형. ssh 키 로그인은 3(네트워크)
const GOOD_LOGON = [2, 10, 11];
// 작업 동작: 숨긴 powershell이 claude daemon run(포그라운드 supervisor)을 띄우고 끝날 때까지 기다린다(작업이 Running으로 남음)
const daemonArgs = (exe) => `-NoProfile -NonInteractive -WindowStyle Hidden -Command "& '${String(exe).replace(/'/g, "''")}' daemon run"`;
const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+([A-Za-z0-9+/]+={0,3})(?:\s+(.*))?$/;

const sshDir = (programData) => path.join(programData || process.env.ProgramData || 'C:\\ProgramData', 'ssh');
const paths = (programData) => ({
  config: path.join(sshDir(programData), 'sshd_config'),
  keys: path.join(sshDir(programData), 'administrators_authorized_keys'),
});

// PowerShell 스크립트를 -EncodedCommand(UTF-16LE base64)로 넘긴다: 여러 줄·따옴표가 명령줄에서 깨지지 않게
//   출력을 받아 가면 자식 powershell은 오류·진행 스트림을 CLIXML로 내보낸다(-OutputFormat Text로도 안 바뀜).
//   그래서 오류는 스크립트 안에서 잡아 메시지만(안쪽 예외 포함) stderr에 쓰고, 진행 표시는 끈다
function ps(run, script) {
  const full = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'\n[Console]::OutputEncoding=[Text.Encoding]::UTF8;try{\n" + script +
    "\n}catch{$m=$_.Exception.Message;$i=$_.Exception.InnerException;if($i -and $i.Message -ne $m){$m+=' — '+$i.Message};[Console]::Error.WriteLine($m);exit 1}";
  return run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')]);
}

// 실패 결과를 사람이 읽을 한 덩이 글로. CLIXML이 섞여 오면 Error 줄만 풀고, 위치·CategoryInfo 줄은 뺀다
function errText(r) {
  let t = String((r && (r.stderr || r.stdout)) || '');
  if (/^#< CLIXML/.test(t.trim())) {
    t = [...t.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
      .map((m) => m[1].replace(/_x([0-9A-F]{4})_/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'))
      .join('')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^\s*\+ /.test(l) && !/^(At line:|위치 줄:)/.test(l.trim()))
      .join('\n');
  }
  return t.trim() || `종료 코드 ${r ? r.status : '?'}`;
}

// 읽기만 하는 점검(관리자가 아니어도 된다). 항목마다 따로 잡는다: 관리자만 읽히는 것(방화벽 규칙, 좁힌 키 파일 권한)이
//   권한 거부되면 그 항목만 비우고 denied에 이름을 적는다. 그 밖의 오류(없음 등)는 빈 값(없음)으로 본다
const PROBE = `$ErrorActionPreference='SilentlyContinue'
$o=[ordered]@{denied=@()}
function T([string]$k,[scriptblock]$b){$ErrorActionPreference='Stop';try{$o[$k]=& $b}catch{if($_.CategoryInfo.Category -eq 'PermissionDenied' -or $_.Exception -is [UnauthorizedAccessException] -or $_.Exception -is [Security.SecurityException]){$o.denied+=@($k)};$o[$k]=$null}}
$o.admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
T sshd {$s=Get-Service sshd; @{status="$($s.Status)";start="$($s.StartType)"}}
T sshdPath {$w=Get-CimInstance Win32_Service -Filter "Name='sshd'"; if($w){"$($w.PathName)".Trim().Trim('"')}}
T builtin {Test-Path (Join-Path $env:SystemRoot 'System32\\OpenSSH\\sshd.exe')}
T sshdExe {@($o.sshdPath,(Join-Path $env:ProgramFiles 'OpenSSH\\sshd.exe'),(Join-Path $env:SystemRoot 'System32\\OpenSSH\\sshd.exe'))|?{$_ -and (Test-Path $_)}|Select-Object -First 1}
T sshdVersion {$ErrorActionPreference='Continue'; if($o.sshdExe){((& $o.sshdExe -V 2>&1)|%{"$_"}) -join ' '}}
T fwOthers {@(Get-NetFirewallRule -DisplayName '*OpenSSH*','*sshd*' -ErrorAction Stop|?{$_.Name -ne '${FW_RULE}' -and "$($_.Direction)" -eq 'Inbound' -and "$($_.Action)" -eq 'Allow'}|%{@{name="$($_.Name)";enabled="$($_.Enabled)";remote=@(($_|Get-NetFirewallAddressFilter -ErrorAction Stop).RemoteAddress|%{"$_"})}})}
T tailscale {$t=Get-Service Tailscale; @{status="$($t.Status)";start="$($t.StartType)"}}
T tailscaleState {$t=Get-Service Tailscale; $ts=(Get-Command tailscale -ErrorAction SilentlyContinue).Source; if(-not $ts){$p=Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe'; if(Test-Path $p){$ts=$p}}; if($ts -and "$($t.Status)" -eq 'Running'){((& $ts status --json) -join ' ' | ConvertFrom-Json).BackendState}}
T autoLogon {$k=Get-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'; @{enabled=("$($k.GetValue('AutoAdminLogon'))" -eq '1');plainPassword=(@($k.GetValueNames()) -contains 'DefaultPassword')}}
T defaultShell {(Get-ItemProperty 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell).DefaultShell}
T firewall {$r=Get-NetFirewallRule -Name '${FW_RULE}' -ErrorAction Stop; @{enabled="$($r.Enabled)";remote=@(($r|Get-NetFirewallAddressFilter -ErrorAction Stop).RemoteAddress|%{"$_"})}}
T standby {(powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE) -join "\`n"}
T hibernate {(powercfg /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE) -join "\`n"}
T claudeExe {$s=(Get-Command claude -ErrorAction Stop|Select-Object -First 1).Source; if($s -match '\\.(cmd|ps1)$'){$e=Join-Path (Split-Path $s) 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'; if(Test-Path $e){$s=$e}}; $s}
T daemonTask {$t=Get-ScheduledTask -TaskName '${DAEMON_TASK}' -ErrorAction Stop; $a=@($t.Actions)[0]; @{state="$($t.State)";logonType="$($t.Principal.LogonType)";runLevel="$($t.Principal.RunLevel)";execute="$($a.Execute)";arguments="$($a.Arguments)";logonTrigger=(@($t.Triggers|?{$_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'}).Count -gt 0)}}
T daemon {$id=([IO.File]::ReadAllText((Join-Path $env:USERPROFILE '.claude\\daemon.lock'))|ConvertFrom-Json).pid; $p=Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$id)"|?{$_.Name -eq 'claude.exe'}; if($p){@{pid=[int]$id;session=[int]$p.SessionId;logonType=(Get-CimAssociatedInstance -InputObject $p -ResultClassName Win32_LogonSession -ErrorAction SilentlyContinue|Select-Object -First 1).LogonType}}}
T keysAcl {$a=Get-Acl (Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'); @{protected=$a.AreAccessRulesProtected;sids=@($a.Access|%{$ir=$_.IdentityReference;try{$ir.Translate([Security.Principal.SecurityIdentifier]).Value}catch{"$ir"}})}}
$o|ConvertTo-Json -Depth 4 -Compress`;

// powercfg /query 출력에서 AC 값(초). 한국어 출력도 'AC'와 0x 값은 그대로다
function acSeconds(text) {
  const m = /\bAC\b[^\n:]*:\s*0x([0-9a-f]+)/i.exec(String(text || ''));
  return m ? parseInt(m[1], 16) : null;
}

function probe(run) {
  const r = ps(run, PROBE);
  let j;
  try {
    j = JSON.parse(String(r.stdout || '').trim().replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || !('admin' in j)) return null;
  const remote = j.firewall ? [].concat(j.firewall.remote || []).map(String) : null;
  return {
    admin: j.admin === true,
    denied: [].concat(j.denied || []).map(String), // 권한이 없어 읽지 못한 항목(관리자가 아니면 firewall·fwOthers·keysAcl)
    sshd: j.sshd || null,
    sshdPath: j.sshdPath || null, // sshd 서비스가 가리키는 실행 파일
    sshdExe: j.sshdExe || null, // 쓸 sshd.exe(서비스 → Program Files\OpenSSH → System32\OpenSSH 순)
    sshdVersion: j.sshdVersion || null, // sshd -V 출력(실행이 안 되면 빈 값)
    builtin: j.builtin === true, // Windows 선택적 기능판(System32\OpenSSH\sshd.exe)이 있음
    fwOthers: [].concat(j.fwOthers || []).filter(Boolean).map((r) => ({ name: String(r.name), enabled: String(r.enabled) === 'True', remote: [].concat(r.remote || []).map(String) })),
    tailscale: j.tailscale || null,
    tailscaleState: j.tailscaleState || null, // tailscale status의 BackendState(로그인돼 연결 중이면 Running)
    // 자동 로그인: AutoAdminLogon=1인지, 평문 DefaultPassword 값이 있는지(값은 읽지 않고 이름만 본다)
    autoLogon: j.autoLogon ? { enabled: j.autoLogon.enabled === true, plainPassword: j.autoLogon.plainPassword === true } : null,
    defaultShell: j.defaultShell || null,
    firewall: j.firewall ? { enabled: String(j.firewall.enabled) === 'True', remote } : null,
    standbyAc: acSeconds(j.standby),
    hibernateAc: acSeconds(j.hibernate),
    claudeExe: j.claudeExe || null, // daemon 작업이 띄울 claude.exe(npm 설치면 .cmd 옆 실제 실행 파일)
    daemonTask: j.daemonTask || null, // 로그온 작업(DAEMON_TASK) 설정
    // 지금 daemon(daemon.lock의 pid가 살아 있는 claude.exe일 때만): Windows 세션 번호, 로그온 유형(GOOD_LOGON이면 자격 증명 관리자를 읽음)
    daemon: j.daemon ? { pid: Number(j.daemon.pid), session: Number(j.daemon.session), logonType: j.daemon.logonType == null ? null : Number(j.daemon.logonType) } : null,
    keysAcl: j.keysAcl ? { protected: j.keysAcl.protected === true, sids: [].concat(j.keysAcl.sids || []).map(String) } : null,
  };
}

// Windows는 규칙 범위를 '100.64.0.0/255.192.0.0'(점 표기 마스크)로 돌려준다 → '/10'으로 맞춰 비교
const cidr = (s) => String(s).replace(/\/(\d+\.\d+\.\d+\.\d+)$/, (_, m) => `/${m.split('.').reduce((n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, '').length, 0)}`);
const onlyTailnet = (remote) => !!(remote && remote.length === 1 && cidr(remote[0]) === TAILNET);
// 다른 OpenSSH 규칙(MSI판·옛 선택적 기능이 만든 것)이 켜져 있으면 모든 주소에서 22번이 열릴 수 있다 → 꺼져 있거나 Tailscale 대역만이어야 한다
const othersOk = (others) => (others || []).every((r) => !r.enabled || onlyTailnet(r.remote));
const fwOk = (fw, others) => !!(fw && fw.enabled && onlyTailnet(fw.remote)) && othersOk(others);

// OpenSSH 버전: 'OpenSSH_for_Windows_9.5p1' → 9.05. 선택적 기능 7.7은 실행조차 안 되는 경우가 있어 8.1 미만은 교체한다
const MIN_VERSION = 8.01;
function sshVersion(text) {
  const m = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/i.exec(String(text || ''));
  return m ? Number(m[1]) + Number(m[2]) / 100 : null;
}
const isProgramFiles = (p) => /\\Program Files\\OpenSSH\\/i.test(String(p || ''));
const isBuiltin = (p) => /\\System32\\OpenSSH\\/i.test(String(p || ''));
// sshd_config 문법 검사에 쓸 sshd.exe: Program Files\OpenSSH(MSI·winget판) 우선, 없으면 System32(선택적 기능판)
function findSshd({ programFiles = process.env.ProgramFiles || 'C:\\Program Files', exists = fs.existsSync } = {}) {
  const pf = path.join(programFiles, 'OpenSSH', 'sshd.exe');
  return exists(pf) ? pf : SSHD_EXE;
}
// 선택적 기능판을 쓰는데 버전이 낮거나 실행이 안 되면 교체 대상
const builtinBad = (st) => !!(st.builtin && !isProgramFiles(st.sshdPath) && (!st.sshdExe || isBuiltin(st.sshdExe)) && !((sshVersion(st.sshdVersion) || 0) >= MIN_VERSION));
const WINGET_ID = 'Microsoft.OpenSSH.Preview';
const MSI_HINT = 'winget이 없습니다. https://github.com/PowerShell/Win32-OpenSSH/releases 에서 OpenSSH-Win64-v….msi를 받아 관리자 PowerShell에서 msiexec /i <받은 msi> ADDLOCAL=Server 를 실행한 뒤 host를 다시 실행하세요';
const aclOk = (acl) => !!(acl && acl.protected && acl.sids.length && acl.sids.every((s) => s === SID_ADMINS || s === SID_SYSTEM));
// 로그온 작업이 지금 claude.exe로, 로그온 트리거·대화형·일반 권한으로 맞게 있는지
const taskOk = (t, exe) => !!(t && exe && t.logonTrigger && t.logonType === 'Interactive' && t.runLevel === 'Limited'
  && String(t.execute).toLowerCase() === PS_EXE.toLowerCase() && t.arguments === daemonArgs(exe));
// daemon이 바탕화면 쪽 로그온인지. 유형을 못 읽으면 세션 번호로(0이면 아님)
const daemonOk = (d) => (d.logonType != null ? GOOD_LOGON.includes(d.logonType) : d.session !== 0);
const shellOk = (v) => !!v && /\\powershell\.exe$/i.test(v);

// sshd_config 전역 절(첫 Match 앞)에서 값을 맞춘다. 주석 처리된 줄이 있으면 그 자리를 켜고, 없으면 Match 앞에 넣는다
function editSshdConfig(text) {
  const crlf = /\r\n/.test(text);
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const changes = [];
  const globalEnd = () => {
    const i = lines.findIndex((l) => /^\s*Match\s/i.test(l));
    return i < 0 ? lines.length : i;
  };
  for (const [key, value] of SSHD_SETTINGS) {
    const end = globalEnd();
    const want = `${key} ${value}`;
    const active = lines.slice(0, end).findIndex((l) => new RegExp(`^\\s*${key}\\s`, 'i').test(l));
    if (active >= 0) {
      if (lines[active].trim().split(/\s+/)[1] !== value) {
        changes.push(`${lines[active].trim()} → ${want}`);
        lines[active] = want;
      }
      continue;
    }
    const commented = lines.slice(0, end).findIndex((l) => new RegExp(`^\\s*#\\s*${key}\\s`, 'i').test(l));
    if (commented >= 0) lines[commented] = want;
    else {
      let at = end;
      while (at > 0 && lines[at - 1].trim() === '') at -= 1;
      lines.splice(at, 0, want);
    }
    changes.push(`${want} 추가`);
  }
  // 관리자 계정의 공개키 파일 지정(설치 기본값에 있다. 지운 경우만 되살린다)
  if (!lines.some((l) => /^\s*AuthorizedKeysFile\s+__PROGRAMDATA__\/ssh\/administrators_authorized_keys/i.test(l))) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', 'Match Group administrators', '       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys', '');
    changes.push('Match Group administrators → administrators_authorized_keys 추가');
  }
  const out = lines.join('\n');
  return { text: crlf ? out.replace(/\n/g, '\r\n') : out, changes };
}

const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

// 바꿀 목록. 각 항목: { key, title, detail, apply(ctx) }. 상태(st)는 probe 결과
function plan(st, { programData, programFiles } = {}) {
  const p = paths(programData);
  const steps = [];
  // OpenSSH 서버는 Win32-OpenSSH(winget/MSI, Program Files\OpenSSH)로 쓴다. 서비스가 이미 그쪽이면 설치·제거를 건너뛴다
  const pfService = !!st.sshd && isProgramFiles(st.sshdPath);
  const bad = builtinBad(st);
  if (!pfService && bad) {
    const ver = st.sshdVersion ? `버전 ${(/OpenSSH_\S+/i.exec(st.sshdVersion) || [st.sshdVersion])[0]}` : 'sshd -V 실행 실패';
    steps.push({ key: 'remove-builtin', title: 'Windows 선택적 기능 OpenSSH 서버 제거', detail: `${ver} — 8.1 미만이거나 실행이 안 되어 Win32-OpenSSH로 바꿈`,
      apply: (c) => {
        const r = c.ps("$n=@(Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | ?{\"$($_.State)\" -eq 'Installed'})|%{$_.Name}\nforeach($x in $n){$r=Remove-WindowsCapability -Online -Name $x; if($r.RestartNeeded){'RESTART'}}");
        if (r.status === 0 && /RESTART/.test(r.stdout || '')) r.note = '재부팅이 필요하다고 나왔습니다. 설치가 실패하면 재부팅 뒤 다시 실행하세요';
        return r;
      } });
  }
  if (!pfService && (!st.sshd || bad)) {
    steps.push({ key: 'install', title: 'OpenSSH 서버 설치(Win32-OpenSSH)', detail: `winget ${WINGET_ID}(MSI, C:\\Program Files\\OpenSSH. 몇 분 걸릴 수 있음)`,
      apply: (c) => {
        const v = c.run('winget', ['--version']);
        if (v.status !== 0) throw new Error(MSI_HINT);
        return c.run('winget', ['install', '--id', WINGET_ID, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements']);
      } });
  }
  if (!st.sshd || bad || st.sshd.start !== 'Automatic' || st.sshd.status !== 'Running') {
    steps.push({ key: 'service', title: 'sshd 자동 시작·실행', detail: st.sshd ? `지금 ${st.sshd.start}·${st.sshd.status}` : '설치 뒤',
      apply: (c) => c.ps('Set-Service sshd -StartupType Automatic\nStart-Service sshd') });
  }
  if (!shellOk(st.defaultShell)) {
    steps.push({ key: 'shell', title: 'SSH 기본 셸을 PowerShell로', detail: `HKLM\\SOFTWARE\\OpenSSH DefaultShell = ${PS_EXE}`,
      apply: (c) => c.ps(`if(-not(Test-Path 'HKLM:\\SOFTWARE\\OpenSSH')){New-Item 'HKLM:\\SOFTWARE\\OpenSSH' | Out-Null}\nNew-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell -Value '${PS_EXE}' -PropertyType String -Force | Out-Null`) });
  }
  // sshd_config는 sshd를 처음 시작할 때 생긴다. 지금 없으면 실행할 때 다시 읽어 고친다
  const cur = readText(p.config);
  const preview = cur == null ? null : editSshdConfig(cur);
  if (cur == null || preview.changes.length) {
    steps.push({ key: 'config', title: 'sshd_config: 공개키 로그인만', detail: preview ? preview.changes.join(', ') : '비밀번호·키보드 대화 로그인 끔, 공개키 켬(파일은 sshd 첫 시작 때 생김)',
      apply: (c) => {
        const text = readText(p.config);
        if (text == null) throw new Error(`${p.config}이 없습니다(sshd가 한 번도 시작되지 않음)`);
        const e = editSshdConfig(text);
        if (!e.changes.length) return { status: 0 };
        const bak = `${p.config}.bak-${c.stamp}`;
        fs.copyFileSync(p.config, bak);
        fs.writeFileSync(p.config, e.text, 'utf8');
        const t = c.run(findSshd({ programFiles }), ['-t']);
        if (t.status !== 0) {
          fs.copyFileSync(bak, p.config);
          throw new Error(`sshd -t 검사 실패로 되돌렸습니다: ${errText(t)}`);
        }
        c.restart = true;
        return { status: 0, note: `백업 ${bak}` };
      } });
  }
  if (!fs.existsSync(p.keys) || !aclOk(st.keysAcl)) {
    steps.push({ key: 'keys', title: 'administrators_authorized_keys 권한 정리', detail: `${p.keys}(없으면 빈 파일) — Administrators·SYSTEM만`,
      apply: (c) => {
        if (!fs.existsSync(p.keys)) {
          fs.mkdirSync(path.dirname(p.keys), { recursive: true });
          fs.writeFileSync(p.keys, '');
        }
        return fixKeysAcl(c.run, p.keys);
      } });
  }
  if (!fwOk(st.firewall, st.fwOthers)) {
    const others = (st.fwOthers || []).filter((r) => r.enabled && !onlyTailnet(r.remote));
    const now = (st.denied || []).includes('firewall') ? '지금 상태 확인 못 함(관리자 권한 필요) — 관리자 실행 때 다시 봄' : (st.firewall ? `지금 ${st.firewall.enabled ? '켜짐' : '꺼짐'}·${(st.firewall.remote || []).join(',') || '?'}` : '규칙 없음 → 새로 만듦')
      + (others.length ? `; 다른 OpenSSH 규칙도 ${TAILNET}만으로: ${others.map((r) => r.name).join(', ')}` : '');
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    steps.push({ key: 'firewall', title: `방화벽 ${FW_RULE}: ${TAILNET}만`, detail: now,
      apply: (c) => c.ps(`if(Get-NetFirewallRule -Name '${FW_RULE}' -ErrorAction SilentlyContinue){Set-NetFirewallRule -Name '${FW_RULE}' -RemoteAddress '${TAILNET}' -Enabled True}else{New-NetFirewallRule -Name '${FW_RULE}' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress '${TAILNET}' | Out-Null}`
        + others.map((r) => `\nSet-NetFirewallRule -Name ${q(r.name)} -RemoteAddress '${TAILNET}'`).join('')) });
  }
  if (st.standbyAc !== 0 || st.hibernateAc !== 0) {
    steps.push({ key: 'power', title: '전원: AC 대기·최대 절전 끔(화면 끄기는 그대로)', detail: `지금 대기 ${st.standbyAc ?? '?'}초·최대 절전 ${st.hibernateAc ?? '?'}초`,
      apply: (c) => {
        for (const k of ['standby-timeout-ac', 'hibernate-timeout-ac']) {
          const r = c.run('powercfg', ['/change', k, '0']);
          if (r.status !== 0) return r;
        }
        return { status: 0 };
      } });
  }
  if (!taskOk(st.daemonTask, st.claudeExe)) {
    const exe = st.claudeExe;
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    steps.push({ key: 'daemon-task', title: `claude daemon 로그온 작업 ${DAEMON_TASK}`,
      detail: `${st.daemonTask ? '설정이 달라 다시 등록' : '새로 등록'} — 로그온 때 바탕화면(대화형·일반 권한)에서 claude daemon run. 등록만 하고 지금 시작하지 않음`,
      apply: (c) => {
        if (!exe) throw new Error('claude를 찾지 못했습니다(PATH). Claude Code를 설치한 뒤 다시 실행하세요');
        // 관리자 창에서도 작업 계정은 지금 사용자. ssh 쪽은 USERDOMAIN이 WORKGROUP이라 WindowsIdentity 이름을 쓴다
        return c.ps(`$u=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$a=New-ScheduledTaskAction -Execute ${q(PS_EXE)} -Argument ${q(daemonArgs(exe))}
$t=New-ScheduledTaskTrigger -AtLogOn -User $u
$p=New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited
$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName '${DAEMON_TASK}' -Description 'wy-ops: 로그온 때 바탕화면에서 claude daemon(백그라운드 세션)을 띄움(D-167)' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null`);
      } });
  }
  return steps;
}

function fixKeysAcl(run, file) {
  const a = run('icacls', [file, '/reset']);
  if (a.status !== 0) return a;
  return run('icacls', [file, '/inheritance:r', '/grant:r', `*${SID_ADMINS}:F`, '/grant:r', `*${SID_SYSTEM}:F`]);
}

// 단계를 차례로 실행한다. 하나가 실패하면 멈춘다. sshd_config를 바꿨으면 sshd를 다시 시작한다
function apply(steps, { run, say = () => {}, now = new Date() }) {
  const c = { run, ps: (s) => ps(run, s), stamp: now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, ''), restart: false };
  const done = [];
  for (const s of steps) {
    let r;
    try {
      r = s.apply(c) || { status: 0 };
    } catch (err) {
      r = { status: 1, stderr: err.message };
    }
    if (r.status !== 0) {
      say(`  실패 ${s.title}: ${errText(r)}`);
      return { ok: false, done, failed: s.key };
    }
    say(`  완료 ${s.title}${r.note ? ` (${r.note})` : ''}`);
    done.push(s.key);
  }
  if (c.restart) {
    const r = c.ps('Restart-Service sshd');
    if (r.status !== 0) {
      say(`  실패 sshd 다시 시작: ${errText(r)}`);
      return { ok: false, done, failed: 'restart' };
    }
    say('  완료 sshd 다시 시작(설정 반영)');
  }
  return { ok: true, done };
}

// --add-key: 공개키 한 줄(또는 그 줄이 든 파일)을 administrators_authorized_keys에 넣는다. 같은 키(종류+본문)는 건너뛴다
function parseKey(input) {
  let text = String(input || '').trim();
  try {
    if (text && !KEY_RE.test(text) && fs.existsSync(text) && fs.statSync(text).isFile()) text = fs.readFileSync(text, 'utf8').trim();
  } catch {
    // 파일이 아니면 문자열로 본다
  }
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
  const m = KEY_RE.exec(line);
  if (!m) throw new Error('공개키 형식이 아닙니다(ssh-ed25519 AAAA… 한 줄 또는 .pub 파일). 개인키(.pub 없는 파일)는 넣지 마세요');
  return { type: m[1], blob: m[2], line: m[3] ? `${m[1]} ${m[2]} ${m[3]}` : `${m[1]} ${m[2]}` };
}

function addKey(input, { run, programData } = {}) {
  const key = parseKey(input);
  const file = paths(programData).keys;
  const cur = readText(file) || '';
  const have = cur.split(/\r?\n/).some((l) => {
    const m = KEY_RE.exec(l.trim());
    return m && m[1] === key.type && m[2] === key.blob;
  });
  if (!have) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cur + (cur && !/\n$/.test(cur) ? '\r\n' : '') + key.line + '\r\n', 'utf8'); // BOM 없이
  }
  const r = fixKeysAcl(run, file);
  if (r.status !== 0) throw new Error(`키 파일 권한 정리 실패: ${errText(r)}`);
  return { file, added: !have };
}

// 자동화하지 않는 손일(할 일 카드, lib/todo.js writeTodo 형식)
const MANUAL_TODOS = [
  {
    key: 'host-tailscale',
    title: '호스트: Tailscale 설치·상시 연결',
    what: '이 PC에 Tailscale을 설치·로그인하고, 로그인 전에도 연결되게 하고, 이 기기만 키 만료를 끈다',
    why: 'install.ps1 host가 SSH를 Tailscale 대역(100.64.0.0/10)에서만 받게 막았다. Tailscale이 없으면 밖에서 접속할 수 없다',
    steps: [
      'https://tailscale.com/download 에서 Windows용 설치 → 로그인(계정 2단계 인증 확인)',
      '트레이 아이콘 메뉴에서 Run unattended 켜기(Windows 서비스로 로그인 전 동작)',
      '관리 콘솔(Machines)에서 이 기기 이름을 접속용 별칭으로 정하고, 이 기기만 Disable key expiry',
      '접속 PC에서 같은 계정으로 로그인한 뒤 ping <별칭> 확인',
    ],
    check: 'install.ps1 doctor의 호스트 줄에 Tailscale 실행이 보이면 끝',
  },
  {
    key: 'host-autologon',
    title: '호스트: 자동 로그인(암호화 저장)',
    what: '재부팅 뒤 사람 손 없이 로그인되게 Sysinternals Autologon으로 자동 로그인을 켠다',
    why: '역할 세션·브라우저는 로그인한 사용자 세션에서 돈다. 정전·업데이트 재부팅 뒤 원격에서 복구하려면 로그인이 필요하다',
    steps: [
      'Microsoft Sysinternals Autologon을 받아 관리자로 실행 → 계정·비밀번호 입력 → Enable(비밀번호는 LSA 비밀로 암호화 저장)',
      '레지스트리 Winlogon의 DefaultPassword에 비밀번호를 평문으로 넣는 방법은 쓰지 않는다',
      '재부팅해 자동 로그인되는지 확인',
    ],
  },
  {
    key: 'host-update-hours',
    title: '호스트: Windows 업데이트 사용 시간',
    what: '설정 → Windows 업데이트 → 사용 시간을 작업하는 시간대로 지정한다',
    why: '작업 중 업데이트 재부팅으로 역할 세션이 끊기지 않게',
    steps: ['설정 → 업데이트 및 보안 → Windows 업데이트 → 사용 시간 변경'],
  },
];

// 이미 된 손일은 뺀다. Tailscale: 서비스 실행 + 로그인(BackendState Running). 자동 로그인: AutoAdminLogon=1이고 평문 비밀번호 없음.
//   AutoAdminLogon=1인데 평문 DefaultPassword가 있으면 카드를 남기고 주의를 붙인다. 업데이트 사용 시간은 읽을 수 없어 늘 남긴다
function pendingTodos(st) {
  const notes = [];
  const tsDone = !!(st.tailscale && st.tailscale.status === 'Running' && st.tailscaleState === 'Running');
  const al = st.autoLogon;
  if (al && al.enabled && al.plainPassword) notes.push('주의: 자동 로그인이 레지스트리 평문 비밀번호(Winlogon DefaultPassword)로 켜져 있습니다. Sysinternals Autologon으로 다시 켜서 암호화 저장으로 바꾸세요');
  const alDone = !!(al && al.enabled && !al.plainPassword);
  const todos = MANUAL_TODOS.filter((t) => !(t.key === 'host-tailscale' && tsDone) && !(t.key === 'host-autologon' && alDone));
  const skipped = MANUAL_TODOS.filter((t) => !todos.includes(t)).map((t) => t.title);
  return { todos, skipped, notes };
}

// doctor '호스트' 줄. 호스트로 설정하지 않은 PC(sshd 없음)는 해당 없음(통과)
function check(run, { platform = process.platform, serverStub } = {}) {
  const ok = (detail) => ({ level: 'ok', detail });
  if (platform !== 'win32') return ok('해당 없음(Windows 아님)');
  const st = probe(run);
  if (!st) return { level: 'warn', detail: '상태를 읽지 못함(PowerShell 점검 실패)' };
  if (!st.sshd) return ok('해당 없음(OpenSSH 서버 없음 — 원격 호스트로 쓰려면 관리자 PowerShell에서 install.ps1 host)');
  const bad = [];
  const good = [];
  (st.sshd.status === 'Running' && st.sshd.start === 'Automatic' ? good : bad).push(`sshd ${st.sshd.status}·${st.sshd.start}`);
  const ver = sshVersion(st.sshdVersion);
  const where = isProgramFiles(st.sshdExe) ? 'Program Files' : isBuiltin(st.sshdExe) ? '선택적 기능' : '';
  if (ver == null) bad.push(`sshd -V 실행 실패${where ? `(${where})` : ''} — install.ps1 host로 Win32-OpenSSH 교체`);
  else (ver >= MIN_VERSION ? good : bad).push(`OpenSSH ${ver.toFixed(2).replace(/\.0(\d)$/, '.$1')}${where ? `(${where})` : ''}${ver >= MIN_VERSION ? '' : ' — 8.1 미만, install.ps1 host로 교체'}`);
  // 관리자만 읽히는 항목은 일반 권한 doctor에서 '확인 못 함'으로만 적고 주의로 세지 않는다(세션들이 늘 일반 권한으로 돌린다)
  const unknown = [];
  if (st.denied.includes('firewall') || st.denied.includes('fwOthers')) unknown.push('방화벽');
  else (fwOk(st.firewall, st.fwOthers) ? good : bad).push(st.firewall ? `방화벽 ${st.firewall.enabled ? '' : '꺼짐 '}${(st.firewall.remote || []).join(',')}${othersOk(st.fwOthers) ? '' : ' + 다른 OpenSSH 규칙이 모든 주소 허용'}` : '방화벽 규칙 없음');
  (st.tailscale && st.tailscale.status === 'Running' ? good : bad).push(st.tailscale ? `Tailscale ${st.tailscale.status}` : 'Tailscale 없음');
  (st.standbyAc === 0 && st.hibernateAc === 0 ? good : bad).push(`AC 대기 ${st.standbyAc ?? '?'}초·최대 절전 ${st.hibernateAc ?? '?'}초`);
  if (!taskOk(st.daemonTask, st.claudeExe)) bad.push(st.daemonTask ? `daemon 로그온 작업 설정 다름 — install.ps1 host` : 'daemon 로그온 작업 없음 — install.ps1 host');
  if (st.daemon) {
    const d = st.daemon;
    const where = `daemon 세션 ${d.session}·로그온 유형 ${d.logonType ?? '?'}`;
    if (daemonOk(d)) good.push(where);
    else bad.push(`${where} — 바탕화면 로그온이 아니라 세션들의 git push·gh가 실패함. 옮기기는 MANUAL 3-5`);
  } else good.push('daemon 꺼짐');
  if (serverStub) (serverStub.ok ? good : bad).push(serverStub.exists ? `원격 확장 ${serverStub.ok ? '최신' : '옛 판'}` : '원격 확장(~/.vscode-server) 없음');
  if (unknown.length) good.push(`${unknown.join('·')} 확인 못 함(관리자 권한 필요)`);
  if (!bad.length) return ok(good.join(' · '));
  return { level: 'warn', detail: `${bad.join(' · ')}${good.length ? ` (정상: ${good.join(' · ')})` : ''}` };
}

const INSTALL_LINE = '& "$env:USERPROFILE\\.wy-tools\\wy-ops\\current\\install.ps1"';

// install.ps1 host [--dry-run] [--yes] | host --add-key <공개키 줄|.pub 파일>
//   io = { argv, say, confirm, run, writeTodos(items) → [id]|null, afterApply(), programData? }  (install.js가 넘긴다. programData는 시험용)
function cli(io) {
  const { argv, say, confirm, run } = io;
  const opt = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : null);
  if ((io.platform || process.platform) !== 'win32') throw new Error('host는 Windows에서만 씁니다');
  const st = probe(run);
  if (!st) throw new Error('PowerShell로 이 PC 상태를 읽지 못했습니다');
  const notAdmin = () => {
    say('관리자 권한이 필요합니다. 시작 메뉴에서 PowerShell을 "관리자 권한으로 실행"한 뒤 같은 명령을 다시 실행하세요:');
    say(`  ${INSTALL_LINE} host ${argv.slice(1).join(' ')}`.trimEnd());
    return { ok: false };
  };
  if (argv.includes('--add-key')) {
    const v = opt('--add-key');
    if (!v || v.startsWith('--')) throw new Error('--add-key에는 공개키 한 줄이나 .pub 파일이 필요합니다');
    parseKey(v); // 관리자 안내 전에 형식부터
    if (!st.admin) return notAdmin();
    const r = addKey(v, { run, programData: io.programData });
    say(r.added ? `공개키를 넣었습니다: ${r.file}` : `이미 있는 키라 건너뜁니다: ${r.file}`);
    return { ok: true, added: r.added };
  }
  const steps = plan(st, { programData: io.programData, programFiles: io.programFiles });
  say(steps.length ? `원격 호스트 준비 — 바꿀 것 ${steps.length}개:` : '원격 호스트 준비 — 자동으로 바꿀 것 없음');
  for (const s of steps) say(`  - ${s.title}${s.detail ? ` — ${s.detail}` : ''}`);
  const manual = pendingTodos(st);
  say('손으로 할 일(자동화하지 않음):');
  for (const t of manual.todos) say(`  - ${t.title}`);
  for (const t of manual.skipped) say(`  - (이미 됨, 건너뜀) ${t}`);
  for (const n of manual.notes) say(`  ${n}`);
  if (argv.includes('--dry-run')) {
    say('(--dry-run: 아무것도 바꾸지 않았습니다)');
    return { ok: true, dryRun: true, steps: steps.map((s) => s.key) };
  }
  if (!st.admin) return notAdmin();
  let res = { ok: true, done: [] };
  if (steps.length) {
    if (!confirm('위처럼 바꿀까요?')) {
      say('바꾸지 않았습니다');
      return { ok: false, declined: true };
    }
    res = apply(steps, { run, say });
    if (!res.ok) return res;
  }
  if (io.afterApply) io.afterApply();
  const ids = io.writeTodos ? io.writeTodos(manual.todos) : null;
  if (ids && ids.length) say(`할 일 카드를 올렸습니다: ${ids.join(', ')}`);
  else if (!ids) for (const t of manual.todos) say(`\n[할 일] ${t.title}\n${t.steps.map((x) => `  - ${x}`).join('\n')}`);
  say('\n다음: 접속 PC에서 install.ps1 connect로 키를 만들고, 출력된 한 줄(host --add-key …)을 이 PC의 관리자 PowerShell에서 실행하세요.');
  return res;
}

module.exports = { cli, DAEMON_TASK, GOOD_LOGON, daemonArgs, taskOk, daemonOk, TAILNET, FW_RULE, SID_ADMINS, SID_SYSTEM, MANUAL_TODOS, pendingTodos, paths, ps, errText, probe, acSeconds, editSshdConfig, plan, apply, parseKey, addKey, check, fwOk, aclOk, sshVersion, findSshd, builtinBad, WINGET_ID };
