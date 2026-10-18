# TOK-4: 역할별 실제 사용 — Skill·Agent(subagent_type)·MCP 서버·도구 이름. erp·ops 트랜스크립트 전부(하위 에이전트 포함).
# 사용: python -I -X utf8 usage.py <out.json>
import json, sys, os, glob, collections
base = os.path.expanduser('~/.claude/projects')
def proj(d):
    d = d.lower()
    return 'erp' if 'erp-project' in d else 'ops' if 'agentteampackage' in d else None
U = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))
for p in glob.glob(base + '/*/**/*.jsonl', recursive=True):
    pj = proj(os.path.relpath(p, base).split(os.sep)[0])
    if not pj: continue
    sub = os.sep + 'subagents' + os.sep in p
    role = None; seen = set()
    for line in open(p, encoding='utf-8', errors='replace'):
        try: o = json.loads(line)
        except Exception: continue
        if o.get('type') == 'agent-setting': role = o.get('agentSetting')
        if o.get('type') != 'assistant': continue
        m = o.get('message') or {}
        key = (m.get('id'), o.get('requestId'))
        for b in m.get('content') or []:
            if not (isinstance(b, dict) and b.get('type') == 'tool_use'): continue
            if b.get('id') in seen: continue
            seen.add(b.get('id'))
            rk = f"{pj}:{role or '(이름없음)'}" + (':sub' if sub else '')
            n = b.get('name') or ''; i = b.get('input') or {}
            U[rk]['tool'][n] += 1
            if n == 'Skill': U[rk]['skill'][i.get('skill')] += 1
            if n in ('Agent', 'Task'): U[rk]['agent'][i.get('subagent_type') or '(general)'] += 1
            if n.startswith('mcp__'): U[rk]['mcp'][n.split('__')[1]] += 1
            if n == 'ToolSearch': U[rk]['toolsearch'][str(i.get('query'))[:60]] += 1
json.dump(U, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
tot = collections.defaultdict(collections.Counter)
for rk, d in sorted(U.items()):
    for k in ('skill', 'agent', 'mcp'): tot[k].update(d[k])
    print(rk, '| skill', dict(d['skill']), '| agent', dict(d['agent']), '| mcp', dict(d['mcp']))
print('\nTOTAL'); [print(k, dict(v.most_common())) for k, v in tot.items()]
alltool = collections.Counter()
for d in U.values(): alltool.update(d['tool'])
print('tools', dict(alltool.most_common()))
