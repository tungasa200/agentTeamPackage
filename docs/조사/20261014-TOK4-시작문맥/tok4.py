# TOK-4: 세션 첫 호출 전 첨부를 종류·출처별로 나눠 글자 수를 센다(토큰 아님).
# 사용: python -I -X utf8 tok4.py <out.json> <transcript.jsonl>...
import json, sys, os, collections, re
HOME = os.path.expanduser('~')
USER_SKILLS = set(os.listdir(os.path.join(HOME, '.claude', 'skills')))
def skill_src(name):
    if ':' in name: return 'plugin:' + name.split(':')[0]
    if name in USER_SKILLS: return 'user-global'
    if name in ('pm-ops', 'wy-resume-session', 'wy-save-session'): return 'project'
    return 'builtin'
def agent_src(name):
    if ':' in name: return 'plugin:' + name.split(':')[0]
    if name.startswith('OPS-') or name.startswith('WY-'): return 'project'
    return 'builtin'
out = {}
for p in sys.argv[2:]:
    sid = os.path.basename(p)[:8]
    r = dict(meta={}, attach=collections.Counter(), user_chars=0, skills=collections.Counter(), skill_n=collections.Counter(),
             skill_items=[], agents=collections.Counter(), agent_n=collections.Counter(), hooks=[], deferred=None, pending=None, instructions=[], usage=None)
    r['later'] = collections.Counter(); r['later_deferred'] = []; first = True
    for line in open(p, encoding='utf-8'):
        o = json.loads(line); t = o.get('type')
        if t == 'assistant' and first:
            u = o['message'].get('usage', {}); r['usage'] = {k: u.get(k) for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')}; first = False
        if not first:
            if t == 'attachment' and o['attachment']['type'] in ('mcp_instructions_delta', 'deferred_tools_delta') and r['later'][o['attachment']['type']] == 0:
                a = o['attachment']; r['later'][a['type']] += len(json.dumps(a, ensure_ascii=False))
                if a['type'] == 'deferred_tools_delta': r['later_deferred'] = a.get('addedNames')
            continue
        if t in ('agent-setting', 'permission-mode'): r['meta'][t] = o.get('agentSetting') or o.get('permissionMode')
        if t == 'user':
            r['user_chars'] += len(json.dumps(o['message'].get('content'), ensure_ascii=False))
        if t != 'attachment': continue
        a = o['attachment']; at = a['type']; n = len(json.dumps(a, ensure_ascii=False))
        r['attach'][at] += n
        if at == 'skill_listing':
            for item in re.split(r'\n(?=- )', a['content']):
                name = re.match(r'- ([^\s:]+(?::[^\s:]+)?)', item).group(1)
                src = skill_src(name); r['skills'][src] += len(item); r['skill_n'][src] += 1
                r['skill_items'].append((name, src, len(item)))
        elif at == 'agent_listing_delta':
            for ln in a.get('addedLines') or []:
                name = re.match(r'- ([^\s:]+(?::[^\s:]+)?)', ln).group(1)
                src = agent_src(name); r['agents'][src] += len(ln); r['agent_n'][src] += 1
        elif at in ('hook_success', 'hook_additional_context', 'async_hook_response'):
            r['hooks'].append(dict(type=at, name=a.get('hookName'), plugin=a.get('pluginId'), chars=n,
                                   cmd=(a.get('command') or '')[:160], head=str(a.get('content') or a.get('stdout') or a.get('response') or '')[:200]))
        elif at == 'deferred_tools_delta':
            r['deferred'] = a.get('addedNames'); r['pending'] = a.get('pendingMcpServers')
        elif at == 'instructions':
            r['instructions'] = [(f.get('path') or f.get('type'), len(f.get('content', ''))) for f in a['files']]
    out[sid] = r
json.dump(out, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
for sid, r in out.items():
    print('==', sid, r['meta'], r['usage'], 'user', r['user_chars'])
    print(' attach', dict(r['attach'].most_common()), 'total', sum(r['attach'].values()))
    print(' skills', dict(r['skills']), dict(r['skill_n']))
    print(' agents', dict(r['agents']), dict(r['agent_n']))
    for h in r['hooks']: print(' hook', h['type'], h['name'], h['plugin'], h['chars'], h['cmd'][:90], '|', h['head'][:120].replace('\n', ' '))
    print(' later', dict(r['later']), 'later deferred n', len(r['later_deferred']), sorted({x.split('__')[1] for x in r['later_deferred'] if x.startswith('mcp__')}))
    print(' pending', r['pending']); print(' instr', r['instructions'])
