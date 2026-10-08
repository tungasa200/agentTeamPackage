// 껍데기 확장 폴더 만들기(K1-A). install.ps1이 이 폴더를 vsix(zip)로 묶어 code --install-extension 한다.
//   build(realDir, outDir) → { hash, pkg }
//   realDir: 설치본의 vscode 폴더(package.json의 contributes·activationEvents를 가져온다)
//   outDir:  만들 껍데기 폴더(package.json, stub.js, contributes가 가리키는 아이콘)
// hash는 껍데기 내용(contributes·activationEvents·engines·아이콘·stub.js)의 sha256. 설치된 껍데기와 다르면 다시 설치한다.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { rmTree } = require('./fsx');

const STUB_JS = path.join(__dirname, '..', 'stub', 'stub.js');
const ID = { name: 'wy-ops', publisher: 'wy-ops' }; // 확장 id wy-ops.wy-ops(D5)

// contributes 안의 자원 경로(media/…svg·png)
function assetsOf(obj, out = new Set()) {
  if (typeof obj === 'string') {
    if (/^(?:\.\/)?media\/(?!.*\.\.)[\w./-]+\.(?:svg|png)$/.test(obj)) out.add(obj.replace(/^\.\//, '')); // ..로 폴더 밖을 가리키는 것은 뺀다
  } else if (obj && typeof obj === 'object') for (const v of Object.values(obj)) assetsOf(v, out);
  return out;
}

function build(realDir, outDir) {
  const real = JSON.parse(fs.readFileSync(path.join(realDir, 'package.json'), 'utf8'));
  const assets = [...assetsOf(real.contributes)].sort();
  const stubSrc = fs.readFileSync(STUB_JS);
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ activationEvents: real.activationEvents, contributes: real.contributes, engines: real.engines }));
  h.update(stubSrc);
  for (const a of assets) h.update(a).update(fs.readFileSync(path.join(realDir, a)));
  const hash = h.digest('hex').slice(0, 16);
  const pkg = {
    ...ID,
    displayName: 'WY Ops — 세션 현황·승인 센터',
    description: '설치본(~/.wy-tools/wy-ops/current/vscode)을 불러오는 껍데기 확장. 업데이트는 install.ps1 deploy → Reload',
    version: real.version,
    private: true,
    engines: real.engines,
    main: './stub.js',
    activationEvents: real.activationEvents,
    contributes: real.contributes,
    wyOpsStubHash: hash,
  };
  rmTree(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'stub.js'), stubSrc);
  for (const a of assets) {
    fs.mkdirSync(path.dirname(path.join(outDir, a)), { recursive: true });
    fs.copyFileSync(path.join(realDir, a), path.join(outDir, a));
  }
  return { hash, pkg };
}

module.exports = { build, assetsOf, ID };
