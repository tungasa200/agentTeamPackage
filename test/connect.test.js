// 접속 PC 준비(lib/connect.js): ssh config 고치기, 계획·적용·여러 번 실행, --dry-run·거절, 바로가기 주소, 호스트 한 줄
//   node test/connect.test.js   임시 홈 폴더·가짜 명령만(실제 ~/.ssh·VS Code·바탕화면은 건드리지 않음)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmTree } = require('../lib/fsx');
const { plan, connect, updateConfig, folderUri, hostLine, attachArgs, REMOTE_SSH } = require('../lib/connect');

// 1. updateConfig
const add = updateConfig('', { alias: 'wy-host', host: 'wy-host' });
assert.strictEqual(add, 'Host wy-host\r\n    HostName wy-host\r\n    IdentityFile ~/.ssh/id_ed25519\r\n');
assert.strictEqual(updateConfig(add, { alias: 'wy-host', host: 'wy-host' }), add, '같으면 그대로');
const other = 'Host other\n    HostName 10.0.0.9\n    User someone\n\nHost *\n    ServerAliveInterval 30\n';
let t = updateConfig(other, { alias: 'wy-host', host: 'wy-host', user: 'dev' });
assert.ok(t.startsWith(other.trimEnd() + '\n\nHost wy-host\n'), '다른 블록 보존, LF 유지');
assert.ok(t.includes('    User dev\n'));
const existing = 'Host wy-host\n  HostName 100.64.0.1\n  Port 22\n  ForwardAgent no\n\nHost other\n  HostName x\n';
t = updateConfig(existing, { alias: 'wy-host', host: 'wy-host', user: 'dev' });
assert.strictEqual(t, 'Host wy-host\n  HostName wy-host\n  Port 22\n  ForwardAgent no\n  User dev\n  IdentityFile ~/.ssh/id_ed25519\n\nHost other\n  HostName x\n', '블록 안 다른 줄·들여쓰기 보존, 빈 줄 앞에 추가');
assert.strictEqual(updateConfig(t, { alias: 'wy-host', host: 'wy-host', user: 'dev' }), t);
assert.strictEqual(updateConfig(t, { alias: 'wy-host', host: 'wy-host' }), t, '--user 없으면 기존 User 유지');
const multi = 'Host wy-host other\n  HostName z\n';
assert.ok(updateConfig(multi, { alias: 'wy-host', host: 'h' }).startsWith(multi), '여러 이름 Host 줄은 건드리지 않고 새 블록');

// 2. 주소·한 줄
assert.strictEqual(folderUri('wy-host', 'C:\\projects\\my project\\'), 'vscode-remote://ssh-remote+wy-host/c:/projects/my%20project');
assert.strictEqual(hostLine("ssh-ed25519 AAAA wy-ops-connect-wy-host\n"), `& "$env:USERPROFILE\\.wy-tools\\wy-ops\\current\\install.ps1" host --add-key 'ssh-ed25519 AAAA wy-ops-connect-wy-host'`);
assert.throws(() => plan({ alias: 'a b', host: 'h' }), /별칭/);
assert.throws(() => plan({ alias: 'wy-host' }), /--host/);
assert.throws(() => plan({ alias: 'wy-host', host: 'h', user: 'a b' }), /--user/);
assert.throws(() => plan({ alias: 'wy-host', host: 'h', folder: 'projects/x' }), /--folder/);

// 3. 계획·적용(임시 홈, 가짜 명령)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-connect-'));
try {
  const home = path.join(root, 'home');
  const desktop = path.join(root, 'desk');
  fs.mkdirSync(home);
  fs.mkdirSync(desktop);
  const codeDir = path.join(root, 'VS Code');
  fs.mkdirSync(path.join(codeDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(codeDir, 'Code.exe'), '');
  const exts = new Set();
  let tailscale = false;
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'tailscale') return { status: tailscale ? 0 : null, stdout: '', stderr: '' };
    if (cmd === 'code' && args[0] === '--list-extensions') return { status: 0, stdout: [...exts].join('\n') + '\n', stderr: '' };
    if (cmd === 'code' && args[0] === '--install-extension') return exts.add(args[1].toLowerCase()), { status: 0, stdout: '', stderr: '' };
    if (cmd === 'where') return { status: 0, stdout: path.join(codeDir, 'bin', 'code') + '\r\n' + path.join(codeDir, 'bin', 'code.cmd') + '\r\n', stderr: '' };
    if (cmd === 'ssh-keygen') {
      const f = args[args.indexOf('-f') + 1];
      assert.ok(!fs.existsSync(f), 'ssh-keygen은 키가 없을 때만');
      fs.writeFileSync(f, 'PRIVATE');
      fs.writeFileSync(f + '.pub', `ssh-ed25519 AAAAC3fake ${args[args.indexOf('-C') + 1]}\n`);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'powershell') {
      const m = args[2].match(/CreateShortcut\('([^']+)'\)/);
      assert.ok(args[2].includes(`'--folder-uri "vscode-remote://ssh-remote+wy-host/c:/projects/my-project"'`));
      assert.ok(args[2].includes(path.join(codeDir, 'Code.exe')), 'Code.exe를 대상으로');
      fs.writeFileSync(m[1], 'LNK');
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error('모르는 명령 ' + cmd);
  };
  const out = [];
  const deps = { run, home, desktop, tailscaleExe: path.join(root, 'tailscale.exe'), say: (s = '') => out.push(s), confirm: () => true };
  const opts = { alias: 'wy-host', host: 'wy-host', user: 'dev', folder: 'C:\\projects\\my-project' };
  const state = (p) => Object.fromEntries(p.steps.map((s) => [s.id, s.state]));

  // 3-1. --dry-run: 아무것도 바꾸지 않음
  let r = connect({ ...opts, dryRun: true }, deps);
  assert.deepStrictEqual(state(r.plan), { tailscale: 'manual', key: 'todo', config: 'todo', 'remote-ssh': 'todo', shortcut: 'todo' });
  assert.ok(!fs.existsSync(path.join(home, '.ssh')) && !fs.readdirSync(desktop).length, 'dry-run은 쓰지 않음');
  assert.strictEqual(r.hostLine, null);
  assert.ok(!calls.some((c) => /ssh-keygen|--install-extension|CreateShortcut/.test(c)));

  // 3-2. 거절
  r = connect(opts, { ...deps, confirm: () => false });
  assert.ok(!r.ok && !fs.existsSync(path.join(home, '.ssh')));

  // 3-3. 적용(Tailscale 있음)
  tailscale = true;
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'config'), other);
  out.length = 0;
  r = connect(opts, deps);
  assert.ok(r.ok, JSON.stringify(r.results));
  assert.ok(r.results.every((x) => x.state === 'done') && r.results.length === 4);
  const cfg = fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8');
  assert.ok(cfg.startsWith(other.trimEnd()) && cfg.includes('Host wy-host\n    HostName wy-host\n    User dev\n    IdentityFile ~/.ssh/id_ed25519\n'));
  assert.strictEqual(fs.readFileSync(path.join(home, '.ssh', 'config.wy-bak'), 'utf8'), other, '원래 config 백업');
  assert.ok(exts.has(REMOTE_SSH) && fs.existsSync(path.join(desktop, 'wy-host.lnk')));
  assert.ok(r.hostLine.endsWith("host --add-key 'ssh-ed25519 AAAAC3fake wy-ops-connect-wy-host'"));
  assert.ok(out.includes('호스트의 관리자 PowerShell에서 실행할 한 줄(공개키 등록):'));
  assert.ok(out.some((s) => s.includes('ssh -N -L 19222:localhost:9222 wy-host')), 'Chrome 포트 전달은 접속 PC 쪽 다른 포트(0.8.0 실측)');

  // 3-4. 두 번째 실행: 모두 이미 됨, 키를 덮어쓰지 않음
  calls.length = 0;
  r = connect({ ...opts, yes: true }, { ...deps, confirm: () => assert.fail('바꿀 것이 없으면 묻지 않음') });
  assert.ok(r.ok && !r.results.length);
  assert.ok(Object.values(state(r.plan)).every((s) => s === 'ok'));
  assert.strictEqual(fs.readFileSync(path.join(home, '.ssh', 'id_ed25519'), 'utf8'), 'PRIVATE');
  assert.ok(!calls.some((c) => /ssh-keygen|--install-extension|CreateShortcut/.test(c)));

  // 3-5. 호스트 주소가 바뀌면 그 블록만 갱신. 폴더가 없으면 바로가기 건너뜀
  r = connect({ alias: 'wy-host', host: '100.100.1.2', yes: true }, deps);
  assert.deepStrictEqual(state(r.plan), { tailscale: 'ok', key: 'ok', config: 'todo', 'remote-ssh': 'ok', shortcut: 'skip' });
  assert.ok(fs.readFileSync(path.join(home, '.ssh', 'config'), 'utf8').includes('    HostName 100.100.1.2\n    User dev\n'));

  // 3-6. 개인 키만 있고 .pub이 없으면 손으로
  fs.unlinkSync(path.join(home, '.ssh', 'id_ed25519.pub'));
  r = connect({ ...opts, dryRun: true }, deps);
  assert.strictEqual(state(r.plan).key, 'manual');
} finally {
  rmTree(root);
}

// 4. attach 바로가기 인수: 원격 명령 한 덩어리, 공백 폴더
assert.strictEqual(
  attachArgs('wy-host', 'C:/projects/my project/', 'AB-pm'),
  '-t wy-host "powershell -NoProfile -ExecutionPolicy Bypass -File \\"C:\\projects\\my project\\.claude\\skills\\pm-ops\\scripts\\session.ps1\\" attach AB-pm"',
);
assert.throws(() => plan({ alias: 'wy-host', host: 'h', attach: 'AB pm' }), /--attach/);

// 5. --attach·--passphrase(임시 홈, 가짜 명령)
const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-connect2-'));
try {
  const home = path.join(root2, 'home');
  const desktop = path.join(root2, 'desk');
  fs.mkdirSync(home);
  fs.mkdirSync(desktop);
  const sshExe = path.join(root2, 'ssh.exe');
  fs.writeFileSync(sshExe, '');
  let agentRunning = false;
  const added = new Set();
  const tty = [];
  const lnks = [];
  const run = (cmd, args) => {
    if (cmd === 'tailscale') return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'code') return { status: 0, stdout: REMOTE_SSH + '\n', stderr: '' };
    if (cmd === 'where') return { status: 0, stdout: path.join(root2, 'bin', 'code.cmd') + '\r\n', stderr: '' };
    if (cmd === 'powershell' && /Get-Service ssh-agent/.test(args[2])) return { status: 0, stdout: agentRunning ? 'Running\r\n' : 'Stopped\r\n', stderr: '' };
    if (cmd === 'powershell' && /CreateShortcut/.test(args[2])) {
      lnks.push(args[2]);
      fs.writeFileSync(args[2].match(/CreateShortcut\('([^']+)'\)/)[1], 'LNK');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'ssh-keygen' && args[0] === '-lf') return { status: 0, stdout: '256 SHA256:fakefp wy-ops-connect-wy-host (ED25519)\n', stderr: '' };
    if (cmd === 'ssh-add' && args[0] === '-l') return { status: added.size ? 0 : 1, stdout: [...added].join('\n'), stderr: '' };
    throw new Error('모르는 명령 ' + cmd + ' ' + args.join(' '));
  };
  const runTty = (cmd, args) => {
    tty.push([cmd, ...args].join(' '));
    if (cmd === 'ssh-keygen') {
      assert.ok(!args.includes('-N'), '암호를 쓰면 -N 없이 대화형');
      const f = args[args.indexOf('-f') + 1];
      fs.writeFileSync(f, 'PRIVATE');
      fs.writeFileSync(f + '.pub', 'ssh-ed25519 AAAAC3fake wy-ops-connect-wy-host\n');
    }
    if (cmd === 'ssh-add') added.add('256 SHA256:fakefp wy-ops-connect-wy-host (ED25519)');
    return { status: 0 };
  };
  const deps = { run, runTty, home, desktop, sshExe, tailscaleExe: path.join(root2, 'none.exe'), say: () => {}, confirm: () => true };
  const state = (p) => Object.fromEntries(p.steps.map((s) => [s.id, s.state]));

  // 5-1. 폴더 없으면 attach 바로가기 건너뜀
  let r = connect({ alias: 'wy-host', host: 'wy-host', attach: 'AB-pm', dryRun: true }, deps);
  assert.strictEqual(state(r.plan).attach, 'skip');

  // 5-2. ssh-agent가 멈춰 있으면 안내(손으로)·ssh-add 건너뜀, 키는 대화형으로 만듦
  const opts = { alias: 'wy-host', host: 'wy-host', folder: 'C:\\projects\\my-project', attach: 'AB-pm', passphrase: true, yes: true };
  r = connect(opts, deps);
  assert.deepStrictEqual(state(r.plan), { tailscale: 'ok', key: 'todo', agent: 'manual', 'ssh-add': 'skip', config: 'todo', 'remote-ssh': 'ok', shortcut: 'todo', attach: 'todo' });
  assert.ok(!r.ok, '손으로 할 단계가 남음');
  assert.ok(r.results.every((x) => x.state === 'done'), JSON.stringify(r.results));
  assert.strictEqual(tty.length, 1);
  assert.ok(fs.existsSync(path.join(desktop, 'wy-host AB-pm.lnk')));
  const attachLnk = lnks.find((x) => x.includes('AB-pm.lnk'));
  assert.ok(attachLnk.includes(`$s.TargetPath = '${sshExe}'`) && attachLnk.includes('attach AB-pm'));

  // 5-3. 서비스를 켠 뒤 다시: ssh-add 한 번만, 그다음은 모두 이미 됨
  agentRunning = true;
  r = connect(opts, deps);
  assert.ok(r.ok, JSON.stringify(r.results));
  assert.deepStrictEqual(r.results, [{ id: 'ssh-add', state: 'done' }]);
  r = connect(opts, deps);
  assert.ok(r.ok && !r.results.length && Object.values(state(r.plan)).every((s) => s === 'ok'));
  assert.deepStrictEqual(tty.map((x) => x.split(' ')[0]), ['ssh-keygen', 'ssh-add']);
} finally {
  rmTree(root2);
}
console.log('connect.test.js 통과');
