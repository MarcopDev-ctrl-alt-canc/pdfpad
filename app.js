import * as pdfjsLib from './lib/pdf.min.js';
import { penPath, hlPath, dSeg } from './ink.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.js';

const COLORS = { pen: ['#111111', '#1d4ed8', '#dc2626', '#15803d'], hl: ['#fde047', '#86efac', '#f9a8d4', '#93c5fd'] };
const SIZES = { pen: [1.2, 2.4, 4.5], hl: [8, 14, 22] };
const HL_ALPHA = 0.45;
const ERASER_R = 8;
const MAX_CANVAS_PX = 12e6;
const ZOOM_MIN = 0.5, ZOOM_MAX = 5;

const $ = s => document.querySelector(s);
const viewer = $('#viewer'), pagesEl = $('#pages'), thumbsEl = $('#thumbs'), emptyEl = $('#empty');
const st = { tool: 'pen', color: { pen: COLORS.pen[0], hl: COLORS.hl[0] }, size: { pen: 1, hl: 1 }, zoom: 1, finger: false };
let doc = null, bytes = null, fileName = '', pages = [], maxW = 1;
let undoStack = [], redoStack = [], dirty = false, live = null, lastPen = 0, readyFile = null;
const paths = new WeakMap();
const absUrl = p => new URL(p, location.href).href;

const dbp = new Promise((ok, ko) => {
  const r = indexedDB.open('pdfpad', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => ok(r.result);
  r.onerror = () => ko(r.error);
});
async function idb(method, ...args) {
  const db = await dbp;
  return new Promise((ok, ko) => {
    const r = db.transaction('kv', method === 'get' ? 'readonly' : 'readwrite').objectStore('kv')[method](...args);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ko(r.error);
  });
}
const saveInk = () => idb('put', { strokes: pages.map(g => g.strokes), dirty }, 'ink').catch(console.error);

const io = new IntersectionObserver(es => {
  for (const e of es) {
    const g = pages[e.target.dataset.i];
    if (!g) continue;
    g.near = e.isIntersecting;
    g.near ? draw(g) : free(g);
  }
}, { root: viewer, rootMargin: '1200px 0px' });

async function open(data, name, strokes) {
  emptyEl.textContent = 'Caricamento…';
  emptyEl.hidden = false;
  let d;
  try {
    d = await pdfjsLib.getDocument({
      data: data.slice(), cMapUrl: absUrl('lib/cmaps/'), cMapPacked: true, standardFontDataUrl: absUrl('lib/standard_fonts/')
    }).promise;
  } catch (err) {
    emptyEl.textContent = 'Impossibile aprire il PDF: ' + err.message;
    emptyEl.hidden = !!doc;
    if (doc) alert(emptyEl.textContent);
    return false;
  }
  io.disconnect();
  doc?.destroy();
  doc = d; bytes = data; fileName = name;
  pages = []; undoStack = []; redoStack = [];
  pagesEl.textContent = ''; thumbsEl.textContent = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n);
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.i = n - 1;
    const c = document.createElement('canvas'), ink = document.createElement('canvas');
    ink.className = 'ink';
    el.append(c, ink);
    pagesEl.append(el);
    pages.push({ p, vp: p.getViewport({ scale: 1 }), el, c, ink, strokes: strokes?.[n - 1] || [], scale: 0, near: false, task: null });
  }
  maxW = Math.max(...pages.map(g => g.vp.width));
  viewer.scrollTo(0, 0);
  layout();
  pages.forEach(g => io.observe(g.el));
  emptyEl.hidden = true;
  $('#save').disabled = $('#thumbsBtn').disabled = false;
  $('#undo').disabled = $('#redo').disabled = true;
  if (!thumbsEl.hidden) buildThumbs();
  updatePageNum();
  return true;
}

const scale = () => (viewer.clientWidth - 24) / maxW * st.zoom;

function layout() {
  const s = scale();
  for (const g of pages) {
    g.el.style.width = g.vp.width * s + 'px';
    g.el.style.height = g.vp.height * s + 'px';
  }
  pages.filter(g => g.near).forEach(draw);
}

function pixelRatio(g, s) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const px = g.vp.width * g.vp.height * (s * dpr) ** 2;
  return px > MAX_CANVAS_PX ? dpr * Math.sqrt(MAX_CANVAS_PX / px) : dpr;
}

async function draw(g) {
  const s = scale(), r = s * pixelRatio(g, s);
  if (g.scale === r) return;
  g.scale = r;
  g.task?.cancel();
  const vp = g.p.getViewport({ scale: r });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  const task = g.task = g.p.render({ canvasContext: c.getContext('2d'), viewport: vp });
  try { await task.promise; } catch { return; }
  if (g.scale !== r) return;
  g.c.replaceWith(c);
  g.c = c;
  g.ink.width = c.width;
  g.ink.height = c.height;
  paintInk(g);
}

function free(g) {
  g.task?.cancel();
  g.scale = 0;
  g.c.width = g.c.height = g.ink.width = g.ink.height = 0;
}

function strokePath(s) {
  let p = paths.get(s);
  if (!p) {
    p = new Path2D(s.tool === 'hl' ? hlPath(s.pts) : penPath(s.pts, s.w));
    if (s !== live?.s) paths.set(s, p);
  }
  return p;
}

function paintInk(g) {
  const c = g.ink, ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  if (!c.width) return;
  const k = c.width / g.vp.width;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  const all = live?.g === g && live.s ? [...g.strokes, live.s] : g.strokes;
  for (const s of all) {
    if (s.tool === 'hl') {
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = HL_ALPHA;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.w;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.stroke(strokePath(s));
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.fillStyle = s.color;
      ctx.fill(strokePath(s));
    }
  }
}

const pending = new Set();
function schedule(g) {
  if (!pending.size) requestAnimationFrame(() => { pending.forEach(paintInk); pending.clear(); });
  pending.add(g);
}

const canDraw = e => e.pointerType === 'pen' || (e.pointerType === 'mouse' && e.button === 0) || (e.pointerType === 'touch' && st.finger);

pagesEl.addEventListener('pointerdown', e => {
  const el = e.target.closest('.page');
  if (!el || live || !canDraw(e)) return;
  e.preventDefault();
  el.setPointerCapture(e.pointerId);
  const g = pages[el.dataset.i], r = el.getBoundingClientRect();
  live = {
    g, id: e.pointerId, r, k: g.vp.width / r.width, before: g.strokes.slice(),
    s: st.tool === 'eraser' ? null : { tool: st.tool, color: st.color[st.tool], w: SIZES[st.tool][st.size[st.tool]], pts: [] }
  };
  addPoints(e);
});
pagesEl.addEventListener('pointermove', e => { if (live?.id === e.pointerId) addPoints(e); });
pagesEl.addEventListener('pointerup', end);
pagesEl.addEventListener('pointercancel', end);

function addPoints(e) {
  const evs = e.getCoalescedEvents?.() || [];
  for (const ev of evs.length ? evs : [e]) {
    const x = (ev.clientX - live.r.left) * live.k, y = (ev.clientY - live.r.top) * live.k;
    if (!live.s) { erase(live.g, x, y); continue; }
    const pts = live.s.pts, last = pts[pts.length - 1];
    if (last && Math.hypot(x - last[0], y - last[1]) < 0.4) continue;
    const p = ev.pointerType === 'pen' ? ev.pressure : 0.5;
    pts.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(p * 1000) / 1000]);
  }
  if (e.pointerType === 'pen') lastPen = Date.now();
  schedule(live.g);
}

function erase(g, x, y) {
  const keep = g.strokes.filter(s => !s.pts.some((a, i) => dSeg(x, y, a, s.pts[i + 1] || a) < ERASER_R + s.w / 2));
  if (keep.length !== g.strokes.length) g.strokes = keep;
}

function end(e) {
  if (live?.id !== e.pointerId) return;
  const { g, s, before } = live;
  if (s) g.strokes.push(s);
  live = null;
  if (s || g.strokes.length !== before.length) {
    undoStack.push({ g, before, after: g.strokes.slice() });
    redoStack = [];
    changed();
  }
  schedule(g);
}

function step(from, to, key) {
  const a = from.pop();
  if (!a) return;
  a.g.strokes = a[key].slice();
  to.push(a);
  schedule(a.g);
  changed();
}

function changed() {
  dirty = true;
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  saveInk();
}

const stylus = e => [...e.touches].some(t => t.touchType === 'stylus');
viewer.addEventListener('touchstart', e => {
  if (stylus(e) || (st.finger && e.touches.length === 1) || Date.now() - lastPen < 500) e.preventDefault();
}, { passive: false });
viewer.addEventListener('touchmove', e => { if (stylus(e) || live) e.preventDefault(); }, { passive: false });

function setZoom(z, cx = viewer.clientWidth / 2, cy = viewer.clientHeight / 2) {
  if (!doc) return;
  const old = scale(), ax = viewer.scrollLeft + cx, ay = viewer.scrollTop + cy;
  st.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  layout();
  const f = scale() / old;
  viewer.scrollLeft = ax * f - cx;
  viewer.scrollTop = ay * f - cy;
}

let pinch = null;
viewer.addEventListener('gesturestart', e => {
  e.preventDefault();
  if (!doc || live) return;
  const r = viewer.getBoundingClientRect();
  pinch = { z: st.zoom, x: e.clientX - r.left, y: e.clientY - r.top };
  pagesEl.style.transformOrigin = `${viewer.scrollLeft + pinch.x}px ${viewer.scrollTop + pinch.y}px`;
});
viewer.addEventListener('gesturechange', e => {
  e.preventDefault();
  if (!pinch) return;
  const s = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinch.z * e.scale)) / pinch.z;
  pagesEl.style.transform = `scale(${s})`;
});
viewer.addEventListener('gestureend', e => {
  e.preventDefault();
  if (!pinch) return;
  pagesEl.style.transform = '';
  setZoom(pinch.z * e.scale, pinch.x, pinch.y);
  pinch = null;
});
viewer.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const r = viewer.getBoundingClientRect();
  setZoom(st.zoom * Math.exp(-e.deltaY / 200), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
$('#zoomIn').onclick = () => setZoom(st.zoom * 1.25);
$('#zoomOut').onclick = () => setZoom(st.zoom / 1.25);
addEventListener('resize', () => { if (doc) layout(); });

let pnQueued = false;
function updatePageNum() {
  pnQueued = false;
  const midY = viewer.scrollTop + viewer.clientHeight / 2;
  let i = 0;
  while (i < pages.length - 1 && pages[i + 1].el.offsetTop <= midY) i++;
  $('#pageNum').textContent = pages.length ? `${i + 1} / ${pages.length}` : '';
}
viewer.addEventListener('scroll', () => { if (!pnQueued) { pnQueued = true; requestAnimationFrame(updatePageNum); } }, { passive: true });

function buildThumbs() {
  thumbsEl.textContent = '';
  const tio = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    tio.unobserve(e.target);
    const g = pages[e.target.dataset.i], c = e.target.firstChild;
    g.p.render({ canvasContext: c.getContext('2d'), viewport: g.p.getViewport({ scale: c.width / g.vp.width }) });
  }), { root: thumbsEl, rootMargin: '400px 0px' });
  pages.forEach((g, i) => {
    const b = document.createElement('button'), c = document.createElement('canvas');
    c.width = 160;
    c.height = Math.round(160 * g.vp.height / g.vp.width);
    b.dataset.i = i;
    b.append(c, String(i + 1));
    b.onclick = () => {
      g.el.scrollIntoView({ block: 'start' });
      if (innerWidth < 700) toggleThumbs();
    };
    thumbsEl.append(b);
    tio.observe(b);
  });
}
function toggleThumbs() {
  thumbsEl.hidden = !thumbsEl.hidden;
  $('#thumbsBtn').classList.toggle('on', !thumbsEl.hidden);
  if (!thumbsEl.hidden && !thumbsEl.childElementCount) buildThumbs();
  if (doc) layout();
}
$('#thumbsBtn').onclick = toggleThumbs;

function renderTools() {
  document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === st.tool));
  const t = st.tool, inkTool = t !== 'eraser';
  $('#colors').hidden = $('#sizes').hidden = !inkTool;
  if (!inkTool) return;
  $('#colors').replaceChildren(...COLORS[t].map((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === st.color[t] ? ' on' : '');
    b.style.background = c;
    b.setAttribute('aria-label', 'Colore ' + (i + 1));
    b.onclick = () => { st.color[t] = c; renderTools(); };
    return b;
  }));
  document.querySelectorAll('#sizes button').forEach(b => b.classList.toggle('on', +b.dataset.size === st.size[t]));
}
$('#tools').onclick = e => { const t = e.target.dataset.tool; if (t) { st.tool = t; renderTools(); } };
$('#sizes').onclick = e => { const s = e.target.dataset.size; if (s) { st.size[st.tool] = +s; renderTools(); } };
$('#finger').onchange = e => { st.finger = e.target.checked; };
$('#undo').onclick = () => step(undoStack, redoStack, 'before');
$('#redo').onclick = () => step(redoStack, undoStack, 'after');
renderTools();

$('#open').onclick = () => $('#file').click();
$('#file').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (dirty && !confirm('Le annotazioni non esportate del documento aperto andranno perse. Continuare?')) return;
  const data = new Uint8Array(await f.arrayBuffer());
  if (!await open(data, f.name, null)) return;
  dirty = false;
  await idb('put', { bytes: data, name: f.name }, 'doc').catch(console.error);
  saveInk();
};

const hex = h => PDFLib.rgb(...[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));

async function buildPdf() {
  const { PDFDocument, BlendMode, LineCapStyle, LineJoinStyle, pushGraphicsState, popGraphicsState, setLineJoin } = PDFLib;
  const out = await PDFDocument.load(bytes);
  pages.forEach((g, i) => {
    if (!g.strokes.length) return;
    const page = out.getPage(i);
    for (const s of g.strokes) {
      const pts = s.pts.map(([x, y, p]) => { const [X, Y] = g.vp.convertToPdfPoint(x, y); return [X, -Y, p]; });
      if (s.tool === 'hl') {
        page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round));
        page.drawSvgPath(hlPath(pts), {
          x: 0, y: 0, borderColor: hex(s.color), borderWidth: s.w, borderOpacity: HL_ALPHA,
          borderLineCap: LineCapStyle.Round, blendMode: BlendMode.Multiply
        });
        page.pushOperators(popGraphicsState());
      } else {
        page.drawSvgPath(penPath(pts, s.w), { x: 0, y: 0, color: hex(s.color) });
      }
    }
  });
  const name = fileName.replace(/\.pdf$/i, '') + '_annotato.pdf';
  return new File([await out.save()], name, { type: 'application/pdf' });
}

$('#save').onclick = async () => {
  const b = $('#save');
  b.disabled = true;
  b.textContent = 'Preparo…';
  try {
    readyFile = await buildPdf();
    $('#share').hidden = !navigator.canShare?.({ files: [readyFile] });
    $('#ready').showModal();
  } catch (err) {
    alert('Errore durante l\'esportazione: ' + err.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Esporta';
  }
};
function exported() {
  dirty = false;
  saveInk();
  $('#ready').close();
}
$('#share').onclick = async () => {
  try {
    await navigator.share({ files: [readyFile] });
    exported();
  } catch (err) {
    if (err.name !== 'AbortError') alert(err.message);
  }
};
$('#download').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(readyFile);
  a.download = readyFile.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  exported();
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
navigator.storage?.persist?.();

(async () => {
  try {
    const d = await idb('get', 'doc');
    if (!d) return;
    const ink = await idb('get', 'ink');
    if (await open(d.bytes, d.name, ink?.strokes)) dirty = !!ink?.dirty;
  } catch (err) {
    console.error(err);
  }
})();
