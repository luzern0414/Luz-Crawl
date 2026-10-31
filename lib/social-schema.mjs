const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const ALLOWED_SOURCES = new Set(['page_state', 'json_ld', 'dom', 'visible_text', 'observed_media']);
const PLATFORM_TERMS = new Set(['小红书', '小红書', 'rednote', 'xiaohongshu', '抖音', 'douyin', 'tiktok', '笔记', '视频', '评论', '用户', '内容']);
const STOP_REASONS = new Set(['no_new_comments', 'comment_budget', 'page_end', 'login_required', 'verification_required', 'rate_limited', 'operation_budget', 'cancelled']);

function finiteDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function timezoneParts(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    return Object.fromEntries(parts.filter((item) => item.type !== 'literal').map((item) => [item.type, item.value]));
  } catch {
    return timezoneParts(date, 'UTC');
  }
}

function timezoneOffset(date, timezone) {
  try {
    const value = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' })
      .formatToParts(date).find((item) => item.type === 'timeZoneName')?.value || 'GMT';
    const match = value.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
    if (!match) return 0;
    return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] || 0));
  } catch { return 0; }
}

function pad(value, width = 2) { return String(value).padStart(width, '0'); }

function formatLocalISO(date, timezone, milliseconds = false) {
  const parts = timezoneParts(date, timezone);
  const offset = timezoneOffset(date, timezone);
  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  const suffix = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${milliseconds ? `.${pad(date.getMilliseconds(), 3)}` : ''}${suffix}`;
}

function localDate(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0, timezone = DEFAULT_TIMEZONE) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let offset = timezoneOffset(new Date(naive), timezone);
  let date = new Date(naive - offset * 60_000);
  offset = timezoneOffset(date, timezone);
  date = new Date(naive - offset * 60_000);
  const parts = timezoneParts(date, timezone);
  if (Number(parts.year) !== year || Number(parts.month) !== month || Number(parts.day) !== day) return null;
  return date;
}

function parsed(raw, date, timezone, precision, source, milliseconds = false) {
  if (!date) return { raw, iso: null, timezone, precision: null, source, parse_error: 'unrecognized' };
  return { raw, iso: formatLocalISO(date, timezone, milliseconds), timezone, precision, source, parse_error: null };
}

function relativeDate(now, amount, unit) {
  const milliseconds = { 秒: 1_000, 秒钟: 1_000, 分: 60_000, 分钟: 60_000, 小时: 3_600_000, 天: 86_400_000, 周: 604_800_000 }[unit];
  return milliseconds ? new Date(now.getTime() - amount * milliseconds) : null;
}

/** Parse dates visible on social pages while keeping the raw value and precision. */
export function parseSocialTime(value, now = new Date(), timezone = DEFAULT_TIMEZONE) {
  const raw = value;
  const base = finiteDate(now) || new Date();
  const empty = { raw, iso: null, timezone, precision: null, source: 'unknown', parse_error: 'unrecognized' };
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return empty;
  if (value && typeof value === 'object' && typeof value.iso === 'string') return { ...value, raw: value.raw ?? raw, timezone: value.timezone || timezone };
  if (value instanceof Date) return parsed(raw, finiteDate(value), timezone, 'millisecond', 'date', true);
  if (typeof value === 'number' || /^\d{10,13}(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number)) return empty;
    const milliseconds = String(Math.trunc(number)).length >= 13;
    const date = new Date(milliseconds ? number : number * 1_000);
    return parsed(raw, finiteDate(date), timezone, milliseconds ? 'millisecond' : 'second', 'unix', milliseconds);
  }
  const text = String(value).normalize('NFKC').trim();
  const isoDate = finiteDate(text);
  if (/^\d{4}-\d{2}-\d{2}T/i.test(text) && isoDate) {
    const precision = /\.\d+/.test(text) ? 'millisecond' : 'second';
    return parsed(raw, isoDate, timezone, precision, 'absolute', precision === 'millisecond');
  }
  if (/^(?:刚刚|刚才|just now)$/i.test(text)) return parsed(raw, base, timezone, 'second', 'relative');
  const relative = text.match(/^(\d+)\s*(秒钟?|分钟?|小时?|天|周)前$/i) || text.match(/^(\d+)\s*(seconds?|minutes?|hours?|days?|weeks?)\s+ago$/i);
  if (relative) {
    const unitMap = { second: '秒', seconds: '秒', minute: '分', minutes: '分', hour: '小时', hours: '小时', day: '天', days: '天', week: '周', weeks: '周' };
    const unit = unitMap[String(relative[2]).toLowerCase()] || relative[2];
    return parsed(raw, relativeDate(base, Number(relative[1]), unit), timezone, unit === '秒' ? 'second' : unit === '分' ? 'minute' : unit === '小时' ? 'hour' : 'day', 'relative');
  }
  if (/^(?:昨天|yesterday)/i.test(text)) {
    const clock = text.match(/(?:昨天|yesterday)\s*(\d{1,2})(?::|：)(\d{1,2})(?::|：)?(\d{0,2})?/i);
    const localNow = timezoneParts(base, timezone);
    const date = localDate(Number(localNow.year), Number(localNow.month), Number(localNow.day) - 1, Number(clock?.[1] || localNow.hour), Number(clock?.[2] || localNow.minute), Number(clock?.[3] || 0), 0, timezone);
    return parsed(raw, date || new Date(base.getTime() - 86_400_000), timezone, clock ? 'minute' : 'day', 'relative');
  }
  const absolute = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})(?::|：)(\d{1,2})(?::|：)?(\d{1,2})?)?$/);
  if (absolute) {
    const date = localDate(Number(absolute[1]), Number(absolute[2]), Number(absolute[3]), Number(absolute[4] || 0), Number(absolute[5] || 0), Number(absolute[6] || 0), 0, timezone);
    return parsed(raw, date, timezone, absolute[4] ? 'minute' : 'day', 'absolute');
  }
  const chinese = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})(?::|：)(\d{1,2}))?$/);
  if (chinese) {
    const date = localDate(Number(chinese[1]), Number(chinese[2]), Number(chinese[3]), Number(chinese[4] || 0), Number(chinese[5] || 0), 0, 0, timezone);
    return parsed(raw, date, timezone, chinese[4] ? 'minute' : 'day', 'absolute');
  }
  const monthDay = text.match(/^(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})(?::|：)(\d{1,2}))?$/);
  if (monthDay) {
    const localNow = timezoneParts(base, timezone);
    const date = localDate(Number(localNow.year), Number(monthDay[1]), Number(monthDay[2]), Number(monthDay[3] || 0), Number(monthDay[4] || 0), 0, 0, timezone);
    return parsed(raw, date, timezone, monthDay[3] ? 'minute' : 'day', 'absolute');
  }
  if (isoDate && /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/.test(text)) return parsed(raw, isoDate, timezone, 'day', 'absolute');
  return empty;
}

function termsFromQuery(value) {
  return [...new Set(String(value || '').normalize('NFKC').match(/[\p{Script=Han}]{2,}|[A-Za-z][A-Za-z0-9+#.-]{1,}|\d+/gu) || [])]
    .map((item) => item.trim()).filter((item) => item.length >= 2);
}

function queryKey(value) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase(); }

/** Build a small, inspectable query plan instead of silently changing user terms. */
export function expandSocialQueries(request, { platform = 'web', maxQueries = 8, extraTerms = [] } = {}) {
  const original = typeof request === 'object' ? String(request.query || request.text || '').trim() : String(request || '').trim();
  const limit = Math.max(1, Math.min(32, Number(maxQueries) || 8));
  const terms = termsFromQuery(original);
  const core = terms.filter((term) => !PLATFORM_TERMS.has(term.toLowerCase())).slice(0, 6);
  const normalizedPlatform = String(platform || 'web').toLowerCase();
  const contentWords = normalizedPlatform === 'xhs' ? ['笔记', '评论', '用户'] : normalizedPlatform === 'douyin' ? ['视频', '评论', '用户'] : ['内容', '评论'];
  const candidates = [];
  const add = (query, purpose, evidence = ['title', 'body', 'author']) => {
    const value = String(query || '').replace(/\s+/g, ' ').trim();
    if (!value || candidates.some((item) => queryKey(item.query) === queryKey(value))) return;
    candidates.push({ query: value, purpose, evidence });
  };
  add(original, '原始查询', ['title', 'body', 'author', 'published']);
  if (core.length) add(core.join(' '), '主题词组合');
  if (core.length >= 2) add(core.slice(0, 2).join(' '), '核心对象组合');
  for (const word of contentWords) if (core.length) add(`${core.slice(0, 3).join(' ')} ${word}`, `平台内容变体：${word}`, ['title', 'body', 'comments']);
  for (const term of [...extraTerms, ...core.slice(0, 3)]) {
    const clean = String(term || '').trim();
    if (clean) add(`${clean} ${contentWords[0]}`, '补充主题词', ['title', 'body']);
  }
  const facets = [
    { name: 'topic', terms: core },
    { name: 'platform', terms: [normalizedPlatform] },
    { name: 'content', terms: contentWords },
  ];
  return { original, platform: normalizedPlatform, facets, queries: candidates.slice(0, limit), suggested_queries: candidates.slice(1, limit).map((item) => item.query) };
}

function commentText(comment) { return String(comment?.text ?? comment?.content ?? comment?.body ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim(); }
function commentAccount(comment) { return comment?.account || comment?.author || comment?.user || {}; }

/** Remove duplicates produced by virtualized comment lists without dropping raw values. */
export function dedupeSocialComments(comments = []) {
  const seen = new Set();
  const keys = [];
  const unique = [];
  let duplicates = 0;
  for (const comment of Array.isArray(comments) ? comments : []) {
    const account = commentAccount(comment);
    const id = comment?.id ?? comment?.comment_id ?? comment?.commentId ?? comment?.cid;
    const published = comment?.published?.iso ?? comment?.published?.raw ?? comment?.time ?? comment?.created_at ?? '';
    const text = commentText(comment);
    const key = id ? `id:${id}` : `fingerprint:${String(account.id ?? account.handle ?? account.name ?? '').trim()}|${published}|${text}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key); keys.push(key); unique.push(comment);
  }
  return { comments: unique, duplicates, keys };
}

function valueNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && 'value' in value) return valueNumber(value.value);
  const text = String(value).replace(/,/g, '').trim().toLowerCase();
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*([万亿mk])?/i);
  if (!match) return null;
  const multiplier = { 万: 1e4, 亿: 1e8, k: 1e3, m: 1e6 }[match[2]] || 1;
  return Math.round(Number(match[1]) * multiplier);
}

function metric(value) {
  if (value && typeof value === 'object' && ('value' in value || 'raw' in value)) return { raw: value.raw ?? value.value, value: valueNumber(value.value ?? value.raw), source: value.source };
  return { raw: value ?? null, value: valueNumber(value) };
}

function normalizeAccount(value = {}) {
  const account = value && typeof value === 'string' ? { name: value } : (value || {});
  return {
    id: account.id ?? account.user_id ?? account.userId ?? account.uid ?? account.sec_uid ?? null,
    name: account.name ?? account.nickname ?? account.nick_name ?? account.display_name ?? null,
    handle: account.handle ?? account.unique_id ?? account.uniqueId ?? account.short_id ?? null,
    profile_url: account.profile_url ?? account.profileUrl ?? account.url ?? null,
  };
}

function choose(input, ...keys) {
  for (const key of keys) if (input?.[key] !== undefined && input?.[key] !== null && input?.[key] !== '') return input[key];
  return null;
}

function inferSource(input, key, fallback = 'dom') {
  const explicit = input?.field_sources?.[key];
  if (ALLOWED_SOURCES.has(explicit)) return explicit;
  if (input?.state && ['id', 'title', 'text', 'body', 'published', 'time', 'account', 'author', 'engagement'].includes(key)) return 'page_state';
  if (input?.json_ld && ['title', 'text', 'published', 'account'].includes(key)) return 'json_ld';
  return ALLOWED_SOURCES.has(fallback) ? fallback : 'dom';
}

function normalizePublished(value, input, key = 'published') {
  if (value && typeof value === 'object' && typeof value.iso === 'string') return value;
  return parseSocialTime(value, input.now || new Date(), input.timezone || DEFAULT_TIMEZONE);
}

function normalizeEngagement(value = {}) {
  const output = {};
  for (const [key, item] of Object.entries(value || {})) output[key] = metric(item);
  return output;
}

function normalizeComment(comment, input) {
  const account = normalizeAccount(commentAccount(comment));
  const id = choose(comment, 'id', 'comment_id', 'commentId', 'cid');
  const rawPublished = choose(comment, 'published', 'time', 'created_at', 'create_time', 'timestamp');
  const field_sources = { ...(comment.field_sources || {}) };
  if (rawPublished !== null) field_sources.published ||= comment.source || 'dom';
  return {
    ...comment,
    id: id ?? null,
    text: commentText(comment),
    account,
    author: account,
    profile_url: account.profile_url,
    published: normalizePublished(rawPublished, input),
    likes: metric(choose(comment, 'likes', 'like_count', 'digg_count', 'likeCount')),
    parent_id: choose(comment, 'parent_id', 'parentId', 'reply_to') ?? null,
    field_sources,
  };
}

/** Merge measured comment coverage while keeping displayed totals separate from loaded rows. */
export function mergeCommentCoverage(previous = {}, next = {}) {
  const a = previous || {};
  const b = next || {};
  const displayed = [a.displayed_total, b.displayed_total].filter((value) => Number.isFinite(Number(value))).map(Number);
  const stop = b.stop_reason || a.stop_reason || null;
  return {
    loaded: Math.max(0, Number(a.loaded) || 0, Number(b.loaded) || 0),
    displayed_total: displayed.length ? Math.max(...displayed) : null,
    all_comments_verified: Boolean(a.all_comments_verified && b.all_comments_verified) || Boolean(b.all_comments_verified && !stop),
    batches: Math.max(0, Number(a.batches) || 0, Number(b.batches) || 0),
    stop_reason: stop && STOP_REASONS.has(stop) ? stop : stop,
  };
}

/** Normalize page state and visible DOM data into the archive's social record shape. */
export function normalizeSocialRecord(input = {}) {
  const state = input.state && typeof input.state === 'object' ? input.state : {};
  const sourcePost = input.post && typeof input.post === 'object' ? input.post : {};
  const nested = state.note && typeof state.note === 'object' ? state.note : {};
  const rawPost = { ...nested, ...state, ...sourcePost };
  const sourceFallback = input.source || (input.state ? 'page_state' : input.json_ld ? 'json_ld' : 'dom');
  const account = normalizeAccount(choose(rawPost, 'account', 'author', 'user') || choose(state, 'account', 'author', 'user'));
  const rawPublished = choose(rawPost, 'published', 'publish_time', 'publishTime', 'time', 'created_at', 'create_time', 'timestamp');
  const published = normalizePublished(rawPublished, input);
  const rawEngagement = rawPost.engagement || {
    likes: choose(rawPost, 'likes', 'like_count', 'digg_count', 'likeCount'),
    comments: choose(rawPost, 'comments_count', 'comment_count', 'commentCount'),
    favorites: choose(rawPost, 'favorites', 'collect_count', 'collectCount'),
    shares: choose(rawPost, 'shares', 'share_count', 'shareCount'),
    views: choose(rawPost, 'views', 'play_count', 'playCount'),
  };
  const post = {
    ...sourcePost,
    id: choose(sourcePost, 'id', 'noteId', 'note_id', 'video_id', 'aweme_id') ?? choose(state, 'id', 'noteId', 'note_id', 'video_id', 'aweme_id') ?? null,
    url: choose(sourcePost, 'url', 'profile_url') ?? input.requestedURL ?? input.url ?? null,
    title: choose(sourcePost, 'title', 'name') ?? choose(state, 'title', 'name') ?? null,
    text: choose(sourcePost, 'text', 'body', 'desc', 'description', 'content') ?? choose(state, 'text', 'body', 'desc', 'description', 'content') ?? '',
    account,
    author: account,
    published,
    engagement: normalizeEngagement(rawEngagement),
    tags: sourcePost.tags || state.tags || [],
    media: sourcePost.media || state.media || [],
    images: sourcePost.images || state.images || [],
    videos: sourcePost.videos || state.videos || [],
    content_present: Boolean(choose(sourcePost, 'text', 'body', 'desc', 'description', 'content') || choose(state, 'text', 'body', 'desc', 'description', 'content') || sourcePost.media?.length || state.media?.length),
    access_mode: input.access_mode === 'authorized_browser' ? 'authorized_browser' : 'public',
  };
  const field_sources = {
    ...(input.field_sources || {}),
    id: inferSource(input, 'id', sourceFallback),
    title: inferSource(input, 'title', sourceFallback),
    text: inferSource(input, 'text', sourceFallback),
    account: inferSource(input, 'account', sourceFallback),
    published: inferSource(input, 'published', sourceFallback),
    engagement: inferSource(input, 'engagement', sourceFallback),
  };
  post.field_sources = field_sources;
  const normalized = dedupeSocialComments((input.comments || []).map((comment) => normalizeComment(comment, input)));
  const suppliedCoverage = input.coverage || input.comments_coverage || {};
  const coverage = mergeCommentCoverage({ displayed_total: post.engagement.comments?.value ?? null }, {
    ...suppliedCoverage,
    loaded: suppliedCoverage.loaded ?? normalized.comments.length,
  });
  return {
    platform: input.platform || 'web',
    post,
    account,
    comments: normalized.comments,
    duplicates: normalized.duplicates,
    coverage,
    comments_coverage: coverage,
    field_sources,
    access_mode: post.access_mode,
  };
}

/** Select bounded detail and comment work from the number of discovered candidates. */
export function selectAdaptiveBudget({ candidates = 0, read = 0, comments = false, base = 5, failures = 0, hardMax = 20 } = {}) {
  const candidateCount = Math.max(0, Number(candidates) || 0);
  const requested = Math.max(0, Number(read) || 0);
  const minimum = Math.max(1, Number(base) || 1);
  const maximum = Math.max(minimum, Number(hardMax) || 20);
  const detail_limit = candidateCount === 0 || requested === 0 ? 0 : Math.min(candidateCount, maximum, Math.max(minimum, requested * 2));
  const reserve = Math.max(0, Number(failures) || 0);
  const next_batch = Math.min(candidateCount, maximum, Math.max(detail_limit, requested + reserve, minimum));
  const stop_reason = candidateCount === 0 ? 'no_candidates' : null;
  return {
    detail_limit,
    comment_limit: comments ? Math.min(50, Math.max(10, detail_limit * 2 || minimum * 2)) : 0,
    next_batch,
    hard_max: maximum,
    stop_reason,
  };
}

