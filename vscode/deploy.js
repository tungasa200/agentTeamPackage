#!/usr/bin/env node
// 설치본 갱신: 커밋된(HEAD) tools/wy-ops/vscode를 저장소 밖 설치 폴더로 꺼낸다.
//   node tools/wy-ops/vscode/deploy.js
// VS Code 확장과 승인 가드 훅은 설치 폴더를 쓰므로, 개발 중인 파일이 쓰는 확장에 실리지 않는다.
// 여러 세션이 이 폴더에서 동시에 일하므로(운영 도구 구현 계획 2.1) 워킹트리가 아니라 HEAD를 배포한다.
// 커밋 안 된 변경은 배포되지 않는다는 안내만 한다. 새 폴더를 다 만든 뒤 이름을 바꿔 한 번에 교체한다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { rmTree, copyTree } = require('../lib/fsx'); // 한글 경로에서 fs.rmSync·cpSync가 프로세스를 죽이는 것을 피함(R5)

const SRC = __dirname;
const TARGET = process.env.WY_TOOLS_DIR ? path.join(process.env.WY_TOOLS_DIR, 'vscode-dashboard') : path.join(os.homedir(), '.wy-tools', 'vscode-dashboard');
const EXCLUDE = ['test', 'deploy.js']; // 설치본에 필요 없는 것

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: SRC, maxBuffer: 64 * 1024 * 1024, ...opts });
}

function main() {
  const repo = git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const rel = path.relative(repo, SRC).replace(/\\/g, '/');
  const commit = git(['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = git(['status', '--porcelain', '--untracked-files=all', '--', '.'], { encoding: 'utf8' }).trim();
  const stage = `${TARGET}.new`;
  const old = `${TARGET}.old`;
  rmTree(stage);
  fs.mkdirSync(stage, { recursive: true });
  // HEAD의 이 폴더 파일을 하나씩 꺼낸다(tar는 Git Bash와 Windows tar.exe가 경로를 다르게 해석해 쓰지 않는다. index도 건드리지 않음)
  const entries = git(['ls-tree', '-r', '-z', 'HEAD', '--', `${rel}/`], { encoding: 'utf8', cwd: repo }).split('\0').filter(Boolean);
  for (const e of entries) {
    const [meta, file] = e.split('\t');
    const sha = meta.split(' ')[2];
    const relFile = file.slice(rel.length + 1);
    if (EXCLUDE.some((x) => relFile === x || relFile.startsWith(`${x}/`))) continue;
    const dest = path.join(stage, relFile);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, git(['cat-file', 'blob', sha]));
  }
  const version = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(stage, 'deployed.json'), JSON.stringify({ version, commit, source: 'HEAD', deployedAt: new Date().toISOString() }, null, 2) + '\n');

  rmTree(old);
  try {
    if (fs.existsSync(TARGET)) fs.renameSync(TARGET, old);
    fs.renameSync(stage, TARGET);
    rmTree(old);
  } catch (err) {
    // 폴더를 다른 프로세스가 잡고 있어 이름을 못 바꾸면 파일을 덮어쓴다
    if (!fs.existsSync(TARGET) && fs.existsSync(old)) fs.renameSync(old, TARGET);
    copyTree(stage, TARGET);
    rmTree(stage);
    console.warn(`폴더 교체 대신 덮어썼습니다(${err.code || err.message}).`);
  }
  console.log(`배포했습니다: ${TARGET} (v${version}, 커밋 ${commit})`);
  if (dirty) console.log('참고: 커밋 안 된 변경은 배포되지 않았습니다.');
  console.log('VS Code에서 "Developer: Reload Window"를 실행하면 새 코드가 실립니다. 훅은 바로 적용됩니다.');
}

main();
