import { paint, inkPath, isDom } from './items.js';

const A4 = [595.28, 841.89];
const $ = s => document.querySelector(s);
let ctx, entries, history, selected, nextId, thumbs, dragged;

export function openOrganizer(c) {
  ctx = c;
  nextId = 0;
  entries = ctx.pages.map((g, i) => ({ id: nextId++, src: 'cur', i, rot: 0, strokes: g.strokes, w: g.vp.width, h: g.vp.height }));
  history = [];
  selected = new Set();
  $('#org').hidden = false;
  render();
}

const cur = () => entries.filter(e => selected.has(e.id));
const changedSince = () => history.length > 0;

function commit(next) {
  history.push(entries);
  entries = next;
  render();
}

function render() {
  if (!entries) return;
  const grid = $('#orgGrid');
  thumbs?.disconnect();
  thumbs = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    thumbs.unobserve(e.target);
    drawThumb(entries?.find(x => x.id === +e.target.dataset.id), e.target.querySelector('canvas'));
  }), { root: grid, rootMargin: '300px 0px' });
  grid.replaceChildren(...entries.map((e, n) => {
    const card = document.createElement('div');
    card.className = 'card' + (selected.has(e.id) ? ' on' : '');
    card.dataset.id = e.id;
    const frame = document.createElement('div');
    frame.className = 'frame';
    const c = document.createElement('canvas');
    frame.append(c);
    const label = document.createElement('span');
    label.textContent = n + 1;
    const grip = document.createElement('i');
    grip.className = 'grip';
    grip.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>';
    card.append(frame, label, grip);
    thumbs.observe(card);
    return card;
  }));
  $('#orgCount').textContent = selected.size ? `${selected.size} selezionate` : `${entries.length} pagine`;
  $('#orgUndo').disabled = !history.length;
  for (const id of ['orgRotate', 'orgDelete', 'orgExtract']) $('#' + id).disabled = !selected.size;
  $('#orgAll').textContent = selected.size === entries.length ? 'Nessuna' : 'Tutte';
}

async function drawThumb(e, c) {
  if (!e) return;
  const W = 150, k = W / Math.max(e.w, e.h) * 1.4, side = e.rot % 180 !== 0;
  const w = Math.round(e.w * k), h = Math.round(e.h * k);
  [c.width, c.height] = side ? [h, w] : [w, h];
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  const turn = () => {
    const a = e.rot * Math.PI / 180;
    g.translate(c.width / 2, c.height / 2);
    g.rotate(a);
    g.translate(-w / 2, -h / 2);
  };
  if (e.src === 'blank') { turn(); return drawBlank(g, e.kind, w, h, k); }
  const page = e.src === 'cur' ? ctx.pages[e.i].p : await e.doc.getPage(e.i + 1);
  const vp = page.getViewport({ scale: k, rotation: (page.rotate + e.rot) % 360 });
  await page.render({ canvasContext: g, viewport: vp }).promise;
  turn();
  g.scale(k, k);
  for (const o of e.strokes) if (!isDom(o)) paint(g, o, x => new Path2D(inkPath(x)));
}

function drawBlank(g, kind, w, h, k) {
  g.strokeStyle = kind === 'lined' ? '#bfd1ec' : '#d9d9de';
  g.lineWidth = Math.max(0.5, 0.6 * k);
  const step = (kind === 'lined' ? 24 : 14.17) * k;
  g.beginPath();
  if (kind === 'lined') for (let y = 72 * k; y < h - 36 * k; y += step) { g.moveTo(36 * k, y); g.lineTo(w - 36 * k, y); }
  if (kind === 'grid') {
    for (let y = 0; y <= h; y += step) { g.moveTo(0, y); g.lineTo(w, y); }
    for (let x = 0; x <= w; x += step) { g.moveTo(x, 0); g.lineTo(x, h); }
  }
  g.stroke();
}

function insertAt() {
  const idx = entries.reduce((m, e, n) => selected.has(e.id) ? n : m, -1);
  return idx < 0 ? entries.length : idx + 1;
}

function insert(list) {
  const at = insertAt(), next = entries.slice();
  next.splice(at, 0, ...list);
  commit(next);
}

async function addFromPdf(files) {
  const list = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let doc;
    try {
      doc = await ctx.pdfjs.getDocument({ data: bytes.slice() }).promise;
    } catch (err) {
      alert(`Impossibile aprire ${f.name}: ${err.message}`);
      continue;
    }
    for (let i = 0; i < doc.numPages; i++) {
      const vp = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
      list.push({ id: nextId++, src: 'ext', bytes, doc, i, rot: 0, strokes: [], w: vp.width, h: vp.height });
    }
  }
  if (list.length) insert(list);
}

export async function build(list, bakeAll) {
  const { PDFDocument, degrees, rgb } = PDFLib;
  const out = await PDFDocument.create();
  const bake = bakeAll ? null : list.filter(e => e.src === 'cur' && e.rot && e.strokes.length).map(e => e.i);
  const curBytes = bakeAll || bake.length ? await ctx.baked(bake) : ctx.bytes;
  const docs = new Map(), copied = new Map();
  const srcOf = e => e.src === 'cur' ? curBytes : e.bytes;
  for (const e of list) {
    if (e.src === 'blank') continue;
    const b = srcOf(e);
    if (!docs.has(b)) docs.set(b, { doc: await PDFDocument.load(b, { ignoreEncryption: true }), idx: new Set() });
    docs.get(b).idx.add(e.i);
  }
  for (const [b, { doc, idx }] of docs) {
    const ids = [...idx], pages = await out.copyPages(doc, ids);
    copied.set(b, new Map(ids.map((i, n) => [i, pages[n]])));
  }
  const used = new Map();
  for (const e of list) {
    if (e.src === 'blank') {
      const p = out.addPage([e.w, e.h]);
      const color = e.kind === 'lined' ? rgb(0.75, 0.82, 0.93) : rgb(0.85, 0.85, 0.87);
      const step = e.kind === 'lined' ? 24 : 14.17;
      if (e.kind === 'lined') for (let y = e.h - 72; y > 36; y -= step) p.drawLine({ start: { x: 36, y }, end: { x: e.w - 36, y }, thickness: 0.6, color });
      if (e.kind === 'grid') {
        for (let y = e.h; y >= 0; y -= step) p.drawLine({ start: { x: 0, y }, end: { x: e.w, y }, thickness: 0.4, color });
        for (let x = 0; x <= e.w; x += step) p.drawLine({ start: { x, y: 0 }, end: { x, y: e.h }, thickness: 0.4, color });
      }
      continue;
    }
    const b = srcOf(e);
    if (!used.has(b)) used.set(b, new Set());
    let p = copied.get(b).get(e.i);
    if (used.get(b).has(e.i)) [p] = await out.copyPages(docs.get(b).doc, [e.i]);
    used.get(b).add(e.i);
    if (e.rot) p.setRotation(degrees((p.getRotation().angle + e.rot) % 360));
    out.addPage(p);
  }
  return out.save();
}

const baseName = () => ctx.fileName.replace(/\.pdf$/i, '');
const pdfFile = (bytes, name) => new File([bytes], name, { type: 'application/pdf' });

function parseRanges(text, n) {
  const groups = [];
  for (const part of text.split(/[,;]/).map(s => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) throw new Error(`Intervallo non valido: «${part}»`);
    const a = +m[1], b = +(m[2] || m[1]);
    if (a < 1 || b > n || a > b) throw new Error(`Intervallo fuori dalle pagine 1-${n}: «${part}»`);
    groups.push([a - 1, b - 1]);
  }
  return groups;
}

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Attendi…';
  try { await fn(); } catch (err) { alert(err.message); } finally { btn.textContent = label; btn.disabled = false; render(); }
}

$('#orgGrid').addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (!card || dragged) { dragged = false; return; }
  const id = +card.dataset.id;
  selected.has(id) ? selected.delete(id) : selected.add(id);
  render();
});

let drag = null;
$('#orgGrid').addEventListener('pointerdown', e => {
  const card = e.target.closest('.card');
  if (!card || (e.pointerType === 'touch' && !e.target.closest('.grip'))) return;
  dragged = false;
  drag = { card, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
});
$('#orgGrid').addEventListener('pointermove', e => {
  if (drag?.id !== e.pointerId) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) < 8) return;
    drag.moved = true;
    drag.card.setPointerCapture(e.pointerId);
    drag.card.classList.add('dragging');
  }
  e.preventDefault();
  drag.card.style.translate = `${dx}px ${dy}px`;
  const grid = $('#orgGrid'), r = grid.getBoundingClientRect();
  if (e.clientY < r.top + 60) grid.scrollTop -= 14;
  if (e.clientY > r.bottom - 60) grid.scrollTop += 14;
  drag.card.style.visibility = 'hidden';
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.card');
  drag.card.style.visibility = '';
  if (!over || over === drag.card) return;
  const or = over.getBoundingClientRect(), after = e.clientX > or.left + or.width / 2;
  const before = drag.card.getBoundingClientRect();
  over[after ? 'after' : 'before'](drag.card);
  const now = drag.card.getBoundingClientRect();
  drag.x += now.left - before.left;
  drag.y += now.top - before.top;
  drag.card.style.translate = `${e.clientX - drag.x}px ${e.clientY - drag.y}px`;
});
const dragEnd = e => {
  if (drag?.id !== e.pointerId) return;
  const { moved } = drag;
  drag = null;
  if (!moved) return;
  dragged = true;
  const order = [...$('#orgGrid').children].map(c => +c.dataset.id);
  commit(order.map(id => entries.find(x => x.id === id)));
};
$('#orgGrid').addEventListener('pointerup', dragEnd);
$('#orgGrid').addEventListener('pointercancel', dragEnd);

$('#orgAll').onclick = () => {
  selected = selected.size === entries.length ? new Set() : new Set(entries.map(e => e.id));
  render();
};
$('#orgRotate').onclick = () => commit(entries.map(e => selected.has(e.id) ? { ...e, rot: (e.rot + 90) % 360 } : e));
$('#orgDelete').onclick = () => {
  if (selected.size === entries.length) return alert('Il documento deve avere almeno una pagina.');
  const next = entries.filter(e => !selected.has(e.id));
  selected = new Set();
  commit(next);
};
$('#orgUndo').onclick = () => {
  entries = history.pop() || entries;
  selected = new Set([...selected].filter(id => entries.some(e => e.id === id)));
  render();
};
$('#orgInsert').onchange = e => {
  const v = e.target.value;
  e.target.value = '';
  if (v === 'pdf') return $('#orgFile').click();
  const ref = entries[insertAt() - 1] || { w: A4[0], h: A4[1], rot: 0 };
  const [w, h] = ref.rot % 180 ? [ref.h, ref.w] : [ref.w, ref.h];
  insert([{ id: nextId++, src: 'blank', kind: v, i: -1, rot: 0, strokes: [], w, h }]);
};
$('#orgFile').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await busy($('#orgDone'), () => addFromPdf(files));
};
$('#orgExtract').onclick = e => busy(e.currentTarget, async () => {
  const list = entries.filter(x => selected.has(x.id));
  ctx.offer([pdfFile(await build(list, true), `${baseName()}_estratto.pdf`)]);
});
$('#orgSplit').onclick = e => {
  const text = prompt(
    `Come vuoi dividere le ${entries.length} pagine?\n\nScrivi gli intervalli, ad esempio: 1-3, 4-6, 7\nLascia vuoto per avere un file per ogni pagina.`, '');
  if (text === null) return;
  busy(e.currentTarget, async () => {
    const groups = text.trim() ? parseRanges(text, entries.length) : entries.map((_, n) => [n, n]);
    const files = [];
    for (const [a, b] of groups) {
      const name = a === b ? `${baseName()}_p${a + 1}.pdf` : `${baseName()}_p${a + 1}-${b + 1}.pdf`;
      files.push(pdfFile(await build(entries.slice(a, b + 1), true), name));
    }
    ctx.offer(files);
  });
};
$('#orgDone').onclick = e => {
  if (!changedSince()) return close();
  busy(e.currentTarget, async () => {
    const bytes = await build(entries, false);
    const strokes = entries.map(x => x.src === 'cur' && !(x.rot && x.strokes.length) ? x.strokes : []);
    await ctx.apply(bytes, strokes);
    close();
  });
};
$('#orgCancel').onclick = () => {
  if (changedSince() && !confirm('Annullare tutte le modifiche alle pagine?')) return;
  close();
};

function close() {
  thumbs?.disconnect();
  $('#org').hidden = true;
  $('#orgGrid').textContent = '';
  for (const e of entries || []) if (e.src === 'ext') e.doc.destroy?.();
  entries = null;
}

export { parseRanges };
