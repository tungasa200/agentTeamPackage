# WY Ops 사용 설명서

여러 Claude Code 세션이 역할을 나눠 일할 때, 사람이 할 일(승인·결정 요청·직접 할 일)을 한곳에서 처리하고 세션 상태를 보는 도구입니다. 이 문서만 보고 새 PC나 새 프로젝트에서 따라 할 수 있게 썼습니다.

함께 보는 문서:
- [README.md](README.md): 개요, 요구 환경, 빠른 시작, 역할·스택·함께 까는 도구
- [NEW-PC.md](NEW-PC.md): 새 PC에서 사람이 직접 할 일(로그인, 옮길 것, 역할별 준비)
- [vscode/README.md](vscode/README.md): 카드 요청 파일 형식(세션이 카드를 올릴 때 쓰는 규칙)
- 프로젝트 `CLAUDE.md`: 세션 역할과 작업 규칙의 원본(`init`이 넣을 절을 만들어 줍니다)

읽는 순서: 처음이면 1~3장(한눈에 보기·팀이 일하는 흐름·설치), 매일 쓸 때는 4~7장, 역할을 바꿀 때는 8장, 패키지를 고치거나 배포할 때는 9~10장.

명령은 PowerShell 기준입니다. 예시의 역할 이름은 접두사 `AB-`로 만든 프로젝트를 가정합니다(`AB-pm`, `AB-commit`, `AB-qa` …). `<설치>`는 `"$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1"`의 줄임입니다.

---

## 1. 한눈에 보기

| 이름 | 하는 일 | 어디에 |
|---|---|---|
| 승인 센터 | 세션이 올린 카드를 처리한다(권한 요청·결정 요청·할 일·git) | 상태 표시줄 '승인 대기 N'을 누르면 열리는 작업창 탭. 명령 팔레트 `WY: 승인 센터 열기` |
| 세션 현황 | 역할 세션이 지금 무엇을 하는지, 종료된 세션 열기 | 왼쪽 활동 막대의 **WY Ops** 아이콘 → 사이드바 |
| 활동 탭 | 세션끼리 주고받은 메시지를 스레드(작업 하나)로 본다 | 명령 팔레트 `WY: 활동 보기`, 승인 센터에서 `g` `a` |
| 역할 세션 | 역할 파일(`.claude/agents/<역할>.md`)을 싣고 백그라운드에서 도는 Claude 세션 | 터미널 `claude agents`, 세션 현황 |
| 훅 | 세션이 위험한 일을 하지 못하게 막고, 권한 요청을 카드로 바꾼다 | 프로젝트 `.claude/settings.local.json`(설치 명령이 넣음) |

훅 여섯 가지:

| 훅 | 하는 일 |
|---|---|
| 승인 가드 | 커밋·푸시 같은 git 명령은 커밋 역할 세션이 승인 카드를 받은 뒤에만 실행. 승인 파일·설정 파일을 셸로 고치지 못하게 막음 |
| 메시지 가드 | 종료된 세션에 메시지를 보내려 하면 막고 재시작하는 법을 알려 줌 |
| 권한 요청 | 백그라운드 세션이 권한 요청 창을 기다리면 승인 센터에 권한 요청 카드를 올림. 자동 판단(분류기)이 막은 명령은 할 일 카드로 올림 |
| 세션 시작 | 세션이 어떤 역할로 시작했는지 기록(역할 누락 경고에 씀) |
| 컨텍스트 크기 | 역할 세션의 컨텍스트가 기준(`rotation.notifyTokens`)을 넘으면 한 번 "세션 교체 요청"을 pm에 보내라고 알림 |
| 결정 깨우기 | 승인 센터에서 카드를 처리하면 그 카드를 올린 세션을 깨워 결정을 읽고 이어 가게 함(4-1) |

여러 VS Code 창을 열면 창마다 그 폴더(프로젝트)의 카드만 보입니다. 다른 프로젝트 카드는 그 프로젝트 창에서 봅니다. 세션 현황 표도 그 창 프로젝트의 세션(역할 접두사 + 작업 폴더)만 보여 주고, 다른 프로젝트는 표 아래 한 줄로 세션 수·메모리만 요약합니다(3-4).

---

## 2. 팀이 일하는 흐름

### 2-1. 역할 구성

`init`이 만드는 기본 구성입니다(패키지 `templates/roles.json`). 이름은 접두사 + 역할입니다(`AB-pm`, `AB-backend1` …).

| 역할 | 하는 일 | 기본 수 |
|---|---|---|
| pm | 개발 총괄. 지시하고, 보고를 모으고, 중요 결정을 사람에게 올림. 백그라운드로 돌고 사람은 세션 현황 pm 줄에서 붙음(역할 파일 `.claude/agents/<pm>.md`) | 1(고정) |
| commit | 커밋·푸시·PR·병합 전담. 승인 카드를 받은 뒤에만 실행 | 1(고정) |
| planner | 기획·아키텍처 결정, 요구사항·결정기록 | 1 |
| backend | 서버·공통 모듈·빌드 | 2 |
| frontend | 화면·공용 컴포넌트·API 연결 | 2 |
| qa | 구현 동작 검증, 요구사항과 대조. 코드는 고치지 않음 | 1 |
| design | 화면 설계·목업, 구현 화면 점검 | 1 |
| browser | 외부 서비스 콘솔 작업. 코드는 고치지 않음 | 1 |

같은 역할이 둘 이상이면 이름 끝에 번호가 붙고, 1번이 그 역할의 공용 파일을 맡습니다. 역할 수와 담당 영역을 바꾸는 법은 8장에 있습니다.

### 2-2. 사람이 보는 곳

- 사람이 늘 보는 곳은 **pm 창**과 **승인 센터** 둘입니다.
- 다른 역할 세션은 백그라운드에서 돕니다. 상태는 세션 현황(사이드바)에서 봅니다. 직접 들어갈 일은 드뭅니다(4-2 '열기').
- 세션끼리는 `SendMessage`로 말합니다. **같은 PC 안의 세션끼리만** 오갑니다. 다른 PC의 팀과는 문서와 커밋으로 주고받습니다.
- 메시지를 보내기 전에는 매번 `ListAgents`로 받는 세션이 살아 있는지 확인합니다. 종료된 세션에 보내면 메시지 가드가 막습니다.

### 2-3. 하루의 흐름

1. **pm을 띄웁니다.** VS Code 왼쪽 막대 WY Ops → 세션 현황의 pm 줄(세션 표 바로 위)의 **[pm 시작]**(0.10.0, 4-2). pm은 화면 뒤(백그라운드 세션)에서 진행현황 문서를 읽고 오늘 할 일을 정합니다. 말을 걸려면 **[붙기]**. 터미널에서는 `session.ps1 start-pm latest` → `session.ps1 attach AB-pm`. 설치 마법사의 마지막 [pm 시작하고 VS Code 열기]도 같은 일을 합니다.
2. **역할 세션을 띄웁니다.** pm이 `session.ps1 start AB-backend1`. 새 세션은 CLAUDE.md와 진행현황을 읽고 pm에 "시작" 한 줄을 보냅니다.
3. **지시합니다.** pm이 `SendMessage`로 할 일·범위·검증 방법을 보냅니다.
4. **보고를 받습니다.** 역할 세션은 세 가지 형식만 씁니다.
   - `[완료]` 한 일, 바뀐 파일, 실행한 검증 명령과 결과
   - `[결정 요청]` 배경, 선택지와 대가, 추천안, 막히는 작업
   - `[차단]` 멈춘 이유, 필요한 것
5. **결정은 사람에게 카드로.** pm은 사람이 정할 일을 결정 요청 카드로 올립니다. 사람이 승인 센터에서 고르면 pm이 세션에 전합니다.
6. **커밋을 요청합니다.** 작업 세션은 git 명령을 직접 쓰지 않습니다. 커밋 역할에 파일 목록·커밋 메시지·브랜치를 보냅니다(역할 worktree를 쓰면 worktree 이름도, 2-6).
7. **승인 카드.** 커밋 역할이 git 카드를 올리고, 사람이 승인하면 그 명령을 그대로 실행합니다. 푸시·PR·병합도 각각 카드를 거칩니다.
8. **쉬는 세션을 멈춥니다.** 곧 쓸 세션은 대기로 두고, 1시간 넘게 안 쓸 세션은 pm이 `session.ps1 stop AB-qa`. 메모리를 돌려받고, 대화는 남습니다. 다음 작업 때 교체 기준(`rotation.contextTokens`) 이상이면 `rotate`, 미만이면 `start`로 이어 갑니다.

PC를 다시 켜면 백그라운드 세션은 모두 꺼져 있습니다. pm은 세션 현황 [pm 시작], 역할 세션은 pm이 필요한 것만 `start`(컨텍스트가 크면 `rotate`)로 다시 띄웁니다.

### 2-4. 세션 교체

대화가 길어지면 앞 내용을 흐리게 기억합니다. 역할 세션은 `/clear`로 비우지 않고 새 세션으로 바꿉니다.

역할 세션(pm이 함):
1. `session.ps1 health` — 역할별 컨텍스트 크기. '세션 교체'가 뜨면 교체합니다(기준 `rotation.contextTokens`, 기본 10만 토큰). 작업이 끝난 지점에서 합니다.
2. `session.ps1 prep AB-backend1` — 세션이 진행 중인 것만 `/wy-save-session`으로 저장하고, 경로나 '진행 중 없음'을 알립니다.
3. `session.ps1 rotate AB-backend1 <경로|none>` — 옛 세션을 멈추고 새 세션을 띄웁니다. 새 세션이 시작을 알리면 pm이 '멈춰 있는 동안 끝난 일'을 보냅니다.

pm 자신(0.10.0부터 세션 현황 **[pm 교체]** 한 번):
- 세션 현황 pm 줄에 '교체 권장'(컨텍스트가 `rotation.contextTokens` 이상, 기본 10만 토큰)이 뜨면 일이 끊기는 때에 [pm 교체]를 누릅니다. pm에 붙은 터미널('AB-pm 붙기')에 교체 문구가 들어가고, pm이 하던 턴을 마친 뒤 스스로 ① 진행 중인 것 저장(`/wy-save-session`) ② `start-pm latest -Force`로 새 pm ③ 이전 자신 멈춤을 합니다. pm 줄은 이 네 단계(마지막 ④ 새 터미널로 붙기)를 보여 주고, 끝나면 새 pm에 붙은 터미널을 엽니다. 창을 닫아도 교체는 계속되고, 다시 열면 이어서 보여 줍니다.
- 한 단계가 늦으면(저장 10분, 그 뒤 단계 60초) 멈추고 무엇이 안 됐는지와 지금 상태(이전 pm이 살아 있는지)를 보여 줍니다. [다시 시도]는 실패한 단계부터, [기록 보기]는 교체 기록 파일을 엽니다. 여유 메모리가 `memory.blockFreeMB`(기본 500MB) 미만이면 교체를 시작하지 않습니다.
- 터미널로 직접: pm에서 `/wy-save-session`(short-id는 pm 역할 이름) → `session.ps1 start-pm latest -Force`(백그라운드 pm이 이미 돌면 -Force 없이는 거부) → `session.ps1 attach <pm 역할>`로 새 pm에 붙고 이전 pm은 `claude.cmd stop <이전 id>`(PowerShell 실행 정책 때문에 `.cmd`로). `session.ps1 pm-cmd`가 이 순서를 출력합니다.

### 2-5. 기억은 파일에

세션은 교체되므로 대화에 기억을 두지 않습니다.

| 무엇 | 어디에 |
|---|---|
| 역할(담당 범위·작업 방식·함정) | `.claude/agents/<역할>.md`(생성물, 원본은 `.claude/ops/roles/`) |
| 공통 규칙 | 프로젝트 `CLAUDE.md` |
| 진행 상황·역할별 다음 할 일 | 진행현황 문서(`wy-ops.json`의 `docs.progress`) |
| 확정된 결정 | 결정기록 문서(`docs.decisions`) |
| 하던 일의 중간 상태 | `/wy-save-session` 인수인계 파일(이 PC에만 남음) |

다른 PC로 이어 갈 내용은 문서와 커밋으로 넘깁니다.

### 2-6. 역할 worktree(역할마다 작업 폴더)

역할 세션이 한 폴더를 함께 고치면 서로의 미커밋 파일이 섞입니다. 그래서 pm·commit을 뺀 역할 세션은 각자 `.claude/worktrees/<역할>`(git worktree, 가지 `wt/<역할>`)에서 일합니다. pm·commit은 본 저장소(기준 가지)에 남습니다. worktree 하나에 디스크가 약 300MB 듭니다.

**켜고 끄기.** `.claude/wy-ops.json`의 `worktree` 키로 정합니다. 키가 없으면 켬입니다. `init`·`quickstart`의 `--no-worktree`, 마법사 고급 설정의 '역할마다 작업 폴더 따로 쓰기'를 끄면 `"enabled": false`를 적습니다(이미 값이 있으면 덮지 않음).

| 키 | 뜻 | 없으면 |
|---|---|---|
| `enabled` | `false`면 모두 본 저장소 한 폴더를 함께 씀 | 켬 |
| `base` | 기준 가지. 아래 커밋 흐름 3의 `git merge <기준>` 예외는 이 값을 적었을 때만 동작 | 본 저장소의 지금 가지(`session.ps1`만, 가드는 추정하지 않음) |
| `roles` | worktree를 쓸 역할 목록(예: qa처럼 기준 가지에서 돌 역할을 빼려고). 넣지 않은 역할은 본 저장소에서 돌고, 작업 폴더 규칙 문구에 두 쪽 역할 이름이 들어감. 역할이 아닌 이름이나 pm·commit을 넣으면 doctor가 주의로 알림 | pm·commit을 뺀 모든 역할 |
| `deps` | 역할별로 `npm ci --prefer-offline`을 돌릴 폴더. 예: `{ "AB-frontend1": ["frontend"] }` | 설치하지 않음 |

값을 바꾼 뒤에는 `<설치> gen`(역할 파일·pm-ops 스킬의 작업 폴더 규칙 문구가 바뀜) → `CLAUDE.md`의 워킹트리 줄(세션 역할 절 첫 줄)과 커밋 절을 손으로 고침 → 바뀐 파일을 기준 가지에 커밋(worktree는 커밋된 것만 받음, 아래 '처음 켤 때' 6) → 떠 있는 역할 세션을 `rotate`합니다. gen은 `CLAUDE.md`도 `.claude/ops/CLAUDE.part.md`도 쓰지 않습니다(`CLAUDE.part.md`는 `init`만 씀). 켤 때 넣을 문구는 worktree를 켠 이 패키지 저장소의 `CLAUDE.md`에서 얻습니다: 세션 역할 절 첫 줄('같은 저장소에서 작업한다(개발 역할은 각자 worktree)'), 커밋 절 '작업 세션'의 첫 줄(worktree에서 일하기·지우는 명령 금지·커밋 요청에 worktree 이름·충돌 때 `git merge <기준 가지>`), '`OPS-commit`' 절의 둘째 줄(그 worktree에서 요청 파일만 커밋하고 기준 가지에 `git merge --no-ff wt/<역할>`, 충돌하면 `--abort`하고 `[되돌림]`). 역할 이름만 내 프로젝트 것으로 바꿉니다. 끌 때는 '같은 워킹트리에서 작업한다'로 되돌리고, 작업 세션 첫 줄을 '워킹트리는 모든 세션이 함께 쓴다·파일을 바꾸는 git 명령 금지·일부 파일 검증은 `git archive` 사본'으로 바꾸고, `OPS-commit` 절의 worktree 줄을 지웁니다.

**띄울 때마다 하는 일**(`session.ps1`의 `start`·`rotate`·`prep`·`adopt`):
1. worktree가 없으면 만들고(가지 `wt/<역할>`이 남아 있으면 그 가지로), 있으면 다시 씁니다.
2. 기준 가지로 빨리감기(`git merge --ff-only <기준>`)합니다. 병합 전 커밋이 있어 안 되면 경고만 하고 그대로 띄웁니다.
3. 본 저장소의 `.claude/settings.local.json`·`wy-ops.local.json`을 worktree로 복사합니다(git에 없는 파일이라 worktree에 따라오지 않음). 복사하지 못했거나 복사본에 승인 가드 훅이 없으면 **띄우지 않습니다**(가드 없이 도는 세션을 만들지 않음).
4. `deps`의 폴더에 `node_modules`가 없거나 `package-lock.json`이 더 새로우면 `npm ci --prefer-offline`. 실패하면 띄우지 않습니다.

`session.ps1` 안의 git(worktree 목록·만들기·지우기, ff-only, 상태 조회)은 정해진 명령뿐이고 승인 카드를 거치지 않습니다.

**커밋 흐름:**
1. 역할 세션은 커밋 요청에 worktree 이름(자기 역할 이름)을 함께 적습니다. 파일 경로는 worktree 기준입니다.
2. 커밋 역할이 그 worktree에서 요청 파일만 stage·commit하고(git 카드), 본 저장소 기준 가지에서 `git merge --no-ff wt/<역할>`로 합칩니다(git 카드).
3. 충돌하면 커밋 역할이 `git merge --abort`로 되돌리고 요청 세션에 `[되돌림]`(충돌 파일·기준 커밋)을 보냅니다. 요청 세션은 자기 worktree에서 `git merge <기준 가지>`로 충돌을 풀고 다시 요청합니다. 이 `git merge <기준 가지>`는 처음부터 파이프·`cd`·다른 명령을 붙이지 말고 단독으로 실행합니다. 거부되면 형태를 바꿔 다시 시도하지 말고 `[차단]`으로 보고합니다(다음 start·rotate 때 빨리감기로 받아집니다). 이 명령만 커밋 역할이 아닌 세션에 승인 없이 허용됩니다(자기 worktree에서, 대상이 기준 가지일 때). 이 예외는 `wy-ops.json`에 `worktree.base`를 적었을 때만 동작합니다. 가드는 git을 부르지 않으므로 지금 가지를 추정하지 않습니다. 이 병합에서도 충돌이 나면 파일을 고친 뒤 마무리 커밋(`git commit`·`merge --continue`)은 하지 않고, 고친 파일을 커밋 역할에 요청합니다. 커밋 역할의 그 커밋이 병합 커밋이 됩니다.
4. 다음에 띄울 때 2번의 빨리감기가 `wt/<역할>`을 기준 가지에 맞춥니다. 따로 reset하지 않습니다.

역할 세션은 자기 worktree 안에서 검증을 바로 돌립니다(`git archive` 사본 불필요). 본 저장소에서 도는 세션(pm·commit)은 지금처럼 사본을 씁니다. 다른 역할이 고친 파일은 기준 가지에 병합되고 다음에 띄울 때까지 보이지 않습니다.

**처음 켤 때(이미 쓰던 프로젝트에 적용).** 역할 worktree는 기준 가지의 **커밋된** 상태에서 만들어집니다. 본 워킹트리의 미커밋 변경은 따라가지 않습니다. 아래 순서를 지킵니다.
1. 본 저장소의 미커밋 변경을 커밋하거나 정리합니다(doctor '역할 worktree' 줄이 알림).
2. `.gitignore`에 `.claude/worktrees/` 줄을 넣고 커밋합니다. `init`이 넣지만 `update`는 `.gitignore`를 고치지 않습니다(없으면 doctor가 주의). 비슷한 줄이 이미 있으면 새로 넣지 말고 경로만 `.claude/worktrees/`로 맞춥니다. 빠진 채 켜면 `git add -A`가 worktree 폴더를 커밋에 넣습니다.
3. `wy-ops.json`의 `worktree` 키(`enabled`·`roles`·`base`·`deps`)를 정합니다.
4. 프로젝트가 공통 문구 틀 `.claude/ops/agent.md`(pm은 `agent-pm.md`)를 덮어 쓰고 있으면, 그 안의 공유 워킹트리 줄('워킹트리는 모든 세션이 함께 쓴다…')을 `{{treeRules}}` 한 줄로 바꿉니다. 이 줄이 없으면 gen이 역할 파일에 worktree 규칙을 넣지 못하고 doctor '역할 worktree' 줄이 주의로 알립니다.
5. `<설치> gen` → `CLAUDE.md`의 워킹트리 줄·커밋 절을 손으로 고칩니다(위 '값을 바꾼 뒤에는').
6. gen 생성물(`.claude/agents/`·pm-ops 스킬)·`CLAUDE.md`·`wy-ops.json`·`.claude/ops/` 변경을 **기준 가지에 커밋**합니다. CI가 있으면 통과를 본 뒤 다음으로 갑니다.
7. doctor로 '.gitignore'·'역할 worktree' 줄이 통과인지 확인하고, 역할 세션을 `rotate`합니다(새 worktree에서 뜸).

6을 건너뛰면 worktree가 옛 커밋에서 만들어져 역할 세션이 **옛 역할 파일·옛 CLAUDE.md로 뜹니다.** 겉으로는 정상으로 보이므로 빠뜨리기 쉽습니다. 이미 그렇게 띄웠으면 커밋한 뒤 다시 `rotate`합니다(띄울 때 기준 가지로 빨리감기).

**지우기.** 평소에는 지우지 않습니다(역할마다 고정). 역할을 없애거나 worktree를 끌 때, 트리가 망가졌을 때만 pm이 `session.ps1 wt-clean <역할>`. 세션이 실행 중이거나, 미커밋 변경이나 기준 가지에 병합되지 않은 커밋이 있으면 지우지 않고 알립니다. 가지 `wt/<역할>`은 남기므로 지우려면 커밋 역할에 `git branch -d wt/<역할>`을 요청합니다.

- Claude Code의 `claude -w`(자체 worktree)는 쓰지 않습니다. doctor가 남은 흔적(역할이 아닌 worktree, 잠긴 worktree, `worktree-*` 가지)을 알립니다.
- `.claude/settings.json`의 `worktree.bgIsolation: "none"`은 켜도 그대로 둡니다. Claude Code가 따로 격리하면 worktree 안에 worktree가 생깁니다.
- 세션 현황의 토큰·멈춤 감지와 활동 탭은 worktree 세션의 대화 기록(`~/.claude/projects/<저장소 키>--claude-worktrees-<역할>/`)도 읽습니다.

---

## 3. 설치

### 3-0. 설치 마법사(처음이면 이것, 0.9.0)

패키지 저장소를 `git clone`한 뒤(README '설치하기') 그 폴더의 `setup.cmd`를 더블클릭합니다. 터미널 없이 창 하나로 끝납니다. 마법사(`scripts/setup-wizard.ps1`, PowerShell + WinForms)는 아래 한 줄 설치를 대신 돌리는 앞단이라 하는 일과 결과는 같습니다.

| 단계 | 하는 일 | 사람이 할 것 |
|---|---|---|
| 1 시작 | 무엇을 하는지·걸리는 시간 안내 | 다음 |
| 2 프로젝트 폴더 | 폴더와 이름(폴더 이름에서 자동). 고급(접힘): 역할 이름 앞글자, 프로젝트 종류, 역할 수, '역할마다 작업 폴더 따로 쓰기'(기본 켬, 2-6). 이미 설정이 있는 폴더면 그 값을 읽어 옵니다 | 폴더 고르기 |
| 3 설치 | `install.ps1 quickstart --yes --progress --no-finish`를 창 없이 돌리고 줄마다 진행을 보여 줍니다. 실패하면 그 줄에 쉬운 말 원인과 [다시 시도]·[로그 저장…]. 함께 까는 도구(`extra-*`)는 실패해도 그 줄만 ✕로 두고 설치는 멈추지 않습니다(마침 화면 남은 일로). 함께 까는 도구의 설치 명령은 15분까지 기다립니다 | "변경을 허용할까요?" 창에서 [예] |
| 4 Claude 로그인 | `claude auth login`이 브라우저를 열고, 마법사가 2초마다 로그인 여부를 확인합니다. 건너뛸 수 없음 | 브라우저에서 로그인 |
| 5 GitHub 로그인 | 확인 코드를 크게 보여 주고 github.com/login/device를 엽니다. 로그인되면 `gh auth setup-git`. [나중에 하기] 가능(마침 화면 노랑 + 할 일 카드) | 코드 입력 |
| 6 폴더 사용 허락 | [허락하기] → `install.js trust`가 `~/.claude.json`에 그 폴더의 허락을 기록(쓰기 전 `~/.claude.json.wy-ops-backup`). 실패하면 [Claude 창 열기]로 사람이 Yes를 고르고, 마법사가 기록을 확인하면 넘어갑니다 | (실패 때만) Yes |
| 7 마침 | `doctor --json --todos` 결과를 프로그램 설치·프로젝트 폴더 준비·함께 까는 도구·Claude 로그인·GitHub 로그인·폴더 사용 허락 여섯 줄로 요약. 남은 것은 줄마다 [지금 하기]. 빠진 도구·플러그인(missing)은 점검이 실패여도 '함께 까는 도구' 줄에 주의로만 두고 pm 시작을 막지 않습니다. 남은 일 [자세히]에 빠진 이름과 다시 받는 명령(설치본 `install.ps1 setup --project <폴더>`, 이미 있는 것은 건너뜀)이 나옵니다. **[pm 시작하고 VS Code 열기]**(0.10.0): `session.ps1 start-pm latest`로 pm을 백그라운드로 띄운 뒤 VS Code를 엽니다(pm이 안 떠도 VS Code는 열고, 세션 현황 [pm 시작]으로 이어서). [VS Code만 열기]는 pm 없이. Claude 로그인·폴더 허락이 안 됐으면 [VS Code 열기]만 | 남은 것만 |

- 기록은 `%TEMP%\wy-ops-setup-<시각>.log`에 남고 [로그 저장…]으로 바탕화면에 복사합니다.
- 설치 중 [취소]는 지금 설치하던 프로그램이 끝난 뒤 닫습니다. 다시 실행하면 빠진 것만 채웁니다.
- 화면 배율(125·150%)을 따라 커집니다. 화면 확인용: `powershell -STA -File scripts\setup-wizard.ps1 -Shots <폴더> [-Scale 1.5]`(가짜 출력으로 화면 상태를 PNG로 저장), `-Demo`(가짜 출력으로 창을 띄움, 아무것도 설치·기록하지 않음).
- 스택은 고르지 않습니다(폴더를 보고 알아냄, 3-0b 3/6). 고급 설정의 '검증 명령 [알아보기]'로 미리 봅니다. 틀리면 설치 뒤 `.claude/wy-ops.json`의 `verify`를 고치고 `install.ps1 gen`.
- 마법사가 쓰는 명령: `install.js trust --project <폴더> [--check]`(허락 기록·확인, JSON 한 줄), `doctor --json --todos`, `quickstart --progress --no-finish`.

### 3-0b. 한 줄 설치(터미널)

1. 패키지 저장소를 `C:\tools\wy-ops`에 받습니다. git이 없으면 먼저 `winget install -e --id Git.Git` 후 새 PowerShell 창.
   ```powershell
   git clone <패키지 저장소 주소> C:\tools\wy-ops
   ```
2. 아래 한 줄을 붙여 넣습니다. 이 PC 설치와 프로젝트 붙이기를 한 번에 합니다.
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\tools\wy-ops\install.ps1 quickstart
   ```
   명령 대신 패키지 폴더(`setup.cmd` 옆)의 `quickstart.cmd`를 더블클릭해도 됩니다(설치본 `~\.wy-tools\wy-ops\current`에도 있음). 프로젝트 폴더는 실행 중에 묻고, 끝나거나 실패해도 창이 닫히지 않아 결과를 읽을 수 있습니다.

차례로 하는 일:

| 단계 | 하는 일 | 사람이 할 것 |
|---|---|---|
| 시작 | 필요한 프로그램 확인. 없으면 설치를 한 번 묻습니다 | `y` |
| 시작 | 프로젝트 폴더와 이름을 묻습니다. 경로는 따옴표째 붙여도 되고 `~`도 됩니다. git 저장소 안의 하위 폴더를 주면 저장소 맨 위에 붙입니다 | 폴더·이름 입력(Enter = 기본값) |
| 1/6 | 설치본·VS Code 확장(`global`과 같음). 설치본이 이미 있으면 다시 배포하지 않고 그대로 씁니다. clone이 설치본보다 새로우면 `install.ps1 deploy` 뒤 다시 실행하라고 알립니다 | — |
| 2/6 | 없는 폴더는 만들고, git 저장소가 아니면 `git init` | — |
| 3/6 | 운영 도구 파일(`init`과 같은 결과, 묻지 않고 기본값). 스택은 루트와 바로 아래 폴더의 표지 파일로 폴더마다 알아냅니다(`package.json` → node, `build.gradle(.kts)`·`settings.gradle(.kts)`·`gradlew` → java-gradle, `pom.xml` → java-maven, `pyproject.toml`·`requirements.txt`·`setup.py`·`Pipfile` → python, `*.sln`·`*.csproj` → csharp, `CMakeLists.txt` → cpp). 루트가 Gradle·Maven·.NET 솔루션·CMake처럼 하위 모듈을 함께 빌드하는 스택이면 루트와 같은 스택인 하위 폴더는 루트 빌드의 모듈로 보고 뺍니다. Node·Python 하위 폴더는 남겨 폴더별 명령을 잡습니다. node 실행기는 잠금 파일로 고릅니다(`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb`·`bun.lock` → bun, 그 밖에는 npm. Yarn Berry(`.yarnrc.yml`)는 `yarn install --immutable`). `gradlew`·`mvnw`가 없으면 `gradle`·`mvn`을 씁니다. 결과는 `wy-ops.json`의 `detected`(`[{dir, stack}]`)와 `verify`에 적습니다. `verify`는 폴더가 루트 하나면 키마다 명령 문자열, 여럿이면 키마다 `{ 폴더: 명령 }`입니다. node는 `package.json` scripts에 있는 것만 씁니다. 미리 보려면 `detect`(5장). 역할은 2-1 기본 구성, 접두사는 이름 앞 두 글자(`my-app` → `MY-`, 이 PC의 다른 프로젝트와 겹치면 세 글자 `MYA-`나 숫자를 붙인 `MY2-`). 새 `settings.local.json`은 묻지 않고 만들고, 있는 파일을 바꿀 때는 묻습니다 | 스택 개발 도구가 없으면 설치 여부 `y` |
| 4/6 | `CLAUDE.md`가 없으면 운영 도구 절을 넣어 만듭니다. 있으면 고치지 않고 붙일 내용을 보여 줍니다 | 있던 경우만 붙여 넣기 |
| 5/6 | Claude Code 로그인, GitHub 로그인, 폴더 신뢰. 이미 된 것은 건너뜁니다. 안 된 것은 할 일을 한 줄로 알리고 Enter를 누르면 같은 창에서 엽니다(`s` = 나중에) | 브라우저 로그인, 신뢰 Yes → `/exit` |
| 6/6 | 점검(doctor)을 "됐음 / 이것만 남음"으로 요약하고 VS Code로 프로젝트를 엽니다. 남은 손일은 승인 센터 할 일 카드로도 올라옵니다 | 남은 것만 처리 |

설정이 이미 있는 프로젝트에서 다시 돌려도 됩니다. 있는 설정·`CLAUDE.md`·사람이 고친 파일은 그대로 두고 빠진 것만 채웁니다. 묻지 않고 돌리려면 `--yes --project <폴더> [--name <이름>]`(이때 로그인·신뢰는 건너뛰고 나중에 할 명령만 알립니다). 역할 worktree(2-6)는 묻지 않고 켬입니다. 끄려면 `--no-worktree`.

역할 수·담당 영역을 직접 고르거나 스택을 덮어쓰고 싶을 때는 아래 3-1·3-2처럼 `global` → `init`을 씁니다.

### 3-1. 이 PC에 처음 설치(직접 고르고 싶을 때)

1. 이 패키지 저장소를 clone합니다(경로에 공백·한글이 없는 곳 권장).
   ```powershell
   git clone <패키지 저장소 주소> C:\tools\wy-ops
   ```
2. 설치합니다.
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\tools\wy-ops\install.ps1 global
   ```
   - 먼저 필수 환경(Node.js LTS·Git·GitHub CLI·VS Code·Claude Code)을 확인하고, 없으면 목록을 보여 준 뒤 설치합니다.
   - 설치본을 `%USERPROFILE%\.wy-tools\wy-ops\<버전>`에 넣고 `current`가 그 버전을 가리키게 합니다.
   - VS Code 확장(`wy-ops.wy-ops`)과 함께 까는 도구를 설치합니다.

### 3-2. 새 프로젝트에 붙이기(직접 고르고 싶을 때)

1. 프로젝트 폴더에서(먼저 `git init`):
   ```powershell
   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.wy-tools\wy-ops\current\install.ps1" init --name <프로젝트 이름> --prefix AB-
   ```
   - 스택은 고르지 않습니다. `quickstart`처럼 폴더의 표지 파일로 알아내 결과를 보여 줍니다(3-0b 3/6). 틀리면 설치 뒤 `.claude/wy-ops.json`의 `verify`를 고치고 `<설치> gen`. 하나도 못 알아내면 검증 명령을 묻습니다(`--verify-<키> "<명령>"`으로 미리 줄 수 있음).
   - `--stack node|python|java-gradle|java-maven|csharp|cpp|custom`은 덮어쓰기용입니다. 주면 알아내지 않고 그 템플릿을 씁니다. 루트에 그 스택의 파일(`package.json`·`build.gradle` 등)이 있으면 폴더 내용으로 다듬습니다. node는 `scripts`에 있는 명령만 쓰고, `gradlew`·`mvnw`가 없으면 `gradle`·`mvn`을 씁니다. 빈 폴더면 템플릿 값을 그대로 씁니다.
   - 이미 `wy-ops.json`이 있으면 `verify` 키가 아예 없을 때만 `detected`·`verify`·`tools`·`stackNotes`를 채웁니다(`wy-ops.json.bak-<시각>`을 남김). `verify`가 있으면 손대지 않습니다. 이때 `--verify-*` 값이나 입력값도 쓰지 않고 "기존 verify를 유지해 --verify-* 값은 쓰지 않았습니다(.claude/wy-ops.json에서 고치세요)"를 한 줄 알립니다. 코드가 생긴 뒤 다시 알아내려면 `<설치> detect --apply`를 씁니다.
   - 역할별 수, 여러 개로 나눈 역할의 담당 영역을 묻습니다. 묻지 않고 정하려면 `--roles`, `--count backend=2,frontend=1`, `--area "AB-backend1=server/;AB-backend2=tools/"`를 씁니다.
   - 끌 수 있는 함께 까는 도구를 고릅니다(고른 역할에 필수인 것은 못 끔).
   - 역할 worktree(2-6)를 쓸지 묻습니다(`[Y/n]`, 설정에 값이 있으면 묻지 않음). 묻지 않고 정하려면 `--worktree`·`--no-worktree`. 고른 값은 `worktree.enabled`가 없을 때만 적습니다.
   - 만드는 것: `.claude/wy-ops.json`, 역할 원본(`.claude/ops/`)·역할 파일(`.claude/agents/`), pm-ops 스킬, `.gitignore` 줄(`.claude/worktrees/` 포함), `settings.local.json`, `.claude/settings.json`의 `worktree.bgIsolation: "none"`(값이 없을 때만, 백그라운드 역할 세션이 Claude Code의 따로 격리 없이 정해진 폴더를 고치려면 필요).
   - doctor '공용 워킹트리' 줄이 이 값을 봅니다. 없으면 주의로 알리고, `init`을 다시 실행하거나(있는 파일·값은 덮지 않고 이 값만 더함. 검증 명령(verify)이 없는 설정이면 그것도 더함) `.claude/settings.json`에 `"worktree": { "bgIsolation": "none" }`을 손으로 넣으라고 안내합니다. `update`도 이 값이 비어 있으면 채웁니다(있는 값은 그대로).
   - 이미 있는 파일은 덮지 않습니다. 예외: `verify`가 없는 `wy-ops.json`에는 검증 부분만 더하고 `.bak-<시각>`을 남깁니다.
2. 출력 끝의 **CLAUDE.md에 넣을 절**을 복사해 그 프로젝트 `CLAUDE.md`에 붙입니다(자동으로 고치지 않습니다). '작업 원칙' 절을 빼려면 `init`에 `--no-principles`.
3. 신뢰 안내가 나오면 그 폴더 터미널에서 `claude` → Yes → `/exit`.
4. 그 폴더를 VS Code로 열고 `Developer: Reload Window`.
5. 확인: `<설치> doctor --project .`

`-File` 뒤에는 `~`를 쓰지 않습니다. PowerShell이 `~`를 펼치지 않아 "does not exist"로 실패합니다. `$env:USERPROFILE`을 큰따옴표 안에 씁니다.

### 3-3. 다른 PC에서 같은 프로젝트 이어 가기

개인 상태까지 옮길 때: 원래 PC에서 `<설치> export --out <zip>` → 새 PC에서 패키지를 clone하고 `install.ps1 restore <zip>`. 자세한 순서는 [NEW-PC.md](NEW-PC.md) 3장.

코드만 이어 갈 때:
1. 패키지를 clone하고 `install.ps1 global`(3-1).
2. 프로젝트를 clone하고 그 폴더에서 `claude` → 신뢰 Yes → `/exit`.
3. 프로젝트 폴더에서 `<설치> setup`. `settings.local.json`에 넣을 내용을 보여 주면 맞을 때 `y`. 끝의 점검 표에 **FAIL**이 있으면 그 줄의 '고치기'를 실행합니다. 남은 손일은 승인 센터에 할 일 카드로 올라옵니다.
4. `Developer: Reload Window`.

### 3-4. 한 PC에서 여러 프로젝트 함께 쓰기

설치는 두 층입니다. 프로젝트마다 패키지를 다시 설치하지 않습니다.

| 층 | 언제 | 무엇 |
|---|---|---|
| PC 전역 | PC당 한 번(`global`, 또는 첫 `quickstart`. 설치본이 있으면 `quickstart`는 다시 배포하지 않고, clone이 더 새로우면 `install.ps1 deploy`만 안내) | 설치본 `~\.wy-tools\wy-ops\<버전>`과 `current`, VS Code 확장, 함께 까는 도구 |
| 프로젝트별 | 프로젝트마다 한 번(`quickstart`·`init`, 다른 PC에서 이어 갈 때 `setup`) | `.claude/wy-ops.json`, `.claude/ops`·`.claude/agents`, pm-ops 스킬, `settings.local.json` 훅 |

저절로 나뉘는 것:
- **승인 카드**: 프로젝트마다 `~\.claude\wy-approvals\<namespace>` 폴더를 따로 씁니다. namespace는 `wy-ops.json`의 `approvals.namespace`이고, `init`이 프로젝트 이름으로 넣습니다. 이 값이 빠지거나 형식이 틀리면 공용 폴더(`wy-approvals` 바로 아래)를 쓰게 되고, doctor가 FAIL로 알립니다.
- **승인 센터**: VS Code 창은 그 창에서 연 폴더(위로 올라가며 찾은 `.claude/wy-ops.json`)의 카드만 보입니다.
- **역할 파일·CLAUDE.md·메모리**: 프로젝트 폴더 기준입니다.
- **세션 현황**(D-15): 표에는 그 창 프로젝트의 세션만 나옵니다. 이름이 역할 접두사(없으면 pm 역할 이름)로 시작하고 작업 폴더가 저장소이거나 그 아래(worktree)인 세션입니다. 다른 프로젝트의 살아 있는 세션은 표 아래 한 줄로 폴더 이름별 세션 수와 메모리(세션과 그 자식 프로세스 합, 대략)만 보입니다. 이 폴더에서 연 이름 없는 세션(직접 연 대화 등)은 그 앞에 '이 폴더(이름 없음) N개'로 따로 보입니다. 승인 센터·활동 탭도 이 프로젝트 세션만 봅니다. pm 줄도 이 프로젝트 pm만 봅니다. `session.ps1 list`도 같은 기준입니다.

나뉘지 않는 것(주의):
- **세션 간 메시지**: 같은 PC면 프로젝트가 달라도 닿습니다. 메시지는 이름으로 가므로 **역할 접두사는 프로젝트마다 다르게** 줍니다(`AB-`, `CD-`). 메시지 가드는 이 프로젝트 세션(접두사 + 작업 폴더)만 보고 꺼진 대상을 막습니다. 다른 프로젝트에 같은 이름이 살아 있어도 통과시키지 않습니다. doctor는 이 PC의 다른 프로젝트와 겹치는 것(접두사가 같거나 한쪽이 다른 쪽 앞부분, 승인 폴더 이름 `approvals.namespace`가 같음)을 FAIL로 알립니다. `quickstart`·마법사는 겹치지 않는 접두사를 스스로 고릅니다. `--prefix`로 준 값이 겹치면 오류로 멈춥니다(프로젝트 이름이 다른 프로젝트의 승인 폴더 이름과 같아도 오류, `--name`으로 바꿈).
- **인수인계 파일**: `~/.claude/session-data/`는 모든 프로젝트가 함께 씁니다. `session.ps1`(start·`start-pm latest`·pm-cmd)·`/wy-resume-session`·세션 현황 [pm 교체]는 `**Worktree:**` 머리말이 이 저장소(그 아래 worktree 포함)인 파일만 고릅니다. 머리말이 없는 옛 파일은 이름만 맞으면 고릅니다.
- **버전**: `update`·`deploy`는 하나뿐인 `current`를 바꿉니다. 모든 프로젝트의 훅이 `current`를 쓰므로 한꺼번에 바뀝니다(확장은 창을 다시 불러온 뒤). 프로젝트마다 다른 버전을 동시에 돌릴 수는 없습니다. `wyOpsVersion`은 그 프로젝트가 맞춘 버전을 적어 둔 것입니다. 설치본과 다르면 doctor가 WARN으로 알리기만 합니다. `update`는 그 프로젝트의 생성 파일만 다시 만듭니다. 다른 프로젝트는 그 폴더에서 `update`를 따로 실행합니다.
- **메모리(RAM)**: 모든 프로젝트의 세션이 함께 씁니다. 쉬는 프로젝트의 세션은 `session.ps1 stop`으로 멈춥니다.
- **VS Code 창**: 프로젝트마다 창과 pm 세션을 따로 둡니다. 다중 루트 작업 영역은 권하지 않습니다. 확장은 첫 번째 폴더만 보고 나머지 폴더의 카드는 보이지 않습니다.

요약: PC에 `global` 한 번 → 프로젝트마다 `quickstart`나 `init`(접두사 다르게) → 프로젝트마다 창·pm 따로 → 쉬는 쪽은 `stop`.

### 3-5. 다른 PC에서 원격으로 쓰기(호스트·접속 PC)

한 PC(호스트)에서 역할 세션·빌드·브라우저를 모두 돌리고, 다른 PC(접속 PC)는 VS Code Remote-SSH로 붙어 제어만 합니다. 연결은 Tailscale 사설망 위의 OpenSSH(공개키 로그인만)이고 공개 포트는 열지 않습니다. 접속하면 승인 센터·세션 현황은 호스트 쪽에서 돌고, 역할 세션은 VS Code 창을 닫아도 호스트에서 계속 돕니다.

원격은 선택 기능입니다. `host`·`connect`를 실행하지 않으면 원격 설정은 아무것도 바뀌지 않습니다(`global`·`setup`·`quickstart`·`restore`는 이 둘을 부르지 않음). 원격을 쓰지 않는 PC에서 doctor '호스트' 줄은 OpenSSH 서버가 없으면 '해당 없음'(통과)입니다. 모든 PC에 들어가지만 조건이 맞을 때만 움직이는 것은 둘입니다: `session.ps1`의 daemon 점검(로그온 작업 `wy-ops-claude-daemon`이 있을 때만 시작하고, daemon이 ssh 같은 바탕화면이 아닌 로그온일 때만 경고), 원격 창용 껍데기 확장 설치(`~\.vscode-server`가 있을 때만).

호스트(한 번, **관리자 PowerShell**):
1. `<설치> host --dry-run`으로 바꿀 목록을 봅니다(관리자가 아니어도 됨).
2. `<설치> host` → 목록 확인 후 `y`. 하는 일: OpenSSH 서버 설치·자동 시작(Win32-OpenSSH를 winget `Microsoft.OpenSSH.Preview`로 `C:\Program Files\OpenSSH`에. Windows 선택적 기능판이 8.1 미만이거나 실행되지 않으면 먼저 제거. winget이 없으면 MSI 설치 안내), SSH 기본 셸 PowerShell, `sshd_config` 공개키 로그인만(비밀번호 로그인 끔, 고치기 전 백업·`sshd -t` 검사 실패 시 되돌림), `C:\ProgramData\ssh\administrators_authorized_keys` 권한(Administrators·SYSTEM만), 방화벽 OpenSSH 규칙을 Tailscale 대역(`100.64.0.0/10`)만(규칙이 없으면 만들고, 이름이 다른 OpenSSH 허용 규칙도 같은 대역으로 좁힘), 전원 AC 대기·최대 절전 끔(화면 끄기는 그대로), claude daemon 로그온 작업 `wy-ops-claude-daemon`(로그온 때 바탕화면에서 `claude daemon run`, 대화형·일반 권한. 등록만 하고 지금 시작하지 않음 — 아래 'claude daemon은 바탕화면 로그온에서'), 원격 창용 껍데기 확장(`~\.vscode-server\extensions`). 이미 된 것은 건너뛰므로 여러 번 실행해도 됩니다.
3. 자동으로 하지 않는 일은 승인 센터에 할 일 카드로 올라옵니다(프로젝트 폴더 밖에서 실행했으면 출력으로 안내): Tailscale 설치·로그인·Run unattended·이 기기만 키 만료 끔, 자동 로그인(Sysinternals Autologon — 비밀번호를 레지스트리에 평문으로 두는 방식은 쓰지 않음), Windows 업데이트 사용 시간. 이미 된 것(Tailscale 실행·로그인, 자동 로그인 켜짐)은 카드를 올리지 않습니다. 자동 로그인이 레지스트리 평문 비밀번호(`DefaultPassword`)로 켜져 있으면 Autologon으로 바꾸라는 주의가 나옵니다(값은 읽지 않음).

접속 PC(한 번):
1. Tailscale을 설치하고 호스트와 같은 계정으로 로그인합니다.
2. `<설치> connect <별칭> --host <호스트의 Tailscale 이름> [--user <호스트 계정>] [--folder <호스트의 프로젝트 폴더>] [--wake-relay <주소:포트>] [--passphrase]` → 키 생성, `~\.ssh\config` 별칭, Remote-SSH 확장, 접속 PC 소리 확장(`wy-ops.wy-ops-local` — 원격 창의 새 카드 소리를 접속 PC 스피커로, 0.8.4. 버전이 다르면 다시 설치), 바탕화면 바로가기, 호스트 제어 창 바로가기('<별칭> 제어', 아래), VS Code 터미널 shift+enter 줄바꿈(원격 claude 포함. 접속 PC `%APPDATA%\Code\User\keybindings.json` 끝에 `{"key":"shift+enter","command":"workbench.action.terminal.sendSequence","args":{"text":"\u001b\r"},"when":"terminalFocus"}`를 덧붙이고 원본은 `keybindings.json.wy-bak`으로 백업. when에 `terminalFocus`가 든 shift+enter가 이미 있으면 `[이미 됨]`으로 건너뛰고(지우는 항목 `-명령`과 `!terminalFocus`는 치지 않음), 파일을 읽지 못하면 고치지 않고 `[건너뜀]` 줄에 손으로 넣을 항목을 보여 줌(connect는 실패로 치지 않음). 재시작 없이 바로 적용. 이 단축키는 VS Code의 모든 터미널에 걸립니다. Claude가 아닌 PowerShell 터미널에서 shift+enter를 누르면 입력 줄이 지워지고 Enter가 눌립니다. 원치 않으면 keybindings.json에서 그 항목을 지우세요(원본은 keybindings.json.wy-bak). connect는 정식판 VS Code(`%APPDATA%\Code\User`)만 고칩니다. Insiders(`%APPDATA%\Code - Insiders\User\keybindings.json`)나 VSCodium(`%APPDATA%\VSCodium\User\keybindings.json`)으로 접속하면 같은 항목을 그 파일에 직접 넣으세요). 끝에 '호스트에서 실행할 한 줄'이 나옵니다. `--attach`는 더 쓰지 않습니다(주면 무시하고 한 줄 안내, pm 붙기는 세션 현황 pm 줄). `--passphrase`는 키에 암호를 걸고 ssh-agent에 한 번 올립니다.
3. 그 한 줄(`… install.ps1 host --add-key '<공개키>'`)을 호스트의 관리자 PowerShell에서 실행합니다. 같은 키는 다시 넣지 않습니다.
4. `ssh <별칭>`이 비밀번호 없이 되면 끝. 바로가기를 누르면 VS Code가 호스트의 프로젝트 폴더를 엽니다.

매일: 바로가기 → 원격 창 세션 현황 pm 줄의 [붙기](또는 원격 터미널에서 `session.ps1 attach <pm 역할>`) → 카드는 승인 센터 탭에서. 미리보기는 VS Code 포트 탭에서 포워딩해 접속 PC 브라우저의 `localhost`로 봅니다. 재부팅 뒤에는 자동 로그인 → `ssh <별칭>` → 역할 세션을 다시 띄웁니다. doctor의 '호스트' 줄이 sshd·방화벽 범위·Tailscale·전원·daemon 로그온 작업·daemon 로그온 유형·원격 창용 확장을 점검합니다(호스트가 아닌 PC는 '해당 없음').

화면이 작은 접속 PC(터치): 그 접속 PC의 VS Code 사용자 설정(`Ctrl+,` → User 탭 → 'WY Ops', 또는 settings.json)에 `"wyOps.compact": true`를 한 번 넣으면 세션 현황·승인 센터·활동 탭이 큰 버튼·12px 글자로 바뀝니다. 그 PC에서 여는 원격 창(호스트의 모든 프로젝트)과 로컬 창에 모두 걸리고, 호스트에서 직접 연 창이나 다른 접속 PC에는 걸리지 않습니다. 리로드 없이 바로 바뀝니다. 프로젝트마다 `.claude/wy-ops.local.json`에 `ui.compact`를 넣던 예전 방식도 계속 동작합니다(자세히는 `vscode/README.md`).

claude daemon은 바탕화면 로그온에서(0.8.2): 백그라운드 세션은 claude daemon이 띄우고 daemon의 로그온을 그대로 물려받습니다. ssh 키 로그인은 네트워크 로그온(유형 3)이라 거기서 뜬 daemon 아래 세션은 Windows 자격 증명 관리자를 읽지 못해 `git push`·`gh`가 실패합니다. 그래서 호스트는 자동 로그인된 바탕화면 로그온(유형 2)에서 daemon을 띄워 둡니다. `host`가 등록한 로그온 작업이 로그온 때 띄우고, `session.ps1`은 세션을 띄우기 전에 daemon이 없으면 이 작업을 먼저 시작하며 daemon이 바탕화면 로그온이 아니면 경고합니다.
이미 ssh 쪽 daemon으로 세션을 돌리던 호스트를 옮기는 순서:
1. pm에서 진행 중인 것을 저장하고(`/wy-save-session`, short-id는 pm 역할), 지금 돌고 있는 세션 ID를 적어 둡니다(`claude agents`).
2. 호스트에서 `Start-ScheduledTask wy-ops-claude-daemon`.
3. daemon의 로그온 유형을 확인합니다(doctor '호스트' 줄의 'daemon 세션 N·로그온 유형 N' — 유형을 못 읽으면 '?'이고 세션 0이면 주의. daemon이 없으면 'daemon 꺼짐', 작업이 없거나 다르면 'daemon 로그온 작업 없음/설정 다름 — install.ps1 host'. 또는 `~\.claude\daemon.lock`의 pid 프로세스의 로그온 세션). 2(10·11도 됨)면 4로. 3이면 ssh 쪽 daemon이 아직 돌고 있어 작업이 새 daemon을 띄우지 못한 것입니다. `claude daemon stop --any`로 멈추고(**모든 백그라운드 세션이 꺼집니다**) 2를 다시 한 뒤 확인합니다.
4. `session.ps1 start-pm <1의 인수인계 파일>` → `session.ps1 attach <pm 역할>`, 역할 세션은 `session.ps1 start <역할>`로 다시 띄웁니다.

호스트 제어 창(0.8.2, HC-01로 정리): `connect`가 호스트(별칭)마다 바탕화면 '<별칭> 제어' 바로가기를 하나 만듭니다(추가 설치 없는 PowerShell 창, 콘솔 창은 뜨지 않음. 스크립트 사본은 `~\.wy-tools\connect\host-control.ps1`, 패키지를 갱신한 뒤 `connect`를 다시 실행하면 새 사본으로 바뀝니다). 호스트 전원만 다루는 전역 도구라 프로젝트·pm 기능은 없습니다. pm 띄우기·붙기·교체는 각 프로젝트 VS Code 창의 세션 현황 pm 줄에서 합니다(4-2). `connect`를 다시 실행하면 예전 붙기 바로가기('<별칭> <역할>')를 지웁니다.
- 위쪽: 호스트 응답(깨어 있음/응답 없음). 60초마다, 또는 '새로고침'으로 갱신합니다.
- ① 깨우기: 매직 패킷(UDP 9 브로드캐스트). 호스트와 **같은 집 안 네트워크에서만** 닿습니다. MAC·브로드캐스트 주소는 호스트가 깨어 있을 때 상태 확인이 읽어 `~\.wy-tools\connect\<별칭>.json`에 저장하므로, 처음 한 번은 호스트가 깨어 있을 때 창을 열어 두세요. 보낸 뒤 90초 안에 깨지 않으면 안내가 나옵니다.
  - 폰 중계(0.9.1, 집 밖에서 깨우기): 집 와이파이에 상주하는 안드로이드 폰(Tailscale + Termux sshd, 이 PC 공개키 로그인만, 홈 폴더에 매직 패킷을 보내고 `WAKE-SENT`를 출력하는 `wake.py`)이 있으면 `connect`에 `--wake-relay <폰 Tailscale 주소>:<포트>`(예: `100.64.0.9:8022`)를 줍니다. 주소는 이 PC의 `~\.wy-tools\connect\<별칭>.json`(`wakeRelay`)에만 저장됩니다. 그 뒤 ①은 집 안 매직 패킷과 함께 폰에 `ssh -p <포트> -o BatchMode=yes -o ConnectTimeout=10 -o PasswordAuthentication=no <주소> python wake.py`를 따로 돌리고(창은 굳지 않음, 25초 제한) 결과를 '폰이 매직 패킷을 보냈습니다' / '폰에 연결 못 함'으로 적습니다. MAC을 아직 몰라도 폰 경로는 갑니다. 처음 한 번은 터미널에서 `ssh -p <포트> <주소>`로 직접 들어가 폰의 호스트 키를 받아 두세요(BatchMode는 묻지 않고 실패합니다).
- ② 재우기·③ 재부팅·④ 종료: 확인 창을 거쳐 ssh로 보냅니다. 폰 중계를 설정했으면 밖에서도 폰을 거쳐 깨울 수 있어 외출할 때 재워도 됩니다. 설정하지 않았으면 외출할 때는 재우지 마세요(밖에서는 깨울 수 없음). 재부팅하면 모든 Claude 세션이 꺼지므로 다시 켠 뒤 각 프로젝트 창의 세션 현황 [pm 시작]으로 pm을 띄웁니다. 종료 뒤 다시 켤 때는 전원 버튼입니다.
- ssh는 창과 따로 돌고 시간 제한이 지나면 끊으므로, 재우기처럼 응답 없이 끊기는 명령에도 창이 굳지 않습니다. `host-control.ps1 … -DryRun`은 버튼이 명령을 실행하지 않고 아래 기록 칸에 명령만 적습니다.

접속 PC를 바꿀 때(새 PC로 옮기기): 호스트 쪽 설정은 그대로 두고 새 접속 PC에서 다시 연결합니다. 폰 중계와 승인 센터 기기 등록은 접속 PC마다 따로라 함께 다시 합니다.
1. 새 접속 PC에서 위 '접속 PC(한 번)' 1~4를 합니다(Tailscale, `connect`, 호스트에서 `host --add-key` 한 줄, `ssh <별칭>` 확인). 폰 중계를 쓰면 `connect`에 `--wake-relay <폰 Tailscale 주소>:<포트>`도 줍니다.
2. `connect`가 바꿀 목록을 보여 주고 '위처럼 바꿀까요?'를 물으면 `y`를 누릅니다. 여기서 `y`를 하지 않으면 `wakeRelay`가 `~\.wy-tools\connect\<별칭>.json`에 들어가지 않아, 제어 창 깨우기가 폰을 거치지 않습니다.
3. 폰(Termux)의 `~/.ssh/authorized_keys`에 새 접속 PC의 공개키(`~\.ssh\id_ed25519.pub` 한 줄)를 더합니다. 폰은 접속 PC 공개키로만 로그인을 받으므로, 이것이 없으면 새 PC에서 폰에 연결하지 못합니다.
4. 폰에서 Termux를 열고 `sshd`를 켭니다(꺼져 있으면 연결 거부).
5. 새 접속 PC 터미널에서 `ssh -p <포트> <폰 주소>`로 한 번 직접 들어가 폰의 호스트 키를 받아 둡니다. 제어 창은 BatchMode라 처음 보는 호스트 키를 묻지 않고 실패합니다.
6. 제어 창 ① 깨우기를 눌러 아래 기록 칸에 '폰에 깨우기를 부탁하는 중…' 줄이 나오는지 봅니다. 이 줄이 나오면 폰 중계가 켜진 것이고, 이어서 '폰이 매직 패킷을 보냈습니다'가 나오면 정상입니다. 이 줄이 없으면 2의 `y`가 빠진 것이니 `connect`를 다시 실행합니다.
7. 새 PC의 원격 창 승인 센터에서 뿌리 지문을 확인하고 '신뢰하고 등록 요청' → 호스트 로컬 창(또는 등록된 다른 기기)에서 새 PC 창의 '이 기기' 지문과 비교해 승인합니다(자세히는 `vscode/README.md` '기기 신뢰 뿌리 다시 만들기'). 원격 창의 기기 키는 호스트가 아니라 접속 PC에 있어 새 PC는 새 기기입니다. 새 PC에도 이 도구를 설치해 로컬 창을 연 적이 있으면 '고정한 뿌리가 기기 명부의 뿌리와 다릅니다' 경고가 뜹니다. 그 경고의 [고정 초기화](또는 명령 'WY: 기기 신뢰 고정 초기화')를 한 뒤 등록을 요청합니다. 고정은 호스트마다 따로라, 원격 창에서 초기화해도 새 PC 로컬 창의 고정은 그대로입니다.
8. 옛 접속 PC를 더 쓰지 않으면 승인 센터 '기기' 목록에서 그 기기(원격 창 <옛 PC id>)를 신뢰 해제하고, 폰 `authorized_keys`와 호스트 `administrators_authorized_keys`에서 옛 PC 공개키 줄을 지웁니다.

호스트 브라우저 보기·자동화(0.8.0 실측):
- 호스트의 전용 Chrome(원격 디버깅 9222)을 접속 PC에서 보려면 접속 PC 쪽은 **다른 포트**로 받습니다: `ssh -N -L 19222:localhost:9222 <별칭>` → 접속 PC Chrome의 `chrome://inspect`에 `localhost:19222`를 추가. 접속 PC에서 `-L 9222:…`로 같은 번호를 쓰면 `bind … Permission denied`로 실패할 수 있습니다.
- 모니터 없는 호스트는 화면이 1024×768로 잡힙니다. 브라우저 자동화(agent-browser 등)는 실행할 때 뷰포트 크기를 지정합니다(예: 1440×900). 화면 해상도는 바꾸지 않아도 됩니다.
- 집 밖에서 호스트를 깨우는 일(Wake-on-LAN 중계)은 선택이며 호스트와 같은 망에 상주 장치가 필요합니다(제어 창은 위 '폰 중계'). 없으면 외출할 때 호스트를 재우지 않습니다.

끊긴 SSH 접속이 남기는 프로세스(0.10.0): Remote-SSH 접속 하나마다 호스트에 PowerShell 3단과 VS Code 실행기 묶음(약 310MB)이 생깁니다. 접속이 끊겨도 Windows는 이 묶음을 끄지 않아 쌓입니다. 접속 PC의 SSH 로그인이 관리자라 묶음도 관리자 소유이고, 일반 세션은 끄지 못합니다. `templates/connect/ssh-orphans.ps1`이 묶음을 판정합니다. 다음 묶음은 남깁니다: 살아 있는 접속 아래, 지금 VS Code 서버(`~/.vscode-server/cli/servers/*/pid.txt`)를 품은 것, 가장 최근의 에이전트 호스트 관리 프로세스, 껍데기 말고 일하는 프로세스가 있는 것, 30분이 안 된 것(`-MinAgeMinutes`). 나머지만 정리 후보로 냅니다. doctor '호스트' 줄과 세션 현황 프로세스 블록에 후보 수·MB가 보입니다. 세션 현황(0.11.0)은 SSH 원격 창처럼 관리자 권한으로 돈 창에서 그 줄 옆 [정리]로 바로 끄고, 후보를 보면 10분에 한 번까지 저절로도 끕니다(같은 스크립트·같은 규칙, 끄기 직전 다시 판정, 결과는 한 줄로). 호스트에서 직접 연 일반 권한 창에는 [정리]가 없고 자동 정리도 하지 않습니다. `install.ps1 host`를 하지 않은 PC(SSH 기본 셸이 Windows PowerShell이 아님)에는 줄·버튼·자동 정리가 모두 나오지 않습니다. 자동 정리용 판정은 세션 현황이 떠 있는 동안 10분마다 돕니다(프로세스 블록을 접어 두거나 다른 탭을 보고 있어도). 줄 표시용 60초 판정은 블록을 펼쳤을 때만 돕니다. VS Code 창을 닫으면 자동 정리도 멈춥니다. 바로 정리하려면 호스트의 관리자 PowerShell에서 `& "$env:USERPROFILE\.wy-tools\wy-ops\current\templates\connect\ssh-orphans.ps1" -Stop`을 실행합니다. 인수 없이 실행하면 판정만 하고 끄지 않습니다. 부모가 없다는 것만 보고 끄면 지금 쓰는 서버까지 끄게 되므로 직접 끄지 않습니다.

---

## 4. 매일 쓰기

### 4-1. 승인 센터

카드 네 가지:

| 카드 | 언제 뜨나 | 무엇을 누르나 |
|---|---|---|
| 권한 요청 | 백그라운드 세션이 실행 허락을 기다릴 때 | **이번 한 번 허용** 또는 **거부**(사유 필수). 15분 안에 안 누르면 자동 거부 |
| 결정 요청 | 세션(주로 pm)이 방향을 물을 때 | 질문마다 선택지를 고르고 **응답 전송**. '추천' 표시, 선택지마다 대가가 적혀 있음. '기타'에 직접 써도 됨 |
| 할 일 | 사람이 직접 해야 할 일(설정 수정, 외부 콘솔, 직접 실행) | 단계를 따라 한 뒤 **완료**. 메모에 결과를 적으면 세션이 그에 맞춰 이어 감 |
| git | 커밋·푸시·병합 등 | **승인** 또는 **거부**(사유 필수). 바뀐 파일·검증 결과를 보고 판단 |

카드마다 '무엇을'·'왜'·'누르면 무슨 일'이 있습니다. 이 세 칸이 빈 요청은 **형식 오류** 카드로 뜨고 처리 버튼이 없습니다.

할 일 카드 쓰는 법:
- 단계 목록을 눌러 체크하며 따라 합니다(진행 막대는 기억용).
- 메모 예: '실행함', '실행 안 함 — 필요 없어 보임', 오류 메시지 붙여넣기.
- 분류기가 막은 명령 카드는 대부분 실행하지 않아도 됩니다. 판단이 어려우면 메모에 '실행 안 함'을 적고 **완료**.
- 명령 블록이 두 개면 위가 PowerShell에 붙여 넣을 형태, 아래가 원래 명령(Bash)입니다(4-4 참고).

카드를 처리하면 그 카드를 올린 세션이 **스스로 깨어나** 결정을 읽고 이어 갑니다(0.7.2, Stop 훅 `wy-decision-wake.js`). 세션에 Monitor 감시를 걸어 둘 필요가 없고, 리로드·VS Code 재시작 뒤에도 그 세션의 다음 턴부터 다시 동작합니다. 세션이 꺼져 있을 때만 pm이 다시 띄워 전합니다. 자세한 동작은 `vscode/README.md`의 '자동으로 깨어남'.

거부 사유는 세션에 그대로 전달됩니다. '무엇이 문제인지 + 어떻게 하면 되는지'를 한 줄로 씁니다. 예: '테스트 결과가 없음 — 테스트를 돌린 뒤 다시 요청'.

단축키(승인 센터 탭에 포커스가 있을 때):

| 키 | 하는 일 |
|---|---|
| `j` / `k` | 다음·이전 카드 |
| `a` | 처리(승인·허용·응답 전송·완료) |
| `x` | 거부 |
| `1`~`9` | 결정 요청 카드의 선택지 고르기 |
| `Enter` / `Esc` | 열기 / 목록으로·취소 |
| `w` | '왜' 펼치기 |
| `g` `a` | 활동 탭 |
| `?` | 단축키 안내 펼치기·접기 |

### 4-2. 세션 현황(사이드바)

**pm 줄(세션 표 바로 위, 0.10.0·0.10.1에서 자리 옮김).** pm은 아래 표에 나오지 않고 여기에만 보입니다. 이름 옆 작은 글씨는 '개발 총괄'(원격 창이면 '호스트 <PC 이름>'), 오른쪽은 경과 시간(멈췄으면 멈춘 시각).

| pm 상태 | 보이는 것 | 버튼 |
|---|---|---|
| 실행 중 | 작업 중·입력 대기, 컨텍스트 막대(토큰, 기준 선 = `rotation.contextTokens`) | [붙기] [pm 교체] [멈춤] |
| 교체 권장 | 실행 중과 같은 상자에 이름 옆 '교체 권장' 배지만(0.10.2) | 실행 중과 같음 |
| 권한 승인 대기 | 빨간 상자, 기다리는 도구 한 줄 | [붙어서 답하기] [멈춤](교체는 숨김: 답하지 않은 권한 창이 사라지므로) |
| 멈춤 | 멈춘 시각 또는 '아직 시작하지 않음' | [pm 시작](`session.ps1 start-pm latest`, 60초 안에 안 뜨면 오류와 [기록 보기]) |
| 교체 중 | 네 단계 진행(2-4) | 없음 |
| pm 둘 | 교체가 반만 된 상태 | [이전 pm 멈춤] [붙기] |

- **[붙기]**: 통합 터미널 'AB-pm 붙기'에서 `session.ps1 attach AB-pm`(그 터미널이 살아 있으면 새로 만들지 않고 보여 줌). 붙을 때마다 확장 로그 `pm-control.log`에 '붙기: <pm> <폴더>'를 남깁니다. 터미널을 닫아도 pm은 계속 일합니다.
- **[멈춤]**: 확인 창(Enter·Esc는 취소) 뒤 `session.ps1 stop AB-pm`. 대화는 남아서 [pm 시작]으로 이어집니다. 다른 역할 세션과 승인 카드는 그대로입니다.

역할 세션 표:

| 상태 | 뜻 | 할 일 |
|---|---|---|
| 권한 승인 대기 | 권한 요청 창을 기다림. 기다리는 명령이 함께 보임 | 승인 센터의 권한 요청 카드를 처리 |
| 작업 중 | 일하는 중 | 없음 |
| 입력 대기 | 일을 마치고 다음 지시를 기다림 | pm이 지시하면 됨 |
| 종료됨 | 중지됨·정상 종료·오류 종료(작은 글씨로 이유) | pm이 `session.ps1 start`로 재시작 |
| 미실행 | 역할 표에는 있지만 아직 시작하지 않음 | 필요할 때 시작 |

- 정렬: 권한 승인 대기 → 작업 중 → 입력 대기 → 종료됨 → 미실행. 종료됨·미실행은 아래에 접혀 있음.
- **열기**: 백그라운드 세션에 직접 들어갑니다(새 터미널에서 `claude attach`). 승인 센터로 안 되는 일(긴 대화, 직접 확인)이 있을 때만 씁니다. 들어갔다 나온 커밋 역할 세션은 pm이 세션 교체(rotate)합니다.
- 주황 '미전달 메시지 n건': 종료된 세션에 누가 메시지를 보내려다 막혔습니다. pm에 알려 재시작하게 합니다. '확인'을 누르면 표시가 사라집니다.
- '역할 누락' 경고: 그 세션이 역할 파일 없이 시작했습니다. 커밋 역할 세션이면 커밋이 막히므로 pm이 세션 교체합니다.

### 4-3. 활동 탭

보기 세 가지(위쪽에서 고름):
- **스레드**(기본): 작업 하나(지시 → 보고 → 커밋 …)를 카드 한 장으로. 요약을 누르면 원문이 펼쳐집니다.
  - 진행 중(권한 대기·내 차례 포함)인 스레드만 보입니다. 최근에 움직인 순서
  - 끝난 스레드는 빠집니다. 끝남은 [완료]·재검증 통과로 정하고, 그 뒤에 머리표 없는 확인 회신('잘 받았습니다' 등)이 붙어도 끝난 채로 둡니다. [결함]·[차단]·[결정 요청]·커밋 요청·재검증이 붙으면 다시 진행 중으로 나타납니다(0.11.1)
  - 2시간 넘게 메시지가 없는 진행 중 스레드(유휴)도 빠집니다(답이 필요 없는 알림 등). 새 메시지가 붙으면 다시 나타납니다. 권한 대기·대기 카드가 걸린 스레드는 남습니다. 빠진 스레드의 메시지는 피드에서 봅니다(0.11.2)
- **피드**: 세션끼리 주고받은 메시지를 최신순으로
- **시간**(창이 넓을 때만): 세션별 가로줄에 일한 구간과 메시지 화살표. 1·3·12시간 중 고름. 화살표를 누르면 원문

세션 칩(맨 위 줄)을 누르면 세션 현황에서 그 세션을 보여 줍니다.

### 4-4. Bash와 PowerShell 명령 구분

- VS Code 터미널은 보통 PowerShell입니다. Bash 명령(`rm -rf`, `&&` 줄, `for … do … done`)을 붙여 넣으면 문법 오류가 납니다.
- 카드에 'Bash 명령'이라고 적혀 있으면 Git Bash 창에 붙여 넣거나, 카드의 'PowerShell에 붙여 넣을 형태'를 씁니다.
- PowerShell 명령은 Git Bash에서 실행되지 않습니다.

---

## 5. 명령 모음

설치 명령(`<설치> <명령>`, 프로젝트 폴더에서):

| 명령 | 언제 | 예시 |
|---|---|---|
| `doctor` | 뭔가 이상할 때 먼저. 읽기만 함 | `<설치> doctor` (`--json`, `--todos`는 남은 손일을 할 일 카드로) |
| `trust` | 폴더 사용 허락을 `~/.claude.json`에 기록(설치 마법사 6단계, 3-0) | `<설치> trust --project <폴더>` (`--check`는 확인만) |
| `update` | 운영 도구를 새 버전으로. 패키지 저장소를 pull(확인)하고 설치본을 갱신한 뒤 생성 파일을 다시 만듦. 사람이 고친 생성 파일은 덮지 않고 차이만 보여 줌. 생성 파일을 갱신한 뒤 `.claude/settings.json`의 표준(`enabledPlugins` 끄기·`skillOverrides`·`disableClaudeAiConnectors`·`worktree.bgIsolation`·`autoCompactWindow`)에서 비어 있는 키만 채움(`.bak-<시각>`). 이미 적힌 값은 바꾸지 않고, 표준과 다르면 '다름: 키 · 기존 · 표준'으로 알림. `--dry-run`도 pull·deploy는 하고, 생성 파일·settings에서 바꿀 것만 보여 줌. 미리 보기만 하려면 `--no-deploy`를 함께 씀 | `<설치> update` (미리 보기 `--dry-run --no-deploy`, pull 생략 `--no-pull`) → Reload |
| `detect` | 폴더를 보고 알아낸 스택·검증 명령 미리 보기. 읽기만 함. 설정에 `verify`가 있으면 그 값을 보여 줌 | `<설치> detect` (`--project <폴더>`, `--json`) |
| `detect --apply` | 폴더를 다시 보고 `wy-ops.json`의 비어 있는 `verify` 키를 채우고 `detected`·`tools`·`stackNotes`를 바꿈(옛 `stack` 키는 지움, 다른 키 그대로, 바꿀 때 `.bak-<시각>`을 남김). 이미 적힌 검증 명령은 그대로 두고, 판정과 다르면 '다름: 키 · 기존 · 판정'으로 알림(바꾸려면 `verify`를 직접 고침). 바꾸기 전·뒤 검증 명령과 CLAUDE.md에 넣을 목록을 보여 줌. 알아낸 것이 없거나 채울 것이 없으면 바꾸지 않음. 빈 폴더에 설치한 뒤 코드가 생겼을 때 씀 | `<설치> detect --apply` (`--project <폴더>`) → `<설치> gen` |
| `gen` | `.claude/ops`의 역할 원본·pm-ops 부록을 고친 뒤 역할 파일·스킬 다시 만들기 | `<설치> gen` |
| `deploy` | 설치본만 패키지 저장소의 HEAD로 갱신. `--dev`는 작업 사본을 바로 연결(개발용) | `<설치> deploy` |
| `rollback` | 새 버전에 문제가 있을 때 이전 버전으로. `rollback --list`로 설치본 목록(*가 지금 쓰는 것), `rollback <버전 폴더>`로 특정 버전 | `<설치> rollback` → Reload |
| `export` / `import` / `restore` | 개인 상태 옮기기([NEW-PC.md](NEW-PC.md) 3장) | `<설치> export --out D:\move.zip` |
| `quickstart` | 한 줄 설치: 이 PC 설치 + 프로젝트 붙이기 + 로그인·신뢰 안내 + 점검 요약(3-0b). 설치본이 있으면 다시 배포하지 않고, clone이 더 새로우면 `deploy` 안내만 함 | `C:\tools\wy-ops\install.ps1 quickstart` |
| `global` / `setup` / `init` | 설치를 단계별로 직접(3-1~3-3) | — |
| `host` | 이 PC를 원격 호스트로(관리자 PowerShell, 3-5). `--dry-run`은 목록만. `--add-key`는 접속 PC 공개키 등록 | `<설치> host`, `<설치> host --add-key 'ssh-ed25519 AAAA… 주석'` |
| `connect` | 접속 PC 준비: 키·ssh 별칭·Remote-SSH·바로가기·호스트 제어 창(3-5) | `<설치> connect <별칭> --host <Tailscale 이름>` |

rollback은 설치본(current)만 바꿉니다. 껍데기 확장 내용이 다른 버전이면 확장도 다시 깝니다. 버전 없이 두 번 하면 더 옛 버전이 아니라 최신과 직전 사이만 오가니, 더 옛 버전은 이름을 주세요. 프로젝트의 생성물(.claude/agents·skills)은 되돌리지 않으니 템플릿이 바뀐 배포를 되돌렸다면 `<설치> gen`을 다시 하세요.

프로젝트에 공통 문구 틀 `.claude/ops/agent.md`(8장)를 두었으면, `update`는 그 파일을 바꾸지 않으므로 패키지 틀(`templates/agent.md`)의 새 문구가 들어가지 않습니다. 순서: `<설치> update` → 패키지 `templates/agent.md`와 비교해 `.claude/ops/agent.md`와 `CLAUDE.md`를 손으로 고침 → `<설치> gen`(역할 파일 다시 만들기) → 떠 있는 역할 세션을 다시 띄움(`rotate`). `.claude/settings.json`의 플러그인 끄기(`enabledPlugins`) 등 표준 값은 `update`가 빈 키만 채우므로 `init`을 다시 할 필요는 없습니다.

0.13.0으로 올린 뒤 각 프로젝트에서 `<설치> setup`을 한 번 실행하세요(승인 보호 deny 줄 2개 추가). 실행 전에는 doctor 'deny 줄'이 실패로 나옵니다.

공통 옵션: `--yes`(확인 없이 진행), `--project <폴더>`, `--skip-extension`, `--skip-extras`(함께 까는 도구 건너뜀), `--skip-install`(없는 도구를 설치하지 않고 알리기만).

세션 명령(pm이 주로 씀, 프로젝트 루트에서 `.claude\skills\pm-ops\scripts\session.ps1`):

| 명령 | 언제 | 예시 |
|---|---|---|
| `list` | 역할 세션 목록과 상태 | `… session.ps1 list` |
| `health` | 컨텍스트 확인(10만 토큰 이상이면 세션 교체 권장, `rotation.contextTokens`). pm 줄이 맨 위 | `… session.ps1 health` |
| `start` | 역할 세션 시작(종료된 세션은 재시작. 컨텍스트가 세션 교체 기준 이상이면 재시작하지 않고 `rotate`를 권함, `-Force`로 강행) | `… session.ps1 start AB-qa "로그인 화면 검증"` |
| `stop` | 쉬는 세션 멈추기(메모리 반납, 트랜스크립트는 남음). pm도 됨(세션 현황 [멈춤]) | `… session.ps1 stop AB-qa` |
| `prep` | 세션 교체 준비: 진행 중인 것만 저장하라고 지시 | `… session.ps1 prep AB-backend1` |
| `rotate` | 컨텍스트가 길어진 세션을 새 세션으로 교체 | `… session.ps1 rotate AB-backend1 none` |
| `pm-cmd` | pm 자신의 세션 교체 순서 출력(start-pm → 이전 pm 종료 → attach) | `… session.ps1 pm-cmd [경로]` |
| `start-pm` | pm을 백그라운드 세션으로 띄우기(인수인계 경로·pm-ops 스킬·ListAgents 확인을 시작 지시로). `latest`는 가장 최근 pm 인수인계(없으면 없이, 세션 현황 [pm 시작]·마법사가 씀). 이미 돌면 거부, 세션 교체 중엔 `-Force` | `… session.ps1 start-pm latest`, `… start-pm <경로> -Force` |
| `adopt` | 닫은 VS Code 세션의 대화를 백그라운드 역할 세션으로 옮기기 | `… session.ps1 adopt AB-qa <세션ID>` |
| `pin` / `unpin` | 실행 중인 세션을 메모리 부족 정리에서 빼기 / 되돌리기 | `… session.ps1 pin AB-commit` |
| `attach` | 실행 중인 역할 세션(pm 포함)에 붙기. 원격 터미널에서 쓰고, 빠져나와도 세션은 계속 돎 | `… session.ps1 attach AB-pm` |
| `wt-clean` | 역할 worktree 지우기(2-6). 실행 중·미커밋·미병합이면 멈춤, 가지는 남김 | `… session.ps1 wt-clean AB-qa` |

`start`·`rotate`·`prep`·`adopt`·`start-pm`은 여유 메모리가 `memory.blockFreeMB`(기본 500MB) 미만이면 세션을 띄우지 않습니다. `-Force`는 이 관문과 함께 세션 교체 기준(`start`)과 실행 중인 pm 확인(`start-pm`)도 넘깁니다.

역할 worktree를 켠 프로젝트에서 `start`·`rotate`·`prep`·`adopt`는 역할 세션을 그 역할의 worktree에서 띄웁니다(2-6).

---

## 6. 문제가 생겼을 때

| 증상 | 원인 | 할 일 |
|---|---|---|
| 'Workspace not trusted'로 세션이 시작되지 않음 | 그 폴더를 Claude Code가 신뢰하지 않음 | 그 폴더 터미널에서 `claude` → Yes → `/exit`. VS Code 작성자 신뢰로는 안 됨 |
| 카드가 안 뜸 | 다른 프로젝트 창을 보고 있음 / 확장이 아직 안 실림 / 훅 경로가 틀림 | 그 프로젝트 창인지 확인 → `Developer: Reload Window` → `doctor`에서 '훅'·'확장' 확인 |
| 권한 요청 카드가 사라지고 세션이 '거부됨'을 받음 | 15분 안에 처리하지 않아 자동 거부 | 정상 동작. 필요하면 세션에 다시 하라고 지시(pm) |
| '형식 오류' 카드 | 요청 파일에 필수 칸(무엇을·왜·누르면)이 빠짐 | 처리할 수 없음. 요청한 세션(카드에 이름이 있음)에 다시 올리라고 pm에 알림 |
| WY Ops 아이콘·승인 센터가 안 뜸 | 확장이 설치본을 못 찾음 | `doctor` → '설치본'이 FAIL이면 `<설치> setup` → Reload. 그래도 안 되면 `<설치> rollback` → Reload |
| doctor '개발 연결 중' | `deploy --dev`로 작업 사본을 연결해 둠 | 개발 중이면 정상. 풀려면 `<설치> deploy` |
| doctor '공용 워킹트리' 주의 | `.claude/settings.json`에 `worktree.bgIsolation`이 없음(0.13.0 전에 `init`한 프로젝트). 백그라운드 역할 세션이 공용 워킹트리 파일을 고치지 못함 | doctor 안내대로 `init`(또는 `update`)을 다시 실행하거나, 사용자가 `.claude/settings.json`에 `"worktree": { "bgIsolation": "none" }`을 넣음 → 역할 세션을 다시 띄움 |
| doctor '검증 명령' 주의 | `wy-ops.json`의 `verify`가 비었거나, `{ 폴더: 명령 }`의 폴더가 없음 | `<설치> detect --apply`로 다시 알아내 채움(`.claude/wy-ops.json`의 `verify`를 직접 고쳐도 됨) → `<설치> gen` |
| doctor '버전 고정' 주의 | 설치본 버전이 `wy-ops.json`의 `wyOpsVersion`과 다름 | 프로젝트가 정한 버전으로 맞추거나(`update`·`rollback`), 사용자가 `wyOpsVersion`을 고침 |
| 공백·한글 경로 경고 | 홈·저장소 경로에 공백·한글 | 동작은 하지만 문제가 생기면 `doctor` 결과를 pm에 전달 |
| 붙여 넣은 명령이 'unexpected token' | Bash 명령을 PowerShell에 붙여 넣음 | 4-4 참고. Git Bash에서 실행하거나 PowerShell 형태를 씀 |
| 커밋이 'agent_type'으로 막힘 | 커밋 역할 세션이 역할 없이 시작함(직접 들어갔다 나온 경우 등) | pm이 `session.ps1 rotate AB-commit none` |
| git 카드가 '형식 오류'로 뜸 | `kind`가 정해진 목록에 없음(`pr`·`pr-merge` 같은 이름) | PR 만들기는 `push`, PR 병합은 `merge`로 다시 올림. 목록은 [vscode/README.md](vscode/README.md) '요청 형식' |
| 결정을 기다리는 세션이 메시지에 답하지 않음 | 결정 파일을 포그라운드 셸 루프로 기다려 세션이 묶임 | 기다리지 말고 턴을 끝냄. 결정이 오면 훅이 세션을 깨움(4-1). 결정 파일은 지워지지 않으니 나중에 읽어도 됨 |
| 카드를 처리했는데 세션이 깨지 않음 | 세션이 꺼져 있음, 0.7.2 설치(`setup`) 전에 뜬 뒤 턴이 없었음, 요청의 `session`이 세션 이름과 다름 | `doctor`로 훅 확인. 꺼진 세션은 pm이 `session.ps1 start`로 전함. 그 세션에 아무 메시지나 보내 한 턴을 돌리면 다음부터 깨어남 |
| `start`에 지시를 붙였더니 같은 이름 세션이 둘 | 옛 세션이 아직 살아 있을 때 대화를 이어 띄워 사본이 생김 | `session.ps1 list`로 확인하고 하나를 `stop`. 지시는 붙이지 말고 '시작' 회신을 받은 뒤 `SendMessage`로 보냄 |
| `git lfs`·git 별칭이 승인 가드에 막힘 | 내장이 아닌 하위 명령·별칭은 무엇을 실행할지 판단할 수 없어 모든 역할에서 거부(커밋 역할 포함) | 정식 하위 명령(`git commit`·`git push` …)으로 따로 씀. git lfs 저장소는 아직 지원하지 않음 |
| 설치 명령이 승인 가드에 막힘 | 명령에 `~/.wy-tools` 경로가 들어 있어 가드가 설치본 쓰기로 봄 | 패키지 clone 폴더에서 `node lib/install.js <명령> --project <프로젝트 폴더>`로 실행 |
| `start`가 '승인 가드 훅이 없어 띄우지 않습니다' | 본 저장소 `settings.local.json`에 승인 가드 훅이 없거나 worktree로 복사하지 못함(2-6) | 프로젝트 폴더에서 `<설치> setup` → 다시 `start` |
| `start-pm`이 'settings.local.json이 없어 승인 가드 훅 없이 뜹니다' 경고 | 본 저장소 `.claude/settings.local.json`이 없음(setup 전). pm은 경고만 하고 승인 가드 없이 뜸(역할 `start`는 이때 띄우지 않음) | 프로젝트 폴더에서 `<설치> setup` → pm 교체(세션 현황 [pm 교체])로 가드가 걸린 pm을 다시 띄움 |
| `start`가 'worktree 폴더가 있는데 git worktree 목록에 없습니다' | 지운 흔적 폴더가 남음 | 그 폴더 안 파일을 확인해 옮기거나 지우고 `git worktree prune`(사용자) → 다시 `start` |
| `start`가 '기준 가지를 알 수 없습니다' | 본 워킹트리가 가지에 있지 않음(detached) | 본 워킹트리를 가지로 돌리거나 `wy-ops.json`에 `worktree.base`를 적음(사용자) |
| `start`가 '빨리감지 못했습니다' 경고 | 그 역할 가지에 아직 병합되지 않은 커밋이 있음 | 세션은 그대로 뜸. 커밋 역할이 병합하면 다음에 띄울 때 맞춰짐 |
| `start`가 '의존성 설치 실패' | `deps` 폴더의 `npm ci` 실패 | 그 worktree 폴더에서 `npm ci`를 돌려 원인을 봄 |
| doctor '역할 worktree' 주의 | 흔적 폴더·역할이 아닌 worktree·잠긴 worktree·폴더 없는 등록·`worktree-*` 가지, 처음 만들기 전 미커밋 변경, 프로젝트 `agent.md`에 `{{treeRules}}` 없음 | 그 줄의 '고치기'를 따름 |
| 역할 세션이 다른 세션이 고친 파일을 못 봄 | 역할 worktree는 기준 가지에 병합된 것만 받음 | 그 파일을 커밋·병합한 뒤 세션을 다시 띄움(2-6) |
| 재부팅 뒤 세션 현황이 모두 '종료됨' | 백그라운드 세션은 PC를 끄면 함께 꺼짐 | 정상. 필요한 세션만 `start`. 컨텍스트가 크면 `rotate` |

---

## 7. 지켜야 할 규칙(요약)

- **사람 손이 필요한 일은 카드로.** 세션은 대화창으로 묻지 않고 승인 센터 카드로 올립니다. 대화창으로 되묻는 일이 생기면 결함입니다.
- **설정 파일은 사람이 고친다.** `.claude/wy-ops.json`, `wy-ops.local.json`, `settings.local.json`은 세션이 고치지 못하게 막혀 있습니다. 바꿀 일이 있으면 할 일 카드로 오고, 사용자가 직접 고치거나 설치 명령을 실행합니다.
- **커밋·푸시는 커밋 역할 세션만.** 다른 세션은 커밋을 요청만 합니다. 커밋·푸시도 매번 승인 카드를 거칩니다(자동 승인 없음).
- **승인 파일은 아무도 손으로 고치지 않는다.** 승인 폴더(`~/.claude/wy-approvals/<프로젝트>/`)의 결정·사용 기록은 확장과 훅만 씁니다.
- **비밀값은 저장소·묶음·카드에 넣지 않는다.** 비밀값 폴더(`secretsDir`)는 저장소 밖에 두고 손으로 옮깁니다.

자세한 규칙은 프로젝트 `CLAUDE.md`의 '세션 역할'·'개발 총괄과 보고'·'커밋'·'세션 교체(rotate)'를 봅니다.

---

## 8. 역할 바꾸기

역할 파일(`.claude/agents/<역할>.md`)과 pm-ops 스킬(`.claude/skills/pm-ops/`)은 **생성물**입니다. 원본을 고치고 `<설치> gen`으로 다시 만듭니다.

| 바꿀 것 | 고칠 원본 |
|---|---|
| 한 역할의 담당 범위·작업 방식 | `.claude/ops/roles/<역할>.md`(맨 위 `description:` 줄 + 본문) |
| 모든 역할에 들어가는 공통 문구 | `.claude/ops/agent.md`. 없으면 패키지 기본 틀(`templates/agent.md`)을 씁니다. 바꾸려면 그 파일을 이 경로로 복사해 고칩니다 |
| pm 운영 절차의 이 프로젝트 부록 | `.claude/ops/pm-ops.project.md` |
| 역할 이름·수·요약, 검증 명령, 문서 경로 | `.claude/wy-ops.json`(`roles`·`verify`·`docs`). 세션은 고치지 못하게 막혀 있어 사람이 고칩니다 |
| 역할 worktree 켜고 끄기·대상 역할·의존성 설치 폴더 | `.claude/wy-ops.json`의 `worktree`(2-6) |
| 원격 접속 때 호스트에서 열 프로젝트 폴더(선택) | `.claude/wy-ops.json`의 `remote.hostFolder`(예: `"remote": { "hostFolder": "C:\\work\\myproject" }`). `connect`에 `--folder`가 없으면 이 값을 씁니다 |

고친 뒤:
1. 프로젝트 폴더에서 `<설치> gen`.
2. `CLAUDE.md`의 역할 표가 달라졌으면 손으로 맞춥니다(`init`이 만든 절은 자동으로 고치지 않음).
3. 이미 떠 있는 세션은 옛 역할 파일을 싣고 있습니다. `rotate`로 바꿔야 새 내용이 적용됩니다.

역할 더하기:
1. `wy-ops.json`의 `roles`에 항목을 더합니다. 예: `{ "name": "AB-qa2", "summary": "사용성·기능 테스트(두 번째)", "agent": true, "group": "qa", "template": "qa" }`.
2. `.claude/ops/roles/AB-qa2.md`를 만듭니다. 같은 역할의 원본을 복사하거나, 패키지 `templates/roles/<짧은 이름>.md`에서 시작합니다.
3. `<설치> gen` → `CLAUDE.md` 역할 표에 한 줄 → `session.ps1 start AB-qa2`.

역할 빼기: `roles`에서 지우고 `gen`. `gen`은 옛 파일을 지우지 않으므로 `.claude/agents/<역할>.md`와 `.claude/ops/roles/<역할>.md`를 직접 지웁니다. 떠 있던 세션은 `stop`합니다. 역할 worktree가 있었으면 `session.ps1 wt-clean <역할>`로 지웁니다.

담당 영역 바꾸기: 여러 개로 나눈 역할의 영역은 역할 원본 끝 '담당 영역' 절에 글로 들어 있습니다. 그 절과 `description:` 줄, `wy-ops.json`의 `area`·`summary`를 함께 고치고 `gen`합니다. 같은 역할의 다른 세션 원본에도 상대 영역이 적혀 있으니 같이 고칩니다.

**생성물을 직접 고치지 않는 이유:** `init`·`update`·`gen`은 만든 파일의 해시를 `.claude/wy-ops.lock.json`에 남깁니다. 다음 `update` 때 해시가 다른 파일(사람이 고친 파일)은 덮지 않고 차이만 보여 줍니다. 그러면 그 파일은 패키지 개선을 더는 받지 못합니다. 고친 내용도 다음 `gen`에서 사라집니다.

---

## 9. 구조 한눈에

```
패키지 clone (예: C:\tools\wy-ops)        코드를 고치고 커밋하는 곳
   │  deploy (커밋된 HEAD를 꺼냄)
   ▼
설치본 ~/.wy-tools/wy-ops/<버전>-<커밋>/   최근 3개 버전을 남김
       ~/.wy-tools/wy-ops/current        → 지금 쓰는 버전(정션). 훅·확장은 이 경로를 씀
   │  init / setup / gen / update
   ▼
프로젝트 폴더
   .claude/wy-ops.json          프로젝트 설정(역할·세션 교체 기준·승인 namespace·문서 경로). 사람이 고침
   .claude/wy-ops.local.json    이 PC만의 덮어쓰기(선택)
   .claude/ops/                 역할 원본·pm-ops 부록 (사람이 고침)
   .claude/agents/, skills/     생성물 (gen이 만듦)
   .claude/wy-ops.lock.json     생성물 해시
   .claude/settings.local.json  훅 6종 연결 (setup이 넣음)
   .claude/worktrees/<역할>/    역할 worktree(가지 wt/<역할>, git에 넣지 않음, 2-6)
   │  카드 요청·결정
   ▼
승인 폴더 ~/.claude/wy-approvals/<namespace>/
   requests/<id>.json    세션이 쓰는 카드 요청
   decisions/<id>.json   승인 센터가 쓰는 결정
   decisions.log         결정마다 한 줄(pm이 감시)
   used/<id>.json        승인으로 명령을 한 번 실행했다는 표시(가드 훅)
기기 명부 ~/.claude/wy-approvals/.trust/   호스트에 하나(모든 프로젝트 공통). 승인 센터가 씀
```

VS Code 확장(`wy-ops.wy-ops`)은 `current`를 읽는 얇은 껍데기입니다. 버전이 바뀌어도 다시 설치하지 않고 `Developer: Reload Window`만 합니다.

---

## 10. 패키지 고치기·배포(개발자용)

### 10-1. 흐름

1. **clone에서 고칩니다.** 설치본(`~/.wy-tools`)은 고치지 않습니다. 가드 훅이 막고, 다음 `deploy`에 덮입니다.
2. **시험합니다.** npm 의존성은 없고 시험 파일을 node로 하나씩 돌립니다. 모두 돌리려면 clone 폴더에서(PowerShell):
   ```powershell
   Get-ChildItem *.test.js, test\*.test.js, vscode\test\*.test.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE) { "실패: $($_.Name)" } }
   ```
   시험은 임시 폴더·가짜 명령으로 돌고 실제 홈 폴더와 설치본은 건드리지 않습니다.
3. **커밋합니다.** `deploy`는 작업 사본이 아니라 커밋된 HEAD를 꺼냅니다. 커밋하지 않은 수정은 설치되지 않습니다.
4. **설치본을 갱신합니다.** `<설치> deploy`. 커밋 없이 바로 써 보려면 `deploy --dev`(current가 clone을 직접 가리킴, doctor가 '개발 연결 중'으로 알림). 끝나면 `deploy`로 풉니다.
5. **프로젝트마다 생성물을 맞춥니다.** 역할 틀·스킬이 바뀌었으면 `<설치> update --no-pull`(생성 파일 다시 만들기) 또는 `<설치> gen`.
6. **VS Code에서 `Developer: Reload Window`.**
7. **`<설치> doctor`** 로 확인합니다. 문제가 있으면 `<설치> rollback`.

가드 훅이 `~/.wy-tools`가 들어간 명령을 막으면 clone 폴더에서 `node lib/install.js <명령> --project <프로젝트 폴더>`로 부릅니다.

### 10-2. 버전

- `0.7.x`처럼 0.x는 개발 중입니다. 첫 공개 판이 `1.0.0`입니다.
- `package.json`과 `vscode/package.json`의 `version`을 함께 올립니다. 다르면 시험(`test/generic.test.js`)이 실패합니다.
- 설치본 폴더 이름은 `<버전>-<커밋>`입니다. 같은 버전이라도 커밋이 다르면 새 폴더가 생깁니다.
- 프로젝트는 `wy-ops.json`의 `wyOpsVersion`으로 쓸 버전을 적을 수 있고, doctor가 설치본과 비교합니다.
- VS Code 확장 id(`wy-ops.wy-ops`)는 바꾸지 않습니다. 바꾸면 모든 PC에 옛 확장이 남습니다.

### 10-3. 공개 저장소에 올리기 전

- 비밀값·개인 주소·내부 프로젝트 이름이 없는지 점검합니다.
- 예시 이름은 `AB-`·`my-project`를 씁니다.
- 함께 까는 도구의 출처는 버전이나 커밋을 고정합니다(`extras.json`·`plugins.json`). `main`처럼 움직이는 주소는 검사에서 경고가 납니다.
