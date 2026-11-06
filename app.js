import * as pdfjsLib from './lib/pdf.min.js';
import { penPath, hlPath, dSeg } from './ink.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.js';

const COLORS = {
  pen: ['#111111', '#1d4ed8', '#dc2626', '#15803d'],
  hl: ['#fde047', '#86efac', '#f9a8d4', '#93c5fd'],
  text: ['#111111', '#1d4ed8', '#dc2626', '#15803d']
};
const SIZES = { pen: [1.2, 2.4, 4.5], hl: [8, 14, 22], text: [10, 14, 20] };
const HL_ALPHA = 0.45;
const ERASER_R = 8;
const NOTE = 22;
const MAX_CANVAS_PX = 12e6;
const ZOOM_MIN = 0.5, ZOOM_MAX = 5;
const NOTE_SVG = '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

const $ = s => document.querySelector(s);
const viewer = $('#viewer'), pagesEl = $('#pages'), thumbsEl = $('#thumbs'), emptyEl = $('#empty'), msgEl = $('#emptyMsg');
const st = {
  tool: 'pen', zoom: 1, finger: false,
  color: { pen: COLORS.pen[0], hl: COLORS.hl[0], text: COLORS.text[0] },
  size: { pen: 1, hl: 1, text: 1 }
};
let doc = null, bytes = null, fileName = '', pages = [], maxW = 1;
let undoStack = [], redoStack = [], dirty = false, live = null, lastPen = 0, readyFile = null;
let drag = null, swallow = false, note = null;
const paths = new WeakMap(), objOf = new WeakMap(), sizeOf = new WeakMap();
const isInk = s => s.tool === 'pen' || s.tool === 'hl';
const placing = () => st.tool === 'text' || st.tool === 'note';
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
  msgEl.textContent = 'Caricamento…';
  emptyEl.hidden = false;
  let d;
  try {
    d = await pdfjsLib.getDocument({
      data: data.slice(), cMapUrl: absUrl('lib/cmaps/'), cMapPacked: true, standardFontDataUrl: absUrl('lib/standard_fonts/')
    }).promise;
  } catch (err) {
    msgEl.textContent = 'Impossibile aprire il PDF: ' + err.message;
    emptyEl.hidden = !!doc;
    if (doc) alert(msgEl.textContent);
    return false;
  }
  io.disconnect();
  doc?.destroy();
  doc = d; bytes = data; fileName = name;
  pages = []; undoStack = []; redoStack = [];
  pagesEl.textContent = ''; thumbsEl.textContent = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n), vp = p.getViewport({ scale: 1 });
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.i = n - 1;
    const c = document.createElement('canvas'), ink = document.createElement('canvas'), layer = document.createElement('div');
    ink.className = 'ink';
    layer.className = 'annots';
    layer.style.width = vp.width + 'px';
    layer.style.height = vp.height + 'px';
    el.append(c, ink, layer);
    pagesEl.append(el);
    pages.push({ p, vp, el, c, ink, layer, strokes: strokes?.[n - 1] || [], scale: 0, near: false, task: null });
  }
  maxW = Math.max(...pages.map(g => g.vp.width));
  viewer.scrollTo(0, 0);
  layout();
  pages.forEach(renderAnnots);
  pages.forEach(g => io.observe(g.el));
  emptyEl.hidden = true;
  $('#hud').hidden = false;
  $('#save').disabled = $('#thumbsBtn').disabled = false;
  $('#undo').disabled = $('#redo').disabled = true;
  if (!thumbsEl.hidden) buildThumbs();
  updatePageNum();
  return true;
}

const scale = () => (viewer.clientWidth - 24) / maxW * st.zoom;

function layout() {
  const s = scale();
  $('#zoomPct').textContent = Math.round(st.zoom * 100) + '%';
  for (const g of pages) {
    g.el.style.width = g.vp.width * s + 'px';
    g.el.style.height = g.vp.height * s + 'px';
    g.layer.style.transform = `scale(${s})`;
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
    if (!isInk(s)) continue;
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

document.addEventListener('pointerdown', e => {
  swallow = false;
  const ed = document.querySelector('.annot.editing');
  if (ed && !ed.contains(e.target)) { ed.blur(); swallow = true; }
  if (note && !e.target.closest('#notePop')) { closeNote(); swallow = true; }
}, true);

pagesEl.addEventListener('pointerdown', e => {
  const el = e.target.closest('.page');
  if (!el || live || drag) return;
  const a = e.target.closest('.annot');
  if (placing()) {
    if (a && !a.isContentEditable) startDrag(e, el, a);
    return;
  }
  if (a?.classList.contains('note') && st.tool !== 'eraser') return;
  if (!canDraw(e)) return;
  e.preventDefault();
  el.setPointerCapture(e.pointerId);
  const g = pages[el.dataset.i], r = el.getBoundingClientRect();
  live = {
    g, id: e.pointerId, r, k: g.vp.width / r.width, before: g.strokes.slice(),
    s: st.tool === 'eraser' ? null : { tool: st.tool, color: st.color[st.tool], w: SIZES[st.tool][st.size[st.tool]], pts: [] }
  };
  addPoints(e);
});
pagesEl.addEventListener('pointermove', e => {
  if (live?.id === e.pointerId) addPoints(e);
  else if (drag?.id === e.pointerId) moveDrag(e);
});
pagesEl.addEventListener('pointerup', end);
pagesEl.addEventListener('pointercancel', end);

function addPoints(e) {
  const evs = e.getCoalescedEvents?.() || [];
  for (const ev of evs.length ? evs : [e]) {
    const x = (ev.clientX - live.r.left) * live.k, y = (ev.clientY - live.r.top) * live.k;
    if (!live.s) {
      if (erase(live.g, x, y)) renderAnnots(live.g);
      continue;
    }
    const pts = live.s.pts, last = pts[pts.length - 1];
    if (last && Math.hypot(x - last[0], y - last[1]) < 0.4) continue;
    const p = ev.pointerType === 'pen' ? ev.pressure : 0.5;
    pts.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(p * 1000) / 1000]);
  }
  if (e.pointerType === 'pen') lastPen = Date.now();
  schedule(live.g);
}

function hitBox(o, x, y) {
  const [w, h] = sizeOf.get(o) || [NOTE, NOTE];
  return x > o.x - ERASER_R && x < o.x + w + ERASER_R && y > o.y - ERASER_R && y < o.y + h + ERASER_R;
}

function erase(g, x, y) {
  const keep = g.strokes.filter(s => isInk(s)
    ? !s.pts.some((a, i) => dSeg(x, y, a, s.pts[i + 1] || a) < ERASER_R + s.w / 2)
    : !hitBox(s, x, y));
  if (keep.length === g.strokes.length) return false;
  const annotGone = g.strokes.some(s => !isInk(s) && !keep.includes(s));
  g.strokes = keep;
  return annotGone;
}

function end(e) {
  if (drag?.id === e.pointerId) return endDrag(e);
  if (live?.id !== e.pointerId) return;
  const { g, s, before } = live;
  if (s) g.strokes.push(s);
  live = null;
  if (s || g.strokes.length !== before.length) {
    undoStack.push({ g, before, after: g.strokes.slice() });
    redoStack = [];
    changed();
  }
  refresh(g);
}

function step(from, to, key) {
  document.querySelector('.annot.editing')?.blur();
  const a = from.pop();
  if (!a) return;
  a.g.strokes = a[key].slice();
  to.push(a);
  refresh(a.g);
  changed();
}

function refresh(g) {
  schedule(g);
  renderAnnots(g);
}

function mutate(g, fn) {
  const before = g.strokes.slice();
  fn();
  undoStack.push({ g, before, after: g.strokes.slice() });
  redoStack = [];
  changed();
  refresh(g);
}
const addAnnot = (g, o) => mutate(g, () => { g.strokes = [...g.strokes, o]; });
const replaceAnnot = (g, o, n) => mutate(g, () => {
  g.strokes = n ? g.strokes.map(s => s === o ? n : s) : g.strokes.filter(s => s !== o);
});

function annotEl(o) {
  const a = document.createElement('div');
  a.className = 'annot ' + o.tool;
  a.style.left = o.x + 'px';
  a.style.top = o.y + 'px';
  if (o.tool === 'text') {
    a.textContent = o.text;
    a.style.fontSize = o.size + 'px';
    a.style.color = o.color;
  } else {
    a.innerHTML = NOTE_SVG;
    a.title = o.text;
    a.setAttribute('aria-label', 'Commento: ' + o.text);
  }
  objOf.set(a, o);
  return a;
}

function renderAnnots(g) {
  g.layer.replaceChildren(...g.strokes.filter(s => !isInk(s)).map(annotEl));
  for (const a of g.layer.children) sizeOf.set(objOf.get(a), [a.offsetWidth, a.offsetHeight]);
}

function startDrag(e, el, a) {
  const g = pages[el.dataset.i], r = el.getBoundingClientRect();
  drag = { g, a, o: objOf.get(a), id: e.pointerId, sx: e.clientX, sy: e.clientY, k: g.vp.width / r.width, dx: 0, dy: 0, moved: false };
  a.setPointerCapture(e.pointerId);
}

function moveDrag(e) {
  const cx = e.clientX - drag.sx, cy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(cx, cy) < 6) return;
  drag.moved = true;
  drag.dx = cx * drag.k;
  drag.dy = cy * drag.k;
  drag.a.style.translate = `${drag.dx}px ${drag.dy}px`;
}

function endDrag(e) {
  const { g, o, dx, dy, moved } = drag;
  drag = null;
  if (!moved) return;
  swallow = true;
  if (e.type === 'pointercancel') return renderAnnots(g);
  replaceAnnot(g, o, { ...o, x: o.x + dx, y: o.y + dy });
}

pagesEl.addEventListener('click', e => {
  const el = e.target.closest('.page');
  if (!el || swallow) return;
  const g = pages[el.dataset.i], a = e.target.closest('.annot');
  if (a) {
    const o = objOf.get(a);
    if (o.tool === 'note' && st.tool !== 'eraser') openNote(g, o);
    else if (o.tool === 'text' && st.tool === 'text' && !a.isContentEditable) editText(g, o, a);
    return;
  }
  if (!placing()) return;
  const r = el.getBoundingClientRect(), k = g.vp.width / r.width;
  const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
  if (st.tool === 'note') return openNote(g, null, { tool: 'note', x: x - NOTE / 2, y: y - NOTE / 2, text: '' });
  const size = SIZES.text[st.size.text];
  const draft = { tool: 'text', x, y: y - size * 0.7, text: '', size, color: st.color.text };
  const t = annotEl(draft);
  g.layer.append(t);
  editText(g, null, t, draft);
});

function editText(g, old, a, draft = old) {
  try { a.contentEditable = 'plaintext-only'; } catch { a.contentEditable = 'true'; }
  a.classList.add('editing');
  a.focus();
  const sel = getSelection();
  sel.selectAllChildren(a);
  sel.collapseToEnd();
  a.addEventListener('blur', () => {
    const text = a.innerText.replace(/\n+$/, '');
    if (!text.trim()) old ? replaceAnnot(g, old, null) : renderAnnots(g);
    else if (!old) addAnnot(g, { ...draft, text });
    else if (text !== old.text) replaceAnnot(g, old, { ...old, text });
    else renderAnnots(g);
  }, { once: true });
}

function openNote(g, old, draft = old) {
  note = { g, old, draft };
  const pop = $('#notePop'), ta = $('#noteText');
  ta.value = draft.text;
  $('#noteDel').hidden = !old;
  pop.hidden = false;
  const r = g.el.getBoundingClientRect(), k = r.width / g.vp.width;
  const px = r.left + (draft.x + NOTE) * k + 8, py = r.top + draft.y * k;
  pop.style.left = Math.max(8, Math.min(px, innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = Math.max(8, Math.min(py, innerHeight - pop.offsetHeight - 8)) + 'px';
  ta.focus();
}

function closeNote(del) {
  if (!note) return;
  const { g, old, draft } = note;
  note = null;
  $('#notePop').hidden = true;
  const text = del ? '' : $('#noteText').value.trim();
  if (!text) { if (old) replaceAnnot(g, old, null); }
  else if (!old) addAnnot(g, { ...draft, text });
  else if (text !== old.text) replaceAnnot(g, old, { ...old, text });
}
$('#noteOk').onclick = () => closeNote();
$('#noteDel').onclick = () => closeNote(true);

function changed() {
  dirty = true;
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  saveInk();
}

const stylus = e => [...e.touches].some(t => t.touchType === 'stylus');
viewer.addEventListener('touchstart', e => {
  if (placing() || e.target.closest?.('.annot.note, .annot.editing, #notePop')) return;
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
$('#zoomPct').onclick = () => setZoom(1);
addEventListener('resize', () => { if (doc) layout(); });

let pnQueued = false;
function updatePageNum() {
  pnQueued = false;
  const midY = viewer.scrollTop + viewer.clientHeight / 2;
  let i = 0;
  while (i < pages.length - 1 && pages[i + 1].el.offsetTop <= midY) i++;
  $('#pageNum').textContent = pages.length ? `${i + 1} / ${pages.length}` : '';
  thumbsEl.querySelector('.cur')?.classList.remove('cur');
  thumbsEl.children[i]?.classList.add('cur');
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
  updatePageNum();
  if (doc) layout();
}
$('#thumbsBtn').onclick = toggleThumbs;

function renderTools() {
  document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === st.tool));
  const t = st.tool, inkTool = t in COLORS;
  $('#colors').hidden = $('#sizes').hidden = !inkTool;
  if (!inkTool) return;
  $('#colors').replaceChildren(...COLORS[t].map((c, i) => {
    const b = document.createElement('button');
    const dot = document.createElement('i');
    dot.style.setProperty('--c', c);
    b.append(dot);
    b.className = 'icon swatch' + (c === st.color[t] ? ' on' : '');
    b.setAttribute('aria-label', 'Colore ' + (i + 1));
    b.onclick = () => { st.color[t] = c; renderTools(); };
    return b;
  }));
  document.querySelectorAll('#sizes button').forEach(b => b.classList.toggle('on', +b.dataset.size === st.size[t]));
}
$('#tools').onclick = e => {
  const t = e.target.closest('[data-tool]')?.dataset.tool;
  if (!t) return;
  document.querySelector('.annot.editing')?.blur();
  st.tool = t;
  document.body.dataset.tool = t;
  renderTools();
};
document.body.dataset.tool = st.tool;
$('#sizes').onclick = e => { const s = e.target.closest('[data-size]')?.dataset.size; if (s) { st.size[st.tool] = +s; renderTools(); } };
$('#finger').onclick = e => {
  st.finger = !st.finger;
  e.currentTarget.classList.toggle('on', st.finger);
  e.currentTarget.setAttribute('aria-pressed', st.finger);
};
$('#undo').onclick = () => step(undoStack, redoStack, 'before');
$('#redo').onclick = () => step(redoStack, undoStack, 'after');
renderTools();

$('#open').onclick = $('#openBig').onclick = () => $('#file').click();
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

function baselineRatio() {
  const d = document.createElement('div');
  d.className = 'annot text';
  d.style.cssText = 'position:absolute;visibility:hidden;font-size:100px';
  d.innerHTML = 'H<i style="display:inline-block;width:1px;height:0"></i>';
  document.body.append(d);
  const r = (d.lastChild.getBoundingClientRect().top - d.getBoundingClientRect().top) / 100;
  d.remove();
  return r;
}

async function buildPdf() {
  const {
    PDFDocument, PDFHexString, StandardFonts, BlendMode, LineCapStyle, LineJoinStyle,
    pushGraphicsState, popGraphicsState, setLineJoin, degrees
  } = PDFLib;
  const out = await PDFDocument.load(bytes);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const chars = new Set(font.getCharacterSet());
  const base = baselineRatio();
  const noteAp = out.context.register(out.context.stream(
    'q 0.99 0.83 0.3 rg 0.47 0.21 0.06 RG 0.8 w 0.5 0.5 21 21 re B 1.4 w 1 J 6 15 m 16 15 l S 6 11 m 16 11 l S 6 7 m 12 7 l S Q',
    { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 22, 22] }
  ));
  pages.forEach((g, i) => {
    if (!g.strokes.length) return;
    const page = out.getPage(i);
    const pdf = (x, y) => g.vp.convertToPdfPoint(x, y);
    for (const s of g.strokes) {
      if (s.tool === 'text') {
        const [x0, y0] = pdf(0, 0), [x1, y1] = pdf(1, 0);
        const rotate = degrees(Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI);
        s.text.split('\n').forEach((line, n) => {
          const [X, Y] = pdf(s.x, s.y + s.size * (base + 1.2 * n));
          const safe = [...line].map(c => chars.has(c.codePointAt(0)) ? c : '?').join('');
          page.drawText(safe, { x: X, y: Y, size: s.size, font, color: hex(s.color), rotate });
        });
        continue;
      }
      if (s.tool === 'note') {
        const [ax, ay] = pdf(s.x, s.y), [bx, by] = pdf(s.x + NOTE, s.y + NOTE);
        const l = Math.min(ax, bx), b = Math.min(ay, by);
        page.node.addAnnot(out.context.register(out.context.obj({
          Type: 'Annot', Subtype: 'Text', Name: 'Comment', F: 4, Open: false, C: [0.99, 0.83, 0.3],
          Rect: [l, b, l + NOTE, b + NOTE], AP: { N: noteAp },
          Contents: PDFHexString.fromText(s.text), T: PDFHexString.fromText('PDF Pad')
        })));
        continue;
      }
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
  document.querySelector('.annot.editing')?.blur();
  closeNote();
  const b = $('#save');
  b.disabled = true;
  b.lastChild.textContent = 'Preparo…';
  try {
    readyFile = await buildPdf();
    $('#share').hidden = !navigator.canShare?.({ files: [readyFile] });
    $('#ready').showModal();
  } catch (err) {
    alert('Errore durante l\'esportazione: ' + err.message);
  } finally {
    b.disabled = false;
    b.lastChild.textContent = 'Salva';
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
