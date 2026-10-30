// This function is serialized into the real browser page. Keep it free of module dependencies.
export function extractPage({ platform, requestedURL, comments = false, includePresentation = true, articleMedia = {}, observedVideos = [], isSearch = false }) {
  const first = (selectors, parent = document) => selectors.map((selector) => parent?.querySelector(selector)).find(Boolean);
  const visible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const text = (element) => {
    if (!element || getComputedStyle(element).visibility === 'hidden') return '';
    if (!element.getClientRects().length) {
      const range = document.createRange(); range.selectNodeContents(element);
      if (!range.getClientRects().length) return '';
    }
    return (typeof element.innerText === 'string' ? element.innerText : element.textContent || '').trim();
  };
  const selectors = {
    x: ['[data-testid="primaryColumn"]', 'main'],
    xhs: ['.note-container', '#noteContainer', '.note-detail-mask', 'main'],
    wechat: ['#js_article', '#img-content'],
    douyin: ['[data-e2e="video-detail"]', '[data-e2e="feed-active-video"]', 'main', '[data-e2e="detail-video-info"]'],
    youtube: ['ytd-watch-flexy', 'ytd-search', 'main'],
    bilibili: ['.video-page-v3', '#app', 'main'],
    tiktok: ['[data-e2e="browse-video"]', '[data-e2e="browse-video-desc"]', 'main'],
    reddit: ['main', '.content', 'shreddit-post', '#siteTable'],
    zhihu: ['.AnswerCard', '.Post-Main', '.Question-mainColumn', 'main'],
    douban: ['#content', '.article'],
    github: ['main', 'article.markdown-body', '.markdown-body'],
    csdn: ['main', '#article_content', '#content_views'],
    cnblogs: ['#cnblogs_post_body', '#mainContent'],
    juejin: ['.article-content', 'main'],
    stackoverflow: ['#question', '#answers', 'main'],
    web: ['article', 'main', '[role="main"]'],
  };
  const body = text(document.body);
  const primary = (selectors[platform] || selectors.web).flatMap(selector => [...document.querySelectorAll(selector)]).find(node => text(node)) || document.body || document.documentElement;
  // Portal cards can use <article>; keep a small first card from hiding the result list.
  const root = (platform === 'web' || !selectors[platform]) && (isSearch || text(primary).length < body.length / 2) ? document.body || primary : primary;
  const content = text(root);
  const pageURL = location.href;
  const wantedID = requestedURL.match(/\/status\/(\d+)/)?.[1];
  let loadedTarget, playerData;
  if (!isSearch && platform === 'bilibili') {
    const id = requestedURL.match(/\/video\/(BV[a-zA-Z0-9]{10}|av\d+)/)?.[1];
    const video = window.__INITIAL_STATE__?.videoData;
    if (id && video && (video.bvid === id || `av${video.aid}` === id)) { loadedTarget = video; playerData = window.__playinfo__?.data; }
  }
  if (!isSearch && platform === 'xhs') {
    const id = requestedURL.match(/\/(?:explore|discovery\/item|search_result)\/([^/?#]+)/)?.[1];
    const note = id && window.__INITIAL_STATE__?.note?.noteDetailMap?.[id]?.note;
    if (note && (note.noteId || note.id) === id) loadedTarget = note;
  }
  if (!isSearch && platform === 'tiktok') {
    try {
      const data = JSON.parse(document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent || '{}');
      const video = data.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
      if (video?.id && video.id === requestedURL.match(/\/(?:video|photo)\/(\d+)/)?.[1]) loadedTarget = video;
    } catch {}
  }
  const items = [];
  const tweetArticles = platform === 'x' ? root.querySelectorAll('article[data-testid="tweet"], article:has([data-engagement-action])') : [];
  const tweetURL = article => article.querySelector('time')?.closest('a')?.href || [...article.querySelectorAll('a[href*="/status/"]')].filter(link => link.closest('article') === article && !link.closest('[data-article-part], .x-article-body, [dir="auto"]')).map(link => link.href).find(href => /\/status\/\d+$/.test(href));
  let targetArticle;
  let longformContainer;
  let bodyRoot;
  let articleTitle = '';
  let bodyConfirmed = Boolean(content || [...root.querySelectorAll('img,video,audio')].some(visible));
  if (platform === 'x') {
    for (const article of tweetArticles) {
      const time = article.querySelector('time');
      const permalink = tweetURL(article);
      const id = permalink?.match(/\/status\/(\d+)/)?.[1];
      if (!id) continue;
      if (id === wantedID) targetArticle = article;
      const value = text(article.querySelector('[data-testid="tweetText"], [dir="auto"].text-lead'));
      items.push({ id, url: permalink, author: permalink.match(/x\.com\/([^/]+)/)?.[1] || text(article.querySelector('[data-testid="User-Name"]')), time: time?.dateTime || '', text: value,
        kind: id === wantedID ? 'target_post' : 'thread_or_reply', truncated: Boolean(article.querySelector('[data-testid="tweet-text-show-more-link"]')), metrics_text: text(article.querySelector('[role="group"]')) });
    }
    longformContainer = root.querySelector('[data-testid="twitterArticleReadView"]') || targetArticle?.querySelector('[data-article-part="body"]')?.parentElement;
    articleTitle = text(root.querySelector('[data-testid="twitter-article-title"]') || longformContainer?.querySelector('[data-article-part="title"]'));
    const longform = first(['[data-testid="twitterArticleRichTextView"]', '[data-testid="longformRichTextComponent"]', '[data-article-part="body"]'], longformContainer || root) || (longformContainer && (longformContainer.querySelector('.DraftEditor-root') || longformContainer));
    bodyRoot = longform;
    const articleSourceID = [...(longformContainer?.querySelectorAll('a[href*="/status/"]') || [])].map((link) => link.href.match(/\/status\/(\d+)/)?.[1]).find((id) => id === wantedID);
    if (longform && text(longform)) items.unshift({ id: `article:${pageURL}`, url: pageURL, kind: 'article', text: text(longform), title: articleTitle, source_status_id: articleSourceID || (targetArticle ? wantedID : undefined), author: text(root.querySelector('[data-testid="User-Name"]')) || items.find(item => item.id === wantedID)?.author });
    if (/\/i\/article\//.test(pageURL) && !longform && root.querySelector('article:not([data-testid="tweet"])')) items.unshift({ id: `article:${pageURL}`, url: pageURL, kind: 'article', text: text(root.querySelector('article:not([data-testid="tweet"])')) });
  } else {
    const bodySelectors = {
      xhs: ['#detail-desc', '.note-text', '.desc'], wechat: ['#js_content'],
      youtube: ['#description-inline-expander', 'ytd-text-inline-expander', '#description'],
      bilibili: ['#v_desc .basic-desc-info', '.basic-desc-info', '.desc-info-text', '.video-desc'],
      tiktok: ['[data-e2e="browse-video-desc"]', '[data-e2e="video-desc"]'],
      reddit: ['[slot="text-body"]', '[data-post-click-location="text-body"]', '.usertext-body'],
      zhihu: ['.RichContent-inner .RichText', '.Post-RichText', '.RichText'],
      douban: ['.topic-content', '#link-report', '.review-content', '.article'],
      douyin: ['[data-e2e="video-desc"]', '[data-e2e="detail-video-info"]', 'h1'],
      web: ['article', 'main', '[role="main"]'],
      github: ['article.markdown-body', '.markdown-body', '.react-code-lines', 'pre'],
      csdn: ['#article_content', '#content_views'],
      cnblogs: ['#cnblogs_post_body'],
      juejin: ['.article-content'],
      stackoverflow: ['.js-post-body', '.s-prose'],
    };
    const postContext = platform === 'reddit' && !isSearch ? root.querySelector('shreddit-post, .thing.link') || root : root;
    const article = (bodySelectors[platform] || bodySelectors.web).flatMap(selector => [...postContext.querySelectorAll(selector)]).find(node => text(node) || visible(node)) || (platform === 'reddit' ? first(['[slot="title"]', '.top-matter .title'], postContext) || postContext : root);
    bodyRoot = article;
    const expectedDetail = !isSearch && (platform === 'xhs' && /\/(explore|discovery\/item|search_result)\/[^/?]+/.test(requestedURL) || platform === 'wechat' && /mp\.weixin\.qq\.com\/s(?:[/?]|$)/.test(pageURL) || platform === 'youtube' && /watch\?v=|youtu\.be\//.test(requestedURL) || platform === 'zhihu' && /\/answer\/|zhuanlan\.zhihu\.com\/p\//.test(requestedURL));
    if (expectedDetail) bodyConfirmed = article !== root || (platform === 'wechat' && article.id === 'js_content');
    if (!isSearch && platform === 'bilibili' && /\/video\//.test(requestedURL)) bodyConfirmed = Boolean(loadedTarget && root.querySelector('h1.video-title') && root.querySelector('video, #bilibili-player, .bpx-player-container'));
    if (!isSearch && platform === 'tiktok' && /\/(?:video|photo)\//.test(requestedURL)) bodyConfirmed = Boolean(loadedTarget && (document.querySelector('video') || loadedTarget.imagePost));
    if (platform === 'reddit' && !isSearch) {
      const id = requestedURL.match(/\/comments\/([^/]+)/)?.[1];
      bodyConfirmed = postContext.matches('shreddit-post, .thing.link') && (!id || [postContext.id.replace(/^thing_/, ''), postContext.getAttribute('data-fullname')].includes(`t3_${id}`) || postContext.getAttribute('permalink')?.includes(`/comments/${id}/`));
    }
    const value = platform === 'bilibili' && loadedTarget ? [text(root.querySelector('h1.video-title')), text(article)].filter(value => value && value !== '-').join('\n\n') : platform === 'tiktok' && loadedTarget ? loadedTarget.desc || text(article) : text(article);
    if (value) items.push({ id: pageURL, url: pageURL, kind: !bodyConfirmed ? 'page_shell' : ['youtube', 'douyin', 'bilibili', 'tiktok'].includes(platform) ? 'video_description' : 'page_body', text: value,
      author: document.querySelector('meta[name="author"]')?.content || text(first(['#js_name', '.author .username', '[slot="authorName"]', '#channel-name'])),
      time: root.querySelector('time')?.dateTime || document.querySelector('meta[property="article:published_time"]')?.content || '' });
    if (comments) {
      const commentSelectors = { xhs: '.comment-item', reddit: 'shreddit-comment', youtube: 'ytd-comment-thread-renderer', zhihu: '.CommentItem, [class*="CommentItem"]', douban: '.comment-item, .reply-item, .topic-reply', douyin: '[data-e2e="comment-item"]', weibo: '[class*="CommentItem"], .list_li', github: '.timeline-comment', stackoverflow: '.comment' };
      if (commentSelectors[platform]) for (const item of root.querySelectorAll(commentSelectors[platform])) {
        if (visible(item) && text(item)) items.push({ id: item.id || item.getAttribute('thingid') || `comment:${text(item)}`, kind: 'comment', text: text(item), url: pageURL });
      }
    }
  }
  const transcript = [...document.querySelectorAll('ytd-transcript-segment-renderer')].map((item) => ({ time: text(item.querySelector('.segment-timestamp')), text: text(item.querySelector('.segment-text')) })).filter((item) => item.text);
  const sourceRoot = platform === 'x' && wantedID ? (longformContainer || targetArticle) : root;
  let presentation;
  if (includePresentation && sourceRoot && (platform !== 'x' || longformContainer || targetArticle)) {
    const styled = sourceRoot.cloneNode(true);
    const properties = ('display position top right bottom left z-index box-sizing width height min-width max-width min-height max-height margin-top margin-right margin-bottom margin-left padding-top padding-right padding-bottom padding-left border-top border-right border-bottom border-left border-radius overflow overflow-x overflow-y flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-self justify-content gap row-gap column-gap grid-template-columns grid-column grid-row font-family font-size font-weight font-style line-height letter-spacing text-align text-decoration text-transform text-indent white-space word-break overflow-wrap color background-color background-image background-size background-position background-repeat opacity object-fit object-position vertical-align list-style-type list-style-position list-style-image border-collapse border-spacing table-layout transform').split(' ');
    const css = (style) => properties.map((key) => `${key}:${style.getPropertyValue(key)}`).join(';');
    const assets = new Map();
    const pseudoCSS = [];
    const originalNodes = [sourceRoot, ...sourceRoot.querySelectorAll('*')];
    const cloneNodes = [styled, ...styled.querySelectorAll('*')];
    for (let index = 0; index < originalNodes.length; index++) {
      const source = originalNodes[index], clone = cloneNodes[index];
      clone.setAttribute('style', css(getComputedStyle(source)));
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(source, pseudo);
        if (style.content && !['none', 'normal', '""'].includes(style.content)) {
          clone.setAttribute('data-luz-node', String(index));
          pseudoCSS.push(`[data-luz-node="${index}"]${pseudo}{content:${style.content};${css(style)}}`);
        }
      }
      for (const key of ['href', 'src', 'poster']) if (source.hasAttribute(key)) {
        const value = source[key]?.baseVal || source[key];
        if (typeof value === 'string' && /^https?:\/\//.test(value)) clone.setAttribute(key, value);
        else if (!(source.tagName === 'IMG' && /^data:image\//.test(value))) clone.removeAttribute(key);
      }
      clone.removeAttribute('srcset'); clone.removeAttribute('loading');
      if (source.tagName === 'IMG' && /^https?:\/\//.test(source.currentSrc || source.src)) {
        clone.setAttribute('src', source.currentSrc || source.src);
        assets.set(source.currentSrc || source.src, { kind: 'image', url: source.currentSrc || source.src });
      }
      for (const match of getComputedStyle(source).backgroundImage.matchAll(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g)) assets.set(match[1], { kind: 'image', url: match[1] });
    }
    // The page's own Article response contains media URLs even while its DOM has image placeholders.
    for (const link of styled.querySelectorAll('a[href*="/article/"][href*="/media/"]')) {
      const id = link.href.match(/\/media\/(\d+)/)?.[1];
      const asset = articleMedia[id];
      if (!asset || !/^https:\/\/pbs\.twimg\.com\//.test(asset.url) || link.querySelector('img[src],video,source')) continue;
      const image = document.createElement('img'); image.src = asset.url; image.alt = asset.alt || 'Image';
      image.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block');
      link.style.position = 'relative'; link.appendChild(image);
      assets.set(asset.url, { kind: 'image', url: asset.url });
    }
    for (const item of styled.querySelectorAll('script, style, noscript, iframe, object, embed, form, input, textarea, select, button, meta, link, base, foreignObject, animate, set')) item.remove();
    if (longformContainer) for (const group of styled.querySelectorAll('[role="group"]')) {
      if (!group.closest('[data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"]')) group.remove();
    }
    for (const item of [styled, ...styled.querySelectorAll('*')]) {
      for (const attribute of [...item.attributes]) if (/^on/i.test(attribute.name) || /^(value|srcdoc|nonce|autofocus|contenteditable|autoplay)$/i.test(attribute.name) || (/^(href|src|poster|xlink:href)$/i.test(attribute.name) && !/^(https?:\/\/|data:image\/|#)/i.test(attribute.value))) item.removeAttribute(attribute.name);
      if (item.tagName === 'A') { item.setAttribute('target', '_blank'); item.setAttribute('rel', 'noopener noreferrer'); }
    }
    const fonts = [];
    const fontRules = (rules) => { for (const rule of rules) { if (rule.type === CSSRule.FONT_FACE_RULE) fonts.push(rule.cssText); else if (rule.cssRules) fontRules(rule.cssRules); } };
    for (const sheet of document.styleSheets) { try { fontRules(sheet.cssRules); } catch {} }
    for (const rule of fonts) for (const match of rule.matchAll(/url\(["']?(https?:\/\/[^"')]+)["']?\)/g)) assets.set(match[1], { kind: 'font', url: match[1] });
    let background = 'rgb(255, 255, 255)';
    for (let element = sourceRoot; element; element = element.parentElement) {
      const color = getComputedStyle(element).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') { background = color; break; }
    }
    const viewerLinks = [...sourceRoot.querySelectorAll('a[href*="/article/"][href*="/media/"]')];
    presentation = { kind: longformContainer ? 'x_article' : 'rendered_dom', html: styled.outerHTML, styles: pseudoCSS.join('\n'), fonts, assets: [...assets.values()], width: Math.round(sourceRoot.getBoundingClientRect().width), background, color: getComputedStyle(sourceRoot).color, lang: document.documentElement.lang,
      text_chars: text(bodyRoot || sourceRoot).length, media_pending: viewerLinks.filter((link) => !link.querySelector('img[src],video[src],source[src]') && !articleMedia[link.href.match(/\/media\/(\d+)/)?.[1]]).length,
      ready: Boolean(longformContainer && text(bodyRoot).length && items.some((item) => item.kind === 'article' && (!wantedID || item.source_status_id === wantedID)) && !bodyRoot.querySelector('[aria-busy="true"], [role="progressbar"]') && !root.querySelector('[data-testid="tweet-text-show-more-link"]')) };
  }
  const media = [...(sourceRoot?.querySelectorAll('img, video, audio, source') || [])].map((item) => ({ kind: item.tagName.toLowerCase(), url: item.currentSrc || item.src || item.getAttribute('data-src') || '', alt: item.alt || '', poster: item.poster || '', viewer_url: item.closest('a[href*="/article/"][href*="/media/"]')?.href || '', loaded: item.tagName === 'IMG' ? item.complete && item.naturalWidth > 0 : item.readyState > 1 })).filter((item) => /^https?:\/\//.test(item.url));
  const links = [...(sourceRoot?.querySelectorAll('a[href]') || [])].map((item) => ({ url: item.href, text: text(item) }))
    .concat([...(sourceRoot?.querySelectorAll('[onclick],[data-href],[data-url],[data-link],[lay-href]') || [])].flatMap((node) => {
      // 结果行用点击事件或 data 属性跳转时，从属性中解析地址
      if (node.matches('a[href]') && /^https?:/.test(node.href)) return [];
      let raw = node.getAttribute('data-href') || node.getAttribute('data-url') || node.getAttribute('data-link') || node.getAttribute('lay-href') || '';
      if (!raw) {
        const match = (node.getAttribute('onclick') || '').match(/["']((?:https?:)?\/\/[^"'\s]+|\/[^"'\s]+|[\w.\/-]+\.(?:s?html?|jsp|aspx?|php|do)(?:\?[^"'\s]*)?)["']/);
        raw = match ? match[1] : '';
      }
      if (!raw || /^javascript:/i.test(raw)) return [];
      try { return [{ url: new URL(raw, location.href).href, text: text(node) }]; } catch { return []; }
    }))
    .filter((item) => /^https?:\/\//.test(item.url));
  if (platform === 'x') for (const link of links.filter((item) => /\/article\/\d+\/media\/\d+/.test(item.url))) {
    media.push({ kind: 'media_viewer', url: link.url, loaded: false, alt: '', note: 'Media viewer link observed; binary media URL not present in rendered DOM.' });
    const asset = articleMedia[link.url.match(/\/media\/(\d+)/)?.[1]];
    if (asset) media.push({ kind: 'img', url: asset.url, viewer_url: link.url, alt: asset.alt || '', loaded: false, source: 'observed_article_response' });
  }
  const articleLinks = platform === 'x' && wantedID ? links.filter((item) => /https:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+/.test(item.url)).map((item) => item.url) : [];
  const puzzlePrompt = [...document.querySelectorAll('div, span, p')].some(node => visible(node) && !node.closest('article') && /^(?:拖动下方拼图完成验证|请拖动滑块完成验证|请完成下方验证|为保证您的正常访问[,，]请进行如下验证)[。！!]*$/.test((node.innerText || '').replace(/\s+/g, '')));
  const gateDialog = [...document.querySelectorAll('[role="dialog"], .login-container, .login-modal, [class*="loginModal"], [class*="LoginModal"]')].filter(visible).map(text).join('\n');
  // A visible player on a video platform means the content loaded; a login prompt beside it is not a gate.
  const playableVideo = ['douyin', 'bilibili', 'tiktok', 'youtube'].includes(platform) && [...document.querySelectorAll('video')].some((node) => node.getClientRects().length > 0);
  let gate = null;
  if (platform === 'xhs' && /请打开小红书App扫码查看/i.test(body)) gate = 'verification_required';
  else if ((/\/(?:404|notfound|error)(?:\.\w+)?\/?$/i.test(location.pathname) && content.length < 1500) || /^(?:404|410)(?:页面|\s*[-:|]?\s*(?:page|not found|error))|你访问的页面不见了|页面不存在|page not found/i.test(document.title)) gate = 'unavailable';
  else if (puzzlePrompt || [...document.querySelectorAll('iframe[src*="captcha"], iframe[src*="challenge"], #challenge-running, .geetest_panel')].some(visible) || /^(验证|访问验证|安全验证|安全检查|Just a moment|Human verification)/i.test(document.title) || /\/nocaptcha(?:[/?]|$)/i.test(location.pathname) || (content.length < 2000 && !root.closest('article') && !root.querySelector('article') && /完成验证|拖动滑块|请进行安全验证|verify you are human|checking your browser/i.test(content))) gate = 'verification_required';
  // Login pages are recognised by path only (or a #/login hash route); a gate dialog or login text counts only
  // while the body has not loaded (500+ characters) and no video is playing.
  else if (/(?:\/(?:i\/flow\/login|login|signin|passport)(?:\.\w+)?\/?|^\/passport\/.*)$/i.test(location.pathname) || /^#\/?(?:login|signin)\b/i.test(location.hash) || (platform === 'x' && location.pathname === '/i/jf/onboarding/web' && new URLSearchParams(location.search).get('mode') === 'login')) gate = 'login_required';
  else if (gateDialog && /登录|登入|sign in|log in/i.test(gateDialog) && !(bodyRoot !== root && text(bodyRoot).length > 500) && !playableVideo) gate = 'login_required';
  else if ([...document.querySelectorAll('input[type="password"]')].some(visible) && !document.querySelector('article') && content.length < 3000) gate = 'login_required';
  else if (content.length < 1800 && /请(?:先)?登录后|登录后(?:查看|使用|访问)|扫码(?:即可)?登录|sign in to continue|log in to continue/i.test(content) && !(bodyRoot !== root && text(bodyRoot).length > 500) && !playableVideo) gate = 'login_required';
  else if (content.length < 1500 && /rate limit exceeded|too many requests|操作频繁|访问过于频繁|请求过于频繁/i.test(content)) gate = 'rate_limited';
  else if (content.length < 4000 && /access denied|403 forbidden|^403 ERROR|HTTP ERROR\s*403|request rejected|拒绝访问|请求遭到拒绝|禁止访问|you(?:'ve| have) been blocked|blocked your request|request blocked/i.test(document.title + '\n' + content)) gate = 'access_denied';
  else if (content.length < 1500 && /^(?:502 Bad Gateway|503 Service (?:Unavailable|Temporarily Unavailable)|504 Gateway (?:Timeout|Time-out))(?:\s|$)/i.test(document.title)) gate = 'transient_failure';
  else if (content.length < 1000 && /this post was deleted|this post is unavailable|帖子已删除|内容已删除|笔记不存在|内容不存在|该内容无法查看|account suspended|this account doesn.t exist|page not found/i.test(content)) gate = 'unavailable';
  const cooldownText = gate === 'rate_limited' ? content.split('\n').map(value => value.trim()).find(value => /rate limit exceeded|too many requests|操作频繁|访问过于频繁|请求过于频繁/i.test(value))?.slice(0, 400) || content.slice(0, 400) : undefined;
  const metric = (node) => {
    const label = node?.getAttribute('aria-label') || '';
    const raw = (/\d/.test(label) ? label : text(node) || label).trim();
    const match = raw.match(/(-?[\d,]+(?:\.\d+)?)\s*(万|亿|[kmb](?![a-z]))?/i);
    const units = { 万: 1e4, 亿: 1e8, k: 1e3, m: 1e6, b: 1e9 };
    return { value: match ? Number(match[1].replaceAll(',', '')) * (units[(match[2] || '').toLowerCase()] || 1) : null, raw, approximate: Boolean(match?.[2]) };
  };
  const account = (node, fallback = '') => {
    const names = { x: ['[data-testid="User-Name"] a span'], xhs: ['.author-wrapper .name', '.author .name', '.author .username', '.author-container .username', '.user-name'], zhihu: ['.AuthorInfo-name .UserLink-link', '.AuthorInfo-name', '.UserLink-link', 'a[href*="/people/"]:not(:has(img))'], douban: ['.note-author a', '.topic-doc h3 a', '.from a', '.user-name a', 'h4 a', '.pubdate a'], youtube: ['#channel-name a', '#author-text'], reddit: ['[slot="authorName"]', '[data-testid="comment_author_link"]', 'a.author', 'a[href*="/user/"]:not(:has(img))'], douyin: ['[data-e2e="detail-user-name"]', '[data-e2e="user-title"]', '.user-name', 'a[href*="/user/"]:not([href*="/user/self"]):not(:has(img))'], weibo: ['a[class*="head_name"]', 'a[class*="Head_name"]', '.name'] };
    const authorHandle = platform === 'x' && /^[a-z\d_]+$/i.test(fallback) ? fallback : '';
    const element = first(names[platform] || ['[rel="author"]'], node) || (authorHandle ? node?.closest('article')?.querySelector(`a[href="/${authorHandle}"]:not(:has(img))`) : null);
    const link = element?.closest('a') || element?.querySelector('a');
    const fallbackHandle = fallback.match(/@([a-z\d_]+)/i)?.[1] || (/^[a-z\d_]+$/i.test(fallback) ? fallback : '');
    const handle = platform === 'x' ? link?.href?.match(/(?:x|twitter)\.com\/([^/?#]+)/)?.[1] || fallbackHandle : (platform === 'youtube' ? link?.href?.match(/\/@([^/?#]+)/)?.[1] : '') || link?.href?.match(/\/(?:user\/profile|people|u|channel|user)\/([^/?#]+)/)?.[1] || '';
    const nameElement = platform === 'douyin' ? element?.querySelector('[data-click-from="title"] > span') || element : element;
    return { name: text(nameElement).split('\n')[0] || String(fallback).split('\n')[0] || null, handle: handle || null, profile_url: link?.href && /^https?:\/\//.test(link.href) ? link.href : platform === 'x' && handle ? `https://x.com/${handle}` : null };
  };
  const engagementSelectors = {
    x: { likes: ['[data-testid="like"]', '[data-testid="unlike"]'], comments: ['[data-testid="reply"]'], favorites: ['[data-testid="bookmark"]', '[data-testid="removeBookmark"]'], shares: ['[data-testid="retweet"]', '[data-testid="unretweet"]'], views: ['a[href*="/analytics"]'] },
    xhs: { likes: ['.interact-container .like-wrapper .count', '.interact-container .like-container .count', '.like-wrapper .count'], favorites: ['.collect-wrapper .count', '.collect-container .count'], comments: ['.chat-wrapper .count', '.comment-wrapper .count'] },
    zhihu: { likes: ['.VoteButton--up', 'button.VoteButton:not(.VoteButton--down)'], comments: ['button[aria-label*="评论"]', '.ContentItem-action'], favorites: ['button[aria-label*="收藏"]'] },
    douban: { likes: ['.like-num', '.react-like .count', '.react-like', '.action-react-like'], favorites: ['.fav-num'], comments: ['.comments-count', '#comments .pl', '.topic-reply-count'] },
    youtube: { likes: ['ytd-segmented-like-dislike-button-renderer button[aria-label]', 'like-button-view-model button'], comments: ['ytd-comments-header-renderer #count'], views: ['#info-text'] },
    reddit: { likes: ['[score]', '.thing.link .score.unvoted'], comments: ['[comment-count]', '.thing.link .comments'] },
    douyin: { likes: ['[data-e2e="video-player-digg"]'], comments: ['[data-e2e="video-player-comment"]', '[data-e2e="feed-comment-icon"]'], favorites: ['[data-e2e="video-player-collect"]'], shares: ['[data-e2e="video-player-share"]'] },
    weibo: { likes: ['button[title*="赞"]', '[class*="woo-like-count"]'], comments: ['[aria-label*="评论"]'], shares: ['[aria-label*="转发"]'] },
  };
  const postRoot = platform === 'x' ? longformContainer?.matches('[data-testid="twitterArticleReadView"]') ? longformContainer : targetArticle || longformContainer : root;
  const bodyItem = items.find((item) => item.kind === 'article' || item.id === wantedID || item.kind === 'page_body' || item.kind === 'video_description') || (bodyConfirmed && ['xhs', 'youtube', 'douyin'].includes(platform) ? { text: '' } : null);
  let post = null;
  const extractedComments = [];
  if (!isSearch && postRoot && bodyConfirmed && bodyItem && !gate) {
    const mediaRoot = platform === 'youtube' ? postRoot.querySelector('#player') || bodyRoot : platform === 'reddit' ? postRoot.querySelector('shreddit-post, .thing.link') || bodyRoot : ['douyin', 'zhihu', 'douban', 'wechat', 'csdn', 'github', 'cnblogs', 'juejin', 'stackoverflow'].includes(platform) ? bodyRoot : postRoot;
    let imageSources;
    if (platform === 'bilibili' && loadedTarget) imageSources = [{ url: loadedTarget.pic, alt: loadedTarget.title, source: 'observed_video_cover' }];
    if (platform === 'xhs' && loadedTarget?.imageList?.length) imageSources = loadedTarget.imageList.map(image => ({url:image.urlDefault || image.urlPre,alt:loadedTarget.title,source:'observed_target_page_data'}));
    if (platform === 'tiktok' && loadedTarget) imageSources = loadedTarget.imagePost?.images?.map(image => ({url:image.imageURL?.urlList?.[0] || '',alt:loadedTarget.desc})) || [{url:loadedTarget.video?.cover || loadedTarget.video?.originCover || '',alt:loadedTarget.desc,source:'observed_video_cover'}];
    const images = (imageSources || (platform === 'youtube' ? [{ url: document.querySelector('meta[property="og:image"]')?.content || '', alt: document.title, source: 'observed_video_cover' }] : [...mediaRoot.querySelectorAll('img')].filter((node) => !node.closest('[data-testid*="UserAvatar"], [slot="credit-bar"], .x-avatar, .avatar, .author, .comment-item, .comments-list, .topic-reply, .reply-item')).map((node) => ({ url: node.currentSrc || node.src || node.dataset.src || '', alt: node.alt || '' })))).filter((item) => /^https?:\/\//.test(item.url || '') && !(platform === 'xhs' && /^https?:\/\/sns-avatar[^/]*\.xhscdn\.com\/avatar\//.test(item.url)) && !(platform === 'douban' && /^https?:\/\/[^/]*doubanio\.com\/icon\/up/.test(item.url))).map(item => ({...item,url:/^http:\/\/[^/]+\.xhscdn\.com\//.test(item.url) ? item.url.replace(/^http:/,'https:') : item.url}));
    for (const item of Object.values(articleMedia)) if (!images.some((image) => image.url === item.url)) images.push({ url: item.url, alt: item.alt || '', source: 'observed_article_response' });
    if (platform === 'x') {
      const identity = url => url.match(/^https?:\/\/pbs\.twimg\.com\/media\/([a-z\d_-]+)(?:[.?]|$)/i)?.[1] || url;
      const unique = new Map();
      for (const image of images) if (!unique.has(identity(image.url))) unique.set(identity(image.url), image);
      images.splice(0, images.length, ...unique.values());
      const order = new Map();
      for (const node of (sourceRoot || postRoot).querySelectorAll('img, a[href*="/article/"][href*="/media/"]')) {
        const url = node.tagName === 'IMG' ? node.currentSrc || node.src : articleMedia[node.href.match(/\/media\/(\d+)/)?.[1]]?.url;
        if (url && !order.has(identity(url))) order.set(identity(url), order.size);
      }
      images.sort((left, right) => (order.get(identity(left.url)) ?? Number.MAX_SAFE_INTEGER) - (order.get(identity(right.url)) ?? Number.MAX_SAFE_INTEGER));
    }
    const videos = [...(platform === 'douyin' ? postRoot : mediaRoot).querySelectorAll('video')].map((node) => ({ url: node.currentSrc || node.src || node.querySelector('source')?.src || '', poster: node.poster || '', direct: /^https?:\/\//.test(node.currentSrc || node.src || node.querySelector('source')?.src || '') })).filter(item => /^(https?:\/\/|blob:)/.test(item.url));
    const audios = [...mediaRoot.querySelectorAll('audio, audio source')].map((node) => ({ url: node.currentSrc || node.src || node.getAttribute('src') || '', mime: node.type || node.getAttribute('type') || '' })).filter(item => /^https?:\/\//.test(item.url));
    let targetVideo;
    if (platform === 'bilibili' && playerData?.dash && !playerData.is_drm) {
      const dash = playerData.dash;
      const video = (dash.video || []).filter(item => item.codecid === 7 && item.height <= 720).sort((a,b) => b.height - a.height)[0];
      const audio = (dash.audio || []).find(item => /mp4a/.test(item.codecs || ''));
      // The primary address can be a peer CDN; use an official fallback already supplied by this player.
      const streamURL = item => [item?.baseUrl, item?.base_url, ...(item?.backupUrl || item?.backup_url || [])].find(url => /^https:\/\/[^/]+\.bilivideo\.com\//.test(url || ''));
      const url = streamURL(video);
      const audioURL = streamURL(audio);
      if (/^https:\/\/[^/]+\.bilivideo\.com\//.test(url || '') && /^https:\/\/[^/]+\.bilivideo\.com\//.test(audioURL || '')) targetVideo = {url,audio_url:audioURL,mime:'video/mp4',height:video.height,source:'observed_target_player_streams'};
    }
    if (platform === 'xhs' && loadedTarget?.video?.media?.video?.drmType === 0) {
      const stream = loadedTarget.video.media.stream;
      const video = [...(stream?.h264 || []), ...(stream?.EF4 || [])].filter(item => item.format === 'mp4').sort((a,b) => b.height - a.height)[0];
      const url = video?.masterUrl;
      if (/^https?:\/\/[^/]+\.xhscdn\.com\//.test(url || '')) targetVideo = {url:url.replace(/^http:/,'https:'),height:video.height,source:'observed_target_player_streams'};
    }
    if (platform === 'tiktok' && loadedTarget?.video) {
      const url = loadedTarget.video.PlayAddrStruct?.UrlList?.[0] || loadedTarget.video.playAddr;
      if (/^https:\/\/[^/]+\.(?:tiktok\.com|tiktokcdn\.com)\//.test(url || '')) targetVideo = {url,height:loadedTarget.video.height,source:'observed_target_player_streams'};
    }
    if (targetVideo) videos.splice(0, videos.length, {...targetVideo,direct:true});
    for (const video of videos) if (/^https?:\/\//.test(video.poster) && !images.some(image => image.url === video.poster)) images.push({url:video.poster,alt:'',source:'observed_video_cover'});
    for (const item of observedVideos) if (!videos.some((video) => video.url === item.url)) videos.push({ ...item, direct: true });
    const engagement = Object.fromEntries(['likes', 'comments', 'favorites', 'shares', 'views'].map((key) => {
      const action = {likes:'like',comments:'reply',favorites:'bookmark',shares:'retweet'}[key];
      const element = first(engagementSelectors[platform]?.[key] || [], postRoot) || (platform === 'x' && (action ? postRoot.querySelector(`[data-engagement-action="${action}"]`) : [...postRoot.querySelectorAll('a[href*="/status/"]')].find(link => !link.closest('[data-article-part]') && /浏览量|\bviews\b/i.test(text(link))))) || null;
      if (platform === 'zhihu' && key === 'comments') {
        const count = text(postRoot.querySelector('.Comments-container')).match(/[\d,.万亿]+\s*条评论/)?.[0];
        if (count) return [key, metric({ getAttribute: () => count })];
      }
      if (key === 'likes' && element?.hasAttribute('score')) return [key, metric({ getAttribute: () => element.getAttribute('score') })];
      if (key === 'comments' && element?.hasAttribute('comment-count')) return [key, metric({ getAttribute: () => element.getAttribute('comment-count') })];
      return [key, metric(element)];
    }));
    post = { id: wantedID || pageURL.match(/\/(?:explore|search_result|answer|video|topic|note)\/([^/?#]+)/)?.[1] || pageURL, url: pageURL, title: articleTitle || document.title, text: bodyItem.text, account: account(postRoot, bodyItem.author || ''), engagement, images, videos, audios, content_present: Boolean(bodyItem.text?.trim() || images.length || videos.length || audios.length), scope: videos.length || audios.length ? 'visible_post_and_media_metadata' : 'visible_post' };
    if (platform === 'bilibili' && loadedTarget) post.account = {name:loadedTarget.owner?.name || post.account.name,handle:String(loadedTarget.owner?.mid || '') || null,profile_url:loadedTarget.owner?.mid ? `https://space.bilibili.com/${loadedTarget.owner.mid}` : null};
    if (platform === 'tiktok' && loadedTarget) post.account = {name:loadedTarget.author?.nickname || null,handle:loadedTarget.author?.uniqueId || null,profile_url:loadedTarget.author?.uniqueId ? `https://www.tiktok.com/@${loadedTarget.author.uniqueId}` : null};
    const counts = platform === 'bilibili' ? loadedTarget?.stat : platform === 'tiktok' ? loadedTarget?.stats : null;
    if (counts) for (const [key, field] of Object.entries(platform === 'bilibili' ? {likes:'like',comments:'reply',favorites:'favorite',shares:'share',views:'view'} : {likes:'diggCount',comments:'commentCount',favorites:'collectCount',shares:'shareCount',views:'playCount'})) {
      if (counts[field] !== undefined && /^\d+$/.test(String(counts[field]))) post.engagement[key] = {...metric({getAttribute:()=>String(counts[field])}),source:'observed_target_page_data'};
    }
  }
  if (comments && platform === 'x') for (const node of tweetArticles) {
    const permalink = tweetURL(node);
    const id = permalink?.match(/\/status\/(\d+)/)?.[1];
    if (!id || id === wantedID) continue;
    const value = text(node.querySelector('[data-testid="tweetText"], [dir="auto"].text-lead'));
    if (value) extractedComments.push({ id, url: permalink, text: value, account: account(node, permalink.match(/(?:x|twitter)\.com\/([^/]+)/)?.[1] || ''), likes: metric(first(['[data-testid="like"]', '[data-testid="unlike"]'], node)), time: node.querySelector('time')?.dateTime || null, scope: 'loaded_thread_item' });
  }
  if (comments && platform !== 'x') {
    const selector = { xhs: '.comment-item', zhihu: '.CommentItem, [class*="CommentItem"], .Comments-container .CommentContent', douban: '.comment-item, .reply-item, .topic-reply', reddit: 'shreddit-comment, .thing.comment', youtube: 'ytd-comment-thread-renderer', douyin: '[data-e2e="comment-item"]', weibo: '[class*="CommentItem"], .list_li', github: '.timeline-comment', stackoverflow: '.comment' }[platform];
    const contentSelectors = { xhs: ['.content .note-text', '.note-text', '.content'], zhihu: ['.CommentRichText', '.CommentContent', '.RichText', '[class*="CommentContent"]'], douban: ['.reply-content', '.comment-text', '.content'], reddit: ['[slot="comment"]', '.usertext-body'], youtube: ['#content-text'], douyin: ['[data-e2e="comment-text"]', '.comment-item-content', '[class*="comment-content"]'], github: ['.comment-body'], stackoverflow: ['.comment-copy'] };
    const commentRoot = ['zhihu', 'youtube', 'reddit'].includes(platform) ? document : root;
    if (selector) for (const node of commentRoot.querySelectorAll(selector)) {
      if (!visible(node)) continue;
      if (platform === 'zhihu' && node.closest('[class*="CommentItem"]') && node.closest('[class*="CommentItem"]') !== node) continue;
      let container = node;
      if (platform === 'zhihu' && node.classList.contains('CommentContent')) for (let depth = 0; depth < 4 && container.parentElement && !container.querySelector('a[href*="/people/"]'); depth++) container = container.parentElement;
      const douyinBody = platform === 'douyin' ? container.querySelector('.comment-item-info-wrap')?.nextElementSibling : null;
      const value = text(first(contentSelectors[platform] || ['.content'], container) || douyinBody || node);
      if (value) extractedComments.push({ id: container.id || container.getAttribute('thingid') || (platform === 'douyin' ? container.querySelector('[id^="tooltip_"]')?.id.replace(/^tooltip_/, '') : null) || `comment:${value}`, url: pageURL, text: value, account: account(container), likes: metric(first(['.like-wrapper .count', '.like .count', '#vote-count-middle', '[aria-label*="赞"]', '.comment-item-stats-container p'], container)), time: container.querySelector('time')?.dateTime || text(first(['.date', '.time'], container) || douyinBody?.nextElementSibling) || null, scope: 'loaded_visible_comment' });
    }
  }
  const clone = root.cloneNode(true);
  for (const item of clone.querySelectorAll('script, style, noscript, iframe, object, embed, form, input, textarea, select, button, meta, link, base')) item.remove();
  for (const item of [clone, ...clone.querySelectorAll('*')]) for (const attribute of [...item.attributes]) {
    if (/^on/i.test(attribute.name) || /^(value|srcdoc|nonce)$/i.test(attribute.name) || /^(?:javascript|data):/i.test(attribute.value)) item.removeAttribute(attribute.name);
  }
  const scrollElement = document.scrollingElement || document.documentElement;
  const bodyTitle = platform === 'wechat' ? text(document.querySelector('#activity-name')) : platform === 'xhs' && bodyConfirmed && !isSearch ? text(root.querySelector('#detail-title, .title, h1')) : platform === 'zhihu' && !isSearch ? text(document.querySelector('.QuestionHeader-title,.Post-Title')) : platform === 'douyin' && !isSearch ? text(bodyRoot).split('\n')[0] : '';
  if (post) post.title = articleTitle || bodyTitle || document.title;
  const searchNeedsItems = platform === 'x' && (isSearch || /\/\/(?:www\.)?(?:x|twitter)\.com\/search(?:[/?#]|$)/.test(requestedURL));
  return { url: pageURL, title: articleTitle || bodyTitle || document.title, platform, text: content, body_text_length: body.length, html: clone.outerHTML, presentation,
    items, media, links, article_links: articleLinks, transcript, gate, gate_text: cooldownText, post, comments: extractedComments,
    target_present: !gate && bodyConfirmed && (!searchNeedsItems || items.length > 0) && (!wantedID || items.some((item) => item.id === wantedID || item.source_status_id === wantedID)),
    login_notice: /登录|sign in|log in/i.test(gateDialog),
    loading: [...root.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible),
    visible_expand_controls: [...root.querySelectorAll('[data-testid="tweet-text-show-more-link"], .RichContent-expandButton, .unfold, [class*="expand"]')].filter(visible).length,
    scroll: { top: scrollElement.scrollTop, height: scrollElement.scrollHeight, viewport: scrollElement.clientHeight } };
}

export function articleMediaFromNetwork(entries, targetID) {
  const media = {};
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (String(value.rest_id || value.legacy?.id_str || '') === targetID) {
      const article = value.article?.article_results?.result;
      for (const item of Object.values(article?.media_entities || {})) {
        const url = item?.media_info?.original_img_url;
        if (item.media_id && /^https:\/\/pbs\.twimg\.com\//.test(url || '')) media[String(item.media_id)] = { url, alt: item.media_info?.alt_text || '', source_status_id: targetID };
      }
      const cover = article?.cover_media;
      if (cover?.media_id && /^https:\/\/pbs\.twimg\.com\//.test(cover?.media_info?.original_img_url || '')) media[String(cover.media_id)] = { url: cover.media_info.original_img_url, source_status_id: targetID };
    }
    for (const item of Object.values(value)) if (item && typeof item === 'object') visit(item);
  };
  for (const entry of entries) {
    if (!/^https:\/\/(?:www\.)?x\.com\/i\/api\/graphql\//.test(entry.url || '')) continue;
    for (const body of [entry.responseBody, entry.responsePreview, entry.body]) {
      try { visit(typeof body === 'string' ? JSON.parse(body) : body); } catch {}
    }
  }
  return media;
}

export function observedPostVideos(entries, targetID) {
  const videos = new Map();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (String(value.rest_id || value.legacy?.id_str || '') === targetID) for (const item of value.legacy?.extended_entities?.media || value.legacy?.entities?.media || []) {
      const best = (item.video_info?.variants || []).filter((variant) => variant.content_type === 'video/mp4' && /^https:\/\/video\.twimg\.com\//.test(variant.url || '')).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (best) videos.set(best.url, { url: best.url, bitrate: best.bitrate || null, mime: 'video/mp4', source_status_id: targetID, source: 'observed_post_response' });
    }
    for (const item of Object.values(value)) if (item && typeof item === 'object') visit(item);
  };
  for (const entry of entries) if (/^https:\/\/(?:www\.)?x\.com\/i\/api\/graphql\//.test(entry.url || '')) for (const body of [entry.responseBody, entry.responsePreview, entry.body]) {
    try { visit(typeof body === 'string' ? JSON.parse(body) : body); } catch {}
  }
  return [...videos.values()];
}

// Serialized into the browser; closes an optional login prompt (close button, "not now", or Escape).
export function dismissLoginGate() {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const label = (node) => (node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || node.textContent || '').trim();
  const press = (node) => {
    const target = node.closest('button, [role="button"], a') || node;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return target;
  };
  const textClose = /^(关闭|稍后|稍后再说|暂不登录|暂不|以后再说|游客访问|跳过|取消|我知道了|继续浏览|先逛逛|不了|Close|Not now|Skip|Maybe later|Cancel|×|✕|╳|X)$/i;
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .login-container, .login-modal, [class*="loginModal"], [class*="LoginModal"], [class*="login-guide" i], [class*="login_guide" i], [class*="login-panel" i], [id*="login" i]')]
    .filter((node) => visible(node) && /登录|登入|sign in|log in/i.test(node.innerText || ''));
  for (const dialog of dialogs) {
    const candidates = [...dialog.querySelectorAll('button, [role="button"], a, [aria-label], [title], [class*="close" i], [data-e2e*="close" i], svg')].filter(visible);
    let close = candidates.find((node) => textClose.test(label(node)))
      || candidates.find((node) => /close|关闭/i.test((node.getAttribute('class') || '') + ' ' + (node.getAttribute('data-e2e') || '') + ' ' + (node.getAttribute('aria-label') || '')) && !/登录|登入|login|sign/i.test(node.textContent || ''));
    if (!close) {
      // An unlabeled small control near the dialog's top-right corner.
      const box = dialog.getBoundingClientRect();
      close = candidates.find((node) => {
        const rect = node.getBoundingClientRect();
        return !(node.textContent || '').trim() && rect.width <= 48 && rect.height <= 48 && rect.top - box.top < 72 && box.right - rect.right < 72;
      });
    }
    if (close) {
      const target = press(close);
      return ['dismiss_login:' + (label(target) || String(target.getAttribute('class') || target.tagName)).slice(0, 40)];
    }
  }
  if (dialogs.length) {
    for (const target of [document.activeElement || document.body, document]) target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    return ['dismiss_login:escape'];
  }
  return [];
}

// Adaptive request budget per window: starts at the configured base (assets get four times as much)
// and stays between a quarter and four times that base.
export function adaptiveLimit(record, config, asset) {
  const base = asset ? config.max_requests_per_window * 4 : config.max_requests_per_window;
  const floor = Math.max(3, Math.ceil(base / 4));
  const ceiling = base * 4;
  const stored = record[(asset ? 'asset_' : '') + 'adaptive_limit'];
  return { base, floor, ceiling, limit: Math.min(ceiling, Math.max(floor, stored || base)) };
}

// Ranks two capture results of the same page: valid content first, then status, then text length.
export function captureQuality(result) {
  if (!result) return -1;
  const status = { captured: 4, partial: 3, awaiting_user: 1, blocked: 1 }[result.status] ?? 0;
  const chars = result.completeness?.chars ?? result.chars ?? 0;
  return (result.url_check?.valid_content ? 1000 : 0) + status * 100 + Math.min(99, Math.floor(chars / 100));
}

export function expandPage({ platform, comments = false }) {
  const selectors = {
    x: ['[data-testid="tweet-text-show-more-link"]'],
    xhs: ['.note-content .expand', '.note-content .show-more'],
    youtube: ['ytd-text-inline-expander #expand', 'tp-yt-paper-button#expand', 'ytd-video-description-transcript-section-renderer button'],
    zhihu: ['.RichContent-expandButton'],
    douban: ['.unfold'],
  };
  for (const dialog of document.querySelectorAll('[role="dialog"], .login-container, .login-modal, [class*="loginModal"], [class*="LoginModal"]')) {
    if (!dialog.getClientRects().length || !/登录|sign in|log in/i.test(dialog.innerText || '')) continue;
    const close = [...dialog.querySelectorAll('button, [role="button"], [aria-label]')].find((node) => node.getClientRects().length && /^(关闭|稍后|稍后再说|暂不登录|暂不|以后再说|游客访问|跳过|取消|我知道了|继续浏览|先逛逛|Close|Not now|Skip|Maybe later|×|✕)$/i.test((node.getAttribute('aria-label') || node.innerText || '').trim()));
    if (close) { close.click(); return ['dismiss_optional_login']; }
  }
  for (const selector of selectors[platform] || []) for (const item of document.querySelectorAll(selector)) {
    if (item.getClientRects().length && !item.disabled && item.dataset.luzExpanded !== 'yes') {
      item.dataset.luzExpanded = 'yes'; item.click(); return [selector];
    }
  }
  if (comments && platform === 'reddit') for (const item of document.querySelectorAll('shreddit-comment-tree button')) {
    if (/^(view more comments|load more comments|more replies|更多回复)$/i.test(item.innerText.trim()) && item.getClientRects().length) { item.click(); return ['more_comments']; }
  }
  if (comments && ['zhihu', 'douyin'].includes(platform)) {
    const scope = platform === 'zhihu' ? document.querySelector('.AnswerCard') || document : document;
    const openList = platform === 'douyin' && [...scope.querySelectorAll('[data-e2e="comment-list"]')].some(node => node.getClientRects().length);
    const item = !openList && [...scope.querySelectorAll(platform === 'zhihu' ? 'button.ContentItem-action' : '[data-e2e="video-player-comment"], [data-e2e="feed-comment-icon"]')].find((node) => node.getClientRects().length && node.dataset.luzComments !== 'yes' && (platform !== 'zhihu' || /评论/.test(node.innerText || node.getAttribute('aria-label') || '')));
    if (item) { item.dataset.luzComments = 'yes'; item.click(); return ['open_comments']; }
  }
  return [];
}

export function scrollPage({ move = true, comments = false, platform } = {}) {
  const commentSelectors = { xhs: '.comments-container, .comments-list', zhihu: '.CommentListV2, .CommentsV2-withPagination, .Comments-container', douyin: '[data-e2e="comment-list"]' };
  const commentRoot = comments && commentSelectors[platform] ? document.querySelector(commentSelectors[platform]) : null;
  const root = commentRoot || document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('.note-container, #js_article, main, article, [role="main"]') || document.body || document.documentElement;
  const ancestors = [];
  for (let item = root; item; item = item.parentElement) ancestors.push(item);
  const canScroll = (item) => Boolean(item && item.clientHeight > 100 && item.scrollHeight > item.clientHeight + 3 && (item === document.scrollingElement || /auto|scroll|overlay/.test(getComputedStyle(item).overflowY)));
  const element = ancestors.find(canScroll) || (canScroll(document.scrollingElement) ? document.scrollingElement : null) || [...root.querySelectorAll('*')].filter(canScroll).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0] || document.scrollingElement;
  const before = element.scrollTop;
  if (move) element.scrollBy(0, Math.max(200, Math.round(element.clientHeight * 0.8)));
  return { before, top: element.scrollTop, after: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight, at_bottom: element.scrollTop + element.clientHeight >= element.scrollHeight - 3, element: element.getAttribute('data-testid') || element.id || element.tagName };
}

// Serialized into the browser; submit the site's search, never a login form.
export function submitSearch({ query, mode, url, parameter = 'keywords' }) {
  if (mode === 'gbk') {
    const form = document.createElement('form');
    form.action = url; form.method = 'get'; form.acceptCharset = 'GBK';
    const field = document.createElement('input'); field.name = parameter; field.value = query;
    form.append(field); document.body.append(form); form.submit();
    return { submitted: true, method: 'native_GBK_form', query };
  }
  // 通用站内搜索：给可见输入框按线索打分，排除登录/验证码/手机号；检查同源 iframe；必要时先展开折叠的搜索入口；
  // 按钮按文字、class、图标与位置识别，最后退回表单提交或回车。
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe,frame')) {
    try {
      const doc = frame.contentDocument;
      if (doc && doc.body && frame.getClientRects().length) docs.push(doc);
    } catch {}
  }
  const visible = (node) => {
    if (!node || !node.getClientRects().length) return false;
    const style = (node.ownerDocument.defaultView || window).getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0 && rect.width >= 8 && rect.height >= 8;
  };
  const attrs = (node) => [node.type, node.placeholder, node.name, node.id, node.className && typeof node.className === 'string' ? node.className : '', node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('ng-model'), node.getAttribute('v-model')].filter(Boolean).join(' ');
  const label = (node) => (node.innerText || node.value || node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('alt') || '').trim();
  const bad = /password|验证码|校验码|captcha|手机|电话|邮箱|email|mail|用户名|账号|帐号|登录名|密码|user(?:name)?|login|account|mobile|phone|tel|身份证|日期|date|价格|金额|页码|跳转|goto|page/i;
  const strong = /search|搜索|关键词|关键字|keyword|kwd?\b|\bwd\b|\bq\b|query|查询|检索|项目名称|公告名称|公告标题|标题|全文|招标|采购|请输入|输入.*查|sousuo|searchkey|title/i;
  const btnText = /^(搜索|搜\s*索|查询|查\s*询|查找|检索|搜一下|立即搜索|站内搜索|全文检索|go|search|submit|确定)$/i;
  const btnHint = /search|sousuo|souso|chaxun|jiansuo|btn-?s(?:earch)?\b|query|find|submit|icon-?s(?:earch)?|fa-search|magnif/i;
  const btnBad = /登录|注册|帮助|高级搜索|高级检索|重置|清空|图像|图片|以图|识图|语音|拍照|相机|上传|image|voice|camera|visual|lens|login|register|reset/i;
  const pick = () => {
    const found = [];
    for (const doc of docs) {
      const all = [...doc.querySelectorAll('input:not([type]),input[type="text"],input[type="search"],input[role="searchbox"],[role="searchbox"],[role="combobox"] input,textarea')].filter((node) => visible(node) && !node.disabled && !node.readOnly);
      const text = all.filter((node) => !node.closest('form')?.querySelector('input[type="password"]'));
      for (const node of text) {
        const value = attrs(node);
        let score = 0;
        if (bad.test(value)) continue;
        if (node.type === 'search') score += 5;
        if (node.getAttribute('role') === 'searchbox') score += 5;
        if (strong.test(value)) score += 4;
        const form = node.closest('form');
        if (form && /search|so|query|keyword|find|jiansuo|sousuo|chaxun/i.test(form.getAttribute('action') || '')) score += 3;
        const box = node.closest('header,nav,[class*=search i],[id*=search i],[class*=sousuo i],[class*=top i],[class*=head i]');
        if (box) score += 2;
        if (/search|sousuo|ss_|keyword/i.test((box?.className || '') + ' ' + (box?.id || ''))) score += 2;
        if (node.closest('footer,[class*=footer i]')) score -= 3;
        if (node.tagName === 'TEXTAREA') score -= 2;
        const rect = node.getBoundingClientRect();
        if (rect.top < (node.ownerDocument.defaultView || window).innerHeight * 0.6) score += 1;
        found.push({ node, score });
      }
      if (text.length === 1 && found.length === 1) found[0].score += 3;
    }
    found.sort((a, b) => b.score - a.score);
    return found[0] && found[0].score >= 3 ? found[0].node : null;
  };
  let input = pick();
  let opened = '';
  if (!input) {
    // A collapsed search entry: click the search icon or label first, then look again.
    for (const doc of docs) {
      const toggle = [...doc.querySelectorAll('button,a,[role="button"],span,i,div,img,svg')].filter(visible).find((node) => {
        const value = label(node);
        const names = (typeof node.className === 'string' ? node.className : node.getAttribute('class') || '') + ' ' + (node.id || '');
        return ((value.length <= 6 && /^(搜索|搜\s*索|search)$/i.test(value)) || (value === '' && /search|sousuo|icon-?s\b|magnif/i.test(names))) && !btnBad.test(value + ' ' + names) && node.getBoundingClientRect().width <= 160;
      });
      if (toggle) {
        (toggle.closest('button,a,[role="button"]') || toggle).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        opened = 'opened_search_toggle';
        break;
      }
    }
    if (opened) input = pick();
  }
  if (!input) return { submitted: false, method: opened ? 'search_toggle_without_input' : 'no_visible_search', login_visible: /登录|登入|sign in|log in/i.test(document.body.innerText || '') };
  if (parameter === 'search' && !/请输入搜索内容|^search$/i.test(`${input.placeholder} ${input.name} ${input.id}`)) {
    const exact = [...document.querySelectorAll('input')].filter(visible).find((node) => /请输入搜索内容|^search$/i.test(`${node.placeholder} ${node.name} ${node.id}`));
    if (exact) input = exact;
  }
  const win = input.ownerDocument.defaultView || window;
  const proto = input.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
  input.focus();
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, query);
  for (const type of ['input', 'change', 'keyup']) input.dispatchEvent(new Event(type, { bubbles: true }));
  const form = input.closest('form');
  if (form?.querySelector('input[type="password"]')) return {submitted:false,method:'login_form_rejected',login_visible:true};
  const doc = input.ownerDocument;
  if (parameter === 'search' && input.id !== 'FINDTXT') {
    const button = [...doc.querySelectorAll('button,[role="button"],input[type="submit"]')].find((node) => visible(node) && /搜索/i.test(label(node)) && !btnBad.test(label(node)));
    if (button) { button.click(); return { submitted: true, method: 'procurement_search_button', query, input: input.id || input.placeholder, button: button.id || button.innerText }; }
  }
  // 结果在当前标签页打开，便于跟随落地地址
  for (const element of doc.querySelectorAll('form[target],a[target]')) if (element.target && element.target !== '_self') element.target = '_self';
  try {
    const script = doc.createElement('script');
    script.textContent = 'window.open=function(u){u&&(location.href=u);return window};';
    (doc.head || doc.documentElement).append(script);
    script.remove();
  } catch {}
  const inputRect = input.getBoundingClientRect();
  let scope = form;
  if (!scope) {
    // The nearest ancestor (up to four levels) that holds a button-like control.
    scope = input.parentElement;
    for (let i = 0; i < 4 && scope && scope.parentElement; i++) {
      if (scope.querySelectorAll('button,input[type="submit"],input[type="button"],input[type="image"],a,[role="button"],[onclick],[class*=search i],[class*=btn i]').length) break;
      scope = scope.parentElement;
    }
  }
  const near = (node) => {
    const rect = node.getBoundingClientRect();
    return Math.abs(rect.top + rect.height / 2 - (inputRect.top + inputRect.height / 2)) + Math.max(0, inputRect.left - rect.left) * 2 + Math.max(0, rect.left - inputRect.right);
  };
  const buttons = [...(scope || doc).querySelectorAll('button,input[type="submit"],input[type="button"],input[type="image"],a,[role="button"],[onclick],span,i,div,img,em,label')]
    .filter((node) => node !== input && visible(node) && !node.contains(input))
    .map((node) => {
      const value = label(node);
      const names = (typeof node.className === 'string' ? node.className : node.getAttribute('class') || '') + ' ' + (node.id || '') + ' ' + (node.getAttribute('onclick') || '') + ' ' + (node.getAttribute('src') || '');
      let score = 0;
      if (btnBad.test(value) || (btnBad.test(names) && !btnHint.test(names))) return null;
      if (btnText.test(value)) score += 6;
      else if (value.length <= 8 && /搜索|查询|检索|search/i.test(value)) score += 4;
      if (btnHint.test(names)) score += 3;
      if (/^(submit|image)$/i.test(node.type || '')) score += 3;
      if (node.tagName === 'BUTTON') score += 1;
      if (value.length > 12) score -= 4;
      const rect = node.getBoundingClientRect();
      if (rect.width > 320) score -= 3;
      return score >= 3 ? { node, score, distance: near(node) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.distance - b.distance);
  const button = buttons[0]?.node;
  if (button) {
    (button.closest('button,a,[role="button"]') || button).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: win }));
    return { submitted: true, method: opened ? 'toggle_then_search_button' : 'visible_search_button', query, input: input.id || input.name || input.placeholder, button: button.id || label(button).slice(0, 20) || button.className };
  }
  if (form) {
    try { form.requestSubmit(); } catch { form.submit(); }
    return { submitted: true, method: 'native_search_form', query, input: input.id || input.name };
  }
  for (const type of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  return { submitted: true, method: 'enter_key', query, input: input.id || input.name || input.placeholder };
}


export function clickSearchResult({ url, inspect = false }) {
  const target = new URL(url);
  const noteID = (path) => path.match(/\/(?:explore|discovery\/item|search_result)\/([^/?]+)/)?.[1];
  const id = noteID(target.pathname);
  const link = [...document.querySelectorAll('a[href]')].find((item) => {
    const candidate = new URL(item.href);
    return item.getClientRects().length && candidate.origin === target.origin && (candidate.pathname === target.pathname || (id && noteID(candidate.pathname) === id));
  });
  if (!link) return false;
  if (inspect) return true;
  link.target = '_self'; link.click(); return true;
}
