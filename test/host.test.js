// install.ps1 host(원격 호스트 준비)·doctor 호스트 줄 검사: 가짜 실행기(run)와 임시 ProgramData로 돈다. 실제 시스템은 바꾸지 않는다.
//   node test/host.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const host = require('../lib/host');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-host-'));
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBodyOnlyForTests0000000000000 wy-ops-connect-test';
const KEY2 = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyBodyOnlyForTests11111111111111 other';
const DEFAULT_CONFIG = [
  '# This is the sshd server system-wide configuration file.',
  '#PubkeyAuthentication yes',
  '#PasswordAuthentication yes',
  '#PermitEmptyPasswords no',
  'Subsystem\tsftp\tsftp-server.exe',
  '',
  'Match Group administrators',
  '       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys',
  '',
].join('\r\n');
const powercfg = (sec) => `전원 설정 GUID: 29f6c1db\n  최소 가능한 설정: 0x00000000\n  현재 AC 전원 설정 인덱스: 0x${sec.toString(16).padStart(8, '0')}\n  현재 DC 전원 설정 인덱스: 0x00000384\n`;

// 가짜 PC: 상태(st)를 들고, 명령이 오면 상태를 바꾼다. 부른 명령은 calls에 남긴다
function fakePc(name, over = {}) {
  const programData = path.join(base, name);
  const pc = {
    programData,
    calls: [],
    programFiles: path.join(base, name, 'pf'),
    st: { admin: true, sshd: null, tailscale: null, defaultShell: null, firewall: null, standby: 1800, hibernate: 0, keysAcl: null,
      sshdPath: null, sshdExe: null, sshdVersion: null, builtin: false, fwOthers: [], ...over },
    winget: true,
    fail: null, // 실패시킬 단계 표식(스크립트 일부 문자열)
    sshdT: 0,
  };
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  pc.run = (cmd, args = []) => {
    if (cmd === 'powershell') {
      const i = args.indexOf('-EncodedCommand');
      const script = Buffer.from(args[i + 1], 'base64').toString('utf16le');
      pc.calls.push(`ps:${script.split('\n').slice(2).join(' ').slice(0, 80)}`);
      if (pc.fail && script.includes(pc.fail)) return { status: 1, stdout: '', stderr: '가짜 실패' };
      const s = pc.st;
      if (script.includes('ConvertTo-Json')) {
        return ok(JSON.stringify({
          admin: s.admin, sshd: s.sshd, tailscale: s.tailscale, defaultShell: s.defaultShell,
          firewall: s.firewall, standby: powercfg(s.standby), hibernate: powercfg(s.hibernate), keysAcl: s.keysAcl,
          tailscaleState: s.tailscaleState, autoLogon: s.autoLogon,
          sshdPath: s.sshdPath, sshdExe: s.sshdExe, sshdVersion: s.sshdVersion, builtin: s.builtin, fwOthers: s.fwOthers,
        }));
      }
      if (script.includes('Remove-WindowsCapability')) Object.assign(s, { builtin: false, sshd: null, sshdPath: null, sshdExe: null, sshdVersion: null });
      if (script.includes('Set-NetFirewallRule -Name ')) s.fwOthers = s.fwOthers.map((r) => (script.includes(`'${r.name}'`) ? { ...r, remote: [host.TAILNET] } : r));
      if (script.includes('Start-Service sshd')) {
        s.sshd = { status: 'Running', start: 'Automatic' };
        if (!fs.existsSync(path.join(programData, 'ssh', 'sshd_config'))) {
          fs.mkdirSync(path.join(programData, 'ssh'), { recursive: true });
          fs.writeFileSync(path.join(programData, 'ssh', 'sshd_config'), DEFAULT_CONFIG);
        }
      }
      if (script.includes('DefaultShell')) s.defaultShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      if (script.includes('NetFirewallRule')) s.firewall = { enabled: 'True', remote: [host.TAILNET] };
      return ok();
    }
    pc.calls.push([path.basename(cmd), ...args.map((a) => (a.startsWith(base) ? '<file>' : a))].join(' '));
    if (cmd === 'icacls') {
      if (args.includes('/inheritance:r')) pc.st.keysAcl = { protected: true, sids: [host.SID_ADMINS, host.SID_SYSTEM] };
      return ok();
    }
    if (cmd === 'powercfg') {
      if (args[1] === 'standby-timeout-ac') pc.st.standby = 0;
      if (args[1] === 'hibernate-timeout-ac') pc.st.hibernate = 0;
      return ok();
    }
    if (cmd === 'winget') {
      if (!pc.winget) return { status: null, stdout: '', stderr: 'spawnSync winget ENOENT' };
      if (args[0] === 'install') {
        const exe = path.join(pc.programFiles, 'OpenSSH', 'sshd.exe');
        fs.mkdirSync(path.dirname(exe), { recursive: true });
        fs.writeFileSync(exe, '');
        Object.assign(pc.st, { sshd: { status: 'Stopped', start: 'Manual' }, sshdPath: exe, sshdExe: exe, sshdVersion: 'OpenSSH_for_Windows_10.0p2' });
      }
      return ok('v1.9');
    }
    if (/sshd\.exe$/.test(cmd)) return { status: pc.sshdT, stdout: '', stderr: pc.sshdT ? 'line 3: Bad configuration option' : '' };
    return { status: null, stdout: '', stderr: 'unknown' };
  };
  return pc;
}

function io(pc, argv, { yes = true } = {}) {
  const out = [];
  const todos = [];
  const r = host.cli({
    argv: ['host', ...argv], platform: 'win32', programData: pc.programData, programFiles: pc.programFiles, run: pc.run,
    say: (s = '') => out.push(s), confirm: () => yes,
    writeTodos: (items) => (todos.push(...items.map((t) => t.key)), items.map((t) => `setup-${t.key}`)),
    afterApply: () => out.push('<afterApply>'),
  });
  return { r, out: out.join('\n'), todos };
}

try {
  // powercfg 출력(한국어·영어)에서 AC 값
  assert.strictEqual(host.acSeconds(powercfg(1800)), 1800);
  assert.strictEqual(host.acSeconds('Current AC Power Setting Index: 0x00000000\nCurrent DC Power Setting Index: 0x00000384'), 0);
  assert.strictEqual(host.acSeconds('알 수 없음'), null);

  // sshd_config 편집: 주석 줄을 켜고, 없는 키는 Match 앞에, 줄바꿈(CRLF) 유지, 두 번째는 바꿀 것 없음
  {
    const e = host.editSshdConfig(DEFAULT_CONFIG);
    assert.ok(e.text.includes('\r\nPubkeyAuthentication yes\r\nPasswordAuthentication no\r\n'), e.text);
    assert.ok(/KbdInteractiveAuthentication no\r\n\r\nMatch Group administrators/.test(e.text), e.text);
    assert.ok(!/\r\n#PasswordAuthentication/.test(e.text));
    assert.strictEqual(host.editSshdConfig(e.text).changes.length, 0, '두 번 고쳐도 같음');
    // 켜져 있던 비밀번호 로그인은 끔. Match 안의 같은 키는 건드리지 않음
    const on = host.editSshdConfig('PasswordAuthentication yes\nMatch User x\n  PasswordAuthentication yes\n');
    assert.ok(on.changes.some((c) => c.includes('PasswordAuthentication yes → PasswordAuthentication no')));
    assert.ok(on.text.startsWith('PasswordAuthentication no\n'));
    assert.ok(on.text.includes('Match User x\n  PasswordAuthentication yes\n'), on.text);
    // 관리자 키 파일 지정을 지웠으면 되살림
    assert.ok(on.text.includes('Match Group administrators\n       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys'));
  }

  // 공개키 형식: 줄·파일 모두 받음, 개인키·이상한 값은 거절
  {
    assert.strictEqual(host.parseKey(KEY).line, KEY);
    const pub = path.join(base, 'id.pub');
    fs.writeFileSync(pub, KEY + '\n');
    assert.strictEqual(host.parseKey(pub).line, KEY);
    assert.throws(() => host.parseKey('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn'), /공개키 형식/);
    assert.throws(() => host.parseKey('ssh-ed25519'), /공개키 형식/);
  }

  // 새 PC: 전부 설치·설정. 실행 순서, 바뀐 상태, 할 일 카드, 다시 돌리면 바꿀 것 없음
  {
    const pc = fakePc('fresh');
    const { r, out, todos } = io(pc, []);
    assert.ok(r.ok, out);
    assert.deepStrictEqual(r.done, ['install', 'service', 'shell', 'config', 'keys', 'firewall', 'power']);
    const cfg = fs.readFileSync(host.paths(pc.programData).config, 'utf8');
    assert.ok(cfg.includes('PasswordAuthentication no') && cfg.includes('PubkeyAuthentication yes'));
    assert.ok(fs.readdirSync(path.join(pc.programData, 'ssh')).some((f) => f.startsWith('sshd_config.bak-')), '설정 백업');
    assert.ok(fs.existsSync(host.paths(pc.programData).keys), '빈 키 파일');
    assert.ok(pc.calls.some((c) => c.startsWith('ps:Restart-Service sshd')), '설정을 바꿨으면 sshd 다시 시작');
    assert.ok(pc.calls.includes(`icacls <file> /inheritance:r /grant:r *${host.SID_ADMINS}:F /grant:r *${host.SID_SYSTEM}:F`), pc.calls.join('\n'));
    assert.ok(pc.calls.includes('powercfg /change standby-timeout-ac 0'));
    assert.ok(!pc.calls.some((c) => /monitor-timeout/.test(c)), '화면 끄기는 그대로');
    assert.deepStrictEqual(todos, ['host-tailscale', 'host-autologon', 'host-update-hours']);
    assert.ok(out.includes('<afterApply>'));
    assert.ok(/install\.ps1 connect/.test(out));
    const again = io(pc, []);
    assert.ok(again.out.includes('자동으로 바꿀 것 없음'), again.out);
    assert.deepStrictEqual(again.r.done, []);
  }

  // OpenSSH 버전·sshd.exe 위치
  {
    assert.strictEqual(host.sshVersion('OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2'), 9.05);
    assert.strictEqual(host.sshVersion('OpenSSH_7.7p1, LibreSSL 2.6.5'), 7.07);
    assert.strictEqual(host.sshVersion(''), null);
    const pf = 'C:\\Program Files';
    assert.strictEqual(host.findSshd({ programFiles: pf, exists: () => true }), 'C:\\Program Files\\OpenSSH\\sshd.exe', 'Program Files 우선');
    assert.strictEqual(host.findSshd({ programFiles: pf, exists: () => false }), 'C:\\Windows\\System32\\OpenSSH\\sshd.exe', '없으면 System32');
  }

  // 선택적 기능 7.7(실행 안 됨): 제거 → winget 설치 → 서비스 → 나머지. sshd -t는 Program Files 쪽으로
  {
    const sys = 'C:\\Windows\\System32\\OpenSSH\\sshd.exe';
    const pc = fakePc('old-builtin', { sshd: { status: 'Stopped', start: 'Manual' }, builtin: true, sshdPath: sys, sshdExe: sys, sshdVersion: '' });
    const { r, out } = io(pc, []);
    assert.ok(r.ok, out);
    assert.deepStrictEqual(r.done.slice(0, 3), ['remove-builtin', 'install', 'service'], out);
    assert.ok(out.includes('sshd -V 실행 실패'), out);
    assert.ok(pc.calls.includes(`winget install --id ${host.WINGET_ID} -e --silent --accept-package-agreements --accept-source-agreements`), pc.calls.join('\n'));
    assert.ok(pc.calls.some((c) => c === 'sshd.exe -t'), 'sshd -t 실행');
    assert.ok(fs.existsSync(path.join(pc.programFiles, 'OpenSSH', 'sshd.exe')));
    // 낮은 버전(7.7)이 실행은 되어도 교체, 8.1 이상 선택적 기능은 그대로 씀
    assert.ok(host.builtinBad({ builtin: true, sshdExe: sys, sshdVersion: 'OpenSSH_7.7p1' }));
    assert.ok(!host.builtinBad({ builtin: true, sshdExe: sys, sshdVersion: 'OpenSSH_for_Windows_9.5p1' }));
    assert.ok(!host.builtinBad({ builtin: true, sshdPath: 'C:\\Program Files\\OpenSSH\\sshd.exe', sshdExe: 'C:\\Program Files\\OpenSSH\\sshd.exe', sshdVersion: 'OpenSSH_for_Windows_10.0p2' }));
  }
  // 서비스가 이미 Program Files 쪽이면 제거·설치 건너뜀(선택적 기능판 파일이 남아 있어도)
  {
    const pfExe = 'C:\\Program Files\\OpenSSH\\sshd.exe';
    const keys = host.plan({ admin: true, sshd: { status: 'Running', start: 'Automatic' }, sshdPath: pfExe, sshdExe: pfExe, sshdVersion: '', builtin: true, fwOthers: [], standbyAc: 0, hibernateAc: 0 }, { programData: path.join(base, 'pfsvc') }).map((s) => s.key);
    assert.ok(!keys.includes('install') && !keys.includes('remove-builtin') && !keys.includes('service'), keys.join());
  }
  // winget이 없으면 MSI 안내로 멈춤
  {
    const pc = fakePc('nowinget');
    pc.winget = false;
    const { r, out } = io(pc, []);
    assert.strictEqual(r.failed, 'install');
    assert.ok(/winget이 없습니다.*msiexec \/i <받은 msi> ADDLOCAL=Server/.test(out), out);
  }
  // 방화벽: 기본 규칙 이름이 없으면 만들고, 모든 주소를 받는 다른 OpenSSH 규칙은 Tailscale 대역으로 좁힘
  {
    const others = [{ name: 'sshd-preview', enabled: true, remote: ['Any'] }, { name: 'off-rule', enabled: false, remote: ['Any'] }];
    assert.ok(!host.fwOk({ enabled: true, remote: [host.TAILNET] }, others));
    assert.ok(host.fwOk({ enabled: true, remote: [host.TAILNET] }, [others[1]]), '꺼진 규칙은 괜찮음');
    const pc = fakePc('fw-others', { fwOthers: others.map((r) => ({ ...r, enabled: r.enabled ? 'True' : 'False' })) }); // probe 출력처럼 문자열
    const { r, out } = io(pc, []);
    assert.ok(r.ok, out);
    assert.ok(out.includes('다른 OpenSSH 규칙도 100.64.0.0/10만으로: sshd-preview') && !out.includes('off-rule'), out);
    assert.deepStrictEqual(pc.st.firewall, { enabled: 'True', remote: [host.TAILNET] }, '기본 이름 규칙을 새로 만듦');
    assert.deepStrictEqual(pc.st.fwOthers[0].remote, [host.TAILNET]);
  }

  // 이미 된 손일은 카드에서 뺌: Tailscale 실행+로그인, 자동 로그인(평문 비밀번호 없음). 업데이트 사용 시간은 늘 남음
  {
    const ts = { status: 'Running', start: 'Automatic' };
    const keysOf = (over) => host.pendingTodos({ tailscale: null, tailscaleState: null, autoLogon: null, ...over }).todos.map((t) => t.key);
    assert.deepStrictEqual(keysOf({}), ['host-tailscale', 'host-autologon', 'host-update-hours']);
    assert.deepStrictEqual(keysOf({ tailscale: ts, tailscaleState: 'NeedsLogin' }), ['host-tailscale', 'host-autologon', 'host-update-hours'], '로그인 안 됨이면 남김');
    assert.deepStrictEqual(keysOf({ tailscale: { status: 'Stopped', start: 'Automatic' }, tailscaleState: 'Running' }), ['host-tailscale', 'host-autologon', 'host-update-hours'], '서비스가 멈췄으면 남김');
    assert.deepStrictEqual(keysOf({ tailscale: ts, tailscaleState: 'Running', autoLogon: { enabled: true, plainPassword: false } }), ['host-update-hours']);
    const plain = host.pendingTodos({ autoLogon: { enabled: true, plainPassword: true } });
    assert.ok(plain.todos.some((t) => t.key === 'host-autologon') && /Autologon으로 다시 켜서/.test(plain.notes.join()), '평문 비밀번호면 카드 남기고 주의');
    assert.strictEqual(host.pendingTodos({ autoLogon: { enabled: false, plainPassword: true } }).notes.length, 0, '자동 로그인이 꺼져 있으면 주의 없음');
    // cli: 다 된 PC는 업데이트 사용 시간 카드만 올리고 건너뜀을 알림
    const pc = fakePc('manual-done', { tailscale: ts, tailscaleState: 'Running', autoLogon: { enabled: true, plainPassword: false } });
    const { out, todos } = io(pc, []);
    assert.deepStrictEqual(todos, ['host-update-hours'], out);
    assert.ok(out.includes('(이미 됨, 건너뜀) 호스트: Tailscale') && out.includes('(이미 됨, 건너뜀) 호스트: 자동 로그인'), out);
    const warn = io(fakePc('manual-plain', { autoLogon: { enabled: true, plainPassword: true } }), ['--dry-run']);
    assert.ok(/주의: 자동 로그인이 레지스트리 평문/.test(warn.out), warn.out);
  }
  // 실패 메시지: CLIXML 원문 대신 사람 말(진행 레코드·위치·CategoryInfo 줄 뺌)
  {
    const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>처음 사용하기 위해 모듈을 준비하는 중입니다.</AV></PR></MS></Obj>'
      + '<S S="Error">Start-Service : &apos;OpenSSH SSH Server (sshd)&apos; 서비스를 시작할 수 없습니다._x000D__x000A_</S><S S="Error">위치 줄:4 문자:1_x000D__x000A_</S>'
      + '<S S="Error">+ Start-Service sshd_x000D__x000A_</S><S S="Error">    + CategoryInfo          : OpenError: (System.ServiceProcess.ServiceController:ServiceController) [Start-Service]_x000D__x000A_</S><S S="Error"> _x000D__x000A_</S></Objs>';
    assert.strictEqual(host.errText({ status: 1, stderr: clixml }), "Start-Service : 'OpenSSH SSH Server (sshd)' 서비스를 시작할 수 없습니다.");
    assert.strictEqual(host.errText({ status: 1, stderr: ' 그냥 글 \r\n' }), '그냥 글');
    assert.strictEqual(host.errText({ status: 3, stderr: '', stdout: '' }), '종료 코드 3');
    // 단계 실패가 CLIXML로 와도 출력에는 풀린 글만
    const pc = fakePc('clixml');
    const run0 = pc.run;
    pc.run = (cmd, args) => (cmd === 'powershell' && Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le').includes('Start-Service sshd') ? { status: 1, stdout: '', stderr: clixml } : run0(cmd, args));
    const { out } = io(pc, []);
    assert.ok(out.includes("실패 sshd 자동 시작·실행: Start-Service : 'OpenSSH SSH Server (sshd)' 서비스를 시작할 수 없습니다.") && !out.includes('CLIXML'), out);
  }
  // 실제 자식 powershell(Windows에서만): 오류는 스크립트 안에서 잡혀 메시지 한 줄로 온다(없는 서비스라 아무것도 바꾸지 않음)
  if (process.platform === 'win32') {
    const { spawnSync } = require('child_process');
    const r = host.ps((c, a) => spawnSync(c, a, { encoding: 'utf8' }), "Write-Progress -Activity x -Status y\nStart-Service 'wy-ops-no-such-service'");
    assert.strictEqual(r.status, 1);
    assert.ok(!/CLIXML|<Objs/.test(r.stderr) && /wy-ops-no-such-service/.test(r.stderr), JSON.stringify(r.stderr));
  }

  // 점검 스크립트는 DefaultPassword 값을 읽지 않음(이름 목록만)
  {
    let script = '';
    host.probe((cmd, args) => ((script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')), { status: 1 }));
    assert.ok(script.includes("GetValueNames()) -contains 'DefaultPassword'") && !/GetValue\('DefaultPassword'\)|-Name DefaultPassword/.test(script), script);
  }

  // --dry-run: 관리자가 아니어도 목록만 보여 주고 아무것도 부르지 않음
  {
    const pc = fakePc('dry', { admin: false });
    const { r, out } = io(pc, ['--dry-run']);
    assert.ok(r.dryRun && r.steps.includes('install'), out);
    assert.deepStrictEqual(pc.calls.filter((c) => !c.includes('ConvertTo-Json') && !c.startsWith('ps:$ErrorActionPreference')), []);
  }

  // 관리자가 아니면 안내만 하고 멈춤
  {
    const pc = fakePc('user', { admin: false });
    const { r, out } = io(pc, []);
    assert.strictEqual(r.ok, false);
    assert.ok(/관리자 권한으로 실행/.test(out), out);
    assert.ok(!fs.existsSync(pc.programData), '아무것도 쓰지 않음');
  }

  // 확인을 거절하면 바꾸지 않음
  {
    const pc = fakePc('no');
    const { r } = io(pc, [], { yes: false });
    assert.ok(r.declined);
    assert.strictEqual(pc.st.sshd, null);
  }

  // 중간 단계가 실패하면 거기서 멈추고 실패 단계를 알려 줌
  {
    const pc = fakePc('fail');
    pc.fail = 'New-ItemProperty';
    const { r, out } = io(pc, []);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failed, 'shell');
    assert.deepStrictEqual(r.done, ['install', 'service']);
    assert.ok(/실패 SSH 기본 셸/.test(out));
    assert.ok(!out.includes('<afterApply>'));
  }

  // sshd -t 검사가 실패하면 sshd_config를 되돌림
  {
    const pc = fakePc('badcfg', { sshd: { status: 'Running', start: 'Automatic' } });
    fs.mkdirSync(path.join(pc.programData, 'ssh'), { recursive: true });
    fs.writeFileSync(host.paths(pc.programData).config, DEFAULT_CONFIG);
    pc.sshdT = 1;
    const { r } = io(pc, []);
    assert.strictEqual(r.failed, 'config');
    assert.strictEqual(fs.readFileSync(host.paths(pc.programData).config, 'utf8'), DEFAULT_CONFIG, '원래대로');
  }

  // 방화벽이 모든 주소를 받으면 좁힘
  {
    const st = { admin: true, sshd: { status: 'Running', start: 'Automatic' }, defaultShell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', firewall: { enabled: true, remote: ['Any'] }, standbyAc: 0, hibernateAc: 0, keysAcl: null };
    const keys = host.plan(st, { programData: path.join(base, 'fw') }).map((s) => s.key);
    assert.ok(keys.includes('firewall') && !keys.includes('power') && !keys.includes('install'), keys.join());
  }

  // --add-key: 넣고, 같은 키는 건너뛰고, 다른 키는 덧붙임. 권한은 매번 정리
  {
    const pc = fakePc('keys');
    let { r, out } = io(pc, ['--add-key', KEY]);
    assert.ok(r.ok && r.added, out);
    ({ r } = io(pc, ['--add-key', KEY.replace(' wy-ops-connect-test', ' 다른-주석')]));
    assert.strictEqual(r.added, false, '같은 키(주석만 다름)는 건너뜀');
    ({ r } = io(pc, ['--add-key', KEY2]));
    assert.ok(r.added);
    const text = fs.readFileSync(host.paths(pc.programData).keys, 'utf8');
    assert.strictEqual(text, `${KEY}\r\n${KEY2}\r\n`);
    assert.ok(!text.startsWith('\uFEFF'), 'BOM 없음');
    assert.strictEqual(pc.calls.filter((c) => c.includes('/inheritance:r')).length, 3);
    // 관리자가 아니면 안내만, 형식이 틀리면 관리자 안내보다 먼저 거절
    const u = fakePc('keys-user', { admin: false });
    assert.strictEqual(io(u, ['--add-key', KEY]).r.ok, false);
    assert.ok(!fs.existsSync(u.programData));
    assert.throws(() => io(u, ['--add-key', 'nope']), /공개키 형식/);
    assert.throws(() => io(u, ['--add-key']), /공개키 한 줄/);
  }

  // doctor 호스트 줄: sshd가 없으면 해당 없음(통과), 다 맞으면 통과, 하나라도 어긋나면 주의, 읽지 못하면 주의
  {
    const check = (over, opts) => host.check(fakePc('chk', over).run, { platform: 'win32', ...opts });
    assert.ok(/해당 없음/.test(check({}).detail) && check({}).level === 'ok');
    assert.ok(/해당 없음/.test(host.check(() => ({}), { platform: 'linux' }).detail));
    const good = {
      sshd: { status: 'Running', start: 'Automatic' }, tailscale: { status: 'Running', start: 'Automatic' },
      firewall: { enabled: 'True', remote: [host.TAILNET] }, standby: 0, hibernate: 0, sshdExe: 'C:\\Program Files\\OpenSSH\\sshd.exe', sshdVersion: 'OpenSSH_for_Windows_10.0p2, LibreSSL 4.2.0',
    };
    assert.strictEqual(check(good).level, 'ok', check(good).detail);
    assert.ok(check(good).detail.includes('OpenSSH 10.0(Program Files)'), check(good).detail);
    for (const [over, word] of [
      [{ firewall: { enabled: 'True', remote: ['Any'] } }, '방화벽'],
      [{ tailscale: null }, 'Tailscale 없음'],
      [{ standby: 1800 }, 'AC 대기 1800초'],
      [{ sshd: { status: 'Stopped', start: 'Automatic' } }, 'sshd Stopped'],
      [{ sshdVersion: '' }, 'sshd -V 실행 실패'],
      [{ sshdVersion: 'OpenSSH_7.7p1' }, '8.1 미만'],
      [{ fwOthers: [{ name: 'x', enabled: 'True', remote: ['Any'] }] }, '다른 OpenSSH 규칙'],
    ]) {
      const r = check({ ...good, ...over });
      assert.ok(r.level === 'warn' && r.detail.includes(word), JSON.stringify(r));
    }
    assert.strictEqual(check(good, { serverStub: { exists: false, ok: false } }).level, 'warn');
    assert.strictEqual(check(good, { serverStub: { exists: true, ok: true } }).level, 'ok');
    assert.strictEqual(host.check(() => ({ status: 0, stdout: '5.1.19041.1' }), { platform: 'win32' }).level, 'warn', '읽지 못하면 주의');
  }

  // 공개 저장소: 손일 안내에 개인 값이 없음(별칭은 자리표시자)
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(host.MANUAL_TODOS).replace(host.TAILNET, '')));

  console.log('wy-ops host 검사 통과');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
