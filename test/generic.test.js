// 범용화 회귀 검사(R8): 패키지 코드에 특정 프로젝트 이름이 다시 들어오지 않는지, 역할 이름을 설정에서만 읽는지
//   node tools/wy-ops/test/generic.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rmTree } = require('../lib/fsx');

const PKG = path.resolve(__dirname, '..');
const slash = (p) => p.replace(/\\/g, '/');

// 1. 문자열 검사: 테스트·문서(.md 중 템플릿 밖) 말고 패키지 파일 전부
//    허용: 옛 확장 id(이 PC 전환 정리용, OLD_EXT)
const ALLOWED = ['erp-project.erp-session-dashboard'];
const BAD = [/WY-/, /\berp\b/i, /erp-project/i, /worklog/i];
function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = slash(path.relative(PKG, p));
    if (e.isDirectory()) {
      if (['test', 'node_modules', '.git'].includes(e.name)) continue;
      files(p, out);
    } else if (/\.(js|ps1|json|html|css|svg)$/.test(e.name) || (e.name.endsWith('.md') && rel.startsWith('templates/'))) {
      if (!e.name.endsWith('.test.js')) out.push(p);
    }
  }
  return out;
}
const hits = [];
for (const f of files(PKG)) {
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
    let l = line;
    for (const a of ALLOWED) l = l.split(a).join('');
    if (BAD.some((re) => re.test(l))) hits.push(`${slash(path.relative(PKG, f))}:${i + 1}: ${line.trim().slice(0, 100)}`);
  });
}
assert.deepStrictEqual(hits, [], `특정 프로젝트 이름이 남아 있음:\n${hits.join('\n')}`);

// 2. 버전: 패키지와 확장 내부 package.json이 같다
const ver = (f) => JSON.parse(fs.readFileSync(path.join(PKG, f), 'utf8')).version;
assert.strictEqual(ver('vscode/package.json'), ver('package.json'), '패키지·확장 버전이 다름');

// 3. 메시지 가드: 안내 문구의 pm 이름은 설정에서, 없으면 일반 문구
const { check } = require('../vscode/hooks/wy-message-guard');
const list = [{ name: 'AB-qa', state: 'stopped', kind: 'background', startedAt: 1, sessionId: 's1' }];
assert.ok(check(list, 'AB-qa', 'AB-pm').reason.includes('AB-pm에 알리거나'), '메시지 가드: 설정의 pmRole');
assert.ok(check(list, 'AB-qa').reason.includes('pm 세션에 알리거나'), '메시지 가드: 설정 없음');

// 4. session.ps1: 역할 목록은 wy-ops.json에서만 온다(접두어 AB-), 설정이 없으면 멈춘다
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wy-generic-'));
try {
  const scripts = path.join(tmp, '.claude', 'skills', 'pm-ops', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(path.join(PKG, 'templates', 'pm-ops', 'scripts', 'session.ps1'), path.join(scripts, 'session.ps1'));
  const ps = (args) => {
    // 콘솔 코드 페이지(한국어 Windows는 CP949)와 상관없이 UTF-8로 받는다
    const cmd = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; & '${path.join(scripts, 'session.ps1')}' ${args.join(' ')}`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return (r.stdout || '') + (r.stderr || '');
  };
  assert.ok(/roles·pmRole이 없습니다/.test(ps(['stop', 'AB-qa'])), 'session.ps1: 설정 없으면 멈춤');
  fs.writeFileSync(path.join(tmp, '.claude', 'wy-ops.json'), JSON.stringify({
    rolePrefix: 'AB-', pmRole: 'AB-pm', commitRole: 'AB-commit',
    roles: [{ name: 'AB-commit', agent: true }, { name: 'AB-pm', agent: false }, { name: 'AB-qa', agent: true }],
  }));
  const out = ps(['stop', 'WY-qa']);
  assert.ok(/역할 이름이 아닙니다: WY-qa \(예: AB-qa\)/.test(out), `session.ps1: 설정의 역할만 인정\n${out}`);
} finally {
  rmTree(tmp);
}

console.log('generic 검사 통과');
