// 함께 까는 도구(카드 1110): extras.json manifest를 읽어 계획·점검·설치한다. 명령 실행은 run(cmd, args) → { status, stdout, stderr }으로 주입받는다
//   load({ pkg? })                            → items (plugin 항목은 plugins.json에서 마켓플레이스를 채움)
//   plan({ ops, off?, items? })               → [{ id, label, kind, required, on, forcedBy? }]  required: requiredFor ∩ (ops.roles의 group + 'rotation')
//                                               off: 끌 id(기본 ops.extras.off). 필수는 끌 수 없고, 켜진 항목이 needs로 부르는 항목도 켠다
//   check({ run, home?, items?, plan? })      → [{ id, state: 'ok'|'missing'|'off', detail? }]  plan을 주면 꺼진 항목은 'off'(점검 안 함)
//   install(entries, { run, home?, items? })  → [{ id, state: 'ok'|'installed'|'failed'|'skipped', error? }]  entries: plan 결과나 id 목록.
//                                               이미 있으면 건너뛰고(ok), needs가 실패한 항목은 skipped. manifest 순서(의존 먼저)로 실행
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG = path.resolve(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function load({ pkg = PKG } = {}) {
  const items = readJson(path.join(pkg, 'extras.json')).items;
  const raw = readJson(path.join(pkg, 'plugins.json'));
  const plugins = new Map((Array.isArray(raw) ? raw : raw.plugins || []).map((p) => [p.id, p]));
  return items.map((it) => {
    if (it.kind !== 'plugin') return it;
    const p = plugins.get(it.plugin);
    if (!p) throw new Error(`extras.json ${it.id}: plugins.json에 ${it.plugin}이 없습니다`);
    const src = p.ref ? `${p.marketplace}#${p.ref}` : p.marketplace;
    return {
      ...it,
      source: p.marketplace,
      check: [{ plugin: it.plugin }],
      install: [['claude', 'plugin', 'marketplace', 'add', src], ['claude', 'plugin', 'install', it.plugin, '--scope', 'user']],
    };
  });
}

function plan({ ops = {}, off, items = load() } = {}) {
  const offList = off || (ops.extras && ops.extras.off) || [];
  const groups = new Set(['rotation', ...(ops.roles || []).map((r) => r.group).filter(Boolean)]);
  const byId = new Map(items.map((it) => [it.id, it]));
  const out = new Map(
    items.map((it) => {
      const required = (it.requiredFor || []).some((g) => groups.has(g));
      return [it.id, { id: it.id, label: it.label, kind: it.kind, required, on: required || (it.default !== false && !offList.includes(it.id)) }];
    }),
  );
  // 켜진 항목의 needs를 켠다(사슬이 있어 바뀌지 않을 때까지)
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of out.values()) {
      if (!e.on) continue;
      for (const n of byId.get(e.id).needs || []) {
        const dep = out.get(n);
        if (!dep) throw new Error(`extras.json ${e.id}: needs ${n}이 없습니다`);
        if (e.required && !dep.required) (dep.required = true), (changed = true);
        if (!dep.on) (dep.on = true), (changed = true);
        if (offList.includes(n)) {
          dep.forcedBy = dep.forcedBy || [];
          if (!dep.forcedBy.includes(e.id)) dep.forcedBy.push(e.id);
        }
      }
    }
  }
  return [...out.values()];
}

const expand = (s, home) => (typeof s === 'string' && s.startsWith('~/') ? path.join(home, s.slice(2)) : s);

function makeChecker({ run, home }) {
  let pluginList;
  let mcp;
  const plugins = () => {
    if (pluginList === undefined) {
      const r = run('claude', ['plugin', 'list', '--json']);
      try {
        pluginList = r.status === 0 ? JSON.parse(r.stdout) : null;
      } catch {
        pluginList = null;
      }
    }
    return pluginList;
  };
  const mcpServers = () => {
    if (mcp === undefined) {
      try {
        mcp = readJson(path.join(home, '.claude.json')).mcpServers || {};
      } catch {
        mcp = {};
      }
    }
    return mcp;
  };
  return (it) => {
    for (const c of it.check || []) {
      if (c.cmd) {
        const [cmd, ...args] = c.cmd.map((s) => expand(s, home));
        if (run(cmd, args).status !== 0) return { state: 'missing', detail: `${c.cmd.join(' ')} 실패` };
      } else if (c.path) {
        if (!fs.existsSync(expand(c.path, home))) return { state: 'missing', detail: `${c.path} 없음` };
      } else if (c.mcp) {
        if (!mcpServers()[c.mcp]) return { state: 'missing', detail: `MCP ${c.mcp} 등록 안 됨` };
      } else if (c.plugin) {
        const list = plugins();
        if (!Array.isArray(list)) return { state: 'missing', detail: 'claude plugin list --json을 읽지 못함' };
        const got = list.find((p) => p.id === c.plugin);
        if (!got) return { state: 'missing', detail: `${c.plugin} 없음` };
        if (got.enabled === false) return { state: 'missing', detail: `${c.plugin} 꺼져 있음` };
      }
    }
    return { state: 'ok' };
  };
}

function check({ run, home = os.homedir(), items = load(), plan: p = null } = {}) {
  const on = p ? new Map(p.map((e) => [e.id, e.on])) : null;
  const has = makeChecker({ run, home });
  return items.map((it) => (on && !on.get(it.id) ? { id: it.id, state: 'off' } : { id: it.id, ...has(it) }));
}

function install(entries, { run, home = os.homedir(), items = load() } = {}) {
  const want = new Set(entries.map((e) => (typeof e === 'string' ? e : e.on ? e.id : null)).filter(Boolean));
  const has = makeChecker({ run, home });
  const done = new Map();
  const out = [];
  for (const it of items.filter((x) => want.has(x.id))) {
    const bad = (it.needs || []).find((n) => want.has(n) && ['failed', 'skipped'].includes(done.get(n)));
    let r;
    if (has(it).state === 'ok') r = { id: it.id, state: 'ok' };
    else if (bad) r = { id: it.id, state: 'skipped', error: `${bad} 설치 실패로 건너뜀` };
    else {
      r = { id: it.id, state: 'installed' };
      for (const [i, step] of it.install.entries()) {
        const [cmd, ...args] = step.map((s) => expand(s, home));
        const res = run(cmd, args);
        // 마켓플레이스 add는 이미 있으면 실패해도 된다
        if (res.status !== 0 && !(it.kind === 'plugin' && i === 0)) {
          r = { id: it.id, state: 'failed', error: `${step.join(' ')}: ${String(res.stderr || res.stdout || '').trim().split('\n').pop()}` };
          break;
        }
      }
    }
    done.set(it.id, r.state);
    out.push(r);
  }
  return out;
}

module.exports = { load, plan, check, install };
