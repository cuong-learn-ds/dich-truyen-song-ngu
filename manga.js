// Content script for image comics (manga / manhwa / webtoon):
//  - Auto: OCR the pages on screen, translate each speech bubble, cover it with the Vietnamese text.
//  - Manual: hold Alt and drag a box over any area to read + translate just that area.
(() => {
  if (window.__ftMangaLoaded) return;
  window.__ftMangaLoaded = true;

  const host = location.hostname;
  let settings = { enabled: true, disabledSites: [], mangaAuto: true };
  const isOn = () => settings.enabled && !settings.disabledSites.includes(host);

  const tracked = new Map(); // img -> { src, tiles, done:Set, mode }
  const boxes = [];          // { el, img, n:{x,y,w,h,lineH}, manual } or { el, page:{x,y,w,h} }
  let layer = null;
  let autoActive = false;
  let running = 0;           // tiles being read right now
  const MAX_PARALLEL = 2;    // the OCR side has a worker pool, so 2 tiles can be read at once
  let skipCount = 0;
  let dead = false;          // extension was reloaded; this old script must stay quiet

  // ---------- helpers ----------
  // Set DEBUG = true to trace every step in the page console as "[FT] ...".
  const DEBUG = false;
  const log = DEBUG ? (...a) => console.log('[FT]', Math.round(performance.now() / 100) / 10 + 's', ...a) : () => {};

  async function send(msg) {
    if (dead) { log('send skipped: dead'); return null; }
    const t0 = performance.now();
    try {
      const res = await chrome.runtime.sendMessage(msg);
      log('send', msg.type, Math.round(performance.now() - t0) + 'ms', res ? (res.ok ? 'ok' : 'ERR ' + res.error) : 'no response');
      return res;
    } catch (e) {
      log('send', msg.type, 'THREW', String(e));
      if (String(e).includes('context invalidated')) dead = true;
      return null;
    }
  }
  if (DEBUG) setInterval(() => { if (autoActive) log('heartbeat running=' + running, 'siteMode=' + siteMode, 'boxes=' + boxes.length); }, 5000);

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function getLayer() {
    if (!layer || !layer.isConnected) {
      layer = document.createElement('div');
      layer.id = 'ft-manga-layer';
      document.documentElement.appendChild(layer);
    }
    return layer;
  }

  function isMangaImg(img) {
    if (!img.complete || img.naturalWidth < 300 || img.naturalHeight < 300) return false;
    const r = img.getBoundingClientRect();
    if (r.width < 250 || r.height < 200) return false;
    return !img.closest('header, nav, footer, aside');
  }

  // Readers either stack many pages (webtoon style) or show one big page at a time.
  function isMangaPage() {
    const imgs = [...document.images].filter(isMangaImg);
    return imgs.length >= 2 || imgs.some((i) => i.naturalHeight >= 2000 || fillsScreen(i));
  }

  function fillsScreen(img) {
    const r = img.getBoundingClientRect();
    return r.height >= innerHeight * 0.5 || r.width * r.height >= innerWidth * innerHeight * 0.25;
  }

  // ---------- overlay boxes ----------
  function overlapRatio(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    if (w <= 0 || h <= 0) return 0;
    return (w * h) / Math.min(a.w * a.h, b.w * b.h);
  }

  function fitText(box) {
    const el = box.el;
    let size = parseFloat(el.style.fontSize) || 14;
    const limit = parseFloat(el.style.minHeight) * 1.5;
    while (el.scrollHeight > limit && size > 9) {
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }

  function position(box) {
    const el = box.el;
    const pad = 4;
    if (box.page) {
      Object.assign(el.style, {
        left: box.page.x - pad + 'px', top: box.page.y - pad + 'px',
        width: box.page.w + pad * 2 + 'px', minHeight: box.page.h + pad * 2 + 'px', display: '',
      });
      return;
    }
    const img = box.img;
    const r = img.isConnected ? img.getBoundingClientRect() : null;
    if (!r || !r.width || !img.naturalWidth) { el.style.display = 'none'; return; }
    const sx = r.width / img.naturalWidth;
    const sy = r.height / img.naturalHeight;
    const n = box.n;
    Object.assign(el.style, {
      display: '',
      left: r.left + scrollX + n.x * sx - pad + 'px',
      top: r.top + scrollY + n.y * sy - pad + 'px',
      width: n.w * sx + pad * 2 + 'px',
      minHeight: n.h * sy + pad * 2 + 'px',
    });
    const font = Math.max(10, Math.min(22, n.lineH * sy * 0.8));
    if (box.font !== font) {
      box.font = font;
      el.style.fontSize = font + 'px';
      fitText(box);
    }
  }

  let rafPending = false;
  function repositionAll() {
    if (rafPending || !boxes.length) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      boxes.forEach(position);
    });
  }

  function makeBox(text, original, manual) {
    const el = document.createElement('div');
    el.className = 'ft-manga-box' + (manual ? ' ft-manual' : '');
    el.textContent = text; // textContent only: never inject HTML
    el.title = original ? 'Gốc: ' + original + '\n(Bấm để xem ảnh gốc)' : '';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      el.classList.toggle('ft-peek');
    });
    getLayer().appendChild(el);
    return el;
  }

  function addImageBox(img, n, text, original, manual = false) {
    if (!manual) {
      const dup = boxes.some((b) => b.img === img && overlapRatio(b.n, n) > 0.5);
      if (dup) return;
    }
    const box = { el: makeBox(text, original, manual), img, n, manual };
    boxes.push(box);
    position(box);
  }

  function removeBoxes(pred) {
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (pred(boxes[i])) {
        boxes[i].el.remove();
        boxes.splice(i, 1);
      }
    }
  }

  // ---------- auto mode ----------
  function track(img) {
    if (tracked.has(img) || !isMangaImg(img)) return;
    tracked.set(img, newState(img));
  }

  // How images can be read on this site ('fetch' | 'canvas' | 'capture'), learned from the
  // first image so the next pages don't retry methods that already failed.
  let siteMode = null;

  function newState(img) {
    return {
      src: img.currentSrc || img.src,
      tiles: planTiles(img.naturalWidth, img.naturalHeight),
      done: new Set(),
      mode: siteMode,
    };
  }

  // Lazy-loading readers swap the src later: start over for that image.
  function syncState(img, st) {
    const src = img.currentSrc || img.src;
    if (st.src === src) return st;
    removeBoxes((b) => b.img === img && !b.manual);
    const fresh = newState(img);
    tracked.set(img, fresh);
    return fresh;
  }

  function pickJob() {
    let best = null;
    // Images we can read directly are prepared ahead (about 1.5 screens below), so the
    // translation is ready when the reader gets there. Screenshots only work on screen.
    // A tile is ~1300px tall on screen, so look at least ~2 tiles ahead.
    const ahead = siteMode === 'capture' ? 300 : Math.round(Math.max(innerHeight * 1.5, 2600));
    for (const [img, st0] of tracked) {
      if (!img.isConnected) { tracked.delete(img); continue; }
      if (!img.complete || !img.naturalWidth) continue;
      const st = syncState(img, st0);
      const r = img.getBoundingClientRect();
      if (!r.width || r.bottom < -600 || r.top > innerHeight + ahead + 300) continue;
      const sy = r.height / img.naturalHeight;
      st.tiles.forEach((t, i) => {
        if (st.done.has(i)) return;
        const top = r.top + t.y * sy;
        const bottom = r.top + (t.y + t.h) * sy;
        if (bottom < -300 || top > innerHeight + (st.mode === 'capture' ? 300 : ahead)) return;
        const dist = top > innerHeight ? top - innerHeight : bottom < 0 ? -bottom : 0;
        if (!best || dist < best.dist) best = { img, st, i, dist };
      });
    }
    return best;
  }

  // Draw part of the image to a canvas. Fails (returns null) for cross-origin images.
  function cropToDataUrl(img, t) {
    try {
      const c = document.createElement('canvas');
      c.width = t.w;
      c.height = t.h;
      c.getContext('2d').drawImage(img, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
      return c.toDataURL('image/png');
    } catch {
      return null;
    }
  }

  // Last resort: screenshot the visible part of the tile.
  async function captureVisible(img, t) {
    const r = img.getBoundingClientRect();
    const sx = r.width / img.naturalWidth;
    const sy = r.height / img.naturalHeight;
    const top = Math.max(0, r.top + t.y * sy);
    const bottom = Math.min(innerHeight, r.top + (t.y + t.h) * sy);
    const left = Math.max(0, r.left);
    const right = Math.min(innerWidth, r.right);
    const fullH = Math.min(t.h * sy, innerHeight);
    if (bottom - top < fullH * 0.6 || right - left < 50) return null; // wait until it's on screen
    const res = await withLayerHidden(() =>
      send({ type: 'ocrCapture', rect: { x: left, y: top, w: right - left, h: bottom - top }, dpr: devicePixelRatio })
    );
    if (!res || !res.ok) return null;
    // Drop text that came from something covering the page (ad banner, popup).
    const before = res.items.length;
    res.items = res.items.filter((it) => imageVisibleAt(img, it.x + it.w / 2, it.y + it.h / 2));
    if (res.items.length < before) res.covered = true;
    // Viewport px -> natural image px (using the rect from capture time).
    res.items = res.items.map((it) => ({
      ...it,
      x: (it.x - r.left) / sx, y: (it.y - r.top) / sy, w: it.w / sx, h: it.h / sy, lineH: it.lineH / sy,
    }));
    res.partial = true;
    return res;
  }

  // Is the comic image what the reader actually sees at this point of the screen?
  // Invisible click-zones (no text) over the image are fine; banners with text are not.
  function imageVisibleAt(img, x, y) {
    const top = document.elementsFromPoint(x, y).find((el) => !el.closest('#ft-manga-layer, #ft-select'));
    if (!top || top === img || top.contains(img)) return true;
    return !(top.innerText || '').trim();
  }

  async function withLayerHidden(fn) {
    const l = getLayer();
    l.style.visibility = 'hidden';
    await nextFrame();
    try {
      return await fn();
    } finally {
      l.style.visibility = '';
    }
  }

  async function runTile({ img, st, i }) {
    const t = st.tiles[i];
    const src = img.currentSrc || img.src;
    let res = null;

    if (st.mode !== 'capture') {
      if (st.mode !== 'canvas' && /^https?:/.test(src)) {
        res = await send({ type: 'ocrImage', src, region: { x: t.x, y: t.y, w: t.w, h: t.h }, pageUrl: location.href });
        // No answer (background restarted) or the OCR itself failed: that says nothing about
        // whether this site lets us fetch images, so retry the same tile shortly.
        if (!res || (!res.ok && res.kind === 'ocr')) { st.done.delete(i); await new Promise((r) => setTimeout(r, 1500)); return; }
        if (res.ok) st.mode = 'fetch';
        else res = null;
      }
      if (!res) {
        const dataUrl = cropToDataUrl(img, t);
        if (dataUrl) {
          res = await send({ type: 'ocrImage', dataUrl });
          if (!res || (!res.ok && res.kind === 'ocr')) { st.done.delete(i); await new Promise((r) => setTimeout(r, 1500)); return; }
          if (res.ok) {
            st.mode = 'canvas';
            res.items = res.items.map((it) => ({ ...it, x: it.x + t.x, y: it.y + t.y }));
          } else res = null;
        }
      }
      if (!res) st.mode = 'capture';
      siteMode = st.mode;
    }
    if (st.mode === 'capture') {
      res = await captureVisible(img, t);
      if (!res) { skipCount++; if (skipCount % 20 === 1) log('capture skipped (not on screen enough / failed) x' + skipCount, 'tile', i); st.done.delete(i); return; } // try again when it's on screen
      // Part of the page was hidden behind a banner: look again a bit later (a few times).
      st.retries = st.retries || {};
      if (res.covered && (st.retries[i] = (st.retries[i] || 0) + 1) <= 5) {
        setTimeout(() => { st.done.delete(i); pump(); }, 4000);
      }
    }
    if (syncState(img, st) !== st) return; // image changed while we were reading it

    let items = res.items;
    if (!res.partial) items = items.filter((it) => {
      const cy = it.y + it.h / 2;
      return cy >= t.coreTop && cy < t.coreBottom;
    });
    log('tile', i, 'mode=' + st.mode, 'ocr items=' + res.items.length, 'kept=' + items.length, items.map((it) => it.text));
    if (!items.length) return;

    const tr = await send({ type: 'translate', texts: items.map((it) => it.text) });
    if (!tr || !tr.ok) { st.done.delete(i); return; }
    items.forEach((it, k) => {
      if (tr.translations[k]) addImageBox(img, it, tr.translations[k], it.text);
    });
  }

  async function pump() {
    if (!autoActive || dead) return;
    // Screenshot mode stays one at a time (captures are rate-limited and hide our layer).
    // Until the first tile tells us how this site works, also go one at a time.
    const limit = siteMode === 'fetch' || siteMode === 'canvas' ? MAX_PARALLEL : 1;
    if (running >= limit) return;
    const job = pickJob();
    if (!job) return;
    log('pick tile', job.i, 'of', job.st.tiles.length, 'mode=' + job.st.mode, (job.img.currentSrc || job.img.src).slice(-40));
    running++;
    job.st.done.add(job.i);
    if (running < limit) setTimeout(pump, 0); // start another tile alongside this one
    try {
      await runTile(job);
    } catch (e) {
      log('runTile THREW', String(e));
      job.st.done.delete(job.i);
    } finally {
      running--;
      setTimeout(pump, 50);
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }

  function scan() {
    if (!isOn() || !settings.mangaAuto || dead) return;
    if (!autoActive) {
      if (!isMangaPage()) return;
      autoActive = true;
      log('manga mode ON', document.images.length, 'images');
    }
    [...document.images].forEach(track);
    pump();
  }

  function stopAuto() {
    autoActive = false;
  }

  // ---------- manual mode: Alt + drag ----------
  let drag = null;

  document.addEventListener('mousedown', (e) => {
    if (!e.altKey || e.button !== 0 || !isOn() || dead) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = document.createElement('div');
    sel.id = 'ft-select';
    document.documentElement.appendChild(sel);
    drag = { x: e.clientX, y: e.clientY, sel };
    updateSel(e);
  }, true);

  function updateSel(e) {
    const x = Math.min(drag.x, e.clientX);
    const y = Math.min(drag.y, e.clientY);
    Object.assign(drag.sel.style, {
      left: x + 'px', top: y + 'px',
      width: Math.abs(e.clientX - drag.x) + 'px', height: Math.abs(e.clientY - drag.y) + 'px',
    });
  }

  document.addEventListener('mousemove', (e) => {
    if (drag) { e.preventDefault(); updateSel(e); }
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = {
      x: Math.min(drag.x, e.clientX), y: Math.min(drag.y, e.clientY),
      w: Math.abs(e.clientX - drag.x), h: Math.abs(e.clientY - drag.y),
    };
    drag.sel.remove();
    drag = null;
    if (rect.w >= 12 && rect.h >= 12) translateArea(rect);
  }, true);

  // Stop the click that follows an Alt-drag from opening links / turning pages.
  document.addEventListener('click', (e) => {
    if (e.altKey && isOn()) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  function imageUnder(rect) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    return [...document.images].find((img) => {
      const r = img.getBoundingClientRect();
      return img.naturalWidth && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    });
  }

  // Read the selected part straight from the image file, like auto mode does. Screenshots
  // only work after the user clicks the extension icon on that tab (Chrome's activeTab rule).
  // Returns items in the image's natural pixels, or null if the image can't be read this way.
  async function readSelectionFromImage(img, imgRect, rect) {
    const src = img.currentSrc || img.src;
    const sx = imgRect.width / img.naturalWidth;
    const sy = imgRect.height / img.naturalHeight;
    const x = Math.max(0, Math.round((rect.x - imgRect.left) / sx));
    const y = Math.max(0, Math.round((rect.y - imgRect.top) / sy));
    const region = {
      x, y,
      w: Math.min(img.naturalWidth - x, Math.round(rect.w / sx)),
      h: Math.min(img.naturalHeight - y, Math.round(rect.h / sy)),
    };
    if (region.w < 8 || region.h < 8) return null;
    if (siteMode !== 'canvas' && /^https?:/.test(src)) {
      const res = await send({ type: 'ocrImage', src, region, pageUrl: location.href });
      if (res && res.ok) return res;
    }
    const dataUrl = cropToDataUrl(img, region);
    if (dataUrl) {
      const res = await send({ type: 'ocrImage', dataUrl });
      if (res && res.ok) {
        res.items = res.items.map((it) => ({ ...it, x: it.x + region.x, y: it.y + region.y }));
        return res;
      }
    }
    return null;
  }

  async function translateArea(rect) {
    const page = { x: rect.x + scrollX, y: rect.y + scrollY, w: rect.w, h: rect.h };
    const img = imageUnder(rect);
    const imgRect = img && img.getBoundingClientRect();

    const temp = { el: makeBox('Đang đọc chữ…', '', true), page };
    temp.el.classList.add('ft-loading');
    temp.el.style.fontSize = '13px';
    boxes.push(temp);
    position(temp);

    let res = img && imgRect.width ? await readSelectionFromImage(img, imgRect, rect) : null;
    const natural = !!res; // items are in image pixels (else: screen pixels from a screenshot)
    if (!res) {
      res = await withLayerHidden(() => send({ type: 'ocrCapture', rect, dpr: devicePixelRatio }));
    }
    const items = res && res.ok ? res.items.sort((a, b) => a.y - b.y) : [];
    const text = items.map((it) => it.text).join(' ').trim();
    if (!text) {
      let msg = 'Không đọc được chữ ở vùng này';
      if (res && !res.ok) {
        msg = /activeTab/.test(res.error)
          ? 'Vùng này cần chụp màn hình: bấm vào biểu tượng extension một lần rồi thử lại'
          : 'Lỗi: ' + res.error;
      }
      temp.el.textContent = msg;
      setTimeout(() => removeBoxes((b) => b === temp), 4000);
      return;
    }
    temp.el.textContent = 'Đang dịch…';
    const tr = await send({ type: 'translate', texts: [text] });
    removeBoxes((b) => b === temp);
    const translation = tr && tr.ok ? tr.translations[0] : null;
    if (!translation) return;

    const lineH = items.reduce((s, it) => s + it.lineH, 0) / items.length || 18;
    if (img && imgRect.width) {
      const sx = imgRect.width / img.naturalWidth;
      const sy = imgRect.height / img.naturalHeight;
      const n = {
        x: (rect.x - imgRect.left) / sx, y: (rect.y - imgRect.top) / sy,
        w: rect.w / sx, h: rect.h / sy, lineH: natural ? lineH : lineH / sy,
      };
      // The user re-did this spot: drop auto boxes that were there.
      removeBoxes((b) => b.img === img && !b.manual && overlapRatio(b.n, n) > 0.3);
      addImageBox(img, n, translation, text, true);
    } else {
      const box = { el: makeBox(translation, text, true), page };
      box.el.style.fontSize = Math.max(11, Math.min(20, lineH * 0.8)) + 'px';
      boxes.push(box);
      position(box);
    }
  }

  // ---------- wiring ----------
  addEventListener('scroll', () => { repositionAll(); scheduleScan(); }, { capture: true, passive: true });
  addEventListener('resize', () => { boxes.forEach((b) => (b.font = null)); repositionAll(); });
  document.addEventListener('load', (e) => { if (e.target.tagName === 'IMG') scheduleScan(); }, true);
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'],
  });
  // Every second: catch layout shifts (ads, lazy images above) and hide boxes whose
  // part of the page is currently covered by a banner/popup.
  setInterval(() => {
    repositionAll();
    for (const b of boxes) {
      if (!b.img) continue;
      const r = b.el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cy < 0 || cy > innerHeight || cx < 0 || cx > innerWidth) continue;
      b.el.style.visibility = imageVisibleAt(b.img, cx, cy) ? '' : 'hidden';
    }
  }, 1000);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of ['enabled', 'disabledSites', 'mangaAuto']) {
      if (changes[key]) settings[key] = changes[key].newValue;
    }
    if (isOn() && settings.mangaAuto) scheduleScan();
    else stopAuto();
  });

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'mangaStatus') sendResponse({ active: autoActive, images: tracked.size, boxes: boxes.length });
  });

  chrome.storage.local.get(['enabled', 'disabledSites', 'mangaAuto']).then((s) => {
    for (const [k, v] of Object.entries(s)) if (v !== undefined) settings[k] = v;
    scan();
    setTimeout(scan, 2500);
  });
})();
