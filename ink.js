export const PRESSURE_MIN = 0.3;
export const PRESSURE_GAIN = 1.6;

const f2 = v => Math.round(v * 100) / 100;
const pt = p => `${f2(p[0])} ${f2(p[1])}`;
const mid = (a, b) => pt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);

export function penPath(pts, w) {
  const n = pts.length, L = [], R = [];
  const rad = p => w / 2 * (PRESSURE_MIN + (1 - PRESSURE_MIN) * Math.min(1, p * PRESSURE_GAIN));
  const dir = i => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    return l ? [dx / l, dy / l] : [1, 0];
  };
  const cap = (i, s) => {
    const [x, y, p] = pts[i], [dx, dy] = dir(i), r = rad(p), out = [];
    for (let t = 1; t < 6; t++) {
      const c = Math.cos(Math.PI * t / 6) * s, sn = Math.sin(Math.PI * t / 6) * s;
      out.push([x + r * (-dy * c + dx * sn), y + r * (dx * c + dy * sn)]);
    }
    return out;
  };
  for (let i = 0; i < n; i++) {
    const [x, y, p] = pts[i], [dx, dy] = dir(i), r = rad(p);
    L.push([x - dy * r, y + dx * r]);
    R.push([x + dy * r, y - dx * r]);
  }
  const P = [...L, ...cap(n - 1, 1), ...R.reverse(), ...cap(0, -1)];
  let d = `M ${mid(P[0], P[1])}`;
  for (let i = 1; i <= P.length; i++) {
    const a = P[i % P.length], b = P[(i + 1) % P.length];
    d += ` Q ${pt(a)} ${mid(a, b)}`;
  }
  return d + ' Z';
}

export function hlPath(pts) {
  let d = `M ${pt(pts[0])}`;
  for (let i = 1; i < pts.length - 1; i++) d += ` Q ${pt(pts[i])} ${mid(pts[i], pts[i + 1])}`;
  const e = pts[pts.length - 1];
  return d + ` L ${pt(pts.length === 1 ? [e[0] + 0.01, e[1]] : e)}`;
}

export function dSeg(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l)) : 0;
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
