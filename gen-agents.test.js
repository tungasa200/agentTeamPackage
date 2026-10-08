// gen-agents.js 줄바꿈 처리 검사: node tools/wy-ops/gen-agents.test.js (통과하면 종료 코드 0)
// core.autocrlf=true 체크아웃처럼 지금 파일이 CRLF여도 --check는 같다고 보고, 쓸 때는 그 줄바꿈을 따른다.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const GEN = path.join(__dirname, 'gen-agents.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-agents-'));
const w = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const run = (...args) => spawnSync(process.execPath, [GEN, '--root', root, ...args], { encoding: 'utf8' });

try {
  w('.claude/wy-ops.json', JSON.stringify({ pmRole: 'XX-pm', roles: [{ name: 'XX-a' }, { name: 'XX-b' }, { name: 'XX-c' }, { name: 'XX-pm', agent: false }] }));
  w('.claude/ops/agent.md', '---\nname: {{name}}\ndescription: {{description}}\n{{frontmatter}}---\n\n{{body}}\n\n지시: {{pmRole}}\n');
  for (const n of ['XX-a', 'XX-b', 'XX-c']) w(`.claude/ops/roles/${n}.md`, `---\ndescription: ${n} 역할\n---\n- ${n} 본문\n`);

  // 기준 생성(LF) 후 a는 CRLF, b는 LF로 둔다. c는 지운다(새 파일 경우)
  assert.strictEqual(run().status, 0);
  const file = (n) => path.join(root, '.claude', 'agents', `${n}.md`);
  const lf = fs.readFileSync(file('XX-a'), 'utf8');
  assert.ok(!lf.includes('\r'), '새로 만든 파일은 LF');
  fs.writeFileSync(file('XX-a'), lf.replace(/\n/g, '\r\n'));
  fs.rmSync(file('XX-c'));

  // --check: CRLF 파일도 같음, 없는 파일은 다름
  let r = run('--check');
  assert.match(r.stdout, /같음 {2}XX-a/, 'CRLF 파일을 같다고 봐야 함:\n' + r.stdout);
  assert.match(r.stdout, /같음 {2}XX-b/);
  assert.match(r.stdout, /없음 {2}XX-c/);
  assert.strictEqual(r.status, 1);

  // 쓰기: a는 CRLF 유지, b는 LF 유지, c는 새 파일 LF
  assert.strictEqual(run().status, 0);
  assert.strictEqual(fs.readFileSync(file('XX-a'), 'utf8'), lf.replace(/\n/g, '\r\n'), '기존 CRLF 유지');
  assert.ok(!fs.readFileSync(file('XX-b'), 'utf8').includes('\r'), '기존 LF 유지');
  assert.ok(!fs.readFileSync(file('XX-c'), 'utf8').includes('\r'), '새 파일 LF');
  r = run('--check');
  assert.strictEqual(r.status, 0, '다시 쓴 뒤 모두 같음:\n' + r.stdout);

  // BOM이 붙은 CRLF 파일도 같음, 내용이 다르면 종료 코드 1
  fs.writeFileSync(file('XX-b'), '﻿' + fs.readFileSync(file('XX-b'), 'utf8').replace(/\n/g, '\r\n'));
  assert.strictEqual(run('--check').status, 0, 'BOM+CRLF도 같음');
  fs.writeFileSync(file('XX-b'), fs.readFileSync(file('XX-b'), 'utf8').replace('XX-b 본문', '다른 본문'));
  r = run('--check');
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /다름 {2}XX-b/);
  console.log('gen-agents 줄바꿈 검사 통과');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// 자리표시자 필터: |indent는 줄마다 두 칸 들여 써서 하위 목록으로 만든다(빈 줄은 그대로), |size는 MB → GB/MB
{
  const { fill } = require('./gen-agents');
  assert.strictEqual(fill('- 검증:\n{{v|indent}}\n- 다음', { v: '- a\n\n- b' }, 't'), '- 검증:\n  - a\n\n  - b\n- 다음');
  assert.strictEqual(fill('{{m|size}}·{{n|size}}', { m: 1024, n: 500 }, 't'), '1GB·500MB');
  console.log('gen-agents 필터 검사 통과');
}
