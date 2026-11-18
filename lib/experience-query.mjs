// Lexical recall for local experience. It suggests leads; it never verifies facts.
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const stop = new Set('的 与 和 了 在 及 把 如何 怎么 需要 请 帮 寻找 一些 更多 the a an and or to for with how is of in on please find need'.split(' '));
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function experienceTerms(query) {
  return [...new Set([...segmenter.segment(normalize(query))]
    .filter(part => part.isWordLike && !stop.has(part.segment))
    .map(part => part.segment)
    .filter(term => !/\p{Script=Han}/u.test(term) || term.length > 1))];
}

function contains(text, term) {
  return /^[a-z\d_.-]+$/i.test(term)
    ? new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(term)}($|[^\\p{L}\\p{N}_])`, 'u').test(text)
    : text.includes(term);
}

export function experienceScore(value, query) {
  const text = normalize(value), phrase = normalize(query);
  if (!phrase) return 1;
  const terms = experienceTerms(phrase);
  const matched = terms.filter(term => contains(text, term));
  if (!matched.length) return 0;
  return matched.reduce((score, term) => score + Math.min(term.length, 8), 0) / Math.max(terms.length, 1)
    + (contains(text, phrase) ? 10 : 0);
}
