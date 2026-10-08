# 세션 현황 · 승인 센터 (VS Code 확장)

VS Code 사이드바에서 메모리, 프로세스 그룹별 사용량, Claude 역할 세션 상태를 본다. 작업창 탭 '승인 센터'에서는 세션이 올린 git 명령 요청(커밋·푸시·PM 결정)을 승인·거부하고, 결정 요청에 답하고, 권한 요청과 할 일을 처리한다. npm 의존성과 빌드 단계가 없다.

이 문서는 확장의 동작과 **카드 요청 파일 형식**(세션이 카드를 올릴 때 쓰는 규칙)을 적는다. 설치·사용법은 패키지의 `README.md`·`MANUAL.md`를 본다. 예시의 역할 이름은 접두사 `AB-`, 승인 namespace는 `my-project`로 가정한다.

## 개발본과 설치본

이 폴더(`vscode/`)는 개발본이다. VS Code에는 껍데기 확장(`wy-ops.wy-ops`)만 설치되고, 껍데기는 설치본 `~/.wy-tools/wy-ops/current/vscode`의 코드를 불러온다. 훅도 설치본의 스크립트를 쓴다. 그래서 개발 중인 파일이 쓰는 확장에 바로 실리지 않는다.

- 설치·갱신: 패키지 저장소에서 `install.ps1 global`(처음) 또는 `install.ps1 update`/`deploy`(갱신). 커밋본(HEAD)을 버전 폴더로 꺼내고 `current`를 바꾼다. 다른 사람의 미커밋 변경은 실리지 않는다. 그 뒤 `Developer: Reload Window`. 다시 설치할 필요는 없다.
- 작업 사본을 바로 써 보려면 `install.ps1 deploy --dev`(풀려면 `install.ps1 deploy`).
- 시험: `node vscode/test/<이름>.test.js`(가짜 vscode 모듈 `test/fakeVscode.js`, Extension Development Host 없이).
- 설치본의 `deployed.json`에 버전·커밋·시각·설치 원본이 남는다.

## 세션 현황(사이드바)

| 항목 | 출처 | 주기 |
|---|---|---|
| 전체·여유 메모리 | Node `os.totalmem`·`os.freemem` | 5초 |
| 프로세스 그룹 상위 5개 | `tasklist /fo csv /nh` | 15초 |
| 세션 | `claude agents --json --all` | 10초 |

- 패널이 보이지 않으면 폴링을 멈춘다. 위 오른쪽 새로고침 버튼으로 바로 갱신할 수 있다.
- 프로세스 블록은 제목을 눌러 접을 수 있다. 접어 두면 `tasklist`를 실행하지 않고, 접힘 상태는 패널을 다시 열어도 유지된다.
- 세션은 갱신 때마다 작업 중 → 대기(대기·입력 대기·승인 대기) → 멈춤 → 오류 → 없음 순으로 다시 정렬한다. 같은 그룹 안은 `.claude/wy-ops.json`의 역할 순서다. 실행하지 않은 역할은 '없음'으로 보여 준다. 워크스페이스 루트가 저장소여야 한다.
- 입력 대기는 할 일을 마치고 다음 지시를 기다리는 상태, 승인 대기는 권한·샌드박스·선택 대화상자 응답을 기다리는 상태다(`claude agents`의 `waitingFor`로 구분). 상태 위에 마우스를 올리면 기다리는 이유가 보인다.
- 여유 메모리가 1GB 미만이면 막대와 문구가 경고색으로 바뀐다. 막대 위의 세로선이 1GB 기준이다.

## 승인 센터(작업창 탭)

상태 표시줄의 '승인 대기 N'을 누르거나 명령 팔레트에서 `WY: 승인 센터 열기`를 실행한다. VS Code를 다시 열면 탭이 되살아난다. N은 대기 중인 카드(git·결정·권한·할 일)를 합친 수이고, 마우스를 올리면 종류별로 나눠서 보인다.

새 카드가 들어오면 OS 기본 알림음을 한 번 낸다(탭이 닫혀 있어도). 여러 장이 5초 안에 몰려도 한 번이고, VS Code를 켤 때 이미 쌓여 있던 카드로는 울리지 않는다. 끄려면 설정 `wyOps.approvals.sound`를 끈다. 창을 여러 개 열면 창마다 울린다.

- **git 명령 카드**: 커밋·푸시(파랑)와 PM 결정(노랑: 병합·`gh pr merge`, 브랜치 생성·삭제, reset, 강제 푸시, rebase, 태그 삭제). 매번 [승인] 또는 [거부]를 누른다. 자동 승인은 없다. 거부할 때는 사유를 적어야 한다.
- **결정 요청 카드**(보라): 질문 1~4개, 질문마다 선택지 2~4개(추천 표시), 하나만 또는 여러 개 고르기, '기타' 직접 입력, 메모. 모든 질문에 답해야 [응답 전송]이 된다.
- **권한 요청 카드**: 백그라운드 세션(`claude agents`의 kind=background)이 도구 실행 권한 요청에 대한 응답을 기다릴 때 훅이 올린다. 대화형 세션이나 종류를 알 수 없는 세션은 카드 없이 평소 터미널 권한 요청 창으로 간다. [허용]은 그 한 번만, [거부]는 사유가 세션에 전달된다. 15분 안에 결정이 없으면 거부로 닫힌다.
- **할 일 카드**: 사람이 직접 할 일(콘솔 작업, 설정 수정, 직접 실행). 방법 단계와 확인 방법을 보고 처리한 뒤 [완료]를 누르면 요청 세션이 이어 간다.
- **형식 오류 카드**: 요청 파일을 읽지 못했거나 필수 칸(아래 '요청 형식')이 빠진 요청. 처리 버튼이 없다.

### 파일(저장소 밖 `~/.claude/wy-approvals/<namespace>/`)

승인 폴더는 프로젝트마다 따로다. `<namespace>`는 프로젝트 설정 `.claude/wy-ops.json`의 `approvals.namespace`(예: `my-project` → `~/.claude/wy-approvals/my-project/`). 설정이 없는 프로젝트는 `~/.claude/wy-approvals/` 바로 아래를 쓴다(예전 방식). 승인 센터 탭과 가드 훅은 각각 VS Code 워크스페이스·명령 실행 위치(cwd)로 프로젝트를 찾으므로, 한 프로젝트의 승인을 다른 프로젝트에서 쓸 수 없다. 예전 바탕 폴더에 결정 안 된 요청이 남아 있으면 탭 위에 안내가 뜬다.

| 경로 | 쓰는 쪽 | 내용 |
|---|---|---|
| `requests/<id>.json` | 요청하는 세션 | 요청 하나 |
| `decisions/<id>.json` | 확장 | 그 요청의 결정. 요청과 같은 id |
| `decisions.log` | 확장 | 결정마다 JSON 한 줄을 덧붙인다(알림용) |
| `used/<id>.json` | 가드 훅 | 그 승인으로 명령을 한 번 실행했다는 표시 |
| `message-blocks.log` | 메시지 가드 훅 | 종료된 세션에 보내려다 거부된 메시지마다 JSON 한 줄(`at`·`from`·`fromSessionId`·`to`·`toSessionId`·`toState`, 본문 없음). 1MB를 넘으면 앞 절반을 버린다. 세션 현황의 '꺼진 뒤 메시지 옴' 경고가 읽는다 |

- id는 영문·숫자·`.`·`_`·`-`로 80자 이내, 요청을 쓰는 세션이 정한다. 겹치지 않게 `<날짜>-<시각>-<세션>-<짧은 설명>`을 권한다(예: `20261006-1530-AB-pm-p2-scope`).
- 요청 파일도 임시 이름으로 다 쓴 뒤 `<id>.json`으로 이름을 바꿔 둔다. 반쯤 쓴 파일은 형식 오류 카드로 보인다.
- 요청 파일은 결정 뒤에도 지우지 않는다(최근 결정 목록이 제목을 보여 줄 때 쓴다).

### 요청 형식

공통 필드: `kind`, `session`(요청 세션 이름, 결정을 전해 받을 곳), `createdAt`, `title`, `relatedSessions`(선택, 결정을 함께 알아야 할 세션), `detail`(선택).

카드만 보고 판단할 수 있게(OPS-03) 모든 종류에 아래 세 칸이 **필수**다. 하나라도 비어 있으면(공백만 있어도) 처리 버튼이 없는 형식 오류 카드("필수 칸 없음: what, why")로 올라간다. 요청 세션이 다시 써야 한다.

| 칸 | 필수 | 내용 |
|---|---|---|
| `what` | 예 | 무엇을: 실행할 일·고를 일을 한두 문장으로 |
| `why` | 예 | 왜: 이 요청이 지금 필요한 이유 |
| `onClick` | 예 | 누르면 무슨 일: 승인·거부(또는 고른 뒤·완료 뒤)에 세션이 하는 일 |
| `cost` | 아니오 | 대가(시간·위험·되돌리기 어려움). choice는 카드가 아니라 선택지마다 쓴다(아래) |

git 명령 요청(`kind`: `commit` `push` `force-push` `branch` `delete-branch` `merge` `reset` `rebase` `tag-delete`):

```json
{
  "kind": "commit",
  "session": "AB-commit",
  "createdAt": "2026-10-06T15:30:00+09:00",
  "title": "feat(tools): 승인 센터 2단계",
  "what": "승인 센터 2단계 파일 1개를 feature/P1에 커밋한다",
  "why": "AB-backend2 작업이 끝나 검증을 통과했다",
  "onClick": "승인: AB-commit이 아래 명령을 한 번 실행한다. 거부: 실행하지 않고 사유를 요청 세션에 전한다",
  "cost": "되돌리려면 새 커밋이 필요하다(푸시 전)",
  "branch": "feature/P1",
  "command": "git commit -F .git/AB_COMMIT_MSG",
  "files": ["vscode/approvalStore.js"],
  "commits": [{ "hash": "5795e03", "subject": "feat(tools): …" }],
  "verification": "node --check 통과, 가짜 vscode 로드 통과",
  "relatedSessions": ["AB-backend2"],
  "detail": "AB-backend2 요청분"
}
```

- `command`: 실제로 실행할 명령 그대로. 가드 훅은 공백만 정리해 실행 명령과 똑같은지 비교한다. 여러 명령을 `&&`로 이을 때는 잠금 대상 명령마다 요청을 하나씩 쓴다.
- push 요청은 `commits`에 올라갈 커밋을, commit 요청은 `files`(또는 `fileCount`)와 `verification`을 채운다.

결정 요청(`kind`: `choice`, AskUserQuestion과 같은 모양):

```json
{
  "kind": "choice",
  "session": "AB-pm",
  "createdAt": "2026-10-06T16:00:00+09:00",
  "title": "P2 시작 범위",
  "what": "P2를 시작할 시점과 먼저 할 영역을 정한다",
  "why": "P1 QA가 끝나 다음 지시를 내려야 한다",
  "onClick": "응답 전송: AB-pm이 답대로 역할 세션에 P2 작업을 지시한다",
  "background": "P1 QA가 끝났고 남은 결함 2건은 P2 첫 주에 고칠 수 있다.",
  "relatedSessions": ["AB-planner", "AB-backend1"],
  "questions": [
    {
      "header": "시작 시점",
      "question": "P2를 언제 시작할까요?",
      "multiSelect": false,
      "options": [
        { "label": "바로 시작", "description": "결함은 P2와 함께 고친다", "cost": "P2 첫 주 일정이 이틀 늘어난다", "recommended": true },
        { "label": "결함 먼저", "description": "남은 2건을 고친 뒤 시작한다", "cost": "P2 시작이 이틀 늦어진다", "onClick": "AB-pm이 결함 2건부터 배정한다" }
      ]
    },
    {
      "header": "먼저 할 일",
      "question": "P2에서 먼저 할 영역을 고르세요.",
      "multiSelect": true,
      "allowOther": true,
      "options": [
        { "label": "알림", "cost": "백엔드 2명 1주" },
        { "label": "통계", "cost": "백엔드 1명·프론트 1명 1주" },
        { "label": "모바일 화면", "cost": "프론트 2명 1주" }
      ]
    }
  ]
}
```

- `questions` 1~4개, 질문마다 `options` 2~4개(`label`은 질문 안에서 겹치지 않게). `header`는 짧은 라벨(24자 이내).
- `multiSelect`(기본 false), `allowOther`(기본 true: '기타' 직접 입력 칸을 보여 준다), `recommended`(선택지에 '추천' 표시).
- 선택지마다 `cost`(그 선택의 대가, 문자열)가 **필수**다. 빠지면 형식 오류 카드("필수 칸 없음: 1번 질문 선택지 cost(통계)")가 된다. 선택지별 `onClick`(그것을 고르면 하는 일)은 선택이고, 없으면 카드의 `onClick`을 보여 준다.

할 일 요청(`kind`: `todo`, 사람이 직접 할 일. OPS-02 ③):

```json
{
  "kind": "todo",
  "session": "AB-browser",
  "createdAt": "2026-10-07T10:00:00+09:00",
  "title": "호스팅 콘솔 2단계 인증 직접 처리",
  "what": "호스팅 콘솔의 2단계 인증을 사람이 직접 통과한다",
  "why": "자동화 브라우저로는 2단계 인증 코드를 받을 수 없다",
  "onClick": "완료: AB-browser가 도메인 설정을 이어 간다",
  "steps": ["전용 Chrome에서 콘솔 로그인 창을 연다", "휴대폰 인증 앱의 코드를 넣는다"],
  "check": "콘솔 대시보드의 프로젝트 목록이 보이면 된다"
}
```

- `steps`: 방법 단계(최대 20개). `check`(선택): 끝났는지 확인하는 방법.
- 카드의 [완료](메모 선택)를 누르면 결정 `decision: "done"`이 생긴다(`note`에 메모). 요청 세션은 아래 '결정을 받는 방법'대로 `decisions/<id>.json`을 기다렸다가 이어 간다. 대화창으로 따로 알릴 필요가 없다.
- 요청 세션이 이미 종료됐으면 카드에 '세션 종료됨'이 붙는다. [완료]는 눌러도 되지만, 이어 갈 세션이 없으니 pm 역할이 다시 배정한다.
- 권한 요청 카드(`permission`)와 분류기 거부 할 일 카드(`denied-<키>`)는 `hooks/wy-permission.js`가 쓴다. 세션이 직접 쓰지 않는다.

### 결정 형식

`decisions/<id>.json`은 임시 파일에 다 쓴 뒤 이름을 바꿔 생긴다. 그래서 **파일이 보이면 완성된 결정**이고 `done: true`가 들어 있다(`*.tmp`는 무시한다).

```json
{
  "id": "20261006-1600-AB-pm-p2-scope",
  "kind": "choice",
  "session": "AB-pm",
  "relatedSessions": ["AB-planner", "AB-backend1"],
  "decision": "answered",
  "answers": [
    { "question": "P2를 언제 시작할까요?", "header": "시작 시점", "selected": ["바로 시작"], "other": null },
    { "question": "P2에서 먼저 할 영역을 고르세요.", "header": "먼저 할 일", "selected": ["알림"], "other": "로그인 화면 다듬기" }
  ],
  "note": "결함 2건은 AB-qa 재확인 후 닫기",
  "by": "user",
  "decidedAt": "2026-10-06T07:05:12.345Z",
  "done": true
}
```

- 할 일 결정은 `decision: "done"`과 `note`가 들어 있다.
- git 명령 결정은 `decision`이 `approved` 또는 `rejected`이고, `reason`(거부 사유)과 `command`(정리한 명령)가 들어 있다.
- `decisions.log`에는 같은 결정이 한 줄로 붙는다: `{"id":"…","kind":"choice","session":"AB-pm","relatedSessions":[…],"decision":"answered","decidedAt":"…"}`

### 결정을 받는 방법(기다리지 않아도 되게)

요청한 세션은 요청 파일을 쓴 뒤 결정을 기다리며 멈춰 있을 필요가 없다. 결정 파일은 지워지지 않으니 나중에 읽어도 된다.

- **id 하나를 기다릴 때**(요청한 세션이 직접): `decisions/<id>.json`이 생길 때까지 확인한다. 예(Bash, Monitor의 until 루프):
  `until [ -f ~/.claude/wy-approvals/my-project/decisions/<id>.json ]; do sleep 5; done; cat ~/.claude/wy-approvals/my-project/decisions/<id>.json`
- **모든 결정을 감시할 때**(pm 역할): `decisions.log`에 새 줄이 붙는지 본다. 예:
  `tail -n 0 -F ~/.claude/wy-approvals/my-project/decisions.log`
  새 줄의 `session`·`relatedSessions`를 보고, 그 세션이 종료돼 있으면 재시작해서(`session.ps1 start <역할> "<결정 요약>"`) 결정 파일 경로와 요약을 전한다.
- 가드 훅은 승인 파일을 **읽는** 셸 명령(cat·ls·tail·test·감시 루프)은 통과시키고, **쓰는** 명령만 막는다.

### 세션별 사용 규칙(초안)

- **커밋 역할**(`wy-ops.json`의 `commitRole`): 잠금 대상 git 명령마다 git 요청 파일을 쓰고 결정을 받은 뒤, approved면 `command`를 그대로 실행한다. rejected면 실행하지 않고 `reason`을 요청 세션과 pm 역할에 전한다. 승인은 결정 후 60분 안에 한 번만 쓸 수 있다. PM 결정 종류는 요청 전에 pm 역할에 알린다. 반드시 `--agent <커밋 역할>`로 실행한 세션이어야 한다(가드 훅이 agent_type을 본다).
- **pm 역할**(`pmRole`): 사용자에게 물을 결정은 choice 요청으로 올리고 `decisions.log`를 감시한다. 결정이 오면 `session`·`relatedSessions`에 전하고, 확정된 결정은 결정기록 문서(`wy-ops.json`의 `docs`) 담당 역할이 기록하게 한다.
- **다른 역할 세션**: git 명령 요청은 쓰지 않는다(커밋 역할에 커밋을 요청한다). 사용자 판단이 필요한 결정은 pm 역할에 `[결정 요청]`으로 보내고, pm 역할이 choice 요청으로 올린다.
- **모든 세션**: `decisions/`·`decisions.log`·`used/`·설치 폴더에 쓰지 않는다. 결정 파일은 Read 도구나 읽기 명령으로 본다. 확장을 고칠 때 가드 훅이 막는 셸 명령(보호 경로가 들어간 node·sed 스크립트 등)은 쓰지 말고 Edit 도구로 고친다.

## 승인 가드 훅

`hooks/wy-approval-guard.js`는 Bash·PowerShell 도구의 PreToolUse 훅이다.

- 잠금 대상 git 명령(commit, push, 강제 푸시, 브랜치 생성·삭제, merge·`gh pr merge`, reset, rebase, 태그 삭제)은 `--agent <커밋 역할>`로 실행한 세션만 실행할 수 있다. agent_type이 없는 세션도 거부한다. 조회 명령(status, log, diff 등)은 누구나 쓴다.
- 커밋 역할이라도 같은 종류·같은 명령의 승인 결정(결정 후 60분 이내, 아직 안 씀)이 없으면 거부하고, 요청 파일을 쓰라는 사유를 돌려준다.
- `merge --abort`, `rebase --abort`처럼 되돌리는 명령은 잠그지 않는다.
- 승인 파일(모든 namespace의 decisions·decisions.log·used·sessions·message-blocks.log), 설치 폴더(`~/.wy-tools`), 프로젝트 설정(`.claude/wy-ops.json`·`wy-ops.local.json`·`settings.local.json`)에 쓰는 셸 명령을 막는다: 그 경로로의 리다이렉트(`>`·`>>`), 쓰기 명령(cp·mv·rm·tee·Set-Content·Out-File·Remove-Item 등, `sed -i`, `find -delete`/`-exec`), 그 경로가 나오는 명령 안의 다른 리다이렉트·쓰기 명령(변수 경로 우회 방지), 쓰기 API(writeFileSync·appendFile·rename·unlink, open(…, 'w'/'a'), os.remove, Set-Content 등)나 난독화(eval·계산된 이름·getattr 등)를 쓰는 인터프리터 코드. 읽기 API(readFileSync·require·JSON.parse, json.load(open(…)), Get-Content·ConvertFrom-Json)만 쓰는 node·python·PowerShell 코드와 cat·ls·tail·test·`git add/diff` 같은 읽기, 설정을 안에서 읽는 스크립트 실행(`session.ps1`, `gen-agents.js`, `deploy.js`)은 통과한다. 판단할 수 없는 코드는 막는다. 설정 변경은 내용을 pm 역할에 보내 사용자가 직접 고친다.
- 승인 폴더는 명령의 cwd가 속한 프로젝트 것을 쓴다(위 '파일' 참고).
- 훅은 오류·시간 초과 때 통과시키는 특성이 있어서, 이 스크립트는 판단하지 못하면 종료 코드 2로 막는다. 다만 설정에 적힌 스크립트 경로가 없거나 `node`를 못 찾으면 Claude Code가 훅을 건너뛴다(통과).
