import * as pdfjsLib from './lib/pdf.min.js';
import { penPath } from './ink.js';
import {
  HL_ALPHA, NOTE, STAMPS, isDom, resizable, bbox, hit, mapItem, paint, inkPath, exportItem, markRects
} from './items.js';
import { openOrganizer } from './organize.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.js';

const INK = ['#111111', '#1d4ed8', '#dc2626', '#15803d'];
const COLORS = {
  pen: INK, text: INK, shape: INK,
  hl: ['#fde047', '#86efac', '#f9a8d4', '#93c5fd'],
  mark: ['#facc15', '#22c55e', '#dc2626', '#2563eb'],
  sign: ['#111111', '#1d4ed8']
};
const SIZES = { pen: [1.2, 2.4, 4.5], hl: [8, 14, 22], text: [10, 14, 20], shape: [1, 2, 4] };
const ERASER_R = 8, SELECT_TOL = 6, STAMP_H = 34, SIG_W = 150;
const MAX_CANVAS_PX = 12e6;
const ZOOM_MIN = 0.5, ZOOM_MAX = 5;
const PLACING = new Set(['text', 'note', 'sign', 'stamp']);
const ICON = {
  rect: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  line: '<path d="M5 19 19 5"/>',
  arrow: '<path d="M5 19 19 5"/><path d="M10 5h9v9"/>',
  note: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>'
};
const svg = k => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;

const $ = s => document.querySelector(s);
const viewer = $('#viewer'), pagesEl = $('#pages'), thumbsEl = $('#thumbs'), emptyEl = $('#empty'), msgEl = $('#emptyMsg'), optsEl = $('#opts');
const st = {
  tool: 'pen', zoom: 1, finger: false, sig: null, stamp: 0,
  color: Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, v[0]])),
  size: { pen: 1, hl: 1, text: 1, shape: 1 },
  kind: { shape: 'rect', mark: 'hl' }
};
let doc = null, bytes = null, fileName = '', pages = [], maxW = 1, sigs = [];
let undoStack = [], redoStack = [], dirty = false, live = null, lastPen = 0, ready = null;
let drag = null, swallow = false, note = null, sel = null;
const paths = new WeakMap(), objOf = new WeakMap(), sizeOf = new WeakMap();
const sizeFn = o => sizeOf.get(o);
const placing = () => PLACING.has(st.tool);
const absUrl = p => new URL(p, location.href).href;
const today = () => new Date().toLocaleDateString('it-IT');

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
  pages = []; undoStack = []; redoStack = []; sel = null;
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
    pages.push({ p, vp, el, c, ink, layer, strokes: strokes?.[n - 1] || [], scale: 0, near: false, task: null, words: null, textP: null });
  }
  maxW = Math.max(...pages.map(g => g.vp.width));
  viewer.scrollTo(0, 0);
  layout();
  pages.forEach(renderAnnots);
  pages.forEach(g => io.observe(g.el));
  emptyEl.hidden = true;
  $('#hud').hidden = false;
  $('#save').disabled = $('#thumbsBtn').disabled = false;
  $('#orgBtn').hidden = false;
  $('#undo').disabled = $('#redo').disabled = true;
  if (!thumbsEl.hidden) buildThumbs();
  updatePageNum();
  renderOpts();
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
    g.layer.style.setProperty('--inv', 1 / s);
  }
  pages.filter(g => g.near).forEach(draw);
}

function pixelRatio(g, s) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const px = g.vp.width * g.vp.height * (s * dpr) ** 2;
  return px > MAX_CANVAS_PX ? dpr * Math.sqrt(MAX_CANVAS_PX / px) : dpr;
}

async function draw(g) {
  loadText(g);
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

function loadText(g) {
  return g.textP ??= g.p.getTextContent().then(tc => {
    g.words = [];
    for (const i of tc.items) {
      if (!i.str.trim() || !i.width) continue;
      const t = pdfjsLib.Util.transform(g.vp.transform, i.transform);
      const h = Math.hypot(t[2], t[3]), len = Math.hypot(t[0], t[1]);
      if (t[0] / len < 0.99) continue;
      g.words.push({ str: i.str, x: t[4], y: t[5] - h * 0.8, w: i.width, h });
    }
    return g.words;
  }).catch(() => (g.words = []));
}

function inkPath2D(o) {
  let p = paths.get(o);
  if (!p) {
    p = new Path2D(inkPath(o));
    if (o !== live?.s) paths.set(o, p);
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
  for (const o of all) if (!isDom(o)) paint(ctx, o, inkPath2D);
}

const pending = new Set();
function schedule(g) {
  if (!pending.size) requestAnimationFrame(() => { pending.forEach(paintInk); pending.clear(); });
  pending.add(g);
}

function refresh(g) {
  schedule(g);
  renderAnnots(g);
}

function changed() {
  dirty = true;
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  saveInk();
}

function commit(g, before) {
  if (g.strokes.length === before.length && g.strokes.every((s, i) => s === before[i])) return;
  undoStack.push({ g, before, after: g.strokes.slice() });
  redoStack = [];
  changed();
}

function mutate(g, fn) {
  const before = g.strokes.slice();
  fn();
  commit(g, before);
  refresh(g);
}
const addItem = (g, o) => mutate(g, () => { g.strokes = [...g.strokes, o]; });
const replaceItem = (g, o, n) => mutate(g, () => {
  g.strokes = n ? g.strokes.map(s => s === o ? n : s) : g.strokes.filter(s => s !== o);
});

function step(from, to, key) {
  blurEditing();
  const a = from.pop();
  if (!a) return;
  a.g.strokes = a[key].slice();
  to.push(a);
  setSel(null);
  refresh(a.g);
  changed();
}

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
    a.innerHTML = svg('note');
    a.title = o.text;
    a.setAttribute('aria-label', 'Commento: ' + o.text);
  }
  objOf.set(a, o);
  return a;
}

function renderAnnots(g) {
  g.layer.replaceChildren(...g.strokes.filter(isDom).map(annotEl));
  for (const a of g.layer.children) sizeOf.set(objOf.get(a), [a.offsetWidth, a.offsetHeight]);
  if (sel?.g === g) renderSel();
}

function renderSel() {
  document.querySelectorAll('.sel').forEach(e => e.remove());
  if (sel && !sel.g.strokes.includes(sel.o)) sel = null;
  if (!sel) return;
  const [x0, y0, x1, y1] = bbox(sel.o, sizeFn);
  const d = document.createElement('div');
  d.className = 'sel';
  Object.assign(d.style, { left: x0 + 'px', top: y0 + 'px', width: x1 - x0 + 'px', height: y1 - y0 + 'px' });
  if (resizable(sel.o)) d.append(Object.assign(document.createElement('i'), { className: 'handle' }));
  sel.g.layer.append(d);
}

function setSel(s) {
  sel = s;
  renderSel();
  renderOpts();
}

const blurEditing = () => document.querySelector('.annot.editing')?.blur();
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
    if (a && !a.isContentEditable && a.classList.contains(st.tool)) startDrag(e, el, a);
    return;
  }
  if (a?.classList.contains('note') && st.tool !== 'eraser' && st.tool !== 'select') return;
  if (!canDraw(e)) return;
  e.preventDefault();
  el.setPointerCapture(e.pointerId);
  const g = pages[el.dataset.i], r = el.getBoundingClientRect(), k = g.vp.width / r.width;
  const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
  live = { g, id: e.pointerId, r, k, x0: x, y0: y, before: g.strokes.slice(), s: null };
  const t = st.tool;
  if (t === 'pen' || t === 'hl') live.s = { tool: t, color: st.color[t], w: SIZES[t][st.size[t]], pts: [] };
  else if (t === 'shape') live.s = { tool: 'shape', kind: st.kind.shape, color: st.color.shape, w: SIZES.shape[st.size.shape], x1: x, y1: y, x2: x, y2: y };
  else if (t === 'mark') {
    if (!g.words) { loadText(g); live = null; return; }
    live.s = { tool: 'mark', kind: st.kind.mark, color: st.color.mark, rects: [], text: '' };
  } else if (t === 'select') selectDown(g, x, y);
  move(e);
});

pagesEl.addEventListener('pointermove', e => {
  if (live?.id === e.pointerId) move(e);
  else if (drag?.id === e.pointerId) moveDrag(e);
});
pagesEl.addEventListener('pointerup', end);
pagesEl.addEventListener('pointercancel', end);

function move(e) {
  const evs = e.getCoalescedEvents?.() || [];
  for (const ev of evs.length ? evs : [e]) {
    const x = (ev.clientX - live.r.left) * live.k, y = (ev.clientY - live.r.top) * live.k;
    const s = live.s;
    if (st.tool === 'eraser') {
      const keep = live.g.strokes.filter(o => !hit(o, x, y, ERASER_R, sizeFn));
      if (keep.length !== live.g.strokes.length) {
        const domGone = live.g.strokes.some(o => isDom(o) && !keep.includes(o));
        live.g.strokes = keep;
        if (domGone) renderAnnots(live.g);
      }
    } else if (s?.pts) {
      const last = s.pts[s.pts.length - 1];
      if (last && Math.hypot(x - last[0], y - last[1]) < 0.4) continue;
      const p = ev.pointerType === 'pen' ? ev.pressure : 0.5;
      s.pts.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(p * 1000) / 1000]);
    } else if (s?.tool === 'shape') {
      s.x2 = x; s.y2 = y;
    } else if (s?.tool === 'mark') {
      Object.assign(s, markRects(live.g.words, live.x0, live.y0, x, y));
    } else if (st.tool === 'select') {
      selectMove(x, y);
    }
  }
  if (e.pointerType === 'pen') lastPen = Date.now();
  schedule(live.g);
}

function end(e) {
  if (drag?.id === e.pointerId) return endDrag(e);
  if (live?.id !== e.pointerId) return;
  const { g, s, before } = live;
  const keep = s && (s.pts?.length || s.rects?.length || (s.tool === 'shape' && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 3));
  if (keep) g.strokes.push(s);
  live = null;
  commit(g, before);
  refresh(g);
}

function selectDown(g, x, y) {
  const tol = SELECT_TOL * live.k;
  if (sel?.g === g && resizable(sel.o)) {
    const [, , x1, y1] = bbox(sel.o, sizeFn);
    if (Math.hypot(x - x1, y - y1) < 14 * live.k) { live.resize = { box: bbox(sel.o, sizeFn), orig: sel.o }; return; }
  }
  const o = [...g.strokes].reverse().find(o => hit(o, x, y, tol, sizeFn));
  setSel(o ? { g, o } : null);
  if (o) live.moveFrom = o;
}

function selectMove(x, y) {
  const dx = x - live.x0, dy = y - live.y0, g = live.g;
  if (!live.moved && Math.hypot(dx, dy) < 2 * live.k) return;
  live.moved = true;
  let n;
  if (live.moveFrom) n = mapItem(live.moveFrom, ([px, py]) => [px + dx, py + dy], 1);
  else if (live.resize) {
    const [x0, y0, x1, y1] = live.resize.box;
    const s = Math.max(0.15, Math.max((x1 - x0 + dx) / (x1 - x0), (y1 - y0 + dy) / (y1 - y0)));
    n = mapItem(live.resize.orig, ([px, py]) => [x0 + (px - x0) * s, y0 + (py - y0) * s], s);
  } else return;
  g.strokes = g.strokes.map(s => s === sel.o ? n : s);
  sel.o = n;
  if (isDom(n)) renderAnnots(g); else renderSel();
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
  replaceItem(g, o, mapItem(o, ([x, y]) => [x + dx, y + dy], 1));
}

pagesEl.addEventListener('click', e => {
  const el = e.target.closest('.page');
  if (!el || swallow) return;
  const g = pages[el.dataset.i], a = e.target.closest('.annot');
  if (a) {
    const o = objOf.get(a);
    if (o.tool === 'note' && st.tool !== 'eraser' && st.tool !== 'select') return openNote(g, o);
    if (o.tool === 'text' && st.tool === 'text' && !a.isContentEditable) return editText(g, o, a);
    if (st.tool !== 'sign' && st.tool !== 'stamp') return;
  }
  if (!placing()) return;
  const r = el.getBoundingClientRect(), k = g.vp.width / r.width;
  const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
  if (st.tool === 'note') return openNote(g, null, { tool: 'note', x: x - NOTE / 2, y: y - NOTE / 2, text: '' });
  if (st.tool === 'sign') {
    const sig = sigs[st.sig];
    if (!sig) return openPad();
    let w = SIG_W, h = w / sig.ratio;
    if (h > 80) { h = 80; w = h * sig.ratio; }
    return addItem(g, { tool: 'sig', color: st.color.sign, paths: sig.paths, x: x - w / 2, y: y - h / 2, w, h });
  }
  if (st.tool === 'stamp') {
    const [label, color] = STAMPS[st.stamp], date = today(), h = STAMP_H;
    const m = document.createElement('canvas').getContext('2d');
    m.font = `700 ${h * 0.4}px Helvetica, Arial, sans-serif`;
    const w = Math.max(m.measureText(label).width, m.measureText(date).width * 0.5) + h * 0.8;
    return addItem(g, { tool: 'stamp', label, color, date, x: x - w / 2, y: y - h / 2, w, h });
  }
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
  const range = getSelection();
  range.selectAllChildren(a);
  range.collapseToEnd();
  a.addEventListener('blur', () => {
    const text = a.innerText.replace(/\n+$/, '');
    if (!text.trim()) old ? replaceItem(g, old, null) : renderAnnots(g);
    else if (!old) addItem(g, { ...draft, text });
    else if (text !== old.text) replaceItem(g, old, { ...old, text });
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
  if (!text) { if (old) replaceItem(g, old, null); }
  else if (!old) addItem(g, { ...draft, text });
  else if (text !== old.text) replaceItem(g, old, { ...old, text });
}
$('#noteOk').onclick = () => closeNote();
$('#noteDel').onclick = () => closeNote(true);

const pad = $('#sigPad');
let padStrokes = [], padLive = null;
function openPad() {
  padStrokes = [];
  $('#sigDlg').showModal();
  const r = pad.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  pad.width = r.width * dpr;
  pad.height = r.height * dpr;
  drawPad();
}
function drawPad() {
  const ctx = pad.getContext('2d'), dpr = pad.width / pad.getBoundingClientRect().width;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pad.width, pad.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#111';
  for (const s of padLive ? [...padStrokes, padLive] : padStrokes) if (s.pts.length) ctx.fill(new Path2D(penPath(s.pts, s.w)));
}
const padPoint = (e, r) => [e.clientX - r.left, e.clientY - r.top, e.pointerType === 'pen' ? e.pressure : 0.5];
pad.addEventListener('pointerdown', e => {
  e.preventDefault();
  pad.setPointerCapture(e.pointerId);
  padLive = { w: 3.2, pts: [padPoint(e, pad.getBoundingClientRect())], id: e.pointerId };
  drawPad();
});
pad.addEventListener('pointermove', e => {
  if (padLive?.id !== e.pointerId) return;
  const r = pad.getBoundingClientRect();
  for (const ev of e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e]) padLive.pts.push(padPoint(ev, r));
  drawPad();
});
const padEnd = e => {
  if (padLive?.id !== e.pointerId) return;
  padStrokes.push({ w: padLive.w, pts: padLive.pts });
  padLive = null;
  drawPad();
};
pad.addEventListener('pointerup', padEnd);
pad.addEventListener('pointercancel', padEnd);
$('#sigClear').onclick = () => { padStrokes = []; drawPad(); };
$('#sigSave').onclick = () => {
  if (!padStrokes.length) return;
  const all = padStrokes.flatMap(s => s.pts), m = 4;
  const x0 = Math.min(...all.map(p => p[0])) - m, y0 = Math.min(...all.map(p => p[1])) - m;
  const W = Math.max(...all.map(p => p[0])) + m - x0, H = Math.max(...all.map(p => p[1])) + m - y0;
  sigs.push({
    ratio: W / H,
    paths: padStrokes.map(s => ({ w: s.w / W, pts: s.pts.map(([x, y, p]) => [+((x - x0) / W).toFixed(4), +((y - y0) / H).toFixed(4), p]) }))
  });
  st.sig = sigs.length - 1;
  idb('put', sigs, 'sigs').catch(console.error);
  $('#sigDlg').close();
  renderOpts();
};

function sigThumb(sig) {
  const c = document.createElement('canvas'), h = 30, w = Math.min(110, h * sig.ratio), dpr = 2;
  c.width = w * dpr;
  c.height = h * dpr;
  c.style.width = w + 'px';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = getComputedStyle(document.body).color;
  const o = { paths: sig.paths, x: 0, y: 0, w, h: w / sig.ratio };
  ctx.fill(new Path2D(inkPath({ tool: 'sig', ...o })));
  return c;
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

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}
const optBtn = (props, on, onclick, ...kids) => el('button', { ...props, className: (props.className || '') + (on ? ' on' : ''), onclick }, ...kids);
const group = (...kids) => el('div', { className: 'seg' }, ...kids);
const hint = text => el('span', { className: 'hint', textContent: text });

function swatches(key, apply = c => { st.color[key] = c; renderOpts(); }, current = st.color[key]) {
  return el('div', { className: 'group' }, ...COLORS[key].map((c, i) => {
    const dot = el('i');
    dot.style.setProperty('--c', c);
    return optBtn({ className: 'icon swatch', ariaLabel: 'Colore ' + (i + 1) }, c === current, () => apply(c), dot);
  }));
}

function sizes(key) {
  return group(...[4, 8, 13].map((d, i) => {
    const dot = el('i');
    dot.style.setProperty('--d', d + 'px');
    return optBtn({ className: 'icon dot', ariaLabel: ['Sottile', 'Medio', 'Spesso'][i] }, st.size[key] === i, () => { st.size[key] = i; renderOpts(); }, dot);
  }));
}

function kinds(key, list) {
  return group(...list.map(([v, label, icon]) => {
    const b = optBtn({ className: icon ? 'icon' : '', ariaLabel: label, title: label }, st.kind[key] === v, () => { st.kind[key] = v; renderOpts(); });
    if (icon) b.innerHTML = svg(icon); else b.textContent = label;
    return b;
  }));
}

function renderOpts() {
  const t = st.tool, parts = [];
  if (t === 'pen' || t === 'hl') parts.push(swatches(t), sizes(t));
  if (t === 'shape') parts.push(kinds('shape', [['rect', 'Rettangolo', 'rect'], ['ellipse', 'Ellisse', 'ellipse'], ['line', 'Linea', 'line'], ['arrow', 'Freccia', 'arrow']]), swatches('shape'), sizes('shape'));
  if (t === 'mark') parts.push(kinds('mark', [['hl', 'Evidenzia'], ['under', 'Sottolinea'], ['strike', 'Barra']]), swatches('mark'), hint('Trascina sul testo'));
  if (t === 'text') parts.push(swatches('text'), sizes('text'), hint('Tocca la pagina per scrivere'));
  if (t === 'note') parts.push(hint('Tocca la pagina per aggiungere un commento'));
  if (t === 'eraser') parts.push(hint('Passa sopra un elemento per cancellarlo'));
  if (t === 'stamp') {
    parts.push(el('div', { className: 'group' }, ...STAMPS.map(([label, color], i) => {
      const b = optBtn({ className: 'stamp-chip' }, st.stamp === i, () => { st.stamp = i; renderOpts(); }, label);
      b.style.setProperty('--c', color);
      return b;
    })), hint('Tocca la pagina'));
  }
  if (t === 'sign') {
    parts.push(el('div', { className: 'group' }, ...sigs.map((s, i) => el('div', { className: 'sig-chip' + (st.sig === i ? ' on' : '') },
      el('button', { className: 'sig-pick', ariaLabel: 'Firma ' + (i + 1), onclick: () => { st.sig = i; renderOpts(); } }, sigThumb(s)),
      Object.assign(el('button', {
        className: 'icon sig-del', ariaLabel: 'Elimina firma', onclick: () => {
          if (!confirm('Eliminare questa firma salvata?')) return;
          sigs.splice(i, 1);
          st.sig = sigs.length ? 0 : null;
          idb('put', sigs, 'sigs').catch(console.error);
          renderOpts();
        }
      }), { innerHTML: svg('x') })
    ))));
    const nb = optBtn({ className: 'add' }, false, openPad);
    nb.innerHTML = svg('plus') + 'Nuova firma';
    parts.push(nb, swatches('sign'));
    if (sigs.length) parts.push(hint('Tocca la pagina per firmare'));
  }
  if (t === 'select') {
    if (!sel) parts.push(hint('Tocca un elemento per selezionarlo, trascinalo per spostarlo'));
    else {
      const { g, o } = sel;
      if (o.color) {
        const key = { pen: 'pen', hl: 'hl', shape: 'shape', mark: 'mark', text: 'text', sig: 'sign' }[o.tool];
        if (key) parts.push(swatches(key, c => { const n = { ...o, color: c }; replaceItem(g, o, n); setSel({ g, o: n }); renderOpts(); }, o.color));
      }
      parts.push(
        optBtn({}, false, () => {
          const n = mapItem(o, ([x, y]) => [x + 12, y + 12], 1);
          addItem(g, n);
          setSel({ g, o: n });
        }, 'Duplica'),
        optBtn({ className: 'danger' }, false, () => { replaceItem(g, o, null); setSel(null); }, 'Elimina')
      );
      if (o.tool === 'mark' && o.text) parts.push(optBtn({}, false, () => navigator.clipboard?.writeText(o.text), 'Copia testo'));
    }
  }
  optsEl.replaceChildren(...parts);
}

$('#tools').onclick = e => {
  const t = e.target.closest('[data-tool]')?.dataset.tool;
  if (!t) return;
  blurEditing();
  closeNote();
  st.tool = t;
  document.body.dataset.tool = t;
  document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  if (t !== 'select') setSel(null);
  if (t === 'sign' && !sigs.length) openPad();
  renderOpts();
};
document.body.dataset.tool = st.tool;
$('#finger').onclick = e => {
  st.finger = !st.finger;
  e.currentTarget.classList.toggle('on', st.finger);
  e.currentTarget.setAttribute('aria-pressed', st.finger);
};
$('#undo').onclick = () => step(undoStack, redoStack, 'before');
$('#redo').onclick = () => step(redoStack, undoStack, 'after');
addEventListener('keydown', e => {
  if (document.activeElement?.closest?.('.annot, textarea, input')) return;
  if (sel && (e.key === 'Delete' || e.key === 'Backspace')) { replaceItem(sel.g, sel.o, null); setSel(null); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? $('#redo').click() : $('#undo').click(); }
});
renderOpts();

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

async function bakeDoc(only) {
  const { PDFDocument, StandardFonts, degrees } = PDFLib;
  const out = await PDFDocument.load(bytes);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const E = {
    out, color: hex, font, bold: await out.embedFont(StandardFonts.HelveticaBold),
    chars: new Set(font.getCharacterSet()), base: baselineRatio(),
    noteAp: out.context.register(out.context.stream(
      'q 0.99 0.83 0.3 rg 0.47 0.21 0.06 RG 0.8 w 0.5 0.5 21 21 re B 1.4 w 1 J 6 15 m 16 15 l S 6 11 m 16 11 l S 6 7 m 12 7 l S Q',
      { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 22, 22] }
    ))
  };
  pages.forEach((g, i) => {
    if (!g.strokes.length || (only && !only.includes(i))) return;
    const page = out.getPage(i);
    E.pdf = (x, y) => g.vp.convertToPdfPoint(x, y);
    const [x0, y0] = E.pdf(0, 0), [x1, y1] = E.pdf(1, 0);
    E.rotate = degrees(Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI);
    for (const o of g.strokes) exportItem(page, o, E);
  });
  return out;
}

async function buildPdf() {
  const name = fileName.replace(/\.pdf$/i, '') + '_annotato.pdf';
  return new File([await (await bakeDoc(null)).save()], name, { type: 'application/pdf' });
}

function offer(files, main = false) {
  ready = { files, main };
  $('#readyTitle').textContent = files.length > 1 ? `${files.length} PDF pronti` : 'PDF pronto';
  $('#share').hidden = !navigator.canShare?.({ files });
  $('#ready').showModal();
}

async function applyPages(data, strokes) {
  if (!await open(data, fileName, strokes)) return;
  dirty = true;
  await idb('put', { bytes: data, name: fileName }, 'doc').catch(console.error);
  saveInk();
}

$('#orgBtn').onclick = () => {
  blurEditing();
  closeNote();
  setSel(null);
  openOrganizer({
    pages, bytes, fileName, pdfjs: pdfjsLib, offer, apply: applyPages,
    baked: async only => (await bakeDoc(only)).save()
  });
};

$('#save').onclick = async () => {
  blurEditing();
  closeNote();
  const b = $('#save');
  b.disabled = true;
  b.lastChild.textContent = 'Preparo…';
  try {
    offer([await buildPdf()], true);
  } catch (err) {
    alert('Errore durante l\'esportazione: ' + err.message);
  } finally {
    b.disabled = false;
    b.lastChild.textContent = 'Salva';
  }
};
function exported() {
  if (ready.main) {
    dirty = false;
    saveInk();
  }
  $('#ready').close();
}
$('#share').onclick = async () => {
  try {
    await navigator.share({ files: ready.files });
    exported();
  } catch (err) {
    if (err.name !== 'AbortError') alert(err.message);
  }
};
$('#download').onclick = () => {
  ready.files.forEach((f, n) => setTimeout(() => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, n * 300));
  exported();
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(console.error);
  navigator.serviceWorker.ready.then(() => { $('#offline').hidden = false; });
}
navigator.storage?.persist?.();

(async () => {
  try {
    sigs = await idb('get', 'sigs') || [];
    if (sigs.length) st.sig = 0;
    const d = await idb('get', 'doc');
    if (!d) return;
    const ink = await idb('get', 'ink');
    if (await open(d.bytes, d.name, ink?.strokes)) dirty = !!ink?.dirty;
  } catch (err) {
    console.error(err);
  }
})();
