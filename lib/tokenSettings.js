// 토큰 절감 2차 설정 적용(사용자 결정 2026-10-07). scripts/apply-token-settings.ps1이 부른다. 여러 번 실행해도 같다.
//   1) .claude/settings.json: env.CLAUDE_CODE_AUTO_COMPACT_WINDOW=300000 (다른 키 보존)
//   2) .claude/settings.local.json: 대화 크기 훅(Stop, wy-context-size.js) — settings.js의 병합(설치본 경로, PC별이라 local)
// CLI: node tokenSettings.js plan|apply [프로젝트 폴더]
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { toolsDir } = require('./deploy');

const ENV = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' };

function planEnv(current) {
  const next = JSON.parse(JSON.stringify(current || {}));
  const changes = [];
  next.env = next.env && typeof next.env === 'object' ? next.env : {};
  for (const [k, v] of Object.entries(ENV)) {
    if (next.env[k] === v) continue;
    changes.push(`${next.env[k] === undefined ? '+' : '~'} env ${k}=${v}`);
    next.env[k] = v;
  }
  return { next, changes };
}

function run(cmd, project, hooksDir = path.join(toolsDir(), 'current', 'vscode', 'hooks').replace(/\\/g, '/')) {
  const out = [];
  const shared = path.join(project, '.claude', 'settings.json');
  const env = planEnv(settings.readSettings(shared));
  out.push(`${shared}: ${env.changes.length ? env.changes.join(', ') : '바꿀 것 없음'}`);
  // 훅 파일이 설치본에 없으면 훅이 조용히 통과하므로 local은 바꾸지 않는다
  if (!fs.existsSync(path.join(hooksDir, 'wy-context-size.js'))) throw new Error(`훅 파일이 없습니다: ${hooksDir}/wy-context-size.js — 커밋 뒤 install.ps1 deploy를 먼저 실행하세요`);
  const local = path.join(project, '.claude', 'settings.local.json');
  const hooks = settings.plan(settings.readSettings(local), hooksDir);
  out.push(`${local}: ${hooks.changes.length ? hooks.changes.map(settings.describe).join(', ') : '바꿀 것 없음'}`);
  if (cmd === 'apply') {
    if (env.changes.length) out.push(`백업: ${settings.apply(shared, env.next) || '(새 파일)'}`);
    if (hooks.changes.length) out.push(`백업: ${settings.apply(local, hooks.next) || '(새 파일)'}`);
  }
  return out;
}

if (require.main === module) {
  const [cmd, project = process.cwd()] = process.argv.slice(2);
  if (!['plan', 'apply'].includes(cmd)) {
    console.error('사용법: node tokenSettings.js plan|apply [프로젝트 폴더]');
    process.exit(64);
  }
  try {
    console.log(run(cmd, path.resolve(project)).join('\n'));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}

module.exports = { planEnv, run, ENV };
