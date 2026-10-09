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
    st: { admin: true, sshd: null, tailscale: null, defaultShell: null, firewall: null, standby: 1800, hibernate: 0, keysAcl: null, ...over },
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
        }));
      }
      if (script.includes('Add-WindowsCapability')) s.sshd = { status: 'Stopped', start: 'Manual' };
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
    if (/sshd\.exe$/.test(cmd)) return { status: pc.sshdT, stdout: '', stderr: pc.sshdT ? 'line 3: Bad configuration option' : '' };
    return { status: null, stdout: '', stderr: 'unknown' };
  };
  return pc;
}

function io(pc, argv, { yes = true } = {}) {
  const out = [];
  const todos = [];
  const r = host.cli({
    argv: ['host', ...argv], platform: 'win32', programData: pc.programData, run: pc.run,
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
      firewall: { enabled: 'True', remote: [host.TAILNET] }, standby: 0, hibernate: 0,
    };
    assert.strictEqual(check(good).level, 'ok', check(good).detail);
    for (const [over, word] of [
      [{ firewall: { enabled: 'True', remote: ['Any'] } }, '방화벽'],
      [{ tailscale: null }, 'Tailscale 없음'],
      [{ standby: 1800 }, 'AC 대기 1800초'],
      [{ sshd: { status: 'Stopped', start: 'Automatic' } }, 'sshd Stopped'],
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
