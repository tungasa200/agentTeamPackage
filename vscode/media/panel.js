// 사이드바 패널 렌더링. 데이터는 extension.js가 postMessage로 보낸다.
(() => {
  const vscode = acquireVsCodeApi();
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const $ = (id) => document.getElementById(id);
  const REVEAL_MS = 6000;

  // 상태(view)는 확장의 agentsReader가 정한다(운영 도구 구현 계획 2.2)
  // 네 가지 상태(사용자 확정 2026-10-07). 꺼짐(done·stopped)은 아래 접는 묶음, 이유는 작은 글씨로
  const STATES = {
    working: { label: '작업 중', icon: 'i-working' },
    input: { label: '입력 대기', icon: 'i-waiting' },
    permission: { label: '권한 승인 대기', icon: 'i-approval' },
    off: { label: '종료됨', icon: 'i-stopped' },
    none: { label: '미실행', icon: 'i-none' },
  };
  const OFF_REASON = { stopped: '중지됨', done: '정상 종료', failed: '오류 종료' };
  // 권한 대기 > 일하는 중 > 입력 대기 > 꺼짐 > 띄우지 않음. 같은 그룹 안은 역할 표 순서
  const GROUP = { permission: 0, working: 1, input: 2, off: 3, none: 4 };
  // 꺼진 뒤 메시지가 온 세션은 접는 묶음에 숨기지 않는다
  const isFoldable = (r) => (r.st === 'off' && !(r.s && r.s.offWarning)) || r.st === 'none';
  const WAITING_FOR = {
    'permission prompt': '권한 승인 요청',
    'sandbox request': '샌드박스 허용 요청',
    'worker request': '작업자 요청',
    'dialog open': '선택 대화상자 열림',
    'input needed': '다음 지시를 기다림',
  };

  const saved = vscode.getState() || {};
  const folded = new Set(saved.folded || []);
  let roles = [];
  let lastSessions = null;
  let lastMemory = null;
  // 메모리 경고 선(wy-ops.json memory, D-86). 확장이 limits로 보내기 전에는 기본값
  let limits = { warn: 1024 * MB, block: 500 * MB };
  let wasLevel = 'ok';
  let reveal = null; // { key, until, done }
  let lastAt = 0;
  const failed = new Set();

  const fmtGB = (b) => (b / GB).toFixed(1) + ' GB';
  const fmtSize = (b) => (b >= GB ? (b / GB).toFixed(2) + ' GB' : Math.round(b / 1024 ** 2) + ' MB');
  const fmtTime = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour12: false });

  function fmtElapsed(startedAt) {
    if (!startedAt) return '—';
    const min = Math.floor((Date.now() - startedAt) / 60000);
    if (min < 1) return '1분 미만';
    if (min < 60) return min + '분';
    const h = Math.floor(min / 60);
    if (h < 10) return h + '시간 ' + (min % 60) + '분';
    if (h < 24) return h + '시간';
    return Math.floor(h / 24) + '일 ' + (h % 24) + '시간';
  }

  function sortRows(rows) {
    const rank = (n) => {
      const i = roles.indexOf(n);
      return i < 0 ? roles.length : i;
    };
    return rows.sort(
      (a, b) =>
        GROUP[a.st] - GROUP[b.st] ||
        rank(a.name) - rank(b.name) ||
        a.name.localeCompare(b.name) ||
        ((b.s && b.s.startedAt) || 0) - ((a.s && a.s.startedAt) || 0),
    );
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function icon(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }

  // 주기 갱신은 읽어 주지 않고, 수동 새로고침 완료와 메모리 경고 전환만 알린다
  function announce(text) {
    $('announce').textContent = text;
  }

  function errLine(text) {
    const p = el('p', 'err-line');
    p.append(icon('i-error'), el('span', null, text));
    return p;
  }

  // 블록 본문 대신 오류 한 줄을 보여 준다. 다음에 성공하면 본문이 돌아온다
  function showError(boxId, errId, text) {
    $(boxId).hidden = !!text;
    const err = $(errId);
    err.hidden = !text;
    if (text) err.replaceChildren(...errLine(text).childNodes);
  }

  function stamp() {
    const s = $('stamp');
    if (failed.size) {
      s.textContent = '일부 정보를 읽지 못했습니다';
      s.classList.add('is-error');
    } else {
      s.textContent = lastAt ? fmtTime(lastAt) + ' 갱신' : '불러오는 중…';
      s.classList.remove('is-error');
    }
  }

  function renderMemory(msg) {
    const box = $('mem');
    box.classList.remove('is-loading');
    showError('mem', 'mem-err', msg.error && '메모리를 읽지 못했습니다: ' + msg.error);
    if (msg.error) return;
    const { total, free } = msg.data;
    const used = total - free;
    const pct = Math.round((used / total) * 100);
    const level = free < limits.block ? 'block' : free < limits.warn ? 'warn' : 'ok';
    box.classList.toggle('is-low', level === 'warn');
    box.classList.toggle('is-block', level === 'block');
    if (level !== wasLevel) {
      announce(
        level === 'block' ? `여유 메모리 ${fmtSize(free)}, ${fmtSize(limits.block)} 미만입니다. 무거운 작업을 시작하지 마세요`
          : level === 'warn' ? `여유 메모리 ${fmtSize(free)}, ${fmtSize(limits.warn)} 미만입니다`
            : `여유 메모리가 ${fmtSize(limits.warn)} 이상으로 돌아왔습니다`,
      );
    }
    wasLevel = level;
    $('mem-free').textContent = fmtGB(free);
    $('mem-total').textContent = '전체 ' + fmtGB(total);
    const meter = $('mem-meter');
    meter.style.setProperty('--used', String(used / total));
    meter.style.setProperty('--limit', Math.max(0, ((total - limits.warn) / total) * 100) + '%');
    meter.style.setProperty('--block', Math.max(0, ((total - limits.block) / total) * 100) + '%');
    $('mem-limit').title = `이 선을 넘으면 여유 ${fmtSize(limits.warn)} 미만(주의)`;
    $('mem-block').title = `이 선을 넘으면 여유 ${fmtSize(limits.block)} 미만(무거운 작업 금지)`;
    meter.setAttribute('aria-valuenow', String(pct));
    meter.setAttribute('aria-valuetext', `사용 ${fmtGB(used)}, 여유 ${fmtGB(free)}`);
    const note = $('mem-note');
    note.replaceChildren();
    if (level === 'block') note.append(icon('i-error'), el('span', null, `여유 ${fmtSize(limits.block)} 미만 — 무거운 작업을 시작하지 마세요`));
    else if (level === 'warn') note.append(icon('i-warn'), el('span', null, `여유 ${fmtSize(limits.warn)} 미만 — 무거운 작업은 한 번에 하나씩`));
    else note.append(el('span', null, `사용 ${fmtGB(used)} · ${pct}%`));
  }

  function renderProcesses(msg) {
    const list = $('procs');
    list.classList.remove('is-loading');
    list.replaceChildren();
    if (msg.error) {
      const li = el('li');
      li.append(errLine('프로세스 목록을 읽지 못했습니다: ' + msg.error));
      list.append(li);
      return;
    }
    if (!msg.data.length) {
      list.append(el('li', 'empty', '표시할 프로세스가 없습니다'));
      return;
    }
    const max = msg.data[0].bytes;
    for (const p of msg.data) {
      const li = el('li', 'proc');
      const name = el('span', 'proc-name', p.name);
      name.title = p.name;
      name.append(el('span', 'proc-count', '×' + p.count));
      const bar = el('span', 'proc-bar');
      bar.setAttribute('aria-hidden', 'true');
      const fill = el('i');
      fill.style.setProperty('--share', String(p.bytes / max));
      bar.append(fill);
      li.append(name, el('span', 'proc-mem', fmtSize(p.bytes)), bar);
      list.append(li);
    }
  }

  // ── pm 제어 줄(0.10.0, design/pm-control 목업 P-1~P-8). 데이터는 확장의 pmControl.view() ──
  let pmName = null;
  let lastPm = null;
  let pmSaid = null; // 마지막으로 읽어 준 pm 상태(같은 상태는 다시 읽지 않는다)
  let pmDoneTimer = null;
  const PM_SAY = { working: 'pm 작업 중', input: 'pm 입력 대기', permission: 'pm 권한 승인 대기' };
  const kTok = (n) => Math.round(n / 1000) + 'k';
  const hhmm = (d) => d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

  function fmtStopped(t) {
    const d = new Date(t);
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(new Date()) - day(d)) / 86400000);
    const when = diff === 0 ? '' : diff === 1 ? '어제 ' : `${d.getMonth() + 1}월 ${d.getDate()}일 `;
    return `${when}${hhmm(d)}에 멈춤`;
  }

  const fmtSec = (ms) => (ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + '초' : Math.round(ms / 60000) + '분');

  // 좁은 폭(N-1)에서 바뀌는 글자: 넓을 때 글자와 좁을 때 글자를 둘 다 넣고 CSS로 하나만 보인다
  function swapText(wide, narrow) {
    const f = document.createDocumentFragment();
    f.append(el('span', 'wide', wide), el('span', 'narrow', narrow));
    return f;
  }

  // disabled는 키보드 포커스를 잃게 하므로 aria-disabled로 막는다
  function pmBtn(act, kind, label, iconId, { grow = true, disabled = false, aria } = {}) {
    const b = el('button', `btn btn-${kind}` + (grow ? ' grow' : ''));
    b.type = 'button';
    b.dataset.act = act;
    if (iconId) b.append(icon(iconId));
    if (typeof label === 'string') b.append(el('span', null, label));
    else b.append(label);
    if (aria) {
      b.setAttribute('aria-label', aria);
      b.title = aria;
    }
    b.setAttribute('aria-disabled', String(disabled));
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      vscode.postMessage({ type: act });
    });
    return b;
  }

  // [멈춤]: 좁은 폭에서는 아이콘만(이름은 aria-label·title)
  const stopBtn = (disabled) => pmBtn('pmStop', 'ghost', swapText('멈춤', ''), 'i-stop', { grow: false, disabled, aria: 'pm 멈춤' });
  const rotateLabel = () => swapText('pm 교체', '교체');

  function stateChip(cls, iconId, label) {
    const chip = el('span', 'state ' + cls);
    chip.append(icon(iconId), el('span', null, label));
    return chip;
  }

  function stepsList(steps, slow) {
    const ol = el('ol', 'steps4');
    ol.setAttribute('aria-label', '교체 단계');
    for (const st of steps) {
      const li = el('li', st.state === 'todo' ? null : st.state);
      li.append(icon({ done: 'i-check', cur: 'i-working', fail: 'i-error', todo: 'i-none' }[st.state]), el('span', null, st.label));
      if (st.state === 'cur') li.setAttribute('aria-current', 'step');
      if (st.state === 'done' && st.ms != null) li.append(el('small', null, fmtSec(st.ms)));
      if (st.state === 'cur' && slow) li.append(el('small', null, 'pm이 하던 일을 마치는 중'));
      ol.append(li);
    }
    return ol;
  }

  function errBox(text) {
    const p = el('p', 'pm-err');
    p.setAttribute('role', 'alert');
    p.append(icon('i-error'), el('span', null, text));
    return p;
  }

  function ctxBlock(d) {
    // 기준을 넘어도 색은 그대로(0.10.2): '교체 권장' 배지 하나로 알린다
    const box = el('div', 'ctx');
    const max = d.limit * 1.5; // 막대 끝 = 기준의 1.5배, 기준 선은 2/3 지점
    box.style.setProperty('--used', String(Math.min(d.tokens / max, 1)));
    box.style.setProperty('--limit', ((d.limit / max) * 100).toFixed(1) + '%');
    const row = el('div', 'ctx-row');
    const left = el('span', null, '컨텍스트 ');
    left.append(el('b', null, kTok(d.tokens)));
    const right = el('span');
    right.append(swapText('교체 기준', '기준'), document.createTextNode(' ' + kTok(d.limit)));
    row.append(left, right);
    const meter = el('div', 'meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', 'pm 컨텍스트 크기');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', String(Math.round(max)));
    meter.setAttribute('aria-valuenow', String(Math.min(d.tokens, Math.round(max))));
    meter.setAttribute('aria-valuetext', `${kTok(d.tokens)} 토큰, 교체 기준 ${kTok(d.limit)}`);
    meter.append(el('div', 'fill'), el('div', 'limit'));
    box.append(row, meter);
    return box;
  }

  function pmTop(title, small, aside) {
    const top = el('div', 'pm-top');
    const h = el('h3', 'pm-name', title);
    h.id = 'pm-h';
    if (small) h.append(small);
    top.append(h, el('span', 'elapsed', aside || ''));
    return top;
  }

  // 이름 옆 작은 글씨: 원격 창이면 "호스트 <PC 이름>", 아니면 "개발 총괄"(R-1)
  const whoSmall = (d) => el('small', null, d.host ? '호스트 ' + d.host : '개발 총괄');

  function renderPm(d) {
    const sec = $('pm');
    lastPm = d;
    if (!d) {
      sec.hidden = true;
      return;
    }
    const focusAct = sec.contains(document.activeElement) ? document.activeElement.dataset.act || '' : null;
    sec.hidden = false;
    sec.removeAttribute('aria-busy');
    const box = el('div', 'pm-box');
    const acts = el('div', 'pm-acts');
    let say;
    if (d.mode === 'rotating' || d.mode === 'rotateFailed') {
      const failed = d.mode === 'rotateFailed';
      if (failed) box.classList.add('is-error');
      else sec.setAttribute('aria-busy', 'true');
      box.append(pmTop(`${d.name} ${failed ? '교체하지 못함' : '교체 중'}`, null, failed ? '' : `${d.step + 1}/4`), stepsList(d.steps, d.slow));
      if (failed) {
        box.append(errBox(d.error));
        acts.append(pmBtn('pmRetry', 'pri', '다시 시도'), pmBtn('pmLog', 'sec', '기록 보기'), pmBtn('pmClose', 'ghost', '닫기', null, { grow: false }));
        say = 'pm 교체하지 못함';
      } else {
        box.append(el('p', 'pm-note', `끝나면 이 창에 '${d.name} 붙기' 터미널이 열립니다. 창을 닫아도 교체는 계속됩니다.`));
        say = 'pm 교체: ' + ['하던 일 저장 중', '새 pm 시작 중', '이전 pm 멈추는 중', '새 터미널로 붙는 중'][d.step];
      }
    } else if (d.mode === 'stopped' || d.mode === 'startFailed' || d.mode === 'memory') {
      const aside = d.mode === 'stopped' ? (d.never ? '아직 시작하지 않음' : d.stoppedAt ? fmtStopped(d.stoppedAt) : '') : '';
      box.append(pmTop(d.name, whoSmall(d), aside));
      if (d.mode === 'memory') {
        box.classList.add('is-error');
        box.append(errBox(d.error));
        acts.append(pmBtn('pmClose', 'ghost', '닫기'));
        say = d.error;
      } else {
        const line = el('div', 'pm-line');
        line.append(stateChip('st-off', 'i-stopped', '멈춤'));
        box.append(line);
        if (d.mode === 'startFailed') {
          box.classList.add('is-error');
          box.append(errBox('pm이 시작되지 않았습니다. ' + d.error));
          acts.append(pmBtn('pmRetry', 'pri', '다시 시도'), pmBtn('pmLog', 'sec', '기록 보기'), pmBtn('pmClose', 'ghost', '닫기', null, { grow: false }));
          say = 'pm이 시작되지 않았습니다';
        } else {
          box.append(el('p', 'pm-note', d.never ? '시작하면 화면 뒤에서 일하고, [붙기]로 말을 걸 수 있습니다.' : '대화는 남아 있어 시작하면 이어서 일합니다.'));
          acts.append(pmBtn('pmStart', 'pri', 'pm 시작', 'i-play'));
          say = 'pm 멈춤';
        }
      }
    } else if (d.mode === 'starting') {
      sec.setAttribute('aria-busy', 'true');
      const line = el('div', 'pm-line');
      line.append(stateChip('st-working', 'i-working', '시작하는 중…'));
      box.append(pmTop(d.name, whoSmall(d), ''), line, el('p', 'pm-note', '10초쯤 걸립니다. 다 뜨면 [붙기]가 켜집니다.'));
      // 버튼은 실행 중 자리 그대로 두고 끈다(다 뜬 뒤 줄이 밀리지 않게)
      acts.append(pmBtn('pmAttach', 'pri', '붙기', 'i-term', { disabled: true }), pmBtn('pmRotate', 'sec', rotateLabel(), 'i-swap', { disabled: true }), stopBtn(true));
      say = 'pm 시작하는 중';
    } else {
      // running · two(pm이 둘)
      const view = STATES[d.view] ? d.view : 'input';
      if (view === 'permission') box.classList.add('is-perm');
      let small = whoSmall(d);
      if (d.rotate) {
        small = el('span', 'badge badge-warn', '교체 권장');
        small.title = `컨텍스트가 교체 기준(${kTok(d.limit)} 토큰) 이상입니다`;
      }
      box.append(pmTop(d.name, small, fmtElapsed(d.startedAt)));
      const line = el('div', 'pm-line');
      const done = d.doneAt && Date.now() - d.doneAt < 3000;
      if (done) {
        const ok = el('span', 'state pm-done');
        ok.append(icon('i-check'), el('span', null, '교체했습니다' + (d.tokens ? ' · 컨텍스트 ' + kTok(d.tokens) : '')));
        line.append(ok);
        clearTimeout(pmDoneTimer);
        pmDoneTimer = setTimeout(() => lastPm && renderPm(lastPm), 3000 - (Date.now() - d.doneAt));
      } else {
        line.append(stateChip('st-' + view, STATES[view].icon, STATES[view].label));
      }
      box.append(line);
      if (d.pending) {
        const cmd = [d.pending.tool, d.pending.command].filter(Boolean).join(': ');
        const why = el('p', 'pm-why pm-pending', cmd);
        why.title = cmd;
        box.append(why);
      }
      if (d.tokens) box.append(ctxBlock(d));
      say = done ? '교체했습니다' : PM_SAY[view];
      if (d.mode === 'two') {
        box.classList.add('is-error');
        box.append(errBox(`pm이 ${d.count}개 떠 있습니다. 교체가 끝나지 않았을 수 있습니다. 새 pm만 남기려면 [이전 pm 멈춤]을 누르세요.`));
        acts.append(pmBtn('pmStopOld', 'pri', '이전 pm 멈춤', 'i-stop'), pmBtn('pmAttach', 'sec', '붙기', 'i-term'));
        say = `pm이 ${d.count}개 떠 있습니다`;
      } else if (view === 'permission') {
        // 답하지 않은 권한 창을 두고 교체하면 그 요청이 사라지므로 교체는 숨긴다
        acts.append(pmBtn('pmAttach', 'pri', '붙어서 답하기', 'i-term'), stopBtn(false));
      } else {
        // 교체 권장도 평소와 같은 상자·버튼(0.10.2, 사용자 피드백): 알림은 이름 옆 배지만
        acts.append(pmBtn('pmAttach', 'pri', '붙기', 'i-term'), pmBtn('pmRotate', 'sec', rotateLabel(), 'i-swap'), stopBtn(false));
      }
    }
    if (acts.childNodes.length) box.append(acts);
    sec.replaceChildren(box);
    // 처음 그릴 때는 읽지 않고, 상태가 바뀔 때만 한 번 읽는다
    if (pmSaid !== null && say && say !== pmSaid) announce(say);
    pmSaid = say || '';
    // 누른 버튼이 다시 그려져도 포커스를 잃지 않게 같은 버튼(없으면 상자 첫 버튼)으로
    if (focusAct !== null) {
      const again = sec.querySelector(`[data-act="${focusAct}"]`) || sec.querySelector('button');
      if (again) again.focus();
    }
  }

  // "세션 현황에서 보기"로 고른 줄인가: 전체 sessionId 또는 짧은 id 앞부분
  function isRevealed(s) {
    if (!reveal || !s || Date.now() > reveal.until) return false;
    const k = reveal.key;
    return k === s.sessionId || (!!s.id && (k === s.id || k.startsWith(s.id) || s.id.startsWith(k)));
  }

  function sessionRow(name, s, state) {
    const tr = el('tr');
    tr.classList.add('st-row-' + state);
    if (state === 'none') tr.classList.add('is-absent');
    // 입력 대기 중 질문 대화상자가 열린 세션은 사람이 답해야 하므로 바탕색으로 먼저 보이게 한다
    if (state === 'input' && s && String(s.waitingFor || '').toLowerCase() === 'dialog open') tr.classList.add('needs-answer');
    if (s && s.sessionId) tr.dataset.sessionId = s.sessionId;
    const who = el('td');
    const nm = el('span', 's-name', name);
    nm.title = name;
    const meta = el('span', 's-meta');
    if (s) {
      meta.append(el('span', null, (s.kind === 'background' ? '백그라운드' : 'VS Code') + (s.id ? ' · ' : '')));
      if (s.id) meta.append(el('span', 's-id', s.id));
      // 대화 크기(토큰): 매 턴 이만큼 다시 읽는다. 교대 기준 이상이면 배지
      if (s.contextTokens) {
        const ctx = el('span', 's-ctx', ' · ' + Math.round(s.contextTokens / 1000) + 'k');
        ctx.title = `컨텍스트 약 ${s.contextTokens.toLocaleString('ko-KR')} 토큰(매 턴 다시 읽는 크기)`;
        meta.append(ctx);
      }
      if (s.rotate) {
        const badge = el('span', 'badge badge-warn', '세션 교체 권장');
        badge.title = '컨텍스트가 세션 교체 기준 이상입니다. 다음 작업은 session.ps1 rotate로 세션을 교체해 주세요';
        meta.append(badge);
      }
      if (s.roleMissing) {
        const badge = el('span', 'badge badge-warn', '역할 누락');
        badge.title = '--agent 없이 실행된 세션입니다. 역할 파일의 규칙이 실리지 않았을 수 있습니다';
        meta.append(badge);
      }
    } else {
      meta.textContent = '미실행';
    }
    who.append(nm, meta);
    // 권한 대기: 기다리는 도구·명령(OPS-04)
    if (s && s.pending) {
      const cmd = [s.pending.tool, s.pending.command].filter(Boolean).join(' · ');
      const line = el('span', 's-pending', cmd);
      line.title = cmd;
      who.append(line);
    }
    // 멈춤 의심: 도구 한 번에 기준 분 이상 묶임(그동안 메시지를 받지 못한다)
    if (s && s.stuck) {
      tr.classList.add('is-stuck');
      // 글은 본문 글꼴, 명령만 고정폭(권한 대기 줄과 같은 모양)
      const line = el('span', 's-stuck');
      line.append(el('b', null, `멈춤 의심 ${s.stuck.minutes}분`), document.createTextNode(' · '), el('code', null, s.stuck.command || s.stuck.tool));
      line.title = `${s.stuck.tool} 한 번에 ${s.stuck.minutes}분째 묶여 있습니다${s.stuck.long ? '(빌드·테스트 기준 적용)' : ''}. 묶인 동안 메시지를 받지 못합니다. pm 세션에 한 번 알렸습니다.
${s.stuck.command || ''}`;
      who.append(line);
    }
    // 꺼진 뒤 이 세션 앞으로 메시지가 왔거나 막혔다(주황 경고, 확인함으로 숨김)
    // 좁은 사이드바에서도 읽히게 세션 줄 아래 한 줄을 통째로 쓴다
    const warn = s && s.offWarning;
    let warnRow = null;
    if (warn) {
      tr.classList.add('st-row-offwarn');
      warnRow = el('tr', 'warn-row st-row-offwarn');
      const cell = el('td');
      cell.colSpan = 4;
      const line = el('div', 's-offwarn');
      const from = warn.from.length ? ` · ${warn.from.join(', ')}` : '';
      line.append(icon('i-warn'), el('span', null, `미전달 메시지 ${warn.count}건${from}`));
      line.title = (warn.summary ? `마지막: ${warn.summary}\n` : '') + '종료된 뒤 보낸 메시지는 전달되지 않았습니다. 재시작한 뒤 보낸 세션에 알리세요.';
      const ack = el('button', 'ack-btn', '확인');
      ack.type = 'button';
      ack.setAttribute('aria-label', `${name} 미전달 메시지 경고 확인`);
      ack.addEventListener('click', () => vscode.postMessage({ type: 'ackOff', sessionId: s.sessionId }));
      line.append(ack);
      cell.append(line);
      warnRow.append(cell);
    }
    const st = el('td');
    const chip = el('span', 'state st-' + state);
    chip.append(icon(STATES[state].icon), el('span', null, STATES[state].label));
    if (state === 'off' && s && OFF_REASON[s.offReason]) chip.append(el('span', 'st-why', OFF_REASON[s.offReason]));
    const wf = s && s.waitingFor;
    if (wf) chip.title = WAITING_FOR[String(wf).toLowerCase()] || wf;
    st.append(chip);
    const live = s && state !== 'off';
    const age = el('td', 'num elapsed', live ? fmtElapsed(s.startedAt) : '—');
    if (s && s.startedAt) age.title = new Date(s.startedAt).toLocaleString('ko-KR') + ' 시작';
    // 열기: 백그라운드 세션만 attach할 수 있다(D-89)
    const act = el('td', 'act');
    if (s && s.kind === 'background' && s.id) {
      const open = el('button', 'open-btn', '열기');
      open.type = 'button';
      open.setAttribute('aria-label', `${name} 열기 (새 터미널에서 attach)`);
      open.title = '새 터미널에서 이 세션에 들어갑니다';
      open.addEventListener('click', () => vscode.postMessage({ type: 'open', id: s.id, name }));
      act.append(open);
    }
    tr.append(who, st, age, act);
    if (isRevealed(s)) {
      tr.classList.add('is-revealed');
      tr.tabIndex = -1;
      if (!reveal.done) {
        reveal.done = true;
        requestAnimationFrame(() => {
          tr.scrollIntoView({ block: 'nearest' });
          tr.focus();
        });
      }
    }
    return warnRow ? [tr, warnRow] : [tr];
  }

  // 다른 프로젝트 세션 요약 한 줄(D-15). 세션 수와 메모리(세션·자식 프로세스 합, 못 재면 수만). 버튼 없음
  function renderOthers(others) {
    const p = $('sess-others');
    const list = others || [];
    p.hidden = !list.length;
    p.textContent = list.length ? '다른 프로젝트: ' + list.map((o) => `${o.project} 세션 ${o.count}개${Number.isFinite(o.mb) ? ` · 약 ${o.mb}MB` : ''}`).join(' · ') : '';
  }

  function renderSessions(msg) {
    const body = $('sess-body');
    body.classList.remove('is-loading');
    body.replaceChildren();
    renderOthers(msg.error ? [] : msg.others);
    if (msg.error) {
      const td = el('td');
      td.colSpan = 4;
      td.append(errLine('세션 목록을 읽지 못했습니다: ' + msg.error));
      const tr = el('tr');
      tr.append(td);
      body.append(tr);
      $('sess-sum').textContent = '';
      return;
    }
    // pm은 표가 아니라 표 바로 위 pm 줄에만 나온다(요약·역할 수에서도 뺀다)
    const sessions = msg.data.filter((s) => s.name !== pmName).map((s) => ({ name: s.name, s, st: STATES[s.view] ? s.view : 'input' }));
    const tableRoles = roles.filter((r) => r !== pmName);
    const seen = new Set(sessions.map((r) => r.name));
    const rows = sortRows([...sessions, ...tableRoles.filter((r) => !seen.has(r)).map((r) => ({ name: r, s: null, st: 'none' }))]);
    const top = rows.filter((r) => !isFoldable(r));
    const bottom = rows.filter(isFoldable);
    for (const r of top) body.append(...sessionRow(r.name, r.s, r.st));
    // 꺼짐·띄우지 않음은 접는 묶음(접은 상태는 webview state에 남는다)
    if (bottom.length) {
      const offFolded = folded.has('offRows');
      const tr = el('tr', 'fold-row');
      const td = el('td');
      td.colSpan = 4;
      const b = el('button', 'fold');
      b.type = 'button';
      b.id = 'off-fold';
      b.setAttribute('aria-expanded', String(!offFolded));
      const chev = icon('i-chev');
      chev.classList.add('chev');
      b.append(chev, el('span', null, `종료됨 ${bottom.filter((r) => r.st === 'off').length}` + (bottom.some((r) => r.st === 'none') ? ` · 미실행 ${bottom.filter((r) => r.st === 'none').length}` : '')));
      b.addEventListener('click', () => {
        if (folded.has('offRows')) folded.delete('offRows');
        else folded.add('offRows');
        vscode.setState({ ...saved, folded: [...folded] });
        renderSessions(lastSessions);
        const again = $('off-fold');
        if (again) again.focus();
      });
      td.append(b);
      tr.append(td);
      body.append(tr);
      if (!offFolded) for (const r of bottom) body.append(...sessionRow(r.name, r.s, r.st));
    }
    if (!rows.length) {
      const td = el('td', 'empty', '실행 중인 Claude 세션이 없습니다');
      td.colSpan = 4;
      const tr = el('tr');
      tr.append(td);
      body.append(tr);
    }

    const count = (st) => sessions.filter((r) => r.st === st).length;
    const live = sessions.filter((r) => r.s.alive).length;
    const parts = [`실행 중 ${live}`];
    if (count('permission')) parts.push(`권한 승인 대기 ${count('permission')}`);
    if (count('input')) parts.push(`입력 대기 ${count('input')}`);
    const warned = sessions.filter((r) => r.s.offWarning).length;
    if (warned) parts.push(`미전달 메시지 ${warned}`);
    $('sess-sum').textContent = parts.join(' · ') + (tableRoles.length ? ` / 역할 ${tableRoles.length}` : '');
  }

  // 끊긴 SSH 접속이 남긴 묶음(0.10.0): 정리 후보가 있을 때만 프로세스 블록 아래 한 줄. 확장은 못 읽으면 data를 null로 보낸다
  // 끊긴 SSH 묶음 줄(SSH 원격 호스트에서만 옴). [정리]는 관리자 창(SSH 원격 창)에서만 보인다(0.11.0)
  function renderOrphans(msg) {
    const p = $('proc-orphans');
    const d = msg.data;
    renderOrphansResult();
    if (msg.error || !d || !d.count) {
      p.hidden = true;
      return;
    }
    $('orphans-text').textContent = `끊긴 SSH 접속이 남긴 묶음 ${d.count}개 · ${d.mb} MB`;
    $('orphans-stop').hidden = !d.admin;
    p.title = d.admin
      ? '30분 넘게 쓰이지 않은 묶음만 끕니다(지금 서버·살아 있는 접속은 남김). 10분에 한 번 저절로도 정리합니다'
      : '정리는 SSH 원격 창(관리자 권한)에서 됩니다';
    p.hidden = false;
  }

  // 정리 결과 한 줄: 10분 지나면 숨긴다(줄은 60초마다 다시 그려진다)
  const ORPHANS_RESULT_MS = 10 * 60 * 1000;
  let orphansResult = null;
  function orphansResultText(r) {
    const what = r.kind === 'auto' ? '자동 정리' : '정리';
    if (r.error) return `${what}하지 못했습니다: ${r.error}`;
    if (!r.count) return `${what}: 끌 묶음이 없었습니다(그사이 다시 쓰이기 시작했거나 이미 꺼짐)`;
    return `${hhmm(new Date(r.at))} ${what}: ${r.count}묶음 · ${r.mb} MB 끔${r.failed ? ` · 프로세스 ${r.failed}개는 끄지 못함` : ''}`;
  }
  function renderOrphansResult() {
    const p = $('orphans-result');
    const r = orphansResult;
    // 자동 정리가 끌 것이 없었으면 알릴 일이 아니다
    if (!r || Date.now() - r.at > ORPHANS_RESULT_MS || (r.kind === 'auto' && !r.error && !r.count)) {
      p.hidden = true;
      return;
    }
    p.textContent = orphansResultText(r);
    p.classList.toggle('is-error', !!(r.error || r.failed));
    p.hidden = false;
  }
  function setOrphansBusy(busy) {
    const b = $('orphans-stop');
    b.disabled = busy;
    b.setAttribute('aria-busy', String(busy));
    b.textContent = busy ? '정리 중…' : '정리';
  }

  const RENDER = { memory: renderMemory, processes: renderProcesses, sessions: renderSessions, orphans: renderOrphans };

  // 접기: 상태는 webview state에 남기고, 접힌 블록은 확장이 읽지 않는다
  function applyFold(source, btnId, bodyId) {
    const btnEl = $(btnId);
    const isFolded = folded.has(source);
    btnEl.setAttribute('aria-expanded', String(!isFolded));
    $(bodyId).hidden = isFolded;
    btnEl.closest('.block').classList.toggle('is-folded', isFolded);
  }

  $('orphans-stop').addEventListener('click', () => {
    if ($('orphans-stop').disabled) return;
    setOrphansBusy(true);
    vscode.postMessage({ type: 'orphansStop' });
  });

  $('proc-fold').addEventListener('click', () => {
    const isFolded = !folded.has('processes');
    if (isFolded) folded.add('processes');
    else folded.delete('processes');
    vscode.setState({ ...saved, folded: [...folded] });
    applyFold('processes', 'proc-fold', 'proc-body');
    vscode.postMessage({ type: 'fold', source: 'processes', folded: isFolded });
  });
  applyFold('processes', 'proc-fold', 'proc-body');

  window.addEventListener('message', ({ data: msg }) => {
    if (msg.type === 'refreshed') {
      btn.setAttribute('aria-busy', 'false');
      btn.setAttribute('aria-disabled', 'false');
      announce(failed.size ? '새로고침했지만 일부 정보를 읽지 못했습니다' : '새로고침했습니다');
      return;
    }
    if (msg.type === 'roles') {
      roles = msg.data || [];
      if (lastSessions) renderSessions(lastSessions);
      return;
    }
    if (msg.type === 'limits') {
      const d = msg.data || {};
      limits = { warn: (d.warnFreeMB || 1024) * MB, block: (d.blockFreeMB || 500) * MB };
      if (lastMemory && !lastMemory.error) renderMemory(lastMemory);
      return;
    }
    if (msg.type === 'pm') {
      const name = (msg.data && msg.data.name) || null;
      const changed = name !== pmName;
      pmName = name;
      renderPm(msg.data);
      if (changed && lastSessions && !lastSessions.error) renderSessions(lastSessions);
      return;
    }
    if (msg.type === 'orphansBusy') {
      setOrphansBusy(true);
      return;
    }
    if (msg.type === 'orphansResult') {
      setOrphansBusy(false);
      orphansResult = msg.data || null;
      renderOrphansResult();
      if (orphansResult && !$('orphans-result').hidden) announce(orphansResultText(orphansResult));
      return;
    }
    if (msg.type === 'reveal') {
      reveal = { key: String(msg.sessionId || ''), until: Date.now() + REVEAL_MS, done: false };
      if (lastSessions && !lastSessions.error) renderSessions(lastSessions);
      return;
    }
    const render = RENDER[msg.type];
    if (!render) return;
    if (msg.type === 'sessions') lastSessions = msg;
    if (msg.type === 'memory') lastMemory = msg;
    render(msg);
    if (msg.error) failed.add(msg.type);
    else {
      failed.delete(msg.type);
      lastAt = Math.max(lastAt, msg.at);
    }
    stamp();
  });

  const btn = $('refresh');
  // disabled는 키보드 포커스를 잃게 하므로 aria-disabled로 막는다
  btn.addEventListener('click', () => {
    if (btn.getAttribute('aria-disabled') === 'true') return;
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-disabled', 'true');
    vscode.postMessage({ type: 'refresh' });
  });

  vscode.postMessage({ type: 'ready', folded: [...folded] });
})();
