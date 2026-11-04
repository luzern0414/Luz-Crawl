import fs from 'node:fs';

// One page format for every report LuzCrawl writes (爬取总结, 汇总报告, 前置检索结论): the title is the first visible line,
// every table has a numbered caption above it, one font stack, no cards, badges, timestamps or scripts.
// The CSS lives in lib/formal-report.css so scripts/crawl_preflight.py renders the same page. Its text sizes come from the
// luz-md-type block (a mirror shared by the Luz skills, synced from its master, never edited here): body 18 on desktop and 16 on a phone,
// tables 16 and 14, captions 14. Do not edit that block here, and do not set font sizes outside it except through its var(--md-*).
export const FORMAL_CSS = fs.readFileSync(new URL('./formal-report.css', import.meta.url), 'utf8').trim();
export const FORMAL_ICON = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%228%22%20fill%3D%22%23E8F0EB%22%2F%3E%3Ccircle%20cx%3D%2214%22%20cy%3D%2214%22%20r%3D%227%22%20fill%3D%22none%22%20stroke%3D%22%231F5F46%22%20stroke-width%3D%222.6%22%2F%3E%3Cpath%20d%3D%22M19.5%2019.5%2025%2025%22%20stroke%3D%22%231F5F46%22%20stroke-width%3D%222.6%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E';

// The same stylesheet limited to one container, for a report block appended to a saved copy of a source page.
export function scopedFormalCSS(scope) {
  const map = (selector) => {
    const value = selector.trim();
    return ['html', 'body', ':root'].includes(value) ? scope : value === '*' ? `${scope} *` : `${scope} ${value}`;
  };
  const rules = (css) => {
    let out = '';
    for (let index = 0; index < css.length;) {
      const open = css.indexOf('{', index);
      if (open < 0) break;
      let depth = 1, end = open + 1;
      while (end < css.length && depth) depth += css[end] === '{' ? 1 : css[end] === '}' ? -1 : 0, end++;
      const head = css.slice(index, open).trim(), inner = css.slice(open + 1, end - 1);
      out += head.startsWith('@') ? `${head}{${rules(inner)}}` : `${head.split(',').map(map).join(',')}{${inner}}`;
      index = end;
    }
    return out;
  };
  // The stylesheet carries the Markdown type block with its comments; a comment in front of a rule would end up inside its selector.
  return rules(FORMAL_CSS.replace(/\/\*[\s\S]*?\*\//g, ''));
}

export const escapeHTML =(value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

// A heading carries no bracketed explanation: "采购公告（含变更）" is shown as "采购公告".
export const plainTitle = (value) => {
  const text = String(value ?? '').trim();
  const stripped = text.replace(/\s*[（(][^（()）]*[)）]/g, '').replace(/\s+/g, ' ').trim();
  return stripped || text;
};

/** cells: [{ html, class?, rowspan? }] or plain strings (escaped). head: array of strings. */
export function formalTable({ number, caption, head, rows, centered = [], widths = [] }) {
  const cell = (item, index, tag = 'td') => {
    const value = typeof item === 'object' && item !== null ? item : { text: item };
    const classes = [value.class, centered.includes(index) ? 'c' : ''].filter(Boolean).join(' ');
    return `<${tag}${classes ? ` class="${classes}"` : ''}${value.rowspan > 1 ? ` rowspan="${value.rowspan}"` : ''}>${value.html ?? escapeHTML(value.text)}</${tag}>`;
  };
  const header = `<tr>${head.map((name, index) => `<th scope="col"${widths[index] ? ` style="width:${escapeHTML(widths[index])}"` : ''}>${escapeHTML(name)}</th>`).join('')}</tr>`;
  // rowspan cells shift the visible column index of later rows; rows list only the cells they own.
  const body = rows.map((row) => `<tr>${row.map((item, index) => cell(item, index + (head.length - row.length))).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><caption>表 ${number}　${escapeHTML(caption)}</caption><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
}

// The page only shows escaped text and links; captured scripts, remote images and forms never run or load.
export const FORMAL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export function formalPage({ title, body, lang = 'zh-CN', csp = FORMAL_CSP }) {
  const heading = plainTitle(title);
  return `<!doctype html><html lang="${escapeHTML(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeHTML(csp)}"><meta name="referrer" content="no-referrer"><link rel="icon" href="${FORMAL_ICON}"><title>${escapeHTML(heading)}</title><style>${FORMAL_CSS}</style></head><body><main><h1>${escapeHTML(heading)}</h1>${body}</main></body></html>\n`;
}
