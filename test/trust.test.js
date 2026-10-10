// 폴더 사용 허락 기록(lib/trust.js, D-171 ②): 임시 홈의 .claude.json만 쓴다
//   node test/trust.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rmTree } = require('../lib/fsx');
const { trustFolder, claudeTrusted, keyFor } = require('../lib/trust');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-trust-'));
const file = path.join(tmp, '.claude.json');
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
try {
  // 설정 파일이 없으면 쓰지 않고 실패(마법사가 Claude 창으로 대체)
  assert.strictEqual(trustFolder('C:/projects/app', tmp).ok, false, '파일 없음');
  assert.ok(!fs.existsSync(file), '없는 파일을 만들지 않음');

  // 다른 값은 그대로, 새 항목 추가, 백업
  fs.writeFileSync(file, JSON.stringify({ numStartups: 3, projects: { 'C:/other': { allowedTools: ['x'], hasTrustDialogAccepted: false } } }, null, 2));
  const r = trustFolder('c:\\projects\\app\\', tmp);
  assert.ok(r.ok && !r.already, JSON.stringify(r));
  assert.strictEqual(r.key, 'C:/projects/app', 'Claude 키 모양(슬래시·대문자 드라이브)');
  const j = read();
  assert.strictEqual(j.numStartups, 3);
  assert.deepStrictEqual(j.projects['C:/other'], { allowedTools: ['x'], hasTrustDialogAccepted: false });
  assert.strictEqual(j.projects['C:/projects/app'].hasTrustDialogAccepted, true);
  assert.ok(fs.existsSync(r.backup) && !JSON.parse(fs.readFileSync(r.backup, 'utf8')).projects['C:/projects/app'], '쓰기 전 백업');
  assert.strictEqual(claudeTrusted('C:/projects/app/sub', tmp), true, '하위 폴더');

  // 이미 허락됨 → 쓰지 않음
  const before = fs.statSync(file).mtimeMs;
  assert.deepStrictEqual(trustFolder('C:/projects/app', tmp), { ok: true, already: true });
  assert.strictEqual(fs.statSync(file).mtimeMs, before);

  // 있는 항목(대소문자 다른 키)은 그 키에 더함
  fs.writeFileSync(file, JSON.stringify({ projects: { 'c:/Work/App': { allowedTools: [] } } }));
  const r2 = trustFolder('C:\\work\\app', tmp);
  assert.ok(r2.ok && r2.key === 'c:/Work/App', JSON.stringify(r2));
  assert.deepStrictEqual(read().projects, { 'c:/Work/App': { allowedTools: [], hasTrustDialogAccepted: true } });

  // 형식이 다르면 쓰지 않음
  fs.writeFileSync(file, JSON.stringify({ projects: [] }));
  assert.strictEqual(trustFolder('C:/x', tmp).ok, false, 'projects가 배열');
  fs.writeFileSync(file, '{ broken');
  assert.strictEqual(trustFolder('C:/x', tmp).ok, false, '깨진 JSON');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ broken', '깨진 파일은 그대로');
  assert.strictEqual(keyFor('d:\\a\\b\\'), 'D:/a/b');

  // install.js trust: JSON 한 줄, 종료 코드(홈은 USERPROFILE로 임시 폴더)
  fs.writeFileSync(file, JSON.stringify({ projects: {} }));
  const env = { ...process.env, USERPROFILE: tmp, HOME: tmp };
  const cli = (args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'install.js'), 'trust', ...args], { encoding: 'utf8', env });
  const proj = path.join(tmp, 'proj');
  let c = cli(['--project', proj, '--check']);
  assert.strictEqual(c.status, 1, c.stdout + c.stderr);
  assert.strictEqual(JSON.parse(c.stdout).ok, false);
  c = cli(['--project', proj]);
  assert.strictEqual(c.status, 0, c.stdout + c.stderr);
  assert.strictEqual(JSON.parse(c.stdout).ok, true);
  c = cli(['--project', proj, '--check']);
  assert.strictEqual(c.status, 0, c.stdout + c.stderr);
} finally {
  rmTree(tmp);
}
console.log('trust 검사 통과');
