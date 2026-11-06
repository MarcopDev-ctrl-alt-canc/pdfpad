let measure = s => s.length;
export const setMeasure = f => { measure = f; };

export function charX(w, c) {
  if (c <= 0) return w.x;
  if (c >= w.str.length) return w.x + w.w;
  return w.x + w.w * measure(w.str.slice(0, c)) / measure(w.str);
}

export function charAt(w, x) {
  let best = 0, bd = Infinity;
  for (let c = 0; c <= w.str.length; c++) {
    const d = Math.abs(charX(w, c) - x);
    if (d <= bd) { bd = d; best = c; }
  }
  return best;
}

export const fold = s => s.split('').map(ch => ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()[0] ?? ' ').join('');

export function pageIndex(words) {
  let text = '';
  const map = [];
  words.forEach((w, wi) => {
    if (text) { text += ' '; map.push(null); }
    for (let c = 0; c < w.str.length; c++) map.push([wi, c]);
    text += w.str;
  });
  return { text: fold(text), map };
}

function span(words, map, a, b) {
  const parts = new Map();
  for (let k = a; k < b; k++) {
    if (!map[k]) continue;
    const [wi, c] = map[k], p = parts.get(wi) || [c, c + 1];
    parts.set(wi, [Math.min(p[0], c), Math.max(p[1], c + 1)]);
  }
  const rects = [];
  for (const [wi, [c0, c1]] of parts) {
    const w = words[wi], x0 = charX(w, c0), r = [x0, w.y, charX(w, c1) - x0, w.h], last = rects[rects.length - 1];
    if (last && Math.abs(last[1] - r[1]) < r[3] * 0.5 && r[0] >= last[0] - 2) last[2] = r[0] + r[2] - last[0];
    else rects.push(r);
  }
  return rects;
}

export function findRects(words, idx, q) {
  const nq = fold(q.trim()), out = [];
  if (!nq) return out;
  for (let i = idx.text.indexOf(nq); i >= 0; i = idx.text.indexOf(nq, i + 1)) out.push(span(words, idx.map, i, i + nq.length));
  return out;
}
