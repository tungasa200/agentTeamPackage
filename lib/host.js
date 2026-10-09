// 원격 호스트 준비(install.ps1 host, 원격 호스트 계획 4.1 H3~H6·P3)와 점검(doctor '호스트' 줄, P5).
//   이 PC를 다른 PC에서 Tailscale + OpenSSH + VS Code Remote-SSH로 쓰는 작업 호스트로 만든다.
//   자동으로 하는 것: OpenSSH 서버 설치·자동 시작·기본 셸 PowerShell, sshd_config 공개키 로그인만,
//     administrators_authorized_keys 권한 정리, 방화벽 OpenSSH 규칙을 Tailscale 대역만, 전원(AC 대기·최대 절전 끔, 화면 끄기는 그대로)
//   손으로 하는 것(할 일 카드·안내): Tailscale 설치·Run unattended·키 만료 끔, 자동 로그인(Sysinternals Autologon), 업데이트 사용 시간
//   공개 저장소에 들어가므로 호스트 이름·IP·계정·키를 코드에 두지 않는다(키는 --add-key 인수로만 받는다).
// 시스템을 바꾸는 명령은 모두 run(cmd, args) → { status, stdout, stderr }로 부른다(시험에서 가짜로 바꿔 끼운다).
const fs = require('fs');
const path = require('path');

const TAILNET = '100.64.0.0/10';
const FW_RULE = 'OpenSSH-Server-In-TCP'; // OpenSSH 서버 설치가 만드는 기본 규칙 이름
const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SSHD_EXE = 'C:\\Windows\\System32\\OpenSSH\\sshd.exe'; // sshd_config 문법 검사(-t)용
// 이름 대신 SID: 한국어 Windows에서는 그룹 이름이 달라 icacls가 못 찾는다
const SID_ADMINS = 'S-1-5-32-544';
const SID_SYSTEM = 'S-1-5-18';
const SSHD_SETTINGS = [
  ['PubkeyAuthentication', 'yes'],
  ['PasswordAuthentication', 'no'],
  ['KbdInteractiveAuthentication', 'no'],
  ['PermitEmptyPasswords', 'no'],
];
const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)\s+([A-Za-z0-9+/]+={0,3})(?:\s+(.*))?$/;

const sshDir = (programData) => path.join(programData || process.env.ProgramData || 'C:\\ProgramData', 'ssh');
const paths = (programData) => ({
  config: path.join(sshDir(programData), 'sshd_config'),
  keys: path.join(sshDir(programData), 'administrators_authorized_keys'),
});

// PowerShell 스크립트를 -EncodedCommand(UTF-16LE base64)로 넘긴다: 여러 줄·따옴표가 명령줄에서 깨지지 않게
function ps(run, script) {
  const full = "$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.Encoding]::UTF8\n" + script;
  return run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')]);
}

// 읽기만 하는 점검(관리자가 아니어도 된다. 키 파일 권한은 관리자일 때만 읽힌다)
const PROBE = `$ErrorActionPreference='SilentlyContinue'
$o=[ordered]@{}
$o.admin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$s=Get-Service sshd; $o.sshd=$(if($s){@{status="$($s.Status)";start="$($s.StartType)"}}else{$null})
$t=Get-Service Tailscale; $o.tailscale=$(if($t){@{status="$($t.Status)";start="$($t.StartType)"}}else{$null})
$ts=(Get-Command tailscale).Source; if(-not $ts){$p=Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe'; if(Test-Path $p){$ts=$p}}
$o.tailscaleState=$(if($ts -and $t -and "$($t.Status)" -eq 'Running'){try{((& $ts status --json) -join ' ' | ConvertFrom-Json).BackendState}catch{$null}}else{$null})
$k=Get-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
$o.autoLogon=$(if($k){@{enabled=("$($k.GetValue('AutoAdminLogon'))" -eq '1');plainPassword=(@($k.GetValueNames()) -contains 'DefaultPassword')}}else{$null})
$o.defaultShell=(Get-ItemProperty 'HKLM:\\SOFTWARE\\OpenSSH' -Name DefaultShell).DefaultShell
$r=Get-NetFirewallRule -Name '${FW_RULE}'
$o.firewall=$(if($r){@{enabled="$($r.Enabled)";remote=@(($r|Get-NetFirewallAddressFilter).RemoteAddress|%{"$_"})}}else{$null})
$o.standby=(powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE) -join "\`n"
$o.hibernate=(powercfg /query SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE) -join "\`n"
$a=Get-Acl (Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys')
$o.keysAcl=$(if($a){@{protected=$a.AreAccessRulesProtected;sids=@($a.Access|%{$ir=$_.IdentityReference;try{$ir.Translate([Security.Principal.SecurityIdentifier]).Value}catch{"$ir"}})}}else{$null})
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
    sshd: j.sshd || null,
    tailscale: j.tailscale || null,
    tailscaleState: j.tailscaleState || null, // tailscale status의 BackendState(로그인돼 연결 중이면 Running)
    // 자동 로그인: AutoAdminLogon=1인지, 평문 DefaultPassword 값이 있는지(값은 읽지 않고 이름만 본다)
    autoLogon: j.autoLogon ? { enabled: j.autoLogon.enabled === true, plainPassword: j.autoLogon.plainPassword === true } : null,
    defaultShell: j.defaultShell || null,
    firewall: j.firewall ? { enabled: String(j.firewall.enabled) === 'True', remote } : null,
    standbyAc: acSeconds(j.standby),
    hibernateAc: acSeconds(j.hibernate),
    keysAcl: j.keysAcl ? { protected: j.keysAcl.protected === true, sids: [].concat(j.keysAcl.sids || []).map(String) } : null,
  };
}

const fwOk = (fw) => !!(fw && fw.enabled && fw.remote && fw.remote.length === 1 && fw.remote[0] === TAILNET);
const aclOk = (acl) => !!(acl && acl.protected && acl.sids.length && acl.sids.every((s) => s === SID_ADMINS || s === SID_SYSTEM));
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
function plan(st, { programData } = {}) {
  const p = paths(programData);
  const steps = [];
  if (!st.sshd) {
    steps.push({ key: 'install', title: 'OpenSSH 서버 설치', detail: 'Windows 선택적 기능 OpenSSH.Server(몇 분 걸릴 수 있음)',
      apply: (c) => c.ps("$n=(Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1).Name\nAdd-WindowsCapability -Online -Name $n | Out-Null") });
  }
  if (!st.sshd || st.sshd.start !== 'Automatic' || st.sshd.status !== 'Running') {
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
        const t = c.run(SSHD_EXE, ['-t']);
        if (t.status !== 0) {
          fs.copyFileSync(bak, p.config);
          throw new Error(`sshd -t 검사 실패로 되돌렸습니다: ${(t.stderr || t.stdout || '').trim()}`);
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
  if (!fwOk(st.firewall)) {
    const now = st.firewall ? `지금 ${st.firewall.enabled ? '켜짐' : '꺼짐'}·${(st.firewall.remote || []).join(',') || '?'}` : '규칙 없음 → 새로 만듦';
    steps.push({ key: 'firewall', title: `방화벽 ${FW_RULE}: ${TAILNET}만`, detail: now,
      apply: (c) => c.ps(`if(Get-NetFirewallRule -Name '${FW_RULE}' -ErrorAction SilentlyContinue){Set-NetFirewallRule -Name '${FW_RULE}' -RemoteAddress '${TAILNET}' -Enabled True}else{New-NetFirewallRule -Name '${FW_RULE}' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress '${TAILNET}' | Out-Null}`) });
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
      say(`  실패 ${s.title}: ${String(r.stderr || r.stdout || '').trim()}`);
      return { ok: false, done, failed: s.key };
    }
    say(`  완료 ${s.title}${r.note ? ` (${r.note})` : ''}`);
    done.push(s.key);
  }
  if (c.restart) {
    const r = c.ps('Restart-Service sshd');
    if (r.status !== 0) {
      say(`  실패 sshd 다시 시작: ${String(r.stderr || '').trim()}`);
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
  if (r.status !== 0) throw new Error(`키 파일 권한 정리 실패: ${String(r.stderr || r.stdout || '').trim()}`);
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
  (fwOk(st.firewall) ? good : bad).push(st.firewall ? `방화벽 ${st.firewall.enabled ? '' : '꺼짐 '}${(st.firewall.remote || []).join(',')}` : '방화벽 규칙 없음');
  (st.tailscale && st.tailscale.status === 'Running' ? good : bad).push(st.tailscale ? `Tailscale ${st.tailscale.status}` : 'Tailscale 없음');
  (st.standbyAc === 0 && st.hibernateAc === 0 ? good : bad).push(`AC 대기 ${st.standbyAc ?? '?'}초·최대 절전 ${st.hibernateAc ?? '?'}초`);
  if (serverStub) (serverStub.ok ? good : bad).push(serverStub.exists ? `원격 확장 ${serverStub.ok ? '최신' : '옛 판'}` : '원격 확장(~/.vscode-server) 없음');
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
  const steps = plan(st, { programData: io.programData });
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

module.exports = { cli, TAILNET, FW_RULE, SID_ADMINS, SID_SYSTEM, MANUAL_TODOS, pendingTodos, paths, ps, probe, acSeconds, editSshdConfig, plan, apply, parseKey, addKey, check, fwOk, aclOk };
