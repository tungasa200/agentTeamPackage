// 생성 파일 다시 만들기(update, OPS-10-3): 패키지 새 버전을 반영할 때 사람이 고친 생성 파일은 덮지 않고 차이만 보여 준다.
//   update({ project, version, dryRun }) → [{ file, action, diff? }]
//     대상: .claude/agents/<역할>.md(gen-agents), .claude/skills/pm-ops/SKILL.md(gen-skill),
//           .claude/skills/pm-ops/scripts/session.ps1(코어 템플릿 그대로)
//     action은 lib/lock.js decide 결과: create·update는 쓴다, same은 그대로, modified(사람이 고침)·unmanaged(lock에 없는데 이미 있음)는
//     쓰지 않고 diff(앞부분 몇 줄)를 돌려준다. 쓴 파일과 same의 해시를 .claude/wy-ops.lock.json에 남긴다(dryRun이면 아무것도 쓰지 않음).
// 생성기는 같은 프로세스에서 불러 내용만 받는다(--out 임시 폴더로 돌린 것과 같은 결과, 임시 파일이 남지 않음).
const fs = require('fs');
const path = require('path');
const lock = require('./lock');

const PKG = path.join(__dirname, '..');
const SESSION_PS1 = path.join(PKG, 'templates', 'pm-ops', 'scripts', 'session.ps1');
const DIFF_LINES = 6;

// 새로 만들 생성 파일 목록(프로젝트 기준 상대 경로와 내용)
function planned(project) {
  const items = require('../gen-agents').generate(project).map((a) => ({ file: `.claude/agents/${a.name}.md`, content: a.text }));
  items.push({ file: '.claude/skills/pm-ops/SKILL.md', content: require('../gen-skill').generate(project) });
  // 한글이 든 .ps1은 BOM이 있어야 PowerShell 5.1이 읽으므로 템플릿 바이트를 그대로 옮긴다
  if (fs.existsSync(SESSION_PS1)) items.push({ file: '.claude/skills/pm-ops/scripts/session.ps1', content: fs.readFileSync(SESSION_PS1, 'utf8') });
  return items;
}

// 처음 달라진 곳부터 몇 줄: '- 지금 파일' / '+ 새로 만들 내용'
function preview(current, next) {
  const a = String(current).replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  const b = String(next).replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const out = [`@@ ${i + 1}번째 줄부터`];
  for (let k = i; k < Math.min(i + DIFF_LINES, Math.max(a.length, b.length)); k++) {
    if (a[k] === b[k]) out.push(`  ${a[k]}`);
    else {
      if (k < a.length) out.push(`- ${a[k]}`);
      if (k < b.length) out.push(`+ ${b[k]}`);
    }
  }
  return out.join('\n');
}

function update({ project, version = null, dryRun = false } = {}) {
  const root = path.resolve(project || process.cwd());
  if (!fs.existsSync(path.join(root, '.claude', 'wy-ops.json'))) throw new Error(`${root}/.claude/wy-ops.json이 없습니다(init을 먼저)`);
  const current = lock.readLock(root);
  const items = planned(root).map((it) => ({ ...lock.decide(root, current, it.file, it.content), content: it.content }));
  if (!dryRun) lock.writePlanned(root, current, items, version);
  return items.map(({ file, action, content }) => {
    const out = { file, action };
    if (action === 'modified' || action === 'unmanaged') out.diff = preview(fs.readFileSync(path.join(root, file), 'utf8'), content);
    return out;
  });
}

const WORD = { create: '새로 만듦', update: '고침', same: '같음', modified: '사람이 고친 파일이라 그대로 둠', unmanaged: '관리 밖 파일이라 그대로 둠' };

function format(results) {
  return results.map((r) => `${WORD[r.action] || r.action}  ${r.file}${r.diff ? `\n${r.diff.split('\n').map((l) => `    ${l}`).join('\n')}` : ''}`).join('\n');
}

// CLI: node lib/update.js [--project <폴더>] [--dry-run] [--json]
function main(argv = process.argv.slice(2)) {
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version || null;
  } catch {
    // 버전 파일이 없으면 lock에 버전을 남기지 않는다
  }
  const results = update({ project: at('--project') || process.cwd(), version, dryRun: argv.includes('--dry-run') });
  process.stdout.write((argv.includes('--json') ? JSON.stringify(results, null, 2) : format(results)) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { update, planned, preview, format };
