const MAX_OUT = 2200, EDGE = 0.004;

export function homography(p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, d = y1 - y0 + g * y1, e = y3 - y0 + h * y3;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + x0) / w, (d * u + e * v + y0) / w];
  };
}

export function warp(src, quad) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
  let H = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
  const k = Math.min(1, MAX_OUT / Math.max(W, H));
  W = Math.max(1, Math.round(W * k));
  H = Math.max(1, Math.round(H * k));
  const map = homography(quad), out = new Uint8ClampedArray(W * H * 4), s = src.data, sw = src.width, sh = src.height;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let [sx, sy] = map(EDGE + (1 - 2 * EDGE) * (x + 0.5) / W, EDGE + (1 - 2 * EDGE) * (y + 0.5) / H);
      sx = Math.min(sw - 1.001, Math.max(0, sx - 0.5));
      sy = Math.min(sh - 1.001, Math.max(0, sy - 0.5));
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy, i = (iy * sw + ix) * 4, o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s[i + c] * (1 - fx) + s[i + 4 + c] * fx;
        const bot = s[i + sw * 4 + c] * (1 - fx) + s[i + sw * 4 + 4 + c] * fx;
        out[o + c] = top * (1 - fy) + bot * fy;
      }
      out[o + 3] = 255;
    }
  }
  return new ImageData(out, W, H);
}

export function filter(img, mode) {
  if (mode === 'color') return img;
  const d = img.data, n = d.length / 4, lum = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const l = (d[i * 4] * 299 + d[i * 4 + 1] * 587 + d[i * 4 + 2] * 114) / 1000 | 0;
    lum[i] = l;
    hist[l]++;
  }
  let lo = 0, hi = 255;
  if (mode === 'doc') {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.25) { hi = v; break; } }
    if (hi - lo < 40) { lo = 0; hi = 255; }
  }
  for (let i = 0; i < n; i++) {
    let v = (lum[i] - lo) / (hi - lo);
    v = Math.min(1, Math.max(0, v));
    if (mode === 'doc') v = Math.pow(v, 1.6);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v * 255;
  }
  return img;
}
