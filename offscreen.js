// Offscreen document: loads images and reads the text on them with PaddleOCR
// (PP-OCRv5 English on ONNX Runtime). On real manga pages it found 27 bubbles where
// Tesseract found 21, at about 1s per tile. Everything ships in lib/paddle/ (no downloads).

let paddlePromise = null;
let paddleQueue = Promise.resolve(); // one inference at a time (an ONNX session is not re-entrant)

function getPaddle() {
  if (!paddlePromise) {
    paddlePromise = (async () => {
      const { ort, PaddleOcrService } = await import(chrome.runtime.getURL('lib/paddle/paddle.bundle.mjs'));
      ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/paddle/'); // never the CDN default
      // Several CPU threads need a cross-origin isolated page (set in manifest.json).
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) >> 1)) : 1;
      const model = (f) => chrome.runtime.getURL('lib/paddle/models/' + f);
      const service = new PaddleOcrService({
        model: {
          detection: model('PP-OCRv5_mobile_det_infer.ort'),
          recognition: model('en_PP-OCRv5_mobile_rec_infer.ort'),
          charactersDictionary: model('ppocrv5_en_dict.txt'),
        },
        session: { executionProviders: ['wasm'] },
        recognition: { mainThreadYieldMs: 0 },
        debugging: { verbose: false },
      });
      await service.initialize();
      return service;
    })().catch((e) => {
      paddlePromise = null; // let the next job try to start it again
      throw e;
    });
  }
  return paddlePromise;
}

// Keep the last few decoded images so the next tiles of a long strip don't re-download.
// Stores promises so parallel tiles of one image share a single download. Old entries
// are just dropped (not closed): another job may still be drawing from them.
const bitmapCache = new Map();
function loadBitmap(src) {
  if (bitmapCache.has(src)) return bitmapCache.get(src);
  const p = (async () => {
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) throw new Error('Tải ảnh lỗi HTTP ' + res.status);
    return createImageBitmap(await res.blob());
  })();
  p.catch(() => bitmapCache.delete(src));
  bitmapCache.set(src, p);
  if (bitmapCache.size > 3) bitmapCache.delete(bitmapCache.keys().next().value);
  return p;
}

// Paddle returns lines with boxes; turn them into the word/line shape groupLines() reads.
function paddleLines(res) {
  return res.lines.flat().map((l) => ({
    words: [{
      text: l.text,
      confidence: l.confidence * 100,
      bbox: { x0: l.box.x, y0: l.box.y, x1: l.box.x + l.box.width, y1: l.box.y + l.box.height },
    }],
  }));
}

// Read one region; returns speech bubbles in source-image coordinates.
async function readRegion(bmp, reg) {
  const scale = reg.w < 400 ? 2 : 1; // small manual selections: give the detector more pixels
  const canvas = new OffscreenCanvas(Math.round(reg.w * scale), Math.round(reg.h * scale));
  canvas.getContext('2d').drawImage(bmp, reg.x, reg.y, reg.w, reg.h, 0, 0, canvas.width, canvas.height);
  const service = await getPaddle();
  const job = paddleQueue.then(() => service.recognize(canvas, { noCache: true }));
  paddleQueue = job.catch(() => {});
  const res = await job;
  return groupLines(paddleLines(res)).map((c) => ({
    text: c.text,
    x: reg.x + c.bbox.x0 / scale,
    y: reg.y + c.bbox.y0 / scale,
    w: (c.bbox.x1 - c.bbox.x0) / scale,
    h: (c.bbox.y1 - c.bbox.y0) / scale,
    lineH: c.lineH / scale,
  }));
}

async function ocr({ src, dataUrl, region }) {
  let bmp;
  try {
    bmp = dataUrl ? await createImageBitmap(await (await fetch(dataUrl)).blob()) : await loadBitmap(src);
  } catch (e) {
    e.kind = 'load'; // the image itself can't be read this way: the page tries another way
    throw e;
  }
  try {
    const r = region || { x: 0, y: 0, w: bmp.width, h: bmp.height };
    const x = Math.max(0, Math.round(r.x));
    const y = Math.max(0, Math.round(r.y));
    const reg = { x, y, w: Math.min(bmp.width - x, Math.round(r.w)), h: Math.min(bmp.height - y, Math.round(r.h)) };
    const items = reg.w < 8 || reg.h < 8 ? [] : await readRegion(bmp, reg);
    return { items, width: bmp.width, height: bmp.height };
  } finally {
    if (dataUrl) bmp.close(); // cached page images stay open for the next tiles
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen' || msg.type !== 'ocr') return;
  ocr(msg)
    .then((r) => sendResponse({ ok: true, ...r }))
    // kind 'ocr' = the reader itself failed (e.g. still starting): worth retrying the same tile.
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e), kind: (e && e.kind) || 'ocr' }));
  return true;
});
