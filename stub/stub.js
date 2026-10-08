// WY Ops 껍데기 확장(K1-A): VS Code에는 이 작은 확장만 설치하고, 실제 코드는 설치본 ~/.wy-tools/wy-ops/current/vscode에서 불러온다.
// 그래서 업데이트는 install.ps1 deploy → Reload로 끝난다. 껍데기를 다시 설치하는 것은 contributes(뷰·명령 목록)가 바뀔 때뿐이다.
// 경로 바꾸기: 확장 컨텍스트의 extensionUri·extensionPath·asAbsolutePath를 설치본으로 바꿔 넘긴다(media 등 자원을 거기서 찾게).
// require('vscode'): 설치본 파일은 이 확장 폴더 밖이라, 그 파일들이 부르는 'vscode'만 이 확장의 API로 이어 준다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

let real = null;

function installDir() {
  return process.env.WY_OPS_CURRENT || path.join(os.homedir(), '.wy-tools', 'wy-ops', 'current', 'vscode');
}

function activate(context) {
  const vscode = require('vscode');
  const want = installDir();
  if (!fs.existsSync(path.join(want, 'extension.js'))) {
    vscode.window.showErrorMessage(`WY Ops 설치본을 찾지 못했습니다(${want}). 저장소 루트에서 install.ps1 setup을 실행한 뒤 Reload Window 하세요.`);
    return undefined;
  }
  // Node는 정션을 실제 경로(버전 폴더)로 풀어 모듈을 올리므로, 비교와 자원 경로 모두 실제 경로로 맞춘다
  const dir = fs.realpathSync(want);
  const main = path.join(dir, 'extension.js');
  const inside = (file) => !!file && path.resolve(file).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep);
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode' && parent && inside(parent.filename)) return vscode;
    return load.apply(this, arguments);
  };
  const uri = vscode.Uri.file(dir);
  const ctx = new Proxy(context, {
    get(target, key) {
      if (key === 'extensionUri') return uri;
      if (key === 'extensionPath') return dir;
      if (key === 'asAbsolutePath') return (p) => path.join(dir, p);
      const v = Reflect.get(target, key, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  real = require(main);
  return real.activate(ctx);
}

function deactivate() {
  return real && typeof real.deactivate === 'function' ? real.deactivate() : undefined;
}

module.exports = { activate, deactivate };
