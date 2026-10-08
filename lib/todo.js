// 남은 손일을 승인 센터 ③ 할 일 카드로 올린다(OPS-10-1, OPS-01). install.ps1 setup이 doctor의 미충족 항목으로 부른다.
//   requests/setup-<항목>.json 하나씩, 형식은 승인 센터 README의 할 일 요청(B2-2: what·why·onClick 필수, steps·check).
//   같은 id가 이미 있으면 다시 쓰지 않는다(여러 번 실행해도 카드가 늘지 않음). 결정 파일(decisions/·used/)은 쓰지 않는다(OPS-10-3).
const fs = require('fs');
const path = require('path');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// item: { key, title, what, why, steps[], check?, onClick? }
function writeTodo(approvalsRoot, item, { session = 'install.ps1', now = new Date() } = {}) {
  const id = `setup-${String(item.key || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
  if (!ID_RE.test(id)) throw new Error(`할 일 id 형식이 틀림: ${id}`);
  for (const k of ['title', 'what', 'why']) if (!String(item[k] || '').trim()) throw new Error(`할 일 ${id}: ${k}가 비어 있음`);
  const dir = path.join(approvalsRoot, 'requests');
  const file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) return { id, written: false };
  fs.mkdirSync(dir, { recursive: true });
  const body = {
    kind: 'todo',
    session,
    createdAt: now.toISOString(),
    title: item.title,
    what: item.what,
    why: item.why,
    onClick: item.onClick || '했음: 확인 표시만 남깁니다. 설치 명령은 다음 doctor 때 이 항목을 다시 확인합니다.',
    steps: Array.isArray(item.steps) ? item.steps : [],
    ...(item.check ? { check: item.check } : {}),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { id, written: true };
}

module.exports = { writeTodo };
