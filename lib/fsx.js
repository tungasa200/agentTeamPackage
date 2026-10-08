// 한글 경로에서도 도는 지우기·복사(R5 리허설에서 찾음): node 24.12의 fs.rmSync·fs.cpSync는 경로에 한글이 있으면
// 프로세스가 0xC0000409로 비정상 종료한다(공백만 있으면 괜찮음, fs.promises.rm·unlinkSync·rmdirSync는 괜찮음).
// 홈 경로에 한글이 든 PC(사용자 이름이 한글)에서 설치·정리가 죽지 않도록 패키지 안의 지우기·복사는 이것을 쓴다.
//   rmTree(path)         있으면 통째로 지운다(없으면 아무것도 안 함). 정션·심볼릭 링크는 따라가지 않고 링크만 지운다
//   copyTree(src, dest)  폴더를 통째로 복사한다(dest 아래 같은 이름은 덮어씀). 링크는 따라가지 않는다
const fs = require('fs');
const path = require('path');

function rmTree(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    // 정션도 Windows에서는 심볼릭 링크로 보인다: 대상 폴더가 아니라 링크만 지운다
    try {
      fs.unlinkSync(p);
    } catch {
      fs.rmdirSync(p);
    }
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) rmTree(path.join(p, name));
    fs.rmdirSync(p);
    return;
  }
  try {
    fs.unlinkSync(p);
  } catch (err) {
    // 읽기 전용 파일(git 객체 등)은 쓰기 가능으로 바꾼 뒤 지운다
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    fs.chmodSync(p, 0o666);
    fs.unlinkSync(p);
  }
}

function copyTree(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dest, name));
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

module.exports = { rmTree, copyTree };
