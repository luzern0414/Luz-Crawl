const STOP_LABELS = {
  verification_required: '等待手动验证',
  login_required: '等待登录',
  rate_limited: '已限流，暂停当前路线',
  no_candidates: '没有通过核验的候选',
  no_new_comments: '评论没有新增',
  comment_budget: '达到评论预算',
  page_end: '已到页面末尾',
  cancelled: '已取消',
  scroll_budget: '达到滚动预算',
  stable_after_2_scrolls: '页面已稳定',
  stable_after_3_scrolls: '页面已稳定',
  operation_budget: '达到操作预算',
  unavailable: '页面不可用',
  access_denied: '访问被拒绝',
  content_incomplete: '正文仍不完整',
};
const STAGE_LABELS = {
  planning: '规划中',
  query: '查询中',
  candidates: '筛选候选',
  detail: '读取详情',
  comments: '加载评论',
  browser_command: '执行浏览器操作',
  stopped: '已停止',
  finished: '已完成',
};

function numberPart(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }

export function formatTaskStatus(status = {}) {
  const mode = status.access_mode === 'authorized_browser' ? '已连接浏览器授权' : '公开页面';
  const stop = STOP_LABELS[status.stop_reason];
  const parts = [mode];
  const queryCount = numberPart(status.query_count);
  const candidateCount = numberPart(status.candidate_count);
  const verifiedCount = numberPart(status.verified_count);
  const commentLoaded = numberPart(status.comment_loaded);
  const stage = STAGE_LABELS[status.stage];
  if (stage) parts.push(stage);
  if (typeof status.query_current === 'string' && status.query_current.trim()) {
    const query = status.query_current.trim().replace(/\s+/g, ' ');
    parts.push(`词 ${query.length > 24 ? `${query.slice(0, 24)}…` : query}`);
  }
  if (queryCount !== null) parts.push(`查询 ${queryCount}`);
  if (candidateCount !== null) parts.push(`候选 ${candidateCount}`);
  if (verifiedCount !== null) parts.push(`详情 ${verifiedCount}`);
  if (commentLoaded !== null) parts.push(`评论 ${commentLoaded}`);
  if (stop) parts.push(stop);
  if (!status.active && !stop && status.status === 'partial') parts.push('部分完成');
  if (!status.active && !stop && status.status === 'failed') parts.push('执行失败');
  if (!status.active && !stop && status.status === 'captured') parts.push('已完成');
  if (status.active && parts.length === 1) parts.push('任务运行中');
  return parts.join(' · ');
}

