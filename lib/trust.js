// Claude Code 폴더 신뢰(~/.claude.json의 projects[경로].hasTrustDialogAccepted). 설치 마법사의 '폴더 사용 허락'(D-171 ②)
//   claudeTrusted(폴더, home)  읽기만: true / false / null(설정 파일을 읽지 못함). 하위 폴더는 위 폴더의 신뢰를 따른다
//   trustFolder(폴더, home)    기록: 백업 → 임시 파일에 쓰고 바꿔치기 → 다시 읽어 확인. 설정 파일이 없거나 형식이 다르면 쓰지 않고 실패
//                              (Claude 내부 형식이라 업데이트로 바뀔 수 있다. 실패하면 마법사가 Claude 창에서 사람이 Yes를 고르게 한다)
// VS Code 작성자 신뢰와 따로이고, 없으면 claude --bg가 'Workspace not trusted'로 뜨지 않는다(R6)
const fs = require('fs');
const os = require('os');
const path = require('path');

const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// Claude가 쓰는 키 모양: 슬래시, 드라이브 글자 대문자(예: C:/projects/app)
const keyFor = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').replace(/^[a-z]:/, (d) => d.toUpperCase());

function claudeTrusted(project, home = os.homedir()) {
  let projects = {};
  try {
    projects = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects || {};
  } catch {
    return null; // 읽지 못하면 모른다
  }
  const want = norm(project);
  return Object.entries(projects).some(([k, v]) => v && v.hasTrustDialogAccepted && (want === norm(k) || want.startsWith(`${norm(k)}/`)));
}

function trustFolder(project, home = os.homedir()) {
  const file = path.join(home, '.claude.json');
  if (claudeTrusted(project, home) === true) return { ok: true, already: true };
  let text;
  let j;
  try {
    text = fs.readFileSync(file, 'utf8');
    j = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `설정 파일을 읽지 못함: ${err.message}` };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j) || (j.projects != null && (typeof j.projects !== 'object' || Array.isArray(j.projects)))) {
    return { ok: false, error: '설정 파일 형식이 예상과 다름(projects)' };
  }
  const projects = j.projects || (j.projects = {});
  const key = Object.keys(projects).find((k) => norm(k) === norm(project)) || keyFor(project);
  const entry = projects[key];
  if (entry != null && (typeof entry !== 'object' || Array.isArray(entry))) return { ok: false, error: `설정 파일의 ${key} 항목 형식이 예상과 다름` };
  projects[key] = { ...(entry || {}), hasTrustDialogAccepted: true };
  const backup = `${file}.wy-ops-backup`;
  try {
    fs.writeFileSync(backup, text);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, error: `설정 파일에 쓰지 못함: ${err.message}`, backup };
  }
  if (claudeTrusted(project, home) !== true) return { ok: false, error: '기록한 뒤 다시 읽었지만 허락이 보이지 않음', backup };
  return { ok: true, already: false, key, backup };
}

module.exports = { claudeTrusted, trustFolder, keyFor };
