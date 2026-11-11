// Translation engine: free Google "gtx" endpoint, batching, throttling, caching.
// Kept free of chrome.* calls (except via the injected cache) so it can be tested in Node.

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=vi&dt=t';
const MAX_CHARS_PER_REQUEST = 4000; // keep each request small and safe
const MIN_GAP_MS = 300;             // pause between requests (workflow: 200-500ms)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalize a paragraph so it can be safely joined with "\n" and used as a cache key.
function clean(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// FNV-1a hash -> short cache key. The "g1" part changes whenever the glossary changes,
// so old translations made without it are not reused.
function hashKey(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'c_g1' + (h >>> 0).toString(36) + '_' + text.length.toString(36);
}

// Story terms Google translates literally ("powerhouse" -> "nhà máy điện").
// Longer phrases first so "senior brother" wins over shorter matches.
const GLOSSARY = [
  [/\bsenior brothers?\b/gi, 'sư huynh'],
  [/\bjunior brothers?\b/gi, 'sư đệ'],
  [/\bsenior sisters?\b/gi, 'sư tỷ'],
  [/\bjunior sisters?\b/gi, 'sư muội'],
  [/\bsect masters?\b/gi, 'tông chủ'],
  [/\byoung master\b/gi, 'thiếu gia'],
  [/\bheavenly demon\b/gi, 'Thiên Ma'],
  [/\bmartial god\b/gi, 'Võ Thần'],
  [/\bmartial arts?\b/gi, 'võ công'],
  [/\bmurim\b/gi, 'võ lâm'],
  [/\bpowerhouses?\b/gi, 'cường giả'],
  [/\bregressors?\b/gi, 'kẻ hồi quy'],
  [/\bdungeons?\b/gi, 'hầm ngục'],
  [/\bcultivators?\b/gi, 'tu sĩ'],
  [/\bcultivation\b/gi, 'tu luyện'],
  [/\bdantian\b/gi, 'đan điền'],
  [/\bsects?\b/gi, 'tông môn'],
];

// Swap glossary terms for tokens Google leaves alone ("Zq07"), and back after translating.
// Tests: a short letter+digits token survived every time; made-up names sometimes got mangled.
function protectTerms(text) {
  return GLOSSARY.reduce((s, [re], i) => s.replace(re, ' Zq' + String(i).padStart(2, '0') + ' '), text)
    .replace(/ {2,}/g, ' ')
    .replace(/ ([,.!?;:…])/g, '$1')
    .trim();
}

function restoreTerms(text) {
  let out = text.replace(/Zq ?(\d\d)/g, (m, n) => (GLOSSARY[+n] ? '\u0000' + GLOSSARY[+n][1] : m));
  // A term that starts a sentence gets a capital letter.
  out = out.replace(/(^|[.!?…]\s+|["“]\s*)\u0000(\S)/g, (_, p, ch) => p + ch.toUpperCase());
  return out.replace(/\u0000/g, '');
}

// Split a list of texts into groups whose joined length stays under the limit.
function chunk(texts) {
  const groups = [];
  let cur = [];
  let len = 0;
  for (const t of texts) {
    if (cur.length && len + t.length + 1 > MAX_CHARS_PER_REQUEST) {
      groups.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(t);
    len += t.length + 1;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

let lastRequestAt = 0;
let chain = Promise.resolve();

// All network calls go through one queue so requests never fire in bursts.
function throttled(fn) {
  const run = chain.then(async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  chain = run.catch(() => {});
  return run;
}

async function requestOnce(text) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'q=' + encodeURIComponent(text),
  });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data[0] || []).map((seg) => seg[0] || '').join('');
}

// One throttled request, retried with backoff when Google rate-limits us.
async function request(text) {
  const delays = [2000, 5000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await throttled(() => requestOnce(text));
    } catch (e) {
      if (attempt >= delays.length) throw e;
      await sleep(delays[attempt]);
    }
  }
}

// Translate one group in a single request; fall back to one-by-one if lines don't line up.
async function translateGroup(group) {
  const src = group.map(protectTerms);
  const out = await request(src.join('\n'));
  const lines = out.split('\n').map((s) => restoreTerms(s.trim()));
  if (lines.length === group.length) return lines;
  const result = [];
  for (const t of src) result.push(restoreTerms((await request(t)).trim()));
  return result;
}

/**
 * Translate many paragraphs. `cache` is { get(keys) -> {key: value}, set({key: value}) }.
 * Returns translations in the same order as `texts`.
 */
async function translateAll(texts, cache) {
  const cleaned = texts.map(clean);
  const keys = cleaned.map(hashKey);
  const cached = cache ? await cache.get(keys) : {};
  const results = cleaned.map((_, i) => cached[keys[i]] ?? null);

  // Unique texts that still need translating.
  const missing = [...new Set(cleaned.filter((_, i) => results[i] === null && cleaned[i]))];
  const fresh = {};
  for (const group of chunk(missing)) {
    const translated = await translateGroup(group);
    group.forEach((t, i) => { fresh[t] = translated[i]; });
    if (cache) {
      const toSave = {};
      group.forEach((t, i) => { toSave[hashKey(t)] = translated[i]; });
      await cache.set(toSave);
    }
  }

  return cleaned.map((t, i) => results[i] ?? fresh[t] ?? '');
}

if (typeof module !== 'undefined') module.exports = { translateAll, hashKey, chunk, clean, protectTerms, restoreTerms };
