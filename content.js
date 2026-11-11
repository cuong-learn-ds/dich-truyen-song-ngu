// Content script: finds English paragraphs on reading pages and shows Vietnamese subtitles.
(() => {
  if (window.__freeTranslatorLoaded) return;
  window.__freeTranslatorLoaded = true;

  const SUB_CLASS = 'free-translator-sub';
  const STATUS = 'translatedStatus'; // -> data-translated-status
  const BATCH_SIZE = 20;
  const MIN_LEN = 5;
  // A page counts as a "reading page" once it has this many long English paragraphs.
  const READING_PAGE_MIN_PARAGRAPHS = 4;
  const LONG_PARAGRAPH = 40;
  const SKIP_ANCESTORS = 'header, nav, footer, aside, button, textarea, [contenteditable=""], [contenteditable="true"], .' + SUB_CLASS;
  const VIETNAMESE = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;

  const host = location.hostname;
  let settings = { enabled: true, mode: 'bilingual', disabledSites: [] };
  let active = false;
  let queue = [];
  let flushTimer = null;
  let sending = false;

  const isOn = () => settings.enabled && !settings.disabledSites.includes(host);

  function looksEnglish(text) {
    if (VIETNAMESE.test(text)) return false;
    const letters = text.match(/\p{L}/gu) || [];
    if (letters.length < 2) return false;
    const latin = letters.filter((c) => /[a-z]/i.test(c)).length;
    return latin / letters.length > 0.8;
  }

  function isCandidate(p) {
    if (p.dataset[STATUS]) return false;
    if (p.closest(SKIP_ANCESTORS)) return false;
    const text = p.innerText ? p.innerText.trim() : p.textContent.trim();
    return text.length >= MIN_LEN && looksEnglish(text);
  }

  function findParagraphs(root = document) {
    const list = root.querySelectorAll ? [...root.querySelectorAll('p')] : [];
    if (root.tagName === 'P') list.push(root);
    return list.filter(isCandidate);
  }

  function isReadingPage() {
    const long = [...document.querySelectorAll('p')].filter(
      (p) => !p.closest(SKIP_ANCESTORS) && p.textContent.trim().length >= LONG_PARAGRAPH && looksEnglish(p.textContent)
    );
    return long.length >= READING_PAGE_MIN_PARAGRAPHS;
  }

  // ---- Rendering ----
  function applyModeClasses() {
    const root = document.documentElement;
    root.classList.toggle('ft-mode-replace', settings.mode === 'replace');
    root.classList.toggle('ft-off', !isOn());
  }

  function placeholderFor(p) {
    let sub = p.nextElementSibling;
    if (!sub || !sub.classList.contains(SUB_CLASS)) {
      sub = document.createElement('div');
      sub.className = SUB_CLASS + ' ft-loading';
      sub.textContent = 'Đang dịch…';
      p.after(sub);
    }
    return sub;
  }

  function render(p, translation) {
    const sub = placeholderFor(p);
    sub.classList.remove('ft-loading');
    sub.textContent = translation; // textContent only: never inject HTML
    p.dataset[STATUS] = 'completed';
  }

  function fail(p) {
    const sub = p.nextElementSibling;
    if (sub && sub.classList.contains(SUB_CLASS)) sub.remove();
    delete p.dataset[STATUS];
    // Try again later when the reader scrolls back to it.
    setTimeout(() => active && observer.observe(p), 10000);
  }

  // ---- Translation queue ----
  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 120);
  }

  async function flush() {
    if (sending || !queue.length) return;
    sending = true;
    try {
      while (queue.length && active) {
        const batch = queue.splice(0, BATCH_SIZE);
        const texts = batch.map((p) => p.innerText || p.textContent);
        let res;
        try {
          res = await chrome.runtime.sendMessage({ type: 'translate', texts });
        } catch (e) {
          // Extension was reloaded/updated: this old script can no longer talk to it.
          stop();
          return;
        }
        if (res && res.ok) batch.forEach((p, i) => (res.translations[i] ? render(p, res.translations[i]) : fail(p)));
        else batch.forEach(fail);
      }
    } finally {
      sending = false;
      if (queue.length && active) scheduleFlush();
    }
  }

  // Only translate what is on (or near) the screen.
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const p = entry.target;
        observer.unobserve(p);
        if (p.dataset[STATUS]) continue;
        p.dataset[STATUS] = 'pending';
        placeholderFor(p);
        queue.push(p);
      }
      if (queue.length) scheduleFlush();
    },
    { rootMargin: '400px 0px' }
  );

  // Pick up paragraphs added later (infinite scroll, next chapter loaded by JS).
  const mutations = new MutationObserver((records) => {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1 || node.classList.contains(SUB_CLASS)) continue;
        findParagraphs(node).forEach((p) => observer.observe(p));
      }
    }
  });

  // Many sites load the chapter text late, or switch chapters without reloading the page.
  // Until this page qualifies, keep re-checking (at most once a second) when it changes.
  let recheckTimer = null;
  const waitForText = new MutationObserver(() => {
    if (recheckTimer) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = null;
      if (isOn()) start();
    }, 1000);
  });

  function start() {
    if (active) return;
    if (!isReadingPage()) {
      waitForText.observe(document.body, { childList: true, subtree: true });
      return;
    }
    waitForText.disconnect();
    active = true;
    findParagraphs().forEach((p) => observer.observe(p));
    mutations.observe(document.body, { childList: true, subtree: true });
  }

  function stop() {
    active = false;
    waitForText.disconnect();
    observer.disconnect();
    mutations.disconnect();
    queue.forEach((p) => {
      const sub = p.nextElementSibling;
      if (sub && sub.classList.contains('ft-loading')) sub.remove();
      delete p.dataset[STATUS];
    });
    queue = [];
  }

  function refresh() {
    applyModeClasses();
    if (isOn()) start();
    else stop();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let changed = false;
    for (const key of ['enabled', 'mode', 'disabledSites']) {
      if (changes[key]) {
        settings[key] = changes[key].newValue;
        changed = true;
      }
    }
    if (changed) refresh();
  });

  // Popup asks whether this tab is a reading page.
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'pageStatus') sendResponse({ host, active, readingPage: isReadingPage() });
    if (msg.type === 'forceStart') {
      if (isOn() && !active) {
        active = true;
        findParagraphs().forEach((p) => observer.observe(p));
        mutations.observe(document.body, { childList: true, subtree: true });
      }
      sendResponse({ active });
    }
  });

  chrome.storage.local.get(['enabled', 'mode', 'disabledSites']).then((s) => {
    settings = { ...settings, ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) };
    refresh();
    // Some sites render the chapter text a bit after load; check again once.
    if (!active && isOn()) setTimeout(refresh, 2500);
  });
})();
