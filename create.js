import { warp, filter } from './scanmath.js';

const $ = s => document.querySelector(s);
const MAX_SRC = 2400, A4W = 595.28;
let ctx, shots, cur, view;

export async function blankPdf(kind) {
  const { PDFDocument, rgb } = PDFLib;
  const out = await PDFDocument.create(), [w, h] = [A4W, 841.89], p = out.addPage([w, h]);
  const color = kind === 'lined' ? rgb(0.75, 0.82, 0.93) : rgb(0.85, 0.85, 0.87);
  if (kind === 'lined') for (let y = h - 72; y > 36; y -= 24) p.drawLine({ start: { x: 36, y }, end: { x: w - 36, y }, thickness: 0.6, color });
  if (kind === 'grid') {
    for (let y = h; y >= 0; y -= 14.17) p.drawLine({ start: { x: 0, y }, end: { x: w, y }, thickness: 0.4, color });
    for (let x = 0; x <= w; x += 14.17) p.drawLine({ start: { x, y: 0 }, end: { x, y: h }, thickness: 0.4, color });
  }
  return out.save();
}

async function loadShot(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, MAX_SRC / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return { src: c, quad: [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]], mode: 'doc', rot: 0 };
}

export function openScanner(c) {
  ctx = c;
  shots = [];
  cur = -1;
  $('#scan').hidden = false;
  render();
  $('#scanFile').click();
}

function close() {
  $('#scan').hidden = true;
  shots = [];
  $('#scanStrip').textContent = '';
}

function render() {
  const has = shots.length > 0;
  $('#scanEmpty').hidden = has;
  $('#scanStage').hidden = !has;
  $('#scanTools').hidden = !has;
  $('#scanDone').disabled = !has;
  $('#scanDone').textContent = has ? `Crea PDF (${shots.length})` : 'Crea PDF';
  $('#scanStrip').replaceChildren(...shots.map((s, i) => {
    const b = document.createElement('button');
    b.className = 'shot' + (i === cur ? ' on' : '');
    const f = Math.min(1, 220 / Math.max(s.src.width, s.src.height));
    if (!s.small) {
      const c = document.createElement('canvas');
      c.width = Math.round(s.src.width * f);
      c.height = Math.round(s.src.height * f);
      c.getContext('2d').drawImage(s.src, 0, 0, c.width, c.height);
      s.small = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    }
    const copy = new ImageData(new Uint8ClampedArray(s.small.data), s.small.width, s.small.height);
    const img = filter(warp(copy, s.quad.map(([x, y]) => [x * f, y * f])), s.mode);
    const t = document.createElement('canvas');
    t.width = img.width;
    t.height = img.height;
    t.getContext('2d').putImageData(img, 0, 0);
    t.style.transform = `rotate(${s.rot}deg)`;
    b.append(t);
    b.onclick = () => { cur = i; render(); };
    return b;
  }));
  if (!has) return;
  const s = shots[cur];
  for (const b of $('#scanMode').children) b.classList.toggle('on', b.dataset.mode === s.mode);
  drawStage();
}

function drawStage() {
  const s = shots[cur], stage = $('#scanStage'), cv = $('#scanCanvas');
  const r = stage.getBoundingClientRect(), pad = 28;
  const k = Math.min((r.width - pad * 2) / s.src.width, (r.height - pad * 2) / s.src.height);
  const w = s.src.width * k, h = s.src.height * k, ox = (r.width - w) / 2, oy = (r.height - h) / 2, dpr = devicePixelRatio || 1;
  view = { k, ox, oy };
  cv.width = r.width * dpr;
  cv.height = r.height * dpr;
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  g.drawImage(s.src, ox, oy, w, h);
  const P = s.quad.map(([x, y]) => [ox + x * k, oy + y * k]);
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.beginPath();
  g.rect(0, 0, r.width, r.height);
  g.moveTo(...P[0]);
  for (const p of [P[3], P[2], P[1]]) g.lineTo(...p);
  g.closePath();
  g.fill('evenodd');
  g.strokeStyle = '#3b82f6';
  g.lineWidth = 2;
  g.beginPath();
  P.forEach((p, i) => i ? g.lineTo(...p) : g.moveTo(...p));
  g.closePath();
  g.stroke();
  for (const p of P) {
    g.beginPath();
    g.arc(...p, 11, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,.95)';
    g.fill();
    g.lineWidth = 3;
    g.stroke();
  }
}

let grab = null;
function stagePoint(e) {
  const r = $('#scanStage').getBoundingClientRect();
  return [(e.clientX - r.left - view.ox) / view.k, (e.clientY - r.top - view.oy) / view.k];
}
$('#scanStage').addEventListener('pointerdown', e => {
  if (cur < 0) return;
  const [x, y] = stagePoint(e), s = shots[cur];
  let best = -1, bd = 40 / view.k;
  s.quad.forEach(([qx, qy], i) => { const d = Math.hypot(qx - x, qy - y); if (d < bd) { bd = d; best = i; } });
  if (best < 0) return;
  e.preventDefault();
  $('#scanStage').setPointerCapture(e.pointerId);
  grab = { id: e.pointerId, i: best };
});
$('#scanStage').addEventListener('pointermove', e => {
  if (grab?.id !== e.pointerId) return;
  const s = shots[cur], [x, y] = stagePoint(e);
  s.quad[grab.i] = [Math.min(s.src.width, Math.max(0, x)), Math.min(s.src.height, Math.max(0, y))];
  drawStage();
});
const ungrab = e => { if (grab?.id !== e.pointerId) return; grab = null; render(); };
$('#scanStage').addEventListener('pointerup', ungrab);
$('#scanStage').addEventListener('pointercancel', ungrab);
addEventListener('resize', () => { if (!$('#scan').hidden && cur >= 0) drawStage(); });

$('#scanFile').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    try {
      shots.push(await loadShot(f));
    } catch (err) {
      alert(`Impossibile leggere ${f.name}: ${err.message}`);
    }
  }
  if (files.length) cur = shots.length - 1;
  render();
};
$('#scanAdd').onclick = $('#scanPick').onclick = () => $('#scanFile').click();
$('#scanMode').onclick = e => {
  const m = e.target.closest('[data-mode]')?.dataset.mode;
  if (!m || cur < 0) return;
  shots[cur].mode = m;
  render();
};
$('#scanRotate').onclick = () => { if (cur >= 0) { shots[cur].rot = (shots[cur].rot + 90) % 360; render(); } };
$('#scanReset').onclick = () => {
  if (cur < 0) return;
  const { width: w, height: h } = shots[cur].src;
  shots[cur].quad = [[0, 0], [w, 0], [w, h], [0, h]];
  drawStage();
};
$('#scanRemove').onclick = () => {
  if (cur < 0) return;
  shots.splice(cur, 1);
  cur = Math.min(cur, shots.length - 1);
  render();
};
$('#scanCancel').onclick = () => {
  if (shots.length && !confirm('Scartare le pagine acquisite?')) return;
  close();
};
$('#scanDone').onclick = async () => {
  const b = $('#scanDone');
  b.disabled = true;
  b.textContent = 'Creo il PDF…';
  try {
    const { PDFDocument } = PDFLib, out = await PDFDocument.create();
    for (const s of shots) {
      const src = s.src.getContext('2d').getImageData(0, 0, s.src.width, s.src.height);
      const img = filter(warp(src, s.quad), s.mode);
      const c = document.createElement('canvas'), side = s.rot % 180 !== 0;
      c.width = side ? img.height : img.width;
      c.height = side ? img.width : img.height;
      const tmp = document.createElement('canvas');
      tmp.width = img.width;
      tmp.height = img.height;
      tmp.getContext('2d').putImageData(img, 0, 0);
      const g = c.getContext('2d');
      g.translate(c.width / 2, c.height / 2);
      g.rotate(s.rot * Math.PI / 180);
      g.drawImage(tmp, -img.width / 2, -img.height / 2);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
      const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      const h = A4W * c.height / c.width;
      out.addPage([A4W, h]).drawImage(jpg, { x: 0, y: 0, width: A4W, height: h });
    }
    const name = 'Scansione ' + new Date().toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }).replace(/[/:]/g, '.').replace(',', '') + '.pdf';
    await ctx.done(await out.save(), name);
    close();
  } catch (err) {
    alert('Errore durante la creazione: ' + err.message);
    render();
  }
};

