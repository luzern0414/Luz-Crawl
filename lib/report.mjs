import fs from 'node:fs/promises';
import path from 'node:path';
import { LEGACY_ARCHIVE_LAYOUT, archiveFile, atomicWrite, hash, legacyDeliveryRoot, verifyArchive } from './archive.mjs';
import { validateURL } from './platforms.mjs';
import { formalPage, formalTable, scopedFormalCSS, plainTitle } from './formal-html.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const href = value => { try { return escape(validateURL(value).href); } catch { return ''; } };
const fileLink = (output, file) => path.relative(output,file).split(path.sep).map(encodeURIComponent).join('/');
const marker = '\n<!-- LUZCRAWL_ARCHIVE_MEDIA -->\n';
export const reportStyles = scopedFormalCSS('.luz-report');

export async function readArchive(directory) {
  const folder = path.resolve(directory);
  const integrity = await verifyArchive(folder);
  if (!integrity.ok) throw new Error(`Archive verification failed: ${integrity.failures.join(', ')}`);
  const content = JSON.parse(await fs.readFile(await archiveFile(folder,'content.json'),'utf8'));
  if (!content.url_check?.valid_content || content.query) return null;
  let downloads = {files:[]};
  try { downloads = JSON.parse(await fs.readFile(await archiveFile(folder,'downloads.json'),'utf8')); }
  catch(error) { if(error.code !== 'ENOENT') throw error; }
  return {folder,content,downloads};
}

async function localMedia(folder, file) {
  const root = await fs.realpath(folder);
  const resolved = path.resolve(file.file);
  if (!resolved.startsWith(path.resolve(folder) + path.sep) || !(await fs.realpath(resolved)).startsWith(root + path.sep)) throw new Error('Report media escapes its source archive.');
  const bytes = await fs.readFile(resolved);
  if (hash(bytes) !== file.sha256) throw new Error('Report media checksum does not match.');
  return bytes;
}

export async function sourceMarkup({folder,content,downloads={files:[]}}, output, index=1, counter={ next: 1 }) {
  const post = content.post || {};
  const files = [...(downloads.files || []), ...(downloads.retained_parts || [])];
  const texts = [...new Set([post.text,...(content.items || []).filter(item => !['page_shell','comment','reply','thread_or_reply'].includes(item.kind)).map(item => item.text)].filter(value => value?.trim()))];
  const comments = content.comments?.length ? content.comments : (content.items || []).filter(item => ['comment','reply'].includes(item.kind));
  const images = post.images || (content.media || []).filter(item => item.kind === 'img');
  const pictures = [];
  for(const image of images) {
    const file = files.find(file => file.url === image.url && /^image\//.test(file.mime));
    const src = file ? `data:${file.mime};base64,${(await localMedia(folder,file)).toString('base64')}` : href(image.url);
    if(src) pictures.push(`<figure><img src="${src}" alt="${escape(image.alt)}" loading="lazy">${file ? `<figcaption><a href="${escape(fileLink(output,file.file))}" download>下载图片</a></figcaption>` : '<figcaption>图片未保存，当前使用来源地址</figcaption>'}</figure>`);
  }
  const videos = [];
  for(const file of files.filter(file => /^video\//.test(file.mime))) {
    await localMedia(folder,file);
    const link = escape(fileLink(output,file.file));
    videos.push(`<figure><video controls preload="none" playsinline src="${link}"></video><figcaption><a href="${link}" download>下载视频</a>，${Math.round(file.bytes/1024)} KiB</figcaption></figure>`);
  }
  const audios = post.audios || (content.media || []).filter(item => item.kind === 'audio');
  const sounds = [];
  for(const audio of audios) {
    const file = files.find(file => file.url === audio.url && /^audio\//.test(file.mime));
    const src = file ? escape(fileLink(output,file.file)) : href(audio.url);
    if(src) sounds.push(`<figure><audio controls preload="none" src="${src}"></audio><figcaption>${file ? `<a href="${src}" download>下载音频</a>` : '音频未保存，当前使用来源地址'}</figcaption></figure>`);
  }
  const metrics = Object.entries({likes:'赞',comments:'评',favorites:'藏',shares:'分享',views:'播放 / 浏览'}).flatMap(([key,label]) => post.engagement?.[key]?.value != null ? [`${label} ${escape(post.engagement[key].raw || post.engagement[key].value)}`] : []).join('，');
  const author = post.account?.name || (content.items || []).find(item => item.author)?.author || '';
  const accountURL = href(post.account?.profile_url);
  const source = href(content.resolved_url || content.requested_url);
  const status = content.status === 'captured' ? '已获取' : '本次已取得的内容';
  const body = texts.map(text => `<div class="body">${escape(text)}</div>`).join('');
  const info = [
    ['平台', { text: content.platform || '' }],
    ...(author ? [['账号', { html: accountURL ? `<a href="${accountURL}" target="_blank" rel="noopener noreferrer">${escape(author)}</a>` : escape(author) }]] : []),
    ...(metrics ? [['互动', { html: metrics }]] : []),
    ['读取范围', { text: status }],
    ...(source ? [['原文', { html: `<a href="${source}" target="_blank" rel="noopener noreferrer">${escape(plainTitle(post.title || content.title || '查看原文'))}</a>` }]] : []),
  ].filter(([, cell]) => cell.html || cell.text);
  const table = (caption, head, rows, centered, widths) => formalTable({ number: counter.next++, caption, head, rows, centered, widths });
  const name = plainTitle(post.title || content.title);
  // Tables are numbered in reading order, so build them in the order they appear.
  const infoTable = table(`${name}　来源信息`, ['项目', '内容'], info.map(([label, cell]) => [{ text: label, class: 'g' }, cell]), [], ['160px']);
  const replies = comments.length ? `<details open><summary>已加载评论 ${comments.length} 条</summary>${table(`${name}　已加载评论`, ['账号', '时间', '评论'], comments.map(comment => [{ text: comment.account?.name || comment.author || '' }, { text: comment.time || '' }, { html: `<span class="body">${escape(comment.text)}</span>` }]), [1], ['180px', '140px'])}</details>` : '';
  const transcript = (content.transcript || []).length ? `<details open><summary>已取得的字幕</summary>${table(`${name}　字幕`, ['时间', '字幕'], content.transcript.map(item => [{ text: item.time || '' }, { text: item.text || '' }]), [0], ['140px'])}</details>` : '';
  const limitations = content.limitations?.length ? table(`${name}　读取缺项`, ['缺项'], content.limitations.map(item => [{ text: item }])) : '';
  return `<section id="source-${index}" data-source-url="${source}"><h2>${escape(name)}</h2>${infoTable}${body}${pictures.length ? '<h3>图片</h3>'+pictures.join('') : ''}${videos.length ? '<h3>视频</h3>'+videos.join('') : post.videos?.length ? '<p>视频未下载成功，播放文件尚不可用。</p>' : ''}${sounds.length ? '<h3>音频</h3>'+sounds.join('') : audios.length ? '<p>音频未下载成功，播放文件尚不可用。</p>' : ''}${replies}${transcript}${limitations}</section>`;
}

export async function reportDocument(title, archives, output, runs=[]) {
  const sections=[], counter={ next: 1 };
  for(const [index,archive] of archives.entries()) sections.push(await sourceMarkup(archive,output,index+1,counter));
  const resultLabel = run => `${run.status}${run.task_id ? '，待手动验证 ' + run.task_id : ''}`;
  const table = runs.length ? `<section><h2>检索任务</h2>${formalTable({ number: counter.next++, caption: '检索任务', head: ['平台', '关键词或链接', '结果'], rows: runs.map(run => [{ text: run.platform || '链接' }, { text: run.query || run.url || '' }, { text: resultLabel(run) }]), centered: [0] })}</section>` : '';
  const empty = archives.length ? '' : '<section><h2>采集结果</h2><p>本次未取得可核验的目标正文，详情保存在任务目录的 raw/ 里。</p></section>';
  return formalPage({ title, body: `${sections.join('')}${empty}${table}`, csp: "default-src 'none'; img-src 'self' file: data: https: http:; media-src 'self' file: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
}

export async function appendMediaExport(folder, content, downloads, manifest) {
  const name = manifest.primary_file;
  if (!name?.endsWith('.html')) return null;
  if (path.basename(name) !== name) throw new Error('Export filename escapes archive.');
  // The readable HTML sits inside the archive; an older archive keeps it in its delivery folder (and, rarely, a copy inside).
  const external = manifest.output_layout === LEGACY_ARCHIVE_LAYOUT;
  const output = external ? await legacyDeliveryRoot(folder) : folder;
  const delivery = external ? path.join(output,name) : null;
  const file = external && manifest.delivery ? delivery : path.join(folder,name);
  const original = await fs.readFile(file,'utf8');
  let base = original;
  if(manifest.delivery_media) { const start=base.lastIndexOf(marker); if(start>=0) base=base.slice(0,start)+'</body></html>\n'; }
  for (const image of (downloads.files || []).filter(file => /^image\//.test(file.mime))) {
    const data = `data:${image.mime};base64,${(await localMedia(folder, image)).toString('base64')}`;
    for (const url of new Set([image.url, image.url.replaceAll('&', '&amp;')])) base = base.split(url).join(data);
  }
  const markup = await sourceMarkup({folder,content,downloads},output);
  const html = base.replace(/media-src https: http:/,"media-src 'self' file: data: https: http:").replace(/<\/body>\s*<\/html>\s*$/i,`${marker}<style>${reportStyles}</style><div class="luz-report">${markup}</div></body></html>\n`);
  let delivered;
  if(delivery && delivery !== file) delivered = await fs.readFile(delivery,'utf8');
  try { await atomicWrite(file,html); if(delivery && delivery !== file) await atomicWrite(delivery,html); }
  catch(error) { await atomicWrite(file,original); if(delivery && delivery !== file) await atomicWrite(delivery,delivered); throw error; }
  return {file:delivery || file,path:name,external:external && Boolean(manifest.delivery),bytes:Buffer.byteLength(html),sha256:hash(html),images:(downloads.files || []).filter(file=>/^image\//.test(file.mime)).length,videos:(downloads.files || []).filter(file=>/^video\//.test(file.mime)).length,audios:(downloads.files || []).filter(file=>/^audio\//.test(file.mime)).length};
}
