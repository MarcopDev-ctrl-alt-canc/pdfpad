import { toLines, toBlocks, buildDocx } from './docx.js';

const OCR_SCALE = 2.5, IMG_SCALE = 2;
const abs = p => new URL(p, location.href).href;

function loadScript(src) {
  return new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => ko(new Error('Per il primo uso dell\'OCR serve la connessione a internet.'));
    document.head.append(s);
  });
}

async function renderPage(g, scale) {
  const vp = g.p.getViewport({ scale }), c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  await g.p.render({ canvasContext: x, viewport: vp }).promise;
  return c;
}

const jpeg = c => new Promise(r => c.toBlob(b => b.arrayBuffer().then(a => r(new Uint8Array(a))), 'image/jpeg', 0.85));

export async function ocrPages(list, onProgress) {
  if (!window.Tesseract) await loadScript('lib/tesseract/tesseract.min.js');
  let n = 0;
  const worker = await Tesseract.createWorker('ita', 1, {
    workerPath: abs('lib/tesseract/worker.min.js'), corePath: abs('lib/tesseract/core'), langPath: abs('lib/tesseract/lang'),
    logger: m => { if (m.status === 'recognizing text') onProgress(n, m.progress); }
  });
  try {
    for (const g of list) {
      onProgress(n, 0);
      const { data } = await worker.recognize(await renderPage(g, OCR_SCALE));
      g.ocr = data.words.filter(w => w.text.trim() && w.confidence > 25).map(w => ({
        str: w.text, x: w.bbox.x0 / OCR_SCALE, y: w.bbox.y0 / OCR_SCALE,
        w: (w.bbox.x1 - w.bbox.x0) / OCR_SCALE, h: (w.bbox.y1 - w.bbox.y0) / OCR_SCALE
      }));
      n++;
    }
  } finally {
    await worker.terminate();
  }
}

async function pageItems(g, pdfjsLib) {
  const tc = await g.p.getTextContent(), items = [];
  for (const i of tc.items) {
    if (!i.str?.trim() || !i.width) continue;
    const t = pdfjsLib.Util.transform(g.vp.transform, i.transform), size = Math.hypot(t[2], t[3]);
    if (t[0] / Math.hypot(t[0], t[1]) < 0.99) continue;
    let f = null;
    try { f = g.p.commonObjs.get(i.fontName); } catch {}
    const name = f?.name || '';
    items.push({
      str: i.str, x: t[4], y: t[5], w: i.width, size: Math.round(size * 2) / 2,
      bold: !!f?.bold || /bold|black|heavy|semibold|demi/i.test(name), italic: !!f?.italic || /italic|oblique/i.test(name)
    });
  }
  if (!items.length && g.ocr) {
    for (const w of g.ocr) items.push({ str: w.str, x: w.x, y: w.y + w.h * 0.85, w: w.w, size: Math.max(6, Math.round(w.h * 1.3)), bold: false, italic: false });
  }
  return items;
}

function imageRects(g, pdfjsLib, ops) {
  const { OPS, Util } = pdfjsLib, stack = [], rects = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  ops.fnArray.forEach((fn, k) => {
    const a = ops.argsArray[k];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (a?.[0]) ctm = Util.transform(ctm, a[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) {
      const m = Util.transform(g.vp.transform, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]]);
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const x = Math.max(0, Math.min(...xs)), y = Math.max(0, Math.min(...ys));
      const w = Math.min(g.vp.width, Math.max(...xs)) - x, h = Math.min(g.vp.height, Math.max(...ys)) - y;
      if (w > 24 && h > 24) rects.push({ x, y, w, h });
    }
  });
  return rects;
}

export async function toWord(pages, pdfjsLib, onProgress) {
  const out = [];
  for (const [n, g] of pages.entries()) {
    onProgress(n);
    const ops = await g.p.getOperatorList();
    const items = await pageItems(g, pdfjsLib);
    const blocks = toBlocks(toLines(items), g.vp.width);
    const area = g.vp.width * g.vp.height;
    const rects = imageRects(g, pdfjsLib, ops).filter(r => !(items.length && r.w * r.h > area * 0.8));
    if (rects.length) {
      const c = await renderPage(g, IMG_SCALE);
      for (const r of rects) {
        const crop = document.createElement('canvas');
        crop.width = Math.max(1, Math.round(r.w * IMG_SCALE));
        crop.height = Math.max(1, Math.round(r.h * IMG_SCALE));
        crop.getContext('2d').drawImage(c, r.x * IMG_SCALE, r.y * IMG_SCALE, crop.width, crop.height, 0, 0, crop.width, crop.height);
        blocks.push({ type: 'image', y: r.y, w: r.w, h: r.h, data: await jpeg(crop) });
      }
    }
    out.push(blocks.sort((a, b) => a.y - b.y));
  }
  return buildDocx(out);
}

export async function toImages(pages, base, onProgress) {
  const files = [];
  for (const [n, g] of pages.entries()) {
    onProgress(n);
    files.push(new File([await jpeg(await renderPage(g, IMG_SCALE))], `${base}_pagina${n + 1}.jpg`, { type: 'image/jpeg' }));
  }
  return files;
}
