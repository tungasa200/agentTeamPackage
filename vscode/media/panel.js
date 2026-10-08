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

  function renderSessions(msg) {
    const body = $('sess-body');
    body.classList.remove('is-loading');
    body.replaceChildren();
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
    const sessions = msg.data.map((s) => ({ name: s.name, s, st: STATES[s.view] ? s.view : 'input' }));
    const seen = new Set(sessions.map((r) => r.name));
    const rows = sortRows([...sessions, ...roles.filter((r) => !seen.has(r)).map((r) => ({ name: r, s: null, st: 'none' }))]);
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
    $('sess-sum').textContent = parts.join(' · ') + (roles.length ? ` / 역할 ${roles.length}` : '');
  }

  const RENDER = { memory: renderMemory, processes: renderProcesses, sessions: renderSessions };

  // 접기: 상태는 webview state에 남기고, 접힌 블록은 확장이 읽지 않는다
  function applyFold(source, btnId, bodyId) {
    const btnEl = $(btnId);
    const isFolded = folded.has(source);
    btnEl.setAttribute('aria-expanded', String(!isFolded));
    $(bodyId).hidden = isFolded;
    btnEl.closest('.block').classList.toggle('is-folded', isFolded);
  }

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
