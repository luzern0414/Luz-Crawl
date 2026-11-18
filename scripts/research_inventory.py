"""Merge observed candidates without promoting a search link to evidence."""
import importlib.util
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


def review_errors(record, inventory, review, *, payload=None):
    """Validate the handoff structure, not the truth or diligence of its judgments."""
    errors = []
    if not isinstance(review, dict):
        return ['尽责复盘必须是对象']
    for field in ('caller', 'stage', 'task_root', 'candidate_inventory_sha256'):
        if field not in review or review[field] != record.get(field):
            errors.append(f'尽责复盘绑定不匹配: {field}')
    required = {
        'questions': ('id', 'question', 'importance'),
        'query_groups': ('purpose', 'queries'),
        'candidate_reviews': ('url', 'category', 'status', 'priority', 'reason'),
        'rounds': ('logs', 'observation', 'next_action'),
        'experience_reuse': ('status', 'log', 'impact'),
        'experience_updates': ('key', 'category', 'outcome', 'evidence', 'recall_log'),
    }
    spec = importlib.util.spec_from_file_location('_inventory_evidence_policy', Path(__file__).with_name('evidence_policy.py'))
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    min_groups = policy.research_floor(record)['queries']
    for field, keys in required.items():
        rows = review.get(field)
        if field == 'query_groups' and min_groups == 0 and rows == []:
            continue
        if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) or any(not row.get(key) for key in keys) for row in rows):
            errors.append(f'尽责复盘 {field} 缺少实际记录或必填字段: {", ".join(keys)}')
    norm = lambda value: ' '.join(str(value).split()).casefold()
    executed = {norm(s['args'][2]) for s in record.get('steps', []) if policy.executed_search(s)}
    groups = review.get('query_groups', [])
    purposes, used = set(), set()
    if isinstance(groups, list):
        for group in groups:
            if not isinstance(group, dict):
                continue
            purpose = norm(group.get('purpose', ''))
            queries = group.get('queries')
            if not purpose or purpose in purposes or not isinstance(queries, list) or not queries or any(not isinstance(q, str) or not q.strip() for q in queries):
                errors.append('查询组须有不同的实际研究目的和非空查询数组')
                continue
            purposes.add(purpose)
            actual = {norm(q) for q in queries}
            if not actual <= executed:
                errors.append('查询组包含没有成功执行日志的查询')
            if used & actual:
                errors.append('同一查询不能重复充当不同查询方向')
            used.update(actual)
    if len(purposes) < min_groups:
        errors.append(f'尽责复盘至少需要 {min_groups} 组不同目的的查询；措辞差异仍须人工复核')
    question_rows = review.get('questions', [])
    questions = {}
    if isinstance(question_rows, list):
        for row in question_rows:
            if not isinstance(row, dict):
                continue
            key = row.get('id')
            if not isinstance(key, str) or not key.strip() or key in questions:
                errors.append('问题必须有唯一非空 id')
                continue
            questions[key] = row
            if row.get('importance') not in {'required', 'optional'}:
                errors.append('问题 importance 必须为 required 或 optional')
    captured = {candidate_url(s.get('url')) for s in record.get('sources', [])}
    captured.discard(None)
    rows = review.get('candidate_reviews')
    if isinstance(rows, list) and all(isinstance(row, dict) for row in rows):
        urls = [row.get('url') for row in rows]
        expected = {row['url'] for row in inventory['candidates']}
        if any(not isinstance(url, str) for url in urls) or len(urls) != len(expected) or set(urls) != expected:
            errors.append('尽责复盘必须逐项覆盖当前完整候选，不能漏项、重复或加入未发现网址')
        for row in rows:
            if row.get('category') not in {'official', 'project-product', 'research-data', 'professional', 'community', 'index', 'unknown'}:
                errors.append('候选 category 必须为规定来源类别；未知发布关系用 unknown 并说明')
            if row.get('status') not in {'unread', 'read-adopted', 'read-not-adopted', 'duplicate', 'irrelevant', 'restricted'} or row.get('priority') not in {'high', 'medium', 'low'}:
                errors.append('候选必须写有效阅读状态和优先级')
            ids = row.get('question_ids')
            if not isinstance(ids, list) or any(not isinstance(i, str) or i not in questions for i in ids) or (row.get('status') == 'read-adopted' and not ids):
                errors.append('候选 question_ids 必须关联复盘中的问题；已采用候选不能没有问题')
            if row.get('status') in {'read-adopted', 'read-not-adopted'} and candidate_url(row.get('url')) not in captured:
                errors.append('候选标为已读但没有本阶段可核验正文；链接不能冒充阅读证据')
    stop = review.get('stop')
    if not isinstance(stop, dict) or stop.get('reason') not in {'sufficient', 'saturated', 'budget-limited', 'access-limited'} or not isinstance(stop.get('basis'), str) or not stop['basis'].strip() or not isinstance(stop.get('remaining'), list):
        errors.append('尽责复盘 stop 必须填写停止类型、实际依据和 remaining 剩余范围')
    if isinstance(stop, dict) and stop.get('reason') in {'sufficient', 'saturated'} and isinstance(rows, list):
        if any(isinstance(row, dict) and row.get('priority') == 'high' and row.get('status') in {'unread', 'restricted'} for row in rows):
            errors.append('高优先级候选仍未读或受限，不能声明充分或饱和；须处理依据或如实记录受限')
    if isinstance(payload, dict):
        errors.extend(coverage_errors(record, review, questions, payload))
    return list(dict.fromkeys(errors))


def coverage_errors(record, review, questions, payload):
    """Cross-check declared questions, body-backed adoptions and conclusion IDs."""
    errors, covered = [], set()
    sources = {s['id']: candidate_url(s.get('url')) for s in record.get('sources', [])}
    decisions = {candidate_url(r.get('url')): r for r in review.get('candidate_reviews', []) if isinstance(r, dict)}
    findings = {f['id']: f for f in payload.get('findings', []) if isinstance(f, dict) and isinstance(f.get('id'), str)}
    adopted_urls = set()
    for finding in findings.values():
        if finding.get('adopted') is True:
            url = sources.get(finding.get('source_id'))
            adopted_urls.add(url)
            if decisions.get(url, {}).get('status') != 'read-adopted':
                errors.append('已采用结论与候选阅读/采用状态不一致')
    for url, decision in decisions.items():
        if decision.get('status') == 'read-adopted' and url not in adopted_urls:
            errors.append('已采用候选没有对应的已采用结论')
    for row in payload.get('coverage', []):
        if not isinstance(row, dict):
            continue
        qid = row.get('question_id')
        if not isinstance(qid, str) or qid not in questions:
            errors.append('coverage.question_id 必须引用本阶段声明的真实问题')
            continue
        ids = row.get('finding_ids')
        if not isinstance(ids, list) or not ids:
            continue
        valid = True
        for fid in ids:
            finding = findings.get(fid, {}) if isinstance(fid, str) else {}
            url = sources.get(finding.get('source_id'))
            if finding.get('adopted') is not True or qid not in decisions.get(url, {}).get('question_ids', []):
                errors.append(f'问题 {qid} 的覆盖须关联已读采用且对应本问题的来源结论')
                valid = False
        if valid:
            covered.add(qid)
    for qid, question in questions.items():
        if question.get('importance') == 'required' and qid not in covered:
            errors.append(f'必要问题 {qid} 未被结论覆盖')
    return errors


def candidate_url(value):
    try:
        parts = urlsplit(str(value or ''))
        if parts.scheme not in {'http', 'https'} or not parts.hostname or parts.username or parts.password:
            return None
        query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                 if not k.lower().startswith('utm_') and k.lower() not in {'fbclid', 'gclid'}]
        # Anchors identify a section; hash routes identify a different page.
        fragment = parts.fragment if parts.fragment.startswith(('/', '!')) else ''
        return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip('/'), urlencode(sorted(query)), fragment))
    except ValueError:
        return None


def build_inventory(logs, sources):
    """logs contains (step, parsed log) pairs from the current caller/stage."""
    candidates = {}

    def add(url, title='', route=None, status='candidate', source_id=None):
        url = candidate_url(url)
        if not url:
            return
        row = candidates.setdefault(url, dict(url=url, host=urlsplit(url).hostname, title=title,
                                             category='unclassified', status='candidate', routes=[], source_ids=[]))
        if title and not row['title']:
            row['title'] = title
        if route and route not in row['routes']:
            row['routes'].append(route)
        if source_id and source_id not in row['source_ids']:
            row['source_ids'].append(source_id)
        if status == 'body-captured' or row['status'] != 'body-captured' and status in {'blocked', 'failed', 'awaiting_user'}:
            row['status'] = status

    for step, result in logs:
        if not isinstance(result, dict):
            continue
        args = step.get('args') or []
        route = dict(command=step['command'], log=step.get('file'), exit_code=step.get('exit_code'),
                     stop_reason=result.get('stop_reason'))
        if step['command'] == 'search':
            route.update(platform=args[1] if len(args) > 1 else result.get('platform'),
                         query=args[2] if len(args) > 2 else result.get('query'))
            for item in result.get('candidates') or []:
                if isinstance(item, dict):
                    add(item.get('url'), item.get('title') or item.get('text') or '', route)
        elif step['command'] == 'capture' and len(args) > 1:
            add(args[1], result.get('title', ''), route, result.get('status'))
    for source in sources:
        add(source.get('url'), source.get('title', ''), status='body-captured', source_id=source['id'])
    sites = {}
    for row in candidates.values():
        sites.setdefault(row['host'], dict(host=row['host'], category='unclassified', urls=[]))['urls'].append(row['url'])
    return dict(schema_version=1, candidates=list(candidates.values()), sites=list(sites.values()),
                candidate_count=len(candidates), site_count=len(sites),
                review_required='候选分类、相关性、发布主体和采用决定由执行者复核；body-captured 仅表示已归档正文，不表示已读、相关或采用。')
