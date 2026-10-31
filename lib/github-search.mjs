// GitHub-specific discovery helpers. They only build browser URLs and rank
// content already observed by the browser; no GitHub API or HTTP shortcut is used.

const QUALIFIER_RE = /(?<!\S)-?(?:in|language|stars|forks?|pushed|created|topic|user|org|repo|license|size|is|archived|mirror|sort):(?:"[^"]+"|[^\s]+)/gi;
// Remove request framing without deleting domain nouns such as 用户画像,
// 操作系统, 项目管理 or 工具调用 in the middle of the user's requirement.
const REQUEST_PREFIX_RE = /^(?:(?:请帮我|帮我|请)?(?:找一个|找一些|寻找一个|寻找一些|推荐一个|推荐一些|有没有|我想要|我需要)\s*)+/;
const GITHUB_REPOSITORY_DETAIL = '^https://(?:www\\.)?github\\.com/(?!topics/|features/|settings/|search/|marketplace/|collections/|orgs/|sponsors/|site/|users/|solutions/|enterprise/|contact/|login/|sessions/|notifications/)[^/?#]+/[^/?#]+/?(?:[?#].*)?$';

const FACETS = [
  { id: 'wechat-auth', group: 'intent', pattern: /微信登录|微信授权|微信 OAuth|wechat\s*(?:login|oauth|auth)/i, terms: ['wechat', 'oauth', 'login'] },
  { id: 'wechat-platform', group: 'intent', pattern: /微信|小程序|公众号|mini\s*program|wechat\s*(?:app|mp)/i, terms: ['wechat', 'wechat mini program', 'miniprogram'] },
  { id: 'admin', group: 'intent', pattern: /后台管理|后台|管理后台|admin(?:istration)?|backoffice|后台系统/i, terms: ['admin', 'dashboard', 'backoffice'] },
  { id: 'customer-service', group: 'intent', pattern: /客服|客户服务|在线客服|customer\s*(?:service|support)|helpdesk|support\s*desk/i, terms: ['customer service', 'helpdesk', 'support'] },
  { id: 'ecommerce', group: 'intent', pattern: /电商|电子商务|商城|购物|e-?commerce|online\s*shop/i, terms: ['e-commerce', 'ecommerce', 'shop', 'store'] },
  { id: 'auth', group: 'intent', pattern: /登录|认证|权限|单点登录|RBAC|SSO|authentication|authorization/i, terms: ['auth', 'authentication', 'rbac', 'sso'] },
  { id: 'crawler', group: 'intent', pattern: /爬虫|抓取|采集|网页抓取|web\s*(?:scraping|crawler)|crawler|scraper|spider/i, terms: ['crawler', 'scraper', 'spider'] },
  { id: 'retry', group: 'intent', pattern: /重试|重试机制|容错|退避|限流处理|retry|retries|backoff|resilien(?:ce|t)|fault[- ]?tolerant/i, terms: ['retry', 'backoff', 'resilience'] },
  { id: 'browser-automation', group: 'intent', pattern: /浏览器自动化|浏览器控制|无头浏览器|browser\s*automation|headless|playwright|puppeteer|selenium/i, terms: ['browser automation', 'headless browser', 'playwright', 'puppeteer', 'selenium'] },
  { id: 'ai-agent', group: 'intent', pattern: /智能体|AI\s*agent|agentic|大模型应用|LLM|大语言模型/i, terms: ['ai agent', 'llm', 'agentic'] },
  { id: 'rag', group: 'intent', pattern: /知识库|检索增强|RAG|向量检索|向量数据库|vector\s*(?:search|database)/i, terms: ['rag', 'vector search', 'knowledge base'] },
  { id: 'ocr', group: 'intent', pattern: /OCR|文字识别|字符识别|optical\s*character/i, terms: ['ocr', 'text recognition'] },
  { id: 'workflow', group: 'intent', pattern: /工作流|流程编排|自动化编排|workflow|orchestration|n8n|触发器/i, terms: ['workflow', 'automation', 'orchestration'] },
  { id: 'api', group: 'intent', pattern: /接口服务|后端服务|\b(?:API|REST|GraphQL|backend|server)\b/i, terms: ['api', 'backend', 'server'] },
  { id: 'search', group: 'intent', pattern: /搜索|检索|全文搜索|search|elasticsearch|solr/i, terms: ['search', 'full-text search', 'elasticsearch'] },
  { id: 'analytics', group: 'intent', pattern: /数据分析|报表|BI|可视化|analytics|business intelligence|dashboard/i, terms: ['analytics', 'business intelligence', 'dashboard', 'data visualization'] },
  { id: 'payment', group: 'intent', pattern: /支付|付款|收款|计费|payment|checkout|billing/i, terms: ['payment', 'checkout', 'billing'] },
  { id: 'notification', group: 'intent', pattern: /通知|消息|短信|邮件|notification|messaging|SMS|email/i, terms: ['notification', 'messaging', 'sms', 'email'] },
  { id: 'mobile', group: 'intent', pattern: /移动端|手机|移动应用|mobile\s*app|\b(?:iOS|Android)\b/i, terms: ['mobile', 'mobile app', 'ios', 'android'] },
  { id: 'plugin', group: 'intent', pattern: /插件|扩展|浏览器扩展|plugin|extension/i, terms: ['plugin', 'extension'] },
  { id: 'self-hosted', group: 'constraints', pattern: /自托管|私有化|本地部署|self[- ]?hosted|on[- ]?premise/i, terms: ['self-hosted'] },
  { id: 'chinese', group: 'constraints', pattern: /中文|汉化|简体|繁体|Chinese|中文支持/i, terms: ['chinese'] },
  { id: 'docker', group: 'constraints', pattern: /Docker|容器化|docker[- ]?compose/i, terms: ['docker'] },
  { id: 'saas', group: 'constraints', pattern: /SaaS|多租户|多租戶|multi[- ]?tenant/i, terms: ['saas', 'multi-tenant'] }
];

const LANGUAGE_ALIASES = [
  ['python', /(?:^|\b)(?:python|py)(?:\b|$)/i],
  ['typescript', /(?:^|\b)(?:typescript|ts)(?:\b|$)/i],
  ['javascript', /(?:^|\b)(?:javascript|js|node(?:\.js)?)(?:\b|$)/i],
  ['rust', /(?:^|\b)rust(?:\b|$)/i],
  ['go', /(?:^|\b)(?:golang|go)(?:\b|$)/i],
  ['java', /(?:^|\b)java(?:\b|$)/i],
  ['csharp', /\bc#|\bcsharp\b|(?:^|[\s,(])\.net\b/i],
  ['php', /(?:^|\b)php(?:\b|$)/i],
  ['ruby', /(?:^|\b)ruby(?:\b|$)/i],
  ['swift', /(?:^|\b)swift(?:\b|$)/i],
  ['kotlin', /(?:^|\b)kotlin(?:\b|$)/i],
  ['dart', /(?:^|\b)dart(?:\b|$)/i],
  ['c++', /\bc\+\+/i],
  ['c', /\bc\b(?![+#])/i],
  ['shell', /(?:^|\b)(?:shell|bash|zsh)(?:\b|$)/i],
  ['sql', /(?:^|\b)sql(?:\b|$)/i],
  ['scala', /(?:^|\b)scala(?:\b|$)/i]
];

const STOP_WORDS = new Set(['a', 'an', 'the', 'for', 'with', 'and', 'or', 'to', 'of', 'on', 'in', '一个', '一些', '项目', '仓库', '开源']);

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function compactTerms(values) {
  const output = [];
  for (const value of unique(values)) {
    const current = value.toLowerCase();
    const covered = output.some((item) => item.toLowerCase() === current || item.toLowerCase().includes(current));
    if (covered) continue;
    for (let index = output.length - 1; index >= 0; index--) if (current.includes(output[index].toLowerCase())) output.splice(index, 1);
    output.push(value);
  }
  return output;
}

function normalize(value) {
  // Colons and commas belong to GitHub qualifiers. Extract them before
  // normalizing prose punctuation, or org:x / in:name,readme lose meaning.
  return String(value || '').normalize('NFKC').replace(/[“”「」]/g, '"').replace(/\s+/g, ' ').trim();
}

function cleanBody(value) {
  return normalize(value)
    .replace(QUALIFIER_RE, ' ')
    .replace(/[，、；。！？：,:;!?]/g, ' ')
    .replace(REQUEST_PREFIX_RE, '')
    .replace(/\s*(?:的)?开源(?:项目|工具|系统|软件|仓库)?$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractQualifiers(value) {
  return unique([...normalize(value).matchAll(QUALIFIER_RE)].map((match) => match[0]));
}

export function githubRepositoryFilters(input) {
  const qualifiers = Array.isArray(input) ? input : extractQualifiers(input);
  return {
    include_archived: qualifiers.some(value => /^archived:true$/i.test(value)),
    include_forks: qualifiers.some(value => /^fork:(?:true|only)$/i.test(value))
  };
}

function extractEnglishTokens(value) {
  return unique((String(value).match(/[A-Za-z][A-Za-z0-9+#._/-]*/g) || [])
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token)));
}

function hasQualifier(qualifiers, name) {
  return qualifiers.some((item) => new RegExp(`^-?${name}:`, 'i').test(item));
}

function facetTerms(facets) {
  // GitHub treats adjacent words as an AND expression.  Sending every
  // synonym in one query therefore destroys recall (for example, a project
  // rarely contains both "helpdesk" and "customer service").  Keep one
  // canonical English term per facet; the primary route still preserves the
  // user's wording and technology terms supply the focused variants.
  return unique(facets.flatMap((facet) => FACETS.find((item) => item.id === facet)?.terms?.slice(0, 1) || []));
}

function formatQuery(terms, qualifiers) {
  const body = compactTerms(terms).join(' ').trim();
  const query = unique([body, ...qualifiers]).join(' ').trim();
  return query || qualifiers.join(' ');
}

function addQuery(queries, id, purpose, terms, qualifiers, extra = {}) {
  const query = formatQuery(terms, qualifiers);
  if (!query || queries.some((item) => item.query === query)) return;
  queries.push({ id, purpose, query, ...extra });
}

/**
 * Turn a natural-language request into a small, inspectable GitHub query plan.
 * The plan deliberately keeps the original wording as one query and adds
 * focused variants rather than silently replacing what the user asked for.
 */
export function githubQueryPlan(input, options = {}) {
  const original = String(input || '').trim();
  const normalizedOriginal = normalize(original);
  const qualifiers = extractQualifiers(normalizedOriginal);
  if (!hasQualifier(qualifiers, 'is')) qualifiers.push('is:public');
  if (!hasQualifier(qualifiers, 'archived')) qualifiers.push('archived:false');
  if (!hasQualifier(qualifiers, 'fork')) qualifiers.push('fork:false');
  const body = cleanBody(normalizedOriginal);
  const english = extractEnglishTokens(body);
  const facets = { intent: [], constraints: [], technology: [] };
  for (const facet of FACETS) if (facet.pattern.test(normalizedOriginal.replace(QUALIFIER_RE, ' '))) facets[facet.group].push(facet.id);
  for (const [language, pattern] of LANGUAGE_ALIASES) if (pattern.test(body)) facets.technology.push(language);
  // Keep technology names that are useful in repository names and descriptions.
  for (const token of english) if (/^(?:react|vue|angular|next\.js|nuxt|django|flask|fastapi|spring|laravel|electron|flutter|react-native|playwright|puppeteer|selenium|tailwind|vite|tensorflow|pytorch|opencv|redis|postgres(?:ql)?|mongodb|kubernetes|k8s)$/i.test(token)) facets.technology.push(token.toLowerCase());
  const preferredKeywords = Array.isArray(options.preferredKeywords) ? options.preferredKeywords : options.preferredKeywords ? [options.preferredKeywords] : [];
  for (const term of preferredKeywords) {
    const value = String(term).trim().toLowerCase();
    if (value && body.toLowerCase().includes(value) && !facets.technology.includes(value)) facets.technology.push(value);
  }
  for (const key of Object.keys(facets)) facets[key] = unique(facets[key]);

  const intentTerms = facetTerms(facets.intent);
  const constraintTerms = facetTerms(facets.constraints);
  // GitHub treats adjacent terms as AND. A query containing every detected
  // feature is usually too strict (a README may say "wechat" and "admin"
  // while describing customer support under a product name). Keep the full
  // intent set in the plan for explanation, but search with bounded semantic
  // slices and use the other slices as recall routes.
  const semantic = compactTerms([
    ...intentTerms.slice(0, 3),
    ...facets.technology.filter((item) => !LANGUAGE_ALIASES.some(([language]) => language === item)).slice(0, 1),
    ...(!intentTerms.length ? english.slice(0, 3) : [])
  ]);
  const intentSearch = compactTerms([
    ...intentTerms.slice(0, 2),
    ...facets.technology.slice(0, 1)
  ]);
  const qualitySearch = compactTerms([
    ...intentTerms.slice(-2),
    ...facets.technology.slice(0, 1)
  ]);
  const fallbackSearch = compactTerms([
    ...(intentTerms.length ? intentTerms.slice(0, 2) : english.slice(0, 4)),
    ...facets.technology.slice(0, 1)
  ]);
  const languageQualifiers = hasQualifier(qualifiers, 'language') ? [] : facets.technology
    .filter((item) => LANGUAGE_ALIASES.some(([language]) => language === item))
    .map((language) => `language:${language}`);
  const inQualifier = hasQualifier(qualifiers, 'in') ? [] : ['in:name,description,readme'];
  const queries = [];
  addQuery(queries, 'primary', '保留原意并搜索仓库名、简介与 README', [body || original], [...qualifiers, ...inQualifier]);
  if (semantic.length) addQuery(queries, 'semantic', '用任务同义词扩展召回（限制 AND 词数）', semantic, [...qualifiers, ...inQualifier]);
  if (facets.intent.length) addQuery(queries, 'intent', '只保留最核心的功能目标，减少自然语言噪声', intentSearch, [...qualifiers, ...inQualifier]);
  if (languageQualifiers.length) addQuery(queries, 'language', '按识别出的语言过滤', [...semantic, ...facets.technology.filter((item) => !languageQualifiers.some((value) => value.endsWith(item)))], [...qualifiers, ...inQualifier, ...languageQualifiers]);
  const hasStars = hasQualifier(qualifiers, 'stars');
  addQuery(queries, 'quality', '保留质量较高的仓库作为优先候选', qualitySearch.length ? qualitySearch : [body || original], [...qualifiers, ...inQualifier, ...languageQualifiers, ...(hasStars ? [] : ['stars:>10'])]);
  if (facets.constraints.length && !queries.some((item) => item.id === 'constraint')) addQuery(queries, 'constraint', '按部署与语言约束补查', [...fallbackSearch, ...constraintTerms.slice(0, 1)], [...qualifiers, ...inQualifier]);

  const searchTerms = unique([...english, ...intentTerms, ...constraintTerms, ...facets.technology]);
  return {
    original,
    normalized: body || original,
    qualifiers,
    facets,
    search_terms: searchTerms,
    search_groups: { intent: intentTerms, constraints: constraintTerms, semantic, intent_search: intentSearch, quality: qualitySearch, fallback: fallbackSearch },
    queries: queries.slice(0, 6),
    suggested_queries: queries.map((item) => item.query)
  };
}

function sortedURL(template, query, sort = 'stars') {
  const url = new URL(template.replaceAll('{query}', encodeURIComponent(query)));
  if (sort) {
    url.searchParams.set('s', sort);
    url.searchParams.set('o', 'desc');
  }
  return url.href;
}

/** Build a bounded set of native GitHub searches plus public and GitCN fallbacks. */
export function githubSearchRoutes(site, input, providedPlan) {
  const plan = providedPlan?.queries ? providedPlan : githubQueryPlan(input);
  const priority = ['primary', 'semantic', 'intent', 'quality', 'language', 'constraint'];
  const selected = priority.map((id) => plan.queries.find((item) => item.id === id)).filter(Boolean).slice(0, 4);
  const routes = selected.map((item, index) => ({
    kind: index === 0 ? 'native' : 'native_variant',
    route_id: `github-${item.id}`,
    query: item.query,
    query_variant: item.id,
    purpose: item.purpose,
    url: sortedURL(site.search, item.query, 'stars')
  }));
  const domain = site.index_domain || site.domains?.[0] || 'github.com';
  const fallbackQueries = unique([
    plan.queries.find((item) => item.id === 'semantic')?.query,
    plan.queries.find((item) => item.id === 'intent')?.query,
    plan.queries.find((item) => item.id === 'quality')?.query,
    plan.queries.find((item) => item.id === 'primary')?.query
  ].map((value) => value ? value.replace(QUALIFIER_RE, ' ').replace(/\s+/g, ' ').trim() : '')).slice(0, 2);
  for (const [index, query] of fallbackQueries.entries()) routes.push({
    kind: index === 0 ? 'public_index' : 'public_index_variant',
    route_id: `bing-github-${index + 1}`,
    query,
    query_variant: `plain-${index + 1}`,
    filters_require_detail_check: plan.qualifiers,
    purpose: 'GitHub 站内搜索没有候选时用 Bing site: 索引发现入口',
    url: `https://www.bing.com/search?q=${encodeURIComponent(`site:${domain} ${query}`)}`
  });
  // GitCN is a browser-facing Chinese discovery index whose cards link back
  // to the original GitHub repository. It needs the real /search page form;
  // appending ?q= to /search produces a page shell without running a search.
  // Keep it after native and Bing routes, and let search.mjs skip it whenever
  // an earlier route already produced candidates.
  routes.push({
    kind: 'mirror',
    route_id: 'gitcn-github',
    query: plan.normalized,
    query_variant: 'gitcn',
    filters_require_detail_check: plan.qualifiers,
    purpose: 'GitHub 原生入口和公开索引没有候选时，用 GitCN 中文社区发现原始 GitHub 仓库',
    url: 'https://gitcn.org/search',
    form: { mode: 'form', entry_url: 'https://gitcn.org/search', query_parameter: 'q' },
    candidate_site: {
      id: 'gitcn',
      name: 'GitCN（GitHub 中文社区）',
      domains: ['gitcn.org'],
      external_results: true,
      result_domains: ['github.com'],
      repository_search: true,
      detail: GITHUB_REPOSITORY_DETAIL
    }
  });
  return routes.filter((route, index, all) => all.findIndex((item) => item.url === route.url) === index).slice(0, 7);
}

function parseMetric(match) {
  if (!match) return 0;
  const number = Number(String(match[1]).replace(/,/g, ''));
  if (!Number.isFinite(number)) return 0;
  const suffix = String(match[2] || '').toLowerCase();
  return Math.round(number * (suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1));
}

export function githubSignals(item) {
  const text = String(item?.text || item?.title || '') + ' ' + String(item?.context || '');
  const labelledStars = text.match(/([\d,.]+)\s*([km])?\s*(?:stars?|stargazers?|星标|星星)/i);
  // Current GitHub result cards render the metric as "32.6k · Updated ...
  // Star" without the word "stars" next to the number.  The separator and
  // Updated label make this pattern specific enough to avoid treating years
  // or issue numbers as star counts.
  const cardStars = text.match(/([\d,.]+)\s*([km])?\s*[·•]\s*(?:updated|更新)/i);
  const stars = parseMetric(labelledStars || cardStars);
  const forks = parseMetric(text.match(/([\d,.]+)\s*([km])?\s*(?:forks?|派生)/i));
  return {
    stars,
    forks,
    archived: /(?:\barchived\b|已归档|归档仓库)/i.test(text),
    forked: /(?:\bforked\b|is a fork|派生仓库)/i.test(text),
    language: text.match(/(?:language|语言)[:\s]+([A-Za-z0-9+#.-]+)/i)?.[1] || null
  };
}

function normalizedTerm(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}+#.-]+/gu, ' ').trim();
}

function scoreCandidate(item, plan, index) {
  const signals = githubSignals(item);
  const text = normalizedTerm(`${item?.text || ''} ${item?.title || ''} ${item?.context || ''} ${item?.url || ''}`);
  const terms = unique(plan.search_terms || []).map(normalizedTerm).filter((term) => term.length > 1);
  const matched = terms.filter((term) => text.includes(term));
  // The first intent facets are the user's core request. Quality routes may
  // contain generic terms such as auth/notification and very popular SDKs;
  // stars must never allow those generic matches to outrank a repository that
  // actually names the requested product area.
  const coreTerms = unique(plan.search_groups?.intent || []).slice(0, 3).map(normalizedTerm).filter((term) => term.length > 1);
  const coreMatched = coreTerms.filter((term) => text.includes(term));
  const coverage = terms.length ? matched.length / terms.length : 0;
  const exact = plan.normalized && text.includes(normalizedTerm(plan.normalized)) ? 14 : 0;
  const relevance = matched.length * 10 + coverage * 42 + exact + coreMatched.length * 24 - (coreTerms.length && !coreMatched.length ? 70 : 0);
  const quality = Math.log10(signals.stars + 1) * 8 + Math.log10(signals.forks + 1) * 2;
  const filters = githubRepositoryFilters(plan.qualifiers || []);
  const penalties = (signals.archived && !filters.include_archived ? 160 : 0) + (signals.forked && !filters.include_forks ? 30 : 0);
  return { score: relevance + quality - penalties, signals, matched, coreMatched };
}

/** Rank repository candidates without discarding low-star or niche projects. */
export function rankGitHubCandidates(candidates, planOrQuery) {
  const plan = planOrQuery?.queries ? planOrQuery : githubQueryPlan(planOrQuery);
  const seen = new Map();
  for (const [index, item] of (candidates || []).entries()) {
    if (!item?.url) continue;
    const key = String(item.url).replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    const scored = scoreCandidate(item, plan, index);
    const previous = seen.get(key);
    const enriched = {
      ...item,
      github_score: Number(scored.score.toFixed(2)),
      github_signals: scored.signals,
      github_matched_terms: scored.matched,
      github_core_matched_terms: scored.coreMatched,
      ...(previous?.github_query_variants ? { github_query_variants: previous.github_query_variants } : {})
    };
    if (!previous || enriched.github_score > previous.github_score) seen.set(key, enriched);
  }
  return [...seen.values()].sort((a, b) => b.github_score - a.github_score || String(a.url).localeCompare(String(b.url)));
}
