// 승인 센터 탭 렌더링(OPS-01~03·08, 목업 docs/운영도구/승인센터_목업.html의 받은 요청·처리됨).
// 상태는 approvalCenter.js가 'state'로 보낸다. 형식: 운영 도구 구현 계획 2.2와 approvalStore.readRequest.
(() => {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const MIN = 60000;
  const DAY = 1440;
  const WIDE = 680; // 목록·상세 2단이 되는 폭(CSS @container와 같은 값)

  const GIT_ICON = { push: 'i-push', 'force-push': 'i-push' };
  const KIND = {
    permission: { label: '권한 요청', icon: 'i-perm', c: 'var(--k-perm)', f: 'perm', g: 0 },
    choice: { label: '결정 요청', icon: 'i-choice', c: 'var(--k-choice)', f: 'choice', g: 1 },
    git: { label: 'git', icon: 'i-commit', c: 'var(--k-git)', f: 'git', g: 1 },
    todo: { label: '할 일', icon: 'i-todo', c: 'var(--k-todo)', f: 'todo', g: 2 },
    broken: { label: '형식 오류', icon: 'i-broken', c: 'var(--err)', f: 'broken', g: 3 },
  };
  const GROUPS = [['차단', 'urgent'], ['결정 대기', ''], ['할 일', ''], ['형식 오류', '']];
  const FILTERS = [['all', '전체', null], ['perm', '권한 요청', 'var(--k-perm)'], ['choice', '결정 요청', 'var(--k-choice)'], ['git', 'git', 'var(--k-git)'], ['todo', '할 일', 'var(--k-todo)'], ['broken', '형식 오류', 'var(--err)']];
  const PRI = { urgent: ['긴급', 'i-p-urgent'], high: ['높음', 'i-p-high'], normal: ['보통', 'i-p-normal'] };
  // 요청 세션이 onClick을 비워 보냈을 때(B2-2 전) 쓰는 기본 문구
  const THEN = {
    permission: '이 명령을 이번 한 번만 실행하고 세션이 이어 갑니다. 영구 허용 규칙은 만들지 않습니다.',
    choice: '고른 답이 요청한 세션에 전달되고, 세션이 그대로 이어 갑니다.',
    git: '요청한 세션이 이 명령을 그대로 한 번 실행합니다.',
    todo: '요청한 세션이 "완료"를 받아 다음 단계로 넘어갑니다.',
  };

  let state = null;
  let lastJson = '';
  let kinds = {};
  let routineKinds = [];
  let rolePrefix = ''; // 역할 이름의 프로젝트 접두어(wy-ops.json rolePrefix, 확장이 state로 넘김)
  const ui = { view: 'inbox', filter: 'all', sel: null, rejecting: null, memo: null, files: false, keysFull: false, alertsOpen: false };
  const ALERTS_SHOWN = 2;
  const drafts = new Map(); // id → { answers, note, reason, ticks }
  const invalid = new Map(); // 결정 카드 id → 답하지 않은 질문 번호
  const errors = new Map();
  const busy = new Set();
  const fresh = new Set(); // 탭을 연 뒤 새로 온 카드(고르면 지움)
  let known = null;
  let pendingSelect = null;
  let focusAfter = null; // 다시 그린 뒤 포커스를 둘 요소 id

  /* ── 작은 도우미 ── */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function ico(id, cls = 'i') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  }
  // `코드` 표기만 <code>로 바꾼다(요청 파일의 글은 HTML로 해석하지 않는다)
  function rich(tag, cls, text) {
    const e = el(tag, cls);
    String(text || '').split(/(`[^`\n]+`)/).forEach((part) => {
      if (/^`[^`]+`$/.test(part)) e.append(el('code', null, part.slice(1, -1)));
      else if (part) e.append(document.createTextNode(part));
    });
    return e;
  }
  function button(cls, label, onClick, { icon, id, kbd, title } = {}) {
    const b = el('button', cls);
    b.type = 'button';
    if (id) b.id = id;
    if (title) b.title = title;
    if (icon) b.append(ico(icon, 'i-s'));
    if (label) b.append(el('span', null, label));
    if (kbd) b.append(el('kbd', null, kbd));
    b.addEventListener('click', (e) => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      onClick(e);
    });
    return b;
  }
  const announce = (t) => ($('announce').textContent = t);
  const minutesSince = (iso) => {
    const t = Date.parse(iso);
    return t ? Math.max(0, Math.floor((Date.now() - t) / MIN)) : null;
  };
  const ago = (m) => (m == null ? '' : m < 1 ? '방금' : m < 60 ? `${m}분` : m < DAY ? `${Math.floor(m / 60)}시간` : `${Math.floor(m / DAY)}일`);
  const ageCls = (m) => (m == null ? '' : m >= DAY ? 'stale' : m >= 30 ? 'aging' : '');
  const fullTime = (iso) => (Date.parse(iso) ? new Date(iso).toLocaleString('ko-KR') : '');
  const wide = () => app.clientWidth >= WIDE;

  /* ── 카드 해석 ── */
  const kindOf = (r) => (r.broken ? 'broken' : r.kind === 'permission' || r.kind === 'choice' || r.kind === 'todo' ? r.kind : 'git');
  const isPmGit = (r) => kindOf(r) === 'git' && !routineKinds.includes(r.kind);
  function meta(r) {
    const k = KIND[kindOf(r)];
    if (k.f !== 'git') return k;
    return { ...k, label: kinds[r.kind] || r.kind, icon: GIT_ICON[r.kind] || 'i-commit' };
  }
  function titleOf(r) {
    if (r.broken) return `requests/${r.id}.json`;
    const q = r.questions && r.questions[0];
    return r.title || r.what || (r.kind === 'permission' && [r.tool, r.command].filter(Boolean).join(' · ')) || r.command || (q && q.question) || '(제목 없음)';
  }
  // 권한 카드의 남은 시간(분)과 전체 길이(기본 15분)
  function timeLeft(r) {
    const end = Date.parse(r.expiresAt);
    if (!end) return null;
    const start = Date.parse(r.createdAt);
    const total = start && end > start ? (end - start) / MIN : 15;
    return { left: Math.max(0, Math.ceil((end - Date.now()) / MIN)), total };
  }
  function priority(r) {
    if (r.priority && PRI[r.priority]) return r.priority;
    if (r.kind === 'permission') return 'urgent';
    const m = minutesSince(r.createdAt);
    if (isPmGit(r) || (m != null && m >= DAY)) return 'high';
    return 'normal';
  }
  function initials(name) {
    const raw = String(name || '');
    const base = (rolePrefix && raw.toLowerCase().startsWith(rolePrefix.toLowerCase()) ? raw.slice(rolePrefix.length) : raw).replace(/^세션\s+/, '');
    const m = base.match(/^([A-Za-z])[A-Za-z]*?(\d+)$/);
    if (m) return (m[1] + m[2]).toUpperCase();
    return (base.replace(/[^A-Za-z0-9가-힣]/g, '').slice(0, 2) || '?').toUpperCase();
  }
  function avatar(name, { size = '', ended = false } = {}) {
    const a = el('span', `av ${size}${ended ? ' ended' : ''}`, initials(name));
    a.title = name + (ended ? ' · 세션 종료됨' : '');
    a.setAttribute('aria-hidden', 'true');
    return a;
  }
  function chip(cls, text, icon) {
    const c = el('span', 'mc ' + (cls || ''));
    if (icon) c.append(ico(icon, 'i-s'));
    c.append(el('span', 'mc-tx', text)); // 긴 브랜치 이름은 말줄임(글자는 title로)
    c.title = text;
    return c;
  }
  function chipsOf(r) {
    const out = [];
    const k = kindOf(r);
    if (k === 'broken') out.push(chip('red', '처리할 수 없음'));
    if (k === 'git') {
      if (r.branch) out.push(chip('mono', r.branch));
      if (r.fileCount != null) out.push(chip('', `파일 ${r.fileCount}`));
      if (r.commits && r.commits.length) out.push(chip('', `커밋 ${r.commits.length}`));
      out.push(r.verification ? chip('ok', '검증', 'i-check') : chip('warn', '검증 결과 없음'));
      if (isPmGit(r)) out.push(chip('red', 'PM 결정'));
    }
    if (k === 'choice') out.push(chip('', `질문 ${r.questions.length}`));
    if (k === 'todo' && r.steps && r.steps.length) out.push(chip('', `단계 ${r.steps.length}`));
    if (k === 'todo' && r.shell) out.push(chip('mono', r.shell === 'bash' ? 'Bash' : 'PowerShell'));
    if (k === 'permission' && r.tool) out.push(chip('mono', r.tool));
    if (r.sessionEnded) out.push(chip('red', '세션 종료됨'));
    return out;
  }

  /* ── 목록 ── */
  const pending = () => (state ? state.pending : []);
  const visible = () =>
    pending()
      .filter((r) => ui.filter === 'all' || KIND[kindOf(r)].f === ui.filter)
      .slice()
      .sort((a, b) => KIND[kindOf(a)].g - KIND[kindOf(b)].g || String(a.createdAt).localeCompare(String(b.createdAt)));

  function head() {
    const n = pending().length;
    const hd = el('div', 'hd');
    const row = el('div', 'hd-row');
    row.append(el('h1', null, '승인 센터'));
    if (n) {
      const b = el('span', 'badge', String(n));
      b.setAttribute('aria-label', `남은 요청 ${n}건`);
      row.append(b);
    }
    row.append(el('span', 'hd-sp'));
    const act = button('icon-btn', null, () => vscode.postMessage({ type: 'openActivity' }), { icon: 'i-activity', id: 'open-activity', title: '활동 탭 열기 (g a)' });
    act.setAttribute('aria-label', '활동 탭 열기');
    const folder = button('icon-btn', null, () => vscode.postMessage({ type: 'openFolder' }), { icon: 'i-folder', id: 'open-folder', title: '요청 폴더 열기' });
    folder.setAttribute('aria-label', '요청 폴더 열기');
    row.append(act, folder);
    const tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    const tab = (v, label, extra) => {
      const t = button('tab', label, () => {
        ui.view = v;
        focusAfter = 'tab-' + v;
        render();
      }, { id: 'tab-' + v });
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(ui.view === v));
      t.setAttribute('aria-controls', 'view');
      t.tabIndex = ui.view === v ? 0 : -1;
      if (extra != null) t.append(el('span', 'n', String(extra)));
      return t;
    };
    tabs.append(tab('inbox', '대기 중', n), tab('hist', '처리됨'));
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      ui.view = ui.view === 'inbox' ? 'hist' : 'inbox';
      focusAfter = 'tab-' + ui.view;
      render();
    });
    hd.append(row, tabs);
    return hd;
  }

  function alerts() {
    const box = el('div', 'alerts');
    const add = (cls, title, text, extra) => {
      const a = el('div', 'alert ' + cls);
      a.setAttribute('role', cls === 'err' ? 'alert' : 'status');
      const tx = el('div', 'tx');
      tx.append(el('b', null, title), document.createTextNode(text));
      a.append(ico(cls === 'err' ? 'i-x' : 'i-warn', 'i-s'), tx, extra || el('span'));
      box.append(a);
    };
    if (state.error) add('err', '승인 파일을 읽지 못했습니다', state.error);
    for (const id of state.untrusted || []) {
      const ack = button('btn secondary', '확인', () => vscode.postMessage({ type: 'ackUntrusted', id }), { id: 'ack-' + id, title: '내용을 확인했습니다. 같은 내용이면 다시 표시하지 않습니다(신뢰하는 것은 아님)' });
      add('err', '출처 불명 결정', `decisions/${id}.json — 승인 센터가 쓰지 않은 결정입니다. 위조일 수 있으니 열어 확인하세요.`, ack);
    }
    for (const w of state.roleWarnings || []) {
      add('', '커밋 세션 역할 누락', `${w.name}(${w.id || '?'})이 --agent ${w.name} 없이 실행 중입니다. 커밋이 가드 훅에 막히니 session.ps1 rotate ${w.name} none으로 세션을 교체하세요.`);
    }
    if (state.notice) add('', '옛 승인 폴더', state.notice);
    if (!box.childNodes.length) return null;
    // 경고가 많으면 목록이 화면 밖으로 밀리므로 둘만 보이고 나머지는 접는다
    const all = [...box.childNodes];
    if (all.length > ALERTS_SHOWN && !ui.alertsOpen) {
      all.slice(ALERTS_SHOWN).forEach((a) => a.remove());
      box.append(button('link', `경고 ${all.length - ALERTS_SHOWN}개 더 보기`, () => {
        ui.alertsOpen = true;
        focusAfter = 'alerts-less';
        render();
      }, { id: 'alerts-more' }));
    } else if (all.length > ALERTS_SHOWN) {
      box.append(button('link', '경고 접기', () => {
        ui.alertsOpen = false;
        focusAfter = 'alerts-more';
        render();
      }, { id: 'alerts-less' }));
    }
    return box;
  }

  function filters() {
    const counts = {};
    for (const r of pending()) counts[KIND[kindOf(r)].f] = (counts[KIND[kindOf(r)].f] || 0) + 1;
    if (Object.keys(counts).length < 2 && ui.filter === 'all') return null;
    const bar = el('div', 'filters');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '종류로 거르기');
    for (const [k, label, c] of FILTERS) {
      if (k !== 'all' && !counts[k]) continue;
      const b = button('chip', null, () => {
        ui.filter = k;
        focusAfter = 'filter-' + k;
        render();
      }, { id: 'filter-' + k });
      if (c) {
        b.style.setProperty('--c', c);
        b.append(el('span', 'dot'));
      }
      b.append(document.createTextNode(label + ' '), el('span', 'n', String(k === 'all' ? pending().length : counts[k])));
      b.setAttribute('aria-pressed', String(ui.filter === k));
      bar.append(b);
    }
    return bar;
  }

  function rowEl(r, tabbable) {
    const m = meta(r);
    const li = el('li', 'row');
    if (kindOf(r) === 'permission') li.classList.add('perm');
    if (fresh.has(r.id)) li.classList.add('is-new');
    li.id = 'row-' + r.id;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(ui.sel === r.id));
    li.tabIndex = tabbable ? 0 : -1;
    li.style.setProperty('--c', m.c);
    const k = el('span', 'k');
    k.title = m.label;
    k.append(ico(m.icon));
    const t = el('span', 't', titleOf(r));
    t.title = titleOf(r);
    let right;
    const tl = kindOf(r) === 'permission' ? timeLeft(r) : null;
    if (tl) {
      right = el('span', 'w left');
      right.title = `${tl.left}분 뒤 시간 초과(거부로 닫힘)`;
      const bar = el('span', 'mbar');
      const fill = el('span');
      fill.style.width = Math.round((tl.left / tl.total) * 100) + '%';
      bar.append(fill);
      right.append(bar, document.createTextNode(`${tl.left}분`));
    } else {
      const w = minutesSince(r.createdAt);
      right = el('span', 'w ' + ageCls(w), ago(w));
      if (w != null) right.title = `${fullTime(r.createdAt)}부터 ${ago(w)}째 기다림`;
    }
    const s = el('span', 's');
    if (!r.broken) s.append(avatar(r.session, { size: 'xs', ended: !!r.sessionEnded }));
    s.append(...chipsOf(r));
    const p = priority(r);
    const pri = el('span', 'pri');
    const pi = ico(PRI[p][1], 'pri-ic ' + p);
    pi.setAttribute('aria-hidden', 'true');
    pri.title = '우선순위 ' + PRI[p][0];
    pri.append(pi);
    li.append(k, t, right, s, pri);
    li.setAttribute('aria-label', `${m.label}, ${titleOf(r)}, ${r.broken ? '' : r.session + ', '}우선순위 ${PRI[p][0]}, ${tl ? tl.left + '분 남음' : ago(minutesSince(r.createdAt)) + ' 기다림'}`);
    li.addEventListener('click', () => select(r.id, { focus: wide() ? 'row' : 'detail' }));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(r.id, { focus: 'detail' });
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        step(e.key === 'ArrowDown' ? 1 : -1, 'row');
      }
    });
    return li;
  }

  function rows() {
    const list = visible();
    const wrap = el('div', 'scroll');
    wrap.dataset.scroll = 'list:' + ui.filter;
    const anchor = ui.sel && list.some((r) => r.id === ui.sel) ? ui.sel : list[0] && list[0].id;
    GROUPS.forEach(([label, cls], g) => {
      const items = list.filter((r) => KIND[kindOf(r)].g === g);
      if (!items.length) return;
      const h = el('h2', 'grp ' + cls);
      h.id = 'grp-' + g;
      if (g === 0) {
        const p = el('span', 'pulse');
        p.setAttribute('aria-hidden', 'true');
        h.append(p);
      }
      h.append(document.createTextNode(label + ' '), el('span', 'n', String(items.length)));
      const ul = el('ul', 'rows');
      ul.setAttribute('role', 'listbox');
      ul.setAttribute('aria-labelledby', h.id);
      items.forEach((r) => ul.append(rowEl(r, r.id === anchor)));
      wrap.append(h, ul);
    });
    return wrap;
  }

  function keyBar() {
    const bar = el('div', 'kbar' + (ui.keysFull ? ' is-full' : ''));
    bar.setAttribute('aria-label', '단축키');
    const item = (keys, label) => {
      const s = el('span');
      keys.forEach((k) => s.append(el('kbd', null, k)));
      s.append(document.createTextNode(' ' + label));
      return s;
    };
    bar.append(item(['j', 'k'], '이동'), item(['a'], '처리'), item(['x'], '거부'));
    if (ui.keysFull) bar.append(item(['Enter'], '열기'), item(['Esc'], '목록으로·취소'), item(['1', '–', '4'], '선택지'), item(['w'], '배경 펼치기'), item(['g', 'a'], '활동 탭'), item(['?'], '단축키 접기'));
    else bar.append(item(['?'], '전체'));
    return bar;
  }

  // 모두 처리했을 때도 카드가 있을 때와 같은 2단: 왼쪽 목록은 비워 두고 오른쪽 내용 칸에 체크·문구·활동 버튼만 둔다
  function emptyState() {
    const col = el('div', 'detail-col empty');
    const inner = el('div', 'empty-in');
    const sum = button('sum', '세션 활동 보기', () => vscode.postMessage({ type: 'openActivity' }), { icon: 'i-activity', id: 'empty-activity' });
    sum.append(ico('i-arrow', 'i-s'));
    inner.append(ico('i-done-art', 'empty-art'), el('h2', null, '모두 처리했습니다'), sum);
    col.append(inner);
    return col;
  }

  /* ── 상세 ── */
  function draftOf(r) {
    if (!drafts.has(r.id)) {
      drafts.set(r.id, {
        answers: (r.questions || []).map(() => ({ selected: [], otherOn: false, other: '' })),
        note: '',
        reason: '',
        ticks: new Set(),
      });
    }
    return drafts.get(r.id);
  }

  function whyBlock(r) {
    const text = r.why || r.background;
    if (!text) return null;
    const d = el('details', 'why');
    d.id = 'why-' + r.id;
    const s = el('summary');
    s.append(el('b', null, '배경'), el('span', 'pv', text.split('\n')[0]), ico('i-down', 'i-s'));
    d.append(s, rich('p', null, text));
    return d;
  }

  function codeBlock(label, text) {
    const blk = el('div', 'blk');
    blk.append(el('div', 'blk-h', label));
    const code = el('div', 'code');
    const pre = el('pre', null, text);
    const copy = button('icon-btn', null, () => copyText(text), { icon: 'i-copy', title: '복사' });
    copy.setAttribute('aria-label', label + ' 복사');
    code.append(pre, copy);
    blk.append(code);
    return blk;
  }

  function copyText(text) {
    const done = () => announce('복사했습니다');
    const fail = () => announce('복사하지 못했습니다. 글자를 직접 선택해 복사해 주세요');
    try {
      navigator.clipboard.writeText(text).then(done, fail);
    } catch {
      fail();
    }
  }

  // git 카드의 단계 사슬: 요청 → 검증 → 승인(지금) → 실행
  function gitChain(r) {
    const steps = [
      ['요청', 'i-wrench', 'done'],
      ['검증', r.verification ? 'i-check' : 'i-warn', r.verification ? 'done' : 'todo'],
      ['승인', 'i-hand', 'now'],
      [meta(r).label, GIT_ICON[r.kind] || 'i-commit', 'todo'],
    ];
    const chain = el('div', 'chain');
    chain.setAttribute('role', 'list');
    chain.setAttribute('aria-label', '진행 단계: ' + steps.map(([w, , s]) => `${w}(${s === 'done' ? '완료' : s === 'now' ? '지금' : '남음'})`).join(', '));
    steps.forEach(([who, icon, st], i) => {
      if (i) {
        const prev = steps[i - 1][2];
        chain.append(el('span', 'lk' + (prev === 'done' && st !== 'todo' ? ' done' : '')));
      }
      const sn = el('div', 'sn ' + st);
      sn.setAttribute('role', 'listitem');
      sn.style.setProperty('--c', st === 'now' ? 'var(--k-choice)' : st === 'done' ? 'var(--ok)' : 'var(--dim)');
      const ic = el('span', 'ic');
      ic.append(ico(icon, 'i-s'));
      sn.append(ic, el('span', 'who', who));
      chain.append(sn);
    });
    return chain;
  }

  function permissionBody(r, body) {
    const tl = timeLeft(r);
    if (tl) {
      const t = el('div', 'timer');
      t.setAttribute('role', 'timer');
      t.setAttribute('aria-label', `시간 초과까지 ${tl.left}분`);
      const h = el('div', 'timer-h');
      h.append(ico('i-clock', 'i-s'), el('b', null, `${tl.left}분 남음`), el('span', null, '지나면 거부로 닫히고 세션이 다음 행동을 합니다'));
      const bar = el('div', 'timer-bar');
      const fill = el('span');
      fill.style.width = Math.round((tl.left / tl.total) * 100) + '%';
      bar.append(fill);
      t.append(h, bar);
      body.append(t);
    }
    const why = whyBlock(r);
    if (why) body.append(why);
    if (r.command) body.append(codeBlock(r.tool ? `허용을 기다리는 명령 (${r.tool})` : '허용을 기다리는 명령', r.command));
  }

  function choiceBody(r, body) {
    const d = draftOf(r);
    const bad = invalid.get(r.id) || new Set();
    const why = whyBlock(r);
    if (why) body.append(why);
    r.questions.forEach((q, qi) => {
      const a = d.answers[qi];
      const base = `q-${r.id}-${qi}`;
      const fs = el('fieldset', 'q' + (bad.has(qi) ? ' is-invalid' : ''));
      fs.id = base;
      const lg = el('legend', 'q-h');
      lg.append(el('b', null, q.question), chip('', q.multiSelect ? '복수 선택' : '단일 선택'));
      if (q.header) lg.append(chip('', q.header));
      fs.append(lg);
      if (bad.has(qi)) {
        const msg = el('p', 'err-line');
        msg.id = base + '-err';
        msg.append(ico('i-x', 'i-s'), el('span', null, '이 질문에 답해 주세요.'));
        fs.append(msg);
        fs.setAttribute('aria-describedby', msg.id);
      }
      const opts = el('div', 'opts');
      const type = q.multiSelect ? 'checkbox' : 'radio';
      const clear = () => invalid.get(r.id) && invalid.get(r.id).delete(qi);
      q.options.forEach((o, oi) => {
        const on = a.selected.includes(o.label);
        const row = el('label', 'opt' + (on ? ' is-on' : ''));
        const input = el('input', 'sr-only');
        input.type = type;
        input.name = base;
        input.id = `${base}-o${oi}`;
        input.checked = on;
        input.addEventListener('change', () => {
          if (q.multiSelect) a.selected = input.checked ? [...a.selected, o.label] : a.selected.filter((s) => s !== o.label);
          else {
            a.selected = [o.label];
            a.otherOn = false;
          }
          clear();
          syncChoice(r);
        });
        const num = el('span', 'num');
        if (q.multiSelect && on) num.append(ico('i-check', 'i-s'));
        else num.textContent = String(oi + 1);
        num.setAttribute('aria-hidden', 'true');
        row.append(input, num, el('span', 'lb', o.label));
        if (o.recommended) {
          const rec = el('span', 'rec');
          rec.append(ico('i-check', 'i-s'), document.createTextNode('추천'));
          row.append(rec);
        } else row.append(el('span'));
        const cost = o.cost || o.description;
        if (cost) row.append(el('span', 'cost', cost));
        opts.append(row);
      });
      if (q.allowOther) {
        const row = el('label', 'opt' + (a.otherOn ? ' is-on' : ''));
        const input = el('input', 'sr-only');
        input.type = type;
        input.name = base;
        input.id = `${base}-oth`;
        input.checked = a.otherOn;
        const text = el('input', 'other-input');
        text.type = 'text';
        text.id = `${base}-other`;
        text.value = a.other;
        text.placeholder = '직접 입력';
        text.setAttribute('aria-label', `${q.header || q.question} — 기타 답 직접 입력`);
        input.addEventListener('change', () => {
          a.otherOn = input.checked;
          if (!q.multiSelect && input.checked) a.selected = [];
          clear();
          syncChoice(r);
          if (input.checked) text.focus({ preventScroll: true });
        });
        text.addEventListener('input', () => {
          a.other = text.value;
          if (text.value && !a.otherOn) {
            a.otherOn = true;
            input.checked = true;
            row.classList.add('is-on');
            if (!q.multiSelect) {
              a.selected = [];
              opts.querySelectorAll('.opt').forEach((o) => o !== row && o.classList.remove('is-on'));
            }
          }
          clear();
        });
        text.addEventListener('click', (e) => e.preventDefault());
        const num = el('span', 'num', String(q.options.length + 1));
        num.setAttribute('aria-hidden', 'true');
        row.append(input, num, el('span', 'lb', '기타'), el('span'), text);
        opts.append(row);
      }
      fs.append(opts);
      body.append(fs);
    });
  }

  // 결정 카드의 선택 상태만 화면에 맞춘다. 상세를 다시 그리면 스크롤이 맨 위로 가므로 선택에는 render()를 쓰지 않는다
  function syncChoice(r) {
    const d = draftOf(r);
    const bad = invalid.get(r.id);
    r.questions.forEach((q, qi) => {
      const base = `q-${r.id}-${qi}`;
      const a = d.answers[qi];
      q.options.forEach((o, oi) => {
        const input = $(`${base}-o${oi}`);
        if (!input) return;
        const on = a.selected.includes(o.label);
        input.checked = on;
        const row = input.closest('.opt');
        row.classList.toggle('is-on', on);
        const num = row.querySelector('.num');
        if (q.multiSelect && on) num.replaceChildren(ico('i-check', 'i-s'));
        else num.textContent = String(oi + 1);
      });
      const other = $(`${base}-oth`);
      if (other) {
        other.checked = a.otherOn;
        other.closest('.opt').classList.toggle('is-on', a.otherOn);
      }
      const set = $(base);
      if (set && !(bad && bad.has(qi))) {
        set.classList.remove('is-invalid');
        set.removeAttribute('aria-describedby');
        const msg = $(base + '-err');
        if (msg) msg.remove();
      }
    });
    if (bad && !bad.size) {
      invalid.delete(r.id);
      if (errors.has(r.id)) {
        errors.delete(r.id);
        const line = document.querySelector('.act .err-line');
        if (line) line.remove();
      }
    }
    const then = $('then-' + r.id);
    if (then) then.textContent = thenTextOf(r);
  }

  // 누르면 일어나는 일: 결정 카드는 고른 선택지의 onClick이 있으면 그것(B2-2), 없으면 카드의 onClick
  function thenTextOf(r) {
    const k = kindOf(r);
    const d = draftOf(r);
    const picked = k === 'choice' ? r.questions.flatMap((q, i) => q.options.filter((o) => o.onClick && d.answers[i].selected.includes(o.label))) : [];
    const expired = k === 'permission' && timeLeft(r) && timeLeft(r).left === 0;
    if (expired) return '시간이 지나 거부로 닫혔습니다. 세션은 거부 사유를 받고 다음 행동을 합니다.';
    return picked.length ? picked.map((o) => o.onClick).join(' / ') : r.onClick || THEN[k] || '';
  }

  function gitBody(r, body) {
    const chainBlk = el('div', 'blk');
    chainBlk.append(gitChain(r));
    body.append(chainBlk);
    const blk = el('div', 'blk');
    const chips = el('div', 'chips');
    if (r.branch) chips.append(chip('mono', r.branch, 'i-branch'));
    const list = r.files && r.files.length ? r.files : null;
    const commits = r.commits && r.commits.length ? r.commits : null;
    const toggle = (label, icon) => {
      const b = button('chip-btn', label, () => {
        ui.files = !ui.files;
        focusAfter = b.id;
        render();
      }, { icon, id: 'files-' + r.id });
      b.append(ico('i-down', 'i-s'));
      b.setAttribute('aria-expanded', String(ui.files));
      b.setAttribute('aria-controls', 'files-list-' + r.id);
      return b;
    };
    if (list) chips.append(toggle(`파일 ${r.fileCount != null ? r.fileCount : list.length}`, 'i-file'));
    else if (r.fileCount != null) chips.append(chip('', `파일 ${r.fileCount}`, 'i-file'));
    if (commits && !list) chips.append(toggle(`커밋 ${commits.length}`, 'i-commit'));
    else if (commits) chips.append(chip('', `커밋 ${commits.length}`, 'i-commit'));
    chips.append(r.verification ? chip('ok', '검증', 'i-check') : chip('warn', '검증 결과 없음', 'i-warn'));
    blk.append(chips);
    if (ui.files && (list || commits)) {
      const ul = el('ul', 'files');
      ul.id = 'files-list-' + r.id;
      if (commits) commits.forEach((c) => {
        const li = el('li');
        li.append(el('code', null, (c.hash || '').slice(0, 7)), document.createTextNode(c.subject));
        ul.append(li);
      });
      if (list) list.forEach((f) => ul.append(el('li', null, f)));
      blk.append(ul);
    }
    if (r.verification) blk.append(el('p', 'detail-text', '검증: ' + r.verification));
    body.append(blk);
    const why = whyBlock(r);
    if (why) body.append(why);
    if (r.command) body.append(codeBlock('실행할 명령 그대로', r.command));
  }

  function todoBody(r, body) {
    const d = draftOf(r);
    if (r.steps && r.steps.length) {
      const blk = el('div', 'blk');
      const h = el('div', 'blk-h', '단계 ');
      const bar = el('span', 'mbar');
      bar.style.setProperty('--c', 'var(--ok)');
      const fill = el('span');
      fill.style.width = Math.round((d.ticks.size / r.steps.length) * 100) + '%';
      bar.append(fill);
      h.append(bar, document.createTextNode(`${d.ticks.size}/${r.steps.length}`));
      const ol = el('ol', 'todo-steps');
      r.steps.forEach((s, i) => {
        const li = el('li');
        li.id = `tick-${r.id}-${i}`;
        li.setAttribute('role', 'checkbox');
        li.setAttribute('aria-checked', String(d.ticks.has(i)));
        li.tabIndex = 0;
        const tick = el('span', 'tick');
        tick.append(ico('i-check', 'i-s'));
        li.append(tick, rich('span', 'tx', s));
        const toggle = () => {
          if (d.ticks.has(i)) d.ticks.delete(i);
          else d.ticks.add(i);
          focusAfter = li.id;
          render();
        };
        li.addEventListener('click', toggle);
        li.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            toggle();
          }
        });
        ol.append(li);
      });
      blk.append(h, ol);
      body.append(blk);
    }
    // 어느 창에 붙여 넣을지 헷갈리지 않게 셸을 제목에 쓴다(Bash 명령을 PowerShell에 붙여 넣다 실패한 일이 계기).
    // VS Code 기본 터미널은 PowerShell이라, 바꾼 형태가 있으면 그것을 먼저 보인다
    if (r.commandPowerShell) body.append(codeBlock('PowerShell에 붙여 넣을 형태 — VS Code PowerShell 터미널용', r.commandPowerShell));
    if (r.command) {
      const label = r.shell === 'bash' ? 'Bash 명령 — Git Bash 창용(PowerShell에서는 실패)'
        : r.shell === 'powershell' ? 'PowerShell 명령 — VS Code PowerShell 터미널용(Git Bash에서는 실패)'
          : '직접 실행할 명령';
      body.append(codeBlock(label, r.command));
    }
    if (r.check) {
      const blk = el('div', 'blk');
      blk.append(el('div', 'blk-h', '확인 방법'), rich('p', 'note-text', r.check));
      body.append(blk);
    }
    const why = whyBlock(r);
    if (why) body.append(why);
  }

  // 주 행동(a 키와 같은 일)
  function primary(r) {
    const k = kindOf(r);
    const tl = k === 'permission' ? timeLeft(r) : null;
    if (tl && tl.left === 0) return; // 기한이 지난 권한은 허용할 수 없다(훅이 이미 거부로 닫음)
    if (k === 'permission' || k === 'git') return send(r, { type: 'decide', decision: 'approved' });
    if (k === 'todo') return send(r, { type: 'done', note: draftOf(r).note.trim() });
    if (k === 'choice') return sendAnswers(r);
  }

  function sendAnswers(r) {
    const d = draftOf(r);
    const missing = new Set(r.questions.map((q, i) => i).filter((i) => {
      const a = d.answers[i];
      return !a.selected.length && !(a.otherOn && a.other.trim());
    }));
    if (missing.size) {
      invalid.set(r.id, missing);
      errors.set(r.id, `답하지 않은 질문이 ${missing.size}개 있습니다.`);
      focusAfter = `q-${r.id}-${[...missing][0]}-o0`;
      render();
      return;
    }
    invalid.delete(r.id);
    send(r, { type: 'answer', answers: d.answers.map((a) => ({ selected: a.selected, other: a.otherOn ? a.other.trim() : '' })), note: d.note.trim() });
  }

  function send(r, message) {
    if (busy.has(r.id)) return;
    busy.add(r.id);
    errors.delete(r.id);
    vscode.postMessage({ id: r.id, ...message });
    render();
  }

  function startReject(r) {
    const k = kindOf(r);
    if (k !== 'permission' && k !== 'git') return;
    ui.rejecting = r.id;
    ui.memo = null;
    focusAfter = 'reason-' + r.id;
    render();
  }

  function cancelPanel(r) {
    const was = ui.rejecting ? 'reject-' + r.id : 'memo-' + r.id;
    ui.rejecting = null;
    ui.memo = null;
    errors.delete(r.id);
    focusAfter = was;
    render();
  }

  function actionBar(r) {
    const k = kindOf(r);
    const d = draftOf(r);
    const waiting = busy.has(r.id);
    const err = () => {
      if (!errors.has(r.id)) return null;
      const p = el('p', 'err-line');
      p.setAttribute('role', 'alert');
      p.append(ico('i-x', 'i-s'), el('span', null, errors.get(r.id)));
      return p;
    };
    const textPanel = (cls, id, label, hint, value, onInput, buttons) => {
      const bar = el('div', 'act ' + cls);
      const lb = el('label', null, label + ' ');
      lb.htmlFor = id;
      lb.append(el('span', null, hint));
      const ta = el('textarea');
      ta.id = id;
      ta.rows = 2;
      ta.value = value;
      ta.addEventListener('input', () => {
        onInput(ta.value);
        ta.removeAttribute('aria-invalid');
      });
      if (errors.has(r.id) && cls === 'rej') ta.setAttribute('aria-invalid', 'true');
      const btns = el('span', 'btns');
      btns.append(...buttons);
      bar.append(lb, ta, btns);
      const e = err();
      if (e) bar.append(e);
      return bar;
    };

    if (ui.rejecting === r.id) {
      const cancel = button('btn secondary', '취소', () => cancelPanel(r), { kbd: 'Esc', id: 'cancel-' + r.id });
      const go = button('btn danger solid', '거부 전송', () => {
        if (!d.reason.trim()) {
          errors.set(r.id, '거부 사유를 적어 주세요. 요청한 세션이 이 사유를 보고 다음 행동을 정합니다.');
          focusAfter = 'reason-' + r.id;
          render();
          return;
        }
        send(r, { type: 'decide', decision: 'rejected', reason: d.reason.trim() });
      }, { icon: 'i-x', id: 'confirm-' + r.id });
      go.setAttribute('aria-disabled', String(waiting));
      return textPanel('rej', 'reason-' + r.id, '거부 사유', `— ${r.session}에 그대로 전달`, d.reason, (v) => (d.reason = v), [cancel, go]);
    }

    if (ui.memo === r.id) {
      const cancel = button('btn secondary', '닫기', () => cancelPanel(r), { kbd: 'Esc', id: 'memo-close-' + r.id });
      const go = button('btn primary', k === 'todo' ? '완료' : '응답 전송', () => primary(r), { icon: 'i-check', id: 'memo-send-' + r.id });
      go.setAttribute('aria-disabled', String(waiting));
      return textPanel('memo', 'note-' + r.id, '메모', '(선택) — 요청한 세션에 함께 전달', d.note, (v) => (d.note = v), [cancel, go]);
    }

    const bar = el('div', 'act');
    const then = el('span', 'then');
    const expired = k === 'permission' && timeLeft(r) && timeLeft(r).left === 0;
    const thenLine = el('span', null, thenTextOf(r));
    thenLine.id = 'then-' + r.id;
    then.append(ico('i-arrow', 'i-s'), thenLine);
    const btns = el('span', 'btns');
    if (k === 'permission' || k === 'git') {
      const rej = button('btn danger', '거부', () => startReject(r), { icon: 'i-x', kbd: 'x', id: 'reject-' + r.id });
      const ok = button('btn primary', k === 'permission' ? '이번 한 번 허용' : '승인', () => primary(r), { icon: 'i-check', kbd: 'a', id: 'approve-' + r.id });
      [rej, ok].forEach((b) => b.setAttribute('aria-disabled', String(waiting || !!expired)));
      btns.append(rej, ok);
    } else if (k === 'choice' || k === 'todo') {
      const memo = button('btn secondary', d.note ? '메모 수정' : '메모', () => {
        ui.memo = r.id;
        focusAfter = 'note-' + r.id;
        render();
      }, { id: 'memo-' + r.id });
      const ok = button('btn primary', k === 'todo' ? '완료' : '응답 전송', () => primary(r), { icon: 'i-check', kbd: 'a', id: 'approve-' + r.id });
      ok.setAttribute('aria-disabled', String(waiting));
      btns.append(memo, ok);
    } else {
      btns.append(button('btn secondary', '요청 폴더 열기', () => vscode.postMessage({ type: 'openFolder' }), { icon: 'i-folder', id: 'folder-' + r.id }));
    }
    bar.append(then, btns);
    const e = err();
    if (e) bar.append(e);
    return bar;
  }

  function detail(r) {
    const col = el('div', 'detail-col');
    if (!r) {
      col.append(el('div', 'detail-empty', '왼쪽에서 요청을 선택하세요'));
      return col;
    }
    const m = meta(r);
    const list = visible();
    const idx = list.findIndex((x) => x.id === r.id);
    const p = priority(r);

    const bar = el('div', 'dt-bar');
    const back = button('back narrow-only', '목록', () => {
      const id = ui.sel;
      ui.sel = null;
      ui.rejecting = null;
      ui.memo = null;
      focusAfter = 'row-' + id;
      render();
    }, { icon: 'i-back', id: 'back' });
    const kc = el('span', 'kind-chip');
    kc.style.setProperty('--c', m.c);
    kc.append(ico(m.icon, 'i-s'), document.createTextNode(m.label));
    const pl = el('span', 'pri-lab');
    pl.append(ico(PRI[p][1], 'pri-ic ' + p), el('span', null, PRI[p][0]));
    const prev = button('icon-btn', null, () => step(-1, 'detail'), { icon: 'i-up', id: 'prev', title: '이전 (k)' });
    prev.setAttribute('aria-label', '이전 요청 (k)');
    const next = button('icon-btn', null, () => step(1, 'detail'), { icon: 'i-down', id: 'next', title: '다음 (j)' });
    next.setAttribute('aria-label', '다음 요청 (j)');
    bar.append(back, kc, pl, el('span', 'sp'), el('span', null, `${idx + 1}/${list.length}`), prev, next);

    const dt = el('div', 'dt');
    dt.dataset.scroll = 'dt:' + r.id;
    const body = el('div', 'dt-in');
    const h = el('h2', null, titleOf(r));
    h.id = 'dt-title';
    h.tabIndex = -1;
    body.append(h);

    if (r.broken) {
      body.append(el('p', 'broken-tx', `이 요청 파일은 형식이 맞지 않아 처리할 수 없습니다: ${r.broken}. 요청한 세션이 파일을 고치거나 지우면 이 카드가 사라집니다.`));
    } else {
      const who = el('div', 'who-row');
      const me = el('span', 'me');
      me.append(avatar(r.session, { ended: !!r.sessionEnded }), document.createTextNode(r.session));
      who.append(me);
      const tl = kindOf(r) === 'permission' ? timeLeft(r) : null;
      const w = minutesSince(r.createdAt);
      if (tl) who.append(chip('red', `${tl.left}분 남음`, 'i-clock'));
      else if (w != null) who.append(chip(w >= DAY ? 'red' : '', `${ago(w)}째`, 'i-clock'));
      if (r.sessionEnded) who.append(chip('red', '세션 종료됨 — 처리해도 받을 세션이 없습니다', 'i-warn'));
      if (r.relatedSessions && r.relatedSessions.length) {
        const rel = el('span', 'rel', '참조 ');
        const avs = el('span', 'avs');
        r.relatedSessions.forEach((n) => avs.append(avatar(n, { size: 'xs' })));
        rel.append(avs);
        rel.title = r.relatedSessions.join(', ');
        rel.setAttribute('aria-label', '참조: ' + r.relatedSessions.join(', '));
        who.append(rel);
      }
      // D-89: 권한·할 일 카드는 attach 버튼 대신 세션 현황 링크만
      if (r.sessionId) {
        who.append(button('link', '세션 현황에서 보기', () => vscode.postMessage({ type: 'reveal', sessionId: r.sessionId }), { id: 'reveal-' + r.id }));
      }
      body.append(who);
      if (r.what && r.what !== titleOf(r)) body.append(rich('p', 'what', r.what));
      // 카드 단위 대가(B2-2, 선택). 결정 카드의 대가는 선택지마다 보인다
      if (r.cost) {
        const c = el('p', 'cost-line');
        c.append(el('b', null, '트레이드오프 '), document.createTextNode(r.cost));
        body.append(c);
      }
      const k = kindOf(r);
      if (k === 'permission') permissionBody(r, body);
      else if (k === 'choice') choiceBody(r, body);
      else if (k === 'git') gitBody(r, body);
      else if (k === 'todo') todoBody(r, body);
      if (r.detail) body.append(rich('p', 'detail-text', r.detail));
    }
    dt.append(body);
    col.append(bar, dt, actionBar(r));
    return col;
  }

  /* ── 처리됨 ── */
  const DECISION = {
    approved: ['i-check', '승인', 'var(--ok)'],
    answered: ['i-check', '응답함', 'var(--k-choice)'],
    done: ['i-check', '완료', 'var(--k-todo)'],
    rejected: ['i-x', '거부', 'var(--err)'],
    expired: ['i-clock', '시간 초과', 'var(--warn)'],
  };
  function hist() {
    const wrap = el('div', 'scroll');
    wrap.dataset.scroll = 'hist';
    const recent = state.recent || [];
    if (!recent.length) {
      wrap.append(el('p', 'hist-empty', '아직 처리한 요청이 없습니다.'));
      return wrap;
    }
    const ul = el('ul', 'hist');
    for (const d of recent) {
      const [icon, word, c] = DECISION[d.decision] || ['i-check', d.decision || '처리', 'var(--dim)'];
      const req = d.request;
      const li = el('li');
      li.style.setProperty('--c', c);
      const k = el('span', 'k');
      k.append(ico(icon));
      const what = (req && titleOf(req)) || d.command || d.id;
      const kindLabel = req ? meta(req).label : kinds[d.kind] || d.kind || '';
      const tt = el('span', 'tt', `${d.session ? d.session + ' · ' : ''}${what}`);
      const at = el('span', 'r', ago(minutesSince(d.decidedAt)) + ' 전');
      at.title = fullTime(d.decidedAt);
      let how = `${kindLabel} · ${word}`;
      if (d.reason) how += ` — “${d.reason}”`;
      if (d.decision === 'answered') {
        const parts = (d.answers || []).map((a) => [...(a.selected || []), ...(a.other ? ['기타: ' + a.other] : [])].join(', '));
        if (parts.length) how += ' — ' + parts.join(' / ');
      }
      if (d.note) how += ` · 메모: ${d.note}`;
      li.append(k, tt, at, el('span', 'how', how));
      ul.append(li);
    }
    wrap.append(ul);
    return wrap;
  }

  /* ── 그리기 ── */
  function select(id, { focus } = {}) {
    if (ui.sel !== id) {
      ui.rejecting = null;
      ui.memo = null;
      ui.files = false;
    }
    ui.sel = id;
    fresh.delete(id);
    focusAfter = focus === 'detail' ? 'dt-title' : focus === 'row' ? 'row-' + id : focusAfter;
    render();
  }

  function step(d, focus) {
    const list = visible();
    if (!list.length) return;
    const i = list.findIndex((r) => r.id === ui.sel);
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))];
    select(next.id, { focus: focus || (document.activeElement && document.activeElement.closest('.detail-col') ? 'detail' : 'row') });
  }

  function render() {
    if (!state) return;
    const list = visible();
    if (ui.sel && !pending().some((r) => r.id === ui.sel)) ui.sel = null;
    if (!ui.sel && ui.view === 'inbox' && list.length && wide()) ui.sel = list[0].id;
    if (ui.filter !== 'all' && !list.length) ui.filter = 'all';

    // 다시 그려도 포커스와 입력 위치를 잃지 않게 id로 되살린다
    const focused = document.activeElement;
    const keep = focusAfter || (focused && focused !== document.body && focused.id) || null;
    const textual = focused && (focused.tagName === 'TEXTAREA' || (focused.tagName === 'INPUT' && focused.type === 'text'));
    const range = !focusAfter && textual ? [focused.selectionStart, focused.selectionEnd] : null;
    const whyOpen = new Set([...document.querySelectorAll('details.why[open]')].map((d) => d.id));
    // 확장의 상태 메시지·30초 갱신으로 다시 그려도 읽던 자리에 머물게 한다(같은 카드·같은 거르기일 때만)
    const scrolls = new Map([...document.querySelectorAll('[data-scroll]')].map((e) => [e.dataset.scroll, e.scrollTop]));
    const explicit = !!focusAfter; // 일부러 옮긴 포커스(답 안 한 질문 등)만 화면에 보이게 스크롤한다
    focusAfter = null;

    const parts = [head()];
    const al = alerts();
    if (al) parts.push(al);
    const view = el('div', 'body');
    view.id = 'view';
    view.setAttribute('role', 'tabpanel');
    view.setAttribute('aria-labelledby', 'tab-' + ui.view);
    if (ui.view === 'hist') {
      view.append(hist());
    } else if (!pending().length) {
      view.append(el('div', 'list-col'), emptyState());
    } else {
      const lc = el('div', 'list-col');
      const f = filters();
      if (f) lc.append(f);
      lc.append(rows(), keyBar());
      view.append(lc, detail(pending().find((r) => r.id === ui.sel)));
    }
    parts.push(view);
    app.classList.toggle('has-sel', ui.view === 'inbox' && !!ui.sel);
    app.classList.toggle('all-done', ui.view === 'inbox' && !pending().length);
    app.replaceChildren(...parts);
    whyOpen.forEach((id) => {
      const d = $(id);
      if (d) d.open = true;
    });
    document.querySelectorAll('[data-scroll]').forEach((e) => {
      if (scrolls.has(e.dataset.scroll)) e.scrollTop = scrolls.get(e.dataset.scroll);
    });

    const target = keep && $(keep);
    if (target) {
      target.focus({ preventScroll: true });
      if (range && target.setSelectionRange) target.setSelectionRange(range[0], range[1]);
      if (explicit || target.classList.contains('row')) target.scrollIntoView({ block: 'nearest' });
    } else if (keep && focused && focused !== document.body) {
      // 처리한 카드가 사라지면 다음 카드로 포커스를 옮긴다
      const next = ui.sel ? $(wide() ? 'row-' + ui.sel : 'dt-title') : $('tab-' + ui.view);
      if (next) next.focus();
    }
  }

  /* ── 단축키(목업: j/k 이동, Enter 열기, Esc 목록·취소, a 처리, x 거부, 1–4 선택지, w 왜, g a 활동, ? 전체) ── */
  let gPressed = 0;
  document.addEventListener('keydown', (e) => {
    if (!state || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing = t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && t.type === 'text'));
    const r = ui.view === 'inbox' ? pending().find((x) => x.id === ui.sel) : null;
    if (e.key === 'Escape') {
      if (r && (ui.rejecting === r.id || ui.memo === r.id)) {
        e.preventDefault();
        cancelPanel(r);
      } else if (r && !wide()) {
        e.preventDefault();
        ui.sel = null;
        focusAfter = 'row-' + r.id;
        render();
      }
      return;
    }
    if (typing) return;
    const key = e.key;
    if (key === 'g') {
      gPressed = Date.now();
      return;
    }
    if (key === 'a' && Date.now() - gPressed < 1000) {
      gPressed = 0;
      e.preventDefault();
      vscode.postMessage({ type: 'openActivity' });
      return;
    }
    if (key === '?') {
      ui.keysFull = !ui.keysFull;
      render();
      return;
    }
    if (ui.view !== 'inbox') return;
    if (key === 'j' || key === 'k') {
      e.preventDefault();
      step(key === 'j' ? 1 : -1);
      return;
    }
    if (!r || r.broken) return;
    if (key === 'a') {
      e.preventDefault();
      if (ui.rejecting !== r.id) primary(r);
    } else if (key === 'x') {
      e.preventDefault();
      startReject(r);
    } else if (key === 'w') {
      const d = $('why-' + r.id);
      if (d) {
        d.open = !d.open;
        d.querySelector('summary').focus();
      }
    } else if (/^[1-9]$/.test(key) && kindOf(r) === 'choice') {
      // 포커스가 있는 질문, 없으면 아직 답하지 않은 첫 질문
      const inQ = t && t.closest && t.closest('fieldset.q');
      const d = draftOf(r);
      const qi = inQ ? Number(inQ.id.split('-').pop()) : Math.max(0, d.answers.findIndex((a) => !a.selected.length && !a.otherOn));
      const input = $(`q-${r.id}-${qi}-o${Number(key) - 1}`);
      if (input) {
        e.preventDefault();
        input.click();
      }
    }
  });

  /* ── 확장과 주고받기 ── */
  window.addEventListener('message', ({ data: msg }) => {
    if (msg.type === 'state') {
      const json = JSON.stringify(msg.state);
      if (json === lastJson) return;
      lastJson = json;
      const prev = known;
      const prevSel = ui.sel;
      const prevIndex = visible().findIndex((r) => r.id === prevSel);
      state = msg.state;
      kinds = state.kinds || {};
      routineKinds = state.routineKinds || [];
      rolePrefix = state.rolePrefix || '';
      const ids = new Set(state.pending.map((r) => r.id));
      const added = prev ? state.pending.filter((r) => !prev.has(r.id)) : [];
      added.forEach((r) => fresh.add(r.id));
      const decided = [...busy].filter((id) => !ids.has(id)).map((id) => (state.recent || []).find((d) => d.id === id)).filter(Boolean);
      const word = (d) => ({ approved: '승인했습니다', rejected: '거부했습니다', answered: '답을 보냈습니다', done: '완료를 알렸습니다' }[d.decision] || '처리했습니다');
      const left = state.pending.length ? `. 남은 요청 ${state.pending.length}건` : '. 남은 요청이 없습니다';
      if (decided.length) announce(decided.map(word).join(', ') + left);
      else if (added.length) announce(`새 요청 ${added.length}건: ${added.map(titleOf).join(', ')}`);
      // 처리한 카드가 사라지면 같은 자리의 다음 카드를 고른다
      if (prevSel && !ids.has(prevSel)) {
        const list = visible();
        ui.sel = list.length && prevIndex >= 0 ? list[Math.min(prevIndex, list.length - 1)].id : null;
        ui.rejecting = null;
        ui.memo = null;
        if (busy.has(prevSel)) focusAfter = ui.sel ? (wide() ? 'row-' + ui.sel : 'dt-title') : 'tab-inbox';
      }
      for (const s of [busy, fresh]) for (const id of [...s]) if (!ids.has(id)) s.delete(id);
      for (const m of [drafts, invalid, errors]) for (const id of [...m.keys()]) if (!ids.has(id)) m.delete(id);
      known = ids;
      if (pendingSelect && ids.has(pendingSelect)) {
        const id = pendingSelect;
        pendingSelect = null;
        ui.view = 'inbox';
        ui.filter = 'all';
        select(id, { focus: 'detail' });
        return;
      }
      render();
    } else if (msg.type === 'select') {
      if (!state || !state.pending.some((r) => r.id === msg.id)) {
        pendingSelect = msg.id; // 아직 상태가 없거나 그 카드가 오기 전이면 기다린다
        return;
      }
      ui.view = 'inbox';
      ui.filter = 'all';
      select(msg.id, { focus: 'detail' });
    } else if (msg.type === 'error') {
      if (msg.id) {
        busy.delete(msg.id);
        errors.set(msg.id, msg.message);
      } else {
        announce('오류: ' + msg.message);
      }
      render();
    }
  });

  // 대기 시간·남은 시간을 갱신한다. 입력 중에는 건드리지 않는다
  setInterval(() => {
    const f = document.activeElement;
    if (!(f && (f.tagName === 'TEXTAREA' || f.tagName === 'INPUT'))) render();
  }, 30000);
  // 폭이 바뀌어 2단 ↔ 1단이 되면 고른 카드 처리를 다시 정한다
  if (typeof ResizeObserver === 'function') {
    let wasWide = null;
    new ResizeObserver(() => {
      const w = wide();
      if (w !== wasWide) {
        wasWide = w;
        render();
      }
    }).observe(app);
  }

  vscode.postMessage({ type: 'ready' });
})();
