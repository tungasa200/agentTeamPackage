# erp 적용안 — 토큰 사용 개선 1차(TOK-1~3, wy-ops 0.14.0)

- 작성: OPS-pm, 2026-10-14. 받는 사람: erp WY-pm.
- 배경: 0.14.0(d68b18c)이 배포됐고 erp에도 gen을 돌렸다. 하지만 erp가 직접 고친 원본 파일은 gen·update가 덮지 않는다. 그래서 아래 규칙은 erp에 아직 적용되지 않았다. TOK-0 측정에서 토큰을 가장 많이 쓴 쪽이 erp(10-09~13 38억, 호출당 평균 문맥 148k)라 erp에 적용해야 실제 효과가 난다.
- 근거: agentTeamPackage `docs/토큰개선계획.md`, 결정 D-20·D-21, 패키지 커밋 d671ece(템플릿 문구).

## 이미 적용된 것(손댈 필요 없음)

- 세션 교체 알림·권장 기본값 10만·13만(VS Code 확장. erp wy-ops.json에 rotation 값이 없어 새 기본값을 씀)
- pm-ops 스킬 문구(gen 반영): ListAgents 완화, 할 일 없는 메시지 금지, 쉬는 세션 정책 D-21
- `.claude/settings.json` env `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 200000(사용자가 고침, 커밋은 erp WY-commit 몫)

## erp에서 고칠 것

### 1. `.claude/ops/roles/WY-commit.md` 9행 — 승인 대기 루프 없애기

지금: `Bash run_in_background로 until [ -f …/<id>.json ]; do sleep 3; done …` 식으로 결정 파일을 기다린다. TOK-0: WY-commit 대기 루프 499번, 깨우기 턴 96%, Sonnet인데 토큰 3위(569M).

바꿀 문구(패키지 templates/roles/commit.md와 같음):

> 사용자 승인은 승인 센터로 받는다(CLAUDE.md "커밋" 절). 카드를 올린 뒤 대기 루프(`until`·`sleep` 반복, Monitor)를 걸지 말고 턴을 끝낸다. 결정이 나면 결정 깨우기 훅(`wy-decision-wake`)이 이 세션을 깨우므로, 그때 결정 파일(`decisions/<id>.json`)을 Read 도구로 읽고 이어 간다.

확인할 것: erp settings.local.json에 Stop 훅 `wy-decision-wake.js`가 있어야 한다(doctor '훅' 줄).

### 2. `.claude/ops/agent.md` — 모든 역할 공통 절

보고 절의 "보내기 전 매번 `ListAgents`로 대상을 확인한다"를 다음으로 바꾸고, 파일 읽기 줄을 더한다.

> `ListAgents`로 대상을 확인하는 것은 처음 보내는 대상, 세션 교체 직후, 보내기 실패·전달 안내를 받았을 때뿐이다. pm 세션에는 최종 `[완료]`·`[결정 요청]`·`[차단]`만 보낸다. "카드 올림"·"대기 중" 같은 중간 보고나 수신 확인처럼 받는 쪽이 할 일이 없는 메시지는 보내지 않는다(결정 대기로 15분 넘게 막히면 그때 한 번).
>
> 파일은 Read·Grep 도구로 필요한 범위를 한 번에 읽는다. `sed -n`·`cat`·`head`로 조금씩 여러 번 나눠 읽지 않는다.

TOK-0: erp SendMessage 3,001·ListAgents 1,596번. 받고 답만 한 짧은 턴 837개(1.6억). grep·sed -n·cat 7,198번.

### 3. erp `CLAUDE.md` — 세션 절·커밋 절

- 쉬는 세션: "1시간 넘게 안 쓸 세션은 `stop`으로 멈춰 메모리를 돌려준다. 대화는 남아서 `start`로 이어지고, 교체 기준 이상으로 커진 세션은 `rotate`로 새로 시작한다." (D-21. 캐시 수명이 1시간이라 그보다 오래 쉰 큰 세션을 깨우면 대화 전체를 캐시에 다시 쓴다. erp 30건, 최대 25만)
- 메시지: "`ListAgents`로 대상 세션이 있는지 확인하는 것은 처음 보내는 대상, 세션 교체 직후, 보내기 실패·전달 안내를 받았을 때다." 그리고 "메시지는 받는 쪽이 할 일이 있을 때만 보낸다. 수신 확인, '알겠습니다', '대기하세요'처럼 할 일이 없는 메시지는 보내지 않는다(받는 세션이 깨어나 대화 전체를 다시 읽는다)."
- 커밋 절: "`decisions/<id>.json` 결정을 받은 뒤(대기 루프 없이 턴을 끝내면 결정 깨우기 훅이 깨운다) approved면 그 명령을 그대로 실행한다."

### 4. 고친 뒤

- `install.ps1 gen --project C:\projects\erp-project`(사용자 실행. 설치본 실행은 승인 가드가 세션에서 막음) → WY-commit 등 역할 파일에 반영
- 커밋(WY-commit): 위 원본 + 생성물 + 0.13.0·0.14.0 gen 생성물(`.claude/skills/pm-ops/*`, `.claude/wy-ops.lock.json`) + `.claude/settings.json`
- 이미 떠 있는 세션은 시작 때 읽은 규칙을 쓴다. 바뀐 규칙은 rotate·새 세션부터 적용된다.

## 다음(참고)

TOK-3 2차(시험 출력 거르기 훅, agent-browser 스냅숏 줄이기)와 TOK-4(역할 세션에서 안 쓰는 플러그인·MCP 끄기)는 agentTeamPackage에서 이어서 한다. agent-browser는 erp qa·ux·browser 역할이 3,997번 썼기 때문에 그때 erp 역할 문구 변경을 다시 보낸다.
