// install.js 검사: R4 전환 조건(결정을 기다리는 카드 세기)
//   node tools/wy-ops/test/install.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmTree } = require('../lib/fsx');
const { protectedPending, claudeTrusted } = require('../lib/install');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-inst-'));
const card = (id, o) => {
  fs.mkdirSync(path.join(root, 'requests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'requests', `${id}.json`), JSON.stringify({ session: 'WY-pm', createdAt: new Date().toISOString(), title: id, what: 'w', why: 'y', onClick: 'o', ...o }));
};
try {
  assert.deepStrictEqual(protectedPending(root), [], '빈 대기열');
  // 할 일 카드만 남았으면 통과(R4를 안내하는 할 일 카드 자체가 걸리던 결함)
  card('r4-guide', { kind: 'todo', steps: ['setup 실행'] });
  card('broken-1', { kind: 'commit' }); // command가 없어도 형식은 맞음 — 아래에서 따로 본다
  fs.writeFileSync(path.join(root, 'requests', 'bad.json'), '{ 깨진 파일');
  assert.deepStrictEqual(protectedPending(root), ['broken-1'], '할 일·형식 오류는 세지 않음');
  fs.unlinkSync(path.join(root, 'requests', 'broken-1.json'));
  assert.deepStrictEqual(protectedPending(root), [], 'todo만 남으면 통과');
  // commit 대기 1장이면 멈춤(setup이 이 목록이 비어 있지 않으면 멈춘다)
  card('c1', { kind: 'commit', command: 'git commit -F x' });
  assert.deepStrictEqual(protectedPending(root), ['c1'], 'commit 대기 1장');
  // 결정된 카드·기한 지난 권한 카드는 세지 않음, 대기 중인 결정·권한 카드는 셈
  fs.mkdirSync(path.join(root, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(root, 'decisions', 'c1.json'), JSON.stringify({ id: 'c1', decision: 'approved' }));
  card('p-old', { kind: 'permission', command: 'ls', expiresAt: new Date(Date.now() - 1000).toISOString() });
  card('ch1', { kind: 'choice', questions: [{ question: 'q', options: [{ label: 'a', cost: '0' }, { label: 'b', cost: '0' }] }] });
  card('p-new', { kind: 'permission', command: 'ls', expiresAt: new Date(Date.now() + 60000).toISOString() });
  assert.deepStrictEqual(protectedPending(root).sort(), ['ch1', 'p-new'], '결정됨·기한 지남은 제외');
  // Claude Code 폴더 신뢰 읽기(~/.claude.json, 읽기만): 정확히 같은 폴더·하위 폴더는 신뢰, 대소문자·구분자 무시, 없는 파일은 모름(null)
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  assert.strictEqual(claudeTrusted('C:/x', home), null, '설정 파일이 없으면 모름');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { 'C:/projects/my-project': { hasTrustDialogAccepted: true }, 'c:/projects/new': { hasTrustDialogAccepted: false } } }));
  assert.strictEqual(claudeTrusted('C:\\projects\\my-project', home), true);
  assert.strictEqual(claudeTrusted('c:/Projects/MY-project/tools/x', home), true, '하위 폴더');
  assert.strictEqual(claudeTrusted('C:/projects/new', home), false, '신뢰 안 함');
  assert.strictEqual(claudeTrusted('C:/projects/my-project-2', home), false, '이름이 비슷한 다른 폴더');
  // rollback CLI(S1): --list, 되돌린 버전의 껍데기 해시가 설치된 확장과 다르면 다시 깖(가짜 code.cmd·임시 홈·설치 폴더)
  if (process.platform === 'win32') {
    const { point } = require('../lib/deploy');
    const tools = path.join(root, 'tools');
    const dir = path.join(tools, 'wy-ops');
    const ver = (name, hash, at) => {
      const v = path.join(dir, name);
      fs.mkdirSync(path.join(v, 'stub-ext'), { recursive: true });
      fs.writeFileSync(path.join(v, 'deployed.json'), JSON.stringify({ version: name.split('-')[0], commit: name.split('-')[1], stubHash: hash, deployedAt: at }));
      fs.writeFileSync(path.join(v, 'stub-ext', 'package.json'), JSON.stringify({ name: 'wy-ops', publisher: 'wy-ops', version: '0.0.1', engines: { vscode: '^1.85.0' }, wyOpsStubHash: hash }));
    };
    ver('0.1.0-aaa', 'hashA', '2026-01-01T00:00:00.000Z');
    ver('0.2.0-bbb', 'hashB', '2026-01-02T00:00:00.000Z');
    point(dir, '0.2.0-bbb');
    const extDir = path.join(root, 'ext');
    fs.mkdirSync(path.join(extDir, 'wy-ops.wy-ops-0.0.1'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'wy-ops.wy-ops-0.0.1', 'package.json'), JSON.stringify({ wyOpsStubHash: 'hashB' }));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const called = path.join(bin, 'called.txt');
    fs.writeFileSync(path.join(bin, 'code.cmd'), `@echo off\r\necho %*>>"${called}"\r\nexit /b 0\r\n`);
    const home2 = path.join(root, 'home2');
    fs.mkdirSync(home2);
    const env = { ...process.env, WY_TOOLS_DIR: tools, USERPROFILE: home2, PATH: `${bin};${process.env.PATH}` };
    const cli = (...a) => require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'install.js'), ...a], { env, encoding: 'utf8' });
    let o = cli('rollback', '--list');
    assert.strictEqual(o.status, 0, o.stderr);
    assert.deepStrictEqual(o.stdout.trim().split(/\r?\n/).map((l) => l.slice(0, 12)), ['* 0.2.0-bbb ', '  0.1.0-aaa '], `새것부터, current 표시: ${o.stdout}`);
    assert.ok(!fs.existsSync(called), '--list는 아무것도 바꾸지 않음');
    o = cli('rollback', '--extensions-dir', extDir);
    assert.strictEqual(o.status, 0, o.stdout + o.stderr);
    assert.ok(o.stdout.includes('0.2.0-bbb → 0.1.0-aaa'), o.stdout);
    assert.ok(fs.existsSync(called) && fs.readFileSync(called, 'utf8').includes('--install-extension'), '해시가 다르면 다시 깖');
    assert.ok(o.stdout.includes('최신 ↔ 직전') && o.stdout.includes('install.ps1 gen') && o.stdout.includes('Reload Window'), `안내 두 줄과 Reload: ${o.stdout}`);
    fs.unlinkSync(called);
    o = cli('rollback', '--extensions-dir', extDir);
    assert.ok(o.stdout.includes('0.1.0-aaa → 0.2.0-bbb') && o.stdout.includes('최신입니다'), `두 번째는 최신으로, 해시가 같으면 건너뜀: ${o.stdout}`);
    assert.ok(!fs.existsSync(called), '해시가 같으면 code를 부르지 않음');
  }
  console.log('wy-ops install 검사 통과');
} finally {
  rmTree(root);
}
