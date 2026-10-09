// 한 줄 설치(quickstart)의 판단 부분. 명령 실행·입출력은 install.js가 한다(여기는 순수 함수와 파일 읽기만)
//   cleanPath(입력, home)   붙여 넣은 경로의 따옴표·~·%USERPROFILE%·$env:USERPROFILE을 정리(PowerShell 함정을 사람 손에서 뺀다)
//   defaultName(폴더)       폴더 이름에서 프로젝트 이름(영문·숫자·._-). 못 만들면 null
//   prefixFor(이름)         역할 접두사(앞 영문·숫자 2자 대문자 + '-')
//   detectStack(폴더)       있는 파일로 스택 추정(못 하면 custom)
//   claudeMdPlan(폴더)      CLAUDE.md: 없음(create) / 이미 절이 있음(present) / 있지만 절 없음(append)
const fs = require('fs');
const path = require('path');

function cleanPath(input, home) {
  let s = String(input || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!s) return '';
  s = s.replace(/^~(?=$|[\\/])/, home).replace(/^%USERPROFILE%/i, home).replace(/^\$env:USERPROFILE/i, home).replace(/^\$HOME(?=$|[\\/])/i, home);
  return path.resolve(s);
}

function defaultName(dir) {
  const n = path.basename(path.resolve(dir)).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+$/, '').slice(0, 64);
  return n || null;
}

function prefixFor(name) {
  const p = String(name || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  return `${p || 'WY'}-`;
}

// 위에서부터 먼저 맞는 것(여러 언어가 섞이면 빌드 도구가 있는 쪽을 먼저 본다)
const STACK_MARKERS = [
  ['java-gradle', ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew']],
  ['cpp', ['CMakeLists.txt']],
  ['csharp', [/\.sln$/i, /\.csproj$/i]],
  ['python', ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']],
  ['node', ['package.json']],
];

function detectStack(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 'custom';
  }
  for (const [id, marks] of STACK_MARKERS) {
    if (marks.some((m) => names.some((n) => (typeof m === 'string' ? n === m : m.test(n))))) return id;
  }
  return 'custom';
}

// 운영 도구 절이 이미 들어 있는지: 절에만 있는 세션 스크립트 경로로 본다
const SECTION_MARK = '.claude/skills/pm-ops/scripts/session.ps1';
function claudeMdPlan(dir) {
  const file = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(file)) return { file, state: 'create' };
  return { file, state: fs.readFileSync(file, 'utf8').includes(SECTION_MARK) ? 'present' : 'append' };
}

// doctor 결과를 쉬운 말로: 됐음 개수, 남은 것(FAIL 먼저, 그다음 WARN) 한 줄씩
function summarize(results) {
  const ok = results.filter((r) => r.level === 'ok');
  const left = results.filter((r) => r.level === 'fail').concat(results.filter((r) => r.level === 'warn'));
  const lines = [`됐음: 점검 ${results.length}개 중 ${ok.length}개`];
  if (!left.length) lines.push('남은 것 없음. 바로 쓰면 됩니다.');
  else {
    lines.push('이것만 남음:');
    for (const r of left) lines.push(`  - ${r.title}${r.detail ? `: ${r.detail}` : ''}${r.fix ? `\n      할 일: ${r.fix}` : ''}`);
  }
  return lines.join('\n');
}

module.exports = { cleanPath, defaultName, prefixFor, detectStack, claudeMdPlan, summarize, SECTION_MARK };
