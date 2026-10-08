// 활동 탭 렌더링. 상태는 activityView.js가 postMessage({type:'state'})로 보낸다.
// 보기: 스레드(세션 칩 줄 + 단계 사슬 카드, 기본) / 피드(시간순 메시지) / 시간(넓은 화면의 세션별 레인). 요약을 누르면 원문이 펼쳐진다.
(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const ui = {
    mode: ['feed', 'time'].includes(saved.mode) ? saved.mode : 'threads',
    range: [1, 3, 12].includes(saved.range) ? saved.range : 1,
    open: new Set(saved.open || []),
    doneOpen: saved.doneOpen === true, // '완료 n' 묶음: 기본 접힘
    dormantOpen: saved.dormantOpen === true, // '휴면 n' 묶음: 기본 접힘
    openMsg: new Set(),
    timeSel: null, // 시간 보기에서 고른 메시지
  };
  const WIDE = 680; // 이보다 좁으면 시간 보기 대신 묶음(목업: 좁은 폭은 묶음만)
  let state = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ico = (id, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

  // 역할 이름의 프로젝트 접두어(wy-ops.json rolePrefix, 확장이 state로 넘김)를 뗀다
  const unprefix = (name) => {
    const p = (state && state.rolePrefix) || '';
    const s = String(name || '');
    return p && s.toLowerCase().startsWith(p.toLowerCase()) ? s.slice(p.length) : s;
  };
  // 역할 이름 → 아바타 글자
  const SHORT = { pm: 'PM', commit: 'CM', qa: 'QA', search: 'SR', planner: 'PL', design: 'DS', browser: 'BR', frontend: 'FE', frontend2: 'F2', backend1: 'B1', backend2: 'B2', backend3: 'B3' };
  function initials(name) {
    if (!name || name === '(알 수 없음)') return '?';
    const n = unprefix(name);
    if (SHORT[n]) return SHORT[n];
    const m = n.match(/^([A-Za-z])[A-Za-z]*?(\d+)$/);
    return m ? (m[1] + m[2]).toUpperCase() : n.slice(0, 2).toUpperCase();
  }
  const short = (name) => unprefix(name);

  // 네 가지 상태와 순서(권한 대기 > 일하는 중 > 입력 대기 > 꺼짐). 꺼진 이유는 작은 글씨로
  const VIEW = {
    permission: ['권한 승인 대기', 0],
    working: ['작업 중', 1],
    input: ['입력 대기', 2],
    off: ['종료됨', 3],
  };
  const OFF_REASON = { stopped: '중지됨', done: '정상 종료', failed: '오류 종료' };
  // 꺼진 뒤 메시지가 온 세션은 꺼짐 묶음에 숨기지 않는다
  const warned = (s) => s.view === 'off' && s.offWarn > 0;
  const STAGE = {
    bug: ['i-bug', '결함 보고'],
    order: ['i-send', '지시·전달'],
    ask: ['i-hand', '결정 요청'],
    block: ['i-block', '차단'],
    commit: ['i-commit', '커밋'],
    verify: ['i-loop', '재검증'],
    done: ['i-check', '완료'],
  };
  const NEXT = { bug: '수정', order: '완료', ask: '결정', block: '해결', commit: '커밋', verify: '통과' };
  const BSTATE = {
    run: ['진행 중', 'i-loop'],
    bug: ['결함 미해결', 'i-bug'],
    ask: ['결정 대기', 'i-hand'],
    me: ['사용자 조치 필요', 'i-hand'],
    blocked: ['차단', 'i-block'],
    perm: ['권한 승인 대기', 'i-perm'],
    done: ['완료', 'i-check'],
  };

  function ago(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const m = Math.max(0, Math.round(((state && state.now) || Date.now()) - t) / 60000);
    if (m < 1) return '방금';
    if (m < 60) return `${Math.floor(m)}분 전`;
    if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
    return `${Math.floor(m / 1440)}일 전`;
  }
  const clock = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const full = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ko-KR');
  };

  const sessionView = (name) => {
    const s = state && state.sessions.find((x) => x.name === name);
    return s ? s.view + (warned(s) ? ' offwarn' : '') : '';
  };
  const av = (name, size = '') => `<span class="av ${size} ${sessionView(name)}" title="${esc(name)}">${esc(initials(name))}</span>`;

  function doingText(s) {
    if (s.view === 'permission') return s.pending && s.pending.command ? `권한 승인 대기 · ${s.pending.command}` : '권한 승인 대기';
    if (s.view === 'working') return s.doing || '작업 중';
    if (warned(s)) return `미전달 메시지 ${s.offWarn}건 · 재시작 필요`;
    if (s.view === 'off') return OFF_REASON[s.offReason] ? `종료됨 · ${OFF_REASON[s.offReason]}` : '종료됨';
    if (!VIEW[s.view]) return `상태: ${s.view || '알 수 없음'}`;
    return s.lastAt ? `입력 대기 · ${ago(s.lastAt)} 마지막 동작` : '입력 대기';
  }

  function renderStrip() {
    const strip = $('strip');
    const rank = (v) => (VIEW[v] ? VIEW[v][1] : 9); // 모르는 상태 값(세션 현황 쪽에서 새로 생긴 것)은 뒤로
    const live = state.sessions.filter((s) => s.view !== 'off' || warned(s)).sort((a, b) => rank(a.view) - rank(b.view));
    const stopped = state.sessions.filter((s) => s.view === 'off' && !warned(s));
    const chips = live.map((s) => {
      const text = doingText(s);
      return `<button type="button" class="sc ${s.view}${warned(s) ? ' offwarn' : ''}" data-session="${esc(s.sessionId || '')}" aria-label="${esc(`${s.name}, ${text}. 세션 현황에서 보기`)}" title="${esc(text)}">${av(s.name)}<span><span class="nm">${esc(short(s.name))}</span><span class="ac">${esc(text)}</span></span></button>`;
    });
    if (stopped.length) chips.push(`<span class="sc rest" title="${esc(stopped.map((s) => `${s.name}(${OFF_REASON[s.offReason] || '종료됨'})`).join(', '))}">종료됨 ${stopped.length}</span>`);
    if (state.statusError) chips.push(`<span class="err">${ico('i-warn', 'i-s')}세션 상태를 읽지 못함: ${esc(state.statusError)}</span>`);
    strip.innerHTML = chips.join('') || '<span class="sc rest">실행 중인 세션 없음</span>';
  }

  function renderSum() {
    const count = (v) => state.sessions.filter((s) => s.view === v).length;
    const parts = [`작업 중 <b>${count('working')}</b>`];
    if (count('permission')) parts.push(`권한 승인 대기 <b>${count('permission')}</b>`);
    if (count('input')) parts.push(`입력 대기 <b>${count('input')}</b>`);
    const warnedCount = state.sessions.filter(warned).length;
    if (warnedCount) parts.push(`미전달 메시지 <b>${warnedCount}</b>`);
    parts.push(`최근 ${state.windowHours}시간 메시지 <b>${state.feed.length}</b>`);
    if (state.unreadable) parts.push(`<span class="warn" title="Claude Code 트랜스크립트 형식이 바뀌었을 수 있습니다. 해당 줄은 건너뛰었습니다.">${ico('i-warn', 'i-s')}파싱 실패 ${state.unreadable}</span>`);
    $('sum').innerHTML = parts.join(' · ');
  }

  function msgRow(id, withStage) {
    const m = state.messages[id];
    if (!m) return '';
    const open = ui.openMsg.has(id);
    const stage = withStage ? `<span class="ic c-${withStage}" title="${esc(STAGE[withStage][1])}">${ico(STAGE[withStage][0], 'i-s')}</span>` : '';
    return `<li class="msg ${open ? 'open' : ''}" data-msg="${esc(id)}"><button type="button" aria-expanded="${open}" aria-label="${esc(`${m.from}이(가) ${m.to}에게: ${m.title}. ${open ? '원문 접기' : '원문 펼치기'}`)}">${stage}${av(m.from, 'xs')}<span class="ar">${ico('i-send', 'i-s')}${av(m.to, 'xs')}</span><span class="tx">${esc(m.title)}</span><span class="tm" title="${esc(full(m.at))}">${esc(clock(m.at))}</span></button>${open ? `<div class="body">${esc(m.body)}</div>` : ''}</li>`;
  }

  function chainHtml(b) {
    let steps = b.steps.map((s, i) => ({ who: initials(s.from), stage: s.stage, st: b.state === 'done' || i < b.steps.length - 1 ? 'done' : 'now' }));
    if (steps.length > 6) steps = [steps[0], { gap: steps.length - 5 }, ...steps.slice(-4)];
    if (b.state !== 'done') {
      const last = b.steps[b.steps.length - 1].stage;
      if (NEXT[last]) steps.push({ who: NEXT[last], st: 'todo' });
    }
    const nodes = steps.map((s, i) => {
      const prev = steps[i - 1];
      const lk = i === 0 ? '' : `<span class="lk ${prev.st === 'done' && s.st === 'done' ? 'done' : prev.st === 'done' && s.st === 'now' ? 'run' : ''}"></span>`;
      if (s.gap) return `${lk}<div class="sn gap"><span class="ic">+${s.gap}</span><span class="who">…</span></div>`;
      const icon = s.st === 'todo' ? 'i-check' : STAGE[s.stage][0];
      const label = s.st === 'todo' ? `다음: ${s.who}` : `${s.who} ${STAGE[s.stage][1]}${s.st === 'now' ? '(지금)' : ''}`;
      return `${lk}<div class="sn ${s.st} c-${s.stage || 'dim'}" title="${esc(label)}"><span class="ic">${ico(icon, 'i-s')}</span><span class="who">${esc(s.who)}</span></div>`;
    });
    return `<div class="chain" role="img" aria-label="${esc(`메시지 ${b.steps.length}개: ${b.steps.map((s) => STAGE[s.stage][1]).join(' → ')}`)}">${nodes.join('')}</div>`;
  }

  // 진행 중 묶음은 위(최근에 움직인 순). 그 아래 '휴면 n'(2시간 넘게 조용한 진행 중), 맨 아래 '완료 n'.
  // 두 묶음 모두 기본 접힘이고 접힘 상태는 webview에 기억한다. 휴면·완료 판정은 확장(activityView.js)이 한다
  const GROUPS = {
    dormant: { label: '유휴', icon: 'i-clock', aria: '2시간 넘게 움직임이 없는 스레드', key: 'dormantOpen' },
    done: { label: '완료', icon: 'i-check', aria: '완료된 스레드', key: 'doneOpen' },
  };

  function renderThreads() {
    if (!state.bundles.length) return empty('아직 세션 간 메시지가 없습니다', `최근 ${state.windowHours}시간 안에 세션이 SendMessage로 주고받은 메시지가 여기에 묶여 보입니다.`);
    const running = state.bundles.filter((b) => !b.done && !b.dormant);
    const top = running.length ? `<div class="threads">${cards(running)}</div>` : '<p class="none">진행 중인 스레드가 없습니다.</p>';
    return top + group('dormant', state.bundles.filter((b) => b.dormant)) + group('done', state.bundles.filter((b) => b.done));
  }

  function group(kind, list) {
    if (!list.length) return '';
    const g = GROUPS[kind];
    const open = ui[g.key];
    return `<section class="done-group g-${kind}" aria-label="${g.aria}">
      <button type="button" class="done-toggle" data-group="${kind}" aria-expanded="${open}"${open ? ` aria-controls="${kind}-list"` : ''}>${ico('i-down', 'i-s')}${ico(g.icon, 'i-s')}${g.label} <b>${list.length}</b>${open ? '' : `<span class="dt-last">마지막 ${esc(ago(list[0].lastAt))}</span>`}</button>
      ${open ? `<div class="threads done-list" id="${kind}-list">${cards(list)}</div>` : ''}</section>`;
  }

  function cards(list) {
    return list
      .map((b) => {
        const isOpen = ui.open.has(b.key);
        const [label, icon] = BSTATE[b.state] || BSTATE.run;
        const head = STAGE[b.steps[0].stage][0];
        return `<article class="th c-${b.steps[0].stage}" data-key="${esc(b.key)}"><div class="th-h">${ico(head)}<span class="t" title="${esc(b.title)}">${esc(b.title)}</span><span class="pill c-${b.state}">${ico(icon, 'i-s')}${label}</span><span class="tm" title="${esc(full(b.lastAt))}">${esc(ago(b.lastAt))}</span></div>
        ${chainHtml(b)}
        ${isOpen ? `<ul class="msgs">${b.steps.map((s) => msgRow(s.id, s.stage)).join('')}</ul>` : ''}
        <div class="th-f"><button type="button" class="more" data-thread="${esc(b.key)}" aria-expanded="${isOpen}">${ico('i-down', 'i-s')}메시지 ${b.steps.length}</button>
        ${b.card ? `<button type="button" class="to-card c-${b.state}" data-card="${esc(b.card.id)}" title="${esc(b.card.title || '')}">카드 열기 ${ico('i-arrow', 'i-s')}</button>` : ''}</div></article>`;
      })
      .join('');
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const now = new Date((state && state.now) || Date.now());
    const key = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
    if (key(d) === key(now)) return '오늘';
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (key(d) === key(y)) return '어제';
    return d.toLocaleDateString('ko-KR');
  }

  function renderFeed() {
    if (!state.feed.length) return empty('아직 세션 간 메시지가 없습니다', `최근 ${state.windowHours}시간 안에 세션이 주고받은 메시지가 최신순으로 보입니다.`);
    const stageOf = new Map();
    for (const b of state.bundles) for (const s of b.steps) stageOf.set(s.id, s.stage);
    let day = '';
    const rows = [];
    for (const id of state.feed) {
      const m = state.messages[id];
      const d = dayLabel(m.at);
      if (d !== day) {
        day = d;
        rows.push(`<li class="day" role="presentation">${esc(d)}</li>`);
      }
      rows.push(msgRow(id, stageOf.get(id) || 'order'));
    }
    return `<ul class="feed">${rows.join('')}</ul>`;
  }

  const empty = (title, text, err) => `<div class="empty ${err ? 'err' : ''}"><b>${esc(title)}</b>${esc(text)}</div>`;

  // 주기 갱신으로 다시 그려도 키보드 초점이 같은 버튼에 남게 한다
  function focusSelector() {
    const el = document.activeElement;
    if (el && el.dataset && el.dataset.tmsg) return `[data-tmsg="${CSS.escape(el.dataset.tmsg)}"]`;
    if (!el || el.tagName !== 'BUTTON') return null;
    if (el.dataset.group) return `button[data-group="${CSS.escape(el.dataset.group)}"]`;
    for (const k of ['mode', 'range', 'thread', 'card', 'session']) if (el.dataset[k] !== undefined) return `button[data-${k}="${CSS.escape(el.dataset[k])}"]`;
    const li = el.closest('.msg');
    return li ? `.msg[data-msg="${CSS.escape(li.dataset.msg)}"] > button` : null;
  }

  function render() {
    const sel = focusSelector();
    paint();
    const again = sel && document.querySelector(sel);
    if (again && again !== document.activeElement) again.focus();
  }

  const effectiveMode = () => (ui.mode === 'time' && document.documentElement.clientWidth < WIDE ? 'threads' : ui.mode);

  function paint() {
    const mode = effectiveMode();
    document.querySelectorAll('button[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    document.querySelectorAll('button[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === ui.range)));
    $('range').hidden = mode !== 'time';
    if (!state) return;
    if (state.error) {
      $('sum').textContent = '';
      $('strip').innerHTML = '';
      $('main').innerHTML = empty('활동을 보여 줄 수 없습니다', state.error, true);
      return;
    }
    renderSum();
    renderStrip();
    $('main').innerHTML = state.transcriptsMissing
      ? empty('트랜스크립트 폴더를 찾지 못했습니다', `${state.transcriptsMissing} 에 세션 트랜스크립트가 없습니다. 이 창에 연 폴더가 세션을 실행한 저장소와 같은지 확인해 주세요. 세션 상태는 위 칩에 그대로 보입니다.`, true)
      : mode === 'feed' ? renderFeed() : mode === 'time' ? renderTime() : renderThreads();
  }

  // ── 시간 보기: 세션마다 한 줄, 가로가 시간. 띠 = 일한 구간, 화살표 = 메시지, 점선 상자 = 진행 중인 묶음 ──
  const LANE_H = 40;
  const TOP = 34;
  const X0 = 150;
  const X1 = 930;
  const TICK = { 1: 10, 3: 30, 12: 120 }; // 범위(시간)별 눈금 간격(분)

  // SVG 글자는 말줄임이 안 되므로 폭으로 자른다: 한글 등 넓은 글자는 2칸, 영숫자는 1칸(12px 굵은 글씨 기준 1칸 ≈ 7px)
  function fitLabel(text, units) {
    const w = (ch) => (/[^\u0000-ɏ]/.test(ch) ? 2 : 1);
    const chars = [...text];
    if (chars.reduce((s, c) => s + w(c), 0) <= units) return text;
    let out = '';
    let used = 1; // 말줄임표 자리
    for (const c of chars) {
      if (used + w(c) > units) break;
      out += c;
      used += w(c);
    }
    return `${out}…`;
  }

  function renderTime() {
    const now = state.now;
    const t0 = now - ui.range * 3600000;
    const x = (t) => X0 + ((Math.max(t0, Math.min(now, t)) - t0) / (now - t0)) * (X1 - X0);
    const msgs = state.feed.map((id) => ({ id, ...state.messages[id] })).filter((m) => Date.parse(m.at) >= t0);
    const lanesBy = new Map(state.lanes.map((l) => [l.name, { bands: l.bands.filter((b) => b[1] >= t0), from: l.from }]));

    // 레인: 살아 있는 세션, 이 범위에서 일했거나 메시지를 주고받은 세션. 순서는 세션 칩과 같게
    const want = new Set(msgs.flatMap((m) => [m.from, m.to]));
    for (const [n, l] of lanesBy) if (l.bands.length) want.add(n);
    for (const s of state.sessions) if (s.view !== 'off' || warned(s)) want.add(s.name);
    const order = state.sessions.map((s) => s.name);
    const names = [...want].filter((n) => n && n !== '(알 수 없음)').sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
    if (!names.length) return empty('이 범위에 활동이 없습니다', '더 긴 범위를 고르거나, 세션이 일을 시작하면 여기에 띠와 화살표가 나타납니다.');
    const y = (n) => TOP + 20 + names.indexOf(n) * LANE_H;
    const H = TOP + 20 + names.length * LANE_H + 6;

    const ticks = [];
    const step = TICK[ui.range] * 60000;
    for (let t = Math.ceil(t0 / step) * step; t < now - step / 3; t += step) ticks.push(`<line class="grid" x1="${x(t)}" y1="${TOP - 6}" x2="${x(t)}" y2="${H}"/><text class="tick" x="${x(t)}" y="${TOP - 12}" text-anchor="middle">${esc(clock(new Date(t).toISOString()))}</text>`);

    const lanes = names.map((n) => {
      const view = sessionView(n) || 'off';
      const yy = y(n);
      const l = lanesBy.get(n) || { bands: [], from: null };
      // 처음 열 때 기록 끝부분만 읽으므로, 읽기 시작한 시각보다 앞은 '모름'으로 칠한다(비어 있다고 오해하지 않게)
      const unread = l.from && l.from > t0 ? `<rect class="unread" x="${X0}" y="${yy - 7}" width="${x(l.from) - X0}" height="14" rx="3"><title>이 앞은 읽지 않음(처음 열 때 기록 끝부분만 읽습니다)</title></rect>` : '';
      const bands = l.bands.map(([a, b]) => `<rect class="band" x="${x(a)}" y="${yy - 6}" width="${Math.max(3, x(b) - x(a))}" height="12" rx="6"/>`).join('');
      const tailKind = view.includes('offwarn') ? 'offwarn' : ['permission', 'input'].includes(view) ? view : '';
      const tail = tailKind ? `<rect class="tail tail-${tailKind}" x="${X1 - 28}" y="${yy - 6}" width="28" height="12" rx="6"><title>${tailKind === 'offwarn' ? '미전달 메시지' : esc(VIEW[view][0])}</title></rect>` : '';
      const label = fitLabel(short(n), 15); // 이름 칸(약 110px)을 넘지 않게
      return `<g class="lane ${view}"><title>${esc(n)}</title><circle class="lav" cx="${16}" cy="${yy}" r="11"/><text class="lav-t" x="16" y="${yy + 4}" text-anchor="middle">${esc(initials(n))}</text><text class="lane-n" x="34" y="${yy + 4}">${esc(label)}</text>
        <rect class="track" x="${X0}" y="${yy - 2}" width="${X1 - X0}" height="4" rx="2"/>${unread}${bands}${tail}</g>`;
    }).join('');

    // 진행 중인 묶음(작업 ID, 메시지 2개 이상) 중 가장 최근 것 하나를 점선 상자로(여럿이면 이름표가 겹친다)
    const stageOf = new Map();
    for (const b of state.bundles) for (const s of b.steps) stageOf.set(s.id, s.stage);
    const boxes = state.bundles
      .filter((b) => b.taskId && b.state !== 'done')
      .map((b) => ({ b, in: b.steps.map((s) => state.messages[s.id]).filter((m) => m && Date.parse(m.at) >= t0 && names.includes(m.from) && names.includes(m.to)) }))
      .filter((v) => v.in.length >= 2)
      .slice(0, 1)
      .map(({ b, in: ms }) => {
        const xs = ms.map((m) => x(Date.parse(m.at)));
        const ys = ms.flatMap((m) => [y(m.from), y(m.to)]);
        const bx = Math.min(...xs) - 10;
        const by = Math.min(...ys) - 16;
        return `<g class="box c-${b.state}"><rect x="${bx}" y="${by}" width="${Math.max(...xs) - bx + 16}" height="${Math.max(...ys) - by + 16}" rx="10"/><text x="${bx + 8}" y="${by - 4}">${esc(b.taskId)} · ${esc((BSTATE[b.state] || BSTATE.run)[0])}</text></g>`;
      })
      .join('');

    const arrows = msgs
      .filter((m) => names.includes(m.from) && names.includes(m.to))
      .map((m) => {
        const stage = stageOf.get(m.id) || 'order';
        const ax = x(Date.parse(m.at));
        const y1 = y(m.from);
        const y2 = y(m.to);
        const d = y1 === y2 ? `M${ax} ${y1 - 7} c 8 -14, 16 -14, 18 0` : `M${ax} ${y1 + (y2 > y1 ? 7 : -7)} C ${ax + 6} ${(y1 + y2) / 2}, ${ax + 6} ${(y1 + y2) / 2}, ${ax + 8} ${y2 + (y2 > y1 ? -9 : 9)}`;
        const sel = ui.timeSel === m.id ? ' sel' : '';
        return `<g class="hit c-${stage}${sel}" tabindex="0" role="button" data-tmsg="${esc(m.id)}" aria-pressed="${!!sel}" aria-label="${esc(`${clock(m.at)} ${m.from}이(가) ${m.to}에게: ${m.title}`)}"><path class="halo" d="${d}"/><path class="arr" d="${d}" marker-end="url(#mk-${stage})"/><circle class="dot" cx="${ax}" cy="${y1}" r="3.5"/><title>${esc(`${clock(m.at)} ${short(m.from)} → ${short(m.to)}: ${m.title}`)}</title></g>`;
      })
      .join('');

    const markers = Object.keys(STAGE).map((k) => `<marker id="mk-${k}" class="c-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="mk" d="M0 0 10 5 0 10Z"/></marker>`).join('');
    const nowLine = `<line class="now-line" x1="${X1}" y1="${TOP - 10}" x2="${X1}" y2="${H}"/><rect class="now-pill" x="${X1 - 19}" y="${TOP - 26}" width="38" height="16" rx="8"/><text class="now-t" x="${X1}" y="${TOP - 14}" text-anchor="middle">지금</text>`;
    const legend = [['band', '활동 구간'], ['tail-permission', '권한 승인 대기'], ['tail-input', '입력 대기'], ['tail-offwarn', '미전달 메시지']]
      .map(([c, t]) => `<span><i class="lg ${c}"></i>${t}</span>`).join('') + `<span><i class="lg box-lg"></i>진행 중인 스레드</span><span><i class="lg unread"></i>미로드 구간</span>`;

    const selRow = ui.timeSel && state.messages[ui.timeSel] ? `<ul class="feed sel-msg">${msgRow(ui.timeSel, stageOf.get(ui.timeSel) || 'order')}</ul>` : `<p class="hint">화살표를 누르면 그 메시지의 원문이 여기에 펼쳐집니다.</p>`;
    return `<div class="lanes"><svg viewBox="0 0 ${X1 + 30} ${H}" role="group" aria-label="${esc(`최근 ${ui.range}시간 세션별 활동, 메시지 ${msgs.length}개`)}"><defs>${markers}</defs>${ticks.join('')}${boxes}${lanes}${arrows}${nowLine}</svg></div>
      <div class="legend">${legend}</div>${selRow}`;
  }

  const save = () => vscode.setState({ mode: ui.mode, range: ui.range, open: [...ui.open], doneOpen: ui.doneOpen, dormantOpen: ui.dormantOpen });

  function pickTimeMsg(id) {
    ui.timeSel = ui.timeSel === id ? null : id;
    if (ui.timeSel) ui.openMsg.add(id);
    render();
  }

  document.addEventListener('keydown', (e) => {
    const g = e.target.closest && e.target.closest('[data-tmsg]');
    if (g && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      pickTimeMsg(g.dataset.tmsg);
    }
  });

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-tmsg]');
    if (g) return pickTimeMsg(g.dataset.tmsg);
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.mode) {
      ui.mode = t.dataset.mode;
      save();
      render();
    } else if (t.dataset.range) {
      ui.range = Number(t.dataset.range);
      save();
      render();
    } else if (GROUPS[t.dataset.group]) {
      const k = GROUPS[t.dataset.group].key;
      ui[k] = !ui[k];
      save();
      render();
    } else if (t.dataset.thread) {
      const k = t.dataset.thread;
      if (ui.open.has(k)) ui.open.delete(k);
      else ui.open.add(k);
      save();
      render();
    } else if (t.dataset.card) {
      vscode.postMessage({ type: 'openCard', id: t.dataset.card });
    } else if (t.dataset.session !== undefined) {
      if (t.dataset.session) vscode.postMessage({ type: 'revealSession', sessionId: t.dataset.session });
    } else {
      const li = t.closest('.msg');
      if (!li) return;
      const id = li.dataset.msg;
      if (ui.openMsg.has(id)) ui.openMsg.delete(id);
      else ui.openMsg.add(id);
      render();
    }
  });

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'state') {
      state = e.data.state;
      // 모르는 단계 값(읽기 모듈이 새 머리표를 배운 경우)은 '지시·전달'로 그린다
      for (const b of state.bundles || []) for (const s of b.steps) if (!STAGE[s.stage]) s.stage = 'order';
      render();
    }
  });
  // 폭이 기준을 넘나들면 시간 보기와 묶음을 바꿔 그린다
  let wasWide = document.documentElement.clientWidth >= WIDE;
  window.addEventListener('resize', () => {
    const wide = document.documentElement.clientWidth >= WIDE;
    if (wide !== wasWide) {
      wasWide = wide;
      render();
    }
  });
  render();
  vscode.postMessage({ type: 'ready' });
})();
