// 접속 PC 준비(원격 호스트 P4): install.ps1 connect <별칭> --host <Tailscale 이름|IP> [--user <계정>] [--folder <호스트 폴더>]
// 이 PC(접속 PC, Windows)에서 호스트에 Remote-SSH로 붙을 준비를 한다. 이미 된 단계는 건너뛴다(여러 번 실행해도 같은 결과).
//   ① Tailscale 설치 확인(없으면 안내만) ② ~/.ssh/id_ed25519 없으면 ssh-keygen(덮어쓰지 않음)
//   ③ ~/.ssh/config의 Host <별칭> 블록 추가·갱신(HostName·User·IdentityFile, 다른 블록·다른 줄 보존)
//   ④ VS Code Remote-SSH 확장 설치 ⑤ 바탕화면 바로가기(Remote-SSH로 호스트 폴더 열기)
//   ⑥ 끝에 '호스트에서 실행할 한 줄'(공개키 등록, lib/host.js의 host --add-key)
// 파일 시스템·명령 실행은 주입식(deps)이라 시험에서 실제 ~/.ssh를 건드리지 않는다.
//   plan(opts, deps)          → { steps: [{ id, label, state: 'ok'|'todo'|'manual'|'skip', detail? }], ... }  읽기만
//   apply(p, deps)            → [{ id, state: 'done'|'failed', error? }]  todo 단계만 실행
//   connect(opts, deps)       → { ok, plan, results, hostLine }  계획 출력 → (--dry-run이면 멈춤) → 확인(--yes) → 적용 → 한 줄 출력
//   opts: { alias, host, user?, folder?, attach?, passphrase?, dryRun?, yes? }
//   deps: { fs?, run?, runTty?, home?, desktop?, tailscaleExe?, sshExe?, controlSrc?, confirm?, say? }
// 선택:
//   attach: <역할>  바탕화면 '<별칭> <역할>' 바로가기 = ssh -t <별칭> → 호스트 session.ps1 attach <역할>(호스트 폴더 필요)
//   passphrase      키에 암호를 건다: ssh-keygen이 이 터미널에서 암호를 묻고, ssh-agent 서비스(시작은 관리자 손)에 ssh-add로 한 번 올린다
// 제어 창(0.8.2): --folder와 --attach(pm 역할)가 있으면 templates/connect/host-control.ps1을 ~/.wy-tools/connect/에 복사하고
//   바탕화면 '<별칭> 제어' 바로가기(powershell -WindowStyle Hidden)를 만든다. 깨우기·재우기·재부팅·종료·pm 새로 띄우기·pm에 붙기
const fsReal = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REMOTE_SSH = 'ms-vscode-remote.remote-ssh';
const KEY_NAME = 'id_ed25519';
const HOST_INSTALL = '& "$env:USERPROFILE\\.wy-tools\\wy-ops\\current\\install.ps1"';
const TAILSCALE_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const SSH_EXE = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SESSION_PS1 = '.claude\\skills\\pm-ops\\scripts\\session.ps1';
const CONTROL_SRC = path.join(__dirname, '..', 'templates', 'connect', 'host-control.ps1');
const AGENT_START = 'Get-Service ssh-agent | Set-Service -StartupType Automatic; Start-Service ssh-agent';

// code는 Windows에서 .cmd 래퍼라 cmd.exe로 부른다(install.js run과 같은 방식)
function runReal(cmd, args = []) {
  const opts = { encoding: 'utf8', windowsHide: true, timeout: 180000 };
  let r;
  if (process.platform === 'win32' && cmd === 'code') {
    const q = (a) => (/[\s"&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    r = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map(q).join(' ')}"`], { ...opts, windowsVerbatimArguments: true });
  } else {
    r = spawnSync(cmd, args, opts);
  }
  return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function validate({ alias, host, user, folder, attach }) {
  if (attach != null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(attach)) throw new Error('--attach에는 역할 이름을 씁니다(예: AB-pm)');
  if (!alias || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) throw new Error('별칭은 영문·숫자·. _ - 만 씁니다(예: wy-host)');
  if (!host || !/^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(host)) throw new Error('--host <Tailscale 이름|IP>가 필요합니다');
  if (user != null && !/^[^\s"'#]+$/.test(user)) throw new Error('--user에는 공백·따옴표·#을 쓸 수 없습니다');
  if (folder != null && !/^[A-Za-z]:[\\/]/.test(folder)) throw new Error('--folder는 호스트의 절대 경로입니다(예: C:\\projects\\my-project)');
}

// C:\projects\my project → vscode-remote://ssh-remote+<별칭>/c:/projects/my%20project
function folderUri(alias, folder) {
  const p = folder.replace(/\\/g, '/').replace(/\/+$/, '');
  const [drive, ...rest] = p.split('/');
  return `vscode-remote://ssh-remote+${alias}/${drive.toLowerCase()}/${rest.map(encodeURIComponent).join('/')}`;
}

// ~/.ssh/config: Host/Match 줄로 블록을 나눈다. 별칭 하나만 적힌 Host 블록이 대상
function parseConfig(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [{ head: null, lines: [] }];
  for (const line of lines) {
    if (/^\s*(Host|Match)\s/i.test(line)) blocks.push({ head: line, lines: [] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks;
}

const isHostBlock = (b, alias) => b.head && /^\s*Host\s/i.test(b.head) && b.head.trim().split(/\s+/).slice(1).join(' ') === alias;

function wantedFields({ host, user }) {
  const f = [['HostName', host]];
  if (user) f.push(['User', user]);
  f.push(['IdentityFile', `~/.ssh/${KEY_NAME}`]);
  return f;
}

// 새 config 텍스트(바뀔 것이 없으면 원문 그대로)
function updateConfig(text, { alias, host, user }) {
  const nl = /\r\n/.test(text) ? '\r\n' : text ? '\n' : '\r\n';
  const fields = wantedFields({ host, user });
  const blocks = parseConfig(text);
  const b = blocks.find((x) => isHostBlock(x, alias));
  if (!b) {
    const body = [`Host ${alias}`, ...fields.map(([k, v]) => `    ${k} ${v}`)].join(nl);
    const trimmed = text.replace(/(\r?\n)*$/, '');
    return (trimmed ? trimmed + nl + nl : '') + body + nl;
  }
  const indent = (b.lines.find((l) => /^\s+\S/.test(l)) || '    ').match(/^\s*/)[0] || '    ';
  for (const [k, v] of fields) {
    const i = b.lines.findIndex((l) => new RegExp(`^\\s*${k}(\\s|=)`, 'i').test(l));
    if (i >= 0) {
      const cur = b.lines[i].trim().replace(new RegExp(`^${k}\\s*=?\\s*`, 'i'), '');
      if (cur !== v) b.lines[i] = `${indent}${k} ${v}`;
    } else {
      // 블록 끝의 빈 줄 앞에 넣는다
      let at = b.lines.length;
      while (at > 0 && !b.lines[at - 1].trim()) at--;
      b.lines.splice(at, 0, `${indent}${k} ${v}`);
    }
  }
  // 첫 블록(Host 앞 머리말)이 비어 있으면 빼야 앞에 빈 줄이 생기지 않는다
  return blocks.flatMap((x) => (x.head === null ? x.lines : [x.head, ...x.lines])).join(nl);
}

function hostLine(pub) {
  return `${HOST_INSTALL} host --add-key '${pub.trim().replace(/'/g, "''")}'`;
}

function makeDeps(deps = {}) {
  const run = deps.run || runReal;
  return {
    fs: deps.fs || fsReal,
    run,
    home: deps.home || os.homedir(),
    // 바탕화면은 OneDrive로 옮겨졌을 수 있어 Windows에 묻는다
    desktop:
      deps.desktop ||
      (() => {
        const r = run('powershell', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"]);
        return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : path.join(deps.home || os.homedir(), 'Desktop');
      }),
    // 암호 입력처럼 사람이 답해야 하는 명령은 이 터미널에 그대로 붙여 실행한다
    runTty: deps.runTty || ((cmd, args) => ({ status: spawnSync(cmd, args, { stdio: 'inherit' }).status })),
    tailscaleExe: deps.tailscaleExe || TAILSCALE_EXE,
    controlSrc: deps.controlSrc || CONTROL_SRC,
    sshExe: deps.sshExe || SSH_EXE,
    confirm: deps.confirm || (() => false),
    say: deps.say || ((s = '') => process.stdout.write(s + '\n')),
  };
}

function plan(opts, deps = {}) {
  validate(opts);
  const d = makeDeps(deps);
  const { alias, host, user, folder, attach, passphrase } = opts;
  const sshDir = path.join(d.home, '.ssh');
  const keyFile = path.join(sshDir, KEY_NAME);
  const configFile = path.join(sshDir, 'config');
  const steps = [];

  // ① Tailscale: 설치는 안내만(관리자 설치·계정 로그인은 사람 손)
  const ts = d.run('tailscale', ['version']);
  const tsOk = ts.status === 0 || d.fs.existsSync(d.tailscaleExe);
  steps.push(
    tsOk
      ? { id: 'tailscale', label: 'Tailscale 설치', state: 'ok' }
      : { id: 'tailscale', label: 'Tailscale 설치', state: 'manual', detail: 'winget install Tailscale.Tailscale (또는 tailscale.com/download) → 호스트와 같은 계정으로 로그인 → 다시 실행' },
  );

  // ② 키
  const hasKey = d.fs.existsSync(keyFile);
  const hasPub = d.fs.existsSync(keyFile + '.pub');
  if (hasKey && !hasPub) steps.push({ id: 'key', label: `SSH 키 ~/.ssh/${KEY_NAME}`, state: 'manual', detail: `개인 키만 있고 .pub이 없습니다: ssh-keygen -y -f ~/.ssh/${KEY_NAME} > ~/.ssh/${KEY_NAME}.pub` });
  else steps.push({ id: 'key', label: `SSH 키 ~/.ssh/${KEY_NAME}`, state: hasKey ? 'ok' : 'todo', detail: hasKey ? undefined : `ssh-keygen -t ed25519(${passphrase ? '암호는 이 터미널에서 입력' : '암호 없음'})`, keyFile, sshDir });

  // ②-1 암호를 쓰면 ssh-agent에 한 번 올려 둔다(바로가기가 매번 암호를 묻지 않게). 서비스 시작은 관리자 권한이라 안내만
  if (passphrase) {
    const svc = d.run('powershell', ['-NoProfile', '-Command', '(Get-Service ssh-agent -ErrorAction SilentlyContinue).Status']);
    const running = svc.status === 0 && /^Running/i.test(svc.stdout.trim());
    steps.push(running ? { id: 'agent', label: 'ssh-agent 서비스', state: 'ok' } : { id: 'agent', label: 'ssh-agent 서비스', state: 'manual', detail: `관리자 PowerShell에서: ${AGENT_START} → 다시 실행` });
    let loaded = false;
    if (running && hasPub) {
      const fp = d.run('ssh-keygen', ['-lf', keyFile + '.pub']).stdout.split(/\s+/)[1];
      loaded = !!fp && d.run('ssh-add', ['-l']).stdout.includes(fp);
    }
    if (!running) steps.push({ id: 'ssh-add', label: 'ssh-agent에 키 올리기', state: 'skip', detail: 'ssh-agent 서비스 시작 뒤' });
    else steps.push({ id: 'ssh-add', label: 'ssh-agent에 키 올리기', state: loaded ? 'ok' : 'todo', detail: loaded ? undefined : 'ssh-add(암호를 한 번 입력)', keyFile });
  }

  // ③ ssh config
  const cur = d.fs.existsSync(configFile) ? d.fs.readFileSync(configFile, 'utf8') : '';
  const next = updateConfig(cur, { alias, host, user });
  steps.push({ id: 'config', label: `~/.ssh/config Host ${alias}`, state: next === cur ? 'ok' : 'todo', detail: next === cur ? undefined : cur && parseConfig(cur).some((b) => isHostBlock(b, alias)) ? '블록 갱신' : '블록 추가', configFile, sshDir, text: next });

  // ④ Remote-SSH 확장
  const ext = d.run('code', ['--list-extensions']);
  if (ext.status !== 0) steps.push({ id: 'remote-ssh', label: 'VS Code Remote-SSH 확장', state: 'manual', detail: 'code 명령이 없습니다. VS Code를 설치하고(PATH 추가) 다시 실행' });
  else {
    const has = ext.stdout.split(/\r?\n/).some((l) => l.trim().toLowerCase() === REMOTE_SSH);
    steps.push({ id: 'remote-ssh', label: 'VS Code Remote-SSH 확장', state: has ? 'ok' : 'todo', detail: has ? undefined : `code --install-extension ${REMOTE_SSH}` });
  }

  // ⑤ 바로가기
  if (!folder) steps.push({ id: 'shortcut', label: '바탕화면 바로가기', state: 'skip', detail: '호스트 폴더를 모름: --folder <호스트 폴더>로 다시 실행' });
  else {
    const lnk = path.join(typeof d.desktop === 'function' ? d.desktop() : d.desktop, `${alias}.lnk`);
    const uri = folderUri(alias, folder);
    steps.push({ id: 'shortcut', label: `바탕화면 바로가기 ${alias}.lnk`, state: d.fs.existsSync(lnk) ? 'ok' : 'todo', detail: `code --folder-uri ${uri}`, lnk, uri });
  }

  // ⑥ attach 바로가기: ssh -t <별칭> → 호스트 PowerShell에서 session.ps1 attach <역할>
  if (attach) {
    const label = `바탕화면 바로가기 ${alias} ${attach}.lnk`;
    if (!folder) steps.push({ id: 'attach', label, state: 'skip', detail: '호스트 폴더를 모름: --folder <호스트 폴더>로 다시 실행' });
    else {
      const lnk = path.join(typeof d.desktop === 'function' ? d.desktop() : d.desktop, `${alias} ${attach}.lnk`);
      const args = attachArgs(alias, folder, attach);
      steps.push({ id: 'attach', label, state: d.fs.existsSync(lnk) ? 'ok' : 'todo', detail: `ssh ${args}`, lnk, args });
    }
  }

  // ⑦ 제어 창: 스크립트 사본이 템플릿과 다르면(패키지 갱신) 다시 복사
  const ctlLabel = `바탕화면 바로가기 ${alias} 제어.lnk`;
  if (!folder || !attach) steps.push({ id: 'control', label: ctlLabel, state: 'skip', detail: '--folder <호스트 폴더>와 --attach <pm 역할>이 있어야 만듭니다' });
  else {
    const lnk = path.join(typeof d.desktop === 'function' ? d.desktop() : d.desktop, `${alias} 제어.lnk`);
    const script = path.join(d.home, '.wy-tools', 'connect', 'host-control.ps1');
    const src = d.fs.readFileSync(d.controlSrc, 'utf8');
    const same = d.fs.existsSync(script) && d.fs.readFileSync(script, 'utf8') === src;
    steps.push({ id: 'control', label: ctlLabel, state: same && d.fs.existsSync(lnk) ? 'ok' : 'todo', detail: same ? undefined : '제어 창 스크립트 복사', lnk, script, src, args: controlArgs(script, alias, folder, attach) });
  }

  return { alias, host, user, folder, passphrase: !!passphrase, keyFile, steps };
}

// 바로가기 대상: code.cmd 대신 옆의 Code.exe(콘솔 창이 뜨지 않게). 못 찾으면 code.cmd
function codeExe(d) {
  const r = d.run('where', ['code']);
  const cmd = r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => /\.cmd$/i.test(s)) : null;
  if (!cmd) return null;
  const exe = path.join(path.dirname(path.dirname(cmd)), 'Code.exe');
  return d.fs.existsSync(exe) ? exe : cmd;
}

const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ssh.exe 인수: 원격 명령은 한 인수로 묶는다(ssh가 호스트 셸 PowerShell에 그대로 넘김). 폴더에 공백이 있어도 되게 안쪽 따옴표는 \"
function attachArgs(alias, folder, role) {
  const script = `${folder.replace(/[\\/]+$/, '').replace(/\//g, '\\')}\\${SESSION_PS1}`;
  const remote = `powershell -NoProfile -ExecutionPolicy Bypass -File "${script}" attach ${role}`;
  return `-t ${alias} "${remote.replace(/"/g, '\\"')}"`;
}

// 제어 창 바로가기 인수: 콘솔 창이 남지 않게 -WindowStyle Hidden
function controlArgs(script, alias, folder, role) {
  return `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" -Alias ${alias} -Folder "${folder.replace(/[\\/]+$/, '')}" -Role ${role}`;
}

function makeLnk(d, { lnk, target, args, desc }) {
  const script = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + ps(lnk) + ')',
    '$s.TargetPath = ' + ps(target),
    '$s.Arguments = ' + ps(args),
    '$s.IconLocation = ' + ps(target + ',0'),
    '$s.Description = ' + ps(desc),
    '$s.Save()',
  ].join('; ');
  const r = d.run('powershell', ['-NoProfile', '-Command', script]);
  if (r.status !== 0) throw new Error(`바로가기 만들기 실패: ${(r.stderr || r.stdout).trim() || r.status}`);
}

function apply(p, deps = {}) {
  const d = makeDeps(deps);
  const results = [];
  for (const s of p.steps) {
    if (s.state !== 'todo') continue;
    try {
      if (s.id === 'key') {
        d.fs.mkdirSync(s.sshDir, { recursive: true });
        if (d.fs.existsSync(s.keyFile)) throw new Error('그 사이 키가 생겼습니다(덮어쓰지 않음)');
        const base = ['-t', 'ed25519', '-f', s.keyFile, '-C', `wy-ops-connect-${p.alias}`];
        const r = p.passphrase ? d.runTty('ssh-keygen', base) : d.run('ssh-keygen', [...base, '-N', '', '-q']);
        if (r.status !== 0) throw new Error(`ssh-keygen 실패: ${(r.stderr || r.stdout).trim() || r.status}`);
      } else if (s.id === 'config') {
        d.fs.mkdirSync(s.sshDir, { recursive: true });
        if (d.fs.existsSync(s.configFile)) d.fs.copyFileSync(s.configFile, s.configFile + '.wy-bak');
        d.fs.writeFileSync(s.configFile, s.text);
      } else if (s.id === 'remote-ssh') {
        const r = d.run('code', ['--install-extension', REMOTE_SSH]);
        if (r.status !== 0) throw new Error(`확장 설치 실패: ${(r.stderr || r.stdout).trim() || r.status}`);
      } else if (s.id === 'shortcut') {
        const target = codeExe(d);
        if (!target) throw new Error('code 실행 파일을 찾지 못했습니다');
        makeLnk(d, { lnk: s.lnk, target, args: `--folder-uri "${s.uri}"`, desc: `Remote-SSH ${p.alias}` });
      } else if (s.id === 'ssh-add') {
        if (!d.fs.existsSync(s.keyFile)) throw new Error('키가 없습니다');
        const r = d.runTty('ssh-add', [s.keyFile]);
        if (r.status !== 0) throw new Error(`ssh-add 실패: ${r.status}`);
      } else if (s.id === 'attach') {
        if (!d.fs.existsSync(d.sshExe)) throw new Error(`ssh.exe가 없습니다(${d.sshExe}). Windows 설정 > 선택적 기능 > OpenSSH 클라이언트`);
        makeLnk(d, { lnk: s.lnk, target: d.sshExe, args: s.args, desc: `ssh ${p.alias} attach` });
      } else if (s.id === 'control') {
        d.fs.mkdirSync(path.dirname(s.script), { recursive: true });
        d.fs.writeFileSync(s.script, s.src);
        makeLnk(d, { lnk: s.lnk, target: POWERSHELL_EXE, args: s.args, desc: `${p.alias} 제어(깨우기·재우기·pm)` });
      }
      results.push({ id: s.id, state: 'done' });
    } catch (e) {
      results.push({ id: s.id, state: 'failed', error: e.message });
    }
  }
  return results;
}

const MARK = { ok: '이미 됨', todo: '바꿈', manual: '손으로', skip: '건너뜀' };

function connect(opts, deps = {}) {
  const d = makeDeps(deps);
  const p = plan(opts, { ...deps, ...d });
  d.say(`접속 PC 준비: ${opts.alias} → ${opts.host}`);
  for (const s of p.steps) d.say(`  [${MARK[s.state]}] ${s.label}${s.detail ? ` — ${s.detail}` : ''}`);
  const todo = p.steps.filter((s) => s.state === 'todo');
  let results = [];
  if (opts.dryRun) d.say('(--dry-run: 바꾸지 않았습니다)');
  else if (todo.length) {
    if (!opts.yes && !d.confirm('위처럼 바꿀까요?')) {
      d.say('바꾸지 않았습니다');
      return { ok: false, plan: p, results, hostLine: null };
    }
    results = apply(p, { ...deps, ...d });
    for (const r of results) d.say(`  ${r.state === 'done' ? '완료' : '실패'}: ${r.id}${r.error ? ` — ${r.error}` : ''}`);
  }
  const pubFile = p.keyFile + '.pub';
  const pub = d.fs.existsSync(pubFile) ? d.fs.readFileSync(pubFile, 'utf8').trim() : null;
  const line = pub ? hostLine(pub) : null;
  d.say('');
  if (line) {
    d.say('호스트의 관리자 PowerShell에서 실행할 한 줄(공개키 등록):');
    d.say(`  ${line}`);
  } else d.say('공개키가 아직 없어 호스트에서 실행할 한 줄을 만들지 못했습니다(--dry-run이면 실제로 실행한 뒤 나옵니다)');
  d.say(`등록 뒤 확인: ssh ${opts.alias} (비밀번호를 묻지 않으면 성공)`);
  d.say(`호스트 전용 Chrome 보기(필요할 때): ssh -N -L 19222:localhost:9222 ${opts.alias} → chrome://inspect에 localhost:19222 (이쪽 포트는 9222와 다르게)`);
  const failed = results.some((r) => r.state === 'failed');
  const manual = p.steps.some((s) => s.state === 'manual');
  return { ok: !failed && !manual, plan: p, results, hostLine: line };
}

module.exports = { plan, apply, connect, updateConfig, folderUri, hostLine, attachArgs, controlArgs, REMOTE_SSH };
