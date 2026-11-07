import * as pdfjsLib from './lib/pdf.min.js';
import { penPath } from './ink.js';
import {
  HL_ALPHA, NOTE, STAMPS, isDom, resizable, bbox, hit, erasePart, mapItem, paint, inkPath, exportItem, markRects, onImageReady
} from './items.js';
import { buildForms, fillPdfForm } from './forms.js';
import { ocrPages, toWord, toImages } from './convert.js';
import { openOrganizer } from './organize.js';
import { openScanner, blankPdf } from './create.js';
import { idb, libList, libAdd, libTouch, libRemove, migrate } from './store.js';
import { pageIndex, findRects, setMeasure } from './search.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.js';
const measurer = document.createElement('canvas').getContext('2d');
measurer.font = '100px Helvetica, Arial, sans-serif';
setMeasure(s => measurer.measureText(s).width);

const INK = ['#111111', '#ffffff', '#1d4ed8', '#dc2626', '#15803d'];
const COLORS = {
  pen: INK, text: INK, shape: INK,
  hl: ['#ffff00', '#39ff14', '#ff9f1a', '#ff2bd6'],
  mark: ['#facc15', '#22c55e', '#dc2626', '#2563eb'],
  sign: ['#111111', '#1d4ed8']
};
const SIZES = { pen: [1.2, 2.4, 4.5], hl: [8, 14, 22], text: [10, 14, 20], shape: [1, 2, 4], eraser: [4, 9, 18] };
const NIB_W = { pen: 1, biro: 0.6, fountain: 1.5, marker: 2.8 };
const FONTS = [
  ['Helvetica', ''], ['Arial (Arimo)', 'arimo'], ['Times New Roman (Tinos)', 'tinos'], ['Courier New (Cousine)', 'cousine'],
  ['Calibri (Carlito)', 'carlito'], ['Cambria (Caladea)', 'caladea'], ['Roboto', 'roboto'], ['Open Sans', 'open-sans'],
  ['Lato', 'lato'], ['Montserrat', 'montserrat'], ['Poppins', 'poppins'], ['Raleway', 'raleway'], ['Nunito', 'nunito'],
  ['Source Sans 3', 'source-sans-3'], ['Merriweather', 'merriweather'], ['Playfair Display', 'playfair-display'],
  ['EB Garamond', 'eb-garamond'], ['Libre Baskerville', 'libre-baskerville'], ['Lora', 'lora'], ['PT Serif', 'pt-serif'],
  ['Oswald', 'oswald'], ['Ubuntu', 'ubuntu'], ['Inconsolata', 'inconsolata'], ['Dancing Script', 'dancing-script'],
  ['Pacifico', 'pacifico'], ['Caveat', 'caveat']
];
const fontCss = id => (id ? `'F-${id}', ` : '') + 'Helvetica, Arial, sans-serif';
const fontsLoaded = new Map();
function loadFont(id) {
  if (!id) return Promise.resolve();
  if (!fontsLoaded.has(id)) {
    const f = new FontFace('F-' + id, `url(fonts/extra/${id}.woff)`);
    document.fonts.add(f);
    fontsLoaded.set(id, f.load().catch(console.error));
  }
  return fontsLoaded.get(id);
}
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
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  redact: '<rect x="3" y="8" width="18" height="8" rx="1" fill="currentColor"/>'
};
const svg = k => `<svg viewBox="0 0 24 24">${ICON[k]}</svg>`;

const $ = s => document.querySelector(s);
const viewer = $('#viewer'), pagesEl = $('#pages'), thumbsEl = $('#thumbs'), emptyEl = $('#empty'), msgEl = $('#emptyMsg'), optsEl = $('#opts');
const st = {
  tool: 'pen', zoom: 1, finger: false, sig: null, stamp: 0,
  color: Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, v[0]])),
  size: { pen: 1, hl: 1, text: 1, shape: 1, eraser: 1 },
  kind: { shape: 'rect', mark: 'under', text: 'new', eraser: 'item', pen: 'pen' }
};
let doc = null, bytes = null, fileName = '', pages = [], maxW = 1, sigs = [];
let undoStack = [], redoStack = [], dirty = false, live = null, lastPen = 0, ready = null;
let drag = null, swallow = false, note = null, sel = null;
const paths = new WeakMap(), objOf = new WeakMap(), sizeOf = new WeakMap();
const sizeFn = o => sizeOf.get(o);
const placing = () => PLACING.has(st.tool) || (st.tool === 'shape' && st.kind.shape === 'image');
const absUrl = p => new URL(p, location.href).href;
const today = () => new Date().toLocaleDateString('it-IT');

let curId = null, search = null, toastTimer = 0;
let formVals = {};
const saveInk = () => curId && idb('put', { strokes: pages.map(g => g.strokes), dirty, forms: formVals, ocr: pages.map(g => g.ocr || null) }, 'ink:' + curId).catch(console.error);
onImageReady(() => pages.filter(g => g.near).forEach(schedule));

function toast(text, sticky = false) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

const io = new IntersectionObserver(es => {
  for (const e of es) {
    const g = pages[e.target.dataset.i];
    if (!g) continue;
    g.near = e.isIntersecting;
    g.near ? draw(g) : free(g);
  }
}, { root: viewer, rootMargin: '1200px 0px' });

async function open(data, name, strokes, forms = {}, ocr = []) {
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
  closeSearch();
  pagesEl.textContent = ''; thumbsEl.textContent = ''; $('#outline').textContent = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n), vp = p.getViewport({ scale: 1 });
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.i = n - 1;
    const c = document.createElement('canvas'), under = document.createElement('canvas'), ink = document.createElement('canvas');
    const layer = document.createElement('div'), hits = document.createElement('div'), formsEl = document.createElement('div');
    ink.className = 'ink';
    layer.className = 'annots';
    hits.className = 'annots hits';
    formsEl.className = 'annots forms';
    for (const l of [layer, hits, formsEl]) {
      l.style.width = vp.width + 'px';
      l.style.height = vp.height + 'px';
    }
    el.append(c, under, ink, hits, formsEl, layer);
    pagesEl.append(el);
    pages.push({ p, vp, el, c, under, ink, layer, hits, forms: formsEl, strokes: strokes?.[n - 1] || [], ocr: ocr?.[n - 1] || null, scale: 0, near: false, task: null, words: null, textP: null });
  }
  maxW = Math.max(...pages.map(g => g.vp.width));
  viewer.scrollTo(0, 0);
  layout();
  pages.forEach(renderAnnots);
  formVals = { ...forms };
  for (const g of pages) buildForms(g, formVals, onField);
  pages.forEach(g => io.observe(g.el));
  emptyEl.hidden = true;
  $('#hud').hidden = false;
  $('#save').disabled = $('#thumbsBtn').disabled = false;
  $('#orgBtn').hidden = false;
  $('#undo').disabled = $('#redo').disabled = true;
  if (!$('#side').hidden) buildSide();
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
    g.layer.style.transform = g.hits.style.transform = g.forms.style.transform = `scale(${s})`;
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
  const task = g.task = g.p.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
  try { await task.promise; } catch { return; }
  if (g.scale !== r) return;
  g.c.replaceWith(c);
  g.c = c;
  g.ink.width = g.under.width = c.width;
  g.ink.height = g.under.height = c.height;
  paintInk(g);
}

function free(g) {
  g.task?.cancel();
  g.scale = 0;
  g.c.width = g.c.height = g.ink.width = g.ink.height = g.under.width = g.under.height = 0;
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
    if (!g.words.length && g.ocr) g.words = g.ocr;
    return g.words;
  }).catch(() => (g.words = g.ocr || []));
}

function inkPath2D(o) {
  let p = paths.get(o);
  if (!p) {
    p = new Path2D(inkPath(o));
    if (o !== live?.s) paths.set(o, p);
  }
  return p;
}

const OPAQUE = new Set(['cover', 'redact', 'image']);

function paintInk(g) {
  const all = live?.g === g && live.s ? [...g.strokes, live.s] : g.strokes;
  for (const c of [g.under, g.ink]) {
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!c.width) continue;
    const k = c.width / g.vp.width;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    for (const o of all) if (!isDom(o) && OPAQUE.has(o.tool) === (c === g.under)) paint(ctx, o, inkPath2D);
  }
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
  for (const m of a.multi || [a]) {
    m.g.strokes = m[key].slice();
    refresh(m.g);
  }
  to.push(a);
  setSel(null);
  changed();
}

function mutateAll(fn) {
  const before = pages.map(g => g.strokes.slice());
  fn();
  const multi = pages.map((g, i) => ({ g, before: before[i], after: g.strokes.slice() })).filter(m => m.after.length !== m.before.length || m.after.some((o, i) => o !== m.before[i]));
  if (!multi.length) return;
  undoStack.push({ multi });
  redoStack = [];
  changed();
  multi.forEach(m => refresh(m.g));
}

function onField(name, value, src) {
  formVals[name] = value;
  for (const f of document.querySelectorAll('.field')) {
    if (f === src || f.dataset.name !== name) continue;
    if (f.type === 'checkbox') f.checked = !!value;
    else if (f.type === 'radio') f.checked = f.value === value;
    else f.value = value;
  }
  dirty = true;
  saveInk();
}

function annotEl(o) {
  const a = document.createElement('div');
  a.className = 'annot ' + o.tool;
  a.style.left = o.x + 'px';
  a.style.top = o.y + 'px';
  if (o.tool === 'text') {
    a.textContent = o.text;
    a.style.fontSize = o.size + 'px';
    if (o.font) { a.style.fontFamily = fontCss(o.font); loadFont(o.font); }
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
  if (!el || live || drag || e.target.closest('.field')) return;
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
  if (t === 'hl') live.s = { tool: t, color: st.color[t], w: SIZES[t][st.size[t]], pts: [] };
  else if (t === 'pen') live.s = { tool: t, nib: st.kind.pen, color: st.color[t], w: SIZES[t][st.size[t]] * NIB_W[st.kind.pen], pts: [] };
  else if (t === 'shape' && st.kind.shape === 'redact') live.s = { tool: 'redact', x, y, w: 0, h: 0 };
  else if (t === 'shape') live.s = { tool: 'shape', kind: st.kind.shape, color: st.color.shape, w: SIZES.shape[st.size.shape], x1: x, y1: y, x2: x, y2: y };
  else if (t === 'mark') {
    if (!g.words) { loadText(g); live = null; return toast('Attendi un istante e riprova'); }
    if (!g.words.length) { live = null; return toast('Questa pagina non ha testo selezionabile: usa ⋯ › Riconosci testo (OCR)'); }
    live.s = { tool: 'mark', kind: st.kind.mark, color: st.kind.mark === 'copy' ? '#60a5fa' : st.color.mark, rects: [], text: '' };
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
    if (st.tool === 'eraser' && st.kind.eraser === 'free') {
      const r = SIZES.eraser[st.size.eraser];
      live.g.strokes = live.g.strokes.flatMap(o => erasePart(o, x, y, r) || [o]);
    } else if (st.tool === 'eraser') {
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
    } else if (s?.tool === 'redact') {
      Object.assign(s, { x: Math.min(x, live.x0), y: Math.min(y, live.y0), w: Math.abs(x - live.x0), h: Math.abs(y - live.y0) });
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
  if (s?.kind === 'copy') {
    live = null;
    schedule(g);
    if (s.text) navigator.clipboard?.writeText(s.text).then(() => toast('Testo copiato'), () => toast('Copia non riuscita'));
    return;
  }
  const keep = s && (s.pts?.length || s.rects?.length || (s.tool === 'shape' && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 3) || (s.tool === 'redact' && s.w > 3 && s.h > 3));
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
  if (st.tool === 'shape') return pickImage(g, x, y);
  if (st.kind.text === 'edit') return editPdfText(g, x, y);
  const size = SIZES.text[st.size.text];
  const draft = { tool: 'text', x, y: y - size * 0.7, text: '', size, color: st.color.text, ...(st.font && { font: st.font }) };
  const t = annotEl(draft);
  g.layer.append(t);
  editText(g, null, t, draft);
});

function pickImage(g, x, y) {
  const input = $('#imgFile');
  input.onchange = async () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k);
      c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const src = f.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
      const w = Math.min(200, g.vp.width * 0.5), h = w * c.height / c.width;
      addItem(g, { tool: 'image', src, x: x - w / 2, y: y - h / 2, w, h });
      st.tool = 'select';
      document.body.dataset.tool = 'select';
      document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === 'select'));
      setSel({ g, o: g.strokes[g.strokes.length - 1] });
    } catch (err) {
      alert('Impossibile inserire l\'immagine: ' + err.message);
    }
  };
  input.click();
}

function editPdfText(g, x, y) {
  const w = g.words?.find(w => x >= w.x - 2 && x <= w.x + w.w + 2 && y >= w.y - 2 && y <= w.y + w.h * 1.15 + 2);
  if (!w) return toast('Tocca una riga di testo del PDF');
  let bg = '#ffffff';
  if (g.c.width) {
    const k = g.c.width / g.vp.width, [r, gr, b] = g.c.getContext('2d').getImageData(Math.max(0, (w.x - 3) * k) | 0, (w.y + w.h / 2) * k | 0, 1, 1).data;
    bg = '#' + [r, gr, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  const size = Math.round(w.h * 10) / 10, baseline = w.y + w.h * 0.8;
  addItem(g, { tool: 'cover', x: w.x - 1, y: w.y - 1, w: w.w + 2, h: w.h * 1.15 + 2, color: bg });
  const draft = { tool: 'text', x: w.x, y: baseline - size * baselineRatio(), text: w.str, size, color: '#111111' };
  const t = annotEl(draft);
  t.textContent = w.str;
  g.layer.append(t);
  editText(g, null, t, draft);
}

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
  if (placing() || e.target.closest?.('.annot.note, .annot.editing, #notePop, .field, button, a, input, select, label, textarea')) return;
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
  thumbsEl.children[i]?.scrollIntoView?.({ block: 'nearest' });
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
  const side = $('#side');
  side.hidden = !side.hidden;
  $('#thumbsBtn').classList.toggle('on', !side.hidden);
  if (!side.hidden) buildSide();
  updatePageNum();
  if (doc) layout();
}

function buildSide() {
  if (!thumbsEl.childElementCount) buildThumbs();
  if (!$('#outline').childElementCount) buildOutline();
}

$('#sideTabs').onclick = e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  for (const x of $('#sideTabs').children) x.classList.toggle('on', x === b);
  thumbsEl.hidden = b.dataset.tab !== 'pages';
  $('#outline').hidden = b.dataset.tab !== 'outline';
};

async function buildOutline() {
  const box = $('#outline'), d = doc, items = await d.getOutline().catch(() => null);
  if (d !== doc) return;
  if (!items?.length) {
    box.replaceChildren(el('p', { className: 'hint', textContent: 'Questo documento non ha un indice.' }));
    return;
  }
  const list = nodes => el('ul', {}, ...nodes.map(n => el('li', {},
    el('button', { textContent: n.title || '(senza titolo)', onclick: () => goDest(n.dest) }),
    ...(n.items?.length ? [list(n.items)] : []))));
  box.replaceChildren(list(items));
}

async function goDest(dest) {
  try {
    if (typeof dest === 'string') dest = await doc.getDestination(dest);
    if (!dest) return;
    const i = typeof dest[0] === 'object' ? await doc.getPageIndex(dest[0]) : dest[0];
    pages[i]?.el.scrollIntoView({ block: 'start' });
    if (innerWidth < 700) toggleThumbs();
  } catch (err) {
    console.error(err);
  }
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
  }), customSwatch(COLORS[key].includes(current) ? null : current, apply));
}

function fontPicker(cur, apply) {
  const s = el('select', { className: 'font-pick', ariaLabel: 'Carattere', onchange: () => { loadFont(s.value); apply(s.value); } },
    ...FONTS.map(([label, id]) => el('option', { value: id, textContent: label, selected: id === cur })));
  return s;
}

function customSwatch(current, apply) {
  const dot = el('i'), input = el('input', { type: 'color', ariaLabel: 'Altri colori', value: current || '#888888', onchange: e => apply(e.target.value) });
  if (current) dot.style.setProperty('--c', current);
  return el('label', { className: 'icon swatch custom' + (current ? ' on' : '') }, dot, input);
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
  if (search) return;
  const t = st.tool, parts = [];
  if (t === 'pen') parts.push(kinds('pen', [['pen', 'Penna'], ['biro', 'Biro'], ['fountain', 'Stilografica'], ['marker', 'Pennarello']]));
  if (t === 'pen' || t === 'hl') parts.push(swatches(t), sizes(t));
  if (t === 'shape') {
    parts.push(kinds('shape', [['rect', 'Rettangolo', 'rect'], ['ellipse', 'Ellisse', 'ellipse'], ['line', 'Linea', 'line'], ['arrow', 'Freccia', 'arrow'], ['image', 'Immagine', 'image'], ['redact', 'Oscura', 'redact']]));
    if (st.kind.shape === 'image') parts.push(hint('Tocca la pagina dove inserire l\'immagine'));
    else if (st.kind.shape === 'redact') parts.push(hint('Trascina sopra ciò che vuoi oscurare. Nel PDF salvato la pagina diventa un\'immagine'));
    else parts.push(swatches('shape'), sizes('shape'));
  }
  if (t === 'mark') parts.push(kinds('mark', [['under', 'Sottolinea'], ['hl', 'Evidenzia'], ['strike', 'Barra'], ['copy', 'Copia']]), ...(st.kind.mark === 'copy' ? [] : [swatches('mark')]), hint(st.kind.mark === 'copy' ? 'Trascina sul testo da copiare' : 'Trascina sul testo'));
  if (t === 'text') {
    parts.push(kinds('text', [['new', 'Nuovo testo'], ['edit', 'Modifica testo PDF']]));
    if (st.kind.text === 'edit') parts.push(hint('Tocca una riga di testo del PDF per riscriverla'));
    else parts.push(fontPicker(st.font, f => { st.font = f; }), swatches('text'), sizes('text'), hint('Tocca la pagina per scrivere'));
  }
  if (t === 'note') parts.push(hint('Tocca la pagina per aggiungere un commento'));
  if (t === 'eraser') parts.push(kinds('eraser', [['item', 'Elementi'], ['free', 'Libera']]), ...(st.kind.eraser === 'free' ? [sizes('eraser'), hint('Cancella solo la parte di tratto su cui passi')] : [hint('Passa sopra un elemento per cancellarlo')]));
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
      if (o.tool === 'text') parts.push(fontPicker(o.font || '', f => { const n = { ...o, font: f || undefined }; replaceItem(g, o, n); setSel({ g, o: n }); renderOpts(); }));
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
  closeSearch();
  st.tool = t;
  document.body.dataset.tool = t;
  document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  if (t !== 'select') setSel(null);
  if (t === 'sign' && !sigs.length) openPad();
  if (t === 'mark') pages.forEach(loadText);
  renderOpts();
};
document.body.dataset.tool = st.tool;
$('#moreMenu').onchange = e => {
  const v = e.target.value;
  e.target.value = '';
  if (v === 'finger') {
    st.finger = !st.finger;
    e.target.querySelector('[value="finger"]').textContent = 'Disegna con il dito: ' + (st.finger ? 'sì' : 'no');
    $('#moreBtn').classList.toggle('on', st.finger);
    return toast(st.finger ? 'Il dito ora disegna' : 'Il dito ora scorre la pagina');
  }
  if (!doc) return toast('Apri prima un documento');
  if (v === 'ocr') return runOcr();
  if (v === 'word') return runWord();
  if (v === 'images') return runImages();
  openDocTool(v);
};

let busyJob = false;
async function job(fn) {
  if (busyJob) return toast('Attendi la fine dell\'operazione in corso');
  busyJob = true;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    toast('Errore: ' + err.message);
  } finally {
    busyJob = false;
  }
}

async function needOcr() {
  const list = [];
  for (const g of pages) if (!(await loadText(g)).length && !g.ocr) list.push(g);
  return list;
}

async function ocrList(list) {
  await ocrPages(list, (n, p) => toast(`Riconoscimento testo: pagina ${n + 1} di ${list.length} · ${Math.round(p * 100)}%`, true));
  for (const g of list) {
    g.words = g.ocr;
    g.index = null;
    g.textP = Promise.resolve(g.words);
  }
  dirty = true;
  saveInk();
}

function runOcr() {
  job(async () => {
    const list = await needOcr();
    if (!list.length) return toast('Il documento contiene già testo selezionabile');
    toast('Preparo l\'OCR…', true);
    await ocrList(list);
    const n = list.reduce((s, g) => s + g.ocr.length, 0);
    toast(`OCR completato: ${n} parole riconosciute. Ora puoi cercare e copiare il testo`);
  });
}

function runWord() {
  job(async () => {
    const missing = await needOcr();
    if (missing.length && confirm(`${missing.length} pagine sono scansioni senza testo. Eseguire prima l'OCR per includerne il testo?`)) await ocrList(missing);
    const data = await toWord(pages, pdfjsLib, n => toast(`Conversione in Word: pagina ${n + 1} di ${pages.length}`, true));
    toast('Documento Word pronto');
    offer([new File([data], fileName.replace(/\.pdf$/i, '') + '.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })]);
  });
}

function runImages() {
  job(async () => {
    const files = await toImages(pages, fileName.replace(/\.pdf$/i, ''), n => toast(`Esporto la pagina ${n + 1} di ${pages.length}`, true));
    toast('Immagini pronte');
    offer(files);
  });
}

const textWidth = (str, size) => measurer.measureText(str).width * size / 100;

function field(label, control) {
  return el('label', { className: 'frow' }, el('span', { textContent: label }), control);
}
function choice(id, options, value) {
  const s = el('select', { id });
  for (const [v, l] of options) s.append(new Option(l, v));
  s.value = value;
  return s;
}

function openDocTool(mode) {
  const f = $('#docFields');
  if (mode === 'numbers') {
    $('#docTitle').textContent = 'Numeri di pagina';
    f.replaceChildren(
      field('Formato', choice('dFmt', [['n', '1'], ['pn', 'Pagina 1 di 10'], ['nn', '1 / 10']], 'pn')),
      field('Posizione', choice('dPos', [['bc', 'In basso al centro'], ['br', 'In basso a destra'], ['tr', 'In alto a destra']], 'bc')),
      field('Dimensione', choice('dSize', [['8', 'Piccola'], ['10', 'Media'], ['13', 'Grande']], '10')));
  } else if (mode === 'wm') {
    $('#docTitle').textContent = 'Filigrana';
    f.replaceChildren(
      field('Testo', el('input', { id: 'dText', value: 'BOZZA', maxLength: 40 })),
      field('Colore', choice('dColor', [['#6b7280', 'Grigio'], ['#dc2626', 'Rosso'], ['#1d4ed8', 'Blu']], '#6b7280')),
      field('Intensità', choice('dAlpha', [['0.12', 'Leggera'], ['0.22', 'Media'], ['0.35', 'Forte']], '0.22')));
  } else {
    $('#docTitle').textContent = 'Intestazione o piè di pagina';
    f.replaceChildren(
      field('Testo', el('input', { id: 'dText', placeholder: 'Es. Contratto di locazione – {n}/{N}' })),
      field('Posizione', choice('dPos', [['t', 'In alto'], ['b', 'In basso']], 't')),
      field('Allineamento', choice('dAlign', [['l', 'Sinistra'], ['c', 'Centro'], ['r', 'Destra']], 'l')),
      el('p', { className: 'hint', textContent: '{n} diventa il numero di pagina, {N} il totale.' }));
  }
  const dlg = $('#docDlg');
  dlg.querySelector('form').onsubmit = e => { if (e.submitter?.value === 'ok') applyDocTool(mode); };
  dlg.showModal();
}

function applyDocTool(mode) {
  const N = pages.length, v = id => $('#' + id)?.value;
  mutateAll(() => pages.forEach((g, i) => {
    const W = g.vp.width, H = g.vp.height, add = o => { g.strokes = [...g.strokes, o]; };
    if (mode === 'numbers') {
      const size = +v('dSize'), text = { n: `${i + 1}`, pn: `Pagina ${i + 1} di ${N}`, nn: `${i + 1} / ${N}` }[v('dFmt')];
      const tw = textWidth(text, size), pos = v('dPos');
      const x = pos === 'bc' ? (W - tw) / 2 : W - 36 - tw, y = pos === 'tr' ? 20 : H - 24 - size * 1.2;
      add({ tool: 'text', x, y, text, size, color: '#444444' });
    } else if (mode === 'wm') {
      const text = v('dText').trim();
      if (!text) return;
      const size = Math.min(Math.min(W, H) * 0.16, Math.hypot(W, H) * 0.75 / (textWidth(text, 1) || 1));
      add({ tool: 'wm', text, color: v('dColor'), alpha: +v('dAlpha'), size, tw: textWidth(text, size), x: 0, y: 0, w: W, h: H });
    } else {
      const text = v('dText').replace(/\{n\}/g, i + 1).replace(/\{N\}/g, N).trim();
      if (!text) return;
      const size = 9, tw = textWidth(text, size), al = v('dAlign');
      const x = al === 'l' ? 36 : al === 'c' ? (W - tw) / 2 : W - 36 - tw, y = v('dPos') === 't' ? 18 : H - 18 - size * 1.2;
      add({ tool: 'text', x, y, text, size, color: '#444444' });
    }
  }));
}
$('#undo').onclick = () => step(undoStack, redoStack, 'before');
$('#redo').onclick = () => step(redoStack, undoStack, 'after');
addEventListener('keydown', e => {
  if (document.activeElement?.closest?.('.annot, textarea, input')) return;
  if (sel && (e.key === 'Delete' || e.key === 'Backspace')) { replaceItem(sel.g, sel.o, null); setSel(null); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? $('#redo').click() : $('#undo').click(); }
});
renderOpts();

$('#open').onclick = () => showHome();
$('#openBig').onclick = $('#homeOpen').onclick = () => $('#file').click();
$('#homeClose').onclick = () => { $('#home').hidden = true; };

const stamp = () => new Date().toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }).replace(/[/:]/g, '.').replace(',', '');
async function createDoc(data, name) {
  await openDoc(await libAdd(data, name));
}
function startCreate(kind) {
  if (kind === 'scan') return openScanner({ done: createDoc });
  const label = { blank: 'Documento', lined: 'Appunti a righe', grid: 'Appunti a quadretti' }[kind];
  blankPdf(kind).then(data => createDoc(data, `${label} ${stamp()}.pdf`));
}
$('#homeCreate').onchange = e => {
  const v = e.target.value;
  e.target.value = '';
  startCreate(v);
};
$('#scanBig').onclick = () => startCreate('scan');
$('#file').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  let first = null;
  for (const f of files) {
    const id = await libAdd(new Uint8Array(await f.arrayBuffer()), f.name);
    first ??= id;
  }
  if (first) await openDoc(first);
};

async function openDoc(id) {
  blurEditing();
  closeNote();
  const d = await idb('get', 'doc:' + id);
  if (!d) return;
  $('#home').hidden = true;
  const ink = await idb('get', 'ink:' + id);
  if (!await open(d.bytes, d.name, ink?.strokes, ink?.forms, ink?.ocr)) return showHome();
  curId = id;
  dirty = !!ink?.dirty;
  await idb('put', id, 'cur');
  const entry = (await libList()).find(x => x.id === id);
  await libTouch(id, { pages: pages.length, ...(entry?.thumb ? {} : { thumb: await thumbOf() }) });
}

async function thumbOf() {
  const g = pages[0], k = 180 / g.vp.width, c = document.createElement('canvas');
  c.width = 180;
  c.height = Math.round(g.vp.height * k);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  await g.p.render({ canvasContext: x, viewport: g.p.getViewport({ scale: k }) }).promise;
  return c.toDataURL('image/jpeg', 0.75);
}

async function showHome() {
  blurEditing();
  closeNote();
  const list = await libList(), grid = $('#homeList');
  $('#homeClose').hidden = !doc;
  $('#homeEmpty').hidden = list.length > 0;
  grid.hidden = !list.length;
  grid.replaceChildren(...list.map(x => {
    const del = el('button', {
      className: 'icon doc-del', ariaLabel: 'Rimuovi ' + x.name, onclick: async ev => {
        ev.stopPropagation();
        if (!confirm(`Rimuovere «${x.name}» e le sue annotazioni da PDF Pad?\nIl file originale non viene toccato.`)) return;
        await libRemove(x.id);
        if (x.id === curId) location.reload();
        else showHome();
      }
    });
    del.innerHTML = svg('x');
    const img = el('div', { className: 'doc-thumb' });
    if (x.thumb) img.append(el('img', { src: x.thumb, alt: '' }));
    return el('button', { className: 'doc' + (x.id === curId ? ' cur' : ''), onclick: () => x.id === curId && doc ? ($('#home').hidden = true) : openDoc(x.id) },
      img, el('strong', { textContent: x.name.replace(/\.pdf$/i, '') }),
      el('small', { textContent: [x.pages && `${x.pages} pag.`, new Date(x.opened).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })].filter(Boolean).join(' · ') }),
      del);
  }));
  $('#home').hidden = false;
}

function hitRects(g, rects, cur) {
  return rects.map(([x, y, w, h]) => el('div', {
    className: 'hit' + (cur ? ' cur' : ''),
    style: `left:${x}px;top:${y}px;width:${w}px;height:${h}px`
  }));
}

function renderHits() {
  for (const g of pages) g.hits.replaceChildren();
  if (!search) return;
  search.hits.forEach((h, n) => h.g.hits.append(...hitRects(h.g, h.rects, n === search.cur)));
  $('#searchCount').textContent = search.q.trim()
    ? (search.busy ? 'Cerco…' : search.hits.length ? `${search.cur + 1} di ${search.hits.length}` : 'Nessun risultato')
    : '';
}

function goHit(n) {
  if (!search?.hits.length) return;
  search.cur = (n + search.hits.length) % search.hits.length;
  renderHits();
  const { g, rects } = search.hits[search.cur], s = scale();
  viewer.scrollTo({ top: g.el.offsetTop + rects[0][1] * s - viewer.clientHeight / 3, left: Math.max(0, g.el.offsetLeft + rects[0][0] * s - viewer.clientWidth / 2) });
}

async function runSearch() {
  if (!search) return;
  const q = search.q, run = search.run = {};
  search.hits = [];
  search.cur = 0;
  search.busy = true;
  renderHits();
  for (const g of pages) {
    const words = await loadText(g);
    if (search?.run !== run) return;
    g.index ??= pageIndex(words);
    for (const rects of findRects(words, g.index, q)) search.hits.push({ g, rects });
  }
  search.busy = false;
  renderHits();
  const midY = viewer.scrollTop;
  goHit(Math.max(0, search.hits.findIndex(h => h.g.el.offsetTop + h.rects[0][1] * scale() >= midY)));
}

function openSearch() {
  if (!doc) return;
  if (search) return closeSearch();
  search = { q: '', hits: [], cur: 0 };
  $('#searchBtn').classList.add('on');
  let timer = 0;
  const input = el('input', {
    type: 'search', placeholder: 'Cerca nel documento', id: 'searchInput', enterKeyHint: 'search',
    oninput: () => { search.q = input.value; clearTimeout(timer); timer = setTimeout(runSearch, 250); },
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); goHit(search.cur + (e.shiftKey ? -1 : 1)); } if (e.key === 'Escape') closeSearch(); }
  });
  const prev = el('button', { className: 'icon', ariaLabel: 'Precedente', onclick: () => goHit(search.cur - 1) });
  prev.innerHTML = '<svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>';
  const next = el('button', { className: 'icon', ariaLabel: 'Successivo', onclick: () => goHit(search.cur + 1) });
  next.innerHTML = '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>';
  const close = el('button', { textContent: 'Fine', onclick: closeSearch });
  optsEl.replaceChildren(el('div', { className: 'search' }, input, el('span', { id: 'searchCount', className: 'hint' }), prev, next), close);
  input.focus();
}

function closeSearch() {
  if (!search) return;
  search = null;
  $('#searchBtn').classList.remove('on');
  renderHits();
  renderOpts();
}
$('#searchBtn').onclick = openSearch;
addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search ? $('#searchInput').focus() : openSearch(); }
});

const hex = h => PDFLib.rgb(...[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255));

function baselineRatio(id) {
  const d = document.createElement('div');
  d.className = 'annot text';
  d.style.cssText = 'position:absolute;visibility:hidden;font-size:100px';
  d.style.fontFamily = fontCss(id);
  d.innerHTML = 'H<i style="display:inline-block;width:1px;height:0"></i>';
  document.body.append(d);
  const r = (d.lastChild.getBoundingClientRect().top - d.getBoundingClientRect().top) / 100;
  d.remove();
  return r;
}

async function rasterPage(g, base) {
  const k = 2, vp = g.p.getViewport({ scale: k }), c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  await g.p.render({ canvasContext: x, viewport: vp }).promise;
  x.setTransform(k, 0, 0, k, 0, 0);
  for (const o of g.strokes) {
    if (o.tool === 'text') {
      x.fillStyle = o.color;
      x.font = `${o.size}px Helvetica, Arial, sans-serif`;
      o.text.split('\n').forEach((line, n) => x.fillText(line, o.x, o.y + o.size * (base + 1.2 * n)));
    } else if (o.tool !== 'note') paint(x, o, it => new Path2D(inkPath(it)));
  }
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}

function ocrLines(words) {
  const lines = [];
  for (const w of [...words].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const l = lines.find(l => Math.abs(l[0].y + l[0].h / 2 - (w.y + w.h / 2)) < Math.max(l[0].h, w.h) * 0.5);
    l ? l.push(w) : lines.push([w]);
  }
  return lines.map(l => l.sort((a, b) => a.x - b.x));
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
  E.images = new Map();
  for (const src of new Set(pages.flatMap(g => g.strokes.filter(o => o.tool === 'image').map(o => o.src)))) {
    const data = Uint8Array.from(atob(src.split(',')[1]), ch => ch.charCodeAt(0));
    E.images.set(src, src.startsWith('data:image/png') ? await out.embedPng(data) : await out.embedJpg(data));
  }
  E.fonts = new Map();
  const used = new Set(pages.flatMap(g => g.strokes.filter(o => o.tool === 'text' && o.font).map(o => o.font)));
  if (used.size) {
    if (!window.fontkit) await new Promise((ok, ko) => document.head.append(Object.assign(document.createElement('script'), { src: 'lib/fontkit.min.js', onload: ok, onerror: ko })));
    out.registerFontkit(fontkit);
    for (const id of used) {
      await loadFont(id);
      const f = await out.embedFont(await (await fetch(`fonts/extra/${id}.woff`)).arrayBuffer(), { subset: true });
      E.fonts.set(id, { font: f, chars: new Set(f.getCharacterSet()), base: baselineRatio(id) });
    }
  }
  if (!only) fillPdfForm(out, formVals, E.chars);
  for (const [i, g] of pages.entries()) {
    if ((!g.strokes.length && !g.ocr?.length) || (only && !only.includes(i))) continue;
    if (g.strokes.some(o => o.tool === 'redact')) {
      const jpg = await out.embedJpg(await rasterPage(g, E.base));
      out.removePage(i);
      out.insertPage(i, [g.vp.width, g.vp.height]).drawImage(jpg, { x: 0, y: 0, width: g.vp.width, height: g.vp.height });
      continue;
    }
    const page = out.getPage(i);
    E.pdf = (x, y) => g.vp.convertToPdfPoint(x, y);
    const [x0, y0] = E.pdf(0, 0), [x1, y1] = E.pdf(1, 0);
    E.rotate = degrees(Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI);
    for (const o of g.strokes) exportItem(page, o, E);
    for (const line of ocrLines(g.ocr || [])) {
      const str = [...line.map(w => w.str).join(' ')].map(ch => E.chars.has(ch.codePointAt(0)) ? ch : '?').join('');
      const first = line[0], last = line[line.length - 1], h = Math.max(...line.map(w => w.h));
      let size = h * 1.2;
      const tw = E.font.widthOfTextAtSize(str, size);
      if (tw > 0) size *= Math.min(2, Math.max(0.3, (last.x + last.w - first.x) / tw));
      const [X, Y] = E.pdf(first.x, first.y + first.h * 0.85);
      page.drawText(str, { x: X, y: Y, size, font: E.font, opacity: 0, rotate: E.rotate });
    }
  }
  return out;
}

async function buildPdf() {
  const name = fileName.replace(/\.pdf$/i, '') + '_annotato.pdf';
  return new File([await (await bakeDoc(null)).save()], name, { type: 'application/pdf' });
}

function offer(files, main = false) {
  ready = { files, main };
  const single = files[0].name.endsWith('.docx') ? 'Documento Word pronto' : files[0].type.startsWith('image/') ? 'Immagine pronta' : 'PDF pronto';
  const many = files[0].type.startsWith('image/') ? `${files.length} immagini pronte` : files[0].name.endsWith('.docx') ? `${files.length} file pronti` : `${files.length} PDF pronti`;
  $('#readyTitle').textContent = files.length > 1 ? many : single;
  $('#share').hidden = !navigator.canShare?.({ files });
  $('#ready').showModal();
}

async function applyPages(data, strokes) {
  if (!await open(data, fileName, strokes)) return;
  dirty = true;
  await idb('put', { bytes: data, name: fileName }, 'doc:' + curId).catch(console.error);
  saveInk();
  await libTouch(curId, { pages: pages.length, thumb: await thumbOf() });
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
    await migrate();
    sigs = await idb('get', 'sigs') || [];
    if (sigs.length) st.sig = 0;
    const cur = await idb('get', 'cur');
    if (cur) await openDoc(cur);
    if (!doc) showHome();
  } catch (err) {
    console.error(err);
  }
})();
