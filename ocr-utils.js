// Pure helpers for manga OCR: tiling tall images, grouping OCR lines into speech bubbles,
// and cleaning OCR text. No browser APIs here so it can be tested in Node.

const MIN_WORD_CONF = 45;   // drop words the OCR is unsure about (usually artwork noise)
const MIN_BUBBLE_CONF = 60; // drop whole bubbles with low average confidence

// Split a tall image (webtoon strip) into overlapping tiles.
// Each tile has a "core" band; a result belongs to the tile whose core contains its center,
// so text inside the overlap is never shown twice.
function planTiles(width, height, tileH = 1600, overlap = 240) {
  if (height <= tileH) return [{ x: 0, y: 0, w: width, h: height, coreTop: 0, coreBottom: height }];
  const tiles = [];
  const step = tileH - overlap;
  for (let y = 0; y < height; y += step) {
    const h = Math.min(tileH, height - y);
    const first = y === 0;
    const last = y + h >= height;
    tiles.push({
      x: 0, y, w: width, h,
      coreTop: first ? 0 : y + overlap / 2,
      coreBottom: last ? height : y + h - overlap / 2,
    });
    if (last) break;
  }
  return tiles;
}

function bboxOf(items) {
  return {
    x0: Math.min(...items.map((b) => b.x0)),
    y0: Math.min(...items.map((b) => b.y0)),
    x1: Math.max(...items.map((b) => b.x1)),
    y1: Math.max(...items.map((b) => b.y1)),
  };
}

const letterCount = (s) => (s.match(/[a-z]/gi) || []).length;

// Rebuild each OCR line from its confident, letter-bearing words only.
// OCR sometimes reads two bubbles side by side as one line, so a line is
// split wherever the gap between two words is much wider than the text height.
function cleanLines(lines) {
  const out = [];
  const push = (words) => {
    if (!words.length) return;
    const bbox = bboxOf(words.map((w) => w.bbox));
    out.push({
      text: words.map((w) => w.text).join(' '),
      conf: words.reduce((s, w) => s + w.confidence, 0) / words.length,
      bbox,
      h: bbox.y1 - bbox.y0,
    });
  };
  for (const line of lines) {
    const words = (line.words || [])
      .filter((w) => w.confidence >= MIN_WORD_CONF && /[a-z0-9]/i.test(w.text) && w.bbox.x1 > w.bbox.x0)
      .sort((a, b) => a.bbox.x0 - b.bbox.x0);
    let part = [];
    for (const w of words) {
      const prev = part[part.length - 1];
      const h = Math.max(w.bbox.y1 - w.bbox.y0, prev ? prev.bbox.y1 - prev.bbox.y0 : 0);
      if (prev && w.bbox.x0 - prev.bbox.x1 > h * 1.5) {
        push(part);
        part = [];
      }
      part.push(w);
    }
    push(part);
  }
  return out;
}

// Group lines that sit close together (same bubble) into clusters.
function groupLines(rawLines) {
  const lines = cleanLines(rawLines).sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const clusters = [];
  for (const line of lines) {
    let best = null;
    for (const c of clusters) {
      const lh = c.lineH;
      const gap = line.bbox.y0 - c.bbox.y1;
      if (gap > lh * 1.2 || gap < -lh * 1.5) continue;
      const sizeRatio = line.h / lh;
      if (sizeRatio < 0.55 || sizeRatio > 1.8) continue;
      const lineCx = (line.bbox.x0 + line.bbox.x1) / 2;
      const cCx = (c.bbox.x0 + c.bbox.x1) / 2;
      const halfW = Math.max(c.bbox.x1 - c.bbox.x0, line.bbox.x1 - line.bbox.x0) / 2;
      if (Math.abs(lineCx - cCx) > halfW + lh) continue;
      if (!best || gap < best.gap) best = { c, gap };
    }
    if (best) {
      const c = best.c;
      c.lines.push(line);
      c.bbox = bboxOf([c.bbox, line.bbox]);
      c.lineH = c.lines.reduce((s, l) => s + l.h, 0) / c.lines.length;
    } else {
      clusters.push({ lines: [line], bbox: { ...line.bbox }, lineH: line.h });
    }
  }

  return clusters
    .map((c) => {
      const words = c.lines.reduce((n, l) => n + l.text.split(' ').length, 0);
      const conf = c.lines.reduce((s, l) => s + l.conf * l.text.split(' ').length, 0) / words;
      return { text: cleanOcrText(c.lines.map((l) => l.text)), conf, bbox: c.bbox, lineH: c.lineH };
    })
    .filter((c) => c.conf >= MIN_BUBBLE_CONF && isProbablyText(c.text));
}

function isProbablyText(text) {
  if (letterCount(text) < 3) return false;
  // Scanlation watermarks ("Asurascans.Com") are not dialogue.
  if (/^\W*[\w-]+\.(com|net|org|io|xyz|me|co|to|gg|cc)\W*$/i.test(text.trim())) return false;
  // Needs at least one real-looking word (2+ letters) and mostly letters overall.
  if (!/[a-z]{2,}/i.test(text)) return false;
  // A lone short word is usually artwork misread as letters ("Ans"), unless it is
  // punctuated like real dialogue ("NO!", "Huh?").
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length === 1 && letterCount(text) < 4 && !/[!?…]/.test(text)) return false;
  const visible = text.replace(/\s/g, '');
  return letterCount(text) / visible.length >= 0.6;
}

// Join OCR lines into one sentence and undo manga ALL-CAPS so translation works better.
function cleanOcrText(lines) {
  let text = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/[a-z]-$/i.test(text)) text = text.slice(0, -1) + line; // SOME- / THING
    else text += (text ? ' ' : '') + line;
  }
  text = text
    .replace(/\|/g, 'I')
    .replace(/\b1s\b/gi, 'is') // common OCR slip: "IS" read as "1S"
    .replace(/[_~=*#<>{}\[\]\\]/g, ' ')
    .replace(/\s+([,.!?…])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  const letters = text.match(/[a-z]/gi) || [];
  const upper = letters.filter((c) => c === c.toUpperCase()).length;
  if (letters.length && upper / letters.length > 0.7) {
    text = text.toLowerCase()
      .replace(/(^|[.!?…]\s*|["“]\s*)([a-z])/g, (_, p, ch) => p + ch.toUpperCase())
      .replace(/\bi\b/g, 'I')
      .replace(/\bi'/g, "I'");
  }
  return text;
}

if (typeof module !== 'undefined') module.exports = { planTiles, groupLines, cleanOcrText, isProbablyText };
