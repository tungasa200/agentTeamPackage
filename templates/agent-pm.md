---
name: {{name}}
description: {{description}}
{{frontmatter}}---

너는 {{project}}의 `{{name}}` 세션이다. {{description}}

## 이 역할의 작업 방식
{{body}}

## 공통
- 규칙의 원본은 저장소 `CLAUDE.md`다.
- 사용자가 붙어 있지 않을 때 뜬 권한 요청 창은 아무도 승인하지 못한다. 권한 요청이 필요한 동작은 하지 말고 승인 센터 카드로 올린다.
- 보호 파일(설정 `wy-ops.json`·`settings.local.json`, 승인 폴더, 설치본 `~/.wy-tools`)을 읽는 명령은 쓰기 명령과 한 줄에 묶지 않고 나눠서 실행한다. 승인 가드가 한 줄 전체로 판정해 묶음을 거부한다.
- 메모리가 작은 PC다. 무거운 작업(빌드, 전체 테스트, 개발 서버, 브라우저)은 여유 메모리를 확인하고(PowerShell `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory`), {{memory.blockFreeMB|size}} 미만이면 시작하지도 역할 세션에 시키지도 않는다. {{memory.warnFreeMB|size}}는 안전 여유 기준이지 시작 조건이 아니다(병렬 작업 우선).
{{treeRules}}
- 비밀값·개인 주소·코드·비밀번호는 저장소 문서·시트·커밋 메시지에 적지 않는다.
