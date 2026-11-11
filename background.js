// Service worker: does all network calls (content scripts would hit CORS)
// and routes OCR jobs to the offscreen document.
importScripts('translator.js');

const CACHE_PREFIX = 'c_';

// Cache is capped: an index key lists cache keys oldest -> newest, and the oldest are
// dropped once there are more than MAX_ENTRIES (keeps storage far below the 10MB quota).
const INDEX_KEY = 'cache_idx';
const MAX_ENTRIES = 6000;
let cacheLock = Promise.resolve(); // serializes writes so the index never gets out of sync

async function loadIndex() {
  const { [INDEX_KEY]: idx } = await chrome.storage.local.get(INDEX_KEY);
  if (Array.isArray(idx)) return idx;
  // First run after upgrade: build the index from the entries already stored.
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
}

const storageCache = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (items) => {
    const run = cacheLock.then(async () => {
      const added = Object.keys(items);
      const addedSet = new Set(added);
      const next = (await loadIndex()).filter((k) => !addedSet.has(k)).concat(added);
      const evict = next.length > MAX_ENTRIES ? next.splice(0, next.length - MAX_ENTRIES) : [];
      await chrome.storage.local.set({ ...items, [INDEX_KEY]: next });
      if (evict.length) await chrome.storage.local.remove(evict);
    });
    cacheLock = run.catch(() => {});
    return run;
  },
};

chrome.runtime.onInstalled.addListener(async () => {
  const defaults = { enabled: true, mode: 'bilingual', disabledSites: [], mangaAuto: true };
  const current = await chrome.storage.local.get(Object.keys(defaults));
  const missing = {};
  for (const [k, v] of Object.entries(defaults)) if (current[k] === undefined) missing[k] = v;
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});

async function cacheStats() {
  const keys = await loadIndex();
  return { count: keys.length, keys };
}

// ---- Offscreen document (runs PaddleOCR) ----
let creating = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Đọc chữ trên ảnh truyện bằng PaddleOCR' })
      .finally(() => (creating = null));
  }
  await creating;
}

function sendToOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'ocr', ...msg });
}

// Many manga sites only serve images to their own pages: some check the Referer,
// others need the site's own cookies (e.g. a reading session). For our own (non-tab)
// requests to that image host, send the reading page as Referer plus that host's cookies.
// The cookies only ever go back to the host they belong to.
async function allowHotlink(src, pageUrl) {
  let host;
  try { host = new URL(src).hostname; } catch { return; }
  let id = 1;
  for (let i = 0; i < host.length; i++) id = (id * 31 + host.charCodeAt(i)) % 1000000;
  id += 1;
  const requestHeaders = [{ header: 'referer', operation: 'set', value: pageUrl }];
  try {
    // "cookies" is an optional permission (popup toggle); without it chrome.cookies is undefined.
    const cookies = chrome.cookies ? await chrome.cookies.getAll({ url: src }) : [];
    if (cookies.length) {
      requestHeaders.push({ header: 'cookie', operation: 'set', value: cookies.map((c) => `${c.name}=${c.value}`).join('; ') });
    }
  } catch {}
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE] },
    }],
  });
}

// captureVisibleTab is limited to ~2 calls per second.
let lastCapture = 0;
async function captureTab(windowId) {
  const wait = lastCapture + 600 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCapture = Date.now();
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

async function ocrImage(msg) {
  await ensureOffscreen();
  if (!msg.dataUrl && /^https?:/.test(msg.src)) await allowHotlink(msg.src, msg.pageUrl);
  return sendToOffscreen({ src: msg.src, dataUrl: msg.dataUrl, region: msg.region });
}

async function ocrCapture(msg, sender) {
  const dataUrl = await captureTab(sender.tab.windowId);
  await ensureOffscreen();
  const d = msg.dpr || 1;
  const region = { x: msg.rect.x * d, y: msg.rect.y * d, w: msg.rect.w * d, h: msg.rect.h * d };
  const res = await sendToOffscreen({ dataUrl, region });
  if (res && res.ok) {
    // Back to CSS pixels of the viewport.
    res.items = res.items.map((it) => ({ ...it, x: it.x / d, y: it.y / d, w: it.w / d, h: it.h / d, lineH: it.lineH / d }));
  }
  return res;
}

function reply(promise, sendResponse) {
  promise.then(sendResponse).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return; // meant for the offscreen document
  switch (msg.type) {
    case 'translate':
      return reply(translateAll(msg.texts, storageCache).then((translations) => ({ ok: true, translations })), sendResponse);
    case 'ocrImage':
      return reply(ocrImage(msg), sendResponse);
    case 'ocrCapture':
      return reply(ocrCapture(msg, sender), sendResponse);
    case 'cacheStats':
      return reply(cacheStats().then(({ count }) => ({ count })), sendResponse);
    case 'clearCache':
      return reply(cacheLock.then(cacheStats).then(({ keys }) => chrome.storage.local.remove([...keys, INDEX_KEY])).then(() => ({ ok: true })), sendResponse);
  }
});
