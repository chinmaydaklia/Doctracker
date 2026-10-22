// Pure image-geometry helpers for scan clean-up (no DOM): perspective correction
// (4-point homography), contrast mapping and output sizing. Unit-tested in Node.

// Solve A·x = b (n×n) by Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error("Corner points are degenerate (three in a line or overlapping).");
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Homography H mapping src[i] -> dst[i] (4 point pairs, each {x, y}). Returns 3×3 row-major [9].
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

// Output size for a quadrilateral (TL, TR, BR, BL): average of opposite edge lengths,
// scaled so the longer side is at most maxSide.
export function quadSize(q, maxSide = 2000) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = (d(q[0], q[1]) + d(q[3], q[2])) / 2;
  let h = (d(q[0], q[3]) + d(q[1], q[2])) / 2;
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

// Inverse warp: for each output pixel, sample the source through H⁻¹ (bilinear).
// src: {data: Uint8ClampedArray RGBA, width, height}. Returns new RGBA ImageData-like object.
export function warpPerspective(src, quad, out) {
  const Hinv = homography(
    [{ x: 0, y: 0 }, { x: out.width - 1, y: 0 }, { x: out.width - 1, y: out.height - 1 }, { x: 0, y: out.height - 1 }],
    quad,
  );
  const dst = new Uint8ClampedArray(out.width * out.height * 4);
  const { data, width: W, height: Hh } = src;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const p = applyH(Hinv, x, y);
      const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
      const o = (y * out.width + x) * 4;
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= Hh - 1) {
        dst[o] = dst[o + 1] = dst[o + 2] = 255;
        dst[o + 3] = 255;
        continue;
      }
      const fx = p.x - x0, fy = p.y - y0;
      const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
      for (let c = 0; c < 4; c++) {
        dst[o + c] = data[i00 + c] * (1 - fx) * (1 - fy) + data[i10 + c] * fx * (1 - fy) + data[i01 + c] * (1 - fx) * fy + data[i11 + c] * fx * fy;
      }
    }
  }
  return { data: dst, width: out.width, height: out.height };
}

// Brightness (-100..100), contrast (-100..100), optional grayscale, in place.
export function adjust(img, { brightness = 0, contrast = 0, grayscale = false } = {}) {
  const c = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const b = brightness * 2.55;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], bl = d[i + 2];
    if (grayscale) r = g = bl = 0.299 * r + 0.587 * g + 0.114 * bl;
    d[i] = c * (r - 128) + 128 + b;
    d[i + 1] = c * (g - 128) + 128 + b;
    d[i + 2] = c * (bl - 128) + 128 + b;
  }
  return img;
}

// Local-mean ("adaptive") thresholding to make ink stand out on uneven paper / shadows.
// Uses an integral image so it is O(pixels).
export function adaptiveThreshold(img, { radius = 15, offset = 10 } = {}) {
  const { width: W, height: H, data } = img;
  const gray = new Float64Array(W * H);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const integ = new Float64Array((W + 1) * (H + 1));
  for (let y = 1; y <= H; y++) {
    let row = 0;
    for (let x = 1; x <= W; x++) {
      row += gray[(y - 1) * W + (x - 1)];
      integ[y * (W + 1) + x] = integ[(y - 1) * (W + 1) + x] + row;
    }
  }
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(H - 1, y + radius);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(W - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const s = integ[(y1 + 1) * (W + 1) + (x1 + 1)] - integ[y0 * (W + 1) + (x1 + 1)] - integ[(y1 + 1) * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
      const v = gray[y * W + x] < s / area - offset ? 0 : 255;
      const o = (y * W + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  }
  return img;
}

// Corners of the full image after an optional rotation in degrees (for default crop).
export function fullQuad(width, height) {
  return [{ x: 0, y: 0 }, { x: width - 1, y: 0 }, { x: width - 1, y: height - 1 }, { x: 0, y: height - 1 }];
}
