// install.ps1 필수 환경 확인: 가짜 명령(.cmd)만 있는 PATH에서 돌린다. 실제 winget·npm 설치는 하지 않는다
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PS1 = path.join(__dirname, '..', 'install.ps1');
const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function fakeBin(names) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'wyps1-'));
  const log = path.join(bin, 'calls.log');
  for (const n of names) {
    const body = n === 'node'
      ? `@echo off\r\nif "%1"=="-v" (echo v20.1.0& exit /b 0)\r\necho node %*>>"${log}"\r\n`
      : `@echo off\r\necho ${n} %*>>"${log}"\r\n`;
    fs.writeFileSync(path.join(bin, `${n}.cmd`), body);
  }
  return { bin, log };
}

function run(bin, args) {
  // Windows 환경 변수는 대소문자를 가리지 않으므로 Path 키를 모두 지우고 하나만 둔다
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args], {
    env: { ...env, Path: `${bin};${SYS}`, WY_OPS_KEEP_PATH: '1' },
    encoding: 'utf8',
  });
  return r;
}

const calls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/) : []);

// 1) 모두 없음 + --skip-install: 목록만 보이고 설치 명령은 부르지 않음, 종료 1
{
  const { bin, log } = fakeBin(['winget', 'npm']);
  const r = run(bin, ['--skip-install', 'doctor']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stdout.includes('OpenJS.NodeJS.LTS') && r.stdout.includes('@anthropic-ai/claude-code'), r.stdout);
  assert.deepStrictEqual(calls(log), []);
  fs.rmSync(bin, { recursive: true, force: true });
}

// 2) 모두 없음 + --yes: winget 4개(Node·Git·gh·VS Code)와 npm(Claude Code)을 부름. 가짜라 여전히 없으므로 종료 1, node는 안 돎
{
  const { bin, log } = fakeBin(['winget', 'npm']);
  const r = run(bin, ['--yes', 'doctor']);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  const c = calls(log);
  for (const id of ['OpenJS.NodeJS.LTS', 'Git.Git', 'GitHub.cli', 'Microsoft.VisualStudioCode']) {
    assert.ok(c.some((l) => l.startsWith('winget install -e --id ' + id + ' ')), `${id}: ${c.join(' | ')}`);
  }
  assert.ok(c.includes('npm install -g @anthropic-ai/claude-code'), c.join(' | '));
  assert.ok(!c.some((l) => l.startsWith('node ')), 'node가 돌면 안 됨');
  assert.ok(r.stdout.includes('아직 없는 것'), r.stdout);
  fs.rmSync(bin, { recursive: true, force: true });
}

// 3) 모두 있음: 설치 없이 node로 넘김, --skip-install은 빼고 넘김
{
  const { bin, log } = fakeBin(['winget', 'npm', 'node', 'git', 'gh', 'code', 'claude']);
  const r = run(bin, ['--skip-install', 'doctor', '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const c = calls(log);
  assert.ok(!c.some((l) => /^(winget|npm) /.test(l)), c.join(' | '));
  const n = c.find((l) => l.startsWith('node '));
  assert.ok(n && /install\.js doctor --json$/.test(n) && !n.includes('--skip-install'), n);
  fs.rmSync(bin, { recursive: true, force: true });
}

// 4) node 18 미만은 없는 것으로 봄
{
  const { bin, log } = fakeBin(['winget', 'npm', 'git', 'gh', 'code', 'claude']);
  fs.writeFileSync(path.join(bin, 'node.cmd'), `@echo off\r\nif "%1"=="-v" (echo v16.20.0& exit /b 0)\r\necho node %*>>"${log}"\r\n`);
  const r = run(bin, ['--skip-install', 'doctor']);
  assert.strictEqual(r.status, 1, r.stdout);
  assert.ok(r.stdout.includes('Node.js') && !r.stdout.includes('Git.Git'), r.stdout);
  fs.rmSync(bin, { recursive: true, force: true });
}

console.log('install.ps1 검사 통과');
