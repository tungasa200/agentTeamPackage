// 이 PC의 wy-ops 프로젝트 목록(D-39). 등록부 파일 없이 그때그때 찾는다. 읽기만 한다
//   list(home)              ~/.claude.json projects 가운데 .claude/wy-ops.json이 있는 폴더(.claude/worktrees 아래는 뺌)
//                           → [{ dir, project, rolePrefix, pmRole, namespace }]
//   mainRoot(dir)           worktree 안이면 본 저장소 경로(.claude/worktrees 앞부분), 아니면 그대로
//   others(dir, home)       list에서 dir(본 저장소 기준) 프로젝트를 뺀 것
//   prefixClash(a, b)       두 접두사가 같거나 한쪽이 다른 쪽의 앞부분(대소문자 무시)
//   conflicts(self, list)   self({ rolePrefix, pmRole, namespace })와 겹치는 프로젝트 → [{ dir, project, why: 'prefix'|'namespace', value }]
//   freePrefix(name, list)  겹치지 않는 접두사: 앞 2자 → 앞 3자 → 앞 2자 + 숫자(MY- → MYA- → MY2- …)
const fs = require('fs');
const path = require('path');
const { loadOpsConfig } = require('../vscode/opsConfig');

const norm = (p) => path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const WT = /[\\/]\.claude[\\/]worktrees([\\/]|$)/i;

function mainRoot(dir) {
  const m = WT.exec(String(dir));
  return m ? String(dir).slice(0, m.index) : dir;
}

function list(home) {
  let keys = [];
  try {
    const cj = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8').replace(/^﻿/, ''));
    keys = Object.keys((cj && cj.projects) || {});
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const k of keys) {
    const key = norm(k);
    if (WT.test(k) || seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(path.join(k, '.claude', 'wy-ops.json'))) continue;
    const ops = loadOpsConfig(k);
    if (!ops || norm(ops.root) !== key) continue;
    out.push({ dir: path.resolve(k), project: ops.project || null, rolePrefix: ops.rolePrefix || null, pmRole: ops.pmRole || null, namespace: (ops.approvals && ops.approvals.namespace) || null });
  }
  return out;
}

const others = (dir, home) => list(home).filter((p) => norm(p.dir) !== norm(mainRoot(dir)));

const prefixOf = (p) => p.rolePrefix || p.pmRole || '';
function prefixClash(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
}

function conflicts(self, projects) {
  const out = [];
  for (const p of projects) {
    if (prefixClash(prefixOf(self), prefixOf(p))) out.push({ dir: p.dir, project: p.project, why: 'prefix', value: prefixOf(p) });
    if (self.namespace && p.namespace && self.namespace.toLowerCase() === p.namespace.toLowerCase()) out.push({ dir: p.dir, project: p.project, why: 'namespace', value: p.namespace });
  }
  return out;
}

function freePrefix(name, projects) {
  const s = String(name || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'WY';
  const two = s.slice(0, 2);
  const cands = [two, ...(s.length > 2 ? [s.slice(0, 3)] : []), ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${two}${n}`)].map((c) => `${c}-`);
  const taken = projects.map(prefixOf);
  return cands.find((c) => !taken.some((t) => prefixClash(c, t))) || cands[0]; // 모두 겹치면 첫 후보(부르는 쪽이 겹침을 다시 본다)
}

module.exports = { list, mainRoot, others, prefixClash, conflicts, freePrefix };
