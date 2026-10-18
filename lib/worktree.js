// worktree(S4, D-32) 켜짐·대상 역할 판정과 역할·규칙 문구(WT-09).
// 판정은 session.ps1의 $WtOn·Test-WtRole과 같은 규칙이다: 키가 없으면 켬, enabled를 적었으면 그 값(true일 때만 켬).
// 대상 역할은 worktree.roles가 있으면 그 목록, 없으면 pm·commit을 뺀 역할(둘은 늘 본 저장소에서 돈다).
// 문구: 꺼진 프로젝트는 예전 문구와 바이트가 같아야 한다(생성물이 바뀌지 않게).
// PowerShell '-eq $true'처럼 true·1·문자열 "true"(대소문자 무관)를 켬으로 본다
const isOn = (ops) => {
  const w = ops && ops.worktree;
  if (!w || w.enabled == null) return true;
  return w.enabled === true || w.enabled === 1 || /^true$/i.test(String(w.enabled));
};
function isWtRole(ops, name) {
  if (!isOn(ops)) return false;
  const roles = ops.worktree && ops.worktree.roles;
  const list = roles ? [].concat(roles) : []; // 문자열 하나도 목록(session.ps1 @($Wt.roles))
  if (list.length) return list.includes(name);
  return name !== ops.pmRole && name !== ops.commitRole;
}

// 역할 파일(templates/agent.md {{treeRules}}): 역할마다 한 줄
function agentRules(ops, name) {
  const c = ops.commitRole;
  if (!c) throw new Error('wy-ops.json에 commitRole이 없습니다(역할 파일의 커밋 규칙에 필요)'); // 예전 {{commitRole}} 자리표시자처럼 멈춘다
  if (!isOn(ops)) return `- 워킹트리는 모든 세션이 함께 쓴다. \`git stash\`·\`checkout\`·\`restore\`·\`reset\`·\`clean\` 금지. 일부 파일만 검증하려면 \`git archive\`로 사본을 만들어 그 안에서 돌린다. 커밋은 커밋 전담 세션(\`${c}\`)에 요청하고, 요청한 파일은 완료 회신 전까지 고치지 않는다.`;
  if (isWtRole(ops, name)) return `- 너의 작업 폴더는 \`.claude/worktrees/${name}\`(가지 \`wt/${name}\`)이다. 다른 역할의 worktree와 본 저장소 파일은 고치지 않는다. 이 폴더 안에서는 커밋하지 않은 변경을 지우는 명령(\`stash\`·\`checkout -- <파일>\`·\`restore\`·\`reset --hard\`·\`clean\`)만 쓰지 않는다. 검증은 이 폴더에서 바로 돌린다(\`git archive\` 사본 불필요). 커밋은 커밋 전담 세션(\`${c}\`)에 worktree 이름(\`${name}\`)을 함께 적어 요청하고, 요청한 파일은 완료 회신 전까지 고치지 않는다. 충돌로 \`[되돌림]\`을 받으면 이 폴더에서 기준 가지를 자기 가지에 합쳐(\`git merge <기준 가지>\`) 풀고 다시 요청한다.`;
  const main = `- 이 세션은 본 저장소에서 돈다. 역할 세션은 각자 \`.claude/worktrees/<역할>\`(가지 \`wt/<역할>\`)에서 일하고, 본 저장소는 여기 도는 세션들이 함께 쓴다. 본 저장소에서는 \`git stash\`·\`checkout\`·\`restore\`·\`reset\`·\`clean\` 금지.`;
  if (name === c) return `${main} worktree 이름이 붙은 커밋 요청은 그 worktree에서 요청 파일만 stage·commit하고(\`git -C .claude/worktrees/<역할> …\`), 사본 검증은 \`wt/<역할>\` HEAD에서 뜬다. 그다음 본 저장소 기준 가지에서 \`git merge --no-ff wt/<역할>\`로 합친다. 충돌하면 \`git merge --abort\`로 되돌리고 요청 세션에 \`[되돌림]\`(충돌 파일·기준 커밋)을 보낸다.`;
  return `${main} 일부 파일만 검증하려면 \`git archive\`로 사본을 만들어 그 안에서 돌린다. 커밋은 커밋 전담 세션(\`${c}\`)에 요청하고, 요청한 파일은 완료 회신 전까지 고치지 않는다.`;
}

// CLAUDE.md 절(templates/claude-md.md): 작업 세션 규칙 한 줄(treeRules)과 커밋 담당 절 끝에 붙는 흐름(commitTreeRules, 꺼지면 빈 문자열)
function claudeMdRules(ops) {
  if (!isOn(ops)) return { treeRules: '- 워킹트리는 모든 세션이 함께 쓴다. `git stash`·`checkout`·`restore`·`reset`·`clean`처럼 워킹트리 파일을 바꾸는 git 명령은 쓰지 않는다. 일부 파일만으로 검증하려면 `git archive` 등으로 사본을 만들어 그 안에서 돌린다.', commitTreeRules: '' };
  return {
    treeRules: `- 역할 세션은 각자 \`.claude/worktrees/<역할>\`(가지 \`wt/<역할>\`)에서 일한다(\`${ops.pmRole}\`·\`${ops.commitRole}\`은 본 저장소). 다른 역할의 worktree와 본 저장소 파일은 고치지 않는다. 커밋하지 않은 변경을 지우는 명령(\`stash\`·\`checkout -- <파일>\`·\`restore\`·\`reset --hard\`·\`clean\`)은 쓰지 않는다. 검증은 자기 worktree에서 바로 돌린다. 본 저장소에서 도는 세션이 일부 파일만 검증하려면 \`git archive\` 등으로 사본을 만든다. 커밋 요청에는 worktree 이름을 함께 적는다. 충돌로 \`[되돌림]\`을 받으면 자기 worktree에서 기준 가지를 합쳐(\`git merge <기준 가지>\`) 풀고 다시 요청한다.`,
    commitTreeRules: '\n- worktree 이름이 붙은 요청은 그 worktree에서 요청 파일만 stage·commit하고(사본 검증은 `wt/<역할>` HEAD), 본 저장소 기준 가지에서 `git merge --no-ff wt/<역할>`로 합친다. 충돌하면 `git merge --abort`로 되돌리고 요청 세션에 `[되돌림]`(충돌 파일·기준 커밋)을 보낸다. 다음 시작 때 session.ps1이 `wt/<역할>`을 기준 가지로 빨리감기한다.',
  };
}

// pm-ops 스킬(templates/pm-ops/SKILL.md {{treeRules}})
const skillRules = (ops) => (isOn(ops)
  ? '- 커밋을 요청한 파일은 완료 회신 전까지 아무도 고치지 않는다. 역할 세션은 각자 `.claude/worktrees/<역할>`에서 일하고, 본 저장소(pm·commit)에서는 stash·checkout·restore·reset·clean 금지. 남은 worktree는 `session.ps1 wt-clean <역할>`로 지운다.'
  : '- 커밋을 요청한 파일은 완료 회신 전까지 아무도 고치지 않는다. 공유 워킹트리에서 stash·checkout·restore·reset·clean 금지.');

module.exports = { isOn, isWtRole, agentRules, claudeMdRules, skillRules };
