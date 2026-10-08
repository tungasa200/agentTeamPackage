// 한글·공백 경로 검사(R5 리허설에서 찾은 결함): lib/fsx 지우기·복사, 정션은 따라가지 않음, legacy 정리, doctor 실행기의 인자 전달.
// node 24.12의 fs.rmSync·cpSync는 한글 경로에서 프로세스가 죽으므로 이 테스트는 그 함수를 쓰지 않는다.
//   node tools/wy-ops/test/fsx.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rmTree, copyTree } = require('../lib/fsx');
const legacy = require('../lib/legacy');
const { defaultRun } = require('../lib/doctor');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-fsx-'));
const ko = path.join(base, '사용자 홈 한글');
const write = (p, text = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

try {
  // 1. 한글·공백 폴더 통째로 복사·지우기
  write(path.join(ko, '가', '나', '파일 1.txt'), '하나');
  write(path.join(ko, 'b.json'), '{}');
  const copy = path.join(base, '복사본 2');
  copyTree(ko, copy);
  assert.strictEqual(fs.readFileSync(path.join(copy, '가', '나', '파일 1.txt'), 'utf8'), '하나', '복사');
  rmTree(copy);
  assert.ok(!fs.existsSync(copy), '지움');
  rmTree(path.join(base, '없는 폴더 없음'));
  assert.ok(true, '없는 경로는 조용히 넘어감');

  // 2. 정션은 링크만 지우고 대상은 그대로
  const target = path.join(base, '대상 폴더');
  write(path.join(target, '남아야 함.txt'));
  const link = path.join(ko, 'current');
  fs.symlinkSync(target, link, 'junction');
  rmTree(ko);
  assert.ok(!fs.existsSync(ko), '정션이 든 폴더 지움');
  assert.ok(fs.existsSync(path.join(target, '남아야 함.txt')), '정션 대상은 그대로');

  // 3. 읽기 전용 파일도 지운다(git 객체 등)
  const ro = path.join(base, '읽기 전용', 'f.txt');
  write(ro);
  fs.chmodSync(ro, 0o444);
  rmTree(path.dirname(ro));
  assert.ok(!fs.existsSync(ro), '읽기 전용 파일');

  // 4. 한글 홈에서 cleanup-legacy가 죽지 않고 지운다
  const home = path.join(base, '홍 길동');
  write(path.join(home, '.claude', 'wy-approvals', 'requests', 'old.json'));
  write(path.join(home, '.claude', 'wy-approvals', 'erp-project', 'decisions', 'd.json'));
  const items = legacy.list(home, { env: {} });
  assert.deepStrictEqual(items.map((i) => path.basename(i.path)), ['requests'], '한글 홈 목록');
  assert.ok(legacy.remove(items, home, { env: {} })[0].removed, '한글 홈에서 지움');
  assert.ok(fs.existsSync(path.join(home, '.claude', 'wy-approvals', 'erp-project', 'decisions', 'd.json')), '프로젝트 폴더 그대로');

  // 5. doctor 실행기: 공백·한글이 든 스크립트 경로와 인자를 그대로 넘긴다
  const script = path.join(base, '스크립트 폴더', 'echo args.js');
  write(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const r = defaultRun('node', [script, '공백 있는 인자', 'a"b']);
  assert.strictEqual(r.status, 0, `실행: ${r.stdout}`);
  assert.deepStrictEqual(JSON.parse(r.stdout), ['공백 있는 인자', 'a"b'], '인자 그대로');

  console.log('fsx 검사 통과');
} finally {
  rmTree(base);
}
