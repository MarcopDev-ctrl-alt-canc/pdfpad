import { penPath, hlPath, dSeg } from './ink.js';
import { charX, charAt } from './search.js';

export const HL_ALPHA = 0.45;
export const NOTE = 22;
export const STAMPS = [
  ['APPROVATO', '#15803d'], ['RIFIUTATO', '#dc2626'], ['BOZZA', '#6b7280'],
  ['CONFIDENZIALE', '#b45309'], ['RICEVUTO', '#1d4ed8'], ['URGENTE', '#be123c']
];

const f2 = v => Math.round(v * 100) / 100;
export const isDom = o => o.tool === 'text' || o.tool === 'note';
export const resizable = o => o.tool !== 'mark' && o.tool !== 'note';

export function sigStrokes(o) {
  return o.paths.map(({ pts, w }) => ({ w: w * o.w, pts: pts.map(([x, y, p]) => [o.x + x * o.w, o.y + y * o.h, p]) }));
}

export function shapeLines(o) {
  const { x1, y1, x2, y2 } = o;
  if (o.kind === 'rect') return [[[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]];
  if (o.kind === 'ellipse') {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2;
    return [Array.from({ length: 65 }, (_, i) => [cx + rx * Math.cos(i * Math.PI / 32), cy + ry * Math.sin(i * Math.PI / 32)])];
  }
  const L = [[[x1, y1], [x2, y2]]];
  if (o.kind === 'arrow') {
    const a = Math.atan2(y2 - y1, x2 - x1), h = Math.max(8, o.w * 4);
    L.push([[x2 - h * Math.cos(a - 0.45), y2 - h * Math.sin(a - 0.45)], [x2, y2], [x2 - h * Math.cos(a + 0.45), y2 - h * Math.sin(a + 0.45)]]);
  }
  return L;
}

export const linesPath = L => L.map(l => 'M ' + l.map(p => `${f2(p[0])} ${f2(p[1])}`).join(' L ')).join(' ');
const rectLines = ([x, y, w, h]) => [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];

export function markBars(o) {
  if (o.kind === 'hl') return o.rects;
  return o.rects.map(([x, y, w, h]) => {
    const t = Math.max(0.8, h * 0.07);
    return [x, y + h * (o.kind === 'under' ? 0.94 : 0.55) - t / 2, w, t];
  });
}

export function bbox(o, size) {
  switch (o.tool) {
    case 'pen': case 'hl': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of o.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const p = o.w / 2;
      return [x0 - p, y0 - p, x1 + p, y1 + p];
    }
    case 'shape': {
      const p = o.w / 2;
      return [Math.min(o.x1, o.x2) - p, Math.min(o.y1, o.y2) - p, Math.max(o.x1, o.x2) + p, Math.max(o.y1, o.y2) + p];
    }
    case 'mark': {
      const xs = o.rects.flatMap(([x, , w]) => [x, x + w]), ys = o.rects.flatMap(([, y, , h]) => [y, y + h]);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
    case 'text': case 'note': {
      const [w, h] = size?.(o) || [NOTE, NOTE];
      return [o.x, o.y, o.x + w, o.y + h];
    }
    default: return [o.x, o.y, o.x + o.w, o.y + o.h];
  }
}

export function hit(o, x, y, tol, size) {
  if (o.tool === 'pen' || o.tool === 'hl') return o.pts.some((a, i) => dSeg(x, y, a, o.pts[i + 1] || a) < tol + o.w / 2);
  if (o.tool === 'shape' && (o.kind === 'line' || o.kind === 'arrow')) return dSeg(x, y, [o.x1, o.y1], [o.x2, o.y2]) < tol + o.w / 2;
  if (o.tool === 'mark') return o.rects.some(([rx, ry, w, h]) => x > rx - tol && x < rx + w + tol && y > ry - tol && y < ry + h + tol);
  const [x0, y0, x1, y1] = bbox(o, size);
  return x > x0 - tol && x < x1 + tol && y > y0 - tol && y < y1 + tol;
}

export function mapItem(o, f, s) {
  const P = p => { const [x, y] = f(p); return p.length > 2 ? [x, y, p[2]] : [x, y]; };
  switch (o.tool) {
    case 'pen': case 'hl': return { ...o, pts: o.pts.map(P), w: o.w * s };
    case 'shape': {
      const [x1, y1] = f([o.x1, o.y1]), [x2, y2] = f([o.x2, o.y2]);
      return { ...o, x1, y1, x2, y2, w: o.w * s };
    }
    case 'mark': return { ...o, rects: o.rects.map(([x, y, w, h]) => { const [a, b] = f([x, y]); return [a, b, w, h]; }) };
    case 'text': { const [x, y] = f([o.x, o.y]); return { ...o, x, y, size: o.size * s }; }
    case 'note': { const [x, y] = f([o.x, o.y]); return { ...o, x, y }; }
    default: { const [x, y] = f([o.x, o.y]); return { ...o, x, y, w: o.w * s, h: o.h * s }; }
  }
}

export function paint(ctx, o, path) {
  ctx.save();
  ctx.lineCap = ctx.lineJoin = 'round';
  switch (o.tool) {
    case 'hl':
      ctx.globalCompositeOperation = 'multiply';
      ctx.globalAlpha = HL_ALPHA;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.w;
      ctx.stroke(path(o));
      break;
    case 'pen': case 'sig':
      ctx.fillStyle = o.color;
      ctx.fill(path(o));
      break;
    case 'shape':
      ctx.strokeStyle = o.color;
      ctx.lineWidth = o.w;
      ctx.stroke(new Path2D(linesPath(shapeLines(o))));
      break;
    case 'mark':
      if (o.kind === 'hl') { ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = HL_ALPHA; }
      ctx.fillStyle = o.color;
      for (const r of markBars(o)) ctx.fillRect(...r);
      break;
    case 'stamp': {
      const { x, y, w, h } = o;
      ctx.strokeStyle = ctx.fillStyle = o.color;
      ctx.lineWidth = h * 0.06;
      ctx.stroke(new Path2D(linesPath(rectLines([x, y, w, h]))));
      ctx.textAlign = 'center';
      ctx.font = `700 ${h * 0.4}px Helvetica, Arial, sans-serif`;
      ctx.fillText(o.label, x + w / 2, y + h * 0.52);
      ctx.font = `600 ${h * 0.2}px Helvetica, Arial, sans-serif`;
      ctx.fillText(o.date, x + w / 2, y + h * 0.82);
      break;
    }
  }
  ctx.restore();
}

export function inkPath(o) {
  if (o.tool === 'hl') return hlPath(o.pts);
  if (o.tool === 'sig') return sigStrokes(o).map(s => penPath(s.pts, s.w)).join(' ');
  return penPath(o.pts, o.w);
}

export function exportItem(page, o, E) {
  const { pdf, color, out } = E;
  const P = p => { const [X, Y] = pdf(p[0], p[1]); return p.length > 2 ? [X, -Y, p[2]] : [X, -Y]; };
  const svg = L => L.map(l => 'M ' + l.map(p => P(p).slice(0, 2).join(' ')).join(' L ')).join(' ');
  const { LineCapStyle, LineJoinStyle, BlendMode, pushGraphicsState, popGraphicsState, setLineJoin, PDFHexString } = PDFLib;
  const round = fn => { page.pushOperators(pushGraphicsState(), setLineJoin(LineJoinStyle.Round)); fn(); page.pushOperators(popGraphicsState()); };
  const text = (str, x, y, size, font, c) => {
    const safe = [...str].map(ch => E.chars.has(ch.codePointAt(0)) ? ch : '?').join('');
    const [X, Y] = pdf(x, y);
    page.drawText(safe, { x: X, y: Y, size, font, color: c, rotate: E.rotate });
  };
  switch (o.tool) {
    case 'pen':
      page.drawSvgPath(penPath(o.pts.map(P), o.w), { x: 0, y: 0, color: color(o.color) });
      break;
    case 'sig':
      for (const s of sigStrokes(o)) page.drawSvgPath(penPath(s.pts.map(P), s.w), { x: 0, y: 0, color: color(o.color) });
      break;
    case 'hl':
      round(() => page.drawSvgPath(hlPath(o.pts.map(P)), {
        x: 0, y: 0, borderColor: color(o.color), borderWidth: o.w, borderOpacity: HL_ALPHA,
        borderLineCap: LineCapStyle.Round, blendMode: BlendMode.Multiply
      }));
      break;
    case 'shape':
      round(() => page.drawSvgPath(svg(shapeLines(o)), {
        x: 0, y: 0, borderColor: color(o.color), borderWidth: o.w, borderLineCap: LineCapStyle.Round
      }));
      break;
    case 'mark':
      for (const r of markBars(o)) {
        page.drawSvgPath(svg(rectLines(r)) + ' Z', {
          x: 0, y: 0, color: color(o.color),
          ...(o.kind === 'hl' ? { opacity: HL_ALPHA, blendMode: BlendMode.Multiply } : {})
        });
      }
      break;
    case 'stamp': {
      const { x, y, w, h } = o, c = color(o.color);
      page.drawSvgPath(svg(rectLines([x, y, w, h])), { x: 0, y: 0, borderColor: c, borderWidth: h * 0.06 });
      const ls = h * 0.4, ds = h * 0.2;
      text(o.label, x + w / 2 - E.bold.widthOfTextAtSize(o.label, ls) / 2, y + h * 0.52, ls, E.bold, c);
      text(o.date, x + w / 2 - E.bold.widthOfTextAtSize(o.date, ds) / 2, y + h * 0.82, ds, E.bold, c);
      break;
    }
    case 'text':
      o.text.split('\n').forEach((line, n) => text(line, o.x, o.y + o.size * (E.base + 1.2 * n), o.size, E.font, color(o.color)));
      break;
    case 'note': {
      const [ax, ay] = pdf(o.x, o.y), [bx, by] = pdf(o.x + NOTE, o.y + NOTE);
      const l = Math.min(ax, bx), b = Math.min(ay, by);
      page.node.addAnnot(out.context.register(out.context.obj({
        Type: 'Annot', Subtype: 'Text', Name: 'Comment', F: 4, Open: false, C: [0.99, 0.83, 0.3],
        Rect: [l, b, l + NOTE, b + NOTE], AP: { N: E.noteAp },
        Contents: PDFHexString.fromText(o.text), T: PDFHexString.fromText('PDF Pad')
      })));
      break;
    }
  }
}

export function markRects(words, ax, ay, bx, by) {
  const near = (x, y) => {
    let best = -1, bd = Infinity;
    words.forEach((w, i) => {
      const dx = Math.max(w.x - x, 0, x - w.x - w.w), dy = Math.max(w.y - y, 0, y - w.y - w.h), d = dx * dx + 4 * dy * dy;
      if (d < bd) { bd = d; best = i; }
    });
    return bd < 900 ? best : -1;
  };
  let i = near(ax, ay), j = near(bx, by), sx = ax, ex = bx;
  if (i < 0 || j < 0) return { rects: [], text: '' };
  if (i > j || (i === j && ax > bx)) { [i, j] = [j, i]; [sx, ex] = [bx, ax]; }
  const rects = [];
  let text = '';
  for (let k = i; k <= j; k++) {
    const w = words[k], n = w.str.length;
    const a = k === i ? charAt(w, sx) : 0;
    const b = k === j ? charAt(w, ex) : n;
    if (b <= a) continue;
    const x = charX(w, a), wd = charX(w, b) - x, str = w.str.slice(a, b), last = rects[rects.length - 1];
    if (last && Math.abs(last[1] - w.y) < w.h * 0.5 && x >= last[0] - 2) {
      last[2] = Math.max(last[0] + last[2], x + wd) - last[0];
      last[3] = Math.max(last[3], w.h);
      text += /\s$/.test(text) || /^\s/.test(str) ? str : ' ' + str;
    } else {
      rects.push([x, w.y, wd, w.h]);
      text += (text ? '\n' : '') + str;
    }
  }
  return { rects: rects.map(r => r.map(f2)), text: text.trim() };
}
