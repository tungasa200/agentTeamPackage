#!/usr/bin/env node
// 버전 설치(R2): 커밋된(HEAD) tools/wy-ops를 ~/.wy-tools/wy-ops/<버전>-<커밋>/에 꺼내고, current 정션을 그 폴더로 바꾼다.
//   훅과 껍데기 확장은 current 경로를 쓴다. 최근 KEEP개 버전만 남기고, rollback은 정션만 되돌린다.
//   여러 세션이 같은 워킹트리에서 일하므로 워킹트리가 아니라 HEAD를 꺼낸다(지금의 vscode/deploy.js와 같은 이유).
//   설치본에는 테스트를 넣지 않는다. 껍데기 확장 폴더(stub-ext)를 함께 만들고 해시를 deployed.json에 남긴다.
//   패키지가 저장소의 하위 폴더여도, 패키지 저장소 자체(최상위)여도 된다. deployed.json의 source에 저장소·하위 경로를 남긴다.
//   개발 연결(--dev): 버전 폴더를 만들지 않고 current를 패키지 작업 사본에 바로 연결한다(고친 것이 커밋 없이 바로 쓰인다).
//     껍데기 확장 폴더(stub-ext)와 deployed.json(dev: true)은 작업 사본 안에 만든다(패키지 저장소의 .gitignore 대상).
//     다시 보통 deploy나 rollback을 하면 연결이 풀린다.
// CLI: node lib/deploy.js [--keep 3] [--no-legacy] [--dev]   |   node lib/deploy.js rollback [<버전 폴더 이름>]
//   R4 전환 전까지는 옛 설치본(~/.wy-tools/vscode-dashboard, 지금 훅·확장이 쓰는 곳)에도 함께 배포한다(--no-legacy로 끔).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const stub = require('./stub');
const { rmTree } = require('./fsx');

const PKG = path.resolve(__dirname, '..');
const KEEP = 3;

const toolsDir = () => (process.env.WY_TOOLS_DIR ? path.join(process.env.WY_TOOLS_DIR, 'wy-ops') : path.join(os.homedir(), '.wy-tools', 'wy-ops'));
const git = (args, cwd, enc = 'utf8') => execFileSync('git', args, { cwd, encoding: enc, maxBuffer: 64 * 1024 * 1024 });
// 설치하지 않는 것: 시험, 도구 저장소 자신의 프로젝트 운영 파일(.claude/: 역할·설정, docs/: 기획 문서)
const skip = (rel) => rel.split('/').includes('test') || rel.endsWith('.test.js') || /^(\.claude|docs)\//.test(rel);

// 버전 폴더 목록(정션·.new·.old 제외), 새것부터
function versions(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !/^current/.test(n) && !/\.(new|old)$/.test(n) && fs.existsSync(path.join(dir, n, 'deployed.json')))
    .map((n) => ({ name: n, at: Date.parse(JSON.parse(fs.readFileSync(path.join(dir, n, 'deployed.json'), 'utf8')).deployedAt) || 0 }))
    .sort((a, b) => b.at - a.at)
    .map((v) => v.name);
}

// current가 가리키는 버전 폴더 이름. 설치 폴더 밖(개발 연결의 작업 사본)이면 절대 경로
function currentTarget(dir) {
  try {
    const target = path.resolve(dir, fs.readlinkSync(path.join(dir, 'current')).replace(/[\\/]+$/, ''));
    return path.dirname(target).toLowerCase() === path.resolve(dir).toLowerCase() ? path.basename(target) : target;
  } catch {
    return null;
  }
}

// current 정션을 name 폴더로(절대 경로면 그 폴더로). 이미 있는 정션 위로는 이름을 바꿀 수 없어서(EPERM) 옛 정션을 옆으로 옮긴 뒤 새 정션을 넣는다
function point(dir, name) {
  const cur = path.join(dir, 'current');
  const next = path.join(dir, 'current.new');
  const old = path.join(dir, 'current.old');
  for (const p of [next, old]) if (fs.existsSync(p) || isLink(p)) fs.unlinkSync(p);
  fs.symlinkSync(path.isAbsolute(name) ? name : path.join(dir, name), next, 'junction');
  if (isLink(cur)) fs.renameSync(cur, old);
  fs.renameSync(next, cur);
  if (isLink(old)) fs.unlinkSync(old); // 정션만 지운다(대상 폴더는 남음)
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// 개발 연결: current → 작업 사본. 버전은 작업 사본의 package.json
function deployDev({ dir = toolsDir(), pkg = PKG } = {}) {
  const before = currentTarget(dir);
  const prevStub = before ? readDeployed(path.isAbsolute(before) ? before : path.join(dir, before)).stubHash || null : null;
  const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
  const { hash } = stub.build(path.join(pkg, 'vscode'), path.join(pkg, 'stub-ext'));
  fs.writeFileSync(path.join(pkg, 'deployed.json'), JSON.stringify({ version, commit: 'dev', dev: true, stubHash: hash, source: { kind: 'dev', repo: pkg, rel: '' }, deployedAt: new Date().toISOString() }, null, 2) + '\n');
  fs.mkdirSync(dir, { recursive: true });
  point(dir, path.resolve(pkg));
  return { dir, name: path.resolve(pkg), version, commit: 'dev', dev: true, stubHash: hash, stubChanged: hash !== prevStub, previous: before, removed: [] };
}

function deploy({ dir = toolsDir(), keep = KEEP, pkg = PKG } = {}) {
  const repo = git(['rev-parse', '--show-toplevel'], pkg).trim();
  const rel = path.relative(repo, pkg).replace(/\\/g, '/'); // 패키지가 저장소 최상위면 ''
  const prefix = rel ? `${rel}/` : '';
  const commit = git(['rev-parse', '--short', 'HEAD'], repo).trim();
  const version = JSON.parse(git(['show', `HEAD:${prefix}package.json`], repo)).version;
  const name = `${version}-${commit}`;
  const target = path.join(dir, name);
  const before = currentTarget(dir);
  const prevStub = before ? readDeployed(path.isAbsolute(before) ? before : path.join(dir, before)).stubHash || null : null;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(target, 'deployed.json'))) {
    const stage = `${target}.new`;
    rmTree(stage);
    const entries = git(['ls-tree', '-r', '-z', 'HEAD', ...(rel ? ['--', prefix] : [])], repo).split('\0').filter(Boolean);
    for (const e of entries) {
      const [meta, file] = e.split('\t');
      const relFile = file.slice(prefix.length);
      if (skip(relFile)) continue;
      const dest = path.join(stage, relFile);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, git(['cat-file', 'blob', meta.split(' ')[2]], repo, 'buffer'));
    }
    const { hash } = stub.build(path.join(stage, 'vscode'), path.join(stage, 'stub-ext'));
    fs.writeFileSync(path.join(stage, 'deployed.json'), JSON.stringify({ version, commit, stubHash: hash, source: { kind: 'head', repo, rel }, deployedAt: new Date().toISOString() }, null, 2) + '\n');
    rmTree(target);
    fs.renameSync(stage, target);
  }
  point(dir, name);
  const removed = prune(dir, keep);
  const info = readDeployed(target);
  return { dir, name, version, commit, stubHash: info.stubHash, stubChanged: info.stubHash !== prevStub, previous: before, removed };
}

function readDeployed(versionDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(versionDir, 'deployed.json'), 'utf8'));
  } catch {
    return {};
  }
}

// INS-01: 설치 원본(clone) HEAD가 설치본 커밋보다 앞서면 { version, commit }. 같음·설치본이 더 새로움·갈라짐·개발 연결·git을 못 쓰면 null
function newerSource(installed, pkg = PKG) {
  if (!installed || installed.dev || !installed.commit) return null;
  const q = (...args) => execFileSync('git', args, { cwd: pkg, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); // 실패 출력은 숨긴다
  try {
    // 짧은 해시 길이는 저장소가 커지면 바뀌므로 전체 해시로 비교한다
    const [head, base] = q('rev-parse', 'HEAD', `${installed.commit}^{commit}`).split(/\r?\n/);
    if (head === base) return null;
    q('merge-base', '--is-ancestor', installed.commit, 'HEAD'); // 조상이 아니면 throw
    return { version: JSON.parse(q('show', 'HEAD:./package.json')).version, commit: q('rev-parse', '--short', 'HEAD') };
  } catch {
    return null;
  }
}

// 새것부터 keep개와 current가 가리키는 폴더는 남긴다
function prune(dir, keep) {
  const cur = currentTarget(dir);
  const all = versions(dir);
  const removed = [];
  for (const n of all.slice(keep)) {
    if (n === cur) continue;
    rmTree(path.join(dir, n));
    removed.push(n);
  }
  return removed;
}

// 이전 버전(또는 이름을 준 버전)으로 정션만 되돌린다. stubHash는 되돌린 버전의 껍데기 해시(확장 다시 깔기 판단용)
//   이름 없이 부르면 current가 아닌 가장 최근 배포본으로 간다: 두 번 하면 최신 ↔ 직전만 오간다
function rollback({ dir = toolsDir(), name = null } = {}) {
  const cur = currentTarget(dir);
  const all = versions(dir);
  const to = name || all.find((n) => n !== cur);
  if (!to || !all.includes(to)) throw new Error(`되돌릴 버전이 없습니다(있는 것: ${all.join(', ') || '없음'})`);
  point(dir, to);
  return { dir, from: cur, to, stubHash: readDeployed(path.join(dir, to)).stubHash || null };
}

// 설치본 목록(deployed.json의 배포 시각 기준 새것부터), current가 가리키는 것에 current: true
function list(dir = toolsDir()) {
  const cur = currentTarget(dir);
  return versions(dir).map((name) => {
    const d = readDeployed(path.join(dir, name));
    return { name, version: d.version, commit: d.commit, deployedAt: d.deployedAt, current: name === cur };
  });
}

// rollback 뒤에 보여 줄 안내
const ROLLBACK_NOTES = [
  '버전 없이 rollback을 다시 하면 더 옛것이 아니라 최신 배포본으로 돌아갑니다(최신 ↔ 직전). 더 옛 버전은 rollback <버전 폴더>(목록: rollback --list)',
  '되돌린 것은 설치본(current)뿐입니다. 프로젝트의 생성물(.claude/agents·skills 등)은 그대로이니, 템플릿이 바뀐 배포를 되돌렸다면 install.ps1 gen을 다시 하세요',
];

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === 'rollback') {
      const r = rollback({ name: args[1] || null });
      console.log(`되돌렸습니다: ${r.from || '(없음)'} → ${r.to}. VS Code에서 Reload Window를 하세요.`);
      for (const n of ROLLBACK_NOTES) console.log(`  ${n}`);
    } else {
      const k = args.indexOf('--keep');
      const dev = args.includes('--dev');
      const r = dev ? deployDev() : deploy({ keep: k >= 0 ? Number(args[k + 1]) || KEEP : KEEP });
      if (dev) console.log(`개발 연결: current → ${r.name} (작업 사본 v${r.version}). 고친 것이 바로 쓰입니다. 풀려면 deploy(보통) 또는 rollback`);
      else console.log(`설치했습니다: ${path.join(r.dir, r.name)} (v${r.version}, 커밋 ${r.commit}), current → ${r.name}`);
      if (r.removed.length) console.log(`오래된 버전 정리: ${r.removed.join(', ')}`);
      if (r.stubChanged) console.log('껍데기 확장 내용이 바뀌었습니다: install.ps1 setup(또는 global)으로 다시 설치하세요.');
      if (!dev && !args.includes('--no-legacy')) execFileSync(process.execPath, [path.join(PKG, 'vscode', 'deploy.js')], { stdio: 'inherit' });
    }
  } catch (err) {
    console.error(`배포 실패: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { deploy, deployDev, rollback, list, ROLLBACK_NOTES, versions, currentTarget, point, prune, toolsDir, readDeployed, newerSource };
