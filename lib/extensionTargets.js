// 껍데기 확장을 어디에 까는가(0.8.0 P1): 로컬 VS Code 확장 폴더와, 이 PC가 Remote-SSH 호스트일 때 VS Code 서버 쪽 확장 폴더.
//   원격 창에서 확장(extensionKind workspace)은 호스트의 ~/.vscode-server/extensions에서 뜬다. 로컬 폴더에만 있으면 원격 창에 카드가 안 보인다.
//   두 곳 모두 데스크톱 code CLI의 --extensions-dir로 설치한다(같은 extensions.json 형식을 그 폴더에 남긴다).
//   server: 'auto'(기본) — ~/.vscode-server가 있을 때만(이 PC에 원격 접속한 적이 있음) · 'force' — 없으면 만들어 둔다(install.ps1 host, 첫 접속 전)
//           · 'skip' — 로컬만
//   설치된 껍데기의 해시(package.json wyOpsStubHash)가 설치본과 같으면 그 폴더는 건너뛴다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const STUB_EXT = 'wy-ops.wy-ops';

const localDir = (home = os.homedir(), override = null) => override || path.join(home, '.vscode', 'extensions');
const serverRoot = (home = os.homedir()) => path.join(home, '.vscode-server');
const serverDir = (home = os.homedir()) => path.join(serverRoot(home), 'extensions');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// 그 확장 폴더에 깔린 껍데기의 해시. extensions.json에서 위치를 찾고, 그 파일이 없으면 wy-ops.wy-ops-* 폴더를 본다. 없으면 null
function stubHashIn(dir) {
  let folder = null;
  try {
    const list = readJson(path.join(dir, 'extensions.json'));
    const e = list.find((x) => x && x.identifier && String(x.identifier.id).toLowerCase() === STUB_EXT);
    if (e) folder = ((e.location && (e.location.fsPath || e.location.path)) || path.join(dir, e.relativeLocation || '')).replace(/^\/([A-Za-z]:)/, '$1');
  } catch {
    try {
      const d = fs.readdirSync(dir).filter((n) => n.toLowerCase().startsWith(`${STUB_EXT}-`)).sort().pop();
      if (d) folder = path.join(dir, d);
    } catch {
      folder = null;
    }
  }
  if (!folder) return null;
  try {
    return readJson(path.join(folder, 'package.json')).wyOpsStubHash || null;
  } catch {
    return null;
  }
}

// 설치할 곳 목록 [{ name: 'local'|'server', dir, args }]. args는 code CLI 앞에 붙일 인자
function targets({ home = os.homedir(), localOverride = null, server = 'auto' } = {}) {
  const out = [{ name: 'local', dir: localDir(home, localOverride), args: localOverride ? ['--extensions-dir', localOverride] : [] }];
  if (server === 'force' || (server === 'auto' && fs.existsSync(serverRoot(home)))) {
    out.push({ name: 'server', dir: serverDir(home), args: ['--extensions-dir', serverDir(home)] });
  }
  return out;
}

// 껍데기를 필요한 곳에 설치한다. run(cmd, args) → { status, stdout, stderr }
//   돌려줌 [{ name, dir, state: 'same'|'installed'|'failed', error? }]. 로컬 실패는 부르는 쪽이 오류로, 서버 쪽 실패는 경고로 다룬다
function install({ stubHash, stubDir, run, home, localOverride, server, tmpdir = os.tmpdir() }) {
  const list = targets({ home, localOverride, server });
  const results = [];
  let file = null;
  try {
    for (const t of list) {
      if (stubHashIn(t.dir) === stubHash) {
        results.push({ name: t.name, dir: t.dir, state: 'same' });
        continue;
      }
      if (!file) {
        file = path.join(tmpdir, `wy-ops-${stubHash}.vsix`);
        fs.writeFileSync(file, require('./vsix').vsix(stubDir));
      }
      if (t.name === 'server') fs.mkdirSync(t.dir, { recursive: true });
      const r = run('code', [...t.args, '--install-extension', file, '--force']);
      if (r.status === 0) results.push({ name: t.name, dir: t.dir, state: 'installed' });
      else results.push({ name: t.name, dir: t.dir, state: 'failed', error: String(r.stderr || r.stdout || '').trim().split('\n').pop() || `종료 코드 ${r.status}` });
    }
  } finally {
    if (file) {
      try {
        fs.unlinkSync(file); // fs.rmSync는 한글 경로에서 프로세스를 죽인다(R5)
      } catch {
        // 이미 없으면 그만
      }
    }
  }
  return results;
}

// doctor용: 서버 쪽 껍데기 상태. exists = ~/.vscode-server가 있음(원격 접속한 적 있음 또는 host로 만들어 둠)
function serverStubState(home = os.homedir(), deployedHash = null) {
  const dir = serverDir(home);
  const exists = fs.existsSync(serverRoot(home));
  const hash = exists ? stubHashIn(dir) : null;
  return { dir, exists, hash, ok: !!hash && (!deployedHash || hash === deployedHash) };
}

module.exports = { STUB_EXT, localDir, serverDir, serverRoot, stubHashIn, targets, install, serverStubState };
