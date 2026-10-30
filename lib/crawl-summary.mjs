import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, findTaskArchive } from './archive.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clean = value => String(value || '').replace(/https?:\/\/[^\s<>"）)]+/g, '').replace(/\s+/g, ' ').trim();
const queues = new Map();
const names = {'ggzy.gov.cn':'全国公共资源交易平台','ygp.gdzwfw.gov.cn':'广东省公共资源交易平台','gdgpo.czt.gd.gov.cn':'广东省政府采购网','fszc.zcjb.com.cn':'佛山阳光采购平台','qianlima.com':'千里马招标网','yfbzb.com':'乙方宝','bidcenter.com.cn':'采招网','qcc.com':'企查查','xydec.com.cn':'星艺装饰官网','mingdiao.com.cn':'名雕装饰官网','mjdec.com':'名匠装饰官网','szecp.com.cn':'华润守正采购平台','search.crc.com.cn':'华润站内搜索','plap.mil.cn':'军队采购网','lw.gov.cn':'荔湾区政府网站','powerchina.cn':'中国电建采购平台','szygcg.com':'深圳阳光采购平台','zcg.szcg.cn':'特区建工采购平台'};

async function taskRoot(directory) {
  const initial = path.resolve(directory);
  for (let current = initial; ; current = path.dirname(current)) {
    if (await findTaskArchive(current)) return current;
    if (current === path.dirname(current)) return initial;
  }
}

// Ignore media, snapshots and symlinks; the summary reads persisted evidence only.
async function evidenceFiles(root) {
  let entries;
  try { entries = await fs.readdir(root, {withFileTypes:true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory() && !['snapshots','browser-actions','media','downloads','platform-probes'].includes(entry.name)) files.push(...await evidenceFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.json') && (['content.json','collection.json'].includes(entry.name) || /^(batch-|search-)/.test(entry.name) || path.basename(root) === 'tasks')) files.push(file);
  }
  return files;
}

export function summaryEntry(result, at = '', fallbackURL) {
  if (!result || typeof result !== 'object') return null;
  const actions = Array.isArray(result.results) ? result.results : [];
  const observed = actions.filter(v => v.value?.url).at(-1)?.value;
  const read = actions.filter(v => ['read','extract'].includes(v.action) && v.value?.text).at(-1)?.value;
  const extracted = actions.filter(v => v.action === 'extract' && (!observed || v.value?.url === observed.url)).at(-1)?.value;
  const post = result.post || extracted?.post || {};
  let url;
  try {
    const parsed = new URL(result.inspection?.url || observed?.url || result.resolved_url || result.handover_url || result.search_url || result.requested_url || result.url || fallbackURL);
    if (!['https:','http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    url = parsed.href;
  } catch { return null; }
  const text = String(post.text || result.text || (read?.url === observed?.url ? read?.text : '') || result.items?.filter(v => v.kind !== 'page_shell').map(v => v.text || '').join('\n') || '');
  const title = clean(result.title || post.title || result.inspection?.title || observed?.title || result.query || '页面详情').slice(0,110) || '页面详情';
  const status = result.status || 'unknown';
  const labels = {captured:'已保存',completed:'动作完成',partial:'部分获取',awaiting_user:'需人工处理',blocked:'受阻',failed:'失败',skipped:'未访问'};
  const lines = text.split(/[\r\n]+/).map(clean).filter(v => v.length >= 8 && !/^Copyright|^版权所有/i.test(v));
  const excerpt = (lines.find(v => v.includes(title.slice(0,15))) || lines.find(v => v.length >= 50) || lines[0] || '').slice(0,125);
  const count = Number(result.discovered_candidates ?? result.candidates?.length ?? 0);
  const media = result.media || extracted?.media || [];
  const images = post.images?.length || media.filter(v=>v.kind === 'image').length, videos = post.videos?.length || media.filter(v=>v.kind === 'video').length;
  const audios = post.audios?.length || media.filter(v=>v.kind === 'audio').length;
  const reason = result.awaiting_reason || result.stop_reason || result.failure?.code || '';
  const reasons = {login_required:'需要登录',verification_required:'需要验证',rate_limited:'平台限流',access_denied:'访问被拒绝',operation_budget:'操作预算已用尽'};
  const summary = status === 'skipped' ? '同站前序任务受阻，本页尚未访问。' : ['failed','blocked','awaiting_user'].includes(status) ? `${text ? `保留${text.length}字可见文字；` : '未取得可用正文；'}${clean(reasons[reason] || reason || result.error?.message || result.error || '等待处理')}。` : `${excerpt ? `取得“${excerpt}${excerpt.length === 125 ? '…' : ''}”等可见内容` : text ? '取得页面可见文字' : '没有取得目标正文'}${text ? `（约${text.length}字）` : ''}${count ? `，发现${count}条候选，详情须另行核验` : ''}${images || videos || audios ? `，观察到${images}张图片、${videos}段视频、${audios}段音频` : ''}。`;
  const host = new URL(url).hostname;
  const site = Object.entries(names).find(([domain]) => host === domain || host.endsWith('.'+domain))?.[1] || clean(result.platform_name || title);
  return {url,host,site,title,status,label:labels[status] || '待核验',summary,chars:text.length,body_observed:typeof result.text === 'string' || Array.isArray(result.items) || actions.some(v=>['read','extract'].includes(v.action)),at:result.captured_at || result.finished_at || at || ''};
}

export async function writeCrawlSummary(directory) {
  const root = await taskRoot(directory), previous = queues.get(root) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const rows = new Map(), warnings = [];
    const put = (value, at, fallback) => {
      const row = summaryEntry(value, at, fallback);
      if (!row) return;
      const old = rows.get(row.url);
      if (!old || row.at >= old.at) {
        // Session results can omit the body already persisted by the same successful capture.
        if (old?.chars && !row.chars && ['captured','completed','partial'].includes(row.status) && row.status === old.status && !row.body_observed) {
          Object.assign(row,{title:old.title,site:old.site,summary:old.summary,chars:old.chars});
        }
        rows.set(row.url,row);
      } else if (row.chars && !old.chars && row.status === old.status && !old.body_observed) {
        rows.set(row.url,{...row,at:old.at});
      }
    };
    for (const file of await evidenceFiles(root)) {
      let value;
      try { value = JSON.parse(await fs.readFile(file,'utf8')); }
      catch (error) { warnings.push(`${path.basename(file)}: ${error.message}`); continue; }
      if (value.result) put(value.result,value.at,value.url || value.options?.url);
      else if (path.basename(file).startsWith('batch-') || path.basename(file) === 'collection.json') for (const row of value.results || []) put(row,row.finished_at || value.created_at,row.url);
      else { put(value,value.at); for (const source of value.sources || []) if (typeof source === 'object') put(source,value.at); }
    }
    const entries = [...rows.values()].sort((a,b) => a.host.localeCompare(b.host) || b.at.localeCompare(a.at));
    const visited = entries.filter(v => v.status !== 'skipped'), sites = new Set(visited.map(v => v.host));
    const title = (await findTaskArchive(root))?.title || '爬取任务';
    const groups = new Map();
    for (const row of entries) { if (!groups.has(row.host)) groups.set(row.host, []); groups.get(row.host).push(row); }
    const stats = [[sites.size,'涉及站点'],[visited.length,'尝试页面'],[entries.filter(v => v.chars > 0).length,'有可见内容'],[entries.filter(v => !['captured','completed'].includes(v.status)).length,'待核验 / 受阻']].map(([n,t]) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`).join('');
    const records = [...groups].map(([, items]) => `<section class="site"><div class="site-head"><h2><a href="${esc(items[0].url)}" target="_blank" rel="noopener noreferrer">${esc(items[0].site)}</a></h2><span>${items.length} 个页面记录</span></div>${items.map(row => `<article class="entry"><div><a class="title" href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">${esc(row.title)}</a></div><div class="sentence">${esc(row.summary)}</div><div><span class="badge ${['captured','completed'].includes(row.status) ? '' : row.status === 'partial' ? 'warn' : 'fail'}">${esc(row.label)}</span></div></article>`).join('')}</section>`).join('') || '<p class="empty">尚无带来源地址的采集记录。</p>';
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%228%22%20fill%3D%22%23E8F2EA%22%2F%3E%3Ccircle%20cx%3D%2214%22%20cy%3D%2214%22%20r%3D%227%22%20fill%3D%22none%22%20stroke%3D%22%232F6B4F%22%20stroke-width%3D%222.6%22%2F%3E%3Cpath%20d%3D%22M19.5%2019.5%2025%2025%22%20stroke%3D%22%232F6B4F%22%20stroke-width%3D%222.6%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E"><title>${esc(title)} · 爬取总结</title><style>
    :root{font:14px/1.75 "Segoe UI","Microsoft YaHei",sans-serif;color:#203a32;background:#f5f7f3}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0}main{max-width:1120px;margin:auto;padding:28px 24px 44px}header{display:flex;justify-content:space-between;align-items:end;gap:20px}h1{font-size:26px;margin:0 0 8px;letter-spacing:-.5px}p{margin:0;color:#6c7d73}.kicker{font-size:12px;color:#23745c;margin-bottom:8px;letter-spacing:2px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0}.stat{background:white;border:1px solid #dfe8dd;border-radius:9px;padding:13px 18px}.stat b{font-size:26px;margin-right:8px}.stat span{font-size:12px;color:#687d70}.filter{margin-bottom:20px}input{font:inherit;width:100%;padding:10px 13px;border:1px solid #d6e2d4;border-radius:7px;background:white;color:inherit}h2{font-size:16px;margin:0}a{color:#1d7357;text-decoration:none}a:hover{text-decoration:underline}.site{background:white;border:1px solid #dfe8dd;border-radius:10px;margin:14px 0;overflow:hidden}.site-head{padding:14px 18px;display:flex;align-items:center;justify-content:space-between;background:#f9fbf7;border-bottom:1px solid #e5ece1}.site-head span{font-size:11px;color:#7b8b7f;white-space:nowrap;flex:none}.site-head{gap:12px}.site-head h2{min-width:0;overflow-wrap:anywhere}.entry{display:grid;grid-template-columns:minmax(190px,1fr) minmax(0,1.8fr) 88px;gap:20px;padding:15px 18px;border-bottom:1px solid #edf1e9}.entry:last-child{border-bottom:0}.title{font-size:13px;font-weight:600;overflow-wrap:anywhere}.sentence{font-size:12px;color:#65786b;overflow-wrap:anywhere}.badge{font-size:11px;display:inline-block;padding:2px 8px;border-radius:4px;background:#edf5ea;color:#32734b;white-space:nowrap}.badge.warn{background:#faf0df;color:#996d25}.badge.fail{background:#f5ece8;color:#966451}footer{font-size:11px;color:#7b8b7f;margin-top:22px}.empty{padding:25px;text-align:center;color:#6c7d73}details{font-size:12px;color:#8e6934}summary{cursor:pointer}:focus-visible{outline:3px solid #98c3a6;outline-offset:3px}@media(max-width:680px){main{padding:20px 14px}h1{font-size:23px}header{display:block}header>p{margin-top:10px}.stats{grid-template-columns:1fr 1fr;gap:8px}.stat{padding:10px 13px}.stat b{font-size:23px}.entry{grid-template-columns:1fr auto;gap:5px 12px;padding:14px}.sentence{grid-column:1/-1;grid-row:2}.entry>div:last-child{grid-column:2;grid-row:1}.site-head{padding:12px 14px}.site-head h2{font-size:14px}}@media print{input,.filter{display:none}main{padding:0}.entry{break-inside:avoid}}
    </style><main><header><div><div class="kicker">LUZCRAWL / 采集记录</div><h1>${esc(title)}</h1><p>访问过哪些网站，实际取得了什么内容。</p></div><p style="font-size:12px">更新于 ${esc(new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}</p></header><div class="stats">${stats}</div><div class="filter"><input type="search" aria-label="搜索网站或内容" placeholder="搜索网站、页面或获取内容" id="filter"></div><div id="records">${records}</div><p id="empty" class="empty" hidden>没有匹配的记录。</p>${warnings.length ? `<details><summary>${warnings.length} 份记录无法读取，未计入统计</summary><p>${warnings.map(esc).join('<br>')}</p></details>` : ''}<footer>页面记录按实际来源地址合并；可见文字、搜索候选与已核实详情分别判断。“动作完成”只表示浏览器步骤执行结束，目标正文与统计数据仍须另行核验。</footer></main><script>document.getElementById('filter').addEventListener('input',e=>{const q=e.target.value.trim().toLowerCase();let count=0;document.querySelectorAll('.site').forEach(s=>{let found=0;const name=s.querySelector('h2').textContent.toLowerCase();s.querySelectorAll('.entry').forEach(r=>{r.hidden=!(name+' '+r.textContent.toLowerCase()).includes(q);if(!r.hidden)found++});s.hidden=!found;count+=found});document.getElementById('empty').hidden=!!count});</script></html>`;
    const file = path.join(root, 'raw', '爬取总结.html');
    await atomicWrite(file, html);
    return {file,websites:sites.size,pages:visited.length,records:entries.length,warnings};
  });
  queues.set(root,pending);
  try { return await pending; } finally { if (queues.get(root) === pending) queues.delete(root); }
}
